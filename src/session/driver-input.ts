/**
 * The claude-family driver's caller-stdin side: one framed input line
 * parsed, acked, and dispatched (handleCallerLine), and the stdin-close
 * end it feeds (handleCallerEnd). src/session/driver.ts owns the
 * lifecycle.
 */

import { buildHarnessUserMessage } from "./claude-session.js";
import { callerStdinFailure, harnessLineDeliverable } from "./process.js";
import { applyAuthorPrefix, buildUserMessage, parseInputLine } from "./protocol.js";
import { ClaudeDriverEvents } from "./driver-events.js";

export abstract class ClaudeDriverInput extends ClaudeDriverEvents {

  /** One framed line from the caller's stdin. Never throws. */
  handleCallerLine(line: string): void {
    if (line.trim() === "") return;
    if (this.finished) {
      // The input contract (§4.1): every line is answered, an end path
      // included — during the drain window (`finished` and not yet
      // `settled`) the answer is the `shutting_down` rejection, the same
      // reason the protocol layer's gate specifies (review live9: the
      // gate was unreachable dead code while this guard dropped lines
      // unacknowledged). Once `settled`, `session_ended` is already on
      // the stream and nothing may follow it, so later lines are dropped.
      if (!this.settled) this.ack(this.fsm.nextInputSeq(), false, "shutting_down");
      return;
    }
    const inputSeq = this.fsm.nextInputSeq();
    const parsed = parseInputLine(line, {
      capabilities: this.capabilities,
      hasActiveTurn: this.fsm.state === "turn_active" || this.openerPending,
      pendingRequestIds: new Set(this.fsm.pendingIds),
      shuttingDown: this.stdinClosed || this.fsm.state === "shutting_down" || this.fsm.state === "ended",
    });
    if (!parsed.ok) {
      this.ack(inputSeq, false, parsed.reason);
      return;
    }
    const message = parsed.message;
    switch (message.type) {
      case "user": {
        // `steer` never reaches this arm (the claude-family capability is
        // false, rejected `unsupported` above), and neither does a `user`
        // line while a turn runs (`user_during_turn: false`, rejected
        // `busy`): every line here opens a turn, now or at init.
        const harnessText = applyAuthorPrefix(
          message.text,
          message.author,
          this.options.authorPrefix
        );
        const harnessLine = buildHarnessUserMessage(harnessText);
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
        // The acknowledgement itself can be the event that breaches the
        // outbound bound and ends the session. The end path then recorded
        // that no turn was open, so no turn may open after it (review
        // round 155).
        if (this.finished) return;
        const turnId = this.fsm.state === "idle" ? this.startTurn() : null;
        this.emit(
          buildUserMessage(
            ++this.seq,
            this.options.sessionId,
            inputSeq,
            message.text,
            message.author,
            turnId
          )
        );
        // No turn work after the driver finished (review round 153): an
        // outbound bound breached inside the emits above ends the session
        // synchronously — the queue's failure callback runs finish, which
        // sets `finished` before its first await — and the end path owns
        // the child and its stdin from that moment, so the turn's line is
        // never written into a closing session.
        if (this.finished) return;
        // Set only now, with the write that makes it true (review round
        // 156): the end path reads this flag as "a pre-init line was
        // already forwarded", so an end that began inside the echo above
        // must not see it for a line that was never written.
        if (turnId === null) this.openerPending = true;
        this.writeToHarness(harnessLine);
        return;
      }
      case "interrupt": {
        if (this.fsm.state === "starting" && this.openerPending) {
          // A `user` line was already forwarded, so the harness runs that
          // turn as soon as it starts; the turn opens codemux-side with the
          // init frame, and the interrupt rides that moment.
          this.ack(inputSeq, true);
          this.interruptBeforeInit = true;
          this.interruptBeforeInitSeq = inputSeq;
          return;
        }
        // No active turn: an acknowledged no-op (§4.1).
        if (this.fsm.state !== "turn_active") {
          this.ack(inputSeq, true);
          return;
        }
        // §4.1: a pending request is answered deny on interrupt, before
        // the turn closes (permission_resolved: "superseded") — it must
        // not keep a timer running against a turn that is ending.
        this.supersedePendingDeny();
        // Written before the ack: a refused write started the crash end,
        // and an accepted ack would report an interrupt the harness never
        // got (review live23, the codex sibling's finding). A refused
        // deny above already started that end, whose own interrupt must
        // stay the pending one, so nothing more is written.
        if (!this.finished) this.sendInterrupt();
        if (this.finished) {
          this.rejectUndelivered(inputSeq);
          return;
        }
        this.ack(inputSeq, true);
        return;
      }
      case "permission_decision": {
        this.applyPermissionDecision(inputSeq, message);
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
   * reported and costs success (review live17 — it used to exit 0). */
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
}
