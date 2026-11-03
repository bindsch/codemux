/** Driver e2e tests for the opencode session, stream-tier split (from
 * tests/session-opencode-e2e.test.ts): the tier-3 garbage line and the
 * tier-2 foreign-session and missing-field fatals. */

import { afterAll, describe, expect, test } from "bun:test";
import {
  cleanups,
  of,
  send,
  startSession,
  waitFor,
  type Event
} from "./helpers/session-opencode-e2e.js";

afterAll(async () => {
  for (const clean of cleanups.reverse()) await clean();
});

describe("opencode session e2e - stream tiers", () => {
  test("a non-JSON line is a tier-3 fatal crash", async () => {
    const session = await startSession();
    send(session.driver, { type: "user", text: "scenario:garbage junk" });
    await waitFor(
      session.events,
      (events) => events.find((event) => event.type === "error" && event.fatal === true),
      "the fatal error"
    );
    expect(await session.code).toBe(1);
    const ended = session.events[session.events.length - 1] as Event;
    expect(ended.type).toBe("session_ended");
    expect(ended.reason).toBe("harness_failed");
  });

  test("a line naming a foreign session is a tier-2 fatal with the raw preserved", async () => {
    const session = await startSession();
    send(session.driver, { type: "user", text: "scenario:basic one" });
    await waitFor(session.events, of("turn_completed"), "turn_completed");
    send(session.driver, { type: "user", text: "scenario:wrongid two" });
    const unknown = await waitFor(
      session.events,
      (events) =>
        events.find(
          (event) =>
            event.type === "unknown" &&
            typeof event.raw === "string" &&
            event.raw.includes("ses_other123456789")
        ),
      "the raw passthrough"
    );
    expect(unknown.session_id).toBe("ses_fake1234567890");
    const error = await waitFor(
      session.events,
      (events) => events.find((event) => event.type === "error" && event.fatal === true),
      "the fatal error"
    );
    expect(error.message).toContain("ses_other123456789");
    expect(await session.code).toBe(1);
  });

  test("a line without a sessionID is a tier-2 fatal", async () => {
    const session = await startSession();
    send(session.driver, { type: "user", text: "scenario:nosession probe" });
    const error = await waitFor(
      session.events,
      (events) => events.find((event) => event.type === "error" && event.fatal === true),
      "the fatal error"
    );
    expect(error.message).toContain("carries no sessionID");
    expect(await session.code).toBe(1);
  });

  test("a line without a type is a tier-2 fatal", async () => {
    const session = await startSession();
    send(session.driver, { type: "user", text: "scenario:notype probe" });
    const error = await waitFor(
      session.events,
      (events) => events.find((event) => event.type === "error" && event.fatal === true),
      "the fatal error"
    );
    expect(error.message).toContain("carries no type");
    // The line's session id validated, so the fatal events name this
    // session and the record makes it resumable (review round 42): before,
    // a payload grammar error on a fresh session's first line left the
    // session id empty and the session unrecorded.
    expect(error.session_id).toBe("ses_fake1234567890");
    expect(await session.code).toBe(1);
    const ended = session.events[session.events.length - 1] as Event;
    expect(ended.type).toBe("session_ended");
    expect(ended.session_id).toBe("ses_fake1234567890");
    expect(ended.resumable).toBe(true);
  });
});
