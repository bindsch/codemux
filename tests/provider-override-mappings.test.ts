import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AiderAdapter } from "../src/adapters/aider.js";
import { DroidAdapter } from "../src/adapters/droid.js";
import { KimiAdapter } from "../src/adapters/kimi.js";
import { OpenHandsAdapter } from "../src/adapters/openhands.js";
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
});

const ZAI_OPENHANDS = {
  CODEMUX_OPENHANDS_PROVIDER_BASE_URL: "https://api.z.ai/api/coding/paas/v4",
  CODEMUX_OPENHANDS_PROVIDER_API_KEY: "test-key-do-not-print",
  CODEMUX_OPENHANDS_PROVIDER_MODEL: "glm-5.3",
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
  const run = (env: NodeJS.ProcessEnv, request: Partial<RunRequest> = {}): string[] =>
    new OpenHandsAdapter(env).buildRunCommand({
      agent: "openhands",
      prompt: "p",
      cwd: cwdOf(),
      ...request,
    } as RunRequest);

  test("without an override nothing changes", () => {
    const adapter = new OpenHandsAdapter({});
    expect(adapter.getRunEnv({ agent: "openhands", prompt: "p" } as RunRequest)).toEqual({});
    expect(run({})).not.toContain("--override-with-envs");
  });

  test("the override rides LLM_BASE_URL/LLM_API_KEY/LLM_MODEL and the openai/ prefix", () => {
    const adapter = new OpenHandsAdapter(ZAI_OPENHANDS);
    expect(adapter.getRunEnv({ agent: "openhands", prompt: "p" } as RunRequest)).toEqual({
      LLM_BASE_URL: ZAI_OPENHANDS.CODEMUX_OPENHANDS_PROVIDER_BASE_URL,
      LLM_API_KEY: ZAI_OPENHANDS.CODEMUX_OPENHANDS_PROVIDER_API_KEY,
      LLM_MODEL: "openai/glm-5.3",
    });
    const cmd = run(ZAI_OPENHANDS);
    // The model exists only through the environment, so the env gate rides along.
    expect(cmd).toContain("--override-with-envs");
    // The key never rides argv.
    expect(cmd.join(" ")).not.toContain(ZAI_OPENHANDS.CODEMUX_OPENHANDS_PROVIDER_API_KEY);
  });

  test("an explicit --model wins and is prefixed once", () => {
    const adapter = new OpenHandsAdapter(ZAI_OPENHANDS);
    expect(
      adapter.getRunEnv({ agent: "openhands", prompt: "p", model: "glm-5.3-flash" } as RunRequest)
    ).toMatchObject({ LLM_MODEL: "openai/glm-5.3-flash" });
    expect(
      adapter.getRunEnv({ agent: "openhands", prompt: "p", model: "openai/glm-5.3" } as RunRequest)
    ).toMatchObject({ LLM_MODEL: "openai/glm-5.3" });
    // Without an override the model stays unprefixed.
    expect(
      new OpenHandsAdapter({}).getRunEnv({
        agent: "openhands",
        prompt: "p",
        model: "anthropic/claude-sonnet-5",
      } as RunRequest)
    ).toEqual({ LLM_MODEL: "anthropic/claude-sonnet-5" });
  });

  test("a keyless override fails validation with the missing name", () => {
    const adapter = new OpenHandsAdapter({
      CODEMUX_OPENHANDS_PROVIDER_BASE_URL: ZAI_OPENHANDS.CODEMUX_OPENHANDS_PROVIDER_BASE_URL,
      CODEMUX_OPENHANDS_PROVIDER_MODEL: "glm-5.3",
    });
    expect(() =>
      adapter.validateRunRequest({
        agent: "openhands",
        prompt: "p",
        cwd: cwdOf(),
      } as RunRequest)
    ).toThrow("provider override is missing CODEMUX_OPENHANDS_PROVIDER_API_KEY");
  });

  test("an override without any model fails validation, headless and tui", () => {
    const adapter = new OpenHandsAdapter({
      CODEMUX_OPENHANDS_PROVIDER_BASE_URL: ZAI_OPENHANDS.CODEMUX_OPENHANDS_PROVIDER_BASE_URL,
      CODEMUX_OPENHANDS_PROVIDER_API_KEY: ZAI_OPENHANDS.CODEMUX_OPENHANDS_PROVIDER_API_KEY,
    });
    expect(() =>
      adapter.validateRunRequest({
        agent: "openhands",
        prompt: "p",
        cwd: cwdOf(),
      } as RunRequest)
    ).toThrow("openhands needs a model for the provider override");
    expect(() => adapter.validateTuiRequest(undefined, cwdOf()))
      .toThrow("openhands needs a model for the provider override");
  });

  test("the tui command and env carry the same override, model or not", () => {
    const adapter = new OpenHandsAdapter(ZAI_OPENHANDS);
    expect(adapter.buildTuiCommand(undefined, "high")).toContain("--override-with-envs");
    expect(adapter.buildTuiCommand("glm-5.3", "high")).toContain("--override-with-envs");
    expect(adapter.getTuiEnv()).toEqual({
      LLM_BASE_URL: ZAI_OPENHANDS.CODEMUX_OPENHANDS_PROVIDER_BASE_URL,
      LLM_API_KEY: ZAI_OPENHANDS.CODEMUX_OPENHANDS_PROVIDER_API_KEY,
      LLM_MODEL: "openai/glm-5.3",
    });
  });
});

const ZAI_KIMI = {
  CODEMUX_KIMI_PROVIDER_BASE_URL: "https://api.z.ai/api/coding/paas/v4",
  CODEMUX_KIMI_PROVIDER_API_KEY: "test-key-do-not-print",
  CODEMUX_KIMI_PROVIDER_MODEL: "glm-5.3",
};

describe("kimi provider override", () => {
  const scratch: string[] = [];
  const adapters: KimiAdapter[] = [];
  afterEach(() => {
    for (const adapter of adapters.splice(0)) adapter.disposeNoToolsFiles();
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
  const adapterOf = (env: NodeJS.ProcessEnv = {}): KimiAdapter => {
    const adapter = new KimiAdapter(env);
    adapters.push(adapter);
    return adapter;
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
    const request = { agent: "kimi" as const, prompt: "p", tools: "none" as const, cwd: cwdOf() };
    adapter.prepareRun(request);
    const cmd = adapter.buildRunCommand(request);
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
});

const ZAI_DROID = {
  CODEMUX_DROID_PROVIDER_BASE_URL: "https://api.z.ai/api/coding/paas/v4",
  CODEMUX_DROID_PROVIDER_API_KEY: "test-key-do-not-print",
  CODEMUX_DROID_PROVIDER_MODEL: "glm-5.3",
};

describe("droid provider override", () => {
  const scratch: string[] = [];
  const adapters: DroidAdapter[] = [];
  afterEach(() => {
    for (const adapter of adapters.splice(0)) adapter.disposeProviderSettings();
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
    const adapter = new DroidAdapter(env, home);
    adapters.push(adapter);
    return adapter;
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
    const request = { agent: "droid" as const, prompt: "p", cwd: cwdOf() };
    adapter.prepareRun(request);
    const path = adapter.buildRunCommand(request as RunRequest)[2]!;
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
    expect(adapter.getRunEnv(request as RunRequest)).toEqual({
      CODEMUX_DROID_PROVIDER_API_KEY: ZAI_DROID.CODEMUX_DROID_PROVIDER_API_KEY,
    });
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  test("the command selects the override's model through -m", () => {
    const adapter = adapterOf(ZAI_DROID);
    const request = { agent: "droid" as const, prompt: "p", cwd: cwdOf() };
    adapter.prepareRun(request);
    const cmd = adapter.buildRunCommand(request as RunRequest);
    expect(cmd.slice(0, 3)).toEqual(["droid", "--settings", cmd[2]!]);
    expect(cmd.slice(3)).toEqual(["exec", "-m", "custom:codemux:glm-5.3-0"]);
    expect(cmd.join(" ")).not.toContain(ZAI_DROID.CODEMUX_DROID_PROVIDER_API_KEY);
  });

  test("an explicit --model wins as the routed model id", () => {
    const adapter = adapterOf(ZAI_DROID);
    const request = { agent: "droid" as const, prompt: "p", cwd: cwdOf(), model: "glm-5.3-flash" };
    adapter.prepareRun(request as RunRequest);
    const path = adapter.buildRunCommand(request as RunRequest)[2]!;
    expect(JSON.parse(readFileSync(path, "utf8")).customModels[0].model).toBe("glm-5.3-flash");
    expect(adapter.buildRunCommand(request as RunRequest).slice(3))
      .toEqual(["exec", "-m", "custom:codemux:glm-5.3-flash-0"]);
  });

  test("the override and --tools none coexist", () => {
    const adapter = adapterOf(ZAI_DROID);
    const request = { agent: "droid" as const, prompt: "p", cwd: cwdOf(), tools: "none" as const, autonomy: "high" as const };
    adapter.prepareRun(request as RunRequest);
    expect(adapter.buildRunCommand(request as RunRequest).slice(3))
      .toEqual(["exec", "-m", "custom:codemux:glm-5.3-0", "--auto", "high", "--only-tools", "ToolSearch"]);
    expect(adapter.getRunEnv(request as RunRequest)).toEqual({
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

  test("dispose removes every prepared settings file", () => {
    const adapter = adapterOf(ZAI_DROID);
    const request = { agent: "droid" as const, prompt: "p", cwd: cwdOf() };
    adapter.prepareRun(request);
    const first = adapter.buildRunCommand(request as RunRequest)[2]!;
    adapter.prepareRun(request);
    const second = adapter.buildRunCommand(request as RunRequest)[2]!;
    expect(second).not.toBe(first);
    // The earlier file stays until exit: an earlier run may still read it.
    expect(statSync(first).isFile()).toBe(true);
    adapter.disposeProviderSettings();
    expect(() => statSync(first)).toThrow();
    expect(() => statSync(second)).toThrow();
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

  test("the tui refuses the override; without one it is unchanged", () => {
    const plain = adapterOf();
    expect(() => plain.validateTuiRequest(undefined, cwdOf())).not.toThrow();
    expect(plain.buildTuiCommand(undefined, "high")).toEqual(["droid", "--auto", "high"]);
    const adapter = adapterOf(ZAI_DROID);
    expect(() => adapter.validateTuiRequest(undefined, cwdOf()))
      .toThrow("supports headless runs only");
  });
});
