import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
      // Hermetic since the parity round (COPILOT_HOME private config
      // directory); tools none rides the --available-tools sentinel
      // allowlist; result JSON rides --output-format json
      // (docs/isolation.md).
      supportsHermetic: true,
      supportsToolSelection: true,
      supportsResultJson: true,
      supportsProviderOverride: true,
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
      "--silent",
    ]);
    expect(adapter.getStdinInput({ agent: "copilot", prompt: "fix the tests" }))
      .toBe("fix the tests");
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

describe("CopilotAdapter run parity", () => {
  const HARDENING = [
    "--no-auto-update",
    "--no-bash-env",
    "--no-remote",
    "--no-remote-export",
    "--no-custom-instructions",
    "--no-experimental",
  ] as const;

  test("a hermetic run routes the harness through the private config directory", () => {
    const home = mkdtempSync(join(tmpdir(), "copilot-parity-"));
    try {
      const adapter = new CopilotAdapter({ HOME: home });
      const context = adapter.prepareRun({ agent: "copilot", prompt: "t", hermetic: true });
      const cmd = adapter.buildRunCommand({ agent: "copilot", prompt: "t", hermetic: true }, context);
      expect(cmd[0]).toBe("env");
      expect(cmd[1]!.startsWith(`COPILOT_HOME=${join(home, ".copilot", ".codemux-hermetic", "run-")}`))
        .toBe(true);
      expect(cmd[2]).toBe("copilot");
      expect(cmd.slice(3, 9)).toEqual([...HARDENING]);
      adapter.cleanupRunSync(context);
      const preview = adapter.buildRunCommand({ agent: "copilot", prompt: "t", hermetic: true });
      expect(preview[1]).toBe(
        `COPILOT_HOME=${join(home, ".copilot", ".codemux-hermetic", "unprepared")}`
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("prepareRun hard links the login config; cleanup removes the private directory", () => {
    const home = mkdtempSync(join(tmpdir(), "copilot-parity-"));
    try {
      mkdirSync(join(home, ".copilot"), { recursive: true });
      writeFileSync(join(home, ".copilot", "config.json"), "{}");
      const adapter = new CopilotAdapter({ HOME: home });
      const context = adapter.prepareRun({ agent: "copilot", prompt: "t", hermetic: true });
      expect(existsSync(join(context.copilotHermeticHome!.home, "config.json"))).toBe(true);
      adapter.cleanupRunSync(context);
      expect(existsSync(context.copilotHermeticHome!.home)).toBe(false);
      expect(existsSync(join(home, ".copilot", "config.json"))).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("--tools none rides the sentinel allowlist; --result-json rides the json output", () => {
    const adapter = new CopilotAdapter();
    const cmd = adapter.buildRunCommand({
      agent: "copilot",
      prompt: "t",
      tools: "none",
      resultJson: true,
    });
    expect(cmd).toEqual([
      "copilot",
      ...HARDENING,
      "--disable-builtin-mcps",
      "--available-tools",
      "codemux-no-tools",
      "--output-format",
      "json",
      "--silent",
    ]);
    const out = adapter.processRunResult(
      {
        stdout: [
          JSON.stringify({ type: "assistant.message", data: { content: "done", model: "served" } }),
          JSON.stringify({ type: "result", sessionId: "s", exitCode: 0, usage: {} }),
        ].join("\n"),
        stderr: "",
        exitCode: 0,
        success: true,
      },
      { agent: "copilot", prompt: "t", resultJson: true }
    );
    expect(out.success).toBe(true);
    expect(JSON.parse(out.stdout).codemux.session_id).toBe("s");
  });

  test("a hermetic run may not pass COPILOT_HOME through", () => {
    const work = mkdtempSync(join(tmpdir(), "copilot-parity-"));
    try {
      const adapter = new CopilotAdapter();
      expect(() =>
        adapter.validateRunRequest({
          agent: "copilot",
          prompt: "t",
          cwd: work,
          hermetic: true,
          passthroughEnv: ["COPILOT_HOME"],
        })
      ).toThrow(/owns COPILOT_HOME/);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });
});
