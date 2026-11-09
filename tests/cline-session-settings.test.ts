import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openClineSessionHome, prepareClineSessionSettings, previewClineSessionSettings } from "../src/session/cline-settings.js";
import { readClineSessionUsage } from "../src/session/cline-history.js";
import type { RunRequest } from "../src/types.js";
import type { ExecutableCheck } from "../src/executable-security.js";
import { ClineAcpTransport } from "../src/session/cline-acp.js";

const roots: string[] = [];
const id = "1794230000000_Ab-12_cli";
const environment = { CODEMUX_CLINE_PROVIDER_BASE_URL: "https://synthetic.invalid/v1", CODEMUX_CLINE_PROVIDER_API_KEY: "synthetic-secret", CODEMUX_CLINE_PROVIDER_MODEL: "exact-model" };
function root(): string {
  mkdirSync("scratch/fix/cline-tests", { recursive: true });
  const path = mkdtempSync(join(process.cwd(), "scratch/fix/cline-tests/run-")); roots.push(path); return path;
}
const request: RunRequest = { agent: "cline", prompt: "prompt", cwd: "/synthetic/work", hermetic: true, autonomy: "low" };
afterEach(() => { for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("Cline session settings and private state", () => {
  test("private paths follow settle and resume without removing native state", () => {
    const state = root(); const home = openClineSessionHome(state);
    const first = prepareClineSessionSettings({ request, prepared: {}, privateHome: home, environment });
    const old = home.dir; writeFileSync(join(old, "native-session-marker"), "persisted"); home.settle(id);
    const second = prepareClineSessionSettings({ request, prepared: {}, privateHome: home, environment });
    expect(second.clineConfig?.env.HOME).toBe(home.dir); expect(second.clineConfig?.env.CLINE_PROVIDER_SETTINGS_PATH).not.toContain(old);
    expect(second.clineConfig?.env.CLINE_API_KEY).toBe("synthetic-secret"); expect(second.clineConfig?.env.CLINE_PROVIDER).toBe("codemux-override");
    expect(second.clineConfig?.env.CLINE_SESSION_BACKEND_MODE).toBe("local");
    first.clineConfig?.finalize(); second.clineConfig?.finalize(); expect(existsSync(home.dir)).toBe(true);
    const resumed = openClineSessionHome(state, id); expect(resumed.dir).toBe(home.dir);
    expect(readFileSync(join(resumed.dir, "native-session-marker"), "utf8")).toBe("persisted");
    expect(resumed.remove()).toBe(true); expect(existsSync(home.dir)).toBe(false);
  });

  test("Playwright and no-web use private files, with exact provider and token caps", () => {
    const home = openClineSessionHome(root());
    const check = { path: "/synthetic/playwright-mcp" } as ExecutableCheck;
    const context = prepareClineSessionSettings({ request: { ...request, model: "explicit", enablePlaywrightMcp: true, web: false },
      prepared: { playwrightMcpCheck: check }, privateHome: home,
      environment: { ...environment, CODEMUX_CLINE_PROVIDER_MAX_OUTPUT_TOKENS: "17", CODEMUX_CLINE_PROVIDER_MAX_CONTEXT_TOKENS: "31" } });
    const env = context.clineConfig!.env;
    const providers = JSON.parse(readFileSync(env.CLINE_PROVIDER_SETTINGS_PATH!, "utf8"));
    expect(providers.providers["codemux-override"].settings).toMatchObject({ model: "explicit", maxTokens: 17, contextWindow: 31 });
    expect(JSON.parse(readFileSync(env.CLINE_GLOBAL_SETTINGS_PATH!, "utf8"))).toMatchObject({ disabledTools: ["fetch_web_content"], tools: { web_search: { enabled: false } } });
    expect(JSON.parse(readFileSync(env.CLINE_MCP_SETTINGS_PATH!, "utf8"))).toMatchObject({ mcpServers: { playwright: { transport: { type: "stdio", command: check.path } } } });
    expect(context.playwrightMcpCheck).toBe(check);
    expect(() => prepareClineSessionSettings({ request: { ...request, enablePlaywrightMcp: true }, prepared: {}, privateHome: home, environment })).toThrow("verified MCP executable");
  });

  test("plain sessions retain prepared file lifecycle and no override uses native auth", () => {
    let finalized = false;
    const prepared = { harnessVersion: "3.0.74", clineConfig: { home: "/prepared", configDir: "/prepared/.cline", env: { CLINE_MCP_SETTINGS_PATH: "/prepared/mcp.json" }, finalize() { finalized = true; } } };
    const context = prepareClineSessionSettings({ request: { ...request, hermetic: false }, prepared, privateHome: null, environment });
    expect(context.clineConfig?.env).toMatchObject({ CLINE_MCP_SETTINGS_PATH: "/prepared/mcp.json", CLINE_API_KEY: "synthetic-secret" });
    context.clineConfig?.finalize(); expect(finalized).toBe(true);
    const plain = prepareClineSessionSettings({ request: { ...request, hermetic: false }, prepared: {}, privateHome: null, environment: {} });
    expect(plain.clineConfig?.env).toEqual({ CLINE_SESSION_BACKEND_MODE: "local" }); plain.clineConfig?.finalize();
  });

  test("preview rebases disposable paths without opening or rewriting resumed state", () => {
    const home = openClineSessionHome(root());
    const prepared = prepareClineSessionSettings({ request, prepared: {}, privateHome: home, environment });
    const target = join(root(), "representative-session");
    const preview = previewClineSessionSettings({ request, prepared, privateDir: target, environment });
    expect(preview.clineConfig?.home).toBe(target); expect(preview.clineConfig?.env.HOME).toBe(target);
    expect(preview.clineConfig?.env.CLINE_PROVIDER_SETTINGS_PATH).toBe(join(target, ".cline/providers.json"));
    expect(preview.clineConfig?.env.CLINE_API_KEY).toBe("synthetic-secret");
    expect(existsSync(target)).toBe(false); preview.clineConfig?.finalize(); expect(existsSync(home.dir)).toBe(true);
    expect(previewClineSessionSettings({ request, prepared, privateDir: null, environment }).clineConfig?.home).toBe(home.dir);
    expect(() => previewClineSessionSettings({ request, prepared: {}, privateDir: target, environment: {} })).toThrow("disposable private settings");
  });
});

describe("Cline history command uses synthetic execution only", () => {
  test("history reads the same private roots with a bounded local command", async () => {
    const usage = await readClineSessionUsage({ sessionId: id, cwd: "/work", home: "/private", env: { CLINE_SESSION_BACKEND_MODE: "auto" },
      execute: async (command, options) => {
        expect(command).toEqual(["cline", "--config", "/private/.cline", "history", "--json", "--limit", "2000"]);
        expect(options.env.CLINE_SESSION_BACKEND_MODE).toBe("local"); expect(options.timeoutMs).toBe(10000);
        return { success: true, exitCode: 0, stderr: "", stdout: JSON.stringify([{ sessionId: id, cwd: "/work", metadata: {
          usage: { inputTokens: 7, outputTokens: 2, cacheReadTokens: 1, cacheWriteTokens: 0 },
        } }]) };
      } });
    expect(usage).toEqual({ input_tokens: 6, output_tokens: 2, cached_input_tokens: 1, total_tokens: 9, cost_usd: null });
  });
  test("failure and exceptions leave usage unknown", async () => {
    expect(await readClineSessionUsage({ sessionId: id, cwd: "/work", env: {}, execute: async (command) => {
      expect(command).not.toContain("--config"); return { success: false, exitCode: 1, stdout: "[]", stderr: "failed" };
    } })).toBeNull();
    expect(await readClineSessionUsage({ sessionId: id, cwd: "/work", env: {}, execute: async () => { throw new Error("synthetic missing binary"); } })).toBeNull();
  });
});

describe("Cline ACP configuration errors", () => {
  test("configuration rejects unknown state, overlapping calls, refused frames and malformed answers", async () => {
    const sent: any[] = []; const errors: Error[] = [];
    let writable = true;
    const t = new ClineAcpTransport({ write: (wire) => { sent.push(JSON.parse(wire)); return writable; }, onUpdate() {}, onFailure: (error) => errors.push(error) });
    const reply = (result: unknown) => t.handleLine(JSON.stringify({ jsonrpc: "2.0", id: sent.at(-1).id, result }));
    await expect(t.configure(undefined, "plan")).rejects.toThrow("not ready");
    const initialized = t.initialize(); reply({ protocolVersion: 1 }); await initialized;
    const opened = t.open({ cwd: "/work" }); reply({ sessionId: id }); await opened;
    const pending = t.configure("model", "act");
    await expect(t.configure("other", "act")).rejects.toThrow("already pending");
    t.handleLine(JSON.stringify({ jsonrpc: "2.0", id: sent.at(-1).id, error: { message: "rejected config" } }));
    await expect(pending).rejects.toThrow("rejected config"); expect(errors[0]!.message).toContain("Cline ACP");
    await expect(t.configure("model", "act")).rejects.toThrow("rejected config"); t.handleLine("ignored after close");
    const w = new ClineAcpTransport({ write: (wire) => { sent.push(JSON.parse(wire)); return writable; }, onUpdate() {} });
    const init = w.initialize(); w.handleLine(JSON.stringify({ jsonrpc: "2.0", id: sent.at(-1).id, result: { protocolVersion: 1 } })); await init;
    const open = w.open({ cwd: "/work" }); w.handleLine(JSON.stringify({ jsonrpc: "2.0", id: sent.at(-1).id, result: { sessionId: id } })); await open;
    writable = false; await expect(w.configure("model", "act")).rejects.toThrow("could not be written");
  });
});
