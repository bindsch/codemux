import { describe, expect, spyOn, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BaseAdapter,
  type RunContext,
} from "../src/adapters/base.js";
import { launchRunRequest } from "../src/launch.js";
import { getAdapter } from "../src/adapters/index.js";
import { assertHarnessSupported, resolveScodeExecutableForEnv } from "../src/cli-runtime.js";
import { spawnSessionChild } from "../src/session/spawn.js";
import { verifyAgentWiring } from "../src/verify.js";
import {
  MAX_ARGV_PROMPT_BYTES,
  MAX_CAPTURE_BYTES,
  OUTPUT_LIMIT_EXIT_CODE,
  guardedWait,
  runCapturedCommand,
} from "../src/process-runner.js";
import { processTableReadable, readProcessTable } from "../src/process-table.js";
import { claudeFamilyResult } from "../src/result-envelope.js";

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
  RunResult,
} from "../src/types.js";

const bun = process.execPath;

test("adapter executable lookup uses only the injected PATH (al40)", async () => {
  const savedPath = process.env.PATH;
  const ambient = mkdtempSync(join(tmpdir(), "codemux-ambient-path-"));
  const injected = realpathSync(mkdtempSync(join(tmpdir(), "codemux-injected-path-")));
  try {
    for (const name of ["codex", "cursor-agent", "qwen", "scode"]) {
      writeFileSync(join(ambient, name), "#!/bin/sh\necho codex-cli 0.0.1\n", { mode: 0o700 });
    }
    process.env.PATH = ambient;
    // Diagnostics explicitly supply PATH while excluding operator opt-ins.
    expect(verifyAgentWiring("codex").installed).toBe(true);
    for (const environment of [{ PATH: injected }, {}, { PATH: "" }]) {
      const executionEnv = getAdapter("codex", environment).buildExecutionEnv();
      expect(resolveScodeExecutableForEnv(executionEnv)).toBeNull();
      // The version probe must not inspect the ambient fake's old version.
      await assertHarnessSupported("codex", "codex", process.cwd(), executionEnv);
      await expect(spawnSessionChild(["codex", "--version"], executionEnv, {
        cwd: process.cwd(), sandboxed: false, autonomy: "high",
      }, { onLine: () => {}, onFatal: () => {} })).rejects.toThrow("was not found");
      for (const agent of ["codex", "cursor", "qwen"] as const) {
        const adapter = getAdapter(agent, environment);
        expect(adapter.isAvailable(), agent).toBe(false);
        expect(() => adapter.resolveExecutionCommand([adapter.binaryName, "--version"], injected))
          .toThrow("was not found");
      }
    }
    // A different injected installation must win over the ambient one.
    writeFileSync(join(injected, "codex"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    const codex = getAdapter("codex", { PATH: injected });
    expect(codex.isAvailable()).toBe(true);
    expect(codex.resolveExecutionCommand(["codex", "--version"], process.cwd())[0])
      .toBe(join(injected, "codex"));
  } finally {
    if (savedPath === undefined) delete process.env.PATH;
    else process.env.PATH = savedPath;
    rmSync(ambient, { recursive: true, force: true });
    rmSync(injected, { recursive: true, force: true });
  }
});

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
    // Establish the orphan before starting the timeout. Otherwise slow
    // interpreter startup can leave the parent alive when the timeout
    // fires, testing a different process tree and losing the note.
    if (process.platform === "win32") return;
    const cwd = mkdtempSync(join(tmpdir(), "codemux-orphan-"));
    const pidFile = join(cwd, "pid");
    const grandchildScript = [
      `await Bun.write(${JSON.stringify(pidFile)}, String(process.pid));`,
      "setInterval(() => {}, 1000);",
    ].join("\n");
    const parentScript = [
      `Bun.spawn([${JSON.stringify(bun)}, "-e", ${JSON.stringify(grandchildScript)}], { detached: true, stdin: "ignore", stdout: "inherit", stderr: "ignore" });`,
      `while (!(await Bun.file(${JSON.stringify(pidFile)}).exists())) await Bun.sleep(10);`,
      "process.exit(0);",
    ].join("\n");
    const command = [bun, "-e", parentScript];
    const child = Bun.spawn(command, {
      cwd, env: {}, stdin: "pipe", stdout: "pipe", stderr: "pipe", detached: true,
    });
    try {
      expect(await child.exited).toBe(0);
      const started = performance.now();
      // Supply the already-exited parent with its still-open stdout pipe.
      const spawn = spyOn(Bun, "spawn").mockReturnValueOnce(child);
      let pending: ReturnType<typeof runCapturedCommand>;
      try {
        pending = runCapturedCommand(command, { cwd, env: {}, timeoutMs: 500 });
      } finally {
        spawn.mockRestore();
      }
      const result = await pending;
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

  test("a timed-out run whose sink folds past the capture bound fails at 125, not 124", async () => {
    // Round al32, edges major 1: the check after sink.finish() runs on
    // every exit branch, the give-up abandonment a timeout ends on
    // included. The unreachable orphan of the test above holds stdout
    // open past every signal and writes complete 64 KiB lines totaling
    // just under the capture bound, then one unterminated chunk over it;
    // the sink counts only complete lines while the stream runs, so no
    // per-push check trips, and exactly the fold inside finish() — the
    // wire-regime rule that does not count the buffered partial line
    // until close() folds it — carries the kept total past the bound.
    // Before al32 the give-up branch returned that fold unexamined and
    // the run exited 124 over the bound; it must fail at 125 with the
    // capture-limit error instead.
    if (process.platform === "win32") return;
    const cwd = mkdtempSync(join(tmpdir(), "codemux-fold-limit-"));
    const pidFile = join(cwd, "pid");
    // 242 complete 64 KiB lines (15.13 MiB, under the bound alone),
    // then a 1 MiB unterminated chunk (16.13 MiB once folded).
    const lineCount = Math.ceil((MAX_CAPTURE_BYTES * 0.945) / 65_536);
    const grandchildScript = [
      `const line = "x".repeat(65_535) + "\\n";`,
      `for (let i = 0; i < ${lineCount}; i++) await Bun.write(Bun.stdout, line);`,
      `await Bun.write(Bun.stdout, "y".repeat(1_048_576));`,
      `await Bun.write(${JSON.stringify(pidFile)}, String(process.pid));`,
      "setInterval(() => {}, 1000);",
    ].join("\n");
    const parentScript = [
      `Bun.spawn([${JSON.stringify(bun)}, "-e", ${JSON.stringify(grandchildScript)}], { detached: true, stdin: "ignore", stdout: "inherit", stderr: "ignore" });`,
      // Idle only once the grandchild has written everything, then exit —
      // so the timeout's tree walk finds nobody and the orphan survives
      // to hold stdout open, exactly the abandonment shape.
      `while (!(await Bun.file(${JSON.stringify(pidFile)}).exists())) await Bun.sleep(5);`,
      "await Bun.sleep(50);",
      "process.exit(0);",
    ].join("\n");
    // The line-buffered sink: kept bytes are the complete lines alone
    // while pushes arrive; finish() folds the trailing partial in, and
    // keptBytes() answers for the fold too.
    let lines = "";
    let partial = "";
    let folded: string | null = null;
    const sink = {
      push(chunk: string): void {
        if (folded !== null) return;
        const text = partial + chunk;
        const cut = text.lastIndexOf("\n");
        if (cut === -1) {
          partial = text;
          return;
        }
        lines += text.slice(0, cut + 1);
        partial = text.slice(cut + 1);
      },
      finish(): string {
        if (folded === null) folded = lines + partial;
        return folded;
      },
      keptBytes(): number {
        return Buffer.byteLength(folded ?? lines);
      },
    };
    try {
      const result = await runCapturedCommand([bun, "-e", parentScript], {
        cwd,
        env: {},
        timeoutMs: 1_000,
        stdoutSink: sink,
      });
      expect(result.exitCode).toBe(OUTPUT_LIMIT_EXIT_CODE);
      expect(result.stderr).toContain("exceeded the");
      expect(result.stderr).toContain("capture limit");
      expect(result.success).toBe(false);
    } finally {
      if (existsSync(pidFile)) {
        try {
          process.kill(Number(readFileSync(pidFile, "utf8")), "SIGKILL");
        } catch {
          // Already gone.
        }
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

  test("omitted autonomy reaches buildRunCommand pinned to read-only, not unset", async () => {
    // The round7 finding: run() stopped pinning the request's autonomy, so an
    // adapter that enforces read-only natively (no sandbox needed) saw
    // request.autonomy undefined and built no autonomy flags at all. The pin
    // rides on the request object itself: the request is the record of what
    // the run used, and buildRunCommand reads the autonomy from it (per-run
    // state lives on the RunContext the launcher threads, not the request).
    class NativeReadOnlyAdapter extends RecordingAdapter {
      override requiresSandboxForAutonomy(): boolean {
        return false;
      }
    }
    const adapter = new NativeReadOnlyAdapter();
    const result = await adapter.run({ agent: "claude", prompt: "payload" });
    expect(result.success).toBe(true);
    expect(adapter.seenAutonomy).toBe("read-only");
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

  test("run() never writes to the caller's request object", async () => {
    // Round19: pinning an unset autonomy assigned `request.autonomy =
    // "read-only"` on the caller's object -- a TypeError on a frozen request,
    // and one caller's launch editing a request another caller shared. The
    // pin lands on an effective copy; the caller's object leaves the run
    // exactly as it arrived.
    class NativeReadOnlyAdapter extends RecordingAdapter {
      override requiresSandboxForAutonomy(): boolean {
        return false;
      }
    }
    const adapter = new NativeReadOnlyAdapter();
    const request: RunRequest = Object.freeze({
      agent: "claude",
      prompt: "payload",
    });
    const result = await adapter.run(request);
    expect(result.success).toBe(true);
    expect(adapter.seenAutonomy).toBe("read-only");
    expect(request.autonomy).toBeUndefined();
  });

  test("run() delegates to the launch path: one context, processed, then cleaned", async () => {
    // Round25's standalone-run finding: run() used to spawn and return the
    // raw harness output, skipping processRunResult entirely. It now runs
    // the one launch path, which prepares exactly one context, post-processes
    // the raw result on it, and only then disposes it -- the caller cannot
    // reach the result before processing and cannot outlive the cleanup.
    const order: string[] = [];
    class LifecycleAdapter extends DefaultHookAdapter {
      override prepareRun(): RunContext {
        order.push("prepare");
        return {};
      }
      override processRunResult(result: RunResult): RunResult {
        order.push("process");
        return { ...result, stdout: "processed\n" };
      }
      override cleanupRun(): void {
        order.push("cleanup");
      }
    }
    const adapter = new LifecycleAdapter();
    const result = await adapter.run({ agent: "claude", prompt: "payload", autonomy: "high" });
    expect(result.stdout).toBe("processed\n");
    expect(order).toEqual(["prepare", "process", "cleanup"]);
  });

  test("a standalone resultJson run returns the envelope, not raw harness output", async () => {
    // The round25 finding's user-facing half: a direct `resultJson: true`
    // call through run() carried none of the envelope the flag promises --
    // no codemux block for the Claude family, codex's raw JSONL -- and
    // codex's fallback file was already deleted by the time the caller
    // could look, making a Plan-only result unrecoverable. run() delegates
    // to the launch path, so the standalone result is the processed one.
    const envelope = JSON.stringify({
      type: "result",
      subtype: "success",
      result: "OK",
      usage: { input_tokens: 10, output_tokens: 2 },
    });
    const request: RunRequest = {
      agent: "claude",
      prompt: "payload",
      autonomy: "high",
      resultJson: true,
    };
    class EnvelopeAdapter extends DefaultHookAdapter {
      override capabilities(): AdapterCapabilities {
        return { ...capabilities(), supportsResultJson: true };
      }
      override buildRunCommand(): string[] {
        return [bun, "-e", `process.stdout.write(${JSON.stringify(envelope)})`];
      }
      override processRunResult(result: RunResult): RunResult {
        return claudeFamilyResult(result, request, "claude");
      }
    }
    const result = await new EnvelopeAdapter().run(request);
    const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(parsed.result).toBe("OK");
    const block = parsed.codemux as Record<string, unknown>;
    expect(block.agent).toBe("claude");
    expect((block.usage as Record<string, unknown>).input_tokens).toBe(10);
  });

  test("the exit backstop is released once the lifecycle disposed the context", async () => {
    // The round21 signal major's registration half: a launch registers
    // cleanupRun as an exit handler so a signaled run's scratch (codex's
    // --output-last-message file) cannot outlive exit 143, and unregisters
    // it once the lifecycle has disposed the context itself -- a finished
    // launch leaves no listener behind to fire at a later exit.
    class ContextAdapter extends DefaultHookAdapter {
      cleaned = 0;
      override cleanupRun(): void {
        this.cleaned++;
      }
    }
    const request = { agent: "claude", prompt: "payload", autonomy: "high" } as const;
    const baseline = process.listenerCount("exit");
    const adapter = new ContextAdapter();
    await launchRunRequest(adapter, { ...request }, {
      sandbox: false,
      requestedAutonomy: "high",
    });
    expect(adapter.cleaned).toBe(1);
    expect(process.listenerCount("exit")).toBe(baseline);
    // A launch that rejects mid-lifecycle disposes its context and releases
    // the backstop on the way out, not only a successful one.
    class RefusingAdapter extends DefaultHookAdapter {
      override buildRunCommand(): string[] {
        throw new Error("no command");
      }
    }
    const refusing = new RefusingAdapter();
    await expect(launchRunRequest(refusing, { ...request }, {
      sandbox: false,
      requestedAutonomy: "high",
    })).rejects.toThrow("no command");
    expect(process.listenerCount("exit")).toBe(baseline);
    // A standalone run() carries the same backstop through the launch path
    // it delegates to.
    const standalone = new ContextAdapter();
    await standalone.run({ ...request });
    expect(standalone.cleaned).toBe(1);
    expect(process.listenerCount("exit")).toBe(baseline);
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
    // Round al32 moved the child-directed stop onto process.kill — the
    // honest ESRCH on a pid that no longer exists — so the fake kill()
    // seam this test rode is gone: the child is real now, and its exit
    // 143 (the code a SIGTERM handler exits with) is the proof the
    // escalation sent the signal.
    const proc = Bun.spawn(
      [
        bun,
        "-e",
        "process.on('SIGTERM', () => process.exit(143)); setInterval(() => {}, 1000);",
      ],
      { stdin: "ignore", stdout: "ignore", stderr: "ignore" }
    );
    try {
      await Bun.sleep(150); // the handler is installed
      const waiting = guardedWait(proc);
      process.emit("SIGHUP");
      expect(await waiting).toBe(143);
    } finally {
      try {
        process.kill(proc.pid, "SIGKILL");
      } catch {
        // The expected path already ended it.
      }
    }
  });

  test("guardedWait handles triple interrupt and interactive deadlines", async () => {
    // The same al32 seam change: both halves run real children — the
    // burst's third SIGINT escalates to SIGTERM and the child's handler
    // answers 143, while the deadline's SIGTERM kills a plain child and
    // the wait reports the timeout's 124.
    const interruptProc = Bun.spawn(
      [
        bun,
        "-e",
        "process.on('SIGTERM', () => process.exit(143)); setInterval(() => {}, 1000);",
      ],
      { stdin: "ignore", stdout: "ignore", stderr: "ignore" }
    );
    try {
      await Bun.sleep(150); // the handler is installed
      const interrupted = guardedWait(interruptProc);
      process.emit("SIGINT");
      process.emit("SIGINT");
      process.emit("SIGINT");
      expect(await interrupted).toBe(143);
    } finally {
      try {
        process.kill(interruptProc.pid, "SIGKILL");
      } catch {
        // The expected path already ended it.
      }
    }
    const timeoutProc = Bun.spawn(
      [bun, "-e", "setInterval(() => {}, 1000);"],
      { stdin: "ignore", stdout: "ignore", stderr: "ignore" }
    );
    try {
      expect(await guardedWait(timeoutProc, 10)).toBe(124);
    } finally {
      try {
        process.kill(timeoutProc.pid, "SIGKILL");
      } catch {
        // The expected path already ended it.
      }
    }
  });
});
