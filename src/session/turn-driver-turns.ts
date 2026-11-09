/**
 * The shared turn engine's turn machinery (turn-driver-core.ts holds the
 * state and the end path, turn-driver-record.ts the registry record,
 * and turn-driver.ts the caller-facing edges): the per-turn spawn and
 * prompt delivery, the whole-stdout turn verdict with the session
 * identity rules, and the gemini-style line-stream application.
 */

import { appendSessionTurnCallRecord } from "../call-log.js";
import { emptyUsage } from "../result-envelope.js";
import type { ResultUsageBlock } from "../types.js";
import {
  type SessionChildOutcome,
  type SessionProcess,
} from "./process.js";
import { buildEvent, buildUnknownEvent } from "./protocol.js";
import { addUsage } from "./usage.js";
import { lateChildRuns } from "./spawn-wait.js";
import { touchSession } from "./registry.js";
import { TurnDriverRecord } from "./turn-driver-record.js";
import { isCallerHarnessHome } from "./harness-home.js";
import type {
  TurnAgentStreamEvent,
  TurnAgentTurnVerdict,
  TurnProviderExtras,
} from "./turn-driver-core.js";

export abstract class TurnDriverTurns extends TurnDriverRecord {
  private turnCounter = 0;

  /** Spawn the turn's process and deliver the prompt: on the stdin
   * carriers as raw text followed by the half-close (the process reads
   * its whole stdin as the one message); on the argv carriers the
   * builder already placed it. The process's exit — not any one line —
   * ends the turn. */
  protected async startTurn(text: string): Promise<void> {
    if (this.finished) return;
    this.turnPrompt = text;
    this.turnStdout = [];
    // A fresh session's first turn is the only one that claims the id;
    // a resumed session's first turn in this process still resumes.
    const firstTurn = this.turnCounter === 1 && this.options.resumeSessionId === null;
    const buildArgv = (extras: TurnProviderExtras): string[] =>
      this.options.profile.buildTurnCommand({
        text,
        sessionId: this.sessionId,
        firstTurn,
        callerHome: isCallerHarnessHome(this.options.privateHome) ? this.options.privateHome.dir : undefined,
        hermeticHome:
          this.options.hermetic && this.options.privateHome !== null
            ? this.options.privateHome.dir
            : null,
        autonomy: this.options.autonomy,
        model: this.options.model,
        effort: this.options.effort,
        tools: this.options.tools,
        sessionDir: extras.sessionDir,
        mcpExtensionPath: extras.mcpExtensionPath,
        providerSettingsPath: extras.providerSettingsPath,
        providerModelId: extras.providerModelId,
        geminiHome: extras.geminiHome,
        geminiPolicyPath: extras.geminiPolicyPath,
        qwenPlaywrightPath: extras.qwenPlaywrightPath,
        playwrightMcp: this.options.playwrightMcp === true,
      });
    let proc: SessionProcess;
    let spawn: Promise<SessionProcess> | null = null;
    const agent = this.options.profile.agent;
    try {
      spawn = this.options.spawnTurn(buildArgv, () => this.turnSpawnAbandoned);
      this.turnSpawn = spawn;
      proc = await spawn;
    } catch (error) {
      if (this.finished) return;
      this.emitError(
        true,
        "codemux",
        `could not spawn the ${agent} turn process ` +
          `(${error instanceof Error ? error.message : String(error)})`
      );
      void this.finish("crash", 1);
      return;
    } finally {
      if (spawn !== null && this.turnSpawn === spawn) this.turnSpawn = null;
    }
    if (this.finished) {
      if (lateChildRuns(this.endReason, this.turnSpawnAbandoned)) return;
      if (!this.stopEscalation.escalateIfRequested(proc)) proc.requestStop();
      void proc.settled;
      return;
    }
    this.turnProc = proc;
    proc.exited.then((outcome) => {
      void this.onTurnExited(proc, outcome);
    });
    if (this.options.profile.promptCarrier === "stdin") {
      const written = proc.writeRaw(text);
      if (!written.ok) {
        if (!this.finished) {
          this.emitError(
            true,
            "codemux",
            `could not deliver the prompt to the ${agent} process ` +
              `(${written.reason ?? "unknown"})`
          );
          void this.finish("crash", 1);
        }
        proc.requestStop();
        return;
      }
      proc.endInput();
    }
  }

  /** The turn process exited: after its tree settles, its outcome
   * completes the turn — unless the end path's synthesis won the race. */
  protected async onTurnExited(
    proc: SessionProcess,
    outcome: SessionChildOutcome
  ): Promise<void> {
    await proc.settled;
    if (this.settled) return;
    if (this.turnProc !== proc) return; // superseded — defensive
    this.completeTurn(outcome);
  }

  /** The whole-stdout turn verdict: the profile's parse folds the
   * turn's buffered stdout once, then the identity rules and the exit
   * code decide. Line-stream wires (gemini) never arrive here with a
   * parse — their verdict reads the events the stream already applied,
   * through the line-stream arm below. */
  protected applyWholeStdoutVerdict(outcome: SessionChildOutcome): void {
    const agent = this.options.profile.agent;
    const parse = this.options.profile.parseTurnOutput;
    if (parse === undefined) {
      // A line-stream profile whose output was never streamed: the
      // launch ran the wrong wire. Tier 3.
      this.emitError(true, "harness", `the ${agent} turn produced no parsable wire`);
      void this.finish("crash", 1);
      return;
    }
    const stdout = this.turnStdout.join("\n");
    const verdict = parse(stdout, this.sessionId);
    const exitDetail =
      outcome.code !== null
        ? `code ${outcome.code}`
        : `signal ${outcome.signal ?? "unknown"}`;
    if (verdict.noWire) {
      this.emitError(
        true,
        "harness",
        `unusable harness output: the ${agent} turn printed no result object ` +
          `(exited with ${exitDetail})`
      );
      void this.finish("crash", 1);
      return;
    }
    if (verdict.wrongSession) {
      this.emitError(
        true,
        "harness",
        `the ${agent} turn answered under session ${verdict.sessionId}, ` +
          `not ${this.sessionId}`
      );
      void this.finish("crash", 1);
      return;
    }
    if (verdict.noSessionId || verdict.sessionId === null) {
      if (this.sessionId === null && this.options.profile.identity === "deferred") {
        // The opencode untrackable rule (§4.8): the first turn named no
        // session id, so the session cannot be recorded in the registry.
        this.completeFailedUntrackable(verdict, exitDetail);
        return;
      }
      this.emitError(
        true,
        "harness",
        `the ${agent} turn named no session id, breaking the session identity`
      );
      void this.finish("crash", 1);
      return;
    }
    // A failed start record can finish the session synchronously while
    // adopting the id; the answer must not follow session_ended. A session
    // already finishing for another reason (stdin closed, a timer) still
    // reports this turn's verdict as before.
    const finishedBeforeAdoption = this.finished;
    this.adoptSessionId(verdict.sessionId);
    if (this.finished && !finishedBeforeAdoption) return;
    this.turnUsage = verdict.usage;
    this.turnModelEffective = verdict.modelEffective;
    const failed = outcome.code !== 0 || verdict.failed;
    if (verdict.failed && this.turnError === null) {
      this.turnError = verdict.failureReason;
    }
    if (!failed && verdict.answer !== null) {
      this.emitAssistant(verdict.answer);
    }
    this.completeTurnPair(failed, exitDetail, verdict.usage);
  }

  /** One buffered stdout line (the whole-stdout wires) or one live line
   * (the stream wires). Never throws. */
  protected applyLine(line: string): void {
    if (this.options.profile.parseStreamLine !== undefined) {
      this.applyStreamEvent(this.options.profile.parseStreamLine(line, this.sessionId ?? ""), line);
      return;
    }
    // Whole-stdout wire: the line joins the buffer the turn's exit
    // parses; nothing is emitted mid-turn.
    this.turnStdout.push(line);
  }

  /** The line-stream arm (gemini's stream-json): events apply as they
   * arrive, exactly opencode's parse application mapped through the
   * shared stream vocabulary. */
  private applyStreamEvent(event: TurnAgentStreamEvent, rawLine: string): void {
    switch (event.kind) {
      case "unusable":
        this.emitError(
          true,
          "harness",
          `unusable harness output (not JSON, ${event.bytes} bytes): ${event.excerpt}`
        );
        void this.finish("crash", 1);
        return;
      case "grammar_error":
        this.emit(buildUnknownEvent(++this.seq, this.sessionIdOrEmpty(), rawLine));
        this.emitError(true, "harness", event.message);
        void this.finish("crash", 1);
        return;
      case "unknown":
        this.emit(buildUnknownEvent(++this.seq, this.sessionIdOrEmpty(), rawLine));
        return;
      case "confirmed":
        this.adoptSessionId(event.sessionId);
        if (event.model !== null) this.turnModelEffective = event.model;
        return;
      case "assistant":
        if (this.requireOpenTurn(rawLine)) return;
        this.emit(
          buildEvent(
            ++this.seq,
            this.sessionIdOrEmpty(),
            event.delta ? "assistant_delta" : "assistant_message",
            rawLine,
            event.delta
              ? { delta: event.text, turn_id: this.fsm.activeTurn }
              : { text: event.text, turn_id: this.fsm.activeTurn }
          )
        );
        return;
      case "tool_use":
        if (this.requireOpenTurn(rawLine)) return;
        this.emit(
          buildEvent(++this.seq, this.sessionIdOrEmpty(), "tool_call", rawLine, {
            call_id: event.callId,
            name: event.name,
            input: event.input,
          })
        );
        return;
      case "tool_result":
        if (this.requireOpenTurn(rawLine)) return;
        this.emit(
          buildEvent(++this.seq, this.sessionIdOrEmpty(), "tool_result", rawLine, {
            call_id: event.callId,
            output: event.output,
            is_error: event.isError,
          })
        );
        return;
      case "error":
        if (this.requireOpenTurn(rawLine)) return;
        this.emitError(false, "harness", event.message);
        if (event.failsTurn && this.turnError === null) this.turnError = event.message;
        return;
      case "result":
        this.turnUsage = event.usage;
        if (event.failed && this.turnError === null) {
          this.turnError = event.failureReason;
        }
        return;
    }
  }

  /** The line-stream turn verdict (gemini): the events already applied;
   * the exit code and the stream's own error state decide. */
  protected applyStreamVerdict(outcome: SessionChildOutcome): void {
    const exitDetail =
      outcome.code !== null
        ? `code ${outcome.code}`
        : `signal ${outcome.signal ?? "unknown"}`;
    if (this.sessionId === null) {
      // A null id here means the wire never named the identity at all
      // (a line-stream deferred agent): the untrackable rule.
      this.completeFailedUntrackable(
        {
          answer: null,
          usage: this.turnUsage ?? emptyUsage(),
          modelEffective: this.turnModelEffective,
          sessionId: null,
          noSessionId: true,
          wrongSession: false,
          noWire: false,
          failed: true,
          failureReason: null,
        },
        exitDetail
      );
      return;
    }
    const failed = outcome.code !== 0 || this.turnError !== null;
    this.completeTurnPair(failed, exitDetail, this.turnUsage ?? emptyUsage());
  }

  /** The untrackable first turn (§4.8): the turn completes failed in
   * front of the caller, then the session ends — nothing can record or
   * resume it. */
  private completeFailedUntrackable(
    verdict: TurnAgentTurnVerdict,
    exitDetail: string
  ): void {
    const turnId = this.fsm.activeTurn;
    if (turnId === null) return;
    const error = this.fsm.transition({ kind: "turn_completed", turnId });
    if (error !== null) {
      this.emitError(true, "codemux", error.message);
      void this.finish("crash", 1);
      return;
    }
    this.cumulative = addUsage(this.cumulative, verdict.usage);
    this.emit(
      buildEvent(++this.seq, this.sessionIdOrEmpty(), "turn_completed", null, {
        turn_id: turnId,
        finish: "failed",
        reason:
          this.turnError ??
          `the process exited with ${exitDetail} and named no session id`,
        usage: verdict.usage,
      })
    );
    appendSessionTurnCallRecord(
      this.callLedger,
      this.ledgerSessionId(),
      turnId,
      this.turnStartedAt.get(turnId) ?? Date.now(),
      "failed",
      verdict.usage,
      this.turnModelEffective
    );
    this.turnStartedAt.delete(turnId);
    this.emitError(
      true,
      "harness",
      "the first turn named no session id, " +
        "so the session cannot be recorded in the registry"
    );
    void this.finish("crash", 1);
  }

  /** Adopt the session id from the first output that named one (a
   * fresh deferred session); output that names it confirms a resume or
   * the mint. The private home does NOT settle here: a line-stream
   * adopt (gemini's init line) lands while the turn's process still
   * writes through its GEMINI_CLI_HOME path, and the settle rename
   * would strand every open-after-rename the child still makes — so the
   * settle waits for the turn's completion, when no child is writing
   * (the same place the whole-stdout agents arrive, post-exit). The
   * announcement names the settled spelling either way; between it and
   * the settle the resume guard refuses a resume of a path that does
   * not exist yet — fail closed, the same one-turn window the kimi
   * deferred settle carries. */
  protected adoptSessionId(sessionId: string): void {
    this.harnessConfirmed = true;
    if (this.sessionId === null) {
      this.sessionId = sessionId;
      this.announceSessionStarted();
    }
  }

  /** A mapped stream line belongs to the open turn; one that arrives
   * with no open turn breaks the stream's grammar (tier 2). */
  private requireOpenTurn(rawLine: string): boolean {
    if (this.fsm.state === "turn_active") return false;
    this.emit(buildUnknownEvent(++this.seq, this.sessionIdOrEmpty(), rawLine));
    this.emitError(true, "harness", "a harness line arrived with no open turn");
    void this.finish("crash", 1);
    return true;
  }

  private emitAssistant(text: string): void {
    this.emit(
      buildEvent(++this.seq, this.sessionIdOrEmpty(), "assistant_message", null, {
        text,
        turn_id: this.fsm.activeTurn,
      })
    );
  }

  /** The paired completion of an answered turn: the usage fold, the
   * turn_completed event, and the ledger line. A failed turn is not a
   * failed session — the next turn still runs. Runs after the turn
   * process's tree settled (onTurnExited), so this is also where a
   * mid-turn adopt (the line-stream wires) settles the private home:
   * no child is writing anymore. */
  private completeTurnPair(
    failed: boolean,
    exitDetail: string,
    usage: ResultUsageBlock
  ): void {
    const turnId = this.fsm.activeTurn;
    if (turnId === null) return;
    const completion = this.out.completeTurn(turnId, failed ? "failed" : "end",
      failed ? this.turnError ?? `the process exited with ${exitDetail}` : undefined);
    this.settlePrivateHome();
    const error = this.fsm.transition({ kind: "turn_completed", turnId });
    if (error !== null) {
      this.emitError(true, "codemux", error.message);
      void this.finish("crash", 1);
      return;
    }
    this.cumulative = addUsage(this.cumulative, usage);
    this.emit(
      buildEvent(++this.seq, this.sessionIdOrEmpty(), "turn_completed", null, {
        turn_id: turnId,
        ...completion,
        usage,
      })
    );
    appendSessionTurnCallRecord(
      this.callLedger,
      this.ledgerSessionId(),
      turnId,
      this.turnStartedAt.get(turnId) ?? Date.now(),
      completion.finish,
      usage,
      this.turnModelEffective
    );
    this.turnStartedAt.delete(turnId);
    this.stampActivity();
  }

  /** The turn path's best-effort activity stamp (review live13). */
  protected stampActivity(): void {
    if (!this.registryRecorded || this.options.registryPath === null) return;
    const outcome = touchSession(this.options.registryPath, this.sessionId ?? "", {
      attempts: 1,
    });
    if (!outcome.ok && !this.touchWarned) {
      this.touchWarned = true;
      console.error(
        `codemux: cannot stamp the session registry for ${this.sessionId} ` +
          `(${outcome.error}); activity tracking may lag`
      );
    }
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
    this.turnModelEffective = null;
    this.turnError = null;
    this.turnPrompt = null;
    this.turnStdout = [];
    this.emit(
      buildEvent(++this.seq, this.sessionIdOrEmpty(), "turn_started", null, {
        turn_id: turnId,
      })
    );
    this.turnStartedAt.set(turnId, Date.now());
    return turnId;
  }
}
