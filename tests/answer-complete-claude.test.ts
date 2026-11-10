/** Lane AN1, claude family (claude and zai run the same binary): a run's
 * answer is every assistant message after the prompt, not only the final
 * one. The fixtures follow Claude Code 2.1.317's stream-json frames
 * (src/claude-stream-answer.ts). */
import { describe, expect, test } from "bun:test";
import { ClaudeAdapter } from "../src/adapters/claude.js";
import { ZaiAdapter } from "../src/adapters/zai.js";
import { assembleAnswer, AnswerCollector, truncationLine } from "../src/answer-complete.js";
import { ClaudeStreamFold, claudeStreamAnswer } from "../src/claude-stream-answer.js";
import type { RunRequest, RunResult } from "../src/types.js";

const assistant = (id: string, content: unknown[], extra: Record<string, unknown> = {}) =>
  JSON.stringify({ type: "assistant", message: { id, role: "assistant", content, stop_reason: null, ...extra },
    parent_tool_use_id: null, session_id: "s" });
const toolUse = (id: string, call: string, input: unknown = { path: "a" }) =>
  assistant(id, [{ type: "tool_use", id: call, name: "Read", input }]);
const toolResult = (call: string, content: string) =>
  JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: call, content }] },
    parent_tool_use_id: null, session_id: "s" });
const resultFrame = (result: string, extra: Record<string, unknown> = {}) => JSON.stringify({
  type: "result", subtype: "success", is_error: false, result, stop_reason: "end_turn", session_id: "s",
  usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  modelUsage: { "claude-opus-5": {} }, total_cost_usd: 0.01, ...extra,
});

/** text, tool call, text, tool call, empty final message. */
function textToolTextToolEmpty(): string[] {
  return [
    JSON.stringify({ type: "system", subtype: "init", tools: ["Read"], session_id: "s" }),
    assistant("m1", [{ type: "text", text: "First part." }]),
    toolUse("m1", "t1"),
    toolResult("t1", "file one"),
    assistant("m2", [{ type: "text", text: "Second part." }]),
    toolUse("m2", "t2"),
    toolResult("t2", "file two"),
    assistant("m3", [{ type: "text", text: "" }], { stop_reason: "end_turn" }),
    resultFrame(""),
  ];
}

function folded(lines: string[], chunk = 7): string {
  const fold = new ClaudeStreamFold();
  const wire = lines.map((line) => `${line}\n`).join("");
  for (let index = 0; index < wire.length; index += chunk) fold.push(wire.slice(index, index + chunk));
  return fold.finish();
}

const done = (stdout: string): RunResult => ({ stdout, stderr: "", exitCode: 0, success: true });

describe("assembleAnswer", () => {
  test("joins non-empty messages with one blank line and keeps a single message verbatim", () => {
    expect(assembleAnswer(["a\n", "", "  ", "\nb", "c\n"])).toBe("a\n\nb\n\nc\n");
    expect(assembleAnswer(["only\n"])).toBe("only\n");
    expect(assembleAnswer(["", ""])).toBe("");
  });

  test("a user turn restarts the answer; a length stop marks the last message", () => {
    const collector = new AnswerCollector();
    collector.message("earlier exchange");
    collector.userTurn();
    collector.text("de", "k");
    collector.text("lta", "k");
    collector.close();
    collector.message("end", "max_tokens");
    expect(collector.transcript()).toEqual({ messages: ["delta", "end"], truncated: true });
    collector.message("after", "end_turn");
    expect(collector.transcript().truncated).toBe(false);
  });
});

describe("claude family: the complete answer", () => {
  for (const [name, adapter] of [["claude", new ClaudeAdapter()], ["zai", new ZaiAdapter({ ZAI_API_KEY: "k" })]] as const) {
    test(`${name}: plain run prints every message though the final one is empty`, () => {
      const request: RunRequest = { agent: name, prompt: "p" };
      const out = adapter.processRunResult(done(folded(textToolTextToolEmpty())), request, {});
      expect(out.success).toBe(true);
      expect(out.stdout).toBe("First part.\n\nSecond part.\n");
      expect(out.usage?.input_tokens).toBe(10);
    });

    test(`${name}: --result-json carries the answer and keeps the final message apart`, () => {
      const lines = textToolTextToolEmpty();
      lines.splice(-2, 2, assistant("m3", [{ type: "text", text: "Closing line." }]), resultFrame("Closing line."));
      const request: RunRequest = { agent: name, prompt: "p", resultJson: true };
      const out = adapter.processRunResult(done(folded(lines)), request, {});
      const envelope = JSON.parse(out.stdout);
      expect(out.success).toBe(true);
      expect(envelope.result).toBe("First part.\n\nSecond part.\n\nClosing line.");
      expect(envelope.codemux.final_message).toBe("Closing line.");
      expect(envelope.codemux.truncated).toBe(false);
      expect(envelope.modelUsage).toEqual({ "claude-opus-5": {} });
    });
  }

  test("the zai report of 2026-11-10: findings written before later tool calls are kept", () => {
    // The checklist and findings 1 to 19 come before two more tool calls;
    // the final message starts mid-list at finding 20. The json format's
    // `result` was that tail alone.
    const head = ["## Checklist", "- [x] read the brief", "", ...Array.from({ length: 19 }, (_, i) => `${i + 1}. Finding ${i + 1}.`)].join("\n");
    const tail = "20. Finding 20, the last one.\n\nVerdict: revise.";
    const lines = [
      assistant("a1", [{ type: "text", text: "I will read the evidence first." }]),
      toolUse("a1", "c1"), toolResult("c1", "x".repeat(4096)),
      assistant("a2", [{ type: "text", text: head }]),
      toolUse("a2", "c2"), toolResult("c2", "y"),
      toolUse("a3", "c3"), toolResult("c3", "z"),
      assistant("a4", [{ type: "text", text: tail }], { stop_reason: "end_turn" }),
      resultFrame(tail),
    ];
    const zai = new ZaiAdapter({ ZAI_API_KEY: "k" });
    const plain = zai.processRunResult(done(folded(lines)), { agent: "zai", prompt: "p" }, {});
    expect(plain.stdout.startsWith("I will read the evidence first.\n\n## Checklist")).toBe(true);
    expect(plain.stdout).toContain("1. Finding 1.\n");
    expect(plain.stdout).toContain("19. Finding 19.\n\n20. Finding 20");
    expect(plain.stdout.endsWith("Verdict: revise.\n")).toBe(true);
    const json = JSON.parse(zai.processRunResult(done(folded(lines)), { agent: "zai", prompt: "p", resultJson: true }, {}).stdout);
    expect(json.result).toBe(plain.stdout.slice(0, -1));
    expect(json.codemux.final_message).toBe(tail);
  });

  test("a max-tokens stop sets codemux.truncated and prints one stderr line", () => {
    const lines = [assistant("m1", [{ type: "text", text: "Cut off mid" }], { stop_reason: "max_tokens" }),
      resultFrame("Cut off mid", { stop_reason: "max_tokens" })];
    const adapter = new ClaudeAdapter();
    const json = adapter.processRunResult(done(folded(lines)), { agent: "claude", prompt: "p", resultJson: true }, {});
    expect(JSON.parse(json.stdout).codemux.truncated).toBe(true);
    expect(json.stderr).toBe(`${truncationLine("claude")}\n`);
    const plain = adapter.processRunResult(done(folded(lines)), { agent: "claude", prompt: "p" }, {});
    expect(plain.stdout).toBe("Cut off mid\n");
    expect(plain.stderr).toBe(`${truncationLine("claude")}\n`);
  });

  test("subagent and hook messages are not the agent's answer", () => {
    const lines = [
      assistant("m1", [{ type: "text", text: "Mine." }]),
      JSON.stringify({ type: "assistant", message: { id: "sub", content: [{ type: "text", text: "Subagent text." }] }, parent_tool_use_id: "t9" }),
      JSON.stringify({ type: "assistant", message: { id: "hook", content: [{ type: "text", text: "Hook text." }] }, parent_tool_use_id: null, is_meta: true }),
      resultFrame("Mine."),
    ];
    expect(claudeStreamAnswer(lines.join("\n")).transcript.messages).toEqual(["Mine."]);
  });

  test("the fold sheds tool results and tool inputs, even past the pending-line bound", () => {
    const huge = "q".repeat(3 * 1024 * 1024);
    const lines = [assistant("m1", [{ type: "text", text: "Before." }]), toolUse("m1", "t1", { content: huge }),
      toolResult("t1", huge), assistant("m2", [{ type: "text", text: "After." }]), resultFrame("After.")];
    const fold = new ClaudeStreamFold();
    for (const line of lines) fold.push(`${line}\n`);
    const kept = fold.finish();
    expect(Buffer.byteLength(kept)).toBeLessThan(4096);
    expect(fold.keptBytes()).toBeLessThan(4096);
    expect(claudeStreamAnswer(kept).transcript.messages).toEqual(["Before.", "After."]);
  });

  test("a bare json result object still parses: the answer falls back to its result", () => {
    const out = new ClaudeAdapter().processRunResult(done(resultFrame("OK")), { agent: "claude", prompt: "p", resultJson: true }, {});
    const envelope = JSON.parse(out.stdout);
    expect(envelope.result).toBe("OK");
    expect(envelope.codemux.final_message).toBe("OK");
  });

  test("a stream cut before its result object fails the plain run with nothing on stdout", () => {
    const out = new ClaudeAdapter().processRunResult(done(folded([assistant("m1", [{ type: "text", text: "partial" }])])),
      { agent: "claude", prompt: "p" }, {});
    expect(out.success).toBe(false);
    expect(out.stdout).toBe("");
  });

  test("ordinary runs read stream-json through the fold; experiment runs keep the bridge", () => {
    const adapter = new ClaudeAdapter();
    expect(adapter.buildRunCommand({ agent: "claude", prompt: "p" })).toContain("stream-json");
    expect(adapter.prepareRun({ agent: "claude", prompt: "p" }).stdoutSink).toBeInstanceOf(ClaudeStreamFold);
  });
});
