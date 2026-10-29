import { expect, test } from "bun:test";
import { ExperimentFailure, ExperimentFailureCode as Code } from "../src/experiment-records.js";
import { MAX_CAPTURE_BYTES } from "../src/process-runner.js";
import { experimentFailedResult } from "../src/result-envelope/experiment.js";

function failedPrefix(text: string, extra = "") {
  const stdout = [
    { type: "thread.started", thread_id: "thread-r" },
    { type: "turn.started" },
    { type: "item.completed", item: { id: "reply-r", type: "agent_message", text } },
  ].map((event) => JSON.stringify(event)).join("\n") + "\n" + extra + "{broken\n";
  return experimentFailedResult({ stdout, stderr: "", success: false, exitCode: 125 },
    { agent: "codex", prompt: "fixture", resultJson: true }, "/recording-r.jsonl",
    new ExperimentFailure(Code.Protocol, "capture interrupted"));
}

test("Codex failure recovery stores its final message only in result", () => {
  const result = failedPrefix("unique final reply");
  const envelope = JSON.parse(result.stdout);
  expect(envelope.result).toBe("unique final reply");
  expect(JSON.stringify(envelope.events)).not.toContain("unique final reply");
  expect(envelope.events).toHaveLength(2);
});

test("Codex failure recovery drops events before truncating a fitting result", () => {
  const reply = "r".repeat(MAX_CAPTURE_BYTES - 512);
  const result = failedPrefix(reply, JSON.stringify({ type: "extra", data: "e".repeat(1024) }) + "\n");
  expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(MAX_CAPTURE_BYTES);
  const envelope = JSON.parse(result.stdout);
  expect(envelope.result).toBe(reply);
  expect(envelope.events).toBeUndefined();
});

test("Codex failure recovery truncates escaped multibyte text with a note within the byte limit", () => {
  const result = failedPrefix('é\\"'.repeat(Math.ceil(MAX_CAPTURE_BYTES / 4)));
  expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(MAX_CAPTURE_BYTES);
  const envelope = JSON.parse(result.stdout);
  expect(envelope.result).toContain("[truncated by codemux]");
  expect(envelope.events).toBeUndefined();
  expect(envelope.codemux.failure_code).toBe("protocol");
  expect(result.stderr).toContain("result truncated to the 16 MiB capture limit");
});

test("Codex failure recovery bounds a reported model from a captured prefix without inventing a reply", () => {
  const stream = (model: string) => [
    { type: "thread.started", thread_id: "thread-r" },
    { type: "turn.started" },
    { type: "item.completed", item: { id: "reroute-r", type: "error", message: `model rerouted: a -> ${model} (r)` } },
  ].map((event) => JSON.stringify(event)).join("\n") + "\n{broken\n";
  const stdout = stream("m".repeat(MAX_CAPTURE_BYTES - Buffer.byteLength(stream(""))));
  expect(Buffer.byteLength(stdout)).toBe(MAX_CAPTURE_BYTES);
  const result = experimentFailedResult({ stdout, stderr: "", success: false, exitCode: 125 },
    { agent: "codex", prompt: "fixture", resultJson: true }, "/recording-r.jsonl",
    new ExperimentFailure(Code.Protocol, "capture interrupted"));
  expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(MAX_CAPTURE_BYTES);
  const envelope = JSON.parse(result.stdout);
  expect(envelope.result).toBeNull();
  expect(envelope.events).toBeUndefined();
  expect(envelope.codemux).toMatchObject({ model: null, failure_code: "protocol", recording: "/recording-r.jsonl" });
  expect(result.stderr).toContain("result truncated to the 16 MiB capture limit");
});
