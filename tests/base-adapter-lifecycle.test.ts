import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BaseAdapter,
  type RunContext,
} from "../src/adapters/base.js";
import { launchRunRequest } from "../src/launch.js";
import { MAX_ARGV_PROMPT_BYTES } from "../src/process-runner.js";
import { claudeFamilyResult } from "../src/result-envelope.js";
import type {
  AdapterCapabilities,
  AgentId,
  AutonomyLevel,
  ReasoningEffort,
  RunRequest,
  RunResult,
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
});
