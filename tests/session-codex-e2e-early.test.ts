/**
 * Codex sessions whose turn completes before the turn/start response that
 * names it (review rounds 232 to 241): the lifecycle notifications carry
 * the provisional id, the late response names a closed turn and is
 * consumed, a response naming a never-seen turn crashes, and a late error
 * response changes nothing. Split from tests/session-codex-e2e-review.test.ts
 * at the 500-line cap.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { cleanupMark, cleanupSessions, cleanupSessionsSince, of, send, startAndWait, waitFor } from "./session-codex-e2e-helpers.js";
import { registerNoLeakedSignals } from "./helpers/signal-listeners.js";

afterAll(cleanupSessions);
registerNoLeakedSignals(cleanupSessionsSince, cleanupMark);

describe("codex session e2e - review round 232", () => {
  test("a turn that completes before its turn/start response keeps the session and the next turn runs", async () => {
    // Correctness major: a fast server runs the whole lifecycle —
    // turn/started, the agentMessage, turn/completed — before the
    // turn/start response that names the turn. The lifecycle
    // notifications used to reject the provisional id the deltas
    // accepted, and the first turn/started ended the session on the
    // crash path. They now accept it the way a delta does, the
    // completion adopts it so its stragglers stay recognized, and the
    // late response finds its codemux turn closed and is consumed.
    const session = await startAndWait();
    send(session.driver, { type: "user", text: "scenario:earlydone one" });
    const first = await waitFor(
      session.events,
      (events) => events.find((event) => event.type === "turn_completed" && event.turn_id === "t1"),
      "turn_completed t1"
    );
    expect(first.finish).toBe("end");
    const message = session.events.find((event) => event.type === "assistant_message");
    expect(message?.text).toBe("Early.");
    send(session.driver, { type: "user", text: "scenario:basic two" });
    const second = await waitFor(
      session.events,
      (events) => events.find((event) => event.type === "turn_completed" && event.turn_id === "t2"),
      "turn_completed t2"
    );
    expect(second.finish).toBe("end");
    expect(session.events.find((event) => event.type === "error")).toBeUndefined();
    send(session.driver, { type: "shutdown" });
    await waitFor(session.events, of("session_ended"), "session_ended");
    expect(await session.code).toBe(0);
  });

  test("an interrupt acked while turn/start was in flight is not dropped silently by the early completion (round 341)", async () => {
    // The interrupt lands between the turn/start write and the lifecycle
    // notifications, so it is queued to ride the response and acked. The
    // turn then completes before that response, and the queued interrupt
    // can never be delivered: the caller now hears the drop named by its
    // input_seq — the same notice the sibling drop paths emit — instead
    // of an acked line whose fate is never reported again.
    const session = await startAndWait();
    send(session.driver, { type: "user", text: "scenario:earlydone one" });
    send(session.driver, { type: "interrupt" });
    const first = await waitFor(
      session.events,
      (events) => events.find((event) => event.type === "turn_completed" && event.turn_id === "t1"),
      "turn_completed t1"
    );
    expect(first.finish).toBe("end");
    const notice = session.events.find(
      (event) =>
        event.type === "error" &&
        String((event as { message?: unknown }).message).includes(
          "the interrupt accepted while the turn was starting (input_seq 2)"
        )
    );
    expect(String((notice as { message?: unknown } | undefined)?.message)).toContain("was dropped");
    // The session continues: the late response is consumed and the next
    // turn runs and ends cleanly.
    send(session.driver, { type: "user", text: "scenario:basic two" });
    const second = await waitFor(
      session.events,
      (events) => events.find((event) => event.type === "turn_completed" && event.turn_id === "t2"),
      "turn_completed t2"
    );
    expect(second.finish).toBe("end");
    send(session.driver, { type: "shutdown" });
    await waitFor(session.events, of("session_ended"), "session_ended");
    expect(await session.code).toBe(0);
  });

  test("a late turn/start response naming a turn the session never saw complete crashes the session (review round 235)", async () => {
    // The turn completed inside the window under its provisional id, so
    // the pending id is gone when the response lands; the closed set is
    // what the response is checked against, and a response naming
    // another turn is the round-67 contradiction, not a consumed reply.
    const session = await startAndWait();
    send(session.driver, { type: "user", text: "scenario:earlyother one" });
    const error = await waitFor(
      session.events,
      (events) => events.find((event) => event.type === "error"),
      "error event"
    );
    expect(String((error as { message?: unknown }).message)).toContain("never saw complete");
    const ended = await waitFor(session.events, of("session_ended"), "session_ended");
    expect((ended as { reason?: unknown }).reason).toBe("crash");
    expect(await session.code).not.toBe(0);
  });

  test("a late turn/start response is consumed even after the next turn's notifications began (review round 238)", async () => {
    // Turn one completes early and its response is held; turn two's first
    // delta lands first, so the provisional id is turn two's when the old
    // response is read. The response names a closed turn and is consumed;
    // comparing it with the pending id would have crashed the session.
    const session = await startAndWait();
    send(session.driver, { type: "user", text: "scenario:earlyhold one" });
    const first = await waitFor(
      session.events,
      (events) => events.find((event) => event.type === "turn_completed" && event.turn_id === "t1"),
      "turn_completed t1"
    );
    expect(first.finish).toBe("end");
    send(session.driver, { type: "user", text: "scenario:basic two" });
    const second = await waitFor(
      session.events,
      (events) => events.find((event) => event.type === "turn_completed" && event.turn_id === "t2"),
      "turn_completed t2"
    );
    expect(second.finish).toBe("end");
    expect(session.events.find((event) => event.type === "error")).toBeUndefined();
    send(session.driver, { type: "shutdown" });
    await waitFor(session.events, of("session_ended"), "session_ended");
    expect(await session.code).toBe(0);
  });

  test("a late error response for a turn that already completed changes nothing (review round 241)", async () => {
    // The request's turn completed through its notifications and the next
    // turn is already open when the error lands: failing the open turn
    // would fail a turn the harness still runs. The late refusal is
    // recorded as an unknown line and the session goes on.
    const session = await startAndWait();
    send(session.driver, { type: "user", text: "scenario:earlyerror one" });
    send(session.driver, { type: "user", text: "scenario:basic two" });
    const first = await waitFor(
      session.events,
      (events) => events.find((event) => event.type === "turn_completed" && event.turn_id === "t1"),
      "turn_completed t1"
    );
    expect(first.finish).toBe("end");
    const second = await waitFor(
      session.events,
      (events) => events.find((event) => event.type === "turn_completed" && event.turn_id === "t2"),
      "turn_completed t2"
    );
    expect(second.finish).toBe("end");
    expect(session.events.find((event) => event.type === "error")).toBeUndefined();
    send(session.driver, { type: "shutdown" });
    await waitFor(session.events, of("session_ended"), "session_ended");
    expect(await session.code).toBe(0);
  });

  test("a scoped notification for a turn nobody started is refused in the idle gap after an early completion (review round 247)", async () => {
    // The completed turn's request is still unanswered; it must not keep
    // the idle session inside the turn/start window, or a usage frame for
    // a turn that never existed would be folded into the totals.
    const session = await startAndWait();
    send(session.driver, { type: "user", text: "scenario:earlystray one" });
    const error = await waitFor(
      session.events,
      (events) => events.find((event) => event.type === "error"),
      "error event"
    );
    expect(String((error as { message?: unknown }).message)).toContain("turn-never-started");
    const ended = await waitFor(session.events, of("session_ended"), "session_ended");
    expect((ended as { reason?: unknown }).reason).toBe("crash");
    expect(await session.code).not.toBe(0);
  });
});
