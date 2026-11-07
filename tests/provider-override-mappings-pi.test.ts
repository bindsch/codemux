import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunContext } from "../src/adapters/base.js";
import { PiAdapter } from "../src/adapters/pi.js";
import { UsageRefusalError } from "../src/validation.js";
import type { RunRequest } from "../src/types.js";

// How each adapter translates a provider override
// (CODEMUX_<AGENT>_PROVIDER_{BASE_URL,API_KEY,MODEL}) into what the harness
// consumes. The key must travel in the environment or a private file, never
// in argv; assertions check the command carries no key.

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
      .toThrow("must not contain '$', '{', or '}'");
    expect(() => adapter.prepareRun(request))
      .toThrow("must not contain '$', '{', or '}'");
    expect(existsSync(join(home, ".pi"))).toBe(false);
  });

  test("a model with a bare $VAR is refused: pi expands $VAR templates too (round 259)", () => {
    // The brace refusal missed the template form without them: pi expands
    // `$VAR` exactly like `${VAR}` (resolve-config-value.js), so a model id
    // `glm-$CODEMUX_PI_PROVIDER_API_KEY` landed in models.json verbatim and
    // was expanded at auth time — changing the selected model and putting
    // the key's VALUE into the config a diagnostic could print. The model
    // refuses every template character, before launch and before the write.
    const home = mkdtempSync(join(tmpdir(), "codemux-pi-home-"));
    scratch.push(home);
    const adapter = new PiAdapter(
      { ...ZAI_PI, CODEMUX_PI_PROVIDER_MODEL: "glm-$CODEMUX_PI_PROVIDER_API_KEY" },
      home
    );
    const request: RunRequest = { agent: "pi", prompt: "p", cwd: cwdOf() };
    expect(() => adapter.validateRunRequest(request))
      .toThrow("must not contain '$', '{', or '}'");
    expect(() => adapter.prepareRun(request))
      .toThrow("must not contain '$', '{', or '}'");
    expect(existsSync(join(home, ".pi"))).toBe(false);
  });

  test("a relative passed-through PI_CODING_AGENT_DIR is refused on a plain run and a TUI launch", () => {
    // Review round 286: the check lived on the override path alone, so an
    // ordinary run or TUI launch that passed the variable through sent the
    // relative value to pi, which resolves it against the working
    // directory — agent configuration and extensions from the repository.
    const request = {
      agent: "pi" as const,
      prompt: "p",
      cwd: cwdOf(),
      passthroughEnv: ["PI_CODING_AGENT_DIR"],
    };
    const adapter = adapterOf({ PI_CODING_AGENT_DIR: "relative/path" });
    expect(() => adapter.validateRunRequest(request as RunRequest))
      .toThrow("passed-through PI_CODING_AGENT_DIR must be an absolute path");
    expect(() => adapter.validateTuiRequest(undefined, cwdOf(), "read-only", undefined, ["PI_CODING_AGENT_DIR"]))
      .toThrow("passed-through PI_CODING_AGENT_DIR must be an absolute path");
    // Not passed through: the sanitized environment drops the variable, so
    // the ambient value never reaches pi and the launch proceeds.
    const ambient = adapterOf({ PI_CODING_AGENT_DIR: "relative/path" });
    expect(() => ambient.validateRunRequest({ ...request, passthroughEnv: undefined } as RunRequest)).not.toThrow();
    expect(() => ambient.validateTuiRequest(undefined, cwdOf())).not.toThrow();
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
    // Validation refuses it first — a UsageRefusalError, so the CLI exits
    // 64 at the flag boundary before the quota gate — and the launch path
    // repeats the same refusal.
    expect(() => relative.validateRunRequest(request as RunRequest))
      .toThrow(UsageRefusalError);
    expect(() => relative.validateRunRequest(request as RunRequest))
      .toThrow("passed-through PI_CODING_AGENT_DIR must be an absolute path");
    expect(() => relative.prepareRun(request as RunRequest))
      .toThrow(UsageRefusalError);
  });
});
