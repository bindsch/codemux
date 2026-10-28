import { describe, expect, test } from "bun:test";
import {
  emptyUsage,
  parseCodexEventStream,
} from "../src/result-envelope.js";
import {
  CODEX_EVENTS,
  codexStream,
} from "./helpers/result-envelope.js";

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
    expect(stream.warnings).toContain("stream disconnected; retrying");
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
});
