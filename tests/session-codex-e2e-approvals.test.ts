import { afterAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { cleanupSessions, type Event, of, send, startAndWait, waitFor, waitForRecord } from "./session-codex-e2e-helpers.js";

afterAll(cleanupSessions);

describe("codex session e2e - tools, files, usage", () => {
  test("commandExecution and fileChange items surface as tool and file events", async () => {
    const session = await startAndWait();
    send(session.driver, { type: "user", text: "scenario:tools edit" });
    const call = await waitFor(session.events, of("tool_call"), "tool_call");
    expect(call.name).toBe("commandExecution");
    expect(call.input).toEqual({ command: "echo hi", cwd: session.workDir });
    expect(call.call_id).toBeTypeOf("string");
    const result = await waitFor(session.events, of("tool_result"), "tool_result");
    expect(result.output).toBe("hi\n");
    expect(result.is_error).toBe(false);
    const changes = await waitFor(
      session.events,
      (events) => (events.filter((event) => event.type === "file_change").length >= 3 ? events : undefined),
      "file_change events"
    );
    const fileChanges = changes.filter((event) => event.type === "file_change");
    expect(fileChanges.map((change) => [change.path, change.action])).toEqual([
      [join(session.workDir, "new.txt"), "add"],
      [join(session.workDir, "file.txt"), "edit"],
      [join(session.workDir, "old.txt"), "delete"],
    ]);
    for (const change of fileChanges) {
      expect("derived" in change).toBe(false);
    }
    const completed = await waitFor(session.events, of("turn_completed"), "turn_completed");
    // Two usage notifications accumulate into one turn usage: the deltas
    // sum field-wise (§4.2).
    expect(completed.usage).toEqual({
      input_tokens: 125,
      output_tokens: 15,
      cached_input_tokens: 25,
      total_tokens: 165,
      cost_usd: null,
    });
    const usageEvents = session.events.filter((event) => event.type === "usage");
    expect(usageEvents).toHaveLength(2);
    expect(usageEvents[0]!.turn_id).toBe("t1");
    send(session.driver, { type: "shutdown" });
    expect(await session.code).toBe(0);
    const ended = session.events[session.events.length - 1] as Event;
    expect(ended.usage).toEqual(completed.usage);
  });
});

describe("codex session e2e - approvals", () => {
  test.each(["permission_decision", "permission_response"])("%s allow answers accept and the turn continues", async (type) => {
    const session = await startAndWait();
    send(session.driver, { type: "user", text: "scenario:ask dangerous" });
    const request = await waitFor(session.events, of("permission_request"), "permission_request");
    expect(request.tool).toBe("commandExecution");
    expect(request.input.command).toBe("rm -rf /");
    expect(request.options).toEqual(["allow", "deny"]);
    send(session.driver, { type, request_id: request.request_id, decision: "allow" });
    const accepted = await waitFor(
      session.events,
      (events) => events.find((event) => event.type === "input_accepted" && event.input_seq === 2),
      "the approval input acknowledgment"
    );
    expect(accepted.seq).toBeGreaterThan(request.seq);
    const resolved = await waitFor(session.events, of("permission_resolved"), "permission_resolved");
    expect(resolved.resolution).toBe("allow");
    expect(resolved.request_id).toBe(request.request_id);
    expect(resolved.seq).toBeGreaterThan(request.seq);
    const result = await waitFor(session.events, of("tool_result"), "tool_result");
    expect(result.is_error).toBe(false);
    expect(result.output).toBe("gone\n");
    const completed = await waitFor(session.events, of("turn_completed"), "turn_completed");
    expect(completed.finish).toBe("end");
    const decisions = await waitForRecord(session, "decisions.jsonl");
    expect(decisions[0]!.id).toBe("appr-1");
    expect(decisions[0]!.result).toEqual({ decision: "accept" });
    send(session.driver, { type: "shutdown" });
    expect(await session.code).toBe(0);
  });

  test.each(["permission_decision", "permission_response"])("%s deny answers decline and the tool reports the refusal", async (type) => {
    const session = await startAndWait();
    send(session.driver, { type: "user", text: "scenario:ask dangerous" });
    const request = await waitFor(session.events, of("permission_request"), "permission_request");
    // A denial message cannot ride the codex wire (the decline carries no
    // text channel): rejected `unsupported`, the request stays pending.
    send(session.driver, {
      type,
      request_id: request.request_id,
      decision: "deny",
      message: "Not here.",
    });
    const rejected = await waitFor(
      session.events,
      (events) => events.find((event) => event.type === "input_rejected" && event.reason === "unsupported"),
      "the message rejection"
    );
    expect(rejected.input_seq).toBe(2);
    send(session.driver, { type, request_id: request.request_id, decision: "deny" });
    const accepted = await waitFor(
      session.events,
      (events) => events.find((event) => event.type === "input_accepted" && event.input_seq === 3),
      "the approval input acknowledgment"
    );
    expect(accepted.seq).toBeGreaterThan(rejected.seq);
    const resolved = await waitFor(session.events, of("permission_resolved"), "permission_resolved");
    expect(resolved.resolution).toBe("deny");
    expect(resolved.request_id).toBe(request.request_id);
    expect(resolved.seq).toBeGreaterThan(rejected.seq);
    expect(resolved.message).toBeUndefined();
    const result = await waitFor(session.events, of("tool_result"), "tool_result");
    expect(result.is_error).toBe(true);
    await waitFor(session.events, of("turn_completed"), "turn_completed");
    const decisions = await waitForRecord(session, "decisions.jsonl");
    expect(decisions[0]!.id).toBe("appr-1");
    expect(decisions[0]!.result).toEqual({ decision: "decline" });
    send(session.driver, { type: "shutdown" });
    expect(await session.code).toBe(0);
  });

  test("the permission timeout answers deny and resolves as timeout", async () => {
    const session = await startAndWait({ permissionTimeoutMs: 300 });
    send(session.driver, { type: "user", text: "scenario:ask dangerous" });
    await waitFor(session.events, of("permission_request"), "permission_request");
    const resolved = await waitFor(session.events, of("permission_resolved"), "permission_resolved");
    expect(resolved.resolution).toBe("timeout");
    const result = await waitFor(session.events, of("tool_result"), "tool_result");
    expect(result.is_error).toBe(true);
    await waitFor(session.events, of("turn_completed"), "turn_completed");
    const decisions = await waitForRecord(session, "decisions.jsonl");
    expect(decisions[0]!.result).toEqual({ decision: "decline" });
    send(session.driver, { type: "shutdown" });
    expect(await session.code).toBe(0);
  });

  test("a numeric approval id is answered numerically on the wire", async () => {
    const session = await startAndWait();
    send(session.driver, { type: "user", text: "scenario:asknumeric probe" });
    const request = await waitFor(session.events, of("permission_request"), "permission_request");
    // The caller-facing request_id is the id's string spelling; the wire
    // id must keep its type or the server cannot correlate the reply.
    expect(request.request_id).toBe("42");
    send(session.driver, { type: "permission_decision", request_id: "42", decision: "deny" });
    await waitFor(session.events, of("turn_completed"), "turn_completed");
    const decisions = await waitForRecord(session, "decisions.jsonl");
    expect(decisions[0]!.id).toBe(42);
    expect(decisions[0]!.result).toEqual({ decision: "decline" });
    send(session.driver, { type: "shutdown" });
    expect(await session.code).toBe(0);
  });

  test("approvals under ids 1 and \"1\" stay distinct and separately answerable (review round 73)", async () => {
    const session = await startAndWait();
    send(session.driver, { type: "user", text: "scenario:askmixed probe" });
    const requests = await waitFor(session.events, (events) =>
      events.filter((event) => event.type === "permission_request").length >= 2 ? events : undefined,
      "both permission_requests");
    const byCommand = (command: string): Record<string, any> =>
      requests.filter((event) => event.type === "permission_request")
        .find((event) => event.input?.arguments?.command === command || event.input?.command === command)!;
    const numeric = byCommand("echo numeric");
    const stringy = byCommand("echo stringy");
    // The caller-facing request_id is the id's JSON spelling: numeric 1
    // is 1, string "1" keeps its quotes, so neither the pending set nor
    // the caller can confuse the two.
    expect(numeric.request_id).toBe("1");
    expect(stringy.request_id).toBe("\"1\"");
    // Each decision reaches its own approval, echoed with its wire type.
    send(session.driver, { type: "permission_decision", request_id: "1", decision: "deny" });
    send(session.driver, { type: "permission_decision", request_id: "\"1\"", decision: "deny" });
    const resolved = await waitFor(session.events, (events) =>
      events.filter((event) => event.type === "permission_resolved").length >= 2 ? events : undefined,
      "both permission_resolved");
    expect(resolved.filter((event) => event.type === "permission_resolved").map((event) => event.request_id).sort())
      .toEqual(["\"1\"", "1"]);
    await waitFor(session.events, of("turn_completed"), "turn_completed");
    const decisions = await waitForRecord(session, "decisions.jsonl");
    expect(decisions.map((decision: Record<string, unknown>) => decision.id)).toEqual([1, "1"]);
    for (const decision of decisions) expect(decision.result).toEqual({ decision: "decline" });
    send(session.driver, { type: "shutdown" });
    expect(await session.code).toBe(0);
  });

  test("an interrupt declines a pending approval as superseded and the session continues", async () => {
    const session = await startAndWait();
    send(session.driver, { type: "user", text: "scenario:ask dangerous" });
    await waitFor(session.events, of("permission_request"), "permission_request");
    send(session.driver, { type: "interrupt" });
    const superseded = await waitFor(
      session.events,
      (events) => events.find((event) => event.type === "permission_resolved" && event.resolution === "superseded"),
      "superseded resolution"
    );
    expect(superseded.request_id).toBe("\"appr-1\"");
    const completed = await waitFor(session.events, of("turn_completed"), "turn_completed");
    // Review live14: the wire's status is the verdict. The supersede
    // decline reaches the app-server before the interrupt, and its answer
    // completes the turn "completed" — recasting that as "interrupted"
    // because codemux's own interrupt was still in flight was the defect.
    expect(completed.finish).toBe("end");
    // The harness saw the decline keyed by the pending request's wire id,
    // before the interrupt closed the turn.
    const decisions = await waitForRecord(session, "decisions.jsonl");
    expect(decisions[0]!.id).toBe("appr-1");
    expect(decisions[0]!.result).toEqual({ decision: "decline" });
    // The session survives: another turn runs to completion.
    send(session.driver, { type: "user", text: "scenario:basic after" });
    const second = await waitFor(
      session.events,
      (events) => events.filter((event) => event.type === "turn_completed")[1],
      "second turn_completed"
    );
    expect(second.finish).toBe("end");
    send(session.driver, { type: "shutdown" });
    expect(await session.code).toBe(0);
  });

  test("the turn timeout declines a pending approval as superseded too", async () => {
    const session = await startAndWait({ turnTimeoutMs: 400, permissionTimeoutMs: 300_000 });
    send(session.driver, { type: "user", text: "scenario:ask dangerous" });
    await waitFor(session.events, of("permission_request"), "permission_request");
    const superseded = await waitFor(
      session.events,
      (events) => events.find((event) => event.type === "permission_resolved" && event.resolution === "superseded"),
      "superseded resolution",
      5_000
    );
    expect(superseded.request_id).toBe("\"appr-1\"");
    const completed = await waitFor(session.events, of("turn_completed"), "turn_completed");
    // Review live14, same shape as the caller-interrupt variant above: the
    // supersede decline's answer completes the turn "completed" on the
    // wire while the timeout's interrupt is still in flight, and the
    // wire's status stands — no "interrupted" recast, no "turn-timeout"
    // reason for a turn that delivered its answer.
    expect(completed.finish).toBe("end");
    expect(completed.reason).toBeUndefined();
    const decisions = await waitForRecord(session, "decisions.jsonl");
    expect(decisions[0]!.result).toEqual({ decision: "decline" });
    send(session.driver, { type: "shutdown" });
    expect(await session.code).toBe(0);
  });

  test("an allow above the autonomy ceiling is refused as an escalation", async () => {
    const session = await startAndWait({ autonomy: "medium" });
    send(session.driver, { type: "user", text: "scenario:ask dangerous" });
    const request = await waitFor(session.events, of("permission_request"), "permission_request");
    send(session.driver, { type: "permission_decision", request_id: request.request_id, decision: "allow" });
    const rejected = await waitFor(
      session.events,
      (events) => events.find((event) => event.type === "input_rejected" && event.reason === "autonomy_escalation"),
      "the escalation rejection"
    );
    expect(rejected.input_seq).toBe(2);
    // The request was answered deny; the turn still completes.
    const resolved = await waitFor(session.events, of("permission_resolved"), "permission_resolved");
    expect(resolved.resolution).toBe("deny");
    await waitFor(session.events, of("turn_completed"), "turn_completed");
    const decisions = await waitForRecord(session, "decisions.jsonl");
    expect(decisions[0]!.result).toEqual({ decision: "decline" });
    send(session.driver, { type: "shutdown" });
    expect(await session.code).toBe(0);
  });

  test("an allow on an approval that offers no accept decision is answered deny", async () => {
    // Review live15: availableDecisions ["acceptForSession","decline"]
    // made approvalAccept's pickApprovalDecision substitute "decline"
    // while the driver still resolved "allow" and acked accepted — the
    // caller told allow, the harness told decline, a success reported on
    // a failure path. codemux never answers acceptForSession (the pinned
    // per-request refusal rule), so allow is undeliverable: the request
    // advertises deny as its only option, an allow is rejected
    // `unsupported`, permission_resolved says deny, the harness receives
    // the decline, and a non-fatal error names what happened.
    const session = await startAndWait();
    send(session.driver, { type: "user", text: "scenario:acceptless probe" });
    const request = await waitFor(session.events, of("permission_request"), "permission_request");
    expect(request.options).toEqual(["deny"]);
    send(session.driver, { type: "permission_decision", request_id: request.request_id, decision: "allow" });
    const rejected = await waitFor(
      session.events,
      (events) => events.find((event) => event.type === "input_rejected" && event.reason === "unsupported"),
      "the unsupported rejection"
    );
    expect(rejected.input_seq).toBe(2);
    const resolved = await waitFor(session.events, of("permission_resolved"), "permission_resolved");
    expect(resolved.resolution).toBe("deny");
    const error = await waitFor(
      session.events,
      (events) => events.find((event) => event.type === "error" && event.fatal === false),
      "the undeliverable-allow error"
    );
    expect(error.message).toContain("no accept decision");
    // The harness saw the decline, keyed to the request it denied, and
    // the turn completed on it.
    const decisions = await waitForRecord(session, "decisions.jsonl");
    expect(decisions[0]!.id).toBe("appr-nos");
    expect(decisions[0]!.result).toEqual({ decision: "decline" });
    const completed = await waitFor(session.events, of("turn_completed"), "turn_completed");
    expect(completed.finish).toBe("end");
    send(session.driver, { type: "shutdown" });
    expect(await session.code).toBe(0);
  });

  test("an in-scope patch allow passes the medium ceiling", async () => {
    const session = await startAndWait({ autonomy: "medium" });
    send(session.driver, { type: "user", text: "scenario:askpatch patch" });
    const request = await waitFor(session.events, of("permission_request"), "permission_request");
    expect(request.tool).toBe("fileChange");
    expect(request.input.itemId).toBe("fc-ask");
    expect(JSON.parse(request.raw).params.changes).toBeUndefined();
    send(session.driver, { type: "permission_decision", request_id: request.request_id, decision: "allow" });
    const resolved = await waitFor(session.events, of("permission_resolved"), "permission_resolved");
    expect(resolved.resolution).toBe("allow");
    const changes = await waitFor(
      session.events,
      (events) => events.find((event) => event.type === "file_change"),
      "the allowed file_change"
    );
    expect(changes.path).toBe(join(session.workDir, "file.txt"));
    await waitFor(session.events, of("turn_completed"), "turn_completed");
    const decisions = await waitForRecord(session, "decisions.jsonl");
    expect(decisions[0]!.result).toEqual({ decision: "accept" });
    send(session.driver, { type: "shutdown" });
    expect(await session.code).toBe(0);
  });

  test("an unparsable approval is declined, reported non-fatally, and the session continues", async () => {    const session = await startAndWait();
    send(session.driver, { type: "user", text: "scenario:badapproval opaque" });
    const error = await waitFor(
      session.events,
      (events) => events.find((event) => event.type === "error" && event.fatal === false),
      "the non-fatal approval error"
    );
    expect(error.source).toBe("harness");
    expect(error.message).toContain("could not be parsed");
    const unknown = session.events.find(
      (event) =>
        event.type === "unknown" &&
        typeof event.raw === "string" &&
        event.raw.includes("item/commandExecution/requestApproval")
    );
    expect(unknown).toBeDefined();
    await waitFor(session.events, of("turn_completed"), "turn_completed");
    const decisions = await waitForRecord(session, "decisions.jsonl");
    expect(decisions[0]!.result).toEqual({ decision: "decline" });
    send(session.driver, { type: "shutdown" });
    expect(await session.code).toBe(0);
  });

  test("an unimplemented server request gets the -32601 answer and a non-fatal error", async () => {
    const session = await startAndWait();
    send(session.driver, { type: "user", text: "scenario:unknownreq probe" });
    const error = await waitFor(
      session.events,
      (events) => events.find((event) => event.type === "error" && event.fatal === false),
      "the non-fatal unimplemented-request error"
    );
    expect(error.message).toContain("fs/readFileText");
    const answers = await waitForRecord(session, "decisions.jsonl");
    expect(answers[0]!.error).toEqual({ code: -32601, message: "codemux does not implement fs/readFileText" });
    const completed = await waitFor(session.events, of("turn_completed"), "turn_completed");
    expect(completed.finish).toBe("end");
    send(session.driver, { type: "shutdown" });
    expect(await session.code).toBe(0);
  });
});
