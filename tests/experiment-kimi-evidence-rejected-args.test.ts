/**
 * A call Kimi rejected for unparseable arguments (round 23, edges 3): the
 * wire carries `args: {}`, the loop's tool.result is an `Invalid args for
 * tool` error, nothing was dispatched to the relay, and the model message
 * holds the raw unterminated argument string. Verification must count it
 * OUT of the relay calls while still requiring its stdout result and model
 * message, exactly like an unknown-tool error.
 */

import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { ExperimentKimiEvidence, type KimiEvidenceRelay } from "../src/experiment-kimi.js";
import { KIMI_STREAM_SESSION, kimiResumeHint } from "./fixtures/kimi-stream.js";

type Entry = Record<string, any>;
const INPUT = { query: "hello", nested: { answer: 42 } };
const RESULT = { content: [{ type: "text", text: "answer\n" }] };
const USAGE = { inputOther: 21, output: 3, inputCacheRead: 5, inputCacheCreation: 2 };
const TIME = 1793235723125;
const QUALIFIED = "mcp__experiment__lookup";
// The raw argument string Kimi could not parse: an unterminated JSON
// object, the shape the 2026-11-02 hold probe saw rejected 13 times.
const MALFORMED_ARGUMENTS = '{"query": "hello, "nested": {"answer": ';
const INVALID_ARGS_OUTPUT = `Invalid args for tool "${QUALIFIED}": arguments must be valid JSON`;

function loop(type: string, event: Entry = {}, time = TIME): Entry {
  return { type: "context.append_loop_event", agentId: "main", time, event: { type, ...event } };
}
function inventory(names = [QUALIFIED]): Entry {
  return { type: "llm.tools_snapshot", agentId: "main", tools: names.map((name) => ({ name, description: "test", parameters: {} })), time: TIME };
}
function rejectedCall(): Entry {
  return loop("tool.call", { uuid: "tool-uuid", turnId: "0", step: 1, stepUuid: "step-1", toolCallId: "call-1", name: QUALIFIED, args: {} });
}
function validCall(): Entry {
  return loop("tool.call", { uuid: "tool-2", turnId: "0", step: 1, stepUuid: "step-1", toolCallId: "call-2", name: QUALIFIED, args: INPUT });
}
function rejectedDelivered(): Entry {
  return loop("tool.result", { parentUuid: "tool-uuid", toolCallId: "call-1", result: { output: INVALID_ARGS_OUTPUT, durationMs: 25, isError: true } }, TIME + 25);
}
function validDelivered(): Entry {
  return loop("tool.result", { parentUuid: "tool-2", toolCallId: "call-2", result: { output: "answer\n", durationMs: 25 } }, TIME + 25);
}
function end(): Entry { return loop("step.end", { uuid: "step-1", usage: USAGE }, TIME + 50); }
function message(role: string, extra: Entry = {}, meta: Entry = {}): Entry {
  return { type: "agent.message.appended", time: TIME + 1000, message: { message: { role, content: [], ...extra }, meta } };
}
function rejectedAssistant(): Entry {
  // The model message carries the RAW string it could not parse.
  return message("assistant", { toolCalls: [{ type: "function", id: "call-1", name: QUALIFIED, arguments: MALFORMED_ARGUMENTS }] }, { source: "llm", usage: USAGE });
}
function rejectedModel(): Entry {
  return message("tool", { content: [{ type: "text", text: INVALID_ARGS_OUTPUT }], toolCallId: "call-1" }, { source: "tool" });
}
function fixture(lines: Entry[], calls: KimiEvidenceRelay["calls"]) {
  const parent = resolve("scratch/session-14c66a93/exp/kimi-evidence-fixtures");
  mkdirSync(parent, { recursive: true });
  const home = mkdtempSync(join(parent, "rejected-args-"));
  const path = join(home, "sessions", "workspace", KIMI_STREAM_SESSION, "agents/main/wire.jsonl");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
  const records: Entry[] = [];
  const relay: KimiEvidenceRelay = { spec: { name: "experiment", accept_harness_prefix: ["kimi-wall-time"] }, toolNames: new Set(["lookup"]),
    get toolDefinitions() { return [...this.toolNames].map((name) => ({ name, description: "test", inputSchema: {} })); },
    calls, record(kind, fields) { records.push({ kind, ...fields }); } };
  const evidence = new ExperimentKimiEvidence(relay, { kimiHome: home });
  return { relay, records, evidence };
}
const kinds = (records: Entry[], kind: string): Entry[] => records.filter((record) => record.kind === kind);

test("a rejected-args call owes no relay call but keeps its full evidence (round 23, edges 3)", async () => {
  const run = fixture(
    [inventory(), rejectedCall(), rejectedDelivered(), end(), rejectedAssistant(), rejectedModel()],
    []
  );
  try {
    // The stdout assistant tool call carries the same raw string, and the
    // stdout tool result the same error text.
    run.evidence.accept({ role: "assistant", tool_calls: [
      { type: "function", id: "call-1", function: { name: QUALIFIED, arguments: MALFORMED_ARGUMENTS } }] });
    run.evidence.accept({ role: "tool", tool_call_id: "call-1", content: INVALID_ARGS_OUTPUT });
    run.evidence.accept(kimiResumeHint());
    // Before the fix this threw harness_log_missing: the rejected call was
    // counted as a relay call that never arrived.
    run.evidence.finish();
    expect(kinds(run.records, "harness_invalid_args")).toEqual([
      { kind: "harness_invalid_args", call_id: "call-1", name: QUALIFIED, output: INVALID_ARGS_OUTPUT }]);
    expect(kinds(run.records, "native_arguments_malformed")).toHaveLength(1);
    expect(kinds(run.records, "native_arguments_malformed")[0]).toMatchObject({
      call_id: "call-1", name: QUALIFIED, parse_error: expect.any(String) });
    expect(kinds(run.records, "result_comparison")).toHaveLength(0);
  } finally { run.evidence.stop(); }
});

test("a valid call beside a rejected one still matches its relay call", async () => {
  const run = fixture(
    [inventory(), rejectedCall(), validCall(), rejectedDelivered(), validDelivered(), end(),
      message("assistant", { toolCalls: [
        { type: "function", id: "call-1", name: QUALIFIED, arguments: MALFORMED_ARGUMENTS },
        { type: "function", id: "call-2", name: QUALIFIED, arguments: JSON.stringify(INPUT) }] },
        { source: "llm", usage: USAGE }),
      rejectedModel(),
      message("tool", { content: [{ type: "text", text: "answer\n" }], toolCallId: "call-2" }, { source: "tool" })],
    [{ relay_index: 0, name: "lookup", input: INPUT, result: RESULT }]
  );
  try {
    run.evidence.accept({ role: "assistant", tool_calls: [
      { type: "function", id: "call-1", function: { name: QUALIFIED, arguments: MALFORMED_ARGUMENTS } },
      { type: "function", id: "call-2", function: { name: QUALIFIED, arguments: JSON.stringify(INPUT) } }] });
    run.evidence.accept({ role: "tool", tool_call_id: "call-1", content: INVALID_ARGS_OUTPUT });
    run.evidence.accept({ role: "tool", tool_call_id: "call-2", content: "answer\n" });
    // The rejected call must never satisfy the relay call's native ID.
    expect(await run.evidence.resolveCallId(run.relay.calls[0]!)).toBe("call-2");
    run.evidence.accept(kimiResumeHint());
    run.evidence.finish();
    expect(kinds(run.records, "result_comparison")).toEqual([
      { kind: "result_comparison", call_id: "call-2", relay_index: 0, equal: true,
        harness_prefix: "kimi-wall-time", header: "Wall time: 0.025 seconds\n" }]);
    expect(kinds(run.records, "harness_invalid_args")).toHaveLength(1);
  } finally { run.evidence.stop(); }
});

test("a rejected call's stdout string must be the assistant message's own bytes (round 24, edges 1)", async () => {
  const run = fixture(
    [inventory(), rejectedCall(), rejectedDelivered(), end(), rejectedAssistant(), rejectedModel()],
    []
  );
  try {
    run.evidence.accept({ role: "assistant", tool_calls: [
      { type: "function", id: "call-1", function: { name: QUALIFIED, arguments: '{"query": "other' } }] });
    run.evidence.accept({ role: "tool", tool_call_id: "call-1", content: INVALID_ARGS_OUTPUT });
    run.evidence.accept(kimiResumeHint());
    let thrown: unknown;
    try { run.evidence.finish(); } catch (error) { thrown = error; }
    expect(String((thrown as Error).message)).toContain("stdout assistant tool calls do not match");
  } finally { run.evidence.stop(); }
});

test("a server's own 'Invalid args' error on an empty-argument call stays a dispatched call (round 24, edges 2)", async () => {
  const serverError = { content: [{ type: "text", text: INVALID_ARGS_OUTPUT }], isError: true };
  const run = fixture(
    [inventory(), rejectedCall(), rejectedDelivered(), end(),
      message("assistant", { toolCalls: [{ type: "function", id: "call-1", name: QUALIFIED, arguments: "{}" }] }, { source: "llm", usage: USAGE }),
      rejectedModel()],
    [{ relay_index: 0, name: "lookup", input: {}, result: serverError }]
  );
  try {
    run.evidence.accept({ role: "assistant", tool_calls: [
      { type: "function", id: "call-1", function: { name: QUALIFIED, arguments: "{}" } }] });
    run.evidence.accept({ role: "tool", tool_call_id: "call-1", content: INVALID_ARGS_OUTPUT });
    expect(await run.evidence.resolveCallId(run.relay.calls[0]!)).toBe("call-1");
    run.evidence.accept(kimiResumeHint());
    run.evidence.finish();
    expect(kinds(run.records, "harness_invalid_args")).toHaveLength(0);
    expect(kinds(run.records, "result_comparison")).toHaveLength(1);
    expect(kinds(run.records, "result_comparison")[0]).toMatchObject({ call_id: "call-1", relay_index: 0, equal: true });
  } finally { run.evidence.stop(); }
});

test("a rejected call whose arguments parse (a literal {}) compares by its parsed form (round 35, contracts 1)", async () => {
  const run = fixture(
    [inventory(), rejectedCall(), rejectedDelivered(), end(),
      message("assistant", { toolCalls: [{ type: "function", id: "call-1", name: QUALIFIED, arguments: "{}" }] }, { source: "llm", usage: USAGE }),
      rejectedModel()],
    []
  );
  try {
    run.evidence.accept({ role: "assistant", tool_calls: [
      { type: "function", id: "call-1", function: { name: QUALIFIED, arguments: "{}" } }] });
    run.evidence.accept({ role: "tool", tool_call_id: "call-1", content: INVALID_ARGS_OUTPUT });
    run.evidence.accept(kimiResumeHint());
    run.evidence.finish();
    expect(kinds(run.records, "harness_invalid_args")).toHaveLength(1);
    expect(kinds(run.records, "native_arguments_malformed")).toHaveLength(0);
  } finally { run.evidence.stop(); }
});


test("a rejected call whose assistant message carries no string arguments field is a protocol failure (review round 43)", () => {
  // Before: JSON.parse(undefined) threw, the rejection made that "malformed",
  // and String(undefined) matched a stdout string "undefined".
  const run = fixture(
    [inventory(), rejectedCall(), rejectedDelivered(), end(),
      message("assistant", { toolCalls: [{ type: "function", id: "call-1", name: QUALIFIED }] }, { source: "llm", usage: USAGE }),
      rejectedModel()],
    []
  );
  try {
    run.evidence.accept({ role: "assistant", tool_calls: [
      { type: "function", id: "call-1", function: { name: QUALIFIED, arguments: "undefined" } }] });
    run.evidence.accept({ role: "tool", tool_call_id: "call-1", content: INVALID_ARGS_OUTPUT });
    run.evidence.accept(kimiResumeHint());
    expect(() => run.evidence.finish()).toThrow("carries no string arguments field");
  } finally { run.evidence.stop(); }
});
