import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunContext } from "../src/adapters/base.js";
import { DroidAdapter } from "../src/adapters/droid.js";
import type { RunRequest } from "../src/types.js";

// How each adapter translates a provider override
// (CODEMUX_<AGENT>_PROVIDER_{BASE_URL,API_KEY,MODEL}) into what the harness
// consumes. The key must travel in the environment or a private file, never
// in argv; assertions check the command carries no key.

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
    expect(run({})).toEqual(["droid", "exec", "--output-format", "stream-json"]);
    // An operator model still rides the native flag.
    expect(run({}, { model: "claude-sonnet-5" })).toEqual(["droid", "exec", "-m", "claude-sonnet-5", "--output-format", "stream-json"]);
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
    expect(cmd.slice(3)).toEqual(["exec", "-m", "custom:codemux:glm-5.3-0", "--output-format", "stream-json"]);
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
      .toEqual(["exec", "-m", "custom:codemux:gpt-5.6-codex-0", "--output-format", "stream-json", "--reasoning-effort", "none"]);
    // An explicit non-gpt-5.6 model wins the resolution and takes "off".
    const explicit: RunRequest = {
      agent: "droid",
      prompt: "p",
      cwd: cwdOf(),
      model: "claude-opus-5",
      effort: "none",
    };
    expect(gpt.buildRunCommand(explicit, prepare(gpt, explicit)).slice(3))
      .toEqual(["exec", "-m", "custom:codemux:claude-opus-5-0", "--output-format", "stream-json", "--reasoning-effort", "off"]);
  });

  test("an explicit --model wins as the routed model id", () => {
    const adapter = adapterOf(ZAI_DROID);
    const request: RunRequest = { agent: "droid", prompt: "p", cwd: cwdOf(), model: "glm-5.3-flash" };
    const context = prepare(adapter, request);
    const path = adapter.buildRunCommand(request, context)[2]!;
    expect(JSON.parse(readFileSync(path, "utf8")).customModels[0].model).toBe("glm-5.3-flash");
    expect(adapter.buildRunCommand(request, context).slice(3))
      .toEqual(["exec", "-m", "custom:codemux:glm-5.3-flash-0", "--output-format", "stream-json"]);
  });

  test("the override and --tools none coexist", () => {
    const adapter = adapterOf(ZAI_DROID);
    const request: RunRequest = { agent: "droid", prompt: "p", cwd: cwdOf(), tools: "none", autonomy: "high" };
    const context = prepare(adapter, request);
    expect(adapter.buildRunCommand(request, context).slice(3))
      .toEqual(["exec", "-m", "custom:codemux:glm-5.3-0", "--output-format", "stream-json", "--auto", "high", "--only-tools", "ToolSearch"]);
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

  test("the tui rides the override through the same settings file", () => {
    const plain = adapterOf();
    expect(() => plain.validateTuiRequest(undefined, cwdOf())).not.toThrow();
    expect(plain.buildTuiCommand(undefined, "high")).toEqual(["droid", "--auto", "high"]);
    const adapter = adapterOf(ZAI_DROID);
    expect(() => adapter.validateTuiRequest(undefined, cwdOf())).not.toThrow();
    const cmd = adapter.buildTuiCommand(undefined, "high");
    expect(cmd.slice(0, 2)).toEqual(["droid", "--settings"]);
    expect(cmd.slice(3)).toEqual(["--auto", "high"]);
    const settings = JSON.parse(readFileSync(cmd[2]!, "utf8"));
    expect(settings.sessionDefaultSettings.model).toBe(settings.customModels[0].id);
    expect(settings.customModels[0]).toMatchObject({
      model: "glm-5.3",
      baseUrl: "https://api.z.ai/api/coding/paas/v4",
      apiKey: "${CODEMUX_DROID_PROVIDER_API_KEY}",
    });
    expect(adapter.getTuiEnv()).toEqual({ CODEMUX_DROID_PROVIDER_API_KEY: "test-key-do-not-print" });
    expect(cmd.join(" ")).not.toContain("test-key-do-not-print");
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
