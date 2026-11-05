import { describe, expect, test } from "bun:test";
import {
  agyResult,
  claudeFamilyResult,
  codexResult,
  emptyUsage,
  parseClaudeResultEnvelope,
} from "../src/result-envelope.js";
import { MAX_CAPTURE_BYTES } from "../src/process-runner.js";
import type { RunRequest } from "../src/types.js";
import {
  AGY_SUCCESS_ENVELOPE,
  CLAUDE_ENVELOPE,
  codexStream,
  finished,
} from "./helpers/result-envelope.js";

describe("parseClaudeResultEnvelope", () => {
  test("maps the envelope's usage into the normalized block", () => {
    const parsed = parseClaudeResultEnvelope(`${CLAUDE_ENVELOPE}\n`)!;
    // Anthropic's input_tokens excludes the cache; the cache read and write
    // counts join into cached_input_tokens so the three fields sum.
    expect(parsed.usage).toEqual({
      input_tokens: 24114,
      output_tokens: 98,
      cached_input_tokens: 320,
      total_tokens: 24532,
      cost_usd: 0.12735,
    });
    expect(parsed.servedModel).toBe("claude-opus-5");
    expect(parsed.envelope.result).toBe("OK");
  });

  test("a reported zero cache count stays zero, not null", () => {
    const parsed = parseClaudeResultEnvelope(
      JSON.stringify({
        type: "result",
        result: "OK",
        usage: { input_tokens: 100, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      })
    )!;
    // The harness reported the cache counts (both zero); null would drop a
    // known number, and the published total (their sum plus output) would
    // stop being checkable.
    expect(parsed.usage).toEqual({
      input_tokens: 100,
      output_tokens: 5,
      cached_input_tokens: 0,
      total_tokens: 105,
      cost_usd: null,
    });
  });

  test("keeps nulls instead of guessing when the envelope reports nothing", () => {
    const parsed = parseClaudeResultEnvelope(
      JSON.stringify({ type: "result", result: "OK", session_id: "abc" })
    )!;
    expect(parsed.usage).toEqual(emptyUsage());
    expect(parsed.servedModel).toBeNull();
  });

  test("rejects stdout that is not the envelope", () => {
    expect(parseClaudeResultEnvelope("OK\n")).toBeNull();
    expect(parseClaudeResultEnvelope("[1,2]")).toBeNull();
    expect(parseClaudeResultEnvelope("")).toBeNull();
  });

  test("JSON that is not the result envelope is rejected, not parsed", () => {
    // `{}` and other objects parse cleanly yet carry no result; without the
    // type discriminator each produced a successful envelope with null
    // usage -- unrelated stdout read as a completed run.
    expect(parseClaudeResultEnvelope("{}")).toBeNull();
    expect(parseClaudeResultEnvelope('{"type":"stream"}')).toBeNull();
    expect(parseClaudeResultEnvelope('{"ok":true}')).toBeNull();
  });

  test("the discriminator alone is not a result", () => {
    // `{"type":"result"}` names neither the result text nor a subtype
    // status, so it reports no outcome at all; a malformed wrapper response
    // must not satisfy --result-json by shape alone.
    expect(parseClaudeResultEnvelope('{"type":"result"}')).toBeNull();
    expect(parseClaudeResultEnvelope('{"type":"result","is_error":true}')).not.toBeNull();
  });

  test("a subtype alone is not an outcome: success without result text is rejected", () => {
    // The round7 finding's reproduction: {"type":"result","subtype":
    // "success"} returned exit 0 despite carrying no result -- any string
    // subtype counted, the empty one included. A successful envelope owes
    // its result text; only a failing one (is_error, error_* subtype) may
    // omit it.
    expect(parseClaudeResultEnvelope('{"type":"result","subtype":"success"}')).toBeNull();
    expect(parseClaudeResultEnvelope('{"type":"result","subtype":""}')).toBeNull();
    expect(parseClaudeResultEnvelope('{"type":"result","subtype":"error_max_turns"}')).not.toBeNull();
    expect(
      parseClaudeResultEnvelope('{"type":"result","subtype":"success","result":"OK"}')
    ).not.toBeNull();
  });

  test("a run served by several models names none", () => {
    const parsed = parseClaudeResultEnvelope(
      JSON.stringify({
        type: "result",
        result: "OK",
        modelUsage: { "claude-opus-5": {}, "claude-haiku-4.5": {} },
      })
    )!;
    expect(parsed.servedModel).toBeNull();
  });
});

describe("claudeFamilyResult", () => {
  const request: RunRequest = { agent: "claude", prompt: "p", resultJson: true };

  test("keeps every original field and appends the codemux block", () => {
    const out = claudeFamilyResult(finished(CLAUDE_ENVELOPE), request, "claude");
    expect(out.stdout.endsWith("\n")).toBe(true);
    const envelope = JSON.parse(out.stdout);
    // Backward compatible: the harness's own fields are untouched.
    expect(envelope.type).toBe("result");
    expect(envelope.subtype).toBe("success");
    expect(envelope.session_id).toBe("8f14e45f-ea75-4c8f-9d0b-4bba9c9b1b1b");
    expect(envelope.result).toBe("OK");
    expect(envelope.usage.input_tokens).toBe(24114);
    expect(envelope.modelUsage).toEqual({ "claude-opus-5": {} });
    expect(envelope.codemux).toEqual({
      agent: "claude",
      model: "claude-opus-5",
      usage: {
        input_tokens: 24114,
        output_tokens: 98,
        cached_input_tokens: 320,
        total_tokens: 24532,
        cost_usd: 0.12735,
      },
      // Always null in this release: the adapter passes
      // --no-session-persistence, so no run leaves a resumable session
      // behind -- not even when the harness's own envelope names an id.
      session_id: null,
      // Set only on --experiment-mcp runs, where the bridge records the
      // protocol exchange to a per-run JSONL file.
      recording: null,
      served_model: "claude-opus-5",
      failure_code: null,
      labels: null,
    });
  });

  test("the model falls back to what codemux selected, then null", () => {
    const unnamed = JSON.stringify({ type: "result", result: "OK" });
    const selected = claudeFamilyResult(
      finished(unnamed),
      { ...request, model: "opus" },
      "claude"
    );
    expect(JSON.parse(selected.stdout).codemux.model).toBe("opus");
    const unnamedModel = claudeFamilyResult(finished(unnamed), request, "claude");
    expect(JSON.parse(unnamedModel.stdout).codemux.model).toBeNull();
  });

  test("stdout that is not the envelope fails loudly, verbatim on stdout", () => {
    // Exit 0 with plain-text stdout breaks the --output-format json
    // contract the launch made; a silent success would leave the caller
    // parsing nothing.
    const out = claudeFamilyResult(finished("plain text\n"), request, "claude");
    expect(out.stdout).toBe("plain text\n");
    expect(out.exitCode).toBe(1);
    expect(out.success).toBe(false);
    expect(out.stderr).toContain("printed no result envelope");
  });

  test("an empty JSON object fails loudly like any other non-envelope stdout", () => {
    // `{}` is the harder case: it parses, so only the type discriminator
    // separates it from the envelope the launch promised.
    const out = claudeFamilyResult(finished("{}\n"), request, "claude");
    expect(out.stdout).toBe("{}\n");
    expect(out.exitCode).toBe(1);
    expect(out.success).toBe(false);
    expect(out.stderr).toContain("printed no result envelope");
  });

  test("a bare result discriminator fails loudly, not silently succeeds", () => {
    // The finding's reproduction: `{"type":"result"}` with exit 0 produced
    // success: true -- a malformed wrapper response satisfying --result-json
    // while naming neither a result nor a status. An envelope carrying only
    // is_error still parses (it names an outcome) and fails downstream.
    const out = claudeFamilyResult(finished('{"type":"result"}\n'), request, "claude");
    expect(out.stdout).toBe('{"type":"result"}\n');
    expect(out.exitCode).toBe(1);
    expect(out.success).toBe(false);
    expect(out.stderr).toContain("printed no result envelope");
  });

  test("a failed process exit keeps the envelope and stays failed", () => {
    // The harness's own record still goes out with the block attached, but
    // the run's failed exit is not masked by a clean envelope.
    const out = claudeFamilyResult(
      { stdout: CLAUDE_ENVELOPE, stderr: "", exitCode: 2, success: false },
      request,
      "claude"
    );
    expect(JSON.parse(out.stdout).result).toBe("OK");
    expect(out.exitCode).toBe(2);
    expect(out.success).toBe(false);
    expect(JSON.parse(out.stdout).codemux.session_id).toBeNull();
  });

  test("a run served by several models reports no model, not the request's", () => {
    const multi = JSON.stringify({
      type: "result",
      result: "OK",
      modelUsage: { "claude-opus-5": {}, "claude-haiku-4.5": {} },
    });
    const out = claudeFamilyResult(
      finished(multi),
      { ...request, model: "opus" },
      "claude"
    );
    expect(JSON.parse(out.stdout).codemux.model).toBeNull();
  });

  test("an error envelope fails the run even with the harness's exit 0", () => {
    // The finding's reproduction: `is_error: true` with subtype
    // "error_during_execution" on exit 0 stayed success: true; a wrapper
    // that masks the harness's exit code cannot mask the structured
    // failure too.
    const error = JSON.stringify({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      result: "Api Error: 500",
      session_id: "8f14e45f-ea75-4c8f-9d0b-4bba9c9b1b1b",
    });
    const out = claudeFamilyResult(finished(error), request, "claude");
    const envelope = JSON.parse(out.stdout);
    // The harness's own record of the failure stays intact; the codemux
    // block and the exit code carry the verdict.
    expect(envelope.subtype).toBe("error_during_execution");
    expect(envelope.is_error).toBe(true);
    expect(envelope.result).toBe("Api Error: 500");
    expect(envelope.codemux.session_id).toBeNull();
    expect(out.exitCode).toBe(1);
    expect(out.success).toBe(false);
    expect(out.stderr).toContain("error result");
    expect(out.stderr).toContain("error_during_execution");
  });

  test("is_error without an error subtype fails the run too", () => {
    const flagged = JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: true,
      result: "OK",
    });
    const out = claudeFamilyResult(finished(flagged), request, "claude");
    expect(out.exitCode).toBe(1);
    expect(out.success).toBe(false);
    expect(out.stderr).toContain("is_error: true");
  });

  test("a subtype-only success envelope fails the run, not passes as one", () => {
    // Through the full path: the finding's reproduction returned exit 0
    // with a codemux block over an envelope that carried no reply at all.
    const out = claudeFamilyResult(
      finished('{"type":"result","subtype":"success"}\n'),
      request,
      "claude"
    );
    expect(out.stdout).toBe('{"type":"result","subtype":"success"}\n');
    expect(out.exitCode).toBe(1);
    expect(out.success).toBe(false);
    expect(out.stderr).toContain("printed no result envelope");
  });

  test("an envelope whose result text is empty fails the run", () => {
    // Round10: an empty result passed as a successful run -- the envelope
    // still goes out with the codemux block (its fields are the harness's
    // own record), but the exit is non-zero and stderr says why.
    const out = claudeFamilyResult(
      finished(
        JSON.stringify({
          type: "result",
          subtype: "success",
          result: "",
          session_id: "8f14e45f-ea75-4c8f-9d0b-4bba9c9b1b1b",
        })
      ),
      request,
      "claude"
    );
    expect(out.exitCode).toBe(1);
    expect(out.success).toBe(false);
    expect(out.stderr).toContain("no result text");
  });

  test("a whitespace-only reply is no reply", () => {
    // Round17: the check rejected only the empty string, while prompt
    // validation rejects trimmed-empty input -- a reply of spaces and
    // newlines passed as a successful run. It fails closed now, like the
    // empty reply.
    const envelope = JSON.stringify({
      type: "result",
      subtype: "success",
      session_id: "8f14e45f-ea75-4c8f-9d0b-4bba9c9b1b1b",
      result: " \n",
    });
    const out = claudeFamilyResult(finished(envelope), request, "claude");
    expect(out.exitCode).toBe(1);
    expect(out.success).toBe(false);
    expect(out.stderr).toContain("no result text");
  });

  test("diagnostics append after an unterminated stderr line, not onto it", () => {
    // Round10: appending glued the codemux line onto the harness's last
    // unterminated line, so "boom" became "boomcodemux: ..." and a caller
    // parsing stderr line by line lost both. Every append separates them,
    // on the Claude-family, Antigravity, and codex paths alike.
    const claudeOut = claudeFamilyResult(
      { stdout: "not json\n", stderr: "boom", exitCode: 0, success: true },
      request,
      "claude"
    );
    expect(claudeOut.stderr.startsWith("boom\ncodemux:")).toBe(true);
    expect(claudeOut.stderr).not.toContain("boomcodemux");
    const codexOut = codexResult(
      { stdout: "not jsonl\n", stderr: "boom", exitCode: 0, success: true },
      { agent: "codex", prompt: "p", resultJson: true }
    );
    expect(codexOut.stderr.startsWith("boom\ncodemux:")).toBe(true);
    expect(codexOut.stderr).not.toContain("boomcodemux");
    const agyOut = agyResult(
      { stdout: "not json\n", stderr: "boom", exitCode: 0, success: true },
      { agent: "agy", prompt: "p", resultJson: true }
    );
    expect(agyOut.stderr.startsWith("boom\ncodemux:")).toBe(true);
    expect(agyOut.stderr).not.toContain("boomcodemux");
  });
});

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
