import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GeminiAdapter } from "../src/adapters/gemini.js";
import { geminiToolPolicy, writeGeminiToolPolicy, GEMINI_POLICY_PRIORITY } from "../src/gemini-policy.js";
import type { RunRequest } from "../src/types.js";

describe("Gemini native policy delivery", () => {
  test("default tools need no policy, and none denies every tool in every mode", () => {
    expect(geminiToolPolicy({})).toBeNull();
    expect(geminiToolPolicy({ tools: "default", web: true })).toBeNull();
    const policy = Bun.TOML.parse(geminiToolPolicy({ tools: "none" })!) as { rule: unknown };
    expect(policy.rule).toEqual([{ toolName: "*", decision: "deny", priority: GEMINI_POLICY_PRIORITY }]);
  });

  test("no-web denies the native search and fetch names without denying file tools", () => {
    const policy = Bun.TOML.parse(geminiToolPolicy({ web: false })!) as { rule: unknown };
    expect(policy.rule).toEqual([
      { toolName: "google_web_search", decision: "deny", priority: 999 },
      { toolName: "web_fetch", decision: "deny", priority: 999 },
    ]);
    expect(geminiToolPolicy({ tools: "none", web: false })).toBe(geminiToolPolicy({ tools: "none" }));
  });

  test("plain tools-none and no-web use private policy without rewriting operator settings", () => {
    const home = mkdtempSync(join(tmpdir(), "gemini-policy-"));
    const adapter = new GeminiAdapter({ HOME: home });
    try {
      for (const flags of [{ tools: "none" as const }, { web: false }]) {
        const request: RunRequest = { agent: "gemini", prompt: "secret prompt", ...flags };
        adapter.validateRunRequest(request);
        const context = adapter.prepareRun(request);
        const argv = adapter.buildRunCommand(request, context);
        if (request.tools === "none") {
          expect(argv[0]).toBe("env");
          const settings = JSON.parse(readFileSync(join(context.geminiHermeticHome!.geminiDir, "settings.json"), "utf8"));
          expect(settings.tools.core).toEqual([]);
        } else {
          expect(argv[0]).toBe("gemini");
          expect(argv.some((arg) => arg.startsWith("GEMINI_CLI_HOME="))).toBe(false);
        }
        const path = argv[argv.indexOf("--policy") + 1]!;
        expect(readFileSync(path, "utf8")).toBe(geminiToolPolicy(request)!);
        expect(statSync(path).mode & 0o777).toBe(0o600);
        expect(adapter.getRunEnv(request, context)).toEqual({});
        expect(argv).not.toContain("secret prompt");
        expect(adapter.getStdinInput(request)).toBe("secret prompt");
        adapter.cleanupRunSync(context);
        expect(existsSync(path)).toBe(false);
      }
      expect(writeGeminiToolPolicy(home, {})).toBeNull();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("stdin accepts long prompts without an argv limit", () => {
    const adapter = new GeminiAdapter({});
    const request: RunRequest = { agent: "gemini", prompt: "b".repeat(200_000) };
    expect(() => adapter.validateRunRequest(request)).not.toThrow();
    expect(adapter.getStdinInput(request)).toBe(request.prompt);
    expect(adapter.promptInArgv(request)).toBe(false);
    expect(adapter.buildRunCommand(request).at(-1)).toBe("");
  });

  test("context token caps refuse rather than silently disappearing", () => {
    const adapter = new GeminiAdapter({
      CODEMUX_GEMINI_PROVIDER_BASE_URL: "https://gateway.example",
      CODEMUX_GEMINI_PROVIDER_API_KEY: "test",
      CODEMUX_GEMINI_PROVIDER_MODEL: "gemini-model",
      CODEMUX_GEMINI_PROVIDER_MAX_CONTEXT_TOKENS: "8000",
    });
    expect(() => adapter.validateRunRequest({ agent: "gemini", prompt: "t" })).toThrow(/hard-coded tokenLimit/);
    expect(() => adapter.validateTuiRequest()).toThrow(/hard-coded tokenLimit/);
    expect(() => adapter.getRunEnv({ agent: "gemini", prompt: "t" })).toThrow(/hard-coded tokenLimit/);
  });
});
