/** Driver e2e tests for the agy session, lifecycle split (from
 * tests/session-agy-e2e.test.ts): the deferred identity model, the
 * two-turn exchange, resume, the auth-failure and error-turn ends, stdin
 * close, the timeout, the author prefix, the input bound, refused
 * harness writes, and failing or stalling sinks. */

import { afterAll, describe, expect, test } from "bun:test";
import { readRegistry } from "../src/session/registry.js";
import {
  cleanups,
  fakeRecord,
  of,
  send,
  startSession,
  waitFor,
  type Event
} from "./helpers/session-agy-e2e.js";

afterAll(async () => {
  for (const clean of cleanups.reverse()) await clean();
});

describe("agy session e2e - lifecycle", () => {
  test("a fresh session runs a two-turn exchange with the identity deferred to the first result", async () => {
    const session = await startSession();
    send(session.driver, { type: "user", text: "scenario:basic one" });

    // Before the first result, the session does not exist yet: the
    // input is answered and echoed with an empty session id.
    const echo = await waitFor(session.events, of("user_message"), "user_message");
    expect(echo.text).toBe("scenario:basic one");
    expect(echo.turn_id).toBe("t1");
    expect(echo.session_id).toBe("");
    const turnStarted = await waitFor(session.events, of("turn_started"), "turn_started");
    expect(turnStarted.turn_id).toBe("t1");
    expect(turnStarted.raw).toBeNull();

    // The first result both names the conversation and completes the
    // turn: session_started lands after turn_started but before the
    // turn's remaining events (the assertions below pin both sides of
    // that order).
    const started = await waitFor(session.events, of("session_started"), "session_started");
    expect(started.agent).toBe("agy");
    expect(started.session_id).toBe("conv-fake-1");
    expect(started.autonomy).toBe("high");
    expect(started.protocol).toBe("codemux-live-session/1");
    expect(started.capabilities).toEqual({
      live_input: true,
      user_during_turn: false,
      steer: false,
      interrupt: false,
      permissions: false,
      deltas: false,
      file_changes: false,
      usage_stream: false,
      resume: true,
    });
    const message = await waitFor(session.events, of("assistant_message"), "assistant_message");
    expect(message.text).toBe("Done: scenario:basic one");
    expect(message.turn_id).toBe("t1");
    expect(message.session_id).toBe("conv-fake-1");
    const completed = await waitFor(session.events, of("turn_completed"), "turn_completed");
    // Review live4, contracts 1: `usage_stream: false` means usage rides
    // ONLY the per-turn result envelope — the same contract claude/zai
    // ship. No standalone `usage` event may appear (the turn has
    // completed, so its absence is settled, not early).
    expect(of("usage")(session.events)).toBeUndefined();
    expect(completed.finish).toBe("end");
    expect(completed.turn_id).toBe("t1");
    expect(completed.usage).toEqual({
      input_tokens: 60,
      output_tokens: 20,
      cached_input_tokens: 40,
      total_tokens: 120,
      cost_usd: null,
    });
    // Identity ordering: the echo and turn_started precede
    // session_started; assistant_message and the rest of the turn's
    // events follow it. Both sides are pinned, not just the first.
    const order = session.events.map((event) => event.type);
    expect(order.indexOf("session_started")).toBeGreaterThan(order.indexOf("turn_started"));
    expect(order.indexOf("session_started")).toBeLessThan(order.indexOf("assistant_message"));

    // The second turn names the same conversation.
    send(session.driver, { type: "user", text: "scenario:basic two" });
    const second = await waitFor(
      session.events,
      (events) => events.filter((event) => event.type === "turn_completed")[1],
      "second turn_completed"
    );
    expect(second.turn_id).toBe("t2");
    expect(second.finish).toBe("end");

    send(session.driver, { type: "shutdown" });
    const code = await session.code;
    expect(code).toBe(0);
    const ended = session.events[session.events.length - 1] as Event;
    expect(ended.type).toBe("session_ended");
    expect(ended.reason).toBe("shutdown");
    expect(ended.resumable).toBe(true);
    // Two identical turns, summed field-wise; cost stays null — agy
    // never reports one, and a null component stays null through sums.
    expect(ended.usage).toEqual({
      input_tokens: 120,
      output_tokens: 40,
      cached_input_tokens: 80,
      total_tokens: 240,
      cost_usd: null,
    });

    // The registry recorded the session under the conversation id (§4.8).
    const registry = readRegistry(session.options.registryPath as string);
    expect(registry.outcome).toBe("ok");
    const entry =
      registry.outcome === "ok"
        ? registry.file.sessions.find((r) => r.id === "conv-fake-1")
        : undefined;
    expect(entry?.agent).toBe("agy");
    expect(entry?.ended).not.toBe(null);
  });

  test("a resumed conversation adopts its id at spawn, before any turn", async () => {
    const session = await startSession({ resumeConversationId: "conv-res-7" });
    const started = await waitFor(session.events, of("session_started"), "session_started");
    expect(started.session_id).toBe("conv-res-7");
    expect(session.events.filter((event) => event.type === "turn_started")).toHaveLength(0);
    send(session.driver, { type: "user", text: "scenario:basic hi" });
    const echo = await waitFor(session.events, of("user_message"), "user_message");
    expect(echo.session_id).toBe("conv-res-7");
    const completed = await waitFor(session.events, of("turn_completed"), "turn_completed");
    expect(completed.finish).toBe("end");
    send(session.driver, { type: "shutdown" });
    expect(await session.code).toBe(0);
  });

  test("a resumed conversation the harness never confirms is not reported resumable (review live21)", async () => {
    // The agy sibling of correctness minor 1: a resumed session records
    // at spawn from the registry-vouched id, so `resumable` was true even
    // when agy died before any result named the conversation (the crash
    // scenario: exit 1, no frame).
    const session = await startSession({ resumeConversationId: "conv-res-8" });
    await waitFor(session.events, of("session_started"), "session_started");
    send(session.driver, { type: "user", text: "scenario:crash" });
    expect(await session.code).toBe(1);
    const ended = session.events.at(-1) as Event;
    expect(ended.type).toBe("session_ended");
    expect(ended.reason).toBe("harness_failed");
    expect(ended.resumable).toBe(false);
  });

  test("the fixture-pinned auth failure fails the turn and ends the untrackable session", async () => {
    const session = await startSession();
    send(session.driver, { type: "user", text: "scenario:authfail" });
    const completed = await waitFor(session.events, of("turn_completed"), "turn_completed");
    expect(completed.finish).toBe("failed");
    expect(completed.reason).toBe('status "ERROR": authentication failed or timed out');
    expect(completed.usage).toEqual({
      input_tokens: 0,
      output_tokens: 0,
      cached_input_tokens: 0,
      total_tokens: 0,
      cost_usd: null,
    });
    // No assistant message: the envelope's response is empty.
    expect(of("assistant_message")(session.events)).toBeUndefined();
    const error = await waitFor(
      session.events,
      (events) => events.find((event) => event.type === "error" && event.fatal === true),
      "the fatal error"
    );
    expect(error.message).toContain("named no conversation id");
    expect(await session.code).toBe(1);
    const ended = session.events[session.events.length - 1] as Event;
    expect(ended.type).toBe("session_ended");
    expect(ended.reason).toBe("crash");
    expect(ended.resumable).toBe(false);
    // Never identified, never recorded.
    expect(of("session_started")(session.events)).toBeUndefined();
  });

  test("an error turn with a known conversation fails the turn but not the session", async () => {
    const session = await startSession();
    send(session.driver, { type: "user", text: "scenario:errorturn" });
    const failed = await waitFor(session.events, of("turn_completed"), "turn_completed");
    expect(failed.finish).toBe("failed");
    expect(failed.reason).toBe('status "ERROR": the model refused the turn');
    // The session is still alive: the next turn runs.
    send(session.driver, { type: "user", text: "scenario:basic after" });
    const second = await waitFor(
      session.events,
      (events) => events.filter((event) => event.type === "turn_completed")[1],
      "second turn_completed"
    );
    expect(second.finish).toBe("end");
    expect(second.turn_id).toBe("t2");
    send(session.driver, { type: "shutdown" });
    expect(await session.code).toBe(0);
  });

  test("stdin close mid-turn lets the open turn deliver its own result (review live17)", async () => {
    // Review live17, correctness 3: the end path sent SIGTERM in the same
    // step it began and never closed the harness's stdin, so agy — whose
    // only end carrier is the stdin close — never got to finish the turn:
    // it was always the synthesized `interrupted` with null usage. The
    // driver now closes stdin and gives the turn the grace before any
    // signal; the fake models the input loop finishing the running line
    // on EOF, so the turn ends with its own result and real usage.
    const session = await startSession();
    send(session.driver, { type: "user", text: "scenario:wait hold" });
    await waitFor(session.events, of("turn_started"), "turn_started");
    session.driver.handleCallerEnd();
    const completed = await waitFor(session.events, of("turn_completed"), "turn_completed");
    expect(completed.turn_id).toBe("t1");
    expect(completed.finish).toBe("end");
    // Exact values from the stdin-close result envelope (successResult):
    // raw is the envelope's JSON text (input_tokens 100); the mapped
    // usage nets the 40 cache-read tokens out of input, like the basic
    // scenario's 60/20.
    expect(String(completed.raw)).toContain('"input_tokens":100');
    expect(completed.usage.input_tokens).toBe(60);
    expect(completed.usage.output_tokens).toBe(20);
    expect(await session.code).toBe(0);
    const ended = session.events[session.events.length - 1] as Event;
    expect(ended.type).toBe("session_ended");
    expect(ended.reason).toBe("stdin-close");
    expect(ended.exit_code).toBe(0);
    // The result named the conversation, so the session was identified.
    expect(of("session_started")(session.events)).toBeDefined();
  });

  test("stdin close mid-turn ends cleanly, with the open turn answered", async () => {
    // Review live10, correctness 7: agy has no interrupt carrier, so the
    // end path used to leave the held turn's `turn_started` unanswered —
    // every other driver closes the pairing through the end-interrupt's
    // drained result. The driver now synthesizes the completion the
    // harness cannot: codemux-originated (raw null), interrupted, and
    // the usage it never reported all-null rather than guessed zeros.
    // FAKE_IGNORE_EOF keeps the turn open past the stdin close (live17
    // gives it the grace to answer first) and dies at once on SIGTERM.
    const session = await startSession({}, { FAKE_IGNORE_EOF: "1" });
    send(session.driver, { type: "user", text: "scenario:wait hold" });
    await waitFor(session.events, of("turn_started"), "turn_started");
    session.driver.handleCallerEnd();
    const completed = await waitFor(
      session.events,
      of("turn_completed"),
      "the synthesized turn_completed"
    );
    expect(completed.turn_id).toBe("t1");
    expect(completed.finish).toBe("failed");
    expect(completed.reason).toContain("the agy process exited with signal SIGTERM during the shutdown drain before completing its open turn");
    expect(completed.raw).toBeNull();
    expect(completed.usage).toEqual({
      input_tokens: null,
      output_tokens: null,
      cached_input_tokens: null,
      total_tokens: null,
      cost_usd: null,
    });
    expect(await session.code).toBe(1);
    const ended = session.events[session.events.length - 1] as Event;
    expect(ended.type).toBe("session_ended");
    expect(ended.reason).toBe("harness_failed");
    // The completion precedes the end on the stream, and the pairing is
    // exactly one-to-one: one turn_started, one turn_completed.
    expect(session.events.indexOf(completed)).toBeLessThan(session.events.indexOf(ended));
    expect(session.events.filter((event) => event.type === "turn_started")).toHaveLength(1);
    // Never identified: a fresh agy session whose first turn never
    // completed has no vouchable conversation id, so nothing was
    // recorded and nothing is resumable — even though the end is clean.
    expect(ended.resumable).toBe(false);
    expect(of("session_started")(session.events)).toBeUndefined();
  });

  test("the session timeout ends the session", async () => {
    const session = await startSession({ sessionTimeoutMs: 300 });
    expect(await session.code).toBe(1);
    const ended = session.events[session.events.length - 1] as Event;
    expect(ended.type).toBe("session_ended");
    expect(ended.reason).toBe("timeout");
  });

  test("the author prefix rides the harness line", async () => {
    const session = await startSession();
    send(session.driver, { type: "user", text: "scenario:basic hi", author: "ana" });
    await waitFor(session.events, of("turn_completed"), "turn_completed");
    const lines = fakeRecord(session, "input-lines.jsonl");
    expect(lines[0]!.text).toBe("[ana] scenario:basic hi");
    send(session.driver, { type: "shutdown" });
    expect(await session.code).toBe(0);
  });

  test("a text whose harness frame cannot fit is rejected text_too_long before the ack", async () => {
    // The M2 window: 16 MiB of quotes passes the protocol's raw-text
    // bound, but the frame's JSON-escaping doubles every quote past the
    // 17 MiB write cap. Rejected, never accepted-then-dropped.
    const session = await startSession();
    send(session.driver, { type: "user", text: "scenario:basic one" });
    await waitFor(session.events, of("turn_completed"), "turn_completed");
    send(session.driver, { type: "user", text: '"'.repeat(16 * 1024 * 1024) });
    const rejected = await waitFor(
      session.events,
      (events) => events.find((event) => event.type === "input_rejected"),
      "the text_too_long rejection"
    );
    expect(rejected.reason).toBe("text_too_long");
    // Only turn 1's echo exists; the undeliverable line was never echoed.
    expect(session.events.filter((event) => event.type === "user_message")).toHaveLength(1);
    send(session.driver, { type: "shutdown" });
    expect(await session.code).toBe(0);
  });

  test("a harness-stdin write failure is a fatal codemux error, not a silent diagnostic", async () => {
    // M2's escalation: a refused write after the ack ends the session as
    // codemux's own failure instead of leaving the turn hanging open.
    const session = await startSession();
    send(session.driver, { type: "user", text: "scenario:basic one" });
    await waitFor(session.events, of("turn_completed"), "turn_completed");
    session.proc.writeLine = () => ({ ok: false, reason: "closed" });
    send(session.driver, { type: "user", text: "scenario:basic two" });
    const error = await waitFor(
      session.events,
      (events) => events.find((event) => event.type === "error" && event.fatal),
      "fatal error"
    );
    expect(error.source).toBe("codemux");
    expect(error.message).toContain("could not deliver a line to the harness");
    const ended = await waitFor(session.events, of("session_ended"), "session_ended");
    expect(ended.reason).toBe("crash");
    expect(await session.code).toBe(1);
  });

  test("a write failure on a fresh turn announces the turn before the fatal (review live16)", async () => {
    // Review live16, correctness minor: the user path wrote first and
    // emitted turn_started after, so a refused write put the fatal error
    // (and the crash path) ahead of the turn's opening on the stream.
    const session = await startSession();
    send(session.driver, { type: "user", text: "scenario:basic one" });
    await waitFor(session.events, of("turn_completed"), "turn_completed");
    session.proc.writeLine = () => ({ ok: false, reason: "closed" });
    send(session.driver, { type: "user", text: "scenario:basic two" });
    await waitFor(session.events, of("session_ended"), "session_ended");
    expect(await session.code).toBe(1);
    const types = session.events
      .filter((event) => event.turn_id === "t2" || (event.type === "error" && event.fatal))
      .map((event) => event.type);
    // Review live17, correctness minor 6: turn_started now precedes the
    // user_message that names it, the order the claude and codex drivers
    // emit; the live16 rule (both before the fatal) still holds.
    expect(types).toEqual(["turn_started", "user_message", "error", "turn_completed"]);
  });

  test("a sink failing on the final event reports exit 1, not success", async () => {
    // M3: shutdown already set `finished`, so the failure callback's own
    // end attempt is a no-op and the flush rejection was swallowed — a
    // caller whose pipe broke on `session_ended` still saw exit 0.
    const events: Event[] = [];
    const session = await startSession({
      sink: (line) => {
        const event = JSON.parse(line) as Event;
        events.push(event);
        if (event.type === "session_ended") throw new Error("final write broke");
      },
    });
    send(session.driver, { type: "user", text: "scenario:basic hello" });
    await waitFor(events, of("turn_completed"), "turn_completed");
    send(session.driver, { type: "shutdown" });
    await waitFor(events, of("session_ended"), "session_ended");
    expect(await session.code).toBe(1);
  });

  test("a sink that stalls on the final event still resolves run() with exit 1", async () => {
    // Review live3, correctness 1: the give-up used to win without
    // marking the final event undelivered and without canceling the
    // flush, so a stalled sink reproduced run() resolving 0 with
    // `session_ended` undelivered and the flush poll loop holding the
    // process open. The give-up now reports the miss AND abandons the
    // queue, so the end path resolves.
    const events: Event[] = [];
    const session = await startSession({
      sink: (line) => {
        const event = JSON.parse(line) as Event;
        events.push(event);
        if (event.type === "session_ended") {
          // A stopped reader: the write is accepted but never completes.
          return new Promise<void>(() => {});
        }
      },
    });
    send(session.driver, { type: "user", text: "scenario:basic hello" });
    await waitFor(events, of("turn_completed"), "turn_completed");
    send(session.driver, { type: "shutdown" });
    await waitFor(events, of("session_ended"), "session_ended queued");
    // run() must resolve (this await is the regression: it used to hang
    // behind the flush poll loop) and carry the delivery failure.
    expect(await session.code).toBe(1);
  });
});
