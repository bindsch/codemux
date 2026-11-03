/**
 * Turn bookkeeping for the aider session driver: the turn-exit hook, the
 * pairing completion (FSM transition, usage fold, event, ledger line),
 * turn-id assignment, and the activity stamp. src/session/aider-driver.ts
 * owns the lifecycle; the spawn and verdict paths live there.
 */

import { appendSessionTurnCallRecord } from "../call-log.js";
import { emptyUsage } from "../result-envelope.js";
import {
  type SessionChildOutcome,
  type SessionProcess,
} from "./process.js";
import { buildEvent, type InputRejectionReason } from "./protocol.js";
import { touchSession } from "./registry.js";
import { addTurnUsage } from "./usage.js";
import { AiderDriverCore } from "./aider-finalize.js";

export abstract class AiderTurns extends AiderDriverCore {
  private turnCounter = 0;

  // Filled in by the driver (aider-driver.ts owns the spawn path and the
  // outbound ack lane).
  protected abstract startTurn(text: string): Promise<void>;
  protected abstract ack(
    inputSeq: number,
    accepted: boolean,
    reason?: InputRejectionReason
  ): void;

  // --- turns ---------------------------------------------------------------
  /** The turn process exited: after its tree settles, its outcome
   * completes the turn — unless the end path's synthesis won the race or
   * the end path has already synthesized its completion. */
  protected async onTurnExited(
    proc: SessionProcess,
    outcome: SessionChildOutcome
  ): Promise<void> {
    await proc.settled;
    if (this.settled) return;
    if (this.turnProc !== proc) return; // superseded — defensive
    this.completeTurn(outcome);
  }

  /** The turn's pairing completion: FSM transition, the uniform usage
   * fold (aider reports nothing machine-readable, so the usage is
   * honestly all-null), the event, and the activity stamp. */
  protected finishTurn(
    turnId: string,
    finish: "end" | "failed",
    reason?: string
  ): void {
    const error = this.fsm.transition({ kind: "turn_completed", turnId });
    if (error !== null) {
      this.emitError(true, "codemux", error.message);
      void this.finish("crash", 1);
      return;
    }
    const usage = emptyUsage();
    this.cumulative = addTurnUsage(this.cumulative, usage);
    this.emit(
      buildEvent(++this.seq, this.options.sessionId, "turn_completed", null, {
        turn_id: turnId,
        finish,
        ...(reason !== undefined ? { reason } : {}),
        usage,
      })
    );
    // The ledger's turn record mirrors the event the caller just saw
    // (call-log.ts); aider reports no usage, so the block is all-null —
    // the honest null, not a guessed zero.
    appendSessionTurnCallRecord(
      this.callLedger,
      this.options.sessionId,
      turnId,
      this.turnStartedAt.get(turnId) ?? Date.now(),
      finish,
      usage
    );
    this.turnStartedAt.delete(turnId);
    this.stampActivity();
  }

  /** Assign the next codemux turn id and open it in the FSM. */
  protected submitTurn(): string | null {
    this.turnCounter += 1;
    const turnId = `t${this.turnCounter}`;
    const error = this.fsm.transition({ kind: "turn_started", turnId });
    if (error !== null) {
      this.emitError(true, "codemux", error.message);
      void this.finish("crash", 1);
      return null;
    }
    this.emit(
      buildEvent(++this.seq, this.options.sessionId, "turn_started", null, {
        turn_id: turnId,
      })
    );
    this.turnStartedAt.set(turnId, Date.now());
    return turnId;
  }

  /** The turn path's best-effort activity stamp: single-attempt lock,
   * never a wait (review live13). */
  private stampActivity(): void {
    if (!this.registryRecorded || this.options.registryPath === null) return;
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
