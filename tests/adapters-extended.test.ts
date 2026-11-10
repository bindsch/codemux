import { describe, expect, spyOn, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AiderAdapter } from "../src/adapters/aider.js";
import { OpencodeAdapter } from "../src/adapters/opencode.js";
import { PLAYWRIGHT_MCP_AGENT_LIST } from "../src/mcp.js";
import { PiAdapter } from "../src/adapters/pi.js";
import { QwenAdapter } from "../src/adapters/qwen.js";
import type { RunRequest } from "../src/types.js";

describe("OpencodeAdapter", () => {
  const adapter = new OpencodeAdapter();

  test("has correct id and binary name", () => {
    expect(adapter.id).toBe("opencode");
    expect(adapter.binaryName).toBe("opencode");
  });

  test("the shared validators refuse the Playwright option for an agent with no carrier", () => {
    // Review round 147: only claude and zai have a command builder that can
    // attach the Playwright MCP server. An adapter outside that list refuses
    // the option instead of accepting a launch the server never rides; the
    // sandbox refusal fires first, exactly as for a supporting agent.
    // OpenCode joined the list; aider has no MCP client, so it stands in.
    const aider = new AiderAdapter();
    expect(() => aider.validateRunRequest({
      agent: "aider", prompt: "t", enablePlaywrightMcp: true,
    })).toThrow("--enable-playwright-mcp requires --sandbox");
    expect(() => aider.validateRunRequest({
      agent: "aider", prompt: "t", sandboxed: true, enablePlaywrightMcp: true,
    })).toThrow(`--enable-playwright-mcp is supported only by ${PLAYWRIGHT_MCP_AGENT_LIST}`);
    expect(() => aider.validateTuiRequest(undefined, undefined, undefined, undefined, [], true))
      .toThrow(`--enable-playwright-mcp is supported only by ${PLAYWRIGHT_MCP_AGENT_LIST}`);
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
    expect(adapter.supportsTuiEffort()).toBe(true);
  });

  test("buildRunCommand reads only from stdin", () => {
    const request: RunRequest = { agent: "opencode", prompt: "test" };
    const cmd = adapter.buildRunCommand(request);
    expect(cmd).toEqual(["opencode", "--pure", "run", "--format", "json"]);
  });

  test("buildRunCommand with model", () => {
    const request: RunRequest = { agent: "opencode", prompt: "test", model: "gpt-4" };
    const cmd = adapter.buildRunCommand(request);
    expect(cmd).toEqual(["opencode", "--pure", "run", "--format", "json", "--model", "gpt-4"]);
  });

  test("buildRunCommand with autonomy", () => {
    expect(adapter.buildRunCommand({ agent: "opencode", prompt: "t", autonomy: "read-only" }))
      .toEqual(["opencode", "--pure", "run", "--format", "json", "--agent", "plan"]);
    expect(adapter.buildRunCommand({ agent: "opencode", prompt: "t", autonomy: "low" }))
      .toEqual(["opencode", "--pure", "run", "--format", "json", "--agent", "build"]);
    expect(adapter.buildRunCommand({ agent: "opencode", prompt: "t", autonomy: "medium" }))
      .toEqual(["opencode", "--pure", "run", "--format", "json", "--agent", "build"]);
    expect(adapter.buildRunCommand({ agent: "opencode", prompt: "t", autonomy: "high" }))
      .toEqual(["opencode", "--pure", "run", "--format", "json", "--agent", "build", "--auto"]);
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
    expect(adapter.requiresSandboxForAutonomy("low")).toBe(true);
    expect(adapter.requiresSandboxForAutonomy("medium")).toBe(true);
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
    expect(cmd).toEqual(["pi", "--print", "--no-session", "--no-approve", "--mode", "json"]);
  });

  test("buildRunCommand with model", () => {
    const request: RunRequest = { agent: "pi", prompt: "test", model: "pi-pro" };
    const cmd = adapter.buildRunCommand(request);
    expect(cmd).toEqual(["pi", "--print", "--no-session", "--no-approve", "--mode", "json", "--model", "pi-pro"]);
  });

  test("buildRunCommand with autonomy levels", () => {
    expect(adapter.buildRunCommand({ agent: "pi", prompt: "t", autonomy: "read-only" }))
      .toEqual(["pi", "--print", "--no-session", "--no-approve", "--mode", "json", "--no-extensions", "--tools", "read,grep,find,ls"]);
    expect(adapter.buildRunCommand({ agent: "pi", prompt: "t", autonomy: "low" }))
      .toEqual(["pi", "--print", "--no-session", "--no-approve", "--mode", "json", "--no-extensions", "--tools", "read,grep,find,ls,edit,write"]);
    expect(adapter.buildRunCommand({ agent: "pi", prompt: "t", autonomy: "medium" }))
      .toEqual(["pi", "--print", "--no-session", "--no-approve", "--mode", "json"]);
    expect(adapter.buildRunCommand({ agent: "pi", prompt: "t", autonomy: "high" }))
      .toEqual(["pi", "--print", "--no-session", "--no-approve", "--mode", "json"]);
  });

  test("autonomy mapping is silent at medium and high (audit round 2, A12)", () => {
    // mapAutonomy used to console.warn at medium and high, so every launch
    // and `codemux verify` repeated a note the capability table already
    // carries. The mapping stays as documented; only the warn is gone.
    const warnings: string[] = [];
    const warn = spyOn(console, "warn").mockImplementation((line: string) => { warnings.push(line); });
    try {
      for (const level of ["medium", "high"] as const) {
        expect(adapter.mapAutonomy(level)).toEqual([]);
        adapter.buildRunCommand({ agent: "pi", prompt: "t", autonomy: level });
      }
    } finally {
      warn.mockRestore();
    }
    expect(warnings).toEqual([]);
  });

  test("getStdinInput returns prompt", () => {
    const request: RunRequest = { agent: "pi", prompt: "my prompt" };
    expect(adapter.getStdinInput(request)).toBe("my prompt");
  });

  test("buildTuiCommand basic", () => {
    // --no-approve is project trust, not an autonomy grant, so it rides
    // every TUI launch (0.85.1 help: "Ignore project-local files for this
    // run").
    expect(adapter.buildTuiCommand()).toEqual(["pi", "--no-approve"]);
  });

  test("buildTuiCommand with model", () => {
    expect(adapter.buildTuiCommand("pi-pro")).toEqual(["pi", "--no-approve", "--model", "pi-pro"]);
  });

  test("buildTuiCommand with autonomy", () => {
    // The level's tool restrictions ride along; --no-approve stays at
    // every level because it gates project-local files, not approvals.
    expect(adapter.buildTuiCommand(undefined, "read-only")).toEqual(["pi", "--no-approve", "--no-extensions", "--tools", "read,grep,find,ls"]);
    expect(adapter.buildTuiCommand(undefined, "low")).toEqual(["pi", "--no-approve", "--no-extensions", "--tools", "read,grep,find,ls,edit,write"]);
    expect(adapter.buildTuiCommand(undefined, "medium")).toEqual(["pi", "--no-approve"]);
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
      .toEqual(["pi", "--print", "--no-session", "--no-approve", "--mode", "json", "--thinking", "high"]);
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
    // The tier rides a per-run system settings file (src/qwen-effort.ts);
    // minimal and ultra stay outside the list qwen's settings accept.
    expect(caps.supportsEffort).toBe(true);
    expect(caps.effortLevels).toEqual(["none", "low", "medium", "high", "xhigh", "max"]);
    expect(caps.supportsHermetic).toBe(true);
    expect(caps.supportsResultJson).toBe(true);
    expect(caps.supportsProviderOverride).toBe(true);
    expect(caps.supportsToolSelection).toBe(true);
  });

  test("buildRunCommand with prompt", () => {
    const cmd = adapter.buildRunCommand({ agent: "qwen", prompt: "test prompt" });
    expect(cmd).toEqual(["/fake/qwen", "--safe-mode", "--output-format", "stream-json"]);
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
      "--output-format",
      "stream-json",
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

  test("medium requires scode while current high may run without it", () => {
    expect(adapter.requiresSandboxForAutonomy("medium")).toBe(true);
    expect(adapter.requiresSandboxForTuiAutonomy("medium")).toBe(true);
    expect(adapter.requiresSandboxForAutonomy("high")).toBe(false);
    expect(adapter.requiresSandboxForTuiAutonomy("high")).toBe(false);
  });
});
