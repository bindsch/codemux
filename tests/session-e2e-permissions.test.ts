import { afterAll, describe, expect, test } from "bun:test";
import { DEFAULT_DENIAL_MESSAGE } from "../src/session/claude-session.js";
import {
  cleanups,
  fakeRecord,
  of,
  send,
  startSession,
  waitFor,
  waitForRecord,
  type Event
} from "./helpers/session-e2e.js";
import { registerNoLeakedSignals } from "./helpers/signal-listeners.js";

afterAll(async () => {
  for (const clean of cleanups.reverse()) await clean();
});

// Review round 4, session finding 8: every session a test built is ended
// in that test's afterEach, not left for the file's afterAll — a driver
// still holding the process's signal handlers would fire in any later
// test that raises one.
registerNoLeakedSignals(
  async (mark) => { while (cleanups.length > mark) await cleanups.pop()!(); },
  () => cleanups.length
);

describe("claude session driver e2e", () => {
  test("permission allow round-trips, with updated_input substituted", async () => {
    const session = await startSession({ permissionTimeoutMs: 60_000 });
    send(session.driver, { type: "user", text: "scenario:ask bash please" });
    await waitFor(session.events, of("session_started"), "session_started");
    const request = await waitFor(session.events, of("permission_request"), "permission_request");
    expect(request.tool).toBe("Bash");
    expect(request.input).toEqual({ command: "echo hi", description: "say hi" });
    send(session.driver, {
      type: "permission_decision",
      request_id: request.request_id,
      decision: "allow",
      updated_input: { command: "echo rewritten" },
    });
    const resolved = await waitFor(
      session.events,
      (events) => events.find((event) => event.type === "permission_resolved" && event.resolution === "allow"),
      "permission_resolved allow"
    );
    expect(resolved.request_id).toBe(request.request_id);
    const result = await waitFor(
      session.events,
      (events) => events.find((event) => event.type === "tool_result" && event.output === "allowed:echo rewritten"),
      "tool_result with the substituted command"
    );
    expect(result.is_error).toBe(false);
    // The harness saw the substituted input, not the requested one.
    const responses = fakeRecord(session, "responses.jsonl") as Array<{
      request_id: string;
      behavior: string;
      updatedInput: Record<string, unknown> | null;
      message: string | null;
    }>;
    expect(responses[responses.length - 1]).toEqual({
      request_id: "toolu_ask_1",
      behavior: "allow",
      updatedInput: { command: "echo rewritten" },
      message: expect.any(String),
    });
    await waitFor(session.events, of("turn_completed"), "turn_completed");
    send(session.driver, { type: "shutdown" });
    await waitFor(session.events, of("session_ended"), "session_ended");
  });

  test("permission deny round-trips and fails the tool", async () => {
    const session = await startSession();
    send(session.driver, { type: "user", text: "scenario:ask deny me" });
    await waitFor(session.events, of("session_started"), "session_started");
    const request = await waitFor(session.events, of("permission_request"), "permission_request");
    send(session.driver, {
      type: "permission_decision",
      request_id: request.request_id,
      decision: "deny",
    });
    const resolved = await waitFor(
      session.events,
      (events) => events.find((event) => event.type === "permission_resolved" && event.resolution === "deny"),
      "permission_resolved deny"
    );
    // The record carries the text that was sent: the default denial text,
    // Claude Code's own user-rejection wording.
    expect(resolved.message).toBe(DEFAULT_DENIAL_MESSAGE);
    const failed = await waitFor(
      session.events,
      (events) => events.find((event) => event.type === "tool_result" && event.is_error === true),
      "failed tool_result"
    );
    // The fake echoes the denial message as the tool result, as the real
    // harness does: this string is what the agent saw.
    expect(failed.output).toBe(DEFAULT_DENIAL_MESSAGE);
    const responses = fakeRecord(session, "responses.jsonl") as Array<{
      behavior: string;
      message: string | null;
    }>;
    expect(responses[responses.length - 1]?.behavior).toBe("deny");
    expect(responses[responses.length - 1]?.message).toBe(DEFAULT_DENIAL_MESSAGE);
    send(session.driver, { type: "shutdown" });
    await waitFor(session.events, of("session_ended"), "session_ended");
  });

  test("a caller denial message rides the answer and becomes the agent-visible text", async () => {
    const session = await startSession();
    send(session.driver, { type: "user", text: "scenario:ask with words" });
    await waitFor(session.events, of("permission_request"), "permission_request");
    send(session.driver, {
      type: "permission_decision",
      request_id: "toolu_ask_1",
      decision: "deny",
      message: "Not in this fixture.",
    });
    const resolved = await waitFor(
      session.events,
      (events) => events.find((event) => event.type === "permission_resolved" && event.resolution === "deny"),
      "permission_resolved deny"
    );
    expect(resolved.message).toBe("Not in this fixture.");
    const failed = await waitFor(
      session.events,
      (events) => events.find((event) => event.type === "tool_result" && event.is_error === true),
      "failed tool_result"
    );
    expect(failed.output).toBe("Not in this fixture.");
    const responses = await waitForRecord(session, "responses.jsonl");
    expect(responses[responses.length - 1]).toMatchObject({
      request_id: "toolu_ask_1",
      behavior: "deny",
      message: "Not in this fixture.",
    });
    await waitFor(session.events, of("turn_completed"), "turn_completed");
    send(session.driver, { type: "shutdown" });
    await waitFor(session.events, of("session_ended"), "session_ended");
    expect(await session.code).toBe(0);
  });

  test("every denial that reaches the agent is the harness's own text, never a codemux wrapper", async () => {
    // The experiment this serves: an agent denied mid-turn must read the
    // rejection as its own harness's permission answer, so no string
    // containing "codemux" may reach the harness on a deny — the default
    // text is Claude Code's own user-rejection wording.
    const session = await startSession();
    send(session.driver, { type: "user", text: "scenario:ask quietly" });
    await waitFor(session.events, of("permission_request"), "permission_request");
    send(session.driver, {
      type: "permission_decision",
      request_id: "toolu_ask_1",
      decision: "deny",
    });
    await waitFor(session.events, of("turn_completed"), "turn_completed");
    const responses = fakeRecord(session, "responses.jsonl") as Array<{
      behavior: string;
      message: string | null;
    }>;
    expect(responses.length).toBeGreaterThan(0);
    for (const answer of responses) {
      expect(String(answer.message)).not.toContain("codemux");
    }
    for (const event of session.events) {
      if (event.type === "tool_result" && event.is_error === true) {
        expect(JSON.stringify(event.output)).not.toContain("codemux");
      }
    }
    send(session.driver, { type: "shutdown" });
    await waitFor(session.events, of("session_ended"), "session_ended");
    expect(await session.code).toBe(0);
  });

  test("the deny policy answers with the default text and a permission_denied record", async () => {
    const session = await startSession({ permissionPolicy: "deny" });
    send(session.driver, { type: "user", text: "scenario:ask unattended" });
    const request = await waitFor(session.events, of("permission_request"), "permission_request");
    const denied = await waitFor(session.events, of("permission_denied"), "permission_denied");
    expect(denied.request_id).toBe(request.request_id);
    expect(denied.tool).toBe("Bash");
    expect(denied.message).toBe(DEFAULT_DENIAL_MESSAGE);
    const responses = await waitForRecord(session, "responses.jsonl");
    expect(responses[responses.length - 1]).toMatchObject({
      request_id: request.request_id,
      behavior: "deny",
      message: DEFAULT_DENIAL_MESSAGE,
    });
    await waitFor(session.events, of("turn_completed"), "turn_completed");
    expect(
      session.events.some(
        (event) => event.type === "permission_resolved" && event.request_id === request.request_id
      )
    ).toBe(false);
    send(session.driver, { type: "shutdown" });
    await waitFor(session.events, of("session_ended"), "session_ended");
    expect(await session.code).toBe(0);
  });

  test("an allow above the ceiling is answered deny and rejected as escalation", async () => {
    // Medium grants only scoped edits: Bash is out of reach, so the
    // caller's allow cannot stand (§4.1).
    const session = await startSession({ autonomy: "medium" });
    send(session.driver, { type: "user", text: "scenario:ask escalate" });
    const started = await waitFor(session.events, of("session_started"), "session_started");
    expect(started.autonomy).toBe("medium");
    const request = await waitFor(session.events, of("permission_request"), "permission_request");
    send(session.driver, {
      type: "permission_decision",
      request_id: request.request_id,
      decision: "allow",
    });
    const rejected = await waitFor(
      session.events,
      (events) => events.find((event) => event.type === "input_rejected" && event.reason === "autonomy_escalation"),
      "autonomy_escalation rejection"
    );
    expect(rejected.input_seq).toBe(2);
    // The rejection names the text the harness got — the default denial
    // text, so the agent reads its own harness's rejection.
    expect(rejected.message).toBe(DEFAULT_DENIAL_MESSAGE);
    const ceilingDeny = await waitFor(
      session.events,
      (events) => events.find((event) => event.type === "permission_resolved" && event.resolution === "deny"),
      "deny resolution"
    );
    expect(ceilingDeny.message).toBe(DEFAULT_DENIAL_MESSAGE);
    // The harness saw deny, not the caller's allow.
    const failed = await waitFor(
      session.events,
      (events) => events.find((event) => event.type === "tool_result" && event.is_error === true),
      "denied tool_result"
    );
    expect(failed.output).toBe(DEFAULT_DENIAL_MESSAGE);
    send(session.driver, { type: "shutdown" });
    await waitFor(session.events, of("session_ended"), "session_ended");
  });

  test("read-only denies every allow at the ceiling", async () => {
    const session = await startSession({ autonomy: "read-only" });
    send(session.driver, { type: "user", text: "scenario:ask ro" });
    await waitFor(session.events, of("session_started"), "session_started");
    await waitFor(session.events, of("permission_request"), "permission_request");
    send(session.driver, {
      type: "permission_decision",
      request_id: "toolu_ask_1",
      decision: "allow",
    });
    await waitFor(
      session.events,
      (events) => events.find((event) => event.type === "input_rejected" && event.reason === "autonomy_escalation"),
      "read-only escalation rejection"
    );
    send(session.driver, { type: "shutdown" });
    await waitFor(session.events, of("session_ended"), "session_ended");
  });

  test("an unparsable can_use_tool is answered deny, reported, and never fatal", async () => {
    const session = await startSession({ permissionTimeoutMs: 60_000 });
    send(session.driver, { type: "user", text: "scenario:badask opaque" });
    await waitFor(session.events, of("session_started"), "session_started");
    const error = await waitFor(
      session.events,
      (events) => events.find((event) => event.type === "error" && event.fatal === false),
      "the non-fatal parse error"
    );
    expect(error.source).toBe("harness");
    expect(error.message).toContain("could not be parsed");
    // The raw frame passes through so the caller can see what was denied.
    const unknown = session.events.find(
      (event) =>
        event.type === "unknown" && typeof event.raw === "string" && event.raw.includes("toolu_bad_1")
    );
    expect(unknown).toBeDefined();
    // No permission ever surfaced, so nothing is pending to time out later.
    expect(of("permission_request")(session.events)).toBeUndefined();
    await waitFor(session.events, of("turn_completed"), "turn_completed");
    const responses = fakeRecord(session, "responses.jsonl") as Array<{
      request_id: string;
      behavior: string;
      message: string | null;
    }>;
    expect(responses[responses.length - 1]).toMatchObject({
      request_id: "toolu_bad_1",
      behavior: "deny",
      message: DEFAULT_DENIAL_MESSAGE,
    });
    send(session.driver, { type: "shutdown" });
    await waitFor(session.events, of("session_ended"), "session_ended");
    expect(await session.code).toBe(0);
  });

  test("an interrupt denies a pending request as superseded and the session continues", async () => {
    const session = await startSession({ permissionTimeoutMs: 60_000 });
    send(session.driver, { type: "user", text: "scenario:ask dangerous" });
    await waitFor(session.events, of("session_started"), "session_started");
    const request = await waitFor(session.events, of("permission_request"), "permission_request");
    send(session.driver, { type: "interrupt" });
    const superseded = await waitFor(
      session.events,
      (events) => events.find((event) => event.type === "permission_resolved" && event.resolution === "superseded"),
      "superseded resolution"
    );
    expect(superseded.request_id).toBe(request.request_id);
    expect(superseded.message).toBe(DEFAULT_DENIAL_MESSAGE);
    const completed = await waitFor(session.events, of("turn_completed"), "turn_completed");
    // Review live12: the supersede-deny ends the ask's turn CLEANLY — the
    // fake answers the deny synchronously, so the interrupt that follows
    // finds no open turn and is bare-acked (nothing queued). The turn
    // genuinely ended; an interrupt label belongs to the error result an
    // interrupt produces (the wait-scenario tests below), never to a
    // clean completion that raced one.
    expect(completed.finish).toBe("end");
    // The harness saw the deny before the turn closed — keyed by the
    // pending request's id, so the harness never hangs on it — carrying
    // the default denial text.
    const responses = fakeRecord(session, "responses.jsonl") as Array<{
      request_id: string;
      behavior: string;
      message: string | null;
    }>;
    expect(responses[responses.length - 1]).toMatchObject({
      request_id: "toolu_ask_1",
      behavior: "deny",
      message: DEFAULT_DENIAL_MESSAGE,
    });
    // The session survives: another turn runs to completion.
    send(session.driver, { type: "user", text: "scenario:basic after" });
    const second = await waitFor(
      session.events,
      (events) => events.filter((event) => event.type === "turn_completed")[1],
      "second turn_completed"
    );
    expect(second.finish).toBe("end");
    send(session.driver, { type: "shutdown" });
    await waitFor(session.events, of("session_ended"), "session_ended");
    expect(await session.code).toBe(0);
  });

  test("the turn timeout denies a pending request as superseded too", async () => {
    const session = await startSession({
      permissionTimeoutMs: 300_000,
      turnTimeoutMs: 200,
    });
    send(session.driver, { type: "user", text: "scenario:ask slow" });
    await waitFor(session.events, of("session_started"), "session_started");
    await waitFor(session.events, of("permission_request"), "permission_request");
    const superseded = await waitFor(
      session.events,
      (events) => events.find((event) => event.type === "permission_resolved" && event.resolution === "superseded"),
      "superseded resolution",
      5_000
    );
    expect(superseded.request_id).toBe("toolu_ask_1");
    expect(superseded.message).toBe(DEFAULT_DENIAL_MESSAGE);
    const completed = await waitFor(session.events, of("turn_completed"), "turn_completed");
    // Review live12: same shape as the interrupt test above — the
    // supersede-deny completes the turn cleanly before the timeout's
    // interrupt lands, so the label is the wire's own ("end"; the
    // interrupt missed). The timeout-interrupt labeling itself keeps
    // coverage in the wait variant below.
    expect(completed.finish).toBe("end");
    const responses = fakeRecord(session, "responses.jsonl") as Array<{
      behavior: string;
      message: string | null;
    }>;
    expect(responses[responses.length - 1]?.behavior).toBe("deny");
    expect(responses[responses.length - 1]?.message).toBe(DEFAULT_DENIAL_MESSAGE);
    send(session.driver, { type: "shutdown" });
    await waitFor(session.events, of("session_ended"), "session_ended");
    expect(await session.code).toBe(0);
  });

  test("a permission request times out to deny when no decision comes", async () => {
    const session = await startSession({ permissionTimeoutMs: 150 });
    send(session.driver, { type: "user", text: "scenario:ask silence" });
    await waitFor(session.events, of("session_started"), "session_started");
    await waitFor(session.events, of("permission_request"), "permission_request");
    const timedOut = await waitFor(
      session.events,
      (events) => events.find((event) => event.type === "permission_resolved" && event.resolution === "timeout"),
      "permission_resolved timeout",
      5_000
    );
    expect(timedOut.resolution).toBe("timeout");
    expect(timedOut.message).toBe(DEFAULT_DENIAL_MESSAGE);
    await waitFor(
      session.events,
      (events) => events.find((event) => event.type === "tool_result" && event.is_error === true),
      "denied tool_result after timeout"
    );
    // A late decision for the timed-out request is rejected, not applied.
    send(session.driver, { type: "permission_decision", request_id: "toolu_ask_1", decision: "allow" });
    const late = await waitFor(
      session.events,
      (events) => events.find((event) => event.type === "input_rejected" && event.reason === "unknown_request"),
      "late decision rejection"
    );
    expect(late.input_seq).toBe(2);
    send(session.driver, { type: "shutdown" });
    await waitFor(session.events, of("session_ended"), "session_ended");
  });

  test("permissions still pending when the turn completes by itself are superseded", async () => {
    // Review live11, major 2 (the claude sibling): completeTurn never
    // closed the permission channel, so a can_use_tool that lost its
    // race with the turn's own result stayed pending — a later decision
    // was acked accepted for a request the harness no longer held, while
    // the expiry timer waited to write a stray deny into whatever turn
    // ran next. The completion now supersedes it: denied on the wire,
    // resolved "superseded" to the caller, and a later decision for it
    // is unknown_request.
    const session = await startSession();
    send(session.driver, { type: "user", text: "scenario:asklose race" });
    const request = await waitFor(
      session.events,
      of("permission_request"),
      "permission_request"
    );
    expect(request.request_id).toBe("toolu_lose_1");
    // The harness completes the turn by itself while the decision is out.
    const completed = await waitFor(session.events, of("turn_completed"), "turn_completed");
    expect(completed.finish).toBe("end");
    const superseded = await waitFor(
      session.events,
      (events) =>
        events.find(
          (event) =>
            event.type === "permission_resolved" && event.resolution === "superseded"
        ),
      "superseded resolution"
    );
    expect(superseded.request_id).toBe("toolu_lose_1");
    expect(superseded.message).toBe(DEFAULT_DENIAL_MESSAGE);
    // The deny reached the harness, keyed to the lost request, with the
    // default denial text. Polled, not read once: the emit above is
    // codemux's, so the fake's record follows a pipe turn later.
    const responses = await waitForRecord(session, "responses.jsonl");
    const deny = responses.find((entry) => entry.request_id === "toolu_lose_1");
    expect(deny?.behavior).toBe("deny");
    expect(deny?.message).toBe(DEFAULT_DENIAL_MESSAGE);
    // The session survives and a second turn runs clean.
    send(session.driver, { type: "user", text: "scenario:basic after" });
    const second = await waitFor(
      session.events,
      (events) => events.filter((event) => event.type === "turn_completed")[1],
      "second turn_completed"
    );
    expect(second.finish).toBe("end");
    // A decision for the dead request is rejected, not applied — and no
    // second deny ever reaches the harness for it.
    send(session.driver, {
      type: "permission_decision",
      request_id: "toolu_lose_1",
      decision: "allow",
    });
    const rejected = await waitFor(
      session.events,
      (events) =>
        events.find((event) => event.type === "input_rejected" && event.reason === "unknown_request"),
      "the unknown_request rejection"
    );
    expect(rejected.input_seq).toBe(3);
    expect(
      (fakeRecord(session, "responses.jsonl") as Event[]).filter(
        (entry) => entry.request_id === "toolu_lose_1"
      )
    ).toHaveLength(1);
    send(session.driver, { type: "shutdown" });
    expect(await session.code).toBe(0);
  });
});
