/**
 * The codex approval kinds beyond commandExecution (audit round 2, C-7):
 * `item/permissions/requestApproval` and `item/fileChange/requestApproval`
 * at the autonomy levels that decide them, with the exact JSON-RPC reply
 * each answer writes — the permissions replies carry an echoed grant (or an
 * empty object when declined), never a decision string — and the
 * `unknown_request` ack for a decision naming no pending approval.
 *
 * The ceiling (src/session/codex-session-approvals.ts): read-only allows
 * nothing; low allows everything, the only level where a turn-scoped
 * permission grant is deliverable; permissions deny at medium and high;
 * fileChange is full access at high. The fileChange-at-medium branch is
 * covered by tests/session-codex-e2e-approvals.test.ts.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { cleanupSessions, of, send, startAndWait, waitFor, waitForRecord } from "./session-codex-e2e-helpers.js";

afterAll(cleanupSessions);

describe("codex session e2e - permissions approvals", () => {
  test("a permissions allow at low autonomy echoes the grant turn-scoped", async () => {
    const session = await startAndWait({ autonomy: "low" });
    send(session.driver, { type: "user", text: "scenario:askperms grant" });
    const request = await waitFor(session.events, of("permission_request"), "permission_request");
    expect(request.tool).toBe("permissions");
    expect(request.input.permissions).toEqual({ network: true });
    expect(request.options).toEqual(["allow", "deny"]);
    send(session.driver, { type: "permission_decision", request_id: request.request_id, decision: "allow" });
    const resolved = await waitFor(session.events, of("permission_resolved"), "permission_resolved");
    expect(resolved.resolution).toBe("allow");
    await waitFor(session.events, of("turn_completed"), "turn_completed");
    // The exact reply bytes (§4.7): the accepted grant restates what was
    // requested, no more, scoped to the turn.
    const decisions = await waitForRecord(session, "decisions.jsonl");
    expect(decisions[0]!.id).toBe("appr-perm");
    expect(decisions[0]!.result).toEqual({ permissions: { network: true }, scope: "turn" });
    send(session.driver, { type: "shutdown" });
    expect(await session.code).toBe(0);
  });

  test("a permissions allow at read-only is an escalation answered an empty grant", async () => {
    const session = await startAndWait({ autonomy: "read-only" });
    send(session.driver, { type: "user", text: "scenario:askperms grant" });
    const request = await waitFor(session.events, of("permission_request"), "permission_request");
    send(session.driver, { type: "permission_decision", request_id: request.request_id, decision: "allow" });
    const rejected = await waitFor(
      session.events,
      (events) => events.find((event) => event.type === "input_rejected" && event.reason === "autonomy_escalation"),
      "the escalation rejection"
    );
    expect(rejected.input_seq).toBe(2);
    const resolved = await waitFor(session.events, of("permission_resolved"), "permission_resolved");
    expect(resolved.resolution).toBe("deny");
    await waitFor(session.events, of("turn_completed"), "turn_completed");
    // The decline spelling for permissions: an empty grant object, not a
    // decision string.
    const decisions = await waitForRecord(session, "decisions.jsonl");
    expect(decisions[0]!.result).toEqual({ permissions: {}, scope: "turn" });
    send(session.driver, { type: "shutdown" });
    expect(await session.code).toBe(0);
  });

  test("a permissions allow at high autonomy is denied the same way", async () => {
    // The default options run at high: the mapping grants no turn-scoped
    // permissions there either — low is the only delivering level.
    const session = await startAndWait();
    send(session.driver, { type: "user", text: "scenario:askperms grant" });
    const request = await waitFor(session.events, of("permission_request"), "permission_request");
    send(session.driver, { type: "permission_decision", request_id: request.request_id, decision: "allow" });
    await waitFor(
      session.events,
      (events) => events.find((event) => event.type === "input_rejected" && event.reason === "autonomy_escalation"),
      "the escalation rejection"
    );
    await waitFor(session.events, of("turn_completed"), "turn_completed");
    const decisions = await waitForRecord(session, "decisions.jsonl");
    expect(decisions[0]!.result).toEqual({ permissions: {}, scope: "turn" });
    send(session.driver, { type: "shutdown" });
    expect(await session.code).toBe(0);
  });

  test("a fileChange allow at high autonomy answers accept", async () => {
    const session = await startAndWait();
    send(session.driver, { type: "user", text: "scenario:askpatch patch" });
    const request = await waitFor(session.events, of("permission_request"), "permission_request");
    expect(request.tool).toBe("fileChange");
    send(session.driver, { type: "permission_decision", request_id: request.request_id, decision: "allow" });
    const resolved = await waitFor(session.events, of("permission_resolved"), "permission_resolved");
    expect(resolved.resolution).toBe("allow");
    const change = await waitFor(
      session.events,
      (events) => events.find((event) => event.type === "file_change"),
      "the allowed file_change"
    );
    expect(change.action).toBe("edit");
    await waitFor(session.events, of("turn_completed"), "turn_completed");
    const decisions = await waitForRecord(session, "decisions.jsonl");
    expect(decisions[0]!.result).toEqual({ decision: "accept" });
    send(session.driver, { type: "shutdown" });
    expect(await session.code).toBe(0);
  });

  test("a fileChange allow at read-only is an escalation answered decline", async () => {
    const session = await startAndWait({ autonomy: "read-only" });
    send(session.driver, { type: "user", text: "scenario:askpatch patch" });
    const request = await waitFor(session.events, of("permission_request"), "permission_request");
    send(session.driver, { type: "permission_decision", request_id: request.request_id, decision: "allow" });
    await waitFor(
      session.events,
      (events) => events.find((event) => event.type === "input_rejected" && event.reason === "autonomy_escalation"),
      "the escalation rejection"
    );
    const resolved = await waitFor(session.events, of("permission_resolved"), "permission_resolved");
    expect(resolved.resolution).toBe("deny");
    await waitFor(session.events, of("turn_completed"), "turn_completed");
    const decisions = await waitForRecord(session, "decisions.jsonl");
    expect(decisions[0]!.result).toEqual({ decision: "decline" });
    send(session.driver, { type: "shutdown" });
    expect(await session.code).toBe(0);
  });

  test("a decision naming no pending approval is rejected unknown_request", async () => {
    const session = await startAndWait();
    send(session.driver, { type: "permission_decision", request_id: "appr-nope", decision: "allow" });
    const rejected = await waitFor(
      session.events,
      (events) => events.find((event) => event.type === "input_rejected" && event.reason === "unknown_request"),
      "the unknown_request rejection"
    );
    expect(rejected.input_seq).toBe(1);
    // The session survives and a normal turn still completes.
    send(session.driver, { type: "user", text: "scenario:basic after" });
    const completed = await waitFor(session.events, of("turn_completed"), "turn_completed");
    expect(completed.finish).toBe("end");
    send(session.driver, { type: "shutdown" });
    expect(await session.code).toBe(0);
  });
});
