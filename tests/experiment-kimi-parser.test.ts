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

test("Kimi refuses invalid time on the first call before native ID resolution", () => {
  const f = fixture();
  expect(() => f.accept(toolCall(), NaN)).toThrow(expect.objectContaining({ code: Code.Protocol }));
  expect(f.byKind("turn")).toEqual([]);
});
