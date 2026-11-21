import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAdapter } from "../src/adapters/index.js";
import { claudeLoginState, envKeyLoginState } from "../src/harness-health.js";
import { remedyFor } from "../src/doctor-remedies.js";
import { AGENT_IDS } from "../src/types.js";

const home = mkdtempSync(join(import.meta.dir, "../scratch/fix/login-evidence-"));
afterAll(() => rmSync(home, { recursive: true, force: true }));

test("missing native authentication evidence is unknown for every harness", () => {
  for (const id of AGENT_IDS) {
    if (id === "zai") continue; // Its adapter requires its own file or environment key.
    const state = getAdapter(id, { HOME: home, PATH: "" }).loginState();
    expect(state.state, id).toBe("unknown");
    expect(remedyFor(id, "LOGIN-UNKNOWN"), id).toBeNull();
    expect(state.note ?? "", id).not.toMatch(/run .*login|sign in|log in|unsandboxed|create.*mirror/i);
  }
});

test("macOS Claude missing, malformed, empty and expired files cannot establish Keychain login", () => {
  const config = join(home, ".claude");
  mkdirSync(config);
  const file = join(config, ".credentials.json");
  const future = Date.now() + 3_600_000;
  for (const value of ["{", "{}", JSON.stringify({ claudeAiOauth: { accessToken: "", expiresAt: future } }),
    JSON.stringify({ claudeAiOauth: { accessToken: "fixture", expiresAt: Date.now() - 1 } })]) {
    writeFileSync(file, value);
    const state = claudeLoginState(home, {}, "darwin");
    expect(state).toMatchObject({ state: "unknown", store: "macOS Keychain" });
    expect(state.note).not.toMatch(/login command|auth login|unsandboxed|refresh.*mirror/i);
  }
});

test("positive Claude API key and readable fresh file evidence remain reportable", () => {
  expect(claudeLoginState(home, { ANTHROPIC_API_KEY: "fixture" }, "darwin"))
    .toEqual({ state: "logged-in", store: "ANTHROPIC_API_KEY" });
  expect(claudeLoginState(home, { CLAUDE_CODE_OAUTH_TOKEN: "fixture" }, "darwin"))
    .toEqual({ state: "logged-in", store: "CLAUDE_CODE_OAUTH_TOKEN" });
  writeFileSync(join(home, ".claude/.credentials.json"), JSON.stringify({
    claudeAiOauth: { accessToken: "fixture", expiresAt: Date.now() + 3_600_000 },
  }));
  expect(claudeLoginState(home, {}, "darwin"))
    .toEqual({ state: "logged-in", store: "~/.claude/.credentials.json" });
});

test("provider addresses and model names cannot serve as credential evidence", () => {
  expect(envKeyLoginState("aider", { AZURE_API_BASE: "https://example.invalid" }).state).toBe("unknown");
  expect(envKeyLoginState("aider", { AZURE_API_VERSION: "2026-01" }).state).toBe("unknown");
  expect(envKeyLoginState("openhands", { LLM_MODEL: "fixture", LLM_BASE_URL: "https://example.invalid" }).state).toBe("unknown");
  expect(envKeyLoginState("openhands", { LLM_API_KEY: "fixture" }))
    .toEqual({ state: "logged-in", store: "LLM_API_KEY" });
});

test("file evidence never prescribes native relogin", () => {
  expect(remedyFor("claude", "LOGIN-EXPIRED")).toBeNull();
  expect(remedyFor("kimi", "LOGIN-EXPIRED")).toBeNull();
  expect(remedyFor("kimi", "NO-LOGIN")).toBeNull();
});

test("Claude health reads the selected native credential directory", () => {
  const selected = join(home, "selected-profile");
  mkdirSync(selected);
  expect(claudeLoginState(home, { CLAUDE_CONFIG_DIR: selected }, "darwin").state).toBe("unknown");
  writeFileSync(join(selected, ".credentials.json"), JSON.stringify({
    claudeAiOauth: { accessToken: "fixture", expiresAt: Date.now() + 3_600_000 },
  }));
  expect(claudeLoginState(home, { CLAUDE_CONFIG_DIR: selected }, "darwin"))
    .toEqual({ state: "logged-in", store: "configured Claude login directory/.credentials.json" });
  expect(claudeLoginState(home, { CLAUDE_CONFIG_DIR: selected,
    CLAUDE_SECURESTORAGE_CONFIG_DIR: join(home, "missing-profile") }, "darwin").state).toBe("unknown");
});
