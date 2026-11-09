import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunContext } from "../src/adapters/base.js";
import { CodexAdapter } from "../src/adapters/codex.js";
import { assertNoCodexStoreKnob } from "../src/codex-provider.js";
import type { RunRequest } from "../src/types.js";

// How each adapter translates a provider override
// (CODEMUX_<AGENT>_PROVIDER_{BASE_URL,API_KEY,MODEL}) into what the harness
// consumes. The key must travel in the environment or a private file, never
// in argv; assertions check the command carries no key.

const VLLM_CODEX = {
  CODEMUX_CODEX_PROVIDER_BASE_URL: "http://localhost:8011/v1",
  CODEMUX_CODEX_PROVIDER_API_KEY: "test-key-do-not-print",
  CODEMUX_CODEX_PROVIDER_MODEL: "clawvm-qwen32b-coder",
};

describe("codex provider override", () => {
  const scratch: string[] = [];
  const prepared: { adapter: CodexAdapter; context: RunContext }[] = [];
  afterEach(() => {
    for (const { adapter, context } of prepared.splice(0)) adapter.cleanupRun(context);
    while (scratch.length > 0) {
      const dir = scratch.pop()!;
      rmSync(dir, { recursive: true, force: true });
    }
  });
  const cwdOf = (): string => {
    const cwd = mkdtempSync(join(tmpdir(), "codemux-codex-override-"));
    mkdirSync(join(cwd, ".git"));
    scratch.push(cwd);
    return cwd;
  };
  const adapterOf = (env: NodeJS.ProcessEnv = {}): CodexAdapter => {
    const home = mkdtempSync(join(tmpdir(), "codemux-codex-home-"));
    scratch.push(home);
    return new CodexAdapter(env, home);
  };
  const prepare = (adapter: CodexAdapter, request: RunRequest): RunContext => {
    const context = adapter.prepareRun(request);
    prepared.push({ adapter, context });
    return context;
  };
  const codexHomeOf = (cmd: string[]): string | undefined =>
    cmd.find((part) => part.startsWith("CODEX_HOME="))?.slice("CODEX_HOME=".length);
  const configOf = (context: RunContext): string =>
    readFileSync(join(context.codexProviderHome!.codexHome, "config.toml"), "utf8");

  test("without an override nothing changes", () => {
    const adapter = adapterOf();
    expect(adapter.getRunEnv({ agent: "codex", prompt: "p", cwd: cwdOf() } as RunRequest))
      .toEqual({});
    expect(adapter.getEnvOmissions()).toEqual([]);
    const cmd = adapter.buildRunCommand({
      agent: "codex",
      prompt: "p",
      cwd: cwdOf(),
      model: "gpt-5.4-codex",
    } as RunRequest);
    expect(cmd).toContain("-m");
  });

  test("the override rides a private CODEX_HOME whose config.toml carries the provider", () => {
    const adapter = adapterOf(VLLM_CODEX);
    const request: RunRequest = { agent: "codex", prompt: "p", cwd: cwdOf() };
    const context = prepare(adapter, request);
    const cmd = adapter.buildRunCommand(request, context);
    expect(cmd[0]).toBe("env");
    const home = codexHomeOf(cmd)!;
    expect(home).toContain(join(".codex", ".codemux-provider", `run-${process.pid}-`));
    expect(home).not.toBe(join(process.env.HOME ?? "", ".codex"));
    // The model rides the config, never -m; the key rides neither.
    expect(cmd).not.toContain("-m");
    expect(cmd.join(" ")).not.toContain(VLLM_CODEX.CODEMUX_CODEX_PROVIDER_API_KEY);
    expect(adapter.getRunEnv(request, context)).toEqual({
      CODEMUX_CODEX_PROVIDER_API_KEY: VLLM_CODEX.CODEMUX_CODEX_PROVIDER_API_KEY,
    });
    const config = configOf(context);
    expect(config).toContain('model_provider = "codemux"\n');
    expect(config).toContain('model = "clawvm-qwen32b-coder"\n');
    expect(config).toContain('[model_providers.codemux]\n');
    expect(config).toContain(`base_url = "http://localhost:8011/v1"\n`);
    expect(config).toContain('env_key = "CODEMUX_CODEX_PROVIDER_API_KEY"\n');
    // Unconditional and the only value every supported release accepts.
    expect(config).toContain('wire_api = "responses"\n');
    // The provider key never reaches commands the model runs: the private
    // home replaces any operator shell_environment_policy, so the config
    // excludes the key variable itself rather than relying on codex's default
    // name filter.
    expect(config).toContain('[shell_environment_policy]\nexclude = ["CODEMUX_CODEX_PROVIDER_API_KEY"]\n');
    // Top-level keys stay above the first table (TOML would otherwise attach
    // them to it).
    expect(config.indexOf("model_provider = ")).toBeLessThan(config.indexOf("[shell_environment_policy]"));
    expect(config).not.toContain(VLLM_CODEX.CODEMUX_CODEX_PROVIDER_API_KEY);
    expect(statSync(join(home, "config.toml")).mode & 0o777).toBe(0o600);
    // The operator's login never enters the private home.
    expect(existsSync(join(home, "auth.json"))).toBe(false);
  });

  test("the context cap rides model_context_window; the output cap is refused", () => {
    const adapter = adapterOf({
      ...VLLM_CODEX,
      CODEMUX_CODEX_PROVIDER_MAX_CONTEXT_TOKENS: "32768",
    });
    const request: RunRequest = { agent: "codex", prompt: "p", cwd: cwdOf() };
    expect(configOf(prepare(adapter, request))).toContain("model_context_window = 32768\n");
    const capped = adapterOf({
      ...VLLM_CODEX,
      CODEMUX_CODEX_PROVIDER_MAX_OUTPUT_TOKENS: "4096",
    });
    expect(() => capped.validateRunRequest({ agent: "codex", prompt: "p", cwd: cwdOf() } as RunRequest))
      .toThrow("CODEMUX_CODEX_PROVIDER_MAX_OUTPUT_TOKENS cannot be honored");
  });

  test("MULTI_AGENT=off writes features.multi_agent = false; on and unset write nothing", () => {
    const request: RunRequest = { agent: "codex", prompt: "p", cwd: cwdOf() };
    expect(
      configOf(
        prepare(
          adapterOf({ ...VLLM_CODEX, CODEMUX_CODEX_PROVIDER_MULTI_AGENT: "off" }),
          request
        )
      )
    ).toContain("features.multi_agent = false\n");
    // "on" and unset both leave codex's own default in force: restating it
    // would pin a value a future release could change.
    expect(
      configOf(
        prepare(
          adapterOf({ ...VLLM_CODEX, CODEMUX_CODEX_PROVIDER_MULTI_AGENT: "on" }),
          request
        )
      )
    ).not.toContain("multi_agent");
    expect(configOf(prepare(adapterOf(VLLM_CODEX), request))).not.toContain(
      "multi_agent"
    );
  });

  test("the knob rides the hermetic override home too", () => {
    const adapter = adapterOf({
      ...VLLM_CODEX,
      CODEMUX_CODEX_PROVIDER_MULTI_AGENT: "off",
    });
    const request: RunRequest = {
      agent: "codex",
      prompt: "p",
      cwd: cwdOf(),
      hermetic: true,
    };
    const context = prepare(adapter, request);
    expect(
      readFileSync(join(context.hermeticHome!.codexHome, "config.toml"), "utf8")
    ).toContain("features.multi_agent = false\n");
  });

  test("a knob value other than on/off is refused before launch", () => {
    const adapter = adapterOf({
      ...VLLM_CODEX,
      CODEMUX_CODEX_PROVIDER_MULTI_AGENT: "maybe",
    });
    expect(() =>
      adapter.validateRunRequest({ agent: "codex", prompt: "p", cwd: cwdOf() } as RunRequest)
    ).toThrow('CODEMUX_CODEX_PROVIDER_MULTI_AGENT must be "on" or "off"');
  });

  test("the knob without an override fails loudly like the caps", () => {
    const adapter = adapterOf({ CODEMUX_CODEX_PROVIDER_MULTI_AGENT: "off" });
    expect(() =>
      adapter.validateRunRequest({ agent: "codex", prompt: "p", cwd: cwdOf() } as RunRequest)
    ).toThrow("CODEMUX_CODEX_PROVIDER_MULTI_AGENT is set but no provider override is");
    // The TUI path refuses it the same way, before its own headless-only
    // refusal: the knob still has no channel without an override.
    expect(() => adapter.validateTuiRequest(undefined, cwdOf())).toThrow(
      "CODEMUX_CODEX_PROVIDER_MULTI_AGENT is set but no provider override is"
    );
  });

  test("the STORE knob is refused outright: no supported release has the key", () => {
    // The knob names a config key that does not exist in any supported
    // codex release (verified against the 0.159.3 generated config schema
    // and the 0.160.1 binary), and the behavior it would request — no
    // reliance on server-side response storage — is already hardcoded:
    // every Responses request sends store: false and the HTTP wire never
    // carries previous_response_id. So every value is refused, "on"
    // included, on every path, with and without an override.
    for (const value of ["on", "off", "maybe"]) {
      const adapter = adapterOf({
        ...VLLM_CODEX,
        CODEMUX_CODEX_PROVIDER_STORE: value,
      });
      expect(() =>
        adapter.validateRunRequest({ agent: "codex", prompt: "p", cwd: cwdOf() } as RunRequest)
      ).toThrow("CODEMUX_CODEX_PROVIDER_STORE is refused");
    }
    const bare = adapterOf({ CODEMUX_CODEX_PROVIDER_STORE: "on" });
    expect(() =>
      bare.validateRunRequest({ agent: "codex", prompt: "p", cwd: cwdOf() } as RunRequest)
    ).toThrow("CODEMUX_CODEX_PROVIDER_STORE is refused");
    expect(() => bare.validateTuiRequest(undefined, cwdOf())).toThrow(
      "CODEMUX_CODEX_PROVIDER_STORE is refused"
    );
    // Unset and blank pass: blank counts as unset everywhere else, and the
    // refusal is for a knob someone actually set. Round al18 pins the
    // empty-value semantics both ways — the README, CHANGELOG, and
    // compatibility ledger now say "any non-empty value" (an empty value
    // counts as unset, the MULTI_AGENT convention), and this is the code
    // agreeing with them: truly empty and whitespace-only both pass, every
    // other value refused.
    expect(() => assertNoCodexStoreKnob({})).not.toThrow();
    expect(() => assertNoCodexStoreKnob({ CODEMUX_CODEX_PROVIDER_STORE: "" })).not.toThrow();
    expect(() => assertNoCodexStoreKnob({ CODEMUX_CODEX_PROVIDER_STORE: "  " })).not.toThrow();
    expect(() =>
      assertNoCodexStoreKnob({ CODEMUX_CODEX_PROVIDER_STORE: " on " })
    ).toThrow("CODEMUX_CODEX_PROVIDER_STORE is refused");
    // Round al21 (contracts-2 minor 2): the refusal fires before every
    // override check — a malformed MULTI_AGENT value once masked it
    // (assertMultiAgentKnob ran first in validatedProvider), so the
    // "with or without an override" guarantee above did not hold.
    const masked = adapterOf({
      ...VLLM_CODEX,
      CODEMUX_CODEX_PROVIDER_MULTI_AGENT: "banana",
      CODEMUX_CODEX_PROVIDER_STORE: "on",
    });
    expect(() =>
      masked.validateRunRequest({ agent: "codex", prompt: "p", cwd: cwdOf() } as RunRequest)
    ).toThrow("CODEMUX_CODEX_PROVIDER_STORE is refused");
  });

  test("an explicit --model wins inside the config", () => {
    const adapter = adapterOf(VLLM_CODEX);
    const request: RunRequest = {
      agent: "codex",
      prompt: "p",
      cwd: cwdOf(),
      model: "other-model",
    };
    expect(configOf(prepare(adapter, request))).toContain('model = "other-model"\n');
  });

  test("the envelope reports the override's model when the request named none", () => {
    // Round-1 review finding: the model rode the config.toml, never -m, so
    // codexResult's request fallback saw no model and the envelope reported
    // null ("the harness default") for a run the override's model served.
    // The reroute note had the same hole: it could not name the model that
    // was requested away. processRunResult must resolve the model the way
    // prepareRun did.
    const adapter = adapterOf(VLLM_CODEX);
    const request: RunRequest = {
      agent: "codex",
      prompt: "p",
      cwd: cwdOf(),
      resultJson: true,
    };
    const events = (extra: object[] = []): string =>
      `${[
        { type: "thread.started", thread_id: "t" },
        { type: "turn.started" },
        ...extra,
        { type: "item.completed", item: { id: "item_0", type: "agent_message", text: "OK" } },
        { type: "turn.completed", usage: { input_tokens: 10, output_tokens: 2 } },
      ].map((line) => JSON.stringify(line)).join("\n")}\n`;
    const plain = adapter.processRunResult(
      { stdout: events(), stderr: "", exitCode: 0, success: true },
      request
    );
    expect(JSON.parse(plain.stdout).codemux.model).toBe("clawvm-qwen32b-coder");
    const rerouted = adapter.processRunResult(
      {
        stdout: events([
          {
            type: "item.completed",
            item: {
              id: "item_err",
              type: "error",
              message: "model rerouted: clawvm-qwen32b-coder -> other-model (Unavailable)",
            },
          },
        ]),
        stderr: "",
        exitCode: 0,
        success: true,
      },
      request
    );
    expect(JSON.parse(rerouted.stdout).codemux.model).toBe("other-model");
    expect(rerouted.stderr).toContain("not the requested clawvm-qwen32b-coder");
  });

  test("a half-configured override fails validation with the missing name", () => {
    const adapter = adapterOf({
      CODEMUX_CODEX_PROVIDER_BASE_URL: VLLM_CODEX.CODEMUX_CODEX_PROVIDER_BASE_URL,
    });
    expect(() => adapter.validateRunRequest({ agent: "codex", prompt: "p", cwd: cwdOf() } as RunRequest))
      .toThrow("provider override is missing CODEMUX_CODEX_PROVIDER_API_KEY");
    const modelless = adapterOf({
      CODEMUX_CODEX_PROVIDER_BASE_URL: VLLM_CODEX.CODEMUX_CODEX_PROVIDER_BASE_URL,
      CODEMUX_CODEX_PROVIDER_API_KEY: VLLM_CODEX.CODEMUX_CODEX_PROVIDER_API_KEY,
    });
    expect(() => modelless.validateRunRequest({ agent: "codex", prompt: "p", cwd: cwdOf() } as RunRequest))
      .toThrow("codex needs a model for the provider override");
  });

  test("a static command without prepareRun fails closed", () => {
    const adapter = adapterOf(VLLM_CODEX);
    const cmd = adapter.buildRunCommand({
      agent: "codex",
      prompt: "p",
      cwd: cwdOf(),
    } as RunRequest);
    expect(codexHomeOf(cmd)).toMatch(/\.codemux-provider\/unprepared$/);
    expect(() => adapter.getRunEnv({ agent: "codex", prompt: "p", cwd: cwdOf() } as RunRequest))
      .toThrow("codex provider config was not prepared before launch");
  });

  test("every prepared run gets a fresh home; cleanupRun removes each launch's own only", () => {
    const adapter = adapterOf(VLLM_CODEX);
    const request: RunRequest = { agent: "codex", prompt: "p", cwd: cwdOf() };
    const firstContext = prepare(adapter, request);
    const secondContext = prepare(adapter, request);
    expect(secondContext.codexProviderHome!.codexHome)
      .not.toBe(firstContext.codexProviderHome!.codexHome);
    expect(existsSync(join(firstContext.codexProviderHome!.codexHome, "config.toml"))).toBe(true);
    adapter.cleanupRun(firstContext);
    expect(existsSync(firstContext.codexProviderHome!.codexHome)).toBe(false);
    expect(existsSync(join(secondContext.codexProviderHome!.codexHome, "config.toml"))).toBe(true);
  });

  test("the override survives --hermetic: config inside the private home, user config loaded", () => {
    // --ignore-user-config skips $CODEX_HOME/config.toml itself — the exact
    // file the override lives in — so an override run never passes it, and
    // the operator's auth.json is not linked (the provider key is the
    // credential).
    const adapter = adapterOf(VLLM_CODEX);
    const request: RunRequest = {
      agent: "codex",
      prompt: "p",
      cwd: cwdOf(),
      hermetic: true,
      resultJson: true,
    };
    const context = prepare(adapter, request);
    const home = context.hermeticHome!;
    expect(existsSync(join(home.codexHome, "config.toml"))).toBe(true);
    expect(existsSync(join(home.codexHome, "auth.json"))).toBe(false);
    const cmd = adapter.buildRunCommand(request, context);
    expect(codexHomeOf(cmd)).toBe(home.codexHome);
    expect(cmd).not.toContain("--ignore-user-config");
    expect(cmd.join(" ")).not.toContain(VLLM_CODEX.CODEMUX_CODEX_PROVIDER_API_KEY);
    expect(adapter.getRunEnv(request, context)).toEqual({
      CODEMUX_CODEX_PROVIDER_API_KEY: VLLM_CODEX.CODEMUX_CODEX_PROVIDER_API_KEY,
    });
  });

  test("the operator's CODEX_API_KEY stays out of an override run's environment", () => {
    const adapter = adapterOf({
      ...VLLM_CODEX,
      CODEX_API_KEY: "operator-key-do-not-print",
      OPENAI_API_KEY: "operator-key-do-not-print",
    });
    expect(adapter.getEnvOmissions()).toEqual(["CODEX_API_KEY", "OPENAI_API_KEY"]);
    expect(adapterOf().getEnvOmissions()).toEqual([]);
  });

  test("the tui accepts a complete override and preserves the plain path", () => {
    expect(() => adapterOf().validateTuiRequest(undefined, cwdOf())).not.toThrow();
    expect(() => adapterOf(VLLM_CODEX).validateTuiRequest(undefined, cwdOf()))
      .not.toThrow();
  });
});
