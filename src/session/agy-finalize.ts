/**
 * The agy session driver's session records and end path: the registry
 * start record, the deferred session_started announcement, and the
 * `finish` funnel every end path drains through (agy-driver.ts owns
 * the lifecycle).
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
import { buildEvent, buildSessionStarted } from "./protocol.js";
import {
  busyRecordExhaustedNotice,
  PENDING_RECORD_FATAL,
  recordSessionStartOffStream,
  releaseSessionRecord,
} from "./registry.js";
import { AgyDriverIo, type SessionEndReason } from "./agy-driver-io.js";
import { settledAgyHarnessHome } from "./agy-private-home.js";
import { isCallerHarnessHome, recordedHarnessHome } from "./harness-home.js";
import type { SessionPrivateHome } from "./private-home-types.js";

/** The pause between the two --final removal attempts: long enough for
 * an ephemeral rmSync failure (a scanner holding the directory open) to
 * pass (the claude driver's constant). */
const FINAL_REMOVE_RETRY_MS = 100;

export abstract class AgyFinalize extends AgyDriverIo {
  /** True once the end path ran the `--final` removal sequence (both
   * attempts, whatever the outcome): the CLI's tail removes a --final
   * home only while this is false, so it never re-decides a home the
   * end path already decided (the claude driver's rule, round 15). */
  finalRemovalRan = false;

  /** The `--final` removal, inside the end path (the claude family's
   * shape, driver.ts): one attempt, a short pause on failure, one
   * retry. A removal that throws is reported on stderr instead — the
   * end path still owes the caller its record release and
   * session_ended. By the time it answers, the home is gone or both
   * attempts failed. A session with no private home leaves nothing
   * private behind, so it answers true without touching the disk. */
  private async removeFinalHomeSettled(): Promise<boolean> {
    this.finalRemovalRan = true;
    const home = this.options.privateHome;
    if (home === undefined || home === null) return true;
    const attempt = (): boolean => {
      try {
        return home.remove();
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        console.error(
          `codemux: could not remove the session's private home ${home.dir} ` +
            `(${reason}); the directory was kept`
        );
        return false;
      }
    };
    if (attempt()) return true;
    await new Promise((resolve) => setTimeout(resolve, FINAL_REMOVE_RETRY_MS));
    return attempt();
  }

  /** The end path's keep-or-remove for a hermetic private home: a
   * resumed home is never removed here and needs no settle (it was
   * opened settled); a fresh resumable one settles onto `session-<id>`
   * so the reported resume path exists; a fresh non-resumable one is an
   * abandoned home — removed when `allowRemove`, else left to the sweep
   * (the `--final` sequence already attempted its own removal, round
   * 413 item 2). An error never escapes; false breaks the keep promise. */
  private settleHomeAtEnd(
    home: SessionPrivateHome,
    resumable: boolean,
    allowRemove: boolean
  ): boolean {
    if (isCallerHarnessHome(home)) return true;
    try {
      if (home.resumed) {
        if (!home.settled && this.conversationId !== null) home.settle(this.conversationId);
        return true;
      }
      if (resumable && this.conversationId !== null) {
        home.settle(this.conversationId);
        return home.settled;
      }
      return !allowRemove || home.remove();
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.error(`codemux: agy session private home settlement failed: ${detail}`);
      return false;
    }
  }

  /** A start record is out (`recordStart`) and its verdict has not
   * landed: the end path fails the session closed when it is still out
   * at the summary (review round 345) — the off-stream retries stop
   * there, so no verdict can arrive after it. */
  private recordPending = false;
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
    // event loop mid-turn.
    this.recordStart(() => {
      if (this.settled) return;
      this.emit(
        buildSessionStarted(++this.seq, this.sessionIdOrEmpty(), null, {
          agent: "agy",
          model: this.options.model ?? null,
          autonomy: this.options.autonomy,
          cwd: this.options.cwd,
          sandboxed: this.options.sandboxed,
          sandbox_trust: this.options.sandboxTrust,
          hermetic: this.options.hermetic === true,
          // Caller-owned homes retain their path; disposable homes settle by id.
          private_home:
            this.options.privateHome != null
              ? recordedHarnessHome(this.options.privateHome, this.sessionIdOrEmpty())
              : null,
          capabilities: this.capabilities,
          protocol: "codemux-live-session/1",
          // agy's wire carries no recorded init frame naming the model
          // the harness configured (design P5's declared gap).
          model_served: null,
          model_served_source: null,
          model_alias: this.options.modelAlias ?? null,
        })
      );
    });
  }

  private recordStart(onRecorded: () => void): void {
    // A null registryPath records nothing and announces; a null
    // conversation id is the unreachable defensive case and announces
    // nothing (the old guard's exact behavior). A record still pending
    // when the end path summarizes fails the session closed there
    // (`finish`, review round 345).
    if (this.options.registryPath === null) {
      onRecorded();
      return;
    }
    if (this.conversationId === null) return;
    this.recordPending = true;
    recordSessionStartOffStream(
      this.options.registryPath,
      {
        id: this.conversationId,
        agent: "agy",
        cwd: this.options.cwd,
        hermetic: this.options.hermetic === true,
        // A hermetic session records its private home's state directory
        // on the stable session-keyed spelling (settledAgyHarnessHome):
        // the live directory is still run-shaped when this record is
        // written, and a resume guard comparing paths must meet the one
        // spelling a resume can compute.
        harness_home:
          isCallerHarnessHome(this.options.privateHome) ? this.options.privateHome.dir : this.options.privateHome != null
            ? settledAgyHarnessHome(this.options.privateHome.dir, this.conversationId)
            : this.options.harnessHome,
        ...(isCallerHarnessHome(this.options.privateHome) ? { caller_owned_home: true } : {}),
        model: this.options.model ?? null,
        model_alias: this.options.modelAlias ?? null,
        autonomy: this.options.autonomy,
        sandboxed: this.options.sandboxed,
        sandbox_trust: this.options.sandboxTrust,
        sandbox_no_net: this.options.sandboxNoNet,
        sandbox_scrub_env: this.options.sandboxScrubEnv,
        sandbox_block: [...(this.options.sandboxBlock ?? [])],
        sandbox_strict: this.options.sandboxStrict === true,
        pass_env: [...this.options.passEnv],
        // Agy sessions do not support --enable-playwright-mcp (src/mcp.ts).
        playwright_mcp: false,
        provider_base_url: this.options.providerBaseUrl,
        project_settings: false,
      },
      () => this.settled,
      (outcome) => {
        this.recordPending = false;
        if (!outcome.ok) {
          // A resumed session is tracked by its pre-spawn claim: a busy
          // budget spent refreshing the record is a notice and the
          // announcement, not a crash — the claim is the record (round
          // 361, item 16). Every other failure class fails closed
          // (§4.8): the registry is what makes resume's guards answerable.
          if (outcome.kind === "busy" && this.resumeClaimed) {
            console.error(
              busyRecordExhaustedNotice(this.conversationId ?? "unknown", outcome.error)
            );
            onRecorded();
            return;
          }
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
        ),
      this.options.registryStartBudget
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
      // The input loop finishes the line it runs and exits, so the wait
      // is for the exit itself, bounded by the grace, before any signal
      // (review live17 — SIGTERM at once meant the harness never saw
      // EOF, and an open turn was always the synthesized `interrupted`
      // with null usage). No failure cuts the wait: the old
      // `endExitCode > startCode` cut fired only on a failure that
      // raised the code after the end began, never after an end that
      // started at 1 or 143 (review round 372, item 2), and any cut
      // that stops the child early turns its clean exit into a signal
      // exit, which the shared classification (process.ts) reports as a
      // harness failure instead of the fatal that ended the session.
      // The grace bounds the cost; the verdict stays honest.
      proc.endInput();
      await proc.awaitEndAnswer(() => false);
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
    // A start record still pending at the summary never lands: `settled`
    // (set a few lines below, with no yield between here and there) is
    // the off-stream retries' stop predicate, so this is the record's
    // last honest reading. The session ran untracked — the old
    // synchronous record failed closed here, and the off-stream move
    // must not lose that (review round 345): the fatal, a crash end,
    // exit 1.
    // A resumed conversation is tracked by the record the CLI's claim
    // wrote before the spawn (review round 356): fresh sessions only.
    if (this.recordPending && !this.resumeClaimed) {
      this.recordPending = false;
      reason = "crash";
      this.endExitCode = Math.max(this.endExitCode, 1);
      this.emitError(true, "codemux", PENDING_RECORD_FATAL);
    }
    if (turnOpenAtFinish && this.fsm.state === "turn_active") {
      // Review live10: agy has no interrupt carrier, so an end path with
      // a turn open leaves its `turn_started` unanswered — every other
      // driver closes the pairing. Synthesize the completion the harness
      // cannot: codemux-originated (raw null), the usage it never
      // reported all-null. Interrupted when the child exited zero; failed
      // on a crash end, whose fatal already reported the exit (the crash
      // used to skip the synthesis, leaving the `turn_started` unpaired,
      // review live11), and on a drain-failure exit, whose verdict above
      // just reported it — the blocks used to be mutually exclusive, so
      // the one exit class the verdict reported was the one the
      // synthesis refused to answer (review live12). The FSM is still
      // `turn_active` here by construction, so the transition is legal;
      // its failure is a codemux defect and costs success.
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
            // The wire names no model (see announceSessionStarted): no
            // served model exists to report (design P5's declared gap).
            model_served: null,
            model_served_source: null,
            model_alias: this.options.modelAlias ?? null,
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
          emptyUsage(),
          // The wire names no model (see announceSessionStarted): none to
          // record.
          null
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
    // Resumable means a result named this conversation, or, for a
    // recorded or claimed session agy never confirmed, that the end did
    // not fail (exit 0): a resume agy refused dies on the crash path or
    // fails the drain, and reporting it resumable would send a retrying
    // caller into the same failure (review live21). The record alone is
    // no proof — a resumed session records at spawn. A resume that
    // ended cleanly before its first turn keeps the record the claim
    // judged (review live20). Either way the registry must hold it: a
    // confirmed session whose start could not be recorded is one
    // `--resume` cannot find (exit 66) — the claude driver's rule
    // (review live22).
    const resumable =
      this.capabilities.resume &&
      ownsRecord &&
      (this.harnessConfirmed || this.endExitCode === 0);
    // The hermetic private home's settlement runs here and only here,
    // after the child is dead and the verdict is final; a broken keep
    // cancels resumable (review D2: a resume computes the session-keyed
    // path and would be refused on a home that never reached it).
    let settledHome = true;
    // `--final` replaces the settlement with the claude family's removal
    // contract (driver.ts): the whole two-attempt sequence runs here,
    // BEFORE the record release below, and the end stamp then writes
    // `final: true` with the release in one atomic update. A removal
    // that failed both attempts keeps the directory and the record
    // non-final, so the resumable verdict's promise must be real: the
    // kept home settles onto `session-<id>` here (round 413, item 2),
    // and the failure costs the exit code. A session whose spawn never
    // attached a child removes nothing (a resume keeps its transcript).
    let finalRemoved = false;
    const home = this.options.privateHome;
    if (this.options.final === true && childOutcome !== null && !isCallerHarnessHome(home)) {
      finalRemoved = await this.removeFinalHomeSettled();
      if (!finalRemoved) {
        this.endExitCode = Math.max(this.endExitCode, 1);
        if (home !== undefined && home !== null) {
          settledHome = this.settleHomeAtEnd(home, resumable, false);
        }
      }
    } else if (home !== undefined && home !== null) {
      settledHome = this.settleHomeAtEnd(home, resumable, true);
    }
    if (!settledHome) this.endExitCode = Math.max(this.endExitCode, 1);
    if (
      ownsRecord &&
      this.options.registryPath !== null &&
      this.conversationId !== null
    ) {
      // A lost stamp rides stderr (releaseSessionRecord, review live13);
      // after a --final removal it also fails the exit code (round 56).
      const stamped = releaseSessionRecord(
        this.options.registryPath,
        this.conversationId,
        this.options.final === true && finalRemoved
      );
      if (!stamped && finalRemoved) this.endExitCode = Math.max(this.endExitCode, 1);
    }
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
        // `--final` that removed the home leaves nothing to resume; a
        // removal that failed both attempts kept the home and the record
        // non-final, so the base verdict's promise is real (round 14).
        resumable: resumable && settledHome && !(this.options.final === true && finalRemoved),
      }),
      { terminal: true }
    );
    // Exit-code honesty: `session_ended` is the one event the caller
    // cannot afford to lose, so a delivery that failed — the sink
    // rejected or stalled, or the queue refused the entry — cannot
    // report success. `finish` is past its re-entry guard, so the
    // failure callback's own end attempt only raises `endExitCode`; the
    // code carries the truth. The give-up also abandons the queue, so a
    // stalled sink cannot hold the process open past the report.
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
