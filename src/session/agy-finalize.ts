/**
 * The agy session driver's session records and end path: the registry
 * start record, the deferred session_started announcement, and the
 * `finish` funnel every end path drains through. src/session/agy-driver.ts
 * owns the lifecycle.
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
import { recordSessionStartOffStream, releaseSessionRecord } from "./registry.js";
import { AgyDriverIo, type SessionEndReason } from "./agy-driver-io.js";

export abstract class AgyFinalize extends AgyDriverIo {
  /** The deferred session_started (see the class comment): the FSM has
   * already left `starting`; this is the caller-facing announcement and
   * the registry record. Codemux-originated, so raw is null — the
   * claude-family driver's precedent for the same synthesis. */
  protected override announceSessionStarted(): void {
    // The announcement follows the record's verdict: a required record
    // that failed must not announce — §4.8's fail-closed rule, nothing
    // is vouchable. A null registryPath records nothing and always
    // announces. The record itself runs off the turn's output stream
    // (review round 341): one lock attempt here, a busy lock retried on
    // a timer, never the synchronous full-budget wait that froze the
    // event loop mid-turn — the announcement lands when the verdict
    // does.
    this.recordStart(() => {
      if (this.settled) return;
      this.emit(
        buildEvent(++this.seq, this.sessionIdOrEmpty(), "session_started", null, {
          agent: "agy",
          model: this.options.model ?? null,
          autonomy: this.options.autonomy,
          cwd: this.options.cwd,
          sandboxed: this.options.sandboxed,
          sandbox_trust: this.options.sandboxTrust,
          capabilities: this.capabilities,
          protocol: "codemux-live-session/1",
        })
      );
    });
  }

  private recordStart(onRecorded: () => void): void {
    // A null registryPath records nothing and announces; a null
    // conversation id is the unreachable defensive case and announces
    // nothing (the old guard's exact behavior).
    if (this.options.registryPath === null) {
      onRecorded();
      return;
    }
    if (this.conversationId === null) return;
    recordSessionStartOffStream(
      this.options.registryPath,
      {
        id: this.conversationId,
        agent: "agy",
        cwd: this.options.cwd,
        hermetic: false,
        harness_home: this.options.harnessHome,
        model: this.options.model ?? null,
        autonomy: this.options.autonomy,
        sandboxed: this.options.sandboxed,
        sandbox_trust: this.options.sandboxTrust,
        sandbox_no_net: this.options.sandboxNoNet,
        sandbox_scrub_env: this.options.sandboxScrubEnv,
        sandbox_block: [...(this.options.sandboxBlock ?? [])],
        pass_env: [...this.options.passEnv],
        // The CLI refuses --enable-playwright-mcp outside the claude family.
        playwright_mcp: false,
        provider_base_url: this.options.providerBaseUrl,
        project_settings: false,
      },
      () => this.settled,
      (outcome) => {
        if (!outcome.ok) {
          // An untracked live session must not run (§4.8): the registry is
          // what makes resume's guards answerable, so failing to record it
          // fails the session closed.
          this.emitError(
            true,
            "codemux",
            `cannot record the session in the registry: ${outcome.error}`
          );
          void this.finish("crash", 1);
          return;
        }
        this.registryRecorded = true;
        onRecorded();
      },
      (error) =>
        console.error(
          `codemux: the registry lock is busy recording session ${this.conversationId} ` +
            `(${error}); retrying in the background`
        )
    );
  }

  // --- end path ----------------------------------------------------------

  /** Every end path funnels here (§4.6): no approvals or interrupts
   * exist on this harness, so the end carrier is the stdin close — the
   * input loop ends after the line it is running — and the harness gets
   * the grace to deliver that turn's result and exit before the stop
   * signal; then the tree is killed after a second grace, the pipe
   * drains until the child settles, and `session_ended` is the last
   * event on the stream. */
  private shutdownWasRequested = false;

  protected override async finish(
    reason: SessionEndReason,
    exitCode: number
  ): Promise<void> {
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
    // Read before the stop runs: whether a turn was open when the end
    // began decides whether an unanswered turn is synthesized (below);
    // the verdict's wording reads the turn state after the drain.
    const turnOpenAtFinish = this.fsm.state === "turn_active";
    this.clearTimers();
    // The signal gate stays installed until cleanup completes: a second
    // SIGINT/SIGTERM during the grace window must hit the gate's
    // fire-once latch, not the default disposition, or codemux dies
    // mid-drain and the tree it was about to kill survives it.
    let proc = this.proc;
    if (proc === null) {
      // An end path that began while the CLI's spawn was still pending —
      // a signal during the spawn's async preflight — has no child yet.
      // Holding here keeps everything below (the record release,
      // session_ended, run()'s resolution) behind the child's
      // settlement: attach() answers with the stopped child once it
      // settles, a spawn throw with none (review round 64).
      proc = await this.awaitLateChild();
      // A second signal latched while this child was still being born
      // (review round 162, finding 2): tree SIGKILL on arrival, not the
      // drain below.
      if (proc !== null) this.stopEscalation.escalateIfRequested(proc);
    }
    let childOutcome: SessionChildOutcome | null = null;
    if (proc !== null) {
      // agy has no interrupt; the stdin close is its only end carrier.
      // The input loop finishes the line it is running and exits, so the
      // wait is for the exit itself (or a failure raising the code),
      // bounded by the grace, before any signal (review live17 — SIGTERM
      // used to go out at once and the harness never saw EOF, so an open
      // turn was always the synthesized `interrupted` with null usage).
      proc.endInput();
      const startCode = this.endExitCode;
      await proc.awaitEndAnswer(() => this.endExitCode > startCode);
      // An escalated child is already tree-SIGKILLed; requestStop would
      // only arm timers against the dying group (stop-escalation.ts).
      if (!this.stopEscalation.escalateIfRequested(proc)) proc.requestStop();
      await proc.settled;
      childOutcome = await proc.exited;

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
        drainFailureMessage("agy", childOutcome!, this.fsm.state === "turn_active")
      );
    }
    if (turnOpenAtFinish && this.fsm.state === "turn_active") {
      // Review live10: agy has no interrupt carrier, so an end path with a
      // turn open leaves that turn's `turn_started` unanswered — every
      // other driver closes the pairing (claude and codex through the
      // end-interrupt's drained result). Synthesize the completion the
      // harness cannot: codemux-originated (raw null), the usage it
      // never reported all-null. Interrupted when the child exited zero;
      // failed on a crash end, whose fatal already reported the exit —
      // the crash used to skip the synthesis entirely, leaving the
      // `turn_started` unpaired (review live11) — and on a drain-failure
      // exit, whose verdict above just reported it the same way: the
      // two blocks used to be mutually exclusive, so the one exit class
      // the verdict reported was the one class the synthesis refused to
      // answer (review live12). The FSM is still `turn_active` here by
      // construction (a drained completion would have left it), so the
      // transition is legal; its failure is a codemux defect and costs
      // success.
      const turnId = this.fsm.activeTurn;
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
                  ? drainFailureMessage("agy", childOutcome!, true)
                  : this.firstFatal !== null
                    // A fatal raised during an orderly end's drain (an
                    // overlong line, an unknown response id) is a failure too
                    // (review live22).
                    ? crashSynthesisReason(this.firstFatal)
                    : `the session ended (${reason}) before the turn completed`,
            usage: emptyUsage(),
          }),
          { terminal: "fatal" }
        );
        // The synthesized completion is a turn the caller saw complete, so
        // it gets its ledger line like any other (all-null usage: the
        // harness never reported one).
        appendSessionTurnCallRecord(
          this.callLedger,
          this.ledgerSessionId(),
          turnId ?? "none",
          this.turnStartedAt.get(turnId ?? "") ?? Date.now(),
          synthFinish,
          emptyUsage()
        );
        this.turnStartedAt.delete(turnId ?? "");
      }
    }
    // The child is dead and the pipes are drained: nothing more can
    // arrive, so the harness side closes for good. The FSM transitions
    // wait until here so a result completing the open turn during the
    // drain could still leave `turn_active` through its own
    // `turn_completed`.
    this.settled = true;
    this.fsm.transition({ kind: "shutdown_started" });
    this.fsm.transition({ kind: "ended" });
    const ownsRecord = this.registryRecorded || this.resumeClaimed;
    if (
      ownsRecord &&
      this.options.registryPath !== null &&
      this.conversationId !== null
    ) {
      // A lost stamp rides stderr (releaseSessionRecord, review live13).
      releaseSessionRecord(this.options.registryPath, this.conversationId);
    }
    // Resumable means a result named this conversation, or, for a
    // recorded or claimed session agy never confirmed, that the end did
    // not fail (exit 0): a resume agy refused dies on the crash path or
    // fails the drain, and reporting it resumable would send a retrying
    // caller into the same failure (review live21). The record alone is no proof
    // here — a resumed session records at spawn. A resume that ended
    // cleanly before its first turn keeps the record the claim judged
    // (review live20). Either way the registry must hold the record:
    // a confirmed session whose start could not be recorded is one
    // `--resume` cannot find (exit 66), so it is not resumable — the
    // claude driver's rule (review live22).
    const resumable =
      this.capabilities.resume &&
      ownsRecord &&
      (this.harnessConfirmed || this.endExitCode === 0);
    // The exit code the report carries, read once here: a signal or a
    // failure landing during the final flush (through `finish`'s re-entry
    // arm) no longer changes the process exit code — the session had
    // already ended and told the caller its verdict. That holds for a
    // termination signal too: it exits 143 only when it stopped the
    // session, which the event then says (kimi's machine has the same
    // rule; docs/sessions.md states it under the exit table).
    const reported = this.endExitCode;
    const sent = this.out.enqueue(
      buildSessionEnded(++this.seq, this.sessionIdOrEmpty(), childOutcome, {
        reason,
        shutdown_requested: this.shutdownWasRequested,
        exit_code: reported,
        usage: this.cumulative,
        resumable,
      }),
      { terminal: true }
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
    const finalCode = delivered ? reported : Math.max(reported, 1);
    // The closing ledger line carries the process exit code: the reported
    // one, or nonzero when the report was not delivered (round 171).
    appendSessionCallRecord(this.callLedger, this.ledgerSessionId(), this.sessionStartedAt, reason, finalCode, this.cumulative);
    // Only now, with the report delivered and the exit code decided, do
    // the signal handlers come off: from here to process exit there is
    // no cleanup left for a signal to interrupt.
    this.signals.dispose();
    this.resolveDone(finalCode);
  }
}
