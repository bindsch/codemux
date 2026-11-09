import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { OpencodeAdapter } from "../src/adapters/opencode.js";
import type { RunContext } from "../src/adapters/base.js";
import type { AutonomyLevel, RunRequest } from "../src/types.js";
import type { ExecutableCheck } from "../src/executable-security.js";
import { assertExecutablesUnchanged } from "../src/executable-security.js";
import { resolveEffortForAdapter } from "../src/cli-runtime/options.js";
import { opencodeNoWebConfig, opencodePlaywrightConfig } from "../src/opencode-launch-config.js";
import { RUN_DECLARATIONS } from "../src/parity/declarations-run.js";
import { TUI_DECLARATIONS } from "../src/parity/declarations-tui.js";

const fixtures: string[] = [];
afterEach(() => { for (const path of fixtures.splice(0)) rmSync(path, { recursive: true, force: true }); });

function fixture(provider = false, braces = false) {
  const home = mkdtempSync(join(import.meta.dir, "../scratch/fix/opencode-run-"));
  fixtures.push(home);
  const bin = join(home, braces ? "{bin}" : "bin");
  const cwd = join(home, "work");
  mkdirSync(bin); mkdirSync(cwd);
  const binary = join(bin, "playwright-mcp");
  writeFileSync(binary, "#!/bin/sh\nexit 91\n", { mode: 0o755 });
  const env = { HOME: home, PATH: bin, ...(provider ? {
    CODEMUX_OPENCODE_PROVIDER_BASE_URL: "https://provider.invalid/v1",
    CODEMUX_OPENCODE_PROVIDER_API_KEY: "synthetic-secret",
    CODEMUX_OPENCODE_PROVIDER_MODEL: "model-a",
    CODEMUX_OPENCODE_PROVIDER_MAX_CONTEXT_TOKENS: "32000",
    CODEMUX_OPENCODE_PROVIDER_MAX_OUTPUT_TOKENS: "4000",
  } : {}) };
  return { home, bin, cwd, binary, env, adapter: new OpencodeAdapter(env, home) };
}

const configOf = (command: string[]) => JSON.parse(
  command.find((value) => value.startsWith("OPENCODE_CONFIG_CONTENT="))!.slice("OPENCODE_CONFIG_CONTENT=".length)
);
const valueOf = (command: string[], flag: string) => command[command.indexOf(flag) + 1]!;

describe("OpenCode native run and TUI parity", () => {
  test("native none reaches --variant rather than disappearing in CLI normalization", () => {
    const { adapter, cwd } = fixture();
    const effort = resolveEffortForAdapter("opencode", adapter.capabilities(), "none");
    const request: RunRequest = { agent: "opencode", prompt: "p", cwd, effort };
    expect(effort).toBe("none");
    expect(() => adapter.validateRunRequest(request)).not.toThrow();
    expect(valueOf(adapter.buildRunCommand(request), "--variant")).toBe("none");
    expect(RUN_DECLARATIONS.opencode["run.effort.none-native"].state).toBe("supported");
  });

  test.each(["read-only", "low", "medium", "high"] as AutonomyLevel[])(
    "no-web at %s selects a fresh agent whose last rules deny web and delegation", (autonomy) => {
      const { adapter, cwd } = fixture();
      const request: RunRequest = { agent: "opencode", prompt: "p", cwd, web: false, autonomy };
      adapter.validateRunRequest(request);
      const command = adapter.buildRunCommand(request);
      const agent = valueOf(command, "--agent");
      const config = configOf(command);
      expect(agent).toMatch(/^codemux_noweb_[a-f0-9]{32}$/);
      expect(config.agent[agent].permission).toEqual({
        ...(autonomy === "read-only" ? { edit: "deny" } : {}),
        webfetch: "deny", websearch: "deny", task: "deny",
      });
      expect(command.includes("--auto")).toBe(autonomy === "high");
      expect(valueOf(adapter.buildRunCommand(request), "--agent")).not.toBe(agent);
    }
  );

  test("no-web defaults to read-only and its config survives hermetic environment removal", () => {
    const { adapter, cwd } = fixture();
    const noWeb = opencodeNoWebConfig();
    expect(noWeb.config.agent[noWeb.agent]!.permission.edit).toBe("deny");
    const request: RunRequest = { agent: "opencode", prompt: "p", cwd, web: false, hermetic: true };
    const context = adapter.prepareRun(request);
    try {
      const command = adapter.buildRunCommand(request, context);
      expect(command.indexOf("OPENCODE_CONFIG_CONTENT")).toBeLessThan(
        command.findIndex((value) => value.startsWith("OPENCODE_CONFIG_CONTENT=")));
      expect(configOf(command).agent[valueOf(command, "--agent")].permission.edit).toBe("deny");
    } finally { adapter.cleanupRunSync(context); }
  });

  test("Playwright reaches native local MCP config with this build's executable check", () => {
    const { adapter, cwd, binary } = fixture();
    const request: RunRequest = { agent: "opencode", prompt: "p", cwd, sandboxed: true, enablePlaywrightMcp: true };
    adapter.validateRunRequest(request);
    const context: RunContext = {};
    const command = adapter.buildRunCommand(request, context);
    expect(configOf(command).mcp.playwright).toEqual({ type: "local", command: [binary], enabled: true });
    expect(context.playwrightMcpCheck).not.toBeNull();
    writeFileSync(binary, "#!/bin/sh\nexit 92\n");
    expect(() => assertExecutablesUnchanged([], "opencode", undefined, [context.playwrightMcpCheck!])).toThrow();
  });

  test("Playwright rejects untrusted binaries, config substitution, and incompatible flags", () => {
    const { adapter, cwd, binary, bin } = fixture();
    const base: RunRequest = { agent: "opencode", prompt: "p", cwd, enablePlaywrightMcp: true };
    expect(() => adapter.validateRunRequest(base)).toThrow("requires --sandbox");
    expect(() => adapter.validateRunRequest({ ...base, sandboxed: true, hermetic: true })).toThrow("cannot be combined");
    chmodSync(binary, 0o777);
    expect(() => opencodePlaywrightConfig(true, true, bin, cwd)).toThrow();
    const braces = fixture(false, true);
    expect(() => opencodePlaywrightConfig(true, true, braces.bin, braces.cwd)).toThrow("cannot contain braces");
    expect(opencodePlaywrightConfig(false, true, "").check).toBeNull();
    expect(() => opencodePlaywrightConfig(true, true, "")).toThrow("locally installed");
  });

  test("TUI provider override and Playwright config compose without exposing the API key", () => {
    const { adapter, cwd, binary } = fixture(true);
    adapter.validateTuiRequest(undefined, cwd, "read-only", undefined, [], true);
    const checks: ExecutableCheck[] = [];
    const command = adapter.buildTuiCommand(undefined, "read-only", undefined, true, true, cwd, checks);
    const config = configOf(command);
    expect(valueOf(command, "--model")).toBe("codemux/model-a");
    expect(config.mcp.playwright.command).toEqual([binary]);
    expect(config.provider.codemux.models["model-a"].limit).toEqual({ context: 32000, output: 4000 });
    expect(config.provider.codemux.options.apiKey).toBe("{env:CODEMUX_OPENCODE_PROVIDER_API_KEY}");
    expect(command.join(" ")).not.toContain("synthetic-secret");
    expect(adapter.getTuiEnv().CODEMUX_OPENCODE_PROVIDER_API_KEY).toBe("synthetic-secret");
    expect(checks).toHaveLength(1);
    expect(TUI_DECLARATIONS.opencode["tui.provider-override"].state).toBe("supported");
  });

  test("TUI provider validation enforces model and paired token caps", () => {
    const { home, cwd, env } = fixture(true);
    const missing = new OpencodeAdapter({ ...env, CODEMUX_OPENCODE_PROVIDER_MODEL: undefined }, home);
    expect(() => missing.validateTuiRequest(undefined, cwd)).toThrow("needs a model");
    const half = new OpencodeAdapter({ ...env, CODEMUX_OPENCODE_PROVIDER_MAX_OUTPUT_TOKENS: undefined }, home);
    expect(() => half.getTuiEnv()).toThrow("one-sided token cap");
    expect(() => half.buildTuiCommand("{env:MODEL}", "high", undefined, true, true, cwd)).toThrow("must not contain");
    expect(new OpencodeAdapter({ HOME: home, PATH: "" }, home).getTuiEnv()).toEqual({});
  });

  test("late remote configuration refuses native injected settings before preparing files", () => {
    const { adapter, cwd, home } = fixture(true);
    const data = join(home, ".local/share/opencode");
    mkdirSync(data, { recursive: true });
    writeFileSync(join(data, "auth.json"), JSON.stringify({ "https://remote.invalid": { type: "wellknown", key: "unused", token: "unused" } }));
    const request: RunRequest = { agent: "opencode", prompt: "p", cwd, web: false };
    expect(() => adapter.validateRunRequest(request)).toThrow("remote configuration");
    expect(() => adapter.prepareRun(request)).toThrow("remote configuration");
    expect(() => adapter.buildRunCommand(request)).toThrow("remote configuration");
    expect(() => adapter.validateTuiRequest(undefined, cwd)).toThrow("remote configuration");
    expect(() => adapter.getTuiEnv()).toThrow("remote configuration");
  });

  test("native budget absence refuses before launch and model metadata is not served evidence", () => {
    const { adapter, cwd } = fixture();
    expect(() => adapter.validateRunRequest({ agent: "opencode", prompt: "p", cwd, maxBudgetUsd: 1 }))
      .toThrow("opencode has no spend limit flag; --max-budget-usd is unsupported");
    const stdout = JSON.stringify({ type: "text", sessionID: "ses_0123456789abcdef", part: { text: "answer" }, modelID: "requested-only" });
    const result = adapter.processRunResult({ stdout, stderr: "", exitCode: 0, success: true },
      { agent: "opencode", prompt: "p", resultJson: true, model: "requested-only" });
    expect(JSON.parse(result.stdout).codemux.served_model).toBeNull();
    const row = RUN_DECLARATIONS.opencode["run.max-budget-usd"];
    expect(row.state).toBe("harness-limitation");
    if (row.state === "harness-limitation") {
      expect(row.reason).not.toContain("OPEN:");
      expect(row.evidence).toContain("2026-11-09");
    }
  });
});
