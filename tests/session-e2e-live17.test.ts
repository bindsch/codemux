import { afterAll, describe, expect, test } from "bun:test";
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

afterAll(async () => {
  for (const clean of cleanups.reverse()) await clean();
});

describe("claude session driver e2e - review live17", () => {
  test("the end-interrupt is answered before the stop signal", async () => {
    // Correctness 3: finish wrote the end-interrupt and sent SIGTERM in
    // the same synchronous step, so a harness that dies on SIGTERM (the
    // default fake, and claude itself in the live16 check) never answered
    // it: the turn was the synthesized `interrupted` with null usage. The
    // interrupt now gets the grace before any signal, so the turn closes
    // through its own drained result.
    const session = await startSession();
    send(session.driver, { type: "user", text: "scenario:wait hold" });
    await waitFor(session.events, of("assistant_message"), "assistant_message");
    send(session.driver, { type: "shutdown" });
    const ended = await waitFor(session.events, of("session_ended"), "session_ended");
    const completed = session.events.find((event) => event.type === "turn_completed");
    expect(completed).toBeDefined();
    expect(completed!.finish).toBe("interrupted");
    // Exact values from the scenario's result envelope, matching the
    // sibling fields: raw is the envelope's JSON text, usage its 4/2 pair.
    expect(String(completed!.raw)).toContain('"type":"result"');
    expect(completed!.usage.input_tokens).toBe(4);
    expect(completed!.usage.output_tokens).toBe(2);
    expect(ended.reason).toBe("shutdown");
    expect(await session.code).toBe(0);
  });

  test("a nonzero exit during an idle shutdown costs success", async () => {
    // Correctness 4: the drain verdict required a turn open at finish, so
    // a harness that failed while persisting after an idle `shutdown`
    // exited 1 with codemux reporting 0 and no error. The idle exit now
    // counts the same way; there is no turn to synthesize.
    const session = await startSession({}, { FAKE_SIGTERM_PERSIST: "exit42" });
    send(session.driver, { type: "user", text: "scenario:basic one" });
    await waitFor(session.events, of("turn_completed"), "turn_completed");
    send(session.driver, { type: "shutdown" });
    const ended = await waitFor(session.events, of("session_ended"), "session_ended");
    expect(ended.exit_code).toBe(1);
    expect(await session.code).toBe(1);
    const fatal = session.events.find((event) => event.type === "error" && event.fatal === true);
    expect(fatal?.message).toBe(
      "the claude process exited with code 42 during the shutdown drain"
    );
    expect(session.events.filter((event) => event.type === "turn_completed")).toHaveLength(1);
  });

  test("a caller stdin read error ends the session as a failure", async () => {
    // Correctness 2: a read error ran the clean-close handler and exited
    // 0. The driver now reports it fatal and costs success.
    const session = await startSession();
    send(session.driver, { type: "user", text: "scenario:basic one" });
    await waitFor(session.events, of("turn_completed"), "turn_completed");
    session.driver.handleCallerEnd(new Error("EIO: i/o error, read"));
    const ended = await waitFor(session.events, of("session_ended"), "session_ended");
    expect(ended.reason).toBe("stdin-close");
    expect(await session.code).toBe(1);
    const fatal = session.events.find((event) => event.type === "error" && event.fatal === true);
    expect(fatal?.source).toBe("codemux");
    expect(fatal?.message).toContain("reading the caller's stdin failed (EIO: i/o error, read)");
  });

  test("--turn-timeout re-arms, and a turn that ignores its interrupt ends the session", async () => {
    // Correctness 5: the timer fired once and never re-armed, so a turn
    // whose interrupt was refused or ignored ran uncapped. The first
    // expiry interrupts; the second ends the session (reason timeout,
    // exit 1) with the open turn answered.
    const session = await startSession({ turnTimeoutMs: 300 });
    send(session.driver, { type: "user", text: "scenario:deaf hold" });
    await waitFor(session.events, of("assistant_message"), "assistant_message");
    const ended = await waitFor(session.events, of("session_ended"), "session_ended", 8_000);
    expect(ended.reason).toBe("timeout");
    expect(await session.code).toBe(1);
    const interrupts = fakeRecord(session, "interrupts.jsonl");
    // One timeout interrupt, then the end-interrupt.
    expect(interrupts).toHaveLength(2);
    const fatal = session.events.find((event) => event.type === "error" && event.fatal === true);
    expect(fatal?.message).toContain("did not end within --turn-timeout");
    const completed = session.events.find((event) => event.type === "turn_completed");
    // Review live22: the end raised a fatal, so the synthesized answer is
    // a failure naming it, not an orderly interruption.
    expect(completed?.finish).toBe("failed");
    expect(completed?.reason).toContain("did not end within --turn-timeout");
  });

  test("a harness that stops reading stdin ends the session at the backlog bound (review live19)", async () => {
    // The class of the codex pre-handshake buffer: Bun buffered every
    // line the harness had not read, so a caller writing into a harness
    // that stopped reading grew codemux's memory without limit. Past
    // 64 MiB unread the process layer refuses the write (pinned in
    // session-process-stdout.test.ts), and the driver ends the session with a
    // codemux fatal. Since review live21 a mid-turn `user` line is
    // rejected `busy`, so the caller's lines into a running claude turn
    // are small control lines; the refusal is injected at the process
    // seam and carried by an interrupt.
    const session = await startSession();
    send(session.driver, { type: "user", text: "scenario:nostdin hold" });
    await waitFor(session.events, of("assistant_message"), "assistant_message");
    session.proc.writeLine = () => ({ ok: false, reason: "backlog" });
    send(session.driver, { type: "interrupt" });
    const ended = await waitFor(session.events, of("session_ended"), "session_ended", 8_000);
    expect(ended.reason).toBe("harness_failed");
    expect(await session.code).toBe(1);
    const fatal = session.events.find((event) => event.type === "error" && event.fatal === true);
    expect(fatal?.message).toContain("could not deliver a line to the harness (backlog)");
  }, 30_000);

  test("a plain allow carries the request's own input as updatedInput (review live18)", async () => {
    // Correctness 1: an allow without `updated_input` reached the harness
    // as {behavior, message} only. The harness runs the tool with the
    // answer's updatedInput (the recorded zai-permission3 allow carries
    // the full input), so the plain allow now sends the request's input.
    const session = await startSession({ permissionTimeoutMs: 60_000 });
    send(session.driver, { type: "user", text: "scenario:ask plain" });
    const request = await waitFor(session.events, of("permission_request"), "permission_request");
    send(session.driver, { type: "permission_decision", request_id: request.request_id, decision: "allow" });
    await waitFor(session.events, of("turn_completed"), "turn_completed");
    const responses = (await waitForRecord(session, "responses.jsonl")) as Array<{
      behavior: string;
      updatedInput: Record<string, unknown> | null;
    }>;
    expect(responses[0]?.behavior).toBe("allow");
    expect(responses[0]?.updatedInput).toEqual({ command: "echo hi", description: "say hi" });
    send(session.driver, { type: "shutdown" });
    expect(await session.code).toBe(0);
  });

  test("an unimplemented control request is answered with an error, not left hanging (review live18)", async () => {
    // Correctness 5: a control_request other than can_use_tool passed
    // through as unknown and got no reply, so the harness blocked until
    // --turn-timeout or the end. It is now answered with the control
    // protocol's error response, mirrored raw, and reported non-fatal.
    const session = await startSession();
    send(session.driver, { type: "user", text: "scenario:ctlreq go" });
    const completed = await waitFor(session.events, of("turn_completed"), "turn_completed");
    expect(completed.finish).toBe("end");
    const answers = (await waitForRecord(session, "control-errors.jsonl")) as Event[];
    expect(answers[0]?.request_id).toBe("ctl_1");
    expect(answers[0]?.error).toContain("hook_callback");
    const mirrored = session.events.find(
      (event) => event.type === "unknown" && String(event.raw).includes("hook_callback")
    );
    expect(mirrored).toBeDefined();
    const warning = session.events.find((event) => event.type === "error");
    expect(warning?.fatal).toBe(false);
    expect(warning?.message).toContain("hook_callback");
    send(session.driver, { type: "shutdown" });
    expect(await session.code).toBe(0);
  });

  test("an interrupt sent before init is delivered once the forwarded turn opens (review live18)", async () => {
    // Correctness 4: the user line was forwarded at once, but the
    // interrupt that followed it before system/init found no active turn
    // and was an acknowledged no-op, so the turn ran to completion.
    const session = await startSession();
    send(session.driver, { type: "user", text: "scenario:wait hold" });
    send(session.driver, { type: "interrupt" });
    const completed = await waitFor(session.events, of("turn_completed"), "turn_completed");
    expect(session.events.filter((event) => event.type === "input_accepted")).toHaveLength(2);
    expect(completed.turn_id).toBe("t1");
    expect(completed.finish).toBe("interrupted");
    const interrupts = fakeRecord(session, "interrupts.jsonl") as Event[];
    expect(interrupts.map((entry) => entry.request_id)).toEqual(["interrupt-1"]);
    send(session.driver, { type: "shutdown" });
    expect(await session.code).toBe(0);
  });

  test("only exit 1 after an interrupted drained turn is excused (review live18)", async () => {
    // Correctness 6: any drained completion excused every nonzero exit.
    // The convention is exit 1 after an INTERRUPTED turn; exit 1 after a
    // clean completion, and exit 2 after an interrupted one, both cost
    // success now.
    const clean = await startSession({}, { FAKE_SIGTERM_PERSIST: "1" });
    send(clean.driver, { type: "user", text: "scenario:race go" });
    await waitFor(clean.events, of("assistant_message"), "assistant_message");
    send(clean.driver, { type: "shutdown" });
    const cleanEnded = await waitFor(clean.events, of("session_ended"), "session_ended");
    expect(cleanEnded.exit_code).toBe(1);
    expect(of("turn_completed")(clean.events)?.finish).toBe("end");
    expect(await clean.code).toBe(1);
    expect(clean.events.find((event) => event.type === "error" && event.fatal)?.message).toBe(
      "the claude process exited with code 1 during the shutdown drain"
    );

    const two = await startSession({}, { FAKE_SIGTERM_PERSIST: "exit2" });
    send(two.driver, { type: "user", text: "scenario:wait hold" });
    await waitFor(two.events, of("assistant_message"), "assistant_message");
    send(two.driver, { type: "shutdown" });
    const twoEnded = await waitFor(two.events, of("session_ended"), "session_ended");
    expect(twoEnded.exit_code).toBe(1);
    expect(of("turn_completed")(two.events)?.finish).toBe("interrupted");
    expect(await two.code).toBe(1);
  });

  test("an allow whose frame cannot fit is rejected before the ack and stays pending (review live18)", async () => {
    // Minor: the allow frame's size was never checked, so an
    // updated_input near the line cap was acked accepted and then refused
    // by the write, crashing the session.
    const session = await startSession({ permissionTimeoutMs: 60_000 });
    send(session.driver, { type: "user", text: "scenario:ask big" });
    const request = await waitFor(session.events, of("permission_request"), "permission_request");
    send(session.driver, {
      type: "permission_decision",
      request_id: request.request_id,
      decision: "allow",
      updated_input: { command: "x".repeat(17 * 1024 * 1024) },
    });
    const rejected = await waitFor(session.events, of("input_rejected"), "input_rejected");
    expect(rejected.reason).toBe("text_too_long");
    expect(session.events.find((event) => event.type === "permission_resolved")).toBeUndefined();
    send(session.driver, { type: "permission_decision", request_id: request.request_id, decision: "deny" });
    const resolved = await waitFor(session.events, of("permission_resolved"), "permission_resolved");
    expect(resolved.resolution).toBe("deny");
    await waitFor(session.events, of("turn_completed"), "turn_completed");
    send(session.driver, { type: "shutdown" });
    expect(await session.code).toBe(0);
  });

  test("a stdin error after session_ended adds no event after it (review live18)", async () => {
    // Minor: handleCallerEnd had no settled guard, so a read error during
    // the final flush emitted an error event after session_ended.
    const session = await startSession();
    send(session.driver, { type: "user", text: "scenario:basic one" });
    await waitFor(session.events, of("turn_completed"), "turn_completed");
    send(session.driver, { type: "shutdown" });
    expect(await session.code).toBe(0);
    const count = session.events.length;
    session.driver.handleCallerEnd(new Error("EIO: late"));
    await Bun.sleep(50);
    expect(session.events).toHaveLength(count);
    expect(session.events[count - 1]?.type).toBe("session_ended");
  });
});
