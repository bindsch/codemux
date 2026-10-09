import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { devNull, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  AIDER_EMPTY_CONFIG_PATH,
  AIDER_MODEL_METADATA_PATH,
  AIDER_MODEL_SETTINGS_PATH,
  AiderAdapter,
  aiderPromptIsCommand,
} from "../src/adapters/aider.js";
import { AgyAdapter } from "../src/adapters/agy.js";
import { ClineAdapter } from "../src/adapters/cline.js";
import { CopilotAdapter } from "../src/adapters/copilot.js";
import { CURSOR_ENTRY_ENV, CursorAdapter } from "../src/adapters/cursor.js";
import { AGENT_IDS, getAdapter } from "../src/adapters/index.js";
import { UsageRefusalError } from "../src/validation.js";

describe("new harness registry entries", () => {
  test("registers agy, aider, cline, copilot, and cursor", () => {
    expect(AGENT_IDS).toContain("agy");
    expect(AGENT_IDS).toContain("aider");
    expect(AGENT_IDS).toContain("cline");
    expect(AGENT_IDS).toContain("copilot");
    expect(AGENT_IDS).toContain("cursor");
    expect(getAdapter("agy")).toBeInstanceOf(AgyAdapter);
    expect(getAdapter("aider")).toBeInstanceOf(AiderAdapter);
    expect(getAdapter("cline")).toBeInstanceOf(ClineAdapter);
    expect(getAdapter("copilot")).toBeInstanceOf(CopilotAdapter);
    expect(getAdapter("cursor")).toBeInstanceOf(CursorAdapter);
  });
});

describe("AgyAdapter", () => {
  const adapter = new AgyAdapter();

  test("describes its supported capabilities", () => {
    expect(adapter.id).toBe("agy");
    expect(adapter.binaryName).toBe("agy");
    expect(adapter.capabilities()).toEqual({
      supportsNonInteractive: true,
      supportsInteractive: true,
      supportsModel: true,
      supportsAutonomy: true,
      autonomyLevels: ["read-only", "low", "medium", "high"],
      supportsEffort: true,
      effortLevels: ["low", "medium", "high", "xhigh", "max"],
      supportsResultJson: true,
    });
    // No verified hermetic mode and no tool-removal flag: both requests are
    // refused rather than degraded (docs/HERMETIC.md names the reasons).
    expect(adapter.capabilities().supportsHermetic).toBeUndefined();
    expect(adapter.capabilities().supportsToolSelection).toBeUndefined();
  });

  test("builds a headless command with the value flags in = form and the prompt last", () => {
    // 1.2.14 rejects the space form of its pre-parsed value flags outright
    // (--effort, --mode), and --model's space form was never exercised
    // against the pinned release, so every value flag rides as a single
    // argument.
    expect(adapter.buildRunCommand({
      agent: "agy",
      prompt: "fix the tests",
      model: "gemini-3-pro",
      autonomy: "medium",
      effort: "high",
    })).toEqual([
      "agy",
      "--disable-slash-commands",
      "--model=gemini-3-pro",
      "--effort=high",
      "--mode=accept-edits",
      "--output-format=json",
      "--print=fix the tests",
    ]);
  });

  test("keeps leading-dash prompts inside the print option", () => {
    expect(adapter.buildRunCommand({
      agent: "agy",
      prompt: "--dangerous-looking-prompt",
    })).toContain("--print=--dangerous-looking-prompt");
  });

  test("maps autonomy levels onto agy's mode flags", () => {
    expect(adapter.mapAutonomy("read-only")).toEqual(["--mode=plan"]);
    expect(adapter.mapAutonomy("low")).toEqual([]);
    expect(adapter.mapAutonomy("medium")).toEqual(["--mode=accept-edits"]);
    expect(adapter.mapAutonomy("high")).toEqual(["--dangerously-skip-permissions"]);
  });

  test("refuses effort levels agy does not accept", () => {
    expect(() => adapter.validateRunRequest({
      agent: "agy",
      prompt: "t",
      effort: "ultra",
    })).toThrow("does not support reasoning effort 'ultra'");
  });

  test("--result-json asks for the JSON envelope", () => {
    const cmd = adapter.buildRunCommand({ agent: "agy", prompt: "t", resultJson: true });
    expect(cmd).toContain("--output-format=json");
    expect(adapter.getStdinInput({ agent: "agy", prompt: "t" })).toBeNull();
  });

  test("the envelope is always on, so --result-json adds no flag", () => {
    // Plain runs ask for the envelope too (it is what the plain-run
    // unwrap consumes for the ledger's usage); --result-json only stops
    // the unwrap.
    const plain = adapter.buildRunCommand({ agent: "agy", prompt: "t" });
    expect(plain).toContain("--output-format=json");
    expect(adapter.buildRunCommand({ agent: "agy", prompt: "t", resultJson: true }))
      .toEqual(plain);
  });

  test("builds interactive commands", () => {
    expect(adapter.buildTuiCommand("gemini-3-pro", "read-only", "low"))
      .toEqual(["agy", "--model=gemini-3-pro", "--effort=low", "--mode=plan"]);
  });

  test("rejects Antigravity project manifests before launch", () => {
    const cwd = mkdtempSync(join(tmpdir(), "codemux-agy-project-"));
    mkdirSync(join(cwd, ".git"));
    mkdirSync(join(cwd, ".agents"));
    writeFileSync(
      join(cwd, ".agents", "skills.json"),
      JSON.stringify({ skills: [{ path: "../shared" }] })
    );
    try {
      expect(() => adapter.validateRunRequest({
        agent: "agy",
        prompt: "inspect",
        cwd,
      })).toThrow("refuses repository executable configuration");
      expect(() => adapter.validateTuiRequest(undefined, cwd))
        .toThrow("refuses repository executable configuration");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("rejects the Antigravity config roots the binary names beyond the manifests", () => {
    // The round-2 finding: the refusal list was narrower than its own
    // justification. The binary's strings read `.agents/` directories
    // (rules, plugins, agents, workflows) and `.agents/hooks.json` side by
    // side with the four manifests, plus a whole `.gemini/config/` tree
    // (plugins, skills, hooks.json, mcp_config.json, workflows), so a
    // repository could ship any of them and supply the prompts, hooks, and
    // tools a session runs with.
    const directoryRoots = [
      join(".agents", "rules"),
      join(".agents", "plugins"),
      join(".agents", "agents"),
      join(".agents", "workflows"),
      join(".gemini", "config"),
    ];
    for (const root of [...directoryRoots, join(".agents", "hooks.json")]) {
      const cwd = mkdtempSync(join(tmpdir(), "codemux-agy-config-"));
      try {
        mkdirSync(join(cwd, ".git"));
        // The walker refuses a directory only when it holds an entry.
        if (root.endsWith(".json")) {
          mkdirSync(join(cwd, dirname(root)), { recursive: true });
          writeFileSync(join(cwd, root), "{}");
        } else {
          mkdirSync(join(cwd, root, "supplied"), { recursive: true });
        }
        expect(() => adapter.validateRunRequest({
          agent: "agy",
          prompt: "inspect",
          cwd,
        })).toThrow("refuses repository executable configuration");
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    }
  });
});

describe("AiderAdapter", () => {
  const adapter = new AiderAdapter();

  test("describes its supported capabilities", () => {
    expect(adapter.id).toBe("aider");
    expect(adapter.binaryName).toBe("aider");
    expect(adapter.capabilities()).toEqual({
      supportsNonInteractive: true,
      supportsInteractive: true,
      supportsModel: true,
      supportsAutonomy: true,
      autonomyLevels: ["read-only", "low", "medium", "high"],
      supportsEffort: true,
      effortLevels: ["none", "minimal", "low", "medium", "high", "xhigh", "max"],
      // Refused: the 2026-09-17 check passed, but no flag closes aider's
      // own config layers, and a live 2026-10-04 probe leaked through
      // `.aider.conf.yml` (docs/HERMETIC.md names the channels).
      supportsHermetic: false,
      supportsProviderOverride: true,
    });
  });

  test("refuses a prompt aider would run as a slash command (review D10, security)", () => {
    // Aider's preproc_user_input dispatches a message whose first
    // non-whitespace character is `/` (a slash command) or `!` (the
    // /run alias, which executes the shell immediately, ungated by
    // --dry-run) BEFORE any model turn, so relaying one through a
    // read-only run is code execution the autonomy never authorized.
    // The rule refuses — never escapes — and the session driver's twin
    // (before the ack) carries the same predicate.
    expect(aiderPromptIsCommand("/run whoami")).toBe(true);
    expect(aiderPromptIsCommand("!touch pwned")).toBe(true);
    // Leading whitespace does not hide the dispatch: aider skips it too.
    expect(aiderPromptIsCommand("  /add file")).toBe(true);
    expect(aiderPromptIsCommand("\n!curl http://127.0.0.1:9")).toBe(true);
    // A slash later in the text, or an author label ahead of it, is
    // plain prompt text — only the first non-whitespace character
    // dispatches.
    expect(aiderPromptIsCommand("what is /etc/hosts for?")).toBe(false);
    expect(aiderPromptIsCommand("[ana] /run whoami")).toBe(false);

    const cwd = mkdtempSync(join(tmpdir(), "aider-slash-"));
    try {
      for (const prompt of ["/run whoami", "!touch pwned"]) {
        let refusal: unknown;
        try {
          adapter.validateRunRequest({ agent: "aider", prompt, cwd });
        } catch (error) {
          refusal = error;
        }
        // Usage, not a run failure: the marker the CLI maps to exit 64,
        // so a script can tell a request only the caller can fix from a
        // run that failed.
        expect(refusal).toBeInstanceOf(UsageRefusalError);
        expect((refusal as Error).message).toContain(
          "aider prompts must not start with '/' or '!'"
        );
        expect((refusal as Error).message).toContain("ungated by --dry-run");
      }
      // A plain prompt still validates clean.
      expect(() =>
        adapter.validateRunRequest({ agent: "aider", prompt: "fix the tests", cwd })
      ).not.toThrow();
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("builds run commands without confusing model and message flags", () => {
    expect(adapter.buildRunCommand({
      agent: "aider",
      prompt: "fix the tests",
      model: "openai/gpt-5.4",
      autonomy: "read-only",
      effort: "high",
    })).toEqual([
      "aider",
      "--config",
      AIDER_EMPTY_CONFIG_PATH,
      "--env-file",
      devNull,
      "--model-settings-file",
      AIDER_MODEL_SETTINGS_PATH,
      "--model-metadata-file",
      AIDER_MODEL_METADATA_PATH,
      "--input-history-file",
      devNull,
      "--chat-history-file",
      devNull,
      "--no-gitignore",
      "--no-auto-commits",
      "--no-dirty-commits",
      "--no-analytics",
      "--no-suggest-shell-commands",
      "--no-check-update",
      "--no-show-release-notes",
      "--no-show-model-warnings",
      "--disable-playwright",
      "--model",
      "openai/gpt-5.4",
      "--dry-run",
      "--reasoning-effort",
      "high",
      "--message=fix the tests",
    ]);
  });

  test("maps supervised and auto-confirm modes", () => {
    expect(adapter.mapAutonomy("read-only")).toEqual(["--dry-run"]);
    expect(adapter.mapAutonomy("low")).toEqual([]);
    expect(adapter.mapAutonomy("medium")).toEqual(["--yes-always"]);
    expect(adapter.mapAutonomy("high")).toEqual(["--yes-always"]);
  });

  test("builds interactive commands and passes explicit none effort", () => {
    expect(adapter.buildTuiCommand("anthropic/claude-sonnet-4", "low", "none"))
      .toEqual([
        "aider",
        "--config",
        AIDER_EMPTY_CONFIG_PATH,
        "--env-file",
        devNull,
        "--model-settings-file",
        AIDER_MODEL_SETTINGS_PATH,
        "--model-metadata-file",
        AIDER_MODEL_METADATA_PATH,
        "--input-history-file",
        devNull,
        "--chat-history-file",
        devNull,
        "--no-gitignore",
        "--no-auto-commits",
        "--no-dirty-commits",
        "--no-analytics",
        "--no-suggest-shell-commands",
        "--no-check-update",
        "--no-show-release-notes",
        "--no-show-model-warnings",
        "--disable-playwright",
        "--model",
        "anthropic/claude-sonnet-4",
        "--reasoning-effort",
        "none",
      ]);
  });

  test("keeps leading-dash prompts inside the message option", () => {
    expect(adapter.buildRunCommand({
      agent: "aider",
      prompt: "--dangerous-looking-prompt",
    })).toContain("--message=--dangerous-looking-prompt");
  });

  test("declines headless prompts and retains the argv size guard", () => {
    expect(adapter.getStdinInput({ agent: "aider", prompt: "test" }))
      .toStartWith("n\nn\n");
    expect(() => adapter.validateRunRequest({
      agent: "aider",
      prompt: "x".repeat(40_000),
    })).toThrow("passes prompts in argv");
  });
});

describe("ClineAdapter", () => {
  const adapter = new ClineAdapter();

  test("describes its supported capabilities", () => {
    expect(adapter.id).toBe("cline");
    expect(adapter.binaryName).toBe("cline");
    expect(adapter.capabilities()).toEqual({
      supportsNonInteractive: true,
      supportsInteractive: true,
      supportsModel: true,
      supportsAutonomy: true,
      autonomyLevels: ["read-only", "low", "medium", "high"],
      supportsEffort: true,
      effortLevels: ["none", "low", "medium", "high", "xhigh"],
      // Both refusals verified live at 3.0.62; see docs/HERMETIC.md.
      supportsHermetic: false,
      supportsToolSelection: false,
    });
  });

  test("builds a one-task headless command", () => {
    expect(adapter.buildRunCommand({
      agent: "cline",
      prompt: "fix the tests",
      model: "claude-sonnet-4",
      autonomy: "medium",
      effort: "high",
    })).toEqual([
      "cline",
      "--model",
      "claude-sonnet-4",
      "--auto-approve",
      "true",
      "--thinking",
      "high",
      "--",
      "fix the tests",
    ]);
  });

  test("uses explicit TUI and plan modes", () => {
    expect(adapter.buildTuiCommand(undefined, "read-only", "none"))
      .toEqual(["cline", "--tui", "--plan", "--thinking", "none"]);
  });

  test("maps approval levels", () => {
    expect(adapter.mapAutonomy("read-only")).toEqual(["--plan"]);
    expect(adapter.mapAutonomy("low")).toEqual(["--auto-approve", "false"]);
    expect(adapter.mapAutonomy("medium")).toEqual(["--auto-approve", "true"]);
    expect(adapter.mapAutonomy("high")).toEqual(["--auto-approve", "true"]);
  });
});

describe("CopilotAdapter", () => {
  const adapter = new CopilotAdapter();

  test("describes its supported capabilities", () => {
    expect(adapter.id).toBe("copilot");
    expect(adapter.binaryName).toBe("copilot");
    expect(adapter.capabilities()).toEqual({
      supportsNonInteractive: true,
      supportsInteractive: true,
      supportsModel: true,
      supportsAutonomy: true,
      autonomyLevels: ["read-only", "low", "medium", "high"],
      supportsEffort: true,
      effortLevels: ["none", "minimal", "low", "medium", "high", "xhigh", "max"],
      // Both refusals verified live at 1.0.85; see docs/HERMETIC.md.
      supportsHermetic: false,
      supportsToolSelection: false,
    });
  });

  test("builds programmatic prompt commands", () => {
    expect(adapter.buildRunCommand({
      agent: "copilot",
      prompt: "fix the tests",
      model: "gpt-5.3-codex",
      autonomy: "high",
      effort: "high",
    })).toEqual([
      "copilot",
      "--no-auto-update",
      "--no-bash-env",
      "--no-remote",
      "--no-remote-export",
      "--no-custom-instructions",
      "--no-experimental",
      "--model",
      "gpt-5.3-codex",
      "--allow-all",
      "--reasoning-effort",
      "high",
      "--prompt=fix the tests",
      "--silent",
    ]);
    expect(adapter.getStdinInput({ agent: "copilot", prompt: "fix the tests" }))
      .toBeNull();
  });

  test("maps plan, supervised, tool-approved, and unrestricted modes", () => {
    expect(adapter.mapAutonomy("read-only")).toEqual(["--plan"]);
    expect(adapter.mapAutonomy("low")).toEqual(["--allow-tool", "read"]);
    expect(adapter.mapAutonomy("medium")).toEqual(["--allow-all-tools"]);
    expect(adapter.mapAutonomy("high")).toEqual(["--allow-all"]);
  });

  test("disables remote built-ins below high autonomy", () => {
    expect(adapter.buildRunCommand({
      agent: "copilot",
      prompt: "inspect",
      autonomy: "medium",
    })).toContain("--disable-builtin-mcps");
    expect(adapter.buildRunCommand({
      agent: "copilot",
      prompt: "inspect",
      autonomy: "high",
    })).not.toContain("--disable-builtin-mcps");
  });

  test("rejects repository hooks and executable project configuration", () => {
    const cwd = mkdtempSync(join(tmpdir(), "codemux-copilot-project-"));
    mkdirSync(join(cwd, ".git"));
    mkdirSync(join(cwd, ".github", "hooks"), { recursive: true });
    writeFileSync(
      join(cwd, ".github", "hooks", "session.json"),
      JSON.stringify({ version: 1, hooks: {} })
    );
    try {
      expect(() => adapter.validateRunRequest({
        agent: "copilot",
        prompt: "inspect",
        cwd,
      })).toThrow("refuses repository executable configuration");
      expect(() => adapter.validateTuiRequest(undefined, cwd))
        .toThrow("refuses repository executable configuration");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("passes the explicit none effort through", () => {
    expect(adapter.buildTuiCommand("claude-sonnet-4.6", "low", "none"))
      .toEqual([
        "copilot",
        "--no-auto-update",
        "--no-bash-env",
        "--no-remote",
        "--no-remote-export",
        "--no-custom-instructions",
        "--no-experimental",
        "--disable-builtin-mcps",
        "--model",
        "claude-sonnet-4.6",
        "--allow-tool",
        "read",
        "--reasoning-effort",
        "none",
      ]);
  });
});

describe("CursorAdapter", () => {
  // Every construction passes an explicit environment: the constructor
  // defaults to process.env, and an exported CODEMUX_CURSOR_ENTRY=cursor
  // -- exactly what tests/installed-contract.test.ts hardens against --
  // would flip any test whose outcome depends on the opt-in being absent.
  const adapter = new CursorAdapter(
    (name) => name === "agent" ? "/fake/agent" : null,
    {}
  );

  test("describes its supported capabilities", () => {
    expect(adapter.id).toBe("cursor");
    expect(adapter.binaryName).toBe("agent");
    expect(adapter.capabilities()).toEqual({
      supportsNonInteractive: true,
      supportsInteractive: true,
      supportsModel: true,
      supportsAutonomy: true,
      autonomyLevels: ["read-only", "low", "medium", "high"],
      supportsEffort: false,
      effortLevels: [],
    });
  });

  test("builds plain-text headless commands", () => {
    expect(adapter.buildRunCommand({
      agent: "cursor",
      prompt: "fix the tests",
      model: "gpt-5",
      autonomy: "high",
    })).toEqual([
      "agent",
      "--print",
      "--output-format",
      "text",
      "--trust",
      "--model",
      "gpt-5",
      "--force",
    ]);
    expect(adapter.getStdinInput({ agent: "cursor", prompt: "fix the tests" }))
      .toBe("fix the tests");
    expect(() => adapter.validateRunRequest({
      agent: "cursor",
      prompt: "x".repeat(40_000),
      autonomy: "read-only",
      sandboxed: true,
    })).not.toThrow();
  });

  test("maps current CLI agent modes", () => {
    expect(adapter.mapAutonomy("read-only")).toEqual(["--mode", "plan"]);
    expect(adapter.mapAutonomy("low")).toEqual([]);
    expect(adapter.mapAutonomy("medium")).toEqual(["--auto-review"]);
    expect(adapter.mapAutonomy("high")).toEqual(["--force"]);
  });

  test("builds interactive commands", () => {
    expect(adapter.buildTuiCommand("gpt-5", "medium", undefined, true))
      .toEqual(["agent", "--trust", "--sandbox", "disabled", "--model", "gpt-5", "--auto-review"]);
    expect(adapter.requiresSandboxForAutonomy("read-only")).toBe(true);
    expect(adapter.requiresSandboxForAutonomy("high")).toBe(false);
  });

  test("prefers agent and falls back to the legacy cursor-agent alias", () => {
    const fallback = new CursorAdapter(
      (name) => name === "cursor-agent" ? "/fake/cursor-agent" : null,
      {}
    );
    expect(fallback.binaryName).toBe("cursor-agent");
    expect(fallback.isAvailable()).toBe(true);
    expect(fallback.buildRunCommand({
      agent: "cursor",
      prompt: "test",
      autonomy: "read-only",
      sandboxed: true,
    })).toEqual([
      "cursor-agent",
      "--print",
      "--output-format",
      "text",
      "--trust",
      "--sandbox",
      "disabled",
      "--mode",
      "plan",
    ]);
  });

  test("the desktop entry is ignored without the opt-in", () => {
    // The round-3 redesign restores 0.6.0's default exactly: resolve
    // `agent`, then `cursor-agent`; neither found means "not installed" --
    // and a desktop `cursor` on PATH is not one of the things looked for.
    // The wrapper behind `cursor agent` may install or update the agent on
    // first use, so it must never run on codemux's own initiative.
    // The empty explicit environment is the point (round 4): without it
    // this construction reads process.env, and an exported
    // CODEMUX_CURSOR_ENTRY=cursor makes desktopOptIn true, the desktop
    // entry resolve, and this test fail.
    const desktopOnly = new CursorAdapter(
      (name) => (name === "cursor" ? "/fake/cursor" : null),
      {}
    );
    expect(desktopOnly.isAvailable()).toBe(false);
    expect(desktopOnly.binaryName).toBe("agent");
    expect(desktopOnly.displayName).toBe("agent");
    // A value other than `cursor` opts into nothing.
    const wrongValue = new CursorAdapter(
      (name) => (name === "cursor" ? "/fake/cursor" : null),
      { [CURSOR_ENTRY_ENV]: "desktop" }
    );
    expect(wrongValue.isAvailable()).toBe(false);
    expect(wrongValue.binaryName).toBe("agent");
    // Nothing resolved: the "harness not found" error names the standalone.
    const none = new CursorAdapter(() => null, {});
    expect(none.isAvailable()).toBe(false);
    expect(none.binaryName).toBe("agent");
  });

  test("an exported CODEMUX_CURSOR_ENTRY cannot flip the opt-out tests", () => {
    // The round-4 regression pin: with the opt-in exported in the real
    // environment -- the exact scenario tests/installed-contract.test.ts
    // hardens against for the gate -- a construction that defaulted to
    // process.env reported the desktop entry as installed, so "ignored
    // without the opt-in" failed. The explicit empty environment must be
    // what isolates these tests; reverting any construction here to the
    // process.env default makes this test fail again.
    const saved = process.env[CURSOR_ENTRY_ENV];
    process.env[CURSOR_ENTRY_ENV] = "cursor";
    try {
      const desktopOnly = new CursorAdapter(
        (name) => (name === "cursor" ? "/fake/cursor" : null),
        {}
      );
      expect(desktopOnly.isAvailable()).toBe(false);
      expect(desktopOnly.binaryName).toBe("agent");
      expect(desktopOnly.displayName).toBe("agent");
    } finally {
      if (saved === undefined) {
        delete process.env[CURSOR_ENTRY_ENV];
      } else {
        process.env[CURSOR_ENTRY_ENV] = saved;
      }
    }
  });

  test("the desktop entry is used when the opt-in is set", () => {
    // CODEMUX_CURSOR_ENTRY=cursor selects the desktop entry outright,
    // standalone builds included: the operator asked for the wrapper's
    // entry. When the `cursor` it names does not resolve, the default
    // standalone chain answers instead.
    const desktopOnly = new CursorAdapter(
      (name) => (name === "cursor" ? "/fake/cursor" : null),
      { [CURSOR_ENTRY_ENV]: "cursor" }
    );
    expect(desktopOnly.isAvailable()).toBe(true);
    expect(desktopOnly.binaryName).toBe("cursor");
    expect(desktopOnly.displayName).toBe("cursor");
    expect(desktopOnly.buildRunCommand({
      agent: "cursor",
      prompt: "test",
      autonomy: "read-only",
      sandboxed: true,
    })).toEqual([
      "cursor",
      "agent",
      "--print",
      "--output-format",
      "text",
      "--trust",
      "--sandbox",
      "disabled",
      "--mode",
      "plan",
    ]);
    expect(desktopOnly.buildTuiCommand("gpt-5", "medium", undefined, true)).toEqual([
      "cursor",
      "agent",
      "--trust",
      "--sandbox",
      "disabled",
      "--model",
      "gpt-5",
      "--auto-review",
    ]);
    // The opt-in outranks a resolved standalone `agent`.
    const both = new CursorAdapter(
      (name) => (name === "cursor" || name === "agent" ? `/fake/${name}` : null),
      { [CURSOR_ENTRY_ENV]: "cursor" }
    );
    expect(both.isAvailable()).toBe(true);
    expect(both.binaryName).toBe("cursor");
    // The opt-in names a `cursor` that is not there: default resolution.
    const missing = new CursorAdapter(
      (name) => (name === "agent" ? "/fake/agent" : null),
      { [CURSOR_ENTRY_ENV]: "cursor" }
    );
    expect(missing.isAvailable()).toBe(true);
    expect(missing.binaryName).toBe("agent");
  });

  test("the desktop opt-in requires the --pass-env gesture", () => {
    // The variable being set is not authorization, however it was
    // populated: a shell profile or repository-controlled environment
    // must not make codemux execute an installer-capable wrapper. Only
    // the passthrough name -- argv the operator typed -- authorizes the
    // entry, and a launch without it is refused with both fixes named,
    // before the version gate could probe anything.
    const adapter = new CursorAdapter(
      (name) => (name === "cursor" ? "/fake/cursor" : null),
      { [CURSOR_ENTRY_ENV]: "cursor" }
    );
    expect(() => adapter.validateRunRequest({
      agent: "cursor",
      prompt: "test",
      autonomy: "read-only",
      sandboxed: true,
    })).toThrow(`add --pass-env ${CURSOR_ENTRY_ENV}`);
    expect(() => adapter.validateRunRequest({
      agent: "cursor",
      prompt: "test",
      autonomy: "read-only",
      sandboxed: true,
      passthroughEnv: [CURSOR_ENTRY_ENV],
    })).not.toThrow();
    expect(() => adapter.validateTuiRequest(undefined, undefined))
      .toThrow(`add --pass-env ${CURSOR_ENTRY_ENV}`);
    expect(() => adapter.validateTuiRequest(
      undefined,
      undefined,
      "read-only",
      undefined,
      [CURSOR_ENTRY_ENV]
    )).not.toThrow();
    // The standalone entries never need the gesture.
    const standalone = new CursorAdapter(
      (name) => (name === "agent" ? "/fake/agent" : null),
      {}
    );
    expect(() => standalone.validateRunRequest({
      agent: "cursor",
      prompt: "test",
      autonomy: "read-only",
      sandboxed: true,
    })).not.toThrow();
  });

  test("discovery never executes a repository-local cursor, whatever the trust check would say", () => {
    // The round-2 finding: entry resolution once probed `cursor agent
    // --help` on the PATH-resolved `cursor`, forbidden-rooted at
    // process.cwd() rather than the run's --cwd, so a repository-controlled
    // cursor on PATH executed outside the sandbox during discovery --
    // before the launch's trust check, which knows the run's working
    // directory, could refuse it. Discovery still executes nothing at all:
    // entry resolution, availability, and command building are spawn-free,
    // and the launch's gate is the first and only place that resolves the
    // binary to a trusted path. The worst case here is the opt-in set
    // (the entry actually selected) with the binary inside a repository;
    // the fake cursor marks its execution, and nothing here may create
    // the marker.
    const repoDir = mkdtempSync(join(tmpdir(), "codemux-cursor-repo-"));
    const binary = join(repoDir, "bin", "cursor");
    const marker = join(repoDir, "ran");
    try {
      mkdirSync(join(repoDir, "bin"), { recursive: true });
      // User-owned and not group- or world-writable: a file the launch's
      // own trust check accepts outside its forbidden root. Only the run's
      // --cwd (this repository) makes it untrusted -- the exact case the
      // probe's process.cwd() root missed.
      writeFileSync(binary, `#!/bin/sh\necho ran >> '${marker}'\nexit 0\n`);
      chmodSync(binary, 0o755);
      const adapter = new CursorAdapter(
        (name) => (name === "cursor" ? binary : null),
        { [CURSOR_ENTRY_ENV]: "cursor" }
      );
      expect(adapter.isAvailable()).toBe(true);
      expect(adapter.binaryName).toBe("cursor");
      expect(adapter.displayName).toBe("cursor");
      expect(adapter.buildRunCommand({
        agent: "cursor",
        prompt: "test",
        autonomy: "read-only",
        sandboxed: true,
        cwd: repoDir,
      })).toEqual([
        "cursor",
        "agent",
        "--print",
        "--output-format",
        "text",
        "--trust",
        "--sandbox",
        "disabled",
        "--mode",
        "plan",
      ]);
      expect(adapter.buildTuiCommand("gpt-5", "medium", undefined, true))
        .toContain("--auto-review");
      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  test("diagnostics never execute the desktop wrapper's installer path", () => {
    // The other round-2 finding: `list`, `doctor`, and `verify` once probed
    // `cursor agent --help` when the desktop entry was the only candidate,
    // and the desktop wrapper (the Cursor.app 3.23.12 launcher script)
    // downloads and runs https://cursor.com/install when
    // ~/.local/bin/cursor-agent is absent and runs `cursor-agent update`
    // when the build is old -- before forwarding even --help. The fake
    // models that wrapper: it marks any invocation of its `agent`
    // subcommand. Availability (list, doctor, and verify's installed
    // check), entry naming, and the command building verify performs must
    // all leave the marker untouched -- even with the opt-in active, which
    // is the case that actually selects this entry.
    const dir = mkdtempSync(join(tmpdir(), "codemux-cursor-wrapper-"));
    const wrapper = join(dir, "cursor");
    const marker = join(dir, "agent-subcommand-ran");
    try {
      writeFileSync(
        wrapper,
        `#!/bin/sh\nif [ "$1" = "agent" ]; then echo ran >> '${marker}'; fi\nexit 0\n`
      );
      chmodSync(wrapper, 0o755);
      const adapter = new CursorAdapter(
        (name) => (name === "cursor" ? wrapper : null),
        { [CURSOR_ENTRY_ENV]: "cursor" }
      );
      // The desktop entry counts as installed under the opt-in...
      expect(adapter.isAvailable()).toBe(true);
      // ...and answering every diagnostic question runs nothing.
      expect(adapter.binaryName).toBe("cursor");
      expect(adapter.displayName).toBe("cursor");
      expect(adapter.capabilities().supportsNonInteractive).toBe(true);
      expect(adapter.buildRunCommand({ agent: "cursor", prompt: "test" }))
        .toContain("--print");
      expect(adapter.buildTuiCommand()).toEqual(["cursor", "agent"]);
      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("rejects Cursor project hooks before launch", () => {
    const cwd = mkdtempSync(join(tmpdir(), "codemux-cursor-project-"));
    mkdirSync(join(cwd, ".git"));
    mkdirSync(join(cwd, ".cursor"));
    writeFileSync(join(cwd, ".cursor", "hooks.json"), "{}");
    try {
      expect(() => adapter.validateRunRequest({
        agent: "cursor",
        prompt: "inspect",
        autonomy: "read-only",
        sandboxed: true,
        cwd,
      })).toThrow("refuses repository executable configuration");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("BaseAdapter execution fails closed without an explicit sandbox", async () => {
    await expect(adapter.run({ agent: "cursor", prompt: "test" })).rejects.toThrow(
      "cannot enforce 'read-only' autonomy without an external sandbox"
    );
  });
});
