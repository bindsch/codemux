import { expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { CodexAdapter } from "../src/adapters/codex.js";
import { ZaiAdapter } from "../src/adapters/zai.js";
import { validateExperimentRequest } from "../src/experiment-mcp.js";
import { ExperimentFailure, ExperimentFailureCode } from "../src/experiment-records.js";
import { launchRunRequest } from "../src/launch.js";
import { experimentFailedResult } from "../src/result-envelope/experiment.js";
import type { RunRequest } from "../src/types.js";
import { createFakeBinaryEnv, runCli } from "./helpers/cli.js";

function fixture() {
  const parent = resolve("scratch/session-14c66a93/exp/review-i-preflight");
  mkdirSync(parent, { recursive: true });
  const cwd = mkdtempSync(join(parent, "case-"));
  const home = join(cwd, "operator");
  mkdirSync(join(home, ".codex"), { recursive: true });
  const spec = join(cwd, "spec.json");
  writeFileSync(spec, JSON.stringify({ name: "experiment", command: process.execPath,
    args: [], env: [], accept_harness_prefix: ["codex-wall-time", "kimi-wall-time"] }));
  const request: RunRequest = { agent: "codex", prompt: "fixture", cwd, hermetic: true,
    tools: "none", autonomy: "read-only", sandboxed: true, experimentMcp: spec, resultJson: true };
  return { cwd, home, spec, request };
}

test("cleanup failure preserves the normalized Z.AI default model without --model", () => {
  const adapter = new ZaiAdapter({});
  const request: RunRequest = { agent: "zai", prompt: "fixture", resultJson: true };
  const processed = adapter.processRunResult({ stdout: JSON.stringify({ type: "result", result: "OK",
    usage: { input_tokens: 3, output_tokens: 2 } }), stderr: "", exitCode: 0, success: true }, request);
  expect(JSON.parse(processed.stdout).codemux.model).toBe("opus");
  const failed = experimentFailedResult(processed, request, "/fixture/recording.jsonl",
    new ExperimentFailure(ExperimentFailureCode.Protocol, "private home cleanup failed"));
  expect(failed.success).toBe(false);
  expect(JSON.parse(failed.stdout).codemux).toMatchObject({ model: "opus", failure_code: "protocol",
    recording: "/fixture/recording.jsonl", usage: { input_tokens: 3, output_tokens: 2 } });
});

test.each(["codex", "kimi"] as const)("%s experiment validation refuses untrusted sandbox network policy", (agent) => {
  const { request } = fixture();
  expect(() => validateExperimentRequest({ ...request, agent, sandboxTrust: "untrusted" }))
    .toThrow("--sandbox-trust untrusted");
});

test.each(["codex", "kimi"] as const)("%s experiment launch refuses untrusted sandbox before preparation", async (agent) => {
  const { request, cwd } = fixture();
  const adapter = new CodexAdapter({});
  const prepare = spyOn(adapter, "prepareRun").mockImplementation(() => { throw new Error("unexpected preparation"); });
  const validate = spyOn(adapter, "validateRunRequest").mockImplementation(() => { throw new Error("unexpected validation"); });
  try {
    await expect(launchRunRequest(adapter, { ...request, agent }, { sandbox: true, cwd,
      requestedAutonomy: "read-only", sandboxPolicyOverrides: { trust: "untrusted" } }))
      .rejects.toThrow("--sandbox-trust untrusted");
    expect(prepare).not.toHaveBeenCalled();
    expect(validate).not.toHaveBeenCalled();
  } finally { prepare.mockRestore(); validate.mockRestore(); }
});

test.each(["codex", "kimi"] as const)("%s experiment commands refuse untrusted sandbox before installation checks", async (agent) => {
  const { spec } = fixture();
  const fake = createFakeBinaryEnv({});
  try {
    for (const command of ["run", "check"]) {
      const result = await runCli([command, "-a", agent, "--hermetic", "--tools", "none",
        "--auto", "read-only", "--sandbox-trust", "untrusted", "--experiment-mcp", spec,
        ...(command === "run" ? ["-p", "fixture"] : [])], fake.env);
      // A pre-launch refusal of a caller mistake: 64 since review round 3
      // made the experiment flag-combination refusals UsageRefusalErrors.
      expect(result.exitCode).toBe(64);
      expect(result.stderr).toContain("--sandbox-trust untrusted");
      expect(result.stderr).not.toContain("is not installed");
    }
  } finally { fake.cleanup(); }
});

test.each([
  { model: undefined, cache: undefined, code: "model_required" },
  { model: "missing", cache: { client_version: "0.165.0", models: [{ slug: "listed", tool_mode: "direct" }] },
    code: "model_unavailable" },
  { model: "requested", cache: null, code: "code_mode" },
])("Codex result-json preflight emits $code without launching a harness", async ({ model, cache, code }) => {
  const { cwd, home, spec } = fixture();
  if (cache !== undefined) writeFileSync(join(home, ".codex", "models_cache.json"), JSON.stringify(cache));
  const fake = createFakeBinaryEnv({ codex: "printf 'unexpected harness launch' >&2; exit 91", scode: "exit 92" });
  try {
    const result = await runCli(["run", "-a", "codex", "--hermetic", "--tools", "none",
      "--auto", "read-only", "--cwd", cwd, "--experiment-mcp", spec, "--result-json",
      ...(model ? ["-m", model] : []), "-p", "fixture"], { ...fake.env, HOME: home });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).not.toContain("unexpected harness launch");
    expect(result.stderr).toContain(`[${code}]`);
    expect(result.stdout, result.stderr).not.toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({ result: null, codemux: {
      agent: "codex", model: model ?? null, failure_code: code, recording: null } });
  } finally { fake.cleanup(); }
});
