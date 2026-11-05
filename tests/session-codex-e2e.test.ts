import { afterAll, describe, expect, test } from "bun:test";
import { MAX_HELD_INPUT_LINES } from "../src/session/codex-driver.js";
import { readRegistry } from "../src/session/registry.js";
import { cleanupSessions, type Event, fakeRecord, of, send, startAndWait, startSession, waitFor, waitForRecord } from "./session-codex-e2e-helpers.js";

afterAll(cleanupSessions);

describe("codex session e2e - lifecycle", () => {
  test("a fresh session handshakes, runs one turn, and ends cleanly on shutdown", async () => {
    const session = await startAndWait();
    const started = of("session_started")(session.events) as Event;
    expect(started.agent).toBe("codex");
    expect(started.autonomy).toBe("high");
    expect(started.sandboxed).toBe(true);
    expect(started.protocol).toBe("codemux-live-session/1");
    expect(started.capabilities).toEqual({
      live_input: true,
      user_during_turn: "queue",
      steer: true,
      interrupt: true,
      permissions: true,
      deltas: true,
      file_changes: "native",
      usage_stream: true,
      resume: true,
    });
    expect(started.session_id).toBe("0123456789abcdef");
    expect(String(started.raw)).toContain("thread/started");

    // The handshake the fixture pinned: initialize, initialized
    // notification, thread/start, and only then the turn.
    const requests = fakeRecord(session, "requests.jsonl");
    expect(requests.map((r) => r.method)).toEqual([
      "initialize",
      "notifications/initialized",
      "thread/start",
    ]);

    send(session.driver, { type: "user", text: "scenario:basic hello" });
    const echo = await waitFor(session.events, of("user_message"), "user_message");
    expect(echo.text).toBe("scenario:basic hello");
    expect(echo.turn_id).toBe("t1");
    const turnStarted = await waitFor(session.events, of("turn_started"), "turn_started");
    expect(turnStarted.turn_id).toBe("t1");
    // Review live15: turn_started is emitted at submit, claude-family
    // style — codemux-originated, raw null — never by riding the
    // harness's turn/started notification. The notification itself is a
    // harness echo of codemux's own announcement and mirrors as tier-1
    // unknown.
    expect(turnStarted.raw).toBeNull();
    // Waited, not read at once: turn_started is emitted at submit, so the
    // notification's mirror needs its own pipe round-trip after it — a
    // loaded runner once split that round-trip past the immediate read.
    await waitFor(
      session.events,
      (events) =>
        events.find(
          (event) => event.type === "unknown" && String(event.raw).includes("turn/started")
        ),
      "the turn/started mirror"
    );
    const message = await waitFor(session.events, of("assistant_message"), "assistant_message");
    expect(message.text).toBe("Hello.");
    expect(message.turn_id).toBe("t1");
    const deltas = session.events.filter((event) => event.type === "assistant_delta");
    expect(deltas.map((delta) => delta.delta).join("")).toBe("Hello.");
    const completed = await waitFor(session.events, of("turn_completed"), "turn_completed");
    expect(completed.finish).toBe("end");
    expect(completed.turn_id).toBe("t1");
    expect(completed.usage).toEqual({
      input_tokens: 6686,
      output_tokens: 5,
      cached_input_tokens: 12288,
      total_tokens: 18979,
      cost_usd: null,
    });

    send(session.driver, { type: "shutdown" });
    const code = await session.code;
    expect(code).toBe(0);
    const ended = session.events[session.events.length - 1] as Event;
    expect(ended.type).toBe("session_ended");
    expect(ended.reason).toBe("shutdown");
    expect(ended.resumable).toBe(true);
    expect(ended.usage).toEqual(completed.usage);

    // The registry recorded the session under the thread id (§4.8).
    const registry = readRegistry(session.options.registryPath as string);
    expect(registry.outcome).toBe("ok");
    const entry =
      registry.outcome === "ok"
        ? registry.file.sessions.find((r) => r.id === "0123456789abcdef")
        : undefined;
    expect(entry?.agent).toBe("codex");
    expect(entry?.ended).not.toBe(null);
  });

  test("the home settles onto its key before the registry record is released (review D7, correctness-2 1)", async () => {
    // The window the finding named: the end path closed the record
    // BEFORE renaming the fresh override home onto its session-keyed
    // path, so a --resume arriving in between found a released record
    // whose harness_home named a path that did not exist yet — refused
    // "missing or untrusted" for a session that was resumable a moment
    // later. The settle seam must run while the record is still open:
    // the release is what a resume waits on.
    const observed: Array<{ threadId: string | null; recordEnded: boolean | null }> = [];
    const session = await startSession({
      settleSessionHome: (threadId) => {
        const registry = readRegistry(session.options.registryPath as string);
        const entry =
          registry.outcome === "ok"
            ? registry.file.sessions.find((r) => r.id === threadId)
            : undefined;
        observed.push({
          threadId,
          recordEnded: entry === undefined ? null : entry.ended !== null,
        });
        return true; // the rename landed
      },
    });
    send(session.driver, { type: "user", text: "scenario:basic hello" });
    await waitFor(session.events, of("turn_completed"), "turn_completed");
    send(session.driver, { type: "shutdown" });
    expect(await session.code).toBe(0);
    const ended = session.events[session.events.length - 1] as Event;
    expect(ended.resumable).toBe(true);
    // The settle ran exactly once, on the real thread id, and the record
    // was STILL OPEN when it did — the release had not happened yet.
    expect(observed).toEqual([{ threadId: "0123456789abcdef", recordEnded: false }]);
    // After the end the record is closed: the release did happen, just
    // never before the settle.
    const registry = readRegistry(session.options.registryPath as string);
    expect(registry.outcome).toBe("ok");
    const entry =
      registry.outcome === "ok"
        ? registry.file.sessions.find((r) => r.id === "0123456789abcdef")
        : undefined;
    expect(entry?.ended).not.toBe(null);
  });

  test("caller input that arrives before session_started buffers and replays", async () => {
    const session = await startSession();
    // Sent before run() has seen session_started: nothing may answer yet.
    send(session.driver, { type: "user", text: "scenario:basic early" });
    await waitFor(session.events, of("session_started"), "session_started");
    const completed = await waitFor(session.events, of("turn_completed"), "turn_completed");
    expect(completed.turn_id).toBe("t1");
    send(session.driver, { type: "shutdown" });
    expect(await session.code).toBe(0);
  });

  test("two user lines before session_started run as two turns in order (review live16)", async () => {
    // Review live16, correctness blocker: the replay opened t1 for the
    // first parked line and queued the second, then announceSession's
    // unconditional drainTurnQueue submitted t2 while t1 was still open
    // — the FSM refused, and the session crashed with exit 1 after both
    // lines were acked accepted.
    const session = await startSession();
    send(session.driver, { type: "user", text: "scenario:basic first" });
    send(session.driver, { type: "user", text: "scenario:basic second" });
    await waitFor(
      session.events,
      (events) => events.filter((event) => event.type === "turn_completed")[1],
      "the second turn_completed"
    );
    send(session.driver, { type: "shutdown" });
    expect(await session.code).toBe(0);
    expect(session.events.find((event) => event.type === "error")).toBeUndefined();
    const completed = session.events.filter((event) => event.type === "turn_completed");
    expect(completed.map((event) => [event.turn_id, event.finish])).toEqual([
      ["t1", "end"],
      ["t2", "end"],
    ]);
    const ended = session.events[session.events.length - 1] as Event;
    expect(ended.reason).toBe("shutdown");
  });

  test("stdin close mid-turn interrupts and ends cleanly", async () => {
    const session = await startAndWait();
    send(session.driver, { type: "user", text: "scenario:wait hold" });
    await waitFor(session.events, of("turn_started"), "turn_started");
    session.driver.handleCallerEnd();
    expect(await session.code).toBe(0);
    const ended = session.events[session.events.length - 1] as Event;
    expect(ended.type).toBe("session_ended");
    expect(ended.reason).toBe("stdin-close");
  });

  test("the session timeout ends the session", async () => {
    const session = await startSession({ sessionTimeoutMs: 300 });
    expect(await session.code).toBe(1);
    const ended = session.events[session.events.length - 1] as Event;
    expect(ended.type).toBe("session_ended");
    expect(ended.reason).toBe("timeout");
  });

  test("a resumed thread adopts its id and starts from idle", async () => {
    const session = await startSession({ resumeThreadId: "0123456789abcdef" });
    const started = await waitFor(session.events, of("session_started"), "session_started");
    expect(started.session_id).toBe("0123456789abcdef");
    const requests = fakeRecord(session, "requests.jsonl");
    expect(requests.map((r) => r.method)).toEqual([
      "initialize",
      "notifications/initialized",
      "thread/resume",
    ]);
    send(session.driver, { type: "user", text: "scenario:basic again" });
    await waitFor(session.events, of("turn_completed"), "turn_completed");
    send(session.driver, { type: "shutdown" });
    expect(await session.code).toBe(0);
  });

  test("a thread response naming an id --resume would refuse fails closed (review live16)", async () => {
    // Review live16, correctness major: the response's thread.id was
    // adopted unchecked, and one past the registry's cap made the whole
    // registry corrupt — every resume refused, the next start reset it.
    const session = await startSession({}, { FAKE_THREAD_ID: "t".repeat(129) });
    expect(await session.code).toBe(1);
    const fatal = session.events.find((event) => event.type === "error" && event.fatal === true);
    expect(fatal?.message).toBe("the thread response carries an invalid thread id");
    expect(of("session_started")(session.events)).toBeUndefined();
    expect(readRegistry(session.options.registryPath as string).outcome).toBe("missing");
  });

  test("a resume answered with a different thread id fails closed", async () => {
    // Review live12: `threadId` is preset to the requested id at
    // construction, so the adopt-if-null never ran for a resume and the
    // response's thread.id — the subscription proof the reference
    // clients validate — was never checked. A server resuming into a
    // DIFFERENT thread ran unannounced under the wrong id. The mismatch
    // now fails closed: one fatal naming both ids, no session_started,
    // and a crash end. (FAKE_RESUME_WRONG_THREAD answers the resume
    // with ffffffff-eeee-dddd-cccc-bbbbbbbbbbbb and sends no
    // thread/started, as the real server does on resume.)
    const session = await startSession(
      { resumeThreadId: "0123456789abcdef" },
      { FAKE_RESUME_WRONG_THREAD: "1" }
    );
    expect(await session.code).toBe(1);
    const fatal = session.events.find((event) => event.type === "error" && event.fatal === true);
    expect(fatal).toBeDefined();
    expect(fatal!.source).toBe("harness");
    expect(fatal!.message).toContain(
      "resumed thread ffffffff-eeee-dddd-cccc-bbbbbbbbbbbb, not the requested 0123456789abcdef"
    );
    expect(of("session_started")(session.events)).toBeUndefined();
    const ended = session.events[session.events.length - 1] as Event;
    expect(ended.type).toBe("session_ended");
    expect(ended.reason).toBe("crash");
  });

  test("a shutdown that arrives while the handshake is stalled still ends the session", async () => {
    // Review live4, codex blocker 2: every caller line buffered during
    // startup, shutdown included, so an initialize that never answered
    // held the graceful end hostage behind an unlimited default session.
    // The fake records the initialize and never responds
    // (FAKE_STALL_INIT), and the shutdown must still take effect.
    const session = await startSession({}, { FAKE_STALL_INIT: "1" });
    // The fake is up and its stalled initialize is on record before the
    // end begins. An end that raced the fake's own startup let the stop
    // grace run out on a process that had not read stdin yet, and its
    // SIGTERM exit failed the session (seen once under load).
    await waitForRecord(session, "requests.jsonl", 1);
    send(session.driver, { type: "shutdown" });
    // The regression: this await used to hang until a turn-timeout or an
    // external kill; the acked shutdown ends the session at once.
    expect(await session.code).toBe(0);
    const ended = session.events[session.events.length - 1] as Event;
    expect(ended.type).toBe("session_ended");
    expect(ended.reason).toBe("shutdown");
    // The session never existed: no session_started, and what the fake
    // recorded is handshake-only, never any turn traffic.
    expect(of("session_started")(session.events)).toBeUndefined();
    const requests = fakeRecord(session, "requests.jsonl");
    expect(requests.every((r) => r.method === "initialize")).toBe(true);
  });

  test("caller lines parked behind a stalled handshake are bounded", async () => {
    // Review live19: every line sent while the handshake was pending went
    // into preSessionLines with no count or byte limit, so an app-server
    // that never answered initialize let the caller grow codemux's
    // memory without bound. Past the bound the session ends with a
    // fatal, and every parked line is answered shutting_down in arrival
    // order.
    const session = await startSession({}, { FAKE_STALL_INIT: "1" });
    const lines = MAX_HELD_INPUT_LINES + 1;
    for (let index = 0; index < lines; index++) {
      send(session.driver, { type: "user", text: `parked ${index}` });
    }
    expect(await session.code).toBe(1);
    const fatal = session.events.find((event) => event.type === "error" && event.fatal === true);
    expect(fatal?.message).toContain("before the codex handshake completed");
    const rejected = session.events.filter((event) => event.type === "input_rejected");
    expect(rejected).toHaveLength(lines);
    expect(rejected.every((event) => event.reason === "shutting_down")).toBe(true);
    expect(rejected.map((event) => event.input_seq)).toEqual(
      Array.from({ length: lines }, (_, index) => index + 1)
    );
  }, 20_000);

  test("a handshake response landing after the shutdown ack stops the chain, fresh and resumed", async () => {
    // Review live15: the handshake kept going once an end path began —
    // the initialize response landing inside the drain sent the
    // initialized notification and the thread request, the thread
    // response adopted the id, and the session recorded itself in the
    // registry and announced session_started after the caller's shutdown
    // was already acked. The handshake is codemux's own continuation
    // chain, so it stops the moment an end path began: the response is
    // consumed and nothing is sent, adopted, or recorded. (Deliberately
    // unlike the claude family's init frame and agy's first result —
    // harness-initiated identity frames, which keep announcing.) Both
    // arms: a fresh thread/start and a resumed thread/resume.
    // FAKE_STALL_INIT=release holds the initialize and answers it on the
    // shutdown SIGTERM, deterministically inside the drain.
    const fresh = await startSession({}, { FAKE_STALL_INIT: "release" });
    await waitForRecord(fresh, "requests.jsonl", 1);
    send(fresh.driver, { type: "shutdown" });
    expect(await fresh.code).toBe(0);
    expect(of("session_started")(fresh.events)).toBeUndefined();
    expect(of("error")(fresh.events)).toBeUndefined();
    expect(
      fakeRecord(fresh, "requests.jsonl").some((r) => r.method !== "initialize")
    ).toBe(false);
    expect(readRegistry(fresh.options.registryPath as string).outcome).toBe("missing");
    const freshEnded = fresh.events[fresh.events.length - 1] as Event;
    expect(freshEnded.type).toBe("session_ended");
    expect(freshEnded.reason).toBe("shutdown");

    const resumed = await startSession(
      { resumeThreadId: "0123456789abcdef" },
      { FAKE_STALL_INIT: "release" }
    );
    await waitForRecord(resumed, "requests.jsonl", 1);
    send(resumed.driver, { type: "shutdown" });
    expect(await resumed.code).toBe(0);
    expect(of("session_started")(resumed.events)).toBeUndefined();
    expect(
      fakeRecord(resumed, "requests.jsonl").some((r) => r.method !== "initialize")
    ).toBe(false);
    expect(readRegistry(resumed.options.registryPath as string).outcome).toBe("missing");
  });

  test("a handshake error landing after the shutdown ack does not turn the end into a crash", async () => {
    // Review live15, the failure sibling of the stop rule: the initialize
    // answering with a JSON-RPC error inside the drain used to raise the
    // tier-2 fatal and cost success — the session the caller already
    // ended became a crash because a response nobody waits for failed.
    // FAKE_STALL_INIT=rejectrelease answers the held initialize with an
    // error on the shutdown SIGTERM.
    const session = await startSession({}, { FAKE_STALL_INIT: "rejectrelease" });
    await waitForRecord(session, "requests.jsonl", 1);
    send(session.driver, { type: "shutdown" });
    expect(await session.code).toBe(0);
    expect(of("error")(session.events)).toBeUndefined();
    expect(of("session_started")(session.events)).toBeUndefined();
    const ended = session.events[session.events.length - 1] as Event;
    expect(ended.type).toBe("session_ended");
    expect(ended.reason).toBe("shutdown");
  });

  test("a response echoing a numbered request id as a string is not the reply", async () => {
    // Review live15: pendingCalls matched on Number(id), so a string "1"
    // answered the numeric request 1 — a reply no request this driver
    // made. Ids now match strictly; the frame fails closed.
    // FAKE_STRING_ID_RESPONSE echoes the initialize id as a string.
    const session = await startSession({}, { FAKE_STRING_ID_RESPONSE: "1" });
    expect(await session.code).toBe(1);
    const fatal = session.events.find((event) => event.type === "error" && event.fatal === true);
    expect(fatal).toBeDefined();
    expect(fatal!.source).toBe("harness");
    expect(fatal!.message).toContain("unknown request id 1");
    expect(of("session_started")(session.events)).toBeUndefined();
    const ended = session.events[session.events.length - 1] as Event;
    expect(ended.type).toBe("session_ended");
    expect(ended.reason).toBe("crash");
  });

  test("a thread/start response naming a different thread than the announced one fails closed", async () => {
    // Review live15: a thread/started notification adopting the id FIRST
    // left the thread/start response's own id unchecked — the driver
    // announced one id while the response named another, two ids for one
    // session. The mismatch now fails closed naming both, like the
    // resume-path echo check. FAKE_ANNOUNCE_OTHER_THREAD announces
    // 99999999-… before answering thread/start with 0123456789abcdef.
    const session = await startSession({}, { FAKE_ANNOUNCE_OTHER_THREAD: "1" });
    // The notification adopts and announces first: the session DID exist
    // under the announced id before the contradiction arrived.
    const started = await waitFor(session.events, of("session_started"), "session_started");
    expect(started.session_id).toBe("99999999-8888-7777-6666-555555555555");
    expect(await session.code).toBe(1);
    const fatal = session.events.find((event) => event.type === "error" && event.fatal === true);
    expect(fatal).toBeDefined();
    expect(fatal!.source).toBe("harness");
    expect(fatal!.message).toContain(
      "started thread 0123456789abcdef, not the announced 99999999-8888-7777-6666-555555555555"
    );
    const ended = session.events[session.events.length - 1] as Event;
    expect(ended.type).toBe("session_ended");
    expect(ended.reason).toBe("crash");
  });

  test("caller input buffered during a stalled handshake is answered, never dropped", async () => {
    // Review live10, correctness 2: the only drain of `preSessionLines`
    // was the session_started replay, guarded by `!finished` — so a user
    // line that arrived before the handshake answered, plus an end path
    // that fired before it completed, left the line with no ack, no
    // event, and exit 0, breaking §4.1's every-line-answered contract
    // (the finding's own trigger: `printf '{"type":"user",...}' | codemux
    // session -a codex`). The end path now rejects each buffered line
    // with the same `shutting_down` the drain window gives a fresh line.
    // FAKE_STALL_INIT holds the initialize; handleCallerEnd is the
    // stdin-close the trigger produces.
    const session = await startSession({}, { FAKE_STALL_INIT: "1" });
    // The fake is up and its stalled initialize is on record before the
    // end begins. An end that raced the fake's own startup let the stop
    // grace run out on a process that had not read stdin yet, and its
    // SIGTERM exit failed the session (seen once under load).
    await waitForRecord(session, "requests.jsonl", 1);
    send(session.driver, { type: "user", text: "hi" });
    session.driver.handleCallerEnd();
    expect(await session.code).toBe(0);
    const rejection = session.events.find(
      (event) => event.type === "input_rejected" && event.reason === "shutting_down"
    );
    expect(rejection).toBeDefined();
    expect(rejection!.input_seq).toBe(1);
    expect(of("session_started")(session.events)).toBeUndefined();
    expect(of("user_message")(session.events)).toBeUndefined();
    const ended = session.events[session.events.length - 1] as Event;
    expect(ended.type).toBe("session_ended");
    expect(ended.reason).toBe("stdin-close");
  });
});
