/** Claude-family driver tests for the pre-init window: caller lines that
 * are accepted before the harness's first init frame and the end paths
 * that begin before that frame arrives. The fake sends nothing at spawn,
 * so the window is deterministic — no sleep races the fake's first line. */

import { afterAll, describe, expect, test } from "bun:test";
import { cleanups, of, send, startSession, waitFor, type Event } from "./helpers/session-e2e.js";

afterAll(async () => {
  for (const clean of cleanups.reverse()) await clean();
});

describe("claude-family driver - input accepted before the init frame", () => {
  test("an interrupt parked on a pre-init line is reported dropped when the session ends before init", async () => {
    // Review round 372, item 3: the end path cleared interruptBeforeInit
    // silently, so the caller held an ack for an interrupt whose fate was
    // never reported — against the every-acked-line-is-answered contract
    // (§4.1) that the sibling paths honor (the openerPending notice, the
    // init-time delivery failure, the codex driver's late-interrupt
    // drop). The user line below is forwarded while the FSM is still
    // `starting`, the interrupt parks on it (input_seq 2), and the stdin
    // close begins the end before any init frame arrived.
    const session = await startSession();
    send(session.driver, { type: "user", text: "scenario:wait hold" });
    send(session.driver, { type: "interrupt" });
    session.driver.handleCallerEnd();
    const notice = await waitFor(
      session.events,
      (events) =>
        events.find(
          (event) =>
            event.type === "error" &&
            event.fatal === false &&
            event.message.includes("input_seq 2") &&
            event.message.includes("was dropped")
        ),
      "the interrupt-dropped notice"
    );
    expect(notice.source).toBe("codemux");
    expect(notice.message).toContain("the interrupt accepted before the session started");
    expect(await session.code).toBe(0);
    const ended = session.events[session.events.length - 1] as Event;
    expect(ended.type).toBe("session_ended");
    expect(ended.reason).toBe("stdin-close");
    // Both accepted lines were acked before the end began.
    expect(session.events.filter((event) => event.type === "input_accepted")).toHaveLength(2);
    // The openerPending notice answered the user line; the interrupt
    // notice follows it, in arrival order.
    const notices = session.events.filter(
      (event) => event.type === "error" && event.fatal === false && event.source === "codemux"
    );
    expect(notices.map((event) => event.message)).toEqual([
      expect.stringContaining("user input accepted before the session started"),
      expect.stringContaining("the interrupt accepted before the session started"),
    ]);
    // Nothing turned the acked interrupt into a turn: no turn ever opened.
    expect(of("turn_started")(session.events)).toBeUndefined();
  });
});
