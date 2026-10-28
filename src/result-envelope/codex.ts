import type { CodemuxResultBlock, RunRequest, RunResult } from "../types.js";
import { appendDiagnostic, emptyUsage } from "./common.js";
import { parseCodexEventStream, type CodexEventStream } from "./codex-stream.js";

/**
 * The stderr line that says where a fallback result came from. Codex ends
 * some successful turns with a `Plan` item and no `agent_message`; its own
 * final message is then the Plan text (`final_message_from_turn_items`
 * falls back to the last Plan), but the JSONL mapper drops the item, so the
 * event stream codemux reduces carries no message at all. The launch
 * therefore also passes `--output-last-message <file>` and the recorded
 * final message -- Plan included -- becomes the result; the note keeps the
 * caller from reading a plan as an assistant reply without knowing it.
 */
export const CODEX_FINAL_MESSAGE_FALLBACK_NOTE =
  "codemux: the codex stream carried no agent_message item, so the result " +
  "is the final message codex recorded itself (its last Plan item, which " +
  "the JSONL event stream does not carry)";

/**
 * Fills a stream whose last turn left no message in the event stream with
 * the final message codex recorded through `--output-last-message`. Only a
 * failed-turn-free stream with no in-stream message qualifies: a failed turn
 * has no final message upstream, and a stream that already has one stands
 * (the stream is the documented source; the file is the fallback for the
 * item the mapper drops). Returns whether the fallback supplied the result,
 * so both callers can say so on stderr.
 */
export function applyCodexFinalMessageFallback(
  stream: CodexEventStream,
  fallback: string | null
): boolean {
  if (fallback === null || stream.failure !== null || stream.finalMessage !== null) {
    return false;
  }
  stream.finalMessage = fallback;
  return true;
}

/** The verdict's one caller-specific arm, for the plain-run caller
 * (plain-unwrap.ts): a COMPLETED turn whose message is missing everywhere
 * -- no agent_message in the stream, no --output-last-message file (an
 * untrusted sandbox launch passes none) -- succeeds with empty stdout,
 * because human mode exits 0 for that turn (verified against 0.160.1's
 * event_processor_with_human_output.rs: a TurnStatus::Completed turn
 * shuts the process down normally whatever it holds, and
 * print_final_output prints a final message only when one exists). The
 * envelope path keeps the default arm: its promise is a result envelope,
 * and an empty result is a failed run. */
export interface CodexStreamVerdictOptions {
  messagelessCompletedTurnSucceeds?: boolean;
}

/**
 * The one success verdict every codex event-stream run shares. A run is
 * successful only when the stream carried a complete result: any
 * `turn.failed` or `error` event, a stream that ends without a final
 * assistant message (a turn that produced no message -- the Plan fallback,
 * when the caller applied one, counts as the message), a stream whose last
 * turn never ended with `turn.completed` (an `item` completing is not the
 * turn finishing, so a wrapper that drops the final event cannot make a
 * truncated stream pass), or codex's own non-zero exit is a failure. The
 * diagnostic is the stderr line for the failure; it is null when codex
 * itself already exited non-zero, because its own stderr is the
 * diagnostic. The no-message arm is the one a caller may lift:
 * `messagelessCompletedTurnSucceeds` (CodexStreamVerdictOptions above)
 * drops it, so a completed messageless turn falls through to success --
 * the plain run's rule, not the envelope's.
 */
export function codexStreamVerdict(
  stream: CodexEventStream,
  result: RunResult,
  options: CodexStreamVerdictOptions = {}
): { failed: boolean; diagnostic: string | null } {
  if (stream.failure !== null) {
    return {
      failed: true,
      diagnostic: `codemux: codex run failed: ${stream.failure}`,
    };
  }
  if (!result.success) {
    // Codex's own exit already failed and its stderr is on stderr; no
    // codemux line is added, but the verdict still fails the run.
    return { failed: true, diagnostic: null };
  }
  if (
    !options.messagelessCompletedTurnSucceeds &&
    (stream.finalMessage === null || stream.finalMessage.trim() === "")
  ) {
    // An empty or whitespace-only final message is no message (round10 for
    // "", round17 for whitespace-only): a completed codex turn whose one
    // agent_message carried empty text passed as a successful run with an
    // empty result. The rule is the same one the Claude envelope path
    // applies to its `result` text.
    return {
      failed: true,
      diagnostic:
        "codemux: the codex stream ended without a final assistant " +
        "message, so this run has no result to report",
    };
  }
  if (!stream.turnCompleted) {
    return {
      failed: true,
      diagnostic:
        "codemux: the codex stream ended without a `turn.completed` " +
        "event, so the turn never finished and this result is truncated",
    };
  }
  return { failed: false, diagnostic: null };
}

/** The fallback argument `codexResult` takes: the recorded final message
 * as text; `{ missing }` for a named `--output-last-message` file that is
 * not there (the path, so the failure names the absent file — round al29,
 * the README's documented rule — for upstream writes something for every
 * completed turn and a missing file is a write codex only logged); or
 * null when no fallback applies. Only a messageless stream consults it —
 * a stream that carried its own message answers from the stream alone,
 * whatever the file did. */
export type CodexFinalMessageFallback = string | { missing: string } | null;

/**
 * Finishes a `--result-json` run for codex: codemux builds the envelope
 * itself, because the harness's own stdout is an event stream rather than
 * one object. `result` holds the final assistant message as plain text, and
 * is null unless the verdict above passed -- a failed or interrupted turn
 * has no final message, and partial output from an earlier
 * `item.completed` must not pose as one. A turn the stream records as
 * complete but messageless is different: when codex itself recorded a final
 * message (a Plan-only turn; see `CODEX_FINAL_MESSAGE_FALLBACK_NOTE`), that
 * message -- passed in as `finalMessageFallback` from the
 * `--output-last-message` file the launch named -- is the result; a named
 * file that is missing fails that turn naming the absent file
 * (`CodexFinalMessageFallback`'s `{ missing }` shape, round al29); and a
 * turn with no message anywhere still fails on the generic arm. A failed
 * turn surfaces on every channel: the exit is non-zero even if codex's own
 * was not, and the diagnostic rides on stderr after codex's own output.
 *
 * Usage is this run's. `turn.completed.usage` is the thread's cumulative
 * total (see parseCodexEventStream); a run launched with `--ephemeral`
 * starts its thread, so the last snapshot is exactly this run's usage. An
 * unparseable stream is a broken contract, so that run fails loudly:
 * non-zero exit, the raw stdout kept verbatim on stdout for inspection
 * (the same way the Claude-family path keeps it -- no envelope is emitted,
 * because there is no stream to build one from), and the codemux line on
 * stderr.
 */
export function codexResult(
  result: RunResult,
  request: RunRequest,
  finalMessageFallback: CodexFinalMessageFallback = null
): RunResult {
  const stream = parseCodexEventStream(result.stdout);
  if (stream === null) {
    return {
      ...result,
      stderr: appendDiagnostic(
        result.stderr,
        "codemux: codex printed an event stream this codemux " +
          "cannot parse, so this --result-json run reports no result or usage"
      ),
      exitCode: result.exitCode === 0 ? 1 : result.exitCode,
      success: false,
    };
  }
  const usedFallback = applyCodexFinalMessageFallback(
    stream,
    typeof finalMessageFallback === "string" ? finalMessageFallback : null
  );
  const verdict = codexStreamVerdict(stream, result);
  const block: CodemuxResultBlock = {
    agent: "codex",
    labels: request.labels ?? null,
    // The model is the one that served the run: a reroute (servedModel)
    // replaces the selection mid-run, and otherwise the stream names no
    // model, so it is the one codemux selected or null (the harness
    // default, unreported).
    model: stream.servedModel ?? request.model ?? null,
    // A failed run's envelope reports null usage even when the stream
    // parsed and carried a snapshot (round23): a complete stream paired
    // with codex's own non-zero exit still fails -- the verdict reads the
    // exit, not just the stream -- and a figure from a run whose end the
    // harness itself called failed is at best incomplete. The parser
    // already nulls usage for a stream-level failure; this extends the
    // rule to every failed envelope.
    usage: verdict.failed ? emptyUsage() : stream.usage,
    // Always null in this release: the adapter runs `--ephemeral`, so no
    // thread a run leaves behind can be resumed (reserved for the
    // live-sessions release; see types.ts).
    session_id: null,
    recording: null,
  };
  const notes: string[] = stream.warnings.map((message) => `codemux: codex warning: ${message}`);
  // Round al29 (contracts minor): a named fallback file that is missing,
  // on the messageless stream that needed it, fails the turn NAMING THE
  // ABSENT FILE — the README's documented rule — instead of the generic
  // no-message diagnostic the verdict just computed: upstream writes
  // something for every completed turn (a message, or the empty file that
  // is its messageless record), so a named file that is not there is a
  // write codex only logged, and the caller should learn that, not a
  // generic "no result". Scoped by construction to the turn that needed
  // the file: a stream that failed its own way, or one whose exit already
  // failed, keeps its own diagnostic (the check below requires the run
  // and stream clean), and a stream that carried a message never reaches
  // this state at all — applyCodexFinalMessageFallback is what leaves
  // finalMessage null here. Round al30 (rule 4, edges minor) added the
  // turnCompleted gate: a truncated stream (thread.started and
  // turn.started, no completion) never reached the turn whose file this
  // arm blames — the turn never finished, and that is the verdict the
  // generic diagnostic reports, not a missing file.
  if (
    typeof finalMessageFallback === "object" &&
    finalMessageFallback !== null &&
    result.success &&
    stream.failure === null &&
    stream.finalMessage === null &&
    stream.turnCompleted
  ) {
    notes.push(
      `codemux: the --output-last-message file this run named ` +
        `(${finalMessageFallback.missing}) is missing — upstream writes one ` +
        "for every completed turn, so the write codex logged never happened " +
        "— and the stream carried no agent_message, so this run has no " +
        "result to report"
    );
  } else if (verdict.diagnostic !== null) {
    notes.push(verdict.diagnostic);
  }
  if (!verdict.failed && usedFallback) {
    notes.push(CODEX_FINAL_MESSAGE_FALLBACK_NOTE);
  }
  if (stream.servedModel !== null) {
    // Attribution the caller should not have to dig for: the envelope's
    // model field carries the served model, and the note says it on stderr
    // for the operator who selected a different one.
    notes.push(
      `codemux: codex rerouted the model, so this run was served by ${stream.servedModel}` +
        (request.model !== undefined && request.model !== stream.servedModel
          ? `, not the requested ${request.model}`
          : "")
    );
  }
  return {
    ...result,
    stdout: `${JSON.stringify({ result: verdict.failed ? null : stream.finalMessage, codemux: block })}\n`,
    stderr:
      notes.length > 0
        ? appendDiagnostic(result.stderr, notes.join("\n"))
        : result.stderr,
    exitCode: verdict.failed && result.exitCode === 0 ? 1 : result.exitCode,
    success: !verdict.failed,
    usage: block.usage,
    servedModel: stream.servedModel,
  };
}
