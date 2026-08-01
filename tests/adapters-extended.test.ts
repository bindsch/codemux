import { describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpencodeAdapter } from "../src/adapters/opencode.js";
import { PiAdapter } from "../src/adapters/pi.js";
import { QwenAdapter } from "../src/adapters/qwen.js";
import { ZaiAdapter } from "../src/adapters/zai.js";
import type { RunRequest } from "../src/types.js";

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
    expect(caps.autonomyLevels).toEqual(["read-only", "low", "medium", "high"]);
    expect(caps.supportsEffort).toBe(true);
    expect(caps.effortLevels).toEqual(["low", "medium", "high"]);
    expect(adapter.supportsTuiEffort()).toBe(false);
  });

  test("buildRunCommand reads only from stdin", () => {
    const request: RunRequest = { agent: "opencode", prompt: "test" };
    const cmd = adapter.buildRunCommand(request);
    expect(cmd).toEqual(["opencode", "--pure", "run"]);
  });

  test("buildRunCommand with model", () => {
    const request: RunRequest = { agent: "opencode", prompt: "test", model: "gpt-4" };
    const cmd = adapter.buildRunCommand(request);
    expect(cmd).toEqual(["opencode", "--pure", "run", "--model", "gpt-4"]);
  });

  test("buildRunCommand with autonomy", () => {
    expect(adapter.buildRunCommand({ agent: "opencode", prompt: "t", autonomy: "read-only" }))
      .toEqual(["opencode", "--pure", "run", "--agent", "plan"]);
    expect(adapter.buildRunCommand({ agent: "opencode", prompt: "t", autonomy: "low" }))
      .toEqual(["opencode", "--pure", "run", "--agent", "build"]);
    expect(adapter.buildRunCommand({ agent: "opencode", prompt: "t", autonomy: "medium" }))
      .toEqual(["opencode", "--pure", "run", "--agent", "build"]);
    expect(adapter.buildRunCommand({ agent: "opencode", prompt: "t", autonomy: "high" }))
      .toEqual(["opencode", "--pure", "run", "--agent", "build", "--auto"]);
  });

  test("getStdinInput returns prompt", () => {
    const request: RunRequest = { agent: "opencode", prompt: "my prompt" };
    expect(adapter.getStdinInput(request)).toBe("my prompt");
  });

  test("mapAutonomy returns correct flags", () => {
    expect(adapter.mapAutonomy("read-only")).toEqual(["--agent", "plan"]);
    expect(adapter.mapAutonomy("low")).toEqual(["--agent", "build"]);
    expect(adapter.mapAutonomy("medium")).toEqual(["--agent", "build"]);
    expect(adapter.mapAutonomy("high")).toEqual(["--agent", "build", "--auto"]);
  });

  test("buildTuiCommand with model", () => {
    expect(adapter.buildTuiCommand("gpt-4")).toEqual(["opencode", "--pure", "--model", "gpt-4"]);
  });

  test("buildTuiCommand with autonomy", () => {
    expect(adapter.buildTuiCommand(undefined, "high")).toEqual(["opencode", "--pure", "--agent", "build", "--auto"]);
  });

  test("requires an outer boundary for plan-equivalent levels", () => {
    expect(adapter.requiresSandboxForAutonomy("read-only")).toBe(true);
    expect(adapter.requiresSandboxForAutonomy("low")).toBe(false);
    expect(adapter.requiresSandboxForAutonomy("medium")).toBe(false);
    expect(adapter.requiresSandboxForAutonomy("high")).toBe(false);
  });

  test("rejects project config and executable extension directories", () => {
    const repo = mkdtempSync(join(tmpdir(), "codemux-opencode-project-"));
    const nested = join(repo, "nested");
    mkdirSync(join(repo, ".git"));
    mkdirSync(nested);
    try {
      writeFileSync(join(repo, "opencode.json"), "{}");
      expect(() => adapter.validateRunRequest({
        agent: "opencode",
        prompt: "test",
        cwd: nested,
      })).toThrow("repository executable configuration");
      rmSync(join(repo, "opencode.json"));

      const packageManifest = join(repo, ".opencode", "package.json");
      mkdirSync(join(repo, ".opencode"), { recursive: true });
      writeFileSync(packageManifest, JSON.stringify({
        scripts: { postinstall: "touch unsafe" },
      }));
      expect(() => adapter.validateRunRequest({
        agent: "opencode",
        prompt: "test",
        cwd: nested,
      })).toThrow("repository executable configuration");
      rmSync(packageManifest);

      const tools = join(repo, ".opencode", "tools");
      mkdirSync(tools, { recursive: true });
      writeFileSync(join(tools, "unsafe.ts"), "export default {}");
      expect(() => adapter.validateTuiRequest(undefined, nested))
        .toThrow("repository executable configuration");

      rmSync(tools, { recursive: true });
      const agents = join(repo, ".opencode", "agents");
      mkdirSync(agents, { recursive: true });
      writeFileSync(join(agents, "plan.md"), "---\npermission: allow\n---");
      expect(() => adapter.validateRunRequest({
        agent: "opencode",
        prompt: "test",
        cwd: nested,
      })).toThrow("repository executable configuration");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe("PiAdapter", () => {
  const adapter = new PiAdapter();

  test("has correct id and binary name", () => {
    expect(adapter.id).toBe("pi");
    expect(adapter.binaryName).toBe("pi");
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
    const request: RunRequest = { agent: "pi", prompt: "test prompt" };
    const cmd = adapter.buildRunCommand(request);
    expect(cmd).toEqual(["pi", "--print", "--no-session", "--no-approve"]);
  });

  test("buildRunCommand with model", () => {
    const request: RunRequest = { agent: "pi", prompt: "test", model: "pi-pro" };
    const cmd = adapter.buildRunCommand(request);
    expect(cmd).toEqual(["pi", "--print", "--no-session", "--no-approve", "--model", "pi-pro"]);
  });

  test("buildRunCommand with autonomy levels", () => {
    expect(adapter.buildRunCommand({ agent: "pi", prompt: "t", autonomy: "read-only" }))
      .toEqual(["pi", "--print", "--no-session", "--no-approve", "--no-extensions", "--tools", "read,grep,find,ls"]);
    expect(adapter.buildRunCommand({ agent: "pi", prompt: "t", autonomy: "low" }))
      .toEqual(["pi", "--print", "--no-session", "--no-approve", "--no-extensions", "--tools", "read,grep,find,ls,edit,write"]);
    expect(adapter.buildRunCommand({ agent: "pi", prompt: "t", autonomy: "medium" }))
      .toEqual(["pi", "--print", "--no-session", "--no-approve"]);
    expect(adapter.buildRunCommand({ agent: "pi", prompt: "t", autonomy: "high" }))
      .toEqual(["pi", "--print", "--no-session", "--no-approve"]);
  });

  test("getStdinInput returns prompt", () => {
    const request: RunRequest = { agent: "pi", prompt: "my prompt" };
    expect(adapter.getStdinInput(request)).toBe("my prompt");
  });

  test("buildTuiCommand basic", () => {
    expect(adapter.buildTuiCommand()).toEqual(["pi", "--no-approve"]);
  });

  test("buildTuiCommand with model", () => {
    expect(adapter.buildTuiCommand("pi-pro")).toEqual(["pi", "--no-approve", "--model", "pi-pro"]);
  });

  test("buildTuiCommand with autonomy", () => {
    expect(adapter.buildTuiCommand(undefined, "read-only")).toEqual(["pi", "--no-approve", "--no-extensions", "--tools", "read,grep,find,ls"]);
    expect(adapter.buildTuiCommand("pi-pro", "high")).toEqual(["pi", "--no-approve", "--model", "pi-pro"]);
  });

  test("mapAutonomy returns correct flags", () => {
    expect(adapter.mapAutonomy("read-only")).toEqual(["--no-extensions", "--tools", "read,grep,find,ls"]);
    expect(adapter.mapAutonomy("low")).toEqual(["--no-extensions", "--tools", "read,grep,find,ls,edit,write"]);
    expect(adapter.mapAutonomy("medium")).toEqual([]);
    expect(adapter.mapAutonomy("high")).toEqual([]);
  });

  test("maps normalized effort to Pi thinking levels", () => {
    expect(adapter.mapEffort("none")).toEqual(["--thinking", "off"]);
    expect(adapter.buildRunCommand({ agent: "pi", prompt: "t", effort: "high" }))
      .toEqual(["pi", "--print", "--no-session", "--no-approve", "--thinking", "high"]);
  });
});

describe("QwenAdapter", () => {
  const adapter = new QwenAdapter((name) => name === "qwen" ? "/fake/qwen" : null);

  test("has correct id and binary name", () => {
    expect(adapter.id).toBe("qwen");
    expect(adapter.binaryName).toBe("qwen");
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

  test("buildRunCommand with prompt", () => {
    const cmd = adapter.buildRunCommand({ agent: "qwen", prompt: "test prompt" });
    expect(cmd).toEqual(["/fake/qwen", "--safe-mode"]);
    expect(adapter.getStdinInput({ agent: "qwen", prompt: "test prompt" })).toBe("test prompt");
  });

  test("buildRunCommand with model and autonomy", () => {
    const cmd = adapter.buildRunCommand({
      agent: "qwen",
      prompt: "test prompt",
      model: "qwen3-coder-plus",
      autonomy: "medium",
    });
    expect(cmd).toEqual([
      "/fake/qwen",
      "--safe-mode",
      "--model",
      "qwen3-coder-plus",
      "--approval-mode",
      "auto",
    ]);
  });

  test("buildTuiCommand", () => {
    expect(adapter.buildTuiCommand()).toEqual(["/fake/qwen", "--safe-mode"]);
    expect(adapter.buildTuiCommand("qwen3-coder-plus", "high")).toEqual([
      "/fake/qwen",
      "--safe-mode",
      "--model",
      "qwen3-coder-plus",
      "--approval-mode",
      "yolo",
    ]);
  });

  test("falls back to qwen-coder when qwen is unavailable", () => {
    const fallback = new QwenAdapter((name) => name === "qwen-coder" ? "/fake/qwen-coder" : null);
    expect(fallback.isAvailable()).toBe(true);
    expect(fallback.binaryName).toBe("qwen-coder");
    expect(fallback.capabilities().supportsModel).toBe(false);
    expect(() => fallback.buildRunCommand({
      agent: "qwen",
      prompt: "legacy prompt",
      autonomy: "read-only",
    })).toThrow("cannot enforce autonomy levels");
    expect(fallback.buildRunCommand({
      agent: "qwen",
      prompt: "legacy prompt",
      autonomy: "read-only",
      sandboxed: true,
    })).toEqual(["/fake/qwen-coder", "--", "legacy prompt"]);
    expect(fallback.requiresSandboxForAutonomy("read-only")).toBe(true);
  });

  test("mapAutonomy returns approval mode flags", () => {
    expect(adapter.mapAutonomy("read-only")).toEqual(["--approval-mode", "plan"]);
    expect(adapter.mapAutonomy("low")).toEqual(["--approval-mode", "default"]);
    expect(adapter.mapAutonomy("medium")).toEqual(["--approval-mode", "auto"]);
    expect(adapter.mapAutonomy("high")).toEqual(["--approval-mode", "yolo"]);
  });
});

describe("ZaiAdapter", () => {
  const adapter = new ZaiAdapter({ ZAI_API_KEY: "test-key-123" });
  const safeHeadlessArgs = [
    "claude",
    "-p",
    "--setting-sources",
    "user",
    "--strict-mcp-config",
    "--no-session-persistence",
  ];

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
    expect(cmd).toEqual([...safeHeadlessArgs, "--model", "opus"]);
  });

  test("buildRunCommand with explicit model", () => {
    const request: RunRequest = { agent: "zai", prompt: "test", model: "sonnet" };
    const cmd = adapter.buildRunCommand(request);
    expect(cmd).toEqual([...safeHeadlessArgs, "--model", "sonnet"]);
  });

  test("buildRunCommand with autonomy levels", () => {
    expect(adapter.buildRunCommand({ agent: "zai", prompt: "t", autonomy: "read-only" }))
      .toEqual([...safeHeadlessArgs, "--model", "opus", "--permission-mode", "plan"]);
    expect(adapter.buildRunCommand({ agent: "zai", prompt: "t", autonomy: "low" }))
      .toEqual([...safeHeadlessArgs, "--model", "opus", "--permission-mode", "manual"]);
    expect(adapter.buildRunCommand({ agent: "zai", prompt: "t", autonomy: "medium" }))
      .toEqual([...safeHeadlessArgs, "--model", "opus", "--permission-mode", "acceptEdits"]);
    expect(adapter.buildRunCommand({ agent: "zai", prompt: "t", autonomy: "high" }))
      .toEqual([...safeHeadlessArgs, "--model", "opus", "--dangerously-skip-permissions"]);
  });

  test("buildRunCommand does not inject an MCP server by default", () => {
    const cmd = adapter.buildRunCommand({ agent: "zai", prompt: "t", sandboxed: true });
    expect(cmd).toEqual([
      ...safeHeadlessArgs,
      "--model",
      "opus",
    ]);
  });

  test("getStdinInput returns prompt", () => {
    const request: RunRequest = { agent: "zai", prompt: "my prompt" };
    expect(adapter.getStdinInput(request)).toBe("my prompt");
  });

  test("buildTuiCommand defaults to opus", () => {
    expect(adapter.buildTuiCommand()).toEqual(["claude", "--safe-mode", "--model", "opus"]);
  });

  test("buildTuiCommand with model and autonomy", () => {
    expect(adapter.buildTuiCommand("sonnet", "high")).toEqual(["claude", "--safe-mode", "--model", "sonnet", "--dangerously-skip-permissions"]);
  });

  test("buildTuiCommand does not inject an MCP server by default", () => {
    const cmd = adapter.buildTuiCommand("sonnet", "high", undefined, true);
    expect(cmd).toEqual([
      "claude",
      "--safe-mode",
      "--model",
      "sonnet",
      "--dangerously-skip-permissions",
    ]);
  });

  test("mapAutonomy matches claude adapter", () => {
    expect(adapter.mapAutonomy("read-only")).toEqual(["--permission-mode", "plan"]);
    expect(adapter.mapAutonomy("low")).toEqual(["--permission-mode", "manual"]);
    expect(adapter.mapAutonomy("medium")).toEqual(["--permission-mode", "acceptEdits"]);
    expect(adapter.mapAutonomy("high")).toEqual(["--dangerously-skip-permissions"]);
  });

  test("getEnv sets anthropic proxy vars", () => {
    const env = adapter.getEnv();
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("test-key-123");
    expect(env.ANTHROPIC_BASE_URL).toBe("https://api.z.ai/api/anthropic");
    expect(env.API_TIMEOUT_MS).toBeDefined();
  });
});
