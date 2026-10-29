import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { ExperimentKimiEvidence } from "../src/experiment-kimi.js";
import { kimiProjectedResult, kimiWithoutHeader } from "../src/experiment-kimi-content.js";
import { ExperimentFailureCode as Code } from "../src/experiment-records.js";
import { kimiResult } from "../src/result-envelope/kimi.js";
import type { RunRequest } from "../src/types.js";
import { KIMI_STREAM_SESSION as SESSION, kimiResumeHint as hint, kimiAssistantCall } from "./fixtures/kimi-stream.js";

const NAME = "mcp__experiment__lookup";
const INPUT = { query: "hello", nested: { answer: 42 } };
const USAGE = { inputOther: 1, output: 1, inputCacheRead: 0, inputCacheCreation: 0 };
const stdoutCall = (id = "call-1", input: unknown = INPUT, name = NAME) => kimiAssistantCall(id, name, input);
const stream = (events: unknown[]) => events.map((event) => JSON.stringify(event)).join("\n") + "\n";

function fixture() {
  const parent = resolve("scratch/session-14c66a93/exp/kimi-task-o");
  mkdirSync(parent, { recursive: true });
  const home = mkdtempSync(join(parent, "case-"));
  const path = join(home, "sessions", "workspace", SESSION, "agents/main/wire.jsonl");
  mkdirSync(dirname(path), { recursive: true });
  const loop = (event: object) => ({ type: "context.append_loop_event", event, time: 1000 });
  writeFileSync(path, stream([
    { type: "llm.tools_snapshot", tools: [NAME, "mcp__experiment__another"].map((name) => ({ name, description: "test", parameters: {} })) },
    loop({ type: "tool.call", uuid: "tool-1", stepUuid: "step-1", toolCallId: "call-1", name: NAME, args: INPUT }),
    loop({ type: "tool.result", parentUuid: "tool-1", toolCallId: "call-1", result: { output: "answer", durationMs: 123 } }),
    loop({ type: "step.end", uuid: "step-1", usage: USAGE }),
    { type: "agent.message.appended", message: { message: { role: "assistant", content: [],
      toolCalls: [{ type: "function", id: "call-1", name: NAME, arguments: JSON.stringify(INPUT) }] }, meta: { usage: USAGE } } },
    { type: "agent.message.appended", message: { message: { role: "tool", toolCallId: "call-1", content: [{ type: "text", text: "answer" }] } } },
  ]));
  const records: Record<string, unknown>[] = [];
  const evidence = new ExperimentKimiEvidence({ spec: { name: "experiment", accept_harness_prefix: ["kimi-wall-time"] },
    toolNames: new Set(["lookup", "another"]), toolDefinitions: ["lookup", "another"].map((name) => ({ name, description: "test", inputSchema: {} })),
    calls: [{ relay_index: 0, name: "lookup", input: INPUT, result: { content: [{ type: "text", text: "answer" }] } }],
    record(kind, fields) { records.push({ kind, ...fields }); } }, { kimiHome: home });
  return { evidence, home, path, records };
}

test.each([
  ["ID", stdoutCall("stdout-only")],
  ["arguments", stdoutCall("call-1", { query: "different" })],
  ["name", stdoutCall("call-1", INPUT, "mcp__experiment__another")],
])("Kimi rejects stdout assistant calls with contradictory %s", (_field, event) => {
  const { evidence } = fixture();
  try {
    evidence.accept(event);
    evidence.accept({ role: "tool", tool_call_id: "call-1", content: "answer" });
    expect(() => evidence.finish()).toThrow(expect.objectContaining({ code: Code.Protocol }));
  } finally { evidence.stop(); }
});

test("Kimi requires stdout assistant evidence for each wire tool call", () => {
  const { evidence } = fixture();
  try {
    evidence.accept({ role: "tool", tool_call_id: "call-1", content: "answer" });
    expect(() => evidence.finish()).toThrow(expect.objectContaining({ code: Code.Protocol }));
  } finally { evidence.stop(); }
});

test("Kimi rejects duplicate stdout assistant call IDs", () => {
  const { evidence } = fixture();
  try { evidence.accept(stdoutCall());
    expect(() => evidence.accept(stdoutCall())).toThrow(expect.objectContaining({ code: Code.Protocol })); }
  finally { evidence.stop(); }
});

test("Kimi matches parsed stdout arguments and records the exact removed text prefix", () => {
  const { evidence, records } = fixture();
  try {
    evidence.accept(stdoutCall("call-1", { nested: { answer: 42 }, query: "hello" }));
    evidence.accept({ role: "tool", tool_call_id: "call-1", content: "answer" });
    evidence.accept(hint());
    evidence.finish();
    expect(records.find((record) => record.kind === "result_comparison")).toMatchObject({ equal: true, header: "Wall time: 0.123 seconds\n" });
  } finally { evidence.stop(); }
});

const malformed = [
  { role: "tool", tool_call_id: 7, content: "answer" },
  { role: "tool", tool_call_id: "call-1", content: { text: "answer" } },
  { role: "tool", tool_call_id: "call-1" },
  { role: "meta", type: "session.resume_hint", session_id: SESSION },
  { ...hint(), command: "kimi -r elsewhere" },
  { ...hint(), content: "resume elsewhere" },
  hint("invalid"),
];
test.each(malformed)("Kimi evidence rejects malformed native frames: %j", (event) => {
  const { evidence } = fixture();
  try { expect(() => evidence.accept(event)).toThrow(expect.objectContaining({ code: Code.Protocol })); }
  finally { evidence.stop(); }
});

test.each(malformed)("Kimi normalization rejects malformed native frames before a valid hint: %j", (event) => {
  const { evidence, home } = fixture();
  const request: RunRequest = { agent: "kimi", prompt: "fixture", resultJson: true };
  try {
    const result = kimiResult({ success: true, exitCode: 0, stderr: "", stdout: stream([event, { role: "assistant", content: "answer" }, hint()]) }, request, home);
    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("stream-json line 1");
  } finally { evidence.stop(); }
});

test("Kimi normalization rejects conflicting valid resume hints", () => {
  const { evidence, home } = fixture();
  try {
    const result = kimiResult({ success: true, exitCode: 0, stderr: "", stdout: stream([
      hint(), hint("session_87654321-4321-4321-4321-cba987654321"), { role: "assistant", content: "answer" },
    ]) }, { agent: "kimi", prompt: "fixture", resultJson: true }, home);
    expect(result.success).toBe(false);
    expect(result.stderr).toContain("stream-json line 2");
  } finally { evidence.stop(); }
});

test("Kimi header metadata equals the exact removed prefix", () => {
  for (const content of [[{ type: "text", text: "answer" }], [{ type: "image_url", imageUrl: { url: "data:image/png;base64,YQ==" } }]]) {
    const projected = kimiProjectedResult(content, { durationMs: 123 });
    expect(projected.header).toBe(content[0]!.type === "text" ? "Wall time: 0.123 seconds\n" : "Wall time: 0.123 seconds");
    expect(kimiWithoutHeader(projected.content, projected.header)).toEqual(content);
  }
});
