/**
 * The claude-family driver's turn machinery: turn ids, the pre-init
 * opener, interrupt delivery, the turn timer, and turn completion.
 * src/session/driver.ts owns the lifecycle.
 */

import { appendSessionTurnCallRecord } from "../call-log.js";
import { buildInterruptRequest, type ClaudeParse } from "./claude-session.js";
import { buildEvent, buildUnknownEvent } from "./protocol.js";
import { touchSession } from "./registry.js";
import type { Timer } from "./driver-io.js";
import { addTurnUsage } from "./usage.js";
import { ClaudeDriverPermissions } from "./driver-permissions.js";

export abstract class ClaudeDriverTurns extends ClaudeDriverPermissions {

  private turnCounter = 0;
  // Interrupt request ids live in their own namespace: turns are named
  // t1, t2, … for the caller, and an interrupt must never shift that
  // numbering.
  protected interruptCounter = 0;
  /** A `user` line accepted and forwarded before the init frame: its turn
   * opens codemux-side when that frame arrives. While it is set the
   * session counts as mid-turn, so a second line is rejected `busy`
   * rather than handed to a harness that may fold both into one result
   * (review live21). */
  protected openerPending = false;
  /** The pending opener was already forwarded when the end began: the
   * harness may still run it inside the drain, where no turn can open
   * for it (review live16). */
  protected forwardedAtEnd = false;
  protected interruptPending = false;
  /** The request id of the outstanding interrupt, caller or end path: a
   * refusal clears the pending interrupt only when it answers this id
   * (review live23: the end path's `interrupt-end-N` never matched a
   * comparison rebuilt from the caller spelling). */
  protected interruptId: string | null = null;
  protected interruptFromTimeout = false;

  /** An `interrupt` the caller sent while the forwarded first input's
   * turn could not open yet (the FSM still `starting`, waiting for the
   * init frame). It is delivered the moment that turn opens, so the ack
   * the caller got is honored (review live18 — it was a no-op and the
   * turn ran to completion). */
  protected interruptBeforeInit = false;
  /** The input_seq of the caller interrupt held for the init frame, so a
   * delivery the harness refuses then names the line it acked (review
   * live23). */
  protected interruptBeforeInitSeq: number | null = null;

  /** Whether the open turn's `--turn-timeout` already fired its
   * interrupt; a second expiry on the same turn ends the session. */
  private turnTimeoutFired = false;
  private turnTimer: Timer | null = null;

  /** The wall clock each open turn started at, keyed by turn id: the
   * ledger's session_turn records carry each turn's own duration. */
  protected readonly turnStartedAt = new Map<string, number>();

  /** Empties the derived file-change candidates the finishing turn leaves
   * behind (§4.3): a tool_use whose result never arrived belongs to the
   * turn that ends now, and a later turn's reused or delayed call id must
   * not confirm it (review round 259). Implemented one class down, where
   * the candidate map lives (driver-events.ts). */
  protected abstract dropPendingFileChanges(): void;

  protected completeTurn(
    parse: Extract<ClaudeParse, { kind: "turn_completed" }>,
    rawLine: string
  ): void {
    if (this.finished && this.fsm.state !== "turn_active" && this.forwardedAtEnd) {
      // The harness ran the forwarded pre-init input inside the drain
      // (see finish): its result answers no turn the caller saw open, so
      // it is mirrored, never fatal and never silently dropped.
      this.forwardedAtEnd = false;
      // Its usage is real and the caller sees it raw, so it folds into
      // the session total (review live22).
      this.cumulative = addTurnUsage(this.cumulative, parse.usage);
      this.emit(buildUnknownEvent(++this.seq, this.options.sessionId, rawLine));
      return;
    }
    if (this.fsm.state === "starting") {
      // A result with no init frame before it: the harness answered the
      // forwarded first line without starting a session. A refused
      // `--resume` (a transcript that no longer exists) ends this way,
      // then exits 1 (review live21, recorded live). The line was
      // answered, so the end path's "may still run it" notice would be
      // false; the result goes out raw, its `errors` naming the reason.
      this.openerPending = false;
      this.cumulative = addTurnUsage(this.cumulative, parse.usage);
      this.emitGrammarViolation(
        rawLine,
        `the ${this.options.agent} process sent a result before its init frame, so no session started ` +
          "(a refused --resume ends this way; the result's errors and codemux's stderr carry the reason)"
      );
      void this.finish("crash", 1);
      return;
    }
    const turnId = this.fsm.activeTurn;
    const error = this.fsm.transition({
      kind: "turn_completed",
      turnId: turnId ?? "none",
    });
    if (error !== null) {
      this.emitGrammarViolation(rawLine, error.message);
      void this.finish("crash", 1);
      return;
    }
    // Interrupt labeling is decided here, not in the parser: an
    // interrupted turn arrives as an ERROR result by convention (step-0
    // probe 4), so an error result with an interrupt outstanding is the
    // interrupt striking — interrupted. A CLEAN result with an interrupt
    // outstanding means the interrupt missed: the result was already in
    // flight when the interrupt was written, so the turn ends honestly
    // (review live12). The missed interrupt is spent with it: the harness
    // reads it idle and drops it, because no later turn can be waiting
    // harness-side — a mid-turn `user` line is rejected `busy`, so the
    // next turn's line is written only after this result. (Review live12
    // kept it pending for one more turn, and live20 narrowed that roll to
    // the interrupted shape; both modeled a forwarded mid-turn line the
    // harness had queued, which review live21 removed.)
    const struck = parse.isError && this.interruptPending;
    const finish = struck ? "interrupted" : parse.isError ? "failed" : "end";
    const reason = struck && this.interruptFromTimeout ? "turn-timeout" : parse.reason;
    this.interruptPending = false;
    this.interruptFromTimeout = false;
    this.clearTurnTimer();
    // A turn the harness ended by itself may still hold permission
    // requests open: they belong to a turn that no longer exists, and a
    // later decision would be acked for a request the harness no longer
    // holds while the expiry timer writes a stray deny into whatever
    // turn runs next — the same supersede every other turn-closing path
    // applies (review live11, the codex sibling's finding).
    this.supersedePendingDeny();
    // The derived file-change candidates die with their turn the same way
    // (§4.3): a write tool call whose result never arrived cannot be
    // confirmed by a later turn's reused or delayed call id, which would
    // emit a file_change attributed outside its originating turn (review
    // round 259).
    this.dropPendingFileChanges();
    // Cost rides outside the token sums: the result's `total_cost_usd`
    // is the harness's own session-lifetime figure (each turn's already
    // includes the earlier ones), so the cumulative adopts it rather
    // than adding it (usage.ts, review live8).
    this.cumulative = addTurnUsage(this.cumulative, parse.usage);
    // The per-turn event carries no cost (review live10): the only cost
    // figure the wire reports (`total_cost_usd`) is session-lifetime —
    // each turn's already includes the earlier ones — so mirroring it
    // next to per-turn token counts invited callers to sum overlapping
    // figures. The cumulative fold above keeps the real figure for
    // `session_ended.usage.cost_usd`, where the wire's own number
    // belongs.
    this.emit(
      buildEvent(++this.seq, this.options.sessionId, "turn_completed", rawLine, {
        turn_id: turnId,
        finish,
        ...(reason !== null ? { reason } : {}),
        usage: { ...parse.usage, cost_usd: null },
      })
    );
    // The ledger's turn record mirrors the event the caller just saw; the
    // session's closing record carries the cumulative cost this turn's
    // fold adopted, so the per-turn line stays cost-free like the event.
    appendSessionTurnCallRecord(
      this.callLedger,
      this.options.sessionId,
      turnId ?? "none",
      this.turnStartedAt.get(turnId ?? "") ?? Date.now(),
      finish,
      { ...parse.usage, cost_usd: null }
    );
    this.turnStartedAt.delete(turnId ?? "");
    if (this.registryRecorded && this.options.registryPath !== null) {
      // Best-effort stamp, and never a wait: the lock's retry sleep is a
      // synchronous Atomics.wait on the main thread, and this runs inside
      // harness-line handling on every turn — waiting behind another
      // codemux process's write would freeze stdout reads, caller events
      // and signal handlers for the lock's full budget (~10 s), so the
      // stamp takes a single-attempt lock: one sweep, fail fast (review
      // live13). A failed stamp costs pruning freshness, not correctness
      // (the owner-liveness guard carries the real safety), and the first
      // failure says so once on stderr — silently swallowing it was the
      // live13 defect.
      const outcome = touchSession(this.options.registryPath, this.options.sessionId, {
        attempts: 1,
      });
      if (!outcome.ok && !this.touchWarned) {
        this.touchWarned = true;
        console.error(
          `codemux: cannot stamp the session registry for ${this.options.sessionId} ` +
            `(${outcome.error}); activity tracking may lag`
        );
      }
    }
  }

  protected startTurn(): string | null {
    this.turnCounter += 1;
    const turnId = `t${this.turnCounter}`;
    const error = this.fsm.transition({ kind: "turn_started", turnId });
    if (error !== null) {
      this.emitError(true, "harness", error.message);
      void this.finish("crash", 1);
      return null;
    }
    this.emit(
      buildEvent(++this.seq, this.options.sessionId, "turn_started", null, {
        turn_id: turnId,
      })
    );
    this.turnStartedAt.set(turnId, Date.now());
    this.turnTimeoutFired = false;
    this.armTurnTimer();
    return turnId;
  }

  /** `--turn-timeout` (§4.5): the first expiry interrupts the turn and
   * re-arms; a second expiry on the same turn means the interrupt did not
   * end it (refused, lost, or ignored), so the cap ends the session
   * instead of letting the turn run uncapped (review live17 — the timer
   * fired once and never re-armed). */
  private armTurnTimer(): void {
    // An end path clears every timer once; a timer armed after it began
    // would fire into the drain (review live22: a refused timeout
    // interrupt started the crash end, and the re-arm below then raised a
    // second, false "--turn-timeout" fatal).
    if (this.options.turnTimeoutMs === null || this.finished) return;
    this.clearTurnTimer();
    this.turnTimer = setTimeout(() => {
      this.turnTimer = null;
      if (this.finished || this.fsm.state !== "turn_active" || !this.capabilities.interrupt) {
        return;
      }
      if (this.turnTimeoutFired) {
        this.emitError(
          true,
          "codemux",
          "the turn did not end within --turn-timeout after its timeout interrupt; ending the session"
        );
        void this.finish("timeout", 1);
        return;
      }
      this.turnTimeoutFired = true;
      // §4.1: the turn timeout denies pending requests too, then
      // interrupts the turn; the session continues. The timeout label
      // rides only an interrupt that was written (review live23).
      this.supersedePendingDeny();
      if (this.finished) return;
      if (this.sendInterrupt()) this.interruptFromTimeout = true;
      this.armTurnTimer();
    }, this.options.turnTimeoutMs);
    this.turnTimer.unref?.();
  }

  /** A refused write marks nothing pending (review live23): the crash
   * end it started must not read a drained error result as interrupted. */
  protected sendInterrupt(): boolean {
    this.interruptCounter += 1;
    const interruptId = `interrupt-${this.interruptCounter}`;
    if (!this.writeToHarness(buildInterruptRequest(interruptId))) return false;
    this.interruptId = interruptId;
    this.interruptPending = true;
    return true;
  }

  protected override clearTurnTimer(): void {
    if (this.turnTimer !== null) {
      clearTimeout(this.turnTimer);
      this.turnTimer = null;
    }
  }
}
