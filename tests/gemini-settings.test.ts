import { describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { GeminiAdapter } from "../src/adapters/gemini.js";
import { createGeminiHermeticHome } from "../src/gemini-hermetic.js";
import { geminiSettingsWithOutputLimit, inheritGeminiSettings } from "../src/gemini-settings.js";
import { validateGeminiProjectSettings } from "../src/gemini-project-settings.js";

describe("Gemini settings carriers", () => {
  test("output token caps extend existing model settings without changing unrelated settings", () => {
    const previous = { match: { model: "other" }, modelConfig: { generateContentConfig: { temperature: 0.5 } } };
    const settings = { tools: { allowed: ["read_file"] }, modelConfigs: { customOverrides: [previous] } };
    expect(geminiSettingsWithOutputLimit(settings, "target", 512)).toEqual({
      tools: settings.tools,
      modelConfigs: { customOverrides: [previous, {
        match: { model: "target" }, modelConfig: { generateContentConfig: { maxOutputTokens: 512 } },
      }] },
    });
    expect(geminiSettingsWithOutputLimit({ modelConfigs: null }, "target", 1)).toHaveProperty("modelConfigs.customOverrides");
  });

  test("more specific native and custom rules cannot restore a higher output cap", () => {
    const specific = { match: { model: "target", isChatModel: true }, modelConfig: { generateContentConfig: { maxOutputTokens: 9000, temperature: 0.2 } } };
    const unrelated = { match: { model: "other" }, modelConfig: { generateContentConfig: { maxOutputTokens: 9000 } } };
    const result = geminiSettingsWithOutputLimit({ modelConfigs: { overrides: [specific, unrelated], customOverrides: [specific] } }, "target", 100);
    type Override = typeof specific | typeof unrelated;
    const configs = result.modelConfigs as { overrides: Override[]; customOverrides: Override[] };
    expect(configs.overrides[0]!.modelConfig.generateContentConfig).toEqual({ maxOutputTokens: 100, temperature: 0.2 });
    expect(configs.overrides[1]).toEqual(unrelated);
    expect(configs.customOverrides[0]!.modelConfig.generateContentConfig.maxOutputTokens).toBe(100);
    expect(configs.customOverrides).toHaveLength(2);
    expect(geminiSettingsWithOutputLimit(result, "target", 50)).toHaveProperty("modelConfigs.customOverrides.0.modelConfig.generateContentConfig.maxOutputTokens", 50);
  });

  test("plain settings relocation keeps customization and never rewrites the original file", () => {
    const home = mkdtempSync(join(tmpdir(), "gemini-settings-"));
    const source = join(home, ".gemini");
    mkdirSync(source);
    const original = '{ // operator comment\n "general": { "vimMode": true }}';
    writeFileSync(join(source, "settings.json"), original);
    writeFileSync(join(source, "GEMINI.md"), "operator context");
    const adapter = new GeminiAdapter({
      HOME: home,
      CODEMUX_GEMINI_PROVIDER_BASE_URL: "https://gateway.example",
      CODEMUX_GEMINI_PROVIDER_API_KEY: "secret",
      CODEMUX_GEMINI_PROVIDER_MODEL: "target",
      CODEMUX_GEMINI_PROVIDER_MAX_OUTPUT_TOKENS: "512",
    });
    try {
      const request = { agent: "gemini" as const, prompt: "prompt" };
      const context = adapter.prepareRun(request);
      const privateDir = context.geminiHermeticHome!.geminiDir;
      expect(lstatSync(join(privateDir, "GEMINI.md")).isSymbolicLink()).toBe(true);
      expect(JSON.parse(readFileSync(join(privateDir, "settings.json"), "utf8"))).toEqual({
        general: { vimMode: true }, modelConfigs: { customOverrides: [{
          match: { model: "target" }, modelConfig: { generateContentConfig: { maxOutputTokens: 512 } },
        }] },
      });
      expect(readFileSync(join(source, "settings.json"), "utf8")).toBe(original);
      expect(adapter.buildRunCommand(request, context).slice(0, 3)).toEqual([
        "env", `GEMINI_CLI_HOME=${context.geminiHermeticHome!.home}`, "gemini",
      ]);
      expect(adapter.getRunEnv(request, context)).toEqual({ GOOGLE_GEMINI_BASE_URL: "https://gateway.example", GEMINI_API_KEY: "secret" });
      expect(() => adapter.getRunEnv(request)).toThrow(/was not prepared/);
      expect(() => adapter.validateTuiRequest()).not.toThrow();
      adapter.cleanupRunSync(context);
      expect(existsSync(privateDir)).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("mirrors absent settings and skips login links in previews, while malformed settings fail closed", () => {
    const home = mkdtempSync(join(tmpdir(), "gemini-settings-"));
    const source = join(home, "source");
    const destination = join(home, "destination");
    mkdirSync(source); mkdirSync(destination);
    writeFileSync(join(source, "oauth_creds.json"), "test fixture");
    try {
      expect(inheritGeminiSettings(source, destination, true)).toEqual({});
      expect(existsSync(join(destination, "oauth_creds.json"))).toBe(false);
      writeFileSync(join(source, "settings.json"), "[]");
      expect(() => inheritGeminiSettings(source, destination, true)).toThrow(/must contain an object/);
      writeFileSync(join(source, "settings.json"), "{");
      expect(() => createGeminiHermeticHome(source, { preserveCustomization: true })).toThrow();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("TUI provider override delivers the endpoint, key, and configured model", () => {
    const adapter = new GeminiAdapter({
      CODEMUX_GEMINI_PROVIDER_BASE_URL: "https://gateway.example",
      CODEMUX_GEMINI_PROVIDER_API_KEY: "test",
      CODEMUX_GEMINI_PROVIDER_MODEL: "target",
    });
    expect(adapter.getTuiEnv()).toEqual({ GOOGLE_GEMINI_BASE_URL: "https://gateway.example", GEMINI_API_KEY: "test" });
    expect(adapter.buildTuiCommand()).toContain("target");
    expect(adapter.buildTuiCommand("explicit")).toContain("explicit");
  });
});

describe("Gemini project settings opt-in", () => {
  test("validates containment, policy modes, and conflicting inputs", () => {
    const cwd = mkdtempSync(join(tmpdir(), "gemini-project-"));
    const request = { agent: "gemini", hermetic: true, sandbox: true, autonomy: "low", cwd };
    try {
      mkdirSync(join(cwd, ".gemini"));
      writeFileSync(join(cwd, ".gemini", "settings.json"), '{"tools":{"exclude":["run_shell_command"]}}');
      expect(() => validateGeminiProjectSettings(request)).not.toThrow();
      expect(() => validateGeminiProjectSettings({ ...request, autonomy: "high", session: true })).not.toThrow();
      for (const patch of [{ hermetic: false }, { sandbox: false }, { autonomy: "medium" }, { tools: "none" },
        { experimentMcp: "spec.json" }, { passthroughEnv: ["GEMINI_CLI_HOME"] }]) {
        expect(() => validateGeminiProjectSettings({ ...request, ...patch })).toThrow(/experiment-project-settings/);
      }
      const nested = join(cwd, "nested"); mkdirSync(nested);
      expect(() => validateGeminiProjectSettings({ ...request, cwd: nested })).toThrow(/ancestor Gemini configuration/);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
