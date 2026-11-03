/** Driver e2e tests for the opencode session, end-path split (from
 * tests/session-opencode-e2e.test.ts): stdin close, the shutdown
 * drain's deliveries and verdicts, the registry-record rule, and the
 * late-child ordering rules. */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import {
  cleanups,
  fakeRecord,
  of,
  send,
  startSession,
  waitFor,
  workRoot,
  type Event
} from "./helpers/session-opencode-e2e.js";

afterAll(async () => {
  for (const clean of cleanups.reverse()) await clean();
});

describe("opencode session e2e - end paths", () => {
  test("stdin close mid-turn reports a non-complying child's signal exit as failed", async () => {
    const session = await startSession();
    send(session.driver, { type: "user", text: "scenario:wait hold" });
    await waitFor(session.events, of("turn_started"), "turn_started");
    // The wait scenario's step_start already named the session, so the
    // identity landed and the session is recorded.
    await waitFor(session.events, of("session_started"), "session_started");
    session.driver.handleCallerEnd();
    const completed = await waitFor(
      session.events,
      of("turn_completed"),
      "the synthesized turn_completed"
    );
    expect(completed.turn_id).toBe("t1");
    expect(completed.finish).toBe("failed");
    expect(completed.reason).toContain("the opencode process exited with signal SIGTERM");
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
    expect(ended.exit_code).toBe(1);
    expect(ended.harness_exit).toEqual({ code: null, signal: "SIGTERM" });
    expect(ended.shutdown_requested).toBe(true);
    expect(ended.resumable).toBe(true);
    expect(session.events.filter((event) => event.type === "turn_started")).toHaveLength(1);
  });

  test("the shutdown drain delivers the open turn's final output", async () => {
    // The end path gives the turn's process the grace to finish on its
    // own; FAKE_SIGTERM_PERSIST=1 answers the shutdown SIGTERM with the
    // turn's remaining lines before exiting 0, and that drained output
    // must reach the caller (review live5's rule, the turn-per-process
    // shape: no end carrier exists, the signal is the only thing left).
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
    expect(completed.finish).toBe("end");
    expect(completed.usage).toEqual(first.usage);
    const ended = await waitFor(session.events, of("session_ended"), "session_ended");
    expect(ended.reason).toBe("shutdown");
    expect(await session.code).toBe(0);
  });

  test("a process exiting 42 during the drain with its turn open costs success", async () => {
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
    const fatal = session.events.find((event) => event.type === "error" && event.fatal === true);
    expect(fatal).toBeDefined();
    expect(fatal!.message).toContain("exited with code 42 during the shutdown drain");
    // The child's real exit completed the open turn before the synthesis
    // was needed: its verdict carries the exit code it died with, and the
    // drain fatal rides on top as the session-level verdict.
    const completions = session.events.filter((event) => event.type === "turn_completed");
    expect(completions).toHaveLength(2);
    expect(completions[1]!.turn_id).toBe("t2");
    expect(completions[1]!.finish).toBe("failed");
    expect(completions[1]!.reason).toBe("the opencode process exited with code 42");
    expect(await session.code).toBe(1);
  });

  test("a wrapper exiting 143 during the drain fails the session", async () => {
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
    expect(ended.exit_code).toBe(1);
    expect(of("error")(session.events)?.fatal).toBe(true);
    const second = session.events.filter((event) => event.type === "turn_completed")[1] as Event;
    expect(second.finish).toBe("failed");
    expect(second.reason).toContain("exited with code 143");
    expect(await session.code).toBe(1);
  });

  test("caller input during the shutdown drain is rejected shutting_down, never dropped", async () => {
    // The drain window exists only while a turn is open (an idle session
    // settles at once), so the late input must land inside one.
    const session = await startSession();
    send(session.driver, { type: "user", text: "scenario:wait hold" });
    await waitFor(session.events, of("session_started"), "session_started");
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
    expect(await session.code).toBe(1);
  });

  test("a confirmed session whose start was never recorded is not resumable", async () => {
    // Review live22's agy sibling: the first line adopts the id and
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
    const ended = session.events[session.events.length - 1] as Event;
    expect(ended.type).toBe("session_ended");
    expect(ended.reason).toBe("crash");
    expect(ended.resumable).toBe(false);
  });

  test("a turn child landing after a hard end is settled before done resolves (review D5, correctness 2)", async () => {
    // A timeout while the turn's spawn is still in flight (the 250 ms
    // hold): finish sees no turn process yet, and the late child must be
    // stopped and its tree settled BEFORE done resolves — the CLI's
    // cleanup removes the turn's provider config the moment done does,
    // and an opencode process must never run past that with an
    // OPENCODE_CONFIG pointing at a deleted file. Its exit is codemux's
    // own kill, not a turn verdict: session_ended reports exit_code
    // null, exactly as an idle session does. A graceful end no longer
    // takes this arm (review D11): stdin-close and shutdown run the late
    // child instead, pinned by the next test, so the kill arm is pinned
    // here on a timeout.
    const session = await startSession({ sessionTimeoutMs: 100 }, {}, 250);
    send(session.driver, { type: "user", text: "scenario:basic one" });
    await waitFor(session.events, of("turn_started"), "turn_started");

    const completed = await waitFor(
      session.events,
      of("turn_completed"),
      "the synthesized turn_completed"
    );
    expect(completed.turn_id).toBe("t1");
    expect(completed.finish).toBe("failed");
    expect(completed.reason).toContain("the opencode process exited with signal SIGTERM during the shutdown drain before completing its open turn");
    const ended = session.events[session.events.length - 1] as Event;
    expect(ended.type).toBe("session_ended");
    expect(ended.reason).toBe("harness_failed");
    expect(ended.exit_code).toBe(1);
    expect(await session.code).toBe(1);
    // The ordering the finding named, and exactly one child for the
    // turn: the late child settled before the session's done resolved.
    // (The kill can land before the fake's startup line records argv, so
    // the argv record itself is not asserted here.)
    expect(session.order).toEqual(["spawned", "settled", "done"]);
  });

  test("a stdin close while the turn's spawn is still in flight runs that turn to completion (review D11, correctness 2 1)", async () => {
    // The exact trigger: one prompt, then immediate EOF — `printf one
    // user line | codemux session -a opencode -s` — where the scode
    // gate holds the turn's spawn when the close arrives (the 250 ms
    // hold models that window). A graceful end owes that pending turn
    // its run: pre-D11 the late child was killed on arrival, so the
    // prompt never ran and the turn was reported interrupted while the
    // session still ended exit 0. Now the end path delivers the prompt
    // itself and runs the child through the landed path's drain, inside
    // the end, settled before done resolves.
    const session = await startSession({}, {}, 250);
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
    // The harness confirmed the session (its lines named the id inside
    // the drain), so the graceful end stays resumable.
    expect(ended.resumable).toBe(true);
    expect(await session.code).toBe(0);
    // The prompt actually reached the late child — the regression's
    // core — and it settled before done resolved.
    expect(fakeRecord(session, "prompts.jsonl")).toEqual([
      { text: "scenario:basic one" },
    ]);
    expect(session.order).toEqual(["spawned", "settled", "done"]);
  });
});
