import { expect, test } from "bun:test";
import { KimiWireParser } from "../src/experiment-kimi-parser.js";
import { ExperimentFailureCode as Code } from "../src/experiment-records.js";

type Entry = Record<string, any>;
const USAGE = { inputOther: 10, output: 2, inputCacheRead: 3, inputCacheCreation: 1 };
const NORMALIZED_USAGE = { input: 10, output: 2, cache_read: 3, cache_write: 1 };
const QUALIFIED = "mcp__experiment__lookup";
const toolCall = (id = "call-1") => ({ type: "tool.call", stepUuid: "step-1", uuid: `tool-${id}`,
  toolCallId: id, name: QUALIFIED, args: { query: id } });
const stepEnd = (usage: unknown = USAGE) => ({ type: "step.end", uuid: "step-1", messageId: "provider-1", usage });
const contentPart = { type: "content.part", stepUuid: "step-1", part: { type: "text", text: "answer" } };

function fixture() {
  const records: Entry[] = [];
  const parser = new KimiWireParser("experiment", () => new Set(["lookup"]),
    (kind, fields) => records.push({ kind, ...fields }), () => [{ name: "lookup", description: "test", inputSchema: {} }]);
  parser.accept({ type: "llm.tools_snapshot", tools: [{ name: QUALIFIED, description: "test", parameters: {} }] });
  const accept = (event: Entry, time: number) => parser.accept({ type: "context.append_loop_event", event, time });
  const assistant = (content: Entry[] = [], calls = ["call-1"], usage: unknown = USAGE) => parser.accept({
    type: "agent.message.appended", message: { message: { role: "assistant", content,
      toolCalls: calls.map((id) => ({ type: "function", id, name: QUALIFIED, arguments: JSON.stringify({ query: id }) })) },
    meta: { messageId: "provider-1", usage } },
  });
  const byKind = (kind: string) => records.filter((record) => record.kind === kind);
  return { parser, accept, assistant, byKind };
}

test("Kimi records a turn on its first call and records every call before usage exists", () => {
  const f = fixture();
  f.accept(toolCall(), 1000);
  expect(f.byKind("turn")).toEqual([{ kind: "turn", message_id: "step-1", t: 1, usage: null,
    tool_calls: [{ call_id: "call-1", name: "lookup" }] }]);
  f.accept(toolCall("call-2"), 1100);
  expect(f.byKind("turn")).toHaveLength(1);
  expect(f.byKind("turn_call")).toEqual([
    { kind: "turn_call", message_id: "step-1", call_id: "call-1", name: "lookup", t: 1 },
    { kind: "turn_call", message_id: "step-1", call_id: "call-2", name: "lookup", t: 1.1 },
  ]);
  expect(f.byKind("turn_usage")).toEqual([]);
  f.accept(stepEnd(), 1200);
  f.assistant([], ["call-1", "call-2"]);
  f.parser.finish();
  expect(f.byKind("turn_usage")).toEqual([{ kind: "turn_usage", message_id: "step-1", usage: NORMALIZED_USAGE, t: 1.2 }]);
});

test("Kimi confirms a content-first turn on a later call and preserves its first-content time", () => {
  const f = fixture();
  f.accept(contentPart, 1000);
  expect(f.byKind("turn")).toEqual([]);
  f.accept(toolCall(), 1100);
  expect(f.byKind("turn")).toEqual([{ kind: "turn", message_id: "step-1", t: 1, usage: null,
    tool_calls: [{ call_id: "call-1", name: "lookup" }] }]);
  f.accept(stepEnd(), 1200);
  f.assistant([contentPart.part]);
  f.parser.finish();
  expect(f.byKind("turn")).toHaveLength(1);
  expect(f.byKind("turn_call")).toEqual([{ kind: "turn_call", message_id: "step-1", call_id: "call-1", name: "lookup", t: 1.1 }]);
  expect(f.byKind("turn_usage")).toEqual([{ kind: "turn_usage", message_id: "step-1", usage: NORMALIZED_USAGE, t: 1.2 }]);
});

test("Kimi waits to emit an early usage record until its first step item emits the turn", () => {
  const f = fixture();
  f.accept(stepEnd(), 1000);
  expect(f.byKind("turn")).toEqual([]);
  expect(f.byKind("turn_usage")).toEqual([]);
  f.accept(contentPart, 1100);
  f.assistant([contentPart.part], []);
  f.parser.finish();
  expect(f.byKind("turn")).toEqual([{ kind: "turn", message_id: "step-1", t: 1.1, usage: NORMALIZED_USAGE, tool_calls: [] }]);
  expect(f.byKind("turn_usage")).toEqual([{ kind: "turn_usage", message_id: "step-1", usage: NORMALIZED_USAGE, t: 1 }]);
});

test.each(["missing-end", "missing-usage", "duplicate-usage"])("Kimi requires exactly one usage record per turn: %s", (mode) => {
  const f = fixture();
  f.accept(contentPart, 1000);
  const verify = () => {
    if (mode !== "missing-end") f.accept(stepEnd(mode === "missing-usage" ? null : USAGE), 1100);
    f.assistant([contentPart.part], [], mode === "missing-usage" ? null : USAGE);
    if (mode === "duplicate-usage") f.accept(stepEnd(), 1200);
    f.parser.finish();
  };
  expect(verify).toThrow(expect.objectContaining({ code: Code.HarnessLogMissing }));
  expect(f.byKind("turn_usage")).toHaveLength(mode === "duplicate-usage" ? 1 : 0);
});

test("Kimi refuses a content.part after a finalized step.end (round 331)", () => {
  // A step that already carried content when its end arrived is finalized:
  // a later part would mutate what the final assistant-message comparison
  // checks, and a message matching the mutation passed as a valid order.
  const f = fixture();
  f.accept(contentPart, 1000);
  f.accept(stepEnd(), 1100);
  expect(() => f.accept({ type: "content.part", stepUuid: "step-1", part: { type: "text", text: "late" } }, 1200))
    .toThrow(expect.objectContaining({ code: Code.Protocol, message: expect.stringContaining("step.end") }));
});

test("Kimi still flushes every late part of the early-usage shape", () => {
  // The pinned early-usage order (usage before the step's first content)
  // can flush several parts after the end; all of them belong to the turn.
  const f = fixture();
  f.accept(stepEnd(), 1000);
  f.accept(contentPart, 1100);
  f.accept({ type: "content.part", stepUuid: "step-1", part: { type: "text", text: " more" } }, 1150);
  f.assistant([{ type: "text", text: "answer" }, { type: "text", text: " more" }], []);
  f.parser.finish();
  expect(f.byKind("turn")).toHaveLength(1);
  expect(f.byKind("turn_usage")).toHaveLength(1);
});

test("Kimi refuses invalid time on the first call before native ID resolution", () => {
  const f = fixture();
  expect(() => f.accept(toolCall(), NaN)).toThrow(expect.objectContaining({ code: Code.Protocol }));
  expect(f.byKind("turn")).toEqual([]);
});

// The hold probe of 2026-11-02 (scratch recording 23a82a67): the model wrote a
// 14 KB argument string it never terminated; Kimi recorded `args: {}`,
// answered its own "Invalid args" error, and dispatched nothing. The run's
// final check then failed the whole run on the unparseable native arguments.
test("Kimi's own rejection of unparseable arguments is accepted and recorded", () => {
  const f = fixture();
  const output = `Invalid args for tool "${QUALIFIED}": must have required property 'query'`;
  f.accept({ ...toolCall(), args: {} }, 1000);
  f.accept({ type: "tool.result", parentUuid: "tool-call-1", toolCallId: "call-1", result: { output, isError: true, durationMs: 0 } }, 1050);
  f.accept(stepEnd(), 1200);
  f.parser.accept({ type: "agent.message.appended", message: { message: { role: "assistant", content: [],
    toolCalls: [{ type: "function", id: "call-1", name: QUALIFIED, arguments: '{"query":"AAAA' }] },
    meta: { messageId: "provider-1", usage: USAGE } } });
  f.parser.finish();
  expect(f.byKind("harness_invalid_args")).toEqual([{ kind: "harness_invalid_args", call_id: "call-1", name: QUALIFIED, output }]);
  expect(f.byKind("native_arguments_malformed")).toEqual([
    { kind: "native_arguments_malformed", call_id: "call-1", name: QUALIFIED, bytes: 14, parse_error: expect.any(String) },
  ]);
});

test("unparseable native arguments on a call Kimi ran are still a protocol mismatch", () => {
  const f = fixture();
  f.accept(toolCall(), 1000);
  f.accept({ type: "tool.result", parentUuid: "tool-call-1", toolCallId: "call-1", result: { output: "answer", durationMs: 5 } }, 1050);
  f.accept(stepEnd(), 1200);
  f.parser.accept({ type: "agent.message.appended", message: { message: { role: "assistant", content: [],
    toolCalls: [{ type: "function", id: "call-1", name: QUALIFIED, arguments: '{"query":"AAAA' }] },
    meta: { messageId: "provider-1", usage: USAGE } } });
  let thrown: unknown;
  try { f.parser.finish(); } catch (error) { thrown = error; }
  expect((thrown as { code?: string }).code).toBe(Code.Protocol);
  expect(String((thrown as Error).message)).toContain("does not match tool.call evidence");
});

test("an assistant message without meta.usage is the step mismatch, not an invalid-usage failure (round 361, item 3)", () => {
  // The old `messageUsage ?? normalizedUsage(meta?.usage)` fallback could
  // never produce a value: when messageUsage is undefined, meta.usage is
  // absent, and normalizedUsage throws "Invalid Kimi usage inputOther" —
  // so a completed step whose agent.message.appended entry lacks
  // meta.usage reported the misattributed usage diagnostic instead of the
  // intended comparison verdict.
  const f = fixture();
  f.accept(toolCall(), 1000);
  f.accept({ type: "tool.result", parentUuid: "tool-call-1", toolCallId: "call-1", result: { output: "answer", durationMs: 5 } }, 1050);
  f.accept(stepEnd(), 1200);
  f.parser.accept({ type: "agent.message.appended", message: { message: { role: "assistant", content: [],
    toolCalls: [{ type: "function", id: "call-1", name: QUALIFIED, arguments: JSON.stringify({ query: "call-1" }) }] },
    meta: { messageId: "provider-1" } } });
  let thrown: unknown;
  try { f.parser.finish(); } catch (error) { thrown = error; }
  expect((thrown as { code?: string }).code).toBe(Code.Protocol);
  expect(String((thrown as Error).message)).toContain("does not match its loop step content, usage, or calls");
  expect(String((thrown as Error).message)).not.toContain("Invalid Kimi usage");
});

test("Kimi Code 2.5.0's usage without a cache-read count is a zero, and other gaps still fail", () => {
  // Live gate, 2026-11-06: the 2.5.0 wire carried
  // {"inputOther":2027,"output":114,"inputCacheCreation":0} and the
  // experiment failed with "Invalid Kimi usage inputCacheRead". Kimi's own
  // schema marks the field optional and its own total counts it as zero.
  const f = fixture();
  f.accept(toolCall(), 1000);
  f.accept(stepEnd({ inputOther: 2027, output: 114, inputCacheCreation: 0 }), 1200);
  expect(f.byKind("turn_usage")).toEqual([{ kind: "turn_usage", message_id: "step-1",
    usage: { input: 2027, output: 114, cache_read: 0, cache_write: 0 }, t: 1.2 }]);
  // Present but unusable is still a protocol failure, and the three
  // required counts stay required.
  for (const usage of [
    { inputOther: 1, output: 1, inputCacheRead: null, inputCacheCreation: 0 },
    { inputOther: 1, output: 1, inputCacheRead: -1, inputCacheCreation: 0 },
    { inputOther: 1, output: 1 },
    { output: 1, inputCacheCreation: 0 },
  ]) {
    const g = fixture();
    g.accept(toolCall(), 1000);
    expect(() => g.accept(stepEnd(usage), 1200)).toThrow(expect.objectContaining({ code: Code.Protocol }));
  }
});
