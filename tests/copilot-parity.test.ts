import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { CopilotAdapter } from "../src/adapters/copilot.js";
import { copilotProvider, copilotProviderEnv, copilotProviderOmissions, createCopilotProviderFile } from "../src/copilot-provider.js";
import { buildCopilotPlaywrightMcp } from "../src/copilot-mcp.js";
import { parseCopilotUsageMetrics, createCopilotUsageFile, readCopilotUsageFile } from "../src/copilot-usage.js";
import { copilotResult, parseCopilotResultEnvelope } from "../src/result-envelope/copilot.js";
import { COPILOT_DRIVER_PROFILE } from "../src/session/copilot-driver.js";
import { buildCopilotSessionCommand } from "../src/session/copilot-session.js";
import type { RunRequest } from "../src/types.js";

const provider = {
  CODEMUX_COPILOT_PROVIDER_BASE_URL: "https://model.example.test/v1",
  CODEMUX_COPILOT_PROVIDER_API_KEY: "synthetic-secret",
  CODEMUX_COPILOT_PROVIDER_MODEL: "configured-model",
  CODEMUX_COPILOT_PROVIDER_MAX_OUTPUT_TOKENS: "1234",
};
const sessionId = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
const request: RunRequest = { agent: "copilot", prompt: "secret prompt", resultJson: true };
const wire = (model: unknown = "actually-served") => [
  { type: "assistant.message", data: { content: "done", model } },
  { type: "result", sessionId, exitCode: 0 },
].map((value) => JSON.stringify(value)).join("\n");
const result = (stdout = wire()) => ({ stdout, stderr: "", exitCode: 0, success: true });
const metrics = (usage = { inputTokens: 20, outputTokens: 3, cacheReadTokens: 4, cacheWriteTokens: 1 }) => ({
  modelMetrics: { "actually-served": { usage, requests: { count: 1, cost: 17 } } },
  totalPremiumRequestCost: 17, totalNanoAiu: 999,
});

describe("copilot provider carriers", () => {
  test("run, session environment, and TUI use the same native BYOK names", () => {
    const adapter = new CopilotAdapter(provider);
    const expected = {
      COPILOT_PROVIDER_BASE_URL: provider.CODEMUX_COPILOT_PROVIDER_BASE_URL,
      COPILOT_PROVIDER_API_KEY: "synthetic-secret",
      COPILOT_PROVIDER_TYPE: "openai",
      COPILOT_MODEL: "configured-model",
      COPILOT_PROVIDER_MAX_OUTPUT_TOKENS: "1234",
    };
    expect(adapter.getRunEnv(request)).toEqual(expected);
    expect(adapter.getTuiEnv()).toEqual(expected);
    expect(adapter.getRunEnv({ ...request, model: "explicit" }).COPILOT_MODEL).toBe("explicit");
    expect(adapter.getTuiEnv("explicit").COPILOT_MODEL).toBe("explicit");
    expect(adapter.buildExecutionEnv(expected).COPILOT_PROVIDER_API_KEY).toBe("synthetic-secret");
    expect(adapter.buildRunCommand(request).join(" ")).not.toContain("synthetic-secret");
    expect(() => adapter.validateRunRequest({ ...request, cwd: tmpdir() })).not.toThrow();
    expect(() => adapter.validateTuiRequest(undefined, tmpdir())).not.toThrow();
  });

  test("native higher-precedence authentication and routing cannot override BYOK", () => {
    const adapter = new CopilotAdapter({ ...provider, COPILOT_PROVIDER_BEARER_TOKEN: "other" });
    const omissions = copilotProviderOmissions(provider);
    expect(omissions).toContain("COPILOT_PROVIDER_BEARER_TOKEN");
    expect(omissions).toContain("COPILOT_PROVIDERS_CONFIG");
    const env = adapter.buildExecutionEnv(adapter.getRunEnv(request), omissions);
    expect(env.COPILOT_PROVIDER_BEARER_TOKEN).toBeUndefined();
  });

  test("local providers may omit a key; absent overrides inject nothing", () => {
    expect(copilotProviderEnv({ ...provider, CODEMUX_COPILOT_PROVIDER_API_KEY: undefined,
      CODEMUX_COPILOT_PROVIDER_MAX_OUTPUT_TOKENS: undefined })).toEqual({
      COPILOT_PROVIDER_BASE_URL: provider.CODEMUX_COPILOT_PROVIDER_BASE_URL,
      COPILOT_PROVIDER_TYPE: "openai", COPILOT_MODEL: "configured-model",
    });
    expect(copilotProvider({})).toBeNull();
    expect(copilotProviderEnv({})).toEqual({});
    expect(copilotProviderOmissions({})).toEqual([]);
    const local = { ...provider, CODEMUX_COPILOT_PROVIDER_API_KEY: undefined,
      CODEMUX_COPILOT_PROVIDER_MAX_OUTPUT_TOKENS: undefined,
      COPILOT_PROVIDER_API_KEY: "ambient-secret", COPILOT_PROVIDER_MAX_OUTPUT_TOKENS: "99999" };
    const adapter = new CopilotAdapter(local);
    const env = adapter.buildExecutionEnv(adapter.getRunEnv(request), adapter.getEnvOmissions());
    expect(env.COPILOT_PROVIDER_API_KEY).toBeUndefined();
    expect(env.COPILOT_PROVIDER_MAX_OUTPUT_TOKENS).toBeUndefined();
  });

  test("half overrides fail before launch", () => {
    expect(() => copilotProvider({ CODEMUX_COPILOT_PROVIDER_MODEL: "model" })).toThrow("BASE_URL");
    expect(() => copilotProvider({ ...provider, CODEMUX_COPILOT_PROVIDER_MODEL: undefined }))
      .toThrow("PROVIDER_MODEL");
  });

  test("context caps use a private native providers.json with a provider-qualified model", () => {
    const home = mkdtempSync(join(tmpdir(), "copilot-provider-test-"));
    try {
      const adapter = new CopilotAdapter({ HOME: home, ...provider,
        CODEMUX_COPILOT_PROVIDER_MAX_CONTEXT_TOKENS: "4000" });
      const context = adapter.prepareRun({ ...request, resultJson: false, model: "explicit" });
      const file = context.copilotProviderFile!;
      const config = JSON.parse(readFileSync(file.path, "utf8"));
      expect(config.providers[0].apiKey).toBe("synthetic-secret");
      expect(config.models[0]).toEqual({ id: "model", provider: "codemux", wireModel: "explicit",
        modelId: "explicit", maxContextWindowTokens: 4000, maxOutputTokens: 1234 });
      expect(statSync(file.path).mode & 0o777).toBe(0o600);
      const command = adapter.buildRunCommand(request, context);
      expect(command).toContain(`COPILOT_PROVIDERS_CONFIG=${file.path}`);
      expect(command).toContain("codemux/model");
      expect(command.join(" ")).not.toContain("synthetic-secret");
      expect(adapter.buildTuiCommand()).toContain("codemux/model");
      const preparedTui = adapter.prepareTuiEnvironment("tui-model", "high", undefined, true);
      const tuiPath = preparedTui.env.COPILOT_PROVIDERS_CONFIG!;
      expect(JSON.parse(readFileSync(tuiPath, "utf8")).models[0].wireModel).toBe("tui-model");
      expect(adapter.buildExecutionEnv(preparedTui.env).COPILOT_PROVIDERS_CONFIG).toBe(tuiPath);
      preparedTui.finalize(); expect(existsSync(tuiPath)).toBe(false);
      const previewTui = adapter.prepareTuiEnvironment("tui-model", "high", undefined, true, [], true);
      expect(existsSync(previewTui.env.COPILOT_PROVIDERS_CONFIG!)).toBe(false); previewTui.finalize();
      const uncappedTui = new CopilotAdapter({}).prepareTuiEnvironment(); expect(uncappedTui.env).toEqual({}); uncappedTui.finalize();
      adapter.cleanupRunSync(context);
      expect(existsSync(file.path)).toBe(false);
      const local = createCopilotProviderFile(join(home, ".copilot"), { baseUrl: "http://127.0.0.1:1234", model: "local" });
      expect(JSON.parse(readFileSync(local.path, "utf8")).providers[0].apiKey).toBeUndefined();
      local.finalize();
      expect(() => createCopilotProviderFile(join(home, ".copilot"), {})).toThrow("endpoint and model");
      const tui = adapter.prepareTuiProvider("tui-model")!;
      const tuiArgv = adapter.buildTuiCommand(undefined, "high", undefined, false, false, home, [], tui);
      expect(tuiArgv).toContain(`COPILOT_PROVIDERS_CONFIG=${tui.path}`);
      expect(tuiArgv).toContain("codemux/model");
      expect(JSON.parse(readFileSync(tui.path, "utf8")).models[0].modelId).toBe("tui-model");
      tui.finalize();
      expect(existsSync(tui.path)).toBe(false);
      const preview = adapter.prepareTuiProvider(undefined, true)!;
      expect(existsSync(preview.path)).toBe(false);
      expect(adapter.buildTuiCommand(undefined, undefined, undefined, true, false, home, [], preview))
        .toContain(`COPILOT_PROVIDERS_CONFIG=${preview.path}`);
      preview.finalize();
      expect(new CopilotAdapter({}).prepareTuiProvider()).toBeUndefined();
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});

describe("copilot prompt and tool carriers", () => {
  test("run and session prompts use stdin and accept prompts above the argv limit", () => {
    const adapter = new CopilotAdapter({});
    const prompt = "x".repeat(150_000);
    expect(() => adapter.validateRunRequest({ ...request, prompt, cwd: tmpdir() })).not.toThrow();
    expect(() => adapter.validateRunRequest({ ...request, prompt: "bad\0text", cwd: tmpdir() }))
      .toThrow("NUL");
    expect(adapter.getStdinInput({ ...request, prompt })).toBe(prompt);
    expect(adapter.buildRunCommand({ ...request, prompt }).join(" ")).not.toContain(prompt);
    expect(COPILOT_DRIVER_PROFILE.promptCarrier).toBe("stdin");
    const command = buildCopilotSessionCommand({ sessionId, firstTurn: false, autonomy: "high", prompt });
    expect(command).toContain("--resume");
    expect(command.join(" ")).not.toContain(prompt);
  });

  test("web denial preserves high autonomy and explicitly denies built-in GitHub search", () => {
    const adapter = new CopilotAdapter({});
    const command = adapter.buildRunCommand({ ...request, autonomy: "high", web: false });
    expect(command).toContain("--allow-all");
    expect(command).toContain("web_fetch");
    expect(command).toContain("web_search");
    expect(command).toContain("github-mcp-server(web_search)");
    expect(command).not.toContain("--disable-builtin-mcps");
    expect(adapter.buildRunCommand(request)).not.toContain("--excluded-tools");
  });

  test("session tools none is reapplied on each resume and default restores discovery", () => {
    const base = { sessionId, firstTurn: false, autonomy: "high" as const, prompt: "next" };
    expect(buildCopilotSessionCommand({ ...base, tools: "none" })).toContain("codemux-no-tools");
    expect(buildCopilotSessionCommand({ ...base, tools: "default" })).not.toContain("--available-tools");
    expect(buildCopilotSessionCommand({ ...base, usageOutputPath: "/usage.json" }))
      .toContain("/usage.json");
  });

  test("MCP uses the native JSON carrier and returns the same executable trust check", () => {
    const built = buildCopilotPlaywrightMcp(true, {
      enabled: true, binaryPath: "/usr/bin/true", forbiddenRoot: process.cwd(), pathEnv: "",
    });
    expect(built.args[0]).toBe("--additional-mcp-config");
    expect(JSON.parse(built.args[1]!)).toEqual({ mcpServers: { playwright: {
      // The trusted spelling is the link's target: /usr/bin/true links to
      // gnutrue on Ubuntu 26.04 (CI run 42681779732).
      type: "stdio", command: realpathSync("/usr/bin/true"), args: [], tools: ["*"],
    } } });
    expect(built.check).not.toBeNull();
    expect(buildCopilotPlaywrightMcp(false, { enabled: true, pathEnv: "" }).args).toEqual([]);
  });
});

describe("copilot reporting", () => {
  test("missing usage cannot hide a native session failure", () => {
    const output = copilotResult(result(JSON.stringify({
      type: "session.error", data: { message: "native failure" },
    })), request, { error: "usage file missing" });
    expect(output.success).toBe(false);
    expect(output.stderr).toContain("native failure");
    expect(output.stderr).not.toContain("usage file missing");
  });
  test("USD budgets are refused instead of mapped to AI credits", () => {
    expect(() => new CopilotAdapter({}).validateRunRequest({ ...request, maxBudgetUsd: 1, cwd: tmpdir() }))
      .toThrow("has no spend limit flag; --max-budget-usd is unsupported");
  });
  test("native model metadata and requested models never claim served identity", () => {
    const subagent = JSON.stringify({ type: "assistant.message", agentId: "child", data: { content: "other", model: "other" } });
    const output = copilotResult(result(`${wire()}\n${subagent}`), { ...request, model: "requested" });
    expect(output.success).toBe(true);
    expect(output.servedModel).toBeNull();
    expect(JSON.parse(output.stdout).codemux.served_model).toBeNull();
    expect(JSON.parse(output.stdout).codemux.model).toBe("requested");
    expect(JSON.parse(output.stdout).content).toBe("done");
    expect(parseCopilotResultEnvelope(wire())?.nativeModel).toBe("actually-served");
    for (const missing of [null, "", 23]) {
      expect(copilotResult(result(wire(missing)), request).success).toBe(true);
    }
  });

  test("the integrated profile builds stdin turns and reports wire models and errors", () => {
    const input = { text: "hello", sessionId, firstTurn: true, hermeticHome: null,
      autonomy: "high" as const };
    expect(COPILOT_DRIVER_PROFILE.buildTurnCommand(input)).toContain("--session-id");
    expect(() => COPILOT_DRIVER_PROFILE.buildTurnCommand({ ...input, sessionId: null })).toThrow("minted");
    const parse = COPILOT_DRIVER_PROFILE.parseTurnOutput!;
    expect(parse(wire(), sessionId).modelEffective).toBeNull();
    expect(parse(wire().replace('"exitCode":0', '"exitCode":1'), sessionId).failed).toBe(true);
    expect(parse("no wire", sessionId).noWire).toBe(true);
    expect(() => parse(wire(), null)).toThrow("minted");
  });

  test("normalizes token metrics without treating credits or premium multipliers as USD", () => {
    expect(parseCopilotUsageMetrics(metrics())).toEqual({
      input_tokens: 15, output_tokens: 3, cached_input_tokens: 5, total_tokens: 23, cost_usd: null,
    });
    const multiple = metrics();
    Object.assign(multiple.modelMetrics, { second: { usage: {
      inputTokens: 2, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0,
    } } });
    expect(parseCopilotUsageMetrics(multiple).total_tokens).toBe(26);
  });

  test("rejects missing, inconsistent, fractional, and overflowed metrics", () => {
    for (const invalid of [null, [], {}, { modelMetrics: {} }, { modelMetrics: { a: {} } }]) {
      expect(() => parseCopilotUsageMetrics(invalid)).toThrow();
    }
    expect(() => parseCopilotUsageMetrics(metrics({ inputTokens: 2, outputTokens: 1, cacheReadTokens: 3, cacheWriteTokens: 0 }))).toThrow("inconsistent");
    expect(() => parseCopilotUsageMetrics(metrics({ inputTokens: 2.5, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }))).toThrow("invalid");
    expect(() => parseCopilotUsageMetrics(metrics({ inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }))).toThrow("safe integer");
  });

  test("run preparation, file parsing, and cleanup carry usage through the envelope", () => {
    const home = mkdtempSync(join(tmpdir(), "copilot-usage-test-"));
    try {
      const adapter = new CopilotAdapter({ HOME: home });
      const context = adapter.prepareRun({ ...request, hermetic: true });
      const file = context.copilotUsageFile!;
      expect(adapter.buildRunCommand(request, context)).toContain(file.path);
      writeFileSync(file.path, JSON.stringify(metrics()));
      const output = adapter.processRunResult(result(), request, context);
      expect(output.success).toBe(true);
      expect(output.usage?.total_tokens).toBe(23);
      expect(JSON.parse(output.stdout).codemux.usage.total_tokens).toBe(23);
      adapter.cleanupRunSync(context);
      adapter.cleanupRunSync(context);
      expect(existsSync(dirname(file.path))).toBe(false);
      expect(existsSync(context.copilotHermeticHome!.home)).toBe(false);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test("missing usage file fails a prepared reporting run; preview creates no usage artifact", () => {
    const home = mkdtempSync(join(tmpdir(), "copilot-usage-test-"));
    try {
      const adapter = new CopilotAdapter({ HOME: home });
      const context = adapter.prepareRun(request);
      const output = adapter.processRunResult(result(), request, context);
      expect(output.success).toBe(false);
      expect(output.stderr).toContain("usage output is missing or invalid");
      adapter.cleanupRunSync(context);
      const preview = adapter.prepareRun(request, undefined, undefined, { printOnly: true });
      expect(preview.printOnly).toBe(true);
      expect(adapter.buildRunCommand(request, preview)).toContain("--headless");
      expect(existsSync(preview.copilotUsageFile!.path)).toBe(false);
      adapter.cleanupRunSync(preview);
      expect(adapter.processRunResult(result("plain"), { ...request, resultJson: false }).stdout).toBe("plain");
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test("usage reads refuse symlinks and oversized files", () => {
    const home = mkdtempSync(join(tmpdir(), "copilot-usage-test-"));
    try {
      const file = createCopilotUsageFile(join(home, ".copilot"));
      const target = join(home, "target.json");
      writeFileSync(target, JSON.stringify(metrics()));
      symlinkSync(target, file.path);
      expect(() => readCopilotUsageFile(file)).toThrow("symbolic link");
      file.finalize();
      const large = createCopilotUsageFile(join(home, ".copilot"));
      writeFileSync(large.path, " ".repeat(1024 * 1024 + 1));
      expect(() => readCopilotUsageFile(large)).toThrow("exceeds");
      large.finalize();
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});
