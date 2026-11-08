/**
 * The opencode session driver's shared state, session records, and end
 * path (src/session/opencode-driver.ts owns the lifecycle and the
 * caller-facing edges). Everything the driver's parts share — the FSM,
 * the outbound queue, the session-id model, the turn/child bookkeeping —
 * is declared here once; the classes above it in the chain
 * (opencode-turns.ts) and the driver itself fill in the machinery.
 */

import { randomUUID } from "node:crypto";
import type { ResultUsageBlock } from "../types.js";
import {
  appendSessionCallRecord,
  appendSessionTurnCallRecord,
  type SessionCallContext,
} from "../call-log.js";
import { emptyUsage } from "../result-envelope.js";
import { opencodeSessionCapabilities } from "./opencode-session.js";
import { SessionFsm } from "./fsm.js";
import {
  awaitFinalFlush,
  buildSessionEnded,
  harnessFailed,
  shutdownRequested,
  BoundedOutboundQueue,
  crashSynthesisReason,
  drainFailureMessage,
  DEFAULT_SHUTDOWN_GRACE_MS,
  type SessionChildOutcome,
  type SessionProcess,
  type SessionSignalGate,
} from "./process.js";
import type { OpenCodeDriverOptions } from "./opencode-options.js";
import { SessionStopEscalation } from "./stop-escalation.js";
import { awaitSpawnWithGrace, holdAbandonedSpawn } from "./spawn-wait.js";
import { buildEvent } from "./protocol.js";
import {
  PENDING_RECORD_FATAL,
  recordSessionStartOffStream,
  releaseSessionRecord,
} from "./registry.js";
import { addUsage } from "./usage.js";
import type { SessionEndReason } from "./agy-driver.js";

export type { OpenCodeDriverOptions } from "./opencode-options.js";

export abstract class OpenCodeDriverCore {
  /** The driver options (OpenCodeDriverOptions above); assigned by
   * OpenCodeSessionDriver's constructor, which owns the lifecycle. */
  protected options!: OpenCodeDriverOptions;
  protected readonly fsm = new SessionFsm();
  protected readonly capabilities = opencodeSessionCapabilities();
  protected out!: BoundedOutboundQueue;
  protected signals!: SessionSignalGate;
  protected turnProc: SessionProcess | null = null;
  /** The in-flight turn spawn: set synchronously before spawnTurn is
   * called, cleared once it lands. The end path awaits it (see finish)
   * so a child that lands after the session ended is stopped and its
   * tree settled BEFORE done resolves — the CLI's cleanup (the turn's
   * provider config removal) runs the moment done does, and a live
   * opencode process must never run past it (review D5, correctness 2;
   * a graceful end runs it instead, inside the end path, review D11). */
  protected turnSpawn: Promise<SessionProcess> | null = null;
  /** The open turn's prompt (the stdin payload the child has not
   * received yet): set at submit, reset with the other per-turn
   * accumulators. finish reads it to deliver the prompt to a child that
   * lands while a graceful end is already in flight (review D11,
   * correctness 2 1) — turnSpawn being non-null guarantees it was set
   * for this same turn, synchronously, before the spawn existed. */
  protected turnPrompt: string | null = null;
  protected seq = 0;
  /** The native session id: adopted from the first run-output line (a
   * fresh session) or the registry-vouched resume id adopted at run start.
   * Null until one of those lands. */
  protected sessionId!: string | null;
  /** Codemux's own id for this session, minted at construction: what the
   * call ledger records while no run-output line has named the session
   * (and ever after, if none ever does), so id-less sessions never share
   * a key (review ul6). */
  protected readonly codemuxSessionId = randomUUID();
  /** A run-output line named this session: the harness confirmed it. A
   * resumed session records at spawn from the vouched id, so the record
   * alone does not prove opencode can load the session (the agy rule,
   * review live21). */
  protected harnessConfirmed = false;
  protected cumulative: ResultUsageBlock = emptyUsage();
  /** The open turn's folded step_finish usage and first error-line
   * message; reset at submit, consumed at the turn's completion. */
  protected turnUsage: ResultUsageBlock | null = null;
  protected turnError: string | null = null;
  protected registryRecorded = false;
  /** A start record is out and its verdict has not landed: still out at
   * the summary, the end path fails the session closed (review 345). */
  protected recordPending = false;
  /** The CLI claimed the record for a resume before anything spawned
   * (`adoptResumeClaim`): every end path releases the claim. */
  protected resumeClaimed = false;
  protected touchWarned = false;
  protected finished = false;
  /** The reason of the end path that owns cleanup (set with finished,
   * never overwritten): startTurn's finished-arm reads it to tell a
   * graceful end — which will run its late-landed child (review D11) —
   * from a signal, timeout, or crash end, which kills it on arrival. */
  protected endReason: SessionEndReason | null = null;
  /** The end path's exit code, updatable while cleanup drains (review
   * live7). Monotone: only a higher code ever wins. */
  protected endExitCode = 0;
  protected lastChildOutcome: SessionChildOutcome | null = null;
  /** True once the end path gave up on the in-flight turn spawn, and
   * the hold that stops its late-landing child (review round 110): the
   * CLI awaits the hold before the cleanup a live child would race
   * (the turn's provider config removal, review D5). */
  protected turnSpawnAbandoned = false;
  protected abandonedSpawnHold: Promise<void> | null = null;
  /** The second-signal escalation (src/session/stop-escalation.ts). */
  protected readonly stopEscalation = new SessionStopEscalation();
  protected sawHarnessFailure = false;
  /** True only once the end path has settled every child: run-output
   * lines keep being parsed and emitted through the whole shutdown drain
   * (review live5). */
  protected settled = false;
  protected firstFatal: string | null = null;
  /** The wall clock each open turn started at, keyed by turn id: the
   * ledger's session_turn records carry each turn's own duration. */
  protected readonly turnStartedAt = new Map<string, number>();
  /** The session's own start, for the closing ledger record's duration. */
  protected readonly sessionStartedAt = Date.now();
  /** The launch facts the call ledger records on every turn and at the
   * end (call-log.ts); the provider is the override's host or "default". */
  protected callLedger!: SessionCallContext;
  protected done!: Promise<number>;
  protected resolveDone!: (code: number) => void;
  protected shutdownWasRequested = false;

  // Filled in above this class in the chain (opencode-driver.ts owns the
  // outbound lane and the timers; the turn verdict lives there and the
  // turn-exit hook in opencode-turns.ts).
  protected abstract emit(line: string, options?: { terminal?: boolean | "fatal" }): void;
  protected abstract emitError(
    fatal: boolean,
    source: "codemux" | "harness",
    message: string
  ): void;
  protected abstract clearTimers(): void;
  protected abstract completeTurn(outcome: SessionChildOutcome): void;
  protected abstract onTurnExited(
    proc: SessionProcess,
    outcome: SessionChildOutcome
  ): Promise<void>;

  // --- end path ------------------------------------------------------------
  /** Every end path funnels here (§4.6). The open turn's process gets the
   * grace to finish on its own first — its completion is the drained
   * output the caller is owed — then the stop signal and the tree-scoped
   * kill; an idle session has no child at all. A turn still SPAWNING gets
   * the same grace when the end is graceful (stdin-close, shutdown): its
   * late-landing child is delivered the prompt and run through the same
   * drain (review D11, correctness 2 1); a signal, timeout, or crash end
   * kills the late child on arrival (review D5, correctness 2). */
  protected async finish(reason: SessionEndReason, exitCode: number): Promise<void> {
    this.shutdownWasRequested ||= shutdownRequested(reason);
    if (this.finished) {
      // Idempotent cleanup, honest verdict (review live7).
      this.endExitCode = Math.max(this.endExitCode, exitCode);
      return;
    }
    this.finished = true;
    this.endReason = reason;
    this.endExitCode = exitCode;
    const turnOpenAtFinish = this.fsm.state === "turn_active";
    this.clearTimers();
    const proc = this.turnProc;
    const spawn = this.turnSpawn;
    // The turn's process to drain, once landed: the one already running,
    // or — on a graceful end — the one that lands while this path waits.
    let drain: SessionProcess | null = proc;
    if (drain === null && spawn !== null) {
      // A turn whose spawn was still in flight when the end path began
      // (an end between the turn's start and its child landing). The
      // wait itself is bounded by the stop grace (review round 110):
      // the CLI's cleanup — for opencode, the turn's provider config
      // removal — runs the moment done resolves, so a stalled spawn
      // must not hold the end past it. A graceful end meets the D5 rule
      // by RUNNING the turn inside this path (review D11, correctness
      // 2 1): deliver the prompt (startTurn's finished-arm leaves the
      // child untouched for exactly this) and give it the landed path's
      // drain below. A signal, timeout, or crash end keeps the D5 rule:
      // stop on arrival. A spawn that outlasts the grace is given up on
      // below — fatally, and with the hold stopping whatever lands late.
      let late: SessionProcess | null = null;
      const graceMs = this.options.spawnGraceMs ?? DEFAULT_SHUTDOWN_GRACE_MS;
      const wait = await awaitSpawnWithGrace(spawn, graceMs);
      if (wait.kind === "landed") {
        late = wait.child;
      } else if (wait.kind === "rejected") {
        // No child to stop. A graceful end owes this turn its run
        // (review D11), and a rejected spawn means that run can never
        // happen: report it exactly as startTurn's pre-end path does
        // (review round 73) — the fatal fails the open turn's synthesis
        // and the crash's code raises the exit to at least 1. A
        // signal, timeout, or crash end already carries its verdict and
        // owes no run, so the rejection stays absorbed there.
        if (
          (reason === "stdin-close" || reason === "shutdown") &&
          this.fsm.state === "turn_active"
        ) {
          this.emitError(
            true,
            "codemux",
            "could not spawn the opencode turn process " +
              `(${wait.error instanceof Error ? wait.error.message : String(wait.error)})`
          );
          void this.finish("crash", 1);
        }
      } else {
        // The spawn outlasted the grace (review round 110): fatal
        // whatever the reason — the graceful arm's run can never happen
        // now — so the open turn's synthesis answers failed and the
        // exit code is at least 1. The hold stops a late-landing child
        // and settles it before the CLI's cleanup (review D5).
        this.turnSpawnAbandoned = true;
        this.abandonedSpawnHold = holdAbandonedSpawn(spawn, graceMs, this.stopEscalation);
        this.endExitCode = Math.max(this.endExitCode, 1);
        this.emitError(
          true,
          "codemux",
          `the opencode turn process never appeared within the ${graceMs} ms end grace; ending without it`
        );
      }
      if (late !== null) {
        // A second signal latched while this child was still being born
        // (review round 162, finding 2): tree SIGKILL on arrival — not
        // the run a graceful end owes the turn, not the stop with grace.
        const escalated = this.stopEscalation.escalateIfRequested(late);
        if (
          !escalated &&
          (reason === "stdin-close" || reason === "shutdown") &&
          this.fsm.state === "turn_active"
        ) {
          const child = late;
          this.turnProc = child;
          child.exited.then((outcome) => {
            void this.onTurnExited(child, outcome);
          });
          const written = child.writeRaw(this.turnPrompt ?? "");
          if (written.ok) {
            child.endInput();
            drain = child;
          } else {
            // The child cannot take the prompt (it died on arrival):
            // the turn never ran, so report the delivery failure and
            // fall back to the kill — the synthesis answers the turn
            // failed. finish is already in flight; the crash call only
            // raises the verdict's exit code.
            this.turnProc = null;
            this.emitError(
              true,
              "codemux",
              "could not deliver the prompt to the opencode process " +
                `(${written.reason ?? "unknown"})`
            );
            void this.finish("crash", 1);
          }
        }
        if (drain === null) {
          if (!escalated) late.requestStop();
          await late.settled;
          this.lastChildOutcome = await late.exited;

        }
      }
    }
    if (drain !== null) {
      // The turn process's stdin is already at EOF (the prompt write
      // half-closed it), so there is no end carrier to send: the wait is
      // for a fatal verdict or the child's raw exit —
      // then the stop signal, then the settle.
      await drain.awaitEndAnswer(() => this.firstFatal !== null || this.endExitCode !== 0);
      // An escalated child is already tree-SIGKILLed; requestStop would
      // only arm timers against the dying group (stop-escalation.ts).
      if (!this.stopEscalation.escalateIfRequested(drain)) drain.requestStop();
      await drain.settled;
      this.lastChildOutcome = await drain.exited;

      this.turnProc = null;
    }
    if (this.sawHarnessFailure) {
      this.endExitCode = Math.max(this.endExitCode, 1);
      reason = "harness_failed";
    }
    // Every nonzero code and signal exit fails, including during shutdown.
    const drainFailureCode = harnessFailed(this.lastChildOutcome)
      ? this.lastChildOutcome!.code ?? 1
      : null;
    if (drainFailureCode !== null) {
      reason = "harness_failed";
      this.endExitCode = Math.max(this.endExitCode, 1);
      if (this.firstFatal === null) this.emitError(
        true,
        "harness",
        drainFailureMessage("opencode", this.lastChildOutcome!, this.fsm.state === "turn_active")
      );
    }
    // A start record still pending at the summary never lands: `settled`
    // (set below, no yield between) stops the retries, so the session ran
    // untracked — fail closed like the old synchronous record (round 345).
    if (this.recordPending && !this.resumeClaimed) { // fresh sessions only (round 356)
      this.recordPending = false;
      reason = "crash";
      this.endExitCode = Math.max(this.endExitCode, 1);
      this.emitError(true, "codemux", PENDING_RECORD_FATAL);
    }
    if (turnOpenAtFinish && this.fsm.state === "turn_active") {
      // The open turn's `turn_started` must be answered (review live10/
      // live12): synthesize the completion the harness cannot. Failed on
      // a crash end (its fatal already reported the exit), a drain
      // failure, any fatal raised during the drain, or an error line the
      // turn's own stream carried (the completeTurn rule, review round
      // 123); interrupted otherwise. The usage is the turn's real folded
      // step_finish report — partial, but reported, not guessed.
      const turnId = this.fsm.activeTurn;
      const usage = this.turnUsage ?? emptyUsage();
      const error = this.fsm.transition({
        kind: "turn_completed",
        turnId: turnId ?? "none",
      });
      if (error !== null) {
        this.endExitCode = Math.max(this.endExitCode, 1);
        this.emitError(true, "codemux", error.message);
      } else {
        const synthFinish =
          reason === "crash" || drainFailureCode !== null || this.firstFatal !== null ||
          this.turnError !== null
            ? "failed"
            : "interrupted";
        this.cumulative = addUsage(this.cumulative, usage);
        this.emit(
          buildEvent(++this.seq, this.sessionIdOrEmpty(), "turn_completed", null, {
            turn_id: turnId,
            finish: synthFinish,
            reason:
              this.turnError !== null
                ? this.turnError
                : reason === "crash"
                  ? crashSynthesisReason(this.firstFatal)
                  : drainFailureCode !== null
                    ? drainFailureMessage("opencode", this.lastChildOutcome!, true)
                    : this.firstFatal !== null
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
    this.settled = true;
    this.fsm.transition({ kind: "shutdown_started" });
    this.fsm.transition({ kind: "ended" });
    const ownsRecord = this.registryRecorded || this.resumeClaimed;
    if (
      ownsRecord &&
      this.options.registryPath !== null &&
      this.sessionId !== null
    ) {
      releaseSessionRecord(this.options.registryPath, this.sessionId);
    }
    // Resumable means a run-output line named this session, or, for a
    // recorded or claimed session opencode never confirmed, that the end
    // did not fail (the agy rule, review live21/live22): the registry
    // must hold the record a `--resume` can find.
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
      buildSessionEnded(++this.seq, this.sessionIdOrEmpty(), this.lastChildOutcome, {
        reason,
        shutdown_requested: this.shutdownWasRequested,
        exit_code: reported,
        usage: this.cumulative,
        resumable,
      }),
      { terminal: true }
    );
    const delivered = sent ? await awaitFinalFlush(this.out) : false;
    const finalCode = delivered ? reported : Math.max(reported, 1);
    // The closing ledger line carries the process exit code: the reported
    // one, or nonzero when the report was not delivered (round 171).
    appendSessionCallRecord(this.callLedger, this.ledgerSessionId(), this.sessionStartedAt, reason, finalCode, this.cumulative);
    this.resolveDone(finalCode);
    // The handlers stay installed past done while the abandoned spawn's
    // hold still waits (kimi's rule, round al30): a second signal there
    // escalates the late child instead of being absorbed. dispose is
    // process-off under the hood, so the CLI's later dispose() is safe.
    if (this.turnSpawnAbandoned) await this.abandonedSpawnHold;
    this.signals.dispose();
  }

  /** The CLI awaits this before the cleanup a late-landing child would
   * race (review round 110, review D5): resolved once the abandoned
   * spawn can no longer start a child unnoticed. */
  awaitAbandonedSpawn(): Promise<void> {
    return this.abandonedSpawnHold ?? Promise.resolve();
  }

  // --- helpers ---------------------------------------------------------------
  /** The start record, one lock attempt at a time: a busy lock retries on
   * a timer off the turn's output stream (review round 341), never the
   * synchronous full-budget wait; `onRecorded` runs once the verdict is
   * in. A null registryPath records nothing and reports success at once;
   * a null session id reports nothing (the old guard's exact behavior).
   * A record still pending at the end fails the session closed
   * (`finish`, review round 345). */
  protected recordStart(onRecorded: () => void): void {
    if (this.options.registryPath === null) {
      onRecorded();
      return;
    }
    if (this.sessionId === null) return;
    this.recordPending = true;
    recordSessionStartOffStream(
      this.options.registryPath,
      {
        id: this.sessionId,
        agent: "opencode",
        cwd: this.options.cwd,
        hermetic: this.options.hermetic,
        harness_home: this.options.harnessHome,
        model: this.options.model ?? null,
        autonomy: this.options.autonomy,
        sandboxed: this.options.sandboxed,
        sandbox_trust: this.options.sandboxTrust,
        sandbox_no_net: this.options.sandboxNoNet,
        sandbox_scrub_env: this.options.sandboxScrubEnv,
        sandbox_block: [...(this.options.sandboxBlock ?? [])],
        pass_env: [...this.options.passEnv],
        playwright_mcp: false,
        provider_base_url: this.options.providerBaseUrl,
        project_settings: false,
      },
      () => this.settled,
      (outcome) => {
        this.recordPending = false;
        if (!outcome.ok) {
          // An untracked live session must not run (§4.8).
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
          `codemux: the registry lock is busy recording session ${this.sessionId} ` +
            `(${error}); retrying in the background`
        )
    );
  }

  // stampActivity (review live13) moved beside its only caller,
  // opencode-driver.ts's completeTurn.

  protected sessionIdOrEmpty(): string {
    return this.sessionId ?? "";
  }

  /** The id the call ledger keys this session's records by: the harness's
   * own session id once a run-output line has named one (the registry key,
   * stable across a resume), else the codemux-minted id every session owns
   * from construction — never "", which merged every id-less session under
   * one key in `calls --sum` (review ul6). */
  protected ledgerSessionId(): string {
    return this.sessionId || this.codemuxSessionId;
  }
}
