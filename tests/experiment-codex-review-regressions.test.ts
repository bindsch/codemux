import { afterEach, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { CodexAdapter } from "../src/adapters/codex.js";
import { CodexRolloutParser } from "../src/experiment-codex-parser.js";
import { launchRunRequest } from "../src/launch.js";
import * as runtime from "../src/cli-runtime.js";
import type { RunContext } from "../src/run-context.js";
import type { RunRequest } from "../src/types.js";
import { codexCatalog, codexDefinitions, codexWorldState } from "./fixtures/experiment-codex.js";

const contexts: { adapter: CodexAdapter; context: RunContext }[] = [];
afterEach(async () => {
  for (const { adapter, context } of contexts.splice(0)) {
    try { await adapter.cleanupRun(context); } catch { /* Failure fixtures retain their verdict. */ }
  }
});

function fixture(model = "direct") {
  const parent = resolve("scratch/session-14c66a93/exp/review-j-codex");
  mkdirSync(parent, { recursive: true });
  const cwd = mkdtempSync(join(parent, "case-"));
  const home = join(cwd, "operator");
  mkdirSync(join(home, ".codex"), { recursive: true });
  writeFileSync(join(home, ".codex", "models_cache.json"), JSON.stringify({ client_version: "0.165.0",
    models: [{ slug: "direct", tool_mode: "direct" }, { slug: "code", tool_mode: "code_mode_only" }] }));
  const specPath = join(cwd, "spec.json");
  const recording = join(cwd, "recordings");
  writeFileSync(specPath, JSON.stringify({ name: "experiment", command: process.execPath,
    args: ["--no-env-file", "--no-install", `--config=${resolve("bunfig.runtime.toml")}`,
      resolve("tests/fixtures/experiment-mcp.ts")], env: [], recording,
    accept_harness_prefix: ["codex-wall-time"] }));
  const request: RunRequest = { agent: "codex", prompt: "fixture", model, cwd, hermetic: true,
    tools: "none", autonomy: "read-only", sandboxed: true, experimentMcp: specPath, resultJson: true };
  const adapter = new CodexAdapter({ HOME: home, CODEX_API_KEY: "synthetic" }, home);
  adapter.validateRunRequest(request);
  const context = adapter.prepareRun(request);
  contexts.push({ adapter, context });
  return { adapter, request, context, recording, experiment: context.experimentCodex! };
}

function records(path: string) {
  return readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line));
}

async function completedEvidence(context: RunContext, verify = true) {
  const experiment = context.experimentCodex!;
  await experiment.prepare("0.165.0");
  expect((await fetch(experiment.relay.catalogUrl!)).status).toBe(200);
  for (const [id, method] of [[1, "initialize"], [2, "tools/list"]] as const) {
    const response = await fetch(experiment.relay.url, { method: "POST", headers: {
      Authorization: `Bearer ${experiment.relay.token}`, "Content-Type": "application/json",
    }, body: JSON.stringify({ jsonrpc: "2.0", id, method, params: {} }) });
    expect(response.status).toBe(200);
    await response.json();
  }
  const sessions = join(context.hermeticHome!.codexHome, "sessions");
  mkdirSync(sessions, { recursive: true });
  const lines = [
    { type: "session_meta", payload: { id: "thread-cleanup" } },
    codexWorldState(["bash"]),
    { type: "response_item", payload: { type: "message", role: "assistant", id: "message-cleanup",
      content: [{ type: "output_text", text: "OK" }] } },
    { type: "event_msg", payload: { type: "token_count", info: { last_token_usage: {
      input_tokens: 4, cached_input_tokens: 0, output_tokens: 2,
    } } } },
  ].map((line) => JSON.stringify({ timestamp: "2026-10-29T00:00:00Z", ...line }));
  writeFileSync(join(sessions, "rollout-2026-10-29T00-00-00-thread-cleanup.jsonl"), lines.join("\n") + "\n");
  experiment.push(JSON.stringify({ type: "thread.started", thread_id: "thread-cleanup" }) + "\n");
  if (verify) await experiment.verify();
}

test.each([false, true])("Codex private-home cleanup fails before recording closure; synchronous=%s", async (synchronous) => {
  const { adapter, context, experiment } = fixture();
  await completedEvidence(context);
  expect(records(experiment.recordingPath).some((entry) => entry.kind === "run_end")).toBe(false);
  const finalize = spyOn(context.hermeticHome!, "finalize").mockImplementation(() => {
    const before = records(experiment.recordingPath);
    expect(before.some((entry) => entry.kind === "harness_log_copy" && typeof entry.bytes === "number")).toBe(true);
    expect(before.some((entry) => entry.kind === "run_end")).toBe(false);
    throw new Error("synthetic Codex private-home cleanup failure");
  });
  try {
    if (synchronous) expect(() => adapter.cleanupRunSync(context)).toThrow("private-home cleanup failure");
    else await expect(adapter.cleanupRun(context)).rejects.toThrow("private-home cleanup failure");
    const entries = records(experiment.recordingPath);
    expect(entries.find((entry) => entry.kind === "failure")).toMatchObject({ code: "protocol",
      message: "synthetic Codex private-home cleanup failure" });
    expect(entries.at(-1)).toMatchObject({ kind: "run_end", code: "protocol",
      error: "synthetic Codex private-home cleanup failure" });
    expect(existsSync(entries.find((entry) => entry.kind === "harness_log_copy").path)).toBe(true);
    expect(experiment.failureError).toMatchObject({ code: "protocol" });
  } finally { finalize.mockRestore(); }
});

test("Codex launch returns a failed envelope when private-home cleanup fails", async () => {
  const { adapter, request, context, experiment } = fixture();
  const prepare = spyOn(adapter, "prepareRun").mockReturnValue(context);
  const floor = spyOn(runtime, "assertHarnessSupported").mockResolvedValue("0.165.0");
  const finalize = spyOn(context.hermeticHome!, "finalize").mockImplementation(() => {
    expect(records(experiment.recordingPath).some((entry) => entry.kind === "run_end")).toBe(false);
    throw new Error("synthetic launch cleanup failure");
  });
  const run = spyOn(runtime, "runSandboxedWithStdin").mockImplementation(async () => {
    await completedEvidence(context, false);
    experiment.push(JSON.stringify({ type: "turn.started" }) + "\n" +
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", id: "reply", text: "OK" } }) + "\n" +
      JSON.stringify({ type: "turn.completed", usage: { input_tokens: 4, cached_input_tokens: 0, output_tokens: 2 } }) + "\n");
    return { stdout: experiment.finish(), stderr: "", success: true, exitCode: 0 };
  });
  try {
    const result = await launchRunRequest(adapter, request, { sandbox: true, requestedAutonomy: "read-only", cwd: request.cwd });
    expect(result).toMatchObject({ success: false, exitCode: 1 });
    expect(JSON.parse(result.stdout)).toMatchObject({ result: "OK", codemux: {
      recording: experiment.recordingPath, failure_code: "protocol", model: "direct" } });
    expect(records(experiment.recordingPath).at(-1)).toMatchObject({ kind: "run_end", code: "protocol",
      error: "synthetic launch cleanup failure" });
  } finally { prepare.mockRestore(); floor.mockRestore(); finalize.mockRestore(); run.mockRestore(); }
});

test.each([false, true])("ordinary Codex cleanup retains its logging behavior; synchronous=%s", async (synchronous) => {
  const { adapter, context } = fixture();
  const finalize = spyOn(context.hermeticHome!, "finalize").mockImplementation(() => { throw new Error("ordinary cleanup failure"); });
  const output = spyOn(console, "error").mockImplementation(() => {});
  try {
    const ordinaryContext = { hermeticHome: context.hermeticHome };
    if (synchronous) expect(() => adapter.cleanupRunSync(ordinaryContext)).not.toThrow();
    else await adapter.cleanupRun(ordinaryContext);
    expect(output).toHaveBeenCalledWith("codemux: could not remove codex's private hermetic home: ordinary cleanup failure");
  } finally { finalize.mockRestore(); output.mockRestore(); }
});

test.each([false, true])("Codex cleanup preserves finalizer errors before recording setup; synchronous=%s", async (synchronous) => {
  const { adapter, context, experiment } = fixture();
  const finalize = spyOn(context.hermeticHome!, "finalize").mockImplementation(() => { throw new Error("unprepared cleanup failure"); });
  try {
    if (synchronous) expect(() => adapter.cleanupRunSync(context)).toThrow("unprepared cleanup failure");
    else await expect(adapter.cleanupRun(context)).rejects.toThrow("unprepared cleanup failure");
    expect(experiment.startedRecordingPath).toBeUndefined();
  } finally { finalize.mockRestore(); }
});

test.each([false, true])("Codex interruption before thread.started records protocol failure; synchronous=%s", async (synchronous) => {
  const { adapter, context, experiment } = fixture();
  await experiment.prepare("0.165.0");
  if (synchronous) adapter.cleanupRunSync(context);
  else await expect(adapter.cleanupRun(context)).rejects.toThrow("interrupted before harness evidence");
  const entries = records(experiment.recordingPath);
  expect(entries.find((entry) => entry.kind === "failure")).toMatchObject({ code: "protocol",
    message: "interrupted before harness evidence" });
  expect(entries.at(-1)).toMatchObject({ kind: "run_end", code: "protocol",
    error: "interrupted before harness evidence" });
  expect(existsSync(context.hermeticHome!.home)).toBe(false);
});

// A cache from another client version is served with a warning
// (tests/experiment-codex-cache-version.test.ts); the undetected version is
// the preflight refusal that stays.
test.each(["direct", "code"].flatMap((model) => [null, undefined].map((version) => ({ model, version }))))(
  "Codex version preflight creates no recording for %j", async ({ model, version }) => {
    const { adapter, context, experiment, recording } = fixture(model);
    expect(existsSync(recording)).toBe(false);
    expect(experiment.startedRecordingPath).toBeUndefined();
    await expect(experiment.prepare(version)).rejects.toMatchObject({ code: "code_mode" });
    expect(existsSync(recording)).toBe(false);
    expect(experiment.startedRecordingPath).toBeUndefined();
    expect(context.experimentRecording).toBeUndefined();
    expect(experiment.failureError).toBeNull();
    await adapter.cleanupRun(context);
    expect(existsSync(context.hermeticHome!.home)).toBe(false);
  });

test.each([false, true])("Codex preserves an existing mcp__ namespace prefix; flat=%s", (flat) => {
  const parser = new CodexRolloutParser("thread", "mcp__foo", () => new Set(["lookup"]), () => {}, () => codexDefinitions(["lookup"]));
  parser.accept(codexCatalog(["lookup"], "mcp__foo"));
  parser.accept({ timestamp: "2026-10-29T00:00:00Z", type: "response_item", payload: {
    type: "function_call", id: "function", call_id: "call", arguments: "{}",
    ...(flat ? { name: "mcp__foo__lookup" } : { namespace: "mcp__foo", name: "lookup" }),
  } });
  expect(parser.calls).toHaveLength(1);
  const doubled = new CodexRolloutParser("thread", "mcp__foo", () => new Set(["lookup"]), () => {}, () => codexDefinitions(["lookup"]));
  doubled.accept(codexCatalog(["lookup"], "mcp__foo"));
  doubled.accept({ timestamp: "2026-10-29T00:00:00Z", type: "response_item", payload: {
    type: "function_call", id: "function", call_id: "call", arguments: "{}",
    namespace: "mcp__mcp__foo", name: "lookup",
  } });
  expect(() => doubled.finish()).toThrow("outside the experiment set");
});
