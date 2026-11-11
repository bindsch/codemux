import { expect, test } from "bun:test";
import { qwenPlainResult, qwenResult } from "../src/result-envelope/qwen.js";
import { goosePlainResult, gooseResult } from "../src/result-envelope/goose.js";
import { parseGooseTranscript } from "../src/goose-answer.js";
import { qwenStreamFold } from "../src/qwen-stream-answer.js";
import { clineResult } from "../src/result-envelope/cline.js";
import { copilotResult } from "../src/result-envelope/copilot.js";
import { parseUsageSnapshot } from "../src/usage-protocol.js";
import { QwenAdapter } from "../src/adapters/qwen.js";

const lines = (...events: unknown[]) => events.map((event) => JSON.stringify(event)).join("\n");
const run = (stdout: string) => ({ stdout, stderr: "", exitCode: 0, success: true });

test("legacy qwen-coder retains its unstructured plain output contract", () => {
  const adapter = new QwenAdapter((name) => name === "qwen-coder" ? "/synthetic/qwen-coder" : null, {});
  const result = run("Done\n");
  expect(adapter.processRunResult(result, { agent: "qwen", prompt: "p" })).toEqual({ ...result, reply: "" });
});

test.each([
  { type: "system", subtype: "init", session_id: "session" },
  { type: "assistant", message: { content: [{ type: "text", text: "Partial" }] } },
])("Qwen requires a terminal result after %j", (event) => {
  const input = run(lines(event));
  for (const output of [qwenPlainResult(input), qwenResult(input, { agent: "qwen", prompt: "p" })]) {
    expect(output.success).toBe(false);
    expect(output.exitCode).toBe(1);
    expect(output.stderr).toContain("result message");
  }
  expect(qwenPlainResult(input).stdout).toBe("");
});

test("Goose requires complete for streams while retaining legacy JSON support", () => {
  const message = { role: "assistant", content: [{ type: "text", text: "Partial answer" }] };
  const wire = lines({ type: "message", message });
  expect(parseGooseTranscript(wire)?.errorMessage).toContain("without a complete event");
  for (const result of [goosePlainResult(run(wire)), gooseResult(run(wire), { agent: "goose", prompt: "p", resultJson: true })]) {
    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(1);
  }
  expect(parseGooseTranscript(lines({ messages: [message], metadata: { status: "completed" } }))?.errorMessage).toBeNull();
  expect(parseGooseTranscript(wire + '\n{"type":"complete"}')?.errorMessage).toBeNull();
});

test("Qwen capture counts unfinished tool-call bytes until the completed line can shrink", () => {
  const fold = qwenStreamFold();
  const line = lines({ type: "assistant", message: { content: [
    { type: "tool_use", id: "call", name: "write_file", input: { content: "x".repeat(17 * 1024 * 1024) } },
  ] } });
  for (let start = 0; start < line.length; start += 1024 * 1024) {
    fold.push(line.slice(start, start + 1024 * 1024));
    expect(fold.keptBytes!()).toBe(Math.min(start + 1024 * 1024, line.length));
  }
  expect(fold.keptBytes!()).toBeGreaterThan(16 * 1024 * 1024);
  fold.push('\n{"type":"result","subtype":"success","result":"Done"}\n');
  expect(fold.keptBytes!()).toBeLessThan(1024);
  const captured = fold.finish();
  expect(captured.length).toBeLessThan(1024);
  expect(qwenPlainResult(run(captured)).stdout).toBe("Done\n");
});

test.each(["run_aborted", "run_abort_requested"])("Cline preserves a completed result before %s", (type) => {
  const result = { type: "run_result", finishReason: "completed", text: "Done" };
  expect(clineResult(run(lines(result, { type })), { agent: "cline", prompt: "p" }).success).toBe(true);
  expect(clineResult(run(lines({ type }, result)), { agent: "cline", prompt: "p" }).success).toBe(false);
});

test.each(["Done", "Done\n"])("Copilot plain output has one terminal newline for %j", (text) => {
  const output = copilotResult(run(lines({ type: "assistant.message", data: { content: text } },
    { type: "result", sessionId: "session", exitCode: 0 })), { agent: "copilot", prompt: "p", resultJson: false });
  expect(output.success).toBe(true);
  expect(output.stdout).toBe("Done\n");
});

test("an omitted usage window duration is unknown without dropping measured quota", () => {
  const snapshot = parseUsageSnapshot(JSON.stringify({ schemaVersion: "1", generatedAt: "2026-11-11T00:00:00Z",
    results: [{ client: "codex", provider: "codex", status: "ok", source: "fixture", plan: null, account: null,
      windows: [{ kind: "weekly", usedPercent: 90, remainingPercent: 10, resetsAt: null }],
      credits: null, subscriptionRenewsAt: null, subscriptionExpiresAt: null, message: null }] }));
  expect(snapshot.results[0]?.windows[0]).toMatchObject({ windowMinutes: null, usedPercent: 90, remainingPercent: 10 });
});
