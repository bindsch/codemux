/**
 * The claude-family session driver (design §4.2, §4.6): the launcher-owned
 * context that turns one SessionProcess plus the caller's stdin into the
 * event stream. All per-run state lives here — never on a singleton
 * adapter — and the driver never throws across the stream: every failure
 * is an event, an end path, or both.
 *
 * Turn model: claude print mode has no turn-started event of its own, so
 * codemux owns the boundary — a turn starts when an accepted input is
 * submitted from idle, ends at the harness's `result`. One input, one
 * result: a `user` line while a turn runs is rejected `busy`
 * (`user_during_turn: false`). The wire gives a mid-turn line no stable
 * turn — print mode folds it into the running turn when that turn makes
 * another model request (fixture zai-session-a.ndjson: one result answers
 * both) and answers it in a result of its own when it does not (review
 * live21, both recorded live) — so codemux cannot know which result
 * answers it and does not forward it.
 */

import { appendSessionCallRecord, appendSessionTurnCallRecord } from "../call-log.js";
import { reportSpawnThrow } from "./stdin-frame.js";
import { emptyUsage } from "../result-envelope.js";
import { buildInterruptRequest } from "./claude-session.js";
import { shutdownKillWarning } from "./shutdown-kill.js";
import { buildEvent } from "./protocol.js";
import {
  awaitFinalFlush,
  buildSessionEnded,
  drainFailureMessage,
  harnessFailed,
  shutdownRequested,
  type SessionChildOutcome,
  type SessionProcess,
} from "./process.js";
import { discardUnconfirmedRecord, releaseSessionRecord } from "./registry.js";
import type { SessionEndReason } from "./driver-io.js";
import { ClaudeDriverInput } from "./driver-input.js";
import { synthesizedTurnCompletion } from "./driver-synth.js";

export type { SessionDriverOptions, SessionEndReason } from "./driver-io.js";

/** The pause between the two --final removal attempts: long enough for an
 * ephemeral rmSync failure (a scanner holding the directory open) to pass. */
const FINAL_REMOVE_RETRY_MS = 100;

export class ClaudeSessionDriver extends ClaudeDriverInput {
  private shutdownWasRequested = false;

  /** True once the end path ran the --final removal sequence (both
   * attempts, whatever the outcome): the CLI's finally removes a --final
   * directory only while this is false, so it never re-decides a directory
   * the end path already decided (review round 15, major). */
  finalRemovalRan = false;
  /** A fresh unconfirmed record was discarded: the CLI removes the orphaned private directory (round 46). */
  recordDiscarded = false;

  /** Set between spawnPending() and attach()/spawnAbandoned(): an end path
   * that begins inside that window holds at the late-child wait in finish
   * until one of them answers (review round 18, edges 1). */
  private lateChild: Promise<SessionProcess | null> | null = null;
  private resolveLateChild: ((proc: SessionProcess | null) => void) | null = null;

  /** The CLI calls this immediately before its spawn, after which the first
   * await is the spawn itself: a signal delivered while that spawn is still
   * in its preflight (the scode compatibility probe is async) starts the
   * end path with no child to stop, and the end path's --final removal
   * would otherwise delete the private directory before the child that
   * needs killing even exists — a child that then reads or recreates the
   * removed directory after the session reported completion (review round
   * 18, edges 1). */
  spawnPending(): void {
    this.lateChild = new Promise((resolve) => {
      this.resolveLateChild = resolve;
    });
  }

  /** The CLI's spawn ended without a child (it threw): an end path waiting
   * on the late child proceeds with none and preserves a resumed session's
   * private directory, because this invocation never ran its harness. */
  spawnAbandoned(): void {
    this.resolveLateChild?.(null);
    this.resolveLateChild = null;
  }

  /** True once an end path has begun (a signal or a timeout during the
   * spawn's preflight among them): the CLI's spawn-throw catch hands the
   * ending to that path (round 20, minor 8). */
  endPathStarted(): boolean {
    return this.finished;
  }

  /** The spawn-throw catch's exit once endPathStarted() is true: the end
   * path owns the ending — it emits session_ended and releases or
   * discards the record inside its own ordering — so await its verdict
   * and leave through the session's exit code; a rethrow instead exits
   * the process hard first. A FRESH --final directory the end path
   * decided nothing about still gets the CLI tail's own removal. */
  async finishAfterSpawnThrow(error: unknown): Promise<void> {
    reportSpawnThrow(error);
    let code = await this.done;
    if ( // --final, or a fresh record discarded as unconfirmed (nothing points at the directory; round 47)
      (this.options.final || this.recordDiscarded) &&
      !this.finalRemovalRan &&
      !this.resumeClaimed &&
      !(this.options.removeFinalProjectDir?.() ?? true)
    ) {
      code = Math.max(code, 1);
    }
    this.dispose();
    process.stdin.destroy();
    process.exitCode = code;
  }

  /** Hand the driver the spawned process; lines that arrived before this
   * run are replayed in order. */
  attach(proc: SessionProcess): void {
    this.proc = proc;
    // A signal between construction and this call finished the driver with
    // no child to stop (the CLI's spawn runs an async compatibility probe
    // before it attaches). The end path waiting on this child drains it
    // the way every shutdown does, EOF first, the grace, then the stop
    // request, and awaits its settlement before the --final removal
    // (review round 18, edges 1); an immediate SIGTERM here turned a child
    // that would have exited on EOF into a harness failure (round 69).
    if (this.finished && this.resolveLateChild === null) {
      // No end path waits for this child (the end completed with no spawn
      // pending): nothing will drain it, so it is stopped at once or it
      // outlives the session it was spawned for.
      if (!this.stopEscalation.escalateIfRequested(proc)) proc.requestStop();
      return;
    }
    this.resolveLateChild?.(proc);
    this.resolveLateChild = null;
  }

  /** The CLI's resume claim succeeded: this process owns the record from
   * now on, whether or not the harness ever reaches its init frame. */
  adoptResumeClaim(): void {
    this.resumeClaimed = true;
  }

  /** The --final removal settles here, inside the end path: one attempt,
   * a short pause on failure, one retry with the same helper. By the time
   * it answers, the directory is gone (either attempt) or both attempts
   * failed — so the end stamp, the resumable verdict, and the exit code
   * that follow all describe the directory the process actually leaves
   * behind (review round 15, major). */
  private async removeFinalProjectDirSettled(): Promise<boolean> {
    this.finalRemovalRan = true;
    const remove = this.options.removeFinalProjectDir;
    if (remove === undefined || remove()) return true;
    await new Promise((resolve) => setTimeout(resolve, FINAL_REMOVE_RETRY_MS));
    return remove();
  }

  /** The start record, written by the CLI before the spawn: codemux
   * chose the session id (`--session-id`) or the registry vouched for
   * the resumed one, so nothing about the record waits on the harness.
   * On a resume it follows the claim and updates the claimed record in
   * place with the flags the resume runs under. Returns the failure
   * message, or null once this process owns the record (review live22). */
  recordBeforeSpawn(): string | null {
    const outcome = this.writeStartRecord();
    if (outcome === null) return null;
    if (!outcome.ok) return outcome.error;
    this.recordedBeforeSpawn = true;
    return null;
  }

  /** One line from the harness stdout. Never throws. Lines are parsed and
   * emitted until the end path settles (`settled`): the shutdown grace
   * window is exactly the interval in which the harness's last output —
   * the interrupted turn's result, its usage — is still arriving, and
   * dropping it there would report a session that ended mid-sentence. */
  override handleHarnessLine(line: string): void {
    if (this.proc === null) {
      this.earlyLines.push(line);
      return;
    }
    if (this.settled) return;
    const wasEnding = this.finished;
    const parses = this.parser.feed(line, {
      expectedSessionId: this.options.sessionId,
    });
    for (const parse of parses) {
      this.applyParse(parse, line);
      // A parse that started the end path ends this line's application;
      // parses that arrive while an already-running end path drains still
      // apply, all the way to settlement.
      if (this.settled || (!wasEnding && this.finished)) return;
    }
  }

  dispose(): void {
    this.signals.dispose();
    this.clearTimers();
  }

  /** Every end path funnels here (§4.6): pending requests are answered
   * deny (`superseded`) first, the active turn is interrupted so the
   * harness can persist, the tree is killed after the grace, harness
   * output is drained until the child settles, and `session_ended` is
   * the last event on the stream. */
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
    // A `user` line accepted before the init frame was acked, echoed, and
    // already forwarded, so an end path cannot drop it — the harness may
    // still run it inside the grace window (review live16; the live10
    // notice said "dropped", which was false here). No turn can open
    // during the drain, so such a result is mirrored as `unknown`
    // (completeTurn) rather than read as a grammar violation. The ack
    // cannot be retracted and a second answer per line would break the
    // ack contract, so the caller gets one non-fatal notice instead.
    if (this.openerPending) {
      this.emitError(
        false,
        "codemux",
        `user input accepted before the session started was already forwarded to the ${this.options.agent} process and has no turn; ` +
          "the harness may still run it while shutting down, and any result it produces is mirrored as unknown"
      );
      this.forwardedAtEnd = true;
      this.openerPending = false;
    }
    // An interrupt parked on that pre-init line can no longer ride the
    // init frame's turn either: the end path owns the child and its stdin
    // from here, no turn opens during the drain, and an init frame that
    // arrives now no longer opens one (driver-events guards the delivery
    // on !finished). The ack stands, so the caller gets the same
    // non-fatal notice the sibling drop paths emit, naming the seq
    // (review round 372, item 3: this clear used to be silent — the one
    // acked line whose fate the caller never heard).
    if (this.interruptBeforeInit) {
      this.interruptBeforeInit = false;
      this.emitError(
        false,
        "codemux",
        `the interrupt accepted before the session started (input_seq ${this.interruptBeforeInitSeq}) was dropped: ` +
          `the session ended (${reason}) before the harness started`
      );
    }
    // Read before the end-interrupt runs: whether a turn was open when
    // the end began decides whether an unanswered turn is synthesized
    // (below); the verdict's wording reads the turn state after the drain.
    const turnOpenAtFinish = this.fsm.state === "turn_active";
    this.supersedePendingDeny();
    let interruptWritten = false;
    if (
      this.fsm.state === "turn_active" &&
      this.capabilities.interrupt &&
      this.proc !== null
    ) {
      // The end path interrupts before the SIGTERM so the harness can
      // answer and persist its transcript cleanly. The interrupt is
      // pending like any other: a result arriving during the drain below
      // is the interrupted turn's own completion, not a failed one. A
      // refused write (a harness that stopped reading, review live19)
      // marks nothing pending and goes straight to the stop.
      const interruptId = `interrupt-end-${++this.interruptCounter}`;
      const written = this.proc.writeLine(buildInterruptRequest(interruptId));
      interruptWritten = written.ok;
      if (interruptWritten) {
        this.interruptPending = true;
        this.interruptId = interruptId;
      } else if (reason !== "crash") {
        // An orderly end whose interrupt the harness would not take (it
        // stopped reading stdin) is a failure: the turn is stopped by the
        // signal, not interrupted, so it cannot end 0 (review live25). A
        // crash end already reported its own fatal.
        this.endExitCode = Math.max(this.endExitCode, 1);
        this.emitError(
          true,
          "codemux",
          `could not deliver the end-path interrupt to the ${this.options.agent} process ` +
            `(${written.reason ?? "unknown"}); the open turn was stopped by signal`
        );
      }
    }
    this.clearTimers();
    // The signal gate stays installed until cleanup completes: a second
    // SIGINT/SIGTERM during the grace window must hit the gate's
    // fire-once latch, not the default disposition, or codemux dies
    // mid-drain and the tree it was about to kill survives it.
    let proc = this.proc;
    if (proc === null && this.lateChild !== null) {
      // The end began while the CLI's spawn was still in its preflight
      // (review round 18, edges 1): hold here until that spawn answers.
      // attach() has already asked the child it produced to stop, and
      // resolves only at its settlement, so everything below — the drain,
      // the --final removal, the end stamp, session_ended — runs over a
      // child that is dead, never one that could read or recreate the
      // private directory this end is about to remove. A spawn that threw
      // resolves with no child at all.
      proc = await this.lateChild;
      // A second signal latched while this child was still being born
      // (review round 162, finding 2): it gets the tree SIGKILL on
      // arrival, not the drain below.
      if (proc !== null) this.stopEscalation.escalateIfRequested(proc);
    }
    // Preserve the raw child outcome, including signal-only exits.
    let childOutcome: SessionChildOutcome | null = null;
    if (proc !== null) {
      if (interruptWritten) {
        // The interrupt gets its own grace window before any signal
        // (review live17): the turn closes through its drained result, a
        // failure arriving meanwhile raises the code, or the child exits.
        const startCode = this.endExitCode;
        await proc.awaitEndAnswer(
          () =>
            this.fsm.state !== "turn_active" ||
            this.endExitCode > startCode ||
            !this.interruptPending
        );
      }
      proc.endInput();
      await proc.awaitEndAnswer(() => false);
      // An escalated child is already tree-SIGKILLed; requestStop would
      // only arm timers against the dying group (stop-escalation.ts).
      if (!this.stopEscalation.escalateIfRequested(proc)) proc.requestStop();
      await proc.settled;
      childOutcome = await proc.exited;
    }
    const killWarning = shutdownKillWarning(this.options.agent, childOutcome, proc?.stopSignals,
      reason, this.fsm.activeTurn !== null || this.forwardedAtEnd, this.endExitCode);
    if (killWarning) { reason = "shutdown"; this.out.enqueue(buildEvent(++this.seq, this.options.sessionId, "warning", null, { message: killWarning })); }
    const drainFailureCode = !killWarning && harnessFailed(childOutcome)
      ? childOutcome!.code ?? 1
      : null;
    if (drainFailureCode !== null) {
      reason = "harness_failed";
      this.endExitCode = Math.max(this.endExitCode, 1);
      if (this.firstFatal === null) this.emitError(
        true,
        "harness",
        drainFailureMessage(
          this.options.agent,
          childOutcome!,
          this.fsm.state === "turn_active"
        )
      );
    }
    if (turnOpenAtFinish && this.fsm.state === "turn_active") {
      // The turn is still open and nothing else will ever answer it: the
      // crash path's fatal already told the failure story (a crash
      // mid-turn, review live11 — the agy precedent from live10), the
      // child exited zero without a result, or the drain-failure verdict
      // above just fired (review live12 — the two blocks used to be
      // mutually exclusive, so the one exit class the verdict reported
      // was the one class the synthesis refused to answer). §4.1's
      // pairing — every `turn_started` answered — holds only if codemux
      // synthesizes the completion: failed for a crash or a drain
      // failure (the reason mirrors the fatal that reported it),
      // interrupted otherwise; all-null usage (never guessed zeros),
      // raw null (codemux-originated).
      const turnId = this.fsm.activeTurn;
      const error = this.fsm.transition({
        kind: "turn_completed",
        turnId: turnId ?? "none",
      });
      if (error !== null) {
        this.endExitCode = Math.max(this.endExitCode, 1);
        this.emitError(true, "codemux", error.message);
      } else {
        const synth = synthesizedTurnCompletion(
          ++this.seq,
          this.options.sessionId,
          turnId,
          reason,
          drainFailureCode,
          this.firstFatal,
          this.options.agent,
          childOutcome!,
          this.options.modelAlias ?? null
        );
        this.emit(synth.event, { terminal: "fatal" });
        // The synthesized completion still gets its ledger line; no served
        // model — the harness never answered the turn (driver-synth.ts).
        appendSessionTurnCallRecord(
          this.callLedger,
          this.options.sessionId,
          turnId ?? "none",
          this.turnStartedAt.get(turnId ?? "") ?? Date.now(),
          synth.finish,
          emptyUsage(),
          null
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
    const ownsRecord =
      this.registryRecorded || this.resumeClaimed || this.recordedBeforeSpawn;
    // Whether a --final removal actually removed the private directory;
    // decided inside the release below, read by the resumable verdict.
    let finalRemoved = false;
    if (ownsRecord && this.options.registryPath !== null) {
      if (this.recordedBeforeSpawn && !this.registryRecorded && !this.resumeClaimed) {
        // A fresh record the harness never confirmed names no transcript.
        discardUnconfirmedRecord(this.options.registryPath, this.options.sessionId); this.recordDiscarded = true;
      } else {
        // A --final session leaves nothing claimable (review round 10,
        // edges 4): the private directory is removed first — while this
        // process still owns the record, so no resume can be running in
        // it — and the end stamp then writes `final: true` with `ended`
        // in one atomic update, so the record is never ended-and-
        // claimable for a resume that would reopen a deleted directory.
        // The CLI's removal closure reports a failure on stderr instead
        // of throwing, so a removal that fails cannot skip the release,
        // the end stamp, and session_ended below (review round 11,
        // contracts-2 4). The whole removal sequence runs here, before
        // any of those (review round 15, major): one attempt, a short
        // pause, one retry, and only then the verdict — a directory the
        // CLI's finally deleted after a failed first attempt left the
        // record and the already-emitted session_ended promising a
        // resume into a directory that no longer existed. The stamp
        // follows the removal's settled outcome (review round 14,
        // edges 3): a directory that survived both attempts still holds
        // the token copy and transcript, and a final record refuses
        // every future resume, so the record stays ended and resumable
        // and the exit code says the removal failed.
        // A resume whose spawn failed keeps its existing transcript.
        // Remove it only after a child attached in this invocation.
        finalRemoved = this.options.final && proc !== null
          ? await this.removeFinalProjectDirSettled()
          : false;
        if (this.options.final && proc !== null && !finalRemoved) {
          this.endExitCode = Math.max(this.endExitCode, 1);
        }
        // A lost stamp rides stderr (live13); after a --final removal it also fails the exit code (round 56).
        const stamped = releaseSessionRecord(this.options.registryPath, this.options.sessionId, this.options.final === true && finalRemoved);
        if (!stamped && finalRemoved) this.endExitCode = Math.max(this.endExitCode, 1);
      }
    }
    // Resumable means the harness confirmed the session (the start was
    // recorded at its first identity-bearing frame) or, for a claimed
    // resume it never confirmed, that the end did not fail: a resume the
    // harness refused (a transcript Claude Code already cleaned up, a
    // thread codex cannot load) dies on the crash path or fails the
    // drain, and one that hung until a timeout proved nothing either;
    // reporting it resumable would send a retrying caller into the same
    // failure (review live21). A claimed resume that ended
    // cleanly before its init frame keeps the record the claim judged,
    // and the end stamp above released the claim (review live20).
    const resumable =
      this.capabilities.resume &&
      (this.registryRecorded ||
        (this.resumeClaimed && this.endExitCode === 0)) &&
      // --final removed the private config directory before the end
      // stamp above, so the verdict must not promise a resume that would
      // open a fresh, transcript-less directory. A --final removal that
      // failed BOTH attempts kept the directory and the record
      // non-final, so the retry the verdict promises is real (review
      // round 14, edges 3; round 15 moved the retry into the end path).
      !(this.options.final && finalRemoved);
    // The exit code the report carries, read once here: a signal or a
    // failure landing during the final flush (through `finish`'s re-entry
    // arm) no longer changes the process exit code — the session had
    // already ended and told the caller its verdict. That holds for a
    // termination signal too: it exits 143 only when it stopped the
    // session, which the event then says (kimi's machine has the same
    // rule; docs/sessions.md states it under the exit table).
    const reported = this.endExitCode;
    const sent = this.out.enqueue(
      buildSessionEnded(++this.seq, this.options.sessionId, childOutcome, {
        reason,
        shutdown_requested: this.shutdownWasRequested,
        exit_code: reported,
        usage: this.cumulative,
        resumable,
      }, killWarning !== null),
      { terminal: true }
    );
    // A failed final delivery cannot report success or hold the process.
    const delivered = sent ? await awaitFinalFlush(this.out) : false;
    const finalCode = delivered ? reported : Math.max(reported, 1);
    // The closing ledger line carries the process exit code: the reported
    // one, or nonzero when the report was not delivered (round 171).
    appendSessionCallRecord(this.callLedger, this.options.sessionId, this.sessionStartedAt, reason, finalCode, this.cumulative);
    // Handlers come off only now, report delivered: nothing after this
    // needs them.
    this.signals.dispose();
    this.resolveDone(finalCode);
  }
}
