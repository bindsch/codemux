import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { prepareGeminiSessionSettings } from "../src/session/gemini-settings.js";
import { GEMINI_DRIVER_PROFILE } from "../src/session/gemini-driver.js";
import type { ExecutableCheck } from "../src/executable-security.js";

const REQUEST = { agent: "gemini" as const, prompt: "p" };
const ID = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";

describe("Gemini session settings integration seam", () => {
  test("a plain session without generated settings preserves the native home", () => {
    expect(prepareGeminiSessionSettings({ request: REQUEST, prepared: {}, privateHome: null, override: null })).toEqual({});
  });

  test("tools-none is reapplied on resume and default restores the tools", () => {
    const home = mkdtempSync(join(tmpdir(), "gemini-session-settings-"));
    mkdirSync(join(home, ".gemini"));
    try {
      const input = { request: { ...REQUEST, tools: "none" as const }, prepared: {}, privateHome: home, override: null };
      for (const firstTurn of [true, false]) {
        const extras = prepareGeminiSessionSettings(input);
        const command = GEMINI_DRIVER_PROFILE.buildTurnCommand({
          text: "secret", sessionId: ID, firstTurn, hermeticHome: home, autonomy: "low", ...extras,
        });
        expect(command).toContain(extras.geminiPolicyPath!);
        expect(command).toContain(firstTurn ? "--session-id" : "--resume");
        expect(command).not.toContain("secret");
      }
      const settings = join(home, ".gemini", "settings.json");
      expect(JSON.parse(readFileSync(settings, "utf8")).tools).toEqual({ core: [], exclude: ["*"] });
      expect(prepareGeminiSessionSettings({ ...input, request: REQUEST }).geminiPolicyPath).toBeUndefined();
      expect(JSON.parse(readFileSync(settings, "utf8")).tools).toBeUndefined();
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test("provider output cap survives repeated turns without growing the settings", () => {
    const home = mkdtempSync(join(tmpdir(), "gemini-session-settings-"));
    mkdirSync(join(home, ".gemini"));
    try {
      const input = { request: REQUEST, prepared: {}, privateHome: home, override: { model: "target", maxOutputTokens: 512 } };
      prepareGeminiSessionSettings(input); prepareGeminiSessionSettings(input);
      const settings = JSON.parse(readFileSync(join(home, ".gemini", "settings.json"), "utf8"));
      expect(settings.modelConfigs.customOverrides).toEqual([{
        match: { model: "target" }, modelConfig: { generateContentConfig: { maxOutputTokens: 512 } },
      }]);
      expect(() => prepareGeminiSessionSettings({ ...input, override: { maxOutputTokens: 1 } })).toThrow(/requires a model/);
      const denied = prepareGeminiSessionSettings({ ...input, permissionPolicy: "deny" });
      expect(readFileSync(denied.geminiPolicyPath!, "utf8")).toContain('toolName = "*"');
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test("Playwright uses the captured executable identity and a missing identity refuses", () => {
    const home = mkdtempSync(join(tmpdir(), "gemini-session-settings-"));
    mkdirSync(join(home, ".gemini"));
    try {
      const input = { request: { ...REQUEST, enablePlaywrightMcp: true }, prepared: {}, privateHome: home, override: null };
      expect(() => prepareGeminiSessionSettings(input)).toThrow(/require an executable check/);
      prepareGeminiSessionSettings({ ...input, prepared: { playwrightMcpCheck: { path: "/trusted/playwright" } as ExecutableCheck } });
      expect(JSON.parse(readFileSync(join(home, ".gemini", "settings.json"), "utf8")).mcpServers).toEqual({
        playwright: { command: "/trusted/playwright", args: [] },
      });
      writeFileSync(join(home, ".gemini", "settings.json"), "[]");
      expect(() => prepareGeminiSessionSettings({ ...input, request: REQUEST })).toThrow(/must contain an object/);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test("a redirected settings directory is refused before any write", () => {
    const home = mkdtempSync(join(tmpdir(), "gemini-session-settings-"));
    const target = mkdtempSync(join(tmpdir(), "gemini-session-target-"));
    symlinkSync(target, join(home, ".gemini"));
    try {
      expect(() => prepareGeminiSessionSettings({ request: REQUEST, prepared: {}, privateHome: home, override: null }))
        .toThrow(/real private directory/);
    } finally {
      rmSync(home, { recursive: true, force: true }); rmSync(target, { recursive: true, force: true });
    }
  });
});
