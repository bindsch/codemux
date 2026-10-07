/**
 * The session lifecycle state machine (design §4.6): starting → idle ⇄
 * turn_active → shutting_down → ended, with the pending-permission-request
 * set and the monotonic `input_seq` counter living alongside it.
 *
 * The FSM never talks to a process. Drivers feed it transitions; a
 * transition the grammar does not allow returns an error instead of
 * throwing, and the driver turns that into a fatal harness error ending
 * the session. Every tier-2 refusal of a harness line mirrors the line
 * as an `unknown` event first, then the fatal: a parse-level violation
 * (a foreign session id, a second thread announcement) and an FSM
 * violation the driver detected (a turn terminal with no open turn, a
 * duplicate permission id) alike. Review live21 unified the two; the
 * FSM-detected half used to emit only the fatal, which hid a refused
 * resume's own result from the caller. Keeping the verdict as a value is
 * what lets the refusal path stay uniform across harnesses.
 */

export type SessionState =
  | "starting"
  | "idle"
  | "turn_active"
  | "shutting_down"
  | "ended";

export type FsmEvent =
  | { kind: "session_started" }
  | { kind: "turn_started"; turnId: string }
  | { kind: "turn_completed"; turnId: string }
  | { kind: "shutdown_started" }
  | { kind: "ended" };

export interface FsmError {
  /** The grammar rule that was violated, for the fatal error's message. */
  message: string;
}

export class SessionFsm {
  private stateInternal: SessionState = "starting";
  private activeTurnId: string | null = null;
  private inputSeqCounter = 0;
  private readonly pendingRequests = new Set<string>();

  get state(): SessionState {
    return this.stateInternal;
  }

  get activeTurn(): string | null {
    return this.activeTurnId;
  }

  /** Next codemux-assigned monotonic input sequence number. */
  nextInputSeq(): number {
    this.inputSeqCounter += 1;
    return this.inputSeqCounter;
  }

  isPending(requestId: string): boolean {
    return this.pendingRequests.has(requestId);
  }

  get pendingIds(): string[] {
    return [...this.pendingRequests];
  }

  /** Track a new permission request. A duplicate id is a grammar
   * violation: pending requests are a set keyed by the harness's own id,
   * and a harness reusing one mid-flight has broken its contract. */
  addPending(requestId: string): FsmError | null {
    if (this.pendingRequests.has(requestId)) {
      return { message: `duplicate permission request id ${requestId}` };
    }
    this.pendingRequests.add(requestId);
    return null;
  }

  /** Remove a resolved request. Absent means unknown, late, or already
   * resolved — the caller's decision cannot be applied. */
  removePending(requestId: string): FsmError | null {
    if (!this.pendingRequests.delete(requestId)) {
      return { message: `permission request ${requestId} is not pending` };
    }
    return null;
  }

  /** Clear every pending request, returning their ids so each can be
   * reported resolved (`superseded`) — the every-end-path rule (§4.6). */
  supersedePending(): string[] {
    const ids = [...this.pendingRequests];
    this.pendingRequests.clear();
    return ids;
  }

  /**
   * Apply one transition. Returns an error when the grammar forbids it
   * (tier-2), `null` when it applied. `shutdown_started` while already
   * shutting down and `ended` from the ended state are idempotent no-ops:
   * end paths can race (a signal during harness-driven shutdown), and
   * re-running them is safe where re-running a turn transition is not.
   */
  transition(event: FsmEvent): FsmError | null {
    switch (event.kind) {
      case "session_started":
        if (this.stateInternal === "idle") {
          return { message: "second session_started" };
        }
        if (this.stateInternal !== "starting") {
          return { message: `session_started in state ${this.stateInternal}` };
        }
        this.stateInternal = "idle";
        return null;
      case "turn_started":
        if (this.stateInternal === "turn_active") {
          return {
            message: `turn ${event.turnId} started while turn ${this.activeTurnId} is active`,
          };
        }
        if (this.stateInternal !== "idle") {
          return { message: `turn_started in state ${this.stateInternal}` };
        }
        this.stateInternal = "turn_active";
        this.activeTurnId = event.turnId;
        return null;
      case "turn_completed":
        if (this.stateInternal !== "turn_active") {
          return {
            message: `turn ${event.turnId} completed in state ${this.stateInternal} (no open turn)`,
          };
        }
        if (event.turnId !== this.activeTurnId) {
          return {
            message: `turn ${event.turnId} completed but the open turn is ${this.activeTurnId}`,
          };
        }
        this.stateInternal = "idle";
        this.activeTurnId = null;
        return null;
      case "shutdown_started":
        if (this.stateInternal === "shutting_down") return null;
        if (this.stateInternal === "ended") {
          return { message: "shutdown_started after the session ended" };
        }
        this.stateInternal = "shutting_down";
        this.activeTurnId = null;
        return null;
      case "ended":
        if (this.stateInternal === "ended") return null;
        this.stateInternal = "ended";
        this.activeTurnId = null;
        return null;
    }
  }
}
