/**
 * The turn/start scenarios that answer the request themselves (a refusal,
 * a bare response) instead of letting releaseTurnStart answer it, split
 * from fake-codex-app-server.ts at the 500-line cap: the scenario switch
 * in that file runs only after the response, so these arms cannot live in
 * scenarios.ts. Returns true when the scenario was handled.
 */
import { THREAD_ID, notify, respond, respondError, state } from "./wire.js";
import { usage } from "./items.js";

/** Refuse the policy-sensitive scenarios before they can fabricate an ask.
 * Codex 0.166.0 asks for patches under on-request + read-only (upstream
 * core/src/safety.rs); an unrestricted file sandbox would auto-approve. */
export function checkApprovalPolicy(method: string, id: unknown, params: Record<string, unknown>): boolean {
  if (process.env.FAKE_REQUIRE_ASKING_POLICY !== "1") return true;
  if (!["thread/start", "thread/resume", "turn/start"].includes(method)) return true;
  const sandbox = params["sandboxPolicy"] as Record<string, unknown> | undefined;
  const readOnly = method === "turn/start" ? sandbox?.["type"] === "readOnly" : params["sandbox"] === "read-only";
  if (params["approvalPolicy"] === "on-request" && readOnly) return true;
  respondError(id, "the approval fixture requires on-request with native read-only access");
  return false;
}

export function startArm(scenario: string, turnId: string, id: unknown): boolean {
  if (scenario === "failstart") {
    respondError(id, "the turn was refused");
    return true;
  }
  if (scenario === "usagefailstart") {
    notify("thread/tokenUsage/updated", {
      threadId: THREAD_ID,
      turnId,
      tokenUsage: { total: usage(400, 0, 0, 13), last: usage(400, 0, 0, 13), modelContextWindow: 258400 },
    });
    respondError(id, "the turn was refused");
    return true;
  }
  if (scenario === "noturnid") {
    respond(id, { turn: { items: [], status: "inProgress" } });
    return true;
  }
  if (scenario === "failstartlaggard") {
    // A scoped notification names the provisional id while the turn/start
    // response is still in flight, then the response refuses the turn
    // (review round 401, item 3): the failed turn's provisional id must
    // be adopted as closed. The laggard pair below replays after the next
    // turn is named, naming this refused turn's id.
    notify("item/agentMessage/delta", { threadId: THREAD_ID, turnId, itemId: "m-failstart", delta: "early" });
    state.laggardTurnId = turnId;
    state.laggardSkip = 0;
    respondError(id, "the turn was refused");
    return true;
  }
  return false;
}
