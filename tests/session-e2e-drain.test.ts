import { afterAll, describe, expect, test } from "bun:test";
import { DEFAULT_DENIAL_MESSAGE } from "../src/session/claude-session.js";
import {
  cleanups,
  fakeRecord,
  of,
  send,
  startSession,
  waitFor,
  waitForRecord,
  type Event
} from "./helpers/session-e2e.js";

afterAll(async () => {
  for (const clean of cleanups.reverse()) await clean();
});

describe("claude session driver e2e", () => {
  test("a stale interrupt is spent on the clean turn it missed; the next turn is not relabeled", async () => {
    // Review live12: the interrupt was written while t1's result was
    // already in flight, and t1 — a clean success — was labeled
    // interrupted. A clean result with an interrupt outstanding ends
    // honestly. Review live21: the missed interrupt is spent with it. The
    // harness reads it idle and drops it, because t2's line is written
    // only after t1's result (a mid-turn `user` is rejected `busy`), so
    // the live12/live20 roll that kept it pending for t2 relabeled a turn
    // the interrupt never reached.
    const session = await startSession();
    send(session.driver, { type: "user", text: "scenario:race one" });
    await waitFor(session.events, of("session_started"), "session_started");
    await waitFor(session.events, of("turn_started"), "turn_started");
    await waitFor(session.events, of("assistant_message"), "assistant_message");
    send(session.driver, { type: "interrupt" });
    await waitFor(session.events, of("turn_completed"), "first turn_completed");
    // An error result on t2 with the interrupted shape and no interrupt
    // behind it: pre-fix the rolled interrupt struck it.
    send(session.driver, { type: "user", text: "scenario:ede two" });
    await waitFor(
      session.events,
      (events) => events.filter((event) => event.type === "turn_completed")[1],
      "second turn_completed"
    );
    const completions = session.events.filter((event) => event.type === "turn_completed");
    expect(completions.map((event) => [event.turn_id, event.finish])).toEqual([
      ["t1", "end"],
      ["t2", "failed"],
    ]);
    expect(completions[0]!.usage.input_tokens).toBe(11);
    expect(completions[1]!.reason).toBe("error_during_execution");
    send(session.driver, { type: "shutdown" });
    await waitFor(session.events, of("session_ended"), "session_ended");
    expect(await session.code).toBe(0);
    // The one caller interrupt, which the harness dropped.
    const interrupts = fakeRecord(session, "interrupts.jsonl") as Event[];
    expect(interrupts.map((entry) => entry.request_id)).toEqual(["interrupt-1"]);
  });

  test("the shutdown drain delivers the harness's final output", async () => {
    // Review live5, major 2: handleHarnessLine used to return early on
    // `finished`, so the harness's last frames — the end-interrupt's
    // answer, the interrupted turn's result, its usage — vanished during
    // the grace window: no turn_completed, a null-usage session_ended,
    // exit 0. FAKE_SIGTERM_PERSIST keeps the fake alive past the
    // shutdown SIGTERM the way the real harness survives inside the
    // grace window, so its answer must reach the caller.
    const session = await startSession({}, { FAKE_SIGTERM_PERSIST: "1" });
    send(session.driver, { type: "user", text: "scenario:wait held" });
    await waitFor(session.events, of("turn_started"), "turn_started");
    send(session.driver, { type: "shutdown" });

    // The drain: the fake answers the end-interrupt and completes the
    // turn while the end path is already running — those events must
    // still reach the caller, before session_ended.
    const completed = await waitFor(
      session.events,
      (events) => events.find((event) => event.type === "turn_completed"),
      "drained turn_completed"
    );
    expect(completed.turn_id).toBe("t1");
    expect(completed.finish).toBe("interrupted");
    expect(completed.usage).toEqual({
      input_tokens: 4,
      output_tokens: 2,
      cached_input_tokens: 0,
      total_tokens: 6,
      cost_usd: null, // no per-turn cost (review live10)
    });
    const ended = await waitFor(session.events, of("session_ended"), "session_ended");
    expect(ended.reason).toBe("harness_failed");
    // Exit 1 fails the session even after a drained turn completion.
    expect(ended.exit_code).toBe(1);
    // The drained result's usage folded into the session cumulative; the
    // cost adopted there (the per-turn event carries none — live10).
    expect(ended.usage).toEqual({
      input_tokens: 4,
      output_tokens: 2,
      cached_input_tokens: 0,
      total_tokens: 6,
      cost_usd: 0.001,
    });
    expect(session.events[session.events.length - 1]).toBe(ended);
    expect(await session.code).toBe(1);
    // The interrupt the end path sent was the one the fake answered.
    const interrupts = fakeRecord(session, "interrupts.jsonl") as Event[];
    expect(interrupts.map((entry) => entry.request_id)).toEqual(["interrupt-end-1"]);
  });

  test("a harness exiting nonzero during the drain with its turn open costs success", async () => {
    // Review live9, correctness 2: finish() resolved with the initiating
    // end's success code and ignored the child's exit — an injected
    // child exiting 42 reproduced driver exit 0 while
    // session_ended.exit_code said 42. The verdict now reads the child:
    // a turn still open at the drain's end (no completion delivered)
    // plus a nonzero exit is a failure, with the error on the stream
    // ahead of session_ended. A delivered completion cannot excuse a
    // nonzero exit, and a signal death fails by the same rule.
    const session = await startSession({}, { FAKE_SIGTERM_PERSIST: "exit42" });
    send(session.driver, { type: "user", text: "scenario:wait held" });
    await waitFor(session.events, of("turn_started"), "turn_started");
    send(session.driver, { type: "shutdown" });

    const ended = await waitFor(session.events, of("session_ended"), "session_ended");
    expect(ended.reason).toBe("harness_failed");
    expect(ended.exit_code).toBe(1);
    const fatal = session.events.find((event) => event.type === "error" && event.fatal === true);
    expect(fatal).toBeDefined();
    expect(fatal!.source).toBe("harness");
    expect(fatal!.message).toContain("exited with code 42 during the shutdown drain");
    // Review live12: the failure verdict and the pairing synthesis used to
    // be mutually exclusive — this exit class left `turn_started t1`
    // unpaired, exactly when the fatal fired. The open turn is now
    // answered: a failed completion whose reason mirrors the fatal, after
    // the error and before session_ended.
    const completion = of("turn_completed")(session.events)!;
    expect(completion.turn_id).toBe("t1");
    expect(completion.finish).toBe("failed");
    expect(completion.reason).toContain("exited with code 42 during the shutdown drain");
    expect(completion.raw).toBeNull();
    expect(completion.usage).toEqual({
      input_tokens: null,
      output_tokens: null,
      cached_input_tokens: null,
      total_tokens: null,
      cost_usd: null,
    });
    expect(session.events[session.events.length - 1]).toBe(ended);
    expect(await session.code).toBe(1);
    // The end-interrupt was delivered but died unanswered.
    const interrupts = fakeRecord(session, "interrupts.jsonl") as Event[];
    expect(interrupts.map((entry) => entry.request_id)).toEqual(["interrupt-end-1"]);
  });

  test("a fatal arriving during the shutdown drain costs success", async () => {
    // Review live7, major 2: once `finish` began, its re-entry guard
    // ignored every later failure call — the driver emitted the tier-3
    // fatal and still exited 0 with reason "shutdown". Cleanup stays
    // idempotent; the verdict does not freeze until the child settles: a
    // fatal line arriving inside the grace window raises the exit code
    // to 1. FAKE_SIGTERM_PERSIST=garbage keeps the fake alive past the
    // shutdown SIGTERM and emits one non-JSON line before dying.
    const session = await startSession({}, { FAKE_SIGTERM_PERSIST: "garbage" });
    send(session.driver, { type: "user", text: "scenario:wait held" });
    await waitFor(session.events, of("turn_started"), "turn_started");
    send(session.driver, { type: "shutdown" });

    const ended = await waitFor(session.events, of("session_ended"), "session_ended");
    expect(ended.reason).toBe("harness_failed");
    const fatal = session.events.find(
      (event) => event.type === "error" && event.fatal === true
    );
    expect(fatal).toBeDefined();
    expect(fatal!.source).toBe("harness");
    expect(fatal!.message).toContain("unusable harness output");
    expect(session.events[session.events.length - 1]).toBe(ended);
    expect(await session.code).toBe(1);
  });

  test("the session cost adopts the harness's running figure, never summing turns", async () => {
    // Review live8, major 1: the result's total_cost_usd is a
    // session-lifetime figure on the real wire (pinned by
    // tests/fixtures/live/zai-session-a.ndjson), so the cumulative used
    // to sum reports that already included the earlier turns — two turns
    // at $0.01 and $0.015 reported $0.025. The fake models the real
    // counter (each result reports the running total), so the session
    // cost must adopt the second turn's figure while the tokens still
    // sum. Review live10, correctness 3: the per-turn events carry no
    // cost at all — mirroring the lifetime figure beside per-turn token
    // counts invited callers to sum overlapping figures (the fixture
    // shows 0.101124 → 0.1066152 → 0.118512 across three turns). The
    // ask/badask results carry no cost, and their keep-semantics are
    // unit-pinned in tests/session-usage.test.ts.
    const session = await startSession();
    send(session.driver, { type: "user", text: "scenario:basic one" });
    const first = await waitFor(
      session.events,
      (events) => events.filter((event) => event.type === "turn_completed")[0],
      "first turn_completed"
    );
    expect(first.usage.cost_usd).toBe(null);
    send(session.driver, { type: "user", text: "scenario:tools two" });
    const second = await waitFor(
      session.events,
      (events) => events.filter((event) => event.type === "turn_completed")[1],
      "second turn_completed"
    );
    expect(second.usage.cost_usd).toBe(null);
    send(session.driver, { type: "shutdown" });
    const ended = await waitFor(session.events, of("session_ended"), "session_ended");
    expect(ended.usage).toEqual({
      input_tokens: 22,
      output_tokens: 8,
      cached_input_tokens: 3,
      total_tokens: 33,
      // The harness's running total after turn 2 — not the $0.005
      // delta, and not a sum of the per-turn events (which carry none).
      cost_usd: 0.015,
    });
    expect(await session.code).toBe(0);
  });

  test("a permission request arriving during the shutdown drain is denied and resolved", async () => {
    // Review live8, major 2: a can_use_tool landing inside the grace
    // window — after finish() denied everything it found pending — used
    // to register with an expiry timer the end path had already cleared
    // (and `finished` short-circuits expiry besides), while the caller's
    // decision channel was already closed: the harness waited on an
    // answer that could never come, stalling the very persistence the
    // grace window exists for. The request is now denied at once with
    // the supersede treatment. FAKE_SIGTERM_PERSIST=ask makes the fake
    // surface the ask from the end-interrupt, which the driver writes
    // inside the end path — deterministically inside the drain.
    const session = await startSession({}, { FAKE_SIGTERM_PERSIST: "ask" });
    send(session.driver, { type: "user", text: "scenario:wait held" });
    await waitFor(session.events, of("turn_started"), "turn_started");
    send(session.driver, { type: "shutdown" });

    const request = await waitFor(
      session.events,
      of("permission_request"),
      "drain permission_request"
    );
    expect(request.request_id).toBe("toolu_drain_1");
    expect(request.tool).toBe("Bash");
    const resolved = await waitFor(
      session.events,
      (events) =>
        events.find(
          (event) =>
            event.type === "permission_resolved" && event.request_id === "toolu_drain_1"
        ),
      "drain permission_resolved"
    );
    expect(resolved.resolution).toBe("superseded");
    expect(resolved.message).toBe(DEFAULT_DENIAL_MESSAGE);
    // The deny reached the harness, keyed to the request it denied, with
    // the default denial text. permission_resolved is codemux's own
    // event, so the fake's record follows a pipe turn later: one read
    // right after it raced the fake under load (waitForRecord's rule).
    const responses = await waitForRecord(session, "responses.jsonl");
    const deny = responses.find((entry) => entry.request_id === "toolu_drain_1");
    expect(deny?.behavior).toBe("deny");
    expect(deny?.message).toBe(DEFAULT_DENIAL_MESSAGE);
    // The denial does not forfeit the drain: the interrupted turn's
    // completion still arrives, then the end.
    const completed = await waitFor(
      session.events,
      (events) => events.find((event) => event.type === "turn_completed"),
      "drained turn_completed"
    );
    expect(completed.finish).toBe("interrupted");
    const ended = await waitFor(session.events, of("session_ended"), "session_ended");
    expect(ended.reason).toBe("harness_failed");
    expect(session.events[session.events.length - 1]).toBe(ended);
    expect(await session.code).toBe(1);
  });

  test("caller input during the shutdown drain is rejected shutting_down, never dropped", async () => {
    // Review live9, contracts: §4.1 and the README promise every input
    // line is acknowledged, but the driver's guard returned before
    // parsing once `finished` flipped, so a line landing inside the
    // grace window vanished unacknowledged — and the documented
    // `shutting_down` reason was unreachable dead code. The drain
    // window (`finished`, not yet `settled`) now answers every line
    // with the rejection. The two sends are synchronous: the CLI keeps
    // relaying caller stdin through the whole grace window, so the
    // second line deterministically lands inside the drain.
    const session = await startSession();
    send(session.driver, { type: "user", text: "scenario:basic hello" });
    await waitFor(session.events, of("turn_completed"), "turn_completed");
    send(session.driver, { type: "shutdown" });
    send(session.driver, { type: "user", text: "too late" });

    const rejection = await waitFor(
      session.events,
      (events) =>
        events.find(
          (event) => event.type === "input_rejected" && event.reason === "shutting_down"
        ),
      "the shutting_down rejection"
    );
    expect(rejection.input_seq).toBe(3);
    // The line was never echoed or turned: only rejection, then the end.
    expect(session.events.filter((event) => event.type === "user_message")).toHaveLength(1);
    const ended = await waitFor(session.events, of("session_ended"), "session_ended");
    expect(ended.reason).toBe("shutdown");
    expect(session.events[session.events.length - 1]).toBe(ended);
    expect(await session.code).toBe(0);
  });

  test("a wrapper exiting 143 during shutdown fails the session (al41)", async () => {
    const session = await startSession({}, { FAKE_SIGTERM_PERSIST: "exit143" });
    send(session.driver, { type: "user", text: "scenario:wait held" });
    await waitFor(session.events, of("turn_started"), "turn_started");
    send(session.driver, { type: "shutdown" });

    const ended = await waitFor(session.events, of("session_ended"), "session_ended");
    expect(ended.reason).toBe("harness_failed");
    expect(ended.exit_code).toBe(1);
    expect(of("error")(session.events)?.fatal).toBe(true);
    const completed = of("turn_completed")(session.events) as Event;
    expect(completed).toBeDefined();
    expect(completed.turn_id).toBe("t1");
    expect(completed.finish).toBe("failed");
    expect(completed.reason).toContain("exited with code 143");
    expect(completed.usage).toEqual({
      input_tokens: null,
      output_tokens: null,
      cached_input_tokens: null,
      total_tokens: null,
      cost_usd: null,
    });
    expect(await session.code).toBe(1);
    const interrupts = fakeRecord(session, "interrupts.jsonl") as Event[];
    expect(interrupts.map((entry) => entry.request_id)).toEqual(["interrupt-end-1"]);
  });

  test("a crash mid-turn reports one fatal and still answers the open turn", async () => {
    // Review live11, minor 5 (the claude sibling): the crash path already
    // told the failure story, but the live9 verdict then added a second,
    // false "during the shutdown drain" fatal for the same exit — and the
    // open turn's turn_started was never answered. The crash now emits
    // one fatal and the turn receives a failed completion.
    const session = await startSession();
    send(session.driver, { type: "user", text: "scenario:crash boom" });
    await waitFor(session.events, of("session_started"), "session_started");
    const ended = await waitFor(session.events, of("session_ended"), "session_ended");
    expect(ended.reason).toBe("harness_failed");
    // Exactly one fatal — the crash itself — and no drain fatal behind it.
    const fatals = session.events.filter(
      (event) => event.type === "error" && event.fatal === true
    );
    expect(fatals).toHaveLength(1);
    expect(fatals[0]!.message).toContain("exited unexpectedly");
    expect(
      session.events.some((event) => String(event.message ?? "").includes("shutdown drain"))
    ).toBe(false);
    // The open turn is answered: synthesized failed, codemux-originated,
    // usage never guessed.
    const completed = of("turn_completed")(session.events) as Event;
    expect(completed).toBeDefined();
    expect(completed.turn_id).toBe("t1");
    expect(completed.finish).toBe("failed");
    // Review live17: the reason is the fatal that ended the session.
    expect(completed.reason).toContain("the claude process exited with code 1 during the shutdown drain before completing its open turn");
    expect(completed.usage).toEqual({
      input_tokens: null,
      output_tokens: null,
      cached_input_tokens: null,
      total_tokens: null,
      cost_usd: null,
    });
    expect(session.events[session.events.length - 1]).toBe(ended);
    expect(await session.code).toBe(1);
  });

  test("a forwarded pre-init input the harness runs during the drain is mirrored, not fatal (review live16)", async () => {
    // Review live16, correctness major: a user line accepted before the
    // init frame is forwarded at once, so a shutdown cannot drop it. The
    // shutdown here lands before any harness line; the fake keeps running
    // after the SIGTERM, runs the line, and emits its result
    // while no turn is open. Pre-fix that result hit an idle FSM, raised
    // a fatal, and turned a clean shutdown into exit 1 while the caller
    // was told the input dropped. (Mid-turn lines are rejected `busy`
    // since review live21, so the pre-init line is the one forwarded
    // input that can lack a turn.)
    // exit143: the fake survives the SIGTERM for 300 ms, then exits the
    // way a signal-killed wrapper reports (no interrupted turn exists to
    // carry the exit-1 convention).
    const session = await startSession({}, { FAKE_SIGTERM_PERSIST: "exit143" });
    // The fake must be up (its SIGTERM survival installed) before the
    // shutdown, or the signal kills it before it reads the line.
    await waitForRecord(session, "argv.jsonl", 1);
    await Bun.sleep(100);
    send(session.driver, { type: "user", text: "scenario:basic early" });
    send(session.driver, { type: "shutdown" });

    const ended = await waitFor(session.events, of("session_ended"), "session_ended");
    expect(ended.reason).toBe("harness_failed");
    expect(await session.code).toBe(1);
    const errors = session.events.filter((event) => event.type === "error");
    expect(errors.filter((event) => event.fatal === true)).toHaveLength(1);
    // The notice says the harness may still run it, never that it dropped.
    expect(errors).toHaveLength(2);
    expect(String(errors[0]?.message)).toContain("may still run it");
    // No turn opened during the drain; the line's result is mirrored.
    expect(session.events.filter((event) => event.type === "turn_started")).toHaveLength(0);
    expect(session.events.filter((event) => event.type === "turn_completed")).toHaveLength(0);
    const mirrored = session.events.filter(
      (event) => event.type === "unknown" && String(event.raw).includes('"type":"result"')
    );
    expect(mirrored).toHaveLength(1);
    // Review live22 (audit sibling of the codex usage loss): the mirrored
    // result's usage reaches the session total; it used to be dropped.
    const mirroredUsage = JSON.parse(String(mirrored[0]!.raw)).usage;
    expect(ended.usage.input_tokens).not.toBeNull();
    expect(ended.usage.output_tokens).toBe(mirroredUsage.output_tokens);
  });
});
