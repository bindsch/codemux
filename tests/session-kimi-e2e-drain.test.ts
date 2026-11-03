/**
 * Driver e2e for the kimi session (design §4.7): the end paths' drains
 * and verdicts — the shutdown drain's delivered output, exit codes after
 * a recorded stop, external deaths during the drain, late caller input,
 * and the unrecorded-start refusal. Split from tests/session-kimi-e2e.test.ts;
 * the rig is tests/helpers/session-kimi-e2e.ts.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  cleanups,
  of,
  send,
  startSession,
  waitFor,
  workRoot,
  type Event,
  ID,
  NULL_USAGE,
} from "./helpers/session-kimi-e2e.js";

afterAll(async () => {
  for (const clean of cleanups) await clean();
});

describe("kimi session e2e - end paths", () => {
  test("stdin close mid-turn reports a non-complying child's signal exit as failed", async () => {
    const session = await startSession();
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
    expect(completed.reason).toContain("the kimi process exited with signal SIGTERM and named no session id");
    expect(completed.raw).toBeNull();
    expect(completed.usage).toEqual(NULL_USAGE);
    expect(await session.code).toBe(1);
    // session_ended arrives asynchronously after the events awaited above.
    const ended = await waitFor(session.events, of("session_ended"), "session_ended");
    expect(ended.reason).toBe("harness_failed");
    // exit_code is the end path's own code (the stdin-close cause at 0,
    // the same code the process exits with) — the killed child's signal
    // death is the normal kill path and reports nothing of its own (round
    // al29: the code is the cause log's, never a child's stale exit). And
    // the hint never arrived, so nothing was ever identified or recorded,
    // and the unidentified session is not resumable.
    expect(ended.exit_code).toBe(1);
    expect(ended.resumable).toBe(false);
    expect(of("session_started")(session.events)).toBeUndefined();
  });

  test("the shutdown drain delivers the open turn's final output", async () => {
    // The end path gives the turn's process the grace to finish on its
    // own; FAKE_SIGTERM_PERSIST=1 answers the shutdown SIGTERM with the
    // turn's remaining lines before exiting 0, and that drained output
    // must reach the caller (review live5's rule, the turn-per-process
    // shape: no end carrier exists, the signal is the only thing left).
    // Code 0 completes normally even after a recorded stop (al39). The
    // drained reply and hint complete the turn, and the raw outcome
    // rides harness_exit.
    const session = await startSession({}, { FAKE_SIGTERM_PERSIST: "1" });
    send(session.driver, { type: "user", text: "scenario:basic one" });
    const first = await waitFor(session.events, of("turn_completed"), "first turn_completed");
    expect(first.finish).toBe("end");
    send(session.driver, { type: "user", text: "scenario:wait two" });
    const secondTurn = await waitFor(
      session.events,
      (events) => events.filter((event) => event.type === "turn_started")[1],
      "second turn_started"
    );
    expect(secondTurn.turn_id).toBe("t2");
    send(session.driver, { type: "shutdown" });

    const message = await waitFor(
      session.events,
      (events) => events.filter((event) => event.type === "assistant_message")[1],
      "the drained assistant_message"
    );
    expect(message.text).toBe("drained after the shutdown signal");
    expect(message.turn_id).toBe("t2");
    const completed = await waitFor(
      session.events,
      (events) => events.filter((event) => event.type === "turn_completed")[1],
      "drained turn_completed"
    );
    expect(completed.turn_id).toBe("t2");
    // The harness delivered its answer and exited 0 during cleanup.
    expect(completed.finish).toBe("end");
    expect(completed.reason).toBeUndefined();
    expect(completed.usage).toEqual(first.usage);
    const ended = await waitFor(session.events, of("session_ended"), "session_ended");
    expect(ended.reason).toBe("shutdown");
    expect(ended.exit_code).toBe(0);
    expect(ended.harness_exit).toEqual({ code: 0, signal: null });
    // The drained hint confirmed the turn's session, so the store is
    // vouchable.
    expect(ended.resumable).toBe(true);
    expect(await session.code).toBe(0);
  });

  test("an exit 42 after the drain's recorded stop remains a harness failure (al38)", async () => {
    // The handler exits 42 after SIGTERM. That code matches neither a
    // clean exit nor the recorded signal's coded form, so shutdown fails.
    const session = await startSession({}, { FAKE_SIGTERM_PERSIST: "exit42" });
    send(session.driver, { type: "user", text: "scenario:basic one" });
    await waitFor(session.events, of("turn_completed"), "first turn_completed");
    send(session.driver, { type: "user", text: "scenario:wait two" });
    await waitFor(
      session.events,
      (events) => events.filter((event) => event.type === "turn_started")[1],
      "second turn_started"
    );
    send(session.driver, { type: "shutdown" });

    const ended = await waitFor(session.events, of("session_ended"), "session_ended");
    expect(ended.reason).toBe("harness_failed");
    expect(ended.exit_code).toBe(1);
    expect(ended.harness_exit).toEqual({ code: 42, signal: null });
    expect(of("error")(session.events)?.fatal).toBe(true);
    const completions = session.events.filter((event) => event.type === "turn_completed");
    expect(completions).toHaveLength(2);
    expect(completions[1]!.turn_id).toBe("t2");
    expect(completions[1]!.finish).toBe("failed");
    expect(completions[1]!.reason).toContain("42");
    // The interrupted turn's hint never came: not resumable (al21's rule).
    expect(ended.resumable).toBe(false);
    expect(await session.code).toBe(1);
  });

  test("an exit 143 after the drain's stop fails the session (al41)", async () => {
    const session = await startSession({}, { FAKE_SIGTERM_PERSIST: "exit143" });
    send(session.driver, { type: "user", text: "scenario:basic one" });
    await waitFor(session.events, of("turn_completed"), "first turn_completed");
    send(session.driver, { type: "user", text: "scenario:wait two" });
    await waitFor(
      session.events,
      (events) => events.filter((event) => event.type === "turn_started")[1],
      "second turn_started"
    );
    send(session.driver, { type: "shutdown" });

    const ended = await waitFor(session.events, of("session_ended"), "session_ended");
    expect(ended.reason).toBe("harness_failed");
    // Shutdown intent and the raw child outcome remain separate.
    expect(ended.exit_code).toBe(1);
    expect(ended.harness_exit).toEqual({ code: 143, signal: null });
    expect(of("error")(session.events)?.fatal).toBe(true);
    const second = session.events.filter((event) => event.type === "turn_completed")[1] as Event;
    expect(second.finish).toBe("failed");
    expect(second.reason).toContain("exited with code 143");
    expect(await session.code).toBe(1);
    // The interrupted turn never closed, so its hint never came: not
    // resumable on the FIRST turn's confirmation (round al21, edges 2 —
    // before, this read true).
    expect(ended.resumable).toBe(false);
  });

  test("an idle end after a failed child reports failure on the event, process, and ledger (al41)", async () => {
    // A child failure remains a session failure even after an idle end.
    // The event, process exit, and closing ledger record must agree.
    const ledgerPath = join(mkdtempSync(join(workRoot(), "ledger-")), "calls.jsonl");
    const previousLog = process.env.CODEMUX_CALL_LOG;
    process.env.CODEMUX_CALL_LOG = ledgerPath;
    try {
      const session = await startSession();
      send(session.driver, { type: "user", text: "scenario:basic one" });
      const first = await waitFor(session.events, of("turn_completed"), "first turn_completed");
      expect(first.finish).toBe("end");
      send(session.driver, { type: "user", text: "scenario:errorturn" });
      const second = await waitFor(
        session.events,
        (events) => events.filter((event) => event.type === "turn_completed")[1],
        "second turn_completed"
      );
      expect(second.finish).toBe("failed");
      // The session survives the turn's own failure; the shutdown below
      // ends it idle.
      send(session.driver, { type: "shutdown" });
      const ended = await waitFor(session.events, of("session_ended"), "session_ended");
      expect(ended.reason).toBe("harness_failed");
      expect(ended.exit_code).toBe(1);
      expect(await session.code).toBe(1);
      const records = readFileSync(ledgerPath, "utf8")
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => JSON.parse(line) as Record<string, any>);
      const closing = records.filter((record) => record.kind === "session");
      expect(closing).toHaveLength(1);
      expect(closing[0]!.exit_code).toBe(1);
      expect(closing[0]!.finish).toBe("harness_failed");
      expect(closing[0]!.session_id).toBe(ID);
    } finally {
      if (previousLog === undefined) delete process.env.CODEMUX_CALL_LOG;
      else process.env.CODEMUX_CALL_LOG = previousLog;
    }
  });

  test("a signaled death during the drain that cleanup did not cause is reported, not swallowed (al25)", async () => {
    // The edges major's drain half: any signaled child exit inside a
    // graceful end used to be read as cleanup's own kill — exit_code
    // null, turn "interrupted", session exit 0 — so a child killed by
    // anyone else (an operator, an OOM killer) vanished from the verdict
    // entirely. FAKE_DRAIN_SELFKILL models it: turn one identifies the
    // session, turn two stays open, and the child SIGKILLs itself 100 ms
    // after its stdin closed — while the drain is still awaiting the
    // turn's answer, before cleanup has signaled anything. The death
    // belongs to the turn's verdict and raises the session's code; only
    // a signal cleanup itself sent stays the suppressed kill (the
    // wrapper-143 test above, and the normal kill path).
    const session = await startSession({}, { FAKE_DRAIN_SELFKILL: "1" });
    send(session.driver, { type: "user", text: "scenario:basic one" });
    await waitFor(session.events, of("turn_completed"), "first turn_completed");
    send(session.driver, { type: "user", text: "scenario:wait two" });
    await waitFor(
      session.events,
      (events) => events.filter((event) => event.type === "turn_started")[1],
      "second turn_started"
    );
    session.driver.handleCallerEnd();

    const completed = await waitFor(
      session.events,
      (events) => events.filter((event) => event.type === "turn_completed")[1],
      "the failed turn_completed"
    );
    expect(completed.turn_id).toBe("t2");
    expect(completed.finish).toBe("failed");
    expect(completed.reason).toBe("the kimi process exited with signal SIGKILL");
    const fatal = session.events.find((event) => event.type === "error" && event.fatal === true);
    expect(fatal?.message).toContain("the kimi process exited with signal SIGKILL");
    // session_ended arrives asynchronously after the events awaited above.
    const ended = await waitFor(session.events, of("session_ended"), "session_ended");
    expect(ended.reason).toBe("harness_failed");
    // The external death recorded a crash cause at 1: exit_code is that
    // raised code, matching the process exit (round al29; the child's
    // signal death itself carries no code of its own).
    expect(ended.exit_code).toBe(1);
    expect(ended.resumable).toBe(false);
    expect(await session.code).toBe(1);
  });

  test("an external SIGTERM's coded 143 during the drain is reported, not exempted (al26)", async () => {
    // Exit 143 fails the session regardless of who requested shutdown.
    // FAKE_DRAIN_EXIT143: the child exits 143 on its own 100 ms
    // after its stdin closed, inside the drain's answer wait — before
    // requestStop ever runs.
    const session = await startSession({}, { FAKE_DRAIN_EXIT143: "1" });
    send(session.driver, { type: "user", text: "scenario:basic one" });
    await waitFor(session.events, of("turn_completed"), "first turn_completed");
    send(session.driver, { type: "user", text: "scenario:wait two" });
    await waitFor(
      session.events,
      (events) => events.filter((event) => event.type === "turn_started")[1],
      "second turn_started"
    );
    session.driver.handleCallerEnd();

    // The turn's own verdict fails on the exit code the child chose.
    const completed = await waitFor(
      session.events,
      (events) => events.filter((event) => event.type === "turn_completed")[1],
      "the failed turn_completed"
    );
    expect(completed.turn_id).toBe("t2");
    expect(completed.finish).toBe("failed");
    expect(completed.reason).toBe("the kimi process exited with code 143");
    // The drain fatal names the coded spelling and whose death it was.
    const fatal = session.events.find((event) => event.type === "error" && event.fatal === true);
    expect(fatal?.message).toContain("the kimi process exited with code 143");
    expect(fatal?.fatal).toBe(true);
    // session_ended follows the failed turn_completed asynchronously, so
    // it is awaited rather than assumed to be the last event already.
    const ended = await waitFor(session.events, of("session_ended"), "session_ended");
    expect(ended.reason).toBe("harness_failed");
    // The external coded 143 recorded a crash cause at 1: exit_code is
    // that raised code, matching the process exit (round al29; the
    // child's own 143 is the turn's verdict above).
    expect(ended.exit_code).toBe(1);
    expect(ended.resumable).toBe(false);
    expect(await session.code).toBe(1);
  });

  test("a SIGKILL after only a recorded SIGTERM remains a harness failure (al38)", async () => {
    // The child kills itself before cleanup's SIGKILL timer fires.
    // Its signal does not match the recorded SIGTERM.
    // FAKE_SIGTERM_PERSIST=selfkill: the wait-scenario child survives the
    // grace without answering, takes the drain's SIGTERM, and dies to its
    // own SIGKILL.
    const session = await startSession({}, { FAKE_SIGTERM_PERSIST: "selfkill" });
    send(session.driver, { type: "user", text: "scenario:basic one" });
    await waitFor(session.events, of("turn_completed"), "first turn_completed");
    send(session.driver, { type: "user", text: "scenario:wait two" });
    await waitFor(
      session.events,
      (events) => events.filter((event) => event.type === "turn_started")[1],
      "second turn_started"
    );
    session.driver.handleCallerEnd();

    const ended = await waitFor(session.events, of("session_ended"), "session_ended");
    expect(ended.reason).toBe("harness_failed");
    expect(ended.exit_code).toBe(1);
    expect(ended.harness_exit).toEqual({ code: null, signal: "SIGKILL" });
    expect(session.events.find((event) => event.type === "error")?.fatal).toBe(true);
    const completed = session.events.filter((event) => event.type === "turn_completed")[1] as Event;
    expect(completed.finish).toBe("failed");
    expect(completed.reason).toContain("SIGKILL");
    // The last turn never confirmed (no hint), so the store is not
    // vouchable (al21's rule).
    expect(ended.resumable).toBe(false);
    expect(await session.code).toBe(1);
  });

  test("a confirmed session whose open turn is cut by EOF with the drain expired ends not resumable (al21)", async () => {
    // The finding's shape: turn one confirms the session (hint adopted,
    // registry recorded), turn two opens, and the caller's stdin closes
    // before the turn completes. The drain expires without an answer —
    // the child dies to the stop signal, no hint is written — and the
    // session ends clean: exit 0, the turn interrupted. Before al21 the
    // synthesized completion left sawUnconfirmedTurnFailure unset, so
    // the clean-end fallback reported resumable on the strength of an
    // earlier turn's hint, vouching for a store whose LAST turn may
    // never have persisted.
    const session = await startSession();
    send(session.driver, { type: "user", text: "scenario:basic one" });
    const first = await waitFor(session.events, of("turn_completed"), "first turn_completed");
    expect(first.finish).toBe("end");
    await waitFor(session.events, of("session_started"), "session_started");
    send(session.driver, { type: "user", text: "scenario:wait two" });
    await waitFor(
      session.events,
      (events) => events.filter((event) => event.type === "turn_started")[1],
      "second turn_started"
    );
    session.driver.handleCallerEnd();

    const completed = await waitFor(
      session.events,
      (events) => events.filter((event) => event.type === "turn_completed")[1],
      "the synthesized turn_completed"
    );
    expect(completed.turn_id).toBe("t2");
    // The faithful verdict: interrupted, the real cause named — never a
    // synthesized success.
    expect(completed.finish).toBe("failed");
    expect(completed.reason).toContain("the kimi process exited with signal SIGTERM");
    expect(completed.usage).toEqual(NULL_USAGE);
    expect(await session.code).toBe(1);
    // session_ended arrives asynchronously after the events awaited above.
    const ended = await waitFor(session.events, of("session_ended"), "session_ended");
    expect(ended.reason).toBe("harness_failed");
    // The clean end's own code: the child's signal death was observed
    // after the drain's recorded stop, so by ordering it is the
    // shutdown's and costs nothing (rounds al29, al37).
    expect(ended.exit_code).toBe(1);
    // Recorded and once confirmed, but the last turn supplied no hint:
    // not resumable.
    expect(ended.resumable).toBe(false);
  });

  test("caller input during the shutdown drain is rejected shutting_down, never dropped", async () => {
    // The drain window exists only while a turn is open (an idle session
    // settles at once), so the late input must land inside one.
    const session = await startSession();
    send(session.driver, { type: "user", text: "scenario:basic one" });
    await waitFor(session.events, of("turn_completed"), "turn_completed");
    send(session.driver, { type: "user", text: "scenario:wait two" });
    await waitFor(
      session.events,
      (events) => events.filter((event) => event.type === "turn_started")[1],
      "second turn_started"
    );
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
    // seq 1 and 2 were the two accepted user lines, 3 the shutdown.
    expect(rejection.input_seq).toBe(4);
    expect(await session.code).toBe(1);
  });

  test("a confirmed session whose start was never recorded is not resumable", async () => {
    // Review live22's agy sibling: the first hint adopts the id and
    // confirms it; when the record write fails, the crash end must not
    // report the session resumable (a --resume would exit 66).
    const blockerRoot = mkdtempSync(join(workRoot(), "blocker-"));
    const blocker = join(blockerRoot, "blocker");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(blocker, "not a directory");
    const session = await startSession({ registryPath: join(blocker, "reg", "live-sessions.json") });
    send(session.driver, { type: "user", text: "scenario:basic one" });
    expect(await session.code).toBe(1);
    const fatal = session.events.find((event) => event.type === "error" && event.fatal === true);
    expect(fatal?.message).toContain("cannot record the session in the registry");
    // session_ended arrives asynchronously after the events awaited above.
    const ended = await waitFor(session.events, of("session_ended"), "session_ended");
    expect(ended.reason).toBe("crash");
    expect(ended.resumable).toBe(false);
    expect(session.events.some((event) => event.type === "session_started")).toBe(false);
    expect(session.events.every((event) => event.session_id === "")).toBe(true);
    expect(session.events.some((event) => event.raw?.includes("session.resume_hint"))).toBe(false);
  });
});
