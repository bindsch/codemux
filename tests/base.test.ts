import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BaseAdapter,
} from "../src/adapters/base.js";
import {
  MAX_ARGV_PROMPT_BYTES,
  MAX_CAPTURE_BYTES,
  OUTPUT_LIMIT_EXIT_CODE,
  guardedWait,
  runCapturedCommand,
} from "../src/process-runner.js";
import { processTableReadable, readProcessTable } from "../src/process-table.js";

/** Whether `pid` still runs, by the process table (which omits zombies, so a
 * killed process awaiting a slow reaper does not count as alive). Throws if
 * the table cannot be read, so an enumeration failure can never pass as
 * "exited"; callers guard on `processTableReadable()` first. */
function stillRunning(pid: number): boolean {
  const table = readProcessTable();
  if (table.size === 0) throw new Error("process table unreadable; cannot judge liveness");
  return table.has(pid);
}
import type {
  AdapterCapabilities,
  AgentId,
  AutonomyLevel,
  ReasoningEffort,
  RunRequest,
} from "../src/types.js";

const bun = process.execPath;

function capabilities(): AdapterCapabilities {
  return {
    supportsNonInteractive: true,
    supportsInteractive: true,
    supportsModel: true,
    supportsAutonomy: true,
    autonomyLevels: ["read-only", "low", "medium", "high"],
    supportsEffort: true,
    effortLevels: ["none", "low", "medium", "high"],
  };
}

class TestAdapter extends BaseAdapter {
  readonly id: AgentId = "claude";
  readonly binaryName = bun;

  capabilities(): AdapterCapabilities {
    return capabilities();
  }

  buildRunCommand(_request: RunRequest): string[] {
    return [
      bun,
      "-e",
      "const input = await Bun.stdin.text(); console.log(JSON.stringify({input,cwd:process.cwd(),kept:process.env.KEPT,removed:process.env.REMOVED}))",
    ];
  }

  buildTuiCommand(
    _model?: string,
    _autonomy?: AutonomyLevel,
    _effort?: ReasoningEffort
  ): string[] {
    return [bun, "-e", "process.exit(0)"];
  }

  override getStdinInput(request: RunRequest): string {
    return request.prompt;
  }

  override getRunEnv(): Record<string, string> {
    return { KEPT: "yes", REMOVED: "secret" };
  }

  override getEnvOmissions(): readonly string[] {
    return ["REMOVED"];
  }
}

class DefaultHookAdapter extends BaseAdapter {
  readonly id: AgentId = "claude";
  readonly binaryName = bun;

  capabilities(): AdapterCapabilities {
    return capabilities();
  }

  buildRunCommand(_request: RunRequest): string[] {
    return [bun, "-e", "process.exit(0)"];
  }

  buildTuiCommand(): string[] {
    return [bun, "-e", "process.exit(0)"];
  }
}

class RecordingAdapter extends DefaultHookAdapter {
  seenAutonomy?: AutonomyLevel;
  launchCount = 0;

  override buildRunCommand(request: RunRequest): string[] {
    this.seenAutonomy = request.autonomy;
    return [bun, "-e", "process.exit(0)"];
  }

  override beforeLaunch(): void {
    this.launchCount++;
  }
}

describe("captured process execution", () => {
  test("captures stdout and stderr concurrently and forwards stdin, cwd, and env", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "codemux-base-"));
    try {
      const result = await runCapturedCommand(
        [
          bun,
          "-e",
          "const input=await Bun.stdin.text(); process.stdout.write(input); process.stderr.write(process.env.FLAG ?? '');",
        ],
        {
          cwd,
          env: { FLAG: "stderr" },
          stdinInput: "stdin",
          timeoutMs: 2_000,
        }
      );
      expect(result).toEqual({
        stdout: "stdin",
        stderr: "stderr",
        exitCode: 0,
        success: true,
      });
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("terminates a hung process at the configured deadline", async () => {
    const result = await runCapturedCommand(
      [bun, "-e", "setInterval(() => {}, 1000)"],
      {
        cwd: process.cwd(),
        env: {},
        timeoutMs: 25,
      }
    );
    expect(result.exitCode).toBe(124);
    expect(result.success).toBe(false);
    expect(result.stderr).toContain("timed out");
  });

  test("terminates descendants that retain captured pipes", async () => {
    if (process.platform === "win32") return;
    const started = performance.now();
    const childScript = "setInterval(() => {}, 1000)";
    const parentScript = [
      `Bun.spawn([${JSON.stringify(bun)}, "-e", ${JSON.stringify(childScript)}], { stdout: "inherit", stderr: "inherit" });`,
      "setInterval(() => {}, 1000);",
    ].join("\n");
    const result = await runCapturedCommand([bun, "-e", parentScript], {
      cwd: process.cwd(),
      env: {},
      timeoutMs: 50,
    });
    expect(result.exitCode).toBe(124);
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  test("abandoning capture mid-character still returns the timeout result", async () => {
    // The cutoff can land between the bytes of a multibyte character. The
    // fatal decoder buffers the incomplete suffix and flushing it would
    // throw; the run must still return 124 with the output captured so far
    // instead of rejecting with an invalid-UTF-8 error.
    if (process.platform === "win32") return;
    const originalSpawn = Bun.spawn;
    const originalSpawnSync = Bun.spawnSync;
    const originalKill = process.kill;
    try {
      let reads = 0;
      const stdout = new ReadableStream<Uint8Array>({
        pull(controller) {
          reads += 1;
          if (reads === 1) controller.enqueue(Buffer.from("ok\n", "utf8"));
          else if (reads === 2) controller.enqueue(Buffer.from([0xc3]));
          // otherwise: stall forever, holding the partial character
        },
      });
      const stderr = new ReadableStream<Uint8Array>({ start() {} });
      Bun.spawn = (() => ({
        pid: 2147483647,
        stdin: { write() {}, end() {} },
        stdout,
        stderr,
        exited: Promise.resolve(0),
        kill() {},
      })) as unknown as typeof Bun.spawn;
      Bun.spawnSync = (() => ({
        exitCode: 0,
        stdout: Buffer.from("1 0 1 S Sat Sep 5 00:00:00 2026\n"),
      })) as unknown as typeof Bun.spawnSync;
      process.kill = (() => true) as unknown as typeof process.kill;
      const result = await runCapturedCommand(["fixture"], {
        cwd: process.cwd(),
        env: {},
        timeoutMs: 50,
      });
      expect(result.exitCode).toBe(124);
      expect(result.success).toBe(false);
      expect(result.stdout).toBe("ok\n");
    } finally {
      Bun.spawn = originalSpawn;
      Bun.spawnSync = originalSpawnSync;
      process.kill = originalKill;
    }
  }, 15_000);

  test("captures thousands of small chunks in full", async () => {
    // The give-up reaction is registered once per stream; a chatty command
    // must still be captured completely.
    const result = await runCapturedCommand(
      [bun, "-e", "for (let i = 0; i < 5000; i++) process.stdout.write('x');"],
      { cwd: process.cwd(), env: {}, timeoutMs: 10_000 }
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("x".repeat(5000));
  }, 15_000);

  test("an output limit releases the other stream instead of stalling", async () => {
    // stdout floods past the capture limit while stderr is held open by a
    // process the kill cannot reach. The run failed already: it must come
    // back with 125 immediately, not when the timeout eventually fires.
    if (process.platform === "win32") return;
    const originalSpawn = Bun.spawn;
    const originalSpawnSync = Bun.spawnSync;
    const originalKill = process.kill;
    try {
      let floods = 0;
      const stdout = new ReadableStream<Uint8Array>({
        pull(controller) {
          floods += 1;
          if (floods === 1) controller.enqueue(Buffer.alloc(17 * 1024 * 1024, 120));
          // otherwise: stall, as a process past its kill would
        },
      });
      const stderr = new ReadableStream<Uint8Array>({ start() {} });
      Bun.spawn = (() => ({
        pid: 2147483647,
        stdin: { write() {}, end() {} },
        stdout,
        stderr,
        exited: Promise.resolve(0),
        kill() {},
      })) as unknown as typeof Bun.spawn;
      Bun.spawnSync = (() => ({
        exitCode: 0,
        stdout: Buffer.from("1 0 1 S Sat Sep 5 00:00:00 2026\n"),
      })) as unknown as typeof Bun.spawnSync;
      process.kill = (() => true) as unknown as typeof process.kill;
      const started = performance.now();
      const result = await runCapturedCommand(["fixture"], {
        cwd: process.cwd(),
        env: {},
        timeoutMs: 60_000,
      });
      const elapsed = performance.now() - started;
      expect(result.exitCode).toBe(OUTPUT_LIMIT_EXIT_CODE);
      expect(result.success).toBe(false);
      expect(result.stderr).toContain("exceeded the");
      // Before this fix nothing released stderr until the timeout fired —
      // sixty seconds here, and forever when the holder was unreachable.
      // Well under one second proves the other stream was released by the
      // failure itself.
      expect(elapsed).toBeLessThan(5_000);
    } finally {
      Bun.spawn = originalSpawn;
      Bun.spawnSync = originalSpawnSync;
      process.kill = originalKill;
    }
  }, 15_000);

  test.skipIf(process.platform === "win32" || !processTableReadable())(
    "terminates descendants that close captured pipes and ignore SIGTERM after the grace period",
    async () => {
    const cwd = mkdtempSync(join(tmpdir(), "codemux-descendant-"));
    const marker = join(cwd, "survived");
    const pidFile = join(cwd, "pid");
    // The descendant ignores SIGTERM, so it gets the two-second grace period
    // and then the SIGKILL, starting once the deadline fires — roughly 3.1 s
    // plus table reads. The marker is timed well past that, and checked only
    // after its time has come, so it fires only if the descendant survived.
    const markerAtMs = 6_000;
    const childScript = [
      "process.on('SIGTERM', () => {});",
      `await Bun.write(${JSON.stringify(pidFile)}, String(process.pid));`,
      `setTimeout(() => Bun.write(${JSON.stringify(marker)}, "alive"), ${markerAtMs});`,
      "setInterval(() => {}, 1000);",
    ].join("\n");
    const parentScript = [
      `Bun.spawn([${JSON.stringify(bun)}, "-e", ${JSON.stringify(childScript)}], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });`,
      // The parent idles only once the descendant has written its pid file,
      // so the deadline cannot beat readiness and the pid-file assertion
      // below tests the fixture, not a startup race.
      `while (!(await Bun.file(${JSON.stringify(pidFile)}).exists())) await Bun.sleep(5);`,
      "setInterval(() => {}, 1000);",
    ].join("\n");

    const started = performance.now();
    try {
      const result = await runCapturedCommand([bun, "-e", parentScript], {
        cwd,
        env: {},
        // One second: comfortably past two Bun launches and the readiness
        // write, without making the test crawl.
        timeoutMs: 1_000,
      });
      expect(result.exitCode).toBe(124);
      // The parent idled only after the pid file appeared, so a missing
      // file means the fixture itself broke — never a lost startup race.
      expect(existsSync(pidFile)).toBe(true);
      if (processTableReadable()) {
        await Bun.sleep(300);
        expect(stillRunning(Number(readFileSync(pidFile, "utf8")))).toBe(false);
      }
      await Bun.sleep(Math.max(0, markerAtMs + 300 - (performance.now() - started)));
      expect(existsSync(marker)).toBe(false);
    } finally {
      if (existsSync(pidFile)) {
        try {
          process.kill(Number(readFileSync(pidFile, "utf8")), "SIGKILL");
        } catch {
          // The expected path already killed and reaped the descendant.
        }
      }
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 15_000);

  // The tree-walk cases need process enumeration, which a host nested in a
  // sandbox may deny; they are reported as skipped there, never as passed.
  const treeWalk = test.skipIf(process.platform === "win32" || !processTableReadable());

  treeWalk("terminates descendants that escaped into their own process group", async () => {
    // Codex runs each tool command in a fresh process group, so a group kill
    // never reaches the shell loops it leaves behind. The runner must walk the
    // process tree by parent pid instead of trusting the group alone.
    const cwd = mkdtempSync(join(tmpdir(), "codemux-escaped-"));
    const pidFile = join(cwd, "pid");
    // The grandchild reports its own pid only once its SIGTERM handler is
    // installed, so a pid file proves the escalation, not ordinary SIGTERM,
    // is what ended it.
    const grandchildScript = [
      "process.on('SIGTERM', () => {});",
      `await Bun.write(${JSON.stringify(pidFile)}, String(process.pid));`,
      "setInterval(() => {}, 1000);",
    ].join("\n");
    const parentScript = [
      `Bun.spawn([${JSON.stringify(bun)}, "-e", ${JSON.stringify(grandchildScript)}], { detached: true, stdin: "ignore", stdout: "ignore", stderr: "ignore" });`,
      // Same readiness synchronization: idle only once the grandchild has
      // written its pid file (its SIGTERM handler is live by then).
      `while (!(await Bun.file(${JSON.stringify(pidFile)}).exists())) await Bun.sleep(5);`,
      "setInterval(() => {}, 1000);",
    ].join("\n");

    try {
      const result = await runCapturedCommand([bun, "-e", parentScript], {
        cwd,
        env: {},
        timeoutMs: 1_000,
      });
      expect(result.exitCode).toBe(124);
      // The parent idled only after the pid file appeared, so a missing
      // file means the fixture itself broke — never a lost startup race.
      expect(existsSync(pidFile)).toBe(true);
      // The grandchild ignored SIGTERM, so the runner waited out the grace
      // period and SIGKILLed it; once the reaper has collected it, it must
      // be gone from the process table.
      await Bun.sleep(300);
      expect(stillRunning(Number(readFileSync(pidFile, "utf8")))).toBe(false);
    } finally {
      if (existsSync(pidFile)) {
        try {
          process.kill(Number(readFileSync(pidFile, "utf8")), "SIGKILL");
        } catch {
          // The expected path already killed the escaped descendant.
        }
      }
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 10_000);

  test("returns from a timeout even when an unreachable orphan holds the output open", async () => {
    // The child hands its stdout to a detached grandchild and exits at once,
    // long before the timeout. No snapshot ever saw that grandchild under
    // the child, and it is in its own process group, so no signal can reach
    // it: the documented limitation. The run must still come back.
    if (process.platform === "win32") return;
    const cwd = mkdtempSync(join(tmpdir(), "codemux-orphan-"));
    const pidFile = join(cwd, "pid");
    const grandchildScript = [
      `await Bun.write(${JSON.stringify(pidFile)}, String(process.pid));`,
      "setInterval(() => {}, 1000);",
    ].join("\n");
    const parentScript = [
      `Bun.spawn([${JSON.stringify(bun)}, "-e", ${JSON.stringify(grandchildScript)}], { detached: true, stdin: "ignore", stdout: "inherit", stderr: "ignore" });`,
      "await Bun.sleep(50);",
      "process.exit(0);",
    ].join("\n");
    const started = performance.now();
    try {
      const result = await runCapturedCommand([bun, "-e", parentScript], {
        cwd,
        env: {},
        timeoutMs: 100,
      });
      expect(result.exitCode).toBe(124);
      expect(result.stderr).toContain("kept the output open");
      expect(performance.now() - started).toBeLessThan(6_000);
    } finally {
      try {
        process.kill(Number(readFileSync(pidFile, "utf8")), "SIGKILL");
      } catch {
        // Already gone.
      }
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 10_000);

  test("rejects invalid reusable timeout values before spawning", async () => {
    for (const timeoutMs of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(runCapturedCommand([bun, "-e", "process.exit(0)"], {
        cwd: process.cwd(),
        env: {},
        timeoutMs,
      })).rejects.toThrow("timeoutMs must be an integer");
    }
  });

  test("rejects invalid commands and malformed UTF-8 output", async () => {
    await expect(runCapturedCommand([], {
      cwd: process.cwd(),
      env: {},
    })).rejects.toThrow("command must contain");
    await expect(runCapturedCommand([
      bun,
      "-e",
      "process.stdout.write(Uint8Array.from([0x80]))",
    ], {
      cwd: process.cwd(),
      env: {},
      timeoutMs: 2_000,
    })).rejects.toThrow("stdout is not valid UTF-8");
  });

  test("guardedWait rejects invalid timeout values before installing listeners", async () => {
    const proc = {
      exited: Promise.resolve(0),
      kill: () => undefined,
    } as unknown as ReturnType<typeof Bun.spawn>;
    await expect(guardedWait(proc, 0)).rejects.toThrow(
      "timeoutMs must be an integer"
    );
  });

  test("kills a process that exceeds the capture limit", async () => {
    const result = await runCapturedCommand(
      [
        bun,
        "-e",
        `process.stdout.write('x'.repeat(${MAX_CAPTURE_BYTES - 1}) + '😀')`,
      ],
      {
        cwd: process.cwd(),
        env: {},
        timeoutMs: 5_000,
      }
    );
    expect(result.exitCode).toBe(125);
    expect(result.success).toBe(false);
    expect(result.stderr).toContain("capture limit");
    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(MAX_CAPTURE_BYTES);
    expect(Buffer.byteLength(result.stdout)).toBeGreaterThanOrEqual(
      MAX_CAPTURE_BYTES - 4
    );
    expect(result.stdout).not.toContain("\uFFFD");
  });
});

describe("BaseAdapter", () => {
  test("runs with adapter stdin/env hooks and removes sensitive variables", async () => {
    const adapter = new TestAdapter();
    // `high` is the one level that still runs unsandboxed; this test is about
    // the stdin/env hooks, not the boundary.
    const result = await adapter.run({
      agent: "claude",
      prompt: "payload",
      autonomy: "high",
      timeoutMs: 2_000,
    });
    const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(parsed.input).toBe("payload");
    expect(parsed.kept).toBe("yes");
    expect(parsed.removed).toBeUndefined();
    expect(result.success).toBe(true);
  });

  test("default hooks are least surprising and capability-derived", () => {
    const adapter = new DefaultHookAdapter();
    expect(adapter.isAvailable()).toBe(true);
    expect(adapter.mapAutonomy("read-only")).toEqual([]);
    expect(adapter.mapEffort("low")).toEqual([]);
    expect(adapter.getEnv()).toEqual({});
    expect(adapter.getEnvOmissions()).toEqual([]);
    expect(adapter.getStdinInput({ agent: "claude", prompt: "ignored" })).toBeNull();
    expect(adapter.getRunEnv({ agent: "claude", prompt: "ignored" })).toEqual({});
    expect(adapter.getTuiEnv()).toEqual({});
    expect(adapter.supportsTuiModel()).toBe(true);
    expect(adapter.supportsTuiAutonomy()).toBe(true);
    expect(adapter.supportsTuiEffort()).toBe(true);
    expect(adapter.requiresSandboxForAutonomy("read-only")).toBe(true);
    expect(adapter.requiresSandboxForTuiAutonomy("read-only")).toBe(true);
    expect(adapter.beforeLaunch()).toBeUndefined();
    expect(adapter.configurationIssues()).toEqual([]);
  });

  test("runs interactive commands through the guarded wait path", async () => {
    const adapter = new DefaultHookAdapter();
    expect(await adapter.runInteractive(undefined, undefined, "high")).toBe(0);
  });

  test("normalizes omitted autonomy and runs launch validation exactly once", async () => {
    const adapter = new RecordingAdapter();
    // Omitted autonomy still normalizes to read-only; running it directly is
    // now refused, so assert the normalization through the rejection.
    await expect(adapter.run({ agent: "claude", prompt: "payload" })).rejects.toThrow(
      "cannot enforce 'read-only' autonomy without an external sandbox"
    );
    const result = await adapter.run({ agent: "claude", prompt: "payload", autonomy: "high" });
    expect(result.success).toBe(true);
    expect(adapter.seenAutonomy).toBe("high");
    expect(adapter.launchCount).toBe(1);
  });

  test("rejects forged sandbox assertions on direct APIs", async () => {
    const adapter = new DefaultHookAdapter();
    await expect(adapter.run({
      agent: "claude",
      prompt: "payload",
      sandboxed: true,
    })).rejects.toThrow("cannot attest an external sandbox");
    await expect(adapter.runInteractive(undefined, undefined, undefined, undefined, true))
      .rejects.toThrow("cannot attest an external sandbox");
  });

  test("rejects mismatched adapter identity and oversized argv prompts", () => {
    const adapter = new DefaultHookAdapter();
    expect(() => adapter.validateRunRequest({ agent: "codex", prompt: "payload" }))
      .toThrow("does not match adapter");
    expect(() => adapter.validateRunRequest({
      agent: "claude",
      prompt: "x".repeat(MAX_ARGV_PROMPT_BYTES + 1),
    })).toThrow("prompt exceeds");
    expect(() => adapter.validateRunRequest({
      agent: "claude",
      prompt: "unsafe\0prompt",
    })).toThrow("NUL byte");
  });

  test("validates every runtime request boundary", () => {
    const adapter = new DefaultHookAdapter();
    for (const request of [
      { agent: "claude", prompt: "" },
      { agent: "claude", prompt: "payload", model: " padded " },
      { agent: "claude", prompt: "payload", model: "line\nbreak" },
      { agent: "claude", prompt: "payload", autonomy: "root" },
      { agent: "claude", prompt: "payload", effort: "maximum" },
      { agent: "claude", prompt: "payload", passthroughEnv: ["BAD-NAME"] },
    ]) {
      expect(() => adapter.validateRunRequest(request as RunRequest)).toThrow();
    }
  });

  test("rejects repository-controlled adapter executables", () => {
    const dir = mkdtempSync(join(tmpdir(), "codemux-local-binary-"));
    const binary = join(dir, "claude");
    writeFileSync(binary, "#!/bin/sh\nexit 0\n");
    chmodSync(binary, 0o755);
    const adapter = new DefaultHookAdapter();
    try {
      expect(() => adapter.resolveExecutionCommand([binary], dir))
        .toThrow("inside the execution working directory");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  const treeWalk = test.skipIf(process.platform === "win32" || !processTableReadable());

  treeWalk("guardedWait still kills remembered descendants when the child exits on SIGTERM", async () => {
    // An interactive child that quits promptly on SIGTERM used to cancel the
    // tree-scoped SIGKILL with its own exit, leaving an escaped descendant
    // running for good.
    const cwd = mkdtempSync(join(tmpdir(), "codemux-guarded-"));
    const pidFile = join(cwd, "pid");
    const grandchildScript = [
      "process.on('SIGTERM', () => {});",
      `await Bun.write(${JSON.stringify(pidFile)}, String(process.pid));`,
      "setInterval(() => {}, 1000);",
    ].join("\n");
    const childScript = [
      `Bun.spawn([${JSON.stringify(bun)}, "-e", ${JSON.stringify(grandchildScript)}], { detached: true, stdin: "ignore", stdout: "ignore", stderr: "ignore" });`,
      "process.on('SIGTERM', () => process.exit(0));",
      "setInterval(() => {}, 1000);",
    ].join("\n");
    const proc = Bun.spawn([bun, "-e", childScript], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    try {
      // Let the child spawn and record the grandchild before the deadline.
      while (!existsSync(pidFile)) await Bun.sleep(10);
      expect(await guardedWait(proc, 50)).toBe(124);
      await Bun.sleep(300);
      expect(stillRunning(Number(readFileSync(pidFile, "utf8")))).toBe(false);
    } finally {
      try {
        process.kill(Number(readFileSync(pidFile, "utf8")), "SIGKILL");
      } catch {
        // The expected path already killed the escaped descendant.
      }
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 10_000);

  test("guardedWait always removes signal listeners on rejection", async () => {
    const before = {
      SIGINT: process.listenerCount("SIGINT"),
      SIGTERM: process.listenerCount("SIGTERM"),
      SIGHUP: process.listenerCount("SIGHUP"),
    };
    const proc = {
      exited: Promise.reject(new Error("wait failed")),
      kill: () => undefined,
    } as unknown as ReturnType<typeof Bun.spawn>;

    await expect(guardedWait(proc)).rejects.toThrow("wait failed");
    expect(process.listenerCount("SIGINT")).toBe(before.SIGINT);
    expect(process.listenerCount("SIGTERM")).toBe(before.SIGTERM);
    expect(process.listenerCount("SIGHUP")).toBe(before.SIGHUP);
  });

  test("guardedWait escalates SIGHUP through the bounded termination path", async () => {
    let resolveExit!: (code: number) => void;
    const signals: string[] = [];
    const proc = {
      exited: new Promise<number>((resolve) => { resolveExit = resolve; }),
      kill: (signal: string) => {
        signals.push(signal);
        if (signal === "SIGTERM") resolveExit(143);
      },
    } as unknown as ReturnType<typeof Bun.spawn>;

    const waiting = guardedWait(proc);
    process.emit("SIGHUP");
    expect(await waiting).toBe(143);
    expect(signals).toContain("SIGTERM");
  });

  test("guardedWait handles triple interrupt and interactive deadlines", async () => {
    let resolveInterruptExit!: (code: number) => void;
    const interruptSignals: string[] = [];
    const interruptProc = {
      exited: new Promise<number>((resolve) => {
        resolveInterruptExit = resolve;
      }),
      kill: (signal: string) => {
        interruptSignals.push(signal);
        if (signal === "SIGTERM") resolveInterruptExit(143);
      },
    } as unknown as ReturnType<typeof Bun.spawn>;

    const interrupted = guardedWait(interruptProc);
    process.emit("SIGINT");
    process.emit("SIGINT");
    process.emit("SIGINT");
    expect(await interrupted).toBe(143);
    expect(interruptSignals).toContain("SIGTERM");

    let resolveTimeoutExit!: (code: number) => void;
    const timeoutProc = {
      exited: new Promise<number>((resolve) => {
        resolveTimeoutExit = resolve;
      }),
      kill: (signal: string) => {
        if (signal === "SIGTERM") resolveTimeoutExit(143);
      },
    } as unknown as ReturnType<typeof Bun.spawn>;
    expect(await guardedWait(timeoutProc, 10)).toBe(124);
  });
});
