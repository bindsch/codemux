import { describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  awaitFinalFlush,
  BoundedOutboundQueue,
  codemuxFatalMessage,
  installSessionSignalHandlers,
  MAX_HARNESS_LINE_BYTES,
  MAX_INPUT_LINE_BYTES,
  SessionProcess,
  type SessionFatal,
} from "../src/session/process.js";

/** A SessionProcess over a /bin/sh script, collecting lines and fatals. */
function harness(script: string, graceMs = 500): {
  proc: SessionProcess;
  lines: string[];
  fatals: SessionFatal[];
  done: Promise<void>;
} {
  const lines: string[] = [];
  const fatals: SessionFatal[] = [];
  const proc = new SessionProcess({
    command: ["/bin/sh", "-c", script],
    cwd: tmp(),
    env: { PATH: "/usr/bin:/bin" },
    onLine: (line) => {
      lines.push(line);
    },
    onFatal: (fatal) => {
      fatals.push(fatal);
    },
    graceMs,
  });
  return { proc, lines, fatals, done: proc.settled };
}

let tmpDir: string | null = null;
function tmp(): string {
  if (tmpDir === null) {
    tmpDir = mkdtempSync(join(tmpdir(), "codemux-session-proc-"));
  }
  return tmpDir;
}

/** Poll until `pid` is gone (ESRCH), or fail after `ms`. */
async function waitGone(pid: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await Bun.sleep(50);
  }
  return false;
}

describe("session process runner", () => {
  test(
    "delivers newline-framed lines and a final line without its newline",
    async () => {
      const { proc, lines, done } = harness(
        "printf 'one\\ntwo'; printf '\\nthree\\n'"
      );
      await done;
      expect(lines).toEqual(["one", "two", "three"]);
      expect((await proc.exited).code).toBe(0);
    }
  );

  test("blank lines are not delivered as events", async () => {
    const { lines, done } = harness("printf 'a\\n\\n\\nb\\n'");
    await done;
    expect(lines).toEqual(["a", "b"]);
  });

  test(
    "a line at exactly the cap is delivered; the cap is the boundary",
    async () => {
      const { proc, lines, fatals, done } = harness(
        `head -c ${MAX_HARNESS_LINE_BYTES} /dev/zero | tr '\\0' 'a'; printf '\\n'`
      );
      await done;
      expect(fatals).toEqual([]);
      expect(lines).toHaveLength(1);
      expect(Buffer.byteLength(lines[0] ?? "", "utf8")).toBe(
        MAX_HARNESS_LINE_BYTES
      );
      expect((await proc.exited).code).toBe(0);
    },
    20_000
  );

  test(
    "an unterminated run over the cap is a line-overflow fatal; the reader resyncs and the end path still settles",
    async () => {
      const { proc, lines, fatals, done } = harness(
        `head -c $(( ${MAX_HARNESS_LINE_BYTES} + 4096 )) /dev/zero | tr '\\0' 'a'; ` +
          "printf '\\nafter-resync\\n'; sleep 30"
      );
      // The fatal arrives while the child is still running; the session
      // layer would end it. Emulate that: wait for the fatal, then stop.
      await waitUntil(() => fatals.length === 1, 20_000);
      const fatal = fatals[0];
      expect(fatal?.kind).toBe("line-overflow");
      if (fatal?.kind === "line-overflow" || fatal?.kind === "invalid-utf8") {
        expect(fatal.bytes).toBe(MAX_HARNESS_LINE_BYTES + 4096);
        expect(Buffer.byteLength(fatal.excerpt, "utf8")).toBeLessThanOrEqual(
          4096 + 16
        );
      }
      // Nothing is delivered after a fatal, not even the post-resync line.
      expect(lines).toEqual([]);
      proc.requestStop();
      await done;
    },
    30_000
  );

  test("a complete line over the cap is a line-overflow fatal too", async () => {
    const { proc, lines, fatals, done } = harness(
      `head -c $(( ${MAX_HARNESS_LINE_BYTES} + 1 )) /dev/zero | tr '\\0' 'a'; printf '\\n'; sleep 30`
    );
    await waitUntil(() => fatals.length === 1, 20_000);
    expect(fatals[0]?.kind).toBe("line-overflow");
    expect(lines).toEqual([]);
    proc.requestStop();
    await done;
  }, 30_000);

  test(
    "framing a large line in pipe-sized chunks stays linear, not quadratic",
    async () => {
      // Review live15: the framer restarted its newline scan from byte 0
      // on every chunk, so a line near the cap arriving in ~64 KiB pipe
      // chunks cost a quadratic scan. The scan work runs in THIS process,
      // so the discriminator is its CPU time (load-insensitive), not wall
      // clock: the pre-fix scan of eight 12 MiB lines re-read ~8 GiB of
      // bytes (seconds of CPU); the linear framer reads each byte once
      // (~96 MiB, tens of milliseconds). The bound is an order of magnitude
      // above that: the CPU time measured here also carries Bun's own
      // UTF-8 decoding of the 96 MiB and the pipe reads, which on GitHub's
      // shared macOS runner exceeded a 600 ms bound (the whole test took
      // 7.5 s of wall clock there); the quadratic pre-fix scan still lands
      // seconds above 2500 ms on any host.
      const script =
        "i=0; while [ $i -lt 8 ]; do head -c 12582912 /dev/zero | tr '\\0' 'a'; printf '\\n'; i=$((i+1)); done";
      const cpuStarted = process.cpuUsage();
      const { proc, lines, done } = harness(script);
      await done;
      const cpuSpent = process.cpuUsage(cpuStarted);
      expect((await proc.exited).code).toBe(0);
      expect(lines).toHaveLength(8);
      expect(Buffer.byteLength(lines[0] ?? "", "utf8")).toBe(12582912);
      expect((cpuSpent.user + cpuSpent.system) / 1000).toBeLessThan(2500);
    },
    30_000
  );

  test("invalid UTF-8 on its own line is a fatal with an excerpt", async () => {
    const { proc, lines, fatals, done } = harness(
      "printf 'ok\\n'; printf '\\303\\250ok\\n'; printf '\\377\\376\\n'; printf 'never\\n'; sleep 30"
    );
    await waitUntil(() => fatals.length === 1, 10_000);
    expect(fatals[0]?.kind).toBe("invalid-utf8");
    // The valid line before the bad one was delivered; nothing after.
    expect(lines).toEqual(["ok", "èok"]);
    proc.requestStop();
    await done;
  }, 30_000);

  test("a throwing onLine becomes a handler fatal, never an invalid-utf8 one", async () => {
    // The tier-3 label must stay true to its name: an exception from the
    // handler is codemux's, not the harness's, so it is reported as its
    // own fatal class (found live on 2026-10-05: a registry EPERM thrown
    // through the handler was recast as "invalid-utf8" for a perfectly
    // valid line). Riding the fatal channel keeps the end path — and its
    // tree kill — running, so settled still resolves.
    const seen: string[] = [];
    const fatals: SessionFatal[] = [];
    const proc = new SessionProcess({
      command: ["/bin/sh", "-c", "printf 'fine\\n'; sleep 30"],
      cwd: tmp(),
      env: { PATH: "/usr/bin:/bin" },
      onLine: (line) => {
        seen.push(line);
        throw new Error("handler bug");
      },
      onFatal: (fatal) => {
        fatals.push(fatal);
      },
      graceMs: 100,
    });
    await waitUntil(() => fatals.length === 1, 10_000);
    expect(fatals[0]?.kind).toBe("handler");
    if (fatals[0]?.kind === "handler") {
      expect((fatals[0].error as Error).message).toBe("handler bug");
      expect(fatals[0].bytes).toBe("fine".length);
    }
    proc.requestStop();
    await proc.settled;
  }, 30_000);

  test("a stdout read error is a read-error fatal, never an unhandled rejection (review live25)", async () => {
    // Review live25, correctness-2 minor 6: nothing handled the stdout
    // reader's rejection until the child exited, so a pipe read error
    // before then was an unhandled rejection that ended codemux and left
    // the detached harness group running. The read now fails through the
    // fatal channel, and the driver's end path kills the tree.
    const realGetReader = ReadableStream.prototype.getReader;
    const spy = spyOn(ReadableStream.prototype, "getReader").mockImplementation(function (
      this: ReadableStream<Uint8Array>
    ) {
      const reader = realGetReader.call(this) as ReadableStreamDefaultReader<Uint8Array>;
      return {
        read: () => Promise.reject(new Error("EIO on the stdout pipe")),
        cancel: (reason?: unknown) => reader.cancel(reason),
        releaseLock: () => reader.releaseLock(),
        closed: reader.closed,
      } as unknown as ReadableStreamDefaultReader<Uint8Array>;
    } as typeof realGetReader);
    const fatals: SessionFatal[] = [];
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown): void => {
      rejections.push(reason);
    };
    process.on("unhandledRejection", onRejection);
    let proc: SessionProcess;
    try {
      proc = new SessionProcess({
        command: ["/bin/sh", "-c", "sleep 30"],
        cwd: tmp(),
        env: { PATH: "/usr/bin:/bin" },
        onLine: () => {},
        onFatal: (fatal) => {
          fatals.push(fatal);
        },
        graceMs: 100,
      });
    } finally {
      spy.mockRestore();
    }
    try {
      await waitUntil(() => fatals.length === 1, 10_000);
      expect(fatals[0]?.kind).toBe("read-error");
      expect(codemuxFatalMessage(fatals[0] as Extract<SessionFatal, { error: unknown }>)).toBe(
        "reading the harness's stdout failed: EIO on the stdout pipe"
      );
      proc.requestStop();
      await proc.settled;
      expect((await proc.exited).signal).not.toBeNull();
      expect(rejections).toEqual([]);
    } finally {
      process.off("unhandledRejection", onRejection);
    }
  }, 30_000);

  test("stdin round-trip: writeLine frames, endInput closes", async () => {
    const { proc, lines, done } = harness("while IFS= read -r line; do echo \"got:$line\"; done");
    expect(proc.writeLine('{"type":"user"}')).toEqual({ ok: true });
    expect(proc.writeLine("second")).toEqual({ ok: true });
    proc.endInput();
    await done;
    expect(lines).toEqual(['got:{"type":"user"}', "got:second"]);
  });

  test("writeLine refuses framing violations and oversize lines without corrupting the stream", async () => {
    const { proc, lines, done } = harness("while IFS= read -r line; do echo \"got:$line\"; done");
    expect(proc.writeLine("with\nnewline")).toEqual({ ok: false, reason: "framing" });
    expect(proc.writeLine("with\0nul")).toEqual({ ok: false, reason: "framing" });
    expect(proc.writeLine("with\rcr")).toEqual({ ok: false, reason: "framing" });
    const oversize = "a".repeat(MAX_INPUT_LINE_BYTES + 1);
    expect(proc.writeLine(oversize)).toEqual({ ok: false, reason: "oversize" });
    // The rejections never touched the wire: the next write round-trips.
    expect(proc.writeLine("intact")).toEqual({ ok: true });
    proc.endInput();
    await done;
    expect(lines).toEqual(["got:intact"]);
  }, 20_000);

  test("writeLine refuses past the unread stdin backlog and recovers once the harness reads", async () => {
    // Review live19 (the class of the codex pre-handshake buffer): Bun's
    // pipe sink buffers every write a harness has not read, without
    // limit, so a harness that stopped reading let the caller grow
    // codemux's memory. The backlog is now bounded; the drivers treat
    // the refusal as a codemux fatal.
    const { proc, done } = harness("sleep 1; cat >/dev/null");
    const chunk = "a".repeat(1024 * 1024);
    const results: Array<string> = [];
    for (let index = 0; index < 80; index++) {
      const result = proc.writeLine(chunk);
      results.push(result.ok ? "ok" : (result.reason as string));
      if (!result.ok) break;
    }
    expect(results.at(-1)).toBe("backlog");
    expect(results.filter((entry) => entry === "ok").length).toBeLessThanOrEqual(64);
    // Once the harness drains the pipe, the next write is accepted.
    const deadline = Date.now() + 10_000;
    let recovered = proc.writeLine("small");
    while (!recovered.ok && Date.now() < deadline) {
      await Bun.sleep(50);
      recovered = proc.writeLine("small");
    }
    expect(recovered).toEqual({ ok: true });
    proc.endInput();
    await done;
  }, 20_000);

  test("writeLine after endInput reports closed", async () => {
    const { proc, lines, done } = harness("while IFS= read -r line; do echo \"got:$line\"; done");
    proc.endInput();
    expect(proc.writeLine("late")).toEqual({ ok: false, reason: "closed" });
    await done;
    expect(lines).toEqual([]);
  });

  test("a child dying while a large line still drains is no unhandled rejection", async () => {
    // Review live14: a line larger than the pipe hands its remainder to
    // FileSink's async drain, and a child that exits mid-drain rejects
    // that write promise with EPIPE — the submit had already succeeded
    // (ok:true below), and the child's exit is the report. The rejection
    // used to escape as an unhandled one, failing whatever test was
    // running when it fired; writeLine now absorbs it. The child reads
    // nothing and dies with most of the megabyte still undrained, and the
    // trailing sleep keeps any escape inside THIS test.
    const { proc, fatals, done } = harness("sleep 0.2; exit 0");
    expect(proc.writeLine("x".repeat(1024 * 1024))).toEqual({ ok: true });
    await done;
    await Bun.sleep(50);
    expect((await proc.exited).code).toBe(0);
    expect(fatals).toEqual([]);
  });

  test(
    "requestStop: SIGTERM to the child, then the remembered grandchild dies",
    async () => {
      const { proc, lines, done } = harness(
        "sleep 60 & printf '%s\\n' $!; sleep 30"
      );
      await waitUntil(() => lines.length === 1, 10_000);
      const grandchild = Number(lines[0]);
      expect(Number.isInteger(grandchild)).toBe(true);
      proc.requestStop();
      await done;
      // The tree kill must have reached the orphaned sleep.
      expect(await waitGone(grandchild, 10_000)).toBe(true);
      const outcome = await proc.exited;
      // sh dies by signal or exits after its children are gone; either is
      // a clean stop from this layer's point of view. The assertion is
      // that the child is terminal at all — killed by the stop signal or
      // holding an exit code — never still running (both fields null).
      expect(outcome.signal === "SIGTERM" || outcome.code !== null).toBe(true);
    },
    30_000
  );

  test(
    "a clean exit kills descendants the periodic capture remembered",
    async () => {
      // The child stays alive past one capture tick (5 s), so the
      // grandchild is remembered while its parent chain is intact — the
      // only state from which the end-path kill can reach it (a walk taken
      // after the parent exited cannot attribute an orphan).
      const { lines, done } = harness(
        "sleep 60 & printf '%s\\n' $!; sleep 6; exit 0"
      );
      await waitUntil(() => lines.length === 1, 10_000);
      const grandchild = Number(lines[0]);
      await done;
      expect(await waitGone(grandchild, 10_000)).toBe(true);
    },
    30_000
  );

  test(
    "SIGTERM mid-session runs the shutdown path and exits 143, grandchild included",
    async () => {
      const driver = Bun.spawn(
        [process.execPath, join(import.meta.dir, "fixtures", "session", "sigterm-driver.ts")],
        {
          cwd: join(import.meta.dir, ".."),
          stdout: "pipe",
          stderr: "pipe",
          stdin: "ignore",
        }
      );
      const reader = (driver.stdout as ReadableStream<Uint8Array>).getReader();
      const decoder = new TextDecoder();
      let text = "";
      let grandchild = 0;
      while (grandchild === 0) {
        const { done, value } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
        const newline = text.indexOf("\n");
        if (newline !== -1) {
          const first = text.slice(0, newline);
          expect(first.startsWith("LINE:")).toBe(true);
          grandchild = Number(first.slice("LINE:".length));
        }
      }
      expect(grandchild).toBeGreaterThan(1);
      process.kill(driver.pid, "SIGTERM");
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
      }
      const exitCode = await driver.exited;
      expect(exitCode).toBe(143);
      expect(text).toContain(`LINE:${grandchild}`);
      expect(await waitGone(grandchild, 10_000)).toBe(true);
    },
    30_000
  );

  test("harness stderr passes through to codemux's stderr, never as lines", async () => {
    // Review live17, correctness major: stderr was piped into a capture
    // nothing read, so a harness that died at startup (an expired login,
    // a refused --model) left the caller only "exited unexpectedly". It
    // now passes through the way `run` passes it; stdout framing is
    // unaffected. The layer runs in a child so its stderr is observable.
    const script = [
      `import { SessionProcess } from ${JSON.stringify(join(import.meta.dir, "..", "src", "session", "process.ts"))};`,
      "const proc = new SessionProcess({",
      `  command: ["/bin/sh", "-c", "printf 'out\\n'; printf 'warn: login expired\\n' >&2; exit 3"],`,
      "  cwd: process.cwd(),",
      '  env: { PATH: "/usr/bin:/bin" },',
      "  onLine: (line) => process.stdout.write(`LINE:${line}\\n`),",
      "  onFatal: () => process.stdout.write('FATAL\\n'),",
      "  graceMs: 200,",
      "});",
      "await proc.settled;",
      "process.stdout.write(`CODE:${(await proc.exited).code}\\n`);",
    ].join("\n");
    const child = Bun.spawn([process.execPath, "-e", script], {
      cwd: tmp(),
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
    });
    const [stdout, stderr] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    await child.exited;
    expect(stdout).toBe("LINE:out\nCODE:3\n");
    expect(stderr).toContain("warn: login expired");
  });

  test("requestStop after the child exited arms no kill timer (review live18)", async () => {
    // Minor: requestStop on an already-settled process armed a SIGKILL
    // timer nothing cleared, holding the event loop for the whole grace
    // and then signaling a reaped process group. With a 5 s grace, the
    // child script below would live 5 s; it must exit at once.
    const script = [
      `import { SessionProcess } from ${JSON.stringify(join(import.meta.dir, "..", "src", "session", "process.ts"))};`,
      "const proc = new SessionProcess({",
      '  command: ["/bin/sh", "-c", "exit 0"],',
      "  cwd: process.cwd(),",
      '  env: { PATH: "/usr/bin:/bin" },',
      "  onLine: () => {},",
      "  onFatal: () => {},",
      "  graceMs: 5000,",
      "});",
      "await proc.settled;",
      "proc.requestStop();",
    ].join("\n");
    const began = Date.now();
    const child = Bun.spawn([process.execPath, "-e", script], {
      cwd: tmp(),
      stdout: "ignore",
      stderr: "ignore",
      stdin: "ignore",
    });
    expect(await child.exited).toBe(0);
    expect(Date.now() - began).toBeLessThan(3_000);
  });
});

describe("bounded outbound queue", () => {
  test("delivers entries to the sink in order and flushes", async () => {
    const delivered: string[] = [];
    const queue = new BoundedOutboundQueue(
      async (line) => {
        await Bun.sleep(2);
        delivered.push(line);
      },
      () => {}
    );
    for (const word of ["a", "b", "c", "d", "e"]) {
      expect(queue.enqueue(word)).toBe(true);
    }
    await queue.flush();
    expect(delivered).toEqual(["a", "b", "c", "d", "e"]);
    expect(queue.pending.events).toBe(0);
  });

  test("a stopped reader trips the event bound and reports the overflow", async () => {
    const overflows: unknown[] = [];
    const queue = new BoundedOutboundQueue(
      () => new Promise<void>(() => {}),
      (overflow) => overflows.push(overflow),
      { events: 3 }
    );
    expect(queue.enqueue("one")).toBe(true);
    expect(queue.enqueue("two")).toBe(true);
    expect(queue.enqueue("three")).toBe(true);
    expect(queue.enqueue("four")).toBe(false);
    expect(overflows).toHaveLength(1);
    expect((overflows[0] as { events: number }).events).toBe(4);
  });

  test("the overflow class latches too: harness lines after the first breach cannot re-fire it", async () => {
    // The drivers keep enqueueing while harness lines arrive; an unlatched
    // overflow re-reported the diagnostic per line. Like the sink class,
    // the class fires exactly once.
    const overflows: unknown[] = [];
    const queue = new BoundedOutboundQueue(
      () => new Promise<void>(() => {}),
      (overflow) => overflows.push(overflow),
      { events: 2 }
    );
    expect(queue.enqueue("one")).toBe(true);
    expect(queue.enqueue("two")).toBe(true);
    for (const line of ["three", "four", "five", "six"]) {
      expect(queue.enqueue(line)).toBe(false);
    }
    expect(overflows).toHaveLength(1);
  });

  test("the byte bound counts UTF-8 bytes plus the newline", async () => {
    const overflows: unknown[] = [];
    const queue = new BoundedOutboundQueue(
      () => new Promise<void>(() => {}),
      (overflow) => overflows.push(overflow),
      { bytes: 10 }
    );
    // "aaaaé" is 6 bytes + 1 newline = 7.
    expect(queue.enqueue("aaaaé")).toBe(true);
    // "bbb" is 3 + 1 = 4; 7 + 4 > 10.
    expect(queue.enqueue("bbb")).toBe(false);
    expect(overflows).toHaveLength(1);
    expect((overflows[0] as { bytes: number }).bytes).toBe(11);
  });

  test("a failing sink poisons the queue: the failure is reported once, enqueue refuses, flush rejects", async () => {
    const failures: { kind: string; error?: unknown }[] = [];
    const queue = new BoundedOutboundQueue(
      () => {
        throw new Error("sink broke");
      },
      (failure) => failures.push(failure)
    );
    expect(queue.enqueue("line")).toBe(true);
    await Bun.sleep(10);
    expect(queue.enqueue("later")).toBe(false);
    // The sink failure reached the callback exactly once, with its class
    // and the error — silently disabling delivery is the defect this
    // pins (a dead sink must be as loud as an overrun bound).
    expect(failures).toHaveLength(1);
    expect(failures[0]?.kind).toBe("sink");
    expect((failures[0]?.error as Error).message).toBe("sink broke");
    expect(queue.enqueue("again")).toBe(false);
    expect(failures).toHaveLength(1);
    await expect(queue.flush()).rejects.toThrow("sink broke");
  });

  test("abandon drops the entries and releases a flush waiting on a stalled sink", async () => {
    // Review live3, correctness 1: a sink that neither resolves nor
    // throws left flush()'s poll loop spinning forever. abandon() is the
    // give-up's release valve — flush() resolves, pending empties, and
    // further enqueues refuse — so the driver's end path can report the
    // final event undelivered and still finish.
    const queue = new BoundedOutboundQueue(
      () => new Promise<void>(() => {}),
      () => {}
    );
    expect(queue.enqueue("final")).toBe(true);
    await Bun.sleep(10);
    expect(queue.pending.events).toBe(1);
    queue.abandon();
    expect(queue.pending.events).toBe(0);
    expect(queue.pending.bytes).toBe(0);
    // The stalled flush resolves instead of hanging.
    await queue.flush();
    expect(queue.enqueue("after")).toBe(false);
    // Idempotent: a second abandon changes nothing.
    queue.abandon();
    await queue.flush();
  });

  test("awaitFinalFlush reports a stalled final flush as undelivered, a completed one as delivered", async () => {
    const stalled = new BoundedOutboundQueue(
      () => new Promise<void>(() => {}),
      () => {}
    );
    stalled.enqueue("final");
    const startedAt = Date.now();
    expect(await awaitFinalFlush(stalled, 50)).toBe(false);
    // Bounded by the give-up, not by the sink.
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    const completed: string[] = [];
    const healthy = new BoundedOutboundQueue(
      (line) => {
        completed.push(line);
      },
      () => {}
    );
    healthy.enqueue("final");
    expect(await awaitFinalFlush(healthy, 1_000)).toBe(true);
    expect(completed).toEqual(["final"]);
    const broke = new BoundedOutboundQueue(
      () => {
        throw new Error("sink broke");
      },
      () => {}
    );
    broke.enqueue("final");
    expect(await awaitFinalFlush(broke, 1_000)).toBe(false);
  });
});

describe("session signal gate", () => {
  test("fires once, absorbs repeats, and dispose removes the handlers", async () => {
    const fired: string[] = [];
    const gate = installSessionSignalHandlers((signal) => {
      fired.push(signal);
    });
    gate.trigger("SIGTERM");
    gate.trigger("SIGINT");
    gate.trigger("SIGHUP");
    expect(fired).toEqual(["SIGTERM"]);
    gate.dispose();
  });
});

async function waitUntil(predicate: () => boolean, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await Bun.sleep(25);
  }
}

// Cleanup for the shared tmp dir once this file's tests are done.
process.on("beforeExit", () => {
  if (tmpDir !== null) {
    rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  }
});
