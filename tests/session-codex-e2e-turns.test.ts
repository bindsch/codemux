import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { CodexSessionDriver, MAX_HELD_INPUT_LINES } from "../src/session/codex-driver.js";
import { SessionProcess } from "../src/session/process.js";
import { readRegistry, recordSessionStart } from "../src/session/registry.js";
import { cleanupSessions, HOLD, type Event, type Session, workRoot, fakeRecord, of, send, startAndWait, startSession, waitFor, waitForRecord } from "./session-codex-e2e-helpers.js";

afterAll(cleanupSessions);

describe("codex session e2e - lifecycle", () => {

  test("an early shutdown answers the lines parked ahead of it, in order", async () => {
    // Review live14: the starting-state shutdown ack used to take the
    // next input_seq while an earlier user line sat unsequenced in
    // preSessionLines — the shutdown answered seq 1 and the user line's
    // later rejection seq 2, so a broker matching acks in order read
    // its user line's rejection as the shutdown's answer. The parked
    // lines are now rejected first, arrival order preserved, and
    // finish()'s own drain of the same buffer makes the pair
    // idempotent.
    const session = await startSession({}, { FAKE_STALL_INIT: "1" });
    // The fake is up before the end begins (session-codex-e2e-review.test.ts).
    await waitForRecord(session, "requests.jsonl", 1);
    send(session.driver, { type: "user", text: "scenario:basic hello" });
    send(session.driver, { type: "shutdown" });
    expect(await session.code).toBe(0);
    const acks = session.events.filter(
      (event) => event.type === "input_accepted" || event.type === "input_rejected"
    );
    expect(acks).toHaveLength(2);
    expect(acks[0]!.type).toBe("input_rejected");
    expect(acks[0]!.reason).toBe("shutting_down");
    expect(acks[0]!.input_seq).toBe(1);
    expect(acks[1]!.type).toBe("input_accepted");
    expect(acks[1]!.input_seq).toBe(2);
    // The session never existed: no announcement, no echo, the end last.
    expect(of("session_started")(session.events)).toBeUndefined();
    expect(of("user_message")(session.events)).toBeUndefined();
    const ended = session.events[session.events.length - 1] as Event;
    expect(ended.type).toBe("session_ended");
    expect(ended.reason).toBe("shutdown");
  });

  test("queued user input that can no longer run is reported, not lost silently", async () => {
    // Review live10, correctness 2's sibling: mid-turn user lines acked
    // and echoed but still in the FIFO vanished on every end path. The
    // end path now emits one non-fatal notice naming the drop — the
    // acks cannot be retracted, and a second answer per line would
    // double-ack. FAKE_SIGTERM_PERSIST keeps the drained t1 completion
    // arriving, pinning that the notice and the drain coexist.
    const session = await startAndWait({}, { FAKE_SIGTERM_PERSIST: "1" });
    send(session.driver, { type: "user", text: "scenario:wait one" });
    await waitFor(session.events, of("turn_started"), "turn_started");
    send(session.driver, { type: "user", text: "scenario:basic two" });
    await waitFor(
      session.events,
      (events) => events.find((event) => event.type === "user_message" && event.text === "scenario:basic two"),
      "queued echo"
    );
    send(session.driver, { type: "shutdown" });
    const error = await waitFor(
      session.events,
      (events) => events.find((event) => event.type === "error" && event.fatal === false),
      "the queued-input drop notice"
    );
    expect(error.message).toContain("queued user input");
    const ended = await waitFor(session.events, of("session_ended"), "session_ended");
    // The queued turn never ran: exactly one turn_completed — t1's
    // drained interrupted completion.
    expect(session.events.filter((event) => event.type === "turn_completed")).toHaveLength(1);
    expect(session.events[session.events.length - 1]).toBe(ended);
    expect(await session.code).toBe(0);
  });

  test("a signal that fires before attach stops the child instead of stranding it", async () => {
    // Review live4, codex blocker 1: the driver installs its signal
    // handlers at construction, but the child is attached only after the
    // CLI's async spawn; a signal in that window finished the driver with
    // no child to stop, and the child then ran on, never stopped.
    // handleCallerEnd() is the same public pre-attach end a signal
    // produces, deterministically — no real signal is needed.
    // Review round 64: the CLI arms spawnPending() before that spawn, so
    // the end path now holds its completion — the resume record's release,
    // session_ended, run()'s resolution — behind the late child's
    // settlement, and a rival resume in that window still reads a live
    // session. FAKE_SIGTERM_PERSIST keeps the child alive past the stop
    // request, so the held window is observable.
    const dir = mkdtempSync(join(workRoot(), "s-"));
    const stateDir = join(dir, "state");
    const registryDir = join(dir, "registry");
    mkdirSync(stateDir);
    mkdirSync(registryDir, { mode: 0o700 });
    const registryPath = join(registryDir, "live-sessions.json");
    const threadId = "0123456789abcdef";
    const events: Event[] = [];
    const driver = new CodexSessionDriver({
      resumeThreadId: threadId,
      autonomy: "high",
      cwd: dir,
      sandboxed: true,
      sandboxTrust: "standard",
      sandboxNoNet: false,
      sandboxScrubEnv: false,
      passEnv: [],
      authorPrefix: true,
      permissionTimeoutMs: 300_000,
      turnTimeoutMs: null,
      sessionTimeoutMs: null,
      registryPath,
      harnessHome: join(dir, "home"),
      providerBaseUrl: null,
      sink: (line) => {
        events.push(JSON.parse(line) as Event);
      },
    });
    // The claimed resume record the CLI owns from its claim until the end
    // path releases it.
    expect(
      recordSessionStart(registryPath, {
        id: threadId,
        agent: "codex",
        cwd: dir,
        hermetic: false,
        project_settings: false,
        harness_home: join(dir, "home"),
        provider_base_url: null,
        model: null,
        model_alias: null,
        autonomy: "high",
        sandboxed: true,
        sandbox_trust: "standard",
        sandbox_no_net: false,
        sandbox_scrub_env: false,
        sandbox_block: [],
        pass_env: [],
        playwright_mcp: false,
      }).ok
    ).toBe(true);
    driver.adoptResumeClaim();
    // The CLI's pre-spawn arm, then the pre-attach end: the driver
    // finishes with no child to stop and holds on the pending spawn.
    driver.spawnPending();
    driver.handleCallerEnd();
    // A child that survives its stop request (its SIGTERM handler is up —
    // the READY line — before the test attaches), so the held window is
    // observable: a plain child dies to the immediate SIGTERM during its
    // own boot, settling at once.
    let childReady: () => void = () => {};
    const ready = new Promise<void>((resolve) => {
      childReady = resolve;
    });
    const proc = new SessionProcess({
      command: ["bun", HOLD],
      cwd: dir,
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: dir,
      },
      onLine: (line) => {
        if (line === "READY") childReady();
      },
      onFatal: (fatal) => driver.handleFatal(fatal),
      graceMs: 500,
    });
    await ready;
    driver.attach(proc);
    const code = driver.run();
    // The child is still alive (FAKE_SIGTERM_PERSIST survives the stop
    // request for a moment): the end path must not have completed. A
    // resolved run() here is exactly the round 64 bug — the record
    // released and session_ended emitted while the child lived on.
    const held = await Promise.race([
      code.then(() => "resolved" as const),
      Bun.sleep(150).then(() => "held" as const),
    ]);
    expect(held).toBe("held");
    expect(of("session_ended")(events)).toBeUndefined();
    const owned = readRegistry(registryPath);
    expect(owned.outcome === "ok" && owned.file.sessions[0]?.ended).toBeNull();
    // The child that arrived after the end is stopped by attach itself,
    // and only its settlement lets the end path finish.
    const outcome = await Promise.race([
      proc.exited,
      Bun.sleep(4_000).then(() => null),
    ]);
    expect(outcome).not.toBeNull();
    expect(await code).toBe(0);
    const ended = events[events.length - 1] as Event;
    expect(ended.type).toBe("session_ended");
    // handleCallerEnd() is the pre-attach end a closed caller stdin
    // produces; a real signal maps to "signal" on the same held path.
    expect(ended.reason).toBe("stdin-close");
    const released = readRegistry(registryPath);
    expect(
      released.outcome === "ok" && released.file.sessions[0]?.ended !== null
    ).toBe(true);
    driver.dispose();
    await proc.settled;
  });
});

describe("codex session e2e - turns", () => {
  test("mid-turn user input queues and rolls the next turn on completion", async () => {
    const session = await startAndWait();
    // A waiting first turn keeps the session mid-turn while the second
    // input arrives, so the queue path is exercised deterministically.
    send(session.driver, { type: "user", text: "scenario:wait one" });
    await waitFor(session.events, of("turn_started"), "first turn_started");
    send(session.driver, { type: "user", text: "scenario:basic two" });
    const echo = await waitFor(
      session.events,
      (events) => events.find((event) => event.type === "user_message" && event.text === "scenario:basic two"),
      "second user_message"
    );
    // A queued echo names no turn: the field is absent, not null (the
    // protocol builder omits turn_id rather than writing null).
    expect("turn_id" in echo).toBe(false);
    send(session.driver, { type: "interrupt" });
    const completions = await waitFor(
      session.events,
      (events) => (events.filter((event) => event.type === "turn_completed").length >= 2 ? events : undefined),
      "both turns completed"
    );
    const turns = completions.filter((event) => event.type === "turn_completed");
    expect(turns.map((turn) => [turn.turn_id, turn.finish])).toEqual([
      ["t1", "interrupted"],
      ["t2", "end"],
    ]);
    const started = session.events.filter((event) => event.type === "turn_started");
    expect(started.map((turn) => turn.turn_id)).toEqual(["t1", "t2"]);
    // One turn/start per turn, submitted only after the previous turn
    // completed: the fake saw them in order.
    const turnStarts = fakeRecord(session, "requests.jsonl").filter((r) => r.method === "turn/start");
    expect(turnStarts).toHaveLength(2);
    send(session.driver, { type: "shutdown" });
    expect(await session.code).toBe(0);
  });

  test("steering rides turn/steer with the harness turn id and echoes on the open turn", async () => {
    const session = await startAndWait();
    send(session.driver, { type: "user", text: "scenario:steer please" });
    await waitFor(session.events, of("turn_started"), "turn_started");
    send(session.driver, { type: "steer", text: "go west" });
    const echo = await waitFor(
      session.events,
      (events) => events.find((event) => event.type === "user_message" && event.text === "go west"),
      "steer echo"
    );
    expect(echo.turn_id).toBe("t1");
    const completed = await waitFor(session.events, of("turn_completed"), "turn_completed");
    expect(completed.finish).toBe("end");
    const steers = fakeRecord(session, "steers.jsonl");
    expect(steers).toHaveLength(1);
    expect(steers[0]!.expectedTurnId).toBe("turn-fake-1");
    expect(steers[0]!.texts).toEqual(["go west"]);
    send(session.driver, { type: "shutdown" });
    expect(await session.code).toBe(0);
  });

  test("user lines queued behind a turn and steers held for its id are bounded (busy)", async () => {
    // Review live19, the class of the pre-handshake buffer: turnQueue and
    // steerBuffer held every accepted text with no limit. Past the bound
    // a line is rejected busy at its own input_seq, so order holds.
    const rejectionsOf = (session: Session): Event[] =>
      session.events.filter((event) => event.type === "input_rejected");
    const queued = await startAndWait();
    send(queued.driver, { type: "user", text: "scenario:wait hold" });
    await waitFor(queued.events, of("turn_started"), "turn_started");
    for (let index = 0; index <= MAX_HELD_INPUT_LINES; index++) {
      send(queued.driver, { type: "user", text: `queued ${index}` });
      if (index % 64 === 0) await Bun.sleep(5);
    }
    const busy = await waitFor(
      queued.events,
      (events) => events.find((event) => event.type === "input_rejected"),
      "the queue's busy rejection"
    );
    expect(busy.reason).toBe("busy");
    expect(busy.input_seq).toBe(MAX_HELD_INPUT_LINES + 2);
    expect(rejectionsOf(queued)).toHaveLength(1);
    send(queued.driver, { type: "shutdown" });
    await queued.code;

    // The steer hold: turn/start is answered late, so the harness turn
    // id stays unknown while the steers arrive.
    const held = await startAndWait({}, { FAKE_TURNSTART_DELAY: "3000" });
    send(held.driver, { type: "user", text: "scenario:wait hold" });
    for (let index = 0; index <= MAX_HELD_INPUT_LINES; index++) {
      send(held.driver, { type: "steer", text: `steer ${index}` });
      if (index % 64 === 0) await Bun.sleep(5);
    }
    const steerBusy = await waitFor(
      held.events,
      (events) => events.find((event) => event.type === "input_rejected"),
      "the steer hold's busy rejection"
    );
    expect(steerBusy.reason).toBe("busy");
    expect(steerBusy.input_seq).toBe(MAX_HELD_INPUT_LINES + 2);
    expect(rejectionsOf(held)).toHaveLength(1);
    send(held.driver, { type: "shutdown" });
    await held.code;
  }, 30_000);

  test("a steer buffered while the harness turn id is unknown is reported when its turn dies", async () => {
    // Review live10, correctness 2's sibling: failOpenTurn used to clear
    // the steer buffer silently — the same loss completeTurn reports.
    // The steer lands while the turn/start response is still in flight
    // (both sends are synchronous, so the response cannot interleave),
    // and the failstart scenario's rejection then kills the turn it
    // steered.
    const session = await startAndWait();
    send(session.driver, { type: "user", text: "scenario:failstart nope" });
    send(session.driver, { type: "steer", text: "go west" });
    const error = await waitFor(
      session.events,
      (events) => events.find((event) => event.type === "error" && event.fatal === false),
      "the steer drop notice"
    );
    expect(error.message).toContain("steering input arrived too late");
    const completed = await waitFor(session.events, of("turn_completed"), "turn_completed");
    expect(completed.finish).toBe("failed");
    // No steer ever reached the harness.
    expect(fakeRecord(session, "steers.jsonl")).toEqual([]);
    send(session.driver, { type: "shutdown" });
    expect(await session.code).toBe(0);
  });

  test("steers buffered behind a delayed turn/start are split, never joined past the write cap", async () => {
    // Review live14: each steer passed the pre-ack deliverability check
    // alone and was acked, but flushSteer then joined every buffered
    // text into ONE turn/steer frame with no size check — two 9 MiB
    // steers made a ~18 MiB frame, over the 17 MiB harness write cap,
    // writeToHarness refused it, and the session crashed as a codemux
    // failure after both inputs had been accepted. The batch is now
    // grown only while the built frame fits, so the join falls back to
    // one request per steer — the wire's common shape anyway (each
    // steer arriving after the turn started sends its own request).
    // FAKE_TURNSTART_DELAY holds the turn/start response so both steers
    // buffer, exactly the race.
    const session = await startAndWait({}, { FAKE_TURNSTART_DELAY: "250" });
    send(session.driver, { type: "user", text: "scenario:wait held" });
    send(session.driver, { type: "steer", text: "a".repeat(9 * 1024 * 1024) });
    send(session.driver, { type: "steer", text: "b".repeat(9 * 1024 * 1024) });
    const completed = await waitFor(session.events, of("turn_completed"), "turn_completed");
    expect(completed.finish).toBe("end");
    // Pre-fix the joined frame was refused as oversize and ended the
    // session as a crash; the split frames all fit.
    expect(session.events.find((event) => event.type === "error" && event.fatal)).toBeUndefined();
    // Wait for the fake to have READ both split frames before ending the
    // session: a 9 MiB line drains through the pipe for a while, and the
    // fake dies at once on the shutdown SIGTERM — the split is what is
    // under test, not the drain's race with the kill.
    await waitForRecord(session, "steers.jsonl", 2);
    send(session.driver, { type: "shutdown" });
    expect(await session.code).toBe(0);
    // Both steers reached the harness as separate requests of one text
    // each (initialize, initialized, thread/start, turn/start, then the
    // two turn/steer frames).
    const requests = fakeRecord(session, "requests.jsonl");
    expect(requests.map((request) => request.method)).toEqual([
      "initialize",
      "initialized",
      "thread/start",
      "turn/start",
      "turn/steer",
      "turn/steer",
    ]);
    const steers = requests.filter((request) => request.method === "turn/steer");
    expect(steers[0]!.params.input).toHaveLength(1);
    expect(steers[1]!.params.input).toHaveLength(1);
  });

  test("an interrupt request completes the turn as interrupted", async () => {
    const session = await startAndWait();
    send(session.driver, { type: "user", text: "scenario:wait hold" });
    await waitFor(session.events, of("turn_started"), "turn_started");
    send(session.driver, { type: "interrupt" });
    const completed = await waitFor(session.events, of("turn_completed"), "turn_completed");
    expect(completed.finish).toBe("interrupted");
    expect(completed.turn_id).toBe("t1");
    const interrupts = fakeRecord(session, "interrupts.jsonl");
    expect(interrupts).toHaveLength(1);
    expect(interrupts[0]!.turnId).toBe("turn-fake-1");
    send(session.driver, { type: "shutdown" });
    expect(await session.code).toBe(0);
  });

  test("the turn timeout interrupts and reports the reason", async () => {
    const session = await startAndWait({ turnTimeoutMs: 400 });
    send(session.driver, { type: "user", text: "scenario:wait hold" });
    const completed = await waitFor(session.events, of("turn_completed"), "turn_completed");
    expect(completed.finish).toBe("interrupted");
    expect(completed.reason).toBe("turn-timeout");
    send(session.driver, { type: "shutdown" });
    expect(await session.code).toBe(0);
  });

  test("a rejected interrupt leaves the turn's real completion standing", async () => {
    // Review live4, codex blocker 3: the interrupt's rejection did not
    // clear interruptPending, so the turn's own completion was re-labeled
    // "interrupted" — masking whatever actually happened, a failed turn
    // as much as a clean one.
    const session = await startAndWait();
    send(session.driver, { type: "user", text: "scenario:refuseinterrupt hold" });
    await waitFor(session.events, of("turn_started"), "turn_started");
    send(session.driver, { type: "interrupt" });
    const error = await waitFor(
      session.events,
      (events) => events.find((event) => event.type === "error" && event.fatal === false),
      "the rejected-interrupt error"
    );
    expect(error.message).toContain("rejected the interrupt request");
    const completed = await waitFor(session.events, of("turn_completed"), "turn_completed");
    expect(completed.turn_id).toBe("t1");
    expect(completed.finish).toBe("end"); // not "interrupted"
    expect(completed.reason).toBeUndefined();
    const interrupts = fakeRecord(session, "interrupts.jsonl");
    expect(interrupts).toHaveLength(1);
    // The session survives: another turn runs to completion.
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

  test("a turn/start error fails the open turn without ending the session", async () => {
    const session = await startAndWait();
    send(session.driver, { type: "user", text: "scenario:failstart nope" });
    // Review live15, trigger A: the caller saw t1 open BEFORE the harness
    // refused it — turn_started goes out at submit, so the failed
    // completion answers a start that is on the stream (§4.1's pairing),
    // not an orphan.
    const started = await waitFor(session.events, of("turn_started"), "turn_started");
    expect(started.turn_id).toBe("t1");
    expect(started.raw).toBeNull();
    const completed = await waitFor(session.events, of("turn_completed"), "turn_completed");
    expect(completed.finish).toBe("failed");
    expect(completed.reason).toBe("the turn was refused");
    expect(session.events.indexOf(started)).toBeLessThan(
      session.events.indexOf(completed)
    );
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

  test("a turn/completed with an unrecognized status completes the turn failed and the queue still runs", async () => {
    // Review live15: an unrecognized turn/completed status passed through
    // as tier-1 unknown, leaving the turn open forever — the queued input
    // below never ran and only a timeout or shutdown ended the session.
    // The recognized method names the open turn, so the outcome completes
    // failed with the status named, fail-closed, and the queue the
    // completion releases still runs.
    const session = await startAndWait();
    send(session.driver, { type: "user", text: "scenario:badstatus stale" });
    const started = await waitFor(session.events, of("turn_started"), "turn_started");
    // Queued while t1 is (still) open: it must run once the completion
    // frees the FSM — the discriminator the old open-turn hang failed.
    send(session.driver, { type: "user", text: "scenario:basic two" });
    const first = await waitFor(session.events, of("turn_completed"), "t1 completed");
    expect(first.turn_id).toBe("t1");
    expect(first.finish).toBe("failed");
    expect(first.reason).toBe("the turn completed with unrecognized status expired");
    const second = await waitFor(
      session.events,
      (events) => events.filter((event) => event.type === "turn_completed")[1],
      "t2 completed"
    );
    expect(second.turn_id).toBe("t2");
    expect(second.finish).toBe("end");
    expect(session.events.filter((event) => event.type === "turn_started").map((t) => t.turn_id)).toEqual(["t1", "t2"]);
    expect(session.events.indexOf(started)).toBeLessThan(session.events.indexOf(first));
    send(session.driver, { type: "shutdown" });
    expect(await session.code).toBe(0);
  });

  test("the author prefix rides harness-bound text", async () => {
    const session = await startAndWait();
    send(session.driver, { type: "user", text: "scenario:basic hi", author: "ana" });
    await waitFor(session.events, of("turn_completed"), "turn_completed");
    const turnStart = fakeRecord(session, "requests.jsonl").find((r) => r.method === "turn/start");
    expect(turnStart!.params.input[0]!.text).toBe("[ana] scenario:basic hi");
    send(session.driver, { type: "shutdown" });
    expect(await session.code).toBe(0);
  });
});
