import { describe, expect, test } from "bun:test";
import {
  agyResult,
  claudeFamilyResult,
  codexResult,
  emptyUsage,
  parseClaudeResultEnvelope,
} from "../src/result-envelope.js";
import type { RunRequest } from "../src/types.js";
import {
  CLAUDE_ENVELOPE,
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
