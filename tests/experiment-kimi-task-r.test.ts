import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { ExperimentKimiEvidence } from "../src/experiment-kimi.js";
import { KimiWireParser } from "../src/experiment-kimi-parser.js";
import { ExperimentFailureCode as Code } from "../src/experiment-records.js";
import { KIMI_STREAM_SESSION, kimiAssistantCall, kimiResumeHint } from "./fixtures/kimi-stream.js";

type Entry = Record<string, any>;
const NAME = "mcp__experiment__lookup";
const TOOL = { name: "lookup", description: "test", inputSchema: {} };
const USAGE = { inputOther: 10, output: 2, inputCacheRead: 3, inputCacheCreation: 1 };
const SNAPSHOT = { type: "llm.tools_snapshot", tools: [{ name: NAME, description: TOOL.description, parameters: {} }] };
const INPUT = { query: "hello" };
const loop = (event: Entry, time = 1000) => ({ type: "context.append_loop_event", event, time });
const text = (value: string) => ({ type: "text", text: value });

function step(id: string, parts: Entry[], call = false): Entry[] {
  return [
    ...parts.map((part) => loop({ type: "content.part", stepUuid: id, part })),
    ...(call ? [loop({ type: "tool.call", stepUuid: id, uuid: "tool-1", toolCallId: "call-1", name: NAME, args: INPUT }),
      loop({ type: "tool.result", parentUuid: "tool-1", toolCallId: "call-1", result: { output: "tool answer", durationMs: 1 } })] : []),
    loop({ type: "step.end", uuid: id, messageId: `provider-${id}`, usage: USAGE }, 1100),
    { type: "agent.message.appended", message: { message: { role: "assistant", content: parts,
      toolCalls: call ? [{ type: "function", id: "call-1", name: NAME, arguments: JSON.stringify(INPUT) }] : [] },
    meta: { usage: USAGE, messageId: `provider-${id}` } } },
    ...(call ? [{ type: "agent.message.appended", message: { message: { role: "tool", toolCallId: "call-1", content: [text("tool answer")] } } }] : []),
  ];
}

function evidenceFixture(steps: Entry[], call = false) {
  const parent = resolve("scratch/session-14c66a93/exp/kimi-task-r");
  mkdirSync(parent, { recursive: true });
  const home = mkdtempSync(join(parent, "case-"));
  const path = join(home, "sessions/workspace", KIMI_STREAM_SESSION, "agents/main/wire.jsonl");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, [SNAPSHOT, ...steps].map((line) => JSON.stringify(line)).join("\n") + "\n");
  const records: Entry[] = [];
  const evidence = new ExperimentKimiEvidence({ spec: { name: "experiment", accept_harness_prefix: ["kimi-wall-time"] },
    toolNames: new Set([TOOL.name]), toolDefinitions: [TOOL],
    calls: call ? [{ relay_index: 0, name: TOOL.name, input: INPUT, result: { content: [text("tool answer")] } }] : [],
    record(kind, fields) { records.push({ kind, ...fields }); } }, { kimiHome: home });
  return { evidence, records };
}

test.each([
  ["altered", [{ role: "assistant", content: "different answer" }]],
  ["truncated", [{ role: "assistant", content: "fin" }]],
  ["missing", []],
  ["duplicated", [{ role: "assistant", content: "finished" }, { role: "assistant", content: "finished" }]],
  ["whitespace changed", [{ role: "assistant", content: "finished\n" }]],
])("Kimi rejects %s stdout assistant text against its wire step", (_label, frames) => {
  const { evidence } = evidenceFixture(step("step-1", [text("finished")]));
  try {
    for (const frame of frames) evidence.accept(frame);
    evidence.accept(kimiResumeHint());
    expect(() => evidence.finish()).toThrow(expect.objectContaining({ code: Code.Protocol }));
  } finally { evidence.stop(); }
});

test("Kimi rejects text moved between steps even when the combined reply matches", () => {
  const { evidence } = evidenceFixture([...step("step-1", [text("first")]), ...step("step-2", [text("second")])]);
  try {
    evidence.accept({ role: "assistant", content: "firstsecond" });
    evidence.accept(kimiResumeHint());
    expect(() => evidence.finish()).toThrow(expect.objectContaining({ code: Code.Protocol }));
  } finally { evidence.stop(); }
});

test.each([false, true])("Kimi associates assistant text with its own step's tool calls: swapped=%s", (swapped) => {
  const { evidence } = evidenceFixture([...step("step-1", [text("before")], true), ...step("step-2", [text("after")])], true);
  try {
    evidence.accept({ ...kimiAssistantCall("call-1", NAME, INPUT), content: swapped ? "after" : "before" });
    evidence.accept({ role: "tool", tool_call_id: "call-1", content: "tool answer" });
    evidence.accept({ role: "assistant", content: swapped ? "before" : "after" });
    evidence.accept(kimiResumeHint());
    if (swapped) expect(() => evidence.finish()).toThrow(expect.objectContaining({ code: Code.Protocol }));
    else expect(() => evidence.finish()).not.toThrow();
  } finally { evidence.stop(); }
});

test("Kimi matches concatenated text parts without including reasoning or changing whitespace", () => {
  const { evidence } = evidenceFixture(step("step-1", [text(" first\n"), { type: "think", think: "private reasoning" }, text("second \t")]));
  try {
    evidence.accept({ role: "assistant", content: " first\nsecond \t" });
    evidence.accept(kimiResumeHint());
    expect(() => evidence.finish()).not.toThrow();
  } finally { evidence.stop(); }
});

test.each(["content-first", "end-first", "failed-retry"])("Kimi rejects a tool.call after step.end: %s", (order) => {
  const records: Entry[] = [];
  const parser = new KimiWireParser("experiment", () => new Set([TOOL.name]),
    (kind, fields) => records.push({ kind, ...fields }), () => [TOOL]);
  parser.accept(SNAPSHOT);
  if (order === "content-first") parser.accept(loop({ type: "content.part", stepUuid: "step-1", part: text("answer") }));
  parser.accept(loop({ type: "step.end", uuid: "step-1", messageId: "provider-1",
    ...(order === "failed-retry" ? { finishReason: "error" } : { usage: USAGE }) }, 1100));
  expect(() => parser.accept(loop({ type: "tool.call", stepUuid: "step-1", uuid: "tool-1", toolCallId: "call-1", name: NAME, args: INPUT }, 1200)))
    .toThrow(expect.objectContaining({ code: Code.Protocol }));
  expect(parser.calls).toEqual([]);
  expect(records.filter((record) => record.kind === "turn_call")).toEqual([]);
  expect(records.filter((record) => record.kind === "turn_usage")).toHaveLength(order === "content-first" ? 1 : 0);
});
