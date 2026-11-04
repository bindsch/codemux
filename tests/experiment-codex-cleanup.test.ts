/** Codex experiment cleanup ordering (split from
 * tests/experiment-codex-run.test.ts to keep both files small): what
 * runs when evidence preservation fails mid-cleanup. */

import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { codexCatalog, codexWorldState } from "./fixtures/experiment-codex.js";
import { join, resolve } from "node:path";
import { CodexAdapter } from "../src/adapters/codex.js";
import type { RunContext } from "../src/run-context.js";
import type { RunRequest } from "../src/types.js";
import { MARKER, respond } from "./fixtures/experiment-mcp.js";

const contexts: { adapter: CodexAdapter; context: RunContext }[] = [];
afterEach(async () => {
  for (const { adapter, context } of contexts.splice(0)) {
    try { await adapter.cleanupRun(context); } catch { /* A failure fixture remains failed. */ }
  }
});

function setup() {
  const parent = resolve("scratch/session-14c66a93/exp/synthetic");
  mkdirSync(parent, { recursive: true });
  const cwd = mkdtempSync(join(parent, "codex-"));
  const home = join(cwd, "operator");
  mkdirSync(join(home, ".codex"), { recursive: true });
  writeFileSync(join(home, ".codex", "models_cache.json"), JSON.stringify({
    client_version: "0.165.0", fetched_at: "2026-10-29T00:00:00Z", models: [
      { slug: "gpt-5.5", tool_mode: "direct" },
    ],
  }));
  const specPath = join(cwd, "spec.json");
  writeFileSync(specPath, JSON.stringify({ name: "experiment", command: process.execPath,
    args: ["--no-env-file", "--no-install", `--config=${resolve("bunfig.runtime.toml")}`,
      resolve("tests/fixtures/experiment-mcp.ts")], env: [], recording: join(cwd, "recordings"),
    accept_harness_prefix: ["codex-wall-time"] }));
  const request: RunRequest = { agent: "codex", prompt: "fixture", model: "gpt-5.5", cwd, hermetic: true,
    tools: "none", autonomy: "read-only", sandboxed: true, experimentMcp: specPath, resultJson: true };
  const adapter = new CodexAdapter({ HOME: home, CODEX_API_KEY: "synthetic" }, home);
  adapter.validateRunRequest(request);
  const context = adapter.prepareRun(request);
  contexts.push({ adapter, context });
  return { adapter, context, experiment: context.experimentCodex! };
}

async function callFixture(experiment: RunContext["experimentCodex"], context: RunContext) {
  const relay = experiment!.relay;
  expect((await fetch(relay.catalogUrl!)).status).toBe(200);
  async function post(message: object) {
    const response = await fetch(relay.url, { method: "POST", headers: {
      Authorization: `Bearer ${relay.token}`, "Content-Type": "application/json",
    }, body: JSON.stringify(message) });
    expect(response.status).toBe(200);
    return response.json();
  }
  await post({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  await post({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  rollout(context);
  experiment!.push(JSON.stringify({ type: "thread.started", thread_id: "thread-test" }) + "\n");
  await post({ jsonrpc: "2.0", id: 3, method: "tools/call",
    params: { name: "bash", arguments: { command: "marker" } } });
}

function rollout(context: RunContext) {
  const sessions = join(context.hermeticHome!.codexHome, "sessions", "2026", "10", "29");
  mkdirSync(sessions, { recursive: true });
  const output = [
    { type: "input_text", text: "Wall time: 0.0123 seconds\nOutput:" },
    { type: "input_text", text: MARKER },
  ];
  const lines = [
    { type: "session_meta", payload: { id: "thread-test" } }, codexCatalog((respond({ id: 1, method: "tools/list" }) as any).result.tools), codexWorldState(["bash"]),
    { type: "response_item", payload: { type: "function_call", id: "fc_1", call_id: "call_1",
      name: "mcp__experiment__bash", arguments: '{"command":"marker"}' } },
    { type: "event_msg", payload: { type: "token_count", info: { last_token_usage: {
      input_tokens: 100, cached_input_tokens: 20, cache_write_input_tokens: 0, output_tokens: 10,
    } } } },
    { type: "response_item", payload: { type: "function_call_output", call_id: "call_1", output } },
    { type: "response_item", payload: { type: "message", role: "assistant", id: "msg_2",
      content: [{ type: "output_text", text: "finished" }] } },
    { type: "event_msg", payload: { type: "token_count", info: { last_token_usage: {
      input_tokens: 120, cached_input_tokens: 30, cache_write_input_tokens: 0, output_tokens: 5,
    } } } },
  ].map((line, index) => ({ timestamp: `2026-10-29T00:00:0${index}.000Z`, ...line }));
  writeFileSync(join(sessions, "rollout-2026-10-29T00-00-00-thread-test.jsonl"),
    lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
}

function execEvents(context: RunContext) {
  const events = [
    { type: "turn.started" },
    { type: "item.completed", item: { type: "mcp_tool_call", id: "item_1", server: "experiment",
      tool: "bash", arguments: { command: "marker" }, result: { content: [{ type: "text", text: MARKER }] }, status: "completed" } },
    { type: "item.completed", item: { type: "agent_message", id: "item_2", text: "finished" } },
    { type: "turn.completed", usage: { input_tokens: 220, cached_input_tokens: 50,
      cache_write_input_tokens: 0, output_tokens: 15 } },
  ];
  const wire = events.map((event) => JSON.stringify(event)).join("\n") + "\n";
  context.stdoutSink!.push(wire.slice(0, 39));
  context.stdoutSink!.push(wire.slice(39));
  return context.stdoutSink!.finish();
}

test("a Codex evidence-preservation failure still finalizes the private home (review round 64)", async () => {
  const { adapter, context, experiment } = setup();
  await experiment.prepare("0.165.0");
  await callFixture(experiment, context);
  execEvents(context);
  // The copy helper records its own destination failures instead of
  // throwing, so the ordering pin forces the one thrower directly:
  // whatever makes preserveHarnessLog fail, the hermetic home must not
  // survive it and the failure must still be relayed. Before the fix the
  // throw skipped the home finalizer entirely.
  const preserve = experiment.preserveHarnessLog;
  let thrown = false;
  experiment.preserveHarnessLog = () => {
    if (thrown) return preserve.call(experiment);
    thrown = true;
    throw new Error("synthetic evidence preservation failure");
  };
  const privateHome = context.hermeticHome!.home;
  expect(() => adapter.cleanupRunSync(context)).toThrow("synthetic evidence preservation failure");
  expect(existsSync(privateHome)).toBe(false);
  const records = readFileSync(experiment.recordingPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  expect(records.find((record) => record.kind === "failure" &&
    record.message === "synthetic evidence preservation failure")).toBeDefined();
  expect(records.at(-1)).toMatchObject({ kind: "run_end", error: "synthetic evidence preservation failure" });
});

test("two Codex cleanup failures reach the recording as one failure naming both (review round 69)", async () => {
  // The relay latches its first failure: relaying each one separately
  // kept only the first in the recording and in close()'s rejection.
  const { adapter, context, experiment } = setup();
  await experiment.prepare("0.165.0");
  await callFixture(experiment, context);
  execEvents(context);
  const preserve = experiment.preserveHarnessLog;
  let thrown = false;
  experiment.preserveHarnessLog = () => {
    if (thrown) return preserve.call(experiment);
    thrown = true;
    throw new Error("evidence failure");
  };
  const home = context.hermeticHome!;
  const realFinalize = home.finalize.bind(home);
  home.finalize = () => { throw new Error("home failure"); };
  try {
    let caught: unknown;
    try { adapter.cleanupRunSync(context); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(AggregateError);
    expect((caught as Error).message).toContain("evidence failure");
    expect((caught as Error).message).toContain("home failure");
    const records = readFileSync(experiment.recordingPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    const failure = records.find((record) => record.kind === "failure");
    expect(failure?.message).toContain("evidence failure");
    expect(failure?.message).toContain("home failure");
  } finally {
    home.finalize = realFinalize;
    realFinalize();
  }
});
