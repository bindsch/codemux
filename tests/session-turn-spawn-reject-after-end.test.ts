/**
 * Review round 73, major 1: a turn-per-process spawn that rejects AFTER a
 * graceful end began (the caller's stdin EOF, a shutdown) is a failure,
 * never a silent absorption. The graceful end owes the accepted turn its
 * run (review D11); a spawn that rejects means that run can never happen,
 * so the turn's synthesized completion is failed — not interrupted — the
 * spawn error reaches the caller on a fatal error event, and the session
 * exits at least 1. The end path still owns the record and session_ended
 * ordering. One test per driver (opencode, aider). */

import { afterAll, expect, test } from "bun:test";
import * as opencode from "./helpers/session-opencode-e2e.js";
import * as aider from "./helpers/session-aider-e2e.js";

afterAll(async () => {
  for (const clean of opencode.cleanups.reverse()) await clean();
  for (const clean of aider.cleanups.reverse()) await clean();
});

/** One accepted turn whose spawn holds until the test releases it and
 * then rejects: the end begins while the spawn is in flight, exactly the
 * window the end path's await must answer for. */
function rejectingSpawn(): { spawnTurn: () => Promise<never>; release: () => void } {
  let release: (() => void) | null = null;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    spawnTurn: async (): Promise<never> => {
      await held;
      throw new Error("turn spawn blew up");
    },
    release: () => release!(),
  };
}

test("an opencode turn spawn rejecting after the caller's EOF fails the turn and the session (review round 73)", async () => {
  const rejection = rejectingSpawn();
  const session = await opencode.startSession({ spawnTurn: rejection.spawnTurn });
  opencode.send(session.driver, { type: "user", text: "scenario:basic one" });
  await opencode.waitFor(session.events, opencode.of("turn_started"), "turn_started");
  // The graceful end begins while the turn's spawn is still in flight.
  session.driver.handleCallerEnd();
  rejection.release();

  const completed = await opencode.waitFor(
    session.events,
    opencode.of("turn_completed"),
    "the synthesized turn_completed"
  );
  expect(completed.finish).toBe("failed");
  expect(completed.reason).toContain("could not spawn the opencode turn process");
  expect(completed.reason).toContain("turn spawn blew up");
  // The spawn error reaches the caller as a fatal error event, before
  // the synthesized completion and the end event.
  const events = session.events;
  const fatal = events.find((event) => event.type === "error" && event.fatal === true);
  expect(fatal).toBeDefined();
  expect(fatal!.message).toContain("could not spawn the opencode turn process");
  expect(events.indexOf(fatal!)).toBeLessThan(events.indexOf(completed));
  expect(await session.code).toBe(1);
  const ended = events[events.length - 1]!
  expect(ended!.type).toBe("session_ended");
  expect(ended!.exit_code).toBe(1);
  expect(events.filter((event) => event.type === "session_ended")).toHaveLength(1);
}, 20_000);

test("an aider turn spawn rejecting after the caller's EOF fails the turn and the session (review round 73)", async () => {
  const rejection = rejectingSpawn();
  const session = await aider.startSession({ spawnTurn: rejection.spawnTurn });
  aider.send(session.driver, { type: "user", text: "hello" });
  await aider.waitFor(session.events, aider.of("turn_started"), "turn_started");
  session.driver.handleCallerEnd();
  rejection.release();

  const completed = await aider.waitFor(
    session.events,
    aider.of("turn_completed"),
    "the synthesized turn_completed"
  );
  expect(completed.finish).toBe("failed");
  expect(completed.reason).toContain("could not spawn the aider turn process");
  expect(completed.reason).toContain("turn spawn blew up");
  const events = session.events;
  const fatal = events.find((event) => event.type === "error" && event.fatal === true);
  expect(fatal).toBeDefined();
  expect(fatal!.message).toContain("could not spawn the aider turn process");
  expect(events.indexOf(fatal!)).toBeLessThan(events.indexOf(completed));
  expect(await session.code).toBe(1);
  const ended = events[events.length - 1]!
  expect(ended!.type).toBe("session_ended");
  expect(ended!.exit_code).toBe(1);
  expect(events.filter((event) => event.type === "session_ended")).toHaveLength(1);
}, 20_000);
