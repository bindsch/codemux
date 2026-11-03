/**
 * Turn and event handling for the agy session driver: the caller input
 * edges, the harness line parse and result application, and codemux
 * turn-id assignment. src/session/agy-driver.ts owns the lifecycle.
 */

import { appendSessionTurnCallRecord } from "../call-log.js";
import {
  buildAgyUserMessage,
  parseAgySessionLine,
  type AgyParse,
} from "./agy-session.js";
import { callerStdinFailure, harnessLineDeliverable } from "./process.js";
import {
  applyAuthorPrefix,
  buildEvent,
  buildUnknownEvent,
  buildUserMessage,
  parseInputLine,
} from "./protocol.js";
import { touchSession } from "./registry.js";
import { addTurnUsage } from "./usage.js";
import { AgyFinalize } from "./agy-finalize.js";

export abstract class AgyTurns extends AgyFinalize {

  /** The CLI's resume claim succeeded: this process owns the record from
   * now on, whether or not the session start is ever reached. */
  adoptResumeClaim(): void {
    this.resumeClaimed = true;
  }
  /** One line from the harness stdout. Never throws. Lines are parsed and
   * emitted until the end path settles (`settled`): the shutdown grace
   * window is exactly the interval in which a final result envelope may
   * still be arriving, and dropping it there would report a session that
   * ended mid-sentence. */
  override handleHarnessLine(line: string): void {
    if (this.proc === null) {
      this.earlyLines.push(line);
      return;
    }
    if (this.settled) return;
    this.applyParse(
      parseAgySessionLine(line, { knownConversationId: this.conversationId }),
      line
    );
  }

  /** One framed line from the caller's stdin. Never throws. The
   * capability matrix has already narrowed the reachable cases: steer,
   * interrupt, and permission_decision are parser rejections
   * (`unsupported`), and a user line mid-turn is a `busy` rejection, so
   * only `user` and `shutdown` ever reach the switch. */
  handleCallerLine(line: string): void {
    if (line.trim() === "") return;
    if (this.finished) {
      // The input contract (§4.1): every line is answered, an end path
      // included — during the drain window (`finished` and not yet
      // `settled`) the answer is the `shutting_down` rejection (review
      // live9). Once `settled`, `session_ended` is already on the stream
      // and nothing may follow it, so later lines are dropped.
      if (!this.settled) this.ack(this.fsm.nextInputSeq(), false, "shutting_down");
      return;
    }
    const inputSeq = this.fsm.nextInputSeq();
    const parsed = parseInputLine(line, {
      capabilities: this.capabilities,
      hasActiveTurn: this.fsm.state === "turn_active",
      // permissions are false, so nothing is ever pending; the capability
      // gate rejects any decision line `unsupported` before the pending
      // check can see the empty set (unknown_request is unreachable here).
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
        const harnessLine = buildAgyUserMessage(harnessText);
        // Deliverability is checked on the exact frame BEFORE the ack: the
        // frame's JSON-escaping can push a text that passed the protocol's
        // 16 MiB bound past the harness write cap, and an accepted line
        // that cannot reach the harness would hang its turn open with the
        // caller told it went through.
        if (!harnessLineDeliverable(harnessLine)) {
          this.ack(inputSeq, false, "text_too_long");
          return;
        }
        this.ack(inputSeq, true);
        if (this.fsm.state === "starting") {
          // The silent warm-up: the FSM must be idle before a turn can
          // open, but a fresh agy session has no init frame to answer —
          // the session_started event and the registry record wait for
          // the first result to name the conversation (see the class
          // comment). Nothing but a user line or shutdown can arrive in
          // `starting`, so the transition is safe here.
          const error = this.fsm.transition({ kind: "session_started" });
          if (error !== null) {
            this.emitError(true, "harness", error.message);
            void this.finish("crash", 1);
            return;
          }
        }
        // submitTurn announces `turn_started` (codemux-originated:
        // writing the line IS opening the turn), so the order matches the
        // claude and codex drivers — turn_started, then the user_message
        // that names it (review live17) — and both precede the write: a
        // refused write ends the session through the crash path, and its
        // fatal must follow the turn it failed (review live16).
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
        this.writeToHarness(harnessLine);
        return;
      }
      case "shutdown": {
        this.ack(inputSeq, true);
        void this.finish("shutdown", 0);
        return;
      }
    }
  }

  /** The caller closed stdin: the graceful end (§4.6), exit 0. A read
   * error is not a close: the same end path runs, but the failure is
   * reported and costs success (review live17). */
  handleCallerEnd(error?: unknown): void {
    this.stdinClosed = true;
    // `session_ended` is already on the stream once settled, and nothing
    // may follow it: a read error landing during the final flush goes to
    // stderr only (review live18).
    if (this.settled) {
      if (error !== undefined) console.error(`codemux: ${callerStdinFailure(error)}`);
      return;
    }
    if (this.finished) {
      // An end already began and owns the exit code: stdin is no longer
      // read, so a read error now loses nothing and is reported without
      // turning that end into a failure (review live22).
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

  // --- harness side -----------------------------------------------------

  private applyParse(parse: AgyParse, rawLine: string): void {
    switch (parse.kind) {
      case "unusable":
        // Tier 3 (§4.2): the fatal report carries the excerpt; the line
        // itself is not mirrored (there is no event to preserve).
        this.emitError(
          true,
          "harness",
          `unusable harness output (not JSON, ${parse.bytes} bytes): ${parse.excerpt}`
        );
        void this.finish("crash", 1);
        return;
      case "grammar_error":
        // Tier 2: the raw event still goes out, then the fatal end.
        this.emit(buildUnknownEvent(++this.seq, this.sessionIdOrEmpty(), rawLine));
        this.emitError(true, "harness", parse.message);
        void this.finish("crash", 1);
        return;
      case "unknown":
        this.emit(buildUnknownEvent(++this.seq, this.sessionIdOrEmpty(), rawLine));
        return;
      case "result":
        this.applyResult(parse, rawLine);
        return;
    }
  }

  private applyResult(
    parse: Extract<AgyParse, { kind: "result" }>,
    rawLine: string
  ): void {
    if (this.fsm.state !== "turn_active") {
      // One line is one turn, so a result with no open turn breaks the
      // stream's grammar — tier 2, raw preserved.
      this.emit(buildUnknownEvent(++this.seq, this.sessionIdOrEmpty(), rawLine));
      this.emitError(true, "harness", "a result arrived with no open turn");
      void this.finish("crash", 1);
      return;
    }
    if (parse.conversationId !== null) this.harnessConfirmed = true;
    if (parse.conversationId !== null && this.conversationId === null) {
      // The first identity-bearing fact of a fresh session: adopt it,
      // record, and only now tell the caller the session exists. The
      // guard is `settled`, not `finished`: even when the end path is
      // already draining, this result still completes its own turn.
      this.conversationId = parse.conversationId;
      this.announceSessionStarted();
      if (this.settled) return;
    }
    const turnId = this.fsm.activeTurn;
    if (parse.responseText !== null) {
      this.emit(
        buildEvent(++this.seq, this.sessionIdOrEmpty(), "assistant_message", rawLine, {
          text: parse.responseText,
          turn_id: turnId,
        })
      );
    }
    // No standalone `usage` event: `usage_stream` is honestly false —
    // usage rides only the per-turn `turn_completed` (and the session
    // cumulative on `session_ended`), the same contract claude/zai ship.
    const error = this.fsm.transition({
      kind: "turn_completed",
      turnId: turnId ?? "none",
    });
    if (error !== null) {
      this.emitError(true, "harness", error.message);
      void this.finish("crash", 1);
      return;
    }
    // The shared fold (usage.ts): agy's envelope carries no cost, so
    // this is the uniform rule, not an agy behavior (review live8).
    this.cumulative = addTurnUsage(this.cumulative, parse.usage);
    const reason =
      parse.errorText !== null
        ? `status "${parse.status}": ${parse.errorText}`
        : `status "${parse.status}"`;
    this.emit(
      buildEvent(++this.seq, this.sessionIdOrEmpty(), "turn_completed", rawLine, {
        turn_id: turnId,
        finish: parse.isError ? "failed" : "end",
        ...(parse.isError ? { reason } : {}),
        usage: parse.usage,
      })
    );
    // The ledger's turn record mirrors the event the caller just saw
    // (call-log.ts); agy's usage carries no cost, so this is the event's
    // own block verbatim.
    appendSessionTurnCallRecord(
      this.callLedger,
      this.ledgerSessionId(),
      turnId ?? "none",
      this.turnStartedAt.get(turnId ?? "") ?? Date.now(),
      parse.isError ? "failed" : "end",
      parse.usage
    );
    this.turnStartedAt.delete(turnId ?? "");
    if (this.registryRecorded && this.options.registryPath !== null) {
      // Best-effort stamp, and never a wait: the lock's retry sleep is a
      // synchronous Atomics.wait on the main thread, and this runs inside
      // harness-line handling on every turn — waiting behind another
      // codemux process's write would freeze stdout reads, caller events
      // and signal handlers for the lock's full budget (~10 s), so the
      // stamp takes a single-attempt lock: one sweep, fail fast (review
      // live13). A failed stamp costs pruning freshness, not correctness
      // (the owner-liveness guard carries the real safety), and the first
      // failure says so once on stderr — silently swallowing it was the
      // live13 defect.
      const outcome = touchSession(this.options.registryPath, this.conversationId ?? "", {
        attempts: 1,
      });
      if (!outcome.ok && !this.touchWarned) {
        this.touchWarned = true;
        console.error(
          `codemux: cannot stamp the session registry for ${this.conversationId} ` +
            `(${outcome.error}); activity tracking may lag`
        );
      }
    }
    if (parse.conversationId === null && this.conversationId === null) {
      // The auth-failure shape the fixture pinned: a first result that
      // names no conversation leaves the session untrackable, and an
      // untracked live session must not run (§4.8). The turn's events
      // went out above; now the session ends.
      this.emitError(
        true,
        "harness",
        "the first result named no conversation id, " +
          "so the session cannot be recorded in the registry"
      );
      void this.finish("crash", 1);
    }
  }

  /** Assign the next codemux turn id and open it in the FSM. */
  private submitTurn(): string | null {
    this.turnCounter += 1;
    const turnId = `t${this.turnCounter}`;
    const error = this.fsm.transition({ kind: "turn_started", turnId });
    if (error !== null) {
      this.emitError(true, "harness", error.message);
      void this.finish("crash", 1);
      return null;
    }
    this.emit(
      buildEvent(++this.seq, this.sessionIdOrEmpty(), "turn_started", null, {
        turn_id: turnId,
      })
    );
    this.turnStartedAt.set(turnId, Date.now());
    return turnId;
  }
}
