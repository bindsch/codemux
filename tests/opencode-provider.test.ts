import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunContext } from "../src/adapters/base.js";
import { OpencodeAdapter } from "../src/adapters/opencode.js";
import {
  OPENCODE_PROVIDER_ID,
  OPENCODE_PROVIDER_KEY_ENV,
  writeOpencodeProviderConfig,
} from "../src/opencode-provider.js";
import type { RunRequest } from "../src/types.js";

// The provider override's opencode translation: a private config file under
// the real data directory (OPENCODE_CONFIG) plus a key environment variable
// the file references as {env:…}. The key must never ride argv; assertions
// check the command and the file both stay free of it.

const ZAI = {
  CODEMUX_OPENCODE_PROVIDER_BASE_URL: "https://api.z.ai/api/coding/paas/v4",
  CODEMUX_OPENCODE_PROVIDER_API_KEY: "test-key-do-not-print",
  CODEMUX_OPENCODE_PROVIDER_MODEL: "glm-5.3",
};

describe("opencode provider override", () => {
  const scratch: string[] = [];
  // Every context this describe prepares, disposed per launch -- the same
  // ownership rule the launcher follows, never a whole-adapter sweep.
  const prepared: { adapter: OpencodeAdapter; context: RunContext }[] = [];
  afterEach(() => {
    for (const { adapter, context } of prepared.splice(0)) adapter.cleanupRun(context);
    while (scratch.length > 0) {
      const dir = scratch.pop()!;
      rmSync(dir, { recursive: true, force: true });
    }
  });
  const homeOf = (): string => {
    const home = mkdtempSync(join(tmpdir(), "codemux-opencode-home-"));
    scratch.push(home);
    return home;
  };
  const adapterOf = (env: NodeJS.ProcessEnv = {}): OpencodeAdapter =>
    new OpencodeAdapter(env, homeOf());
  const prepare = (adapter: OpencodeAdapter, request: RunRequest): RunContext => {
    const context = adapter.prepareRun(request);
    prepared.push({ adapter, context });
    return context;
  };
  const cwdOf = (): string => {
    const cwd = mkdtempSync(join(tmpdir(), "codemux-opencode-override-"));
    mkdirSync(join(cwd, ".git"));
    scratch.push(cwd);
    return cwd;
  };
  const configPathOf = (cmd: string[]): string | undefined =>
    cmd.find((part) => part.startsWith("OPENCODE_CONFIG="))?.slice("OPENCODE_CONFIG=".length);
  const modelArg = (cmd: string[]): string => cmd[cmd.indexOf("--model") + 1]!;

  test("without an override nothing changes", () => {
    const adapter = adapterOf();
    expect(adapter.buildRunCommand({ agent: "opencode", prompt: "p" }))
      .toEqual(["opencode", "--pure", "run"]);
    expect(adapter.getRunEnv({ agent: "opencode", prompt: "p" })).toEqual({});
  });

  test("the override rides a private OPENCODE_CONFIG file plus a key environment", () => {
    const adapter = adapterOf(ZAI);
    const request: RunRequest = { agent: "opencode", prompt: "p" };
    const env = adapter.getRunEnv(request, prepare(adapter, request));
    expect(Object.keys(env).sort()).toEqual([OPENCODE_PROVIDER_KEY_ENV, "OPENCODE_CONFIG"]);
    expect(env[OPENCODE_PROVIDER_KEY_ENV]).toBe(ZAI.CODEMUX_OPENCODE_PROVIDER_API_KEY);
    const cmd = adapter.buildRunCommand({ agent: "opencode", prompt: "p" });
    expect(modelArg(cmd)).toBe(`${OPENCODE_PROVIDER_ID}/glm-5.3`);
    // The key never rides argv, and the file records only the env name.
    expect(cmd.join(" ")).not.toContain(ZAI.CODEMUX_OPENCODE_PROVIDER_API_KEY);
    const path = env.OPENCODE_CONFIG!;
    const config = JSON.parse(readFileSync(path, "utf8"));
    const provider = config.provider[OPENCODE_PROVIDER_ID];
    expect(provider.npm).toBe("@ai-sdk/openai-compatible");
    expect(provider.options.baseURL).toBe(ZAI.CODEMUX_OPENCODE_PROVIDER_BASE_URL);
    expect(provider.options.apiKey).toBe(`{env:${OPENCODE_PROVIDER_KEY_ENV}}`);
    expect(Object.keys(provider.models)).toEqual(["glm-5.3"]);
    expect(config.model).toBe(`${OPENCODE_PROVIDER_ID}/glm-5.3`);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(path).toContain(join("opencode", ".codemux", `provider-${process.pid}-`));
  });

  test("an explicit --model wins and is namespaced once", () => {
    const adapter = adapterOf(ZAI);
    const request: RunRequest = { agent: "opencode", prompt: "p", model: "glm-5.3-flash" };
    const env = adapter.getRunEnv(request, prepare(adapter, request));
    const config = JSON.parse(readFileSync(env.OPENCODE_CONFIG!, "utf8"));
    expect(Object.keys(config.provider[OPENCODE_PROVIDER_ID].models)).toEqual(["glm-5.3-flash"]);
    expect(config.model).toBe(`${OPENCODE_PROVIDER_ID}/glm-5.3-flash`);
    expect(modelArg(adapter.buildRunCommand({ agent: "opencode", prompt: "p", model: "glm-5.3-flash" })))
      .toBe(`${OPENCODE_PROVIDER_ID}/glm-5.3-flash`);
    expect(modelArg(adapter.buildRunCommand({
      agent: "opencode",
      prompt: "p",
      model: `${OPENCODE_PROVIDER_ID}/glm-5.3`,
    }))).toBe(`${OPENCODE_PROVIDER_ID}/glm-5.3`);
  });

  test("a provider-prefixed model still generates a config the selector resolves", () => {
    // Regression: an override model carrying the provider prefix used to
    // key the models entry as "codemux/glm-5.3" while the selector split
    // into provider "codemux" and id "glm-5.3" — an id absent from the
    // config, so the run could not resolve its own model.
    const adapter = adapterOf({ ...ZAI, CODEMUX_OPENCODE_PROVIDER_MODEL: `${OPENCODE_PROVIDER_ID}/glm-5.3` });
    const request: RunRequest = { agent: "opencode", prompt: "p" };
    const env = adapter.getRunEnv(request, prepare(adapter, request));
    const config = JSON.parse(readFileSync(env.OPENCODE_CONFIG!, "utf8"));
    const selector = config.model as string;
    const id = selector.slice(selector.indexOf("/") + 1);
    expect(Object.keys(config.provider[OPENCODE_PROVIDER_ID].models)).toEqual([id]);
    // The same holds when --model carries the prefix.
    const explicit = adapterOf(ZAI);
    const explicitRequest: RunRequest = {
      agent: "opencode",
      prompt: "p",
      model: `${OPENCODE_PROVIDER_ID}/glm-5.3`,
    };
    const explicitEnv = explicit.getRunEnv(explicitRequest, prepare(explicit, explicitRequest));
    const explicitConfig = JSON.parse(readFileSync(explicitEnv.OPENCODE_CONFIG!, "utf8"));
    expect(Object.keys(explicitConfig.provider[OPENCODE_PROVIDER_ID].models)).toEqual(["glm-5.3"]);
    expect(modelArg(explicit.buildRunCommand(explicitRequest)))
      .toBe(`${OPENCODE_PROVIDER_ID}/glm-5.3`);
  });

  test("the override survives --hermetic: the env prefix carries the config path", () => {
    const adapter = adapterOf(ZAI);
    const request: RunRequest = { agent: "opencode", prompt: "p", hermetic: true };
    const context = prepare(adapter, request);
    const cmd = adapter.buildRunCommand(request, context);
    const path = configPathOf(cmd)!;
    expect(path).not.toBe("");
    expect(statSync(path).isFile()).toBe(true);
    expect(modelArg(cmd)).toBe(`${OPENCODE_PROVIDER_ID}/glm-5.3`);
    // The key rides the real environment, never the env(1) prefix (argv).
    expect(cmd.join(" ")).not.toContain(ZAI.CODEMUX_OPENCODE_PROVIDER_API_KEY);
    const plain = adapterOf();
    const plainRequest: RunRequest = { agent: "opencode", prompt: "p", hermetic: true };
    const plainContext = prepare(plain, plainRequest);
    expect(adapter.getRunEnv(request, context)).toEqual({
      [OPENCODE_PROVIDER_KEY_ENV]: ZAI.CODEMUX_OPENCODE_PROVIDER_API_KEY,
    });
    // Without an override the variable is removed entirely: blanking it
    // reopens the global-config `??` leak (see the adapter comment).
    const plainCmd = plain.buildRunCommand(plainRequest, plainContext);
    expect(configPathOf(plainCmd)).toBeUndefined();
    expect(plainCmd.filter((_, index) => plainCmd[index - 1] === "-u").sort())
      .toEqual(["OPENCODE_AUTH_CONTENT", "OPENCODE_CONFIG", "OPENCODE_CONFIG_CONTENT", "OPENCODE_CONFIG_DIR"]);
  });

  test("a model containing braces is refused before it reaches the config", () => {
    // Regression (h3 review): OpenCode substitutes {env:…} and {file:…}
    // in config text before parsing (packages/opencode/src/config/
    // variable.ts), so a model id carrying braces would splice an
    // environment variable's value or an arbitrary file's content into
    // the config codemux writes. Refused at validation, and at prepare
    // for every other caller.
    const override = adapterOf({ ...ZAI, CODEMUX_OPENCODE_PROVIDER_MODEL: "{env:HOME}" });
    expect(() => override.validateRunRequest({ agent: "opencode", prompt: "p", cwd: cwdOf() }))
      .toThrow("must not contain '{' or '}'");
    expect(() => override.prepareRun({ agent: "opencode", prompt: "p" }))
      .toThrow("must not contain '{' or '}'");
    // A prefixed --model value is normalized to the same bare id first.
    const explicit = adapterOf(ZAI);
    expect(() => explicit.prepareRun({
      agent: "opencode",
      prompt: "p",
      model: `${OPENCODE_PROVIDER_ID}/{file:../secrets}`,
    })).toThrow("must not contain '{' or '}'");
  });

  test("a keyless override fails validation with the missing name", () => {
    const adapter = adapterOf({
      CODEMUX_OPENCODE_PROVIDER_BASE_URL: ZAI.CODEMUX_OPENCODE_PROVIDER_BASE_URL,
      CODEMUX_OPENCODE_PROVIDER_MODEL: "glm-5.3",
    });
    expect(() =>
      adapter.validateRunRequest({ agent: "opencode", prompt: "p", cwd: cwdOf() })
    ).toThrow("provider override is missing CODEMUX_OPENCODE_PROVIDER_API_KEY");
  });

  test("an override without any model fails validation", () => {
    const adapter = adapterOf({
      CODEMUX_OPENCODE_PROVIDER_BASE_URL: ZAI.CODEMUX_OPENCODE_PROVIDER_BASE_URL,
      CODEMUX_OPENCODE_PROVIDER_API_KEY: ZAI.CODEMUX_OPENCODE_PROVIDER_API_KEY,
    });
    expect(() =>
      adapter.validateRunRequest({ agent: "opencode", prompt: "p", cwd: cwdOf() })
    ).toThrow("opencode needs a model for the provider override");
  });

  test("an unprepared provider config refuses launch", () => {
    const adapter = adapterOf(ZAI);
    expect(() => adapter.getRunEnv({ agent: "opencode", prompt: "p" }))
      .toThrow("opencode provider config was not prepared before launch");
  });

  test("the tui refuses an active override", () => {
    const adapter = adapterOf(ZAI);
    expect(() => adapter.validateTuiRequest(undefined, cwdOf()))
      .toThrow("supports headless runs only");
    expect(() => adapterOf().validateTuiRequest(undefined, cwdOf())).not.toThrow();
  });

  test("every prepared run gets a fresh config; cleanupRun removes each launch's own only", () => {
    const adapter = adapterOf(ZAI);
    const request: RunRequest = { agent: "opencode", prompt: "p" };
    const firstContext = prepare(adapter, request);
    const first = adapter.getRunEnv(request, firstContext).OPENCODE_CONFIG!;
    expect(statSync(first).isFile()).toBe(true);
    const secondContext = prepare(adapter, request);
    const second = adapter.getRunEnv(request, secondContext).OPENCODE_CONFIG!;
    expect(second).not.toBe(first);
    // The earlier file stays until its own launch ends: an earlier run may
    // still read it.
    expect(statSync(first).isFile()).toBe(true);
    adapter.cleanupRun(firstContext);
    expect(() => statSync(first)).toThrow();
    expect(statSync(second).isFile()).toBe(true);
  });

  test("old configs of dead codemux processes are swept", () => {
    const home = homeOf();
    const dataDir = join(home, ".local", "share", "opencode");
    const parent = join(dataDir, ".codemux");
    mkdirSync(parent, { recursive: true });
    const old = join(parent, "provider-999999999-old");
    mkdirSync(old);
    writeFileSync(join(old, "opencode.json"), "x");
    const threeDaysAgo = new Date(Date.now() - 3 * 86_400_000);
    utimesSync(old, threeDaysAgo, threeDaysAgo);
    // A fresh config directory of a dead pid stays: the sweep is age-gated,
    // not a wholesale delete of every dead process's artifact.
    const fresh = join(parent, "provider-999999998-fresh");
    mkdirSync(fresh);
    writeFileSync(join(fresh, "opencode.json"), "x");
    const config = writeOpencodeProviderConfig(
      dataDir,
      { baseUrl: ZAI.CODEMUX_OPENCODE_PROVIDER_BASE_URL, apiKey: "k" },
      "glm-5.3"
    );
    expect(readdirSync(parent).filter((entry) => entry.startsWith("provider-9999")))
      .toEqual(["provider-999999998-fresh"]);
    expect(statSync(fresh).isDirectory()).toBe(true);
    config.finalize();
  });

  test("a symlinked .codemux parent is refused", () => {
    const home = homeOf();
    const elsewhere = mkdtempSync(join(tmpdir(), "codemux-opencode-elsewhere-"));
    scratch.push(elsewhere);
    const dataDir = join(home, ".local", "share", "opencode");
    const parent = join(dataDir, ".codemux");
    mkdirSync(parent, { recursive: true });
    rmSync(parent, { recursive: true, force: true });
    symlinkSync(elsewhere, parent);
    expect(() =>
      writeOpencodeProviderConfig(
        dataDir,
        { baseUrl: ZAI.CODEMUX_OPENCODE_PROVIDER_BASE_URL, apiKey: "k" },
        "glm-5.3"
      )
    ).toThrow("must be a directory owned by the current user");
  });
});
