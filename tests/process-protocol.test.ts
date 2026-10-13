import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_CAPTURE_BYTES, runCapturedCommand, type StdoutSink } from "../src/process-runner.js";
import { ClaudeAdapter } from "../src/adapters/claude.js";
import { ExperimentBridge } from "../src/experiment-bridge.js";
import { ExperimentServer } from "../src/experiment-server.js";
import { launchRunRequest } from "../src/launch.js";
import { CALL_LOG_ENV, readCallLog } from "../src/call-log.js";
import { createFakeBinaryEnv } from "./helpers/cli.js";
import type { RunResult } from "../src/types.js";

test("SIGTERM during protocol drainage finalizes the recording and interruption receipt before exit", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "codemux-signal-drain-"));
  const script = `
    import { runCapturedCommand } from ${JSON.stringify(join(import.meta.dir, "../src/process-runner.ts"))};
    import { ExperimentBridge } from ${JSON.stringify(join(import.meta.dir, "../src/experiment-bridge.ts"))};
    import { ExperimentServer } from ${JSON.stringify(join(import.meta.dir, "../src/experiment-server.ts"))};
    import { writeFileSync, readFileSync } from "node:fs";
    const cwd = process.argv[1];
    const bridge = new ExperimentBridge({ name: "experiment", command: process.execPath, args: [], env: [], recording: cwd }, cwd, "probe");
    ExperimentServer.prototype.close = async function () {
      process.kill(process.pid, "SIGTERM");
      await Bun.sleep(50);
    };
    process.on("exit", () => writeFileSync(cwd + "/exit-cleanup", "cleaned"));
    await runCapturedCommand([process.execPath, "-e", "console.log('OK')"], {
      cwd, env: {}, stdoutSink: { push() {}, finish() { return "OK"; }, keptBytes() { return 0; },
        terminateProtocol() { bridge.terminateProtocol(); }, closeProtocol() { return bridge.closeProtocol(); } },
      async onSignaled() {
        if (!readFileSync(bridge.recordingPath, "utf8").includes('"kind":"run_end"')) throw new Error("receipt before finalization");
        await Bun.sleep(25);
        writeFileSync(cwd + "/receipt", "143");
      }
    });`;
  try {
    const child = Bun.spawn([process.execPath, "-e", script, cwd], { stdout: "pipe", stderr: "pipe" });
    const [exit, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect(exit).toBe(143);
    expect(stderr).toContain("interrupted");
    expect(readFileSync(join(cwd, "receipt"), "utf8")).toBe("143");
    expect(readFileSync(join(cwd, "exit-cleanup"), "utf8")).toBe("cleaned");
    const recording = readdirSync(cwd).find((name) => name.endsWith(".jsonl"))!;
    const records = readFileSync(join(cwd, recording), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(records.at(-1).kind).toBe("run_end");
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test.each([false, true])("adapter cleanup retains the completed result in the ledger; sandbox=%s", async (sandbox) => {
  const cwd = mkdtempSync(join(tmpdir(), "codemux-adapter-cleanup-"));
  const ledger = join(cwd, "calls.jsonl");
  const previous = process.env[CALL_LOG_ENV];
  process.env[CALL_LOG_ENV] = ledger;
  const fake = createFakeBinaryEnv({ scode: 'while [ "$1" != "--" ]; do shift; done; shift; exec "$@"' });
  let cleanups = 0;
  class CleanupFailureAdapter extends ClaudeAdapter {
    override prepareRun() { return {}; }
    override buildRunCommand() { return [process.execPath, "-e", 'console.log("OK")']; }
    override processRunResult(raw: RunResult) { return raw; }
    override async cleanupRun() {
      cleanups++;
      expect(existsSync(ledger)).toBe(false);
      await Promise.resolve();
      throw new Error("private home cleanup refused");
    }
  }
  try {
    const result = await launchRunRequest(new CleanupFailureAdapter(fake.env),
      { agent: "claude", prompt: "probe", cwd, autonomy: "high", sandboxed: sandbox },
      { sandbox, requestedAutonomy: "high", cwd });
    expect(result).toMatchObject({ exitCode: 0, success: true, stdout: "OK\n" });
    expect(result.stderr).toContain("cleanup failed: private home cleanup refused");
    expect(cleanups).toBe(1);
    const records = readCallLog(ledger).entries;
    expect(records).toHaveLength(1);
    expect(records[0]!.record!.exit_code).toBe(0);
  } finally {
    if (previous === undefined) delete process.env[CALL_LOG_ENV]; else process.env[CALL_LOG_ENV] = previous;
    fake.cleanup();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("SIGTERM reports a recording finalization failure before exit 143", async () => {
  const script = `
    import { runCapturedCommand } from ${JSON.stringify(join(import.meta.dir, "../src/process-runner.ts"))};
    await runCapturedCommand([process.execPath, "-e", "console.log('OK')"], {
      cwd: process.cwd(), env: {},
      stdoutSink: { push() {}, finish() { return "OK"; }, keptBytes() { return 0; },
        async closeProtocol() {
          process.kill(process.pid, "SIGTERM");
          await Bun.sleep(50);
          throw new Error("recording fsync failed");
        }
      }
    });`;
  const child = Bun.spawn([process.execPath, "-e", script], { stdout: "pipe", stderr: "pipe" });
  const [exit, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  expect(exit).toBe(143);
  expect(stderr).toContain("interrupted");
  expect(stderr).toContain("cleanup failed: recording fsync failed");
});

test.each(["limit", "invalid UTF-8", "protocol"])("%s cancels partial Claude stdout without replacing the original failure", async (kind) => {
  const cwd = mkdtempSync(join(tmpdir(), "codemux-canceled-frame-"));
  const bridge = new ExperimentBridge({ name: "experiment", command: process.execPath, args: [], env: [], recording: cwd }, cwd, "probe");
  let stderr!: ReadableStreamDefaultController<Uint8Array>;
  let abort!: () => void;
  const spawn = spyOn(Bun, "spawn").mockReturnValue({
    pid: 2147483647, kill() {}, stdin: { write() {}, end() {} }, exited: Promise.resolve(0),
    stdout: new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{"type":')); } }),
    stderr: new ReadableStream({ start(controller) { stderr = controller; } }),
  } as unknown as ReturnType<typeof Bun.spawn>);
  const finish = spyOn(bridge, "finish");
  const sink: StdoutSink = {
    start(_write, _end, stop) { abort = stop; },
    push(chunk) {
      bridge.push(chunk);
      if (kind === "protocol") abort();
      else stderr.enqueue(kind === "limit" ? new Uint8Array(MAX_CAPTURE_BYTES + 1).fill(65) : new Uint8Array([255]));
    },
    finish(options) { return bridge.finish(options); }, keptBytes() { return bridge.keptBytes(); },
    closeProtocol() { return bridge.closeProtocol(); },
  };
  try {
    const operation = runCapturedCommand(["synthetic"], { cwd, env: {}, stdoutSink: sink });
    if (kind === "limit") {
      const result = await operation;
      expect(result.exitCode).toBe(125);
      expect(result.success).toBe(false);
      expect(result.stderr).toStartWith("A".repeat(MAX_CAPTURE_BYTES));
      expect(result.stderr).toContain("stderr exceeded");
      expect(result.stderr).not.toContain("incomplete Claude control frame");
    } else {
      await expect(operation).rejects.toThrow(kind === "protocol" ? "protocol capture aborted" : "stderr is not valid UTF-8");
    }
    expect(finish).toHaveBeenCalledTimes(1);
    const records = readFileSync(bridge.recordingPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(records.some((record) => record.kind === "control_stdout_partial" &&
      Buffer.from(record.bytes_base64, "base64").toString() === '{"type":')).toBe(true);
  } finally {
    finish.mockRestore();
    spawn.mockRestore();
    await bridge.close().catch(() => {});
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("protocol abort wins over a child's successful SIGTERM exit", async () => {
  let abort!: () => void;
  const sink: StdoutSink = {
    start(_write, _end, stop) { abort = stop; },
    push() { abort(); }, finish() { return ""; }, keptBytes() { return 0; },
  };
  await expect(runCapturedCommand([process.execPath, "-e",
    'process.on("SIGTERM", () => process.exit(0)); setInterval(() => {}, 1000); console.log("ready");'],
  { cwd: process.cwd(), env: {}, stdoutSink: sink })).rejects.toThrow("protocol capture aborted");
});

test("an abort during async protocol cleanup cannot create timers or signal the finished group", async () => {
  let abort!: () => void;
  let timers: ReturnType<typeof spyOn> | undefined;
  let signals: ReturnType<typeof spyOn> | undefined;
  const sink: StdoutSink = {
    start(_write, _end, stop) { abort = stop; },
    push() {}, finish() { return "OK"; }, keptBytes() { return 0; },
    async closeProtocol() {
      timers = spyOn(globalThis, "setTimeout");
      signals = spyOn(process, "kill");
      await Promise.resolve();
      abort();
      abort();
    },
  };
  try {
    await expect(runCapturedCommand([process.execPath, "-e", 'console.log("OK")'],
      { cwd: process.cwd(), env: {}, stdoutSink: sink })).rejects.toThrow("protocol capture aborted");
    expect(timers).not.toHaveBeenCalled();
    expect(signals).not.toHaveBeenCalled();
  } finally { timers?.mockRestore(); signals?.mockRestore(); }
});

test("a failed launch retains its original error when async cleanup also fails", async () => {
  class FailedAdapter extends ClaudeAdapter {
    override prepareRun() { return {}; }
    override buildRunCommand(): string[] { throw new Error("launch rejected"); }
    override async cleanupRun() { throw new Error("cleanup refused"); }
  }
  await expect(launchRunRequest(new FailedAdapter({}),
    { agent: "claude", prompt: "probe", autonomy: "high", sandboxed: false },
    { sandbox: false, requestedAutonomy: "high" })).rejects.toThrow("launch rejected; cleanup failed: cleanup refused");
});

test.each(["start", "push", "abort"])("the first %s failure survives a protocol cleanup failure", async (stage) => {
  const sink: StdoutSink = {
    start(_write, _end, abort) {
      if (stage === "start") throw new Error("original protocol failure");
      if (stage === "abort") abort();
    },
    push() { if (stage === "push") throw new Error("original protocol failure"); },
    finish() { return ""; }, keptBytes() { return 0; },
    closeProtocol() { throw new Error("cleanup refused"); },
  };
  await expect(runCapturedCommand([process.execPath, "-e", 'console.log("ready")'], {
    cwd: process.cwd(), env: {}, stdoutSink: sink,
  })).rejects.toThrow(`${stage === "abort" ? "protocol capture aborted" : "original protocol failure"}; cleanup failed: cleanup refused`);
});

// These cases test retained output and finalization, so output must already
// exist when the timeout starts. Real child reaping has separate coverage.
function bufferedChild(completedCode?: number) {
  let output!: ReadableStreamDefaultController<Uint8Array>;
  let open = true;
  let exit!: (code: number) => void;
  const exited = new Promise<number>((resolve) => { exit = resolve; });
  if (completedCode !== undefined) exit(completedCode);
  return spyOn(Bun, "spawn").mockReturnValue({
    pid: 2147483647, stdin: { write() {}, end() {} }, exited,
    stdout: new ReadableStream<Uint8Array>({
      start(controller) {
        output = controller;
        controller.enqueue(new TextEncoder().encode("partial output"));
        if (completedCode !== undefined) { open = false; controller.close(); }
      },
      cancel() { open = false; },
    }),
    stderr: new ReadableStream({ start(controller) { controller.close(); } }),
    kill() { if (open) { open = false; output.close(); } exit(143); },
  } as unknown as ReturnType<typeof Bun.spawn>);
}

test.each(["timeout", "limit"])("%s retains its exit, partial output, and diagnosis when finalization fails", async (kind) => {
  let retained = "";
  const sink: StdoutSink = {
    push(chunk) { retained += chunk; }, finish() { return retained; },
    keptBytes() { return kind === "limit" && retained ? MAX_CAPTURE_BYTES + 1 : retained.length; },
    closeProtocol() { throw new Error("recording fsync failed"); },
  };
  const spawn = bufferedChild();
  try {
    const result = await runCapturedCommand(["buffered-child"],
      { cwd: process.cwd(), env: {}, timeoutMs: kind === "timeout" ? 150 : 5000, stdoutSink: sink });
    expect(result.exitCode).toBe(kind === "timeout" ? 124 : 125);
    expect(result.success).toBe(false);
    expect(result.stdout).toBe("partial output");
    expect(result.stderr).toContain(kind === "timeout" ? "agent timed out after 150ms" : "capture limit");
    expect(result.stderr).toContain("Note: cleanup failed: recording fsync failed");
  } finally { spawn.mockRestore(); }
}, 6000);

test.each(["timeout", "limit", "success", "failure"].flatMap((kind) => ["server", "fsync"].map((failure) => ({ kind, failure }))))(
  "launcher preserves its result when bridge finalization fails and cleanup repeats: %j", async ({ kind, failure }) => {
  const cwd = mkdtempSync(join(tmpdir(), "codemux-close-once-"));
  const bridge = new ExperimentBridge({ name: "experiment", command: process.execPath, args: [], env: [], recording: cwd }, cwd, "probe");
  const finalize = failure === "server"
    ? spyOn(ExperimentServer.prototype, "close").mockRejectedValue(new Error("recording finalization failed"))
    : spyOn(fs, "fsyncSync").mockImplementation(() => { throw new Error("recording finalization failed"); });
  let retained = "";
  class BridgeAdapter extends ClaudeAdapter {
    override prepareRun() {
      return { experimentBridge: bridge, stdoutSink: {
        push(chunk: string) { retained += chunk; }, finish() { return retained; },
        keptBytes() { return kind === "limit" && retained ? MAX_CAPTURE_BYTES + 1 : retained.length; },
        closeProtocol() { return bridge.closeProtocol(); },
      } };
    }
    override buildRunCommand() {
      return [process.execPath, "-e", 'process.stdout.write("partial output"); setInterval(() => {}, 1000);'];
    }
  }
  const spawn = bufferedChild(kind === "success" ? 0 : kind === "failure" ? 2 : undefined);
  try {
    const result = await launchRunRequest(new BridgeAdapter({}),
      { agent: "claude", prompt: "probe", cwd, autonomy: "high", sandboxed: false, timeoutMs: kind === "timeout" ? 150 : 5000 },
      { sandbox: false, requestedAutonomy: "high", cwd });
    expect(result.exitCode).toBe(kind === "timeout" ? 124 : kind === "limit" ? 125 : kind === "success" ? 0 : 2);
    expect(result.success).toBe(kind === "success");
    expect(result.stdout).toBe("partial output");
    expect(result.stderr.match(/cleanup failed: recording finalization failed/g)).toHaveLength(1);
    await expect(bridge.close()).resolves.toBeUndefined();
    await expect(bridge.closeProtocol()).rejects.toThrow("recording finalization failed");
    expect(finalize).toHaveBeenCalledTimes(1);
    const records = readFileSync(bridge.recordingPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(records.filter((record) => record.kind === "run_end")).toHaveLength(1);
    expect(records.filter((record) => record.kind === "failure")).toHaveLength(failure === "server" ? 1 : 0);
  } finally {
    spawn.mockRestore();
    await bridge.close().catch(() => {});
    finalize.mockRestore();
    rmSync(cwd, { recursive: true, force: true });
  }
}, 6000);

test("pipe abandonment also releases an exit promise held open by inherited stdio", async () => {
  const spawn = spyOn(Bun, "spawn").mockReturnValue({
    pid: 2147483647, kill: () => {}, stdin: { write: () => {}, end: () => {} },
    stdout: new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("partial")); } }),
    stderr: new ReadableStream({ start(controller) { controller.close(); } }),
    exited: new Promise(() => {}),
  } as unknown as ReturnType<typeof Bun.spawn>);
  try {
    const result = await runCapturedCommand(["fake"], { cwd: process.cwd(), env: {}, timeoutMs: 10 });
    expect(result.exitCode).toBe(124);
    expect(result.stdout).toBe("partial");
    expect(result.stderr).toContain("kept the output open");
  } finally { spawn.mockRestore(); }
}, 6000);

test("protocol cleanup failure still writes the completed launch's receipt", async () => {
  class CleanupFailureAdapter extends ClaudeAdapter {
    override prepareRun() {
      let output = "";
      return { stdoutSink: {
        push(chunk: string) { output += chunk; }, finish() { return output; }, keptBytes() { return output.length; },
        closeProtocol() { throw new Error("run_end write failed"); },
      } };
    }
    override buildRunCommand() { return [process.execPath, "-e", 'process.stdout.write("completed")']; }
  }
  const cwd = mkdtempSync(join(tmpdir(), "codemux-cleanup-receipt-"));
  const previous = process.env[CALL_LOG_ENV];
  process.env[CALL_LOG_ENV] = join(cwd, "calls.jsonl");
  try {
    const operation = launchRunRequest(new CleanupFailureAdapter({}),
      { agent: "claude", prompt: "probe", cwd, autonomy: "high", sandboxed: false },
      { sandbox: false, requestedAutonomy: "high", cwd });
    const result = await operation;
    expect(result).toMatchObject({ exitCode: 0, success: true, stdout: "completed" });
    expect(result.stderr).toContain("cleanup failed: run_end write failed");
    const records = readCallLog(process.env[CALL_LOG_ENV]!).entries;
    expect(records).toHaveLength(1);
    expect(records[0]!.record).toMatchObject({ agent: "claude", exit_code: 0 });
  } finally {
    if (previous === undefined) delete process.env[CALL_LOG_ENV]; else process.env[CALL_LOG_ENV] = previous;
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("a duplex start() throw after spawn terminates the child and fails the run", async () => {
  // start() runs after the spawn, so the child is live when it throws; the
  // runner must give it the same tree termination a signal gets and wait for
  // the exit, never leak a running child behind a failed protocol setup.
  const children: ReturnType<typeof Bun.spawn>[] = [];
  const realSpawn = Bun.spawn;
  const spawn = spyOn(Bun, "spawn").mockImplementation(((...args: Parameters<typeof Bun.spawn>) => {
    const proc = realSpawn(args[0]!, args[1]);
    children.push(proc);
    return proc;
  }) as typeof Bun.spawn);
  const sink: StdoutSink = {
    start() { throw new Error("duplex start exploded"); },
    push() {},
    finish() { return ""; },
    keptBytes() { return 0; },
  };
  try {
    await expect(runCapturedCommand([process.execPath, "-e", "setInterval(() => {}, 1000)"], {
      cwd: process.cwd(), env: {}, timeoutMs: 10_000, stdoutSink: sink,
    })).rejects.toThrow("duplex start exploded");
  } finally {
    spawn.mockRestore();
  }
  expect(children).toHaveLength(1);
  await children[0]!.exited;
  expect(() => process.kill(children[0]!.pid, 0)).toThrow();
});

for (const failure of ["overflow", "invalid UTF-8", "protocol"] as const) {
  test(`capture failure (${failure}) reaps a real SIGTERM-ignoring child before cleanup`, async () => {
    const realSpawn = Bun.spawn;
    let child: ReturnType<typeof Bun.spawn> | undefined;
    let exited = false;
    let cleanupSawExit = false;
    const spawn = spyOn(Bun, "spawn").mockImplementation(((...args: Parameters<typeof Bun.spawn>) => {
      const proc = realSpawn(args[0]!, args[1]);
      if (!child) {
        child = proc;
        void proc.exited.then(() => { exited = true; });
      }
      return proc;
    }) as typeof Bun.spawn);
    const sink: StdoutSink = {
      push() { if (failure === "protocol") throw new Error("protocol rejected output"); },
      finish() { return ""; }, keptBytes() { return 0; },
      closeProtocol() { cleanupSawExit = exited; },
    };
    const output = failure === "overflow"
      ? `process.stderr.write(Buffer.alloc(${MAX_CAPTURE_BYTES + 1}, 65));`
      : failure === "invalid UTF-8" ? "process.stderr.write(Buffer.from([255]));"
        : 'process.stdout.write("ready");';
    try {
      const operation = runCapturedCommand([process.execPath, "-e",
        `process.on("SIGTERM", () => {}); process.stderr.on("error", () => {});
         setInterval(() => {}, 1000); ${output}`],
      { cwd: process.cwd(), env: {}, timeoutMs: 10_000, stdoutSink: sink });
      if (failure === "overflow") {
        expect((await operation).exitCode).toBe(125);
      } else {
        await expect(operation).rejects.toThrow(failure === "protocol" ? "protocol rejected" : "not valid UTF-8");
      }
      expect(cleanupSawExit).toBe(true);
      expect(exited).toBe(true);
      expect(() => process.kill(child!.pid, 0)).toThrow();
    } finally {
      spawn.mockRestore();
      if (child && !exited) { child.kill("SIGKILL"); await child.exited; }
    }
  }, 6000);
}
