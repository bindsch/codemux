/**
 * Driver e2e for the kimi session (design §4.7): the honest-false input
 * rules — unsupported shapes refused by name before the ack, the busy
 * serialization, the argv text bound, and the author prefix. Split from
 * tests/session-kimi-e2e.test.ts; the rig is tests/helpers/
 * session-kimi-e2e.ts.
 */

import { afterAll, describe, expect, test } from "bun:test";
import {
  cleanups,
  fakeRecord,
  of,
  send,
  startSession,
  waitFor,
} from "./helpers/session-kimi-e2e.js";

afterAll(async () => {
  for (const clean of cleanups) await clean();
});

describe("kimi session e2e - honest false capabilities", () => {
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
        events.filter((event) => event.type === "input_rejected").length >= 3
          ? events.filter((event) => event.type === "input_rejected")
          : undefined,
      "the three rejections"
    );
    expect(rejections.map((event) => [event.input_seq, event.reason])).toEqual([
      [2, "unsupported"],
      [3, "unsupported"],
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

  test("the /goal command and ! shape are rejected unsupported before the ack; every other /-leading text runs (al17)", async () => {
    const session = await startSession();
    send(session.driver, { type: "user", text: "/goal create ship it" });
    send(session.driver, { type: "user", text: "  !ls" });
    const rejections = await waitFor(
      session.events,
      (events) =>
        events.filter(
          (event) =>
            event.type === "input_rejected" && event.reason === "unsupported"
        ).length >= 2
          ? events.filter(
              (event) =>
                event.type === "input_rejected" && event.reason === "unsupported"
            )
          : undefined,
      "the two unsupported rejections"
    );
    expect(rejections.map((event) => event.input_seq)).toEqual([1, 2]);
    expect(fakeRecord(session, "argv.jsonl")).toHaveLength(0);

    // Every other /-leading text is model text in 0.31.1 (the al17
    // major: the al11 rule refused a path-like prompt outright), so it
    // runs its turn like any prompt.
    send(session.driver, { type: "user", text: "/tmp/notes.md please summarize" });
    const pathEcho = await waitFor(session.events, of("user_message"), "user_message");
    expect(pathEcho.text).toBe("/tmp/notes.md please summarize");
    const pathTurn = await waitFor(session.events, of("turn_completed"), "turn_completed");
    expect(pathTurn.finish).toBe("end");
    expect(fakeRecord(session, "prompts.jsonl")[0]!.text).toBe(
      "/tmp/notes.md please summarize"
    );

    // The author prefix sits ahead of the shape, so the same text under
    // one is model prompt text and runs.
    send(session.driver, { type: "user", text: "/goal here", author: "ana" });
    const echo = await waitFor(
      session.events,
      (events) => events.find((event) => event.type === "user_message" && event.text === "/goal here"),
      "user_message"
    );
    expect(echo).toBeDefined();
    const completed = await waitFor(
      session.events,
      (events) =>
        events.filter((event) => event.type === "turn_completed").length >= 2
          ? events.filter((event) => event.type === "turn_completed")[1]
          : undefined,
      "the second turn_completed"
    );
    expect(completed.finish).toBe("end");
    expect(fakeRecord(session, "prompts.jsonl")[1]!.text).toBe("[ana] /goal here");
    send(session.driver, { type: "shutdown" });
    expect(await session.code).toBe(0);
  });

  test("a text past the argv bound is rejected text_too_long before the ack", async () => {
    // The prompt rides `--prompt` on argv, so the run path's 32 KiB argv
    // bound — not the protocol's 16 MiB text bound — is the per-turn
    // cap, checked before the ack: an accepted line the turn process
    // cannot be handed would hang its turn open.
    const session = await startSession();
    send(session.driver, { type: "user", text: "scenario:basic one" });
    await waitFor(session.events, of("turn_completed"), "turn_completed");
    send(session.driver, { type: "user", text: "x".repeat(32 * 1024 + 1) });
    const rejected = await waitFor(
      session.events,
      (events) => events.find((event) => event.type === "input_rejected"),
      "the text_too_long rejection"
    );
    expect(rejected.reason).toBe("text_too_long");
    expect(session.events.filter((event) => event.type === "user_message")).toHaveLength(1);
    expect(fakeRecord(session, "argv.jsonl")).toHaveLength(1);
    send(session.driver, { type: "shutdown" });
    expect(await session.code).toBe(0);
  });

  test("a whitespace-only user text is rejected unsupported before the ack, so kimi's own refusal never runs (al22)", async () => {
    // The correctness major: the driver accepted a whitespace-only prompt
    // and launched its turn, but kimi's headless entry validates the
    // prompt before anything runs and refuses a blank one before a
    // session exists — no resume hint can close the turn, so a fresh
    // session died on the missing-id fatal (mocked repro: exit 1) instead
    // of telling the caller the line was refused. The refusal sits beside
    // the command-shape one now, judged before the ack: no turn is
    // launched for text the harness itself would refuse.
    const session = await startSession();
    send(session.driver, { type: "user", text: "   " });
    const rejected = await waitFor(
      session.events,
      (events) => events.find((event) => event.type === "input_rejected"),
      "the unsupported rejection"
    );
    expect(rejected.reason).toBe("unsupported");
    expect(rejected.input_seq).toBe(1);
    // Nothing launched: no spawn record, no prompt, and no turn or session
    // announcement exists to answer.
    expect(fakeRecord(session, "argv.jsonl")).toHaveLength(0);
    expect(fakeRecord(session, "prompts.jsonl")).toHaveLength(0);
    expect(session.events.filter((event) => event.type === "turn_started")).toHaveLength(0);
    expect(session.events.filter((event) => event.type === "session_started")).toHaveLength(0);

    // The session is untouched by the refusal: a real prompt still
    // identifies the session through its closing hint and ends clean.
    send(session.driver, { type: "user", text: "scenario:basic one" });
    await waitFor(session.events, of("session_started"), "session_started");
    const completed = await waitFor(session.events, of("turn_completed"), "turn_completed");
    expect(completed.finish).toBe("end");
    send(session.driver, { type: "shutdown" });
    expect(await session.code).toBe(0);
  });

  test("the author prefix rides the prompt argv", async () => {
    const session = await startSession();
    send(session.driver, { type: "user", text: "scenario:basic hi", author: "ana" });
    await waitFor(session.events, of("turn_completed"), "turn_completed");
    expect(fakeRecord(session, "prompts.jsonl")[0]!.text).toBe("[ana] scenario:basic hi");
    send(session.driver, { type: "shutdown" });
    expect(await session.code).toBe(0);
  });
});
