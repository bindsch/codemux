import { afterAll, describe, expect, test } from "bun:test";
import { cleanupSessions, type Event, fakeRecord, of, send, startAndWait, startSession, waitFor, waitForRecord } from "./session-codex-e2e-helpers.js";

afterAll(cleanupSessions);

describe("codex session e2e - stream tiers", () => {

  test("a harness exiting nonzero during the drain with its turn open costs success", async () => {
    // Review live9, correctness 2 (the codex sibling): finish() resolved
    // with the initiating end's success code and ignored the child's
    // exit — driver exit 0 while session_ended.exit_code said 42. The
    // verdict now reads the child: a turn still open at the drain's end
    // (no completion delivered) plus a nonzero exit is a failure, with
    // the error on the stream ahead of session_ended. Signal deaths
    // fail too, whether a completion arrived or not.
    const session = await startAndWait({}, { FAKE_SIGTERM_PERSIST: "exit42" });
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
    // Review live12: this exit class used to leave `turn_started t1`
    // unpaired — the failure verdict and the synthesis were mutually
    // exclusive. The open turn is now answered: a failed completion whose
    // reason mirrors the fatal, after the error and before session_ended.
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
    // The end-interrupt call was delivered but died unanswered.
    const interrupts = fakeRecord(session, "interrupts.jsonl");
    expect(interrupts).toHaveLength(1);
  });

  test("a wrapper exiting 143 during shutdown fails the session (al41)", async () => {
    const session = await startAndWait({}, { FAKE_SIGTERM_PERSIST: "exit143" });
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
    expect(completed.raw).toBeNull();
    expect(completed.usage).toEqual({
      input_tokens: null,
      output_tokens: null,
      cached_input_tokens: null,
      total_tokens: null,
      cost_usd: null,
    });
    expect(await session.code).toBe(1);
    const interrupts = fakeRecord(session, "interrupts.jsonl");
    expect(interrupts).toHaveLength(1);
  });

  test("a shutdown while turn/start is in flight still interrupts the open turn", async () => {
    // The delayed turn/start response arrives during the protocol grace.
    const session = await startAndWait({}, { FAKE_TURNSTART_DELAY: "100" });
    send(session.driver, { type: "user", text: "scenario:wait held" });
    // The fake must have READ the turn/start before the shutdown's
    // SIGTERM arrives, or the signal finds nothing held to release and
    // the hold would last forever (the request's write and the signal
    // race the fake's stdin read otherwise). Poll its request log.
    const seen = await waitFor(
      session.events,
      () =>
        fakeRecord(session, "requests.jsonl").some((r) => r.method === "turn/start")
          ? true
          : undefined,
      "the fake to hold the turn/start"
    );
    expect(seen).toBe(true);
    // turn_started for t1 is already on the stream — emitted at submit
    // (review live15, trigger B: it used to ride the turn/started
    // notification, so a shutdown in this window synthesized a completion
    // for a turn the caller never saw open). The shutdown begins while
    // the turn/start response is still in flight; the response can only
    // land inside the drain window.
    const started = of("turn_started")(session.events) as Event;
    expect(started).toBeDefined();
    expect(started.turn_id).toBe("t1");
    send(session.driver, { type: "shutdown" });

    // The regression: the end-interrupt reached the harness at all.
    const interrupts = await waitForRecord(session, "interrupts.jsonl");
    expect(interrupts).toHaveLength(1);
    // The turn completed through the interrupt, inside the drain: the
    // harness's own completion frame, exactly one — no synthesis — and it
    // answers the t1 start the caller saw (§4.1's pairing).
    const completed = await waitFor(session.events, of("turn_completed"), "turn_completed");
    expect(completed.turn_id).toBe("t1");
    expect(completed.finish).toBe("interrupted");
    expect(
      session.events.filter((event) => event.type === "turn_completed")
    ).toHaveLength(1);
    expect(typeof completed.raw === "string" && completed.raw.includes("turn/completed")).toBe(true);
    const ended = await waitFor(session.events, of("session_ended"), "session_ended");
    expect(ended.reason).toBe("shutdown");
    expect(ended.exit_code).toBe(0);
    expect(session.events[session.events.length - 1]).toBe(ended);
    expect(await session.code).toBe(0);
    expect(of("error")(session.events)).toBeUndefined();
  });

  test("approvals still pending when the turn completes by itself are superseded", async () => {
    // Review live11, major 2: completeTurn never closed the approval
    // channel, so an approval that lost its race with the turn's own
    // completion stayed pending — a later decision was acked accepted for
    // a request the harness no longer held, while the expiry timer
    // waited to write a stray decline into whatever turn ran next. The
    // completion now supersedes it: declined on the wire, resolved
    // "superseded" to the caller, and a later decision for it is
    // unknown_request.
    const session = await startAndWait();
    send(session.driver, { type: "user", text: "scenario:asklose race" });
    await waitFor(session.events, of("permission_request"), "permission_request");
    // The app-server ends the turn by itself while the decision is out.
    const completed = await waitFor(session.events, of("turn_completed"), "turn_completed");
    expect(completed.finish).toBe("end");
    const superseded = await waitFor(
      session.events,
      (events) =>
        events.find(
          (event) => event.type === "permission_resolved" && event.resolution === "superseded"
        ),
      "superseded resolution"
    );
    expect(String(superseded.request_id)).toBe("\"appr-lose\"");
    // The decline reached the app-server, keyed to the lost approval.
    const decisions = await waitForRecord(session, "decisions.jsonl");
    expect(decisions.find((entry) => String(entry.id) === "appr-lose")?.result?.decision).toBe(
      "decline"
    );
    // The session survives and a second turn runs clean.
    send(session.driver, { type: "user", text: "scenario:basic after" });
    const second = await waitFor(
      session.events,
      (events) => events.filter((event) => event.type === "turn_completed")[1],
      "second turn_completed"
    );
    expect(second.finish).toBe("end");
    // A decision for the dead request is rejected, not applied — and no
    // second decline ever reaches the harness for it.
    send(session.driver, { type: "permission_decision", request_id: "\"appr-lose\"", decision: "allow" });
    const rejected = await waitFor(
      session.events,
      (events) =>
        events.find((event) => event.type === "input_rejected" && event.reason === "unknown_request"),
      "the unknown_request rejection"
    );
    expect(rejected.input_seq).toBe(3);
    expect(
      fakeRecord(session, "decisions.jsonl").filter((entry) => String(entry.id) === "appr-lose")
    ).toHaveLength(1);
    send(session.driver, { type: "shutdown" });
    expect(await session.code).toBe(0);
  });

  test("a turn that fails while its interrupt is pending completes failed with its own error", async () => {
    // Review live11, major 3: the interrupt override recast the
    // harness's own failed completion as "interrupted" (a rate limit
    // raced against a caller interrupt). The failure now outranks the
    // interrupt label and keeps its reason.
    const session = await startAndWait();
    send(session.driver, { type: "user", text: "scenario:failoninterrupt hold" });
    await waitFor(session.events, of("turn_started"), "turn_started");
    send(session.driver, { type: "interrupt" });
    const completed = await waitFor(session.events, of("turn_completed"), "turn_completed");
    expect(completed.turn_id).toBe("t1");
    expect(completed.finish).toBe("failed");
    expect(completed.reason).toBe("rate limit exceeded");
    // The interrupt was accepted on the wire and its response consumed.
    const interrupts = fakeRecord(session, "interrupts.jsonl");
    expect(interrupts).toHaveLength(1);
    expect(of("error")(session.events)).toBeUndefined();
    // The session continues: the interrupt flags died with the turn.
    send(session.driver, { type: "user", text: "scenario:basic after" });
    const second = await waitFor(
      session.events,
      (events) => events.filter((event) => event.type === "turn_completed")[1],
      "second turn_completed"
    );
    expect(second.finish).toBe("end");
    send(session.driver, { type: "shutdown" });
    expect(await session.code).toBe(0);
  });

  test("a stale interrupt rejection cannot clear the next turn's interrupt state", async () => {
    // Review live11, major 4: pendingCalls stored only "interrupt", so a
    // rejection whose turn had already completed cleared the interrupt
    // flags of whatever turn was interrupted next — a turn-timeout
    // completion lost its "turn-timeout" reason. t1's interrupt is held
    // unanswered while t1 completes on its own; the rejection flushes
    // only when t2's timeout interrupt arrives, and must clear nothing
    // but itself.
    const session = await startAndWait({ turnTimeoutMs: 800 });
    send(session.driver, { type: "user", text: "scenario:staleinterrupt one" });
    await waitFor(session.events, of("turn_started"), "turn_started");
    send(session.driver, { type: "interrupt" });
    // t1 completes on its own with the interrupt still pending — the
    // driver's own honest label for the race.
    const first = await waitFor(session.events, of("turn_completed"), "t1 completed");
    expect(first.finish).toBe("interrupted");
    // t2 holds until its turn timeout interrupts it; that request is
    // what flushes t1's stale rejection ahead of its own answer.
    send(session.driver, { type: "user", text: "scenario:wait two" });
    const second = await waitFor(
      session.events,
      (events) => events.filter((event) => event.type === "turn_completed")[1],
      "t2 completed"
    );
    expect(second.turn_id).toBe("t2");
    expect(second.finish).toBe("interrupted");
    expect(second.reason).toBe("turn-timeout");
    // The stale rejection itself was reported non-fatally, exactly once,
    // and the session survived it.
    const staleErrors = session.events.filter(
      (event) =>
        event.type === "error" &&
        event.fatal === false &&
        String(event.message).includes("the turn cannot be interrupted")
    );
    expect(staleErrors).toHaveLength(1);
    send(session.driver, { type: "shutdown" });
    expect(await session.code).toBe(0);
  });

  test("a turn the wire completed is never recast interrupted by a racing timeout", async () => {
    // Review live14: completeTurn recast a wire "completed" as
    // "interrupted" (and, on the timeout path, reason "turn-timeout")
    // whenever its own interrupt was still in flight — a turn that
    // delivered its full answer was reported cut short, and the
    // interrupt's later rejection could not correct it. The latecomplete
    // scenario holds the interrupt's response while the turn completes
    // cleanly on its own, then rejects the interrupt: the wire's status
    // is the verdict. (The claude family's driver-owned label exists
    // because ITS wire never says interrupted — an interrupt arrives as
    // an error result there; codex's wire says it itself.)
    const session = await startAndWait({ turnTimeoutMs: 400 });
    send(session.driver, { type: "user", text: "scenario:latecomplete race" });
    const completed = await waitFor(session.events, of("turn_completed"), "turn_completed");
    expect(completed.finish).toBe("end");
    expect(completed.reason ?? null).toBe(null);
    // The too-late rejection is a separate driver event behind the
    // completion the fake wrote ahead of it: wait for it rather than
    // reading the array once (a load-slow event loop made that read race
    // under the full suite), then count after the session is fully over.
    await waitFor(
      session.events,
      (events) =>
        events.find(
          (event) =>
            event.type === "error" &&
            event.fatal === false &&
            String(event.message).includes("no longer running")
        ) ?? undefined,
      "the too-late rejection"
    );
    send(session.driver, { type: "shutdown" });
    expect(await session.code).toBe(0);
    expect(
      session.events.filter((event) => event.type === "turn_completed")
    ).toHaveLength(1);
    expect(
      session.events.filter(
        (event) =>
          event.type === "error" &&
          event.fatal === false &&
          String(event.message).includes("no longer running")
      )
    ).toHaveLength(1);
  });

  test("a first late thread/started naming the resumed thread passes through", async () => {
    // Review live11's resume probe: the reference clients of the same
    // app-server adopt the resumed thread from the thread/resume
    // response (validating its thread.id) and none waits for — or, on
    // the real server, receives — a thread/started there. A server that
    // announces anyway (FAKE_RESUME_ANNOUNCES) lands the notification
    // after adoption: tier-1 passthrough, not a fatal — the parser's
    // second-thread/started guard cannot know the driver adopted ahead
    // of the notification, and this is the notification's first
    // sighting on the wire.
    const session = await startSession(
      { resumeThreadId: "0123456789abcdef" },
      { FAKE_RESUME_ANNOUNCES: "1" }
    );
    const started = await waitFor(session.events, of("session_started"), "session_started");
    expect(started.session_id).toBe("0123456789abcdef");
    // Adopted from the response: codemux-originated, raw null — the
    // notification had not arrived when the session was announced.
    expect(started.raw).toBeNull();
    const unknown = await waitFor(
      session.events,
      (events) =>
        events.find(
          (event) => event.type === "unknown" && String(event.raw).includes("thread/started")
        ),
      "the late thread/started passthrough"
    );
    expect(unknown).toBeDefined();
    expect(of("error")(session.events)).toBeUndefined();
    // The session works: a turn runs to completion.
    send(session.driver, { type: "user", text: "scenario:basic again" });
    await waitFor(session.events, of("turn_completed"), "turn_completed");
    send(session.driver, { type: "shutdown" });
    expect(await session.code).toBe(0);
  });
});

describe("codex session e2e - review live17", () => {
  test("the end-interrupt is answered before the stop signal", async () => {
    // Correctness 3: the interrupt and the SIGTERM went out in one step,
    // so an app-server that dies on SIGTERM (the default fake) never
    // answered it and the turn was synthesized. The interrupt now gets
    // the grace first; the turn closes through the wire's own completion.
    const session = await startAndWait();
    send(session.driver, { type: "user", text: "scenario:wait hold" });
    await waitFor(session.events, of("turn_started"), "turn_started");
    send(session.driver, { type: "shutdown" });
    await waitFor(session.events, of("session_ended"), "session_ended");
    const completed = session.events.find((event) => event.type === "turn_completed");
    expect(completed?.finish).toBe("interrupted");
    expect(completed?.raw).not.toBeNull();
    expect(await session.code).toBe(0);
  });

  test("a nonzero exit during an idle shutdown costs success", async () => {
    // Correctness 4: the drain verdict required an open turn.
    const session = await startAndWait({}, { FAKE_SIGTERM_PERSIST: "exit42" });
    send(session.driver, { type: "user", text: "scenario:basic one" });
    await waitFor(session.events, of("turn_completed"), "turn_completed");
    send(session.driver, { type: "shutdown" });
    const ended = await waitFor(session.events, of("session_ended"), "session_ended");
    expect(ended.exit_code).toBe(1);
    expect(await session.code).toBe(1);
    const fatal = session.events.find((event) => event.type === "error" && event.fatal === true);
    expect(fatal?.message).toBe("the codex process exited with code 42 during the shutdown drain");
  });

  test("--turn-timeout re-arms, and a turn that ignores its interrupt ends the session", async () => {
    // Correctness 5: the timer fired once; a turn whose interrupt was
    // accepted but never acted on ran uncapped.
    const session = await startAndWait({ turnTimeoutMs: 300 });
    send(session.driver, { type: "user", text: "scenario:deaf hold" });
    const ended = await waitFor(session.events, of("session_ended"), "session_ended", 8_000);
    expect(ended.reason).toBe("timeout");
    expect(await session.code).toBe(1);
    // The timeout interrupt, its re-armed expiry, then the end-interrupt.
    expect(fakeRecord(session, "interrupts.jsonl")).toHaveLength(2);
    const fatal = session.events.find((event) => event.type === "error" && event.fatal === true);
    expect(fatal?.message).toContain("did not end within --turn-timeout");
    const completions = session.events.filter((event) => event.type === "turn_completed");
    expect(completions).toHaveLength(1);
    // Review live22: an end that raised a fatal answers the open turn
    // failed, naming the fatal, never as an orderly interruption.
    expect(completions[0]!.finish).toBe("failed");
    expect(completions[0]!.reason).toContain("did not end within --turn-timeout");
  });

  test("an approval that offers no refusal is never forwarded or answered off-list", async () => {
    // Correctness 7: pickApprovalDecision answered "decline" to a request
    // whose availableDecisions named neither decline nor cancel, after
    // telling the caller deny. Such a request is now answered with a
    // JSON-RPC error, passed through raw, and its turn interrupted.
    const session = await startAndWait();
    send(session.driver, { type: "user", text: "scenario:refusalless go" });
    await waitFor(session.events, of("turn_completed"), "turn_completed");
    expect(of("permission_request")(session.events)).toBeUndefined();
    expect(of("permission_resolved")(session.events)).toBeUndefined();
    const decisions = await waitForRecord(session, "decisions.jsonl");
    expect(decisions[0]?.id).toBe("appr-norefuse");
    expect(decisions[0]?.error).not.toBeNull();
    expect(decisions[0]?.result).toEqual({});
    await waitForRecord(session, "interrupts.jsonl");
    const notice = session.events.find((event) => event.type === "error");
    expect(notice?.fatal).toBe(false);
    expect(notice?.message).toContain("offered no refusal decision");
    expect(
      session.events.some(
        (event) => event.type === "unknown" && String(event.raw).includes("appr-norefuse")
      )
    ).toBe(true);
    send(session.driver, { type: "shutdown" });
    await waitFor(session.events, of("session_ended"), "session_ended");
    expect(await session.code).toBe(0);
  });
});

describe("codex session e2e - review live18", () => {
  test("a usage update that lands after its turn completed is not charged to the next turn", async () => {
    // Correctness minor: a tokenUsage notification arriving with no turn
    // open accumulated into the next turn's total. It now folds into the
    // session cumulative alone, and its event carries a null turn_id.
    const session = await startAndWait();
    send(session.driver, { type: "user", text: "scenario:lateusage one" });
    const late = await waitFor(session.events, of("usage"), "late usage");
    expect(late.turn_id).toBeNull();
    const first = session.events.find((event) => event.type === "turn_completed");
    expect(first?.usage.total_tokens).toBeNull();
    send(session.driver, { type: "user", text: "scenario:basic two" });
    const second = await waitFor(
      session.events,
      (events) => events.find((event) => event.type === "turn_completed" && event.turn_id === "t2"),
      "turn_completed t2"
    );
    expect(second.usage.total_tokens).toBe(18979);
    send(session.driver, { type: "shutdown" });
    const ended = await waitFor(session.events, of("session_ended"), "session_ended");
    expect(ended.usage.total_tokens).toBe(18979 + 1007);
    expect(await session.code).toBe(0);
  });

  test("a nonzero exit after the drained completion costs success", async () => {
    // Sibling of the claude-family correctness 6: a delivered completion
    // excused every nonzero exit, but no exit convention was ever recorded
    // for the app-server. The fake answers the end-interrupt, then exits 1.
    const session = await startAndWait({}, { FAKE_SIGTERM_PERSIST: "exit1" });
    send(session.driver, { type: "user", text: "scenario:wait hold" });
    await waitFor(session.events, of("turn_started"), "turn_started");
    send(session.driver, { type: "shutdown" });
    const ended = await waitFor(session.events, of("session_ended"), "session_ended");
    expect(ended.exit_code).toBe(1);
    expect(of("turn_completed")(session.events)?.finish).toBe("interrupted");
    expect(await session.code).toBe(1);
    const fatal = session.events.find((event) => event.type === "error" && event.fatal === true);
    expect(fatal?.message).toBe("the codex process exited with code 1 during the shutdown drain");
  });
});
