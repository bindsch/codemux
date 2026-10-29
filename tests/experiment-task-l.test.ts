import { afterEach, expect, spyOn, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { ExperimentKimiEvidence, type KimiEvidenceRelay } from "../src/experiment-kimi.js";
import { ExperimentKimiRun } from "../src/experiment-kimi-run.js";
import { KimiWireParser } from "../src/experiment-kimi-parser.js";
import { CodexRolloutParser } from "../src/experiment-codex-parser.js";
import { ExperimentFailureCode as Code } from "../src/experiment-records.js";
import { ExperimentHttpRelay } from "../src/experiment-relay.js";
import { ExperimentServer } from "../src/experiment-server.js";
import { cleanupPeers, peer } from "./helpers/experiment-peer.js";
import { codexCatalog, codexDefinitions } from "./fixtures/experiment-codex.js";

afterEach(cleanupPeers);
const tool = { name: "lookup", description: "test", inputSchema: {} };
function directory() {
  const parent = resolve("scratch/session-14c66a93/exp/task-l-fixtures");
  mkdirSync(parent, { recursive: true });
  return mkdtempSync(join(parent, "case-"));
}
function serverMock() {
  const start = spyOn(ExperimentServer.prototype, "start").mockImplementation(() => {});
  const request = spyOn(ExperimentServer.prototype, "request").mockImplementation(async (message) => message.id === undefined ? undefined : ({
    jsonrpc: "2.0", id: message.id, result: { tools: [tool] },
  }));
  return { request, restore: () => { start.mockRestore(); request.mockRestore(); } };
}
function log(path: string): Record<string, any>[] {
  return readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line));
}
async function post(relay: ExperimentHttpRelay, message: object) {
  const response = await fetch(relay.url, { method: "POST", headers: {
    Authorization: `Bearer ${relay.token}`, "Content-Type": "application/json",
  }, body: JSON.stringify({ jsonrpc: "2.0", ...message }) });
  return { status: response.status, body: await response.text() };
}

test.each([false, true])("Kimi termination records protocol failure after inventory; stdout=%s", async (stdout) => {
  const cwd = directory(), mock = serverMock();
  const run = new ExperimentKimiRun({ name: "experiment", command: process.execPath, args: [], env: [],
    recording: join(cwd, "records"), accept_harness_prefix: ["kimi-wall-time"] }, cwd, cwd, join(cwd, "agent.md"), {});
  try {
    await run.prepare();
    expect((await post(run.relay, { id: 1, method: "tools/list" })).status).toBe(200);
    if (stdout) run.push('{"role":"assistant","content":"received reply"}\n');
    run.terminateProtocol(); run.terminateProtocol();
    await expect(run.complete()).rejects.toMatchObject({ code: Code.Protocol,
      message: stdout ? "interrupted before verification" : "interrupted before harness evidence" });
    await run.close().catch(() => {});
    const records = log(run.recordingPath);
    expect(records.filter((record) => record.kind === "failure")).toHaveLength(1);
    expect(records.at(-1)).toMatchObject({ kind: "run_end", code: Code.Protocol,
      error: stdout ? "interrupted before verification" : "interrupted before harness evidence" });
  } finally { await run.close().catch(() => {}); mock.restore(); }
});

test("stopping unfinished Kimi evidence cannot make verification succeed", () => {
  const relay: KimiEvidenceRelay = { spec: { name: "experiment", accept_harness_prefix: ["kimi-wall-time"] },
    toolNames: new Set(["lookup"]), toolDefinitions: [tool], calls: [], record: () => {} };
  const evidence = new ExperimentKimiEvidence(relay, { kimiHome: directory() });
  evidence.stop();
  expect(() => evidence.finish()).toThrow(expect.objectContaining({ code: Code.Protocol }));
});

test("Kimi matches pending identical requests FIFO across staggered native records", async () => {
  const home = directory(), path = join(home, "sessions/workspace/session_test/agents/main/wire.jsonl");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ type: "llm.tools_snapshot", tools: [
    { name: "mcp__experiment__lookup", description: "test", parameters: {} },
  ] }) + "\n");
  const identified: unknown[] = [];
  const relay: KimiEvidenceRelay = { spec: { name: "experiment", accept_harness_prefix: ["kimi-wall-time"] },
    toolNames: new Set(["lookup"]), toolDefinitions: [tool],
    calls: [0, 1].map((relay_index) => ({ relay_index, name: "lookup", input: { query: "same" } })),
    record: (kind, fields) => { if (kind === "tool_call_identified") identified.push(fields); } };
  const evidence = new ExperimentKimiEvidence(relay, { kimiHome: home, callIdTimeoutMs: 1000 });
  try {
    const outcomes = Promise.allSettled(relay.calls.map((call) => evidence.resolveCallId(call)));
    for (const index of [1, 2]) {
      appendFileSync(path, JSON.stringify({ type: "context.append_loop_event", time: 1000, event: {
        type: "tool.call", uuid: `tool-${index}`, stepUuid: "step-1", toolCallId: `call-${index}`,
        name: "mcp__experiment__lookup", args: { query: "same" },
      } }) + "\n");
      await Bun.sleep(275);
    }
    expect(await outcomes).toEqual([1, 2].map((index) => ({ status: "fulfilled", value: `call-${index}` })));
    expect(identified).toEqual([1, 2].map((index) => ({ relay_index: index - 1, call_id: `call-${index}`,
      name: "lookup", input: { query: "same" }, correlation: "fifo" })));
  } finally { evidence.stop(); }
});

test.each(["", 42, null])("Kimi malformed optional provider messageId uses protocol: %j", (messageId) => {
  const parser = new KimiWireParser("experiment", () => new Set(["lookup"]), () => {}, () => [tool]);
  parser.accept({ type: "llm.tools_snapshot", tools: [{ name: "mcp__experiment__lookup", description: "test", parameters: {} }] });
  expect(() => parser.accept({ type: "context.append_loop_event", time: 1000,
    event: { type: "step.end", uuid: "step-1", messageId, usage: { inputOther: 1, output: 1, inputCacheRead: 0, inputCacheCreation: 0 } } }))
    .toThrow(expect.objectContaining({ code: Code.Protocol, message: "Kimi step.end has an invalid provider messageId" }));
});

test.each([false, true])("Claude rejects duplicate tool IDs within a frame; cumulative=%s", async (cumulative) => {
  const p = peer(); await p.ready();
  const call = { type: "tool_use", id: "native-1", name: "mcp__experiment__bash", input: {} };
  const frame = (content: unknown[]) => ({ type: "assistant", message: { id: "message-1", role: "assistant", content,
    usage: { input_tokens: 1, output_tokens: 1 } } });
  if (cumulative) {
    p.push(frame([call]));
    expect(() => p.push(frame([call]))).not.toThrow();
  }
  expect(() => p.push(frame([call, call]))).toThrow(expect.objectContaining({ code: Code.Protocol }));
  expect(p.records().filter((record) => record.kind === "tool_call")).toHaveLength(cumulative ? 1 : 0);
});

test("tools/call notifications return 400 and protocol before server dispatch", async () => {
  const cwd = directory(), mock = serverMock();
  const relay = new ExperimentHttpRelay({ name: "experiment", command: process.execPath, args: [], env: [], recording: join(cwd, "records") }, cwd, {});
  try {
    await relay.start();
    expect((await post(relay, { id: 1, method: "tools/list" })).status).toBe(200);
    expect(await post(relay, { method: "notifications/initialized" })).toEqual({ status: 202, body: "" });
    const before = mock.request.mock.calls.length;
    expect(await post(relay, { method: "tools/call", params: { name: "lookup", arguments: {} } })).toEqual({ status: 400, body: "" });
    expect(relay.failureCode).toBe(Code.Protocol);
    expect(mock.request.mock.calls).toHaveLength(before);
    expect(relay.calls).toHaveLength(0);
  } finally { await relay.close().catch(() => {}); mock.restore(); }
});

test.each(["function_call", "custom_tool_call"])("Codex refuses foreign exec with unknown_tool for %s", (type) => {
  const parser = new CodexRolloutParser("thread-1", "experiment", () => new Set(["lookup"]), () => {}, () => codexDefinitions(["lookup"]));
  parser.accept(codexCatalog(["lookup"]));
  expect(() => parser.accept({ timestamp: "2026-10-29T00:00:00.000Z", type: "response_item", payload: {
    type, namespace: "functions", name: "exec", id: "fc1", call_id: "call1", arguments: "{}", input: "{}",
  } })).toThrow(expect.objectContaining({ code: Code.UnknownTool }));
  expect(parser.calls).toHaveLength(0);
});
