/**
 * The codex driver's turn machinery: the turn queue, steer buffering and
 * batching, interrupt delivery, the turn timers, and turn completion
 * (harness-named, failed, or synthesized). src/session/codex-driver.ts
 * owns the lifecycle.
 */

import type { ResultUsageBlock } from "../types.js";
import { appendSessionTurnCallRecord } from "../call-log.js";
import { emptyUsage } from "../result-envelope.js";
import {
  buildInterruptRequest,
  buildSteerRequest,
  buildTurnStartRequest,
  type CodexParse,
} from "./codex-session.js";
import { harnessLineDeliverable } from "./process.js";
import { buildEvent } from "./protocol.js";
import { touchSession } from "./registry.js";
import { addTurnUsage } from "./usage.js";
import { CodexDriverApprovals } from "./codex-driver-approvals.js";
import type { Timer } from "./codex-driver-io.js";

/** How many closed harness turn ids are kept for straggler matching. */
const CLOSED_TURN_IDS_KEPT = 1024;

export abstract class CodexDriverTurns extends CodexDriverApprovals {
  /** User inputs accepted mid-turn, submitted as turns in order. */
  protected readonly turnQueue: { text: string; inputSeq: number }[] = [];
  /** Steer texts held until the harness turn id is known; flushed as one
   * batched turn/steer. */
  protected readonly steerBuffer: Array<{ text: string; inputSeq: number }> = [];

  protected turnCounter = 0;

  /** The harness turn id of the open turn, from the turn/start response;
   * null while no turn is open and while a turn/start request is still
   * in flight (steers and interrupts buffer until it is named). */
  protected harnessTurnId: string | null = null;
  /** The id the first scoped notification named while the turn/start
   * response was still in flight (review round 67): later notifications
   * in that window must match it, and the response must confirm it. */
  protected pendingTurnId: string | null = null;
  /** The harness ids of turns that closed: a usage, item, or delta
   * notification naming one after its `turn/completed` is late, not the
   * open turn's (review live18), even once a later turn is named (the
   * parser's `closedTurnIds`, review live20). Every closed turn is kept,
   * not only the last (review live23), bounded to the most recent
   * CLOSED_TURN_IDS_KEPT. */
  protected readonly closedHarnessTurnIds = new Set<string>();
  protected queuedInputs = 0;
  protected interruptQueued = false;
  /** The input_seq of a caller interrupt riding the turn/start response,
   * so a delivery the harness refuses then names the line it acked
   * (review live23); null for the timeout's and the end path's own. */
  protected interruptQueuedSeq: number | null = null;
  protected interruptFromTimeout = false;
  /** The request id of the interrupt call in flight, so a stale rejection
   * — a call whose turn already completed while a later turn's interrupt
   * is pending — clears nothing but itself (review live11). */
  protected interruptCallId: number | null = null;
  protected turnUsage: ResultUsageBlock | null = null;
  /** Starts unknown (all-null), not zero: a counter a turn never reports
   * must stay null rather than be guessed as 0 (§4.2). */
  protected cumulative: ResultUsageBlock = emptyUsage();
  /** The wall clock each open turn started at, keyed by turn id: the
   * ledger's session_turn records carry each turn's own duration. */
  protected readonly turnStartedAt = new Map<string, number>();

  /** Whether the open turn's `--turn-timeout` already fired its
   * interrupt; a second expiry on the same turn ends the session. */
  protected turnTimeoutFired = false;
  protected turnTimer: Timer | null = null;

  protected completeTurn(
    parse: Extract<CodexParse, { kind: "turn_completed" }>,
    rawLine: string
  ): void {
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
    // The wire's status is the verdict (review live14): unlike the
    // claude family, where an interrupt surfaces as an error result the
    // driver must interpret (driver.ts pairs the raw error bit with its
    // own interrupt state), codex's turn/completed names "interrupted"
    // itself — so a "completed" that a caller interrupt or a
    // --turn-timeout raced is a completed turn with the full answer
    // delivered, never a recast (the recast labeled it interrupted and,
    // on the timeout path, reason turn-timeout). The wire's "failed"
    // keeps its own message the same way (review live11 — the override
    // used to recast it as interrupted and drop the message). The one
    // label the driver adds: a wire "interrupted" that the timeout's own
    // interrupt produced names its cause.
    const finish = parse.finish;
    const reason =
      finish === "interrupted" && this.interruptFromTimeout
        ? "turn-timeout"
        : parse.reason;
    this.interruptFromTimeout = false;
    this.interruptQueued = false;
    this.interruptQueuedSeq = null;
    this.interruptCallId = null;
    this.clearTurnTimer();
    this.closeHarnessTurn();
    // A turn the app-server ended by itself may still hold approvals
    // open: they belong to a turn that no longer exists, and a later
    // decision would be acked for a request the harness no longer holds
    // while the expiry timer writes a stray decline into whatever turn
    // runs next — the same supersede every other turn-closing path
    // applies (review live11).
    this.supersedeApprovals();
    const usage = this.turnUsage ?? emptyUsage();
    this.turnUsage = null;
    this.dropBufferedSteer();
    // Cost rides outside the token sums when a wire carries one; codex's
    // app-server reports none (cost_usd stays null), so this is the
    // shared rule rather than a codex behavior (usage.ts, review live8).
    this.cumulative = addTurnUsage(this.cumulative, usage);
    this.emit(
      buildEvent(++this.seq, this.sessionIdOrEmpty(), "turn_completed", rawLine, {
        turn_id: turnId,
        finish,
        ...(reason !== null ? { reason } : {}),
        usage,
      })
    );
    // The ledger's turn record mirrors the event the caller just saw
    // (call-log.ts).
    appendSessionTurnCallRecord(
      this.callLedger,
      this.ledgerSessionId(),
      turnId ?? "none",
      this.turnStartedAt.get(turnId ?? "") ?? Date.now(),
      finish,
      usage
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
      const outcome = touchSession(this.options.registryPath, this.threadId ?? "", {
        attempts: 1,
      });
      if (!outcome.ok && !this.touchWarned) {
        this.touchWarned = true;
        console.error(
          `codemux: cannot stamp the session registry for ${this.threadId} ` +
            `(${outcome.error}); activity tracking may lag`
        );
      }
    }
    this.drainTurnQueue();
  }

  /** Complete the open turn as failed without a harness notification:
   * the turn/start response itself refused the turn (§4.7). */
  protected failOpenTurn(reason: string, rawLine: string): void {
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
    this.interruptFromTimeout = false;
    this.interruptQueued = false;
    this.interruptQueuedSeq = null;
    this.interruptCallId = null;
    this.clearTurnTimer();
    this.closeHarnessTurn();
    this.dropBufferedSteer();
    this.supersedeApprovals();
    const usage = this.turnUsage ?? emptyUsage();
    this.turnUsage = null;
    // Usage that arrived before the refusal is real and was already
    // reported per notification; it folds into the session total as
    // completeTurn's does (review live22).
    this.cumulative = addTurnUsage(this.cumulative, usage);
    this.emit(
      buildEvent(++this.seq, this.sessionIdOrEmpty(), "turn_completed", null, {
        turn_id: turnId,
        finish: "failed",
        reason,
        usage,
      })
    );
    appendSessionTurnCallRecord(
      this.callLedger,
      this.ledgerSessionId(),
      turnId ?? "none",
      this.turnStartedAt.get(turnId ?? "") ?? Date.now(),
      "failed",
      usage
    );
    this.turnStartedAt.delete(turnId ?? "");
    this.drainTurnQueue();
  }

  /** Submit the next queued input, only from idle: the announce replay
   * can open a turn for a parked line and queue the next, so a caller
   * that finds a turn already open must leave the queue for that turn's
   * completion (review live16 — submitting from turn_active crashed). */
  protected drainTurnQueue(): void {
    if (this.queuedInputs === 0 || this.finished || this.fsm.state !== "idle") return;
    const next = this.turnQueue.shift();
    if (next === undefined) return;
    this.queuedInputs -= 1;
    const turnId = this.submitTurn();
    if (turnId === null) return; // transition failure already ended us
    // No turn work after the driver finished (review round 153): the
    // entry check above cannot see a finish that begins inside
    // submitTurn's own emit — an outbound bound breach there ends the
    // session synchronously — so the frame is never written into a child
    // the end path owns.
    if (this.finished) return;
    this.sendTurnStart(turnId, next.text);
  }

  /** Report and clear steer texts that can no longer reach a turn — the
   * turn they steered is gone (completed, failed its start, or the
   * session is ending). One place, so every drop path tells the caller
   * the same thing (review live10: failOpenTurn and the end path used to
   * clear the buffer silently, while completeTurn alone reported it). */
  protected dropBufferedSteer(): void {
    if (this.steerBuffer.length === 0) return;
    this.emitError(
      false,
      "codemux",
      `steering input arrived too late for its turn and was dropped (${inputSeqList(
        this.steerBuffer.map((entry) => entry.inputSeq)
      )})`
    );
    this.steerBuffer.length = 0;
  }

  /** Assign the next codemux turn id and open it in the FSM. */
  protected submitTurn(): string | null {
    this.turnCounter += 1;
    const turnId = `t${this.turnCounter}`;
    const error = this.fsm.transition({ kind: "turn_started", turnId });
    if (error !== null) {
      this.emitError(true, "harness", error.message);
      void this.finish("crash", 1);
      return null;
    }
    // The caller's proof the turn opened, emitted where the claude family
    // emits its own (startTurn): at submit, raw null — no harness line
    // exists for it yet. Riding the harness's turn/started notification
    // instead left a turn/start error or an end-path interruption
    // completing a turn the caller never saw open (§4.1, review live15).
    this.emit(
      buildEvent(++this.seq, this.sessionIdOrEmpty(), "turn_started", null, {
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
   * end it (rejected, lost, or ignored), so the cap ends the session
   * instead of letting the turn run uncapped (review live17). */
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
      // §4.1: the turn timeout declines pending approvals too, then
      // interrupts the turn; the session continues. The timeout label
      // rides only an interrupt that was written or queued (review
      // live23).
      this.supersedeApprovals();
      if (this.finished) return;
      if (this.sendInterrupt()) this.interruptFromTimeout = true;
      this.armTurnTimer();
    }, this.options.turnTimeoutMs);
    this.turnTimer.unref?.();
  }

  protected sendTurnStart(turnId: string, text: string): void {
    this.call({ kind: "turn_start", turnId }, (id) =>
      buildTurnStartRequest(
        id,
        this.threadId ?? "",
        text,
        this.policy,
        this.options.effort
      )
    );
  }

  /** `currentSeq` is the steer line being handled now, which its caller
   * rejects itself when the write is refused; every other line in a
   * refused batch was acked earlier and is named here (review live23). */
  protected flushSteer(currentSeq: number | null = null): void {
    if (this.steerBuffer.length === 0 || this.harnessTurnId === null) return;
    const threadId = this.threadId ?? "";
    const expectedTurnId = this.harnessTurnId;
    // Batch greedily but never past the 17 MiB write cap (review live14):
    // every buffered text passed the pre-ack check alone, and joining
    // them can cross the cap — a frame writeToHarness would refuse as
    // oversize, ending the session after each steer in it was already
    // acked. `call` assigns `requestCounter + 1` as the id, so the probe
    // frame is byte-identical to the one that is then sent. Splitting is
    // the wire's common shape anyway: one request per steer once the
    // turn is open; batching only happens while turn/start was in
    // flight.
    while (this.steerBuffer.length > 0) {
      let count = 0;
      while (
        count < this.steerBuffer.length &&
        harnessLineDeliverable(
          buildSteerRequest(
            this.requestCounter + 1,
            threadId,
            expectedTurnId,
            this.steerBuffer.slice(0, count + 1).map((entry) => entry.text)
          )
        )
      ) {
        count += 1;
      }
      if (count === 0) {
        // The pre-ack margin guarantees a single text fits; zero can
        // only mean the buffer holds something that check should have
        // refused. Drop it with the notice rather than spin forever.
        this.dropBufferedSteer();
        return;
      }
      const entries = this.steerBuffer.splice(0, count);
      const texts = entries.map((entry) => entry.text);
      const sent = this.call(
        {
          kind: "steer",
          inputSeqs: entries.map((entry) => entry.inputSeq),
          turnId: this.fsm.activeTurn,
        },
        (id) => buildSteerRequest(id, threadId, expectedTurnId, texts)
      );
      // A refused write started the crash end; the rest cannot follow.
      if (sent === null) {
        const acked = [...entries, ...this.steerBuffer]
          .map((entry) => entry.inputSeq)
          .filter((seq) => seq !== currentSeq);
        this.steerBuffer.length = 0;
        if (acked.length > 0) {
          this.emitError(
            false,
            "codemux",
            `steering input could not be delivered to the harness (${inputSeqList(acked)})`
          );
        }
        return;
      }
    }
  }

  /** Whether the interrupt was written or will ride the turn/start
   * response; false when the write was refused. */
  protected sendInterrupt(): boolean {
    if (this.harnessTurnId === null) {
      // The turn is open codemux-side but the harness has not named it
      // yet; the interrupt rides the turn/start response. With no
      // turn/start in flight there is no response to ride (a success
      // that named no turn, review live22): nothing was sent, and the
      // end path must not wait a grace window for an answer.
      if (!this.turnStartInFlight()) return false;
      this.interruptQueued = true;
      return true;
    }
    return this.deliverInterrupt();
  }

  protected turnStartInFlight(): boolean {
    for (const pending of this.pendingCalls.values()) {
      if (typeof pending === "object" && pending.kind === "turn_start") return true;
    }
    return false;
  }

  protected deliverInterrupt(): boolean {
    const threadId = this.threadId ?? "";
    const turnId = this.harnessTurnId ?? "";
    this.interruptCallId = this.call(
      "interrupt",
      (id) => buildInterruptRequest(id, threadId, turnId)
    );
    return this.interruptCallId !== null;
  }

  // --- helpers -----------------------------------------------------------

  /** Forget the open harness turn, remembering its id as closed. */
  private closeHarnessTurn(): void {
    if (this.harnessTurnId !== null) {
      this.closedHarnessTurnIds.add(this.harnessTurnId);
      if (this.closedHarnessTurnIds.size > CLOSED_TURN_IDS_KEPT) {
        const oldest = this.closedHarnessTurnIds.values().next().value;
        if (oldest !== undefined) this.closedHarnessTurnIds.delete(oldest);
      }
    }
    this.harnessTurnId = null;
    this.pendingTurnId = null;
  }

  /** The caller-facing turn a translated notification belongs to: none
   * for a straggler of the turn that already closed, the open turn
   * otherwise (review live20 — stragglers were labeled with the next
   * turn's id). */
  protected turnIdFor(harnessTurnId: string | null): string | null {
    if (harnessTurnId !== null && this.closedHarnessTurnIds.has(harnessTurnId)) return null;
    return this.fsm.activeTurn;
  }

  protected override clearTurnTimer(): void {
    if (this.turnTimer !== null) {
      clearTimeout(this.turnTimer);
      this.turnTimer = null;
    }
  }
}

/** "input_seq 4" or "input_seq 4, 5" for a notice naming caller lines. */
export function inputSeqList(seqs: readonly number[]): string {
  return `input_seq ${seqs.join(", ")}`;
}
