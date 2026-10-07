import type { SecretReader } from "../src/credentials.js";
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunContext } from "../src/adapters/base.js";
import { AiderAdapter } from "../src/adapters/aider.js";
import { ClaudeAdapter } from "../src/adapters/claude.js";
import { CodexAdapter } from "../src/adapters/codex.js";
import { DroidAdapter } from "../src/adapters/droid.js";
import { GooseAdapter, gooseOpenAiEndpoint } from "../src/adapters/goose.js";
import { KimiAdapter } from "../src/adapters/kimi.js";
import { OpenHandsAdapter } from "../src/adapters/openhands.js";
import { PiAdapter } from "../src/adapters/pi.js";
import type { RunRequest } from "../src/types.js";

// How each adapter translates a provider override
// (CODEMUX_<AGENT>_PROVIDER_{BASE_URL,API_KEY,MODEL}) into what the harness
// consumes. The key must travel in the environment or a private file, never
// in argv; assertions check the command carries no key.

const ZAI = {
  CODEMUX_AIDER_PROVIDER_BASE_URL: "https://api.z.ai/api/coding/paas/v4",
  CODEMUX_AIDER_PROVIDER_API_KEY: "test-key-do-not-print",
  CODEMUX_AIDER_PROVIDER_MODEL: "glm-5.3",
};

describe("aider provider override", () => {
  const scratch: string[] = [];
  afterEach(() => {
    while (scratch.length > 0) {
      const dir = scratch.pop()!;
      rmSync(dir, { recursive: true, force: true });
    }
  });
  const cwdOf = (): string => {
    const cwd = mkdtempSync(join(tmpdir(), "codemux-aider-override-"));
    mkdirSync(join(cwd, ".git"));
    scratch.push(cwd);
    return cwd;
  };
  const run = (env: NodeJS.ProcessEnv, request: Partial<RunRequest> = {}): string[] =>
    new AiderAdapter(env).buildRunCommand({
      agent: "aider",
      prompt: "p",
      cwd: cwdOf(),
      ...request,
    } as RunRequest);
  const modelArg = (cmd: string[]): string => cmd[cmd.indexOf("--model") + 1]!;

  test("without an override nothing changes", () => {
    const adapter = new AiderAdapter({});
    expect(adapter.getRunEnv({ agent: "aider", prompt: "p" } as RunRequest)).toEqual({});
    expect(run({})).not.toContain("--model");
  });

  test("the override rides OPENAI_API_BASE/OPENAI_API_KEY and the openai/ model prefix", () => {
    const adapter = new AiderAdapter(ZAI);
    expect(adapter.getRunEnv({ agent: "aider", prompt: "p" } as RunRequest)).toEqual({
      OPENAI_API_KEY: ZAI.CODEMUX_AIDER_PROVIDER_API_KEY,
      OPENAI_API_BASE: ZAI.CODEMUX_AIDER_PROVIDER_BASE_URL,
    });
    const cmd = run(ZAI);
    expect(modelArg(cmd)).toBe("openai/glm-5.3");
    // The key never rides argv.
    expect(cmd.join(" ")).not.toContain(ZAI.CODEMUX_AIDER_PROVIDER_API_KEY);
  });

  test("an explicit --model wins and is prefixed once", () => {
    expect(modelArg(run(ZAI, { model: "glm-5.3-flash" }))).toBe("openai/glm-5.3-flash");
    expect(modelArg(run(ZAI, { model: "openai/glm-5.3" }))).toBe("openai/glm-5.3");
  });

  test("the override survives --hermetic", () => {
    const cmd = run(ZAI, { hermetic: true });
    expect(cmd).toContain("--map-tokens");
    expect(modelArg(cmd)).toBe("openai/glm-5.3");
  });

  test("a keyless override fails validation with the missing name", () => {
    const adapter = new AiderAdapter({
      CODEMUX_AIDER_PROVIDER_BASE_URL: ZAI.CODEMUX_AIDER_PROVIDER_BASE_URL,
      CODEMUX_AIDER_PROVIDER_MODEL: "glm-5.3",
    });
    expect(() =>
      adapter.validateRunRequest({ agent: "aider", prompt: "p", cwd: cwdOf() } as RunRequest)
    ).toThrow("provider override is missing CODEMUX_AIDER_PROVIDER_API_KEY");
  });

  test("an override without any model fails validation", () => {
    const adapter = new AiderAdapter({
      CODEMUX_AIDER_PROVIDER_BASE_URL: ZAI.CODEMUX_AIDER_PROVIDER_BASE_URL,
      CODEMUX_AIDER_PROVIDER_API_KEY: ZAI.CODEMUX_AIDER_PROVIDER_API_KEY,
    });
    expect(() =>
      adapter.validateRunRequest({ agent: "aider", prompt: "p", cwd: cwdOf() } as RunRequest)
    ).toThrow("aider needs a model for the provider override");
  });

  test("the tui command and env carry the same override", () => {
    const adapter = new AiderAdapter(ZAI);
    const cmd = adapter.buildTuiCommand("glm-5.3");
    expect(modelArg(cmd)).toBe("openai/glm-5.3");
    expect(adapter.getTuiEnv()).toEqual({
      OPENAI_API_KEY: ZAI.CODEMUX_AIDER_PROVIDER_API_KEY,
      OPENAI_API_BASE: ZAI.CODEMUX_AIDER_PROVIDER_BASE_URL,
    });
  });

  test("both token caps are refused: no channel carries one", () => {
    // Regression: aider 0.86.2 has no max-tokens flag and codemux writes no
    // aider config, so a set cap must fail the run rather than ride along
    // silently uncapped.
    const request: RunRequest = { agent: "aider", prompt: "p", cwd: cwdOf() } as RunRequest;
    const outputCap = new AiderAdapter({
      ...ZAI,
      CODEMUX_AIDER_PROVIDER_MAX_OUTPUT_TOKENS: "4096",
    });
    expect(() => outputCap.validateRunRequest(request))
      .toThrow("CODEMUX_AIDER_PROVIDER_MAX_OUTPUT_TOKENS cannot be honored");
    const contextCap = new AiderAdapter({
      ...ZAI,
      CODEMUX_AIDER_PROVIDER_MAX_CONTEXT_TOKENS: "32768",
    });
    expect(() => contextCap.getRunEnv(request))
      .toThrow("CODEMUX_AIDER_PROVIDER_MAX_CONTEXT_TOKENS cannot be honored");
  });
});

const ZAI_KIMI = {
  CODEMUX_KIMI_PROVIDER_BASE_URL: "https://api.z.ai/api/coding/paas/v4",
  CODEMUX_KIMI_PROVIDER_API_KEY: "test-key-do-not-print",
  CODEMUX_KIMI_PROVIDER_MODEL: "glm-5.3",
};

describe("kimi provider override", () => {
  const scratch: string[] = [];
  // Every context this describe prepares, disposed per launch -- the same
  // ownership rule the launcher follows, never a whole-adapter sweep.
  const prepared: { adapter: KimiAdapter; context: RunContext }[] = [];
  afterEach(() => {
    for (const { adapter, context } of prepared.splice(0)) adapter.cleanupRun(context);
    while (scratch.length > 0) {
      const dir = scratch.pop()!;
      rmSync(dir, { recursive: true, force: true });
    }
  });
  const cwdOf = (): string => {
    const cwd = mkdtempSync(join(tmpdir(), "codemux-kimi-override-"));
    mkdirSync(join(cwd, ".git"));
    scratch.push(cwd);
    return cwd;
  };
  const adapterOf = (env: NodeJS.ProcessEnv = {}): KimiAdapter => new KimiAdapter(env);
  const prepare = (adapter: KimiAdapter, request: RunRequest): RunContext => {
    const context = adapter.prepareRun(request);
    prepared.push({ adapter, context });
    return context;
  };
  const run = (env: NodeJS.ProcessEnv, request: Partial<RunRequest> = {}): string[] =>
    adapterOf(env).buildRunCommand({
      agent: "kimi",
      prompt: "p",
      cwd: cwdOf(),
      ...request,
    } as RunRequest);

  test("without an override nothing changes", () => {
    const adapter = adapterOf();
    expect(adapter.getRunEnv({ agent: "kimi", prompt: "p" } as RunRequest)).toEqual({});
    expect(run({})).toEqual(["kimi", "--prompt", "p"]);
    // An operator model still rides the native flag.
    expect(run({}, { model: "kimi-for-coding" })).toEqual(["kimi", "--model", "kimi-for-coding", "--prompt", "p"]);
  });

  test("the override rides the KIMI_MODEL_* environment group", () => {
    const adapter = adapterOf(ZAI_KIMI);
    expect(adapter.getRunEnv({ agent: "kimi", prompt: "p" } as RunRequest)).toEqual({
      KIMI_MODEL_NAME: "glm-5.3",
      KIMI_MODEL_API_KEY: ZAI_KIMI.CODEMUX_KIMI_PROVIDER_API_KEY,
      KIMI_MODEL_BASE_URL: ZAI_KIMI.CODEMUX_KIMI_PROVIDER_BASE_URL,
      KIMI_MODEL_PROVIDER_TYPE: "openai",
    });
    // The synthesized provider is the default model; -m names a config
    // alias that outranks it, so the flag stays off.
    const cmd = run(ZAI_KIMI);
    expect(cmd).toEqual(["kimi", "--prompt", "p"]);
    expect(cmd.join(" ")).not.toContain(ZAI_KIMI.CODEMUX_KIMI_PROVIDER_API_KEY);
  });

  test("an explicit --model wins as the synthesized model id", () => {
    const adapter = adapterOf(ZAI_KIMI);
    expect(adapter.getRunEnv({ agent: "kimi", prompt: "p", model: "glm-5.3-flash" } as RunRequest))
      .toMatchObject({ KIMI_MODEL_NAME: "glm-5.3-flash" });
    expect(run(ZAI_KIMI, { model: "glm-5.3-flash" })).toEqual(["kimi", "--prompt", "p"]);
  });

  test("the override and the --tools none agent file coexist", () => {
    const adapter = adapterOf(ZAI_KIMI);
    const request: RunRequest = { agent: "kimi", prompt: "p", tools: "none", cwd: cwdOf() };
    const cmd = adapter.buildRunCommand(request, prepare(adapter, request));
    expect(cmd).toContain("--agent-file");
    expect(adapter.getRunEnv(request)).toMatchObject({
      KIMI_MODEL_API_KEY: ZAI_KIMI.CODEMUX_KIMI_PROVIDER_API_KEY,
    });
  });

  test("a keyless override fails validation with the missing name", () => {
    const adapter = adapterOf({
      CODEMUX_KIMI_PROVIDER_BASE_URL: ZAI_KIMI.CODEMUX_KIMI_PROVIDER_BASE_URL,
      CODEMUX_KIMI_PROVIDER_MODEL: "glm-5.3",
    });
    expect(() => adapter.validateRunRequest({ agent: "kimi", prompt: "p", cwd: cwdOf() } as RunRequest))
      .toThrow("provider override is missing CODEMUX_KIMI_PROVIDER_API_KEY");
  });

  test("an override without any model fails validation", () => {
    const adapter = adapterOf({
      CODEMUX_KIMI_PROVIDER_BASE_URL: ZAI_KIMI.CODEMUX_KIMI_PROVIDER_BASE_URL,
      CODEMUX_KIMI_PROVIDER_API_KEY: ZAI_KIMI.CODEMUX_KIMI_PROVIDER_API_KEY,
    });
    expect(() => adapter.validateRunRequest({ agent: "kimi", prompt: "p", cwd: cwdOf() } as RunRequest))
      .toThrow("kimi needs a model for the provider override");
    expect(() => adapter.validateTuiRequest(undefined, cwdOf()))
      .toThrow("kimi needs a model for the provider override");
  });

  test("the tui command and env carry the same override", () => {
    const adapter = adapterOf(ZAI_KIMI);
    expect(adapter.buildTuiCommand(undefined, "high")).toEqual(["kimi", "--auto"]);
    expect(adapter.buildTuiCommand("glm-5.3", "high")).toEqual(["kimi", "--auto"]);
    expect(adapter.getTuiEnv()).toEqual({
      KIMI_MODEL_NAME: "glm-5.3",
      KIMI_MODEL_API_KEY: ZAI_KIMI.CODEMUX_KIMI_PROVIDER_API_KEY,
      KIMI_MODEL_BASE_URL: ZAI_KIMI.CODEMUX_KIMI_PROVIDER_BASE_URL,
      KIMI_MODEL_PROVIDER_TYPE: "openai",
    });
  });

  test("both caps ride the sibling KIMI_MODEL_* variables", () => {
    const adapter = adapterOf({
      ...ZAI_KIMI,
      CODEMUX_KIMI_PROVIDER_MAX_OUTPUT_TOKENS: "4096",
      CODEMUX_KIMI_PROVIDER_MAX_CONTEXT_TOKENS: "32768",
    });
    expect(adapter.getRunEnv({ agent: "kimi", prompt: "p" } as RunRequest)).toEqual({
      KIMI_MODEL_NAME: "glm-5.3",
      KIMI_MODEL_API_KEY: ZAI_KIMI.CODEMUX_KIMI_PROVIDER_API_KEY,
      KIMI_MODEL_BASE_URL: ZAI_KIMI.CODEMUX_KIMI_PROVIDER_BASE_URL,
      KIMI_MODEL_PROVIDER_TYPE: "openai",
      KIMI_MODEL_MAX_COMPLETION_TOKENS: "4096",
      KIMI_MODEL_MAX_CONTEXT_SIZE: "32768",
    });
  });
});

const ZAI_DROID = {
  CODEMUX_DROID_PROVIDER_BASE_URL: "https://api.z.ai/api/coding/paas/v4",
  CODEMUX_DROID_PROVIDER_API_KEY: "test-key-do-not-print",
  CODEMUX_DROID_PROVIDER_MODEL: "glm-5.3",
};

describe("droid provider override", () => {
  const scratch: string[] = [];
  // Every context this describe prepares, disposed per launch -- the same
  // ownership rule the launcher follows, never a whole-adapter sweep.
  const prepared: { adapter: DroidAdapter; context: RunContext }[] = [];
  afterEach(() => {
    for (const { adapter, context } of prepared.splice(0)) adapter.cleanupRun(context);
    while (scratch.length > 0) {
      const dir = scratch.pop()!;
      rmSync(dir, { recursive: true, force: true });
    }
  });
  const cwdOf = (): string => {
    const cwd = mkdtempSync(join(tmpdir(), "codemux-droid-override-"));
    mkdirSync(join(cwd, ".git"));
    scratch.push(cwd);
    return cwd;
  };
  const adapterOf = (env: NodeJS.ProcessEnv = {}): DroidAdapter => {
    const home = mkdtempSync(join(tmpdir(), "codemux-droid-home-"));
    scratch.push(home);
    return new DroidAdapter(env, home);
  };
  const prepare = (adapter: DroidAdapter, request: RunRequest): RunContext => {
    const context = adapter.prepareRun(request);
    prepared.push({ adapter, context });
    return context;
  };
  const run = (env: NodeJS.ProcessEnv, request: Partial<RunRequest> = {}): string[] =>
    adapterOf(env).buildRunCommand({
      agent: "droid",
      prompt: "p",
      cwd: cwdOf(),
      ...request,
    } as RunRequest);

  test("without an override nothing changes", () => {
    const adapter = adapterOf();
    expect(adapter.getRunEnv({ agent: "droid", prompt: "p" } as RunRequest)).toEqual({});
    expect(run({})).toEqual(["droid", "exec"]);
    // An operator model still rides the native flag.
    expect(run({}, { model: "claude-sonnet-5" })).toEqual(["droid", "exec", "-m", "claude-sonnet-5"]);
  });

  test("the override rides a per-run --settings file and the key environment", () => {
    const adapter = adapterOf(ZAI_DROID);
    const request: RunRequest = { agent: "droid", prompt: "p", cwd: cwdOf() };
    const context = prepare(adapter, request);
    const path = adapter.buildRunCommand(request, context)[2]!;
    expect(path).toContain(join(".factory", ".codemux", `provider-${process.pid}-`));
    expect(path.endsWith("settings.json")).toBe(true);
    const settings = JSON.parse(readFileSync(path, "utf8"));
    // The file records the key's NAME, never the key; the entry carries the
    // override's base URL and the generic chat-completions provider.
    // The entry selects by id; model is only the API model name.
    expect(settings.model).toBe("custom:codemux:glm-5.3-0");
    expect(settings.customModels).toEqual([
      {
        model: "glm-5.3",
        id: "custom:codemux:glm-5.3-0",
        index: 0,
        displayName: "codemux provider override",
        baseUrl: ZAI_DROID.CODEMUX_DROID_PROVIDER_BASE_URL,
        apiKey: "${CODEMUX_DROID_PROVIDER_API_KEY}",
        provider: "generic-chat-completion-api",
        noImageSupport: true,
      },
    ]);
    expect(JSON.stringify(settings)).not.toContain(ZAI_DROID.CODEMUX_DROID_PROVIDER_API_KEY);
    expect(adapter.getRunEnv(request, context)).toEqual({
      CODEMUX_DROID_PROVIDER_API_KEY: ZAI_DROID.CODEMUX_DROID_PROVIDER_API_KEY,
    });
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  test("the command selects the override's model through -m", () => {
    const adapter = adapterOf(ZAI_DROID);
    const request: RunRequest = { agent: "droid", prompt: "p", cwd: cwdOf() };
    const cmd = adapter.buildRunCommand(request, prepare(adapter, request));
    expect(cmd.slice(0, 3)).toEqual(["droid", "--settings", cmd[2]!]);
    expect(cmd.slice(3)).toEqual(["exec", "-m", "custom:codemux:glm-5.3-0"]);
    expect(cmd.join(" ")).not.toContain(ZAI_DROID.CODEMUX_DROID_PROVIDER_API_KEY);
  });

  test("effort maps against the model the session runs, override-resolved", () => {
    // Regression: the effort call used the raw request.model, so with an
    // override model in the gpt-5.6 family and no explicit -m the session
    // ran that model while argv carried the generic "off" — the value
    // mapEffortForModel exists to avoid for the family.
    const gpt = adapterOf({ ...ZAI_DROID, CODEMUX_DROID_PROVIDER_MODEL: "gpt-5.6-codex" });
    const request: RunRequest = { agent: "droid", prompt: "p", cwd: cwdOf(), effort: "none" };
    expect(gpt.buildRunCommand(request, prepare(gpt, request)).slice(3))
      .toEqual(["exec", "-m", "custom:codemux:gpt-5.6-codex-0", "--reasoning-effort", "none"]);
    // An explicit non-gpt-5.6 model wins the resolution and takes "off".
    const explicit: RunRequest = {
      agent: "droid",
      prompt: "p",
      cwd: cwdOf(),
      model: "claude-opus-5",
      effort: "none",
    };
    expect(gpt.buildRunCommand(explicit, prepare(gpt, explicit)).slice(3))
      .toEqual(["exec", "-m", "custom:codemux:claude-opus-5-0", "--reasoning-effort", "off"]);
  });

  test("an explicit --model wins as the routed model id", () => {
    const adapter = adapterOf(ZAI_DROID);
    const request: RunRequest = { agent: "droid", prompt: "p", cwd: cwdOf(), model: "glm-5.3-flash" };
    const context = prepare(adapter, request);
    const path = adapter.buildRunCommand(request, context)[2]!;
    expect(JSON.parse(readFileSync(path, "utf8")).customModels[0].model).toBe("glm-5.3-flash");
    expect(adapter.buildRunCommand(request, context).slice(3))
      .toEqual(["exec", "-m", "custom:codemux:glm-5.3-flash-0"]);
  });

  test("the override and --tools none coexist", () => {
    const adapter = adapterOf(ZAI_DROID);
    const request: RunRequest = { agent: "droid", prompt: "p", cwd: cwdOf(), tools: "none", autonomy: "high" };
    const context = prepare(adapter, request);
    expect(adapter.buildRunCommand(request, context).slice(3))
      .toEqual(["exec", "-m", "custom:codemux:glm-5.3-0", "--auto", "high", "--only-tools", "ToolSearch"]);
    expect(adapter.getRunEnv(request, context)).toEqual({
      CODEMUX_DROID_PROVIDER_API_KEY: ZAI_DROID.CODEMUX_DROID_PROVIDER_API_KEY,
    });
  });

  test("a static command without prepareRun fails closed", () => {
    const adapter = adapterOf(ZAI_DROID);
    const cmd = run(ZAI_DROID);
    expect(cmd[1]).toBe("--settings");
    expect(cmd[2]).toMatch(/\.codemux\/unprepared\/settings\.json$/);
    expect(() => statSync(cmd[2]!)).toThrow();
    expect(() => adapter.getRunEnv({ agent: "droid", prompt: "p" } as RunRequest))
      .toThrow("droid provider settings were not prepared before launch");
  });

  test("every prepared run gets a fresh settings file; cleanupRun removes each launch's own only", () => {
    const adapter = adapterOf(ZAI_DROID);
    const request: RunRequest = { agent: "droid", prompt: "p", cwd: cwdOf() };
    const firstContext = prepare(adapter, request);
    const first = adapter.buildRunCommand(request, firstContext)[2]!;
    const secondContext = prepare(adapter, request);
    const second = adapter.buildRunCommand(request, secondContext)[2]!;
    expect(second).not.toBe(first);
    // The earlier file stays until its own launch ends: an earlier run may
    // still read it.
    expect(statSync(first).isFile()).toBe(true);
    adapter.cleanupRun(firstContext);
    expect(() => statSync(first)).toThrow();
    expect(statSync(second).isFile()).toBe(true);
  });

  test("a keyless override fails validation with the missing name", () => {
    const adapter = adapterOf({
      CODEMUX_DROID_PROVIDER_BASE_URL: ZAI_DROID.CODEMUX_DROID_PROVIDER_BASE_URL,
      CODEMUX_DROID_PROVIDER_MODEL: "glm-5.3",
    });
    expect(() => adapter.validateRunRequest({ agent: "droid", prompt: "p", cwd: cwdOf() } as RunRequest))
      .toThrow("provider override is missing CODEMUX_DROID_PROVIDER_API_KEY");
  });

  test("an override without any model fails validation", () => {
    const adapter = adapterOf({
      CODEMUX_DROID_PROVIDER_BASE_URL: ZAI_DROID.CODEMUX_DROID_PROVIDER_BASE_URL,
      CODEMUX_DROID_PROVIDER_API_KEY: ZAI_DROID.CODEMUX_DROID_PROVIDER_API_KEY,
    });
    expect(() => adapter.validateRunRequest({ agent: "droid", prompt: "p", cwd: cwdOf() } as RunRequest))
      .toThrow("droid needs a model for the provider override");
  });

  test("a model with braces is refused: the settings file expands ${VAR} templates", () => {
    // Regression (h6 review): the h4 brace refusal covered the base URL
    // only, but the model lands in the same template-expanded file — in
    // the entry's model and id fields — so a crafted model id could splice
    // an environment variable's value into the settings codemux writes
    // (validateModelName allows braces). validateRunRequest refuses it
    // before launch, and the write refuses it before creating anything.
    const home = mkdtempSync(join(tmpdir(), "codemux-droid-home-"));
    scratch.push(home);
    const adapter = new DroidAdapter(
      { ...ZAI_DROID, CODEMUX_DROID_PROVIDER_MODEL: "glm-${CODEMUX_DROID_PROVIDER_API_KEY}" },
      home
    );
    const request: RunRequest = { agent: "droid", prompt: "p", cwd: cwdOf() };
    expect(() => adapter.validateRunRequest(request))
      .toThrow("must not contain '{' or '}'");
    expect(() => adapter.prepareRun(request))
      .toThrow("must not contain '{' or '}'");
    expect(existsSync(join(home, ".factory"))).toBe(false);
  });

  test("the tui refuses the override; without one it is unchanged", () => {
    const plain = adapterOf();
    expect(() => plain.validateTuiRequest(undefined, cwdOf())).not.toThrow();
    expect(plain.buildTuiCommand(undefined, "high")).toEqual(["droid", "--auto", "high"]);
    const adapter = adapterOf(ZAI_DROID);
    expect(() => adapter.validateTuiRequest(undefined, cwdOf()))
      .toThrow("supports headless runs only");
  });

  test("the output cap rides the BYOK entry; the context cap is refused", () => {
    const adapter = adapterOf({
      ...ZAI_DROID,
      CODEMUX_DROID_PROVIDER_MAX_OUTPUT_TOKENS: "4096",
    });
    const request: RunRequest = { agent: "droid", prompt: "p", cwd: cwdOf() };
    const context = prepare(adapter, request);
    const path = adapter.buildRunCommand(request, context)[2]!;
    expect(JSON.parse(readFileSync(path, "utf8")).customModels[0].maxOutputTokens).toBe(4096);
    // There is no context-window BYOK field, so that cap fails the run
    // loudly instead of being dropped.
    const capped = adapterOf({
      ...ZAI_DROID,
      CODEMUX_DROID_PROVIDER_MAX_CONTEXT_TOKENS: "32768",
    });
    expect(() => capped.validateRunRequest({ agent: "droid", prompt: "p", cwd: cwdOf() } as RunRequest))
      .toThrow("CODEMUX_DROID_PROVIDER_MAX_CONTEXT_TOKENS cannot be honored");
  });
});

const ZAI_PI = {
  CODEMUX_PI_PROVIDER_BASE_URL: "https://api.z.ai/api/coding/paas/v4",
  CODEMUX_PI_PROVIDER_API_KEY: "test-key-do-not-print",
  CODEMUX_PI_PROVIDER_MODEL: "glm-5.3",
};

describe("pi provider override", () => {
  const scratch: string[] = [];
  // Every context this describe prepares, disposed per launch -- the same
  // ownership rule the launcher follows, never a whole-adapter sweep.
  const prepared: { adapter: PiAdapter; context: RunContext }[] = [];
  afterEach(() => {
    for (const { adapter, context } of prepared.splice(0)) adapter.cleanupRun(context);
    while (scratch.length > 0) {
      const dir = scratch.pop()!;
      rmSync(dir, { recursive: true, force: true });
    }
  });
  const cwdOf = (): string => {
    const cwd = mkdtempSync(join(tmpdir(), "codemux-pi-override-"));
    mkdirSync(join(cwd, ".git"));
    scratch.push(cwd);
    return cwd;
  };
  const adapterOf = (env: NodeJS.ProcessEnv = {}): PiAdapter => {
    const home = mkdtempSync(join(tmpdir(), "codemux-pi-home-"));
    scratch.push(home);
    return new PiAdapter(env, home);
  };
  const prepare = (adapter: PiAdapter, request: RunRequest): RunContext => {
    const context = adapter.prepareRun(request);
    prepared.push({ adapter, context });
    return context;
  };
  const run = (env: NodeJS.ProcessEnv, request: Partial<RunRequest> = {}): string[] =>
    adapterOf(env).buildRunCommand({
      agent: "pi",
      prompt: "p",
      cwd: cwdOf(),
      ...request,
    } as RunRequest);
  const head = ["pi", "--print", "--no-session", "--no-approve"];

  test("without an override nothing changes", () => {
    const adapter = adapterOf();
    expect(adapter.getRunEnv({ agent: "pi", prompt: "p" } as RunRequest)).toEqual({});
    expect(run({})).toEqual(head);
    // An operator model still rides the native flag.
    expect(run({}, { model: "anthropic/claude-opus-5" }))
      .toEqual([...head, "--model", "anthropic/claude-opus-5"]);
  });

  test("the override rides a private agent directory and the key environment", () => {
    const adapter = adapterOf(ZAI_PI);
    const request: RunRequest = { agent: "pi", prompt: "p", cwd: cwdOf() };
    const env = adapter.getRunEnv(request, prepare(adapter, request));
    expect(env.PI_CODING_AGENT_DIR).toContain(
      join(".pi", "agent", ".codemux", `provider-${process.pid}-`)
    );
    const models = JSON.parse(
      readFileSync(join(env.PI_CODING_AGENT_DIR!, "models.json"), "utf8")
    );
    // The file records the key's NAME, never the key; the provider carries
    // the override's base URL and the OpenAI chat-completions protocol.
    // The model entry declares reasoning (h4 review): pi 0.85.1 defaults a
    // custom model's reasoning to false, which clamps the --thinking flag
    // --effort maps to off, so the bare entry silently disabled reasoning.
    expect(models.providers.codemux).toEqual({
      name: "codemux provider override",
      baseUrl: ZAI_PI.CODEMUX_PI_PROVIDER_BASE_URL,
      apiKey: "${CODEMUX_PI_PROVIDER_API_KEY}",
      api: "openai-completions",
      models: [
        { id: "glm-5.3", name: "glm-5.3", api: "openai-completions", reasoning: true },
      ],
    });
    expect(JSON.stringify(models)).not.toContain(ZAI_PI.CODEMUX_PI_PROVIDER_API_KEY);
    expect(env.CODEMUX_PI_PROVIDER_API_KEY).toBe(ZAI_PI.CODEMUX_PI_PROVIDER_API_KEY);
    expect(statSync(join(env.PI_CODING_AGENT_DIR!, "models.json")).mode & 0o777).toBe(0o600);
  });

  test("both caps ride the model entry as maxTokens and contextWindow", () => {
    const adapter = adapterOf({
      ...ZAI_PI,
      CODEMUX_PI_PROVIDER_MAX_OUTPUT_TOKENS: "4096",
      CODEMUX_PI_PROVIDER_MAX_CONTEXT_TOKENS: "32768",
    });
    const request: RunRequest = { agent: "pi", prompt: "p", cwd: cwdOf() };
    const env = adapter.getRunEnv(request, prepare(adapter, request));
    const models = JSON.parse(
      readFileSync(join(env.PI_CODING_AGENT_DIR!, "models.json"), "utf8")
    );
    const entry = models.providers.codemux.models[0];
    expect(entry.maxTokens).toBe(4096);
    expect(entry.contextWindow).toBe(32768);
  });

  test("the command selects the provider-qualified model", () => {
    const adapter = adapterOf(ZAI_PI);
    const request: RunRequest = { agent: "pi", prompt: "p", cwd: cwdOf() };
    prepare(adapter, request);
    expect(adapter.buildRunCommand(request))
      .toEqual([...head, "--model", "codemux/glm-5.3"]);
    const cmd = adapter.buildRunCommand(request).join(" ");
    expect(cmd).not.toContain(ZAI_PI.CODEMUX_PI_PROVIDER_API_KEY);
  });

  test("an explicit --model wins as the routed model id", () => {
    const adapter = adapterOf(ZAI_PI);
    const request: RunRequest = { agent: "pi", prompt: "p", cwd: cwdOf(), model: "glm-5.3-flash" };
    const context = prepare(adapter, request);
    expect(adapter.buildRunCommand(request))
      .toEqual([...head, "--model", "codemux/glm-5.3-flash"]);
    const env = adapter.getRunEnv(request, context);
    expect(JSON.parse(readFileSync(join(env.PI_CODING_AGENT_DIR!, "models.json"), "utf8"))
      .providers.codemux.models[0].id).toBe("glm-5.3-flash");
  });

  test("the override and --tools none coexist", () => {
    const adapter = adapterOf(ZAI_PI);
    const request: RunRequest = {
      agent: "pi",
      prompt: "p",
      cwd: cwdOf(),
      tools: "none",
      autonomy: "read-only",
    };
    prepare(adapter, request);
    expect(adapter.buildRunCommand(request))
      .toEqual([...head, "--model", "codemux/glm-5.3", "--no-extensions", "--no-tools"]);
  });

  test("an unprepared override fails closed before any launch", () => {
    const adapter = adapterOf(ZAI_PI);
    expect(adapter.buildRunCommand({ agent: "pi", prompt: "p", cwd: cwdOf() } as RunRequest))
      .toEqual([...head, "--model", "codemux/glm-5.3"]);
    expect(() => adapter.getRunEnv({ agent: "pi", prompt: "p" } as RunRequest))
      .toThrow("pi provider agent directory was not prepared before launch");
  });

  test("every prepared run gets a fresh directory; cleanupRun removes each launch's own only", () => {
    const adapter = adapterOf(ZAI_PI);
    const request: RunRequest = { agent: "pi", prompt: "p", cwd: cwdOf() };
    const firstContext = prepare(adapter, request);
    const first = adapter.getRunEnv(request, firstContext).PI_CODING_AGENT_DIR!;
    const secondContext = prepare(adapter, request);
    const second = adapter.getRunEnv(request, secondContext).PI_CODING_AGENT_DIR!;
    expect(second).not.toBe(first);
    // The earlier directory stays until its own launch ends: an earlier run
    // may still read it.
    expect(statSync(first).isDirectory()).toBe(true);
    adapter.cleanupRun(firstContext);
    expect(() => statSync(first)).toThrow();
    expect(statSync(second).isDirectory()).toBe(true);
  });

  test("a keyless override fails validation with the missing name", () => {
    const adapter = adapterOf({
      CODEMUX_PI_PROVIDER_BASE_URL: ZAI_PI.CODEMUX_PI_PROVIDER_BASE_URL,
      CODEMUX_PI_PROVIDER_MODEL: "glm-5.3",
    });
    expect(() => adapter.validateRunRequest({ agent: "pi", prompt: "p", cwd: cwdOf() } as RunRequest))
      .toThrow("provider override is missing CODEMUX_PI_PROVIDER_API_KEY");
  });

  test("an override without any model fails validation", () => {
    const adapter = adapterOf({
      CODEMUX_PI_PROVIDER_BASE_URL: ZAI_PI.CODEMUX_PI_PROVIDER_BASE_URL,
      CODEMUX_PI_PROVIDER_API_KEY: ZAI_PI.CODEMUX_PI_PROVIDER_API_KEY,
    });
    expect(() => adapter.validateRunRequest({ agent: "pi", prompt: "p", cwd: cwdOf() } as RunRequest))
      .toThrow("pi needs a model for the provider override");
  });

  test("a model with braces is refused: models.json expands $VAR/${VAR} templates", () => {
    // Regression (h6 review): the h4 brace refusal covered the base URL
    // only, but the model lands in the same template-expanded file — in
    // the entry's id and name — so a crafted model id could splice an
    // environment variable's value into the models.json codemux writes
    // (validateModelName allows braces). validateRunRequest refuses it
    // before launch, and the write refuses it before creating anything.
    const home = mkdtempSync(join(tmpdir(), "codemux-pi-home-"));
    scratch.push(home);
    const adapter = new PiAdapter(
      { ...ZAI_PI, CODEMUX_PI_PROVIDER_MODEL: "glm-${CODEMUX_PI_PROVIDER_API_KEY}" },
      home
    );
    const request: RunRequest = { agent: "pi", prompt: "p", cwd: cwdOf() };
    expect(() => adapter.validateRunRequest(request))
      .toThrow("must not contain '{' or '}'");
    expect(() => adapter.prepareRun(request))
      .toThrow("must not contain '{' or '}'");
    expect(existsSync(join(home, ".pi"))).toBe(false);
  });

  test("the tui refuses the override; without one it is unchanged", () => {
    const plain = adapterOf();
    expect(() => plain.validateTuiRequest(undefined, cwdOf())).not.toThrow();
    expect(plain.buildTuiCommand(undefined, "high")).toEqual(["pi", "--no-approve"]);
    const adapter = adapterOf(ZAI_PI);
    expect(() => adapter.validateTuiRequest(undefined, cwdOf()))
      .toThrow("supports headless runs only");
  });

  test("a passed-through PI_CODING_AGENT_DIR relocates the private directory", () => {
    const env: NodeJS.ProcessEnv = { ...ZAI_PI };
    const passed = mkdtempSync(join(tmpdir(), "codemux-pi-passed-"));
    scratch.push(passed);
    const home = mkdtempSync(join(tmpdir(), "codemux-pi-home-"));
    scratch.push(home);
    const request = {
      agent: "pi" as const,
      prompt: "p",
      cwd: cwdOf(),
      passthroughEnv: ["PI_CODING_AGENT_DIR"],
    };
    const dropped = new PiAdapter(env, home);
    const droppedContext = prepare(dropped, request as RunRequest);
    expect(dropped.getRunEnv(request as RunRequest, droppedContext).PI_CODING_AGENT_DIR!)
      .toContain(join(home, ".pi", "agent", ".codemux"));

    env.PI_CODING_AGENT_DIR = join(passed, "agent");
    const honoring = new PiAdapter(env, home);
    const honoringContext = prepare(honoring, request as RunRequest);
    expect(honoring.getRunEnv(request as RunRequest, honoringContext).PI_CODING_AGENT_DIR!)
      .toContain(join(passed, "agent", ".codemux", `provider-${process.pid}-`));

    env.PI_CODING_AGENT_DIR = "relative/path";
    const relative = new PiAdapter(env, home);
    expect(() => relative.prepareRun(request as RunRequest))
      .toThrow("passed-through PI_CODING_AGENT_DIR must be an absolute path");
  });
});

const ZAI_GOOSE = {
  CODEMUX_GOOSE_PROVIDER_BASE_URL: "https://api.z.ai/api/coding/paas/v4",
  CODEMUX_GOOSE_PROVIDER_API_KEY: "test-key-do-not-print",
  CODEMUX_GOOSE_PROVIDER_MODEL: "glm-5.3",
};

describe("goose provider override", () => {
  const scratch: string[] = [];
  afterEach(() => {
    while (scratch.length > 0) {
      const dir = scratch.pop()!;
      rmSync(dir, { recursive: true, force: true });
    }
  });
  const cwdOf = (): string => {
    const cwd = mkdtempSync(join(tmpdir(), "codemux-goose-override-"));
    mkdirSync(join(cwd, ".git"));
    scratch.push(cwd);
    return cwd;
  };
  const run = (env: NodeJS.ProcessEnv, request: Partial<RunRequest> = {}): string[] =>
    new GooseAdapter(env).buildRunCommand({
      agent: "goose",
      prompt: "p",
      cwd: cwdOf(),
      ...request,
    } as RunRequest);

  test("without an override nothing changes", () => {
    const adapter = new GooseAdapter({});
    expect(adapter.getRunEnv({ agent: "goose", prompt: "p", autonomy: "high" } as RunRequest))
      .toEqual({ GOOSE_MODE: "auto" });
    expect(run({})).toEqual(["goose", "run", "-t", "p"]);
    // An operator model still rides GOOSE_MODEL.
    expect(adapter.getRunEnv({ agent: "goose", prompt: "p", model: "gpt-5.3" } as RunRequest))
      .toEqual({ GOOSE_MODE: "chat", GOOSE_MODEL: "gpt-5.3" });
  });

  test("the override rides the OPENAI_* environment group goose reads first", () => {
    const adapter = new GooseAdapter(ZAI_GOOSE);
    expect(adapter.getRunEnv({ agent: "goose", prompt: "p", autonomy: "high" } as RunRequest))
      .toEqual({
        GOOSE_MODE: "auto",
        GOOSE_PROVIDER: "openai",
        OPENAI_HOST: "https://api.z.ai",
        OPENAI_BASE_PATH: "api/coding/paas/v4/chat/completions",
        OPENAI_API_KEY: ZAI_GOOSE.CODEMUX_GOOSE_PROVIDER_API_KEY,
        GOOSE_MODEL: "glm-5.3",
      });
    const cmd = run(ZAI_GOOSE);
    expect(cmd).toEqual(["goose", "run", "-t", "p"]);
    expect(cmd.join(" ")).not.toContain(ZAI_GOOSE.CODEMUX_GOOSE_PROVIDER_API_KEY);
  });

  test("the endpoint split mirrors goose's own base-path derivation", () => {
    // The Z.AI OpenAI-compatible endpoint: a version segment gains the
    // chat-completions suffix.
    expect(gooseOpenAiEndpoint("https://api.z.ai/api/coding/paas/v4")).toEqual({
      host: "https://api.z.ai",
      basePath: "api/coding/paas/v4/chat/completions",
    });
    expect(gooseOpenAiEndpoint("https://proxy.example")).toEqual({
      host: "https://proxy.example",
      basePath: "v1/chat/completions",
    });
    expect(gooseOpenAiEndpoint("https://proxy.example/v1")).toEqual({
      host: "https://proxy.example",
      basePath: "v1/chat/completions",
    });
    expect(gooseOpenAiEndpoint("https://proxy.example/openai/v1/chat/completions")).toEqual({
      host: "https://proxy.example",
      basePath: "openai/v1/chat/completions",
    });
    expect(gooseOpenAiEndpoint("https://opencode.ai/zen/go")).toEqual({
      host: "https://opencode.ai",
      basePath: "zen/go/v1/chat/completions",
    });
    expect(gooseOpenAiEndpoint("http://localhost:8080")).toEqual({
      host: "http://localhost:8080",
      basePath: "v1/chat/completions",
    });
    // A query string cannot ride the host/path pair goose consumes.
    expect(() => gooseOpenAiEndpoint("https://gw.example/v1?api-version=2024-02-01"))
      .toThrow("cannot map onto goose's OPENAI_HOST/OPENAI_BASE_PATH");
  });

  test("an explicit --model wins as the routed GOOSE_MODEL", () => {
    const adapter = new GooseAdapter(ZAI_GOOSE);
    expect(adapter.getRunEnv({ agent: "goose", prompt: "p", model: "glm-5.3-flash" } as RunRequest))
      .toMatchObject({ GOOSE_MODEL: "glm-5.3-flash" });
  });

  test("the override and --tools none coexist", () => {
    const adapter = new GooseAdapter(ZAI_GOOSE);
    const request = { agent: "goose" as const, prompt: "p", cwd: cwdOf(), tools: "none" as const };
    expect(adapter.buildRunCommand(request as RunRequest))
      .toEqual(["goose", "run", "--no-profile", "-t", "p"]);
    expect(adapter.getRunEnv(request as RunRequest)).toMatchObject({
      OPENAI_API_KEY: ZAI_GOOSE.CODEMUX_GOOSE_PROVIDER_API_KEY,
      GOOSE_MODEL: "glm-5.3",
    });
  });

  test("a keyless override fails validation with the missing name", () => {
    const adapter = new GooseAdapter({
      CODEMUX_GOOSE_PROVIDER_BASE_URL: ZAI_GOOSE.CODEMUX_GOOSE_PROVIDER_BASE_URL,
      CODEMUX_GOOSE_PROVIDER_MODEL: "glm-5.3",
    });
    expect(() => adapter.validateRunRequest({ agent: "goose", prompt: "p", cwd: cwdOf() } as RunRequest))
      .toThrow("provider override is missing CODEMUX_GOOSE_PROVIDER_API_KEY");
  });

  test("an override without any model fails validation", () => {
    const adapter = new GooseAdapter({
      CODEMUX_GOOSE_PROVIDER_BASE_URL: ZAI_GOOSE.CODEMUX_GOOSE_PROVIDER_BASE_URL,
      CODEMUX_GOOSE_PROVIDER_API_KEY: ZAI_GOOSE.CODEMUX_GOOSE_PROVIDER_API_KEY,
    });
    expect(() => adapter.validateRunRequest({ agent: "goose", prompt: "p", cwd: cwdOf() } as RunRequest))
      .toThrow("goose needs a model for the provider override");
    expect(() => adapter.validateTuiRequest(undefined, cwdOf()))
      .toThrow("goose needs a model for the provider override");
  });

  test("the tui command and env carry the same override", () => {
    const adapter = new GooseAdapter(ZAI_GOOSE);
    expect(adapter.buildTuiCommand(undefined, "high")).toEqual(["goose"]);
    expect(adapter.getTuiEnv("glm-5.3", "high")).toEqual({
      GOOSE_MODE: "auto",
      GOOSE_PROVIDER: "openai",
      OPENAI_HOST: "https://api.z.ai",
      OPENAI_BASE_PATH: "api/coding/paas/v4/chat/completions",
      OPENAI_API_KEY: ZAI_GOOSE.CODEMUX_GOOSE_PROVIDER_API_KEY,
      GOOSE_MODEL: "glm-5.3",
    });
  });

  test("both token caps are refused: the knobs live only in goose's config file", () => {
    // Regression: goose's per-model max_tokens/context_limit exist only in
    // the config file the override never writes; a set cap must fail the
    // run rather than ride along silently uncapped.
    const request = { agent: "goose" as const, prompt: "p", cwd: cwdOf() };
    const outputCap = new GooseAdapter({
      ...ZAI_GOOSE,
      CODEMUX_GOOSE_PROVIDER_MAX_OUTPUT_TOKENS: "4096",
    });
    expect(() => outputCap.validateRunRequest(request as RunRequest))
      .toThrow("CODEMUX_GOOSE_PROVIDER_MAX_OUTPUT_TOKENS cannot be honored");
    const contextCap = new GooseAdapter({
      ...ZAI_GOOSE,
      CODEMUX_GOOSE_PROVIDER_MAX_CONTEXT_TOKENS: "32768",
    });
    expect(() => contextCap.getRunEnv(request as RunRequest))
      .toThrow("CODEMUX_GOOSE_PROVIDER_MAX_CONTEXT_TOKENS cannot be honored");
  });
});

const VLLM_CLAUDE = {
  CODEMUX_CLAUDE_PROVIDER_BASE_URL: "http://localhost:8011",
  CODEMUX_CLAUDE_PROVIDER_API_KEY: "test-key-do-not-print",
  CODEMUX_CLAUDE_PROVIDER_MODEL: "clawvm-qwen32b-coder",
};

describe("claude provider override", () => {
  const scratch: string[] = [];
  afterEach(() => {
    while (scratch.length > 0) {
      const dir = scratch.pop()!;
      rmSync(dir, { recursive: true, force: true });
    }
  });
  const adapterOf = (env: NodeJS.ProcessEnv = {}): ClaudeAdapter => new ClaudeAdapter(env);

  test("without an override nothing changes", () => {
    const adapter = adapterOf();
    expect(adapter.getEnv()).toEqual({ CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: "1" });
    expect(adapter.getEnvOmissions()).toEqual([]);
    expect(adapter.buildRunCommand({ agent: "claude", prompt: "p" } as RunRequest))
      .not.toContain("--model");
  });

  test("the override rides the gateway env; the operator login stays out", () => {
    const adapter = adapterOf(VLLM_CLAUDE);
    const model = VLLM_CLAUDE.CODEMUX_CLAUDE_PROVIDER_MODEL;
    expect(adapter.getEnv()).toEqual({
      ANTHROPIC_AUTH_TOKEN: VLLM_CLAUDE.CODEMUX_CLAUDE_PROVIDER_API_KEY,
      ANTHROPIC_BASE_URL: VLLM_CLAUDE.CODEMUX_CLAUDE_PROVIDER_BASE_URL,
      // Every tier Claude Code picks on its own goes to the same model, so
      // background requests and subagents never ask the endpoint for a
      // model it does not serve.
      ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
      ANTHROPIC_SMALL_FAST_MODEL: model,
      ANTHROPIC_DEFAULT_SONNET_MODEL: model,
      ANTHROPIC_DEFAULT_OPUS_MODEL: model,
      CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: "1",
    });
    // The token is the credential; a stray operator API key or OAuth token
    // would be a second, operator-funded authentication path.
    expect(adapter.getEnvOmissions()).toEqual(["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"]);
  });

  test("the model is always explicit: the override's, else --model's", () => {
    const adapter = adapterOf(VLLM_CLAUDE);
    const request: RunRequest = { agent: "claude", prompt: "p" };
    expect(adapter.buildRunCommand(request)).toContain("clawvm-qwen32b-coder");
    const explicit = adapterOf(VLLM_CLAUDE);
    const cmd = explicit.buildRunCommand({
      agent: "claude",
      prompt: "p",
      model: "other-model",
    } as RunRequest);
    expect(cmd[cmd.indexOf("--model") + 1]).toBe("other-model");
  });

  test("an override without any model fails validation; a keyless override names it", () => {
    const keyless = adapterOf({
      CODEMUX_CLAUDE_PROVIDER_BASE_URL: VLLM_CLAUDE.CODEMUX_CLAUDE_PROVIDER_BASE_URL,
    });
    expect(() => keyless.validateRunRequest({ agent: "claude", prompt: "p" } as RunRequest))
      .toThrow("provider override is missing CODEMUX_CLAUDE_PROVIDER_API_KEY");
    const modelless = adapterOf({
      CODEMUX_CLAUDE_PROVIDER_BASE_URL: VLLM_CLAUDE.CODEMUX_CLAUDE_PROVIDER_BASE_URL,
      CODEMUX_CLAUDE_PROVIDER_API_KEY: VLLM_CLAUDE.CODEMUX_CLAUDE_PROVIDER_API_KEY,
    });
    expect(() => modelless.validateRunRequest({ agent: "claude", prompt: "p" } as RunRequest))
      .toThrow("claude needs a model for the provider override");
    expect(() => modelless.validateTuiRequest(undefined, undefined))
      .toThrow("claude needs a model for the provider override");
  });

  test("the output cap rides CLAUDE_CODE_MAX_OUTPUT_TOKENS; the context cap is refused", () => {
    const adapter = adapterOf({
      ...VLLM_CLAUDE,
      CODEMUX_CLAUDE_PROVIDER_MAX_OUTPUT_TOKENS: "4096",
    });
    expect(adapter.getEnv().CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBe("4096");
    const capped = adapterOf({
      ...VLLM_CLAUDE,
      CODEMUX_CLAUDE_PROVIDER_MAX_CONTEXT_TOKENS: "32768",
    });
    expect(() => capped.validateRunRequest({ agent: "claude", prompt: "p" } as RunRequest))
      .toThrow("CODEMUX_CLAUDE_PROVIDER_MAX_CONTEXT_TOKENS cannot be honored");
    // And without the cap the env carries only the gateway.
    expect(adapterOf(VLLM_CLAUDE).getEnv()).not.toHaveProperty("CLAUDE_CODE_MAX_OUTPUT_TOKENS");
  });

  test("the tui carries the override's model fallback, same as a run", () => {
    const adapter = adapterOf(VLLM_CLAUDE);
    expect(adapter.buildTuiCommand("other-model")).toContain("other-model");
    expect(adapter.buildTuiCommand(undefined)).toContain("clawvm-qwen32b-coder");
  });

  test("the sanitizer keeps the gateway env and drops the operator's own login", () => {
    const adapter = adapterOf(VLLM_CLAUDE);
    const saved: [string, string | undefined][] = [
      ["ANTHROPIC_API_KEY", process.env.ANTHROPIC_API_KEY],
      ["CLAUDE_CODE_OAUTH_TOKEN", process.env.CLAUDE_CODE_OAUTH_TOKEN],
    ];
    process.env.ANTHROPIC_API_KEY = "operator-key-do-not-print";
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "operator-token-do-not-print";
    try {
      const env = adapter.buildExecutionEnv();
      expect(env.ANTHROPIC_AUTH_TOKEN).toBe(VLLM_CLAUDE.CODEMUX_CLAUDE_PROVIDER_API_KEY);
      expect(env.ANTHROPIC_BASE_URL).toBe(VLLM_CLAUDE.CODEMUX_CLAUDE_PROVIDER_BASE_URL);
      expect(env.ANTHROPIC_API_KEY).toBeUndefined();
      expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    } finally {
      for (const [name, value] of saved) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  test("the sandbox sync is skipped under an override; a refresh token refuses only when a Keychain entry owns the login", () => {
    // Nothing of the operator's login may be copied for a run that does not
    // use it: prepareSandbox must not read the Keychain at all. The mirror
    // is still guarded, because the child reads ~/.claude whatever
    // credential it uses.
    const home = mkdtempSync(join(tmpdir(), "codemux-claude-home-"));
    scratch.push(home);
    const mirror = join(home, ".credentials.json");
    writeFileSync(
      mirror,
      JSON.stringify({ claudeAiOauth: { accessToken: "t", refreshToken: "" } })
    );
    let keychainReads = 0;
    class TestableClaudeAdapter extends ClaudeAdapter {
      protected override credentialReader: SecretReader = () => {
        keychainReads++;
        return { kind: "missing" };
      };
      protected override credentialTarget = (): string => mirror;
      protected override credentialBackupDir = (): string => home;
    }
    // A plain run syncs an existing mirror, so the Keychain is consulted.
    const noKeychainSync = process.env.CODEMUX_NO_KEYCHAIN_SYNC;
    delete process.env.CODEMUX_NO_KEYCHAIN_SYNC;
    try {
      const plain = new TestableClaudeAdapter({});
      expect(() => plain.prepareSandbox()).not.toThrow();
      expect(keychainReads).toBeGreaterThan(0);

      const override = new TestableClaudeAdapter(VLLM_CLAUDE);
      keychainReads = 0;
      expect(() => override.prepareSandbox()).not.toThrow();
      expect(keychainReads).toBe(0);

      writeFileSync(
        mirror,
        JSON.stringify({ claudeAiOauth: { accessToken: "t", refreshToken: "rt" } })
      );
      // No Keychain entry (Linux, a file-only login): the file is Claude
      // Code's only store, the token is normal, the launch proceeds and the
      // file is left alone. Presence was checked, nothing copied.
      expect(() => override.prepareSandbox()).not.toThrow();
      expect(keychainReads).toBe(1);
      expect(readFileSync(mirror, "utf8")).toContain('"rt"');
      // The Keychain opt-out means "do not consult the Keychain" here too:
      // reported, never refused, and no read happens.
      process.env.CODEMUX_NO_KEYCHAIN_SYNC = "1";
      keychainReads = 0;
      expect(() => override.prepareSandbox()).not.toThrow();
      expect(keychainReads).toBe(0);
      delete process.env.CODEMUX_NO_KEYCHAIN_SYNC;
      // A Keychain entry owns the login: the file is a mirror and the
      // token in it is the second copy — refused.
      class MirroredClaudeAdapter extends TestableClaudeAdapter {
        protected override credentialReader: SecretReader = () => ({
          kind: "secret",
          value: JSON.stringify({ claudeAiOauth: { accessToken: "k", refreshToken: "k" } }),
        });
      }
      expect(() => new MirroredClaudeAdapter(VLLM_CLAUDE).prepareSandbox()).toThrow(/holds a refresh token/);
      expect(readFileSync(mirror, "utf8")).toContain('"rt"'); // untouched either way
    } finally {
      if (noKeychainSync !== undefined) process.env.CODEMUX_NO_KEYCHAIN_SYNC = noKeychainSync;
    }
  });
});

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

  test("the tui refuses the override; without one it is unchanged", () => {
    expect(() => adapterOf().validateTuiRequest(undefined, cwdOf())).not.toThrow();
    expect(() => adapterOf(VLLM_CODEX).validateTuiRequest(undefined, cwdOf()))
      .toThrow("supports headless runs only");
  });
});

const VLLM_OPENHANDS = {
  CODEMUX_OPENHANDS_PROVIDER_BASE_URL: "http://localhost:8011/v1",
  CODEMUX_OPENHANDS_PROVIDER_API_KEY: "test-key-do-not-print",
  CODEMUX_OPENHANDS_PROVIDER_MODEL: "clawvm-qwen32b-coder",
};

describe("openhands provider override", () => {
  const scratch: string[] = [];
  afterEach(() => {
    while (scratch.length > 0) {
      const dir = scratch.pop()!;
      rmSync(dir, { recursive: true, force: true });
    }
  });
  const cwdOf = (): string => {
    const cwd = mkdtempSync(join(tmpdir(), "codemux-openhands-override-"));
    mkdirSync(join(cwd, ".git"));
    scratch.push(cwd);
    return cwd;
  };
  const adapterOf = (env: NodeJS.ProcessEnv = {}): OpenHandsAdapter => new OpenHandsAdapter(env);

  test("without an override nothing changes", () => {
    const adapter = adapterOf();
    expect(adapter.getRunEnv({ agent: "openhands", prompt: "p" } as RunRequest)).toEqual({});
    expect(adapter.buildRunCommand({ agent: "openhands", prompt: "p" } as RunRequest))
      .toEqual(["openhands", "--headless", "--task", "p"]);
  });

  test("the override rides the LLM_* trio with the openai/ prefix and --override-with-envs", () => {
    const adapter = adapterOf(VLLM_OPENHANDS);
    const request: RunRequest = { agent: "openhands", prompt: "p" };
    expect(adapter.getRunEnv(request)).toEqual({
      LLM_BASE_URL: VLLM_OPENHANDS.CODEMUX_OPENHANDS_PROVIDER_BASE_URL,
      LLM_API_KEY: VLLM_OPENHANDS.CODEMUX_OPENHANDS_PROVIDER_API_KEY,
      LLM_MODEL: "openai/clawvm-qwen32b-coder",
    });
    const cmd = adapter.buildRunCommand(request);
    expect(cmd).toEqual([
      "openhands",
      "--headless",
      "--override-with-envs",
      "--task",
      "p",
    ]);
    expect(cmd.join(" ")).not.toContain(VLLM_OPENHANDS.CODEMUX_OPENHANDS_PROVIDER_API_KEY);
    // An explicit --model wins and is prefixed once.
    expect(adapter.getRunEnv({ ...request, model: "other-model" } as RunRequest).LLM_MODEL)
      .toBe("openai/other-model");
    expect(adapter.getRunEnv({ ...request, model: "openai/other-model" } as RunRequest).LLM_MODEL)
      .toBe("openai/other-model");
  });

  test("a half-configured override fails validation with the missing name", () => {
    const adapter = adapterOf({
      CODEMUX_OPENHANDS_PROVIDER_BASE_URL: VLLM_OPENHANDS.CODEMUX_OPENHANDS_PROVIDER_BASE_URL,
    });
    expect(() => adapter.validateRunRequest({ agent: "openhands", prompt: "p", cwd: cwdOf() } as RunRequest))
      .toThrow("provider override is missing CODEMUX_OPENHANDS_PROVIDER_API_KEY");
    const modelless = adapterOf({
      CODEMUX_OPENHANDS_PROVIDER_BASE_URL: VLLM_OPENHANDS.CODEMUX_OPENHANDS_PROVIDER_BASE_URL,
      CODEMUX_OPENHANDS_PROVIDER_API_KEY: VLLM_OPENHANDS.CODEMUX_OPENHANDS_PROVIDER_API_KEY,
    });
    expect(() => modelless.validateRunRequest({ agent: "openhands", prompt: "p", cwd: cwdOf() } as RunRequest))
      .toThrow("openhands needs a model for the provider override");
    expect(() => modelless.validateTuiRequest(undefined, cwdOf()))
      .toThrow("openhands needs a model for the provider override");
  });

  test("both token caps are refused: the env trio is the entire override surface", () => {
    const outputCap = adapterOf({
      ...VLLM_OPENHANDS,
      CODEMUX_OPENHANDS_PROVIDER_MAX_OUTPUT_TOKENS: "4096",
    });
    expect(() =>
      outputCap.validateRunRequest({ agent: "openhands", prompt: "p", cwd: cwdOf() } as RunRequest)
    ).toThrow("CODEMUX_OPENHANDS_PROVIDER_MAX_OUTPUT_TOKENS cannot be honored");
    const contextCap = adapterOf({
      ...VLLM_OPENHANDS,
      CODEMUX_OPENHANDS_PROVIDER_MAX_CONTEXT_TOKENS: "32768",
    });
    expect(() =>
      contextCap.getRunEnv({ agent: "openhands", prompt: "p" } as RunRequest)
    ).toThrow("CODEMUX_OPENHANDS_PROVIDER_MAX_CONTEXT_TOKENS cannot be honored");
  });

  test("the tui command and env carry the same override", () => {
    const adapter = adapterOf(VLLM_OPENHANDS);
    expect(adapter.buildTuiCommand("clawvm-qwen32b-coder"))
      .toEqual(["openhands", "--override-with-envs"]);
    expect(adapter.getTuiEnv()).toEqual({
      LLM_BASE_URL: VLLM_OPENHANDS.CODEMUX_OPENHANDS_PROVIDER_BASE_URL,
      LLM_API_KEY: VLLM_OPENHANDS.CODEMUX_OPENHANDS_PROVIDER_API_KEY,
      LLM_MODEL: "openai/clawvm-qwen32b-coder",
    });
  });

  test("an override launch warns that LLM_API_KEY is visible to the model", () => {
    // Round-5 security finding: OpenHands' terminal tool builds the shell's
    // environment from the CLI process's own (both the subprocess and the
    // tmux implementation; its sanitizer strips only SESSION_API_KEY), so
    // the override key reaches any command the model runs. No exclusion
    // channel exists, so every launch that carries an override says so.
    const errors: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    };
    try {
      adapterOf(VLLM_OPENHANDS).beforeLaunch();
      expect(errors.length).toBe(1);
      expect(errors[0]).toContain("openhands: provider override active");
      expect(errors[0]).toContain("LLM_API_KEY is visible to the model");
      // Without an override there is nothing to disclose.
      errors.length = 0;
      adapterOf().beforeLaunch();
      expect(errors).toEqual([]);
    } finally {
      console.error = originalError;
    }
  });
});

