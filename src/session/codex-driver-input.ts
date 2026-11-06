/**
 * The codex driver's caller-side input handling: one framed stdin line
 * dispatched per message type, the stdin end, and the bounds on held
 * caller input. src/session/codex-driver.ts owns the lifecycle.
 */

import {
  callerStdinFailure,
  harnessTextDeliverable,
  MAX_PENDING_EVENT_BYTES,
  MAX_PENDING_EVENTS,
} from "./process.js";
import {
  applyAuthorPrefix,
  buildUserMessage,
  parseInputLine,
} from "./protocol.js";
import { CodexDriverEvents } from "./codex-driver-events.js";

/** Bounds on each in-memory hold of caller input (review live19): the
 * lines parked behind the handshake, the user inputs queued behind an
 * open turn, and the steer texts held until the harness names its turn.
 * A quarter of the outbound queue's count: the replay or the end path
 * answers the whole parked buffer in one synchronous burst of up to
 * three events per line, which must fit the queue rather than overflow
 * it. */
export const MAX_HELD_INPUT_LINES = MAX_PENDING_EVENTS / 4;
export const MAX_HELD_INPUT_BYTES = MAX_PENDING_EVENT_BYTES / 2;

/** Whether one more text fits a hold under both bounds. */
function heldInputFits(held: readonly string[], next: string): boolean {
  if (held.length >= MAX_HELD_INPUT_LINES) return false;
  let bytes = Buffer.byteLength(next);
  for (const text of held) bytes += Buffer.byteLength(text);
  return bytes <= MAX_HELD_INPUT_BYTES;
}

export abstract class CodexDriverInput extends CodexDriverEvents {

  private stdinClosed = false;

  /** One framed line from the caller's stdin. Never throws. */
  override handleCallerLine(line: string): void {
    if (line.trim() === "") return;
    if (this.finished) {
      // The input contract (§4.1): every line is answered, an end path
      // included — during the drain window (`finished` and not yet
      // `settled`) the answer is the `shutting_down` rejection (review
      // live9; a repeated shutdown during the drain is the same honest
      // no-op notification). Once `settled`, `session_ended` is already
      // on the stream and nothing may follow it, so later lines drop.
      if (!this.settled) this.ack(this.fsm.nextInputSeq(), false, "shutting_down");
      return;
    }
    // Before session_started nothing can be answered: a fresh thread's id
    // may be known from the response while the session event has not
    // fired, and a turn submitted then would break the FSM's grammar.
    // Buffer the line whole and replay it once session_started fires —
    // except shutdown: a stalled handshake must not hold the graceful end
    // hostage (an initialize that never answers has no session to keep).
    if (this.fsm.state === "starting") {
      const early = parseInputLine(line, {
        capabilities: this.capabilities,
        hasActiveTurn: false,
        pendingRequestIds: new Set(this.fsm.pendingIds),
        shuttingDown: this.stdinClosed,
      });
      if (early.ok && early.message.type === "shutdown") {
        // Parked lines are rejected first, in arrival order (review
        // live14): the acks must not reorder around the shutdown's, or a
        // broker matching them by order reads the earlier user line's
        // rejection as the shutdown's answer. finish() drains the same
        // buffer the same way, so the pair stays idempotent.
        while (this.preSessionLines.length > 0) {
          this.preSessionLines.shift();
          this.ack(this.fsm.nextInputSeq(), false, "shutting_down");
        }
        this.preSessionBytes = 0;
        this.ack(this.fsm.nextInputSeq(), true);
        void this.finish("shutdown", 0);
        return;
      }
      // The seq is assigned at replay, so the peek above must not count.
      this.preSessionLines.push(line);
      this.preSessionBytes += Buffer.byteLength(line);
      if (
        this.preSessionLines.length > MAX_HELD_INPUT_LINES ||
        this.preSessionBytes > MAX_HELD_INPUT_BYTES
      ) {
        // Over the bound, the session ends: rejecting this one line now
        // would give it an input_seq ahead of the parked lines it follows.
        // finish() rejects every parked line, this one included, in order.
        this.emitError(
          true,
          "codemux",
          `the caller sent more than ${MAX_HELD_INPUT_LINES} lines or ${MAX_HELD_INPUT_BYTES} bytes ` +
            "before the codex handshake completed"
        );
        void this.finish("crash", 1);
      }
      return;
    }
    const inputSeq = this.fsm.nextInputSeq();
    const parsed = parseInputLine(line, {
      capabilities: this.capabilities,
      hasActiveTurn: this.fsm.state === "turn_active",
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
        const harnessText = applyAuthorPrefix(
          message.text,
          message.author,
          this.options.authorPrefix
        );
        // Deliverability before the ack: the turn/start frame cannot be
        // built yet (the JSON-RPC id and thread id are assigned at send
        // time), so the check is the escaped literal plus a conservative
        // wrapper margin against the harness write cap.
        if (!harnessTextDeliverable(harnessText)) {
          this.ack(inputSeq, false, "text_too_long");
          return;
        }
        if (
          this.fsm.state !== "idle" &&
          !heldInputFits(this.turnQueue.map((entry) => entry.text), harnessText)
        ) {
          // The queue behind an open turn is bounded (review live19).
          this.ack(inputSeq, false, "busy");
          return;
        }
        this.ack(inputSeq, true);
        // The acknowledgement itself can be the event that breaches the
        // outbound bound and ends the session. The end path then recorded
        // that no turn was open, so no turn may open after it (review
        // round 155).
        if (this.finished) return;
        const turnId = this.fsm.state === "idle" ? this.submitTurn() : null;
        if (turnId === null) this.queuedInputs += 1;
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
        // No turn work after the driver finished (review round 153): an
        // outbound bound breached inside the emits above ends the session
        // synchronously, and the end path owns the child and its stdin
        // from that moment — the turn's frame is never written, and a
        // queued one never drains (drainTurnQueue checks `finished`).
        if (this.finished) return;
        if (turnId !== null) {
          this.sendTurnStart(turnId, harnessText);
        } else {
          this.turnQueue.push({ text: harnessText, inputSeq });
        }
        return;
      }
      case "steer": {
        const harnessText = applyAuthorPrefix(
          message.text,
          message.author,
          this.options.authorPrefix
        );
        // Same pre-ack deliverability check (the steer frame carries the
        // escaped literal under the same write cap).
        if (!harnessTextDeliverable(harnessText)) {
          this.ack(inputSeq, false, "text_too_long");
          return;
        }
        if (
          this.harnessTurnId === null &&
          !heldInputFits(this.steerBuffer.map((entry) => entry.text), harnessText)
        ) {
          // Held until the harness names its turn, and bounded (review
          // live19).
          this.ack(inputSeq, false, "busy");
          return;
        }
        // Steer input is live mid-turn input, delivered as one batched
        // steer request. With the harness turn named it is written now,
        // before the ack: a refused write started the crash end, and the
        // line is rejected rather than acked for text the harness never
        // got (review live23). Otherwise it waits for the turn/start
        // response, and a later failure is reported by its input_seq.
        this.steerBuffer.push({ text: harnessText, inputSeq });
        this.flushSteer(inputSeq);
        if (this.finished) {
          this.rejectUndelivered(inputSeq);
          return;
        }
        this.ack(inputSeq, true);
        this.emit(
          buildUserMessage(
            ++this.seq,
            this.sessionIdOrEmpty(),
            inputSeq,
            message.text,
            message.author,
            this.fsm.activeTurn
          )
        );
        return;
      }
      case "interrupt": {
        // No active turn: an acknowledged no-op (§4.1).
        if (this.fsm.state !== "turn_active") {
          this.ack(inputSeq, true);
          return;
        }
        // §4.1: a pending approval is answered decline on interrupt,
        // before the turn closes (permission_resolved: "superseded").
        // The interrupt is written before the ack: a refused write
        // started the crash end, and an accepted ack would report an
        // interrupt the harness never got (review live23).
        // A refused decline above already started the end, whose own
        // interrupt must stay the pending one, so nothing more is written.
        this.supersedeApprovals();
        if (!this.finished) this.sendInterrupt();
        if (this.finished) {
          this.rejectUndelivered(inputSeq);
          return;
        }
        if (this.interruptQueued) this.interruptQueuedSeq = inputSeq;
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
}
