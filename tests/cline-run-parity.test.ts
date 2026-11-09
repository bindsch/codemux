import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ClineAdapter } from "../src/adapters/cline.js";
import { clineProvider, clineProviderFile, createClineConfig, populateClineConfig } from "../src/cline-config.js";
import { validateClineProjectSettings } from "../src/cline-project-settings.js";
import { prepareClineTuiLaunch } from "../src/cline-tui.js";
import type { SandboxOptions } from "../src/sandbox.js";

let root: string;
let env: NodeJS.ProcessEnv;
const source = resolve(import.meta.dir, "fixtures/live/fake-cline-parity.ts");
beforeEach(() => {
  mkdirSync("scratch/fix/w1-fixtures", { recursive: true });
  root = mkdtempSync(resolve("scratch/fix/w1-fixtures/cline-"));
  mkdirSync(join(root, "home"));
  mkdirSync(join(root, "cwd"));
  mkdirSync(join(root, "cwd", ".git"));
  mkdirSync(join(root, "bin"));
  const fake = join(root, "bin", "cline");
  const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
  writeFileSync(fake, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(source)} "$@"\n`);
  chmodSync(fake, 0o700);
  env = { PATH: join(root, "bin"), HOME: join(root, "home"),
    CODEMUX_CLINE_PROVIDER_BASE_URL: "https://gateway.example/v1",
    CODEMUX_CLINE_PROVIDER_API_KEY: "fixture-key", CODEMUX_CLINE_PROVIDER_MODEL: "fixture-model",
    CODEMUX_CLINE_PROVIDER_MAX_OUTPUT_TOKENS: "256", CODEMUX_CLINE_PROVIDER_MAX_CONTEXT_TOKENS: "8192" };
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("Cline provider and hermetic configuration", () => {
  test("disables both native web channels while preserving ordinary settings", () => {
    const sourceDir = join(root, "home", ".cline");
    mkdirSync(join(sourceDir, "data", "settings"), { recursive: true });
    const source = join(sourceDir, "data", "settings", "global-settings.json");
    const original = JSON.stringify({ disabledTools: ["editor"], disabledPlugins: ["custom"], tools: { web_search: { enabled: true } } });
    writeFileSync(source, original);
    const adapter = new ClineAdapter(env);
    const request = { agent: "cline" as const, prompt: "p", web: false };
    const context = adapter.prepareRun(request);
    try {
      const value = JSON.parse(readFileSync(adapter.getRunEnv(request, context).CLINE_GLOBAL_SETTINGS_PATH!, "utf8"));
      expect(value.disabledTools).toEqual(["editor", "fetch_web_content"]);
      expect(value.disabledPlugins).toEqual(["custom"]);
      expect(value.tools.web_search.enabled).toBe(false);
      expect(readFileSync(source, "utf8")).toBe(original);
    } finally { adapter.cleanupRunSync(context); }
    writeFileSync(source, "[]");
    expect(() => adapter.prepareRun(request)).toThrow("must be an object");
    writeFileSync(source, JSON.stringify({ disabledTools: [42] }));
    expect(() => adapter.prepareRun(request)).toThrow("array of tool names");
    writeFileSync(source, JSON.stringify({ tools: [] }));
    expect(() => adapter.prepareRun(request)).toThrow("section must be an object");
  });

  test("writes pinned Playwright settings and preserves other MCP servers", () => {
    const binary = join(root, "bin", "playwright-mcp");
    writeFileSync(binary, "#!/bin/sh\nexit 0\n");
    chmodSync(binary, 0o700);
    const sourceDir = join(root, "home", ".cline");
    mkdirSync(join(sourceDir, "data", "settings"), { recursive: true });
    const source = join(sourceDir, "data", "settings", "cline_mcp_settings.json");
    writeFileSync(source, JSON.stringify({ mcpServers: { existing: { command: "fixture" } } }));
    const adapter = new ClineAdapter(env);
    const request = { agent: "cline" as const, prompt: "p", sandboxed: true, enablePlaywrightMcp: true, cwd: join(root, "cwd") };
    const context = adapter.prepareRun(request);
    try {
      const settings = JSON.parse(readFileSync(adapter.getRunEnv(request, context).CLINE_MCP_SETTINGS_PATH!, "utf8"));
      expect(settings.mcpServers.existing.command).toBe("fixture");
      expect(settings.mcpServers.playwright.command).toBe(binary);
      expect(context.playwrightMcpCheck).not.toBeNull();
    } finally { adapter.cleanupRunSync(context); }
  });

  test("refreshes settled private configuration without losing session data", () => {
    const home = join(root, "home");
    const first = populateClineConfig(home, env, { hermetic: true });
    writeFileSync(join(first.configDir, "session-fixture"), "keep");
    const second = populateClineConfig(home, env, { hermetic: true, model: "next" });
    expect(readFileSync(join(second.configDir, "session-fixture"), "utf8")).toBe("keep");
    expect(readFileSync(second.env.CLINE_PROVIDER_SETTINGS_PATH!, "utf8")).toContain('"model":"next"');
  });

  test("the TUI MCP helper retains its own executable identity and cleans settings", () => {
    const binary = join(root, "bin", "playwright-mcp");
    writeFileSync(binary, "#!/bin/sh\nexit 0\n");
    chmodSync(binary, 0o700);
    const adapter = new ClineAdapter(env);
    const input = { cwd: join(root, "cwd"), sandboxed: true, enablePlaywrightMcp: true };
    const policy: SandboxOptions = { trust: "untrusted" };
    const launch = prepareClineTuiLaunch(adapter, input, policy);
    expect(launch.command).toContain("--tui");
    expect(launch.playwrightCheck?.path).toBe(binary);
    expect(readFileSync(launch.env.CLINE_MCP_SETTINGS_PATH!, "utf8")).toContain(binary);
    expect(policy.harnessStateDirs).toHaveLength(1);
    expect(launch.env.CLINE_MCP_SETTINGS_PATH).toStartWith(policy.harnessStateDirs![0]! + "/");
    launch.cleanup();
    expect(existsSync(launch.env.CLINE_MCP_SETTINGS_PATH!)).toBe(false);
    expect(() => prepareClineTuiLaunch(adapter, {})).toThrow("requires sandboxed Playwright");
    const failure = spyOn(adapter, "buildTuiCommand").mockImplementation(() => { throw new Error("synthetic failure"); });
    const cleanup = spyOn(adapter, "cleanupRunSync");
    try { expect(() => prepareClineTuiLaunch(adapter, input)).toThrow("synthetic failure"); expect(cleanup).toHaveBeenCalledTimes(1); }
    finally { failure.mockRestore(); cleanup.mockRestore(); }
  });

  test("generated sandbox state is allowed without overriding caller blocks", () => {
    const adapter = new ClineAdapter(env);
    const request = { agent: "cline" as const, prompt: "p", cwd: join(root, "cwd"), sandboxed: true };
    for (const trust of ["standard", "untrusted"] as const) {
      for (const hermetic of [false, true]) {
        const policy: SandboxOptions = { trust, harnessStateDirs: [join(root, "already-allowed")], blockPaths: [join(root, "blocked")] };
        const context = adapter.prepareRun({ ...request, hermetic }, trust, policy);
        try {
          expect(policy.harnessStateDirs).toEqual([join(root, "already-allowed"), context.clineConfig!.home]);
          expect(policy.blockPaths).toEqual([join(root, "blocked")]);
        } finally { adapter.cleanupRunSync(context); }
      }
    }
    const policy: SandboxOptions = { trust: "untrusted", blockPaths: [join(root, "home/.cline")] };
    expect(() => adapter.prepareRun(request, policy.trust, policy)).toThrow("sandbox-block");
    expect(policy.harnessStateDirs).toBeUndefined();
    expect(readdirSync(join(root, "home/.cline/.codemux-hermetic"))).toEqual([]);
    const plain: SandboxOptions = { trust: "untrusted" };
    expect(new ClineAdapter({}).prepareRun(request, plain.trust, plain)).toEqual({});
    expect(plain.harnessStateDirs).toBeUndefined();
  });

  test("bounds project settings to a sandboxed fixture at low autonomy", () => {
    const request = { agent: "cline", hermetic: true, sandbox: true, autonomy: "low", cwd: join(root, "cwd") };
    expect(() => validateClineProjectSettings(request)).not.toThrow();
    for (const extra of [{ hermetic: false }, { sandbox: false }, { autonomy: "high" }, { tools: "none" },
      { experimentMcp: "fixture" }, { passthroughEnv: ["CLINE_DIR"] }]) {
      expect(() => validateClineProjectSettings({ ...request, ...extra })).toThrow("--experiment-project-settings");
    }
    mkdirSync(join(request.cwd, "child"));
    expect(() => validateClineProjectSettings({ ...request, cwd: join(request.cwd, "child") })).toThrow("fixture repository root");
    expect(() => validateClineProjectSettings({ ...request, cwd: "/" })).not.toThrow();
  });

  test("symlink cwd cannot conceal native repository-root instructions or project hooks", () => {
    const nested = join(root, "cwd", "nested"), alias = join(root, "alias");
    mkdirSync(nested); symlinkSync(nested, alias);
    writeFileSync(join(root, "cwd", "AGENTS.md"), "ancestor instructions");
    expect(() => new ClineAdapter(env).validateRunRequest({ agent: "cline", prompt: "p", cwd: alias, hermetic: true }))
      .toThrow("clean working directory");
    expect(() => validateClineProjectSettings({ agent: "cline", hermetic: true, sandbox: true, autonomy: "low", cwd: alias }))
      .toThrow("fixture repository root");
  });
  test("requires a tool-free custom provider and refuses native dollar budgets", () => {
    const adapter = new ClineAdapter({});
    const request = { agent: "cline" as const, prompt: "p", cwd: join(root, "cwd") };
    expect(() => adapter.validateRunRequest({ ...request, tools: "none" })).toThrow("requires an explicit custom provider override");
    expect(() => adapter.validateRunRequest({ ...request, maxBudgetUsd: 1 })).toThrow("has no spend limit flag");
  });
  test("maps both caps and the OpenAI chat endpoint into an owned provider file", () => {
    const parsed = JSON.parse(clineProviderFile(env));
    expect(parsed.providers["codemux-override"].settings).toEqual({ provider: "codemux-override",
      model: "fixture-model", baseUrl: "https://gateway.example/v1", apiKey: "fixture-key",
      protocol: "openai-chat", client: "openai-compatible", maxTokens: 256, contextWindow: 8192 });
    expect(JSON.parse(clineProviderFile({ ...env, CODEMUX_CLINE_PROVIDER_MAX_OUTPUT_TOKENS: "",
      CODEMUX_CLINE_PROVIDER_MAX_CONTEXT_TOKENS: "" }, "selected")).providers["codemux-override"].settings.model).toBe("selected");
    expect(clineProvider({})).toBeNull();
    expect(() => clineProviderFile({})).toThrow("require a provider override");
    expect(() => clineProvider({ CODEMUX_CLINE_PROVIDER_BASE_URL: "https://gateway.example" })).toThrow();
  });

  test("carries a private provider in plain runs without changing HOME", () => {
    const adapter = new ClineAdapter(env);
    const request = { agent: "cline" as const, prompt: "private prompt", cwd: join(root, "cwd"), autonomy: "high" as const };
    adapter.validateRunRequest(request);
    const context = adapter.prepareRun(request);
    try {
      const variables = adapter.getRunEnv(request, context);
      expect(variables.HOME).toBeUndefined();
      expect(readFileSync(variables.CLINE_PROVIDER_SETTINGS_PATH!, "utf8")).toContain("fixture-key");
      expect(statSync(variables.CLINE_PROVIDER_SETTINGS_PATH!).mode & 0o777).toBe(0o600);
      expect(adapter.buildRunCommand(request, context).join(" ")).not.toContain("fixture-key");
      expect(adapter.resultModel(request)).toBe("fixture-model");
      expect(adapter.providerOverrideIssue()).toBeNull();
    } finally { adapter.cleanupRunSync(context); adapter.cleanupRunSync(context); }
    expect(existsSync(context.clineConfig!.home)).toBe(false);
  });

  test("isolates global customization and all state overrides for hermetic runs", () => {
    const adapter = new ClineAdapter(env);
    const request = { agent: "cline" as const, prompt: "p", cwd: join(root, "cwd"), hermetic: true };
    adapter.validateRunRequest(request);
    const context = adapter.prepareRun(request);
    try {
      const variables = adapter.getRunEnv(request, context);
      expect(variables.HOME).toBe(context.clineConfig!.home);
      expect(variables.CLINE_SESSION_BACKEND_MODE).toBe("local");
      expect(variables.CLINE_TASKS_DB_PATH).toStartWith(context.clineConfig!.home);
      expect(adapter.buildRunCommand(request, context)).toContain(context.clineConfig!.configDir);
      expect(JSON.parse(readFileSync(variables.CLINE_MCP_SETTINGS_PATH!, "utf8"))).toEqual({ mcpServers: {} });
    } finally { adapter.cleanupRunSync(context); }
    // A context without a prepared configuration refuses. Static verify
    // passes no context at all and gets an unprepared placeholder (no state
    // written); a launch from that argv would still stop at getRunEnv.
    expect(() => adapter.buildRunCommand(request, {})).toThrow("no prepared configuration");
    const placeholder = adapter.buildRunCommand(request);
    expect(placeholder.find((arg) => arg.startsWith("HOME="))).toEndWith("/.cline/.codemux-unprepared");
    expect(placeholder[placeholder.indexOf("--config") + 1]).toEndWith("/.cline/.codemux-unprepared/.cline");
    expect(() => adapter.getRunEnv(request)).toThrow("no prepared configuration");
    expect(() => adapter.getRunEnv(request, {})).toThrow("no prepared configuration");
  });

  test("refuses unisolated project instructions and missing hermetic credentials", () => {
    const adapter = new ClineAdapter(env);
    const request = { agent: "cline" as const, prompt: "p", hermetic: true, cwd: join(root, "cwd") };
    expect(() => adapter.validateRunRequest({ ...request, cwd: undefined })).toThrow("explicit --cwd");
    expect(() => new ClineAdapter({}).validateRunRequest(request)).toThrow("requires a provider override");
    expect(() => createClineConfig(join(root, "home", ".cline"), {}, { hermetic: true })).toThrow("requires a provider override");
    writeFileSync(join(request.cwd, "AGENTS.md"), "private instructions");
    expect(() => adapter.validateRunRequest(request)).toThrow("clean working directory");
  });

  test("gives TUI overrides the same private file lifecycle", () => {
    const adapter = new ClineAdapter(env);
    adapter.validateTuiRequest(undefined, join(root, "cwd"), "high");
    const prepared = adapter.prepareTuiEnvironment("selected");
    try {
      expect(adapter.buildTuiCommand()).toContain("codemux-override");
      expect(readFileSync(prepared.env.CLINE_PROVIDER_SETTINGS_PATH!, "utf8")).toContain('"model":"selected"');
    } finally { prepared.finalize(); }
    expect(existsSync(prepared.env.CLINE_PROVIDER_SETTINGS_PATH!)).toBe(false);
    expect(new ClineAdapter({}).prepareTuiEnvironment().env).toEqual({});
    new ClineAdapter({}).prepareTuiEnvironment().finalize();
    expect(new ClineAdapter({}).prepareRun({ agent: "cline", prompt: "p" })).toEqual({});
    expect(new ClineAdapter({}).getRunEnv({ agent: "cline", prompt: "p" })).toEqual({});
  });

  test("runs a fake binary on a fake PATH with prompt bytes on stdin", async () => {
    const adapter = new ClineAdapter(env);
    const request = { agent: "cline" as const, prompt: "answer from stdin", cwd: join(root, "cwd"), resultJson: true };
    const context = adapter.prepareRun(request);
    try {
      const command = adapter.resolveExecutionCommand(adapter.buildRunCommand(request, context), request.cwd);
      expect(adapter.promptInArgv(request)).toBe(false);
      expect(command).not.toContain(request.prompt);
      const child = Bun.spawn(command, { cwd: request.cwd, env: adapter.buildExecutionEnv(adapter.getRunEnv(request, context)),
        stdin: "pipe", stdout: "pipe", stderr: "pipe" });
      child.stdin.write(adapter.getStdinInput(request));
      child.stdin.end();
      const stdout = await new Response(child.stdout).text();
      const stderr = await new Response(child.stderr).text();
      const exitCode = await child.exited;
      expect(exitCode).toBe(0);
      const result = adapter.processRunResult({ stdout, stderr, exitCode, success: true }, request);
      expect(JSON.parse(result.stdout).text).toBe(request.prompt);
      expect(result.usage?.cost_usd).toBe(0.25);
    } finally { adapter.cleanupRunSync(context); }
  });
});
