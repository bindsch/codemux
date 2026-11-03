import { afterAll, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanups, of, send, startSession, waitFor, workRoot } from "./helpers/session-e2e.js";
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
  test("turn timeout interrupts the turn and the session continues", async () => {
    const session = await startSession({ turnTimeoutMs: 200 });
    send(session.driver, { type: "user", text: "scenario:wait slow turn" });
    await waitFor(session.events, of("session_started"), "session_started");
    await waitFor(session.events, of("assistant_message"), "assistant_message");
    const completed = await waitFor(
      session.events,
      (events) => events.find((event) => event.type === "turn_completed"),
      "timed-out turn_completed",
      5_000
    );
    expect(completed.finish).toBe("interrupted");
    expect(completed.reason).toBe("turn-timeout");
    // The session survives: another turn runs to completion.
    send(session.driver, { type: "user", text: "scenario:basic still alive" });
    const second = await waitFor(
      session.events,
      (events) => events.filter((event) => event.type === "turn_completed")[1],
      "second turn_completed"
    );
    expect(second.finish).toBe("end");
    send(session.driver, { type: "shutdown" });
    await waitFor(session.events, of("session_ended"), "session_ended");
  });

  test("the session timeout ends the session with reason timeout and exit 1", async () => {
    // The fake answers the init frame only after the first user line, so
    // the line goes first. A timer that fires before that frame ends a
    // harness still running the forwarded line, which has to be stopped
    // by signal, and that end is the harness's failure by design (review
    // live25); on a loaded machine the fake's startup once outlasted a
    // 250 ms timer (release gate, 2026-11-02). The timer therefore gives
    // the started session and its open turn room, and the test waits for
    // both before the end.
    const session = await startSession({ sessionTimeoutMs: 2_000 });
    send(session.driver, { type: "user", text: "scenario:wait long" });
    await waitFor(session.events, of("session_started"), "session_started");
    await waitFor(session.events, of("assistant_message"), "assistant_message");
    const ended = await waitFor(
      session.events,
      (events) => events.find((event) => event.type === "session_ended"),
      "session_ended",
      8_000
    );
    expect(ended.reason).toBe("timeout");
    expect(await session.code).toBe(1);
  }, 15_000);

  test("a harness crash is a fatal error and exit 1, resumable", async () => {
    const session = await startSession();
    send(session.driver, { type: "user", text: "scenario:crash boom" });
    await waitFor(session.events, of("session_started"), "session_started");
    const error = await waitFor(
      session.events,
      (events) => events.find((event) => event.type === "error" && event.fatal),
      "fatal error"
    );
    expect(error.source).toBe("harness");
    const ended = await waitFor(session.events, of("session_ended"), "session_ended");
    expect(ended.reason).toBe("harness_failed");
    expect(ended.resumable).toBe(true);
    expect(await session.code).toBe(1);
  });

  test("a registry start-write failure ends the session as a codemux failure, not a harness one", async () => {
    // A regular file where the registry's directory chain needs one: the
    // record fails, and §4.8 says an untracked live session must not run.
    // The failure is codemux's (an EPERM'd home behaves the same way) and
    // must never be recast as unusable harness output — the record runs
    // from inside the harness-line handler (found live on 2026-10-05,
    // where a denied ~/Library produced "invalid-utf8" for a valid line).
    const blocker = join(workRoot(), "registry-blocker");
    writeFileSync(blocker, "not a directory");
    const session = await startSession({
      registryPath: join(blocker, "reg", "live-sessions.json"),
    });
    send(session.driver, { type: "user", text: "scenario:basic hello" });
    const error = await waitFor(
      session.events,
      (events) => events.find((event) => event.type === "error" && event.fatal),
      "fatal error"
    );
    expect(error.source).toBe("codemux");
    expect(error.message).toContain("cannot record the session in the registry");
    const ended = await waitFor(session.events, of("session_ended"), "session_ended");
    expect(ended.reason).toBe("crash");
    expect(await session.code).toBe(1);
    // The session never started, so nothing was vouchable.
    expect(session.events.some((event) => event.type === "session_started")).toBe(false);
  });

  test("a driver exception on a harness line is a codemux fatal, never unusable harness output", async () => {
    // The class the handler fatal exists for: an unexpected throw while
    // processing a harness line (injected here through the private
    // recordStart — the seam the live EPERM actually threw from) must end
    // the session as codemux's own failure with the real message, and
    // the end path must still run.
    const session = await startSession();
    (session.driver as unknown as { recordStart: () => void }).recordStart = () => {
      throw new Error("driver bug");
    };
    send(session.driver, { type: "user", text: "scenario:basic hello" });
    const error = await waitFor(
      session.events,
      (events) => events.find((event) => event.type === "error" && event.fatal),
      "fatal error"
    );
    expect(error.source).toBe("codemux");
    expect(error.message).toContain("internal error while processing a harness line");
    expect(error.message).toContain("driver bug");
    expect(error.message).not.toContain("unusable harness output");
    const ended = await waitFor(session.events, of("session_ended"), "session_ended");
    expect(ended.reason).toBe("crash");
    expect(await session.code).toBe(1);
  });

  test("a non-JSON harness line is a tier-3 fatal", async () => {
    const session = await startSession();
    send(session.driver, { type: "user", text: "scenario:garbage junk" });
    await waitFor(session.events, of("session_started"), "session_started");
    const error = await waitFor(
      session.events,
      (events) => events.find((event) => event.type === "error" && event.fatal),
      "tier-3 fatal"
    );
    expect(error.message).toContain("unusable harness output");
    const ended = await waitFor(session.events, of("session_ended"), "session_ended");
    expect(ended.reason).toBe("crash");
    expect(await session.code).toBe(1);
  });

  test("a grammar violation preserves the raw event, then ends fatally (tier 2)", async () => {
    const session = await startSession();
    send(session.driver, { type: "user", text: "scenario:wrongsession drift" });
    await waitFor(session.events, of("session_started"), "session_started");
    const unknown = await waitFor(
      session.events,
      (events) =>
        events.find((event) => event.type === "unknown" && String(event.raw).includes("wrong session")),
      "unknown passthrough"
    );
    expect(unknown.raw).toContain("wrong session");
    const error = await waitFor(
      session.events,
      (events) => events.find((event) => event.type === "error" && event.fatal),
      "tier-2 fatal"
    );
    expect(error.source).toBe("harness");
    expect(error.message).toContain("session id");
    const ended = await waitFor(session.events, of("session_ended"), "session_ended");
    expect(ended.reason).toBe("crash");
    expect(await session.code).toBe(1);
  });

  test("a line the session state rejects still goes out raw before the fatal (review live21)", async () => {
    // Tier 2 keeps the raw event (§4.2). The FSM-rejected lines — a
    // duplicate permission request id here, a refused resume's early
    // result in the CLI test — were reported but never mirrored.
    const session = await startSession({ permissionTimeoutMs: 60_000 });
    send(session.driver, { type: "user", text: "scenario:dupask" });
    const ended = await waitFor(session.events, of("session_ended"), "session_ended");
    expect(ended.reason).toBe("crash");
    expect(await session.code).toBe(1);
    const fatal = session.events.find((event) => event.type === "error" && event.fatal === true);
    expect(fatal?.message).toBe("duplicate permission request id toolu_dup_1");
    const mirrored = session.events.filter(
      (event) => event.type === "unknown" && String(event.raw).includes("echo two")
    );
    expect(mirrored).toHaveLength(1);
    expect(mirrored[0]!.seq).toBe(fatal!.seq - 1);
  });
});
