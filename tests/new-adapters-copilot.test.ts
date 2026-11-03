import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CopilotAdapter } from "../src/adapters/copilot.js";

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
      // Both refusals verified live at 1.0.85; see docs/isolation.md.
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
