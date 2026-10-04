import { describe, expect, test } from "bun:test";
import {
  CODEX_FINAL_MESSAGE_FALLBACK_NOTE,
  claudeFamilyResult,
  codexResult,
  codexStreamVerdict,
  emptyUsage,
  parseClaudeResultEnvelope,
  parseCodexEventStream,
} from "../src/result-envelope.js";
import type { RunRequest, RunResult } from "../src/types.js";

const CLAUDE_ENVELOPE = JSON.stringify({
  type: "result",
  subtype: "success",
  session_id: "8f14e45f-ea75-4c8f-9d0b-4bba9c9b1b1b",
  result: "OK",
  usage: {
    input_tokens: 24114,
    output_tokens: 98,
    cache_read_input_tokens: 300,
    cache_creation_input_tokens: 20,
  },
  total_cost_usd: 0.12735,
  modelUsage: { "claude-opus-5": {} },
});

function finished(stdout: string): RunResult {
  return { stdout, stderr: "", exitCode: 0, success: true };
}

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
    // on the Claude-family and codex paths alike.
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
  });
});

// Event shapes pinned against codex-rs/exec/src/exec_events.rs at
// rust-v0.159.3 (the installed codex-cli).
function codexStream(lines: object[]): string {
  return lines.map((line) => JSON.stringify(line)).join("\n") + "\n";
}

const CODEX_EVENTS = codexStream([
  { type: "thread.started", thread_id: "0192b8d4-4d4f-7c4a-9d0e-6f5a4b3c2d1e" },
  { type: "turn.started" },
  {
    type: "item.completed",
    item: { id: "item_0", type: "reasoning", text: "thinking..." },
  },
  {
    type: "item.completed",
    item: { id: "item_1", type: "agent_message", text: "first message" },
  },
  {
    type: "item.completed",
    item: { id: "item_2", type: "agent_message", text: "final message" },
  },
  {
    type: "turn.completed",
    usage: {
      input_tokens: 1000,
      cached_input_tokens: 600,
      cache_write_input_tokens: 200,
      output_tokens: 50,
      reasoning_output_tokens: 10,
    },
  },
]);

describe("parseCodexEventStream", () => {
  test("captures the thread, the last agent message, and the usage", () => {
    const stream = parseCodexEventStream(CODEX_EVENTS)!;
    expect(stream.threadId).toBe("0192b8d4-4d4f-7c4a-9d0e-6f5a4b3c2d1e");
    // The last agent_message, matching codex's own final-message choice.
    expect(stream.finalMessage).toBe("final message");
    // codex's input_tokens includes both cache reads and cache writes, so
    // the normalized uncached input subtracts each; both join the cached
    // count.
    expect(stream.usage).toEqual({
      input_tokens: 200,
      output_tokens: 50,
      cached_input_tokens: 800,
      total_tokens: 1050,
      cost_usd: null,
    });
  });

  test("cache writes are subtracted from the input, not added on top of it", () => {
    // Round25's double-count finding: codex reports cache writes as a
    // breakdown of input_tokens, not an addition to it, so counting them in
    // the input AND in the cached count billed every write twice -- the
    // finding's reproduction (input 1000, cached reads 600, cache writes
    // 200, output 50) returned total_tokens 1250 instead of 1050.
    const stream = parseCodexEventStream(codexStream([
      { type: "thread.started", thread_id: "t" },
      { type: "turn.started" },
      { type: "turn.completed", usage: { input_tokens: 1000, cached_input_tokens: 600, cache_write_input_tokens: 200, output_tokens: 50 } },
    ]))!;
    expect(stream.usage).toEqual({
      input_tokens: 200,
      output_tokens: 50,
      cached_input_tokens: 800,
      total_tokens: 1050,
      cost_usd: null,
    });
  });

  test("a reported zero cache count stays zero, keeping the total checkable", () => {
    const stream = parseCodexEventStream(codexStream([
      { type: "thread.started", thread_id: "t" },
      { type: "turn.started" },
      { type: "turn.completed", usage: { input_tokens: 10, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 5 } },
    ]))!;
    expect(stream.usage).toEqual({
      input_tokens: 10,
      output_tokens: 5,
      cached_input_tokens: 0,
      total_tokens: 15,
      cost_usd: null,
    });
  });

  test("cached input above total input clamps, and the total sums the clamped fields", () => {
    // Round19: the uncached input was clamped to zero when cached exceeded
    // the reported input, but total_tokens still summed the raw input -- so
    // the components the envelope published (0 + 10 + 1 = 11) disagreed
    // with the total they were promised to sum to (6). The total now sums
    // the three normalized fields.
    const stream = parseCodexEventStream(codexStream([
      { type: "thread.started", thread_id: "t" },
      { type: "turn.started" },
      { type: "turn.completed", usage: { input_tokens: 5, cached_input_tokens: 10, cache_write_input_tokens: 0, output_tokens: 1 } },
    ]))!;
    expect(stream.usage).toEqual({
      input_tokens: 0,
      output_tokens: 1,
      cached_input_tokens: 10,
      total_tokens: 11,
      cost_usd: null,
    });
  });

  test("an unreported input_tokens is null, never computed as zero", () => {
    // Format drift: a turn that reports only output_tokens must not gain a
    // fabricated input of 0, and the total (which needs the input) stays
    // null rather than being summed from the guess.
    const stream = parseCodexEventStream(codexStream([
      { type: "thread.started", thread_id: "t" },
      { type: "turn.started" },
      { type: "turn.completed", usage: { output_tokens: 5 } },
    ]))!;
    expect(stream.usage).toEqual({
      input_tokens: null,
      output_tokens: 5,
      cached_input_tokens: null,
      total_tokens: null,
      cost_usd: null,
    });
  });

  test("the total needs the cache-read count too, not just the fields it sums", () => {
    // Round17's contract finding: the total required only input, cache
    // write, and output, so a turn reporting everything BUT
    // cached_input_tokens produced a total while README promised one
    // "only when every component was reported" -- the uncached input and
    // the joined cached count both need the cache-read figure. All four
    // raw counts must be known for the sum.
    const stream = parseCodexEventStream(codexStream([
      { type: "thread.started", thread_id: "t" },
      { type: "turn.started" },
      { type: "turn.completed", usage: { input_tokens: 1000, cache_write_input_tokens: 200, output_tokens: 50 } },
    ]))!;
    expect(stream.usage).toEqual({
      input_tokens: null,
      output_tokens: 50,
      cached_input_tokens: null,
      total_tokens: null,
      cost_usd: null,
    });
  });

  test("a failed turn leaves no usage totals even when a later one completes", () => {
    // Round17: a completed turn's cumulative figure must not survive a
    // failure as exact usage -- the run's true total is that figure or
    // more, and an exact-looking number that understates a failed run is
    // worse than none.
    const stream = parseCodexEventStream(codexStream([
      { type: "thread.started", thread_id: "t" },
      { type: "turn.started" },
      { type: "turn.failed", error: { message: "Usage limit reached" } },
      { type: "turn.started" },
      { type: "turn.completed", usage: { input_tokens: 20, cached_input_tokens: 10, cache_write_input_tokens: 0, output_tokens: 5 } },
    ]))!;
    expect(stream.usage).toEqual(emptyUsage());
    expect(stream.usageReported).toBe(false);
  });

  test("an all-zero usage snapshot is codex's default, not a reported zero total", () => {
    // Round23: codex 0.159.3 fills turn.completed.usage with
    // Usage::default() -- every count zero -- when the thread never
    // received a token-usage update. A turn that completed has consumed
    // tokens, so four zeros are that synthetic snapshot; treating it as
    // reported usage published total_tokens: 0 for a nonempty completed
    // run. The fields stay null, like any unreported figure.
    const stream = parseCodexEventStream(codexStream([
      { type: "thread.started", thread_id: "t" },
      { type: "turn.started" },
      { type: "item.completed", item: { id: "item_0", type: "agent_message", text: "the reply" } },
      { type: "turn.completed", usage: { input_tokens: 0, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0 } },
    ]))!;
    expect(stream.usage).toEqual(emptyUsage());
    expect(stream.usageReported).toBe(false);
    expect(stream.finalMessage).toBe("the reply");
  });

  test("a stream without usage or messages stays null, not zero", () => {
    const stream = parseCodexEventStream(codexStream([
      { type: "thread.started", thread_id: "t" },
      { type: "turn.started" },
      { type: "turn.completed", usage: {} },
    ]))!;
    expect(stream.usage).toEqual(emptyUsage());
    expect(stream.finalMessage).toBeNull();
  });

  test("a line that is not a JSON object is drift, not data", () => {
    expect(parseCodexEventStream("not json\n")).toBeNull();
    expect(parseCodexEventStream("[1]\n")).toBeNull();
  });

  test("a failed turn discards the agent messages before it", () => {
    // Codex clears its own final message on TurnStatus::Failed even though
    // the item.completed events stay in the stream; partial output must
    // not pose as the result.
    const stream = parseCodexEventStream(codexStream([
      { type: "thread.started", thread_id: "t" },
      { type: "turn.started" },
      { type: "item.completed", item: { id: "item_0", type: "agent_message", text: "partial" } },
      { type: "turn.failed", error: { message: "Usage limit reached" } },
    ]))!;
    expect(stream.failure).toBe("Usage limit reached");
    expect(stream.finalMessage).toBeNull();
  });

  test("a stream whose turn never completed is marked incomplete", () => {
    // Upstream separates item completion from turn completion (a turn
    // "encompasses all events that happen while agent is processing the
    // prompt" and ends only at `turn.completed`), so a completed message
    // item without one is a truncated stream, not a result.
    const stream = parseCodexEventStream(codexStream([
      { type: "thread.started", thread_id: "0192b8d4-4d4f-7c4a-9d0e-6f5a4b3c2d1e" },
      { type: "turn.started" },
      { type: "item.completed", item: { id: "item_0", type: "agent_message", text: "partial" } },
    ]))!;
    expect(stream.turnCompleted).toBe(false);
    // The partial message stays visible for diagnostics; the verdict, not
    // the parser, refuses to call it the result.
    expect(stream.finalMessage).toBe("partial");
    expect(parseCodexEventStream(CODEX_EVENTS)!.turnCompleted).toBe(true);
  });

  test("turnCompleted means every turn closed and one completed, not that the run succeeded", () => {
    // The round12 doc finding, restated for the one-completed-turn grammar:
    // a stream whose turn failed and whose next turn completed reports
    // turnCompleted true -- the failure is `failure`'s to report, and every
    // consumer checks it before trusting this field. Pinned here so the
    // field's doc and its value cannot drift apart again.
    const stream = parseCodexEventStream(codexStream([
      { type: "thread.started", thread_id: "t" },
      { type: "turn.started" },
      { type: "item.completed", item: { id: "item_0", type: "agent_message", text: "earlier reply" } },
      { type: "turn.failed", error: { message: "Usage limit reached" } },
      { type: "turn.started" },
      { type: "turn.completed", usage: { input_tokens: 10, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 5 } },
    ]))!;
    expect(stream.turnCompleted).toBe(true);
    expect(stream.failure).toBe("Usage limit reached");
    expect(stream.finalMessage).toBeNull();
  });

  test("an error the harness retried is superseded by a later turn", () => {
    // ServerNotification::Error leaves the run Running (the JSONL processor
    // emits the event without shutting down): a later turn.completed means
    // the turn recovered, so the run did not fail.
    const stream = parseCodexEventStream(codexStream([
      { type: "thread.started", thread_id: "t" },
      { type: "turn.started" },
      { type: "error", message: "stream disconnected; retrying" },
      { type: "item.completed", item: { id: "item_0", type: "agent_message", text: "the reply" } },
      { type: "turn.completed", usage: { input_tokens: 10, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 5 } },
    ]))!;
    expect(stream.failure).toBeNull();
    expect(stream.finalMessage).toBe("the reply");
    expect(stream.usage.output_tokens).toBe(5);
  });

  test("a turn.failed with no message keeps the fallback literal", () => {
    const stream = parseCodexEventStream(codexStream([
      { type: "thread.started", thread_id: "t" },
      { type: "turn.started" },
      { type: "turn.failed", error: {} },
    ]))!;
    expect(stream.failure).toBe("turn failed");
  });

  test("a second thread.started is drift, not an announcement to ignore", () => {
    // The round7 finding: the case's comment called a second announcement
    // drift while the code silently ignored it, so a wrapper concatenating
    // two valid streams returned the second run's result with the first
    // run's thread. The reduction refuses the stream like any other
    // format drift.
    expect(parseCodexEventStream(codexStream([
      { type: "thread.started", thread_id: "first-thread" },
      { type: "thread.started", thread_id: "second-thread" },
    ]))).toBeNull();
  });

  test("an empty thread.started announcement names nothing and is refused", () => {
    // The thread id identifies the conversation this stream records; an
    // announcement without one names nothing, so it is drift like any
    // other malformed event.
    expect(parseCodexEventStream(codexStream([
      { type: "thread.started", thread_id: "" },
      { type: "turn.started" },
      { type: "turn.completed", usage: { input_tokens: 10, output_tokens: 2 } },
    ]))).toBeNull();
  });

  test("a thread.started after any other event is drift, not an announcement", () => {
    // The round9 finding: the ordering the grammar documents (thread.started
    // opens the stream) was not enforced, so turn.started, a message, and a
    // completed turn followed by thread.started parsed successfully and the
    // completed response could pair with an unrelated thread.
    expect(parseCodexEventStream(codexStream([
      { type: "turn.started" },
      { type: "item.completed", item: { id: "item_0", type: "agent_message", text: "the reply" } },
      { type: "turn.completed", usage: { input_tokens: 10, output_tokens: 2 } },
      { type: "thread.started", thread_id: "0192b8d4-4d4f-7c4a-9d0e-6f5a4b3c2d1e" },
    ]))).toBeNull();
  });

  test("a turn.started inside an open turn is drift, not a nested turn", () => {
    // The round9 finding: nested turns were counted, so a wrapper
    // concatenating streams that dropped the first turn's terminal event
    // let the tail's events close as a turn of this stream.
    expect(parseCodexEventStream(codexStream([
      { type: "thread.started", thread_id: "t" },
      { type: "turn.started" },
      { type: "turn.started" },
      { type: "turn.completed", usage: { input_tokens: 10, output_tokens: 2 } },
    ]))).toBeNull();
  });

  test("a turn.completed no turn.started opened is drift, not a count to clamp", () => {
    // The round-8 finding: an unmatched terminal event was clamped to zero
    // open turns, so the tail of a prefix-truncated stream (or a wrapper's
    // splice) posed as a complete run. Every terminal event must match an
    // open turn; anything else is refused.
    expect(parseCodexEventStream(codexStream([
      { type: "thread.started", thread_id: "t" },
      { type: "item.completed", item: { id: "item_0", type: "agent_message", text: "the reply" } },
      { type: "turn.completed", usage: { input_tokens: 10, output_tokens: 2 } },
    ]))).toBeNull();
    // The failed-terminal twin, for the same reason.
    expect(parseCodexEventStream(codexStream([
      { type: "thread.started", thread_id: "t" },
      { type: "turn.failed", error: { message: "Usage limit reached" } },
    ]))).toBeNull();
  });

  test("a turn.failed is terminal: a later completed turn does not clear it", () => {
    // The round-8 finding: turn.completed cleared the failure
    // unconditionally, so a stream whose turn failed and whose next turn
    // completed read as success. Upstream discards a failed turn's final
    // message and no later event un-fails the run that reported it; only a
    // top-level `error` is superseded (the retried-error test above).
    const stream = parseCodexEventStream(codexStream([
      { type: "thread.started", thread_id: "0192b8d4-4d4f-7c4a-9d0e-6f5a4b3c2d1e" },
      { type: "turn.started" },
      { type: "item.completed", item: { id: "item_0", type: "agent_message", text: "partial" } },
      { type: "turn.failed", error: { message: "Usage limit reached" } },
      { type: "turn.started" },
      { type: "item.completed", item: { id: "item_1", type: "agent_message", text: "retry reply" } },
      { type: "turn.completed", usage: { input_tokens: 10, output_tokens: 2 } },
    ]))!;
    expect(stream.failure).toBe("Usage limit reached");
    expect(stream.finalMessage).toBeNull();
    // Through the verdict: the failure stands.
    expect(
      codexStreamVerdict(stream, { stdout: "", stderr: "", exitCode: 0, success: true })
    ).toEqual({ failed: true, diagnostic: expect.stringContaining("Usage limit reached") });
    const out = codexResult(
      {
        stdout: codexStream([
          { type: "thread.started", thread_id: "0192b8d4-4d4f-7c4a-9d0e-6f5a4b3c2d1e" },
          { type: "turn.started" },
          { type: "turn.failed", error: { message: "Usage limit reached" } },
          { type: "turn.started" },
          { type: "item.completed", item: { id: "item_0", type: "agent_message", text: "retry reply" } },
          { type: "turn.completed", usage: { input_tokens: 10, output_tokens: 2 } },
        ]),
        stderr: "",
        exitCode: 0,
        success: true,
      },
      { agent: "codex", prompt: "t", resultJson: true }
    );
    expect(out.success).toBe(false);
    expect(out.exitCode).toBe(1);
    expect(JSON.parse(out.stdout).codemux.session_id).toBeNull();
    expect(out.stderr).toContain("Usage limit reached");
  });

  test("a second turn after a completed one is drift: one run is one turn", () => {
    // The round19 finding: the parser accepted multiple sequential
    // completed turns after one thread.started, so a concatenated or
    // malformed stream returned the second run's result while the stream's
    // single announcement named the first run's thread. A turn.started
    // after any turn.completed is refused now, exactly like the second
    // thread.started -- and through codexResult the raw stream is kept and
    // the run fails, so the second turn's reply cannot pose as this run's
    // result.
    const stream = codexStream([
      { type: "thread.started", thread_id: "0192b8d4-4d4f-7c4a-9d0e-6f5a4b3c2d1e" },
      { type: "turn.started" },
      { type: "item.completed", item: { id: "item_0", type: "agent_message", text: "first run's reply" } },
      { type: "turn.completed", usage: { input_tokens: 10, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 5 } },
      { type: "turn.started" },
      { type: "item.completed", item: { id: "item_1", type: "agent_message", text: "second run's reply" } },
      { type: "turn.completed", usage: { input_tokens: 20, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 5 } },
    ]);
    expect(parseCodexEventStream(stream)).toBeNull();
    const out = codexResult(
      finished(stream),
      { agent: "codex", prompt: "p", resultJson: true }
    );
    expect(out.stdout).toBe(stream);
    expect(out.exitCode).toBe(1);
    expect(out.success).toBe(false);
    expect(out.stderr).toContain("cannot parse");
  });

  test("any item event after the last turn.completed is drift, not only an agent message", () => {
    // Round23: the ordering rule covered only a trailing agent_message, so
    // a recognized reasoning or tool item completing after turn.completed
    // -- or an item.started/item.updated arriving there -- was accepted
    // and the completed turn's response returned successfully. Items
    // belong inside turns, so every shape is refused as the drift of a
    // concatenated or truncated stream.
    const trailing = (eventType: string, item: object): string =>
      codexStream([
        { type: "thread.started", thread_id: "t" },
        { type: "turn.started" },
        { type: "item.completed", item: { id: "item_0", type: "agent_message", text: "the reply" } },
        { type: "turn.completed", usage: { input_tokens: 10, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 5 } },
        { type: eventType, item },
      ]);
    expect(parseCodexEventStream(trailing("item.completed", { id: "item_1", type: "reasoning", text: "thinking" }))).toBeNull();
    expect(parseCodexEventStream(trailing("item.completed", { id: "item_1", type: "command_execution", command: "grep -r secret .", aggregated_output: "", exit_code: 0 }))).toBeNull();
    expect(parseCodexEventStream(trailing("item.started", { id: "item_1", type: "reasoning", text: "thinking" }))).toBeNull();
    expect(parseCodexEventStream(trailing("item.updated", { id: "item_1", type: "reasoning", text: "thinking" }))).toBeNull();
    // Inside a turn, the same events are ordinary stream content: the
    // grammar emits item.started/item.updated there, and the reduction
    // keeps reading the message that follows them.
    const inTurn = parseCodexEventStream(codexStream([
      { type: "thread.started", thread_id: "t" },
      { type: "turn.started" },
      { type: "item.started", item: { id: "item_0", type: "reasoning", text: "" } },
      { type: "item.updated", item: { id: "item_0", type: "reasoning", text: "thinking" } },
      { type: "item.completed", item: { id: "item_1", type: "agent_message", text: "the reply" } },
      { type: "turn.completed", usage: { input_tokens: 10, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 5 } },
    ]))!;
    expect(inTurn.finalMessage).toBe("the reply");
    expect(inTurn.turnCompleted).toBe(true);
  });

  test("an empty stream is a parse failure: the grammar opens with thread.started", () => {
    // The round-8 strict grammar: every stream the reduction is documented
    // to read opens with its one thread.started announcement, and "" carries
    // no events at all. Parsing it to a nulls-everywhere stream left the
    // verdict to fail it as a messageless run; now the reduction rejects it
    // like any other drift and codexResult fails it with the raw stdout
    // kept (see the codexResult test below).
    expect(parseCodexEventStream("")).toBeNull();
  });

  test("a reroute item names the model that served the run, the last one winning", () => {
    // Codex 0.159.3 reports a rerouted model as a completed `error` item
    // (ModelRerouted in exec_events.rs), message formatted `model rerouted:
    // <from> -> <to> (<reason>)` with the reason Debug-formatted upstream --
    // matched here as one unit, so a reason carrying parentheses (an
    // `Other("...")` say) still parses. A reroute is not a failure: the
    // stream's failure channels are turn.failed and the top-level error
    // event, so the turn completes and the message stands.
    const stream = parseCodexEventStream(codexStream([
      { type: "thread.started", thread_id: "0192b8d4-4d4f-7c4a-9d0e-6f5a4b3c2d1e" },
      { type: "turn.started" },
      {
        type: "item.completed",
        item: { id: "item_0", type: "error", message: "model rerouted: gpt-5.3 -> gpt-5.3-codex (Unavailable)" },
      },
      { type: "item.completed", item: { id: "item_1", type: "agent_message", text: "reply" } },
      {
        type: "item.completed",
        item: { id: "item_2", type: "error", message: "model rerouted: gpt-5.3-codex -> gpt-5.3-mini (Other(\"x -> y\"))" },
      },
      { type: "turn.completed", usage: { input_tokens: 10, output_tokens: 2 } },
    ]))!;
    // The last reroute supersedes: an earlier one named a model a later one
    // replaced.
    expect(stream.servedModel).toBe("gpt-5.3-mini");
    expect(stream.failure).toBeNull();
    expect(stream.turnCompleted).toBe(true);
    expect(stream.finalMessage).toBe("reply");
  });

  test("a reroute message outside the documented shape attributes nothing", () => {
    // The format is pinned against 0.159.3, and a message that does not
    // match it is not guessed from: attribution stays null (the request's
    // model shows through in the envelope) rather than half-parsed. An
    // unrecognized error item is not drift the way an agent_message with a
    // non-string text is -- nothing this reduction reports depends on it.
    const stream = parseCodexEventStream(codexStream([
      { type: "thread.started", thread_id: "0192b8d4-4d4f-7c4a-9d0e-6f5a4b3c2d1e" },
      { type: "turn.started" },
      {
        type: "item.completed",
        // No parenthetical reason: not the shape the format string builds.
        item: { id: "item_0", type: "error", message: "model rerouted: gpt-5.3 -> gpt-5.3-codex" },
      },
      {
        type: "item.completed",
        item: { id: "item_1", type: "error", message: "something else entirely" },
      },
      { type: "turn.completed", usage: { input_tokens: 10, output_tokens: 2 } },
    ]))!;
    expect(stream).not.toBeNull();
    expect(stream.servedModel).toBeNull();
    expect(stream.failure).toBeNull();
  });
});

describe("codexResult", () => {
  const request: RunRequest = { agent: "codex", prompt: "p", resultJson: true };

  test("builds the envelope codemux promised: result text plus the block", () => {
    const out = codexResult(finished(CODEX_EVENTS), request);
    const envelope = JSON.parse(out.stdout);
    expect(Object.keys(envelope).sort()).toEqual(["codemux", "result"]);
    expect(envelope.result).toBe("final message");
    expect(envelope.codemux).toEqual({
      agent: "codex",
      model: null,
      usage: {
        input_tokens: 200,
        output_tokens: 50,
        cached_input_tokens: 800,
        total_tokens: 1050,
        cost_usd: null,
      },
      // The run launched with --ephemeral: the stream names a thread id,
      // but no later run can resume it, so it is not reported as though
      // one could.
      session_id: null,
    });
  });

  test("carries the selected model when the stream names none", () => {
    const out = codexResult(finished(CODEX_EVENTS), { ...request, model: "gpt-5.3-codex" });
    expect(JSON.parse(out.stdout).codemux.model).toBe("gpt-5.3-codex");
  });

  test("a rerouted run is attributed to the model that served it", () => {
    // The finding: the parser discarded the reroute item, so a run the
    // harness served with a different model reported the requested one (or
    // null) despite codex naming the served model in the stream. The
    // envelope's model is the served model now, and a stderr note says the
    // run was rerouted, so an operator who selected gpt-5.3 does not read
    // the reply as though gpt-5.3 wrote it.
    const rerouted = codexStream([
      { type: "thread.started", thread_id: "0192b8d4-4d4f-7c4a-9d0e-6f5a4b3c2d1e" },
      { type: "turn.started" },
      {
        type: "item.completed",
        item: { id: "item_0", type: "error", message: "model rerouted: gpt-5.3 -> gpt-5.3-codex (Unavailable)" },
      },
      { type: "item.completed", item: { id: "item_1", type: "agent_message", text: "reply" } },
      { type: "turn.completed", usage: { input_tokens: 10, output_tokens: 2 } },
    ]);
    const out = codexResult(finished(rerouted), { ...request, model: "gpt-5.3" });
    const envelope = JSON.parse(out.stdout);
    expect(out.success).toBe(true);
    expect(envelope.result).toBe("reply");
    expect(envelope.codemux.model).toBe("gpt-5.3-codex");
    expect(out.stderr).toContain("rerouted");
    expect(out.stderr).toContain("served by gpt-5.3-codex");
    expect(out.stderr).toContain("not the requested gpt-5.3");
  });

  test("an unparseable stream keeps the raw stdout and fails the run", () => {
    // The documented contract (README, CHANGELOG) keeps the raw stdout for
    // inspection when the JSON promise breaks; the envelope path used to
    // overwrite it with a null-only envelope, so the bytes appeared
    // nowhere. No envelope is emitted, like the Claude-family path.
    const out = codexResult(finished("human-mode text\n"), request);
    expect(out.stdout).toBe("human-mode text\n");
    expect(out.exitCode).toBe(1);
    expect(out.success).toBe(false);
    expect(out.stderr).toContain("cannot parse");
  });

  test("a truncated stream from a zero-exit wrapper fails, not poses as done", () => {
    // The finding's reproduction: a wrapper like `codex-real "$@" | sed
    // '$d'` drops the final event yet exits 0. Item completion is not turn
    // completion (exec_events.rs), so an agent_message item alone used to
    // pass as the result.
    const out = codexResult(
      finished(codexStream([
        { type: "thread.started", thread_id: "0192b8d4-4d4f-7c4a-9d0e-6f5a4b3c2d1e" },
        { type: "turn.started" },
        { type: "item.completed", item: { id: "item_0", type: "agent_message", text: "commentary" } },
      ])),
      request
    );
    const envelope = JSON.parse(out.stdout);
    expect(envelope.result).toBeNull();
    expect(envelope.codemux.session_id).toBeNull();
    expect(out.exitCode).toBe(1);
    expect(out.success).toBe(false);
    expect(out.stderr).toContain("turn.completed");
  });

  test("an empty stream with codex's exit 0 is a parse failure, not a null envelope", () => {
    // No events at all is not the event stream the launch asked for; before
    // strict parsing it built a successful-looking envelope with nulls
    // everywhere. Now the raw (empty) stdout stays and no envelope is
    // emitted, like any other drift.
    const out = codexResult(finished(""), request);
    expect(out.stdout).toBe("");
    expect(out.exitCode).toBe(1);
    expect(out.success).toBe(false);
    expect(out.stderr).toContain("cannot parse");
  });

  test("a turn with no agent message reports result null", () => {
    const out = codexResult(
      finished(codexStream([{ type: "thread.started", thread_id: "t" }])),
      request
    );
    expect(JSON.parse(out.stdout).result).toBeNull();
  });

  test("a stream that ends without a final assistant message fails the run", () => {
    // A turn may complete without an agent_message item (an interrupted
    // turn keeps no final message either); the run still needs a result.
    const out = codexResult(
      finished(codexStream([
        { type: "thread.started", thread_id: "t" },
        { type: "turn.started" },
        { type: "item.completed", item: { id: "item_0", type: "reasoning", text: "thinking" } },
        { type: "turn.completed", usage: { input_tokens: 10, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 5 } },
      ])),
      request
    );
    const envelope = JSON.parse(out.stdout);
    expect(envelope.result).toBeNull();
    expect(out.exitCode).toBe(1);
    expect(out.success).toBe(false);
    expect(out.stderr).toContain("without a final assistant message");
  });

  test("a failed turn fails the run on every channel", () => {
    // The finding's reproduction: a usage-limit turn.failed with codex's
    // own exit 0 produced empty stderr under --result-json. Now the exit
    // is forced non-zero, the partial message is not the result, and the
    // diagnostic rides on stderr.
    const out = codexResult(
      finished(codexStream([
        { type: "thread.started", thread_id: "0192b8d4-4d4f-7c4a-9d0e-6f5a4b3c2d1e" },
        { type: "turn.started" },
        { type: "item.completed", item: { id: "item_0", type: "agent_message", text: "partial" } },
        { type: "turn.failed", error: { message: "Usage limit reached" } },
      ])),
      request
    );
    const envelope = JSON.parse(out.stdout);
    expect(envelope.result).toBeNull();
    expect(envelope.codemux.session_id).toBeNull();
    expect(out.exitCode).toBe(1);
    expect(out.success).toBe(false);
    expect(out.stderr).toContain("Usage limit reached");
  });

  test("a failed envelope carries null usage even from a complete stream", () => {
    // Round23: a complete event stream paired with codex's own non-zero
    // exit correctly failed the run, but the envelope still carried the
    // stream's snapshot as exact usage. A failed run reports null fields
    // on every channel -- an exact-looking total for a run whose end the
    // harness itself called failed is worse than none.
    const out = codexResult(
      { stdout: CODEX_EVENTS, stderr: "", exitCode: 1, success: false },
      request
    );
    const envelope = JSON.parse(out.stdout);
    expect(envelope.result).toBeNull();
    expect(envelope.codemux.usage).toEqual(emptyUsage());
    expect(out.exitCode).toBe(1);
    expect(out.success).toBe(false);
  });

  test("a failed run's envelope carries null usage, not the last snapshot", () => {
    // Round17: a completed turn's cumulative figure used to survive the
    // failure as exact usage for a run that failed past it. The verdict
    // fails the run, so the usage fields are null -- incomplete totals are
    // not presented as exact.
    const out = codexResult(
      finished(codexStream([
        { type: "thread.started", thread_id: "0192b8d4-4d4f-7c4a-9d0e-6f5a4b3c2d1e" },
        { type: "turn.started" },
        { type: "turn.failed", error: { message: "Usage limit reached" } },
        { type: "turn.started" },
        { type: "item.completed", item: { id: "item_0", type: "agent_message", text: "first" } },
        { type: "turn.completed", usage: { input_tokens: 20, cached_input_tokens: 10, cache_write_input_tokens: 0, output_tokens: 5 } },
      ])),
      request
    );
    const envelope = JSON.parse(out.stdout);
    expect(envelope.codemux.usage).toEqual(emptyUsage());
    expect(out.success).toBe(false);
  });

  test("a whitespace-only final message is no message", () => {
    // Round17: the verdict rejected only the empty string, so a completed
    // turn whose one agent_message carried spaces and newlines passed as a
    // successful run with a whitespace result -- the same gap the Claude
    // envelope path had for `result: " \\n"`.
    const out = codexResult(
      finished(codexStream([
        { type: "thread.started", thread_id: "0192b8d4-4d4f-7c4a-9d0e-6f5a4b3c2d1e" },
        { type: "turn.started" },
        { type: "item.completed", item: { id: "item_0", type: "agent_message", text: " \n" } },
        { type: "turn.completed", usage: { input_tokens: 20, cached_input_tokens: 10, cache_write_input_tokens: 0, output_tokens: 5 } },
      ])),
      request
    );
    expect(out.exitCode).toBe(1);
    expect(out.success).toBe(false);
    expect(out.stderr).toContain("without a final assistant message");
  });

  test("an agent message after the last turn.completed is drift, not a result", () => {
    // The round6 finding: an item.completed arriving after turn.completed
    // replaced the final message with no turn reopened, so a truncated or
    // concatenated stream could return its trailing uncompleted message as
    // a successful result. The reduction now refuses the stream outright.
    const stream = codexStream([
      { type: "thread.started", thread_id: "0192b8d4-4d4f-7c4a-9d0e-6f5a4b3c2d1e" },
      { type: "turn.started" },
      {
        type: "item.completed",
        item: { id: "item_0", type: "agent_message", text: "completed turn's message" },
      },
      { type: "turn.completed", usage: { input_tokens: 10, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 5 } },
      // Drift: no turn.started reopened a turn, yet an agent message
      // completes -- the shape a wrapper concatenating two streams makes.
      {
        type: "item.completed",
        item: { id: "item_1", type: "agent_message", text: "trailing uncompleted message" },
      },
    ]);
    expect(parseCodexEventStream(stream)).toBeNull();
    const out = codexResult(finished(stream), request);
    // Fail closed with the raw stream kept verbatim, like any other drift.
    expect(out.stdout).toBe(stream);
    expect(out.exitCode).toBe(1);
    expect(out.success).toBe(false);
    expect(out.stderr).toContain("cannot parse");
  });

  test("two concatenated complete streams fail closed, raw stdout kept", () => {
    // The round7 finding: the second thread.started was silently ignored,
    // so a wrapper concatenating two valid streams could pair run two's
    // final message with run one's thread. The reduction refuses the
    // concatenation at the second announcement.
    const oneRun = codexStream([
      { type: "thread.started", thread_id: "0192b8d4-4d4f-7c4a-9d0e-6f5a4b3c2d1e" },
      { type: "turn.started" },
      { type: "item.completed", item: { id: "item_0", type: "agent_message", text: "run one reply" } },
      { type: "turn.completed", usage: { input_tokens: 10, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 5 } },
    ]);
    const concatenated = `${oneRun}${oneRun}`;
    expect(parseCodexEventStream(concatenated)).toBeNull();
    const out = codexResult(finished(concatenated), request);
    expect(out.stdout).toBe(concatenated);
    expect(out.exitCode).toBe(1);
    expect(out.success).toBe(false);
    expect(out.stderr).toContain("cannot parse");
  });

  test("a plan-only turn succeeds through the recorded final message", () => {
    // The finding's reproduction: codex 0.159.3 ends some successful turns
    // with a Plan item and no agent_message, and its JSONL mapper drops the
    // item, so the stream alone made a valid completed run exit 1. The final
    // message codex itself records (--output-last-message) is the result,
    // with the note saying where it came from.
    const planOnly = codexStream([
      { type: "thread.started", thread_id: "0192b8d4-4d4f-7c4a-9d0e-6f5a4b3c2d1e" },
      { type: "turn.started" },
      { type: "item.completed", item: { id: "item_0", type: "reasoning", text: "thinking" } },
      { type: "turn.completed", usage: { input_tokens: 10, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 5 } },
    ]);
    const out = codexResult(
      finished(planOnly),
      request,
      "1. Inspect the tree.\n2. Plan the change."
    );
    const envelope = JSON.parse(out.stdout);
    expect(envelope.result).toBe("1. Inspect the tree.\n2. Plan the change.");
    expect(envelope.codemux.session_id).toBeNull();
    expect(out.exitCode).toBe(0);
    expect(out.success).toBe(true);
    expect(out.stderr).toContain(CODEX_FINAL_MESSAGE_FALLBACK_NOTE);
  });

  test("a plan-only turn with nothing recorded still fails", () => {
    // The fallback is a supplement, not a bypass: codex wrote no final
    // message anywhere, so there is no result to report.
    const out = codexResult(
      finished(codexStream([
        { type: "thread.started", thread_id: "t" },
        { type: "turn.started" },
        { type: "turn.completed", usage: { input_tokens: 10, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 5 } },
      ])),
      request,
      null
    );
    expect(JSON.parse(out.stdout).result).toBeNull();
    expect(out.exitCode).toBe(1);
    expect(out.success).toBe(false);
    expect(out.stderr).not.toContain(CODEX_FINAL_MESSAGE_FALLBACK_NOTE);
  });

  test("the recorded message does not displace the stream's own", () => {
    // The stream is the documented source; the file only supplies what the
    // mapper drops, so a stream that carries its own agent_message stands
    // and no note is added.
    const out = codexResult(finished(CODEX_EVENTS), request, "recorded but unused");
    expect(JSON.parse(out.stdout).result).toBe("final message");
    expect(out.exitCode).toBe(0);
    expect(out.stderr).not.toContain(CODEX_FINAL_MESSAGE_FALLBACK_NOTE);
  });

  test("the recorded message does not rescue a failed turn", () => {
    // Upstream itself discards the final message on TurnStatus::Failed, so
    // a file written anyway (or planted) cannot turn the failure into a
    // result.
    const out = codexResult(
      finished(codexStream([
        { type: "thread.started", thread_id: "t" },
        { type: "turn.started" },
        { type: "turn.failed", error: { message: "Usage limit reached" } },
      ])),
      request,
      "planted after the failure"
    );
    expect(JSON.parse(out.stdout).result).toBeNull();
    expect(out.exitCode).toBe(1);
    expect(out.success).toBe(false);
    expect(out.stderr).toContain("Usage limit reached");
    expect(out.stderr).not.toContain(CODEX_FINAL_MESSAGE_FALLBACK_NOTE);
  });

  test("an agent_message with malformed text is drift, not an item to skip", () => {
    // Round10: a recognized agent_message whose text was not a string was
    // silently ignored, so a nonempty --output-last-message fallback could
    // pass the malformed stream off as a successful Plan-only run. The
    // stream is the documented source; one it cannot carry fails closed.
    const malformed = codexStream([
      { type: "thread.started", thread_id: "t" },
      { type: "turn.started" },
      { type: "item.completed", item: { id: "item_0", type: "agent_message", text: 42 } },
      { type: "turn.completed", usage: { input_tokens: 10, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 5 } },
    ]);
    expect(parseCodexEventStream(malformed)).toBeNull();
    const out = codexResult(finished(malformed), request, "1. a plan");
    expect(out.exitCode).toBe(1);
    expect(out.success).toBe(false);
    expect(out.stdout).toBe(malformed);
    expect(out.stderr).toContain("cannot parse");
    expect(out.stderr).not.toContain(CODEX_FINAL_MESSAGE_FALLBACK_NOTE);
  });

  test("an empty agent message is no message, and a recorded one does not paper over it", () => {
    // Round10: the verdict required a final message but accepted the empty
    // one, so a completed turn whose only agent_message carried empty text
    // passed as a successful run with result "" -- the codex half of the
    // empty-response finding. result null, exit 1.
    const out = codexResult(
      finished(codexStream([
        { type: "thread.started", thread_id: "0192b8d4-4d4f-7c4a-9d0e-6f5a4b3c2d1e" },
        { type: "turn.started" },
        { type: "item.completed", item: { id: "item_0", type: "agent_message", text: "" } },
        { type: "turn.completed", usage: { input_tokens: 10, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 5 } },
      ])),
      request,
      "planted over the empty message"
    );
    const envelope = JSON.parse(out.stdout);
    expect(envelope.result).toBeNull();
    expect(envelope.codemux.session_id).toBeNull();
    expect(out.exitCode).toBe(1);
    expect(out.success).toBe(false);
    expect(out.stderr).toContain("without a final assistant message");
  });
});
