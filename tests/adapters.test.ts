import { describe, test, expect } from "bun:test";
import { ClaudeAdapter } from "../src/adapters/claude.js";
import { CodexAdapter } from "../src/adapters/codex.js";
import { DroidAdapter } from "../src/adapters/droid.js";
import { GooseAdapter } from "../src/adapters/goose.js";
import { GeminiAdapter } from "../src/adapters/gemini.js";
import { OpencodeAdapter } from "../src/adapters/opencode.js";
import { QwenAdapter } from "../src/adapters/qwen.js";
import { ZaiAdapter } from "../src/adapters/zai.js";
import { getAdapter, getAllAdapters, AGENT_IDS } from "../src/adapters/index.js";
import type { RunRequest } from "../src/types.js";

describe("Adapter Registry", () => {
  test("AGENT_IDS contains all expected agents", () => {
    expect(AGENT_IDS).toContain("claude");
    expect(AGENT_IDS).toContain("codex");
    expect(AGENT_IDS).toContain("droid");
    expect(AGENT_IDS).toContain("goose");
    expect(AGENT_IDS).toContain("gemini");
    expect(AGENT_IDS).toContain("opencode");
    expect(AGENT_IDS).toContain("qwen");
    expect(AGENT_IDS).toContain("zai");
    expect(AGENT_IDS.length).toBe(8);
  });

  test("getAdapter returns correct adapter for each agent", () => {
    expect(getAdapter("claude")).toBeInstanceOf(ClaudeAdapter);
    expect(getAdapter("codex")).toBeInstanceOf(CodexAdapter);
    expect(getAdapter("droid")).toBeInstanceOf(DroidAdapter);
    expect(getAdapter("goose")).toBeInstanceOf(GooseAdapter);
    expect(getAdapter("gemini")).toBeInstanceOf(GeminiAdapter);
    expect(getAdapter("opencode")).toBeInstanceOf(OpencodeAdapter);
    expect(getAdapter("qwen")).toBeInstanceOf(QwenAdapter);
    expect(getAdapter("zai")).toBeInstanceOf(ZaiAdapter);
  });

  test("getAdapter throws for unknown agent", () => {
    expect(() => getAdapter("unknown" as any)).toThrow("Unknown agent: unknown");
  });

  test("getAllAdapters returns all 8 adapters", () => {
    const adapters = getAllAdapters();
    expect(adapters.length).toBe(8);
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
    expect(caps.supportsEffort).toBe(false);
    expect(caps.effortLevels).toEqual([]);
  });

  test("buildRunCommand with prompt only", () => {
    const request: RunRequest = { agent: "claude", prompt: "test prompt" };
    const cmd = adapter.buildRunCommand(request);
    expect(cmd).toEqual(["claude", "-p"]);
  });

  test("buildRunCommand with model", () => {
    const request: RunRequest = { agent: "claude", prompt: "test", model: "opus" };
    const cmd = adapter.buildRunCommand(request);
    expect(cmd).toEqual(["claude", "-p", "--model", "opus"]);
  });

  test("buildRunCommand with autonomy levels", () => {
    expect(adapter.buildRunCommand({ agent: "claude", prompt: "t", autonomy: "read-only" }))
      .toEqual(["claude", "-p"]);
    expect(adapter.buildRunCommand({ agent: "claude", prompt: "t", autonomy: "low" }))
      .toEqual(["claude", "-p", "--permission-mode", "acceptEdits"]);
    expect(adapter.buildRunCommand({ agent: "claude", prompt: "t", autonomy: "medium" }))
      .toEqual(["claude", "-p", "--permission-mode", "dontAsk"]);
    expect(adapter.buildRunCommand({ agent: "claude", prompt: "t", autonomy: "high" }))
      .toEqual(["claude", "-p", "--dangerously-skip-permissions"]);
  });

  test("getStdinInput returns prompt", () => {
    const request: RunRequest = { agent: "claude", prompt: "my prompt" };
    expect(adapter.getStdinInput(request)).toBe("my prompt");
  });

  test("buildTuiCommand basic", () => {
    expect(adapter.buildTuiCommand()).toEqual(["claude"]);
  });

  test("buildTuiCommand with model", () => {
    expect(adapter.buildTuiCommand("opus")).toEqual(["claude", "--model", "opus"]);
  });

  test("buildTuiCommand with autonomy", () => {
    expect(adapter.buildTuiCommand(undefined, "high")).toEqual(["claude", "--dangerously-skip-permissions"]);
    expect(adapter.buildTuiCommand("opus", "medium")).toEqual(["claude", "--model", "opus", "--permission-mode", "dontAsk"]);
  });

  test("mapAutonomy returns correct flags", () => {
    expect(adapter.mapAutonomy("read-only")).toEqual([]);
    expect(adapter.mapAutonomy("low")).toEqual(["--permission-mode", "acceptEdits"]);
    expect(adapter.mapAutonomy("medium")).toEqual(["--permission-mode", "dontAsk"]);
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
    expect(caps.effortLevels).toEqual(["none", "low", "medium", "high"]);
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
      .toEqual(["droid", "exec", "-r", "none"]);
    expect(adapter.buildRunCommand({ agent: "droid", prompt: "t", effort: "low" }))
      .toEqual(["droid", "exec", "-r", "low"]);
    expect(adapter.buildRunCommand({ agent: "droid", prompt: "t", effort: "medium" }))
      .toEqual(["droid", "exec", "-r", "medium"]);
    expect(adapter.buildRunCommand({ agent: "droid", prompt: "t", effort: "high" }))
      .toEqual(["droid", "exec", "-r", "high"]);
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
    expect(cmd).toEqual(["droid", "exec", "-m", "gpt-5.1", "--auto", "medium", "-r", "high"]);
  });

  test("getStdinInput returns prompt", () => {
    const request: RunRequest = { agent: "droid", prompt: "my prompt" };
    expect(adapter.getStdinInput(request)).toBe("my prompt");
  });

  test("buildTuiCommand basic", () => {
    expect(adapter.buildTuiCommand()).toEqual(["droid"]);
  });

  test("buildTuiCommand with model", () => {
    expect(adapter.buildTuiCommand("gpt-5.1")).toEqual(["droid", "-m", "gpt-5.1"]);
  });

  test("buildTuiCommand with effort", () => {
    expect(adapter.buildTuiCommand(undefined, undefined, "high")).toEqual(["droid", "-r", "high"]);
    expect(adapter.buildTuiCommand("gpt-5.1", undefined, "medium")).toEqual(["droid", "-m", "gpt-5.1", "-r", "medium"]);
  });

  test("mapAutonomy returns correct flags", () => {
    expect(adapter.mapAutonomy("read-only")).toEqual([]);
    expect(adapter.mapAutonomy("low")).toEqual(["--auto", "low"]);
    expect(adapter.mapAutonomy("medium")).toEqual(["--auto", "medium"]);
    expect(adapter.mapAutonomy("high")).toEqual(["--auto", "high"]);
  });

  test("mapEffort returns correct flags", () => {
    expect(adapter.mapEffort("none")).toEqual(["-r", "none"]);
    expect(adapter.mapEffort("low")).toEqual(["-r", "low"]);
    expect(adapter.mapEffort("medium")).toEqual(["-r", "medium"]);
    expect(adapter.mapEffort("high")).toEqual(["-r", "high"]);
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
    expect(caps.autonomyLevels).toEqual(["read-only", "medium", "high"]);
    expect(caps.supportsEffort).toBe(true);
    expect(caps.effortLevels).toEqual(["low", "medium", "high"]);
  });

  test("buildRunCommand with prompt only", () => {
    const request: RunRequest = { agent: "codex", prompt: "test prompt" };
    const cmd = adapter.buildRunCommand(request);
    expect(cmd).toEqual(["codex", "exec", "--skip-git-repo-check", "-"]);
  });

  test("buildRunCommand with model", () => {
    const request: RunRequest = { agent: "codex", prompt: "test", model: "gpt-5.1" };
    const cmd = adapter.buildRunCommand(request);
    expect(cmd).toEqual(["codex", "exec", "--skip-git-repo-check", "-m", "gpt-5.1", "-"]);
  });

  test("buildRunCommand with autonomy levels", () => {
    expect(adapter.buildRunCommand({ agent: "codex", prompt: "t", autonomy: "read-only" }))
      .toEqual(["codex", "exec", "--skip-git-repo-check", "-s", "read-only", "-"]);
    expect(adapter.buildRunCommand({ agent: "codex", prompt: "t", autonomy: "medium" }))
      .toEqual(["codex", "exec", "--skip-git-repo-check", "-s", "workspace-write", "-"]);
    expect(adapter.buildRunCommand({ agent: "codex", prompt: "t", autonomy: "high" }))
      .toEqual(["codex", "exec", "--skip-git-repo-check", "-s", "danger-full-access", "-"]);
  });

  test("buildRunCommand with effort levels", () => {
    expect(adapter.buildRunCommand({ agent: "codex", prompt: "t", effort: "low" }))
      .toEqual(["codex", "exec", "--skip-git-repo-check", "-c", 'model_reasoning_effort="low"', "-"]);
    expect(adapter.buildRunCommand({ agent: "codex", prompt: "t", effort: "medium" }))
      .toEqual(["codex", "exec", "--skip-git-repo-check", "-c", 'model_reasoning_effort="medium"', "-"]);
    expect(adapter.buildRunCommand({ agent: "codex", prompt: "t", effort: "high" }))
      .toEqual(["codex", "exec", "--skip-git-repo-check", "-c", 'model_reasoning_effort="high"', "-"]);
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
    expect(adapter.buildTuiCommand(undefined, "high")).toEqual(["codex", "-s", "danger-full-access"]);
  });

  test("buildTuiCommand with effort", () => {
    expect(adapter.buildTuiCommand(undefined, undefined, "low")).toEqual(["codex", "-c", 'model_reasoning_effort="low"']);
    expect(adapter.buildTuiCommand("gpt-5.1", undefined, "high")).toEqual(["codex", "-m", "gpt-5.1", "-c", 'model_reasoning_effort="high"']);
  });

  test("mapAutonomy returns correct flags", () => {
    expect(adapter.mapAutonomy("read-only")).toEqual(["-s", "read-only"]);
    expect(adapter.mapAutonomy("medium")).toEqual(["-s", "workspace-write"]);
    expect(adapter.mapAutonomy("high")).toEqual(["-s", "danger-full-access"]);
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
    expect(caps.supportsModel).toBe(false);
    expect(caps.supportsAutonomy).toBe(false);
    expect(caps.autonomyLevels).toEqual([]);
    expect(caps.supportsEffort).toBe(false);
    expect(caps.effortLevels).toEqual([]);
  });

  test("buildRunCommand", () => {
    const request: RunRequest = { agent: "goose", prompt: "test prompt" };
    const cmd = adapter.buildRunCommand(request);
    expect(cmd).toEqual(["goose", "run", "-t", "test prompt"]);
  });

  test("buildTuiCommand", () => {
    expect(adapter.buildTuiCommand()).toEqual(["goose"]);
  });
});

describe("GeminiAdapter", () => {
  const adapter = new GeminiAdapter();

  test("has correct id and binary name", () => {
    expect(adapter.id).toBe("gemini");
    expect(adapter.binaryName).toBe("gemini");
  });

  test("capabilities are correct", () => {
    const caps = adapter.capabilities();
    expect(caps.supportsNonInteractive).toBe(true);
    expect(caps.supportsInteractive).toBe(true);
    expect(caps.supportsModel).toBe(true);
    expect(caps.supportsAutonomy).toBe(false);
    expect(caps.autonomyLevels).toEqual([]);
    expect(caps.supportsEffort).toBe(false);
    expect(caps.effortLevels).toEqual([]);
  });

  test("buildRunCommand with model", () => {
    const request: RunRequest = { agent: "gemini", prompt: "test", model: "gemini-pro" };
    const cmd = adapter.buildRunCommand(request);
    expect(cmd).toEqual(["gemini", "-p", "-m", "gemini-pro", "test"]);
  });

  test("buildTuiCommand with model", () => {
    expect(adapter.buildTuiCommand("gemini-pro")).toEqual(["gemini", "-m", "gemini-pro"]);
  });
});

describe("OpencodeAdapter", () => {
  const adapter = new OpencodeAdapter();

  test("has correct id and binary name", () => {
    expect(adapter.id).toBe("opencode");
    expect(adapter.binaryName).toBe("opencode");
  });

  test("capabilities are correct", () => {
    const caps = adapter.capabilities();
    expect(caps.supportsNonInteractive).toBe(true);
    expect(caps.supportsInteractive).toBe(true);
    expect(caps.supportsModel).toBe(true);
    expect(caps.supportsAutonomy).toBe(true);
    expect(caps.autonomyLevels).toEqual(["read-only", "high"]);
    expect(caps.supportsEffort).toBe(false);
    expect(caps.effortLevels).toEqual([]);
  });

  test("buildRunCommand uses stdin placeholder", () => {
    const request: RunRequest = { agent: "opencode", prompt: "test" };
    const cmd = adapter.buildRunCommand(request);
    expect(cmd).toEqual(["opencode", "run", "-"]);
  });

  test("buildRunCommand with model", () => {
    const request: RunRequest = { agent: "opencode", prompt: "test", model: "gpt-4" };
    const cmd = adapter.buildRunCommand(request);
    expect(cmd).toEqual(["opencode", "run", "--model", "gpt-4", "-"]);
  });

  test("buildRunCommand with autonomy", () => {
    expect(adapter.buildRunCommand({ agent: "opencode", prompt: "t", autonomy: "read-only" }))
      .toEqual(["opencode", "run", "--agent", "explore", "-"]);
    expect(adapter.buildRunCommand({ agent: "opencode", prompt: "t", autonomy: "high" }))
      .toEqual(["opencode", "run", "--agent", "build", "-"]);
  });

  test("getStdinInput returns prompt", () => {
    const request: RunRequest = { agent: "opencode", prompt: "my prompt" };
    expect(adapter.getStdinInput(request)).toBe("my prompt");
  });

  test("mapAutonomy returns correct flags", () => {
    expect(adapter.mapAutonomy("read-only")).toEqual(["--agent", "explore"]);
    expect(adapter.mapAutonomy("high")).toEqual(["--agent", "build"]);
    expect(adapter.mapAutonomy("medium")).toEqual([]);
  });

  test("buildTuiCommand with model", () => {
    expect(adapter.buildTuiCommand("gpt-4")).toEqual(["opencode", "--model", "gpt-4"]);
  });

  test("buildTuiCommand with autonomy", () => {
    expect(adapter.buildTuiCommand(undefined, "high")).toEqual(["opencode", "--agent", "build"]);
  });
});

describe("QwenAdapter", () => {
  const adapter = new QwenAdapter();

  test("has correct id and binary name", () => {
    expect(adapter.id).toBe("qwen");
    expect(adapter.binaryName).toBe("qwen-coder");
  });

  test("capabilities are correct", () => {
    const caps = adapter.capabilities();
    expect(caps.supportsNonInteractive).toBe(true);
    expect(caps.supportsInteractive).toBe(true);
    expect(caps.supportsModel).toBe(false);
    expect(caps.supportsAutonomy).toBe(false);
    expect(caps.autonomyLevels).toEqual([]);
    expect(caps.supportsEffort).toBe(false);
    expect(caps.effortLevels).toEqual([]);
  });

  test("buildRunCommand", () => {
    const request: RunRequest = { agent: "qwen", prompt: "test prompt" };
    const cmd = adapter.buildRunCommand(request);
    expect(cmd).toEqual(["qwen-coder", "test prompt"]);
  });

  test("buildTuiCommand", () => {
    expect(adapter.buildTuiCommand()).toEqual(["qwen-coder"]);
  });
});

describe("ZaiAdapter", () => {
  const adapter = new ZaiAdapter();

  test("has correct id and binary name", () => {
    expect(adapter.id).toBe("zai");
    expect(adapter.binaryName).toBe("claude");
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

  test("buildRunCommand defaults to opus model", () => {
    const request: RunRequest = { agent: "zai", prompt: "test" };
    const cmd = adapter.buildRunCommand(request);
    expect(cmd).toEqual(["claude", "-p", "--model", "opus"]);
  });

  test("buildRunCommand with explicit model", () => {
    const request: RunRequest = { agent: "zai", prompt: "test", model: "sonnet" };
    const cmd = adapter.buildRunCommand(request);
    expect(cmd).toEqual(["claude", "-p", "--model", "sonnet"]);
  });

  test("buildRunCommand with autonomy levels", () => {
    expect(adapter.buildRunCommand({ agent: "zai", prompt: "t", autonomy: "read-only" }))
      .toEqual(["claude", "-p", "--model", "opus"]);
    expect(adapter.buildRunCommand({ agent: "zai", prompt: "t", autonomy: "low" }))
      .toEqual(["claude", "-p", "--model", "opus", "--permission-mode", "acceptEdits"]);
    expect(adapter.buildRunCommand({ agent: "zai", prompt: "t", autonomy: "medium" }))
      .toEqual(["claude", "-p", "--model", "opus", "--permission-mode", "dontAsk"]);
    expect(adapter.buildRunCommand({ agent: "zai", prompt: "t", autonomy: "high" }))
      .toEqual(["claude", "-p", "--model", "opus", "--dangerously-skip-permissions"]);
  });

  test("getStdinInput returns prompt", () => {
    const request: RunRequest = { agent: "zai", prompt: "my prompt" };
    expect(adapter.getStdinInput(request)).toBe("my prompt");
  });

  test("buildTuiCommand defaults to opus", () => {
    expect(adapter.buildTuiCommand()).toEqual(["claude", "--model", "opus"]);
  });

  test("buildTuiCommand with model and autonomy", () => {
    expect(adapter.buildTuiCommand("sonnet", "high")).toEqual(["claude", "--model", "sonnet", "--dangerously-skip-permissions"]);
  });

  test("mapAutonomy matches claude adapter", () => {
    expect(adapter.mapAutonomy("read-only")).toEqual([]);
    expect(adapter.mapAutonomy("low")).toEqual(["--permission-mode", "acceptEdits"]);
    expect(adapter.mapAutonomy("medium")).toEqual(["--permission-mode", "dontAsk"]);
    expect(adapter.mapAutonomy("high")).toEqual(["--dangerously-skip-permissions"]);
  });

  test("getEnv sets anthropic proxy vars", () => {
    const origKey = process.env.ZAI_API_KEY;
    process.env.ZAI_API_KEY = "test-key-123";
    try {
      const env = adapter.getEnv();
      expect(env.ANTHROPIC_AUTH_TOKEN).toBe("test-key-123");
      expect(env.ANTHROPIC_BASE_URL).toBe("https://api.z.ai/api/anthropic");
      expect(env.API_TIMEOUT_MS).toBeDefined();
    } finally {
      if (origKey !== undefined) {
        process.env.ZAI_API_KEY = origKey;
      } else {
        delete process.env.ZAI_API_KEY;
      }
    }
  });
});
