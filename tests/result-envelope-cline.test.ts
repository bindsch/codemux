import { describe, expect, test } from "bun:test";
import { clineResult, parseClineResultEnvelope } from "../src/result-envelope/cline.js";
import { MAX_CAPTURE_BYTES } from "../src/process-runner.js";

const usage = { inputTokens: 13, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 0, totalCost: 0.25 };
const event = (extra = {}) => JSON.stringify({ type: "run_result", finishReason: "completed", text: "answer", usage, ...extra });
const processResult = (stdout: string, resultJson = true, exitCode = 0) => clineResult(
  { stdout, stderr: "", exitCode, success: exitCode === 0 }, { agent: "cline", prompt: "input", resultJson });

describe("Cline cli-v3.0.74 NDJSON result", () => {
  test("maps native usage and cost, preserving session identity", () => {
    const parsed = parseClineResultEnvelope(JSON.stringify({ type: "run_start", sessionId: "session_a" }) + "\n" + event())!;
    expect(parsed).toMatchObject({ answer: "answer", sessionId: "session_a", servedModel: null,
      usage: { input_tokens: 10, output_tokens: 2, cached_input_tokens: 3, total_tokens: 15, cost_usd: 0.25 } });
    expect(processResult(event()).success).toBe(true);
    expect(JSON.parse(processResult(event()).stdout).codemux.agent).toBe("cline");
    expect(processResult(event(), false).stdout).toBe("answer");
  });

  test("prefers aggregate usage without counting it twice", () => {
    const parsed = parseClineResultEnvelope(event({ aggregateUsage: { ...usage, inputTokens: 23 } }))!;
    expect(parsed.usage.input_tokens).toBe(20);
    expect(parsed.usage.total_tokens).toBe(25);
  });

  test("does not invent missing metrics or served identity", () => {
    expect(parseClineResultEnvelope(event({ usage: null }))!.usage.input_tokens).toBeNull();
    expect(parseClineResultEnvelope(event({ usage: { inputTokens: 1.5, totalCost: -1 } }))!.usage)
      .toEqual({ input_tokens: null, output_tokens: null, cached_input_tokens: null, total_tokens: null, cost_usd: null });
    expect(parseClineResultEnvelope(event({ model: { id: "requested" } }))!.servedModel).toBeNull();
  });

  test("fails closed on broken, duplicate, missing, or conflicting wire data", () => {
    for (const wire of ["", "not json", "[]", "null", "{}", event() + "\n" + event(),
      JSON.stringify({ type: "run_start", sessionId: "first" }) + "\n" +
      JSON.stringify({ type: "run_start", sessionId: "second" }) + "\n" + event()]) {
      expect(parseClineResultEnvelope(wire)).toBeNull();
      expect(processResult(wire).success).toBe(false);
    }
    expect(parseClineResultEnvelope("\n" + JSON.stringify({ type: "future-event" }) + "\n" + event())).not.toBeNull();
  });

  test("fails empty answers and unsuccessful terminal reasons without replacing process failures", () => {
    for (const fields of [{ text: " " }, { text: null }, { finishReason: "aborted" }, { finishReason: null }]) {
      const result = processResult(event(fields));
      expect(result.success).toBe(false);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("codemux: cline reported");
    }
    expect(processResult(event({ finishReason: "error" }), true, 9).exitCode).toBe(9);
  });

  test("bounds the result after JSON escaping", () => {
    const result = processResult(event({ text: "x".repeat(MAX_CAPTURE_BYTES + 1) }));
    expect(result.success).toBe(false);
    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(MAX_CAPTURE_BYTES);
  });

  test("native abort events fail an unfinished run but preserve an already completed result", () => {
    for (const type of ["run_abort_requested", "run_aborted"]) {
      const unfinished = JSON.stringify({ type }) + "\n" + event();
      expect(parseClineResultEnvelope(unfinished)).toBeNull();
      expect(processResult(unfinished).success).toBe(false);
      const completed = event() + "\n" + JSON.stringify({ type });
      expect(parseClineResultEnvelope(completed)?.finishReason).toBe("completed");
      expect(processResult(completed).success).toBe(true);
    }
  });
});
