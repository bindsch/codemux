// ProbeRunner behavior for the live gate: output matching, capture,
// cancellation, timeouts, signals, and report directories.
// scripts/live-gate/runner.ts owns the runner.
import { expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ProbeRunner, createReportDirectory, runPool, verifyResultEnvelope } from "../scripts/live-gate.js";
import { fixtureDirectory } from "./helpers/live-gate.js";

test("live gate limits concurrent probes", async () => {
  let running = 0;
  let peak = 0;
  let finished = 0;
  await runPool(Array.from({ length: 9 }, () => async () => {
    running++;
    peak = Math.max(peak, running);
    await Bun.sleep(5);
    running--;
    finished++;
  }), 4);
  expect(peak).toBe(4);
  expect(finished).toBe(9);
});

test("live gate requires exact trimmed output and a zero exit", async () => {
  const runner = new ProbeRunner();
  const probe = (source: string) => runner.run([process.execPath, "-e", source], "OK", 5);
  expect((await probe('console.log(" OK ")')).status).toBe("PASS");
  const mismatch = await probe('console.log("secret unexpected output")');
  expect(mismatch.status).toBe("FAIL");
  expect(mismatch.stderr).toBe("exit 0; stdout: secret unexpected output\\u000a");
  const failure = await probe('console.log("OK"); console.error("first\\tline"); console.error("secret second line"); process.exit(7)');
  expect(failure.status).toBe("FAIL");
  expect(failure.stderr).toBe("first\\tline");
  expect(JSON.stringify(failure)).not.toContain("secret second line");
});

test("live gate skips banner lines but keeps Warning: lines in the note", async () => {
  const source = 'process.stderr.write("\\nRunning with aider (sandboxed)...\\nWar"); await Bun.sleep(10); process.stderr.write("ning: claude 2.1.300 is newer than the 2.1.280 this Codemux audited\\nactual\\tproblem"); process.exit(7);';
  const result = await new ProbeRunner().run([process.execPath, "-e", source], "OK", 5);
  expect(result.status).toBe("FAIL");
  expect(result.stderr).toBe("actual\\tproblem");
  expect(result.note).toContain("Warning: claude 2.1.300 is newer");
  const passing = await new ProbeRunner().run([process.execPath, "-e", 'console.log("OK"); process.stderr.write("Warning: unaudited build\\n")'], "OK", 5);
  expect(passing.status).toBe("PASS");
  expect(passing.note).toBe("Warning: unaudited build");
});

test("live gate keeps a Warning: line that arrives after an ordinary stderr line", async () => {
  // Review round 5, edges finding 5: the classifier ran only while no
  // ordinary line was stored, so a Warning: after one never reached the
  // note and the PASS row carried nothing.
  const source = 'console.log("OK"); process.stderr.write("diagnostic\\nWarning: stale contract\\n");';
  const result = await new ProbeRunner().run([process.execPath, "-e", source], "OK", 5);
  expect(result.status).toBe("PASS");
  // A passing row keeps no stderr by design; the note is where the
  // warning must survive.
  expect(result.note).toContain("Warning: stale contract");
});

test("live gate falls back to the exit code and at most 80 stdout characters", async () => {
  for (const output of ["", "x".repeat(100)]) {
    const source = `process.stderr.write("Running with aider (sandboxed)...\\n\\n"); process.stdout.write(${JSON.stringify(output)}); process.exit(9);`;
    const result = await new ProbeRunner().run([process.execPath, "-e", source], "OK", 5);
    expect(result.stderr).toBe(output ? `exit 9; stdout: ${"x".repeat(80)}` : "exit 9");
  }
});

test("live gate capture verifies envelopes and requires a zero exit", async () => {
  const runner = new ProbeRunner();
  const block = JSON.stringify({ agent: "claude", model: null, served_model: null, labels: null,
    usage: { input_tokens: 1, output_tokens: 2, cached_input_tokens: null, total_tokens: 3, cost_usd: null },
    session_id: null, recording: null, failure_code: null });
  const probe = (source: string) => runner.capture([process.execPath, "-e", source], (captured) => verifyResultEnvelope(captured.stdout, "claude"), 5);
  // The reply carries the trailing newline a real harness answer has;
  // the verifier trims it the way the run probes do.
  const passed = await probe(`console.log(JSON.stringify({ result: "OK\\n", codemux: ${block} }))`);
  expect(passed.status).toBe("PASS");
  const broken = await probe('console.log("not json")');
  expect(broken.status).toBe("FAIL");
  expect(broken.stderr).toContain("result JSON does not parse");
  const failed = await probe('console.log(JSON.stringify({ result: "OK", codemux: { agent: null } }))');
  expect(failed.status).toBe("FAIL");
  expect(failed.stderr).toBe("result JSON's codemux.agent is null, not the probed claude");
  const nonzero = await probe(`console.log(JSON.stringify({ result: "OK\\n", codemux: ${block} })); process.exit(3)`);
  expect(nonzero.status).toBe("FAIL");
  expect(nonzero.stderr).toContain("exit 3");
});

test("live gate capture sends stdin and closes it", async () => {
  const result = await new ProbeRunner().capture(
    [process.execPath, "-e", 'process.stdout.write((await Bun.stdin.text()).trim().toUpperCase())'],
    (captured) => (captured.stdout.trim() === "REPLY WITH EXACTLY: OK" ? null : "wrong reply"), 5, undefined, "Reply with exactly: OK\n");
  expect(result.status).toBe("PASS");
});

test("live gate scripted stdin stays open through a running turn and ends after its last frame", async () => {
  // Probe F, finding 1: a fixed stdin string closes the pipe at once,
  // which a session driver reads as EOF and answers by draining the
  // session instead of running the turn — the live gate's own evidence
  // had codex reject the frame (`shutting_down`) and kimi die by signal
  // mid-turn. A StdinScript keeps the pipe open: this child spends 400 ms
  // mid-turn, and the frame it reads after `turn_completed` must be the
  // scripted shutdown frame, not EOF — the write can only have landed
  // after the runner read that completion line. Writing the frame ends
  // stdin, so the child's next read is EOF.
  const source = `
    const reader = Bun.stdin.stream().getReader();
    const decoder = new TextDecoder();
    let pending = "";
    const readFrame = async () => {
      for (;;) {
        const newline = pending.indexOf("\\n");
        if (newline !== -1) {
          const line = pending.slice(0, newline);
          pending = pending.slice(newline + 1);
          return JSON.parse(line);
        }
        const { value, done } = await reader.read();
        if (done) return { type: "stdin-eof" };
        pending += decoder.decode(value, { stream: true });
      }
    };
    await readFrame();
    await Bun.sleep(400);
    console.log(JSON.stringify({ type: "turn_completed", finish: "end" }));
    console.log((await readFrame()).type);
    console.log((await readFrame()).type);
  `;
  const result = await new ProbeRunner().capture(
    [process.execPath, "-e", source],
    (captured) => {
      const lines = captured.stdout.trim().split("\n").slice(1);
      if (lines[0] !== "shutdown") return `the frame after turn_completed is ${JSON.stringify(lines[0])}, not the scripted shutdown frame`;
      if (lines[1] !== "stdin-eof") return "stdin stayed open after the scripted frame";
      return null;
    },
    30,
    undefined,
    {
      open: `${JSON.stringify({ type: "user", text: "Reply with exactly: OK" })}\n`,
      next: (line) => (line.includes("turn_completed") ? `${JSON.stringify({ type: "shutdown" })}\n` : null),
    });
  expect(result.status).toBe("PASS");
});

test("live gate capture fails closed when stdout exceeds the capture limit", async () => {
  // Review round 4, edges finding 5: a truncated capture used to PASS on
  // the verifier's word, but the verifier judged a prefix — the proof it
  // accepted may simply have sat beyond the limit. The full stdout still
  // reaches the report file.
  const directory = fixtureDirectory();
  try {
    const prefix = join(directory, "oversize");
    const oversize = await new ProbeRunner().capture(
      [process.execPath, "-e", 'process.stdout.write("x".repeat(600 * 1024))'],
      () => null, 30, prefix);
    expect(oversize.status).toBe("FAIL");
    expect(oversize.stderr).toBe("stdout exceeded the capture limit; the verifier saw a prefix only");
    expect(readFileSync(`${prefix}.out`, "utf8").length).toBe(600 * 1024);
    // A reply that ends exactly at the limit dropped nothing: complete,
    // not a prefix, so a passing verifier still passes.
    const exact = await new ProbeRunner().capture(
      [process.execPath, "-e", `process.stdout.write("x".repeat(${512 * 1024}))`],
      () => null, 30);
    expect(exact.status).toBe("PASS");
    // The exact limit followed by one more byte in a LATER chunk: the
    // buffer was full when the byte arrived, so nothing was dropped by
    // the slice — the chunk itself is the evidence of a prefix (the
    // runner's other truncation arm).
    const late = await new ProbeRunner().capture(
      [
        process.execPath,
        "-e",
        `await Bun.write(Bun.stdout, "x".repeat(${512 * 1024})); await Bun.sleep(100); await Bun.write(Bun.stdout, "y");`,
      ],
      () => null, 30);
    expect(late.status).toBe("FAIL");
    expect(late.stderr).toBe("stdout exceeded the capture limit; the verifier saw a prefix only");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("live gate preserves complete raw stdout and stderr for passing and failing probes", async () => {
  const directory = fixtureDirectory();
  try {
    for (const exit of [0, 7]) {
      const prefix = join(directory, `agy-${exit === 0 ? "A" : "B"}`);
      const stdout = exit === 0 ? " OK \n" : `${"x".repeat(200)}\n`;
      const stderr = "Running with aider (sandboxed)...\nWarning: version\nfirst\tproblem\nsecond problem\n";
      const source = `process.stdout.write(${JSON.stringify(stdout)}); process.stderr.write(${JSON.stringify(stderr)}); process.exit(${exit});`;
      const result = await new ProbeRunner().run([process.execPath, "-e", source], "OK", 5, prefix);
      expect(result.status).toBe(exit === 0 ? "PASS" : "FAIL");
      expect(readFileSync(`${prefix}.out`, "utf8")).toBe(stdout);
      expect(readFileSync(`${prefix}.err`, "utf8")).toBe(stderr);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test.each([0, 100])("live gate cancels failed capture and waits for child termination after %s ms", async (delay) => {
  let controller: ReadableStreamDefaultController<Uint8Array>;
  let canceled = false;
  const stdout = new ReadableStream<Uint8Array>({
    start(value) { controller = value; },
    cancel() { canceled = true; },
  });
  const stderr = new ReadableStream<Uint8Array>({
    start(value) { value.error(new Error("capture failed")); },
  });
  let childExited = false;
  let killedBeforeExit = false;
  let exitTimer: ReturnType<typeof setTimeout> | undefined;
  let exitChild!: (code: number) => void;
  const exited = new Promise<number>((resolve) => { exitChild = resolve; });
  const child = { pid: 2147483647, stdout, stderr, exited } as Bun.Subprocess<"pipe", "pipe", "pipe">;
  const spawn = spyOn(Bun, "spawn").mockReturnValueOnce(child);
  const kill = spyOn(process, "kill").mockImplementation((_pid, signal) => {
    if (signal === "SIGKILL" && !childExited) killedBeforeExit = true;
    if (signal === "SIGTERM" && exitTimer === undefined) {
      exitTimer = setTimeout(() => { childExited = true; exitChild(0); }, delay);
    }
    return true;
  });
  try {
    const result = await new ProbeRunner().run(["stub-child"], "OK", 5);
    expect(result.status).toBe("FAIL");
    expect(result.stderr).toBe("could not capture probe output");
    expect(childExited).toBe(true);
    expect(killedBeforeExit).toBe(false);
    expect(canceled).toBe(true);
    expect(stdout.locked).toBe(false);
  } finally {
    clearTimeout(exitTimer);
    if (!canceled) controller!.close();
    spawn.mockRestore();
    kill.mockRestore();
  }
});

test("live gate creates report directories under scratch or the system temporary directory", () => {
  const directory = fixtureDirectory();
  const reports: string[] = [];
  try {
    for (const scratch of [directory, join(directory, "absent")]) {
      const report = createReportDirectory(scratch);
      reports.push(report);
      expect(dirname(report)).toBe(existsSync(scratch) ? join(scratch, "live-gate") : tmpdir());
      expect(readdirSync(report)).toEqual([]);
    }
    expect(createReportDirectory(directory)).not.toBe(reports[0]);
  } finally {
    for (const report of reports) rmSync(report, { recursive: true, force: true });
    rmSync(directory, { recursive: true, force: true });
  }
});

test.each(["SIGINT", "SIGTERM", "SIGHUP"] as const)("live gate stops the process group and blocks new probes after %s", async (signal) => {
  const runner = new ProbeRunner();
  const kill = spyOn(process, "kill");
  try {
    const pending = runner.run([process.execPath, "-e", "setInterval(() => {}, 1000)"], "OK", 10);
    runner.interrupt(signal);
    expect((await pending).status).toBe("FAIL");
    expect(runner.interrupted).toBe(signal);
    expect(kill.mock.calls.some(([pid, sent]) => pid < 0 && sent === "SIGTERM")).toBe(true);
    const next = await runner.run([process.execPath, "-e", 'console.log("OK")'], "OK", 5);
    expect(next.status).toBe("FAIL");
    expect(next.stderr).toContain("interrupted");
  } finally {
    kill.mockRestore();
  }
});

test("live gate stops a probe whose stdin write is still pending when the interrupt lands (round 13, edges 4)", async () => {
  const runner = new ProbeRunner();
  const kill = spyOn(process, "kill");
  try {
    // A child that never reads its stdin and exits on its own after two
    // seconds: one mebibyte into a 64-KiB pipe keeps the write pending
    // for the child's whole life, so the interrupt below lands inside
    // that await — the window the old code left the probe unregistered
    // for. Registered before the write, the interrupt stops the child
    // at once instead of waiting out its own exit.
    const pending = runner.run(
      [process.execPath, "-e", "setTimeout(() => process.exit(0), 2000)"],
      "OK",
      10,
      undefined,
      "x".repeat(1 << 20)
    );
    await Bun.sleep(50);
    runner.interrupt("SIGINT");
    const result = await pending;
    expect(result.status).toBe("FAIL");
    expect(result.stderr).toBe("interrupted");
    expect(kill.mock.calls.some(([pid, sent]) => pid < 0 && sent === "SIGTERM")).toBe(true);
  } finally {
    kill.mockRestore();
  }
});

test("live gate kills a process group that ignores termination on timeout", async () => {
  const scratch = join(import.meta.dir, "../scratch");
  mkdirSync(scratch, { recursive: true });
  const directory = mkdtempSync(join(scratch, "live-gate-timeout-"));
  const pidFile = join(directory, "pid");
  const source = `process.on("SIGTERM", () => {}); console.error("earlier error"); await Bun.write(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`;
  try {
    const result = await new ProbeRunner().run([process.execPath, "-e", source], "OK", 1);
    expect(result.status).toBe("FAIL");
    expect(result.stderr).toBe("timeout");
    const pid = Number(readFileSync(pidFile, "utf8"));
    expect(() => process.kill(pid, 0)).toThrow();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("live gate times out a child that never reads its stdin (round 31, edges 2)", async () => {
  // The pipe buffer fills (64 KiB on macOS and Linux) and the parent's
  // write would block forever unless the deadline was armed first.
  const runner = new ProbeRunner();
  const started = performance.now();
  const result = await runner.capture(
    [process.execPath, "-e", "await Bun.sleep(30_000)"],
    () => null, 1, undefined, "x".repeat(4 * 1024 * 1024)
  );
  expect(result.status).toBe("FAIL");
  expect(result.stderr).toBe("timeout");
  expect(performance.now() - started).toBeLessThan(15_000);
}, 20_000);

test("--codex-model names the alias the codex experiment probe carries, worker by default (round 35, edges 1)", async () => {
  const { parseOptions } = await import("../scripts/live-gate.js");
  expect(parseOptions([], "").codexModel).toBe("worker");
  expect(parseOptions(["--codex-model", "gpt-6-astra"], "").codexModel).toBe("gpt-6-astra");
  expect(() => parseOptions(["--codex-model", " "], "")).toThrow("nonempty");
});


test("a probe command that cannot be spawned fails naming the probe command, not codemux", async () => {
  // Probe J runs scode directly since 2026-11-06, so the spawn failure line
  // no longer names a launcher the row may never have started (review
  // round 187).
  const directory = fixtureDirectory();
  try {
    const result = await new ProbeRunner().run([join(directory, "absent-command")], "OK", 5);
    expect(result).toMatchObject({ status: "FAIL", stderr: "could not start the probe command" });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
