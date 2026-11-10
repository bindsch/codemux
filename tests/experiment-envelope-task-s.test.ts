import { expect, test } from "bun:test";
import { ExperimentFailure, ExperimentFailureCode as Code } from "../src/experiment-records.js";
import { OUTPUT_LIMIT_EXIT_CODE } from "../src/process-runner.js";
import { experimentFailedResult } from "../src/result-envelope/experiment.js";

const head = [
  { type: "thread.started", thread_id: "thread-s" },
  { type: "turn.started" },
];
const captures = [
  ["malformed JSON", 1, "\n{broken\n"],
  ["the output limit", OUTPUT_LIMIT_EXIT_CODE, "\n"],
] as const;

function message(type: string, id: string, text = "same reply") {
  return { type, item: { id, type: "agent_message", text } };
}

function recover(events: Record<string, unknown>[], exitCode: number, suffix: string) {
  const stdout = events.map((event) => JSON.stringify(event)).join("\n") + suffix;
  return experimentFailedResult({ stdout, stderr: "", success: false, exitCode },
    { agent: "codex", prompt: "fixture", resultJson: true }, "/recording-s.jsonl",
    new ExperimentFailure(Code.Protocol, "capture interrupted"));
}

test.each(captures)("Codex failure recovery preserves earlier identical messages after %s", (_, exitCode, suffix) => {
  const earlier = message("item.completed", "earlier");
  const final = message("item.completed", "final");
  const result = recover([...head, earlier, final], exitCode, suffix);
  const envelope = JSON.parse(result.stdout);
  // The complete answer (lane AN1): both messages, the last alone apart.
  expect(envelope.result).toBe("same reply\n\nsame reply");
  expect(envelope.codemux.final_message).toBe("same reply");
  expect(envelope.events).toEqual([...head, earlier]);
  expect(envelope.codemux.failure_code).toBe("protocol");
  expect(result.exitCode).toBe(exitCode);
  expect(result.success).toBe(false);
});

test.each(captures)("Codex failure recovery preserves same-text updates after %s", (_, exitCode, suffix) => {
  const started = message("item.started", "final");
  const updated = message("item.updated", "final");
  const final = message("item.completed", "final");
  const trailing = { type: "item.completed", item: { id: "reasoning", type: "reasoning", text: "same reply" } };
  const result = recover([...head, started, updated, final, trailing], exitCode, suffix);
  const envelope = JSON.parse(result.stdout);
  expect(envelope.result).toBe("same reply");
  expect(envelope.events).toEqual([...head, started, updated, trailing]);
});

test("Codex failure recovery preserves completed messages when the turn discards its final reply", () => {
  const completed = message("item.completed", "discarded");
  const failed = { type: "turn.failed", error: { message: "turn failed" } };
  const result = recover([...head, completed, failed], 1, "\n{broken\n");
  const envelope = JSON.parse(result.stdout);
  expect(envelope.result).toBeNull();
  expect(envelope.events).toEqual([...head, completed, failed]);
});
