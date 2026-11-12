import { describe, expect, test } from "bun:test";
import { CursorAdapter } from "../src/adapters/cursor.js";
import { CURSOR_ANSWER_FIELD, cursorResult, parseCursorResultEnvelope } from "../src/result-envelope/cursor.js";
import type { RunRequest, RunResult } from "../src/types.js";

// Lane W4: cursor's run-surface parity — every run on the stream-json
// wire (the text format drops a tool-using run's reply), the plain-run
// rewrite with its usage record, --no-web through --exclude-tools,
// --tools none through the validated --allowed-tools allowlist, and the
// provider override over CURSOR_API_ENDPOINT / CURSOR_API_KEY.

function adapter(env: Record<string, string | undefined> = {}): CursorAdapter {
  return new CursorAdapter((name) => (name === "agent" ? "/fake/agent" : null), env);
}

const wire = (...events: unknown[]): string => events.map((event) => JSON.stringify(event)).join("\n") + "\n";
const usageEvent = (inputTokens: number, outputTokens: number, cacheReadTokens: number, cacheWriteTokens = 0): unknown => ({
  type: "usage", subtype: "model_call", session_id: "sess-1",
  usage: { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens },
});
const resultLine = (result: string, extra: Record<string, unknown> = {}): unknown => ({
  type: "result", subtype: "success", is_error: false, duration_ms: 1200,
  result, session_id: "sess-1", ...extra,
});

describe("cursor run argv", () => {
  test("every run launches on the stream-json wire, plain and result-json alike", () => {
    const argv = ["agent", "--print", "--output-format", "stream-json", "--trust"];
    expect(adapter().buildRunCommand({ agent: "cursor", prompt: "p" })).toEqual(argv);
    expect(adapter().buildRunCommand({ agent: "cursor", prompt: "p", resultJson: true })).toEqual(argv);
  });

  test("--no-web removes exactly the two web tools", () => {
    expect(adapter().buildRunCommand({ agent: "cursor", prompt: "p", web: false })).toEqual([
      "agent", "--print", "--output-format", "stream-json", "--trust",
      "--exclude-tools", "web_search_tool_call,web_fetch_tool_call",
    ]);
    expect(adapter().buildRunCommand({ agent: "cursor", prompt: "p", web: true }))
      .toEqual(["agent", "--print", "--output-format", "stream-json", "--trust"]);
  });

  test("the allowlist names the one no-op tool under every autonomy level", () => {
    expect(adapter().buildRunCommand({ agent: "cursor", prompt: "p", tools: "none" })).toEqual([
      "agent", "--print", "--output-format", "stream-json", "--trust",
      "--allowed-tools", "reflect_tool_call",
    ]);
    expect(adapter().buildRunCommand({ agent: "cursor", prompt: "p", tools: "none", autonomy: "read-only" })).toEqual([
      "agent", "--print", "--output-format", "stream-json", "--trust",
      "--allowed-tools", "reflect_tool_call", "--mode", "plan",
    ]);
    expect(adapter().buildRunCommand({ agent: "cursor", prompt: "p", tools: "default" }))
      .toEqual(["agent", "--print", "--output-format", "stream-json", "--trust"]);
  });
});

describe("cursor stream envelope", () => {
  test("usage sums the model_call events, input net of both cache counters", () => {
    const parsed = parseCursorResultEnvelope(wire(
      { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "the answer" }] }, session_id: "sess-1" },
      usageEvent(10, 2, 3),
      usageEvent(5, 3, 0),
      resultLine("the answer"),
    ))!;
    expect(parsed.answer).toBe("the answer");
    expect(parsed.sessionId).toBe("sess-1");
    expect(parsed.usage).toEqual({
      input_tokens: 15, output_tokens: 5, cached_input_tokens: 3, total_tokens: 23, cost_usd: null,
    });
  });

  test("a stream with no usage events falls back to the result line's usage", () => {
    const parsed = parseCursorResultEnvelope(wire(resultLine("the answer", {
      usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 2, cacheWriteTokens: 3 },
    })))!;
    expect(parsed.usage).toEqual({
      input_tokens: 10, output_tokens: 5, cached_input_tokens: 5, total_tokens: 20, cost_usd: null,
    });
  });

  test("no usage anywhere stays all-null, not zero", () => {
    const parsed = parseCursorResultEnvelope(wire(resultLine("r")))!;
    expect(parsed.usage).toEqual({
      input_tokens: null, output_tokens: null, cached_input_tokens: null, total_tokens: null, cost_usd: null,
    });
  });

  test("the result line folds into the --result-json envelope under its native field", () => {
    expect(CURSOR_ANSWER_FIELD).toBe("result");
    const stdout = wire(usageEvent(10, 5, 2, 3), resultLine("the answer"));
    const result = cursorResult(
      { stdout, stderr: "", exitCode: 0, success: true } as RunResult,
      { agent: "cursor", prompt: "p", resultJson: true, model: "m1" }
    );
    const envelope = JSON.parse(result.stdout);
    expect(envelope.result).toBe("the answer");
    expect(envelope.usage).toEqual({
      input_tokens: 10, output_tokens: 5, cached_input_tokens: 5, total_tokens: 20, cost_usd: null,
    });
    expect(envelope.codemux).toEqual({
      agent: "cursor",
      labels: null,
      model: "m1",
      served_model: null,
      model_alias: null,
      usage: envelope.usage,
      session_id: "sess-1",
      recording: null,
      failure_code: null,
      final_message: "the answer",
      truncated: false,
    });
  });

  test("no result line fails loudly", () => {
    const result = cursorResult(
      { stdout: "boom\n", stderr: "error: boom", exitCode: 1, success: false },
      { agent: "cursor", prompt: "p", resultJson: true }
    );
    expect(result.success).toBe(false);
    expect(result.stderr).toContain("cursor printed no result line");
  });

  test("an error or empty result line fails even at exit 0", () => {
    const errorLine = wire({ type: "result", subtype: "error_during_execution", is_error: true, result: "" });
    const errored = cursorResult(
      { stdout: errorLine, stderr: "", exitCode: 0, success: true },
      { agent: "cursor", prompt: "p", resultJson: true }
    );
    expect(errored.success).toBe(false);
    expect(errored.exitCode).toBe(1);
    expect(JSON.parse(errored.stdout).codemux.failure_code).toBe("harness-error");
    const emptied = cursorResult(
      { stdout: wire(resultLine("   ")), stderr: "", exitCode: 0, success: true },
      { agent: "cursor", prompt: "p", resultJson: true }
    );
    expect(emptied.success).toBe(false);
    expect(JSON.parse(emptied.stdout).codemux.failure_code).toBe("harness-error");
  });
});

describe("cursor plain-run rewrite", () => {
  const run = (stdout: string): RunResult => adapter().processRunResult(
    { stdout, stderr: "", exitCode: 0, success: true } as RunResult,
    { agent: "cursor", prompt: "p" }
  );

  test("a tool-using run's whole reply is every segment, with usage recorded", () => {
    const result = run(wire(
      { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "before tools " }] }, session_id: "sess-1" },
      { type: "tool_call", subtype: "started", call_id: "c1", session_id: "sess-1" },
      usageEvent(10, 2, 3),
      { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "after tools" }] }, session_id: "sess-1" },
      resultLine("before tools after tools"),
    ));
    expect(result.stdout).toBe("before tools\n\nafter tools\n");
    expect(result.usage).toEqual({
      input_tokens: 10, output_tokens: 2, cached_input_tokens: 3, total_tokens: 15, cost_usd: null,
    });
    expect(result.servedModel).toBeNull();
  });

  test("stdout with no result line keeps its bytes and exit status", () => {
    const result = run("\n");
    expect(result.stdout).toBe("\n");
    expect(result.success).toBe(true);
    expect(result.usage).toBeUndefined();
  });
});

describe("cursor provider override", () => {
  const overrideEnv = {
    CODEMUX_CURSOR_PROVIDER_BASE_URL: "https://api.example/v1",
    CODEMUX_CURSOR_PROVIDER_API_KEY: "key-1",
    CODEMUX_CURSOR_PROVIDER_MODEL: "provider-model",
  };

  test("the unsafe override is refused before building the run environment", () => {
    const request: RunRequest = { agent: "cursor", prompt: "p" };
    expect(() => adapter(overrideEnv).getRunEnv(request)).toThrow("saved account credential");
    expect(adapter({}).getRunEnv(request)).toEqual({});
  });

  test("an explicit model cannot bypass provider refusal", () => {
    expect(() => adapter(overrideEnv).buildRunCommand({ agent: "cursor", prompt: "p" }))
      .toThrow("saved account credential");
    expect(() => adapter(overrideEnv).buildRunCommand({ agent: "cursor", prompt: "p", model: "explicit" }))
      .toThrow("saved account credential");
  });

  test("a token cap is refused with the no-surface evidence", () => {
    const capped = {
      ...overrideEnv,
      CODEMUX_CURSOR_PROVIDER_MAX_OUTPUT_TOKENS: "4096",
    };
    expect(() => adapter(capped).validateRunRequest({ agent: "cursor", prompt: "p" }))
      .toThrow(/no token-budget surface/);
  });

  test("the interactive path refuses the same override", () => {
    expect(() => adapter(overrideEnv).validateTuiRequest()).toThrow("saved account credential");
    expect(() => adapter(overrideEnv).getTuiEnv()).toThrow("saved account credential");
    expect(() => adapter({}).validateTuiRequest()).not.toThrow();
  });
});
