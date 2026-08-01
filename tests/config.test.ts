import { describe, test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
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
    expect(config.defaultAgent).toBeDefined();
    expect(config.models).toBeDefined();
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

  test("default config has expected model aliases", () => {
    const config = getDefaultConfig();
    expect(config.models["sonnet"]).toBeDefined();
    expect(config.models["opus"]).toBeDefined();
    expect(config.models["haiku"]).toBeDefined();
    expect(config.models["gpt5"]).toBeDefined();
    expect(config.models["gpt5-codex"]).toBeDefined();
    expect(config.models["gemini-pro"]).toBeDefined();
    expect(config.models["gemini-flash"]).toBeDefined();
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
