/**
 * The codex app-server session driver (design §4.7): the launcher-owned
 * context that turns one SessionProcess plus the caller's stdin into the
 * event stream. All per-run state lives here — the FSM, the JSON-RPC
 * request correlation, the parser, the pending-approval timers, the
 * output queue, the registry writes — never on a singleton adapter. The
 * driver never throws across the stream: every failure is an event, an
 * end path, or both.
 *
 * Turn model: the caller sees codemux-local turn ids t1, t2, … assigned
 * the moment an input is submitted from idle (the `user_message` echo
 * carries its turn synchronously); the driver maps that to the harness
 * turn id from the turn/start response. The caller-facing `turn_started`
 * event is emitted at submit, immediately after the FSM opens the turn —
 * the same place the claude family emits its own — so every completion
 * path (the wire's turn/completed, a failed turn/start, a synthesized
 * interruption at session end) answers a start the caller actually saw;
 * a turn/start that never answers leaves an orphan completion (review
 * live15). The harness's turn/started notification still parses under
 * the grammar checks but mirrors as tier-1 unknown, like every other
 * harness echo of something codemux already announced. Mid-turn input
 * queues in the codemux-side FIFO (`user_during_turn: "queue"`); steering
 * and interrupts ride turn/steer and turn/interrupt once the harness
 * turn id is known — before that they buffer and flush on the response.
 */

import { appendSessionCallRecord, appendSessionTurnCallRecord } from "../call-log.js";
import { emptyUsage } from "../result-envelope.js";
import {
  awaitFinalFlush,
  buildSessionEnded,
  crashSynthesisReason,
  drainFailureMessage,
  harnessFailed,
  shutdownRequested,
  type SessionChildOutcome,
} from "./process.js";
import { buildEvent } from "./protocol.js";
import { releaseSessionRecord } from "./registry.js";
import { addTurnUsage } from "./usage.js";
import { CodexDriverInput } from "./codex-driver-input.js";
import type { SessionEndReason } from "./codex-driver-io.js";

export type { CodexDriverOptions, SessionEndReason } from "./codex-driver-io.js";
export { MAX_HELD_INPUT_LINES, MAX_HELD_INPUT_BYTES } from "./codex-driver-input.js";

export class CodexSessionDriver extends CodexDriverInput {
  /** Every end path funnels here (§4.6): pending approvals are answered
   * deny (`superseded`) first, the active turn is interrupted so the
   * harness can persist, the tree is killed after the grace, harness
   * output is drained until the child settles, and `session_ended` is
   * the last event on the stream. */
  private shutdownWasRequested = false;

  protected override async finish(reason: SessionEndReason, exitCode: number): Promise<void> {
    this.shutdownWasRequested ||= shutdownRequested(reason);
    if (this.finished) {
      // Idempotent cleanup, honest verdict: a failure calling in during
      // the drain (a fatal harness line, a handler exception) arrives
      // after the initiating end already began — it raises the exit code
      // instead of restarting a cleanup that is running.
      this.endExitCode = Math.max(this.endExitCode, exitCode);
      return;
    }
    this.finished = true;
    this.endExitCode = exitCode;
    // The input contract (§4.1) reaches the buffers an end path forecloses
    // (review live10): lines parked in `preSessionLines` — the handshake
    // never answered, so replay can never run — are each rejected with the
    // same `shutting_down` the drain window gives a fresh line; user
    // inputs already acked and echoed but still queued in the FIFO can no
    // longer run, so the caller gets one non-fatal notice (their acks
    // cannot be retracted, and a second answer per line would break the
    // ack contract); steer texts buffered before the harness turn id was
    // named get the drop notice completeTurn emits for the same loss.
    while (this.preSessionLines.length > 0) {
      this.preSessionLines.shift();
      this.ack(this.fsm.nextInputSeq(), false, "shutting_down");
    }
    this.preSessionBytes = 0;
    if (this.queuedInputs > 0) {
      this.emitError(
        false,
        "codemux",
        "queued user input could not run before the session ended and was dropped"
      );
      this.queuedInputs = 0;
      this.turnQueue.length = 0;
    }
    this.dropBufferedSteer();
    // Read before the end-interrupt runs: whether a turn was open when
    // the end began decides whether an unanswered turn is synthesized
    // (below); the verdict's wording reads the turn state after the drain.
    const turnOpenAtFinish = this.fsm.state === "turn_active";
    this.supersedeApprovals();
    let interruptSent = false;
    if (
      this.fsm.state === "turn_active" &&
      this.capabilities.interrupt &&
      this.proc !== null
    ) {
      // The end path interrupts before the SIGTERM, and the interrupt
      // gets its own grace window (below), so the harness can answer and
      // persist its transcript cleanly. It
      // is a real correlated call, not an uncorrelated fire-and-forget:
      // the response (or its rejection) can arrive during the drain
      // below and the normal response handlers consume it — and the
      // interrupt is pending like any other, so a turn completing during
      // the drain is the interrupted completion, while a rejection
      // clears the flag and the turn's real completion stands (the
      // live4 rule). sendInterrupt, not an inline call: while a
      // turn/start response is still in flight (harnessTurnId null) the
      // interrupt buffers and rides that response, which lands inside
      // the drain — the old harnessTurnId guard skipped the interrupt
      // entirely in that window and the turn ran until the kill (review
      // live11).
      // A refused write (a harness that stopped reading, review live19)
      // leaves nothing to wait for, so the stop follows at once.
      interruptSent = this.sendInterrupt();
      if (!interruptSent && reason !== "crash") {
        // The claude driver's rule (review live25): an orderly end whose
        // interrupt the app-server would not take stops the turn by
        // signal, which is a failure, not a clean end. A crash end
        // already reported its own fatal.
        this.endExitCode = Math.max(this.endExitCode, 1);
        this.emitError(
          true,
          "codemux",
          "could not deliver the end-path interrupt to the codex process; the open turn was stopped by signal"
        );
      }
    }
    this.clearTimers();
    // The signal gate stays installed until cleanup completes: a second
    // SIGINT/SIGTERM during the grace window must hit the gate's
    // fire-once latch, not the default disposition, or codemux dies
    // mid-drain and the tree it was about to kill survives it.
    const proc = this.proc;
    let childOutcome: SessionChildOutcome | null = null;
    if (proc !== null) {
      if (interruptSent) {
        // The interrupt gets its own grace window before any signal
        // (review live17): the turn closes through its drained
        // completion, a failure arriving meanwhile raises the code, or
        // the child exits.
        const startCode = this.endExitCode;
        // A rejected interrupt clears its call id (applyResponseError),
        // so the wait also stops there instead of holding the full grace
        // (review live23; the claude driver's rule).
        await proc.awaitEndAnswer(
          () =>
            this.fsm.state !== "turn_active" ||
            this.endExitCode > startCode ||
            (!this.interruptQueued && this.interruptCallId === null)
        );
      }
      proc.endInput();
      await proc.awaitEndAnswer(() => false);
      proc.requestStop();
      await proc.settled;
      childOutcome = await proc.exited;

    }
    // A raw-newline fragment still buffered when the stream ended can never
    // complete: the output it held is reported as tier 3, never dropped
    // without a word (review live25).
    const fragment = this.parser.takeFragment();
    if (fragment !== null) {
      this.endExitCode = Math.max(this.endExitCode, 1);
      this.emitError(
        true,
        "harness",
        `unusable harness output (an unterminated JSON fragment at the end of the stream, ` +
          `${fragment.bytes} bytes): ${fragment.excerpt}`
      );
    }
    // Every nonzero code and signal exit fails, including during shutdown.
    const drainFailureCode = harnessFailed(childOutcome)
      ? childOutcome!.code ?? 1
      : null;
    if (drainFailureCode !== null) {
      reason = "harness_failed";
      this.endExitCode = Math.max(this.endExitCode, 1);
      if (this.firstFatal === null) this.emitError(
        true,
        "harness",
        drainFailureMessage("codex", childOutcome!, this.fsm.state === "turn_active")
      );
    }
    if (turnOpenAtFinish && this.fsm.state === "turn_active") {
      // The turn is still open and nothing else will ever answer it: the
      // crash path's fatal already told the failure story (a crash
      // mid-turn, review live11), the child exited without a completion
      // with code zero, or the
      // drain-failure verdict above just fired (review live12 — the two
      // blocks used to be mutually exclusive, so the one exit class the
      // verdict reported was the one class the synthesis refused to
      // answer). §4.1's pairing holds only if codemux answers the
      // `turn_started` it emitted, so synthesize the completion: failed
      // for a crash or a drain failure (the reason mirrors the fatal
      // that reported it), interrupted otherwise; the usage the open
      // turn already reported, or all-null usage (never guessed zeros)
      // when none came, raw null (codemux-originated) — the agy
      // precedent (review live10). The known usage also folds into the
      // session total: dropping it under-reported `session_ended.usage`
      // for tokens the caller had already seen (review live22).
      const turnId = this.fsm.activeTurn;
      const usage = this.turnUsage ?? emptyUsage();
      this.turnUsage = null;
      this.cumulative = addTurnUsage(this.cumulative, usage);
      const error = this.fsm.transition({
        kind: "turn_completed",
        turnId: turnId ?? "none",
      });
      if (error !== null) {
        this.endExitCode = Math.max(this.endExitCode, 1);
        this.emitError(true, "codemux", error.message);
      } else {
        const synthFinish =
          reason === "crash" || drainFailureCode !== null || this.firstFatal !== null
            ? "failed"
            : "interrupted";
        this.emit(
          buildEvent(++this.seq, this.sessionIdOrEmpty(), "turn_completed", null, {
            turn_id: turnId,
            finish: synthFinish,
            reason:
              reason === "crash"
                ? crashSynthesisReason(this.firstFatal)
                : drainFailureCode !== null
                  ? drainFailureMessage("codex", childOutcome!, true)
                  : this.firstFatal !== null
                    // A fatal raised during an orderly end's drain (an
                    // overlong line, an unknown response id) is a failure too
                    // (review live22).
                    ? crashSynthesisReason(this.firstFatal)
                    : `the session ended (${reason}) before the turn completed`,
            usage,
          }),
          { terminal: "fatal" }
        );
        // The synthesized completion is a turn the caller saw complete, so
        // it gets its ledger line like any other (call-log.ts).
        appendSessionTurnCallRecord(
          this.callLedger,
          this.ledgerSessionId(),
          turnId ?? "none",
          this.turnStartedAt.get(turnId ?? "") ?? Date.now(),
          synthFinish,
          usage
        );
        this.turnStartedAt.delete(turnId ?? "");
      }
    }
    // The child is dead and the pipes are drained: nothing more can
    // arrive, so the harness side closes for good. The FSM transitions
    // wait until here so a turn completing during the drain could still
    // leave `turn_active` through its own `turn_completed`.
    this.settled = true;
    this.fsm.transition({ kind: "shutdown_started" });
    this.fsm.transition({ kind: "ended" });
    // Resumable means the harness confirmed the session (the start was
    // recorded at its first identity-bearing frame) or, for a claimed
    // resume it never confirmed, that the end did not fail: a resume the
    // harness refused (a transcript Claude Code already cleaned up, a
    // thread codex cannot load) dies on the crash path or fails the
    // drain, and one that hung until a timeout proved nothing either;
    // reporting it resumable would send a retrying caller into the same
    // failure (review live21). A claimed resume that ended
    // cleanly before its first turn keeps the record the claim judged
    // (review live20).
    const resumable =
      this.capabilities.resume &&
      (this.registryRecorded ||
        (this.resumeClaimed && this.endExitCode === 0));
    // The per-session harness home's settlement (a codex override session's
    // CODEX_HOME, codex-provider.ts) runs here and only here: the child has
    // settled, so nothing writes the home anymore, and the resumable
    // verdict — what decides keep-vs-remove for a FRESH home — is final. A
    // resumed home is never removed at settlement (review D3,
    // correctness-2): its state predates this process, so an interrupted
    // resume must not delete the earlier turns with it; the sweep reclaims
    // it if no resume comes back. Best-effort by contract: a settlement
    // that cannot complete is reported by the home's own code, never
    // raised out of the end path. Its return is whether the state reached
    // where a resume finds it (review D2, correctness-2 2): a rename that
    // failed leaves the threads on in the run-shaped name a resume never
    // computes, so the report and the registry's promise must not claim
    // resumable — the caller is refused now instead of failing inside
    // codex on a thread-not-found later. The settlement runs BEFORE the
    // record release below: the release is what a --resume in another
    // process waits on, and a released record whose harness_home names a
    // keyed path that does not exist yet is refused "missing or untrusted"
    // in the window this ordering used to leave (review D7,
    // correctness-2 1).
    let settledHome = true;
    if (this.options.settleSessionHome !== undefined) {
      try {
        settledHome = this.options.settleSessionHome(this.threadId, resumable);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        console.error(`codemux: session home settlement failed: ${detail}`);
        settledHome = false;
      }
    }
    const ownsRecord = this.registryRecorded || this.resumeClaimed;
    if (ownsRecord && this.options.registryPath !== null && this.threadId !== null) {
      // A lost stamp rides stderr (releaseSessionRecord, review live13).
      releaseSessionRecord(this.options.registryPath, this.threadId);
    }
    const sent = this.out.enqueue(
      buildSessionEnded(++this.seq, this.sessionIdOrEmpty(), childOutcome, {
        reason,
        shutdown_requested: this.shutdownWasRequested,
        exit_code: this.endExitCode,
        usage: this.cumulative,
        resumable: resumable && settledHome,
      }),
      { terminal: true }
    );
    // The closing ledger line: the same cumulative usage and end verdict
    // the caller just received (call-log.ts).
    appendSessionCallRecord(
      this.callLedger,
      this.ledgerSessionId(),
      this.sessionStartedAt,
      reason,
      this.endExitCode,
      this.cumulative
    );
    // Exit-code honesty: `session_ended` is the one event the caller
    // cannot afford to lose, so a delivery that failed — the sink
    // rejected or stalled on the flush, or the queue refused the entry —
    // cannot report success. `finish` is already past its re-entry
    // guard, so the failure callback's own end attempt only raises
    // `endExitCode`; the code carries the truth. The give-up also
    // abandons the queue, so a stalled sink cannot hold the process
    // open past the report.
    const delivered = sent ? await awaitFinalFlush(this.out) : false;
    // Only now, with the report delivered and the exit code decided, do
    // the signal handlers come off: from here to process exit there is
    // no cleanup left for a signal to interrupt.
    this.signals.dispose();
    this.resolveDone(delivered ? this.endExitCode : Math.max(this.endExitCode, 1));
  }
}
