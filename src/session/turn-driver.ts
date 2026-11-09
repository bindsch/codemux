/**
 * The shared turn-per-process session driver class (turn-driver-core.ts
 * holds the state and end path, turn-driver-turns.ts the turn
 * machinery): the caller-facing edges of the opencode driver — the
 * caller protocol (ack, user, shutdown), the harness line and fatal
 * handlers, the resume claim, the session timer — bound to any agent
 * profile. The seven second-wave agents (cursor, droid, pi, qwen,
 * gemini, copilot, goose) run this one class; their profiles
 * (src/session/<agent>-driver.ts) are the only per-agent code.
 *
 * Identity models (turn-driver-core.ts): "minted" agents announce
 * session_started at run() start with the codemux-minted id (the
 * aider/claude rule); "deferred" agents wait for the first turn's
 * output (the opencode rule). Both announce through the same
 * registry-record discipline.
 */

import { providerHost } from "../call-log.js";
import { SessionOutputQueue } from "./completion.js";
import {
  callerStdinFailure,
  codemuxFatalMessage,
  harnessFailed,
  harnessLineDeliverable,
  SESSION_SIGNAL_EXIT_CODE,
  type SessionChildOutcome,
  type SessionFatal,
} from "./process.js";
import { MAX_ARGV_PROMPT_BYTES } from "../process-runner.js";
import {
  applyAuthorPrefix,
  buildEvent,
  buildInputAck,
  buildUserMessage,
  parseInputLine,
  type InputRejectionReason,
} from "./protocol.js";
import { TurnDriverTurns } from "./turn-driver-turns.js";
import type { TurnAgentDriverOptions } from "./turn-driver-core.js";

type Timer = ReturnType<typeof setTimeout>;

export class TurnAgentSessionDriver extends TurnDriverTurns {

  private stdinClosed = false;
  private sessionTimer: Timer | null = null;

  constructor(options: TurnAgentDriverOptions) {
    super();
    this.options = options;
    this.capabilities = options.profile.capabilities;
    this.done = new Promise<number>((resolve) => {
      this.resolveDone = resolve;
    });
    // A minted identity's fresh session runs under the id the launcher
    // minted (turn-driver-launch.ts): one id names the private home, the
    // registry record, and the first turn's --session-id. A deferred
    // fresh session stays null until the first turn's output names the
    // harness's own mint.
    this.sessionId = options.resumeSessionId ??
      (options.profile.identity === "minted" ? options.mintedSessionId ?? null : null);
    this.callLedger = {
      agent: options.profile.agent,
      model: options.model ?? null,
      modelAlias: options.modelAlias ?? null,
      provider: providerHost(options.providerBaseUrl),
      autonomy: options.autonomy,
      hermetic: options.hermetic,
      sandboxed: options.sandboxed,
      cwd: options.cwd,
    };
    this.out = new SessionOutputQueue(
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
    this.signals = this.stopEscalation.install(
      () => void this.finish("signal", SESSION_SIGNAL_EXIT_CODE),
      () => [this.turnProc]
    );
  }

  /** The CLI's resume claim succeeded: this process owns the record from
   * now on, whether or not the session start is ever reached. */
  adoptResumeClaim(): void {
    this.resumeClaimed = true;
  }

  /** The main wait: resolves with codemux's exit code when the session
   * has fully ended. There is no child to watch while idle — a turn
   * process's death is that turn's business, not the session's, until
   * it leaves the turn unanswerable (which completeTurn reports). */
  async run(): Promise<number> {
    if (this.finished) return this.done;
    if (this.options.sessionTimeoutMs !== null) {
      this.sessionTimer = setTimeout(
        () => void this.finish("timeout", 1),
        this.options.sessionTimeoutMs
      );
      this.sessionTimer.unref?.();
    }
    // A fresh session proves the registry writable before any turn can
    // run untracked (the cli-record.ts rule for driver-owned records).
    this.probeRegistry();
    if (this.finished) return this.done;
    const minted = this.options.profile.identity === "minted";
    if (minted || this.sessionId !== null) {
      // The minted identity is known at construction — the id is
      // codemux's mint — and a resume knows its registry-vouched id at
      // spawn; both announce now. The deferred fresh identity waits for
      // the first turn's output to name it.
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

  /** One line from the open turn process's stdout. Never throws. A
   * line-stream profile applies its parse per line; a whole-stdout
   * profile buffers until the turn's exit parses the fold. */
  handleHarnessLine(line: string): void {
    if (this.settled) return;
    this.applyLine(line);
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
   * capability matrix (live input and resume only, per profile) has
   * already narrowed the reachable cases to `user` and `shutdown`. */
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
        // The carrier decides the deliverability bound: an argv carrier
        // (goose -t; openhands, whose argv names a task file) rides the OS argv
        // limit codemux enforces for run prompts (32 KiB); a stdin
        // carrier rides the protocol's 16 MiB text bound.
        if (this.options.profile.promptCarrier === "argv") {
          if (Buffer.byteLength(harnessText, "utf8") > MAX_ARGV_PROMPT_BYTES) {
            this.ack(inputSeq, false, "text_too_long");
            return;
          }
        } else if (!harnessLineDeliverable(harnessText)) {
          this.ack(inputSeq, false, "text_too_long");
          return;
        }
        // Every one of these wires reads the message as the process's
        // entire prompt (stdin to EOF or one argv slot); an empty one is
        // a harness refusal waiting to happen — and on a fresh deferred
        // session it would also leave no session id, ending the session
        // as untrackable (§4.8). Refused before the acknowledgement the
        // way kimi and opencode refuse theirs: deliverable but not one
        // the harness accepts (review round 96).
        if (harnessText.trim() === "") {
          this.ack(inputSeq, false, "unsupported");
          return;
        }
        this.ack(inputSeq, true);
        // The acknowledgement itself can be the event that breaches the
        // outbound bound and ends the session. The end path then recorded
        // that no turn was open, so no turn may open after it (review
        // round 155).
        if (this.finished) return;
        if (this.fsm.state === "starting") {
          // The deferred fresh identity's silent warm-up: the
          // session_started event and the registry record wait for the
          // first turn's output to name the session.
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
        // A turn must not spawn after the driver finished (review round
        // 153): an outbound bound breached inside the emits above ends
        // the session synchronously — the queue's failure callback runs
        // finish, which sets `finished` before its first await — so the
        // turn ends with the session instead of spawning a child the end
        // path no longer owns.
        if (this.finished) return;
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

  /** Turn-per-process verdict, carrier-routed: a whole-stdout profile
   * parses the buffered fold once; a line-stream profile reads the
   * events its stream already applied. Both land in the shared identity
   * rules of turn-driver-turns.ts. */
  protected completeTurn(outcome: SessionChildOutcome): void {
    this.lastChildOutcome = outcome;
    this.sawHarnessFailure ||= harnessFailed(outcome);
    // The synthesis in finish may have answered the turn already (the
    // settled guard above missed nothing; this is the second line of
    // defense for the FSM race).
    if (this.fsm.state !== "turn_active") return;
    this.turnProc = null;
    if (this.options.profile.parseStreamLine !== undefined) {
      this.applyStreamVerdict(outcome);
      return;
    }
    this.applyWholeStdoutVerdict(outcome);
  }

  /** Queue one event line. The session's end events (the option) ride
   * the queue's terminal lane (round al32): session_ended and the
   * fatals that end the session reach the caller even when the ordinary
   * bounds refuse everything else, while turn_completed and the input
   * acks are ordinary entries that drop with the rest. Two terminal
   * classes (round al35, edges major 4): `terminal: true` is
   * session_ended alone, and `terminal: "fatal"` is a fatal, so the
   * lane reserves its last slot for the end event and a flood of
   * fatals cannot take it. */
  protected emit(line: string, options?: { terminal?: boolean | "fatal" }): void {
    this.out.enqueue(line, options);
  }

  private ack(inputSeq: number, accepted: boolean, reason?: InputRejectionReason): void {
    this.emit(
      buildInputAck(++this.seq, this.sessionIdOrEmpty(), inputSeq, accepted, reason)
    );
  }

  protected emitError(
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
      }),
      { terminal: fatal ? "fatal" : undefined }
    );
  }

  protected clearTimers(): void {
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
