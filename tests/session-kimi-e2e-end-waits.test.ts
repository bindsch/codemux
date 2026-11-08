/**
 * Driver e2e for the kimi session (design §4.7): the end paths' in-flight
 * spawn waits — the timeout enforced against held and never-settling
 * spawns, signals and fatal escalations cutting the wait, the late child
 * killed on landing, and the registry record held until it settles. Split
 * from tests/session-kimi-e2e.test.ts; the rig is tests/helpers/
 * session-kimi-e2e.ts.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { SessionProcess, SESSION_SIGNAL_EXIT_CODE } from "../src/session/process.js";
import { readRegistry } from "../src/session/registry.js";
import {
  cleanups,
  fakeRecord,
  of,
  send,
  startSession,
  waitFor,
  STARTUP_GRACE_MS,
  ID,
} from "./helpers/session-kimi-e2e.js";
import { registerNoLeakedSignals } from "./helpers/signal-listeners.js";

afterAll(async () => {
  for (const clean of cleanups) await clean();
});

// Review round 4, session finding 8: every session a test built is ended
// in that test's afterEach, not left for the file's afterAll — a driver
// still holding the process's signal handlers would fire in any later
// test that raises one. A kimi driver whose spawn hold is still settling
// keeps its handlers past dispose by design (al30) and drops them once
// the hold lands, so the assertion waits (settleMs). Every never-settling
// spawn this file builds is recordless, where round 391 skips the hold
// and the handlers drop at once — no exemption is needed.
registerNoLeakedSignals(
  async (mark) => { while (cleanups.length > mark) await cleanups.pop()!(); },
  () => cleanups.length,
  { settleMs: 5_000 }
);

describe("kimi session e2e - end paths", () => {
  test("the session timeout is honored while the turn's spawn is in flight; the late child is killed on landing (D5, al23)", async () => {
    // A timeout while the turn's spawn is still in flight (the 250 ms
    // hold models the slow scode gate — the probes the spawn closure
    // runs before any child exists). Round al23 (edges 2): the absolute
    // --timeout is no longer stretched by that wait. The end path
    // ABANDONS the in-flight spawn and resolves done at the deadline;
    // the late child is stopped by the hold (spawnContinuation's
    // abandoned arm, settleChild) when it
    // lands, its exit codemux's own kill, not a turn verdict — and
    // session_ended's exit_code is the end path's own code (the timeout
    // cause's 1, round al29), never a child's. Before al23 the end path
    // awaited the spawn, so the deadline
    // waited with it (and a spawn that never settled kept the session
    // from ending at all — the next test pins that half). A graceful
    // end still runs the late child instead (review D11), pinned by the
    // test after next.
    const session = await startSession({ sessionTimeoutMs: 100 }, {}, 250);
    send(session.driver, { type: "user", text: "scenario:basic one" });
    await waitFor(session.events, of("turn_started"), "turn_started");

    const completed = await waitFor(
      session.events,
      of("turn_completed"),
      "the synthesized turn_completed"
    );
    expect(completed.turn_id).toBe("t1");
    expect(completed.finish).toBe("interrupted");
    expect(completed.reason).toContain("the session ended (timeout)");
    // session_ended arrives asynchronously after the events awaited above.
    const ended = await waitFor(session.events, of("session_ended"), "session_ended");
    expect(ended.reason).toBe("timeout");
    // The timeout cause's own code, the same one the process exits with
    // (round al29 — never a child's exit, and no child landed yet).
    expect(ended.exit_code).toBe(1);
    expect(await session.code).toBe(1);
    // The al23 ordering: done resolved at the deadline, BEFORE the spawn
    // landed (100 ms timeout against a 250 ms hold) — the session's end
    // no longer waits on the in-flight spawn.
    expect(session.order).toEqual(["done"]);
    // The abandoned spawn is not leaked: exactly one child landed, was
    // stopped rather than run — no assistant output was ever accepted —
    // and its tree settled after done.
    const deadline = Date.now() + 8_000;
    while (session.order.length < 3) {
      if (Date.now() > deadline) {
        throw new Error(`timed out waiting for the late child; order: ${session.order.join(",")}`);
      }
      await Bun.sleep(10);
    }
    expect(session.order).toEqual(["done", "spawned", "settled"]);
    expect(session.events.find((event) => event.type === "assistant_message")).toBeUndefined();
  });

  test("a spawn that never settles cannot keep the session open past the timeout (al23)", async () => {
    // The edges major's far half: the end path awaited the in-flight
    // spawn unconditionally, so a spawn that never settled — probes hung
    // past their own timeouts — kept session_ended, the registry
    // release, the signal-handler cleanup, and run() resolution away
    // from the caller entirely. The abandonment closes this too: with
    // nothing to await, the timeout ends the session on schedule. The
    // eternal promise models the hung spawn; no child ever exists, so
    // there is nothing to stop and nothing leaks.
    const session = await startSession({
      sessionTimeoutMs: 100,
      spawnTurn: () => new Promise<SessionProcess>(() => {}),
    });
    // The hold never settles, but the session is recordless (no child
    // ever existed), so round 391 skips the wait: the handlers come down
    // at once and the afterEach's ordinary zero-listener rule holds.
    send(session.driver, { type: "user", text: "scenario:basic one" });
    await waitFor(session.events, of("turn_started"), "turn_started");

    const completed = await waitFor(
      session.events,
      of("turn_completed"),
      "the synthesized turn_completed"
    );
    expect(completed.finish).toBe("interrupted");
    expect(completed.reason).toContain("the session ended (timeout)");
    // session_ended arrives asynchronously after the events awaited above.
    const ended = await waitFor(session.events, of("session_ended"), "session_ended");
    expect(ended.reason).toBe("timeout");
    // The timeout cause's own code, matching the process exit (round
    // al29 — no child ever existed to report).
    expect(ended.exit_code).toBe(1);
    expect(ended.resumable).toBe(false);
    expect(await session.code).toBe(1);
    // Nothing ever spawned, and done still resolved.
    expect(session.order).toEqual(["done"]);
  });

  test("a recordless session ends at once instead of waiting out an abandoned spawn's hold (round 391)", async () => {
    // The hold guards one thing: the registry release past done. When a
    // fresh session's start record never landed — no child ever existed,
    // so no session id and no resume claim — releaseRegistryRecord
    // returns at its first guard and the wait protects nothing: codemux
    // sat past session_ended with its signal handlers installed until the
    // abandoned spawn's own probes gave up. Never await a release that
    // cannot happen: the end path disposes at once.
    const session = await startSession({
      spawnTurn: () => new Promise<SessionProcess>(() => {}),
    });
    send(session.driver, { type: "user", text: "scenario:basic one" });
    await waitFor(session.events, of("turn_started"), "turn_started");
    process.kill(process.pid, "SIGTERM");
    const ended = await waitFor(session.events, of("session_ended"), "session_ended");
    expect(ended.reason).toBe("signal");
    expect(await session.code).toBe(SESSION_SIGNAL_EXIT_CODE);
    // The recordless end takes the signal handlers down at once; without
    // the fix this wait outlives every abandoned-spawn probe.
    const internals = session.driver as unknown as { signalsDisposed: boolean };
    const deadline = Date.now() + 5_000;
    while (!internals.signalsDisposed) {
      if (Date.now() > deadline) {
        throw new Error("the signal handlers stayed installed past the recordless end");
      }
      await Bun.sleep(5);
    }
  }, 10_000);

  test("a stdin close while the turn's spawn is still in flight runs that turn to completion (review D11, correctness 2 1)", async () => {
    // The exact trigger: one prompt, then immediate EOF — `printf one
    // user line | codemux session -a kimi -s` — where the scode gate
    // holds the turn's spawn when the close arrives (the 250 ms hold
    // models that window). A graceful end owes that pending turn its
    // run: the prompt already rides the late child's argv, so the end
    // path runs it through the landed path's drain, settled before done
    // resolves.
    const session = await startSession({}, {}, 250, 1, STARTUP_GRACE_MS);
    send(session.driver, { type: "user", text: "scenario:basic one" });
    await waitFor(session.events, of("turn_started"), "turn_started");
    session.driver.handleCallerEnd();

    const completed = await waitFor(
      session.events,
      of("turn_completed"),
      "the turn's own completion"
    );
    expect(completed.turn_id).toBe("t1");
    expect(completed.finish).toBe("end");
    const assistant = await waitFor(
      session.events,
      of("assistant_message"),
      "assistant_message"
    );
    expect(assistant.text).toBe("Done: scenario:basic one");
    const ended = await waitFor(session.events, of("session_ended"), "session_ended");
    expect(ended.reason).toBe("stdin-close");
    expect(ended.exit_code).toBe(0);
    // The harness confirmed the session (its hint named the id inside
    // the drain), so the graceful end stays resumable.
    expect(ended.resumable).toBe(true);
    expect(await session.code).toBe(0);
    // The prompt actually reached the late child — the regression's
    // core — and it settled before done resolved.
    expect(fakeRecord(session, "prompts.jsonl")).toEqual([
      { text: "scenario:basic one" },
    ]);
    expect(session.order).toEqual(["spawned", "settled", "done"]);
  }, 10_000);

  test("a signal while a graceful end awaits the turn's spawn cuts the wait; the late child is killed on landing (round al18, reshaped by al25)", async () => {
    // The correctness review's major (round al18): a SIGTERM arriving
    // after a graceful end entered the spawn wait only raised endExitCode
    // — the late child still landed into the graceful run and got its
    // prompt's full pre-stop grace. al18 stopped the child through the
    // landed check while the end still WAITED for it; round al25 (edges
    // major) cuts the wait itself, so the escalated end can never hang on
    // a spawn that does not settle: done resolves at the signal, and the
    // late child — landing after it — is stopped, never run to
    // completion. Before al18 the same sequence ran the turn to "end"
    // and reported the child's own exit 0.
    const session = await startSession({}, {}, 400);
    send(session.driver, { type: "user", text: "scenario:basic one" });
    await waitFor(session.events, of("turn_started"), "turn_started");
    session.driver.handleCallerEnd();
    process.kill(process.pid, "SIGTERM");

    const completed = await waitFor(
      session.events,
      of("turn_completed"),
      "the synthesized turn_completed"
    );
    expect(completed.turn_id).toBe("t1");
    expect(completed.finish).toBe("interrupted");
    expect(completed.reason).toContain("before the turn completed");
    // session_ended arrives asynchronously after the events awaited above.
    const ended = await waitFor(session.events, of("session_ended"), "session_ended");
    // The end path's own reason stands (the stdin close started it); the
    // exit code is the signal cause's — the one later cause the end path
    // met, the same code the process exits with — and the killed child's
    // exit is codemux's own, reported nothing of its own (round al29).
    expect(ended.reason).toBe("stdin-close");
    expect(ended.exit_code).toBe(SESSION_SIGNAL_EXIT_CODE);
    expect(await session.code).toBe(SESSION_SIGNAL_EXIT_CODE);
    // The al25 ordering: done resolved at the signal, BEFORE the spawn
    // landed (the 400 ms hold is the slow scode gate) — the escalation
    // cut the wait instead of sitting in it.
    expect(session.order).toEqual(["done"]);
    // The abandoned spawn is not leaked: the child landed, was stopped
    // rather than run — no assistant output was ever accepted — and its
    // tree settled after done.
    const deadline = Date.now() + 8_000;
    while (session.order.length < 3) {
      if (Date.now() > deadline) {
        throw new Error(`timed out waiting for the late child; order: ${session.order.join(",")}`);
      }
      await Bun.sleep(10);
    }
    expect(session.order).toEqual(["done", "spawned", "settled"]);
    expect(session.events.find((event) => event.type === "assistant_message")).toBeUndefined();
  });

  test("a session timeout that fires while a graceful end awaits the turn's spawn is enforced, not stretched (al25)", async () => {
    // The correctness major: cleanup used to clear the session timer
    // BEFORE awaiting the in-flight spawn, so the caller's absolute
    // --timeout could never fire while the wait ran — a 60 ms timeout
    // against a 200 ms spawn hold ended past 200 ms with exit 0, reason
    // stdin-close, the deadline stretched by whatever the spawn closure
    // did. The timer stays armed through the wait now and the timeout's
    // escalation cuts it: done resolves at the deadline with a nonzero
    // code, and the late child is stopped on landing, never run.
    const session = await startSession({ sessionTimeoutMs: 60 }, {}, 200);
    send(session.driver, { type: "user", text: "scenario:basic one" });
    await waitFor(session.events, of("turn_started"), "turn_started");
    session.driver.handleCallerEnd();

    const completed = await waitFor(
      session.events,
      of("turn_completed"),
      "the synthesized turn_completed"
    );
    expect(completed.finish).toBe("interrupted");
    expect(completed.reason).toContain("the session ended (stdin-close) before the turn completed");
    // session_ended arrives asynchronously after the events awaited above.
    const ended = await waitFor(session.events, of("session_ended"), "session_ended");
    expect(ended.reason).toBe("stdin-close");
    // The timeout's raised code: the graceful end's 0 is gone.
    expect(await session.code).toBe(1);
    // The deadline was not stretched: done resolved before the spawn
    // landed (60 ms timeout against a 200 ms hold).
    expect(session.order).toEqual(["done"]);
    const deadline = Date.now() + 8_000;
    while (session.order.length < 3) {
      if (Date.now() > deadline) {
        throw new Error(`timed out waiting for the late child; order: ${session.order.join(",")}`);
      }
      await Bun.sleep(10);
    }
    expect(session.order).toEqual(["done", "spawned", "settled"]);
    expect(session.events.find((event) => event.type === "assistant_message")).toBeUndefined();
  });

  test("a spawn that never settles cannot outlast a timeout that fires during a graceful end's wait (al25)", async () => {
    // The far half of the same major: the graceful end awaited the
    // in-flight spawn unconditionally, so a spawn that never settled —
    // probes hung past their own timeouts — kept session_ended, the
    // registry release, the signal handlers, and run() resolution away
    // from the caller forever, with the timer already cleared. The cut
    // closes that too: with nothing to land, the timeout ends the
    // session on schedule. The eternal promise models the hung spawn.
    const session = await startSession({
      sessionTimeoutMs: 100,
      spawnTurn: () => new Promise<SessionProcess>(() => {}),
    });
    // Same as above: recordless, so round 391 skips the hold and the
    // handlers come down at once — no exemption.
    send(session.driver, { type: "user", text: "scenario:basic one" });
    await waitFor(session.events, of("turn_started"), "turn_started");
    session.driver.handleCallerEnd();

    const ended = await waitFor(session.events, of("session_ended"), "session_ended");
    expect(ended.reason).toBe("stdin-close");
    expect(ended.resumable).toBe(false);
    expect(await session.code).toBe(1);
    expect(session.order).toEqual(["done"]);
  });

  test("the session timer stays armed through the graceful drain: a hanging child cannot outlive --timeout (al27)", async () => {
    // Edges major 2, the drain half al25 left open: cleanup cleared the
    // session timer BEFORE the drain, so a timeout could cut the spawn
    // wait but never the drain after it — a landed child that hung
    // (scenario:wait) drained through the stop grace past the deadline
    // while the session reported a clean shutdown at exit 0. The timer
    // stays armed through the drain now: the 400 ms deadline fires inside
    // the drain's answer wait (closed at ~20 ms, grace 500 ms), the
    // escalation raises the end code and awaitEndAnswer's raised-verdict
    // predicate cuts the wait at once, and the session ends 1.
    const session = await startSession({ sessionTimeoutMs: 400 });
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
    expect(completed.reason).toContain(
      "the kimi process exited with signal SIGTERM and named no session id"
    );
    // session_ended arrives asynchronously after the events awaited above.
    const ended = await waitFor(session.events, of("session_ended"), "session_ended");
    expect(ended.reason).toBe("harness_failed");
    expect(ended.shutdown_requested).toBe(true);
    expect(ended.exit_code).toBe(1);
    expect(await session.code).toBe(1);
    // The drain settled the stopped child before done resolved: the end
    // was cut by the deadline, not stretched through the whole grace.
    expect(session.order).toEqual(["spawned", "settled", "done"]);
  });

  test("a killing end holds the registry record until the abandoned spawn can no longer create a child (al27)", async () => {
    // Edges major 1: the end path released the registry record in its own
    // tail — before the abandoned spawn settled — so a concurrent
    // `--resume` could claim the session and write the store while the
    // late child was still to land, run, and write it too. The release
    // now defers behind the lateSpawnSettled tracker, past done: the
    // record keeps its live-looking owner until the late child has
    // settled, and only then is the end stamped. Turn one runs prompt
    // (the record exists); turn two's spawn is held in flight when the
    // signal arrives.
    const session = await startSession({}, {}, 250, 2);
    send(session.driver, { type: "user", text: "scenario:basic one" });
    await waitFor(
      session.events,
      (events) => events.filter((event) => event.type === "turn_completed")[0],
      "the first turn_completed"
    );
    send(session.driver, { type: "user", text: "scenario:basic two" });
    await waitFor(
      session.events,
      (events) => events.filter((event) => event.type === "turn_started")[1],
      "the second turn_started"
    );
    process.kill(process.pid, "SIGTERM");

    const ended = await waitFor(session.events, of("session_ended"), "session_ended");
    expect(ended.reason).toBe("signal");
    expect(await session.code).toBe(SESSION_SIGNAL_EXIT_CODE);
    // The al23 ordering still holds: done resolved at the signal, before
    // the held second spawn landed (turn one's milestones precede).
    expect(session.order).toEqual(["spawned", "settled", "done"]);
    // The record is STILL HELD at done — the spawn is in flight, so a
    // child may still be created for this session.
    const entryOf = ():
      | { ended: string | null }
      | undefined => {
      const registry = readRegistry(session.options.registryPath as string);
      return registry.outcome === "ok"
        ? (registry.file.sessions.find((r) => r.id === ID) as { ended: string | null })
        : undefined;
    };
    const held = entryOf();
    expect(held).toBeDefined(); // the record exists and is still live
    expect(held!.ended).toBeNull();
    // The abandoned spawn is not leaked: it lands, is stopped rather than
    // run, and settles.
    const deadline = Date.now() + 8_000;
    while (session.order.length < 5) {
      if (Date.now() > deadline) {
        throw new Error(`timed out waiting for the late child; order: ${session.order.join(",")}`);
      }
      await Bun.sleep(10);
    }
    expect(session.order).toEqual([
      "spawned",
      "settled",
      "done",
      "spawned",
      "settled",
    ]);
    expect(
      session.events.filter((event) => event.type === "assistant_message").length
    ).toBe(1);
    // Past that settling the record releases: the end is stamped only
    // once no child of this session can be created anymore.
    const stampDeadline = Date.now() + 8_000;
    for (;;) {
      const entry = entryOf();
      if (entry !== undefined && entry.ended !== null) break;
      if (Date.now() > stampDeadline) {
        throw new Error(`timed out waiting for the deferred registry release`);
      }
      await Bun.sleep(10);
    }
  });

  test("a fatal escalation while a graceful end awaits the turn's spawn cuts the wait (al25)", async () => {
    // The edges major's third escalation: a crash end arriving while the
    // graceful spawn wait runs — here a codemux-side read failure
    // reported through the driver's fatal channel, the same seam round
    // al20 drove — must cut the wait like a signal or timeout does, or
    // a stuck spawn would block the crash end's own cleanup forever.
    const session = await startSession({}, {}, 400);
    send(session.driver, { type: "user", text: "scenario:basic one" });
    await waitFor(session.events, of("turn_started"), "turn_started");
    session.driver.handleCallerEnd();
    session.driver.handleFatal({
      kind: "read-error",
      error: new Error("EPIPE: broken pipe"),
      bytes: 0,
    });

    const completed = await waitFor(
      session.events,
      of("turn_completed"),
      "the synthesized turn_completed"
    );
    expect(completed.finish).toBe("failed");
    expect(completed.reason).toContain("reading the harness's stdout failed");
    expect(await session.code).toBe(1);
    // The crash cut the wait: done resolved before the spawn landed.
    expect(session.order).toEqual(["done"]);
    const deadline = Date.now() + 8_000;
    while (session.order.length < 3) {
      if (Date.now() > deadline) {
        throw new Error(`timed out waiting for the late child; order: ${session.order.join(",")}`);
      }
      await Bun.sleep(10);
    }
    expect(session.order).toEqual(["done", "spawned", "settled"]);
  });
});
