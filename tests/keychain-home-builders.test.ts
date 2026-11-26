import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AgyAdapter } from "../src/adapters/agy.js";
import { AiderAdapter } from "../src/adapters/aider.js";
import { createAiderHermeticHome } from "../src/aider-hermetic.js";
import { createHermeticCheckPlan } from "../src/check-hermetic-plan.js";
import { createClineConfig, populateClineConfig } from "../src/cline-config.js";
import { guardChildKeychainHomes, keychainResolves } from "../src/darwin-keychain-home.js";
import { createDroidHermeticHome } from "../src/droid-hermetic.js";
import { createCodexHermeticHome, populateCodexHermeticSessionHome } from "../src/hermetic-home.js";
import { plantClineSessionCanary, plantSessionCanary } from "../src/hermetic-session-canary.js";
import { plantHarnessHomeCanary } from "../src/hermetic-session-canary-home.js";
import { createKimiHermeticHome, populateKimiHermeticSessionHome } from "../src/kimi-hermetic.js";
import { createOpencodeHermeticHome } from "../src/opencode-hermetic.js";
import { createOpenhandsHermeticHome } from "../src/openhands-hermetic.js";
import { QwenExperimentRun } from "../src/qwen-experiment-run.js";
import { populateAgySessionPrivateHome } from "../src/session/agy-private-home.js";
import { openCallerHarnessHome } from "../src/session/harness-home.js";
import { openOpenhandsSessionHome } from "../src/session/openhands-home.js";
import { buildKimiSessionCommand } from "../src/session/kimi-session.js";
import { aiderSessionHermeticAssignments } from "../src/session/aider-session.js";
import { droidSessionHermeticAssignments } from "../src/session/turn-driver-homes.js";
import { openhandsSessionEnvPrefix } from "../src/session/openhands-session.js";
import { codexSessionHermeticEnvPrefix } from "../src/session/codex-session.js";
import { agyPrivateHomeEnvPrefix } from "../src/adapters/agy-homes.js";
import { OPENCODE_HERMETIC_ENV } from "../src/adapters/opencode-env.js";
import type { RunRequest } from "../src/types.js";
import { accountHasLoginKeychain, defaultKeychainStatus, scratchRoot } from "./helpers/keychain-home.js";

// Each builder of a private HOME must leave a home in which a child finds a
// default keychain. The builders use the real account home (from the
// password database, not this suite's temporary HOME), so the file runs on
// macOS when the account has a login keychain. The check starts a child
// with HOME set to the built home and asks which keychain is the default
// one: a status query that shows no window and stores nothing.
const roots: string[] = [];
const finalizers: (() => void)[] = [];
afterEach(() => {
  for (const finalize of finalizers.splice(0)) { try { finalize(); } catch { /* removed with the root */ } }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function root(): string {
  const dir = scratchRoot("keychain-builders");
  roots.push(dir);
  return dir;
}
function dir(...parts: string[]): string {
  const path = join(...parts);
  mkdirSync(path, { recursive: true, mode: 0o700 });
  return path;
}
function expectResolves(home: string): void {
  expect(keychainResolves(home)).toBe(true);
  expect(defaultKeychainStatus(home)).toBe(0);
}
const CLINE_PROVIDER = { CODEMUX_CLINE_PROVIDER_BASE_URL: "https://gateway.example/v1",
  CODEMUX_CLINE_PROVIDER_API_KEY: "fixture-key", CODEMUX_CLINE_PROVIDER_MODEL: "fixture-model" };

describe.skipIf(!accountHasLoginKeychain())("every private-home builder links the account keychain", () => {
  test("codex hermetic run and session homes", () => {
    const source = dir(root(), ".codex");
    const run = createCodexHermeticHome(source, true);
    finalizers.push(run.finalize);
    expectResolves(run.home);
    const session = dir(root(), "session");
    populateCodexHermeticSessionHome(session, source, true);
    expectResolves(session);
  });

  test("kimi hermetic run and session homes", () => {
    const brand = dir(root(), ".kimi-code");
    dir(brand, "credentials");
    const run = createKimiHermeticHome(brand);
    finalizers.push(run.finalize);
    expectResolves(run.home);
    const session = dir(root(), "session");
    populateKimiHermeticSessionHome(session, brand);
    expectResolves(session);
  });

  test("droid, aider, openhands and opencode hermetic run homes", () => {
    const base = root();
    for (const built of [
      createDroidHermeticHome(dir(base, ".factory")),
      createAiderHermeticHome(dir(base, ".aider")),
      createOpenhandsHermeticHome(dir(base, ".openhands")),
      createOpencodeHermeticHome(dir(base, "opencode-data")),
    ]) {
      finalizers.push(built.finalize);
      expectResolves(built.home);
    }
  });

  test("cline hermetic run and session homes", () => {
    const base = root();
    const run = createClineConfig(dir(base, ".cline"), CLINE_PROVIDER, { hermetic: true });
    finalizers.push(run.finalize);
    expectResolves(run.env.HOME!);
    const session = dir(base, "session");
    expectResolves(populateClineConfig(session, CLINE_PROVIDER, { hermetic: true }).env.HOME!);
  });

  test("openhands session home", () => {
    const names = ["CODEMUX_OPENHANDS_PROVIDER_BASE_URL", "CODEMUX_OPENHANDS_PROVIDER_API_KEY", "CODEMUX_OPENHANDS_PROVIDER_MODEL"] as const;
    const saved = names.map((name) => process.env[name]);
    process.env.CODEMUX_OPENHANDS_PROVIDER_BASE_URL = "https://gateway.example/v1";
    process.env.CODEMUX_OPENHANDS_PROVIDER_API_KEY = "fixture-key";
    process.env.CODEMUX_OPENHANDS_PROVIDER_MODEL = "fixture-model";
    try {
      const home = openOpenhandsSessionHome({ stateRoot: dir(root(), ".openhands"), resume: false, sessionId: null, permissionPolicy: "default" });
      expectResolves(home.dir);
    } finally {
      names.forEach((name, index) => { if (saved[index] === undefined) delete process.env[name]; else process.env[name] = saved[index]; });
    }
  });

  test("qwen experiment home", () => {
    const home = root();
    const spec = { name: "test", command: "/synthetic/server", args: [], env: [] };
    const environment = { OPENAI_API_KEY: "synthetic-api-key", OPENAI_BASE_URL: "http://127.0.0.1:1", OPENAI_MODEL: "synthetic" };
    const noop = (): void => {};
    const relay = { spec, token: "synthetic", url: "http://127.0.0.1:1/mcp", recordingPath: join(home, "recording.jsonl"),
      failureError: null, start: async () => {}, finish: noop, fail: noop, onFailure: () => noop,
      terminateProtocol: noop, close: async () => {}, closeSync: noop };
    const experiment = new QwenExperimentRun(spec, home, home, environment, "prompt", {}, relay as never);
    finalizers.push(() => experiment.closeSync());
    expectResolves(experiment.home);
  });

  test("agy run home on both login routes", () => {
    for (const apiKey of [true, false]) {
      const home = root();
      const cwd = dir(home, "workspace", ".git");
      const adapter = new AgyAdapter({ HOME: home, ...(apiKey ? { GEMINI_API_KEY: "synthetic-api-key" } : {}) });
      const request: RunRequest = { agent: "agy", prompt: "probe", cwd: join(cwd, ".."), autonomy: "read-only", sandboxed: true };
      const context = adapter.prepareRun(request);
      finalizers.push(() => adapter.cleanupRun(context));
      expectResolves((context as { agyProbe: { home: string } }).agyProbe.home);
    }
  });

  test("agy session home on both login arms", () => {
    for (const environment of [{ GEMINI_API_KEY: "synthetic" }, {}]) {
      const base = root();
      const home = dir(base, "private");
      populateAgySessionPrivateHome(home, { environment: { HOME: dir(base, "operator"), ...environment }, scrubbing: false });
      expectResolves(home);
    }
  });

  test("a caller's --harness-home directory", () => {
    const base = root();
    const sourceHome = dir(base, "operator");
    writeFileSync(join(dir(sourceHome, ".factory"), "auth.json"), "{}");
    const home = openCallerHarnessHome({ agent: "droid", dir: join(base, "caller"), cwd: dir(base, "work"),
      sourceHome, blockedPaths: [sourceHome], sourceEnv: { HOME: sourceHome }, apiKeyAuth: false });
    expect(home.environment.HOME).toBe(home.dir);
    expectResolves(home.dir);
  });

  test("the check --hermetic control home", () => {
    const base = root();
    const adapter = new AiderAdapter({ HOME: dir(base, "operator") });
    const plan = createHermeticCheckPlan(adapter, { agent: "aider", prompt: "probe", autonomy: "read-only", sandboxed: true },
      { sandbox: true, requestedAutonomy: "read-only", timeoutMs: 9000, kind: "check" });
    finalizers.push(plan.canary.cleanup);
    const home = (plan.canary as { home?: string }).home!;
    expect(plan.control.adapter.buildRunCommand(plan.control.request, {})).toContain(`HOME=${home}`);
    expectResolves(home);
  });

  test("the session canary homes for kimi, agy and cline", () => {
    const base = root();
    const cline = plantClineSessionCanary(base);
    finalizers.push(cline.cleanup);
    expectResolves(cline.env!.HOME!);
    for (const agent of ["kimi", "agy"] as const) {
      const planted = plantSessionCanary(agent);
      finalizers.push(planted.cleanup);
      expectResolves(planted.env!.HOME!);
    }
  });

  test("the caller-home canary's operator home", () => {
    const base = root();
    const plant = plantHarnessHomeCanary("droid", undefined, { HOME: dir(base, "operator"), PATH: process.env.PATH }, base);
    finalizers.push(plant.cleanup);
    expectResolves(plant.env.HOME!);
  });

  // The session command builders are pure functions (a print-only launch
  // calls them too), so a resumed home made by an older release is linked
  // at the session spawn: spawnSessionChild runs this same check on the
  // argv each builder returns.
  test.each([
    ["kimi", (home: string) => buildKimiSessionCommand({ prompt: "hi", hermeticHome: home } as never)],
    ["droid", (home: string) => ["env", ...droidSessionHermeticAssignments(home), "droid"]],
    ["aider", (home: string) => ["env", ...aiderSessionHermeticAssignments(home), "aider"]],
    ["openhands", (home: string) => [...openhandsSessionEnvPrefix(home), "openhands"]],
    ["codex", (home: string) => ["env", ...codexSessionHermeticEnvPrefix(home), "codex"]],
    ["agy", (home: string) => [...agyPrivateHomeEnvPrefix(home), "agy"]],
    ["opencode", (home: string) => ["env", ...OPENCODE_HERMETIC_ENV(home, join(home, "data"), null), "opencode"]],
  ] as const)("the %s session argv's HOME is linked by the spawn check", (_agent, build) => {
    const base = root();
    const home = dir(base, "resumed-home");
    const command = ["/opt/scode", "--rw", "--", ...build(home)];
    expect(command).toContain(`HOME=${home}`);
    guardChildKeychainHomes(command, { HOME: process.env.HOME }, base);
    expectResolves(home);
  });
});
