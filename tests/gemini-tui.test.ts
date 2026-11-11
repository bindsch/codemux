import { describe, expect, test, spyOn } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { GeminiAdapter } from "../src/adapters/gemini.js";
import { prepareGeminiTuiLaunch } from "../src/gemini-tui.js";

function geminiTuiFixture() {
  const root = mkdtempSync(join(tmpdir(), "gemini-tui-"));
  const home = join(root, "home"), cwd = join(root, "work"), bin = join(root, "bin");
  for (const path of [join(home, ".gemini"), cwd, bin]) mkdirSync(path, { recursive: true });
  const environment = { HOME: home, PATH: bin, CODEMUX_GEMINI_PROVIDER_BASE_URL: "https://provider.invalid", CODEMUX_GEMINI_PROVIDER_API_KEY: "synthetic", CODEMUX_GEMINI_PROVIDER_MODEL: "native-model", CODEMUX_GEMINI_PROVIDER_MAX_OUTPUT_TOKENS: "64" };
  return { root, home, cwd, bin, environment, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

describe("Gemini prepared TUI lifecycle", () => {
  test("caps the native model, delivers provider environment, and removes its private settings on cleanup", () => {
    const f = geminiTuiFixture();
    try {
      const adapter = new GeminiAdapter(f.environment);
      const launch = prepareGeminiTuiLaunch(adapter, { cwd: f.cwd, autonomy: "high" });
      const privateHome = launch.command[1]!.slice("GEMINI_CLI_HOME=".length);
      expect(launch.command).not.toContain("-p"); expect(launch.command).toContain("native-model");
      expect(launch.env).toEqual({ GOOGLE_GEMINI_BASE_URL: "https://provider.invalid", GEMINI_API_KEY: "synthetic" });
      const settings = JSON.parse(readFileSync(join(privateHome, ".gemini", "settings.json"), "utf8"));
      expect(settings.modelConfigs.customOverrides[0].modelConfig.generateContentConfig.maxOutputTokens).toBe(64);
      expect(existsSync(privateHome)).toBe(true); launch.cleanup(); expect(existsSync(privateHome)).toBe(false);
      expect(() => adapter.validateTuiRequest(undefined, f.cwd, "high")).not.toThrow();
    } finally { f.cleanup(); }
  });

  test("MCP preserves the captured executable check and preview skips login links", () => {
    const f = geminiTuiFixture();
    try {
      const binary = join(f.bin, "playwright-mcp"); writeFileSync(binary, "#!/bin/sh\nexit 0\n"); chmodSync(binary, 0o755);
      writeFileSync(join(f.home, ".gemini", "oauth_creds.json"), "synthetic");
      const adapter = new GeminiAdapter(f.environment);
      const launch = prepareGeminiTuiLaunch(adapter, { cwd: f.cwd, autonomy: "low", enablePlaywrightMcp: true, sandboxed: true, printOnly: true });
      const privateHome = launch.command[1]!.slice("GEMINI_CLI_HOME=".length);
      expect(launch.playwrightCheck).not.toBeNull();
      expect(existsSync(join(privateHome, ".gemini", "oauth_creds.json"))).toBe(false); launch.cleanup();
      expect(() => prepareGeminiTuiLaunch(adapter, { cwd: f.cwd, autonomy: "high", enablePlaywrightMcp: true })).toThrow(/requires --sandbox/);
    } finally { f.cleanup(); }
  });

  test("ordinary interactive launches need no settings mirror and failed command construction cleans its mirror", () => {
    const f = geminiTuiFixture();
    try {
      const ordinary = prepareGeminiTuiLaunch(new GeminiAdapter({ HOME: f.home }), { cwd: f.cwd, autonomy: "high" });
      expect(ordinary.command[0]).toBe("gemini"); expect(ordinary.env).toEqual({}); ordinary.cleanup();
      const adapter = new GeminiAdapter(f.environment);
      const cleanup = spyOn(adapter, "cleanupRunSync");
      const command = spyOn(adapter, "buildRunCommand").mockReturnValue(["gemini"]);
      try {
        expect(() => prepareGeminiTuiLaunch(adapter, { cwd: f.cwd, autonomy: "high" })).toThrow(/headless prompt suffix/);
        expect(cleanup).toHaveBeenCalledTimes(1);
      } finally { command.mockRestore(); cleanup.mockRestore(); }
    } finally { f.cleanup(); }
  });

  test("generic TUI environment lifetime carries caps without command-order or shared-helper changes", () => {
    const f = geminiTuiFixture();
    try {
      writeFileSync(join(f.home, ".gemini", "settings.json"), JSON.stringify({ ui: { theme: "plain" } }));
      writeFileSync(join(f.home, ".gemini", "oauth_creds.json"), "synthetic");
      const adapter = new GeminiAdapter(f.environment);
      adapter.validateTuiRequest(undefined, f.cwd, "high");
      const commandBefore = adapter.buildTuiCommand(undefined, "high");
      const first = adapter.prepareTuiEnvironment(undefined, "high", undefined, false);
      const preview = adapter.prepareTuiEnvironment(undefined, "high", undefined, true, [], true);
      try {
        const home = first.env.GEMINI_CLI_HOME!;
        expect(preview.env.GEMINI_CLI_HOME).not.toBe(home);
        expect(adapter.buildTuiCommand(undefined, "high")).toEqual(commandBefore);
        expect(first.env).toMatchObject({ GOOGLE_GEMINI_BASE_URL: "https://provider.invalid", GEMINI_API_KEY: "synthetic" });
        expect(adapter.buildExecutionEnv(first.env).HOME).toBe(f.home);
        const settings = JSON.parse(readFileSync(join(home, ".gemini", "settings.json"), "utf8"));
        expect(settings.ui.theme).toBe("plain");
        expect(settings.modelConfigs.customOverrides[0].modelConfig.generateContentConfig.maxOutputTokens).toBe(64);
        expect(existsSync(join(preview.env.GEMINI_CLI_HOME!, ".gemini", "oauth_creds.json"))).toBe(false);
        first.finalize(); expect(existsSync(home)).toBe(false);
        expect(existsSync(preview.env.GEMINI_CLI_HOME!)).toBe(false);
      } finally { first.finalize(); preview.finalize(); }
      const ordinary = new GeminiAdapter({ HOME: f.home }).prepareTuiEnvironment();
      expect(ordinary.env).toEqual({}); ordinary.finalize();
      mkdirSync(join(f.cwd, ".gemini"));
      writeFileSync(join(f.cwd, ".gemini", "settings.json"), '{"modelConfigs":{}}');
      expect(() => adapter.validateTuiRequest(undefined, f.cwd, "high")).toThrow();
      expect(() => adapter.validateTuiRequest(undefined, f.root, "high", undefined, [], true)).toThrow();
    } finally { f.cleanup(); }
  });
});
