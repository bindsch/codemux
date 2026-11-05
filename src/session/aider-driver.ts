/**
 * The aider session driver (design §4.7): turn-per-process with
 * codemux-owned state. Each caller input spawns one headless aider
 * process against the session's chat history file
 * (src/session/aider-session.ts), writes the canned negative responses,
 * and lets the process run to its exit; the state that carries across
 * turns is aider's own chat history — the transcript the next process
 * replays with --restore-chat-history before appending its exchange.
 *
 * aider's stdout is a human transcript, never a protocol: every line is
 * tier-1 unknown passthrough, raw preserved. The turn's verdict comes
 * from two codemux-side facts instead — the process's exit code, and the
 * chat history delta: the `#### ` section this exchange appended, with
 * the model's reply extracted from it (src/aider-history.ts). The
 * delta is read past a byte offset that advances with each turn, never
 * as the whole file — a session's history accumulates every exchange
 * for the session's whole life and outgrows any whole-file bound
 * (review D8, correctness 2). A history that cannot be read back
 * (symlink, truncation, an oversize turn) is an integrity failure: the
 * session's state is the file, so the session ends rather than
 * continue on state it cannot see.
 *
 * Identity is codemux-owned from the start: the session id is a minted
 * UUID, the record is written before anything spawns
 * (`recordBeforeSpawn`, the claude-family pattern), and session_started
 * is announced at run() start — no deferred identity, because nothing
 * about the id waits on the harness.
 *
 * Round al28 gives this lifecycle a shared state table
 * (src/session/turn-per-process.ts), written against kimi's rewrite.
 * Aider keeps its own implementation, split across a class chain with
 * this file's AiderSessionDriver at the head: aider-finalize.ts's
 * AiderDriverCore holds the shared state and the end path,
 * aider-turns.ts's AiderTurns adds the turn bookkeeping, and
 * aider-input.ts's AiderCallerInput adds the caller-side input
 * grammar; the driver itself owns the spawn and verdict paths and the
 * caller-facing edges. The FSM (declared once in AiderDriverCore) is the
 * caller-visible protocol grammar, and its ladder overlays the table:
 * `turn_active` spans the table's spawning and running, `shutting_down`
 * spans draining and ending, `ended` is ended — but the table's
 * invariants are this driver's too, and its DELIBERATE DIVERGENCES
 * section is the contract this file must not silently leave: aider
 * always awaits an in-flight spawn at the end (no abandon, no hold —
 * its end path has no deadline-vs-probe tension, and every child is
 * settled before done resolves), and its end exit code keeps the
 * monotone maximum over the end path, whose single reachable rung (a
 * late child that cannot take its canned negatives raises 1) is not the
 * interleaving pile that made the maximum wrong for kimi. A reader
 * reasoning about aider's interleavings should hold the table, then
 * those two divergences; nothing else here may disagree with either.
 */

import { providerHost } from "../call-log.js";
import { HEADLESS_NEGATIVE_RESPONSES } from "../adapters/aider.js";
import {
  aiderDeltaRecordsUnansweredPrompt,
  aiderHistoryHeader,
  aiderHistorySizeBytes,
  aiderReplyAfterHeader,
  extractAiderReply,
  readAiderHistoryDelta,
} from "../aider-history.js";
import {
  assertAiderHistoryForTurn,
  buildAiderSessionCommand,
} from "./aider-session.js";
import {
  BoundedOutboundQueue,
  codemuxFatalMessage,
  harnessFailed,
  SESSION_SIGNAL_EXIT_CODE,
  installSessionSignalHandlers,
  type SessionChildOutcome,
  type SessionFatal,
  type SessionProcess,
} from "./process.js";
import { lateChildRuns } from "./spawn-wait.js";
import {
  buildEvent,
  buildInputAck,
  buildUnknownEvent,
  type InputRejectionReason,
} from "./protocol.js";
import { AiderCallerInput } from "./aider-input.js";
import type { AiderDriverOptions } from "./aider-finalize.js";

export type { AiderDriverOptions } from "./aider-finalize.js";

type Timer = ReturnType<typeof setTimeout>;

export class AiderSessionDriver extends AiderCallerInput {

  /** How many bytes of the history file earlier turns have consumed;
   * each turn's exchange is the slice past it. A byte offset, not a
   * string length: the session history outgrows any whole-file read, so
   * the driver reads only the bounded delta past this offset (review
   * D8, correctness 2). */
  private consumedBytes = 0;
  /** The open turn's prompt as sent: aider's history block for this
   * exchange is built from exactly these bytes (aiderHistoryHeader), so
   * the reply is anchored past it — a multi-line prompt's continuation
   * lines sit inside the header's own section and must not leak into the
   * reply. */
  private turnPrompt: string | null = null;
  private sessionTimer: Timer | null = null;

  constructor(options: AiderDriverOptions) {
    super();
    this.options = options;
    this.done = new Promise<number>((resolve) => {
      this.resolveDone = resolve;
    });
    this.callLedger = {
      agent: "aider",
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
        // Both failure classes end the session (§4.2); the diagnostic
        // rides stderr because the final events may not fit.
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
   * has fully ended. The history file is verified and sized once here —
   * the resume verification (an unreadable history fails the session
   * before any turn runs) and the consumed-byte baseline in one step,
   * with none of the transcript's content read: a session history grows
   * without bound, so codemux reads only each turn's bounded delta
   * (review D8, correctness 2). */
  async run(): Promise<number> {
    if (this.finished) return this.done;
    if (this.options.sessionTimeoutMs !== null) {
      this.sessionTimer = setTimeout(
        () => void this.finish("timeout", 1),
        this.options.sessionTimeoutMs
      );
      this.sessionTimer.unref?.();
    }
    const historySize = aiderHistorySizeBytes(this.options.historyPath);
    if (historySize === null) {
      this.emitError(
        true,
        "codemux",
        `the session history file cannot be read (${this.options.historyPath}); ` +
          (this.options.resume
            ? "the resumed conversation is not recoverable"
            : "the session cannot continue")
      );
      void this.finish("crash", 1);
      return this.done;
    }
    this.consumedBytes = historySize;
    if (this.fsm.state === "starting") {
      // Codemux owns the identity: the session exists now, not at some
      // harness fact. (A user line that arrived first warmed the FSM up
      // without the announcement — this branch is the one place it is
      // emitted.)
      const error = this.fsm.transition({ kind: "session_started" });
      if (error !== null) {
        this.emitError(true, "codemux", error.message);
        void this.finish("crash", 1);
        return this.done;
      }
      this.announceSessionStarted();
    }
    return this.done;
  }

  /** One line from the open turn process's stdout. Never parsed —
   * aider's stdout is a human transcript, so every line is tier-1
   * unknown passthrough, raw preserved (§4.2). */
  handleHarnessLine(line: string): void {
    if (this.settled) return;
    this.emit(buildUnknownEvent(++this.seq, this.options.sessionId, line));
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

  dispose(): void {
    this.signals.dispose();
    this.clearTimers();
  }

  // --- turns ---------------------------------------------------------------
  /** Spawn the turn's process and prime its stdin: the canned negatives
   * (aider treats EOF as acceptance, so a spawn that never answers must
   * answer no), then the half-close. The process's exit ends the turn. */
  protected async startTurn(text: string): Promise<void> {
    // The history file is the session's whole state, and the sandboxed
    // child can write `~/.aider`: re-verify the ownership chain and the
    // file itself (regular, ours, 0600) before EVERY spawn. The
    // creation-time check and the post-turn O_NOFOLLOW read leave the
    // between-turns window where a planted symlink would be followed by
    // this turn's own aider process (review D7, security). A trip fails
    // the TURN, not the session: the caller saw why, and may end the
    // session deliberately.
    try {
      assertAiderHistoryForTurn(this.options.historyPath);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const turnId = this.fsm.activeTurn;
      if (turnId !== null) {
        this.emitError(
          false,
          "codemux",
          `the session's chat history failed its pre-turn check: ${detail}`
        );
        this.finishTurn(
          turnId,
          "failed",
          `the chat history file cannot be trusted for this turn (${detail})`
        );
      }
      return;
    }
    this.turnPrompt = text;
    const argv = buildAiderSessionCommand({
      autonomy: this.options.autonomy,
      model: this.options.model,
      weakModel: this.options.weakModel,
      effort: this.options.effort,
      historyPath: this.options.historyPath,
      prompt: text,
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
        "could not spawn the aider turn process " +
          `(${error instanceof Error ? error.message : String(error)})`
      );
      void this.finish("crash", 1);
      return;
    } finally {
      if (spawn !== null && this.turnSpawn === spawn) this.turnSpawn = null;
    }
    // An end that finished the driver while the spawn ran: the child
    // that arrived after the end must be stopped at once (review live4).
    // The end path, which awaited this same spawn, has normally already
    // stopped and settled it by now; requestStop is idempotent, so this
    // stays as the belt-and-suspenders arm. A GRACEFUL end (stdin-close,
    // shutdown) is the exception (review D11, correctness 2 1): it owes
    // this turn its run, primes the late child's stdin itself (see
    // finish), and this arm must not kill what that path is about to
    // run — unless that end already gave up on this spawn (review round
    // 110), when nothing is left that would run it.
    if (this.finished) {
      if (lateChildRuns(this.endReason, this.turnSpawnAbandoned)) return;
      proc.requestStop();
      void proc.settled;
      return;
    }
    this.turnProc = proc;
    proc.exited.then((outcome) => {
      void this.onTurnExited(proc, outcome);
    });
    const written = proc.writeRaw(HEADLESS_NEGATIVE_RESPONSES);
    if (!written.ok) {
      if (!this.finished) {
        this.emitError(
          true,
          "codemux",
          `could not deliver the negative responses to the aider process (${written.reason ?? "unknown"})`
        );
        void this.finish("crash", 1);
      }
      proc.requestStop();
      return;
    }
    proc.endInput();
  }

  /** Turn-per-process verdict: the process's exit code is the turn's
   * finish; the history file's delta is its substance — the `#### `
   * exchange this turn appended, the model's reply extracted from it. A
   * history that cannot be read back (or shrank) is an integrity
   * failure: the file IS the session's state, so the session ends
   * rather than continue blind. */
  protected completeTurn(outcome: SessionChildOutcome): void {
    this.lastChildOutcome = outcome;
    this.sawHarnessFailure ||= harnessFailed(outcome);
    if (this.fsm.state !== "turn_active") return; // the synthesis answered it
    this.turnProc = null;
    const turnId = this.fsm.activeTurn;
    if (turnId === null) return;
    const read = readAiderHistoryDelta(this.options.historyPath, this.consumedBytes);
    if (read === null) {
      this.finishTurn(turnId, "failed", "the chat history file is unreadable or truncated");
      this.emitError(
        true,
        "codemux",
        `the session's chat history cannot be read back (${this.options.historyPath}); ` +
          "the session state is unreliable, so the session cannot continue"
      );
      void this.finish("crash", 1);
      return;
    }
    const delta = read.text;
    const exitDetail =
      outcome.code !== null
        ? `code ${outcome.code}`
        : `signal ${outcome.signal ?? "unknown"}`;
    if (outcome.code !== 0) {
      this.finishTurn(turnId, "failed", `the aider process exited with ${exitDetail}`);
      // A prompt-only delta from the failed process is the non-resumable
      // shape the end path refuses (aiderDeltaRecordsUnansweredPrompt):
      // the session ends and the offset never advances past the
      // unanswered prompt. `!finished` keeps the verdict with an end path
      // already draining this child.
      if (!this.finished && aiderDeltaRecordsUnansweredPrompt(delta, this.turnPrompt)) {
        this.emitError(
          true,
          "codemux",
          `the session's chat history holds the failed turn's prompt with no reply (${this.options.historyPath}); ` +
            "the session state is unreliable, so the session cannot continue"
        );
        void this.finish("crash", 1);
        return;
      }
      this.consumedBytes = read.sizeBytes;
      return;
    }
    this.consumedBytes = read.sizeBytes;
    if (!delta.includes("#### ")) {
      // Exit 0 but no exchange recorded: the turn produced nothing the
      // session can vouch for. The session continues — the next turn's
      // process may succeed.
      this.finishTurn(turnId, "failed", "the chat history records no exchange for this turn");
      return;
    }
    // The reply is anchored past THIS turn's header block, built exactly
    // as aider writes it (aiderHistoryHeader: `#### ` before every prompt
    // line, joined on two-space lines — io.user_input at the pinned
    // 0.86.2). The delta's first occurrence is the user block: only the
    // per-process banner precedes it, and the delta holds no earlier
    // exchange. The header is searched, not required at the start,
    // because that banner sits ahead of it; the `#### ` search is the
    // fallback for a harness that writes the prompt back altered — the
    // only path where a multi-line prompt's continuation lines can leak
    // (review D1, blocker).
    const header =
      this.turnPrompt !== null ? aiderHistoryHeader(this.turnPrompt) : null;
    const at = header !== null ? delta.indexOf(header) : -1;
    const reply =
      header !== null && at !== -1
        ? aiderReplyAfterHeader(delta.slice(at + header.length))
        : extractAiderReply(delta);
    this.turnPrompt = null;
    if (reply !== "") {
      this.emit(
        buildEvent(++this.seq, this.options.sessionId, "assistant_message", null, {
          text: reply,
          turn_id: turnId,
        })
      );
    }
    this.finishTurn(turnId, "end", undefined);
  }

  // --- helpers ---------------------------------------------------------------
  /** Codemux-originated (raw null): the identity is the minted UUID, not
   * a harness fact. */
  private announceSessionStarted(): void {
    if (
      this.settled ||
      (this.options.registryPath !== null && !this.registryRecorded)
    ) {
      return;
    }
    this.emit(
      buildEvent(++this.seq, this.options.sessionId, "session_started", null, {
        agent: "aider",
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

  protected ack(inputSeq: number, accepted: boolean, reason?: InputRejectionReason): void {
    this.emit(
      buildInputAck(++this.seq, this.options.sessionId, inputSeq, accepted, reason)
    );
  }

  protected emitError(
    fatal: boolean,
    source: "codemux" | "harness",
    message: string
  ): void {
    if (fatal && this.firstFatal === null) this.firstFatal = message;
    this.emit(
      buildEvent(++this.seq, this.options.sessionId, "error", null, {
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
