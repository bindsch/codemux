/**
 * Driver e2e for the kimi session (design §4.7): turn content and spawn
 * failures — tool-call mapping, the meta passthrough, thrown and silent
 * turns, and the spawn failure plus queue-overflow end paths. Split from
 * tests/session-kimi-e2e.test.ts; the rig is tests/helpers/
 * session-kimi-e2e.ts.
 */

import { afterAll, describe, expect, test } from "bun:test";
import {
  cleanups,
  of,
  send,
  startSession,
  waitFor,
  type Event,
} from "./helpers/session-kimi-e2e.js";

afterAll(async () => {
  for (const clean of cleanups) await clean();
});

describe("kimi session e2e - lifecycle", () => {
  test("a tool-calling turn maps its calls and results, arguments parsed", async () => {
    const session = await startSession();
    send(session.driver, { type: "user", text: "scenario:tools one" });
    const call = await waitFor(session.events, of("tool_call"), "tool_call");
    expect(call.call_id).toBe("call_1");
    expect(call.name).toBe("bash");
    expect(call.input).toEqual({ command: "ls" });
    const result = await waitFor(session.events, of("tool_result"), "tool_result");
    expect(result.call_id).toBe("call_1");
    expect(result.output).toBe("file-a\nfile-b");
    expect(result.is_error).toBe(false);
    const message = await waitFor(session.events, of("assistant_message"), "assistant_message");
    expect(message.text).toBe("Listed: scenario:tools one");
    await waitFor(session.events, of("turn_completed"), "turn_completed");
    send(session.driver, { type: "shutdown" });
    expect(await session.code).toBe(0);
  });

  test("a stream that ends with an unanswered tool call and no final text fails the turn (al33)", async () => {
    // Round al33, edges major 2: an assistant frame carrying only tool
    // calls is a request for work, not a reply, so it may not mark the
    // turn as having produced one. The danglingtool fake cuts the tool
    // loop mid-flight — the call opens, its result never arrives, no
    // final assistant text follows, the closing hint lands, and the
    // child exits 0 — and before this round exactly that shape
    // completed as `end`: the tool-call frame set sawAssistant, and
    // nothing tracked the call it left open.
    const session = await startSession();
    send(session.driver, { type: "user", text: "scenario:danglingtool one" });
    const call = await waitFor(session.events, of("tool_call"), "tool_call");
    expect(call.call_id).toBe("call_1");
    // No assistant_message ever arrives: the turn produced no reply.
    const completed = await waitFor(session.events, of("turn_completed"), "turn_completed");
    expect(completed.finish).toBe("failed");
    expect(completed.reason).toBe(
      "the kimi process exited 0 with 1 tool call that never received a result and no final assistant reply"
    );
    // A turn fact, not a session fatal: the session survives, and a
    // later whole turn still completes.
    expect(of("error")(session.events)).toBeUndefined();
    send(session.driver, { type: "user", text: "scenario:basic two" });
    const second = await waitFor(
      session.events,
      (events) => events.filter((event) => event.type === "turn_completed")[1],
      "second turn_completed"
    );
    expect(second.finish).toBe("end");
    send(session.driver, { type: "shutdown" });
    expect(await session.code).toBe(0);
  });

  test("informational meta (retrying, version) passes through raw and the turn still completes", async () => {
    const session = await startSession();
    send(session.driver, { type: "user", text: "scenario:retrying one" });
    const unknown = await waitFor(
      session.events,
      (events) =>
        events.find(
          (event) =>
            event.type === "unknown" &&
            typeof event.raw === "string" &&
            event.raw.includes("turn.step.retrying")
        ),
      "the retrying passthrough"
    );
    expect(unknown.raw).toContain('"failed_attempt":1');
    const completed = await waitFor(session.events, of("turn_completed"), "turn_completed");
    expect(completed.finish).toBe("end");
    send(session.driver, { type: "shutdown" });
    expect(await session.code).toBe(0);
  });

  test("a thrown turn fails its turn and the session survives; the same exit on the first turn ends the untrackable session", async () => {
    const session = await startSession();
    send(session.driver, { type: "user", text: "scenario:basic one" });
    await waitFor(session.events, of("turn_completed"), "first turn_completed");
    send(session.driver, { type: "user", text: "scenario:errorturn two" });
    const failed = await waitFor(
      session.events,
      (events) => events.filter((event) => event.type === "turn_completed")[1],
      "the failed turn_completed"
    );
    expect(failed.finish).toBe("failed");
    expect(failed.reason).toBe("the kimi process exited with code 1");
    // No fatal: the session carries on.
    expect(of("error")(session.events)).toBeUndefined();
    send(session.driver, { type: "user", text: "scenario:basic three" });
    const third = await waitFor(
      session.events,
      (events) => events.filter((event) => event.type === "turn_completed")[2],
      "third turn_completed"
    );
    expect(third.finish).toBe("end");
    send(session.driver, { type: "shutdown" });
    expect(await session.code).toBe(1);

    // The same exit before any hint: §4.8's untracked rule.
    const early = await startSession();
    send(early.driver, { type: "user", text: "scenario:crash one" });
    const fatal = await waitFor(
      early.events,
      (events) => events.find((event) => event.type === "error" && event.fatal === true),
      "the untracked fatal"
    );
    expect(fatal.message).toContain("named no session id");
    const completed = await waitFor(early.events, of("turn_completed"), "turn_completed");
    expect(completed.finish).toBe("failed");
    expect(completed.reason).toContain("named no session id");
    expect(await early.code).toBe(1);
    const ended = early.events[early.events.length - 1] as Event;
    expect(ended.reason).toBe("harness_failed");
    expect(ended.resumable).toBe(false);
    // session_started never happened: nothing was ever identified.
    expect(of("session_started")(early.events)).toBeUndefined();
  });

  test("an exit 0 that printed no assistant output fails the turn on the empty verdict", async () => {
    const session = await startSession();
    send(session.driver, { type: "user", text: "scenario:silent one" });
    // The silent scenario still writes its hint, so the session exists.
    await waitFor(session.events, of("session_started"), "session_started");
    const completed = await waitFor(session.events, of("turn_completed"), "turn_completed");
    expect(completed.finish).toBe("failed");
    expect(completed.reason).toBe("the kimi process exited 0 and printed no assistant output");
    expect(of("error")(session.events)).toBeUndefined();
    send(session.driver, { type: "shutdown" });
    expect(await session.code).toBe(0);
  });

  test("a spawn failure is a fatal codemux error, never an unhandled rejection", async () => {
    const session = await startSession({
      spawnTurn: () => Promise.reject(new Error("the binary is gone")),
    });
    send(session.driver, { type: "user", text: "scenario:basic one" });
    const error = await waitFor(
      session.events,
      (events) => events.find((event) => event.type === "error" && event.fatal),
      "fatal error"
    );
    expect(error.source).toBe("codemux");
    expect(error.message).toContain("could not spawn the kimi turn process");
    expect(error.message).toContain("the binary is gone");
    expect(await session.code).toBe(1);
    const ended = session.events[session.events.length - 1] as Event;
    expect(ended.reason).toBe("crash");
  });

  test("a null spawn rejection fails the session without attaching a child", async () => {
    const session = await startSession({ spawnTurn: () => Promise.reject(null) });
    send(session.driver, { type: "user", text: "hello" });
    expect(await session.code).toBe(1);
    expect(session.events.some((event) => event.type === "error" && event.fatal &&
      event.message.includes("could not spawn the kimi turn process"))).toBe(true);
    expect(session.events.at(-1)).toMatchObject({ type: "session_ended", reason: "crash", harness_exit: null });
  });

  test("an overflow raised mid-effect-list queues behind it: the spawn runs, the crash ends, the child is reaped (al11, al29)", async () => {
    // The reviewer's trigger, one level down: 1,023 rejected inputs under
    // a blocked sink park the outbound queue one short of its event bound,
    // the valid line's ack lands the 1,024th entry, and the turn_started
    // emission is the enqueue that trips the bound. Round al29's rule
    // changed what happens next: the overflow's fatal event is QUEUED —
    // a nested event may not abort the effect list that raised it — so
    // the transition's own effects complete first (the spawn IS
    // requested), and the crash end dispatches after them, stopping the
    // child it now owns before done resolves. The pre-al29 order this
    // test pinned (no spawn at all) was the aborted-effect-list design
    // al29 replaced: an aborted list leaves effects half-run by
    // construction.
    const session = await startSession({
      sink: () => new Promise<void>(() => {}),
    });
    for (let i = 0; i < 1023; i++) {
      send(session.driver, { type: "interrupt" });
    }
    send(session.driver, { type: "user", text: "scenario:basic one" });
    expect(await session.code).toBe(1);
    // The effect list completed before the crash event dispatched: one
    // spawn was requested, and its child settled BEFORE done — the end
    // path stopped it, so nothing lands after cleanup. The fake writes
    // its argv and prompt records synchronously at startup, but the
    // killing end can stop the child before its first line runs — the
    // stop races the interpreter's own startup — so the records are not
    // guaranteed to land and the milestones are the spawn evidence;
    // asserting the records here would pin that race.
    expect(session.order).toEqual(["spawned", "settled", "done"]);
  });

  test("a synchronous spawn throw under a blocked, near-full queue still completes the hold (al37)", async () => {
    // Round al37, edges major 1 — the opencode repro at this rig's queue
    // arithmetic: a caller that stopped reading parks the outbound queue
    // one short of its ordinary bound (1,023 rejected acks; the deferred
    // identity means no session_started entry yet), the valid line's ack
    // lands the 1,024th entry, and the next turn-opening emit's refusal
    // trips the bound — the overflow fatal parks behind the effect list
    // (the al29 rule) while the spawn effect still has to run. The CLI's
    // real closure can throw SYNCHRONOUSLY (validateRunRequest refuses
    // the per-turn request before any promise exists), and the killing
    // end the parked fatal dispatches then abandons the in-flight spawn:
    // finishDone waits on the hold past done before releasing the record
    // and taking the signal handlers down. No continuation exists to
    // release that hold — the throw arm itself completes it; before al37
    // the wait hung forever, signalsDisposed stayed false, and the
    // registry record never released.
    const session = await startSession({
      sink: () => new Promise<void>(() => {}),
      spawnTurn: () => {
        throw new Error("the per-turn validation failed");
      },
    });
    for (let i = 0; i < 1023; i++) {
      send(session.driver, { type: "interrupt" });
    }
    send(session.driver, { type: "user", text: "scenario:basic one" });
    // The parked fatal's crash end: code 1, resolved once the stopped
    // sink's flush give-up lands — not held behind the abandoned spawn.
    expect(await session.code).toBe(1);
    // The two facts the hung wait could never reach, read off the driver
    // (the blocked sink delivers nothing to wait on): the hold completed
    // and the signal handlers came down.
    const internals = session.driver as unknown as {
      holdDone: boolean;
      signalsDisposed: boolean;
    };
    const deadline = Date.now() + 5_000;
    while (!internals.holdDone || !internals.signalsDisposed) {
      if (Date.now() > deadline) {
        throw new Error(
          `the hold never completed (holdDone ${internals.holdDone}, ` +
            `signalsDisposed ${internals.signalsDisposed})`
        );
      }
      await Bun.sleep(5);
    }
    expect(internals.holdDone).toBe(true);
    expect(internals.signalsDisposed).toBe(true);
  }, 10_000);
});
