import { afterAll, describe, expect, test } from "bun:test";
import { cleanupSessions, of, refuseWrites, send, startAndWait, waitFor, waitForRecord } from "./session-codex-e2e-helpers.js";

afterAll(cleanupSessions);

describe("codex automatic approval denials", () => {
  for (const autonomy of ["low", "medium"] as const) {
    for (const scenario of ["ask", "askpatch"] as const) {
      test(`${autonomy} sandboxed ${scenario} emits its request and automatic denial`, async () => {
        const session = await startAndWait({ autonomy, permissionPolicy: "deny", permissionTimeoutMs: 1 }, {
          FAKE_REQUIRE_ASKING_POLICY: "1",
        });
        send(session.driver, { type: "user", text: `scenario:${scenario} write` });
        const request = await waitFor(session.events, of("permission_request"), "permission_request");
        const denied = await waitFor(session.events, of("permission_denied"), "permission_denied");
        expect(request.tool).toBe(scenario === "ask" ? "commandExecution" : "fileChange");
        expect(request.options).toEqual(["allow", "deny"]);
        expect(denied.request_id).toBe(request.request_id);
        expect(denied.tool).toBe(request.tool);
        expect("message" in denied).toBe(false);
        expect(denied.seq).toBe(request.seq + 1);
        if (scenario === "askpatch") {
          expect(request.input.changes[0].path).toBe(`${session.workDir}/file.txt`);
          expect(JSON.parse(request.raw).params.changes).toBeUndefined();
        }
        await waitFor(session.events, of("turn_completed"), "turn_completed");
        expect(of("file_change")(session.events)).toBeUndefined();
        const decisions = await waitForRecord(session, "decisions.jsonl");
        expect(decisions).toHaveLength(1);
        expect(decisions[0]!.result).toEqual({ decision: "decline" });
        send(session.driver, { type: "permission_decision", request_id: request.request_id, decision: "allow" });
        const late = await waitFor(session.events, of("input_rejected"), "late decision rejection");
        expect(late.reason).toBe("unknown_request");
        expect(of("permission_resolved")(session.events)).toBeUndefined();
        send(session.driver, { type: "shutdown" });
        expect(await session.code).toBe(0);
      });
    }
  }

  test("turn-scoped permissions are denied with an empty grant and no text", async () => {
    const session = await startAndWait({ autonomy: "low", permissionPolicy: "deny" });
    send(session.driver, { type: "user", text: "scenario:askperms grant" });
    const request = await waitFor(session.events, of("permission_request"), "permission_request");
    const denied = await waitFor(session.events, of("permission_denied"), "permission_denied");
    expect(denied.tool).toBe("permissions");
    expect(denied.request_id).toBe(request.request_id);
    expect("message" in denied).toBe(false);
    const decisions = await waitForRecord(session, "decisions.jsonl");
    expect(decisions[0]!.result).toEqual({ permissions: {}, scope: "turn" });
    await waitFor(session.events, of("turn_completed"), "turn_completed");
    expect(of("permission_resolved")(session.events)).toBeUndefined();
    send(session.driver, { type: "shutdown" });
    expect(await session.code).toBe(0);
  });

  test("an acceptless request still advertises only deny", async () => {
    const session = await startAndWait({ permissionPolicy: "deny" });
    send(session.driver, { type: "user", text: "scenario:acceptless probe" });
    const request = await waitFor(session.events, of("permission_request"), "permission_request");
    expect(request.options).toEqual(["deny"]);
    await waitFor(session.events, of("permission_denied"), "permission_denied");
    const decisions = await waitForRecord(session, "decisions.jsonl");
    expect(decisions[0]!.result).toEqual({ decision: "decline" });
    await waitFor(session.events, of("turn_completed"), "turn_completed");
    send(session.driver, { type: "shutdown" });
    expect(await session.code).toBe(0);
  });

  test("a refusal-less request still receives a protocol error and interruption", async () => {
    const session = await startAndWait({ permissionPolicy: "deny" });
    send(session.driver, { type: "user", text: "scenario:refusalless probe" });
    await waitFor(session.events, of("turn_completed"), "turn_completed");
    const decisions = await waitForRecord(session, "decisions.jsonl");
    expect(decisions[0]!.error.code).toBe(-32602);
    expect(decisions[0]!.result).toEqual({});
    await waitForRecord(session, "interrupts.jsonl");
    expect(of("permission_request")(session.events)).toBeUndefined();
    expect(of("permission_denied")(session.events)).toBeUndefined();
    expect(of("permission_resolved")(session.events)).toBeUndefined();
    send(session.driver, { type: "shutdown" });
    expect(await session.code).toBe(0);
  });

  test("a refused denial write never reports a delivered denial", async () => {
    const session = await startAndWait({ permissionPolicy: "deny" });
    refuseWrites(session.proc, (line) => line.includes('"decision":"decline"'));
    send(session.driver, { type: "user", text: "scenario:ask probe" });
    await waitFor(session.events, of("session_ended"), "session_ended");
    expect(await session.code).toBe(1);
    expect(of("permission_request")(session.events)).toBeDefined();
    expect(of("permission_denied")(session.events)).toBeUndefined();
    expect(of("permission_resolved")(session.events)).toBeUndefined();
  });

  test("the deny policy answers approvals during shutdown drain", async () => {
    const session = await startAndWait({ permissionPolicy: "deny" }, { FAKE_SIGTERM_PERSIST: "ask" });
    send(session.driver, { type: "user", text: "scenario:wait hold" });
    await waitFor(session.events, (events) => events.find((event) =>
      event.type === "unknown" && event.raw?.includes("msg-wait")), "started turn");
    send(session.driver, { type: "shutdown" });
    await waitFor(session.events, of("session_ended"), "session_ended");
    expect(await session.code).toBe(0);
    expect(of("permission_denied")(session.events)?.request_id).toBe('"appr-drain"');
    expect(of("permission_resolved")(session.events)).toBeUndefined();
  });
});

describe("codex approval timeouts", () => {
  for (const scenario of ["ask", "askpatch", "askperms"] as const) {
    test(`${scenario} expires with its native decline reply`, async () => {
      const session = await startAndWait({ autonomy: "low", permissionTimeoutMs: 30 }, {
        FAKE_REQUIRE_ASKING_POLICY: "1",
      });
      send(session.driver, { type: "user", text: `scenario:${scenario} timeout` });
      const request = await waitFor(session.events, of("permission_request"), "permission_request");
      const resolved = await waitFor(session.events, of("permission_resolved"), "permission_resolved");
      expect(resolved.resolution).toBe("timeout");
      expect(resolved.request_id).toBe(request.request_id);
      expect("message" in resolved).toBe(false);
      const decisions = await waitForRecord(session, "decisions.jsonl");
      expect(decisions[0]!.result).toEqual(scenario === "askperms"
        ? { permissions: {}, scope: "turn" } : { decision: "decline" });
      await waitFor(session.events, of("turn_completed"), "turn_completed");
      send(session.driver, { type: "permission_decision", request_id: request.request_id, decision: "deny" });
      expect((await waitFor(session.events, of("input_rejected"), "late answer")).reason).toBe("unknown_request");
      send(session.driver, { type: "shutdown" });
      expect(await session.code).toBe(0);
    });
  }

  test("a caller decision allows a native patch and clears its timeout", async () => {
    const session = await startAndWait({ autonomy: "medium", permissionTimeoutMs: 100 }, {
      FAKE_REQUIRE_ASKING_POLICY: "1",
    });
    send(session.driver, { type: "user", text: "scenario:askpatch allow" });
    const request = await waitFor(session.events, of("permission_request"), "permission_request");
    send(session.driver, { type: "permission_decision", request_id: request.request_id, decision: "allow" });
    await waitFor(session.events, of("turn_completed"), "turn_completed");
    const decisions = await waitForRecord(session, "decisions.jsonl");
    expect(decisions[0]!.result).toEqual({ decision: "accept" });
    expect(of("permission_resolved")(session.events)?.resolution).toBe("allow");
    send(session.driver, { type: "shutdown" });
    expect(await session.code).toBe(0);
  });
});
