// Lane AN1 for codex: the answer is every agent_message of the turn, in
// order, joined with a blank line; the closing message alone rides
// codemux.final_message; a max_output_tokens incomplete response sets
// codemux.truncated and prints one stderr line.
import { describe, expect, test } from "bun:test";
import { truncationLine } from "../src/answer-complete.js";
import { codexPlainStreamResult } from "../src/plain-unwrap.js";
import { codexResult } from "../src/result-envelope.js";
import type { RunRequest } from "../src/types.js";
import {
  agentMessage,
  codexFoldStream,
  finished,
  THREAD,
  turnCompleted,
  turnFailed,
  turnStarted,
  USAGE_FULL,
} from "./helpers/plain-unwrap.js";

const command = (id: string): string[] => [
  JSON.stringify({ type: "item.started", item: { id, type: "command_execution", command: "ls", status: "in_progress" } }),
  JSON.stringify({ type: "item.completed", item: { id, type: "command_execution", command: "ls", aggregated_output: "a\nb\n", exit_code: 0, status: "completed" } }),
];

// Text, tool call, text, tool call, empty final message: the zai report's
// shape (findings first, a late tool call, a short or empty close).
const TOOL_STREAM = [
  THREAD,
  turnStarted(),
  agentMessage("Checklist and findings 1 to 19."),
  ...command("c1"),
  agentMessage("\nFinding 20 after the first tool call."),
  ...command("c2"),
  agentMessage(""),
  turnCompleted(USAGE_FULL),
].join("\n") + "\n";

const FULL = "Checklist and findings 1 to 19.\n\nFinding 20 after the first tool call.";

describe("codex complete answer (run.answer-complete)", () => {
  const request: RunRequest = { agent: "codex", prompt: "p", resultJson: true };

  test("--result-json carries every message; final_message is the closing one", () => {
    const out = codexResult(finished(TOOL_STREAM), request);
    expect(out.success).toBe(true);
    const envelope = JSON.parse(out.stdout);
    expect(envelope.result).toBe(FULL);
    expect(envelope.codemux.final_message).toBe("");
    expect(envelope.codemux.truncated).toBe(false);
    expect(out.stderr).not.toContain("truncated");
  });

  test("a single-message run keeps its answer verbatim in both fields", () => {
    const stream = [THREAD, turnStarted(), agentMessage("OK\n"), turnCompleted(USAGE_FULL)].join("\n") + "\n";
    const envelope = JSON.parse(codexResult(finished(stream), request).stdout);
    expect(envelope.result).toBe("OK\n");
    expect(envelope.codemux.final_message).toBe("OK\n");
  });

  test("a plain run prints every message, through the fold and the whole-capture replay", () => {
    const whole = codexPlainStreamResult(finished(TOOL_STREAM));
    expect(whole.success).toBe(true);
    expect(whole.stdout).toBe(`${FULL}\n`);
    const fold = codexFoldStream(TOOL_STREAM, 5);
    const folded = fold.verdict(finished(fold.finish()));
    expect(folded.stdout).toBe(`${FULL}\n`);
    expect(folded.success).toBe(true);
  });

  test("the fold books every retained message against the capture bound", () => {
    const one = codexFoldStream([THREAD, turnStarted(), agentMessage("x".repeat(1000))].join("\n") + "\n");
    const two = codexFoldStream([THREAD, turnStarted(), agentMessage("x".repeat(1000)), agentMessage("y".repeat(1000))].join("\n") + "\n");
    expect(two.keptBytes() - one.keptBytes()).toBe(1000);
  });

  test("an incomplete max_output_tokens response sets truncated and one stderr line", () => {
    const stream = [
      THREAD,
      turnStarted(),
      agentMessage("partial findings"),
      turnFailed("stream disconnected before completion: Incomplete response returned, reason: max_output_tokens"),
    ].join("\n") + "\n";
    const out = codexResult({ ...finished(stream), exitCode: 1, success: false }, request);
    const envelope = JSON.parse(out.stdout);
    expect(out.success).toBe(false);
    expect(envelope.result).toBeNull();
    expect(envelope.codemux.truncated).toBe(true);
    expect(out.stderr.split(truncationLine("codex")).length).toBe(2);
    const plain = codexPlainStreamResult({ ...finished(stream), exitCode: 1, success: false });
    expect(plain.stderr).toContain(truncationLine("codex"));
  });

  test("a failed turn of another kind is not flagged truncated", () => {
    const stream = [THREAD, turnStarted(), agentMessage("x"), turnFailed("boom")].join("\n") + "\n";
    const envelope = JSON.parse(codexResult({ ...finished(stream), exitCode: 1, success: false }, request).stdout);
    expect(envelope.codemux.truncated).toBe(false);
    expect(envelope.codemux.final_message).toBeNull();
  });
});
