import { expect, test } from "bun:test";
import { parseGooseResultEnvelope, gooseResult } from "../src/result-envelope/goose.js";
import { parsePiResultEnvelope, piResult } from "../src/result-envelope/pi.js";
import { parseCopilotResultEnvelope } from "../src/result-envelope/copilot.js";
import { parseDroidResultEnvelope } from "../src/result-envelope/droid.js";
import { parseQwenResultEnvelope } from "../src/result-envelope/qwen.js";
import { parseCursorResultEnvelope, normalizeCursorUsage } from "../src/result-envelope/cursor.js";
import { CURSOR_DRIVER_PROFILE } from "../src/session/cursor-driver.js";
import { emptyUsage } from "../src/result-envelope/common.js";

const lines = (events: unknown[]) => events.map((event) => JSON.stringify(event)).join("\n");
const ok = (stdout: string) => ({ stdout, stderr: "", exitCode: 0, success: true });
const piMessage = (role: string, text: string, usage?: unknown) => ({ type: "message_end",
  message: { role, content: [{ type: "text", text }], usage } });
const piUsage = (extra = {}) => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, ...extra });

test("Goose clears the previous answer and message id on a new user turn", () => {
  const messages = [{ role: "user", content: "first" }, { role: "assistant", id: "a", content: "old" },
    { role: "user", content: "next" }];
  for (const stdout of [JSON.stringify({ messages }), lines(messages.map((message) => ({ type: "message", message })))]) {
    const parsed = parseGooseResultEnvelope(stdout)!;
    expect(parsed.answer).toBeNull();
    expect(parsed.finalText).toBeNull();
    expect(gooseResult(ok(stdout), { agent: "goose", prompt: "p", resultJson: true }).success).toBe(false);
  }
  expect(parseGooseResultEnvelope(JSON.stringify({ messages: [...messages,
    { role: "assistant", id: "a", content: "new" }] }))!.finalText).toBe("new");
});

test("Pi resets answer and stop outcome on a new user turn", () => {
  const stdout = lines([piMessage("user", "first"), { ...piMessage("assistant", "old"),
    message: { ...piMessage("assistant", "old").message, stopReason: "error", errorMessage: "old error" } },
  piMessage("user", "next")]);
  const parsed = parsePiResultEnvelope(stdout)!;
  expect(parsed.answer).toBeNull();
  expect(parsed.finalText).toBeNull();
  expect(parsed.stopReason).toBeNull();
  expect(parsed.errorText).toBeNull();
  expect(piResult(ok(stdout), { agent: "pi", prompt: "p", resultJson: true }).success).toBe(false);
});

test("Pi needs a measurement before publishing zero tokens", () => {
  for (const event of [{ type: "session" }, piMessage("user", "p"), piMessage("assistant", "reply")]) {
    expect(parsePiResultEnvelope(lines([event]))!.usage).toEqual(emptyUsage());
  }
  expect(parsePiResultEnvelope(lines([piMessage("assistant", "reply", piUsage())]))!.usage)
    .toEqual({ ...emptyUsage(), input_tokens: 0, output_tokens: 0, cached_input_tokens: 0, total_tokens: 0 });
});

test("Pi makes overflowing token and cost sums unknown and keeps them unknown", () => {
  for (const [field, normalized] of [["input", "input_tokens"], ["output", "output_tokens"],
    ["cacheRead", "cached_input_tokens"], ["cacheWrite", "cached_input_tokens"]] as const) {
    const usage = parsePiResultEnvelope(lines([Number.MAX_SAFE_INTEGER, 2, 0].map((count) =>
      piMessage("assistant", "reply", piUsage({ [field]: count })))))!.usage;
    expect(usage[normalized]).toBeNull();
    expect(usage.total_tokens).toBeNull();
  }
  expect(parsePiResultEnvelope(lines([Number.MAX_VALUE, Number.MAX_VALUE, 1].map((cost) =>
    piMessage("assistant", "reply", piUsage({ cost: { total: cost } })))))!.usage.cost_usd).toBeNull();
});

test("Copilot clears the answer on a main-agent user message", () => {
  const previous = { type: "assistant.message", data: { content: "old", model: "old-model" } };
  const parsed = parseCopilotResultEnvelope(lines([previous, { type: "user.message" }]))!;
  expect(parsed.answer).toBeNull();
  expect(parsed.finalMessage).toBeNull();
  expect(parsed.nativeModel).toBeNull();
  expect(parseCopilotResultEnvelope(lines([previous, { type: "user.message", agentId: "subagent" }]))!.answer).toBe("old");
});

test("Droid does not reuse completion text after a user message", () => {
  const parsed = parseDroidResultEnvelope(lines([{ type: "completion", finalText: "old" },
    { type: "message", role: "user", text: "next" }]))!;
  expect(parsed.answer).toBeNull();
  expect(parsed.finalText).toBeNull();
  expect(parsed.isError).toBe(true);
});

test("Qwen and Cursor require a new result after a new user turn", () => {
  const result = { type: "result", subtype: "success", result: "old" };
  const user = { type: "user", message: { content: [{ type: "text", text: "next" }] } };
  expect(parseQwenResultEnvelope(lines([result, user]))).toBeNull();
  expect(parseCursorResultEnvelope(lines([result, user]))).toBeNull();
  expect(parseQwenResultEnvelope(lines([result, { type: "user", message: { content: [{ type: "tool_result" }] } }]))!.answer).toBe("old");
});

test("Cursor missing usage stays null and complete zero measurements stay zero", () => {
  expect(normalizeCursorUsage({})).toEqual(emptyUsage());
  expect(normalizeCursorUsage({ inputTokens: 1, outputTokens: 2 })).toEqual({ ...emptyUsage(), input_tokens: 1, output_tokens: 2 });
  expect(normalizeCursorUsage({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }))
    .toEqual({ ...emptyUsage(), input_tokens: 0, output_tokens: 0, cached_input_tokens: 0, total_tokens: 0 });
});

test("Cursor event sums cannot hide unknown or overflowing components", () => {
  for (const first of [{}, { inputTokens: 1 }, { inputTokens: 1, outputTokens: 2,
    cacheReadTokens: Number.MAX_SAFE_INTEGER, cacheWriteTokens: 1 }]) {
    const events: unknown[] = [first, { inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 }]
      .map((usage) => ({ type: "usage", subtype: "model_call", usage }));
    const stdout = lines([...events, { type: "result", result: "reply" }]);
    const usage = parseCursorResultEnvelope(stdout)!.usage;
    expect(usage.cached_input_tokens).toBeNull();
    expect(usage.total_tokens).toBeNull();
  }
});

test("Goose cannot omit an unmeasured assistant response from run usage", () => {
  const messages = [{ role: "assistant", id: "one", content: "unmeasured" },
    { role: "assistant", id: "two", content: "measured", usage: {
      inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0.1,
    } }];
  expect(parseGooseResultEnvelope(JSON.stringify({ messages }))!.usage).toEqual(emptyUsage());
  const summary = lines([{ type: "message", message: messages[0] }, { type: "complete", total_tokens: 12 }]);
  expect(parseGooseResultEnvelope(summary)!.usage).toEqual({ ...emptyUsage(), total_tokens: 12 });
});

test("Goose overflow and unknown usage cannot restart a cumulative sum", () => {
  for (const values of [[Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, 1], [null, 1]]) {
    const messages = values.map((value) => ({ role: "assistant", content: "reply", usage: value === null ? {} : {
      inputTokens: value, outputTokens: value, cacheReadTokens: 0, cacheWriteTokens: value, cost: Number.MAX_VALUE,
    } }));
    const usage = parseGooseResultEnvelope(JSON.stringify({ messages }))!.usage;
    expect(usage.input_tokens).toBeNull();
    expect(usage.output_tokens).toBeNull();
    expect(usage.cached_input_tokens).toBeNull();
    expect(usage.total_tokens).toBeNull();
    expect(usage.cost_usd).toBeNull();
  }
});

test("Cursor session profile preserves native failure flags and subtypes", () => {
  const id = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
  for (const failure of [{ is_error: true, subtype: "success" }, { subtype: "error_during_execution" }]) {
    const parsed = CURSOR_DRIVER_PROFILE.parseTurnOutput!(lines([{ type: "result", result: "failure", session_id: id, ...failure }]), id);
    expect(parsed.failed).toBe(true);
    expect(parsed.failureReason).not.toBeNull();
  }
});
