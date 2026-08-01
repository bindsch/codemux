import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import { join } from "node:path";
import {
  AIDER_EMPTY_CONFIG_PATH,
  AIDER_MODEL_METADATA_PATH,
  AIDER_MODEL_SETTINGS_PATH,
  AiderAdapter,
} from "../src/adapters/aider.js";
import { ClineAdapter } from "../src/adapters/cline.js";
import { CopilotAdapter } from "../src/adapters/copilot.js";
import { CursorAdapter } from "../src/adapters/cursor.js";
import { AGENT_IDS, getAdapter } from "../src/adapters/index.js";

describe("new harness registry entries", () => {
  test("registers aider, cline, copilot, and cursor", () => {
    expect(AGENT_IDS).toContain("aider");
    expect(AGENT_IDS).toContain("cline");
    expect(AGENT_IDS).toContain("copilot");
    expect(AGENT_IDS).toContain("cursor");
    expect(getAdapter("aider")).toBeInstanceOf(AiderAdapter);
    expect(getAdapter("cline")).toBeInstanceOf(ClineAdapter);
    expect(getAdapter("copilot")).toBeInstanceOf(CopilotAdapter);
    expect(getAdapter("cursor")).toBeInstanceOf(CursorAdapter);
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
    });
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
      "--effort",
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
        "--effort",
        "none",
      ]);
  });
});

describe("CursorAdapter", () => {
  const adapter = new CursorAdapter((name) => name === "agent" ? "/fake/agent" : null);

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
    const fallback = new CursorAdapter((name) =>
      name === "cursor-agent" ? "/fake/cursor-agent" : null
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
