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

import { appendSessionTurnCallRecord, providerHost } from "../call-log.js";
import { emptyUsage } from "../result-envelope.js";
import { parseOpenCodeRunLine } from "./opencode-session.js";
import {
  BoundedOutboundQueue,
  callerStdinFailure,
  codemuxFatalMessage,
  harnessFailed,
  harnessLineDeliverable,
  SESSION_SIGNAL_EXIT_CODE,
  installSessionSignalHandlers,
  type SessionChildOutcome,
  type SessionFatal,
} from "./process.js";
import {
  applyAuthorPrefix,
  buildEvent,
  buildInputAck,
  buildUserMessage,
  parseInputLine,
  type InputRejectionReason,
} from "./protocol.js";
import { addUsage } from "./usage.js";
import { OpenCodeTurns } from "./opencode-turns.js";
import type { OpenCodeDriverOptions } from "./opencode-finalize.js";

export type { OpenCodeDriverOptions } from "./opencode-finalize.js";

type Timer = ReturnType<typeof setTimeout>;

export class OpenCodeSessionDriver extends OpenCodeTurns {

  private stdinClosed = false;
  private sessionTimer: Timer | null = null;

  constructor(options: OpenCodeDriverOptions) {
    super();
    this.options = options;
    this.done = new Promise<number>((resolve) => {
      this.resolveDone = resolve;
    });
    this.sessionId = options.resumeSessionId;
    this.callLedger = {
      agent: "opencode",
      model: options.model ?? null,
      provider: providerHost(options.providerBaseUrl),
      autonomy: options.autonomy,
      hermetic: options.hermetic,
      sandboxed: options.sandboxed,
      cwd: options.cwd,
    };
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
        // The opencode wire refuses an empty message outright (it reads a
        // non-TTY stdin to EOF as the message and exits 1 on an empty
        // one — opencode-session.ts's pin), and on a fresh session that
        // also leaves no session id, so the turn would end the whole
        // session as untrackable (§4.8). Refused before the
        // acknowledgement the way kimi refuses its whitespace-only
        // prompt: the message is deliverable but not one the harness
        // accepts — the `unsupported` row, not a framing error (review
        // round 96, whole tree).
        if (harnessText.trim() === "") {
          this.ack(inputSeq, false, "unsupported");
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

  /** Turn-per-process verdict: the turn fails on a nonzero exit or on an
   * error line its stream carried (the plain-run rule, plain-unwrap/
   * opencode.ts: a reported error fails the turn even when the process
   * exits 0), the first error line its reason, the folded step_finish
   * usage its report. A failed turn is not a failed session — the next
   * turn still runs. A fresh session still without an id after its first
   * turn is untrackable and ends the session (§4.8, the agy authfail
   * rule). */
  protected completeTurn(outcome: SessionChildOutcome): void {
    this.lastChildOutcome = outcome;
    this.sawHarnessFailure ||= harnessFailed(outcome);
    // The synthesis in finish may have answered the turn already (the
    // settled guard above missed nothing; this is the second line of
    // defense for the FSM race).
    if (this.fsm.state !== "turn_active") return;
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
      // The turn completed in front of the caller, so it gets its ledger
      // line before the session-ending fatal that follows (call-log.ts).
      appendSessionTurnCallRecord(
        this.callLedger,
        this.ledgerSessionId(),
        turnId,
        this.turnStartedAt.get(turnId) ?? Date.now(),
        "failed",
        usage
      );
      this.turnStartedAt.delete(turnId);
      this.emitError(
        true,
        "harness",
        "the first turn named no session id, " +
          "so the session cannot be recorded in the registry"
      );
      void this.finish("crash", 1);
      return;
    }
    // A reported error line fails the turn whatever the exit code was
    // (review round 123): the harness itself said the turn failed, so a
    // clean process exit cannot upgrade it to "end".
    const failed = outcome.code !== 0 || this.turnError !== null;
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
    // The ledger's turn record mirrors the event the caller just saw
    // (call-log.ts).
    appendSessionTurnCallRecord(
      this.callLedger,
      this.ledgerSessionId(),
      turnId,
      this.turnStartedAt.get(turnId) ?? Date.now(),
      failed ? "failed" : "end",
      usage
    );
    this.turnStartedAt.delete(turnId);
    this.stampActivity();
  }

  /** Queue one event line. The session's end events (the option) ride
   * the queue's terminal lane (round al32): session_ended and the fatals
   * that end the session reach the caller even when the ordinary bounds
   * refuse everything else, while turn_completed and the input acks are
   * ordinary entries that drop with the rest. Two terminal classes
   * (round al35, edges major 4): `terminal: true` is session_ended
   * alone, and `terminal: "fatal"` is a fatal, so the lane reserves its
   * last slot for the end event and a flood of fatals cannot take it.
   * The enqueue's boolean is deliberately ignored — a refused line has
   * already fired the queue's own failure callback, which starts the
   * crash end; a terminal line is refused only when its lane class is
   * full, and the overflow that reports starts the same end. */
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
      // A fatal rides the lane's fatal class (capped one slot short of
      // the lane), so the slot the end event needs survives a flood of
      // them (round al35, edges major 4).
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
