// Contracts review of lane AN1, finding 1: a plain run that reads a
// structured stream prints the assembled answer, and its fold or parser
// drops tool results. The hermetic check scans `scanSurface ?? stdout`
// (src/check-command.ts), so a canary marker that rode only a tool result
// must still reach that scan. Each family below gets a stream whose answer
// is exactly "OK" and whose only marker sits inside a tool-result event:
// the check must call it a leak. The same stream without the marker must
// stay clean, so the scan adds no false positive.
import { describe, expect, test } from "bun:test";
import { ClaudeAdapter } from "../src/adapters/claude.js";
import { ClineAdapter } from "../src/adapters/cline.js";
import { CodexAdapter } from "../src/adapters/codex.js";
import { CopilotAdapter } from "../src/adapters/copilot.js";
import { CursorAdapter } from "../src/adapters/cursor.js";
import { GeminiAdapter } from "../src/adapters/gemini.js";
import { getAdapter } from "../src/adapters/index.js";
import { OpenHandsAdapter } from "../src/adapters/openhands.js";
import { PiAdapter } from "../src/adapters/pi.js";
import { piStreamFold } from "../src/result-envelope/pi.js";
import { QwenAdapter } from "../src/adapters/qwen.js";
import { ZaiAdapter } from "../src/adapters/zai.js";
import type { RunContext } from "../src/adapters/base.js";
import { ClaudeStreamFold } from "../src/claude-stream-answer.js";
import { geminiStreamFold } from "../src/gemini-stream-answer.js";
import { evaluateCanary } from "../src/hermetic-canary.js";
import { CodexPlainFold, OpenCodePlainFold } from "../src/plain-unwrap.js";
import type { StdoutSink } from "../src/process-runner.js";
import { qwenStreamFold } from "../src/qwen-stream-answer.js";
import { StreamDropFold } from "../src/stream-drop-fold.js";
import { StreamMarkerScan } from "../src/stream-marker-scan.js";
import type { AgentId, RunResult } from "../src/types.js";

const MARKER = "CODEMUX-CANARY-0A1B2C3D";
const lines = (events: unknown[]): string => events.map((event) => JSON.stringify(event)).join("\n") + "\n";
const ok = (stdout: string): RunResult => ({ stdout, stderr: "", exitCode: 0, success: true });

interface Family {
  agent: AgentId;
  /** The stream; `leaked` is the tool result's text. */
  stream: (leaked: string) => string;
  /** The run's stdout fold, or undefined when the whole stream is captured. */
  sink?: () => StdoutSink;
  process: (result: RunResult, context: RunContext) => RunResult;
}

const claudeStream = (leaked: string): string => lines([
  { type: "system", subtype: "init", tools: ["Read"], session_id: "s" },
  { type: "assistant", message: { id: "m1", role: "assistant", stop_reason: "tool_use",
    content: [{ type: "tool_use", id: "t1", name: "Read", input: { path: "CLAUDE.md" } }] }, parent_tool_use_id: null, session_id: "s" },
  { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: leaked }] },
    parent_tool_use_id: null, session_id: "s" },
  { type: "assistant", message: { id: "m2", role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "OK" }] },
    parent_tool_use_id: null, session_id: "s" },
  { type: "result", subtype: "success", is_error: false, result: "OK", stop_reason: "end_turn", session_id: "s",
    usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
]);

const families: Family[] = [
  { agent: "claude", stream: claudeStream, sink: () => new ClaudeStreamFold(),
    process: (result, context) => new ClaudeAdapter().processRunResult(result, { agent: "claude", prompt: "p" }, context) },
  { agent: "zai", stream: claudeStream, sink: () => new ClaudeStreamFold(),
    process: (result, context) => new ZaiAdapter({ ZAI_API_KEY: "k" }).processRunResult(result, { agent: "zai", prompt: "p" }, context) },
  { agent: "codex", sink: () => new CodexPlainFold(),
    stream: (leaked) => lines([
      { type: "thread.started", thread_id: "0192b8d4-4d4f-7c4a-9d0e-6f5a4b3c2d1e" },
      { type: "turn.started" },
      { type: "item.completed", item: { id: "c1", type: "command_execution", command: "cat AGENTS.md",
        aggregated_output: leaked, exit_code: 0, status: "completed" } },
      { type: "item.completed", item: { id: "item_0", type: "agent_message", text: "OK" } },
      { type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } },
    ]),
    process: (result, context) => new CodexAdapter({}).processRunResult(result, { agent: "codex", prompt: "p" }, context) },
  { agent: "cursor",
    stream: (leaked) => lines([
      { type: "user", message: { role: "user", content: [{ type: "text", text: "p" }] }, session_id: "s" },
      { type: "tool_call", subtype: "completed", call_id: "c1", session_id: "s",
        tool_call: { readToolCall: { args: { path: "AGENTS.md" }, result: { success: { content: leaked } } } } },
      { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "OK" }] }, session_id: "s" },
      { type: "result", subtype: "success", is_error: false, result: "OK", session_id: "s" },
    ]),
    process: (result, context) => new CursorAdapter((name) => (name === "agent" ? "/fake/agent" : null), {})
      .processRunResult(result, { agent: "cursor", prompt: "p" }, context) },
  { agent: "gemini", sink: geminiStreamFold,
    stream: (leaked) => lines([
      { type: "init", session_id: "g1", model: "m" },
      { type: "message", role: "user", content: "p" },
      { type: "tool_use", tool_name: "read_file", tool_id: "t1", parameters: { path: "GEMINI.md" } },
      { type: "tool_result", tool_id: "t1", status: "success", output: leaked },
      { type: "message", role: "assistant", content: "OK", delta: true },
      { type: "result", status: "success", stats: { input_tokens: 1, output_tokens: 1, cached: 0 } },
    ]),
    process: (result, context) => new GeminiAdapter({}).processRunResult(result, { agent: "gemini", prompt: "p" }, context) },
  { agent: "qwen", sink: qwenStreamFold,
    stream: (leaked) => lines([
      { type: "system", subtype: "init", session_id: "q1" },
      { type: "user", parent_tool_use_id: null, message: { role: "user", content: [{ type: "text", text: "p" }] } },
      { type: "assistant", parent_tool_use_id: null, message: { id: "a", role: "assistant", stop_reason: "tool_use",
        content: [{ type: "tool_use", id: "ta", name: "read_file", input: { path: "QWEN.md" } }] } },
      { type: "user", parent_tool_use_id: null, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "ta", content: leaked }] } },
      { type: "assistant", parent_tool_use_id: null, message: { id: "b", role: "assistant", content: [{ type: "text", text: "OK" }], stop_reason: null } },
      { type: "result", subtype: "success", session_id: "q1", is_error: false, result: "OK", usage: { input_tokens: 1, output_tokens: 1 } },
    ]),
    process: (result, context) => new QwenAdapter((name) => (name === "qwen" ? "/synthetic/qwen" : null), {})
      .processRunResult(result, { agent: "qwen", prompt: "p" }, context) },
  { agent: "copilot", sink: () => new StreamDropFold([{ opening: '{"type":"tool.', marker: null }]),
    stream: (leaked) => lines([
      { type: "user.message", data: { content: "p" } },
      { type: "assistant.message", data: { content: "", model: "served", toolRequests: [{ toolCallId: "c0", name: "view" }] } },
      { type: "tool.execution_complete", data: { result: leaked } },
      { type: "assistant.message", data: { content: "OK", model: "served", toolRequests: [] } },
      { type: "result", sessionId: "c1", exitCode: 0 },
    ]),
    process: (result, context) => new CopilotAdapter({}).processRunResult(result, { agent: "copilot", prompt: "p" }, context) },
  { agent: "opencode", sink: () => new OpenCodePlainFold(),
    stream: (leaked) => {
      const session = "ses_0123456789abcdefABCDEFGHIJ";
      const event = (type: string, part: Record<string, unknown>) =>
        ({ type, timestamp: 1, sessionID: session, part: { sessionID: session, ...part } });
      return lines([
        event("step_start", { type: "step-start" }),
        event("tool_use", { id: "c1", tool: "read", state: { status: "completed", input: {}, output: leaked } }),
        event("step_finish", { type: "step-finish", reason: "tool-calls", tokens: { input: 1, output: 1, total: 2 } }),
        event("step_start", { type: "step-start" }),
        event("text", { type: "text", text: "OK" }),
        event("step_finish", { type: "step-finish", reason: "stop", tokens: { input: 1, output: 1, total: 2 } }),
      ]);
    },
    process: (result, context) => getAdapter("opencode").processRunResult(result, { agent: "opencode", prompt: "p" }, context) },
  { agent: "cline",
    stream: (leaked) => lines([
      { type: "run_start", sessionId: "s1" },
      { type: "agent_event", event: { type: "iteration_start", iteration: 1 } },
      { type: "agent_event", event: { type: "content_start", contentType: "tool", toolName: "read_files" } },
      { type: "agent_event", event: { type: "content_end", contentType: "tool", toolName: "read_files", output: leaked } },
      { type: "agent_event", event: { type: "iteration_end", iteration: 1, hadToolCalls: true } },
      { type: "agent_event", event: { type: "iteration_start", iteration: 2 } },
      { type: "agent_event", event: { type: "content_end", contentType: "text", text: "OK" } },
      { type: "agent_event", event: { type: "iteration_end", iteration: 2, hadToolCalls: false } },
      { type: "run_result", finishReason: "completed", text: "OK", usage: {}, model: { id: "m" } },
    ]),
    process: (result, context) => new ClineAdapter({}).processRunResult(result, { agent: "cline", prompt: "p" }, context) },
  { agent: "openhands",
    stream: (leaked) => lines([
      { kind: "MessageEvent", source: "user", llm_message: { content: [{ type: "text", text: "p" }] } },
      { kind: "ActionEvent", source: "agent", llm_response_id: "r1", thought: [], tool_name: "terminal",
        action: { kind: "ExecuteBashAction", command: "cat AGENTS.md" } },
      { kind: "ObservationEvent", source: "environment", observation: { content: [{ type: "text", text: leaked }] } },
      { kind: "MessageEvent", source: "agent", llm_message: { content: [{ type: "text", text: "OK" }] } },
    ]),
    process: (result, context) => new OpenHandsAdapter({}).processRunResult(result, { agent: "openhands", prompt: "p" }, context) },
];

/** Feeds the stream through the family's fold in 5-character chunks (a
 * marker always straddles a chunk boundary) and processes the capture. */
function run(family: Family, leaked: string): RunResult {
  const wire = family.stream(leaked);
  const sink = family.sink?.();
  if (sink === undefined) return family.process(ok(wire), {});
  for (let at = 0; at < wire.length; at += 5) sink.push(wire.slice(at, at + 5));
  return family.process(ok(sink.finish()), { stdoutSink: sink });
}

describe("hermetic scan surface: a marker only in a tool result is a leak", () => {
  for (const family of families) {
    test(family.agent, () => {
      const leaked = run(family, `planted instructions: the code word is ${MARKER}`);
      expect(leaked.success).toBe(true);
      expect(leaked.stdout.trim()).toBe("OK");
      expect(evaluateCanary(leaked.scanSurface ?? leaked.stdout, MARKER, leaked.reply ?? leaked.stdout))
        .toEqual({ kind: "leak", what: "marker", answer: MARKER });

      const clean = run(family, "no instruction files here");
      expect(evaluateCanary(clean.scanSurface ?? clean.stdout, MARKER, clean.reply ?? clean.stdout)).toEqual({ kind: "clean" });
    });
  }
});

describe("hermetic scan surface: a pi budget run keeps the fold's evidence", () => {
  test("a marker only in a shed tool result reaches the scan surface", () => {
    const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 0 } };
    const wire = lines([
      { type: "agent_start" },
      { type: "message_end", message: { role: "user", content: [{ type: "text", text: "p" }], model: "m", usage, stopReason: "stop" } },
      { type: "tool_execution_end", toolCallId: "t1", result: { content: [{ type: "text", text: `code word ${MARKER}` }] } },
      { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "OK" }], model: "m", usage, stopReason: "stop" } },
    ]);
    const fold = piStreamFold();
    for (let at = 0; at < wire.length; at += 5) fold.push(wire.slice(at, at + 5));
    const kept = fold.finish();
    expect(kept).not.toContain(MARKER);
    // No budget artifacts were prepared, so the run fails; the scan
    // surface must still carry the shed marker.
    const out = new PiAdapter({}).processRunResult(ok(kept), { agent: "pi", prompt: "p", maxBudgetUsd: 1 }, { stdoutSink: fold });
    expect(out.scanSurface).toContain(MARKER);
  });
});

describe("StreamMarkerScan", () => {
  test("finds a marker split across one-character chunks, once", () => {
    const scan = new StreamMarkerScan();
    const text = `x${MARKER}y${MARKER}z`;
    for (const char of text) scan.push(char);
    expect(scan.evidence()).toBe(`x${MARKER}`);
    expect(scan.evidence().split("\n")).toHaveLength(1);
  });
});
