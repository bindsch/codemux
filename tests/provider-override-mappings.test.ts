import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AiderAdapter } from "../src/adapters/aider.js";
import { ClineAdapter } from "../src/adapters/cline.js";
import { CopilotAdapter } from "../src/adapters/copilot.js";
import { DroidAdapter } from "../src/adapters/droid.js";
import { GooseAdapter, gooseOpenAiEndpoint } from "../src/adapters/goose.js";
import { KimiAdapter } from "../src/adapters/kimi.js";
import { OpenHandsAdapter } from "../src/adapters/openhands.js";
import { PiAdapter } from "../src/adapters/pi.js";
import { QwenAdapter } from "../src/adapters/qwen.js";
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

const ZAI_PI = {
  CODEMUX_PI_PROVIDER_BASE_URL: "https://api.z.ai/api/coding/paas/v4",
  CODEMUX_PI_PROVIDER_API_KEY: "test-key-do-not-print",
  CODEMUX_PI_PROVIDER_MODEL: "glm-5.3",
};

describe("pi provider override", () => {
  const scratch: string[] = [];
  const adapters: PiAdapter[] = [];
  afterEach(() => {
    for (const adapter of adapters.splice(0)) adapter.disposeProviderAgentDir();
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
    const adapter = new PiAdapter(env, home);
    adapters.push(adapter);
    return adapter;
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
    const request = { agent: "pi" as const, prompt: "p", cwd: cwdOf() };
    adapter.prepareRun(request as RunRequest);
    const env = adapter.getRunEnv(request as RunRequest);
    expect(env.PI_CODING_AGENT_DIR).toContain(
      join(".pi", "agent", ".codemux", `provider-${process.pid}-`)
    );
    const models = JSON.parse(
      readFileSync(join(env.PI_CODING_AGENT_DIR!, "models.json"), "utf8")
    );
    // The file records the key's NAME, never the key; the provider carries
    // the override's base URL and the OpenAI chat-completions protocol.
    expect(models.providers.codemux).toEqual({
      name: "codemux provider override",
      baseUrl: ZAI_PI.CODEMUX_PI_PROVIDER_BASE_URL,
      apiKey: "${CODEMUX_PI_PROVIDER_API_KEY}",
      api: "openai-completions",
      models: [
        { id: "glm-5.3", name: "glm-5.3", api: "openai-completions" },
      ],
    });
    expect(JSON.stringify(models)).not.toContain(ZAI_PI.CODEMUX_PI_PROVIDER_API_KEY);
    expect(env.CODEMUX_PI_PROVIDER_API_KEY).toBe(ZAI_PI.CODEMUX_PI_PROVIDER_API_KEY);
    expect(statSync(join(env.PI_CODING_AGENT_DIR!, "models.json")).mode & 0o777).toBe(0o600);
  });

  test("the command selects the provider-qualified model", () => {
    const adapter = adapterOf(ZAI_PI);
    const request = { agent: "pi" as const, prompt: "p", cwd: cwdOf() };
    adapter.prepareRun(request as RunRequest);
    expect(adapter.buildRunCommand(request as RunRequest))
      .toEqual([...head, "--model", "codemux/glm-5.3"]);
    const cmd = adapter.buildRunCommand(request as RunRequest).join(" ");
    expect(cmd).not.toContain(ZAI_PI.CODEMUX_PI_PROVIDER_API_KEY);
  });

  test("an explicit --model wins as the routed model id", () => {
    const adapter = adapterOf(ZAI_PI);
    const request = { agent: "pi" as const, prompt: "p", cwd: cwdOf(), model: "glm-5.3-flash" };
    adapter.prepareRun(request as RunRequest);
    expect(adapter.buildRunCommand(request as RunRequest))
      .toEqual([...head, "--model", "codemux/glm-5.3-flash"]);
    const env = adapter.getRunEnv(request as RunRequest);
    expect(JSON.parse(readFileSync(join(env.PI_CODING_AGENT_DIR!, "models.json"), "utf8"))
      .providers.codemux.models[0].id).toBe("glm-5.3-flash");
  });

  test("the override and --tools none coexist", () => {
    const adapter = adapterOf(ZAI_PI);
    const request = {
      agent: "pi" as const,
      prompt: "p",
      cwd: cwdOf(),
      tools: "none" as const,
      autonomy: "read-only" as const,
    };
    adapter.prepareRun(request as RunRequest);
    expect(adapter.buildRunCommand(request as RunRequest))
      .toEqual([...head, "--model", "codemux/glm-5.3", "--no-extensions", "--no-tools"]);
  });

  test("an unprepared override fails closed before any launch", () => {
    const adapter = adapterOf(ZAI_PI);
    expect(adapter.buildRunCommand({ agent: "pi", prompt: "p", cwd: cwdOf() } as RunRequest))
      .toEqual([...head, "--model", "codemux/glm-5.3"]);
    expect(() => adapter.getRunEnv({ agent: "pi", prompt: "p" } as RunRequest))
      .toThrow("pi provider agent directory was not prepared before launch");
  });

  test("dispose removes every prepared directory", () => {
    const adapter = adapterOf(ZAI_PI);
    const request = { agent: "pi" as const, prompt: "p", cwd: cwdOf() };
    adapter.prepareRun(request);
    const first = adapter.getRunEnv(request as RunRequest).PI_CODING_AGENT_DIR!;
    adapter.prepareRun(request);
    const second = adapter.getRunEnv(request as RunRequest).PI_CODING_AGENT_DIR!;
    expect(second).not.toBe(first);
    // The earlier directory stays until exit: an earlier run may still
    // read it.
    expect(statSync(first).isDirectory()).toBe(true);
    adapter.disposeProviderAgentDir();
    expect(() => statSync(first)).toThrow();
    expect(() => statSync(second)).toThrow();
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
    adapters.push(dropped);
    dropped.prepareRun(request as RunRequest);
    expect(dropped.getRunEnv(request as RunRequest).PI_CODING_AGENT_DIR!)
      .toContain(join(home, ".pi", "agent", ".codemux"));

    env.PI_CODING_AGENT_DIR = join(passed, "agent");
    const honoring = new PiAdapter(env, home);
    adapters.push(honoring);
    honoring.prepareRun(request as RunRequest);
    expect(honoring.getRunEnv(request as RunRequest).PI_CODING_AGENT_DIR!)
      .toContain(join(passed, "agent", ".codemux", `provider-${process.pid}-`));

    env.PI_CODING_AGENT_DIR = "relative/path";
    const relative = new PiAdapter(env, home);
    adapters.push(relative);
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
});

const ZAI_QWEN = {
  CODEMUX_QWEN_PROVIDER_BASE_URL: "https://api.z.ai/api/coding/paas/v4",
  CODEMUX_QWEN_PROVIDER_API_KEY: "test-key-do-not-print",
  CODEMUX_QWEN_PROVIDER_MODEL: "glm-5.3",
};

describe("qwen provider override", () => {
  const scratch: string[] = [];
  afterEach(() => {
    while (scratch.length > 0) {
      const dir = scratch.pop()!;
      rmSync(dir, { recursive: true, force: true });
    }
  });
  const cwdOf = (): string => {
    const cwd = mkdtempSync(join(tmpdir(), "codemux-qwen-override-"));
    mkdirSync(join(cwd, ".git"));
    scratch.push(cwd);
    return cwd;
  };
  const currentBinary = (name: string): string | null =>
    name === "qwen" ? "/fake/qwen" : null;
  const adapterOf = (env: NodeJS.ProcessEnv = {}): QwenAdapter =>
    new QwenAdapter(currentBinary, env);
  const run = (env: NodeJS.ProcessEnv, request: Partial<RunRequest> = {}): string[] =>
    adapterOf(env).buildRunCommand({
      agent: "qwen",
      prompt: "p",
      cwd: cwdOf(),
      ...request,
    } as RunRequest);

  test("without an override nothing changes", () => {
    const adapter = adapterOf();
    expect(adapter.getRunEnv({ agent: "qwen", prompt: "p" } as RunRequest)).toEqual({});
    expect(run({})).toEqual(["/fake/qwen", "--safe-mode"]);
    // An operator model still rides the native flag.
    expect(run({}, { model: "qwen3-coder" }))
      .toEqual(["/fake/qwen", "--safe-mode", "--model", "qwen3-coder"]);
  });

  test("the override rides the OPENAI_* environment group", () => {
    const adapter = adapterOf(ZAI_QWEN);
    expect(adapter.getRunEnv({ agent: "qwen", prompt: "p" } as RunRequest)).toEqual({
      OPENAI_API_KEY: ZAI_QWEN.CODEMUX_QWEN_PROVIDER_API_KEY,
      OPENAI_BASE_URL: ZAI_QWEN.CODEMUX_QWEN_PROVIDER_BASE_URL,
      OPENAI_MODEL: "glm-5.3",
    });
    // --safe-mode stays on every run; the key never rides argv.
    const cmd = run(ZAI_QWEN);
    expect(cmd).toEqual(["/fake/qwen", "--safe-mode"]);
    expect(cmd.join(" ")).not.toContain(ZAI_QWEN.CODEMUX_QWEN_PROVIDER_API_KEY);
  });

  test("an explicit --model wins and rides both the flag and the env", () => {
    const adapter = adapterOf(ZAI_QWEN);
    expect(run(ZAI_QWEN, { model: "glm-5.3-flash" }))
      .toEqual(["/fake/qwen", "--safe-mode", "--model", "glm-5.3-flash"]);
    expect(adapter.getRunEnv({ agent: "qwen", prompt: "p", model: "glm-5.3-flash" } as RunRequest))
      .toMatchObject({ OPENAI_MODEL: "glm-5.3-flash" });
  });

  test("a keyless override fails validation with the missing name", () => {
    const adapter = adapterOf({
      CODEMUX_QWEN_PROVIDER_BASE_URL: ZAI_QWEN.CODEMUX_QWEN_PROVIDER_BASE_URL,
      CODEMUX_QWEN_PROVIDER_MODEL: "glm-5.3",
    });
    expect(() => adapter.validateRunRequest({ agent: "qwen", prompt: "p", cwd: cwdOf() } as RunRequest))
      .toThrow("provider override is missing CODEMUX_QWEN_PROVIDER_API_KEY");
  });

  test("an override without any model fails validation", () => {
    const adapter = adapterOf({
      CODEMUX_QWEN_PROVIDER_BASE_URL: ZAI_QWEN.CODEMUX_QWEN_PROVIDER_BASE_URL,
      CODEMUX_QWEN_PROVIDER_API_KEY: ZAI_QWEN.CODEMUX_QWEN_PROVIDER_API_KEY,
    });
    expect(() => adapter.validateRunRequest({ agent: "qwen", prompt: "p", cwd: cwdOf() } as RunRequest))
      .toThrow("qwen needs a model for the provider override");
    expect(() => adapter.validateTuiRequest(undefined, cwdOf()))
      .toThrow("qwen needs a model for the provider override");
  });

  test("the legacy qwen-coder binary refuses the override", () => {
    const legacy = new QwenAdapter(
      (name) => (name === "qwen-coder" ? "/fake/qwen-coder" : null),
      ZAI_QWEN
    );
    expect(() => legacy.validateRunRequest({
      agent: "qwen",
      prompt: "p",
      cwd: cwdOf(),
      sandboxed: true,
    } as RunRequest)).toThrow("supports the current qwen CLI only");
  });

  test("the tui command and env carry the same override", () => {
    const adapter = adapterOf(ZAI_QWEN);
    expect(adapter.buildTuiCommand("glm-5.3", "high"))
      .toEqual(["/fake/qwen", "--safe-mode", "--model", "glm-5.3", "--approval-mode", "yolo"]);
    expect(adapter.getTuiEnv("glm-5.3")).toEqual({
      OPENAI_API_KEY: ZAI_QWEN.CODEMUX_QWEN_PROVIDER_API_KEY,
      OPENAI_BASE_URL: ZAI_QWEN.CODEMUX_QWEN_PROVIDER_BASE_URL,
      OPENAI_MODEL: "glm-5.3",
    });
  });
});

const ZAI_CLINE = {
  CODEMUX_CLINE_PROVIDER_BASE_URL: "https://api.z.ai/api/coding/paas/v4",
  CODEMUX_CLINE_PROVIDER_API_KEY: "test-key-do-not-print",
  CODEMUX_CLINE_PROVIDER_MODEL: "glm-5.3",
};

describe("cline provider override", () => {
  const scratch: string[] = [];
  const adapters: ClineAdapter[] = [];
  afterEach(() => {
    for (const adapter of adapters.splice(0)) adapter.disposeProviderDataDir();
    while (scratch.length > 0) {
      const dir = scratch.pop()!;
      rmSync(dir, { recursive: true, force: true });
    }
  });
  const cwdOf = (): string => {
    const cwd = mkdtempSync(join(tmpdir(), "codemux-cline-override-"));
    mkdirSync(join(cwd, ".git"));
    scratch.push(cwd);
    return cwd;
  };
  const adapterOf = (env: NodeJS.ProcessEnv = {}): ClineAdapter => {
    const home = mkdtempSync(join(tmpdir(), "codemux-cline-home-"));
    scratch.push(home);
    const adapter = new ClineAdapter(env, home);
    adapters.push(adapter);
    return adapter;
  };
  const run = (env: NodeJS.ProcessEnv, request: Partial<RunRequest> = {}): string[] =>
    adapterOf(env).buildRunCommand({
      agent: "cline",
      prompt: "p",
      cwd: cwdOf(),
      ...request,
    } as RunRequest);

  test("without an override nothing changes", () => {
    const adapter = adapterOf();
    expect(adapter.getRunEnv({ agent: "cline", prompt: "p" } as RunRequest)).toEqual({});
    expect(run({})).toEqual(["cline", "--", "p"]);
    // An operator model still rides the native flag.
    expect(run({}, { model: "anthropic/claude-sonnet-5" }))
      .toEqual(["cline", "--model", "anthropic/claude-sonnet-5", "--", "p"]);
  });

  test("the override rides a private data directory and adds no environment", () => {
    const adapter = adapterOf(ZAI_CLINE);
    const request = { agent: "cline" as const, prompt: "p", cwd: cwdOf() };
    adapter.prepareRun(request as RunRequest);
    const cmd = adapter.buildRunCommand(request as RunRequest);
    const dataDir = cmd[cmd.indexOf("--data-dir") + 1]!;
    expect(dataDir).toContain(
      join(".cline", ".codemux", `provider-${process.pid}-`)
    );
    // The settings file sits where cline's isolated-state mode resolves
    // it (<data>/settings/providers.json), so no env var is involved.
    expect(adapter.getRunEnv(request as RunRequest)).toEqual({});
    const settings = JSON.parse(
      readFileSync(join(dataDir, "settings", "providers.json"), "utf8")
    );
    // The openai-compatible entry carries the override's endpoint and
    // key: cline's runtime reads the key from this file only, so the
    // private 0600 file is where the contract lets it live.
    expect(settings).toEqual({
      version: 1,
      lastUsedProvider: "openai-compatible",
      providers: {
        "openai-compatible": {
          settings: {
            provider: "openai-compatible",
            apiKey: ZAI_CLINE.CODEMUX_CLINE_PROVIDER_API_KEY,
            model: "glm-5.3",
            baseUrl: ZAI_CLINE.CODEMUX_CLINE_PROVIDER_BASE_URL,
          },
          updatedAt: settings.providers["openai-compatible"].updatedAt,
          tokenSource: "manual",
        },
      },
    });
    expect(statSync(join(dataDir, "settings", "providers.json")).mode & 0o777).toBe(0o600);
  });

  test("the command names the data directory, provider and model, never the key", () => {
    const adapter = adapterOf(ZAI_CLINE);
    const request = { agent: "cline" as const, prompt: "p", cwd: cwdOf() };
    adapter.prepareRun(request as RunRequest);
    const cmd = adapter.buildRunCommand(request as RunRequest);
    expect(cmd[0]).toBe("cline");
    expect(cmd[1]).toBe("--data-dir");
    expect(cmd.slice(cmd.indexOf("--data-dir") + 2))
      .toEqual(["--provider", "openai-compatible", "--model", "glm-5.3", "--", "p"]);
    expect(cmd.join(" ")).not.toContain(ZAI_CLINE.CODEMUX_CLINE_PROVIDER_API_KEY);
  });

  test("an explicit --model wins as the routed model id", () => {
    const adapter = adapterOf(ZAI_CLINE);
    const request = { agent: "cline" as const, prompt: "p", cwd: cwdOf(), model: "glm-5.3-flash" };
    adapter.prepareRun(request as RunRequest);
    const cmd = adapter.buildRunCommand(request as RunRequest);
    const dataDir = cmd[cmd.indexOf("--data-dir") + 1]!;
    expect(cmd[cmd.indexOf("--model") + 1]).toBe("glm-5.3-flash");
    expect(JSON.parse(readFileSync(join(dataDir, "settings", "providers.json"), "utf8"))
      .providers["openai-compatible"].settings.model).toBe("glm-5.3-flash");
  });

  test("an unprepared override fails closed before any launch", () => {
    const adapter = adapterOf(ZAI_CLINE);
    expect(() => adapter.buildRunCommand({ agent: "cline", prompt: "p", cwd: cwdOf() } as RunRequest))
      .toThrow("cline provider data directory was not prepared before launch");
  });

  test("dispose removes every prepared directory", () => {
    const adapter = adapterOf(ZAI_CLINE);
    const request = { agent: "cline" as const, prompt: "p", cwd: cwdOf() };
    adapter.prepareRun(request);
    const first = adapter.buildRunCommand(request as RunRequest);
    const firstDir = first[first.indexOf("--data-dir") + 1]!;
    adapter.prepareRun(request);
    const second = adapter.buildRunCommand(request as RunRequest);
    const secondDir = second[second.indexOf("--data-dir") + 1]!;
    expect(secondDir).not.toBe(firstDir);
    // The earlier directory stays until exit: an earlier run may still
    // read it.
    expect(statSync(firstDir).isDirectory()).toBe(true);
    adapter.disposeProviderDataDir();
    expect(() => statSync(firstDir)).toThrow();
    expect(() => statSync(secondDir)).toThrow();
  });

  test("a keyless override fails validation with the missing name", () => {
    const adapter = adapterOf({
      CODEMUX_CLINE_PROVIDER_BASE_URL: ZAI_CLINE.CODEMUX_CLINE_PROVIDER_BASE_URL,
      CODEMUX_CLINE_PROVIDER_MODEL: "glm-5.3",
    });
    expect(() => adapter.validateRunRequest({ agent: "cline", prompt: "p", cwd: cwdOf() } as RunRequest))
      .toThrow("provider override is missing CODEMUX_CLINE_PROVIDER_API_KEY");
  });

  test("an override without any model fails validation", () => {
    const adapter = adapterOf({
      CODEMUX_CLINE_PROVIDER_BASE_URL: ZAI_CLINE.CODEMUX_CLINE_PROVIDER_BASE_URL,
      CODEMUX_CLINE_PROVIDER_API_KEY: ZAI_CLINE.CODEMUX_CLINE_PROVIDER_API_KEY,
    });
    expect(() => adapter.validateRunRequest({ agent: "cline", prompt: "p", cwd: cwdOf() } as RunRequest))
      .toThrow("cline needs a model for the provider override");
  });

  test("the tui refuses the override; without one it is unchanged", () => {
    const plain = adapterOf();
    expect(() => plain.validateTuiRequest(undefined, cwdOf())).not.toThrow();
    expect(plain.buildTuiCommand("glm-5.3", "high"))
      .toEqual(["cline", "--tui", "--model", "glm-5.3", "--auto-approve", "true"]);
    const adapter = adapterOf(ZAI_CLINE);
    expect(() => adapter.validateTuiRequest(undefined, cwdOf()))
      .toThrow("supports headless runs only");
  });

  test("a passed-through CLINE_DIR relocates the private directory", () => {
    const env: NodeJS.ProcessEnv = { ...ZAI_CLINE };
    const passed = mkdtempSync(join(tmpdir(), "codemux-cline-passed-"));
    scratch.push(passed);
    const home = mkdtempSync(join(tmpdir(), "codemux-cline-home-"));
    scratch.push(home);
    const request = {
      agent: "cline" as const,
      prompt: "p",
      cwd: cwdOf(),
      passthroughEnv: ["CLINE_DIR"],
    };
    const dropped = new ClineAdapter(env, home);
    adapters.push(dropped);
    dropped.prepareRun(request as RunRequest);
    const droppedCmd = dropped.buildRunCommand(request as RunRequest);
    expect(droppedCmd[droppedCmd.indexOf("--data-dir") + 1]!)
      .toContain(join(home, ".cline", ".codemux"));

    env.CLINE_DIR = join(passed, "cline");
    const honoring = new ClineAdapter(env, home);
    adapters.push(honoring);
    honoring.prepareRun(request as RunRequest);
    const honoringCmd = honoring.buildRunCommand(request as RunRequest);
    expect(honoringCmd[honoringCmd.indexOf("--data-dir") + 1]!)
      .toContain(join(passed, "cline", ".codemux", `provider-${process.pid}-`));

    env.CLINE_DIR = "relative/path";
    const relative = new ClineAdapter(env, home);
    adapters.push(relative);
    expect(() => relative.prepareRun(request as RunRequest))
      .toThrow("passed-through CLINE_DIR must be an absolute path");
  });
});

const ZAI_COPILOT = {
  CODEMUX_COPILOT_PROVIDER_BASE_URL: "https://api.z.ai/api/coding/paas/v4",
  CODEMUX_COPILOT_PROVIDER_API_KEY: "test-key-do-not-print",
  CODEMUX_COPILOT_PROVIDER_MODEL: "glm-5.3",
};

describe("copilot provider override", () => {
  const scratch: string[] = [];
  afterEach(() => {
    while (scratch.length > 0) {
      const dir = scratch.pop()!;
      rmSync(dir, { recursive: true, force: true });
    }
  });
  const cwdOf = (): string => {
    const cwd = mkdtempSync(join(tmpdir(), "codemux-copilot-override-"));
    mkdirSync(join(cwd, ".git"));
    scratch.push(cwd);
    return cwd;
  };
  const run = (env: NodeJS.ProcessEnv, request: Partial<RunRequest> = {}): string[] =>
    new CopilotAdapter(env).buildRunCommand({
      agent: "copilot",
      prompt: "p",
      cwd: cwdOf(),
      ...request,
    } as RunRequest);
  const baseCmd = [
    "copilot",
    "--no-auto-update",
    "--no-bash-env",
    "--no-remote",
    "--no-remote-export",
    "--no-custom-instructions",
    "--no-experimental",
  ];

  test("without an override nothing changes", () => {
    const adapter = new CopilotAdapter({});
    expect(adapter.getRunEnv({ agent: "copilot", prompt: "p" } as RunRequest))
      .toEqual({});
    expect(run({})).toEqual([...baseCmd, "--disable-builtin-mcps", "--prompt=p", "--silent"]);
    // An operator model still rides the native flag.
    expect(run({}, { model: "claude-sonnet-5" }))
      .toEqual([...baseCmd, "--disable-builtin-mcps", "--model", "claude-sonnet-5", "--prompt=p", "--silent"]);
  });

  test("the override rides copilot's BYOK environment group", () => {
    const adapter = new CopilotAdapter(ZAI_COPILOT);
    expect(adapter.getRunEnv({ agent: "copilot", prompt: "p" } as RunRequest)).toEqual({
      COPILOT_PROVIDER_BASE_URL: ZAI_COPILOT.CODEMUX_COPILOT_PROVIDER_BASE_URL,
      COPILOT_PROVIDER_TYPE: "openai",
      COPILOT_PROVIDER_API_KEY: ZAI_COPILOT.CODEMUX_COPILOT_PROVIDER_API_KEY,
      COPILOT_MODEL: "glm-5.3",
    });
    // The model rides COPILOT_MODEL, so the command stays unchanged and the
    // key never rides argv.
    const cmd = run(ZAI_COPILOT);
    expect(cmd).toEqual([...baseCmd, "--disable-builtin-mcps", "--prompt=p", "--silent"]);
    expect(cmd.join(" ")).not.toContain(ZAI_COPILOT.CODEMUX_COPILOT_PROVIDER_API_KEY);
  });

  test("an explicit --model wins and rides both the flag and the env", () => {
    const adapter = new CopilotAdapter(ZAI_COPILOT);
    expect(run(ZAI_COPILOT, { model: "glm-5.3-flash" }))
      .toEqual([...baseCmd, "--disable-builtin-mcps", "--model", "glm-5.3-flash", "--prompt=p", "--silent"]);
    expect(adapter.getRunEnv({ agent: "copilot", prompt: "p", model: "glm-5.3-flash" } as RunRequest))
      .toMatchObject({ COPILOT_MODEL: "glm-5.3-flash" });
  });

  test("--tools none is refused, override or not", () => {
    // No argv spelling of an empty --available-tools allowlist disarms the
    // tools (verified live at 1.0.85); see docs/HERMETIC.md.
    const adapter = new CopilotAdapter(ZAI_COPILOT);
    expect(() =>
      adapter.validateRunRequest({
        agent: "copilot",
        prompt: "p",
        cwd: cwdOf(),
        tools: "none",
        autonomy: "high",
      } as RunRequest)).toThrow("copilot cannot remove its built-in tools");
  });

  test("the override does not bypass the hermetic-unprepared guard", () => {
    const adapter = new CopilotAdapter(ZAI_COPILOT);
    expect(() =>
      adapter.getRunEnv({
        agent: "copilot",
        prompt: "p",
        hermetic: true,
        cwd: cwdOf(),
      } as RunRequest)
    ).toThrow("copilot hermetic home was not prepared before launch");
  });

  test("a keyless override fails validation with the missing name", () => {
    const adapter = new CopilotAdapter({
      CODEMUX_COPILOT_PROVIDER_BASE_URL: ZAI_COPILOT.CODEMUX_COPILOT_PROVIDER_BASE_URL,
      CODEMUX_COPILOT_PROVIDER_MODEL: "glm-5.3",
    });
    expect(() =>
      adapter.validateRunRequest({ agent: "copilot", prompt: "p", cwd: cwdOf() } as RunRequest))
      .toThrow("provider override is missing CODEMUX_COPILOT_PROVIDER_API_KEY");
  });

  test("an override without any model fails validation, headless and tui", () => {
    const adapter = new CopilotAdapter({
      CODEMUX_COPILOT_PROVIDER_BASE_URL: ZAI_COPILOT.CODEMUX_COPILOT_PROVIDER_BASE_URL,
      CODEMUX_COPILOT_PROVIDER_API_KEY: ZAI_COPILOT.CODEMUX_COPILOT_PROVIDER_API_KEY,
    });
    expect(() =>
      adapter.validateRunRequest({ agent: "copilot", prompt: "p", cwd: cwdOf() } as RunRequest))
      .toThrow("copilot needs a model for the provider override");
    expect(() => adapter.validateTuiRequest(undefined, cwdOf()))
      .toThrow("copilot needs a model for the provider override");
  });

  test("the tui command and env carry the same override", () => {
    const adapter = new CopilotAdapter(ZAI_COPILOT);
    expect(adapter.buildTuiCommand("glm-5.3", "high"))
      .toEqual([...baseCmd, "--model", "glm-5.3", "--allow-all"]);
    expect(adapter.getTuiEnv("glm-5.3")).toEqual({
      COPILOT_PROVIDER_BASE_URL: ZAI_COPILOT.CODEMUX_COPILOT_PROVIDER_BASE_URL,
      COPILOT_PROVIDER_TYPE: "openai",
      COPILOT_PROVIDER_API_KEY: ZAI_COPILOT.CODEMUX_COPILOT_PROVIDER_API_KEY,
      COPILOT_MODEL: "glm-5.3",
    });
  });
});
