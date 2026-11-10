import { describe, expect, test } from "bun:test";
import { CursorAdapter } from "../src/adapters/cursor.js";
import { GeminiAdapter } from "../src/adapters/gemini.js";
import { cursorResult } from "../src/result-envelope/cursor.js";
import { geminiStreamResult } from "../src/result-envelope/gemini.js";
import { qwenPlainResult, qwenResult } from "../src/result-envelope/qwen.js";
import { copilotPlainResult, copilotResult } from "../src/result-envelope/copilot.js";
import { geminiStreamFold } from "../src/gemini-stream-answer.js";
import { qwenStreamFold } from "../src/qwen-stream-answer.js";
import { StreamDropFold } from "../src/stream-drop-fold.js";
import { truncationLine } from "../src/answer-complete.js";
import type { RunRequest, RunResult } from "../src/types.js";

// Lane AN1 (run.answer-complete) for cursor, gemini, qwen, and copilot:
// each stream carries text, a tool call, text, a tool call, and an empty
// final message. The answer is both texts, a blank line between them; the
// last (empty) message alone is codemux.final_message.

const wire = (...events: unknown[]): string => events.map((event) => JSON.stringify(event)).join("\n") + "\n";
const ok = (stdout: string): RunResult => ({ stdout, stderr: "", exitCode: 0, success: true });
const FULL = "Findings 1 to 19.\n\nFinding 20.";

describe("cursor", () => {
  const say = (text: string): unknown => ({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] }, session_id: "s" });
  const tool = (id: string): unknown => ({ type: "tool_call", subtype: "started", call_id: id, session_id: "s" });
  const stream = wire(
    { type: "user", message: { role: "user", content: [{ type: "text", text: "p" }] }, session_id: "s" },
    say("Findings "), say("1 to 19."), tool("c1"), say("Finding 20."), tool("c2"),
    { type: "result", subtype: "success", is_error: false, result: "Findings 1 to 19.Finding 20.", session_id: "s" },
  );
  const adapter = new CursorAdapter((name) => (name === "agent" ? "/fake/agent" : null), {});

  test("a plain run prints every segment, split at tool calls", () => {
    expect(adapter.processRunResult(ok(stream), { agent: "cursor", prompt: "p" }).stdout).toBe(`${FULL}\n`);
  });

  test("--result-json carries the full answer; final_message is the last segment", () => {
    const envelope = JSON.parse(cursorResult(ok(stream), { agent: "cursor", prompt: "p", resultJson: true }).stdout);
    expect(envelope.result).toBe(FULL);
    expect(envelope.codemux.final_message).toBe("");
    expect(envelope.codemux.truncated).toBe(false);
  });

  test("text before the prompt echo is not the answer", () => {
    const echoed = wire(say("stale"), { type: "user", message: { role: "user", content: [] } }, say("fresh"),
      { type: "result", subtype: "success", is_error: false, result: "stalefresh" });
    expect(JSON.parse(cursorResult(ok(echoed), { agent: "cursor", prompt: "p", resultJson: true }).stdout).result).toBe("fresh");
  });
});

describe("gemini", () => {
  const say = (content: string): unknown => ({ type: "message", role: "assistant", content, delta: true });
  const events = [
    { type: "init", session_id: "g1", model: "m" },
    { type: "message", role: "user", content: "p" },
    say("Findings "), say("1 to 19."),
    { type: "tool_use", tool_name: "read", tool_id: "t1", parameters: {} },
    { type: "tool_result", tool_id: "t1", status: "success", output: "file bytes" },
    say("Finding 20."),
    { type: "tool_use", tool_name: "read", tool_id: "t2", parameters: {} },
    { type: "tool_result", tool_id: "t2", status: "success", output: "more bytes" },
    { type: "result", status: "success", stats: { input_tokens: 5, output_tokens: 2, cached: 0 } },
  ];
  const request: RunRequest = { agent: "gemini", prompt: "p" };

  test("every run launches on stream-json", () => {
    const adapter = new GeminiAdapter({});
    expect(adapter.buildRunCommand(request)).toContain("stream-json");
  });

  test("a plain run prints every message; usage is recorded", () => {
    const result = geminiStreamResult(ok(wire(...events)), request);
    expect(result.stdout).toBe(`${FULL}\n`);
    expect(result.success).toBe(true);
    expect(result.usage?.output_tokens).toBe(2);
  });

  test("--result-json splits the answer from the final message", () => {
    const envelope = JSON.parse(geminiStreamResult(ok(wire(...events)), { ...request, resultJson: true }).stdout);
    expect(envelope.response).toBe(FULL);
    expect(envelope.session_id).toBe("g1");
    expect(envelope.codemux.final_message).toBe("");
    expect(envelope.codemux.truncated).toBe(false);
  });

  test("a MAX_TOKENS stop sets truncated and prints one stderr line", () => {
    const stopped = wire(...events.slice(0, -1),
      { type: "error", severity: "error", message: "Model response was truncated because it exceeded the token limit. Try using /compress to free up context space." },
      { type: "result", status: "success", stats: {} });
    const result = geminiStreamResult(ok(stopped), { ...request, resultJson: true });
    expect(JSON.parse(result.stdout).codemux.truncated).toBe(true);
    expect(result.stderr.split(truncationLine("gemini")).length).toBe(2);
  });

  test("the fold drops tool results and keeps tool calls as boundaries", () => {
    const fold = geminiStreamFold();
    const text = wire(...events);
    for (let i = 0; i < text.length; i += 7) fold.push(text.slice(i, i + 7));
    const kept = fold.finish();
    expect(kept).not.toContain("file bytes");
    expect(geminiStreamResult(ok(kept), request).stdout).toBe(`${FULL}\n`);
  });
});

describe("qwen", () => {
  const say = (id: string, text: string): unknown => ({ type: "assistant", parent_tool_use_id: null,
    message: { id, role: "assistant", content: [{ type: "text", text }], stop_reason: null } });
  const call = (id: string): unknown => ({ type: "assistant", parent_tool_use_id: null,
    message: { id, role: "assistant", content: [{ type: "tool_use", id: `t${id}`, name: "read", input: {} }], stop_reason: "tool_use" } });
  const toolResult = (id: string): unknown => ({ type: "user", parent_tool_use_id: null,
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: `t${id}`, content: "file bytes" }] } });
  const events = [
    { type: "system", subtype: "init", session_id: "q1" },
    { type: "user", parent_tool_use_id: null, message: { role: "user", content: [{ type: "text", text: "p" }] } },
    say("a", "Findings 1 to 19."), call("b"), toolResult("b"),
    say("c", "Finding 20."), call("d"), toolResult("d"),
    { type: "assistant", parent_tool_use_id: "tsub", message: { id: "sub", role: "assistant", content: [{ type: "text", text: "subagent" }] } },
    { type: "assistant", parent_tool_use_id: null, message: { id: "e", role: "assistant", content: [], stop_reason: null } },
    { type: "result", subtype: "success", session_id: "q1", is_error: false, result: "", usage: { input_tokens: 4, output_tokens: 2 } },
  ];

  test("a plain run prints every main-agent message", () => {
    expect(qwenPlainResult(ok(wire(...events))).stdout).toBe(`${FULL}\n`);
  });

  test("--result-json carries the full answer; final_message is qwen's own result", () => {
    const result = qwenResult(ok(wire(...events)), { agent: "qwen", prompt: "p", resultJson: true });
    expect(result.success).toBe(true);
    const envelope = JSON.parse(result.stdout);
    expect(envelope.result).toBe(FULL);
    expect(envelope.codemux.final_message).toBe("");
    expect(envelope.codemux.truncated).toBe(false);
  });

  test("the json format's single array line is read the same way", () => {
    expect(qwenPlainResult(ok(`${JSON.stringify(events)}\n`)).stdout).toBe(`${FULL}\n`);
  });

  test("the fold sheds user lines and tool-call inputs", () => {
    const fold = qwenStreamFold();
    const text = wire(...events);
    for (let i = 0; i < text.length; i += 11) fold.push(text.slice(i, i + 11));
    const kept = fold.finish();
    expect(kept).not.toContain("file bytes");
    expect(kept).not.toContain('"name":"read"');
    expect(qwenPlainResult(ok(kept)).stdout).toBe(`${FULL}\n`);
  });
});

describe("copilot", () => {
  const message = (content: string, tools = 0): unknown => ({ type: "assistant.message",
    data: { content, model: "served", toolRequests: Array.from({ length: tools }, (_, i) => ({ toolCallId: `c${i}`, name: "bash" })) } });
  const events = [
    { type: "user.message", data: { content: "p" } },
    message("Findings 1 to 19.", 1),
    { type: "tool.execution_complete", data: { result: "file bytes" } },
    message("Finding 20.", 1),
    { type: "tool.execution_complete", data: { result: "more bytes" } },
    { type: "assistant.message", agentId: "sub", data: { content: "subagent" } },
    message(""),
    { type: "result", sessionId: "c1", exitCode: 0 },
  ];

  test("a plain run prints every main-agent message", () => {
    expect(copilotPlainResult(ok(wire(...events))).stdout).toBe(`${FULL}\n`);
  });

  test("--result-json carries the full answer; final_message is the last message", () => {
    const usage = { input_tokens: 1, output_tokens: 1, cached_input_tokens: 0, total_tokens: 2, cost_usd: null };
    const result = copilotResult(ok(wire(...events)), { agent: "copilot", prompt: "p", resultJson: true }, { usage });
    expect(result.success).toBe(true);
    const envelope = JSON.parse(result.stdout);
    expect(envelope.content).toBe(FULL);
    expect(envelope.codemux.final_message).toBe("");
    expect(envelope.codemux.truncated).toBe(false);
  });

  test("the plain fold sheds tool events", () => {
    const fold = new StreamDropFold([{ opening: '{"type":"tool.', marker: null }]);
    const text = wire(...events);
    for (let i = 0; i < text.length; i += 5) fold.push(text.slice(i, i + 5));
    const kept = fold.finish();
    expect(kept).not.toContain("file bytes");
    expect(copilotPlainResult(ok(kept)).stdout).toBe(`${FULL}\n`);
  });
});
