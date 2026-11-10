import { expect, test } from "bun:test";
import { Command } from "commander";
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDefaultConfig } from "../src/config.js";
import { AGENT_IDS } from "../src/types.js";
import { PARITY, agentsSupporting } from "../src/parity/index.js";
import { SESSION_OPTION_FEATURE } from "../src/parity/option-features.js";
import { registerSessionOptions } from "../src/session/cli-options.js";
import { resolveSessionRequest } from "../src/session/cli-request.js";
import { codexCallerHomeConfigArgs } from "../src/session/codex-session.js";
import { assertHarnessHomePassEnv, callerHarnessHomeEnvNames, openCallerHarnessHome } from "../src/session/harness-home.js";
import { refusingCall } from "./helpers/session-cli-hermetic.js";

test("commander parses the persistent home and final independently", () => {
  const command = new Command(); registerSessionOptions(command, "claude");
  command.parse(["--harness-home", "/caller-state", "--final"], { from: "user" });
  expect(command.opts().harnessHome).toBe("/caller-state");
  expect(command.opts().final).toBe(true);
  expect(command.opts().hermetic).toBeUndefined();
  expect(SESSION_OPTION_FEATURE.harnessHome).toBe("session.harness-home");
});

test.each([...AGENT_IDS])("%s refuses two isolation modes with exit 64", (agent) => {
  const refusal = refusingCall(() => resolveSessionRequest({
    agent, harnessHome: "/caller-state", hermetic: true,
  }, getDefaultConfig()));
  expect(refusal.code).toBe(64);
  expect(refusal.message).toContain("cannot be combined with --hermetic");
});

// Cline's caller home is integrated, but its provider settings file stores
// API keys beside settings, so the recipe refuses a home without a provider
// override before touching it (src/session/harness-home.ts). The CLI arm of
// this refusal is in tests/session-cli-cline-harness-home.test.ts.
test("cline's caller home refuses without a provider override before it opens anything", () => {
  expect(PARITY.cline["session.harness-home"].state).toBe("supported");
  const root = realpathSync(mkdtempSync(join(tmpdir(), "codemux-cline-home-")));
  try {
    const dir = join(root, "caller-state"); const cwd = join(root, "work");
    mkdirSync(dir); mkdirSync(cwd);
    expect(() => openCallerHarnessHome({
      agent: "cline", dir, cwd, sourceHome: join(root, "operator-state"),
      blockedPaths: [], apiKeyAuth: true, sourceEnv: {},
    })).toThrow("--harness-home for 'cline' requires a provider override");
    expect(readdirSync(dir)).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the declaration names every session agent as an integrated caller-home agent", () => {
  expect(agentsSupporting("session.harness-home").sort()).toEqual([...AGENT_IDS].sort());
});

test("Codex selects the linked file store without a generated config file", () => {
  expect(codexCallerHomeConfigArgs(null)).toEqual(["-c", 'cli_auth_credentials_store="file"']);
});

test("Codex provider settings preserve caller config and keep credentials off argv", () => {
  const saved = process.env.CODEMUX_CODEX_PROVIDER_MULTI_AGENT;
  process.env.CODEMUX_CODEX_PROVIDER_MULTI_AGENT = "off";
  try {
    const args = codexCallerHomeConfigArgs({
      baseUrl: "http://127.0.0.1:9/v1", apiKey: "synthetic-key", maxContextTokens: 12345,
    }, "caller-model");
    expect(args).toContain('model="caller-model"');
    expect(args).toContain('model_providers.codemux.base_url="http://127.0.0.1:9/v1"');
    expect(args).toContain('model_providers.codemux.env_key="CODEMUX_CODEX_PROVIDER_API_KEY"');
    expect(args).toContain("features.multi_agent=false");
    expect(args).toContain("model_context_window=12345");
    expect(args.join(" ")).not.toContain("synthetic-key");
  } finally {
    if (saved === undefined) delete process.env.CODEMUX_CODEX_PROVIDER_MULTI_AGENT;
    else process.env.CODEMUX_CODEX_PROVIDER_MULTI_AGENT = saved;
  }
});

// A --pass-env name the caller home sets or clears would be replaced without
// notice, so the request refuses it, as `check --session` refuses its own.
test.each([...AGENT_IDS])("%s refuses a --pass-env name its caller home owns with exit 64", (agent) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "codemux-home-pass-env-")));
  try {
    const owned = callerHarnessHomeEnvNames(agent);
    const name = owned[owned.length - 1]!;
    const cwd = join(root, "work"); mkdirSync(cwd);
    const refusal = refusingCall(() => resolveSessionRequest({
      agent, harnessHome: join(root, "caller-state"), cwd, sandbox: true, passEnv: `CODEMUX_UNRELATED_NAME,${name}`,
    }, getDefaultConfig()));
    expect(refusal.code).toBe(64);
    expect(refusal.message).toContain(`--harness-home sets or clears ${name} for '${agent}'; remove it from --pass-env`);
    expect(refusal.message).not.toContain("CODEMUX_UNRELATED_NAME");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the refusal lists every conflicting name and passes unrelated ones", () => {
  expect(() => assertHarnessHomePassEnv("goose", ["HOME", "PATH", "GOOSE_DISABLE_KEYRING"]))
    .toThrow("--harness-home sets or clears HOME, GOOSE_DISABLE_KEYRING for 'goose'; remove them from --pass-env");
  expect(() => assertHarnessHomePassEnv("codex", ["PATH", "GOOSE_DISABLE_KEYRING"])).not.toThrow();
});

// The refused list must cover everything an opened home sets or clears.
test.each([...AGENT_IDS])("%s refuses every name an opened caller home sets or clears", (agent) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "codemux-home-names-")));
  try {
    const cwd = join(root, "work"); mkdirSync(cwd);
    const home = openCallerHarnessHome({
      agent, dir: join(root, "caller-state"), cwd, sourceHome: join(root, "operator-state"),
      blockedPaths: [], apiKeyAuth: true, providerOverride: true, printOnly: true, sourceEnv: {},
    });
    const names = [...Object.keys(home.environment), ...(home.environmentOmissions ?? [])];
    expect({ agent, missing: names.filter((name) => !callerHarnessHomeEnvNames(agent).includes(name)) })
      .toEqual({ agent, missing: [] });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
