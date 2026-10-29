import { expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { ExperimentKimiEvidence, type KimiEvidenceRelay } from "../src/experiment-kimi.js";
import { ExperimentKimiRun } from "../src/experiment-kimi-run.js";
import { ExperimentFailure, ExperimentFailureCode as Code } from "../src/experiment-records.js";
import { ExperimentServer } from "../src/experiment-server.js";
import { KIMI_STREAM_SESSION, kimiAssistantCall, kimiResumeHint } from "./fixtures/kimi-stream.js";

type Entry = Record<string, any>;
const NAME = "mcp__experiment__lookup";
const TOOL = { name: "lookup", description: "", inputSchema: {} };
const USAGE = { inputOther: 1, output: 1, inputCacheRead: 0, inputCacheCreation: 0 };
const loop = (event: Entry) => ({ type: "context.append_loop_event", time: 1000, event });
const call = (id: string, name = NAME, input = {}) => ({ id, name, input });
const native = (c: Entry) => ({ type: "function", id: c.id, name: c.name, arguments: JSON.stringify(c.input) });
const encode = (entries: Entry[]) => entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n";

function entries(calls: Entry[], outputs: string[], isError = false): Entry[] {
  return [{ type: "llm.tools_snapshot", tools: [{ name: NAME, description: "", parameters: {} }] },
    ...calls.map((c) => loop({ type: "tool.call", uuid: `uuid-${c.id}`, stepUuid: "step-1", toolCallId: c.id, name: c.name, args: c.input })),
    loop({ type: "step.end", uuid: "step-1", usage: USAGE }),
    { type: "agent.message.appended", message: { message: { role: "assistant", content: [], toolCalls: calls.map(native) }, meta: { usage: USAGE } } },
    ...calls.flatMap((c, i) => [loop({ type: "tool.result", parentUuid: `uuid-${c.id}`, toolCallId: c.id,
      result: { output: outputs[i], isError, durationMs: 5 } }),
    { type: "agent.message.appended", message: { message: { role: "tool", toolCallId: c.id, content: [{ type: "text", text: outputs[i] }] } } }])];
}

function fixture(lines: Entry[], calls: Entry[] = [call("call-1")], outputs = ["answer"], isError = false) {
  const parent = resolve("scratch/session-14c66a93/exp/kimi-task-t");
  mkdirSync(parent, { recursive: true });
  const home = mkdtempSync(join(parent, "case-"));
  const path = join(home, "sessions/workspace", KIMI_STREAM_SESSION, "agents/main/wire.jsonl");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, encode(lines));
  const records: Entry[] = [], failures: Error[] = [];
  const relay: KimiEvidenceRelay = { spec: { name: "experiment", accept_harness_prefix: ["kimi-wall-time"] },
    toolNames: new Set(["lookup"]), toolDefinitions: [TOOL],
    calls: calls.map((c, relay_index) => ({ relay_index, name: "lookup", input: c.input,
      result: { content: [{ type: "text", text: outputs[relay_index] }], ...(isError ? { isError: true } : {}) } })),
    record(kind, fields) { records.push({ kind, ...fields }); } };
  const evidence = new ExperimentKimiEvidence(relay, { kimiHome: home, onFailure: (error) => failures.push(error) });
  return { home, path, relay, records, failures, evidence };
}

function stdout(evidence: ExperimentKimiEvidence, calls: Entry[], outputs: string[]): void {
  evidence.accept({ role: "assistant", tool_calls: calls.flatMap((c) => kimiAssistantCall(c.id, c.name, c.input).tool_calls) });
  calls.forEach((c, i) => evidence.accept({ role: "tool", tool_call_id: c.id, content: outputs[i] }));
  evidence.accept(kimiResumeHint());
}

test.each(["normal", "reversed", "duplicate", "mutated"])("Kimi assigns identical pending calls FIFO and verifies each result once: %s", async (mode) => {
  const calls = [call("call-1"), call("call-2")], outputs = ["first", "second"];
  const delivered = mode === "reversed" ? [...outputs].reverse() : mode === "duplicate" ? ["first", "first"] : mode === "mutated" ? ["changed", "second"] : outputs;
  const f = fixture(entries(calls, delivered), calls, outputs);
  try {
    const ids = await Promise.all(f.relay.calls.map((c) => f.evidence.resolveCallId(c)));
    expect(ids).toEqual(["call-1", "call-2"]);
    f.relay.calls.forEach((c, i) => { c.call_id = ids[i]; });
    expect(f.records.filter((r) => r.kind === "tool_call_identified")).toMatchObject([
      { call_id: "call-1", correlation: "fifo" }, { call_id: "call-2", correlation: "fifo" },
    ]);
    stdout(f.evidence, calls, delivered);
    if (mode === "duplicate" || mode === "mutated") expect(() => f.evidence.finish()).toThrow(expect.objectContaining({ code: Code.ResultChanged }));
    else f.evidence.finish();
    expect(f.records.filter((r) => r.kind === "result_comparison").map((r) => r.equal)).toEqual(
      mode === "duplicate" ? [true, false] : mode === "mutated" ? [false, true] : [true, true]);
  } finally { f.evidence.stop(); }
});

test("Kimi labels an unambiguous native call exact", async () => {
  const calls = [call("call-1")], f = fixture(entries(calls, ["answer"]));
  try {
    expect(await f.evidence.resolveCallId(f.relay.calls[0]!)).toBe("call-1");
    expect(f.records.find((r) => r.kind === "tool_call_identified")).toMatchObject({ correlation: "exact" });
  } finally { f.evidence.stop(); }
});

test("Kimi preserves relay arrival order if identical calls resolve in reverse order", async () => {
  const calls = [call("call-1"), call("call-2")], f = fixture(entries(calls, ["first", "second"]), calls, ["first", "second"]);
  try {
    expect(await f.evidence.resolveCallId(f.relay.calls[1]!)).toBe("call-2");
    expect(await f.evidence.resolveCallId(f.relay.calls[0]!)).toBe("call-1");
  } finally { f.evidence.stop(); }
});

test("Kimi keeps an earlier exact call isolated when a later identical call uses FIFO", async () => {
  const calls = [call("call-1"), call("call-2")], outputs = ["first", "second"], delivered = ["second", "first"];
  const lines = entries(calls, delivered), f = fixture(lines.slice(0, 2), calls.slice(0, 1), outputs);
  try {
    f.relay.calls[0]!.result = undefined;
    f.relay.calls[0]!.call_id = await f.evidence.resolveCallId(f.relay.calls[0]!);
    f.relay.calls.push({ relay_index: 1, name: "lookup", input: {} });
    writeFileSync(f.path, encode(lines));
    f.relay.calls[1]!.call_id = await f.evidence.resolveCallId(f.relay.calls[1]!);
    f.relay.calls.forEach((c, i) => { c.result = { content: [{ type: "text", text: outputs[i] }] }; });
    expect(f.records.filter((r) => r.kind === "tool_call_identified")).toMatchObject([
      { call_id: "call-1", correlation: "exact" }, { call_id: "call-2", correlation: "fifo" },
    ]);
    expect(f.relay.calls.map((c) => c.correlation)).toEqual(["exact", "fifo"]);
    stdout(f.evidence, calls, delivered);
    expect(() => f.evidence.finish()).toThrow(expect.objectContaining({ code: Code.ResultChanged }));
    expect(f.records.filter((r) => r.kind === "result_comparison")).toMatchObject([
      { equal: false }, { equal: false, server_relay_index: 1 },
    ]);
    expect(f.records.find((r) => r.kind === "result_comparison")).not.toHaveProperty("server_relay_index");
  } finally { f.evidence.stop(); }
});

test.each(["weather", "mcp__other__weather"])("Kimi records its own missing-tool error and completes: %s", (name) => {
  const calls = [call("missing-1", name, { city: "Paris" })], output = `Tool "${name}" not found`;
  const f = fixture(entries(calls, [output], true), []);
  try {
    stdout(f.evidence, calls, [output]);
    f.evidence.finish();
    expect(f.failures).toEqual([]);
    expect(f.records.filter((r) => r.kind === "model_tool_error")).toEqual([
      { kind: "model_tool_error", call_id: "missing-1", name, input: { city: "Paris" }, harness_output: output },
    ]);
    expect(f.records.filter((r) => r.kind === "result_comparison")).toEqual([]);
  } finally { f.evidence.stop(); }
});

test.each(["success", "wrong-error", "missing-result", "changed-stdout", "changed-model"])(
  "Kimi requires its matched own unknown-tool error: %s", (mode) => {
    const calls = [call("missing-1", "weather")], output = 'Tool "weather" not found';
    const lines = entries(calls, [mode === "wrong-error" ? 'Tool "other" not found' : output], mode !== "success");
    if (mode === "missing-result") lines.splice(-2, 2);
    if (mode === "changed-model") lines.at(-1)!.message.message.content[0].text = "changed";
    const f = fixture(lines, []);
    try {
      stdout(f.evidence, calls, [mode === "changed-stdout" ? "changed" : output]);
      expect(() => f.evidence.finish()).toThrow(expect.objectContaining({
        code: mode.startsWith("changed-") ? Code.ResultChanged : Code.UnknownTool,
      }));
    } finally { f.evidence.stop(); }
  });

test.each(["Bash", "Read", "Agent", "select_tools", "EnterPlanMode", "ExitPlanMode", "TodoList", "NotifyUser", "Skill",
  "AgentSwarm", "CronCreate", "CronList", "CronDelete", "CreateGoal", "GetGoal", "SetGoalBudget", "UpdateGoal",
  "TowerInit", "TowerPlan", "TowerSpawn", "TowerMerge", "TowerRebase", "TowerTeardown", "TowerComplete", "TowerSend",
  "TowerInbox", "TowerFinding", "TowerReview", "TowerMission", "TowerStatus"])("Kimi built-in %s still fails closed with a missing-tool error", (name) => {
  const calls = [call("builtin-1", name)], output = `Tool "${name}" not found`;
  const f = fixture(entries(calls, [output], true), []);
  try { expect(() => f.evidence.finish()).toThrow(expect.objectContaining({ code: Code.UnknownTool })); }
  finally { f.evidence.stop(); }
});

test.each(["result", "step"])("Kimi reports the tool timeout before missing evidence: %s", (where) => {
  const lines = entries([call("call-1")], ["answer"]);
  if (where === "result") lines.splice(2, lines.length - 2, loop({ type: "tool.result", parentUuid: "uuid-call-1", toolCallId: "call-1",
    result: { output: `Tool "${NAME}" failed: MCP error -32001: Request timed out`, isError: true, durationMs: 7200000 } }));
  else lines.splice(2, lines.length - 2, loop({ type: "step.end", uuid: "step-1", finishReason: "error",
    error: { code: -32001, message: "Request timed out", data: { timeout: 123 } } }));
  const f = fixture(lines);
  try { expect(() => f.evidence.finish()).toThrow(expect.objectContaining({ code: Code.ServerError,
    message: `kimi tool call timed out after ${where === "result" ? 7200000 : 123} ms` })); }
  finally { f.evidence.stop(); }
});

test("Kimi preserves server error content containing request timeout text", () => {
  const calls = [call("call-1")], output = "Request timed out", f = fixture(entries(calls, [output], true), calls, [output]);
  f.relay.calls[0]!.result!.isError = true;
  try { stdout(f.evidence, calls, [output]); f.evidence.finish(); }
  finally { f.evidence.stop(); }
});

test("Kimi preserves opaque server errors that resemble its own timeout wrapper", () => {
  const calls = [call("call-1")], output = `Tool "${NAME}" failed: this log says Request timed out yesterday`;
  const f = fixture(entries(calls, [output], true), calls, [output], true);
  try { stdout(f.evidence, calls, [output]); f.evidence.finish(); }
  finally { f.evidence.stop(); }
});

test("Kimi refuses notes added to its own unknown-tool error", () => {
  const calls = [call("missing-1", "weather")], output = 'Tool "weather" not found';
  const lines = entries(calls, [output], true);
  lines.find((line) => line.event?.type === "tool.result")!.event.result.note = "INJECTED EXTRA MODEL CONTENT";
  const f = fixture(lines, []);
  try {
    stdout(f.evidence, calls, [output]);
    expect(() => f.evidence.finish()).toThrow(expect.objectContaining({ code: Code.ResultChanged }));
  } finally { f.evidence.stop(); }
});

test("Kimi keeps provider retry timeouts separate from MCP tool timeouts", () => {
  const part = { type: "text", text: "finished" }, f = fixture([
    { type: "llm.tools_snapshot", tools: [{ name: NAME, description: "", parameters: {} }] },
    loop({ type: "step.end", uuid: "retry-1", finishReason: "error", error: { message: "Request timed out" } }),
    loop({ type: "content.part", stepUuid: "step-2", part }), loop({ type: "step.end", uuid: "step-2", usage: USAGE }),
    { type: "agent.message.appended", message: { message: { role: "assistant", content: [part], toolCalls: [] }, meta: { usage: USAGE } } },
  ], []);
  try { f.evidence.accept({ role: "assistant", content: "finished" }); f.evidence.finish(); }
  finally { f.evidence.stop(); }
});

test("Kimi run_end counts one model-tool error without a relay dispatch", async () => {
  const calls = [call("missing-1", "weather")], output = 'Tool "weather" not found';
  const lines = entries(calls, [output], true), f = fixture(lines, []);
  f.evidence.stop();
  writeFileSync(f.path, "");
  const start = spyOn(ExperimentServer.prototype, "start").mockImplementation(() => {});
  const request = spyOn(ExperimentServer.prototype, "request").mockImplementation(async (message) =>
    ({ jsonrpc: "2.0", id: message.id, result: { tools: [TOOL] } }));
  const run = new ExperimentKimiRun({ ...f.relay.spec, command: "unused", args: [], env: [], recording: join(f.home, "records") },
    f.home, f.home, join(f.home, "agent.md"), {});
  try {
    await run.prepare();
    const response = await fetch(run.relay.url, { method: "POST", headers: { Authorization: `Bearer ${run.relay.token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    await response.text();
    writeFileSync(f.path, encode(lines));
    run.push(encode([{ role: "assistant", tool_calls: kimiAssistantCall(calls[0]!.id, calls[0]!.name, {}).tool_calls },
      { role: "tool", tool_call_id: "missing-1", content: output }, kimiResumeHint()]));
    await run.complete();
    await run.close();
    const records = readFileSync(run.recordingPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(records.at(-1)).toMatchObject({ kind: "run_end", code: null, model_tool_errors: 1, tool_calls: 0 });
  } finally { start.mockRestore(); request.mockRestore(); await run.close().catch(() => {}); }
});

test.each(["complete", "terminateProtocol", "server-eof", "server-exit"])("Kimi %s preserves a late wire timeout ahead of incomplete relay results", async (operation) => {
  const f = fixture([]);
  f.evidence.stop();
  writeFileSync(f.path, "");
  const start = spyOn(ExperimentServer.prototype, "start").mockImplementation(() => {});
  const request = spyOn(ExperimentServer.prototype, "request").mockImplementation(async (message) =>
    ({ jsonrpc: "2.0", id: message.id, result: { tools: [TOOL] } }));
  const run = new ExperimentKimiRun({ ...f.relay.spec, command: "unused", args: [], env: [], tool_timeout_seconds: 123,
    recording: join(f.home, "records") }, f.home, f.home, join(f.home, "agent.md"), {});
  try {
    await run.prepare();
    const response = await fetch(run.relay.url, { method: "POST", headers: { Authorization: `Bearer ${run.relay.token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    await response.text();
    run.relay.calls.push({ relay_index: 0, call_id: "call-1", name: "lookup", input: {} });
    const lines = entries([call("call-1")], ["answer"]);
    lines.splice(2, lines.length - 2, loop({ type: "tool.result", parentUuid: "uuid-call-1", toolCallId: "call-1",
      result: { output: `Tool "${NAME}" failed: MCP error -32001: Request timed out`, isError: true } }));
    writeFileSync(f.path, encode(lines));
    if (operation === "terminateProtocol") run.terminateProtocol();
    if (operation === "server-eof" || operation === "server-exit") run.relay.fail(new ExperimentFailure(Code.ServerError,
      operation === "server-eof" ? "experiment MCP stdout closed before run completion" : "experiment MCP server exited before termination"));
    await expect(run.complete()).rejects.toMatchObject({ code: Code.ServerError, message: "kimi tool call timed out after 123000 ms" });
    const records = readFileSync(run.recordingPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(records.filter((r) => r.kind === "failure")).toMatchObject([
      { code: Code.ServerError, message: "kimi tool call timed out after 123000 ms" },
    ]);
  } finally { start.mockRestore(); request.mockRestore(); await run.close().catch(() => {}); }
});
