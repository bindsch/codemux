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
} from "./helpers/session-e2e.js";
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
  test("full lifecycle: pre-init input opens the first turn, shutdown, registry end", async () => {
    const session = await startSession();
    // The CLI relays caller stdin the moment the harness spawns, so the
    // first user line regularly arrives before system/init: accepting it,
    // echoing it, and opening its turn at the init frame is the driver's
    // job (the fake emits init per turn, as the real wire does).
    send(session.driver, { type: "user", text: "scenario:basic hello" });
    const started = await waitFor(session.events, of("session_started"), "session_started");
    expect(started.session_id).toBe(session.options.sessionId);
    expect(started.agent).toBe("claude");
    expect(started.autonomy).toBe("high");
    expect(started.cwd).toBe(session.options.cwd);
    expect(started.protocol).toBe("codemux-live-session/1");
    expect(started.capabilities.user_during_turn).toBe(false);
    // Honest flags on the wire: no steering carrier (a steer line is
    // rejected `unsupported` below), no standalone usage stream.
    expect(started.capabilities.steer).toBe(false);
    expect(started.capabilities.usage_stream).toBe(false);
    // The envelope's key order is fixed and raw is null on codemux events;
    // the echo and its ack precede session_started on this path, so the
    // line is located by the event's own seq.
    expect(session.rawLines[started.seq - 1]).toMatch(
      /^\{"seq":\d+,"ts":"[^"]+","session_id":"[^"]+","type":"session_started","raw":null,/
    );

    const turn = await waitFor(session.events, of("turn_started"), "turn_started");
    expect(turn.turn_id).toBe("t1");
    const echo = await waitFor(session.events, of("user_message"), "user_message");
    expect(echo.text).toBe("scenario:basic hello");
    expect(echo.input_seq).toBe(1);
    // Accepted before the session announced itself: the turn was not yet
    // known, so the field is absent (§4.2's `turn_id?` once known).
    expect(echo.turn_id).toBeUndefined();
    expect(
      session.events.map((event) => event.type).indexOf("user_message")
    ).toBeLessThan(session.events.map((event) => event.type).indexOf("session_started"));
    const delta = await waitFor(session.events, of("assistant_delta"), "assistant_delta");
    expect(delta.delta).toBe("Hel");
    expect(typeof delta.raw).toBe("string");
    await waitFor(session.events, of("assistant_message"), "assistant_message");
    const completed = await waitFor(session.events, of("turn_completed"), "turn_completed");
    expect(completed.finish).toBe("end");
    expect(completed.turn_id).toBe("t1");
    expect(completed.usage).toEqual({
      input_tokens: 10,
      output_tokens: 5,
      cached_input_tokens: 3,
      total_tokens: 18,
      // No per-turn cost (review live10): the wire's only cost figure is
      // session-lifetime; it rides session_ended below.
      cost_usd: null,
    });

    send(session.driver, { type: "shutdown" });
    const ended = await waitFor(session.events, of("session_ended"), "session_ended");
    expect(ended.reason).toBe("shutdown");
    expect(ended.resumable).toBe(true);
    expect(ended.usage.total_tokens).toBe(18);
    expect(session.events[session.events.length - 1]).toBe(ended);
    expect(await session.code).toBe(0);

    const read = readRegistry(session.options.registryPath as string);
    expect(read.outcome).toBe("ok");
    if (read.outcome === "ok") {
      const entry = read.file.sessions.find((record) => record.id === started.session_id);
      expect(entry?.ended).not.toBe(null);
    }
  });

  test("a mid-turn user line is rejected busy and never reaches the harness (review live21)", async () => {
    // Contracts major: the driver forwarded a mid-turn line and opened a
    // turn for it at the next result, but print mode folds such a line
    // into the running turn when that turn makes another model request
    // (fixture zai-session-a.ndjson: one result answers both), so the
    // rolled turn waited on a result that never came and every later
    // result answered the turn before it. `user_during_turn` is false
    // now: the line is rejected `busy`, before init as well as after.
    const session = await startSession();
    send(session.driver, { type: "user", text: "scenario:wait first" });
    // Before init: the first line is forwarded and its turn is pending.
    send(session.driver, { type: "user", text: "scenario:basic early" });
    await waitFor(session.events, of("session_started"), "session_started");
    await waitFor(session.events, of("assistant_message"), "assistant_message");
    // Mid-turn.
    send(session.driver, { type: "user", text: "scenario:tools second" });
    const rejections = await waitFor(
      session.events,
      (events) => {
        const found = events.filter((event) => event.type === "input_rejected");
        return found.length === 2 ? found : undefined;
      },
      "two busy rejections"
    );
    expect(rejections.map((event: Event) => [event.input_seq, event.reason])).toEqual([
      [2, "busy"],
      [3, "busy"],
    ]);
    expect(session.events.filter((event) => event.type === "user_message")).toHaveLength(1);
    send(session.driver, { type: "interrupt" });
    const completed = await waitFor(session.events, of("turn_completed"), "turn_completed");
    expect(completed.turn_id).toBe("t1");
    expect(completed.finish).toBe("interrupted");
    // Idle again: the next line opens t2 at once and its result answers it.
    send(session.driver, { type: "user", text: "scenario:tools second" });
    const second = await waitFor(
      session.events,
      (events) => events.find((event) => event.type === "turn_completed" && event.turn_id === "t2"),
      "second turn_completed"
    );
    expect(second.finish).toBe("end");
    expect(session.events.filter((event) => event.type === "turn_started")).toHaveLength(2);
    // The harness saw exactly the two accepted lines.
    const lines = fakeRecord(session, "input-lines.jsonl") as Array<{ text: string }>;
    expect(lines.map((line) => line.text)).toEqual([
      "scenario:wait first",
      "scenario:tools second",
    ]);
    send(session.driver, { type: "shutdown" });
    await waitFor(session.events, of("session_ended"), "session_ended");
    expect(await session.code).toBe(0);
  });

  test("steer is rejected unsupported; the held turn still closes on interrupt", async () => {
    const session = await startSession();
    send(session.driver, { type: "user", text: "scenario:wait hold" });
    await waitFor(session.events, of("session_started"), "session_started");
    await waitFor(session.events, of("assistant_message"), "assistant_message");
    // The claude-family capability is honestly false (review live3): the
    // wire has no carrier that shapes the running turn on demand, so a
    // steer line is rejected by name and nothing reaches the harness or
    // opens a turn.
    send(session.driver, { type: "steer", text: "scenario:basic go", author: "alice" });
    const rejected = await waitFor(
      session.events,
      (events) => events.find((event) => event.type === "input_rejected"),
      "steer rejection"
    );
    expect(rejected.reason).toBe("unsupported");
    // The held turn still closes on interrupt; the next line, sent from
    // idle, opens the next turn (a mid-turn `user` is rejected `busy`,
    // review live21).
    send(session.driver, { type: "interrupt" });
    const interrupted = await waitFor(
      session.events,
      (events) => events.find((event) => event.type === "turn_completed" && event.finish === "interrupted"),
      "interrupted turn"
    );
    expect(interrupted.turn_id).toBe("t1");
    send(session.driver, { type: "user", text: "scenario:basic go" });
    await waitFor(
      session.events,
      (events) => events.find((event) => event.type === "turn_completed" && event.turn_id === "t2"),
      "next turn_completed"
    );
    send(session.driver, { type: "shutdown" });
    await waitFor(session.events, of("session_ended"), "session_ended");
  });

  test("stdin close ends the session cleanly with exit 0", async () => {
    const session = await startSession();
    send(session.driver, { type: "user", text: "scenario:wait open turn" });
    await waitFor(session.events, of("session_started"), "session_started");
    await waitFor(session.events, of("assistant_message"), "assistant_message");
    session.driver.handleCallerEnd();
    const ended = await waitFor(session.events, of("session_ended"), "session_ended");
    expect(ended.reason).toBe("stdin-close");
    expect(await session.code).toBe(0);
  });

  test("a second system/init is a tier-1 unknown and the session continues", async () => {
    const session = await startSession();
    send(session.driver, { type: "user", text: "scenario:badinit replay" });
    const started = await waitFor(session.events, of("session_started"), "session_started");
    expect(started.session_id).toBe(session.options.sessionId);
    const unknown = await waitFor(
      session.events,
      (events) =>
        events.find(
          (event) => event.type === "unknown" && typeof event.raw === "string" && event.raw.includes("init")
        ),
      "the duplicate init passthrough"
    );
    expect(unknown.session_id).toBe(session.options.sessionId);
    // The turn the duplicate init rode still completes...
    const completed = await waitFor(session.events, of("turn_completed"), "turn_completed");
    expect(completed.turn_id).toBe("t1");
    expect(completed.finish).toBe("end");
    // ...and the session survives to run another one.
    send(session.driver, { type: "user", text: "scenario:basic still alive" });
    const second = await waitFor(
      session.events,
      (events) => events.filter((event) => event.type === "turn_completed")[1],
      "second turn_completed"
    );
    expect(second.finish).toBe("end");
    send(session.driver, { type: "shutdown" });
    await waitFor(session.events, of("session_ended"), "session_ended");
    expect(await session.code).toBe(0);
    expect(
      session.events.find((event) => event.type === "error" && event.fatal)
    ).toBeUndefined();
  });

  test("malformed and unsupported caller lines are rejected, never dropped", async () => {
    const session = await startSession();
    send(session.driver, { type: "user", text: "scenario:basic warm" });
    await waitFor(session.events, of("session_started"), "session_started");
    await waitFor(session.events, of("turn_completed"), "warm-up turn_completed");
    session.driver.handleCallerLine("{not json");
    session.driver.handleCallerLine(JSON.stringify({ type: "mystery" }));
    session.driver.handleCallerLine(JSON.stringify({ type: "user", text: "x", extra: 1 }));
    session.driver.handleCallerLine(
      JSON.stringify({ type: "permission_decision", request_id: "nope", decision: "allow" })
    );
    // Delivery to the sink is queued, so the four rejections are awaited,
    // not assumed present the instant the calls return.
    const rejected = await waitFor(
      session.events,
      (events) =>
        events.filter((event) => event.type === "input_rejected").length >= 4
          ? events.filter((event) => event.type === "input_rejected")
          : undefined,
      "four input_rejected events"
    );
    expect(rejected.map((event) => event.reason)).toEqual([
      "malformed",
      "unknown_type",
      "malformed",
      "unknown_request",
    ]);
    expect(rejected.every((event) => typeof event.input_seq === "number")).toBe(true);
    // An interrupt with no active turn is an acknowledged no-op (the
    // warm-up turn's input was seq 1, the four rejects 2 through 5).
    send(session.driver, { type: "interrupt" });
    const accepted = session.events.find(
      (event) => event.type === "input_accepted" && event.input_seq === 6
    );
    expect(accepted).toBeDefined();
    send(session.driver, { type: "shutdown" });
    await waitFor(session.events, of("session_ended"), "session_ended");
  });

  test("the author prefix rides the harness-bound text, not the echo", async () => {
    const session = await startSession();
    send(session.driver, { type: "user", text: "scenario:basic hi", author: "alice" });
    await waitFor(session.events, of("session_started"), "session_started");
    const echo = await waitFor(
      session.events,
      (events) => events.find((event) => event.type === "user_message" && event.author === "alice"),
      "attributed echo"
    );
    expect(echo.text).toBe("scenario:basic hi");
    await waitFor(session.events, of("turn_completed"), "turn_completed");
    const inputs = fakeRecord(session, "input-lines.jsonl") as Array<{ text: string }>;
    expect(inputs[inputs.length - 1]?.text).toBe("[alice] scenario:basic hi");
    send(session.driver, { type: "shutdown" });
    await waitFor(session.events, of("session_ended"), "session_ended");
  });

  test("--no-author-prefix leaves the harness text unprefixed", async () => {
    const session = await startSession({ authorPrefix: false });
    send(session.driver, { type: "user", text: "scenario:basic plain", author: "bob" });
    await waitFor(session.events, of("session_started"), "session_started");
    await waitFor(session.events, of("turn_completed"), "turn_completed");
    const inputs = fakeRecord(session, "input-lines.jsonl") as Array<{ text: string }>;
    expect(inputs[inputs.length - 1]?.text).toBe("scenario:basic plain");
    send(session.driver, { type: "shutdown" });
    await waitFor(session.events, of("session_ended"), "session_ended");
  });

  test("seq stays monotonic across the whole stream", async () => {
    const session = await startSession();
    send(session.driver, { type: "user", text: "scenario:basic seq" });
    await waitFor(session.events, of("session_started"), "session_started");
    await waitFor(session.events, of("turn_completed"), "turn_completed");
    send(session.driver, { type: "shutdown" });
    await waitFor(session.events, of("session_ended"), "session_ended");
    const seqs = session.events.map((event) => event.seq as number);
    expect(seqs).toEqual(seqs.map((_, index) => index + 1));
  });

  test("the sandbox trust is reported and recorded as given", async () => {
    const session = await startSession({ sandboxTrust: "trusted" });
    send(session.driver, { type: "user", text: "scenario:basic trust" });
    const started = await waitFor(session.events, of("session_started"), "session_started");
    expect(started.sandbox_trust).toBe("trusted");
    await waitFor(session.events, of("turn_completed"), "turn_completed");
    send(session.driver, { type: "shutdown" });
    await waitFor(session.events, of("session_ended"), "session_ended");
    const read = readRegistry(session.options.registryPath as string);
    expect(read.outcome).toBe("ok");
    if (read.outcome === "ok") {
      const entry = read.file.sessions.find((record) => record.id === started.session_id);
      expect(entry?.sandbox_trust).toBe("trusted");
    }
  });
});
