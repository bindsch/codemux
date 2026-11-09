/**
 * The opencode session's turn machinery: the per-turn spawn/stdio wiring,
 * the run-output parse into events, the session-id adoption, the deferred
 * session_started announcement, and turn-id assignment.
 * src/session/opencode-driver.ts owns the lifecycle.
 */

import {
  buildOpenCodeSessionCommand,
  type OpenCodeParse,
} from "./opencode-session.js";
import {
  type SessionChildOutcome,
  type SessionProcess,
} from "./process.js";
import { buildEvent, buildUnknownEvent } from "./protocol.js";
import { accumulateUsage } from "./usage.js";
import { lateChildRuns } from "./spawn-wait.js";
import {
  busyRecordExhaustedNotice,
  recordSessionStartOffStream,
} from "./registry.js";
import { OpenCodeDriverCore } from "./opencode-finalize.js";

export abstract class OpenCodeTurns extends OpenCodeDriverCore {
  private turnCounter = 0;

  // --- turns ---------------------------------------------------------------
  /** Spawn the turn's process and write the prompt: `run` reads non-TTY
   * stdin to EOF as its one message, so the write is raw text followed by
   * the half-close. The process's exit — not any one line — ends the
   * turn. A finished driver returns before it builds or spawns anything:
   * the end path owns the child and the verdict from the moment
   * `finished` is set, so no turn may spawn after it (review round 153) —
   * the input path checks this after its emits (an outbound bound breach
   * ends the session synchronously there); this entry guard is the
   * backstop for every other caller. */
  protected async startTurn(text: string): Promise<void> {
    if (this.finished) return;
    this.turnPrompt = text;
    const argv = buildOpenCodeSessionCommand({
      autonomy: this.options.autonomy,
      model: this.options.model,
      effort: this.options.effort,
      resumeSessionId: this.sessionId ?? undefined,
      projectSettings: this.options.projectSettings === true,
    });
    let proc: SessionProcess;
    let spawn: Promise<SessionProcess> | null = null;
    try {
      spawn = this.options.spawnTurn(argv, () => this.turnSpawnAbandoned);
      this.turnSpawn = spawn;
      proc = await spawn;
    } catch (error) {
      // The end path owns the verdict once it began — and it awaited
      // this same spawn, so a rejection that lands after it began is
      // reported THERE (the graceful-end arm in finish, review round
      // 73); reporting it here too would only duplicate the fatal. A
      // spawn failure before any end is codemux's own failure to run
      // the turn.
      if (this.finished) return;
      this.emitError(
        true,
        "codemux",
        "could not spawn the opencode turn process " +
          `(${error instanceof Error ? error.message : String(error)})`
      );
      void this.finish("crash", 1);
      return;
    } finally {
      if (spawn !== null && this.turnSpawn === spawn) this.turnSpawn = null;
    }
    // A signal or timeout finished the driver while the spawn ran: the
    // child that arrived after the end must be stopped at once or it
    // outlives the session it was spawned for (the attach race, review
    // live4). The end path, which awaited this same spawn, has normally
    // already stopped and settled it by now; requestStop is idempotent,
    // so this stays as the belt-and-suspenders arm. A GRACEFUL end
    // (stdin-close, shutdown) is the exception (review D11, correctness
    // 2 1): it owes this turn its run, delivers the prompt to the late
    // child itself (see finish), and this arm must not kill what that
    // path is about to run — unless that end already gave up on this
    // spawn (review round 110), when nothing is left that would run it.
    if (this.finished) {
      if (lateChildRuns(this.endReason, this.turnSpawnAbandoned)) return;
      // A second signal latched while the spawn ran: the tree SIGKILL it
      // asked for, not the stop with grace (stop-escalation.ts).
      if (!this.stopEscalation.escalateIfRequested(proc)) proc.requestStop();
      void proc.settled;
      return;
    }
    this.turnProc = proc;
    proc.exited.then((outcome) => {
      void this.onTurnExited(proc, outcome);
    });
    // The prompt is raw text (writeRaw — multi-line text stays one
    // message), and the EOF after it is what makes `run` treat the whole
    // stdin as the message.
    const written = proc.writeRaw(text);
    if (!written.ok) {
      if (!this.finished) {
        this.emitError(
          true,
          "codemux",
          `could not deliver the prompt to the opencode process (${written.reason ?? "unknown"})`
        );
        void this.finish("crash", 1);
      }
      proc.requestStop();
      return;
    }
    proc.endInput();
  }

  /** The turn process exited: after its tree settles (stdout drained),
   * its outcome completes the turn — unless the end path's synthesis won
   * the race (settled). */
  protected async onTurnExited(
    proc: SessionProcess,
    outcome: SessionChildOutcome
  ): Promise<void> {
    await proc.settled;
    if (this.settled) return;
    if (this.turnProc !== proc) return; // superseded — defensive
    this.completeTurn(outcome);
  }

  // --- harness side --------------------------------------------------------
  protected applyParse(parse: OpenCodeParse, rawLine: string): void {
    switch (parse.kind) {
      case "unusable":
        // Tier 3 (§4.2): the fatal report carries the excerpt.
        this.emitError(
          true,
          "harness",
          `unusable harness output (not JSON, ${parse.bytes} bytes): ${parse.excerpt}`
        );
        void this.finish("crash", 1);
        return;
      case "grammar_error":
        // Tier 2: the raw line still goes out, then the fatal end. A payload
        // grammar error on a line whose session id validated still names
        // this session, so the fatal events and the registry record carry
        // it and the session stays resumable; a session mismatch names
        // another session and is never adopted (review round 42).
        if (parse.reason !== "session-mismatch" && parse.sessionId !== undefined) {
          this.adoptSessionId(parse.sessionId);
        }
        this.emit(buildUnknownEvent(++this.seq, this.sessionIdOrEmpty(), rawLine));
        this.emitError(true, "harness", parse.message);
        void this.finish("crash", 1);
        return;
      case "unknown":
        // Tier 1: raw preserved, session continuing. The session-id gate
        // already validated the id, so this line confirms the identity
        // like any mapped one.
        this.adoptSessionId(parse.sessionId);
        this.emit(buildUnknownEvent(++this.seq, this.sessionIdOrEmpty(), rawLine));
        return;
      case "text":
        this.adoptSessionId(parse.sessionId);
        if (this.requireOpenTurn(rawLine)) return;
        this.emit(
          buildEvent(++this.seq, this.sessionIdOrEmpty(), "assistant_message", rawLine, {
            text: parse.text,
            turn_id: this.fsm.activeTurn,
          })
        );
        return;
      case "tool_use":
        this.adoptSessionId(parse.sessionId);
        if (this.requireOpenTurn(rawLine)) return;
        this.emit(
          buildEvent(++this.seq, this.sessionIdOrEmpty(), "tool_call", rawLine, {
            call_id: parse.callId,
            name: parse.tool,
            input: parse.input,
          })
        );
        this.emit(
          buildEvent(++this.seq, this.sessionIdOrEmpty(), "tool_result", rawLine, {
            call_id: parse.callId,
            output: parse.output ?? parse.errorText ?? null,
            is_error: parse.isError,
          })
        );
        return;
      case "step_finish":
        this.adoptSessionId(parse.sessionId);
        if (this.requireOpenTurn(rawLine)) return;
        // No standalone usage event: usage_stream is honestly false —
        // usage rides only the per-turn turn_completed (the agy/claude
        // contract).
        this.turnUsage = accumulateUsage(this.turnUsage, parse.usage);
        return;
      case "error":
        this.adoptSessionId(parse.sessionId);
        if (this.requireOpenTurn(rawLine)) return;
        // Non-fatal: the session continues (the next turn runs), but the
        // error still fails the turn whatever the exit code turns out to
        // be — the plain-run rule (plain-unwrap/opencode.ts); the first
        // error line is the reason that verdict carries.
        this.emitError(false, "harness", parse.message);
        if (this.turnError === null) this.turnError = parse.message;
        return;
    }
  }

  /** Adopt the session id from the first line that named one (a fresh
   * session); any line that names it confirms a resume. */
  private adoptSessionId(sessionId: string): void {
    this.harnessConfirmed = true;
    if (this.sessionId === null) {
      this.sessionId = sessionId;
      this.announceSessionStarted();
    }
  }

  /** A mapped run-output line belongs to the open turn; one that arrives
   * with no open turn breaks the stream's grammar — tier 2, raw
   * preserved. Unreachable through the turn-per-process spawn discipline
   * (lines stop at the process's settled, which precedes the turn's
   * completion); the guard keeps that discipline a checked fact rather
   * than an assumption. */
  private requireOpenTurn(rawLine: string): boolean {
    if (this.fsm.state === "turn_active") return false;
    this.emit(buildUnknownEvent(++this.seq, this.sessionIdOrEmpty(), rawLine));
    this.emitError(true, "harness", "a run-output line arrived with no open turn");
    void this.finish("crash", 1);
    return true;
  }

  /** The deferred session_started (the agy pattern): the FSM has already
   * left `starting`; this is the caller-facing announcement and the
   * registry record. Codemux-originated, so raw is null. The record runs
   * off the turn's output stream (review round 341): the announcement
   * follows its verdict, which a busy lock delivers late from a timer
   * retry instead of freezing the event loop mid-turn. */
  protected announceSessionStarted(): void {
    this.recordStart(() => {
      if (this.settled) return;
      this.emit(
        buildEvent(++this.seq, this.sessionIdOrEmpty(), "session_started", null, {
          agent: "opencode",
          model: this.options.model ?? null,
          autonomy: this.options.autonomy,
          cwd: this.options.cwd,
          sandboxed: this.options.sandboxed,
          sandbox_trust: this.options.sandboxTrust,
          capabilities: this.capabilities,
          protocol: "codemux-live-session/1",
          // An opencode session keeps no session-keyed private home: the
          // native session (and the login) live in the real data
          // directory the hermetic prefix deliberately keeps, so there
          // is no directory to report.
          private_home: null,
        })
      );
    });
  }

  /** The start record, one lock attempt at a time: a busy lock retries on
   * a timer off the turn's output stream (review round 341), never the
   * synchronous full-budget wait; `onRecorded` runs once the verdict is
   * in. A null registryPath records nothing and reports success at once;
   * a null session id reports nothing (the old guard's exact behavior).
   * A record still pending at the end fails a fresh session closed
   * (`finish`, review round 345); a resumed session that exhausts the
   * busy budget is tracked already — the CLI's claim wrote its record
   * before anything spawned — so the exhaustion is a notice and the
   * announcement, not a crash: the claim is the record (round 361,
   * item 16). */
  private recordStart(onRecorded: () => void): void {
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
        pass_env: [...(this.options.passEnv)],
        playwright_mcp: false,
        provider_base_url: this.options.providerBaseUrl,
        project_settings: this.options.projectSettings === true,
      },
      () => this.settled,
      (outcome) => {
        this.recordPending = false;
        if (!outcome.ok) {
          // A resumed session is tracked by its pre-spawn claim: the
          // spent budget lost a refresh of a record that exists, and the
          // session keeps running (round 361, item 16). A fresh session,
          // and every other failure class, fail closed (§4.8).
          if (outcome.kind === "busy" && this.resumeClaimed) {
            console.error(
              busyRecordExhaustedNotice(this.sessionId ?? "unknown", outcome.error)
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
          `codemux: the registry lock is busy recording session ${this.sessionId} ` +
            `(${error}); retrying in the background`
        ),
      this.options.registryStartBudget
    );
  }

  /** Assign the next codemux turn id, open it in the FSM, and reset the
   * per-turn accumulators. */
  protected submitTurn(): string | null {
    this.turnCounter += 1;
    const turnId = `t${this.turnCounter}`;
    const error = this.fsm.transition({ kind: "turn_started", turnId });
    if (error !== null) {
      this.emitError(true, "harness", error.message);
      void this.finish("crash", 1);
      return null;
    }
    this.turnUsage = null;
    this.turnError = null;
    this.turnPrompt = null;
    this.emit(
      buildEvent(++this.seq, this.sessionIdOrEmpty(), "turn_started", null, {
        turn_id: turnId,
      })
    );
    this.turnStartedAt.set(turnId, Date.now());
    return turnId;
  }
}
