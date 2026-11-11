import { expect, test } from "bun:test";
import { parseAgyResultEnvelope } from "../src/result-envelope/agy.js";
import { parseClaudeResultEnvelope } from "../src/result-envelope/claude.js";
import { parseClineResultEnvelope } from "../src/result-envelope/cline.js";
import { parseCodexEventStream } from "../src/result-envelope/codex-stream.js";
import { parseCopilotResultEnvelope } from "../src/result-envelope/copilot.js";
import { parseCursorResultEnvelope } from "../src/result-envelope/cursor.js";
import { parseDroidResultEnvelope } from "../src/result-envelope/droid.js";
import { parseGeminiResultEnvelope } from "../src/result-envelope/gemini.js";
import { parseGooseResultEnvelope } from "../src/result-envelope/goose.js";
import { parseOpenhandsResultEnvelope } from "../src/result-envelope/openhands.js";
import { parsePiResultEnvelope } from "../src/result-envelope/pi.js";
import { parseQwenResultEnvelope } from "../src/result-envelope/qwen.js";
import { parseAiderAnalytics } from "../src/result-envelope/aider.js";
import { kimiPlainResult } from "../src/result-envelope/kimi.js";
import { opencodeResult } from "../src/result-envelope/opencode.js";
import { openCodeResultData } from "../src/plain-unwrap/opencode.js";

type Frame = Record<string, unknown>;
const parsers: [string, (text: string) => unknown, Frame[]][] = [
  ["agy", parseAgyResultEnvelope, [{ status: "SUCCESS", response: "answer", error: { message: "error" }, usage: { input_tokens: 2 } }]],
  ["claude/zai", parseClaudeResultEnvelope, [{ type: "result", result: "answer", is_error: false, usage: { input_tokens: 2 }, modelUsage: { model: {} } }]],
  ["cline", parseClineResultEnvelope, [{ type: "agent_event", event: { type: "content_end", contentType: "text", text: "answer" } },
    { type: "run_result", text: "answer", aggregateUsage: { inputTokens: 2 }, usage: { inputTokens: 2 } }]],
  ["codex", parseCodexEventStream, [{ type: "thread.started", thread_id: "thread" }, { type: "turn.started" },
    { type: "item.completed", item: { type: "agent_message", text: "answer" } }, { type: "turn.completed", usage: { input_tokens: 2 } }]],
  ["copilot", parseCopilotResultEnvelope, [{ type: "assistant.message", data: { content: "answer", model: "model" } },
    { type: "session.error", data: { message: "error" } }, { type: "result", exitCode: 0 }]],
  ["cursor", parseCursorResultEnvelope, [{ type: "assistant", message: { content: [{ type: "text", text: "answer" }] } },
    { type: "result", result: "answer", usage: { inputTokens: 2 } }]],
  ["droid", parseDroidResultEnvelope, [{ type: "completion", finalText: "answer", usage: { input_tokens: 2 } }]],
  ["gemini", parseGeminiResultEnvelope, [{ response: "answer", stats: { input_tokens: 2 }, error: { message: "error" } }]],
  ["goose", parseGooseResultEnvelope, [{ role: "assistant", content: [{ type: "text", text: "answer" }],
    metadata: { inference: { resolvedModel: "model" }, usage: { inputTokens: 2 } } }]],
  ["openhands", parseOpenhandsResultEnvelope, [{ kind: "MessageEvent", source: "agent", llm_message: { content: [{ type: "text", text: "answer" }] } },
    { kind: "ActionEvent", thought: [{ type: "text", text: "thought" }], action: { kind: "FinishAction", message: "answer" } }]],
  ["pi", parsePiResultEnvelope, [{ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "answer" }],
    usage: { input: 2, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } }, errorMessage: "error" } }]],
  ["qwen", parseQwenResultEnvelope, [{ type: "assistant", message: { content: [{ type: "text", text: "answer" }] } },
    { type: "result", result: "answer", error: { message: "error" }, usage: { input_tokens: 2 } }]],
  ["aider analytics", parseAiderAnalytics, [{ event: "message_send", properties: { prompt_tokens: 2 } }]],
  ["kimi", (stdout) => kimiPlainResult({ stdout, stderr: "", exitCode: 0, success: true }, { agent: "kimi", prompt: "p" }, "/synthetic/missing"),
    [{ role: "assistant", content: "answer" }, { role: "meta", type: "session.resume_hint", session_id: "session_11111111-2222-3333-4444-555555555555" }]],
  ["opencode", (stdout) => opencodeResult({ stdout, stderr: "", exitCode: 0, success: true }, { agent: "opencode", prompt: "p" }, openCodeResultData(stdout)),
    [{ type: "text", part: { type: "text", text: "answer" } }, { type: "step_finish", part: { reason: "stop", tokens: { input: 2, output: 1, cache: { read: 0, write: 0 } } } }]],
];

function nullVariants(value: unknown): unknown[] {
  if (value === null || typeof value !== "object") return [];
  const variants: unknown[] = [];
  for (const key of Object.keys(value)) {
    const original = (value as Frame)[key];
    for (const replacement of [null, ...nullVariants(original)]) {
      const copy = structuredClone(value) as Frame;
      copy[key] = replacement;
      variants.push(copy);
    }
  }
  return variants;
}

for (const [name, parse, frames] of parsers) {
  test(`${name} envelope handles null at every external field boundary`, () => {
    expect(() => parse("null")).not.toThrow();
    for (const variant of nullVariants(frames) as Frame[][]) {
      expect(() => parse(variant.map((frame) => JSON.stringify(frame)).join("\n"))).not.toThrow();
    }
  });
}
