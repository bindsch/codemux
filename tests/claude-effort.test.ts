import { describe, expect, test } from "bun:test";
import { ClaudeAdapter } from "../src/adapters/claude.js";
import { ZaiAdapter } from "../src/adapters/zai.js";
import { CLAUDE_NONE_MODELS, claudeEffortFlags, validateClaudeEffort } from "../src/claude-effort.js";
import { claudeProviderPickerSettings } from "../src/claude-family.js";
import { buildClaudeSessionCommand } from "../src/session/claude-session.js";

const MESSAGE = "requires a verified thinking-disable model";
const MODEL = "claude-sonnet-5";

describe("Claude native thinking disable", () => {
  test("maps native none independently of the token budget and preserves other effort flags", () => {
    expect(claudeEffortFlags("none")).toEqual(["--thinking", "disabled"]);
    for (const level of ["low", "medium", "high", "xhigh", "max"] as const) {
      expect(claudeEffortFlags(level)).toEqual(["--effort", level]);
    }
    for (const model of CLAUDE_NONE_MODELS) {
      expect(() => validateClaudeEffort({ agent: "claude", model, effort: "none" })).not.toThrow();
    }
    expect(() => validateClaudeEffort({ agent: "claude" })).not.toThrow();
    expect(() => validateClaudeEffort({ agent: "claude", effort: "high" })).not.toThrow();
  });

  test("refuses unresolved aliases, always-on models, and unverified native spellings", () => {
    for (const model of [undefined, "opus", "sonnet", "haiku", "fable", "mythos", "default", "auto",
      "opus[1m]", "claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5",
      "claude-fable-5", "claude-mythos-5", "claude-sonnet-5-20261001", "Claude-sonnet-5", "unknown"]) {
      expect(() => validateClaudeEffort({ agent: "claude", effort: "none", model })).toThrow(MESSAGE);
    }
  });

  test("requires the exact owned picker for a provider model and prevents native picker bypasses", () => {
    const model = "vendor/model";
    const providerSettings = claudeProviderPickerSettings(model);
    expect(() => validateClaudeEffort({ agent: "zai", effort: "none", model, providerSettings })).not.toThrow();
    for (const invalid of [undefined, "{}", claudeProviderPickerSettings("another-model")]) {
      expect(() => validateClaudeEffort({ agent: "zai", effort: "none", model, providerSettings: invalid })).toThrow(MESSAGE);
    }
    for (const unsafe of ["claude-fable-5", "Claude-opus-5-5", "opus", "fable"]) {
      expect(() => validateClaudeEffort({ agent: "claude", effort: "none", model: unsafe,
        providerSettings: claudeProviderPickerSettings(unsafe) })).toThrow(MESSAGE);
    }
  });

  test("refuses explicit transport/body overrides and allows budget passthrough", () => {
    for (const name of ["CLAUDE_CODE_EXTRA_BODY", "CLAUDE_CODE_MODEL_CATALOG", "CLAUDE_CODE_DISABLE_THINKING",
      "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY",
      "CLAUDE_CODE_USE_ANTHROPIC_AWS", "CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD", "CLAUDE_CODE_USE_MANTLE"]) {
      expect(() => validateClaudeEffort({ agent: "claude", effort: "none", model: MODEL,
        passthroughEnv: [name] })).toThrow(`--pass-env ${name}`);
    }
    expect(() => validateClaudeEffort({ agent: "claude", effort: "none", model: MODEL,
      passthroughEnv: ["MAX_THINKING_TOKENS"] })).not.toThrow();
  });

  for (const agent of ["claude", "zai"] as const) {
    const adapter = agent === "claude" ? new ClaudeAdapter({ MAX_THINKING_TOKENS: "12000" })
      : new ZaiAdapter({ ZAI_API_KEY: "synthetic-key", MAX_THINKING_TOKENS: "12000" });
    test(`${agent} keeps public none closed while its owned builders carry the native mode`, () => {
      expect(adapter.capabilities().effortLevels).not.toContain("none");
      expect(() => adapter.validateRunRequest({ agent, prompt: "x", model: MODEL, effort: "none" })).toThrow("does not support reasoning effort");
      expect(() => adapter.validateTuiRequest(MODEL, undefined, undefined, "none")).toThrow("does not support reasoning effort");
      const commands = [{}, { hermetic: true }, { resultJson: true }].map((extra) =>
        adapter.buildRunCommand({ agent, prompt: "x", model: MODEL, effort: "none", ...extra }));
      commands.push(adapter.buildTuiCommand(MODEL, undefined, "none"));
      commands.push(buildClaudeSessionCommand({ agent, autonomy: "low", model: MODEL,
        effort: "none", pathEnv: "" }).argv);
      for (const argv of commands) {
        expect(argv.filter((value) => value === "--thinking")).toHaveLength(1);
        expect(argv[argv.indexOf("--thinking") + 1]).toBe("disabled");
        expect(argv).not.toContain("--effort");
        expect(argv).not.toContain("--max-thinking-tokens");
      }
    });

    test(`${agent} refuses invalid none before direct builds or request validation`, () => {
      expect(() => adapter.validateRunRequest({ agent, prompt: "x", effort: "none" })).toThrow("does not support reasoning effort");
      expect(() => adapter.validateTuiRequest(undefined, undefined, undefined, "none")).toThrow("does not support reasoning effort");
      expect(() => adapter.buildRunCommand({ agent, prompt: "x", effort: "none" })).toThrow(MESSAGE);
      expect(() => adapter.buildTuiCommand(undefined, undefined, "none")).toThrow(MESSAGE);
      expect(() => adapter.validateRunRequest({ agent, prompt: "x", model: MODEL, effort: "none",
        passthroughEnv: ["CLAUDE_CODE_EXTRA_BODY"] })).toThrow("does not support reasoning effort");
      expect(() => adapter.validateTuiRequest(MODEL, undefined, undefined, "none", ["CLAUDE_CODE_USE_VERTEX"]))
        .toThrow("does not support reasoning effort");
    });

    test(`${agent} keeps omitted effort unchanged and carries an owned provider picker`, () => {
      const plain = adapter.buildRunCommand({ agent, prompt: "x" });
      expect(plain).not.toContain("--thinking");
      expect(plain).not.toContain("--effort");
      const provider = adapter.buildRunCommand({ agent, prompt: "x", model: "vendor/model", effort: "none" });
      expect(provider[provider.indexOf("--settings") + 1]).toBe(claudeProviderPickerSettings("vendor/model"));
      expect(provider).toContain("--thinking");
      expect(adapter.buildTuiCommand("vendor/model", undefined, "none")).toContain("--thinking");
    });
  }

  test("provider override fallback supplies a compatible model without a request model", () => {
    for (const agent of ["claude", "zai"] as const) {
      const environment = {
        [`CODEMUX_${agent.toUpperCase()}_PROVIDER_BASE_URL`]: "https://provider.test/v1",
        [`CODEMUX_${agent.toUpperCase()}_PROVIDER_API_KEY`]: "synthetic-key",
        [`CODEMUX_${agent.toUpperCase()}_PROVIDER_MODEL`]: "vendor/model",
      };
      const adapter = agent === "claude" ? new ClaudeAdapter(environment) : new ZaiAdapter(environment);
      expect(adapter.buildRunCommand({ agent, prompt: "x", effort: "none" })).toContain("--thinking");
    }
  });

  test("session builders verify provider settings and refuse unproven resume models", () => {
    const command = { agent: "claude" as const, autonomy: "low" as const, effort: "none" as const,
      model: "vendor/model", pathEnv: "", resumeId: "synthetic-session" };
    expect(() => buildClaudeSessionCommand(command)).toThrow(MESSAGE);
    const argv = buildClaudeSessionCommand({ ...command,
      providerSettings: claudeProviderPickerSettings(command.model) }).argv;
    expect(argv).toContain("--resume");
    expect(argv).toContain("--thinking");
    expect(() => buildClaudeSessionCommand({ ...command, model: MODEL,
      passthroughEnv: ["CLAUDE_CODE_EXTRA_BODY"] })).toThrow("--pass-env CLAUDE_CODE_EXTRA_BODY");
  });
});
