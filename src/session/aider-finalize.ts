/**
 * The aider session driver's shared state, session records, and end path
 * (src/session/aider-driver.ts owns the lifecycle and the caller-facing
 * edges). Everything the driver's parts share — the FSM, the outbound
 * queue, the turn/child bookkeeping — is declared here once; the classes
 * above it in the chain (aider-turns.ts, aider-input.ts) and the driver
 * itself fill in the machinery.
 */

import type { AutonomyLevel, ReasoningEffort, ResultUsageBlock } from "../types.js";
import {
  appendSessionCallRecord,
  appendSessionTurnCallRecord,
  type SessionCallContext,
} from "../call-log.js";
import { emptyUsage } from "../result-envelope.js";
import { HEADLESS_NEGATIVE_RESPONSES } from "../adapters/aider.js";
import {
  aiderSessionCapabilities,
  createAiderSessionHistory,
  removeAiderSessionHistory,
} from "./aider-session.js";
import { SessionFsm } from "./fsm.js";
import {
  awaitFinalFlush,
  buildSessionEnded,
  harnessFailed,
  shutdownRequested,
  BoundedOutboundQueue,
  crashSynthesisReason,
  drainFailureMessage,
  type SessionChildOutcome,
  type SessionProcess,
  type SessionSignalGate,
} from "./process.js";
import { buildEvent } from "./protocol.js";
import {
  recordSessionStart,
  releaseSessionRecord,
  sessionHoldState,
  type SandboxTrust,
} from "./registry.js";
import type { SessionEndReason } from "./agy-driver.js";

export interface AiderDriverOptions {
  /** The codemux-minted session id (the registry key and the history
   * directory's name); aider has no native session id. */
  sessionId: string;
  /** True when this session resumes a recorded one (the id is
   * registry-vouched and the history file must already exist). */
  resume: boolean;
  autonomy: AutonomyLevel;
  /** The `--model` value (already `openai/`-prefixed under a provider
   * override — the CLI owns that mapping). Reported as-is. */
  model?: string;
  /** The `--weak-model` value; set only under a provider override. */
  weakModel?: string;
  effort?: ReasoningEffort;
  /** The per-session chat history file (aiderSessionHistoryPath). */
  historyPath: string;
  /** The validated working directory — also the registry's cwd record. */
  cwd: string;
  hermetic: boolean;
  sandboxed: boolean;
  sandboxTrust: SandboxTrust;
  sandboxNoNet: boolean;
  /** The caller's --sandbox-block paths, canonicalized; recorded and
   * compared on resume (registry/format.ts). */
  sandboxBlock?: readonly string[];
  sandboxScrubEnv: boolean;
  passEnv: readonly string[];
  authorPrefix: boolean;
  sessionTimeoutMs: number | null;
  /** Null disables registry writes (unit tests); the CLI always passes one. */
  registryPath: string | null;
  /** The harness state home recorded for this session (§4.8). */
  harnessHome: string;
  /** The provider identity recorded for the resume guard (review D3):
   * the override's base URL, or null for the operator's own login. */
  providerBaseUrl: string | null;
  /** Spawns one process per turn; a throw is reported as a codemux
   * failure, never an unhandled rejection. */
  spawnTurn: (argv: string[]) => Promise<SessionProcess>;
  sink?: (line: string) => Promise<void> | void;
}

export abstract class AiderDriverCore {
  /** The driver options (AiderDriverOptions above); assigned by
   * AiderSessionDriver's constructor, which owns the lifecycle. */
  protected options!: AiderDriverOptions;
  protected readonly fsm = new SessionFsm();
  protected readonly capabilities = aiderSessionCapabilities();
  protected out!: BoundedOutboundQueue;
  protected signals!: SessionSignalGate;
  protected turnProc: SessionProcess | null = null;
  /** The in-flight turn spawn: set synchronously before spawnTurn is
   * called, cleared once it lands. The end path awaits it (see finish)
   * so a child that lands after the session ended is stopped and its
   * tree settled BEFORE done resolves — the CLI's cleanup runs the
   * moment done does, and an aider process must never run past it
   * (review D5, correctness 2). */
  protected turnSpawn: Promise<SessionProcess> | null = null;
  protected seq = 0;
  protected cumulative: ResultUsageBlock = emptyUsage();
  protected registryRecorded = false;
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
  protected sawHarnessFailure = false;
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

  // Filled in above this class in the chain (aider-driver.ts owns the
  // outbound lane and the timers; the turn exit/completion hooks live in
  // aider-turns.ts and aider-driver.ts).
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

  /**
   * The pre-spawn step (the claude-family pattern): create the fresh
   * session's history file and write the start record — codemux owns the
   * identity, so nothing about either waits on the harness. On a resume
   * this follows the claim and updates the claimed record in place with
   * the flags the resume runs under; the history file is never touched
   * (creating it would wipe the conversation). Returns the failure
   * message, or null once this session's state is in place.
   */
  recordBeforeSpawn(): string | null {
    if (!this.options.resume) {
      try {
        // The sweep's liveness skip is registry-backed: a session another
        // codemux process holds open is never aged out, however old its
        // directory mtime sits (review D2, security 2).
        const registryPath = this.options.registryPath;
        createAiderSessionHistory(
          this.options.historyPath,
          registryPath === null
            ? undefined
            : (id) => sessionHoldState(registryPath, id)
        );
      } catch (error) {
        return `cannot create the session history file: ${
          error instanceof Error ? error.message : String(error)
        }`;
      }
    }
    return this.writeStartRecord();
  }

  /** Remove a fresh session's history directory when its start record
   * failed (the CLI exits right after): nothing would point at the
   * directory, so it would sit orphaned until the 28-day sweep (review
   * D2, correctness-2 3). No-op on a resume — the history file is the
   * resumed conversation, never a fresh one to remove — and best-effort:
   * the registry failure the caller already holds is the one to report,
   * so a removal failure only warns on stderr. */
  removeFreshHistory(): void {
    if (this.options.resume) return;
    try {
      removeAiderSessionHistory(this.options.historyPath);
    } catch (error) {
      console.error(
        `codemux: could not remove the unrecorded session history directory ` +
          `(${this.options.historyPath}): ${
            error instanceof Error ? error.message : String(error)
          }`
      );
    }
  }

  // --- end path ------------------------------------------------------------
  /** Every end path funnels here (§4.6). The open turn's process gets
   * the grace to finish on its own first — its exit appends the
   * exchange and the reply is the drained output the caller is owed —
   * then the stop signal and the tree-scoped kill; an idle session has
   * no child at all. A turn still SPAWNING gets the same grace when the
   * end is graceful (stdin-close, shutdown): its late-landing child is
   * primed with the canned negatives and run through the same drain
   * (review D11, correctness 2 1); a signal, timeout, or crash end
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
      // CLI's cleanup runs the moment done resolves, so the late child
      // must be stopped and its tree settled BEFORE that (review D5,
      // correctness 2 — the opencode twin of this branch names the
      // provider-config deletion; aider's child holds nothing codemux
      // deletes, but the ordering rule is one). A graceful end meets
      // that by RUNNING the turn inside this path instead (review D11,
      // correctness 2 1): the child landed before its negatives were
      // written, so prime its stdin (startTurn's finished-arm leaves
      // the child untouched for exactly this) and give it the landed
      // path's drain below — the turn finishes and settles before done
      // resolves, or the drain's grace expiry stops it. A signal,
      // timeout, or crash end stops the late child on arrival. Any
      // nonzero or signal exit still fails the session.
      let late: SessionProcess | null = null;
      try {
        late = await spawn;
      } catch (error) {
        late = null; // no child to stop
        // A graceful end owes this turn its run (review D11), and a
        // spawn that rejects here means that run can never happen:
        // report it exactly as startTurn's pre-end path does (review
        // round 73). The fatal makes the open turn's synthesized
        // completion failed rather than interrupted, and the crash's
        // code raises the session's exit code to at least 1 — finish
        // is already in flight, so its idempotent arm only raises the
        // code; session_ended still follows this path's own ordering.
        // A signal, timeout, or crash end already carries a nonzero
        // verdict and owes no run, so the rejection stays absorbed
        // there.
        if (
          (reason === "stdin-close" || reason === "shutdown") &&
          this.fsm.state === "turn_active"
        ) {
          this.emitError(
            true,
            "codemux",
            "could not spawn the aider turn process " +
              `(${error instanceof Error ? error.message : String(error)})`
          );
          void this.finish("crash", 1);
        }
      }
      if (late !== null) {
        if (
          (reason === "stdin-close" || reason === "shutdown") &&
          this.fsm.state === "turn_active"
        ) {
          const child = late;
          this.turnProc = child;
          child.exited.then((outcome) => {
            void this.onTurnExited(child, outcome);
          });
          const written = child.writeRaw(HEADLESS_NEGATIVE_RESPONSES);
          if (written.ok) {
            child.endInput();
            drain = child;
          } else {
            // The child cannot take the negatives (it died on arrival):
            // the turn never ran, so report the delivery failure and
            // fall back to the kill — the synthesis answers the turn
            // failed. finish is already in flight; the crash call only
            // raises the verdict's exit code.
            this.turnProc = null;
            this.emitError(
              true,
              "codemux",
              "could not deliver the negative responses to the aider process " +
                `(${written.reason ?? "unknown"})`
            );
            void this.finish("crash", 1);
          }
        }
        if (drain === null) {
          late.requestStop();
          await late.settled;
          this.lastChildOutcome = await late.exited;

        }
      }
    }
    if (drain !== null) {
      // The turn process's stdin is already at EOF (the negatives write
      // half-closed it), so there is no end carrier to send: the wait is
      // for a fatal verdict or the child's raw exit —
      // then the stop signal, then the settle.
      await drain.awaitEndAnswer(() => this.firstFatal !== null || this.endExitCode !== 0);
      drain.requestStop();
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
        drainFailureMessage("aider", this.lastChildOutcome!, this.fsm.state === "turn_active")
      );
    }
    // Captured before the block below: the transition inside it moves
    // the FSM, and this is also the not-resumable verdict's input (an
    // open turn answered by synthesis left the history half-written).
    const openTurnInterrupted =
      turnOpenAtFinish && this.fsm.state === "turn_active";
    if (openTurnInterrupted) {
      // The open turn's `turn_started` must be answered (review live10/
      // live12): synthesize the completion the harness cannot, with the
      // usage aider never reports all-null rather than guessed zeros.
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
          buildEvent(++this.seq, this.options.sessionId, "turn_completed", null, {
            turn_id: turnId,
            finish: synthFinish,
            reason:
              reason === "crash"
                ? crashSynthesisReason(this.firstFatal)
                : drainFailureCode !== null
                  ? drainFailureMessage("aider", this.lastChildOutcome!, true)
                  : this.firstFatal !== null
                    ? crashSynthesisReason(this.firstFatal)
                    : `the session ended (${reason}) before the turn completed`,
            usage: emptyUsage(),
          }),
          { terminal: "fatal" }
        );
        // The synthesized completion is a turn the caller saw complete, so
        // it gets its ledger line like any other (all-null usage, the same
        // honesty the event carries).
        appendSessionTurnCallRecord(
          this.callLedger,
          this.options.sessionId,
          turnId ?? "none",
          this.turnStartedAt.get(turnId ?? "") ?? Date.now(),
          synthFinish,
          emptyUsage()
        );
        this.turnStartedAt.delete(turnId ?? "");
      }
    }
    this.settled = true;
    this.fsm.transition({ kind: "shutdown_started" });
    this.fsm.transition({ kind: "ended" });
    const ownsRecord = this.registryRecorded || this.resumeClaimed;
    if (ownsRecord && this.options.registryPath !== null) {
      releaseSessionRecord(this.options.registryPath, this.options.sessionId);
    }
    // Resumable requires an orderly end: the history file is the
    // resumable state, and a session that ended on a failure may have
    // left it mid-exchange (a resume would replay a half-written turn).
    // An open turn answered by synthesis is exactly that mid-exchange
    // state — aider writes the `#### ` user block when the turn starts
    // and the reply only at its end, so a killed turn leaves an
    // unanswered prompt that `--restore-chat-history` would replay —
    // even when termination is requested during normal shutdown. A
    // nonzero or signal exit still fails the session.
    const resumable =
      this.capabilities.resume &&
      ownsRecord &&
      this.endExitCode === 0 &&
      !openTurnInterrupted && !harnessFailed(this.lastChildOutcome);
    const sent = this.out.enqueue(
      buildSessionEnded(++this.seq, this.options.sessionId, this.lastChildOutcome, {
        reason,
        shutdown_requested: this.shutdownWasRequested,
        exit_code: this.endExitCode,
        usage: this.cumulative,
        resumable,
      }),
      { terminal: true }
    );
    // The closing ledger line: the same cumulative usage and end verdict
    // the caller just received (call-log.ts).
    appendSessionCallRecord(
      this.callLedger,
      this.options.sessionId,
      this.sessionStartedAt,
      reason,
      this.endExitCode,
      this.cumulative
    );
    const delivered = sent ? await awaitFinalFlush(this.out) : false;
    this.signals.dispose();
    this.resolveDone(delivered ? this.endExitCode : Math.max(this.endExitCode, 1));
  }

  /** The start record (§4.8): the claude-family writeStartRecord shape.
   * Returns the failure message, or null once recorded (or when registry
   * writes are disabled). */
  private writeStartRecord(): string | null {
    if (this.options.registryPath === null) return null;
    const outcome = recordSessionStart(this.options.registryPath, {
      id: this.options.sessionId,
      agent: "aider",
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
    });
    if (!outcome.ok) return outcome.error;
    this.registryRecorded = true;
    return null;
  }
}
