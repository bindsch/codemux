import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KimiAdapter } from "../src/adapters/kimi.js";
import { launchRunRequest } from "../src/launch.js";
import { UsageRefusalError } from "../src/validation.js";

const adapter = new KimiAdapter();

describe("KimiAdapter", () => {
  test("validation and execution use the injected home despite an invalid ambient home (al38)", () => {
    const ambient = process.env.KIMI_CODE_HOME;
    const home = mkdtempSync(join(tmpdir(), "kimi-env-al38-"));
    try {
      process.env.KIMI_CODE_HOME = "relative/ambient";
      const request = { agent: "kimi" as const, prompt: "hello", autonomy: "high" as const,
        passthroughEnv: ["KIMI_CODE_HOME"] };
      for (const environment of [{}, { KIMI_CODE_HOME: home }]) {
        const injected = new KimiAdapter(environment, home);
        expect(() => injected.validateRunRequest(request)).not.toThrow();
        expect(injected.buildExecutionEnv({}, request.passthroughEnv).KIMI_CODE_HOME)
          .toBe(environment.KIMI_CODE_HOME);
      }
    } finally {
      if (ambient === undefined) delete process.env.KIMI_CODE_HOME;
      else process.env.KIMI_CODE_HOME = ambient;
      rmSync(home, { recursive: true, force: true });
    }
  });
  test("advertises no effort control, because 0.31.1 has none", () => {
    const caps = adapter.capabilities();
    expect(caps.supportsEffort).toBe(false);
    expect(caps.effortLevels).toEqual([]);
    expect(caps.autonomyLevels).toEqual(["read-only", "low", "medium", "high"]);
  });

  test("headless runs carry no autonomy flag at any level", () => {
    // Verified against the installed binary: --prompt rejects --plan, --yolo,
    // and --auto with "Cannot combine --prompt with ...". Emitting one would
    // make every headless run fail.
    for (const level of ["read-only", "low", "medium", "high"] as const) {
      const cmd = adapter.buildRunCommand({
        agent: "kimi",
        prompt: "hello",
        autonomy: level,
      });
      expect(cmd).not.toContain("--plan");
      expect(cmd).not.toContain("--yolo");
      expect(cmd).not.toContain("--auto");
      expect(cmd).toContain("--prompt");
    }
  });

  test("interactive sessions do map autonomy natively", () => {
    expect(adapter.buildTuiCommand(undefined, "read-only")).toContain("--plan");
    expect(adapter.buildTuiCommand(undefined, "medium")).toContain("--yolo");
    expect(adapter.buildTuiCommand(undefined, "high")).toContain("--auto");
    // `low` is the CLI default: it prompts before each tool call.
    expect(adapter.buildTuiCommand(undefined, "low")).toEqual(["kimi"]);
  });

  test("passes the prompt as argv, since 0.31.1 has no stdin transport", () => {
    expect(adapter.getStdinInput({ agent: "kimi", prompt: "hello" })).toBeNull();
    const cmd = adapter.buildRunCommand({ agent: "kimi", prompt: "hello" });
    expect(cmd.slice(-2)).toEqual(["--prompt", "hello"]);
  });

  test("forwards model selection", () => {
    const cmd = adapter.buildRunCommand({
      agent: "kimi",
      prompt: "hello",
      model: "k2",
    });
    expect(cmd).toContain("--model");
    expect(cmd[cmd.indexOf("--model") + 1]).toBe("k2");
  });

  test("requires the scode boundary below high, like every other harness", () => {
    for (const level of ["read-only", "low", "medium"] as const) {
      expect(adapter.requiresSandboxForAutonomy(level)).toBe(true);
      expect(adapter.requiresSandboxForTuiAutonomy(level)).toBe(true);
    }
    expect(adapter.requiresSandboxForAutonomy("high")).toBe(false);
  });

  test("refuses the /goal command and ! shell shape as usage; every other /-leading prompt is model text (al17)", () => {
    // The binary's own rule (0.31.1, both headless entry points): only
    // goal-creates are dispatched before the model turn — so the refusal
    // is the word-bounded /goal name (dispatched as the goal flow with
    // its own exit codes, never a model turn) and the ! shell-escape
    // shape, and nothing else. The al11 rule refused every /- or
    // !-leading prompt; the correctness review caught the cost —
    // /tmp/notes.md please summarize, an ordinary path-like prompt,
    // exited 64 (verified live post-fix: the same prompt reaches the
    // model and answers, exit 0). The session driver's twin (before the
    // ack) carries the same predicate (kimiPromptIsCommand, shared).
    const cwd = mkdtempSync(join(tmpdir(), "kimi-slash-"));
    try {
      for (const prompt of ["/goal create ship it", "/goal status", "!ls"]) {
        let refusal: unknown;
        try {
          adapter.validateRunRequest({ agent: "kimi", prompt, cwd });
        } catch (error) {
          refusal = error;
        }
        // Usage, not a run failure: the marker the CLI maps to exit 64,
        // so a script can tell a request only the caller can fix from a
        // run that failed.
        expect(refusal).toBeInstanceOf(UsageRefusalError);
        expect((refusal as Error).message).toContain(
          "must not be the /goal command or a '!' shell line"
        );
        // Round al18: the message states the true reason per shape.
        // Only /goal CREATES dispatch headlessly (the goal flow, its own
        // exit codes); the other subcommands fall through to the model
        // as prompt text in 0.31.1, and the whole word-bounded name is
        // refused as codemux's policy — an operator refused for
        // /goal status must not be told kimi would have run it as the
        // goal flow, which the al17 message claimed and the repo's own
        // wire facts (kimi-session.ts) contradict.
        expect((refusal as Error).message).toContain(
          "dispatches only /goal creates headlessly"
        );
        expect((refusal as Error).message).toContain(
          "fall through to the model as prompt text"
        );
        expect((refusal as Error).message).toContain(
          "refuses the whole word-bounded /goal name as policy"
        );
      }
      // Every other /-leading prompt — a path first among them, the
      // major's own example — plus plain text validates clean: 0.31.1
      // sends each to the model unchanged.
      for (const prompt of [
        "/tmp/notes.md please summarize",
        "/init",
        "/goalfoo ship it",
        "fix the tests",
      ]) {
        expect(() =>
          adapter.validateRunRequest({ agent: "kimi", prompt, cwd })
        ).not.toThrow();
      }
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("a sandboxed launch reads the adapter's environment view, not process.env (al12)", async () => {
    // The keep-env gate at the launch seam asked process.env whether an
    // override exists, so an ambient malformed CODEMUX_KIMI_PROVIDER_BASE_URL
    // rejected a launch whose adapter view (empty) carries no override at
    // all — before any child spawned, and even without scrubbing. The gate
    // reads the adapter's view now: this launch passes validation and the
    // keep-env decision on the same empty view and dies at the next honest
    // seam instead — no resolvable scode (PATH emptied for the duration).
    const prevPath = process.env.PATH;
    const prevBase = process.env.CODEMUX_KIMI_PROVIDER_BASE_URL;
    const cwd = mkdtempSync(join(tmpdir(), "kimi-launch-view-"));
    process.env.PATH = cwd;
    process.env.CODEMUX_KIMI_PROVIDER_BASE_URL = "not-a-url";
    try {
      await expect(
        launchRunRequest(
          new KimiAdapter({}),
          { agent: "kimi", prompt: "fix the tests", autonomy: "high", sandboxed: true, cwd },
          { sandbox: true, requestedAutonomy: "high", cwd }
        )
      ).rejects.toThrow("scode is not installed");
    } finally {
      process.env.PATH = prevPath;
      if (prevBase === undefined) delete process.env.CODEMUX_KIMI_PROVIDER_BASE_URL;
      else process.env.CODEMUX_KIMI_PROVIDER_BASE_URL = prevBase;
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
