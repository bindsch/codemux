import { describe, expect, test } from "bun:test";
import { ZaiAdapter } from "../src/adapters/zai.js";
import { prepareSessionEnvironment } from "../src/session/cli-environment.js";
import type { RunRequest } from "../src/types.js";

const override = {
  CODEMUX_ZAI_PROVIDER_BASE_URL: "http://127.0.0.1:9/gateway/v1",
  CODEMUX_ZAI_PROVIDER_API_KEY: "synthetic-zai-key",
  CODEMUX_ZAI_PROVIDER_MODEL: "local-coder",
  CODEMUX_ZAI_PROVIDER_MAX_OUTPUT_TOKENS: "2048",
  CODEMUX_ZAI_PROVIDER_MAX_CONTEXT_TOKENS: "32768",
};
const request: RunRequest = { agent: "zai", prompt: "hello" };

describe("Zai provider override uses the shared Claude transport", () => {
  test("override replaces the fixed gateway without requiring the Z.AI credential", () => {
    const adapter = new ZaiAdapter({ ...override, ZAI_API_KEY: "unused-fixed-key" });
    expect(adapter.capabilities().supportsProviderOverride).toBe(true);
    expect(() => adapter.validateRunRequest(request)).not.toThrow();
    expect(() => adapter.beforeLaunch()).not.toThrow();
    expect(adapter.configurationIssues()).toEqual([]);
    const env = adapter.getEnv();
    expect(env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:9/gateway");
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe(override.CODEMUX_ZAI_PROVIDER_API_KEY);
    expect(env.CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBe("2048");
    expect(env.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBe("32768");
    for (const key of ["ANTHROPIC_DEFAULT_HAIKU_MODEL", "ANTHROPIC_SMALL_FAST_MODEL",
      "ANTHROPIC_DEFAULT_SONNET_MODEL", "ANTHROPIC_DEFAULT_OPUS_MODEL"]) {
      expect(env[key]).toBe("local-coder");
    }
    expect(adapter.getEnvOmissions()).toEqual(["ZAI_API_KEY", "ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"]);
    expect(new ZaiAdapter(override).getEnv()).toEqual(env);
  });

  test("run and TUI select the override model and preserve explicit model precedence", () => {
    const adapter = new ZaiAdapter(override);
    expect(() => adapter.validateTuiRequest()).not.toThrow();
    for (const args of [adapter.buildRunCommand(request), adapter.buildTuiCommand()]) {
      expect(args[args.indexOf("--model") + 1]).toBe("local-coder");
      expect(JSON.parse(args[args.indexOf("--settings") + 1]!).modelPicker.options[0].model).toBe("local-coder");
      expect(args.join(" ")).not.toContain(override.CODEMUX_ZAI_PROVIDER_API_KEY);
    }
    expect(adapter.resultModel({ ...request, model: "other-coder" })).toBe("other-coder");
    expect(adapter.buildTuiCommand("other-coder")).toContain("other-coder");
  });

  test("missing override fields fail before the fixed Z.AI key lookup", () => {
    const partial = new ZaiAdapter({ CODEMUX_ZAI_PROVIDER_MODEL: "local-coder" });
    expect(() => partial.validateRunRequest(request)).toThrow("CODEMUX_ZAI_PROVIDER_BASE_URL");
    expect(() => partial.validateTuiRequest()).toThrow("CODEMUX_ZAI_PROVIDER_API_KEY");
    expect(partial.providerOverrideIssue()).toContain("CODEMUX_ZAI_PROVIDER_BASE_URL");
    expect(partial.configurationIssues()[0]).toContain("provider override is missing");
    const modelless = new ZaiAdapter({ ...override, CODEMUX_ZAI_PROVIDER_MODEL: "" });
    expect(() => modelless.validateRunRequest(request)).toThrow("zai needs a model for the provider override");
    expect(() => modelless.validateTuiRequest()).toThrow("CODEMUX_ZAI_PROVIDER_MODEL");
    expect(() => modelless.validateRunRequest({ ...request, model: "explicit" })).not.toThrow();
    expect(modelless.getEnv().ANTHROPIC_DEFAULT_OPUS_MODEL).toBeUndefined();
  });

  test("without an override the fixed gateway and default model remain", () => {
    const adapter = new ZaiAdapter({ ZAI_API_KEY: "fixed-key" });
    expect(adapter.getEnv().ANTHROPIC_BASE_URL).toBe("https://api.z.ai/api/anthropic");
    expect(adapter.getEnv().ANTHROPIC_AUTH_TOKEN).toBe("fixed-key");
    expect(adapter.getEnv().CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBeUndefined();
    expect(adapter.resultModel(request)).toBe("opus");
  });

  test("session environment carries endpoint, both caps, and only the override credential", () => {
    const adapter = new ZaiAdapter({ ...override, PATH: "", ANTHROPIC_API_KEY: "unused-api-key",
      CLAUDE_CODE_OAUTH_TOKEN: "unused-oauth-token", ZAI_API_KEY: "unused-fixed-key" });
    const prepared = prepareSessionEnvironment({ adapter, runLike: request, passthroughEnv: [],
      sandboxed: false, sandboxOptions: undefined, override: adapter.providerOverride() });
    const { env } = prepared.buildSessionEnvironment(undefined);
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe(override.CODEMUX_ZAI_PROVIDER_API_KEY);
    expect(env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:9/gateway");
    expect(env.CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBe("2048");
    expect(env.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBe("32768");
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(env.ZAI_API_KEY).toBeUndefined();
  });

  test("served model evidence remains the result envelope's modelUsage", () => {
    const result = new ZaiAdapter(override).processRunResult({ success: true, exitCode: 0, stderr: "", stdout: JSON.stringify({
      type: "result", subtype: "success", is_error: false, result: "hello", modelUsage: {
        "actually-served": { inputTokens: 2, outputTokens: 3 },
      }, usage: { input_tokens: 2, output_tokens: 3 },
    }) }, { ...request, resultJson: true });
    expect(JSON.parse(result.stdout).codemux.served_model).toBe("actually-served");
  });
});
