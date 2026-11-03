/**
 * The real Codex model cache is shared by every Codex client on the machine;
 * the ChatGPT desktop app's app-server daemon rewrites it with its own
 * client_version (0.166.0 beside a 0.165.0 CLI on 2026-11-02). The
 * experiment serves that cache anyway, warns, and records the mismatch
 * instead of refusing (the live gate's codex G probe was refused for it).
 */

import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { RunContext } from "../src/adapters/base.js";
import { CodexAdapter } from "../src/adapters/codex.js";
import type { RunRequest } from "../src/types.js";

const contexts: { adapter: CodexAdapter; context: RunContext }[] = [];
afterEach(async () => {
  for (const { adapter, context } of contexts.splice(0)) {
    try { await adapter.cleanupRun(context); } catch { /* A failure fixture remains failed. */ }
  }
});

function setup(clientVersion: string) {
  const parent = resolve("scratch/session-14c66a93/exp/synthetic");
  mkdirSync(parent, { recursive: true });
  const cwd = mkdtempSync(join(parent, "codex-cache-"));
  const home = join(cwd, "operator");
  mkdirSync(join(home, ".codex"), { recursive: true });
  writeFileSync(join(home, ".codex", "models_cache.json"), JSON.stringify({
    client_version: clientVersion, fetched_at: "2026-11-02T15:45:07Z", models: [{ slug: "gpt-6-astra", tool_mode: "code_mode_only" }],
  }));
  const specPath = join(cwd, "spec.json");
  writeFileSync(specPath, JSON.stringify({ name: "experiment", command: process.execPath,
    args: ["--no-env-file", "--no-install", `--config=${resolve("bunfig.runtime.toml")}`, resolve("tests/fixtures/experiment-mcp.ts")],
    env: [], recording: join(cwd, "recordings"), accept_harness_prefix: ["codex-wall-time"] }));
  const request: RunRequest = { agent: "codex", prompt: "fixture", model: "gpt-6-astra", cwd, hermetic: true,
    tools: "none", autonomy: "read-only", sandboxed: true, experimentMcp: specPath, resultJson: true };
  const adapter = new CodexAdapter({ HOME: home, CODEX_API_KEY: "synthetic" }, home);
  adapter.validateRunRequest(request);
  const context = adapter.prepareRun(request);
  contexts.push({ adapter, context });
  return context.experimentCodex!;
}

test("a cache written by another Codex client is served with a warning and a record", async () => {
  const experiment = setup("0.166.0");
  const warnings: string[] = [];
  const original = console.error;
  console.error = (message?: unknown) => void warnings.push(String(message));
  try {
    await experiment.prepare("0.165.0");
  } finally {
    console.error = original;
  }
  expect(warnings).toContainEqual(expect.stringContaining("was written by Codex client 0.166.0; the experiment runs codex 0.165.0"));
  const records = readFileSync(experiment.recordingPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  expect(records.find((record) => record.kind === "catalog_client_version_mismatch")).toMatchObject({
    cache_client_version: "0.166.0", codex_version: "0.165.0",
  });
  expect(records.some((record) => record.kind === "catalog_override")).toBe(true);
});

test("a cache from the running Codex version records no mismatch", async () => {
  const experiment = setup("0.165.0");
  await experiment.prepare("0.165.0");
  const records = readFileSync(experiment.recordingPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  expect(records.some((record) => record.kind === "catalog_client_version_mismatch")).toBe(false);
});

test("an undetected Codex version still refuses to serve the cache", async () => {
  const experiment = setup("0.165.0");
  let thrown: unknown;
  try { await experiment.prepare(null); } catch (error) { thrown = error; }
  expect(String((thrown as Error).message)).toContain("the Codex version was not detected");
});
