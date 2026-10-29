import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { ExperimentKimiEvidence } from "../src/experiment-kimi.js";
import { ExperimentKimiRun } from "../src/experiment-kimi-run.js";
import { ExperimentFailureCode as Code } from "../src/experiment-records.js";
import { KIMI_STREAM_SESSION as SESSION, kimiAssistantCall, kimiResumeHint as hint } from "./fixtures/kimi-stream.js";

const NAME = "mcp__experiment__lookup";
const INPUT = { query: "hello" };
const USAGE = { inputOther: 1, output: 1, inputCacheRead: 0, inputCacheCreation: 0 };
const TOOL_RESULT = { role: "tool", tool_call_id: "call-1", content: "answer" };

function fixture() {
  const parent = resolve("scratch/session-14c66a93/exp/kimi-task-q");
  mkdirSync(parent, { recursive: true });
  const home = mkdtempSync(join(parent, "case-"));
  const path = join(home, "sessions", "workspace", SESSION, "agents/main/wire.jsonl");
  mkdirSync(dirname(path), { recursive: true });
  const loop = (event: object) => ({ type: "context.append_loop_event", event, time: 1000 });
  writeFileSync(path, [
    { type: "llm.tools_snapshot", tools: [{ name: NAME, description: "test", parameters: {} }] },
    loop({ type: "tool.call", uuid: "tool-1", stepUuid: "step-1", toolCallId: "call-1", name: NAME, args: INPUT }),
    loop({ type: "tool.result", parentUuid: "tool-1", toolCallId: "call-1", result: { output: "answer", durationMs: 123 } }),
    loop({ type: "step.end", uuid: "step-1", usage: USAGE }),
    { type: "agent.message.appended", message: { message: { role: "assistant", content: [],
      toolCalls: [{ type: "function", id: "call-1", name: NAME, arguments: JSON.stringify(INPUT) }] }, meta: { usage: USAGE } } },
    { type: "agent.message.appended", message: { message: { role: "tool", toolCallId: "call-1", content: [{ type: "text", text: "answer" }] } } },
    loop({ type: "content.part", stepUuid: "step-2", part: { type: "text", text: "answer" } }),
    loop({ type: "step.end", uuid: "step-2", usage: USAGE }),
    { type: "agent.message.appended", message: { message: { role: "assistant", content: [{ type: "text", text: "answer" }],
      toolCalls: [] }, meta: { usage: USAGE } } },
  ].map((event) => JSON.stringify(event)).join("\n") + "\n");
  const records: Record<string, unknown>[] = [];
  const evidence = new ExperimentKimiEvidence({ spec: { name: "experiment", accept_harness_prefix: ["kimi-wall-time"] },
    toolNames: new Set(["lookup"]), toolDefinitions: [{ name: "lookup", description: "test", inputSchema: {} }],
    calls: [{ relay_index: 0, name: "lookup", input: INPUT, result: { content: [{ type: "text", text: "answer" }] } }],
    record(kind, fields) { records.push({ kind, ...fields }); } }, { kimiHome: home });
  evidence.accept(kimiAssistantCall("call-1", NAME, INPUT));
  evidence.accept(TOOL_RESULT);
  return { evidence, home, records };
}

test("Kimi accepts informational frames before one terminal resume hint", () => {
  const { evidence, records } = fixture();
  try {
    evidence.accept({ role: "meta", type: "retrying", content: "retry" });
    evidence.accept({ role: "assistant", content: "answer" });
    evidence.accept(hint());
    evidence.finish();
    expect(records.filter((entry) => entry.kind === "result_comparison")).toEqual([
      expect.objectContaining({ equal: true }),
    ]);
  } finally { evidence.stop(); }
});

const trailingFrames = [
  { label: "identical resume hint", frame: hint() },
  { label: "different resume hint", frame: hint("session_87654321-4321-4321-4321-cba987654321") },
  { label: "assistant text", frame: { role: "assistant", content: "second answer" } },
  { label: "assistant tool call", frame: kimiAssistantCall("call-2", NAME, INPUT) },
  { label: "tool result", frame: { ...TOOL_RESULT, tool_call_id: "call-2" } },
  { label: "informational meta", frame: { role: "meta", type: "retrying", content: "retry" } },
  { label: "unknown frame", frame: { type: "future-event" } },
  { label: "malformed resume hint", frame: { ...hint(), command: "wrong" } },
];
test.each(trailingFrames)("Kimi rejects $label after the terminal resume hint", ({ frame }) => {
  const { evidence, records } = fixture();
  try {
    evidence.accept(hint());
    expect(() => evidence.accept(frame)).toThrow(expect.objectContaining({
      code: Code.Protocol, message: expect.stringContaining("terminal session.resume_hint"),
    }));
    expect(records.filter((entry) => entry.kind === "harness_tool_result")).toHaveLength(1);
  } finally { evidence.stop(); }
});

const nonFrames = [null, [], "text", 7, false].map((frame) => ({ frame, label: JSON.stringify(frame) }));
test.each(nonFrames)("Kimi rejects non-object stdout frames before a hint: $label", ({ frame }) => {
  const { evidence } = fixture();
  try { expect(() => evidence.accept(frame)).toThrow(expect.objectContaining({ code: Code.Protocol })); }
  finally { evidence.stop(); }
});
test.each(nonFrames)("Kimi rejects non-object stdout frames after a hint: $label", ({ frame }) => {
  const { evidence } = fixture();
  try {
    evidence.accept(hint());
    expect(() => evidence.accept(frame)).toThrow(expect.objectContaining({ code: Code.Protocol }));
  } finally { evidence.stop(); }
});

test("Kimi keeps blank-line handling and malformed-JSON rejection after the terminal hint", async () => {
  const { evidence, home } = fixture();
  const sink = new ExperimentKimiRun({ name: "experiment", command: process.execPath, args: [], env: [],
    recording: join(home, "records"), accept_harness_prefix: ["kimi-wall-time"] }, home, home, join(home, "agent.md"), {});
  const malformed = "{broken\n";
  try {
    sink.push(JSON.stringify(hint()) + "\n");
    expect(() => sink.push("\n \t\n")).not.toThrow();
    expect(() => sink.push(malformed)).toThrow(SyntaxError);
    const records = readFileSync(sink.recordingPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    const captured = records.filter((entry) => entry.kind === "harness_stdout")
      .map((entry) => Buffer.from(entry.bytes_base64, "base64").toString());
    expect(captured.at(-1)).toBe(malformed);
  } finally { evidence.stop(); await sink.close().catch(() => {}); }
});
