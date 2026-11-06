/**
 * Turn bookkeeping for the aider session driver: the turn-exit hook, the
 * pairing completion (FSM transition, usage fold, event, ledger line),
 * turn-id assignment, and the activity stamp. src/session/aider-driver.ts
 * owns the lifecycle; the spawn and verdict paths live there.
 */

import { readAiderHistoryDelta } from "../aider-history.js";
import {
  aiderDeltaRecordsUnansweredPrompt,
  aiderHistoryHeader,
  aiderReplyAfterHeader,
  extractAiderReply,
} from "../aider-history-text.js";
import { appendSessionTurnCallRecord } from "../call-log.js";
import { emptyUsage } from "../result-envelope.js";
import {
  harnessFailed,
  type SessionChildOutcome,
  type SessionProcess,
} from "./process.js";
import { buildEvent, type InputRejectionReason } from "./protocol.js";
import { touchSession } from "./registry.js";
import { addTurnUsage } from "./usage.js";
import { AiderDriverCore } from "./aider-finalize.js";

export abstract class AiderTurns extends AiderDriverCore {
  private turnCounter = 0;

  /** How many bytes of the history file earlier turns have consumed;
   * each turn's exchange is the slice past it. A byte offset, not a
   * string length: the session history outgrows any whole-file read, so
   * the driver reads only the bounded delta past this offset (review
   * D8, correctness 2). */
  protected consumedBytes = 0;
  /** The prompt the open turn's process was spawned with — the delta's
   * reply is anchored past its header block, and the failed-turn check
   * pairs it with the prompt the history may hold unanswered. */
  protected turnPrompt: string | null = null;

  // Filled in by the driver (aider-driver.ts owns the spawn path and the
  // outbound ack lane).
  protected abstract startTurn(text: string): Promise<void>;
  protected abstract ack(
    inputSeq: number,
    accepted: boolean,
    reason?: InputRejectionReason
  ): void;

  // --- turns ---------------------------------------------------------------
  /** The turn process exited: after its tree settles, its outcome
   * completes the turn — unless the end path's synthesis won the race or
   * the end path has already synthesized its completion. */
  protected async onTurnExited(
    proc: SessionProcess,
    outcome: SessionChildOutcome
  ): Promise<void> {
    await proc.settled;
    if (this.settled) return;
    if (this.turnProc !== proc) return; // superseded — defensive
    this.completeTurn(outcome);
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
    // The non-resumable shape, checked for EVERY exit code (review round
    // 162): the history file is the session's whole state, and
    // --restore-chat-history replays an unanswered prompt as if the
    // caller had sent it — the exit code does not distinguish the two
    // shapes, so an exit-0 process that wrote the prompt and no reply is
    // as unrecoverable as a failed one.
    const unanswered = aiderDeltaRecordsUnansweredPrompt(delta, this.turnPrompt);
    if (outcome.code !== 0) {
      this.finishTurn(turnId, "failed", `the aider process exited with ${exitDetail}`);
      // `!finished` keeps the verdict with an end path already draining
      // this child (its own drain-failure fatal already reports a
      // nonzero exit).
      if (!this.finished && unanswered) {
        this.failOnUnansweredPrompt();
      }
      this.consumedBytes = read.sizeBytes;
      return;
    }
    if (unanswered) {
      this.finishTurn(turnId, "failed", "the chat history holds the prompt with no reply");
      this.failOnUnansweredPrompt();
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

  /** The shared end for a turn whose history delta holds its prompt with
   * no reply: the consumed offset never advances past the unanswered
   * prompt, the fatal says why, and the session ends as a crash with
   * exit 1 — so `session_ended` is not resumable. The crash call is
   * unconditional: with an end path already draining this child it only
   * raises that end's exit code (finish's idempotent arm), and
   * `unansweredPromptRecorded` keeps the end path's resumable verdict
   * false whatever order the raise and the verdict land in. */
  private failOnUnansweredPrompt(): void {
    this.unansweredPromptRecorded = true;
    this.emitError(
      true,
      "codemux",
      `the session's chat history holds the failed turn's prompt with no reply (${this.options.historyPath}); ` +
        "the session state is unreliable, so the session cannot continue"
    );
    void this.finish("crash", 1);
  }

  /** The turn's pairing completion: FSM transition, the uniform usage
   * fold (aider reports nothing machine-readable, so the usage is
   * honestly all-null), the event, and the activity stamp. */
  protected finishTurn(
    turnId: string,
    finish: "end" | "failed",
    reason?: string
  ): void {
    const error = this.fsm.transition({ kind: "turn_completed", turnId });
    if (error !== null) {
      this.emitError(true, "codemux", error.message);
      void this.finish("crash", 1);
      return;
    }
    const usage = emptyUsage();
    this.cumulative = addTurnUsage(this.cumulative, usage);
    this.emit(
      buildEvent(++this.seq, this.options.sessionId, "turn_completed", null, {
        turn_id: turnId,
        finish,
        ...(reason !== undefined ? { reason } : {}),
        usage,
      })
    );
    // The ledger's turn record mirrors the event the caller just saw
    // (call-log.ts); aider reports no usage, so the block is all-null —
    // the honest null, not a guessed zero.
    appendSessionTurnCallRecord(
      this.callLedger,
      this.options.sessionId,
      turnId,
      this.turnStartedAt.get(turnId) ?? Date.now(),
      finish,
      usage
    );
    this.turnStartedAt.delete(turnId);
    this.stampActivity();
  }

  /** Assign the next codemux turn id and open it in the FSM. */
  protected submitTurn(): string | null {
    this.turnCounter += 1;
    const turnId = `t${this.turnCounter}`;
    const error = this.fsm.transition({ kind: "turn_started", turnId });
    if (error !== null) {
      this.emitError(true, "codemux", error.message);
      void this.finish("crash", 1);
      return null;
    }
    this.emit(
      buildEvent(++this.seq, this.options.sessionId, "turn_started", null, {
        turn_id: turnId,
      })
    );
    this.turnStartedAt.set(turnId, Date.now());
    return turnId;
  }

  /** The turn path's best-effort activity stamp: single-attempt lock,
   * never a wait (review live13). */
  private stampActivity(): void {
    if (!this.registryRecorded || this.options.registryPath === null) return;
    const outcome = touchSession(this.options.registryPath, this.options.sessionId, {
      attempts: 1,
    });
    if (!outcome.ok && !this.touchWarned) {
      this.touchWarned = true;
      console.error(
        `codemux: cannot stamp the session registry for ${this.options.sessionId} ` +
          `(${outcome.error}); activity tracking may lag`
      );
    }
  }
}
