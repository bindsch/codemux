/**
 * The result envelope's own size bound (review round 127), split from
 * tests/result-envelope.test.ts: the bound is on the FINAL serialization
 * once the codemux block is appended, so these tests size each reply from
 * a probe of the finished stdout.
 */
import { describe, expect, test } from "bun:test";
import {
  agyResult,
  claudeFamilyResult,
  codexResult,
} from "../src/result-envelope.js";
import { kimiResult } from "../src/result-envelope/kimi.js";
import { MAX_CAPTURE_BYTES } from "../src/process-runner.js";
import type { RunRequest } from "../src/types.js";
import {
  AGY_SUCCESS_ENVELOPE,
  CLAUDE_ENVELOPE,
  codexStream,
  finished,
} from "./helpers/result-envelope.js";

describe("the envelope's own size (review round 127)", () => {
  // The bound is on the FINAL serialization: every original field plus the
  // codemux block, newline included, measured in bytes. Each test sizes the
  // reply from a probe of the finished stdout -- one ASCII character adds
  // exactly one serialized byte -- so the at-bound and one-past envelopes
  // are exact, and the oversized text is built once and reused (the
  // at-bound reply is a prefix of the one-past reply).
  const claudeWith = (result: string) =>
    JSON.stringify({ ...JSON.parse(CLAUDE_ENVELOPE), result });
  const agyWith = (response: string) =>
    JSON.stringify({ ...JSON.parse(AGY_SUCCESS_ENVELOPE), response });

  test("claude: exactly at the bound passes; one byte over drops the envelope and fails the run", () => {
    const request: RunRequest = { agent: "claude", prompt: "p", resultJson: true };
    const probe = claudeFamilyResult(finished(claudeWith("OK")), request, "claude");
    const replyLength = MAX_CAPTURE_BYTES - Buffer.byteLength(probe.stdout) + "OK".length;
    const oversized = "a".repeat(replyLength + 1);
    const atBound = claudeFamilyResult(
      finished(claudeWith(oversized.slice(0, -1))),
      request,
      "claude"
    );
    expect(Buffer.byteLength(atBound.stdout)).toBe(MAX_CAPTURE_BYTES);
    expect(atBound.success).toBe(true);
    expect(atBound.exitCode).toBe(0);
    const past = claudeFamilyResult(finished(claudeWith(oversized)), request, "claude");
    expect(past.stdout).toBe("");
    expect(past.success).toBe(false);
    expect(past.exitCode).toBe(125);
    expect(past.stderr).toContain(
      `claude result envelope exceeds the ${MAX_CAPTURE_BYTES}-byte capture bound once JSON-escaped; the reply is dropped`
    );
    // The tokens were spent: the refusal still reports the envelope's own
    // usage and the model that served the run.
    expect(past.usage).toEqual({
      input_tokens: 24114,
      output_tokens: 98,
      cached_input_tokens: 320,
      total_tokens: 24532,
      cost_usd: 0.12735,
    });
    expect(past.servedModel).toBe("claude-opus-5");
  });

  test("agy: exactly at the bound passes; one byte over drops the envelope and fails the run", () => {
    const request: RunRequest = { agent: "agy", prompt: "p", resultJson: true };
    const probe = agyResult(finished(agyWith("OK")), request);
    const replyLength = MAX_CAPTURE_BYTES - Buffer.byteLength(probe.stdout) + "OK".length;
    const oversized = "a".repeat(replyLength + 1);
    const atBound = agyResult(finished(agyWith(oversized.slice(0, -1))), request);
    expect(Buffer.byteLength(atBound.stdout)).toBe(MAX_CAPTURE_BYTES);
    expect(atBound.success).toBe(true);
    expect(atBound.exitCode).toBe(0);
    const past = agyResult(finished(agyWith(oversized)), request);
    expect(past.stdout).toBe("");
    expect(past.success).toBe(false);
    expect(past.exitCode).toBe(125);
    expect(past.stderr).toContain(
      `agy result envelope exceeds the ${MAX_CAPTURE_BYTES}-byte capture bound once JSON-escaped; the reply is dropped`
    );
    expect(past.usage).toEqual({
      input_tokens: 2302,
      output_tokens: 657,
      cached_input_tokens: 8113,
      total_tokens: 11072,
      cost_usd: null,
    });
    expect(past.servedModel).toBeNull();
  });
  test("kimi: an oversized envelope that was already diagnosed keeps its diagnostic beside the bound notice (round 341)", () => {
    const request: RunRequest = { agent: "kimi", prompt: "p", resultJson: true };
    // One capture, two failures: the malformed second line is diagnosed
    // while parsing, and the huge first event pushes the serialized
    // envelope past the bound. The refusal keeps the diagnostic and
    // appends the bound notice beside it, as every other agent's does.
    const oversized = "x".repeat(MAX_CAPTURE_BYTES);
    const stdout = `${JSON.stringify({ role: "tool", tool_call_id: "call-1", content: oversized })}\n{broken\n`;
    const past = kimiResult(finished(stdout), request, "brand-home");
    expect(past.stdout).toBe("");
    expect(past.success).toBe(false);
    expect(past.exitCode).toBe(125);
    expect(past.stderr).toContain("codemux: kimi stream-json line 2:");
    expect(past.stderr).toContain(
      `kimi result envelope exceeds the ${MAX_CAPTURE_BYTES}-byte capture bound once JSON-escaped; the reply is dropped`
    );
  });

  const codexWith = (text: string) =>
    codexStream([
      { type: "thread.started", thread_id: "0192b8d4-4d4f-7c4a-9d0e-6f5a4b3c2d1e" },
      { type: "turn.started" },
      { type: "item.completed", item: { id: "item_0", type: "agent_message", text } },
      { type: "turn.completed", usage: { input_tokens: 1000, cached_input_tokens: 600, output_tokens: 50 } },
    ]);

  test("codex: a plain run at the bound passes and one byte over fails; an experiment run truncates instead", () => {
    const request: RunRequest = { agent: "codex", prompt: "p", resultJson: true };
    const probe = codexResult(finished(codexWith("OK")), request);
    const replyLength = MAX_CAPTURE_BYTES - Buffer.byteLength(probe.stdout) + "OK".length;
    const oversized = "a".repeat(replyLength + 1);
    const atBound = codexResult(finished(codexWith(oversized.slice(0, -1))), request);
    expect(Buffer.byteLength(atBound.stdout)).toBe(MAX_CAPTURE_BYTES);
    expect(atBound.success).toBe(true);
    const past = codexResult(finished(codexWith(oversized)), request);
    expect(past.stdout).toBe("");
    expect(past.success).toBe(false);
    expect(past.exitCode).toBe(125);
    expect(past.stderr).toContain(
      `codex result envelope exceeds the ${MAX_CAPTURE_BYTES}-byte capture bound once JSON-escaped; the reply is dropped`
    );
    expect(past.usage?.output_tokens).toBe(50);
    // An experiment run (it names a recording) keeps a reply: the envelope
    // is cut to the bound, says so, and the run's own verdict stands. The
    // recording path lengthens the block, so the same reply is past the
    // bound here too.
    const recorded = codexResult(finished(codexWith(oversized)), request, null, "/synthetic/recording.jsonl");
    expect(Buffer.byteLength(recorded.stdout)).toBeLessThanOrEqual(MAX_CAPTURE_BYTES);
    expect(recorded.success).toBe(true);
    expect(recorded.exitCode).toBe(0);
    expect(recorded.stderr).toContain("codemux: result truncated to the 16 MiB capture limit");
    const envelope = JSON.parse(recorded.stdout) as { result: string; codemux: { recording: string } };
    expect(envelope.result.endsWith("\n[truncated by codemux]")).toBe(true);
    expect(envelope.codemux.recording).toBe("/synthetic/recording.jsonl");
  });
  test("codex: a truncation that drops an oversized reroute name drops it from the returned served model too (review round 128)", () => {
    const request: RunRequest = { agent: "codex", prompt: "p", resultJson: true };
    // The reroute names a model of 9 MiB; the block carries it twice
    // (model and served_model), so the envelope is past the bound with
    // nothing left to cut from the reply.
    const huge = "m".repeat(9 * 1024 * 1024);
    const stream = codexStream([
      { type: "thread.started", thread_id: "0192b8d4-4d4f-7c4a-9d0e-6f5a4b3c2d1e" },
      { type: "turn.started" },
      { type: "item.completed", item: { id: "item_0", type: "error", message: `model rerouted: gpt-5.3 -> ${huge} (Unavailable)` } },
      { type: "item.completed", item: { id: "item_1", type: "agent_message", text: "OK" } },
      { type: "turn.completed", usage: { input_tokens: 1000, cached_input_tokens: 600, output_tokens: 50 } },
    ]);
    // A plain run refuses the envelope whole.
    expect(codexResult(finished(stream), request).exitCode).toBe(125);
    const recorded = codexResult(finished(stream), request, null, "/synthetic/recording.jsonl");
    expect(Buffer.byteLength(recorded.stdout)).toBeLessThanOrEqual(MAX_CAPTURE_BYTES);
    const envelope = JSON.parse(recorded.stdout) as { result: string; codemux: { model: string | null; served_model: string | null } };
    expect(envelope.codemux.model).toBeNull();
    expect(envelope.codemux.served_model).toBeNull();
    expect(recorded.servedModel).toBeNull();
    expect(envelope.result).toBe("OK");
  });
});
