/**
 * The shared turn-per-process session engine for the second wave of
 * session agents (cursor, droid, pi, qwen, gemini, copilot, goose): one
 * headless harness process per caller input, the prompt on that
 * process's stdin or argv, the process's exit as the turn's verdict, and
 * the harness's own session id as the state that carries across turns.
 * The lifecycle, the interleaving rules, and the end path are the
 * opencode/aider/kimi table (src/session/turn-per-process.ts) — this
 * module is that table's parameterized implementation, so the seven
 * drivers cannot drift into privately different vocabularies. Each agent
 * supplies a profile (src/session/<agent>-driver.ts): the identity model
 * (codemux-minted or deferred to the first turn's output), the prompt
 * carrier, the per-turn command builder over its pure session module,
 * and the turn parse. Everything here is agent-agnostic.
 */

import { randomUUID } from "node:crypto";
import type { ResultUsageBlock } from "../types.js";
import {
  appendSessionCallRecord,
  appendSessionTurnCallRecord,
  type SessionCallContext,
} from "../call-log.js";
import { emptyUsage } from "../result-envelope.js";
import { SessionFsm } from "./fsm.js";
import { SessionOutputQueue } from "./completion.js";
import {
  awaitFinalFlush,
  buildSessionEnded,
  harnessFailed,
  shutdownRequested,
  crashSynthesisReason,
  drainFailureMessage,
  DEFAULT_SHUTDOWN_GRACE_MS,
  type SessionChildOutcome,
  type SessionProcess,
  type SessionSignalGate,
} from "./process.js";
import { SessionStopEscalation } from "./stop-escalation.js";
import { awaitSpawnWithGrace, holdAbandonedSpawn } from "./spawn-wait.js";
import { buildEvent } from "./protocol.js";
import { PENDING_RECORD_FATAL, releaseSessionRecord } from "./registry.js";
import { addUsage } from "./usage.js";
import { isCallerHarnessHome, recordedHarnessHome } from "./harness-home.js";
import type { SessionPrivateHome } from "./private-home-types.js";
import type { SessionEndReason } from "./agy-driver.js";
import type { SessionCapabilities } from "./protocol.js";
import type { TurnAgentDriverOptions } from "./turn-driver-types.js";

// The vocabulary layer (verdicts, stream events, profiles, options)
// lives in turn-driver-types.ts; re-exported here because every profile
// and driver file imports it from the core.
export type {
  TurnPromptCarrier,
  TurnAgentId,
  TurnAgentTurnVerdict,
  TurnAgentStreamEvent,
  TurnProviderExtras,
  TurnCommandInput,
  TurnAgentProfile,
  TurnAgentDriverOptions,
} from "./turn-driver-types.js";

export abstract class TurnDriverCore {
  protected options!: TurnAgentDriverOptions;
  protected readonly fsm = new SessionFsm();
  /** The agent's honest capability matrix (the profile). */
  protected capabilities!: SessionCapabilities;
  protected out!: SessionOutputQueue;
  protected signals!: SessionSignalGate;
  protected turnProc: SessionProcess | null = null;
  protected turnSpawn: Promise<SessionProcess> | null = null;
  protected turnPrompt: string | null = null;
  /** The open turn's buffered stdout lines (the whole-stdout wires):
   * parsed once at the turn's exit, never emitted as they arrive — the
   * process's own output is not the session's event stream. */
  protected turnStdout: string[] = [];
  protected seq = 0;
  /** The session id: the mint (assigned at construction) or the resumed
   * id, for a minted identity; adopted from the first turn's output for
   * a deferred one. Null until one of those lands. */
  protected sessionId!: string | null;
  /** Codemux's own id for this session, minted at construction: what
   * the call ledger records while no output has named the session (and
   * ever after, if none ever does), so id-less sessions never share a
   * key (review ul6). */
  protected readonly codemuxSessionId = randomUUID();
  /** A turn's output named this session: the harness confirmed it. A
   * resumed session records at spawn from the vouched id, so the record
   * alone does not prove the harness can load the session (the agy
   * rule, review live21). */
  protected harnessConfirmed = false;
  protected cumulative: ResultUsageBlock = emptyUsage();
  protected turnUsage: ResultUsageBlock | null = null;
  /** The model the open turn's wire named as served, null when none
   * did — the turn ledger line's model_effective. */
  protected turnModelEffective: string | null = null;
  protected turnError: string | null = null;
  protected registryRecorded = false;
  protected recordPending = false;
  protected resumeClaimed = false;
  protected touchWarned = false;
  protected finished = false;
  protected endReason: SessionEndReason | null = null;
  protected endExitCode = 0;
  protected lastChildOutcome: SessionChildOutcome | null = null;
  protected turnSpawnAbandoned = false;
  protected abandonedSpawnHold: Promise<void> | null = null;
  protected readonly stopEscalation = new SessionStopEscalation();
  protected sawHarnessFailure = false;
  protected settled = false;
  protected firstFatal: string | null = null;
  /** True once the end path ran the --final removal sequence: the CLI's
   * tail removes a --final home only while this is false, so it never
   * re-decides a home the end path already decided (round 15). */
  protected finalRemovalRan = false;
  protected readonly turnStartedAt = new Map<string, number>();
  protected readonly sessionStartedAt = Date.now();
  protected callLedger!: SessionCallContext;
  protected done!: Promise<number>;
  protected resolveDone!: (code: number) => void;
  protected shutdownWasRequested = false;

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

  /** The settled spelling of the hermetic session's private home — the
   * directory a --resume opens — or the plain harness home. Used by the
   * record and the session_started announcement. */
  protected recordedHarnessHome(): string {
    const home = this.options.privateHome;
    if (home === null) return this.options.harnessHome;
    return recordedHarnessHome(home, this.sessionId ?? "");
  }

  /** Settle the private home onto `session-<id>` (the deferred
   * identity's run-shaped dir): called at the adopt, when no child is
   * writing. A settle that fails leaves the home run-shaped — the
   * resume guard's harness_home check then refuses the next resume
   * (fail closed), which session_ended's resumable fold reports
   * honestly (the kimi rule). */
  protected settlePrivateHome(): void {
    const home = this.options.privateHome;
    if (home === null || home.settled || this.sessionId === null) return;
    try {
      home.settle(this.sessionId);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.error(`codemux: hermetic session home settlement failed: ${detail}`);
    }
  }

  /** The --final removal, inside the end path (the claude family's
   * shape): one attempt, a short pause on failure, one retry. A removal
   * that throws is reported on stderr instead — the end path still owes
   * the caller its record release and session_ended. */
  private async removeFinalHomeSettled(): Promise<boolean> {
    this.finalRemovalRan = true;
    const home = this.options.privateHome;
    if (home === null) return true;
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
    await new Promise((resolve) => setTimeout(resolve, 100));
    return attempt();
  }

  /** The end path's keep-or-remove for the private home (the agy rule):
   * a resumed home is never removed here and needs no settle; a fresh
   * resumable one settles onto `session-<id>` so the reported resume
   * path exists; a fresh non-resumable one is an abandoned home —
   * removed when `allowRemove`, else left to the sweep (the --final
   * sequence already attempted its own removal). */
  private settleHomeAtEnd(
    home: SessionPrivateHome,
    resumable: boolean,
    allowRemove: boolean
  ): boolean {
    if (isCallerHarnessHome(home)) return true;
    try {
      if (home.resumed) {
        if (!home.settled && this.sessionId !== null) home.settle(this.sessionId);
        return true;
      }
      if (resumable && this.sessionId !== null) {
        home.settle(this.sessionId);
        return home.settled;
      }
      return !allowRemove || home.remove();
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.error(`codemux: session private home settlement failed: ${detail}`);
      return false;
    }
  }

  /** Every end path funnels here (§4.6) — opencode's drain machinery
   * verbatim, with the home/record settlement of the agy end path. */
  protected async finish(reason: SessionEndReason, exitCode: number): Promise<void> {
    this.shutdownWasRequested ||= shutdownRequested(reason);
    if (this.finished) {
      this.endExitCode = Math.max(this.endExitCode, exitCode);
      return;
    }
    this.finished = true;
    this.endReason = reason;
    this.endExitCode = exitCode;
    const turnOpenAtFinish = this.fsm.state === "turn_active";
    this.clearTimers();
    const agent = this.options.profile.agent;
    const proc = this.turnProc;
    const spawn = this.turnSpawn;
    let drainOutcome: SessionChildOutcome | null = null;
    let drain: SessionProcess | null = proc;
    if (drain === null && spawn !== null) {
      let late: SessionProcess | null = null;
      const graceMs = this.options.spawnGraceMs ?? DEFAULT_SHUTDOWN_GRACE_MS;
      const wait = await awaitSpawnWithGrace(spawn, graceMs);
      if (wait.kind === "landed") {
        late = wait.child;
      } else if (wait.kind === "rejected") {
        if (
          (reason === "stdin-close" || reason === "shutdown") &&
          this.fsm.state === "turn_active"
        ) {
          this.emitError(
            true,
            "codemux",
            "could not spawn the " + agent + " turn process " +
              `(${wait.error instanceof Error ? wait.error.message : String(wait.error)})`
          );
          void this.finish("crash", 1);
        }
      } else {
        this.turnSpawnAbandoned = true;
        this.abandonedSpawnHold = holdAbandonedSpawn(spawn, graceMs, this.stopEscalation);
        this.endExitCode = Math.max(this.endExitCode, 1);
        this.emitError(
          true,
          "codemux",
          `the ${agent} turn process never appeared within the ${graceMs} ms end grace; ending without it`
        );
      }
      if (late !== null) {
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
            this.turnProc = null;
            this.emitError(
              true,
              "codemux",
              `could not deliver the prompt to the ${agent} process ` +
                `(${written.reason ?? "unknown"})`
            );
            void this.finish("crash", 1);
          }
        }
        if (drain === null) {
          if (!escalated) late.requestStop();
          await late.settled;
          this.lastChildOutcome = await late.exited;
          drainOutcome = this.lastChildOutcome;
        }
      }
    }
    if (drain !== null) {
      await drain.awaitEndAnswer(() => this.firstFatal !== null || this.endExitCode !== 0);
      if (!this.stopEscalation.escalateIfRequested(drain)) drain.requestStop();
      await drain.settled;
      this.lastChildOutcome = await drain.exited;
      drainOutcome = this.lastChildOutcome;
      this.turnProc = null;
    }
    if (this.sawHarnessFailure) {
      this.endExitCode = Math.max(this.endExitCode, 1);
      reason = "harness_failed";
    }
    const drainFailureCode = harnessFailed(drainOutcome)
      ? drainOutcome!.code ?? 1
      : null;
    if (drainFailureCode !== null) {
      reason = "harness_failed";
      this.endExitCode = Math.max(this.endExitCode, 1);
      if (this.firstFatal === null) {
        this.emitError(
          true,
          "harness",
          drainFailureMessage(agent, drainOutcome!, this.fsm.state === "turn_active")
        );
      }
    }
    if (this.recordPending && !this.resumeClaimed) {
      this.recordPending = false;
      reason = "crash";
      this.endExitCode = Math.max(this.endExitCode, 1);
      this.emitError(true, "codemux", PENDING_RECORD_FATAL);
    }
    if (turnOpenAtFinish && this.fsm.state === "turn_active") {
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
                    ? drainFailureMessage(agent, drainOutcome!, true)
                    : this.firstFatal !== null
                      ? crashSynthesisReason(this.firstFatal)
                      : `the session ended (${reason}) before the turn completed`,
            usage,
          }),
          { terminal: "fatal" }
        );
        appendSessionTurnCallRecord(
          this.callLedger,
          this.ledgerSessionId(),
          turnId ?? "none",
          this.turnStartedAt.get(turnId ?? "") ?? Date.now(),
          synthFinish,
          usage,
          this.turnModelEffective
        );
        this.turnStartedAt.delete(turnId ?? "");
      }
    }
    this.settled = true;
    this.fsm.transition({ kind: "shutdown_started" });
    this.fsm.transition({ kind: "ended" });
    const ownsRecord = this.registryRecorded || this.resumeClaimed;
    const resumableBase =
      this.capabilities.resume &&
      ownsRecord &&
      (this.harnessConfirmed || this.endExitCode === 0);
    // The home settlement and the --final removal run BEFORE the end
    // stamp releases the record (rounds 10, 15; the agy shape): a
    // removal that settled removed makes the record final and the
    // resumable verdict false; a removal that failed both attempts
    // keeps the home and the record non-final, and the fresh home
    // settles so the base verdict's promise is real (round 413, item 2).
    // Unlike agy's end path, the removal is not gated on a child having
    // run: this driver owns the home (the CLI's tail never sees it), so
    // an idle --final session removes here too.
    let finalRemoved = false;
    let settledHome = true;
    const home = this.options.privateHome;
    if (this.options.final && !isCallerHarnessHome(home)) {
      finalRemoved = await this.removeFinalHomeSettled();
      if (!finalRemoved) {
        this.endExitCode = Math.max(this.endExitCode, 1);
        if (home !== null) settledHome = this.settleHomeAtEnd(home, resumableBase, false);
      }
    } else if (home !== null) {
      settledHome = this.settleHomeAtEnd(home, resumableBase, true);
    }
    if (ownsRecord && this.options.registryPath !== null && this.sessionId !== null) {
      const stamped = releaseSessionRecord(
        this.options.registryPath,
        this.sessionId,
        this.options.final && finalRemoved,
        { attempts: 1 }
      );
      if (!stamped && finalRemoved) this.endExitCode = Math.max(this.endExitCode, 1);
    }
    const reported = this.endExitCode;
    const sent = this.out.enqueue(
      buildSessionEnded(++this.seq, this.sessionIdOrEmpty(), this.lastChildOutcome, {
        reason,
        shutdown_requested: this.shutdownWasRequested,
        exit_code: reported,
        usage: this.cumulative,
        resumable:
          resumableBase && settledHome && !(this.options.final && finalRemoved),
      }),
      { terminal: true }
    );
    const delivered = sent ? await awaitFinalFlush(this.out) : false;
    const finalCode = delivered ? reported : Math.max(reported, 1);
    appendSessionCallRecord(
      this.callLedger,
      this.ledgerSessionId(),
      this.sessionStartedAt,
      reason,
      finalCode,
      this.cumulative
    );
    this.resolveDone(finalCode);
    if (this.turnSpawnAbandoned) await this.abandonedSpawnHold;
    this.signals.dispose();
  }

  /** The CLI awaits this before the cleanup a late-landing child would
   * race (review round 110, review D5). */
  awaitAbandonedSpawn(): Promise<void> {
    return this.abandonedSpawnHold ?? Promise.resolve();
  }

  protected sessionIdOrEmpty(): string {
    return this.sessionId ?? "";
  }

  /** The id the call ledger keys this session's records by: the
   * harness's own session id once one is known, else the codemux-minted
   * id every session owns from construction (review ul6). */
  protected ledgerSessionId(): string {
    return this.sessionId || this.codemuxSessionId;
  }
}
