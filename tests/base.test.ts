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
  guardedWait,
  runCapturedCommand,
} from "../src/process-runner.js";
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

  test("terminates descendants that close captured pipes and ignore SIGTERM", async () => {
    if (process.platform === "win32") return;
    const cwd = mkdtempSync(join(tmpdir(), "codemux-descendant-"));
    const marker = join(cwd, "survived");
    const pidFile = join(cwd, "pid");
    const childScript = [
      "process.on('SIGTERM', () => {});",
      `setTimeout(() => Bun.write(${JSON.stringify(marker)}, "alive"), 250);`,
      "setInterval(() => {}, 1000);",
    ].join("\n");
    const parentScript = [
      `const child = Bun.spawn([${JSON.stringify(bun)}, "-e", ${JSON.stringify(childScript)}], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });`,
      `await Bun.write(${JSON.stringify(pidFile)}, String(child.pid));`,
      "setInterval(() => {}, 1000);",
    ].join("\n");

    try {
      const result = await runCapturedCommand([bun, "-e", parentScript], {
        cwd,
        env: {},
        timeoutMs: 75,
      });
      expect(result.exitCode).toBe(124);
      await Bun.sleep(350);
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
  });

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
    const result = await adapter.run({
      agent: "claude",
      prompt: "payload",
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
    expect(adapter.requiresSandboxForAutonomy("read-only")).toBe(false);
    expect(adapter.requiresSandboxForTuiAutonomy("read-only")).toBe(false);
    expect(adapter.beforeLaunch()).toBeUndefined();
    expect(adapter.configurationIssues()).toEqual([]);
  });

  test("runs interactive commands through the guarded wait path", async () => {
    const adapter = new DefaultHookAdapter();
    expect(await adapter.runInteractive()).toBe(0);
  });

  test("normalizes omitted autonomy and runs launch validation exactly once", async () => {
    const adapter = new RecordingAdapter();
    const result = await adapter.run({ agent: "claude", prompt: "payload" });
    expect(result.success).toBe(true);
    expect(adapter.seenAutonomy).toBe("read-only");
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
