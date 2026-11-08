/**
 * runCapturedCommand's stdin delivery failures (review rounds 64 to 68):
 * a write or end that fails after the spawn is the run's failure, whether
 * it throws at once or rejects later, and never replaces an earlier
 * capture failure's diagnosis.
 */
import { describe, expect, test } from "bun:test";
import { hasActiveCapturedCommand, runCapturedCommand } from "../src/process-runner.js";

describe("captured command - stdin delivery", () => {
  test("an initial stdin write that fails stops and awaits the child (review round 64)", async () => {
    // The plain stdin write runs after the spawn and used to run before the
    // termination handlers were installed: a child that closes stdin at
    // once made the write throw EPIPE out of the runner with the child
    // still live and nothing stopping it. The failure is now the run's —
    // the child is terminated, its exit awaited, and the rejection is the
    // wrapped CapturedRunFailure.
    if (process.platform === "win32") return;
    const originalSpawn = Bun.spawn;
    const originalSpawnSync = Bun.spawnSync;
    const originalKill = process.kill;
    const events: string[] = [];
    let resolveExit!: (code: number) => void;
    const exited = new Promise<number>((resolve) => { resolveExit = resolve; });
    try {
      Bun.spawn = (() => ({
        pid: 2147483647,
        stdin: {
          write() { throw new Error("simulated EPIPE on first write"); },
          end() {},
        },
        stdout: new ReadableStream<Uint8Array>({ start() {} }),
        stderr: new ReadableStream<Uint8Array>({ start() {} }),
        exited,
        kill() {},
      })) as unknown as typeof Bun.spawn;
      Bun.spawnSync = (() => ({
        exitCode: 0,
        stdout: Buffer.from("1 0 1 S Sat Sep 5 00:00:00 2026\n"),
      })) as unknown as typeof Bun.spawnSync;
      process.kill = ((pid: number, signal?: string) => {
        events.push(`${signal ?? "kill"}:${pid > 0 ? "pid" : "group"}`);
        // The child's exit is observed once a signal reaches it; ordering
        // this after the signal makes "exit settled" mean "after a real
        // stop attempt", not "before anything happened".
        resolveExit(143);
        return true;
      }) as unknown as typeof process.kill;
      const rejection = await runCapturedCommand(["fixture"], {
        cwd: process.cwd(),
        env: {},
        stdinInput: "hello",
        timeoutMs: 5_000,
      }).then(
        () => { throw new Error("expected a rejection"); },
        (error: Error) => { events.push("rejected"); return error; }
      );
      expect(rejection.name).toBe("CapturedRunFailure");
      expect(rejection.message).toBe("simulated EPIPE on first write");
      // The stop ran (SIGTERM, and the child's exit settled on it) before
      // the run reported its failure. The escalation's SIGKILLs address
      // the group after the exit only while the table lists another
      // member of it (review round 401, item 8); the stubbed table lists
      // none, so none is sent.
      expect(events).toEqual(["SIGTERM:group", "rejected"]);
      expect(hasActiveCapturedCommand()).toBe(false);
    } finally {
      Bun.spawn = originalSpawn;
      Bun.spawnSync = originalSpawnSync;
      process.kill = originalKill;
      await exited;
    }
  }, 15_000);

  test("an initial stdin write whose promise rejects fails the run and stops the child (review round 65)", async () => {
    // Under backpressure Bun's FileSink.write() returns a promise; a child
    // that closes its pipe rejects it after the synchronous call returned.
    // That rejection used to be unhandled while the run reported success.
    if (process.platform === "win32") return;
    const originalSpawn = Bun.spawn;
    const originalSpawnSync = Bun.spawnSync;
    const originalKill = process.kill;
    const events: string[] = [];
    let resolveExit!: (code: number) => void;
    const exited = new Promise<number>((resolve) => { resolveExit = resolve; });
    try {
      Bun.spawn = (() => ({
        pid: 2147483647,
        stdin: {
          write() { return Promise.reject(new Error("simulated EPIPE after backpressure")); },
          end() { return 0; },
        },
        stdout: new ReadableStream<Uint8Array>({ start() {} }),
        stderr: new ReadableStream<Uint8Array>({ start() {} }),
        exited,
        kill() {},
      })) as unknown as typeof Bun.spawn;
      Bun.spawnSync = (() => ({
        exitCode: 0,
        stdout: Buffer.from("1 0 1 S Sat Sep 5 00:00:00 2026\n"),
      })) as unknown as typeof Bun.spawnSync;
      process.kill = ((pid: number, signal?: string) => {
        events.push(`${signal ?? "kill"}:${pid > 0 ? "pid" : "group"}`);
        resolveExit(143);
        return true;
      }) as unknown as typeof process.kill;
      const rejection = await runCapturedCommand(["fixture"], {
        cwd: process.cwd(),
        env: {},
        stdinInput: "hello",
        timeoutMs: 5_000,
      }).then(
        () => { throw new Error("expected a rejection"); },
        (error: Error) => { events.push("rejected"); return error; }
      );
      expect(rejection.name).toBe("CapturedRunFailure");
      expect(rejection.message).toBe("simulated EPIPE after backpressure");
      expect(events[0]).toBe("SIGTERM:group");
      expect(events.at(-1)).toBe("rejected");
      // The group has no listed member after the exit (round 401, item 8).
      expect(events).not.toContain("SIGKILL:group");
      expect(hasActiveCapturedCommand()).toBe(false);
    } finally {
      Bun.spawn = originalSpawn;
      Bun.spawnSync = originalSpawnSync;
      process.kill = originalKill;
      await exited;
    }
  }, 15_000);

  /** A spawn stub whose stdin write settles as `writeResult` after `delayMs`,
   * whose stdout carries `stdoutBytes` and closes, and whose child exits 0
   * at once. */
  const stubSpawn = (stdoutBytes: Uint8Array, writeResult: () => Promise<number>, delayMs: number) =>
    (() => ({
      pid: 2147483647,
      stdin: {
        write() { return Bun.sleep(delayMs).then(writeResult); },
        end() { return 0; },
      },
      stdout: new ReadableStream<Uint8Array>({ start(c) { c.enqueue(stdoutBytes); c.close(); } }),
      stderr: new ReadableStream<Uint8Array>({ start(c) { c.close(); } }),
      exited: Promise.resolve(0),
      kill() {},
    })) as unknown as typeof Bun.spawn;

  test("a stdin rejection that settles after the child exited still fails the run (review round 66)", async () => {
    // The child exits 0 and both streams close before the backpressured
    // write rejects: the input never reached the child, so the run is a
    // failure, never `success: true`.
    const originalSpawn = Bun.spawn;
    const originalKill = process.kill;
    const kills: string[] = [];
    try {
      Bun.spawn = stubSpawn(new Uint8Array(), () => Promise.reject(new Error("late EPIPE")), 60);
      process.kill = ((_pid: number, signal?: string) => { kills.push(signal ?? "kill"); return true; }) as unknown as typeof process.kill;
      const rejection = await runCapturedCommand(["fixture"], {
        cwd: process.cwd(), env: {}, stdinInput: "hello", timeoutMs: 5_000,
      }).then(() => null, (error: Error) => error);
      expect(rejection?.name).toBe("CapturedRunFailure");
      expect(rejection?.message).toBe("late EPIPE");
      // The child was already gone: nothing to stop.
      expect(kills).toEqual([]);
    } finally {
      Bun.spawn = originalSpawn;
      process.kill = originalKill;
    }
  }, 15_000);

  test("a stdin rejection after a capture failure never replaces that failure's diagnosis (review round 66)", async () => {
    const originalSpawn = Bun.spawn;
    const originalKill = process.kill;
    try {
      // Invalid UTF-8 on stdout fails the capture first; the termination
      // that follows closes stdin, and the write's rejection is its
      // consequence.
      Bun.spawn = stubSpawn(new Uint8Array([0xff, 0xfe]), () => Promise.reject(new Error("secondary EPIPE")), 60);
      process.kill = (() => true) as unknown as typeof process.kill;
      const rejection = await runCapturedCommand(["fixture"], {
        cwd: process.cwd(), env: {}, stdinInput: "hello", timeoutMs: 5_000,
      }).then(() => null, (error: Error) => error);
      expect(rejection?.name).toBe("CapturedRunFailure");
      expect(rejection?.message).toContain("stdout is not valid UTF-8");
      expect(rejection?.message).not.toContain("secondary EPIPE");
    } finally {
      Bun.spawn = originalSpawn;
      process.kill = originalKill;
    }
  }, 15_000);

  test("a protocol sink's asynchronous writer call that throws fails the run instead of escaping (review round 71)", async () => {
    // The sink calls its writer from a timer, outside the runner's frame:
    // a synchronous EPIPE there used to be an uncaught exception while
    // the run reported success.
    const originalSpawn = Bun.spawn;
    const originalKill = process.kill;
    let exit!: (code: number) => void;
    const exited = new Promise<number>((resolve) => { exit = resolve; });
    const kills: string[] = [];
    try {
      Bun.spawn = (() => ({
        pid: 2147483647,
        stdin: {
          write() { throw new Error("late sync EPIPE"); },
          end() { return 0; },
        },
        stdout: new ReadableStream<Uint8Array>({ start(c) { c.close(); } }),
        stderr: new ReadableStream<Uint8Array>({ start(c) { c.close(); } }),
        exited,
        kill() {},
      })) as unknown as typeof Bun.spawn;
      process.kill = ((_pid: number, signal?: string) => { kills.push(signal ?? "kill"); exit(143); return true; }) as unknown as typeof process.kill;
      let kept = "";
      const sink = {
        start(write: (line: string) => void) {
          setTimeout(() => write("tool-result\n"), 20);
        },
        push(chunk: string) { kept += chunk; },
        finish() { return kept; },
        keptBytes() { return kept.length; },
      };
      const rejection = await runCapturedCommand(["fixture"], {
        cwd: process.cwd(), env: {}, stdoutSink: sink, timeoutMs: 5_000,
      }).then(() => null, (error: Error) => error);
      expect(rejection?.name).toBe("CapturedRunFailure");
      expect(rejection?.message).toBe("late sync EPIPE");
      // The child was live: it was stopped.
      expect(kills[0]).toBe("SIGTERM");
    } finally {
      Bun.spawn = originalSpawn;
      process.kill = originalKill;
      exit(0);
    }
  }, 15_000);

  test("a protocol sink's first write, issued after the captures closed, is still awaited (review round 68)", async () => {
    // The streams close at once and the chain is empty when the captures
    // finish; the sink writes while the child still runs, and that write
    // rejects after the exit. The wait must begin after the exit, or it
    // drains an empty chain and the run reports success.
    const originalSpawn = Bun.spawn;
    const originalKill = process.kill;
    let exit!: (code: number) => void;
    const exited = new Promise<number>((resolve) => { exit = resolve; });
    try {
      Bun.spawn = (() => ({
        pid: 2147483647,
        stdin: {
          write() { return Bun.sleep(120).then(() => { throw new Error("protocol EPIPE"); }); },
          end() { return 0; },
        },
        stdout: new ReadableStream<Uint8Array>({ start(c) { c.close(); } }),
        stderr: new ReadableStream<Uint8Array>({ start(c) { c.close(); } }),
        exited,
        kill() {},
      })) as unknown as typeof Bun.spawn;
      process.kill = (() => true) as unknown as typeof process.kill;
      let kept = "";
      const sink = {
        start(write: (line: string) => void) {
          setTimeout(() => { write("tool-result\n"); exit(0); }, 20);
        },
        push(chunk: string) { kept += chunk; },
        finish() { return kept; },
        keptBytes() { return kept.length; },
      };
      const rejection = await runCapturedCommand(["fixture"], {
        cwd: process.cwd(), env: {}, stdoutSink: sink, timeoutMs: 5_000,
      }).then(() => null, (error: Error) => error);
      expect(rejection?.name).toBe("CapturedRunFailure");
      expect(rejection?.message).toBe("protocol EPIPE");
    } finally {
      Bun.spawn = originalSpawn;
      process.kill = originalKill;
      exit(0);
    }
  }, 15_000);

});
