/** Driver e2e tests for the opencode session, honest-false-capabilities
 * split (from tests/session-opencode-e2e.test.ts): unsupported input
 * types and mid-turn user lines are rejected by name. */

import { afterAll, describe, expect, test } from "bun:test";
import { cleanups, of, send, startSession, waitFor } from "./helpers/session-opencode-e2e.js";

afterAll(async () => {
  for (const clean of cleanups.reverse()) await clean();
});

describe("opencode session e2e - honest false capabilities", () => {
  test("mid-turn and unsupported inputs are rejected by name, never silently ignored", async () => {
    const session = await startSession();
    send(session.driver, { type: "user", text: "scenario:basic one" });
    await waitFor(session.events, of("turn_completed"), "turn_completed");
    send(session.driver, { type: "steer", text: "go west" });
    send(session.driver, { type: "interrupt" });
    send(session.driver, {
      type: "permission_decision",
      request_id: "r1",
      decision: "allow",
    });
    const rejections = await waitFor(
      session.events,
      (events) =>
        events.filter((event) => event.type === "input_rejected").length >= 2
          ? events.filter((event) => event.type === "input_rejected")
          : undefined,
      "the two rejections"
    );
    expect(rejections.map((event) => [event.input_seq, event.reason])).toEqual([
      [2, "unsupported"],
      [4, "unsupported"],
    ]);
    send(session.driver, { type: "shutdown" });
    expect(await session.code).toBe(0);
  });

  test("a user line mid-turn is rejected busy — turns serialize", async () => {
    const session = await startSession();
    send(session.driver, { type: "user", text: "scenario:wait hold" });
    await waitFor(session.events, of("turn_started"), "turn_started");
    send(session.driver, { type: "user", text: "scenario:basic two" });
    const rejection = await waitFor(
      session.events,
      (events) => events.find((event) => event.type === "input_rejected"),
      "the busy rejection"
    );
    expect(rejection.reason).toBe("busy");
    expect(rejection.input_seq).toBe(2);
    session.driver.handleCallerEnd();
    expect(await session.code).toBe(1);
  });
});
