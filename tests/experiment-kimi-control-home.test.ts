/**
 * The Kimi experiment control probe's write target (audit gap 5): the
 * planted scratch brand home rides on the control request itself, so the
 * control run's private MCP configuration lands inside the canary scratch
 * even when no KIMI_CODE_HOME hint exists anywhere.
 */

import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { KimiAdapter } from "../src/adapters/kimi.js";
import { experimentCanaryControl, validateExperimentRequest } from "../src/experiment-mcp.js";
import { UsageRefusalError } from "../src/validation.js";
import type { RunContext } from "../src/run-context.js";
import type { RunRequest } from "../src/types.js";

const pending: { adapter: KimiAdapter; context: RunContext }[] = [];
afterEach(() => {
  for (const { adapter, context } of pending.splice(0)) {
    try { adapter.cleanupRunSync(context); } catch { /* Failure verdicts stay. */ }
  }
});

function setup() {
  const parent = resolve("scratch/session-14c66a93/exp/kimi-control-home");
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, "run-"));
  const cwd = join(root, "work");
  mkdirSync(join(cwd, ".git"), { recursive: true });
  const home = join(root, "operator");
  mkdirSync(join(home, ".kimi-code"), { recursive: true });
  const specPath = join(root, "spec.json");
  writeFileSync(specPath, JSON.stringify({ name: "exp__test", command: process.execPath,
    args: ["--no-env-file", "--no-install", `--config=${resolve("bunfig.runtime.toml")}`,
      resolve("tests/fixtures/experiment-mcp.ts")], env: [], recording: join(root, "recordings"),
    accept_harness_prefix: ["kimi-wall-time"] }));
  const request: RunRequest = { agent: "kimi", prompt: "fixture", cwd, hermetic: true,
    tools: "none", autonomy: "read-only", sandboxed: true, experimentMcp: specPath };
  // No KIMI_CODE_HOME anywhere: not in the environment, not passed through.
  const adapter = new KimiAdapter({ HOME: home }, home);
  const plantedBrandHome = mkdtempSync(join(root, "planted-brand-"));
  return { adapter, request, home, plantedBrandHome };
}

test("the control request writes its private MCP config under the planted home with no environment hint", async () => {
  const { adapter, request, home, plantedBrandHome } = setup();
  const control = experimentCanaryControl(request, plantedBrandHome);
  expect(validateExperimentRequest(control)).toBeUndefined();
  const context = adapter.prepareRun(control);
  pending.push({ adapter, context });
  const experiment = context.experimentKimi!;
  await experiment.prepare();
  const config = JSON.parse(readFileSync(join(plantedBrandHome, "mcp.json"), "utf8"));
  expect(config.mcpServers.exp__test.url).toBe(experiment.relay.url);
  expect(existsSync(join(plantedBrandHome, "config.toml"))).toBe(true);
  expect(context.kimiNoToolsFile!.path.startsWith(plantedBrandHome)).toBe(true);
  // The operator-visible brand home the environment would have chosen is untouched.
  expect(existsSync(join(home, ".kimi-code", "mcp.json"))).toBe(false);
  expect(existsSync(join(home, ".kimi-code", "config.toml"))).toBe(false);
});

test("the planted home field is refused on a request that is not a control probe", () => {
  const { request, plantedBrandHome } = setup();
  expect(() => validateExperimentRequest({ ...request, kimiControlBrandHome: plantedBrandHome }))
    .toThrow("kimiControlBrandHome is internal to the experiment control probe");
  // Without --experiment-mcp too (review round 15, minor 4): the refusal
  // sits ahead of the experiment's early return, and a UsageRefusalError
  // is the CLI's exit 64.
  const refusal = (() => {
    try {
      validateExperimentRequest({ ...request, experimentMcp: undefined, kimiControlBrandHome: plantedBrandHome });
    } catch (error) {
      return error;
    }
    return null;
  })();
  expect(refusal).toBeInstanceOf(UsageRefusalError);
  expect((refusal as Error).message).toBe(
    "kimiControlBrandHome is internal to the experiment control probe and cannot be set on a request"
  );
  expect(() => validateExperimentRequest(experimentCanaryControl(request))).not.toThrow();
});
