/** Driver e2e tests for the aider session, end-path split (from
 * tests/session-aider-e2e.test.ts): stdin close, the shutdown drain's
 * deliveries and verdicts, the timeout, spawn failure, the late-child
 * ordering rules, and the registry start record. */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AiderSessionDriver } from "../src/session/aider-driver.js";
import { aiderSessionHistoryPath } from "../src/session/aider-session.js";
import {
  cleanups,
  fakeRecord,
  messageArg,
  of,
  send,
  startSession,
  STARTUP_GRACE_MS,
  waitFor,
  workRoot,
  type Event
} from "./helpers/session-aider-e2e.js";

afterAll(async () => {
  for (const clean of cleanups.reverse()) await clean();
});

describe("aider session e2e - end paths", () => {
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
    expect(completed.reason).toContain("the aider process exited with signal SIGTERM");
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
    // The signal death fails the session. The turn it killed
    // left the history half-written (aider wrote the `#### ` user block at
    // the turn's start; the reply never landed), so the end is NOT
    // resumable: a resume would replay the unanswered prompt (review D10,
    // correctness-2 1).
    expect(ended.exit_code).toBe(1);
    expect(ended.harness_exit).toEqual({ code: null, signal: "SIGTERM" });
    expect(ended.shutdown_requested).toBe(true);
    expect(ended.resumable).toBe(false);
    expect(session.events.filter((event) => event.type === "turn_started")).toHaveLength(1);
  });

  test("the shutdown drain delivers the open turn's exchange", async () => {
    // FAKE_SIGTERM_PERSIST=1 answers the shutdown SIGTERM by appending
    // the exchange inside the grace window before exiting 0 — the turn's
    // reply is the drained output the caller is owed.
    const session = await startSession({}, { FAKE_SIGTERM_PERSIST: "1" });
    send(session.driver, { type: "user", text: "scenario:basic one" });
    await waitFor(session.events, of("turn_completed"), "first turn_completed");
    send(session.driver, { type: "user", text: "scenario:wait two" });
    await waitFor(
      session.events,
      (events) => events.filter((event) => event.type === "turn_started")[1],
      "second turn_started"
    );
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
    const ended = await waitFor(session.events, of("session_ended"), "session_ended");
    expect(ended.reason).toBe("shutdown");
    expect(ended.resumable).toBe(true);
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
    const completions = session.events.filter((event) => event.type === "turn_completed");
    expect(completions).toHaveLength(2);
    expect(completions[1]!.turn_id).toBe("t2");
    expect(completions[1]!.finish).toBe("failed");
    expect(completions[1]!.reason).toBe("the aider process exited with code 42");
    expect(await session.code).toBe(1);
  });

  test("a wrapper exiting 143 during the drain fails the session", async () => {
    // A longer shutdown grace than the helper's 500 ms: under a full-suite
    // load the wrapper's 143 exit lost the race to the grace's SIGKILL.
    const session = await startSession({}, { FAKE_SIGTERM_PERSIST: "exit143" }, undefined, 0, 2_000);
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
    expect(ended.resumable).toBe(false);
    const second = session.events.filter((event) => event.type === "turn_completed")[1] as Event;
    expect(second.finish).toBe("failed");
    expect(second.reason).toContain("exited with code 143");
    expect(await session.code).toBe(1);
    // The half-written state the verdict answers for: turn 2's user block
    // is in the history, its reply never landed (the `wait` scenario
    // writes the block at the turn's start — io.user_input parity).
    const history = readFileSync(session.historyPath, "utf8");
    expect(history).toContain("#### scenario:wait two");
    expect(history).not.toContain("Done: scenario:wait two");
  });

  test("a turn killed partway leaves the history half-written and the session not resumable (review D10, correctness-2 1)", async () => {
    // The regression this pins: a killed turn exited 143 (not a drain
    // failure) with no turn failure recorded, so the end's verdict said
    // resumable — though aider had already written the turn's `#### `
    // user block to the history file and would never write its reply,
    // leaving exactly the mid-exchange state a resume must refuse:
    // --restore-chat-history replays the unanswered prompt as if the
    // caller had sent it again.
    const session = await startSession({}, { FAKE_SIGTERM_PERSIST: "exit143" });
    send(session.driver, { type: "user", text: "scenario:wait interrupted" });
    await waitFor(session.events, of("turn_started"), "turn_started");
    send(session.driver, { type: "shutdown" });

    const completed = await waitFor(
      session.events,
      of("turn_completed"),
      "the interrupted turn_completed"
    );
    expect(completed.finish).toBe("failed");
    const ended = await waitFor(session.events, of("session_ended"), "session_ended");
    expect(ended.reason).toBe("harness_failed");
    expect(ended.exit_code).toBe(1);
    expect(ended.resumable).toBe(false);
    expect(await session.code).toBe(1);
    // The half-written history: the user block landed at the turn's
    // start, the reply never did.
    const history = readFileSync(session.historyPath, "utf8");
    expect(history).toContain("#### scenario:wait interrupted");
    expect(history).not.toContain("Done: scenario:wait interrupted");
  });

  test("the session timeout ends the session", async () => {
    const session = await startSession({ sessionTimeoutMs: 300 });
    expect(await session.code).toBe(1);
    const ended = session.events[session.events.length - 1] as Event;
    expect(ended.type).toBe("session_ended");
    expect(ended.reason).toBe("timeout");
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
    expect(error.message).toContain("could not spawn the aider turn process");
    expect(error.message).toContain("the binary is gone");
    expect(await session.code).toBe(1);
    const ended = session.events[session.events.length - 1] as Event;
    expect(ended.reason).toBe("crash");
  });

  test("a turn child landing after a hard end is settled before done resolves (review D5, correctness 2)", async () => {
    // A timeout while the turn's spawn is still in flight (the 250 ms
    // hold): finish sees no turn process yet, and the late child must be
    // stopped and its tree settled BEFORE done resolves — the CLI's
    // cleanup runs the moment done does, and an aider process must never
    // run past the session it was spawned for (review D5, correctness 2,
    // the opencode twin names the provider-config deletion; aider's
    // child holds nothing codemux deletes, but the ordering rule is one).
    // Its exit is codemux's own kill, not a turn verdict: session_ended
    // reports exit_code null, exactly as an idle session does. A
    // graceful end no longer takes this arm (review D11): stdin-close
    // and shutdown run the late child instead, pinned by the next test,
    // so the kill arm is pinned here on a timeout.
    const session = await startSession({ sessionTimeoutMs: 100 }, {}, undefined, 250);
    send(session.driver, { type: "user", text: "scenario:basic one" });
    await waitFor(session.events, of("turn_started"), "turn_started");

    const completed = await waitFor(
      session.events,
      of("turn_completed"),
      "the synthesized turn_completed"
    );
    expect(completed.turn_id).toBe("t1");
    expect(completed.finish).toBe("failed");
    expect(completed.reason).toContain("the aider process exited with signal SIGTERM during the shutdown drain before completing its open turn");
    const ended = session.events[session.events.length - 1] as Event;
    expect(ended.type).toBe("session_ended");
    expect(ended.reason).toBe("harness_failed");
    expect(ended.exit_code).toBe(1);
    expect(await session.code).toBe(1);
    // The ordering the finding named, and exactly one child for the
    // turn: the late child settled before the session's done resolved.
    expect(session.order).toEqual(["spawned", "settled", "done"]);
  });

  test("a stdin close while the turn's spawn is still in flight runs that turn to completion (review D11, correctness 2 1)", async () => {
    // The aider twin of the opencode trigger — `printf one user line |
    // codemux session -a aider -s` — where the scode gate holds the
    // turn's spawn when the close arrives (the 250 ms hold models that
    // window). The prompt rides argv (written before the spawn); what
    // the late child misses is its stdin negatives, so the end path
    // writes those itself and runs the turn through the landed path's
    // drain. The history file then holds the full exchange, and the
    // graceful end stays resumable — pre-D11 the child was killed on
    // arrival, the prompt never ran, and the turn was reported
    // interrupted.
    const session = await startSession({}, {}, undefined, 250, STARTUP_GRACE_MS);
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
    const message = await waitFor(
      session.events,
      of("assistant_message"),
      "assistant_message"
    );
    expect(message.text).toBe("Done: scenario:basic one");
    const ended = await waitFor(session.events, of("session_ended"), "session_ended");
    expect(ended.reason).toBe("stdin-close");
    expect(ended.exit_code).toBe(0);
    expect(ended.resumable).toBe(true);
    expect(await session.code).toBe(0);
    // The negatives reached the late child and the prompt rode argv —
    // the regression's core — and the history holds the full exchange
    // (the resumable state), settled before done resolved.
    expect(fakeRecord(session, "stdin.jsonl")[0]?.bytes).toBe(128);
    expect(messageArg(session, 0)).toBe("--message=scenario:basic one");
    const history = readFileSync(session.historyPath, "utf8");
    expect(history).toContain("#### scenario:basic one");
    expect(history).toContain("Done: scenario:basic one");
    expect(session.order).toEqual(["spawned", "settled", "done"]);
  }, 10_000);

  test("a history file the start record cannot record into ends the session before any turn", async () => {
    // The registry write fails (the registry path's parent is a file):
    // recordBeforeSpawn reports it, and the CLI refuses to run a session
    // it cannot track (§4.8).
    const blockerRoot = mkdtempSync(join(workRoot(), "blocker-"));
    const blocker = join(blockerRoot, "blocker");
    writeFileSync(blocker, "not a directory");
    const harnessHome = join(blockerRoot, "home");
    const id = crypto.randomUUID();
    const driver = new AiderSessionDriver({
      sessionId: id,
      resume: false,
      autonomy: "high",
      cwd: blockerRoot,
      hermetic: false,
      sandboxed: true,
      sandboxTrust: "standard",
      sandboxNoNet: false,
      sandboxScrubEnv: false,
      passEnv: [],
      authorPrefix: true,
      sessionTimeoutMs: null,
      registryPath: join(blocker, "reg", "live-sessions.json"),
      harnessHome,
      providerBaseUrl: null,
      historyPath: aiderSessionHistoryPath(harnessHome, id),
      spawnTurn: () => Promise.reject(new Error("never reached")),
    });
    expect(driver.recordBeforeSpawn()).toContain("cannot update the session registry");
    driver.dispose();
  });
});
