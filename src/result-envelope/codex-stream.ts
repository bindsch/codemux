import type { ResultUsageBlock } from "../types.js";
import { CodexEventReducer } from "./codex-reducer.js";

export interface CodexEventStream {
  /**
   * The thread codex started, from the single `thread.started` event the
   * grammar promises (a stream without one is rejected at parse).
   */
  threadId: string;
  /**
   * The final assistant message: the last completed `agent_message` item of
   * the stream's LAST turn, which is what codex's own human mode prints on
   * stdout (`final_message_from_turn_items` picks the last AgentMessage).
   * Null when that turn completed without one, and null when the stream
   * failed: a failed turn has no final message, and codex itself discards it
   * (`self.final_message = None` on TurnStatus::Failed) even though earlier
   * `item.completed` events stay in the stream.
   */
  finalMessage: string | null;
  /**
   * The model that served the run when codex rerouted it: a reroute is
   * reported as a completed `error` item whose `message` reads
   * `model rerouted: <from> -> <to> (<reason>)` (exec_events.rs at 0.159.3
   * formats ModelRerouted that way), and the model that answers can then
   * differ from the one codemux selected. Null when the stream reports no
   * reroute; the stream names no model otherwise.
   */
  servedModel: string | null;
  /** This run's token usage, as far as the stream can express it. */
  usage: ResultUsageBlock;
  /**
   * Whether the LAST `turn.completed` carried a usage figure. Each snapshot
   * replaces the previous one, so an earlier turn's figure does not count:
   * a last turn that omits usage leaves the fields null. A failed stream
   * reports no usage at all, so this is false alongside null fields there.
   */
  usageReported: boolean;
  /**
   * Whether every turn the stream opened closed, and at least one closed by
   * completing -- not "the last turn completed": a stream whose last turn
   * failed after an earlier one completed still reports true here, and the
   * failure is `failure`'s to report (every consumer checks `failure`
   * before trusting this field). Item completion is not turn completion
   * upstream (exec_events.rs: a turn "encompasses all events that happen
   * while agent is processing the prompt", and `turn.completed` is emitted
   * when it finishes), so a stream that stops after an `item.completed` --
   * a truncated stream from a zero-exit wrapper, say -- has a message but
   * no completed turn behind it.
   */
  turnCompleted: boolean;
  /**
   * The failure diagnostic: the message of a `turn.failed` event (terminal:
   * no later event clears it) or of the last `error` event that no later
   * matched `turn.completed` superseded, or null when every turn completed.
   * An `error` codex retried is superseded when its turn later completes.
   */
  failure: string | null;
  /** Retained diagnostics, including errors followed by successful recovery. */
  warnings: string[];
}

/**
 * Reduces the JSONL event stream `codex exec --json` prints on stdout. The
 * event shapes are pinned against the installed codex-cli 0.159.3 (tag
 * rust-v0.159.3), where they are defined in codex-rs/exec/src/exec_events.rs:
 * `thread.started` carries `thread_id`, `turn.started` opens a turn,
 * `item.completed` carries an `agent_message` item with `text`, and a model
 * reroute as an `error` item whose `message` reads
 * `model rerouted: <from> -> <to> (<reason>)`,
 * `turn.completed` carries `usage`, `turn.failed` carries
 * `error: {message}`, and a top-level `error` event carries `message` (a
 * fatal error from the event stream; one that will be retried is followed
 * by a later `turn.completed`).
 *
 * Two semantics come from how exec builds those events
 * (codex-rs/exec/src/event_processor_with_jsonl_output.rs, same tag):
 *
 * - `turn.completed.usage` is the thread's cumulative total, not this turn's
 *   share: `usage_from_last_total` copies `last_total_token_usage`, fed by
 *   ThreadTokenUsageUpdated, whose `total` is the running thread counter
 *   (codex-protocol's TokenUsageInfo keeps `total_token_usage` and
 *   `last_token_usage` apart, and the exec stream exposes only the total).
 *   A thread this run started makes the last snapshot this run's usage, and
 *   the counter is a thread-lifetime total (a resumed thread's snapshot
 *   would include every earlier run), so the reduction keeps the last
 *   snapshot rather than summing snapshots; every codemux run starts its
 *   own thread (`--ephemeral`), so no run's snapshot carries another's.
 * - a failed turn discards the final message, yet the stream keeps any
 *   earlier `item.completed` agent messages, so the reduction refuses to
 *   offer one as the result.
 *
 * Plan items are the one message the stream cannot carry: codex treats the
 * last `Plan` as the turn's final message (`final_message_from_turn_items`
 * falls back to it), but the JSONL mapper drops the item
 * (`map_item_with_id` has no Plan arm), so a turn that ends with only a
 * Plan leaves no message in the stream at all. The caller cannot tell that
 * turn from one that produced nothing, so the reduction leaves
 * `finalMessage` null and the final message codex itself records through
 * `--output-last-message` is the fallback (see
 * `CODEX_FINAL_MESSAGE_FALLBACK_NOTE`).
 *
 * Codex's `input_tokens` INCLUDES its cache breakdowns: the cached reads
 * AND the cache writes are each parts of that total, not additions to it
 * (responses.rs maps `ResponseCompletedUsage` with both as breakdowns;
 * `blended_total` in event_processor_with_human_output.rs subtracts the
 * reads to discount them). The normalized uncached input is therefore
 * `input - cached - cacheWrite`, and both breakdowns join the cached count.
 *
 * Returns null when a line is not a JSON object, when the stream announces
 * no thread, a second one, or one that is not the stream's first event,
 * when a `turn.completed` or `turn.failed` closes a turn no `turn.started`
 * opened, when a `turn.started` opens inside a turn still open or after a
 * turn already completed, or when an item event that needs a turn arrives
 * outside one (round al34, edges major 3: the event grammar nests items
 * inside turns, and a pre-turn item could overwrite servedModel — a
 * reroute notice — onto a run whose turns that model never served; round
 * al35, correctness major 1, carved out the one item that does not need
 * a turn: a startup warning — a completed `error` item whose message is
 * retained as a warning — may arrive between `thread.started` and
 * `turn.started`, for codex reports initialization warnings there — an
 * empty key under `[otel.span_attributes]`, a deprecation notice — and
 * the run they annotate still succeeds): all are format drift,
 * and the caller says so rather than reporting a partial stream as fact.
 */
export function parseCodexEventStream(stdout: string): CodexEventStream | null {
  const reducer = new CodexEventReducer();
  for (const line of stdout.split("\n")) {
    if (line.trim() === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return null;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return null;
    }
    // The first violation is enough: a stream with any drift is not the
    // event stream this reduction is documented to read.
    if (reducer.drift !== null) return null;
    reducer.takeEvent(parsed as Record<string, unknown>);
  }
  if (reducer.drift !== null || reducer.sawThreadStarted === false) return null;
  return reducer.toStream();
}
