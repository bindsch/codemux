import { describe, test, expect } from "bun:test";
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  ConfigError,
  getConfigPath,
  getDefaultConfig,
  loadConfig,
  resolveModel,
} from "../src/config.js";

function withTempHome<T>(files: Record<string, string>, fn: (configPath: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "codemux-config-test-"));
  const configDir = join(dir, ".config", "codemux");
  mkdirSync(configDir, { recursive: true });
  for (const [relativePath, content] of Object.entries(files)) {
    writeFileSync(join(dir, relativePath), content);
  }

  try {
    return fn(join(configDir, "config.yaml"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("Config", () => {
  test("getConfigPath honors XDG and home fallbacks", () => {
    expect(getConfigPath({ XDG_CONFIG_HOME: "/xdg" }, "/fallback"))
      .toBe("/xdg/codemux/config.yaml");
    expect(getConfigPath({ HOME: "/home/test" }, "/fallback"))
      .toBe("/home/test/.config/codemux/config.yaml");
    expect(getConfigPath({}, "/fallback"))
      .toBe("/fallback/.config/codemux/config.yaml");
    expect(getConfigPath({ XDG_CONFIG_HOME: ".", HOME: "/home/test" }, "/fallback"))
      .toBe("/home/test/.config/codemux/config.yaml");
    expect(getConfigPath({ HOME: "relative-home" }, "/fallback"))
      .toBe("/fallback/.config/codemux/config.yaml");
  });

  test("getDefaultConfig returns expected structure", () => {
    const config = getDefaultConfig();
    expect(config.defaultAgent).toBe("claude");
    expect(config.models).toBeDefined();
    expect(typeof config.models).toBe("object");
  });

  test("loadConfig returns config with defaults", () => {
    const config = withTempHome({}, (configPath) => loadConfig(configPath));
    expect(config.defaultAgent).toBe("claude");
    expect(config.models["sonnet"]?.claude).toBe("sonnet");
    expect(config.models["gpt5"]?.codex).toBe("gpt-5.6");
  });

  test("a config path that cannot be inspected refuses instead of taking the defaults (review round 169)", () => {
    // A mode-000 parent makes the stat itself fail with EACCES; root
    // ignores directory modes, so the case cannot be built there.
    if (typeof process.getuid === "function" && process.getuid() === 0) return;
    const dir = mkdtempSync(join(tmpdir(), "codemux-config-refuse-"));
    const parent = join(dir, "config");
    mkdirSync(parent);
    writeFileSync(join(parent, "config.yaml"), "defaultAgent: codex\n");
    chmodSync(parent, 0o000);
    try {
      const configPath = join(parent, "config.yaml");
      expect(() => loadConfig(configPath)).toThrow(ConfigError);
      try {
        loadConfig(configPath);
      } catch (error) {
        expect(error instanceof ConfigError && error.message).toContain(configPath);
        expect(error instanceof ConfigError && error.message).toContain("EACCES");
      }
    } finally {
      chmodSync(parent, 0o700);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a config path under a file parent and a missing path both give the defaults (review round 169)", () => {
    const dir = mkdtempSync(join(tmpdir(), "codemux-config-absent-"));
    try {
      const blocker = join(dir, "blocker");
      writeFileSync(blocker, "not a directory");
      const underFile = loadConfig(join(blocker, "config.yaml"));
      expect(underFile.defaultAgent).toBe("claude");
      const missing = loadConfig(join(dir, "config.yaml"));
      expect(missing.defaultAgent).toBe("claude");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the claude-family built-in aliases cover zai", () => {
    // zai runs the same binary and accepts the same catalog aliases raw;
    // `-m opus -a zai` used to refuse ("alias not configured for agent")
    // while `-a zai` with no -m ran opus by default.
    for (const alias of ["sonnet", "opus", "haiku"] as const) {
      expect(resolveModel(alias, "zai", getDefaultConfig())).toBe(alias);
    }
  });

  test("loadConfig fails closed for invalid configured defaultAgent", () => {
    expect(() => withTempHome(
      {
        ".config/codemux/config.yaml": "defaultAgent: notreal\n",
      },
      (configPath) => loadConfig(configPath)
    )).toThrow("invalid defaultAgent 'notreal'");
  });

  test("loadConfig fails closed for malformed yaml", () => {
    expect(() => withTempHome(
      {
        ".config/codemux/config.yaml": "defaultAgent: [invalid",
      },
      (configPath) => loadConfig(configPath)
    )).toThrow("Could not load config");
  });

  test("loadConfig rejects unknown root keys", () => {
    expect(() => withTempHome(
      { ".config/codemux/config.yaml": "default_agent: codex\n" },
      (configPath) => loadConfig(configPath)
    )).toThrow("unknown configuration key: default_agent");
  });

  test("an absent quota key means the default gate policy", () => {
    const config = withTempHome({}, (configPath) => loadConfig(configPath));
    expect(config.quota).toEqual({
      minRemainingPercent: 10,
      weeklyWarnUsedPercent: 50,
      // 60 s, not 15: the slowest measured client (claude) answered in
      // 31 s, so 15 timed out and the gate protected nothing (audit
      // round 2, B2).
      timeoutSeconds: 60,
    });
  });

  test("quota: false disables the gate globally", () => {
    const config = withTempHome(
      { ".config/codemux/config.yaml": "quota: false\n" },
      (configPath) => loadConfig(configPath)
    );
    expect(config.quota).toBe(false);
  });

  test("quota settings merge over the defaults per field", () => {
    const config = withTempHome(
      {
        ".config/codemux/config.yaml":
          "quota:\n  minRemainingPercent: 25\n  timeoutSeconds: 30\n",
      },
      (configPath) => loadConfig(configPath)
    );
    expect(config.quota).toEqual({
      minRemainingPercent: 25,
      weeklyWarnUsedPercent: 50,
      timeoutSeconds: 30,
    });
  });

  test("quota rejects unknown settings and out-of-range values", () => {
    expect(() => withTempHome(
      { ".config/codemux/config.yaml": "quota:\n  ceiling: 5\n" },
      (configPath) => loadConfig(configPath)
    )).toThrow("unknown quota setting: ceiling");
    expect(() => withTempHome(
      { ".config/codemux/config.yaml": "quota:\n  minRemainingPercent: 101\n" },
      (configPath) => loadConfig(configPath)
    )).toThrow("quota minRemainingPercent must be a number from 0 to 100");
    expect(() => withTempHome(
      { ".config/codemux/config.yaml": "quota:\n  timeoutSeconds: 301\n" },
      (configPath) => loadConfig(configPath)
    )).toThrow("quota timeoutSeconds must be an integer from 1 to 300");
    expect(() => withTempHome(
      { ".config/codemux/config.yaml": "quota: banana\n" },
      (configPath) => loadConfig(configPath)
    )).toThrow("'quota' must be false or a mapping of quota gate settings");
  });

  test("quota timeoutSeconds rejects zero and fractional values", () => {
    // 0 disabled the gate through the runner's own validation firing inside
    // the gate's fail-open catch; a fraction produced a non-integer
    // millisecond timeout the same way. Both are refused at load now.
    for (const value of ["0", "0.5", "0.0001", "1000000"]) {
      expect(() => withTempHome(
        { ".config/codemux/config.yaml": `quota:\n  timeoutSeconds: ${value}\n` },
        (configPath) => loadConfig(configPath)
      ), `timeoutSeconds: ${value}`).toThrow(
        "quota timeoutSeconds must be an integer from 1 to 300"
      );
    }
  });

  test("quota timeoutSeconds accepts a per-agent map anchored by default (audit round 2, B2)", () => {
    // One agent may answer slower than the rest: {default: 60, claude: 90}
    // covers the named agents and leaves everyone else on the default.
    const config = withTempHome(
      {
        ".config/codemux/config.yaml":
          "quota:\n  timeoutSeconds:\n    default: 60\n    claude: 90\n",
      },
      (configPath) => loadConfig(configPath)
    );
    expect(config.quota).toEqual({
      minRemainingPercent: 10,
      weeklyWarnUsedPercent: 50,
      timeoutSeconds: { default: 60, claude: 90 },
    });
    expect(() => withTempHome(
      { ".config/codemux/config.yaml": "quota:\n  timeoutSeconds:\n    default: 60\n    claude: banana\n" },
      (configPath) => loadConfig(configPath)
    )).toThrow("quota timeoutSeconds for claude must be an integer from 1 to 300");
    expect(() => withTempHome(
      { ".config/codemux/config.yaml": "quota:\n  timeoutSeconds:\n    default: 301\n" },
      (configPath) => loadConfig(configPath)
    )).toThrow("quota timeoutSeconds must be an integer from 1 to 300");
    // A map without a default, and an empty map, would both fall back
    // mid-gate for the agents they do not name.
    expect(() => withTempHome(
      { ".config/codemux/config.yaml": "quota:\n  timeoutSeconds:\n    claude: 90\n" },
      (configPath) => loadConfig(configPath)
    )).toThrow("quota timeoutSeconds mapping must name a default");
    expect(() => withTempHome(
      { ".config/codemux/config.yaml": "quota:\n  timeoutSeconds: {}\n" },
      (configPath) => loadConfig(configPath)
    )).toThrow("quota timeoutSeconds mapping must name a default");
    expect(() => withTempHome(
      { ".config/codemux/config.yaml": "quota:\n  timeoutSeconds:\n    default: 60\n    notreal: 90\n" },
      (configPath) => loadConfig(configPath)
    )).toThrow("unknown quota timeoutSeconds agent 'notreal'");
  });

  test("quota spendsFrom maps agents to the client they spend from (audit round 2, B4)", () => {
    const config = withTempHome(
      {
        ".config/codemux/config.yaml":
          "quota:\n  spendsFrom:\n    opencode: claude\n",
      },
      (configPath) => loadConfig(configPath)
    );
    expect(config.quota).toEqual({
      minRemainingPercent: 10,
      weeklyWarnUsedPercent: 50,
      timeoutSeconds: 60,
      spendsFrom: { opencode: "claude" },
    });
    expect(() => withTempHome(
      { ".config/codemux/config.yaml": "quota:\n  spendsFrom: claude\n" },
      (configPath) => loadConfig(configPath)
    )).toThrow("quota spendsFrom must be a mapping of agent ids to usagemux client names");
    expect(() => withTempHome(
      { ".config/codemux/config.yaml": "quota:\n  spendsFrom:\n    notreal: claude\n" },
      (configPath) => loadConfig(configPath)
    )).toThrow("unknown quota spendsFrom agent 'notreal'");
    expect(() => withTempHome(
      { ".config/codemux/config.yaml": "quota:\n  spendsFrom:\n    opencode: not a client\n" },
      (configPath) => loadConfig(configPath)
    )).toThrow("quota spendsFrom for opencode must name a usagemux client");
    // A typo that looks like a name is refused too: it would reach usagemux,
    // come back unreadable, and let the gate proceed (review round 41).
    expect(() => withTempHome(
      { ".config/codemux/config.yaml": "quota:\n  spendsFrom:\n    opencode: cluade\n" },
      (configPath) => loadConfig(configPath)
    )).toThrow("quota spendsFrom for opencode must name a usagemux client");
  });

  test("quota percents reject non-finite and fractional-out-of-range values", () => {
    expect(() => withTempHome(
      { ".config/codemux/config.yaml": "quota:\n  minRemainingPercent: -1\n" },
      (configPath) => loadConfig(configPath)
    )).toThrow("quota minRemainingPercent must be a number from 0 to 100");
    expect(() => withTempHome(
      { ".config/codemux/config.yaml": "quota:\n  weeklyWarnUsedPercent: 100.5\n" },
      (configPath) => loadConfig(configPath)
    )).toThrow("quota weeklyWarnUsedPercent must be a number from 0 to 100");
    // In-range fractions stay valid: a percent needs no integer rule.
    const config = withTempHome(
      { ".config/codemux/config.yaml": "quota:\n  weeklyWarnUsedPercent: 12.5\n" },
      (configPath) => loadConfig(configPath)
    );
    expect(config.quota).toEqual({
      minRemainingPercent: 10,
      weeklyWarnUsedPercent: 12.5,
      timeoutSeconds: 60,
    });
  });

  test("loadConfig deep-merges model mappings instead of replacing defaults", () => {
    const config = withTempHome(
      {
        ".config/codemux/config.yaml": [
          "models:",
          "  sonnet:",
          "    claude: custom-sonnet",
          "",
        ].join("\n"),
      },
      (configPath) => loadConfig(configPath)
    );

    expect(config.models["sonnet"]?.claude).toBe("custom-sonnet");
    expect(config.models["sonnet"]?.droid).toBe("claude-sonnet-5");
    expect(config.models["sonnet"]?.codex).toBeUndefined();
  });

  test("default config has the exact model alias table", () => {
    // A golden table, not key-existence checks: any single wrong target
    // (the audit's worked example was a renamed sonnet target) fails here.
    const config = getDefaultConfig();
    expect(config.models).toEqual({
      sonnet: { claude: "sonnet", zai: "sonnet", droid: "claude-sonnet-5", copilot: "claude-sonnet-5", cursor: "claude-sonnet-5-high" },
      opus: { claude: "opus", zai: "opus", droid: "claude-opus-5", copilot: "claude-opus-4.8", cursor: "claude-opus-5-high" },
      haiku: { claude: "haiku", zai: "haiku", droid: "claude-haiku-4-5-20251001", copilot: "claude-haiku-4.5" },
      gpt5: { droid: "gpt-5.6-sol", codex: "gpt-5.6", copilot: "gpt-5.6-sol", cursor: "gpt-5.6-sol-medium" },
      "gpt5-codex": { droid: "gpt-5.3-codex", codex: "gpt-5.3-codex", copilot: "gpt-5.3-codex", cursor: "gpt-5.3-codex" },
      gpt53: { droid: "gpt-5.3-codex", codex: "gpt-5.3-codex", copilot: "gpt-5.3-codex", cursor: "gpt-5.3-codex" },
      "gemini-pro": { droid: "gemini-3.1-pro-preview", gemini: "gemini-3.1-pro-preview", copilot: "gemini-3.1-pro-preview", cursor: "gemini-3.1-pro" },
      "gemini-flash": { droid: "gemini-3.6-flash", gemini: "gemini-3.6-flash", copilot: "gemini-3.6-flash", cursor: "gemini-3.6-flash-high" },
    });
  });

  test("default config callers cannot mutate shared defaults", () => {
    const first = getDefaultConfig();
    first.defaultAgent = "droid";
    first.models.sonnet!.claude = "poisoned";

    const second = getDefaultConfig();
    expect(second.defaultAgent).toBe("claude");
    expect(second.models.sonnet!.claude).toBe("sonnet");
  });

  test("rejects unknown agents and unsafe aliases", () => {
    expect(() => withTempHome(
      { ".config/codemux/config.yaml": "models:\n  safe:\n    notreal: model\n" },
      (configPath) => loadConfig(configPath)
    )).toThrow("unknown agent 'notreal'");
    expect(() => withTempHome(
      { ".config/codemux/config.yaml": "models:\n  __proto__:\n    claude: model\n" },
      (configPath) => loadConfig(configPath)
    )).toThrow("invalid model alias '__proto__'");
  });

  test("rejects control characters and padding in configured model names", () => {
    for (const modelName of [" padded ", "line\nbreak", "nul\0byte"]) {
      const escaped = JSON.stringify(modelName);
      expect(() => withTempHome(
        {
          ".config/codemux/config.yaml":
            `models:\n  custom:\n    claude: ${escaped}\n`,
        },
        (configPath) => loadConfig(configPath)
      )).toThrow("invalid model name");
    }
  });

  test("sonnet alias maps correctly", () => {
    const config = getDefaultConfig();
    expect(config.models["sonnet"]!["claude"]).toBe("sonnet");
    expect(config.models["sonnet"]!["droid"]).toBe("claude-sonnet-5");
    expect(config.models["sonnet"]!["codex"]).toBeUndefined();
  });

  test("opus alias maps correctly", () => {
    const config = getDefaultConfig();
    expect(config.models["opus"]!["claude"]).toBe("opus");
    expect(config.models["opus"]!["droid"]).toBe("claude-opus-5");
  });

  test("gpt5 alias maps correctly", () => {
    const config = getDefaultConfig();
    expect(config.models["gpt5"]!["droid"]).toBe("gpt-5.6-sol");
    expect(config.models["gpt5"]!["codex"]).toBe("gpt-5.6");
  });
});

describe("resolveModel", () => {
  const config = getDefaultConfig();

  test("resolves known alias for claude", () => {
    expect(resolveModel("sonnet", "claude", config)).toBe("sonnet");
    expect(resolveModel("opus", "claude", config)).toBe("opus");
    expect(resolveModel("haiku", "claude", config)).toBe("haiku");
  });

  test("resolves known alias for droid", () => {
    expect(resolveModel("sonnet", "droid", config)).toBe("claude-sonnet-5");
    expect(resolveModel("gpt5", "droid", config)).toBe("gpt-5.6-sol");
    expect(resolveModel("gpt5-codex", "droid", config)).toBe("gpt-5.3-codex");
  });

  test("resolves known alias for codex", () => {
    expect(resolveModel("gpt5", "codex", config)).toBe("gpt-5.6");
    expect(() => resolveModel("sonnet", "codex", config)).toThrow(
      "model alias 'sonnet' is not configured for agent 'codex'"
    );
  });

  test("resolves current Cursor and Copilot aliases", () => {
    const config = getDefaultConfig();
    expect(resolveModel("sonnet", "cursor", config))
      .toBe("claude-sonnet-5-high");
    expect(resolveModel("gpt5", "cursor", config))
      .toBe("gpt-5.6-sol-medium");
    expect(resolveModel("gemini-pro", "cursor", config))
      .toBe("gemini-3.1-pro");
    expect(resolveModel("gemini-flash", "copilot", config))
      .toBe("gemini-3.6-flash");
    // One flash model per alias: droid pinned 3.5 through 0.11 while the
    // rest of the table said 3.6, though droid's own catalog serves 3.6.
    expect(resolveModel("gemini-flash", "droid", config))
      .toBe("gemini-3.6-flash");
    expect(resolveModel("gemini-flash", "gemini", config))
      .toBe("gemini-3.6-flash");
  });

  test("returns raw model name if alias not found", () => {
    expect(resolveModel("unknown-model", "claude", config)).toBe("unknown-model");
    expect(resolveModel("gpt-4-turbo", "droid", config)).toBe("gpt-4-turbo");
  });

  test("rejects known aliases that are unsupported by an agent", () => {
    expect(() => resolveModel("opus", "goose", config)).toThrow(
      "model alias 'opus' is not configured for agent 'goose'"
    );
    expect(() => resolveModel("sonnet", "qwen", config)).toThrow(
      "model alias 'sonnet' is not configured for agent 'qwen'"
    );
  });

  test("rejects unsafe direct model names", () => {
    expect(() => resolveModel(" padded ", "claude", config))
      .toThrow("invalid model name");
    expect(() => resolveModel("line\nbreak", "claude", config))
      .toThrow("invalid model name");
  });
});
