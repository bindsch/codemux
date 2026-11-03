/**
 * The claude-family driver's permission round-trip: pending permission
 * requests, caller decisions with the ceiling, expiry timers, and the
 * supersede-deny every turn-closing path applies.
 * src/session/driver.ts owns the lifecycle.
 */

import { claudeCeiling } from "./ceiling.js";
import { buildControlResponse, DEFAULT_DENIAL_MESSAGE } from "./claude-session.js";
import { harnessLineDeliverable } from "./process.js";
import { buildPermissionResolved, type InputMessage } from "./protocol.js";
import { ClaudeDriverLedger } from "./driver-ledger.js";

export abstract class ClaudeDriverPermissions extends ClaudeDriverLedger {

  /** The request facts the ceiling judges; membership lives in the FSM. */
  protected readonly pendingRequests = new Map<
    string,
    { tool: string; input: Record<string, unknown> }
  >();

  protected expirePermission(requestId: string): void {
    if (this.finished || !this.fsm.isPending(requestId)) return;
    this.writeToHarness(buildControlResponse(requestId, "deny"));
    this.resolvePending(requestId, "timeout", DEFAULT_DENIAL_MESSAGE);
  }

  protected applyPermissionDecision(
    inputSeq: number,
    message: Extract<InputMessage, { type: "permission_decision" }>
  ): void {
    const request = this.pendingRequests.get(message.request_id);
    if (request === undefined) {
      this.ack(inputSeq, false, "unknown_request");
      return;
    }
    if (message.decision === "allow") {
      // The ceiling judges the action that will actually run: the
      // substituted arguments when the answer carries them (§4.1). The
      // same object is what the allow sends: the harness runs the tool
      // with the answer's `updatedInput`, so a plain allow carries the
      // request's own input (review live18).
      const effective = message.updated_input ?? request.input;
      const verdict = claudeCeiling(
        this.options.autonomy,
        request.tool,
        effective,
        this.options.cwd
      );
      if (!verdict.allowable) {
        // The deny carries the default denial text — the agent sees its
        // own harness's rejection — and the caller's permission_resolved
        // event carries the same text; the ack's reason,
        // `autonomy_escalation`, is the one place the ceiling is named.
        this.writeToHarness(buildControlResponse(message.request_id, "deny"));
        this.resolvePending(message.request_id, "deny", DEFAULT_DENIAL_MESSAGE);
        this.ack(inputSeq, false, "autonomy_escalation", DEFAULT_DENIAL_MESSAGE);
        return;
      }
      const answer = buildControlResponse(message.request_id, "allow", effective);
      if (!harnessLineDeliverable(answer)) {
        // An `updated_input` too large for the harness write cap cannot be
        // delivered; acking it would report an answer the write then
        // refuses, crashing the session (review live18). The request stays
        // pending, so the caller can answer again within the bound.
        this.ack(inputSeq, false, "text_too_long");
        return;
      }
      if (!this.writeToHarness(answer)) {
        this.rejectUndelivered(inputSeq);
        return;
      }
      this.resolvePending(message.request_id, "allow");
      this.ack(inputSeq, true);
      return;
    }
    // A caller deny rides its own message when it carries one, and the
    // default denial text otherwise — the harness shows the model
    // exactly that string as the rejection.
    const denial = message.message ?? DEFAULT_DENIAL_MESSAGE;
    if (!this.writeToHarness(buildControlResponse(message.request_id, "deny", undefined, denial))) {
      this.rejectUndelivered(inputSeq);
      return;
    }
    this.resolvePending(message.request_id, "deny", denial);
    this.ack(inputSeq, true);
  }

  /** A decision whose answer never reached the harness: the refused
   * write already started the crash end, which superseded the request,
   * so the decision is rejected `shutting_down` rather than acked as
   * accepted (review live20). */
  protected rejectUndelivered(inputSeq: number): void {
    this.ack(inputSeq, false, "shutting_down");
  }

  private resolvePending(
    requestId: string,
    resolution: "allow" | "deny" | "timeout" | "superseded",
    message?: string
  ): void {
    const timer = this.pendingTimers.get(requestId);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.pendingTimers.delete(requestId);
    }
    this.pendingRequests.delete(requestId);
    const error = this.fsm.removePending(requestId);
    if (error !== null) return; // Raced with another resolution path.
    this.emit(
      buildPermissionResolved(
        ++this.seq,
        this.options.sessionId,
        requestId,
        resolution,
        message
      )
    );
  }

  /** Answer every pending request deny and emit `superseded` (§4.1): turn
   * completion, interrupt, `--turn-timeout`, and every end path close the
   * permission channel first — a request whose turn is closing must not
   * keep a timer running against a session that moved on. Every answer
   * carries the default denial text: whatever closed the turn, the agent
   * reads its own harness's rejection. */
  protected supersedePendingDeny(): void {
    for (const requestId of this.fsm.supersedePending()) {
      this.writeToHarness(buildControlResponse(requestId, "deny"));
      const timer = this.pendingTimers.get(requestId);
      if (timer !== undefined) clearTimeout(timer);
      this.pendingTimers.delete(requestId);
      this.pendingRequests.delete(requestId);
      this.emit(
        buildPermissionResolved(
          ++this.seq,
          this.options.sessionId,
          requestId,
          "superseded",
          DEFAULT_DENIAL_MESSAGE
        )
      );
    }
  }
}
