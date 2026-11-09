/**
 * The codex driver's approval plumbing: the pending-approval table, the
 * expiry timers, caller decisions, and the decline/accept answers per
 * method. src/session/codex-driver.ts owns the lifecycle.
 */

import {
  buildJsonRpcResponse,
  codexApprovalCeiling,
  pickApprovalDecision,
  type CodexApprovalKind,
  type RequestId,
} from "./codex-session.js";
import { buildPermissionResolved, type InputMessage } from "./protocol.js";
import { CodexDriverLedger } from "./codex-ledger.js";

export abstract class CodexDriverApprovals extends CodexDriverLedger {
  /** The approval facts the ceiling judges; membership lives in the FSM.
   * The wire id keeps its original type — numeric ids must be answered
   * numerically for the server to correlate the reply (JSON-RPC). */
  protected readonly pendingApprovals = new Map<
    string,
    { id: RequestId; kind: CodexApprovalKind; input: Record<string, unknown> }
  >();

  protected expireApproval(requestId: string): void {
    if (this.finished || !this.fsm.isPending(requestId)) return;
    const approval = this.pendingApprovals.get(requestId);
    const method =
      approval === undefined
        ? "item/commandExecution/requestApproval"
        : approvalMethod(approval.kind);
    const available = approval === undefined ? undefined : approval.input["availableDecisions"];
    // The wire id keeps its type: numeric ids are answered numerically.
    this.writeToHarness(
      this.approvalDecline(approval === undefined ? requestId : approval.id, method, available ?? null)
    );
    this.resolvePending(requestId, "timeout");
  }

  protected applyPermissionDecision(
    inputSeq: number,
    message: Extract<InputMessage, { type: "permission_decision" }>
  ): void {
    const approval = this.pendingApprovals.get(message.request_id);
    if (approval === undefined) {
      this.ack(inputSeq, false, "unknown_request");
      return;
    }
    if (message.updated_input !== undefined || message.message !== undefined) {
      // Codex approvals carry no updated-input channel and no denial-text
      // channel codemux has verified (§4.1): the request stays pending
      // for a plain decision.
      this.ack(inputSeq, false, "unsupported");
      return;
    }
    if (message.decision === "deny") {
      const delivered = this.writeToHarness(
        this.approvalDecline(
          approval.id,
          approvalMethod(approval.kind),
          approval.input["availableDecisions"]
        )
      );
      if (!delivered) {
        this.rejectUndelivered(inputSeq);
        return;
      }
      this.resolvePending(message.request_id, "deny");
      this.ack(inputSeq, true);
      return;
    }
    const verdict = codexApprovalCeiling(
      this.options.autonomy,
      approval.kind,
      approval.input,
      this.options.cwd
    );
    if (!verdict.allowable) {
      this.writeToHarness(
        this.approvalDecline(
          approval.id,
          approvalMethod(approval.kind),
          approval.input["availableDecisions"]
        )
      );
      this.resolvePending(message.request_id, "deny");
      this.ack(inputSeq, false, "autonomy_escalation");
      return;
    }
    if (!this.allowDeliverable(approval.kind, approval.input)) {
      // An approval whose availableDecisions omit "accept" — for example
      // ["acceptForSession","decline"]: the wire answer approvalAccept
      // builds would substitute decline (pickApprovalDecision's rule)
      // while the caller was told allow and the ack said accepted — a
      // success reported on a failure path (review live15). codemux never
      // answers acceptForSession (a per-request refusal is the pinned
      // rule, approvalDecline's comment), so allow is undeliverable: the
      // honest outcome is deny on the wire, deny in permission_resolved,
      // and a rejected ack naming what the caller asked for.
      this.writeToHarness(
        this.approvalDecline(
          approval.id,
          approvalMethod(approval.kind),
          approval.input["availableDecisions"]
        )
      );
      this.resolvePending(message.request_id, "deny");
      this.ack(inputSeq, false, "unsupported");
      this.emitError(
        false,
        "harness",
        "the approval offered no accept decision; the allow was answered deny"
      );
      return;
    }
    if (!this.writeToHarness(this.approvalAccept(approval.id, approval.kind, approval.input))) {
      this.rejectUndelivered(inputSeq);
      return;
    }
    this.resolvePending(message.request_id, "allow");
    this.ack(inputSeq, true);
  }

  /** A decision whose answer never reached the harness: the refused
   * write already started the crash end, which superseded the approval,
   * so the decision is rejected `shutting_down` rather than acked as
   * accepted (review live20). The ceiling and undeliverable-allow paths
   * reject the decision on their own reason either way. */
  protected rejectUndelivered(inputSeq: number): void {
    this.ack(inputSeq, false, "shutting_down");
  }

  /** Whether an allow answer can actually reach the harness as an
   * accept: commandExecution approvals carry the wire's own
   * availableDecisions, and codemux refuses acceptForSession — the one
   * surviving spelling of accept in a list without plain "accept" — so
   * such a request advertises deny as its only option (review live15).
   * fileChange and permissions answers are pinned shapes with no
   * decision list, so allow is always deliverable there. */
  protected allowDeliverable(
    kind: CodexApprovalKind,
    input: Record<string, unknown>
  ): boolean {
    if (kind !== "commandExecution") return true;
    return pickApprovalDecision(input["availableDecisions"], "accept") === "accept";
  }

  /** The decline answer for one approval request id, per method (§4.7):
   * never `acceptForSession`, always a per-request refusal. */
  protected approvalDecline(
    id: number | string,
    method: string,
    available: unknown
  ): string {
    if (method === "item/fileChange/requestApproval") {
      return buildJsonRpcResponse(id, { decision: "decline" });
    }
    if (method === "item/permissions/requestApproval") {
      return buildJsonRpcResponse(id, { permissions: {}, scope: "turn" });
    }
    return buildJsonRpcResponse(id, {
      decision: pickApprovalDecision(available, "decline"),
    });
  }

  /** The allow answer, per method: the ceiling has already cleared it. */
  private approvalAccept(
    id: number | string,
    kind: CodexApprovalKind,
    input: Record<string, unknown>
  ): string {
    if (kind === "fileChange") {
      return buildJsonRpcResponse(id, { decision: "accept" });
    }
    if (kind === "permissions") {
      return buildJsonRpcResponse(id, {
        permissions: echoPermissions(input),
        scope: "turn",
      });
    }
    return buildJsonRpcResponse(id, {
      decision: pickApprovalDecision(input["availableDecisions"], "accept"),
    });
  }

  private resolvePending(
    requestId: string,
    resolution: "allow" | "deny" | "timeout" | "superseded"
  ): void {
    const timer = this.pendingTimers.get(requestId);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.pendingTimers.delete(requestId);
    }
    this.pendingApprovals.delete(requestId);
    const error = this.fsm.removePending(requestId);
    if (error !== null) return; // Raced with another resolution path.
    this.emit(
      buildPermissionResolved(
        ++this.seq,
        this.sessionIdOrEmpty(),
        requestId,
        resolution
      )
    );
  }

  // --- end path ----------------------------------------------------------

  /** Answer every pending approval decline and emit `superseded` (§4.1):
   * turn completion, turn-start failure, interrupt, `--turn-timeout`, and
   * every end path close the permission channel first — a request whose
   * turn is closing must not keep a timer running against a session that
   * moved on. The pinned decline payload carries no reason field, so the
   * caller hears why from the interrupt/timeout/end events themselves. */
  protected supersedeApprovals(): void {
    for (const requestId of this.fsm.supersedePending()) {
      const approval = this.pendingApprovals.get(requestId);
      this.writeToHarness(
        this.approvalDecline(
          approval === undefined ? requestId : approval.id,
          approval === undefined
            ? "item/commandExecution/requestApproval"
            : approvalMethod(approval.kind),
          approval === undefined ? null : approval.input["availableDecisions"]
        )
      );
      const timer = this.pendingTimers.get(requestId);
      if (timer !== undefined) clearTimeout(timer);
      this.pendingTimers.delete(requestId);
      this.pendingApprovals.delete(requestId);
      this.emit(
        buildPermissionResolved(
          ++this.seq,
          this.sessionIdOrEmpty(),
          requestId,
          "superseded"
        )
      );
    }
  }

}

export function approvalMethod(kind: CodexApprovalKind): string {
  switch (kind) {
    case "commandExecution":
      return "item/commandExecution/requestApproval";
    case "fileChange":
      return "item/fileChange/requestApproval";
    case "permissions":
      return "item/permissions/requestApproval";
  }
}

/** Echo the permission grant subset the request asked for (§4.7): the
 * turn-scoped answer restates what was requested, no more. */
function echoPermissions(input: Record<string, unknown>): Record<string, unknown> {
  const requested = input["permissions"];
  const echoed: Record<string, unknown> = {};
  if (typeof requested === "object" && requested !== null && !Array.isArray(requested)) {
    const record = requested as Record<string, unknown>;
    if ("network" in record) echoed["network"] = record["network"];
    if ("fileSystem" in record) echoed["fileSystem"] = record["fileSystem"];
  }
  return echoed;
}
