/**
 * Driver e2e for the kimi session (design §4.7): the stream tiers' fatal
 * paths — tier-3 unusable output, tier-2 grammar errors, foreign-id
 * hints, and the fatals after a valid hint or after a crash end began.
 * Split from tests/session-kimi-e2e.test.ts; the rig is tests/helpers/
 * session-kimi-e2e.ts.
 */

import { afterAll, describe, expect, test } from "bun:test";
import {
  cleanups,
  of,
  send,
  startSession,
  waitFor,
  type Event,
  ID,
  OTHER,
} from "./helpers/session-kimi-e2e.js";

afterAll(async () => {
  for (const clean of cleanups) await clean();
});

describe("kimi session e2e - stream tiers", () => {
  test("a non-JSON line is a tier-3 fatal crash", async () => {
    const session = await startSession();
    send(session.driver, { type: "user", text: "scenario:garbage junk" });
    const error = await waitFor(
      session.events,
      (events) => events.find((event) => event.type === "error" && event.fatal === true),
      "the fatal error"
    );
    expect(error.message).toContain("unusable harness output (not JSON");
    expect(await session.code).toBe(1);
    // session_ended arrives asynchronously after the events awaited above.
    const ended = await waitFor(session.events, of("session_ended"), "session_ended");
    expect(ended.reason).toBe("harness_failed");
  });

  test("a hint naming a foreign session on a fresh session's second turn is a tier-2 fatal with the raw preserved", async () => {
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
            event.raw.includes(OTHER)
        ),
      "the raw passthrough"
    );
    expect(unknown.session_id).toBe(ID);
    const error = await waitFor(
      session.events,
      (events) => events.find((event) => event.type === "error" && event.fatal === true),
      "the fatal error"
    );
    expect(error.message).toContain(OTHER);
    expect(error.message).toContain(ID);
    expect(await session.code).toBe(1);
    // The foreign hint withdraws the confirmation the first turn's hint
    // earned (round al11's re-review, edges 3): the store that answered
    // named another session, so the crash must not end resumable —
    // before the fix the stale confirmation kept resumable:true, telling
    // a retrying caller one more --resume could work.
    // session_ended arrives asynchronously after the events awaited above.
    const ended = await waitFor(session.events, of("session_ended"), "session_ended");
    expect(ended.reason).toBe("crash");
    expect(ended.resumable).toBe(false);
  });

  test("a resumed session whose first hint names a foreign id is fatal and never rebound (al2)", async () => {
    // The seam this pins: a session resumed with a registry-vouched id
    // must not adopt a different id from a resume hint — kimi starting a
    // fresh session instead of resuming would otherwise rebind the record
    // and every later turn to an id the caller never chose. In this
    // resumed-session shape the refusal is the PARSER's mismatch check
    // (parseKimiStreamLine's knownSessionId: a hint naming another id is
    // a grammar_error, fatal on arrival); the driver's adoptSessionId is
    // the checked-invariant backup for the fresh-session arm and never
    // runs here (round al23 corrects this comment's earlier credit).
    // End to end: fatal naming both ids, exit 1, one session_started
    // carrying the resumed id throughout.
    const session = await startSession({ resumeSessionId: ID });
    // The resumed identity is announced before any turn.
    const started = await waitFor(session.events, of("session_started"), "session_started");
    expect(started.session_id).toBe(ID);
    send(session.driver, { type: "user", text: "scenario:wrongid one" });
    const error = await waitFor(
      session.events,
      (events) => events.find((event) => event.type === "error" && event.fatal === true),
      "the fatal error"
    );
    expect(error.message).toContain(OTHER);
    expect(error.message).toContain(ID);
    expect(await session.code).toBe(1);
    // session_ended arrives asynchronously after the events awaited above.
    const ended = await waitFor(session.events, of("session_ended"), "session_ended");
    expect(ended.reason).toBe("crash");
    // Never rebound: the one session_started is the resumed id, and no
    // second announcement ever carried the foreign one.
    const starts = session.events.filter((event) => event.type === "session_started");
    expect(starts).toHaveLength(1);
    expect(starts[0]!.session_id).toBe(ID);
  });

  test("a malformed hint, a tool line without an id, and an empty assistant line are tier-2 fatals", async () => {
    for (const [scenario, phrase] of [
      ["badhint", "a resume hint carries an invalid session id"],
      ["notoolid", "a tool line carries no tool_call_id"],
      ["emptyassistant", "an assistant line carries neither content nor tool calls"],
    ] as const) {
      const session = await startSession();
      send(session.driver, { type: "user", text: `scenario:${scenario} probe` });
      const error = await waitFor(
        session.events,
        (events) => events.find((event) => event.type === "error" && event.fatal === true),
        `the ${scenario} fatal`
      );
      expect(error.message).toContain(phrase);
      expect(await session.code).toBe(1);
    }
  });

  test("a tier-2 fatal that fires mid-turn fails the turn, whatever the child's clean exit (al11 re-review)", async () => {
    // The reviewer's shape: an identified session, a second turn that
    // prints its assistant text and then a malformed hint, and a process
    // that exits 0 — the fatal ends the session while the child drains,
    // and before the fix completeTurn read that exit alone (0 with
    // assistant output) and reported the turn `end` after the caller had
    // just been told the harness output was fatally broken. The synthesis
    // owns the turn now: `failed`, carrying the fatal's own story.
    const session = await startSession();
    send(session.driver, { type: "user", text: "scenario:basic one" });
    await waitFor(session.events, of("turn_completed"), "first turn_completed");
    send(session.driver, { type: "user", text: "scenario:badhint two" });
    const completed = await waitFor(
      session.events,
      (events) => events.filter((event) => event.type === "turn_completed")[1],
      "the failed turn_completed"
    );
    expect(completed.turn_id).toBe("t2");
    expect(completed.finish).toBe("failed");
    expect(completed.reason).toContain("the session ended on a failure");
    expect(completed.reason).toContain("a resume hint carries an invalid session id");
    expect(await session.code).toBe(1);
    const ended = session.events[session.events.length - 1] as Event;
    expect(ended.reason).toBe("crash");
  });

  test("a fatal after a valid resume hint is never resumable, every fatal kind (round al20)", async () => {
    // Edges 1: handleFatal withdrew nothing, so a framing or I/O failure
    // that landed after the turn's hint confirmed the session kept the
    // confirmation standing and the crash ended resumable:true — a
    // retrying caller would be sent back into a store whose stream just
    // broke. Every fatal kind clears it now, the same withdrawal parsed
    // drift after a closing hint already earns (round al14) and a
    // foreign-id hint earns with it. "Every" means all four of
    // SessionFatalKind (process.ts): the claim covered only two until
    // round al21's trivial added invalid-utf8 and handler.
    const hint = JSON.stringify({
      role: "meta",
      type: "session.resume_hint",
      session_id: ID,
      command: `kimi -r ${ID}`,
      content: `To resume this session: kimi -r ${ID}`,
    });
    for (const [label, fatal, phrase] of [
      ["line-overflow", { kind: "line-overflow", excerpt: "giant line", bytes: 17_000_000 }, "unusable harness output (line-overflow"],
      ["invalid-utf8", { kind: "invalid-utf8", excerpt: "lossy \u{FFFD}", bytes: 3 }, "unusable harness output (invalid-utf8"],
      ["handler", { kind: "handler", error: new Error("boom in a line handler"), bytes: 40 }, "internal error while processing a harness line"],
      ["read-error", { kind: "read-error", error: new Error("EPIPE: broken pipe"), bytes: 0 }, "reading the harness's stdout failed"],
      ["write-error", { kind: "write-error", error: new Error("EPIPE: broken pipe"), bytes: 0 }, "writing the harness's stdin failed"],
    ] as const) {
      const session = await startSession();
      send(session.driver, { type: "user", text: "scenario:basic one" });
      await waitFor(session.events, of("turn_completed"), "first turn_completed");
      send(session.driver, { type: "user", text: "scenario:wait hold" });
      await waitFor(
        session.events,
        (events) => events.filter((event) => event.type === "turn_started")[1],
        "second turn_started"
      );
      // The turn's own closing hint, delivered the way the process layer
      // would deliver it: it confirms the session for this turn.
      session.driver.handleHarnessLine(hint);
      session.driver.handleFatal(fatal);

      const completed = await waitFor(
        session.events,
        (events) => events.filter((event) => event.type === "turn_completed")[1],
        `the failed turn_completed (${label})`
      );
      expect(completed.turn_id).toBe("t2");
      expect(completed.finish).toBe("failed");
      expect(completed.reason).toContain("the session ended on a failure before the turn completed");
      expect(completed.reason).toContain(phrase);
      expect(await session.code).toBe(1);
      // session_ended arrives asynchronously after the events awaited above.
      const ended = await waitFor(session.events, of("session_ended"), "session_ended");
      expect(ended.reason).toBe("harness_failed");
      // The regression's core: the hint had confirmed the session, and the
      // fatal must withdraw that confirmation — before the fix this read
      // true, vouching for a store whose stream just broke.
      expect(ended.resumable).toBe(false);
    }
  });

  test("harness output after a fatal's crash end began is never parsed (round al22)", async () => {
    // Edges 2: a tier-2 fatal's finish("crash") runs asynchronously, so
    // `settled` alone could not tell the drain window — where output is
    // owed — from the window between the fatal and its crash end
    // settling. Output parsed in that window emitted a post-fatal
    // assistant message and re-confirmed the session through a late hint,
    // and the crash ended resumable:true. The reviewer's repro exactly: a
    // malformed assistant frame, then a valid one, then the resume hint.
    const session = await startSession();
    send(session.driver, { type: "user", text: "scenario:basic one" });
    await waitFor(session.events, of("turn_completed"), "first turn_completed");
    send(session.driver, { type: "user", text: "scenario:postfatal two" });
    const error = await waitFor(
      session.events,
      (events) => events.find((event) => event.type === "error" && event.fatal === true),
      "the fatal error"
    );
    expect(error.message).toContain("an assistant line carries neither content nor tool calls");
    const completed = await waitFor(
      session.events,
      (events) => events.filter((event) => event.type === "turn_completed")[1],
      "the failed turn_completed"
    );
    expect(completed.turn_id).toBe("t2");
    expect(completed.finish).toBe("failed");
    expect(completed.reason).toContain("the session ended on a failure");
    expect(await session.code).toBe(1);
    // session_ended arrives asynchronously after the events awaited above.
    const ended = await waitFor(session.events, of("session_ended"), "session_ended");
    expect(ended.reason).toBe("crash");
    // The regression's core, both halves: no assistant message the fatal
    // already disowned (turn one's is the only one), and no late hint
    // re-confirming a session the fatal ended — before the fix both read
    // the other way.
    const texts = session.events
      .filter((event) => event.type === "assistant_message")
      .map((event) => event.text);
    expect(texts).toEqual(["Done: scenario:basic one"]);
    expect(ended.resumable).toBe(false);
  });
});
