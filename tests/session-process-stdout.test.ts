import { describe, expect, spyOn, test } from "bun:test";
import {
  codemuxFatalMessage,
  MAX_HARNESS_LINE_BYTES,
  SessionProcess,
  type SessionFatal,
} from "../src/session/process.js";
import { harness, tmp, waitUntil } from "./helpers/session-process.js";

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

  test("a CRLF wire's blank lines are framing whitespace, not events (review round 147)", async () => {
    // A harness that ends every line with \r\n: the JSON lines keep their
    // carriage return (JSON.parse accepts trailing whitespace), and the
    // lone \r between them — the CRLF blank line — is dropped instead of
    // being judged unusable and ending the session.
    const { lines, fatals, done } = harness(
      "printf '{\"a\":1}\\r\\n\\r\\n{\"b\":2}\\r\\n'"
    );
    await done;
    expect(lines).toEqual(['{"a":1}\r', '{"b":2}\r']);
    expect(fatals).toEqual([]);
  });

  test("a lone CRLF newline between frames is ignored", async () => {
    const { lines, fatals, done } = harness("printf 'x\\r\\n\\r\\ny\\r\\n'");
    await done;
    expect(lines).toEqual(["x\r", "y\r"]);
    expect(fatals).toEqual([]);
  });

  test("a line of spaces is delivered and judged as before", async () => {
    // The rule covers the empty line and the CRLF blank only; other
    // whitespace stays a line the parsers judge.
    const { lines, fatals, done } = harness("printf 'x\\n   \\ny\\n'");
    await done;
    expect(lines).toEqual(["x", "   ", "y"]);
    expect(fatals).toEqual([]);
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
    "a paced oversized line reports the bytes seen at the crossing, the figure docs/session-protocol.md documents (review round 87)",
    async () => {
      // The writer stops right past the cap, then appends more of the same
      // line before its newline: only MAX+1 bytes exist when the reader
      // first crosses the cap, so cumulative length at the crossing is
      // exactly that, whatever chunk boundaries the pipe chose. The bytes
      // that land during resynchronization are discarded uncounted — the
      // documented figure, not the full discarded run, because the fatal
      // fires at the crossing so the session ends without waiting for a
      // newline that may never arrive.
      const { proc, lines, fatals, done } = harness(
        `head -c $(( ${MAX_HARNESS_LINE_BYTES} + 1 )) /dev/zero | tr '\\0' 'a'; sleep 1; ` +
          "head -c 4096 /dev/zero | tr '\\0' 'a'; printf '\\nafter-resync\\n'; sleep 30"
      );
      await waitUntil(() => fatals.length === 1, 20_000);
      const fatal = fatals[0];
      expect(fatal?.kind).toBe("line-overflow");
      if (fatal?.kind === "line-overflow" || fatal?.kind === "invalid-utf8") {
        expect(fatal.bytes).toBe(MAX_HARNESS_LINE_BYTES + 1);
      }
      // Nothing is delivered after a fatal, not even the post-resync line.
      expect(lines).toEqual([]);
      proc.requestStop();
      await done;
    },
    30_000
  );

  test(
    "framing a large line in pipe-sized chunks stays linear, not quadratic",
    async () => {
      // Review live15: the framer restarted its newline scan from byte 0
      // on every chunk, so a line near the cap arriving in ~64 KiB pipe
      // chunks cost a scan quadratic in the line size. The discriminator
      // compares the SAME 12 MiB of bytes written by the child as one line
      // and as 192 lines of 64 KiB: spawn, pipe reads, and decoding cost
      // the same in both runs, the linear framer pays about the same for
      // both, and the quadratic one rescans the growing buffer on every
      // chunk of the long line (~1.2 GiB of indexOf). CPU time of this
      // process is measured, so the host's speed cancels out; no absolute
      // bound. Measured 2026-10-07: linear 35 ms short / 18 ms long (the
      // long line has fewer per-line deliveries); with `searchFrom = 0`
      // reinstated in `readStdoutLines` (the quadratic restart) 301 ms
      // long — 8x the short run, against a 2x bound.
      const total = 12 * 1024 * 1024;
      const cpuMs = async (lineBytes: number): Promise<number> => {
        const count = total / lineBytes;
        const script = `i=0; while [ $i -lt ${count} ]; do head -c ${lineBytes} /dev/zero | tr '\\0' 'a'; printf '\\n'; i=$((i+1)); done`;
        const started = process.cpuUsage();
        const { proc, lines, done } = harness(script);
        await done;
        const spent = process.cpuUsage(started);
        expect((await proc.exited).code).toBe(0);
        expect(lines).toHaveLength(count);
        expect(Buffer.byteLength(lines[0] ?? "", "utf8")).toBe(lineBytes);
        return (spent.user + spent.system) / 1000;
      };
      const best = async (lineBytes: number): Promise<number> => {
        let min = Number.POSITIVE_INFINITY;
        for (let i = 0; i < 2; i += 1) min = Math.min(min, await cpuMs(lineBytes));
        return min;
      };
      const short = await best(64 * 1024);
      const long = await best(total);
      expect(long).toBeLessThan(2 * short + 30);
    },
    120_000
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

  test("a fatal handler that throws ends the session by killing the tree, never an unhandled rejection (review round 149)", async () => {
    // The read-error path reports its fatal from the stdout promise's
    // catch. A handler that threw there rejected that promise, which
    // nothing awaits until the child exits: codemux ended on the
    // unhandled rejection and the detached harness kept running. The
    // throw is now contained and the tree is killed, with no stop request.
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
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown): void => {
      rejections.push(reason);
    };
    process.on("unhandledRejection", onRejection);
    const stderr = spyOn(process.stderr, "write").mockImplementation(() => true);
    let handled = 0;
    let proc: SessionProcess;
    try {
      proc = new SessionProcess({
        command: ["/bin/sh", "-c", "sleep 30"],
        cwd: tmp(),
        env: { PATH: "/usr/bin:/bin" },
        onLine: () => {},
        onFatal: () => {
          handled += 1;
          throw new Error("fatal handler bug");
        },
        graceMs: 10_000,
      });
    } finally {
      spy.mockRestore();
    }
    try {
      await proc.settled;
      expect((await proc.exited).signal).toBe("SIGKILL");
      expect(handled).toBe(1);
      expect(rejections).toEqual([]);
      expect(stderr.mock.calls.map((call) => String(call[0]))).toEqual([
        "codemux: internal error while reporting a session failure: fatal handler bug\n",
      ]);
    } finally {
      stderr.mockRestore();
      process.off("unhandledRejection", onRejection);
      proc.escalateStop();
    }
  }, 30_000);

  test("a child that ignores SIGTERM is SIGKILLed by the tree when the grace runs out", async () => {
    // The stop path's armed escalation: requestStop gives the harness one
    // grace period, then the kill timer takes the whole tree down. A sh
    // that traps TERM keeps running past the grace, so the timer fires.
    // The child prints a line once the trap is installed, so the stop is
    // never sent before it.
    const { proc, lines, done } = harness("trap '' TERM\necho ready\nsleep 30", 150);
    try {
      await waitUntil(() => lines.length === 1, 10_000);
      proc.requestStop();
      const outcome = await proc.exited;
      expect(outcome.signal).toBe("SIGKILL");
      await done;
    } finally {
      proc.requestStop();
      await done;
    }
  }, 30_000);

  test("escalateStop SIGKILLs the child's tree at once, once per child", async () => {
    // The second-signal escalation (rounds al30/al33): no grace, no timer,
    // and latched — however many paths reach it, one kill.
    const { proc, done } = harness("trap '' TERM\nsleep 30", 10_000);
    try {
      await Bun.sleep(200);
      proc.escalateStop();
      proc.escalateStop();
      const outcome = await proc.exited;
      expect(outcome.signal).toBe("SIGKILL");
      await done;
    } finally {
      proc.escalateStop();
      await done;
    }
  }, 30_000);
});
