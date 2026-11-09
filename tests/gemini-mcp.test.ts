import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { geminiExperimentServer, geminiPlaywrightSettings } from "../src/gemini-mcp.js";
import { GeminiAdapter } from "../src/adapters/gemini.js";

describe("Gemini native MCP settings", () => {
  test("disabled and unsandboxed requests attach no server", () => {
    expect(geminiPlaywrightSettings(true, false, "")).toEqual({ servers: {}, check: null });
    expect(geminiPlaywrightSettings(false, true, "")).toEqual({ servers: {}, check: null });
    expect(() => geminiPlaywrightSettings(true, true, "")).toThrow(/locally installed/);
  });

  test("Playwright private settings retain the resolved executable check", () => {
    const home = mkdtempSync(join(tmpdir(), "gemini-mcp-home-"));
    const bin = mkdtempSync(join(tmpdir(), "gemini-mcp-bin-"));
    const binary = join(bin, "playwright-mcp");
    writeFileSync(binary, "#!/bin/sh\nexit 0\n"); chmodSync(binary, 0o755);
    try {
      const adapter = new GeminiAdapter({ HOME: home, PATH: bin });
      const request = { agent: "gemini" as const, prompt: "p", sandboxed: true, enablePlaywrightMcp: true };
      // Preparation is tested separately from the shared supported-agent
      // whitelist. This fixture never executes the binary.
      const context = adapter.prepareRun(request);
      expect(context.playwrightMcpCheck).not.toBeNull();
      const settings = JSON.parse(readFileSync(join(context.geminiHermeticHome!.geminiDir, "settings.json"), "utf8"));
      expect(settings.mcpServers.playwright).toEqual({ command: realpathSync(binary), args: [] });
      expect(adapter.buildRunCommand(request, context)[1]).toBe(`GEMINI_CLI_HOME=${context.geminiHermeticHome!.home}`);
      expect(() => adapter.getRunEnv(request)).toThrow(/was not prepared/);
      adapter.cleanupRunSync(context);
      expect(() => geminiPlaywrightSettings(true, true, bin, bin)).toThrow(/inside the execution working directory/);
    } finally {
      rmSync(home, { recursive: true, force: true }); rmSync(bin, { recursive: true, force: true });
    }
  });

  test("experiment mapping includes only explicitly named environment variables", () => {
    const spec = { name: "fixture", command: "/fixture/server", args: ["--fixture"], env: ["ALLOWED", "ABSENT"] };
    expect(geminiExperimentServer(spec, { ALLOWED: "value", SECRET: "not forwarded" })).toEqual({ fixture: {
      command: "/fixture/server", args: ["--fixture"], env: { ALLOWED: "value" }, timeout: 7_200_000,
    } });
    expect(geminiExperimentServer({ ...spec, tool_timeout_seconds: 3 }, {}).fixture!.timeout).toBe(3000);
  });
});
