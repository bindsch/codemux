/**
 * Codex sessions whose turn completes before the turn/start response that
 * names it (review rounds 232 to 241): the lifecycle notifications carry
 * the provisional id, the late response names a closed turn and is
 * consumed, a response naming a never-seen turn crashes, and a late error
 * response changes nothing. The round-401 test below covers the sibling
 * window: a turn the turn/start response refused. Split from
 * tests/session-codex-e2e-review.test.ts at the 500-line cap.
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

  test("a second interrupt queued in the turn/start window is reported dropped by its input_seq (round 391)", async () => {
    // Round 341 made the queued interrupt's fate reported; a second
    // interrupt arriving in the same window used to overwrite the recorded
    // seq, so the first acked interrupt's fate was never reported again.
    // Every acked interrupt is now answered: the queued one keeps its place
    // and its late-drop notice, and the second is answered at once as
    // dropped, named by its own input_seq.
    const message = (event: unknown) => String((event as { message?: unknown } | undefined)?.message);
    const session = await startAndWait();
    send(session.driver, { type: "user", text: "scenario:earlydone one" });
    send(session.driver, { type: "interrupt" });
    send(session.driver, { type: "interrupt" });
    const first = await waitFor(
      session.events,
      (events) => events.find((event) => event.type === "turn_completed" && event.turn_id === "t1"),
      "turn_completed t1"
    );
    expect(first.finish).toBe("end");
    // The second interrupt (input_seq 3) is answered at once as dropped.
    const second = session.events.find(
      (event) => event.type === "error" && message(event).includes("a second interrupt") && message(event).includes("input_seq 3")
    );
    expect(message(second)).toContain("was dropped");
    // The first (input_seq 2) keeps its place: the early completion reports
    // it too, the round-341 notice.
    const notice = session.events.find(
      (event) =>
        event.type === "error" &&
        message(event).includes("the interrupt accepted while the turn was starting (input_seq 2)")
    );
    expect(message(notice)).toContain("was dropped");
    // The session continues: the held response is consumed and the next
    // turn runs and ends cleanly.
    send(session.driver, { type: "user", text: "scenario:basic two" });
    const next = await waitFor(
      session.events,
      (events) => events.find((event) => event.type === "turn_completed" && event.turn_id === "t2"),
      "turn_completed t2"
    );
    expect(next.finish).toBe("end");
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

describe("codex session e2e - review round 401", () => {
  test("a turn refused by its turn/start response keeps its provisional id for stragglers (round 401, item 3)", async () => {
    // A delta names the provisional id while the turn/start response is
    // still in flight; the response then refuses the turn. The failed
    // turn used to close without adopting that id, so the stragglers
    // that arrive after the NEXT turn is named were judged against the
    // new turn's id and killed the session as a grammar violation. The
    // refusal now adopts the id the way the early completion does, and
    // the stragglers land as that closed turn's own.
    const session = await startAndWait();
    send(session.driver, { type: "user", text: "scenario:failstartlaggard one" });
    const first = await waitFor(
      session.events,
      (events) => events.find((event) => event.type === "turn_completed" && event.turn_id === "t1"),
      "turn_completed t1"
    );
    expect(first.finish).toBe("failed");
    // The next turn is named, then the refused turn's straggler delta and
    // usage arrive naming the old id.
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
});
