import { describe, expect, test } from "bun:test";
import {
  geminiResult,
  parseGeminiResultEnvelope,
  geminiUsageFromStats,
  GEMINI_ANSWER_FIELD,
} from "../src/result-envelope/gemini.js";
import { gooseResult, parseGooseResultEnvelope } from "../src/result-envelope/goose.js";
import {
  openhandsResult,
  parseOpenhandsResultEnvelope,
  OPENHANDS_ANSWER_FIELD,
} from "../src/result-envelope/openhands.js";
import {
  copilotResult,
  parseCopilotResultEnvelope,
  COPILOT_ANSWER_FIELD,
} from "../src/result-envelope/copilot.js";
import { RESULT_ANSWER_FIELD } from "../src/result-envelope/index.js";
import type { RunRequest, RunResult } from "../src/types.js";
import { GooseAdapter } from "../src/adapters/goose.js";
import type { RunContext } from "../src/adapters/base.js";

const request: RunRequest = { agent: "gemini", prompt: "p" };
const ok = (stdout: string): RunResult => ({
  stdout,
  stderr: "",
  exitCode: 0,
  success: true,
});

describe("gemini --result-json", () => {
  test("the answer-field table carries the parity agents", () => {
    expect(RESULT_ANSWER_FIELD.gemini).toBe("response");
    expect(RESULT_ANSWER_FIELD.copilot).toBe("content");
    expect(RESULT_ANSWER_FIELD.goose).toBe("content");
    expect(RESULT_ANSWER_FIELD.openhands).toBe("llm_message");
    expect(RESULT_ANSWER_FIELD.aider).toBeUndefined();
  });

  test("parses the envelope: response, session id, stats arithmetic", () => {
    const stdout = JSON.stringify({
      session_id: "0e0e0e0e-1111-2222-3333-444444444444",
      response: "the answer",
      stats: { input_tokens: 150, output_tokens: 40, cached: 50, total_tokens: 190 },
    });
    const parsed = parseGeminiResultEnvelope(stdout);
    expect(parsed).not.toBeNull();
    expect(parsed!.envelope[GEMINI_ANSWER_FIELD]).toBe("the answer");
    expect(parsed!.sessionId).toBe("0e0e0e0e-1111-2222-3333-444444444444");
    // input_tokens includes the cache reads: the uncached input is 100.
    expect(parsed!.usage).toEqual({
      input_tokens: 100,
      cached_input_tokens: 50,
      output_tokens: 40,
      total_tokens: 190,
      cost_usd: null,
    });
  });

  test("an inconsistent cache snapshot nulls the input and the total, never clamps", () => {
    const usage = geminiUsageFromStats({ input_tokens: 10, output_tokens: 5, cached: 50 });
    expect(usage.input_tokens).toBeNull();
    expect(usage.total_tokens).toBeNull();
    expect(usage.cached_input_tokens).toBe(50);
    expect(usage.output_tokens).toBe(5);
  });

  test("stdout that is not the envelope fails the run loudly", () => {
    const out = geminiResult(ok("not json at all"), request);
    expect(out.success).toBe(false);
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain("no result envelope");
  });

  test("an error result and an empty response fail even though the harness exited 0", () => {
    const errored = geminiResult(
      ok(JSON.stringify({ error: { message: "quota" }, stats: {} })),
      request
    );
    expect(errored.success).toBe(false);
    expect(errored.stderr).toContain("quota");
    const empty = geminiResult(
      ok(JSON.stringify({ response: "  \n", stats: {} })),
      request
    );
    expect(empty.success).toBe(false);
    expect(empty.stderr).toContain("no result text");
  });

  test("a good run re-emits the envelope with the codemux block", () => {
    const out = geminiResult(
      ok(JSON.stringify({ response: "done", stats: { input_tokens: 10, output_tokens: 2, cached: 0 } })),
      request
    );
    expect(out.success).toBe(true);
    const envelope = JSON.parse(out.stdout);
    expect(envelope.response).toBe("done");
    expect(envelope.codemux.agent).toBe("gemini");
    expect(envelope.codemux.usage.input_tokens).toBe(10);
  });
});

describe("goose --result-json", () => {
  test("parses the final object: content, session id, usage arithmetic", () => {
    const line = JSON.stringify({
      session_id: "20250921_143022",
      content: "the reply",
      usage: { inputTokens: 120, outputTokens: 30, cacheReadTokens: 20, cacheWriteTokens: 5 },
    });
    const parsed = parseGooseResultEnvelope(`progress line\n${line}\n`);
    expect(parsed).not.toBeNull();
    expect(parsed!.answer).toBe("the reply");
    expect(parsed!.sessionId).toBe("20250921_143022");
    // inputTokens includes the cache reads: the uncached input is 100,
    // and the cache block is reads plus writes.
    expect(parsed!.usage).toEqual({
      input_tokens: 100,
      cached_input_tokens: 25,
      output_tokens: 30,
      total_tokens: 155,
      cost_usd: null,
    });
  });

  test("accepts the snake_case ledger spellings as aliases", () => {
    const parsed = parseGooseResultEnvelope(
      JSON.stringify({ content: "x", usage: { input_tokens: 9, output_tokens: 1, cache_read_tokens: 4, cache_write_tokens: 0 } })
    );
    expect(parsed!.usage.input_tokens).toBe(5);
    expect(parsed!.usage.cached_input_tokens).toBe(4);
  });

  test("a part-list content joins its text parts", () => {
    const parsed = parseGooseResultEnvelope(
      JSON.stringify({ content: [{ type: "text", text: "a" }, { type: "image", url: "x" }, { type: "text", text: "b" }] })
    );
    expect(parsed!.answer).toBe("ab");
  });

  test("no object line, an error object, and an empty answer fail the run", () => {
    const noWire = gooseResult(ok("only human progress lines"), request);
    expect(noWire.success).toBe(false);
    expect(noWire.stderr).toContain("no result object");
    const noAnswer = gooseResult(ok(JSON.stringify({ content: "" })), request);
    expect(noAnswer.success).toBe(false);
    expect(noAnswer.stderr).toContain("no message content");
  });

  test("an experiment run's envelope carries its recording path (review 422 #15)", () => {
    const wire = JSON.stringify({ content: "ok" });
    const adapter = new GooseAdapter();
    const goose: RunRequest = { agent: "goose", prompt: "p", resultJson: true };
    const recorded = adapter.processRunResult(ok(wire), goose, { experimentRecording: "/runs/r.jsonl" } as RunContext);
    expect(JSON.parse(recorded.stdout).codemux.recording).toBe("/runs/r.jsonl");
    const plain = adapter.processRunResult(ok(wire), goose);
    expect(JSON.parse(plain.stdout).codemux.recording).toBeNull();
  });
});

describe("openhands --result-json", () => {
  test("the last agent message's text parts are the answer; user messages are not", () => {
    const wire = [
      JSON.stringify({ kind: "MessageEvent", source: "user", llm_message: { content: [{ type: "text", text: "the prompt" }] } }),
      JSON.stringify({ kind: "MessageEvent", source: "agent", llm_message: { content: [{ type: "text", text: "first" }] } }),
      JSON.stringify({ kind: "MessageEvent", source: "agent", llm_message: { content: [{ type: "text", text: "final " }, { type: "text", text: "answer" }] } }),
    ].join("\n");
    const parsed = parseOpenhandsResultEnvelope(wire);
    expect(parsed!.answer).toBe("final answer");
    expect(parsed!.errorText).toBeNull();
  });

  test("error events fail the run whatever the process exit was", () => {
    const wire = JSON.stringify({ kind: "AgentErrorEvent", error: { message: "boom" } });
    const out = openhandsResult(ok(wire), request);
    expect(out.success).toBe(false);
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain("boom");
  });

  test("no wire events and no agent message fail; usage stays all-null", () => {
    const noWire = openhandsResult(ok("Goodbye!"), request);
    expect(noWire.success).toBe(false);
    expect(noWire.stderr).toContain("no wire events");
    const quiet = openhandsResult(
      ok(JSON.stringify({ kind: "MessageEvent", source: "user", llm_message: { content: "prompt" } })),
      request
    );
    expect(quiet.success).toBe(false);
    expect(quiet.stderr).toContain("no agent message");
    const good = openhandsResult(
      ok(JSON.stringify({ kind: "MessageEvent", source: "agent", llm_message: { content: "hi" } })),
      request
    );
    const envelope = JSON.parse(good.stdout);
    expect(envelope[OPENHANDS_ANSWER_FIELD]).toBe("hi");
    expect(envelope.usage).toEqual({
      input_tokens: null,
      output_tokens: null,
      cached_input_tokens: null,
      total_tokens: null,
      cost_usd: null,
    });
  });
});

describe("copilot --result-json", () => {
  test("the last assistant message is the answer; the result line carries the session and exit", () => {
    const wire = [
      JSON.stringify({ type: "assistant.message", data: { content: "draft" } }),
      JSON.stringify({ type: "assistant.message", data: { content: "final answer" } }),
      JSON.stringify({ type: "result", sessionId: "abc-123", exitCode: 0, usage: { premiumRequests: 1 } }),
    ].join("\n");
    const parsed = parseCopilotResultEnvelope(wire);
    expect(parsed!.answer).toBe("final answer");
    expect(parsed!.sessionId).toBe("abc-123");
    expect(parsed!.reportedExitCode).toBe(0);
    // The writer suppresses assistant.usage and the result line carries
    // no tokens: every usage field is null, never guessed.
    expect(parsed!.usage.input_tokens).toBeNull();
    expect(parsed!.usage.total_tokens).toBeNull();
  });

  test("session.error and a nonzero result exitCode fail the run; no wire fails it", () => {
    const errored = copilotResult(
      ok(JSON.stringify({ type: "session.error", data: { message: "no login" } })),
      request
    );
    expect(errored.success).toBe(false);
    expect(errored.stderr).toContain("no login");
    const badExit = copilotResult(
      ok([
        JSON.stringify({ type: "assistant.message", data: { content: "partial" } }),
        JSON.stringify({ type: "result", sessionId: "s", exitCode: 2, usage: {} }),
      ].join("\n")),
      request
    );
    expect(badExit.success).toBe(false);
    expect(badExit.stderr).toContain("result exitCode 2");
    const noWire = copilotResult(ok("plain text"), request);
    expect(noWire.success).toBe(false);
    expect(noWire.stderr).toContain("no wire events");
  });

  test("a good run emits the envelope with the codemux block and all-null usage", () => {
    const out = copilotResult(
      ok([
        JSON.stringify({ type: "assistant.message", data: { content: "done" } }),
        JSON.stringify({ type: "result", sessionId: "sess", exitCode: 0, usage: {} }),
      ].join("\n")),
      request
    );
    expect(out.success).toBe(true);
    const envelope = JSON.parse(out.stdout);
    expect(envelope[COPILOT_ANSWER_FIELD]).toBe("done");
    expect(envelope.codemux.session_id).toBe("sess");
    expect(envelope.codemux.usage.total_tokens).toBeNull();
  });
});
