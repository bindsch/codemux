/** The codex streaming fold and its whole-capture replay: chunk-by-chunk
 * wire folding under the capture bound. The event model and shared verdict
 * live in codex-fold-model.ts; src/plain-unwrap.ts owns the public surface. */
import { CodexEventReducer } from "../result-envelope.js";
import { MAX_CAPTURE_BYTES } from "../process-runner.js";
import type { ResultUsageBlock, RunResult } from "../types.js";
import {
  byteLength,
  codexPlainReply,
  utf8BytePrefix,
  type CodexPlanFallbackRead,
  type UsageFoldingSink,
} from "./common.js";
import {
  codexFoldVerdict,
  codexRetainedDelta,
  codexRetainedOf,
  codexRetainedTotal,
  foldCodexWireLine,
  noteCodexBreak,
  parsesAsThreadStarted,
  type CodexFoldState,
} from "./codex-fold-model.js";

/**
 * codex, streaming shape: the run's stdout — the whole `--json` event
 * stream, every tool's output riding the item events — is fed chunk by
 * chunk and never captured whole, because an agentic run's stream passes
 * the 16 MiB capture bound and dies at exit 125 with the reply lost (the
 * ul3 finding, now solved the way opencode's was). The fold keeps the
 * final-message candidate, the last usage snapshot, the served model, and
 * the break notes; item events are dropped as they arrive, so no volume
 * of tool output can reach the bound.
 *
 * The stream's regime is decided once, by the first non-empty line
 * (round al30, rule 3): a line that parses as the thread.started
 * announcement commits the stream to the wire; any other first line
 * commits it to human mode — verbatim passthrough, the bytes kept whole
 * in `raw` — and nothing later flips it (a fenced example quoting the
 * events, quoted JSON: reply text, whatever it looks like). The verbatim
 * stream is kept only while the regime is undecided or human, and the
 * boundary search runs over the newly arrived chunk alone (reviews ul5,
 * ul8).
 *
 * One rule for a line past the capture bound (round al37), whatever the
 * stream's regime — wire, human, or undecided — and whatever the event's
 * type: the run fails with the capture-limit failure, exit 125 — the
 * latch `overflowed` answering MAX_CAPTURE_BYTES + 1 to every keptBytes
 * poll, push folding nothing after the drop, close() folding no tail.
 * The check runs at both moments the fold can meet such a line —
 * mid-accumulation or complete in one chunk (round al16) — and the latch
 * freezes the state at the same completed-lines prefix under every
 * chunking, so the pipe's read grouping cannot decide anything. The
 * al34–al36 carve-outs are gone with the accounting that served them: an
 * oversized line no longer commits an undecided stream to human (round
 * al35's commit rule is deleted — the regime stays undecided, for the
 * wire is committed only by a line read whole as the thread.started
 * announcement), and no dropped head is classified (round al8's
 * tool part, round al11's error event and re-review, round al22/al35's
 * warning item, round al34's reroute notice, round al14's non-object
 * drift — none of them): a fold that picked which unread bytes were
 * safe to lose by their first 512 bytes was guessing about lines it
 * never read. The one thing kept is round al31's decided-human prefix:
 * a stream already committed to human mode retains the bounded prefix
 * of the line, so the capture-limit result carries the same partial
 * output the whole-stream capture would have returned instead of only
 * what preceded the oversized line.
 *
 * Round al29 gives the capture-bound accounting ONE rule, stated once and
 * chunking-independent (al28's property test delivers the same bytes
 * whole and in every chunking from 1 byte to 64 KiB and requires
 * byte-identical verdicts and a byte-identical keptBytes): a line is
 * accounted when it COMPLETES, after the reduction has consumed it, and
 * `retainedBytes` moves by the byte DELTA the line made in the retained
 * values (the reply text, the usage snapshot, the kept warnings, the
 * failure text, the thread id, the served model, the drift string — the
 * fields codexRetainedOf snapshots) — so the counter always reads what
 * the reduction holds NOW, a superseded value's bytes leaving with the
 * value (the al28 rule it replaces added the whole line whenever anything
 * changed and never subtracted, so three 3 MiB messages tripped a bound
 * only the last one still met), and the limit check runs right after
 * that update and nowhere else, over `retainedBytes + brokenBytes` alone.
 * Tool-output lines — the wire's volume, the reason the fold exists —
 * move no retained value, so they are dropped before accounting by the
 * same diff; the buffered partial line is never in the check, for the
 * same bytes cross the bound at different partial heights under different
 * chunkings (round al27's verdict rule, now the accounting's).
 * keptBytes reports the latch once it trips (MAX_CAPTURE_BYTES + 1, what
 * the process runner kills on) and otherwise the two regimes' honest
 * residues: the retained values plus break notes on the wire branch, the
 * verbatim bytes human mode still owes on the other. The regime's
 * commitment to wire frees human mode's raw beside itself and starts the
 * wire regime's counter at the values the reduction holds at that moment
 * (round al21's one-counter rule; round al29 replaced the reset-to-zero,
 * which let values the hatch had fed survive the flip unmeasured), while
 * the latch itself is sticky — a bound the residue crossed cannot be
 * un-tripped by later structure.
 */
export class CodexPlainFold implements UsageFoldingSink {
  private readonly state: CodexFoldState = {
    mode: null,
    reducer: new CodexEventReducer(),
    broken: [],
    brokenBytes: 0,
    brokenCount: 0,
  };
  /** The partial line the chunks have not terminated yet. */
  private buffer = "";
  /** UTF-8 bytes of `buffer`, maintained with every mutation. */
  private bufferBytes = 0;
  /** Verbatim stdout for the escape hatch, kept only while no line has
   * been the wire. */
  private raw = "";
  /** UTF-8 bytes of `raw`, maintained alongside it. */
  private rawBytes = 0;
  /** UTF-8 bytes of the retained values the reduction holds now (the wire
   * branch of keptBytes and one side of the limit check): every completed
   * wire line applies the byte delta it moved, so a superseded value's
   * bytes leave with the value. Initialized at the hatch→wire flip. */
  private retainedBytes = 0;
  /** A line past the capture bound was dropped: the run fails at the
   * capture limit (round al37's one rule). Sticky — keptBytes answers
   * MAX_CAPTURE_BYTES + 1 and the process runner kills the run on that;
   * a later line cannot un-trip a bound the residue already crossed. */
  private overflowed = false;
  private closed = false;

  push(chunk: string): void {
    if (this.closed || this.overflowed) return;
    this.bufferBytes += byteLength(chunk);
    // The buffered partial line carries no newline — every exit below
    // leaves it that way — so the boundary search runs over the newly
    // arrived chunk alone (review ul8).
    let carried = this.buffer;
    let start = 0;
    for (;;) {
      const newline = chunk.indexOf("\n", start);
      if (newline === -1) {
        this.buffer = carried + (start === 0 ? chunk : chunk.slice(start));
        break;
      }
      const line = carried + chunk.slice(start, newline);
      carried = "";
      start = newline + 1;
      this.bufferBytes -= byteLength(line) + 1; // the newline is one byte
      // The completed line is size-checked BEFORE it is parsed (round
      // al16), and the drop returns from push at once: the rest of the
      // chunk never folds, for the latch owns everything after the line.
      if (byteLength(line) > MAX_CAPTURE_BYTES) {
        this.dropOversizedLine(line);
        return;
      }
      this.takeLine(line, true);
      if (this.overflowed) return;
    }
    if (this.bufferBytes > MAX_CAPTURE_BYTES) {
      this.dropOversizedLine(this.buffer);
    }
  }

  /** The one treatment for a line past the capture bound (round al37's
   * rule, the class comment above): the note, the latch, and — for a
   * DECIDED human stream only — al31's bounded prefix. No regime is
   * committed and no head classified. Fires at either moment the fold
   * meets such a line: mid-accumulation (the partial line outgrew the
   * bound, push's trailing check) or complete in one chunk (round al16:
   * the newline arrived with the bytes that crossed the bound). `line`
   * is what was read of it — the whole line when it completed, its head
   * only when it did not — which yields the identical prefix either
   * way: the prefix depends on the first `room` bytes alone, and both
   * forms share them (the head is always the longer). */
  private dropOversizedLine(line: string): void {
    noteCodexBreak(
      this.state,
      `a single line over the ${MAX_CAPTURE_BYTES}-byte capture bound was dropped unread`
    );
    if (this.state.mode === "human") {
      // Human mode's plain stdout, unreadable whole: the run fails at the
      // capture limit, never a silent truncation (the ul5 pin). The bytes
      // are still accounted before the discard (round al31, correctness
      // major): the capture-limit result owes the caller the same partial
      // output the whole-stream path returns — the first bytes it could
      // hold — so the bounded prefix of the line joins raw here, against
      // the room left beside what raw and the note already hold.
      const room = Math.max(
        0,
        MAX_CAPTURE_BYTES - this.rawBytes - this.state.brokenBytes
      );
      const prefix = utf8BytePrefix(line, room);
      this.raw += prefix;
      this.rawBytes += byteLength(prefix);
    }
    this.overflowed = true;
    this.buffer = "";
    this.bufferBytes = 0;
  }

  keptBytes(): number {
    if (this.overflowed) return MAX_CAPTURE_BYTES + 1;
    // The two regimes' honest residues (round al29's one rule, the class
    // comment above): the wire branch reports the retained values plus
    // the break notes — the measure the limit check latches
    // on, so what the runner kills on and what the fold reports are one
    // number. Neither regime counts the buffered partial line: its
    // height depends on chunking. close() accounts for an unfinished
    // tail, and push() independently bounds each buffered line.
    return this.state.mode === "wire"
      ? this.retainedBytes + this.state.brokenBytes
      : this.rawBytes + this.state.brokenBytes;
  }

  /** The usage folded so far — the last `turn.completed` snapshot — for a
   * run still in flight (the receipt a signal interrupt writes,
   * launch.ts); null when no turn reported any. */
  foldedUsage(): ResultUsageBlock | null {
    return this.state.reducer.usageReported ? this.state.reducer.usage : null;
  }

  finish(): string {
    this.close();
    // The last message's own spelling (codexPlainReply), NOT always the
    // verdict's: a killed or timed-out turn whose stream carried an
    // intermediate agent_message returns that message here, while
    // verdict() prints nothing for it (round al21, contracts-2 minor 5 —
    // this comment once claimed the verdict's spelling outright). Safe
    // because the launch flow's processRunResult runs after finish() and
    // overwrites stdout with the verdict's own; finish() alone answers
    // only callers that asked for the folded message, not a run result.
    // A null message is the no-message turn's — nothing, never a bare
    // newline — and any real one carries its newline whatever it ends
    // with.
    return this.state.mode === "wire"
      ? this.state.reducer.finalMessage === null
        ? ""
        : codexPlainReply(this.state.reducer.finalMessage)
      : this.raw;
  }

  /** Applies the shared verdict to a finished run; closes the fold first
   * so an unterminated tail line is folded exactly as the whole-capture
   * split folded it. The optional `planFallback` thunk is the round-al29
   * bounded fallback: the launch reads the run's --output-last-message
   * file before the verdict runs and hands its outcome over, and the
   * verdict consults it only for a completed messageless turn
   * (codexFoldVerdict above). No thunk — every whole-capture replay, and
   * any launch that named no file — answers from the stream alone. */
  verdict(
    result: RunResult,
    planFallback?: () => CodexPlanFallbackRead
  ): RunResult {
    this.close();
    return codexFoldVerdict(result, this.state, planFallback);
  }

  private close(): void {
    if (this.closed) return;
    this.closed = true;
    if (!this.overflowed && this.buffer !== "") {
      // A stream can end mid-line (the write was cut) or without the final
      // newline; folding the tail as a line matches the whole-capture
      // split (review ul3's cut-off shape). A latched fold folds nothing:
      // its answer was decided at the drop (round al37).
      this.takeLine(this.buffer, false);
    }
    this.buffer = "";
    this.bufferBytes = 0;
  }

  private takeLine(line: string, terminated: boolean): void {
    // The regime is decided by the first non-empty line and never
    // revisited (round al30, rule 3): blank lines alone commit nothing.
    if (this.state.mode === null && line.trim() !== "") {
      this.decideMode(line);
    }
    if (this.state.mode !== "wire") {
      // Undecided (blank lines so far) or human mode: the bytes are kept
      // verbatim, the tail byte-for-byte (no newline the stream never
      // sent).
      const incoming = terminated ? `${line}\n` : line;
      const room = Math.max(0, MAX_CAPTURE_BYTES - this.rawBytes - this.state.brokenBytes);
      const bytes = byteLength(incoming);
      const retained = bytes > room ? utf8BytePrefix(incoming, room) : incoming;
      this.raw += retained;
      this.rawBytes += byteLength(retained);
      if (bytes > room) this.overflowed = true;
      this.boundCheck();
      return;
    }
    // The round-al29 accounting diff: the snapshot before the line, the
    // reduction consuming it, and the byte DELTA the line moved in the
    // retained values — a completed line that superseded a larger value
    // than it set gives bytes back, and one that moved nothing (a tool
    // part, the wire's volume) is dropped before accounting. The counter
    // was initialized at the regime's commitment (decideMode), so the
    // first wire line's delta lands on the same total the old flip
    // computed after folding it.
    const before = codexRetainedOf(this.state.reducer);
    foldCodexWireLine(line, this.state);
    const delta = codexRetainedDelta(before, this.state.reducer);
    if (delta !== 0) this.accountRetained(delta);
  }

  /** Commit the stream to its regime from the first non-empty line
   * (round al30, rule 3): a line that parses as the thread.started
   * announcement is the wire — the grammar makes it the first event of
   * every stream, and the launch always asked for `--json`, so a binary
   * that honored the flag prints it here — and anything else is human
   * mode, verbatim passthrough for the stream's whole remaining length.
   * The commitment to wire frees the bytes human mode had kept (blank
   * lines, at most) and starts the retained counter at the values the
   * reduction holds NOW (round al21's one-counter rule; round al29's
   * initialization), so the announcement line's own delta lands on the
   * exact total. */
  private decideMode(line: string): void {
    if (parsesAsThreadStarted(line)) {
      this.state.mode = "wire";
      this.raw = "";
      this.rawBytes = 0;
      this.retainedBytes = codexRetainedTotal(this.state.reducer);
      this.boundCheck();
    } else {
      this.state.mode = "human";
    }
  }

  /** One accounting update: the byte delta joins the retained total
   * (negative when a value was superseded or cleared), then check the
   * current total. Raw appends and the regime's initialization use the
   * same check. */
  private accountRetained(delta: number): void {
    this.retainedBytes += delta;
    this.boundCheck();
  }

  /** The limit check, over completed retained lines and break notes
   * alone: never the buffered partial line, whose height at any
   * completion moment is a property of the chunking, not of the bytes. */
  private boundCheck(): void {
    const retained = this.state.mode === "wire" ? this.retainedBytes : this.rawBytes;
    if (retained + this.state.brokenBytes > MAX_CAPTURE_BYTES) {
      this.overflowed = true;
    }
  }
}

/**
 * codex, whole-capture shape: folds an already-captured stdout through the
 * same reduction and verdict, for callers that hold the stream without a
 * launch-owned fold (a direct processRunResult call in a test, say). The
 * launch path streams (CodexPlainFold above, review ul4's rule), because a
 * captured stream is the one shape the 16 MiB bound cannot hold. The
 * optional `planFallback` thunk is the round-al29 bounded fallback, passed
 * by the launch's processRunResult when the run named a
 * --output-last-message file (codex.ts); the replay here stays callable
 * without one — a caller holding captured stdout and no context answers
 * from the stream alone.
 */
export function codexPlainStreamResult(
  result: RunResult,
  planFallback?: () => CodexPlanFallbackRead
): RunResult {
  const fold = new CodexPlainFold();
  if (result.stdout !== "") fold.push(result.stdout);
  return fold.verdict(result, planFallback);
}
