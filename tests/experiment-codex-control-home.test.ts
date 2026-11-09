/**
 * The codex experiment check's paired control (declarations-run.ts
 * check.experiment-mcp): a deliberate non-hermetic launch that still gets
 * its own private per-launch CODEX_HOME, carrying the relay's config.toml
 * and reading the file credential store, while every hermetic suppression
 * flag stays off so the working directory's own channels stay open.
 */

import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { CodexAdapter } from "../src/adapters/codex.js";
import { experimentCanaryControl, validateExperimentRequest } from "../src/experiment-mcp.js";
import { UsageRefusalError } from "../src/validation.js";
import type { RunContext } from "../src/run-context.js";
import type { RunRequest } from "../src/types.js";

const pending: { adapter: CodexAdapter; context: RunContext }[] = [];
afterEach(() => {
  for (const { adapter, context } of pending.splice(0)) {
    try { adapter.cleanupRunSync(context); } catch { /* Failure verdicts stay. */ }
  }
});

function setup() {
  const parent = resolve("scratch/session-14c66a93/exp/codex-control-home");
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, "run-"));
  const cwd = join(root, "work");
  mkdirSync(join(cwd, ".git"), { recursive: true });
  const home = join(root, "operator");
  mkdirSync(join(home, ".codex"), { recursive: true });
  // The cache every codex experiment requires: experimentModel refuses a
  // spec model the cache does not carry (experiment-codex-model.ts).
  writeFileSync(join(home, ".codex", "models_cache.json"), JSON.stringify({
    client_version: "0.165.0", fetched_at: "2026-10-29T00:00:00Z", models: [
      { slug: "gpt-5.5", tool_mode: "direct" },
    ],
  }));
  const specPath = join(root, "spec.json");
  writeFileSync(specPath, JSON.stringify({ name: "experiment", command: process.execPath,
    args: ["--no-env-file", "--no-install", `--config=${resolve("bunfig.runtime.toml")}`,
      resolve("tests/fixtures/experiment-mcp.ts")], env: [], recording: join(root, "recordings"),
    accept_harness_prefix: ["codex-wall-time"] }));
  const request: RunRequest = { agent: "codex", prompt: "fixture", model: "gpt-5.5", cwd,
    hermetic: true, tools: "none", autonomy: "read-only", sandboxed: true, experimentMcp: specPath };
  const adapter = new CodexAdapter({ HOME: home, CODEX_API_KEY: "synthetic" }, home);
  return { adapter, request, home };
}

test("the control gets a private CODEX_HOME, the relay config, and no hermetic suppression", async () => {
  const { adapter, request, home } = setup();
  const control = experimentCanaryControl(request);
  expect(validateExperimentRequest(control)).toBeUndefined();
  // The check command validates the control through the same path as the
  // probe (check-command.ts), so the request boundary accepts it too.
  adapter.validateRunRequest(control);
  const context = adapter.prepareRun(control);
  pending.push({ adapter, context });
  const codexHome = context.hermeticHome!.codexHome;
  expect(codexHome.startsWith(join(home, ".codex", ".codemux-hermetic"))).toBe(true);
  const experiment = context.experimentCodex!;
  await experiment.prepare("0.165.0");
  const config = readFileSync(join(codexHome, "config.toml"), "utf8");
  expect(config).toContain("[mcp_servers.experiment]");
  expect(config).toContain(experiment.relay.url);
  // The operator's own CODEX_HOME stays untouched: the relay table never
  // merges into the config the operator reads.
  expect(existsSync(join(home, ".codex", "config.toml"))).toBe(false);
  const cmd = adapter.buildRunCommand(control, context);
  expect(cmd).toContain(`CODEX_HOME=${codexHome}`);
  // No HOME redirect: the control runs from the real home, and every
  // account-surface suppression flag stays off so the working directory's
  // own AGENTS.md channel stays open — leaking the canary marker is the
  // control's job.
  expect(cmd.some((token) => token.startsWith("HOME="))).toBe(false);
  expect(cmd).not.toContain("--ignore-user-config");
  expect(cmd).not.toContain("project_doc_max_bytes=0");
  // The experiment flags ride the control argv, and the file credential
  // store is forced once: the Keychain entry is keyed to the real CODEX_HOME.
  expect(cmd).toContain("features.non_prefixed_mcp_tool_names=false");
  expect(cmd.filter((token) => token === 'cli_auth_credentials_store="file"')).toHaveLength(1);
  // The relay's evidence dies with the run's own home.
  try { await adapter.cleanupRun(context); } catch { /* No-evidence verdicts stay. */ }
  expect(existsSync(codexHome)).toBe(false);
});

test("a non-control non-hermetic experiment request is refused a home", () => {
  const { adapter, request } = setup();
  expect(() => adapter.prepareRun({ ...request, hermetic: false }))
    .toThrow("Codex experiment requires a private hermetic home");
  // The validation boundary refuses the same request earlier: only the
  // check's marked control may drop --hermetic.
  expect(() => validateExperimentRequest({ ...request, hermetic: false })).toThrow(UsageRefusalError);
});

test("the control request is marked by the canary builder, not by its fields", () => {
  const { request } = setup();
  const control = experimentCanaryControl(request);
  expect(control.hermetic).toBe(false);
  expect(validateExperimentRequest(control)).toBeUndefined();
});
