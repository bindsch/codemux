import { describe, test, expect } from "bun:test";
import { loadConfig, resolveModel, getDefaultConfig } from "../src/config.js";

describe("Config", () => {
  test("getDefaultConfig returns expected structure", () => {
    const config = getDefaultConfig();
    expect(config.defaultAgent).toBe("claude");
    expect(config.models).toBeDefined();
    expect(typeof config.models).toBe("object");
  });

  test("loadConfig returns config with defaults", () => {
    const config = loadConfig();
    expect(config.defaultAgent).toBeDefined();
    expect(config.models).toBeDefined();
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

  test("sonnet alias maps correctly", () => {
    const config = getDefaultConfig();
    expect(config.models["sonnet"]!["claude"]).toBe("claude-sonnet-4-5-20250929");
    expect(config.models["sonnet"]!["droid"]).toBe("claude-sonnet-4-5-20250929");
    expect(config.models["sonnet"]!["codex"]).toBe("claude-sonnet-4-5-20250929");
  });

  test("opus alias maps correctly", () => {
    const config = getDefaultConfig();
    expect(config.models["opus"]!["claude"]).toBe("claude-opus-4-5-20251101");
    expect(config.models["opus"]!["droid"]).toBe("claude-opus-4-5-20251101");
  });

  test("gpt5 alias maps correctly", () => {
    const config = getDefaultConfig();
    expect(config.models["gpt5"]!["droid"]).toBe("gpt-5.1");
    expect(config.models["gpt5"]!["codex"]).toBe("gpt-5.1");
  });
});

describe("resolveModel", () => {
  const config = getDefaultConfig();

  test("resolves known alias for claude", () => {
    expect(resolveModel("sonnet", "claude", config)).toBe("claude-sonnet-4-5-20250929");
    expect(resolveModel("opus", "claude", config)).toBe("claude-opus-4-5-20251101");
    expect(resolveModel("haiku", "claude", config)).toBe("claude-haiku-4-5-20251001");
  });

  test("resolves known alias for droid", () => {
    expect(resolveModel("sonnet", "droid", config)).toBe("claude-sonnet-4-5-20250929");
    expect(resolveModel("gpt5", "droid", config)).toBe("gpt-5.1");
    expect(resolveModel("gpt5-codex", "droid", config)).toBe("gpt-5.1-codex");
  });

  test("resolves known alias for codex", () => {
    expect(resolveModel("sonnet", "codex", config)).toBe("claude-sonnet-4-5-20250929");
    expect(resolveModel("gpt5", "codex", config)).toBe("gpt-5.1");
  });

  test("returns raw model name if alias not found", () => {
    expect(resolveModel("unknown-model", "claude", config)).toBe("unknown-model");
    expect(resolveModel("gpt-4-turbo", "droid", config)).toBe("gpt-4-turbo");
  });

  test("returns raw model name if agent not in alias mapping", () => {
    expect(resolveModel("opus", "goose", config)).toBe("opus");
    expect(resolveModel("sonnet", "qwen", config)).toBe("sonnet");
  });
});
