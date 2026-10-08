/**
 * The opencode session driver (design §4.7): the launcher-owned context
 * that turns per-turn `opencode run` processes plus the caller's stdin into
 * the event stream. opencode speaks no event protocol beyond its one-shot
 * run output (src/session/opencode-session.ts), so the session is
 * turn-per-process: one caller input spawns one `run --session` process,
 * the prompt rides its stdin to EOF, its JSON lines are the turn's events,
 * and its exit is the turn's verdict. State carries across turns through
 * the native session id the first turn's output names.
 *
 * There is no long-lived child: the driver owns zero processes while idle
 * and one while a turn runs. That changes the end path's shape, not its
 * contract — an orderly end still gives the open turn's process the grace
 * to finish on its own (its completion and usage are the drained output
 * the caller is owed) before the stop signal, and the tree-scoped kill
 * still leaves nothing behind.
 *
 * Identity model: a fresh session's id is deferred to the first
 * run-output line (every line carries the sessionID), the agy deferred
 * model; a resume (`--session`, registry-vouched) adopts its id at run
 * start. A first turn whose output never names a session id leaves the
 * session untrackable and ends it (§4.8).
 */

import type { AutonomyLevel, ReasoningEffort, ResultUsageBlock } from "../types.js";
import { emptyUsage } from "../result-envelope.js";
import {
  buildOpenCodeSessionCommand,
  opencodeSessionCapabilities,
  parseOpenCodeRunLine,
  type OpenCodeParse,
} from "./opencode-session.js";
import { SessionFsm } from "./fsm.js";
import {
  awaitFinalFlush,
  BoundedOutboundQueue,
  callerStdinFailure,
  codemuxFatalMessage,
  crashSynthesisReason,
  drainFailureMessage,
  SESSION_SIGNAL_EXIT_CODE,
  harnessLineDeliverable,
  installSessionSignalHandlers,
  type SessionChildOutcome,
  type SessionFatal,
  type SessionProcess,
  type SessionSignalGate,
} from "./process.js";
import {
  applyAuthorPrefix,
  buildEvent,
  buildInputAck,
  buildUnknownEvent,
  buildUserMessage,
  parseInputLine,
  type InputRejectionReason,
} from "./protocol.js";
import {
  recordSessionStart,
  releaseSessionRecord,
  touchSession,
  type SandboxTrust,
} from "./registry.js";
import { addUsage, accumulateUsage } from "./usage.js";
import type { SessionEndReason } from "./agy-driver.js";

export interface OpenCodeDriverOptions {
  /** The native session id to resume, or null to start fresh. */
  resumeSessionId: string | null;
  autonomy: AutonomyLevel;
  /** The wire model (`--model`), already provider-prefixed when an
   * override is active — the CLI owns that mapping, the driver passes it
   * through. Reported on session_started as-is. */
  model?: string;
  effort?: ReasoningEffort;
  /** The validated working directory — also the registry's cwd record. */
  cwd: string;
  hermetic: boolean;
  sandboxed: boolean;
  /** The trust the session actually runs at; recorded and reported as-is. */
  sandboxTrust: SandboxTrust;
  sandboxNoNet: boolean;
  sandboxScrubEnv: boolean;
  /** The `--pass-env` names the child runs with; recorded for the resume
   * guard. */
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
  /** Spawns one process per turn (the CLI's scode/env wiring around
   * SessionProcess); a throw is reported as a codemux failure, never an
   * unhandled rejection. */
  spawnTurn: (argv: string[]) => Promise<SessionProcess>;
  sink?: (line: string) => Promise<void> | void;
}

type Timer = ReturnType<typeof setTimeout>;

export class OpenCodeSessionDriver {
  private readonly fsm = new SessionFsm();
  private readonly capabilities = opencodeSessionCapabilities();
  private readonly out: BoundedOutboundQueue;
  private readonly signals: SessionSignalGate;
  private turnProc: SessionProcess | null = null;
  /** The in-flight turn spawn: set synchronously before spawnTurn is
   * called, cleared once it lands. The end path awaits it (see finish)
   * so a child that lands after the session ended is stopped and its
   * tree settled BEFORE done resolves — the CLI's cleanup (the turn's
   * provider config removal) runs the moment done does, and a live
   * opencode process must never run past it (review D5, correctness 2;
   * a graceful end runs it instead, inside the end path, review D11). */
  private turnSpawn: Promise<SessionProcess> | null = null;
  /** The open turn's prompt (the stdin payload the child has not
   * received yet): set at submit, reset with the other per-turn
   * accumulators. finish reads it to deliver the prompt to a child that
   * lands while a graceful end is already in flight (review D11,
   * correctness 2 1) — turnSpawn being non-null guarantees it was set
   * for this same turn, synchronously, before the spawn existed. */
  private turnPrompt: string | null = null;
  private seq = 0;
  private turnCounter = 0;
  /** The native session id: adopted from the first run-output line (a
   * fresh session) or the registry-vouched resume id adopted at run start.
   * Null until one of those lands. */
  private sessionId: string | null;
  /** A run-output line named this session: the harness confirmed it. A
   * resumed session records at spawn from the vouched id, so the record
   * alone does not prove opencode can load the session (the agy rule,
   * review live21). */
  private harnessConfirmed = false;
  private cumulative: ResultUsageBlock = emptyUsage();
  /** The open turn's folded step_finish usage and first error-line
   * message; reset at submit, consumed at the turn's completion. */
  private turnUsage: ResultUsageBlock | null = null;
  private turnError: string | null = null;
  private registryRecorded = false;
  /** The CLI claimed the record for a resume before anything spawned
   * (`adoptResumeClaim`): every end path releases the claim. */
  private resumeClaimed = false;
  private touchWarned = false;
  private finished = false;
  /** The reason of the end path that owns cleanup (set with finished,
   * never overwritten): startTurn's finished-arm reads it to tell a
   * graceful end — which will run its late-landed child (review D11) —
   * from a signal, timeout, or crash end, which kills it on arrival. */
  private endReason: SessionEndReason | null = null;
  /** The end path's exit code, updatable while cleanup drains (review
   * live7). Monotone: only a higher code ever wins. */
  private endExitCode = 0;
  /** True only once the end path has settled every child: run-output
   * lines keep being parsed and emitted through the whole shutdown drain
   * (review live5). */
  private settled = false;
  private stdinClosed = false;
  private firstFatal: string | null = null;
  private sessionTimer: Timer | null = null;
  private readonly done: Promise<number>;
  private resolveDone!: (code: number) => void;

  constructor(private readonly options: OpenCodeDriverOptions) {
    this.done = new Promise<number>((resolve) => {
      this.resolveDone = resolve;
    });
    this.sessionId = options.resumeSessionId;
    this.out = new BoundedOutboundQueue(
      options.sink ?? defaultEventSink(),
      (failure) => {
        // Both failure classes end the session (§4.2); the diagnostic rides
        // stderr because the final events may not fit.
        if (failure.kind === "overflow") {
          console.error(
            `codemux: event output overran its bounds (${failure.events} events, ` +
              `${failure.bytes} bytes pending); ending the session`
          );
        } else {
          console.error(
            `codemux: event output failed (${failure.error instanceof Error ? failure.error.message : String(failure.error)}); ending the session`
          );
        }
        void this.finish("crash", 1);
      }
    );
    this.signals = installSessionSignalHandlers(() => {
      void this.finish("signal", SESSION_SIGNAL_EXIT_CODE);
    });
  }

  /** The CLI's resume claim succeeded: this process owns the record from
   * now on, whether or not the session start is ever reached. */
  adoptResumeClaim(): void {
    this.resumeClaimed = true;
  }

  /** The main wait: resolves with codemux's exit code when the session
   * has fully ended. There is no child to watch while idle — a turn
   * process's death is that turn's business, not the session's, until it
   * leaves the turn unanswerable (which completeTurn reports). */
  async run(): Promise<number> {
    if (this.finished) return this.done;
    if (this.options.sessionTimeoutMs !== null) {
      this.sessionTimer = setTimeout(
        () => void this.finish("timeout", 1),
        this.options.sessionTimeoutMs
      );
      this.sessionTimer.unref?.();
    }
    if (this.sessionId !== null) {
      // A resumed session knows its identity at spawn: the id is
      // registry-vouched caller input, and the first run-output line only
      // has to agree with it (the parser's mismatch check).
      const error = this.fsm.transition({ kind: "session_started" });
      if (error !== null) {
        this.emitError(true, "harness", error.message);
        void this.finish("crash", 1);
        return this.done;
      }
      this.announceSessionStarted();
    }
    return this.done;
  }

  /** One line from the open turn process's stdout. Never throws. Lines
   * are parsed and emitted until the end path settles. */
  handleHarnessLine(line: string): void {
    if (this.settled) return;
    this.applyParse(
      parseOpenCodeRunLine(line, { knownSessionId: this.sessionId }),
      line
    );
  }

  /** A tier-3 fatal from the process layer (non-UTF-8, line overflow). */
  handleFatal(fatal: SessionFatal): void {
    if (this.settled) return;
    if (fatal.kind === "handler" || fatal.kind === "read-error") {
      console.error(`codemux: ${codemuxFatalMessage(fatal)}`, fatal.error);
      this.emitError(true, "codemux", codemuxFatalMessage(fatal));
      void this.finish("crash", 1);
      return;
    }
    this.emitError(
      true,
      "harness",
      `unusable harness output (${fatal.kind}, ${fatal.bytes} bytes): ${fatal.excerpt}`
    );
    void this.finish("crash", 1);
  }

  /** One framed line from the caller's stdin. Never throws. The honest
   * capability matrix (only live input and resume) has already narrowed
   * the reachable cases to `user` and `shutdown`. */
  handleCallerLine(line: string): void {
    if (line.trim() === "") return;
    if (this.finished) {
      // The input contract (§4.1): during the drain window every line is
      // answered `shutting_down`; once settled, nothing may follow
      // session_ended (review live9).
      if (!this.settled) this.ack(this.fsm.nextInputSeq(), false, "shutting_down");
      return;
    }
    const inputSeq = this.fsm.nextInputSeq();
    const parsed = parseInputLine(line, {
      capabilities: this.capabilities,
      hasActiveTurn: this.fsm.state === "turn_active",
      pendingRequestIds: new Set<string>(),
      shuttingDown:
        this.stdinClosed ||
        this.fsm.state === "shutting_down" ||
        this.fsm.state === "ended",
    });
    if (!parsed.ok) {
      this.ack(inputSeq, false, parsed.reason);
      return;
    }
    const message = parsed.message;
    switch (message.type) {
      case "user": {
        const harnessText = applyAuthorPrefix(
          message.text,
          message.author,
          this.options.authorPrefix
        );
        // The prompt rides stdin as raw text — no JSON frame — so the
        // deliverability check is the raw bytes against the write cap
        // (the protocol's 16 MiB text bound already fits it; the author
        // prefix is the only addition and it is tiny).
        if (!harnessLineDeliverable(harnessText)) {
          this.ack(inputSeq, false, "text_too_long");
          return;
        }
        this.ack(inputSeq, true);
        if (this.fsm.state === "starting") {
          // The silent warm-up: a fresh opencode session has no init
          // frame — the session_started event and the registry record
          // wait for the first run-output line to name the session.
          const error = this.fsm.transition({ kind: "session_started" });
          if (error !== null) {
            this.emitError(true, "harness", error.message);
            void this.finish("crash", 1);
            return;
          }
        }
        // submitTurn announces `turn_started` before the echo and the
        // spawn (the claude/codex/agy order): a spawn failure's fatal
        // must follow the turn it failed.
        const turnId = this.submitTurn();
        if (turnId === null) return; // transition failure already ended us
        this.emit(
          buildUserMessage(
            ++this.seq,
            this.sessionIdOrEmpty(),
            inputSeq,
            message.text,
            message.author,
            turnId
          )
        );
        void this.startTurn(harnessText);
        return;
      }
      case "shutdown": {
        this.ack(inputSeq, true);
        void this.finish("shutdown", 0);
        return;
      }
    }
  }

  /** The caller closed stdin: the graceful end, exit 0. A read error is
   * not a close (review live17). */
  handleCallerEnd(error?: unknown): void {
    this.stdinClosed = true;
    if (this.settled) {
      if (error !== undefined) console.error(`codemux: ${callerStdinFailure(error)}`);
      return;
    }
    if (this.finished) {
      if (error !== undefined) this.emitError(false, "codemux", callerStdinFailure(error));
      return;
    }
    if (error !== undefined) {
      this.emitError(true, "codemux", callerStdinFailure(error));
      void this.finish("stdin-close", 1);
      return;
    }
    void this.finish("stdin-close", 0);
  }

  dispose(): void {
    this.signals.dispose();
    this.clearTimers();
  }

  // --- turns ---------------------------------------------------------------

  /** Spawn the turn's process and write the prompt: `run` reads non-TTY
   * stdin to EOF as its one message, so the write is raw text followed by
   * the half-close. The process's exit — not any one line — ends the
   * turn. */
  private async startTurn(text: string): Promise<void> {
    this.turnPrompt = text;
    const argv = buildOpenCodeSessionCommand({
      autonomy: this.options.autonomy,
      model: this.options.model,
      effort: this.options.effort,
      resumeSessionId: this.sessionId ?? undefined,
    });
    let proc: SessionProcess;
    let spawn: Promise<SessionProcess> | null = null;
    try {
      spawn = this.options.spawnTurn(argv);
      this.turnSpawn = spawn;
      proc = await spawn;
    } catch (error) {
      // The end path owns the verdict once it began; a spawn failure
      // before that is codemux's own failure to run the turn.
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
    // path is about to run.
    if (this.finished) {
      if (this.endReason === "stdin-close" || this.endReason === "shutdown") {
        return;
      }
      proc.requestStop();
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
   * the race (settled) or a signal death inside an end path belongs to
   * that end's story. */
  private async onTurnExited(
    proc: SessionProcess,
    outcome: SessionChildOutcome
  ): Promise<void> {
    await proc.settled;
    if (this.settled) return;
    if (this.turnProc !== proc) return; // superseded — defensive
    this.completeTurn(outcome);
  }

  /** Turn-per-process verdict: the process's exit code is the turn's
   * finish, the first error line its reason, the folded step_finish usage
   * its report. A fresh session still without an id after its first turn
   * is untrackable and ends the session (§4.8, the agy authfail rule). */
  private completeTurn(outcome: SessionChildOutcome): void {
    // The synthesis in finish may have answered the turn already (the
    // settled guard above missed nothing; this is the second line of
    // defense for the FSM race).
    if (this.fsm.state !== "turn_active") return;
    const signaled = outcome.code === null || outcome.signal !== null;
    if (this.finished && (signaled || outcome.code === SESSION_SIGNAL_EXIT_CODE)) {
      // A death the end path itself caused (the drain's SIGTERM, or the
      // 143 a wrapper re-exits it as) or watched happen (a crash drain):
      // the synthesis pairs the turn with the end's own story instead of
      // a misleading "code null"/"code 143" verdict.
      return;
    }
    this.turnProc = null;
    const turnId = this.fsm.activeTurn;
    if (turnId === null) return;
    const usage = this.turnUsage ?? emptyUsage();
    const exitDetail =
      outcome.code !== null
        ? `code ${outcome.code}`
        : `signal ${outcome.signal ?? "unknown"}`;
    if (this.sessionId === null) {
      // The turn's events went out as they arrived; the pairing
      // completion, then the untracked-session fatal.
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
          finish: "failed",
          reason:
            this.turnError ??
            `the opencode process exited with ${exitDetail} and named no session id`,
          usage,
        })
      );
      this.emitError(
        true,
        "harness",
        "the first turn named no session id, " +
          "so the session cannot be recorded in the registry"
      );
      void this.finish("crash", 1);
      return;
    }
    const failed = outcome.code !== 0;
    const error = this.fsm.transition({ kind: "turn_completed", turnId });
    if (error !== null) {
      this.emitError(true, "codemux", error.message);
      void this.finish("crash", 1);
      return;
    }
    // The cumulative fold is a plain sum, not the claude-family
    // adopt-latest (addTurnUsage): opencode's step_finish cost is THAT
    // STEP's own — the binary runs `assistantMessage.cost += step.cost` —
    // so a turn's cost sums its steps and a session's sums its turns
    // (review D2, contracts 2; the within-turn fold below already sums).
    this.cumulative = addUsage(this.cumulative, usage);
    this.emit(
      buildEvent(++this.seq, this.sessionIdOrEmpty(), "turn_completed", null, {
        turn_id: turnId,
        finish: failed ? "failed" : "end",
        ...(failed
          ? { reason: this.turnError ?? `the opencode process exited with ${exitDetail}` }
          : {}),
        usage,
      })
    );
    this.stampActivity();
  }

  // --- harness side --------------------------------------------------------

  private applyParse(parse: OpenCodeParse, rawLine: string): void {
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
        // Tier 2: the raw line still goes out, then the fatal end.
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
        // Non-fatal: the session continues (the next turn runs), and the
        // exit code still decides the turn's finish; the first error line
        // is the reason that verdict carries.
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
   * registry record. Codemux-originated, so raw is null. */
  private announceSessionStarted(): void {
    this.recordStart();
    if (
      this.settled ||
      (this.options.registryPath !== null && !this.registryRecorded)
    ) {
      return;
    }
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
      })
    );
  }

  /** Assign the next codemux turn id, open it in the FSM, and reset the
   * per-turn accumulators. */
  private submitTurn(): string | null {
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
    return turnId;
  }

  // --- end path ------------------------------------------------------------

  /** Every end path funnels here (§4.6). The open turn's process gets the
   * grace to finish on its own first — its completion is the drained
   * output the caller is owed — then the stop signal and the tree-scoped
   * kill; an idle session has no child at all. A turn still SPAWNING gets
   * the same grace when the end is graceful (stdin-close, shutdown): its
   * late-landing child is delivered the prompt and run through the same
   * drain (review D11, correctness 2 1); a signal, timeout, or crash end
   * kills the late child on arrival (review D5, correctness 2). */
  private async finish(reason: SessionEndReason, exitCode: number): Promise<void> {
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
    let childCode: number | null = null;
    // The turn's process to drain, once landed: the one already running,
    // or — on a graceful end — the one that lands while this path waits.
    let drain: SessionProcess | null = proc;
    if (drain === null && spawn !== null) {
      // A turn whose spawn was still in flight when the end path began
      // (an end between the turn's start and its child landing). The
      // CLI's cleanup — for opencode, the turn's provider config
      // removal — runs the moment done resolves, so the late child must
      // be stopped and its tree settled BEFORE that (review D5,
      // correctness 2): never an opencode process running with an
      // OPENCODE_CONFIG that already points at a deleted file. A
      // graceful end meets that by RUNNING the turn inside this path
      // (review
      // D11, correctness 2 1): the child landed before its prompt was
      // written, so deliver the prompt (startTurn's finished-arm leaves
      // the child untouched for exactly this) and give it the landed
      // path's drain below — the turn finishes and settles before done
      // resolves, or the drain's grace expiry stops it. A signal,
      // timeout, or crash end keeps the D5 rule: stop on arrival; the
      // exit is codemux's own kill, not a turn verdict, and session_ended
      // reports exit_code null, exactly as an idle session does.
      let late: SessionProcess | null = null;
      try {
        late = await spawn;
      } catch {
        late = null; // the spawn's own failure — no child to stop
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
          late.requestStop();
          await late.settled;
        }
      }
    }
    if (drain !== null) {
      // The turn process's stdin is already at EOF (the prompt write
      // half-closed it), so there is no end carrier to send: the wait is
      // for the turn's own completion (the FSM leaving turn_active
      // through completeTurn), a raised verdict, or the child's exit —
      // then the stop signal, then the settle.
      const startCode = this.endExitCode;
      await drain.awaitEndAnswer(
        () => this.fsm.state !== "turn_active" || this.endExitCode > startCode
      );
      drain.requestStop();
      await drain.settled;
      childCode = (await drain.exited).code;
      this.turnProc = null;
    }
    // Non-null exactly when the child's exit is itself a failure the
    // verdict reports (review live9): nonzero, not the 143 coded signal
    // death, not a crash end (which emitted its own fatal). A turn that
    // completed through completeTurn already carried the exit as its
    // finish; this is the session-level verdict on top (review live18).
    const drainFailureCode =
      childCode !== null &&
      childCode !== 0 &&
      childCode !== SESSION_SIGNAL_EXIT_CODE &&
      reason !== "crash"
        ? childCode
        : null;
    if (drainFailureCode !== null) {
      this.endExitCode = Math.max(this.endExitCode, 1);
      this.emitError(
        true,
        "harness",
        drainFailureMessage("opencode", drainFailureCode, this.fsm.state === "turn_active")
      );
    }
    if (turnOpenAtFinish && this.fsm.state === "turn_active") {
      // The open turn's `turn_started` must be answered (review live10/
      // live12): synthesize the completion the harness cannot. Failed on
      // a crash end (its fatal already reported the exit), a drain
      // failure, or any fatal raised during the drain; interrupted
      // otherwise. The usage is the turn's real folded step_finish
      // report — partial, but reported, not guessed.
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
        this.cumulative = addUsage(this.cumulative, usage);
        this.emit(
          buildEvent(++this.seq, this.sessionIdOrEmpty(), "turn_completed", null, {
            turn_id: turnId,
            finish:
              reason === "crash" || drainFailureCode !== null || this.firstFatal !== null
                ? "failed"
                : "interrupted",
            reason:
              reason === "crash"
                ? crashSynthesisReason(this.firstFatal)
                : drainFailureCode !== null
                  ? drainFailureMessage("opencode", drainFailureCode, true)
                  : this.firstFatal !== null
                    ? crashSynthesisReason(this.firstFatal)
                    : `the session ended (${reason}) before the turn completed`,
            usage,
          })
        );
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
    const sent = this.out.enqueue(
      buildEvent(++this.seq, this.sessionIdOrEmpty(), "session_ended", null, {
        reason,
        exit_code: childCode,
        usage: this.cumulative,
        resumable,
      })
    );
    const delivered = sent ? await awaitFinalFlush(this.out) : false;
    this.signals.dispose();
    this.resolveDone(delivered ? this.endExitCode : Math.max(this.endExitCode, 1));
  }

  // --- helpers ---------------------------------------------------------------

  private recordStart(): void {
    if (this.options.registryPath === null || this.sessionId === null) return;
    const outcome = recordSessionStart(this.options.registryPath, {
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
      pass_env: [...this.options.passEnv],
      playwright_mcp: false,
      provider_base_url: this.options.providerBaseUrl,
    });
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
  }

  /** The turn path's best-effort activity stamp: single-attempt lock,
   * never a wait (review live13). */
  private stampActivity(): void {
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

  private sessionIdOrEmpty(): string {
    return this.sessionId ?? "";
  }

  private emit(line: string): void {
    this.out.enqueue(line);
  }

  private ack(inputSeq: number, accepted: boolean, reason?: InputRejectionReason): void {
    this.emit(
      buildInputAck(++this.seq, this.sessionIdOrEmpty(), inputSeq, accepted, reason)
    );
  }

  private emitError(
    fatal: boolean,
    source: "codemux" | "harness",
    message: string
  ): void {
    if (fatal && this.firstFatal === null) this.firstFatal = message;
    this.emit(
      buildEvent(++this.seq, this.sessionIdOrEmpty(), "error", null, {
        fatal,
        source,
        message,
      })
    );
  }

  private clearTimers(): void {
    if (this.sessionTimer !== null) {
      clearTimeout(this.sessionTimer);
      this.sessionTimer = null;
    }
  }
}

/** The default event sink: one JSONL line per write on stdout. */
function defaultEventSink(): (line: string) => Promise<void> {
  return async (line: string): Promise<void> => {
    await new Promise<void>((resolve, reject) => {
      process.stdout.write(`${line}\n`, (error) => {
        if (error !== null && error !== undefined) reject(error);
        else resolve();
      });
    });
  };
}
