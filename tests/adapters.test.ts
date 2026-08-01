import { describe, test, expect } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeAdapter } from "../src/adapters/claude.js";
import { CodexAdapter } from "../src/adapters/codex.js";
import { DroidAdapter } from "../src/adapters/droid.js";
import { GooseAdapter } from "../src/adapters/goose.js";
import {
  GEMINI_SYSTEM_SETTINGS_PATH,
  GeminiAdapter,
} from "../src/adapters/gemini.js";
import { OpencodeAdapter } from "../src/adapters/opencode.js";
import { PiAdapter } from "../src/adapters/pi.js";
import { QwenAdapter } from "../src/adapters/qwen.js";
import { ZaiAdapter } from "../src/adapters/zai.js";
import {
  AGENT_IDS,
  getAdapter,
  getAllAdapters,
  getAvailableAdapters,
} from "../src/adapters/index.js";
import type { RunRequest } from "../src/types.js";

describe("Adapter Registry", () => {
  test("AGENT_IDS contains all expected agents", () => {
    expect(AGENT_IDS).toContain("claude");
    expect(AGENT_IDS).toContain("codex");
    expect(AGENT_IDS).toContain("droid");
    expect(AGENT_IDS).toContain("goose");
    expect(AGENT_IDS).toContain("gemini");
    expect(AGENT_IDS).toContain("opencode");
    expect(AGENT_IDS).toContain("pi");
    expect(AGENT_IDS).toContain("qwen");
    expect(AGENT_IDS).toContain("zai");
    expect(AGENT_IDS.length).toBe(13);
  });

  test("getAdapter returns correct adapter for each agent", () => {
    expect(getAdapter("claude")).toBeInstanceOf(ClaudeAdapter);
    expect(getAdapter("codex")).toBeInstanceOf(CodexAdapter);
    expect(getAdapter("droid")).toBeInstanceOf(DroidAdapter);
    expect(getAdapter("goose")).toBeInstanceOf(GooseAdapter);
    expect(getAdapter("gemini")).toBeInstanceOf(GeminiAdapter);
    expect(getAdapter("opencode")).toBeInstanceOf(OpencodeAdapter);
    expect(getAdapter("pi")).toBeInstanceOf(PiAdapter);
    expect(getAdapter("qwen")).toBeInstanceOf(QwenAdapter);
    expect(getAdapter("zai")).toBeInstanceOf(ZaiAdapter);
  });

  test("getAdapter throws for unknown agent", () => {
    expect(() => getAdapter("unknown" as any)).toThrow("Unknown agent: unknown");
  });

  test("getAllAdapters returns all 13 adapters", () => {
    const adapters = getAllAdapters();
    expect(adapters.length).toBe(13);
  });

  test("getAvailableAdapters filters by executable availability", () => {
    const available = getAvailableAdapters();
    expect(available.every((adapter) => adapter.isAvailable())).toBe(true);
  });
});

describe("ClaudeAdapter", () => {
  const adapter = new ClaudeAdapter();

  test("has correct id and binary name", () => {
    expect(adapter.id).toBe("claude");
    expect(adapter.binaryName).toBe("claude");
  });

  test("capabilities are correct", () => {
    const caps = adapter.capabilities();
    expect(caps.supportsNonInteractive).toBe(true);
    expect(caps.supportsInteractive).toBe(true);
    expect(caps.supportsModel).toBe(true);
    expect(caps.supportsAutonomy).toBe(true);
    expect(caps.autonomyLevels).toEqual(["read-only", "low", "medium", "high"]);
    expect(caps.supportsEffort).toBe(true);
    expect(caps.effortLevels).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });

  test("buildRunCommand with prompt only", () => {
    const request: RunRequest = { agent: "claude", prompt: "test prompt" };
    const cmd = adapter.buildRunCommand(request);
    expect(cmd).toEqual([
      "claude",
      "-p",
      "--setting-sources",
      "user",
      "--strict-mcp-config",
      "--no-session-persistence",
    ]);
  });

  test("buildRunCommand with model", () => {
    const request: RunRequest = { agent: "claude", prompt: "test", model: "opus" };
    const cmd = adapter.buildRunCommand(request);
    expect(cmd).toEqual([
      "claude",
      "-p",
      "--setting-sources",
      "user",
      "--strict-mcp-config",
      "--no-session-persistence",
      "--model",
      "opus",
    ]);
  });

  test("buildRunCommand with autonomy levels", () => {
    expect(adapter.buildRunCommand({ agent: "claude", prompt: "t", autonomy: "read-only" }))
      .toEqual(["claude", "-p", "--setting-sources", "user", "--strict-mcp-config", "--no-session-persistence", "--permission-mode", "plan"]);
    expect(adapter.buildRunCommand({ agent: "claude", prompt: "t", autonomy: "low" }))
      .toEqual(["claude", "-p", "--setting-sources", "user", "--strict-mcp-config", "--no-session-persistence", "--permission-mode", "manual"]);
    expect(adapter.buildRunCommand({ agent: "claude", prompt: "t", autonomy: "medium" }))
      .toEqual(["claude", "-p", "--setting-sources", "user", "--strict-mcp-config", "--no-session-persistence", "--permission-mode", "acceptEdits"]);
    expect(adapter.buildRunCommand({ agent: "claude", prompt: "t", autonomy: "high" }))
      .toEqual(["claude", "-p", "--setting-sources", "user", "--strict-mcp-config", "--no-session-persistence", "--dangerously-skip-permissions"]);
  });

  test("buildRunCommand does not inject an MCP server by default", () => {
    const cmd = adapter.buildRunCommand({ agent: "claude", prompt: "t", sandboxed: true });
    expect(cmd).toEqual([
      "claude",
      "-p",
      "--setting-sources",
      "user",
      "--strict-mcp-config",
      "--no-session-persistence",
    ]);
  });

  test("scrubs project hook subprocess environments", () => {
    expect(adapter.getEnv()).toEqual({
      CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: "1",
    });
  });

  test("getStdinInput returns prompt", () => {
    const request: RunRequest = { agent: "claude", prompt: "my prompt" };
    expect(adapter.getStdinInput(request)).toBe("my prompt");
  });

  test("buildTuiCommand basic", () => {
    expect(adapter.buildTuiCommand()).toEqual(["claude", "--safe-mode"]);
  });

  test("buildTuiCommand with model", () => {
    expect(adapter.buildTuiCommand("opus")).toEqual(["claude", "--safe-mode", "--model", "opus"]);
  });

  test("buildTuiCommand with autonomy", () => {
    expect(adapter.buildTuiCommand(undefined, "high")).toEqual(["claude", "--safe-mode", "--dangerously-skip-permissions"]);
    expect(adapter.buildTuiCommand("opus", "medium")).toEqual(["claude", "--safe-mode", "--model", "opus", "--permission-mode", "acceptEdits"]);
  });

  test("buildTuiCommand does not inject an MCP server by default", () => {
    const cmd = adapter.buildTuiCommand("opus", "high", undefined, true);
    expect(cmd).toEqual([
      "claude",
      "--safe-mode",
      "--model",
      "opus",
      "--dangerously-skip-permissions",
    ]);
  });

  test("TUI Playwright MCP rejects a binary inside the requested cwd", () => {
    const cwd = mkdtempSync(join(tmpdir(), "codemux-tui-mcp-"));
    const binary = join(cwd, "playwright-mcp");
    writeFileSync(binary, "#!/bin/sh\nexit 0\n");
    chmodSync(binary, 0o755);
    const originalPath = process.env.PATH;
    process.env.PATH = `${cwd}:${originalPath ?? ""}`;
    try {
      expect(() => adapter.buildTuiCommand(
        "opus",
        "high",
        undefined,
        true,
        true,
        cwd
      )).toThrow("inside the execution working directory");
    } finally {
      if (originalPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = originalPath;
      }
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("TUI Playwright MCP keeps project settings isolated without safe mode", () => {
    const root = mkdtempSync(join(tmpdir(), "codemux-tui-mcp-opt-in-"));
    const cwd = join(root, "work");
    const binary = join(root, "playwright-mcp");
    mkdirSync(cwd);
    writeFileSync(binary, "#!/bin/sh\nexit 0\n");
    chmodSync(binary, 0o755);
    const originalPath = process.env.PATH;
    process.env.PATH = `${root}:${originalPath ?? ""}`;
    try {
      const cmd = adapter.buildTuiCommand(
        "opus",
        "high",
        undefined,
        true,
        true,
        cwd
      );
      expect(cmd).toContain("--setting-sources");
      expect(cmd).toContain("--strict-mcp-config");
      expect(cmd).toContain("--mcp-config");
      expect(cmd).not.toContain("--safe-mode");
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("mapAutonomy returns correct flags", () => {
    expect(adapter.mapAutonomy("read-only")).toEqual(["--permission-mode", "plan"]);
    expect(adapter.mapAutonomy("low")).toEqual(["--permission-mode", "manual"]);
    expect(adapter.mapAutonomy("medium")).toEqual(["--permission-mode", "acceptEdits"]);
    expect(adapter.mapAutonomy("high")).toEqual(["--dangerously-skip-permissions"]);
  });
});

describe("DroidAdapter", () => {
  const adapter = new DroidAdapter();

  test("has correct id and binary name", () => {
    expect(adapter.id).toBe("droid");
    expect(adapter.binaryName).toBe("droid");
  });

  test("capabilities are correct", () => {
    const caps = adapter.capabilities();
    expect(caps.supportsNonInteractive).toBe(true);
    expect(caps.supportsInteractive).toBe(true);
    expect(caps.supportsModel).toBe(true);
    expect(caps.supportsAutonomy).toBe(true);
    expect(caps.autonomyLevels).toEqual(["read-only", "low", "medium", "high"]);
    expect(caps.supportsEffort).toBe(true);
    expect(caps.effortLevels).toEqual(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);
  });

  test("buildRunCommand with prompt only", () => {
    const request: RunRequest = { agent: "droid", prompt: "test prompt" };
    const cmd = adapter.buildRunCommand(request);
    expect(cmd).toEqual(["droid", "exec"]);
  });

  test("buildRunCommand with model", () => {
    const request: RunRequest = { agent: "droid", prompt: "test", model: "gpt-5.1" };
    const cmd = adapter.buildRunCommand(request);
    expect(cmd).toEqual(["droid", "exec", "-m", "gpt-5.1"]);
  });

  test("buildRunCommand with autonomy levels", () => {
    expect(adapter.buildRunCommand({ agent: "droid", prompt: "t", autonomy: "read-only" }))
      .toEqual(["droid", "exec"]);
    expect(adapter.buildRunCommand({ agent: "droid", prompt: "t", autonomy: "low" }))
      .toEqual(["droid", "exec", "--auto", "low"]);
    expect(adapter.buildRunCommand({ agent: "droid", prompt: "t", autonomy: "medium" }))
      .toEqual(["droid", "exec", "--auto", "medium"]);
    expect(adapter.buildRunCommand({ agent: "droid", prompt: "t", autonomy: "high" }))
      .toEqual(["droid", "exec", "--auto", "high"]);
  });

  test("buildRunCommand with effort levels", () => {
    expect(adapter.buildRunCommand({ agent: "droid", prompt: "t", effort: "none" }))
      .toEqual(["droid", "exec", "--reasoning-effort", "off"]);
    expect(adapter.buildRunCommand({ agent: "droid", prompt: "t", effort: "low" }))
      .toEqual(["droid", "exec", "--reasoning-effort", "low"]);
    expect(adapter.buildRunCommand({ agent: "droid", prompt: "t", effort: "medium" }))
      .toEqual(["droid", "exec", "--reasoning-effort", "medium"]);
    expect(adapter.buildRunCommand({ agent: "droid", prompt: "t", effort: "high" }))
      .toEqual(["droid", "exec", "--reasoning-effort", "high"]);
  });

  test("uses the model-specific no-reasoning value", () => {
    expect(adapter.buildRunCommand({
      agent: "droid",
      prompt: "t",
      model: "gpt-5.6-sol",
      effort: "none",
    })).toContain("none");
    expect(adapter.buildRunCommand({
      agent: "droid",
      prompt: "t",
      model: "claude-opus-5",
      effort: "none",
    })).toContain("off");
  });

  test("buildRunCommand with all options", () => {
    const request: RunRequest = {
      agent: "droid",
      prompt: "test",
      model: "gpt-5.1",
      autonomy: "medium",
      effort: "high",
    };
    const cmd = adapter.buildRunCommand(request);
    expect(cmd).toEqual(["droid", "exec", "-m", "gpt-5.1", "--auto", "medium", "--reasoning-effort", "high"]);
  });

  test("getStdinInput returns prompt", () => {
    const request: RunRequest = { agent: "droid", prompt: "my prompt" };
    expect(adapter.getStdinInput(request)).toBe("my prompt");
  });

  test("buildTuiCommand basic", () => {
    expect(adapter.buildTuiCommand()).toEqual(["droid"]);
  });

  test("buildTuiCommand with model", () => {
    expect(adapter.buildTuiCommand("gpt-5.1")).toEqual(["droid"]);
  });

  test("buildTuiCommand with autonomy", () => {
    expect(adapter.buildTuiCommand(undefined, "high")).toEqual(["droid", "--auto", "high"]);
    expect(adapter.buildTuiCommand("gpt-5.1", "low")).toEqual(["droid", "--auto", "low"]);
  });

  test("buildTuiCommand with effort", () => {
    expect(adapter.buildTuiCommand(undefined, undefined, "high")).toEqual(["droid"]);
    expect(adapter.buildTuiCommand("gpt-5.1", undefined, "medium")).toEqual(["droid"]);
  });

  test("TUI rejects unsupported model and effort flags", () => {
    expect(adapter.supportsTuiModel()).toBe(false);
    expect(adapter.supportsTuiEffort()).toBe(false);
  });

  test("mapAutonomy returns correct flags", () => {
    expect(adapter.mapAutonomy("read-only")).toEqual([]);
    expect(adapter.mapAutonomy("low")).toEqual(["--auto", "low"]);
    expect(adapter.mapAutonomy("medium")).toEqual(["--auto", "medium"]);
    expect(adapter.mapAutonomy("high")).toEqual(["--auto", "high"]);
  });

  test("mapEffort returns correct flags", () => {
    expect(adapter.mapEffort("none")).toEqual(["--reasoning-effort", "off"]);
    expect(adapter.mapEffort("low")).toEqual(["--reasoning-effort", "low"]);
    expect(adapter.mapEffort("medium")).toEqual(["--reasoning-effort", "medium"]);
    expect(adapter.mapEffort("high")).toEqual(["--reasoning-effort", "high"]);
  });
});

describe("CodexAdapter", () => {
  const adapter = new CodexAdapter();

  test("has correct id and binary name", () => {
    expect(adapter.id).toBe("codex");
    expect(adapter.binaryName).toBe("codex");
  });

  test("capabilities are correct", () => {
    const caps = adapter.capabilities();
    expect(caps.supportsNonInteractive).toBe(true);
    expect(caps.supportsInteractive).toBe(true);
    expect(caps.supportsModel).toBe(true);
    expect(caps.supportsAutonomy).toBe(true);
    expect(caps.autonomyLevels).toEqual(["read-only", "low", "medium", "high"]);
    expect(caps.supportsEffort).toBe(true);
    expect(caps.effortLevels).toEqual(["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);
  });

  test("buildRunCommand with prompt only", () => {
    const request: RunRequest = { agent: "codex", prompt: "test prompt" };
    const cmd = adapter.buildRunCommand(request);
    expect(cmd).toEqual(["codex", "exec", "--skip-git-repo-check", "--ephemeral", "--ignore-rules", "-"]);
  });

  test("buildRunCommand with model", () => {
    const request: RunRequest = { agent: "codex", prompt: "test", model: "gpt-5.1" };
    const cmd = adapter.buildRunCommand(request);
    expect(cmd).toEqual(["codex", "-m", "gpt-5.1", "exec", "--skip-git-repo-check", "--ephemeral", "--ignore-rules", "-"]);
  });

  test("buildRunCommand with autonomy levels", () => {
    expect(adapter.buildRunCommand({ agent: "codex", prompt: "t", autonomy: "read-only" }))
      .toEqual(["codex", "-s", "read-only", "-a", "never", "exec", "--skip-git-repo-check", "--ephemeral", "--ignore-rules", "-"]);
    expect(adapter.buildRunCommand({ agent: "codex", prompt: "t", autonomy: "low" }))
      .toEqual(["codex", "-s", "workspace-write", "-a", "untrusted", "exec", "--skip-git-repo-check", "--ephemeral", "--ignore-rules", "-"]);
    expect(adapter.buildRunCommand({ agent: "codex", prompt: "t", autonomy: "medium" }))
      .toEqual(["codex", "-s", "workspace-write", "-a", "never", "exec", "--skip-git-repo-check", "--ephemeral", "--ignore-rules", "-"]);
    expect(adapter.buildRunCommand({ agent: "codex", prompt: "t", autonomy: "high" }))
      .toEqual(["codex", "-s", "danger-full-access", "-a", "never", "exec", "--skip-git-repo-check", "--ephemeral", "--ignore-rules", "-"]);
  });

  test("buildRunCommand with effort levels", () => {
    expect(adapter.buildRunCommand({ agent: "codex", prompt: "t", effort: "low" }))
      .toEqual(["codex", "-c", 'model_reasoning_effort="low"', "exec", "--skip-git-repo-check", "--ephemeral", "--ignore-rules", "-"]);
    expect(adapter.buildRunCommand({ agent: "codex", prompt: "t", effort: "medium" }))
      .toEqual(["codex", "-c", 'model_reasoning_effort="medium"', "exec", "--skip-git-repo-check", "--ephemeral", "--ignore-rules", "-"]);
    expect(adapter.buildRunCommand({ agent: "codex", prompt: "t", effort: "high" }))
      .toEqual(["codex", "-c", 'model_reasoning_effort="high"', "exec", "--skip-git-repo-check", "--ephemeral", "--ignore-rules", "-"]);
  });

  test("buildRunCommand with external sandbox bypasses codex sandbox flags", () => {
    const cmd = adapter.buildRunCommand({
      agent: "codex",
      prompt: "t",
      autonomy: "high",
      sandboxed: true,
    });
    expect(cmd).toEqual([
      "codex",
      "--dangerously-bypass-approvals-and-sandbox",
      "exec",
      "--skip-git-repo-check",
      "--ephemeral",
      "--ignore-rules",
      "-",
    ]);
  });

  test("getStdinInput returns prompt", () => {
    const request: RunRequest = { agent: "codex", prompt: "my prompt" };
    expect(adapter.getStdinInput(request)).toBe("my prompt");
  });

  test("buildTuiCommand basic", () => {
    expect(adapter.buildTuiCommand()).toEqual(["codex"]);
  });

  test("buildTuiCommand with model", () => {
    expect(adapter.buildTuiCommand("gpt-5.1")).toEqual(["codex", "-m", "gpt-5.1"]);
  });

  test("buildTuiCommand with autonomy", () => {
    expect(adapter.buildTuiCommand(undefined, "high")).toEqual(["codex", "-s", "danger-full-access", "-a", "never"]);
  });

  test("buildTuiCommand with effort", () => {
    expect(adapter.buildTuiCommand(undefined, undefined, "low")).toEqual(["codex", "-c", 'model_reasoning_effort="low"']);
    expect(adapter.buildTuiCommand("gpt-5.1", undefined, "high")).toEqual(["codex", "-m", "gpt-5.1", "-c", 'model_reasoning_effort="high"']);
  });

  test("buildTuiCommand with external sandbox bypasses codex sandbox flags", () => {
    const cmd = adapter.buildTuiCommand("gpt-5.1", "high", "low", true);
    expect(cmd).toEqual([
      "codex",
      "-m",
      "gpt-5.1",
      "--dangerously-bypass-approvals-and-sandbox",
      "-c",
      'model_reasoning_effort="low"',
    ]);
  });

  test("mapAutonomy returns correct flags", () => {
    expect(adapter.mapAutonomy("read-only")).toEqual(["-s", "read-only", "-a", "never"]);
    expect(adapter.mapAutonomy("low")).toEqual(["-s", "workspace-write", "-a", "untrusted"]);
    expect(adapter.mapAutonomy("medium")).toEqual(["-s", "workspace-write", "-a", "never"]);
    expect(adapter.mapAutonomy("high")).toEqual(["-s", "danger-full-access", "-a", "never"]);
  });

  test("mapEffort returns correct flags", () => {
    expect(adapter.mapEffort("low")).toEqual(["-c", 'model_reasoning_effort="low"']);
    expect(adapter.mapEffort("medium")).toEqual(["-c", 'model_reasoning_effort="medium"']);
    expect(adapter.mapEffort("high")).toEqual(["-c", 'model_reasoning_effort="high"']);
  });
});

describe("GooseAdapter", () => {
  const adapter = new GooseAdapter();

  test("has correct id and binary name", () => {
    expect(adapter.id).toBe("goose");
    expect(adapter.binaryName).toBe("goose");
  });

  test("capabilities are correct", () => {
    const caps = adapter.capabilities();
    expect(caps.supportsNonInteractive).toBe(true);
    expect(caps.supportsInteractive).toBe(true);
    expect(caps.supportsModel).toBe(true);
    expect(caps.supportsAutonomy).toBe(true);
    expect(caps.autonomyLevels).toEqual(["read-only", "low", "medium", "high"]);
    expect(caps.supportsEffort).toBe(false);
    expect(caps.effortLevels).toEqual([]);
  });

  test("buildRunCommand", () => {
    const request: RunRequest = { agent: "goose", prompt: "test prompt" };
    const cmd = adapter.buildRunCommand(request);
    expect(cmd).toEqual(["goose", "run", "-t", "test prompt"]);
  });

  test("buildRunCommand with autonomy", () => {
    expect(adapter.buildRunCommand({ agent: "goose", prompt: "t", autonomy: "read-only" }))
      .toEqual(["goose", "run", "-t", "t"]);
    expect(adapter.buildRunCommand({ agent: "goose", prompt: "t", autonomy: "low" }))
      .toEqual(["goose", "run", "-t", "t"]);
    expect(adapter.buildRunCommand({ agent: "goose", prompt: "t", autonomy: "medium" }))
      .toEqual(["goose", "run", "-t", "t"]);
    expect(adapter.buildRunCommand({ agent: "goose", prompt: "t", autonomy: "high" }))
      .toEqual(["goose", "run", "-t", "t"]);
  });

  test("buildTuiCommand", () => {
    expect(adapter.buildTuiCommand()).toEqual(["goose"]);
    expect(adapter.buildTuiCommand(undefined, "high")).toEqual(["goose"]);
  });

  test("getRunEnv and getTuiEnv set goose mode from autonomy", () => {
    expect(adapter.getRunEnv({ agent: "goose", prompt: "t" })).toEqual({ GOOSE_MODE: "chat" });
    expect(adapter.getRunEnv({ agent: "goose", prompt: "t", autonomy: "medium" }))
      .toEqual({ GOOSE_MODE: "smart_approve" });
    expect(adapter.getTuiEnv(undefined, undefined)).toEqual({ GOOSE_MODE: "chat" });
    expect(adapter.getTuiEnv(undefined, "high")).toEqual({ GOOSE_MODE: "auto" });
    expect(adapter.getRunEnv({ agent: "goose", prompt: "t", model: "provider/model" }))
      .toEqual({ GOOSE_MODE: "chat", GOOSE_MODEL: "provider/model" });
  });

  test("mapAutonomy returns goose mode env", () => {
    expect(adapter.mapAutonomy("read-only")).toEqual([]);
    expect(adapter.mapAutonomy("low")).toEqual([]);
    expect(adapter.mapAutonomy("medium")).toEqual([]);
    expect(adapter.mapAutonomy("high")).toEqual([]);
  });
});

describe("GeminiAdapter", () => {
  const adapter = new GeminiAdapter();

  test("has correct id and binary name", () => {
    expect(adapter.id).toBe("gemini");
    expect(adapter.binaryName).toBe("gemini");
  });

  test("disables repository .env loading with authoritative settings", () => {
    expect(adapter.getEnv()).toEqual({
      GEMINI_CLI_SYSTEM_SETTINGS_PATH: GEMINI_SYSTEM_SETTINGS_PATH,
    });
  });

  test("capabilities are correct", () => {
    const caps = adapter.capabilities();
    expect(caps.supportsNonInteractive).toBe(true);
    expect(caps.supportsInteractive).toBe(true);
    expect(caps.supportsModel).toBe(true);
    expect(caps.supportsAutonomy).toBe(true);
    expect(caps.autonomyLevels).toEqual(["read-only", "low", "medium", "high"]);
    expect(caps.supportsEffort).toBe(false);
    expect(caps.effortLevels).toEqual([]);
  });

  test("buildRunCommand with model", () => {
    const request: RunRequest = { agent: "gemini", prompt: "test", model: "gemini-pro" };
    const cmd = adapter.buildRunCommand(request);
    expect(cmd).toEqual(["gemini", "--sandbox=false", "-m", "gemini-pro", "-p", "test"]);
  });

  test("buildRunCommand with autonomy levels", () => {
    expect(adapter.buildRunCommand({ agent: "gemini", prompt: "t", autonomy: "read-only" }))
      .toEqual(["gemini", "--sandbox=false", "--approval-mode", "plan", "-p", "t"]);
    expect(adapter.buildRunCommand({ agent: "gemini", prompt: "t", autonomy: "low" }))
      .toEqual(["gemini", "--sandbox=false", "--approval-mode", "default", "-p", "t"]);
    expect(adapter.buildRunCommand({ agent: "gemini", prompt: "t", autonomy: "medium" }))
      .toEqual(["gemini", "--sandbox=false", "--approval-mode", "auto_edit", "-p", "t"]);
    expect(adapter.buildRunCommand({ agent: "gemini", prompt: "t", autonomy: "high" }))
      .toEqual(["gemini", "--sandbox=false", "--approval-mode", "yolo", "-p", "t"]);
  });

  test("buildTuiCommand with model", () => {
    expect(adapter.buildTuiCommand("gemini-pro")).toEqual(["gemini", "--sandbox=false", "-m", "gemini-pro"]);
  });

  test("buildTuiCommand with autonomy", () => {
    expect(adapter.buildTuiCommand(undefined, "medium")).toEqual(["gemini", "--sandbox=false", "--approval-mode", "auto_edit"]);
  });

  test("mapAutonomy returns approval mode flags", () => {
    expect(adapter.mapAutonomy("read-only")).toEqual(["--approval-mode", "plan"]);
    expect(adapter.mapAutonomy("low")).toEqual(["--approval-mode", "default"]);
    expect(adapter.mapAutonomy("medium")).toEqual(["--approval-mode", "auto_edit"]);
    expect(adapter.mapAutonomy("high")).toEqual(["--approval-mode", "yolo"]);
  });

  test("requires an outer boundary for headless plan mode", () => {
    expect(adapter.requiresSandboxForAutonomy("read-only")).toBe(true);
    expect(adapter.requiresSandboxForAutonomy("low")).toBe(false);
    expect(adapter.requiresSandboxForAutonomy("medium")).toBe(false);
    expect(adapter.requiresSandboxForAutonomy("high")).toBe(false);
    expect(adapter.requiresSandboxForTuiAutonomy("read-only")).toBe(false);
  });
});
