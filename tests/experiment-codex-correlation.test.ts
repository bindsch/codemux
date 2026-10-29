import { expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ExperimentCodexEvidence, type CodexEvidenceRelay } from "../src/experiment-codex.js";
import { ExperimentFailureCode } from "../src/experiment-records.js";
import { ExperimentHttpRelay, type ExperimentRelayCall } from "../src/experiment-relay.js";
import { ExperimentServer, type JsonObject } from "../src/experiment-server.js";
import { codexCatalog, codexDefinitions } from "./fixtures/experiment-codex.js";

const THREAD = "12345678-1234-4234-8234-123456789abc";
const TIME = "2026-10-29T01:02:03.125Z";
const HEADER = "Wall time: 0.0123 seconds\nOutput:";
const USAGE = { input_tokens: 4, output_tokens: 1, cached_input_tokens: 0 };
const CONTENT = [{ type: "text", text: "same" }];

function directory(): string {
  const parent = resolve("scratch/session-14c66a93/exp/codex-correlation-fixtures");
  mkdirSync(parent, { recursive: true });
  return mkdtempSync(join(parent, "case-"));
}

function rollout(calls: ExperimentRelayCall[]): string {
  const home = directory();
  const sessions = join(home, "sessions/2026/10/29");
  mkdirSync(sessions, { recursive: true });
  const lines = [
    { type: "session_meta", payload: { id: THREAD } },
    codexCatalog(["lookup"]),
    ...calls.map((call, index) => ({ type: "response_item", payload: { type: "function_call",
      id: `function-${index}`, call_id: call.call_id, namespace: "mcp__experiment", name: call.name,
      arguments: JSON.stringify(call.input) } })),
    ...calls.map((call) => ({ type: "response_item", payload: { type: "function_call_output", call_id: call.call_id,
      output: `${HEADER}\n${call.result!.content[0].text}` } })),
    { type: "event_msg", payload: { type: "token_count", info: { last_token_usage: USAGE } } },
  ];
  writeFileSync(join(sessions, `rollout-2026-10-29T01-02-03-${THREAD}.jsonl`),
    lines.map((line) => JSON.stringify({ timestamp: TIME, ...line })).join("\n") + "\n");
  return home;
}

function complete(evidence: ExperimentCodexEvidence, call: ExperimentRelayCall, extra: JsonObject = {}): void {
  evidence.accept({ type: "item.completed", item: { type: "mcp_tool_call", server: "experiment",
    tool: call.name, arguments: call.input, result: { content: call.result!.content, structured_content: null },
    status: call.result!.isError ? "failed" : "completed", error: null, ...extra } });
}

async function post(relay: ExperimentHttpRelay, id: number, method: string, params?: JsonObject) {
  const response = await fetch(relay.url, { method: "POST", headers: {
    Authorization: `Bearer ${relay.token}`, "Content-Type": "application/json",
  }, body: JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) }) });
  return { status: response.status, body: await response.text() };
}

test.each([
  { metadata: true, fetched: false }, { metadata: false, fetched: false }, { metadata: true, fetched: true },
])("Codex requires catalog delivery before resolving and dispatching a call; %j", async ({ metadata, fetched }) => {
  const cwd = directory();
  const start = spyOn(ExperimentServer.prototype, "start").mockImplementation(() => {});
  let dispatches = 0;
  const request = spyOn(ExperimentServer.prototype, "request").mockImplementation(async (message) => {
    if (message.method === "tools/call") dispatches++;
    return { jsonrpc: "2.0", id: message.id, result: message.method === "tools/list"
      ? { tools: codexDefinitions(["lookup"]) } : { content: CONTENT } };
  });
  const relay = new ExperimentHttpRelay({ name: "experiment", command: process.execPath, env: [],
    args: [], recording: join(cwd, "records") }, cwd, {}, { catalog: { body: '{"models":[]}' } });
  const evidence = new ExperimentCodexEvidence(relay, { catalogRequired: true, callIdTimeoutMs: 25 });
  relay.resolveCallId = (call, message) => evidence.resolveCallId(call, message);
  try {
    await relay.start();
    expect((await post(relay, 1, "initialize")).status).toBe(200);
    expect((await post(relay, 2, "tools/list")).status).toBe(200);
    evidence.accept({ type: "thread.started", thread_id: THREAD });
    if (fetched) {
      const response = await fetch(relay.catalogUrl!);
      expect(response.status).toBe(200); await response.text();
    }
    expect((await post(relay, 3, "tools/call", { name: "lookup", arguments: {},
      ...(metadata ? { _meta: { callId: "native-call" } } : {}) })).status).toBe(fetched ? 200 : 400);
    expect(dispatches).toBe(fetched ? 1 : 0);
    expect(relay.failureCode).toBe(fetched ? null : ExperimentFailureCode.CodeMode);
    if (!fetched) expect(relay.failureError?.message).toContain("did not fetch the experiment catalog");
  } finally {
    evidence.stop(); await relay.close().catch(() => {});
    request.mockRestore(); start.mockRestore();
  }
});

test("Codex metadata correlates parallel HTTP arrivals in reverse rollout order", async () => {
  const calls: ExperimentRelayCall[] = ["first", "second"].map((value, index) => ({ relay_index: index,
    call_id: `call-${value}`, name: "lookup", input: { value }, result: { content: [{ type: "text", text: value }] } }));
  const home = rollout(calls);
  const cwd = directory();
  // Keep the HTTP relay and native evidence real. Replace the stdio peer only.
  const start = spyOn(ExperimentServer.prototype, "start").mockImplementation(() => {});
  const request = spyOn(ExperimentServer.prototype, "request").mockImplementation(async (message) => {
    if (message.params?.arguments?.value === "second") await Bun.sleep(20);
    return { jsonrpc: "2.0", id: message.id, result: message.method === "tools/list"
      ? { tools: codexDefinitions(["lookup"]) } : { content: [{ type: "text", text: message.params.arguments.value }] } };
  });
  const relay = new ExperimentHttpRelay({ name: "experiment", command: process.execPath, env: [],
    accept_harness_prefix: ["codex-wall-time"], recording: join(cwd, "records"),
    args: [],
  }, cwd, {});
  const evidence = new ExperimentCodexEvidence(relay, { codexHome: home });
  relay.resolveCallId = (call, request) => evidence.resolveCallId(call, request);
  try {
    await relay.start();
    expect((await post(relay, 1, "tools/list")).status).toBe(200);
    evidence.accept({ type: "thread.started", thread_id: THREAD });
    const second = post(relay, 2, "tools/call", {
      name: "lookup", arguments: { value: "second" }, _meta: { callId: "call-second" },
    });
    const deadline = Date.now() + 1000;
    while (relay.calls.length === 0 && Date.now() < deadline) await Bun.sleep(1);
    expect(relay.calls).toHaveLength(1);
    const first = post(relay, 3, "tools/call", {
      name: "lookup", arguments: { value: "first" }, _meta: { callId: "call-first" },
    });
    expect((await Promise.all([second, first])).map((response) => response.status)).toEqual([200, 200]);
    expect(relay.calls.map((call) => call.call_id)).toEqual(["call-second", "call-first"]);
    for (const call of calls) complete(evidence, call);
    evidence.finish(home);
    relay.finish();
    const records = readFileSync(relay.recordingPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(records.filter((record) => record.kind === "result_comparison").map((record) => ({
      call_id: record.call_id, relay_index: record.relay_index, equal: record.equal,
    }))).toEqual([
      { call_id: "call-second", relay_index: 0, equal: true },
      { call_id: "call-first", relay_index: 1, equal: true },
    ]);
  } finally {
    evidence.stop();
    await relay.close().catch(() => {});
    request.mockRestore();
    start.mockRestore();
  }
});

function identicalCalls(): ExperimentRelayCall[] {
  return [false, true].map((isError, relay_index) => ({ relay_index, call_id: `native-${relay_index}`,
    name: "lookup", input: {}, result: { content: CONTENT, isError } }));
}

function evidenceFor(calls: ExperimentRelayCall[]) {
  const relay: CodexEvidenceRelay = { spec: { name: "experiment", accept_harness_prefix: ["codex-wall-time"] },
    toolNames: new Set(["lookup"]), toolDefinitions: codexDefinitions(["lookup"]), calls, record() {} };
  const evidence = new ExperimentCodexEvidence(relay);
  evidence.accept({ type: "thread.started", thread_id: THREAD });
  return evidence;
}

test.each(["tool reported failure", { message: "tool reported failure" }])(
  "Codex accepts and records matching failed MCP results carrying an error: %j", (error) => {
    const calls = identicalCalls();
    const records: JsonObject[] = [];
    const evidence = new ExperimentCodexEvidence({ spec: { name: "experiment", accept_harness_prefix: ["codex-wall-time"] },
      toolNames: new Set(["lookup"]), toolDefinitions: codexDefinitions(["lookup"]), calls, record: (kind, fields) => { records.push({ kind, ...fields }); } });
    evidence.accept({ type: "thread.started", thread_id: THREAD });
    complete(evidence, calls[0]!);
    complete(evidence, calls[1]!, { error });
    try {
      expect(() => evidence.finish(rollout(calls))).not.toThrow();
      expect(records.find((record) => record.kind === "harness_tool_result" && record.status === "failed"))
        .toMatchObject({ error, error_text: "tool reported failure" });
    } finally { evidence.stop(); }
  },
);

test.each(["success", "server", "tool", "arguments", "content", "status", "missing-result"])(
  "Codex still rejects a completion error with mismatched evidence: %s", (field) => {
    const calls = identicalCalls();
    const evidence = evidenceFor(calls);
    const extra: JsonObject = { error: { message: "tool reported failure" } };
    if (field === "server" || field === "tool") extra[field] = "foreign";
    if (field === "arguments") extra.arguments = { changed: true };
    if (field === "content") extra.result = { content: [{ type: "text", text: "changed" }] };
    if (field === "status") extra.status = "completed";
    if (field === "missing-result") extra.result = null;
    complete(evidence, calls[0]!, field === "success" ? extra : {});
    complete(evidence, calls[1]!, field === "success" ? {} : extra);
    try {
      expect(() => evidence.finish(rollout(calls))).toThrow("Codex exec MCP result does not match");
    } finally { evidence.stop(); }
  },
);

test.each([undefined, "call_id", "callId"])(
  "Codex identical parallel results match error-first completions using native field %s", (field) => {
    const calls = identicalCalls();
    const evidence = evidenceFor(calls);
    for (const call of [...calls].reverse()) complete(evidence, call, field ? { [field]: call.call_id } : {});
    expect(() => evidence.finish(rollout(calls))).not.toThrow();
  },
);

test.each(["call_id", "callId"])("Codex exec native %s cannot be reassigned by completion status", (field) => {
  const calls = identicalCalls();
  const evidence = evidenceFor(calls);
  complete(evidence, calls[0]!, { [field]: calls[1]!.call_id });
  complete(evidence, calls[1]!, { [field]: calls[0]!.call_id });
  try { evidence.finish(rollout(calls)); throw new Error("accepted conflicting native result identity"); }
  catch (error) { expect(error).toMatchObject({ code: ExperimentFailureCode.ResultChanged }); }
});
