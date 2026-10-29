import { afterAll, describe, expect, test } from "bun:test";
import { cleanupSessions, type Event, of, send, startAndWait, startSession, waitFor, waitForRecord } from "./session-codex-e2e-helpers.js";

afterAll(cleanupSessions);

describe("codex session e2e - stream tiers", () => {
  test("a non-JSON line is a tier-3 fatal crash", async () => {
    const session = await startAndWait();
    send(session.driver, { type: "user", text: "scenario:garbage junk" });
    await waitFor(
      session.events,
      (events) => events.find((event) => event.type === "error" && event.fatal === true),
      "the fatal error"
    );
    expect(await session.code).toBe(1);
    const ended = session.events[session.events.length - 1] as Event;
    expect(ended.type).toBe("session_ended");
    expect(ended.reason).toBe("crash");
    expect(ended.resumable).toBe(true);
  });

  test("an event for a foreign thread is a tier-2 fatal with the raw preserved", async () => {
    const session = await startAndWait();
    send(session.driver, { type: "user", text: "scenario:badthread foreign" });
    // The raw passthrough: the specific unknown event carrying the
    // foreign frame (the turn/started notification also mirrors as
    // unknown now, review live15, so "first unknown" no longer finds it).
    const unknown = await waitFor(
      session.events,
      (events) =>
        events.find(
          (event) =>
            event.type === "unknown" &&
            typeof event.raw === "string" &&
            event.raw.includes("ffffffff-eeee-dddd")
        ),
      "the raw passthrough"
    );
    expect(String(unknown.raw).includes("ffffffff-eeee-dddd")).toBe(true);
    const error = await waitFor(
      session.events,
      (events) => events.find((event) => event.type === "error" && event.fatal === true),
      "the fatal error"
    );
    expect(error.message).toContain("thread");
    expect(await session.code).toBe(1);
    const ended = session.events[session.events.length - 1] as Event;
    expect(ended.reason).toBe("crash");
  });

  test("a second thread/started is a tier-2 fatal", async () => {
    const session = await startAndWait();
    send(session.driver, { type: "user", text: "scenario:secondthread dupe" });
    await waitFor(
      session.events,
      (events) => events.find((event) => event.type === "error" && event.fatal === true),
      "the fatal error"
    );
    expect(await session.code).toBe(1);
  });

  test("a frame split by a raw newline rejoins and streams", async () => {
    const session = await startAndWait();
    send(session.driver, { type: "user", text: "scenario:rawnewline split" });
    const delta = await waitFor(
      session.events,
      (events) => events.find((event) => event.type === "assistant_delta"),
      "the rejoined delta"
    );
    expect(delta.delta).toBe("split\nline");
    const completed = await waitFor(session.events, of("turn_completed"), "turn_completed");
    expect(completed.finish).toBe("end");
    send(session.driver, { type: "shutdown" });
    expect(await session.code).toBe(0);
  });

  test("a fragment the stream ends inside is reported tier 3, never dropped (review live25)", async () => {
    // Review live25, correctness-2 minor 3: the parser buffered the
    // fragment waiting for its continuation, and nothing reported it when
    // the stream ended, so its output vanished without an event.
    const session = await startAndWait();
    send(session.driver, { type: "user", text: "scenario:fragment cut" });
    expect(await session.code).toBe(1);
    const fragment = session.events.find(
      (event) => event.type === "error" && String(event.message ?? "").includes("unterminated JSON fragment")
    ) as Event;
    expect(fragment).toBeDefined();
    expect(fragment.fatal).toBe(true);
    expect(fragment.source).toBe("harness");
    expect(String(fragment.message)).toContain('"delta":"cut off');
    const ended = session.events[session.events.length - 1] as Event;
    expect(ended.type).toBe("session_ended");
  });

  test("a harness crash ends the session through the crash path", async () => {
    // Extended review live11, minor 5: the crash path already told the
    // failure story, but the live9 verdict then added a second, false
    // "during the shutdown drain" fatal for the same exit, and the open
    // turn's turn_started was never answered — the synthesis only covered
    // exit codes null and 0. The crash now emits one fatal and the turn
    // receives a failed completion.
    const session = await startAndWait();
    send(session.driver, { type: "user", text: "scenario:crash boom" });
    await waitFor(
      session.events,
      (events) => events.find((event) => event.type === "error" && event.fatal === true),
      "the crash error"
    );
    expect(await session.code).toBe(1);
    const ended = session.events[session.events.length - 1] as Event;
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
    const completed = session.events.find(
      (event) => event.type === "turn_completed"
    ) as Event;
    expect(completed).toBeDefined();
    expect(completed.turn_id).toBe("t1");
    expect(completed.finish).toBe("failed");
    // Review live17: the reason is the fatal that ended the session.
    expect(completed.reason).toContain("the codex process exited with code 1 during the shutdown drain before completing its open turn");
    expect(completed.usage).toEqual({
      input_tokens: null,
      output_tokens: null,
      cached_input_tokens: null,
      total_tokens: null,
      cost_usd: null,
    });
  });

  test("a text whose turn/start frame cannot fit is rejected text_too_long before the ack", async () => {
    // The codex frame cannot be built at ack time (the JSON-RPC id and
    // thread id are assigned at send), so the check is the escaped
    // literal plus a wrapper margin: 16 MiB of quotes escapes to 32 MiB,
    // far past the 17 MiB write cap even with the margin's slack.
    const session = await startAndWait();
    send(session.driver, { type: "user", text: '"'.repeat(16 * 1024 * 1024) });
    const rejected = await waitFor(
      session.events,
      (events) => events.find((event) => event.type === "input_rejected"),
      "the text_too_long rejection"
    );
    expect(rejected.reason).toBe("text_too_long");
    // The line was never echoed and no turn opened for it.
    expect(of("user_message")(session.events)).toBeUndefined();
    expect(of("turn_started")(session.events)).toBeUndefined();
    send(session.driver, { type: "shutdown" });
    expect(await session.code).toBe(0);
  });

  test("a harness-stdin write failure is a fatal codemux error, not a silent diagnostic", async () => {
    // M2's escalation: a refused write after the ack ends the session as
    // codemux's own failure instead of leaving the turn hanging open. The
    // turn is submitted from idle so the turn/start write happens now
    // (mid-turn input would queue in the FIFO instead of writing).
    const session = await startAndWait();
    send(session.driver, { type: "user", text: "scenario:basic first" });
    await waitFor(session.events, of("turn_completed"), "turn_completed");
    session.proc.writeLine = () => ({ ok: false, reason: "closed" });
    send(session.driver, { type: "user", text: "scenario:basic second" });
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

  test("signal handlers stay installed until cleanup completes", async () => {
    // Review live5, major 1: finish() used to dispose the signal gate
    // early, so a second SIGINT/SIGTERM during the shutdown grace hit
    // Node's default disposition and killed codemux mid-kill. The gate
    // must stay installed until the child has settled and session_ended
    // is out. Deterministic: send() runs finish()'s synchronous prefix
    // (the end-interrupt write, requestStop) while the awaits from
    // proc.settled onward resume only on a later event-loop turn.
    const count = () =>
      process.listenerCount("SIGINT") +
      process.listenerCount("SIGTERM") +
      process.listenerCount("SIGHUP");
    const session = await startAndWait();
    send(session.driver, { type: "user", text: "scenario:basic hello" });
    await waitFor(session.events, of("turn_completed"), "turn_completed");
    const withGate = count();
    send(session.driver, { type: "shutdown" });
    // Mid-cleanup: the gate's three listeners must still be installed.
    expect(count()).toBe(withGate);
    expect(await session.code).toBe(0);
    // Cleanup complete: exactly the gate came off.
    expect(count()).toBe(withGate - 3);
  });

  test("the shutdown drain delivers the harness's final output", async () => {
    // Review live5, major 2: harness lines were dropped once `finished`
    // flipped, so the app-server's answer to the end-interrupt — the
    // interrupted turn's completion and its last tokenUsage — vanished
    // during the grace window: no turn_completed, a null-usage
    // session_ended, exit 0. FAKE_SIGTERM_PERSIST keeps the fake alive
    // past the shutdown SIGTERM the way the real app-server survives
    // inside the grace window, so its last frames must reach the caller.
    const session = await startAndWait({}, { FAKE_SIGTERM_PERSIST: "1" });
    send(session.driver, { type: "user", text: "scenario:wait held" });
    await waitFor(session.events, of("turn_started"), "turn_started");
    send(session.driver, { type: "shutdown" });

    const completed = await waitFor(
      session.events,
      (events) => events.find((event) => event.type === "turn_completed"),
      "drained turn_completed"
    );
    expect(completed.turn_id).toBe("t1");
    expect(completed.finish).toBe("interrupted");
    expect(completed.usage).toEqual({
      input_tokens: 14,
      output_tokens: 2,
      cached_input_tokens: 0,
      total_tokens: 16,
      cost_usd: null,
    });
    const ended = await waitFor(session.events, of("session_ended"), "session_ended");
    expect(ended.reason).toBe("shutdown");
    expect(ended.usage).toEqual(completed.usage);
    expect(session.events[session.events.length - 1]).toBe(ended);
    expect(await session.code).toBe(0);
    // The end path's interrupt was a real correlated call: the fake
    // answered it, and the response was consumed — not an unknown-id
    // fatal — so no error event may sit on the stream.
    expect(of("error")(session.events)).toBeUndefined();
  });

  test("a fatal arriving during the shutdown drain costs success", async () => {
    // Review live7, major 2: once `finish` began, its re-entry guard
    // ignored every later failure call — the driver emitted the tier-3
    // fatal and still exited 0 with reason "shutdown". Cleanup stays
    // idempotent; the verdict does not freeze until the child settles: a
    // fatal line arriving inside the grace window raises the exit code
    // to 1. FAKE_SIGTERM_PERSIST=garbage keeps the fake app-server alive
    // past the shutdown SIGTERM and emits one non-JSON line before
    // dying.
    const session = await startAndWait({}, { FAKE_SIGTERM_PERSIST: "garbage" });
    send(session.driver, { type: "user", text: "scenario:wait held" });
    await waitFor(session.events, of("turn_started"), "turn_started");
    send(session.driver, { type: "shutdown" });

    const ended = await waitFor(session.events, of("session_ended"), "session_ended");
    expect(ended.reason).toBe("shutdown");
    const fatal = session.events.find(
      (event) => event.type === "error" && event.fatal === true
    );
    expect(fatal).toBeDefined();
    expect(fatal!.source).toBe("harness");
    expect(fatal!.message).toContain("unusable harness output");
    expect(session.events[session.events.length - 1]).toBe(ended);
    expect(await session.code).toBe(1);
  });

  test("an approval arriving during the shutdown drain is declined and resolved", async () => {
    // Review live8, major 2 (the codex sibling): an approval request
    // landing inside the grace window — after finish() declined
    // everything it found pending — used to register with an expiry
    // timer the end path had already cleared, while the caller's
    // decision channel was already closed: the app-server waited on an
    // answer that could never come, stalling the persistence the grace
    // window exists for. The request is now declined at once with the
    // supersede treatment. FAKE_SIGTERM_PERSIST=ask makes the fake
    // surface the approval from the end-interrupt (keeping the turn
    // open so the request classifies against the driver's open harness
    // turn), which the driver writes inside the end path —
    // deterministically inside the drain.
    const session = await startAndWait({}, { FAKE_SIGTERM_PERSIST: "ask" });
    send(session.driver, { type: "user", text: "scenario:wait held" });
    await waitFor(session.events, of("turn_started"), "turn_started");
    send(session.driver, { type: "shutdown" });

    const request = await waitFor(
      session.events,
      of("permission_request"),
      "drain permission_request"
    );
    expect(String(request.request_id)).toBe("appr-drain");
    const resolved = await waitFor(
      session.events,
      (events) =>
        events.find(
          (event) =>
            event.type === "permission_resolved" && String(event.request_id) === "appr-drain"
        ),
      "drain permission_resolved"
    );
    expect(resolved.resolution).toBe("superseded");
    // The decline reached the app-server, keyed to the request it denied.
    // Polled, not read at once: permission_resolved fires when the driver
    // WRITES the decline, while the fake records it only after reading it
    // off its stdin — a pipe round-trip the one-shot read used to race.
    // (The file's other synchronous decisions.jsonl reads all sit behind
    // a wait that already proves the record exists; this one is the only
    // read whose event cannot order it.)
    const decisions = await waitForRecord(session, "decisions.jsonl");
    const decline = decisions.find((entry) => String(entry.id) === "appr-drain");
    expect(decline?.result?.decision).toBe("decline");
    // The denial does not forfeit the drain: the held interrupt is
    // answered and the interrupted turn's completion still arrives.
    const completed = await waitFor(
      session.events,
      (events) => events.find((event) => event.type === "turn_completed"),
      "drained turn_completed"
    );
    expect(completed.finish).toBe("interrupted");
    const ended = await waitFor(session.events, of("session_ended"), "session_ended");
    expect(ended.reason).toBe("shutdown");
    expect(session.events[session.events.length - 1]).toBe(ended);
    expect(await session.code).toBe(0);
    expect(of("error")(session.events)).toBeUndefined();
  });

  test("caller input during the shutdown drain is rejected shutting_down, never dropped", async () => {
    // Review live9, contracts: §4.1 and the README promise every input
    // line is acknowledged, but the driver's guard returned before
    // parsing once `finished` flipped — the documented `shutting_down`
    // reason was unreachable dead code. The drain window (`finished`,
    // not yet `settled`) now answers every line with the rejection; the
    // two sends are synchronous, so the second line deterministically
    // lands inside the drain.
    const session = await startAndWait();
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
    expect(session.events.filter((event) => event.type === "user_message")).toHaveLength(1);
    const ended = await waitFor(session.events, of("session_ended"), "session_ended");
    expect(ended.reason).toBe("shutdown");
    expect(session.events[session.events.length - 1]).toBe(ended);
    expect(await session.code).toBe(0);
  });
});
