import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunContext } from "../src/adapters/base.js";
import { KimiAdapter } from "../src/adapters/kimi.js";
import type { RunRequest } from "../src/types.js";

// How each adapter translates a provider override
// (CODEMUX_<AGENT>_PROVIDER_{BASE_URL,API_KEY,MODEL}) into what the harness
// consumes. The key must travel in the environment or a private file, never
// in argv; assertions check the command carries no key.

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
    // Every kimi run carries the stream-json wire (plain runs unwrap it).
    expect(run({})).toEqual(["kimi", "--output-format", "stream-json", "--prompt", "p"]);
    // An operator model still rides the native flag.
    expect(run({}, { model: "kimi-for-coding" })).toEqual(["kimi", "--model", "kimi-for-coding", "--output-format", "stream-json", "--prompt", "p"]);
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
    expect(cmd).toEqual(["kimi", "--output-format", "stream-json", "--prompt", "p"]);
    expect(cmd.join(" ")).not.toContain(ZAI_KIMI.CODEMUX_KIMI_PROVIDER_API_KEY);
  });

  test("an explicit --model wins as the synthesized model id", () => {
    const adapter = adapterOf(ZAI_KIMI);
    expect(adapter.getRunEnv({ agent: "kimi", prompt: "p", model: "glm-5.3-flash" } as RunRequest))
      .toMatchObject({ KIMI_MODEL_NAME: "glm-5.3-flash" });
    expect(run(ZAI_KIMI, { model: "glm-5.3-flash" })).toEqual(["kimi", "--output-format", "stream-json", "--prompt", "p"]);
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
