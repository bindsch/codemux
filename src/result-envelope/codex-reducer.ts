import type { ResultUsageBlock } from "../types.js";
import type { CodexEventStream } from "./codex-stream.js";
import { emptyUsage, reportedCount } from "./common.js";

/**
 * The one spelling of the stderr note a retained warning prints (the plain
 * fold's verdict, plain-unwrap.ts), stated here because the dependency runs
 * the other way: the plain fold's capture-bound accounting books the
 * rendered note's size (codexWarningNoteBytes below, round al29) — exactly
 * the line the verdict emits — so the two must agree by construction.
 * Defined beside the reducer, not in plain-unwrap.ts, because the
 * dependency runs the other way.
 */
export function codexWarningNote(message: string): string {
  return `codemux: codex warning: ${message}`;
}

/** A reroute notice's shape: `model rerouted: <from> -> <to> (<reason>)`,
 * the message codex formats for a rerouted model (ModelRerouted in
 * exec_events.rs; the reason is Debug-formatted upstream), matched as one
 * unit so a reason containing parentheses still parses. The one spelling
 * that separates a reroute notice from the warnings it shares an item
 * shape with — both arrive as completed `error` items, and only the
 * notice attributes a model, so only it needs a turn to attribute onto
 * (round al35, correctness major 1). */
function parseRerouteNotice(message: string): RegExpExecArray | null {
  return /^model rerouted: (.+) -> (.+) \((.*)\)$/.exec(message);
}

/** The rendered note's UTF-8 size, newline included — the plain fold's
 * capture-bound accounting books one of these per retained warning (the
 * verdict prints exactly this line), so an empty message still costs its
 * prefix and a flood of them cannot retain an unbounded list the bound
 * never sees (round al23's finding, restated on values in al29). Defined
 * beside the note for the same reason: the dependency runs the other
 * way. */
export function codexWarningNoteBytes(message: string): number {
  return Buffer.byteLength(`${codexWarningNote(message)}\n`);
}

/**
 * The per-event core of parseCodexEventStream, shared with the plain-run
 * streaming fold (plain-unwrap.ts), which cannot hold the whole stream and
 * so reduces event by event as the lines arrive. Every grammar violation
 * the whole-capture shape answers with null is recorded here as `drift`
 * instead: a streaming caller cannot rewind and re-answer, so it freezes on
 * the first violation and the verdict says what broke. A caller that has
 * fed every event and seen no drift calls toStream() for the same
 * CodexEventStream the whole-capture parse returned.
 */
export class CodexEventReducer {
  threadId = "";
  sawThreadStarted = false;
  finalMessage: string | null = null;
  servedModel: string | null = null;
  usage: ResultUsageBlock = emptyUsage();
  usageReported = false;
  /** The first grammar violation, null while the stream is intact. */
  drift: string | null = null;
  // `turn.failed` is terminal: nothing later in the stream clears it. A
  // top-level `error` is softer -- codex retries those, and a later matched
  // `turn.completed` proves the retry recovered. `errorFailure` was public
  // for the plain fold's no-announcement verdict (round al7), which round
  // al30 retired -- the first non-empty line decides the regime now -- so
  // nothing outside this file reads it and the field is private again:
  // failureText() folds it into every verdict that needs it.
  private turnFailure: string | null = null;
  private errorFailure: string | null = null;
  // Round al28 removed the per-field byte counters this class kept
  // (threadIdBytes, finalMessageBytes, servedModelBytes, failureBytes,
  // warningBytes): the plain fold's capture-bound accounting measures the
  // retained values themselves through before/after snapshots
  // (plain-unwrap.ts, codexRetainedOf), so a superseded value — a newer
  // assistant message replacing an older one — gives its bytes back when
  // it is replaced (round al29; the al28 rule it replaces counted each
  // retained line whole and never returned superseded bytes).
  /** Every completed `error` item whose message is not a reroute notice,
   * in arrival order: the wire's warning channel (round al22, correctness
   * minor) -- codex reports configuration and runtime warnings as
   * completed error items the turn survives, and human mode printed them
   * on stderr, so a plain run that reduced them away exited 0 with
   * warnings nowhere. Public because the plain fold's verdict prints each
   * one on stderr beside the reply (plain-unwrap.ts); the envelope path
   * does not read it -- its contract is the structured block, and a
   * warning is not a failure field. */
  warnings: string[] = [];
  // Turns open at `turn.started` and close at `turn.completed` or
  // `turn.failed`; the stream is complete only when every turn closed and at
  // least one did so by completing. A terminal event with no open turn is
  // drift (a prefix-truncated or concatenated stream), not a count to clamp.
  // The stream verdict requires every opened turn to have closed.
  openTurns = 0;
  private sawTurnStart = false;
  /** Whether any turn completed; failed turns never set this flag. */
  sawTurnCompletion = false;
  /** Events consumed so far: the thread.started rules are position-sensitive.
   * (Round al30 made this private again: the plain fold no longer reads it
   * — the hatch's objects-only verdict is gone, the first non-empty line
   * decides the regime now — so the counter is the reducer's own state.) */
  private eventCount = 0;

  private setFinalMessage(text: string | null): void {
    this.finalMessage = text;
  }

  /** The failure the reduced stream would report — the terminal
   * `turn.failed` message, else the last `error` message no
   * `turn.completed` recovered — read WITHOUT the mutation toStream()
   * applies when it materializes the same verdict (it clears the final
   * message and usage). Public because the plain fold's retained-bytes
   * accounting snapshots it (plain-unwrap.ts, round al29): the bytes the
   * failure text retains belong in the measure the capture bound checks. */
  failureText(): string | null {
    return this.turnFailure ?? this.errorFailure;
  }

  private takeWarning(message: string): void {
    // Retained whole (the verdict prints each warning as its own prefixed
    // stderr line, codexWarningNote below), so the plain fold's
    // capture-bound accounting books the rendered note's size —
    // codexWarningNoteBytes, one per retained warning (round al29).
    this.warnings.push(message);
  }

  takeEvent(event: Record<string, unknown>): void {
    if (this.drift !== null) return;
    const index = this.eventCount;
    this.eventCount++;
    switch (event.type) {
      case "thread.started":
        // Exactly one announcement names the thread this run runs on, the
        // grammar makes it the stream's FIRST event (exec emits it before
        // any turn), and it must name one: the thread id identifies the
        // conversation this stream records, so an announcement without it
        // names nothing. An announcement that follows any other event is
        // drift -- a wrapper concatenating two valid streams produces
        // exactly this shape -- and accepting a late one paired the
        // earlier stream's completed response with the second run's
        // thread. All refused.
        if (index > 0) {
          this.drift = "a thread.started event after the stream's first event";
          return;
        }
        if (typeof event.thread_id !== "string" || event.thread_id === "") {
          this.drift = "a thread.started event that named no thread id";
          return;
        }
        this.sawThreadStarted = true;
        this.threadId = event.thread_id;
        break;
      case "turn.started":
        // Turns run one at a time -- the grammar nests items inside a turn
        // and closes it before the next opens -- so a `turn.started` while
        // another turn is still open is drift, the shape of a concatenated
        // or terminal-event-dropping wrapper. Counting it let the second
        // turn's events close as a turn of this stream. A completed turn
        // closes the stream too: one `codex exec` run is one turn, so a
        // `turn.started` after any `turn.completed` is a second
        // conversation glued on (round19) -- accepting it returned the
        // second run's result while the thread the one announcement named
        // stayed the first run's.
        if (this.openTurns > 0) {
          this.drift = "a turn.started event inside a turn still open";
          return;
        }
        if (this.sawTurnCompletion) {
          this.drift = "a turn.started event after a turn already completed";
          return;
        }
        this.openTurns++;
        this.sawTurnStart = true;
        // A new turn supersedes the previous one's message: only the last
        // turn's may be the result, so an earlier turn's reply must not
        // survive into a turn that ends without one and pose as its result.
        this.setFinalMessage(null);
        break;
      case "item.started":
      case "item.updated":
        // Items belong inside turns -- the event grammar nests them there
        // -- so an item event outside a turn is drift (a wrapper
        // concatenating or truncating streams produces exactly this shape).
        // Round23: only a trailing `item.completed` agent message was
        // refused before, so a trailing `item.started` or `item.updated`
        // was silently accepted and the completed turn's response returned
        // successfully over a stream whose tail belonged to no turn of this
        // run. Round al34 (edges major 3) extended the same refusal to the
        // stream's head: an item before the first `turn.started` was
        // accepted there, and a pre-turn item.completed error -- a reroute
        // notice -- overwrote servedModel onto a run whose turns that
        // model never served.
        if (this.openTurns === 0) {
          this.drift = "an item event outside a turn: before the first turn.started or after the last turn.completed with no turn reopened";
          return;
        }
        break;
      case "item.completed": {
        // The same ordering rule for the third item event, whatever the
        // item's type: an agent message (round6), a reasoning or tool item
        // (round23) -- any item completing outside a turn is drift (round
        // al34 widened the head of the rule to match), with the one
        // exception round al35 carved out below. Letting a trailing
        // message item replace the completed turn's message would return an
        // uncompleted message as a successful result, and accepting a
        // trailing non-message item would pass a concatenated stream off as
        // this run's.
        const item = event.item;
        if (this.openTurns === 0) {
          // Round al35, correctness major 1: a startup warning is the one
          // item that does not need a turn. Codex reports initialization
          // warnings as completed `error` items BETWEEN thread.started and
          // turn.started (in_process.rs emits them before the first turn;
          // the JSONL processor maps Warning, ConfigWarning, and
          // DeprecationNotice onto exactly this item shape), and the run
          // they annotate succeeds -- freezing the reduction on one turned
          // every warned run into a drift failure. Allowed only in the
          // head position and only in the warning's own shape: a reroute
          // notice still needs the turn it attributes a model onto (the
          // al34 finding), an agent_message would pose as a turn's reply,
          // and past the last turn.completed an item is the
          // concatenated-stream shape again, wherever its message would
          // have come from.
          const message =
            typeof item === "object" && item !== null &&
            (item as Record<string, unknown>).type === "error"
              ? (item as Record<string, unknown>).message
              : undefined;
          if (
            this.sawTurnStart ||
            typeof message !== "string" ||
            parseRerouteNotice(message) !== null
          ) {
            this.drift = "an item event outside a turn: before the first turn.started or after the last turn.completed with no turn reopened";
            return;
          }
          this.takeWarning(message);
          break;
        }
        if (
          typeof item === "object" && item !== null &&
          (item as Record<string, unknown>).type === "agent_message"
        ) {
          const text = (item as Record<string, unknown>).text;
          // A recognized agent_message whose text is not a string is drift,
          // not an item to skip over: silently ignoring it left the stream
          // without a message, so a nonempty --output-last-message fallback
          // could pass the malformed run off as a successful Plan-only turn
          // (round10). The stream is the documented source for agent
          // messages, and one it cannot carry fails closed like any other
          // drift.
          if (typeof text !== "string") {
            this.drift = "an agent_message item whose text is not a string";
            return;
          }
          this.setFinalMessage(text);
        } else if (
          typeof item === "object" && item !== null &&
          (item as Record<string, unknown>).type === "error"
        ) {
          // A reroute notice is the one error item this reduction reads:
          // codex reports a rerouted model as a completed `error` item
          // (ModelRerouted in exec_events.rs), with the message formatted
          // `model rerouted: <from> -> <to> (<reason>)` -- the reason is
          // Debug-formatted upstream, so the parenthetical is matched as a
          // unit and a reason containing parentheses still parses
          // (parseRerouteNotice above, shared with the outside-a-turn
          // guard, which needs the same spelling to tell a warning from a
          // notice). The last
          // reroute wins: a later one supersedes the model an earlier one
          // named. Any other error item is KEPT, not read -- the stream's
          // failure channels are `turn.failed` and the top-level `error`
          // event, not items, so an unrecognized one is not drift and no
          // verdict field reads it (unlike an agent_message whose text is
          // not a string, which is drift because the stream is the
          // documented source for messages) -- but human mode printed its
          // message on stderr, and the plain fold's verdict reports it
          // from `warnings` so a surviving warning cannot vanish from a
          // successful run (round al22).
          const message = (item as Record<string, unknown>).message;
          if (typeof message === "string") {
            const reroute = parseRerouteNotice(message);
            if (reroute !== null) {
              this.servedModel = reroute[2]!;
            } else this.takeWarning(message);
          }
        }
        break;
      }
      case "turn.completed": {
        // Every terminal event must match an open turn: an unmatched one is
        // the shape of a prefix-truncated stream (only the tail of a longer
        // conversation), and clamping it to zero let that tail pose as a
        // complete result.
        if (this.openTurns === 0) {
          this.drift = "a turn.completed event closed a turn none opened";
          return;
        }
        this.openTurns--;
        this.sawTurnCompletion = true;
        // A completed turn supersedes an earlier `error`: codex retried the
        // error and the turn recovered, so the run did not fail. A
        // `turn.failed` is never superseded -- upstream discards the final
        // message of a failed turn, and a later completed turn cannot
        // un-fail the run that reported it.
        this.errorFailure = null;
        const reported = event.usage;
        // A completed turn that reports no usage figure -- the field absent,
        // or an object carrying no counts -- leaves the run with no last
        // snapshot. The snapshot replaces rather than joins, so the previous
        // turn's cumulative total must not survive it: a stream whose last
        // turn omits usage reports null fields, not the earlier turn's
        // stale counts.
        if (typeof reported !== "object" || reported === null) {
          this.usage = emptyUsage();
          this.usageReported = false;
          break;
        }
        const u = reported as Record<string, unknown>;
        const input = reportedCount(u.input_tokens);
        const cached = reportedCount(u.cached_input_tokens);
        const cacheWrite = reportedCount(u.cache_write_input_tokens);
        const output = reportedCount(u.output_tokens);
        if (input === null && cached === null && cacheWrite === null && output === null) {
          this.usage = emptyUsage();
          this.usageReported = false;
          break;
        }
        // Every count zero is the same non-report in another shape: codex
        // 0.159.3 fills `turn.completed.usage` with `Usage::default()` when
        // the thread never received a token-usage update, and a turn that
        // completed has consumed tokens -- output above all -- so four
        // zeros are that synthetic snapshot, not a measured figure.
        // Publishing `total_tokens: 0` for a nonempty completed run would
        // report a number nothing reported (round23).
        if (input === 0 && cached === 0 && cacheWrite === 0 && output === 0) {
          this.usage = emptyUsage();
          this.usageReported = false;
          break;
        }
        // Each normalized field is computed exactly from the raw fields it
        // needs and is null when any of them is unreported, never guessed
        // from a zero: a reported zero is knowledge (a turn with no cache
        // traffic keeps cached_input_tokens 0), while a missing field stays
        // missing. The snapshot replaces, not joins, the previous one: each
        // is the same cumulative thread counter at a later point.
        this.usage = {
          // The uncached input: codex counts BOTH cache reads and cache
          // writes inside input_tokens (each is a breakdown of that total,
          // responses.rs), so both are subtracted. Subtracting only the
          // reads left every cache write counted twice -- once here and
          // once in the cached count below (round25).
          input_tokens:
            input !== null && cached !== null && cacheWrite !== null
              ? Math.max(0, input - cached - cacheWrite)
              : null,
          output_tokens: output,
          // Cache reads and writes join into the one cached count.
          cached_input_tokens:
            cached !== null && cacheWrite !== null ? cached + cacheWrite : null,
          // The total is computed, not reported: the sum of the three
          // normalized components above, and only when every component of
          // the documented sum is known -- which takes all four raw counts,
          // because the uncached input needs `cached` AND `cacheWrite` and
          // the joined cached count needs `cacheWrite` too (README: the
          // total is computed "only when every component was reported",
          // round17). The uncached term is the CLAMPED one: cached input
          // above total input once summed the raw `input`, so the reported
          // components disagreed with the total they were promised to sum
          // to (round19).
          total_tokens:
            input !== null && cached !== null && cacheWrite !== null && output !== null
              ? Math.max(0, input - cached - cacheWrite) + cached + cacheWrite + output
              : null,
          cost_usd: null,
        };
        this.usageReported = true;
        break;
      }
      case "turn.failed": {
        // Same matching rule as turn.completed, for the same reason. The
        // error sits one level down (TurnFailedEvent { error }); the
        // fallback literal is upstream's own.
        if (this.openTurns === 0) {
          this.drift = "a turn.failed event closed a turn none opened";
          return;
        }
        this.openTurns--;
        const error = event.error;
        const message =
          typeof error === "object" && error !== null
            ? (error as Record<string, unknown>).message
            : undefined;
        this.turnFailure =
          typeof message === "string" && message !== ""
            ? message
            : "turn failed";
        // Cleared at the event, not only in toStream() (round al31,
        // correctness major): the plain fold's retained-bytes accounting
        // snapshots the reducer's values per event, and a failed turn
        // owes the caller the failure text, not the earlier turn's
        // superseded assistant message — releasing it here lets the
        // snapshot at this event see the give-back, so a stream whose
        // last turn failed is measured with the bytes it actually
        // retains. toStream's clearing stays for the soft `error` path,
        // whose recovery window keeps the message alive until the stream
        // ends.
        this.setFinalMessage(null);
        break;
      }
      case "error": {
        const message = event.message;
        this.errorFailure =
          typeof message === "string" && message !== ""
            ? message
            : "codex reported an error";
        this.takeWarning(this.errorFailure);
        break;
      }
      default:
        break;
    }
  }

  /** The reduced stream. Call after the last event; assumes no drift and a
   * thread announcement (the whole-capture parse and the fold both check
   * before calling). */
  toStream(): CodexEventStream {
    const failure = this.failureText();
    if (failure !== null) {
      this.setFinalMessage(null);
      // A failed run reports no usage totals either (round17): the last
      // snapshot is an earlier turn's (a failed turn closes with no usage
      // event), so the run's true total is that figure or more -- an
      // exact-looking number that understates a failed run is worse than
      // none.
      this.usage = emptyUsage();
      this.usageReported = false;
    }
    return {
      threadId: this.threadId,
      finalMessage: this.finalMessage,
      servedModel: this.servedModel,
      usage: this.usage,
      usageReported: this.usageReported,
      turnCompleted: this.sawTurnCompletion && this.openTurns === 0,
      failure,
      warnings: this.warnings,
    };
  }
}
