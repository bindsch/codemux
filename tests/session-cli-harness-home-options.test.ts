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
import { openCallerHarnessHome } from "../src/session/harness-home.js";
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
