import { describe, test, expect } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ClaudeAdapter } from "../src/adapters/claude.js";
import { CodexAdapter } from "../src/adapters/codex.js";
import { launchRunRequest } from "../src/launch.js";
import { BaseAdapter } from "../src/adapters/base.js";
import type { RunContext } from "../src/adapters/base.js";
import type { AdapterCapabilities, RunRequest } from "../src/types.js";

describe("CodexAdapter", () => {
  test("a rejected launch cleans up only its own context, never a live run's", async () => {
    // Round15's major finding, both halves. A launch that rejects BEFORE
    // prepareRun (validation refusing the request) and one that rejects
    // AFTER its own prepareRun (the .scode.yaml workdir refusal) used to
    // run cleanupRun against the live run's keyed state, deleting its
    // --output-last-message file and leaving a successful Plan-only run
    // without its reply. Each launch now owns exactly the context it
    // created, so both rejections leave run A's file standing.
    const home = mkdtempSync(join(tmpdir(), "codemux-codex-"));
    const workdir = mkdtempSync(join(tmpdir(), "codemux-workdir-"));
    let scratchDir: string | undefined;
    try {
      mkdirSync(join(home, ".codex"));
      writeFileSync(join(workdir, ".scode.yaml"), "");
      const adapter = new CodexAdapter({}, home);
      const request: RunRequest = {
        agent: "codex",
        prompt: "t",
        resultJson: true,
        sandboxed: true,
        cwd: workdir,
      };
      // Run A in flight: its own context, its file standing.
      const contextA = adapter.prepareRun(request);
      scratchDir = contextA.lastMessageDir;
      const argvA = adapter.buildRunCommand(request, contextA);
      const fileA = argvA[argvA.indexOf("--output-last-message") + 1]!;
      writeFileSync(fileA, "A's plan");

      // Rejection before prepareRun: a request validation refuses, so the
      // second launch never prepares a context and has nothing of its own
      // -- or of A's -- to clean. The launch options carry the same
      // autonomy the request names (review round 64's agreement rule).
      await expect(
        launchRunRequest(
          adapter,
          { ...request, tools: "none", autonomy: "medium" },
          {
            sandbox: true,
            sandboxPolicyOverrides: { trust: "untrusted" },
            requestedAutonomy: "medium",
            cwd: workdir,
          }
        )
      ).rejects.toThrow(/codex cannot remove its apply_patch tool/);
      expect(existsSync(fileA)).toBe(true);

      // Rejection after prepareRun: the .scode.yaml workdir refuses the
      // launch once its OWN context exists, and only that context is
      // disposed (the rejected-launch test above covers its own file).
      await expect(
        launchRunRequest(adapter, request, {
          sandbox: true,
          requestedAutonomy: "read-only",
          cwd: workdir,
        })
      ).rejects.toThrow(/\.scode\.yaml/);
      expect(existsSync(fileA)).toBe(true);

      // Run A completes on its own context, whole.
      const stream = [
        { type: "thread.started", thread_id: "0192b8d4-4d4f-7c4a-9d0e-6f5a4b3c2d1e" },
        { type: "turn.started" },
        { type: "item.completed", item: { id: "item_0", type: "reasoning", text: "thinking" } },
        { type: "turn.completed", usage: { input_tokens: 10, output_tokens: 2 } },
      ].map((line) => JSON.stringify(line)).join("\n") + "\n";
      const outA = adapter.processRunResult(
        { stdout: stream, stderr: "", exitCode: 0, success: true },
        request,
        contextA
      );
      expect(outA.success).toBe(true);
      expect(JSON.parse(outA.stdout).result).toBe("A's plan");
      expect(existsSync(fileA)).toBe(false);
    } finally {
      if (scratchDir !== undefined) rmSync(scratchDir, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
      rmSync(workdir, { recursive: true, force: true });
    }
  });

  test("the launch path has one passthroughEnv source: the request", async () => {
    // Round15: the launch options used to carry a second passthroughEnv
    // list, so a programmatic caller could validate one list and build the
    // child environment from another -- a relative CLAUDE_CONFIG_DIR that
    // reached only the options bypassed the absolute-path guard and landed
    // the config store under the working directory. The options field is
    // gone; validation and the sandbox environment read the same list.
    const prev = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = "relative-profile";
    try {
      await expect(
        launchRunRequest(
          new ClaudeAdapter(),
          {
            agent: "claude",
            prompt: "t",
            autonomy: "high",
            sandboxed: false,
            passthroughEnv: ["CLAUDE_CONFIG_DIR"],
          },
          { sandbox: false, requestedAutonomy: "high" }
        )
      ).rejects.toThrow(/CLAUDE_CONFIG_DIR must be an absolute path/);
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = prev;
    }
  });

  test("a sandboxed launch whose options disagree with the request is refused before anything spawns (review round 64)", async () => {
    // The sandboxed branch validates the request (adapter checks read
    // request.autonomy and request.cwd) but the scode spawn executes with
    // the options, so a caller passing two different sets could validate a
    // read-only request in one directory and execute with high autonomy in
    // another. The launcher now refuses the disagreement itself, before
    // any adapter preparation.
    const workdirA = mkdtempSync(join(tmpdir(), "codemux-launch-a-"));
    const workdirB = mkdtempSync(join(tmpdir(), "codemux-launch-b-"));
    class ProbeAdapter extends BaseAdapter {
      readonly id = "claude" as const;
      readonly binaryName = "claude";
      prepared = 0;
      capabilities(): AdapterCapabilities {
        return {
          supportsNonInteractive: true,
          supportsInteractive: true,
          supportsModel: false,
          supportsAutonomy: true,
          autonomyLevels: ["read-only", "low", "medium", "high"],
          supportsEffort: false,
          effortLevels: [],
          supportsHermetic: false,
          supportsToolSelection: false,
          supportsResultJson: false,
        };
      }
      buildRunCommand(): string[] {
        return [process.execPath, "-e", "process.exit(0)"];
      }
      buildTuiCommand(): string[] {
        return ["claude"];
      }
      override validateRunRequest(): void {
        throw new Error("probe: request refused after the guard");
      }
      override prepareRun(): RunContext {
        this.prepared++;
        return {};
      }
    }
    try {
      const adapter = new ProbeAdapter();
      const base: RunRequest = { agent: "claude", prompt: "t", sandboxed: true, cwd: workdirA };
      // Autonomy disagreement: the request says read-only, the spawn would
      // run high.
      await expect(
        launchRunRequest(adapter, base, {
          sandbox: true,
          requestedAutonomy: "high",
          cwd: workdirA,
        })
      ).rejects.toThrow(
        "sandboxed launch options must match the request: the scode spawn must run the validated autonomy in the validated working directory"
      );
      // Working-directory disagreement: the request was validated for one
      // directory, the spawn would run in another.
      await expect(
        launchRunRequest(adapter, base, {
          sandbox: true,
          requestedAutonomy: "read-only",
          cwd: workdirB,
        })
      ).rejects.toThrow("sandboxed launch options must match the request");
      // Neither refusal prepared anything or reached the adapter.
      expect(adapter.prepared).toBe(0);
      // The control: an agreeing pair passes the guard and fails at the
      // adapter's own validation instead.
      await expect(
        launchRunRequest(adapter, base, {
          sandbox: true,
          requestedAutonomy: "read-only",
          cwd: workdirA,
        })
      ).rejects.toThrow("probe: request refused after the guard");
      expect(adapter.prepared).toBe(0);
    } finally {
      rmSync(workdirA, { recursive: true, force: true });
      rmSync(workdirB, { recursive: true, force: true });
    }
  });

  test("a direct launch validates before the run's scratch state exists", async () => {
    // Round17: the direct path built the run context before any validation
    // (adapter.run validated only after receiving it), and building a
    // context writes scratch state -- codex's --output-last-message path,
    // a hermetic home. A request the run will refuse must not touch disk
    // first, so validation precedes prepareRun on this path too.
    class ProbeAdapter extends BaseAdapter {
      readonly id = "claude" as const;
      readonly binaryName = "claude";
      prepared = 0;
      refuse = false;
      capabilities(): AdapterCapabilities {
        return {
          supportsNonInteractive: true,
          supportsInteractive: true,
          supportsModel: false,
          supportsAutonomy: true,
          autonomyLevels: ["read-only", "low", "medium", "high"],
          supportsEffort: false,
          effortLevels: [],
          supportsHermetic: false,
          supportsToolSelection: false,
          supportsResultJson: false,
        };
      }
      buildRunCommand(): string[] {
        // A real command shape, so the control launch below spawns a real
        // (harmless) process through the launch path run() now shares.
        return [process.execPath, "-e", "process.exit(0)"];
      }
      buildTuiCommand(): string[] {
        return ["claude"];
      }
      override validateRunRequest(request: RunRequest): void {
        super.validateRunRequest(request);
        if (this.refuse) throw new Error("probe: request refused");
      }
      override prepareRun(): RunContext {
        this.prepared++;
        return {};
      }
    }
    const adapter = new ProbeAdapter();
    const request: RunRequest = {
      agent: "claude",
      prompt: "t",
      autonomy: "high",
      sandboxed: false,
    };
    adapter.refuse = true;
    await expect(
      launchRunRequest(adapter, request, { sandbox: false, requestedAutonomy: "high" })
    ).rejects.toThrow("probe: request refused");
    expect(adapter.prepared).toBe(0);
    // The control: a valid request still prepares exactly one context and
    // runs on it.
    adapter.refuse = false;
    const result = await launchRunRequest(adapter, request, {
      sandbox: false,
      requestedAutonomy: "high",
    });
    expect(result.success).toBe(true);
    expect(adapter.prepared).toBe(1);
  });

  test("a rejected sandboxed launch still removes the run's --output-last-message file", async () => {
    // The round9 finding: post-processing was skipped when the launch
    // itself rejected, so the file codex had already written -- model
    // output -- stayed in CODEX_HOME. Here the sandboxed path rejects
    // after prepareRun (a working directory with .scode.yaml is refused),
    // and the per-run file must not outlive the failed launch.
    const home = mkdtempSync(join(tmpdir(), "codemux-codex-"));
    const workdir = mkdtempSync(join(tmpdir(), "codemux-workdir-"));
    try {
      mkdirSync(join(home, ".codex"));
      writeFileSync(join(workdir, ".scode.yaml"), "");
      // buildRunCommand runs after prepareRun on the launch path; writing
      // the file there stands in for the output codex itself records
      // before a later failure (a captured stdout that is not UTF-8).
      class RecordingCodexAdapter extends CodexAdapter {
        lastMessageFile: string | null = null;
        override buildRunCommand(request: RunRequest, context?: RunContext): string[] {
          const argv = super.buildRunCommand(request, context);
          const flag = argv.indexOf("--output-last-message");
          if (flag >= 0) {
            this.lastMessageFile = argv[flag + 1]!;
            writeFileSync(this.lastMessageFile, "model output");
          }
          return argv;
        }
      }
      const adapter = new RecordingCodexAdapter({}, home);
      const request: RunRequest = {
        agent: "codex",
        prompt: "t",
        resultJson: true,
        sandboxed: true,
        cwd: workdir,
      };
      await expect(
        launchRunRequest(adapter, request, {
          sandbox: true,
          requestedAutonomy: "read-only",
          cwd: workdir,
        })
      ).rejects.toThrow(/\.scode\.yaml/);
      expect(adapter.lastMessageFile).not.toBeNull();
      expect(existsSync(adapter.lastMessageFile!)).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(workdir, { recursive: true, force: true });
    }
  });

  test("a rejected direct run still removes the run's --output-last-message file", async () => {
    // The unsandboxed twin of the finding: adapter.run() itself rejects
    // (the harness binary cannot be resolved here) after prepareRun
    // recorded the file, and the same cleanup applies before the rethrow.
    const home = mkdtempSync(join(tmpdir(), "codemux-codex-"));
    try {
      mkdirSync(join(home, ".codex"));
      class MissingBinaryCodexAdapter extends CodexAdapter {
        lastMessageFile: string | null = null;
        override buildRunCommand(request: RunRequest, context?: RunContext): string[] {
          const argv = super.buildRunCommand(request, context);
          const flag = argv.indexOf("--output-last-message");
          if (flag >= 0) {
            this.lastMessageFile = argv[flag + 1]!;
            writeFileSync(this.lastMessageFile, "model output");
          }
          // Name a binary no PATH holds, so resolution fails after
          // prepareRun instead of spawning a real codex.
          argv[0] = "codemux-no-such-harness-binary";
          return argv;
        }
      }
      const adapter = new MissingBinaryCodexAdapter({}, home);
      const request: RunRequest = {
        agent: "codex",
        prompt: "t",
        resultJson: true,
        autonomy: "high",
        sandboxed: false,
        cwd: home,
      };
      await expect(
        launchRunRequest(adapter, request, {
          sandbox: false,
          requestedAutonomy: "high",
          // The launch runs in the request's directory (review round 372).
          cwd: home,
        })
      ).rejects.toThrow(/was not found/);
      expect(adapter.lastMessageFile).not.toBeNull();
      expect(existsSync(adapter.lastMessageFile!)).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("a cleanup failure removing the --output-last-message file cannot fail the run", () => {
    // The round12 finding: the fallback reader's final rmSync sat outside
    // its try/catch, so an EACCES or ENOTEMPTY there rejected processing
    // on a finished run and replaced its result with a cleanup error. The
    // guard is the rejected-launch cleanup's rule: the failure says so on
    // stderr and stays out of the run's way. A read-only per-run directory
    // makes the removal fail while the read still succeeds.
    const home = mkdtempSync(join(tmpdir(), "codemux-codex-"));
    const errors: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    };
    let lastMessageDir = "";
    try {
      const adapter = new CodexAdapter({}, home);
      const request: RunRequest = {
        agent: "codex",
        prompt: "t",
        resultJson: true,
      };
      const context = adapter.prepareRun(request);
      const argv = adapter.buildRunCommand(request, context);
      const lastMessageFile = argv[argv.indexOf("--output-last-message") + 1]!;
      lastMessageDir = dirname(lastMessageFile);
      writeFileSync(lastMessageFile, "the recorded message");
      chmodSync(lastMessageDir, 0o500);
      const stream = [
        { type: "thread.started", thread_id: "0192b8d4-4d4f-7c4a-9d0e-6f5a4b3c2d1e" },
        { type: "turn.started" },
        { type: "item.completed", item: { id: "item_0", type: "reasoning", text: "thinking" } },
        { type: "turn.completed", usage: { input_tokens: 10, output_tokens: 2 } },
      ].map((line) => JSON.stringify(line)).join("\n") + "\n";
      const out = adapter.processRunResult(
        { stdout: stream, stderr: "", exitCode: 0, success: true },
        request,
        context
      );
      // The run's own result stands; the cleanup failure only warns.
      expect(out.success).toBe(true);
      expect(out.exitCode).toBe(0);
      expect(JSON.parse(out.stdout).result).toBe("the recorded message");
      expect(out.stderr).toContain("final message codex recorded itself");
      expect(errors.join("\n")).toContain(
        "could not remove codex's --output-last-message file"
      );
      // Removal failed, so the file is still there -- visibly, not as a
      // thrown error replacing the result.
      expect(existsSync(lastMessageFile)).toBe(true);
    } finally {
      console.error = originalError;
      if (lastMessageDir !== "") {
        chmodSync(lastMessageDir, 0o700);
        rmSync(lastMessageDir, { recursive: true, force: true });
      }
      rmSync(home, { recursive: true, force: true });
    }
  });

});
