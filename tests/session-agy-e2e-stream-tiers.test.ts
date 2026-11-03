/** Driver e2e tests for the agy session, stream-tier split (from
 * tests/session-agy-e2e.test.ts): tier-2 and tier-3 fatal lines, the
 * crash path, signal handling, and the shutdown drain's verdicts and
 * deliveries. */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { AgySessionDriver } from "../src/session/agy-driver.js";
import { SessionProcess } from "../src/session/process.js";
import {
  cleanups,
  FAKE,
  of,
  send,
  startSession,
  waitFor,
  workRoot,
  type Event
} from "./helpers/session-agy-e2e.js";

afterAll(async () => {
  for (const clean of cleanups.reverse()) await clean();
});

describe("agy session e2e - stream tiers", () => {
  test("a non-JSON line is a tier-3 fatal crash", async () => {
    const session = await startSession();
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
  });

  test("a result naming a foreign conversation is a tier-2 fatal with the raw preserved", async () => {
    const session = await startSession();
    send(session.driver, { type: "user", text: "scenario:basic one" });
    await waitFor(session.events, of("turn_completed"), "turn_completed");
    send(session.driver, { type: "user", text: "scenario:wrongid two" });
    const unknown = await waitFor(
      session.events,
      (events) =>
        events.find(
          (event) => event.type === "unknown" && typeof event.raw === "string" && event.raw.includes("conv-other-9")
        ),
      "the raw passthrough"
    );
    expect(unknown.session_id).toBe("conv-fake-1");
    const error = await waitFor(
      session.events,
      (events) => events.find((event) => event.type === "error" && event.fatal === true),
      "the fatal error"
    );
    expect(error.message).toContain("conv-other-9");
    expect(await session.code).toBe(1);
  });

  test("a frame without an event name is a tier-2 fatal", async () => {
    const session = await startSession();
    send(session.driver, { type: "user", text: "scenario:noevent probe" });
    const error = await waitFor(
      session.events,
      (events) => events.find((event) => event.type === "error" && event.fatal === true),
      "the fatal error"
    );
    expect(error.message).toContain("no event name");
    expect(await session.code).toBe(1);
  });

  test("a result envelope without a status is a tier-2 fatal", async () => {
    const session = await startSession();
    send(session.driver, { type: "user", text: "scenario:badresult probe" });
    const error = await waitFor(
      session.events,
      (events) => events.find((event) => event.type === "error" && event.fatal === true),
      "the fatal error"
    );
    expect(error.message).toContain("no usable envelope");
    expect(await session.code).toBe(1);
  });

  test("a harness crash ends the session through the crash path", async () => {
    const session = await startSession();
    send(session.driver, { type: "user", text: "scenario:crash boom" });
    const error = await waitFor(
      session.events,
      (events) => events.find((event) => event.type === "error" && event.fatal === true),
      "the crash error"
    );
    expect(error.message).toContain("exited unexpectedly");
    expect(await session.code).toBe(1);
    const ended = session.events[session.events.length - 1] as Event;
    expect(ended.reason).toBe("harness_failed");
  });

  test("a signal that fires before attach stops the child instead of stranding it", async () => {
    // Review live4, codex blocker 1 (the window is every driver's): the
    // signal handlers are installed at construction, but the child is
    // attached only after the CLI's async spawn; a signal in that window
    // finished the driver with no child to stop, and the child then ran
    // on, never stopped. handleCallerEnd() is the same public pre-attach
    // end a signal produces, deterministically.
    const dir = mkdtempSync(join(workRoot(), "s-"));
    const stateDir = join(dir, "state");
    mkdirSync(stateDir);
    const driver = new AgySessionDriver({
      resumeConversationId: null,
      autonomy: "high",
      cwd: dir,
      sandboxed: true,
      sandboxTrust: "standard",
      sandboxNoNet: false,
      sandboxScrubEnv: false,
      passEnv: [],
      authorPrefix: true,
      sessionTimeoutMs: null,
      registryPath: null,
      harnessHome: join(dir, "home"),
      providerBaseUrl: null,
      sink: () => {},
    });
    // The pre-attach end: the driver finishes with no child to stop.
    driver.handleCallerEnd();
    const proc = new SessionProcess({
      command: ["bun", FAKE],
      cwd: dir,
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        FAKE_STATE_DIR: stateDir,
        HOME: dir,
      },
      onLine: (line) => driver.handleHarnessLine(line),
      onFatal: (fatal) => driver.handleFatal(fatal),
      graceMs: 500,
    });
    driver.attach(proc);
    // Already finished: resolves without starting the session, and the
    // child that arrived after the end is stopped by attach itself.
    expect(await driver.run()).toBe(0);
    const outcome = await Promise.race([
      proc.exited,
      Bun.sleep(4_000).then(() => null),
    ]);
    expect(outcome).not.toBeNull();
    driver.dispose();
    await proc.settled;
  });

  test("signal handlers stay installed until cleanup completes", async () => {
    // Review live5, major 1: finish() used to dispose the signal gate
    // early, so a second SIGINT/SIGTERM during the shutdown grace killed
    // codemux mid-kill. The gate must stay installed until the child has
    // settled and session_ended is out. Deterministic: send() runs
    // finish()'s synchronous prefix (requestStop) while the awaits from
    // proc.settled onward resume only on a later event-loop turn.
    const count = () =>
      process.listenerCount("SIGINT") +
      process.listenerCount("SIGTERM") +
      process.listenerCount("SIGHUP");
    const session = await startSession();
    send(session.driver, { type: "user", text: "scenario:basic one" });
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
    // flipped, so a result envelope arriving during the grace window —
    // here the wait turn's success result, emitted by the persist-mode
    // fake as it survives the shutdown SIGTERM — vanished: no
    // turn_completed for the open turn, a short-counted session_ended,
    // exit 0. The drain must deliver it.
    const session = await startSession({}, { FAKE_SIGTERM_PERSIST: "1" });
    send(session.driver, { type: "user", text: "scenario:basic one" });
    const first = await waitFor(session.events, of("turn_completed"), "turn_completed");
    // A fresh session's identity lands with the first result; the second
    // turn is the one the drain will complete.
    expect(first.finish).toBe("end");
    send(session.driver, { type: "user", text: "scenario:wait two" });
    const secondTurn = await waitFor(
      session.events,
      (events) => events.filter((event) => event.type === "turn_started")[1],
      "second turn_started"
    );
    expect(secondTurn.turn_id).toBe("t2");
    send(session.driver, { type: "shutdown" });

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
    // Two identical turns, summed field-wise by the drain's fold.
    expect(ended.usage).toEqual({
      input_tokens: 120,
      output_tokens: 40,
      cached_input_tokens: 80,
      total_tokens: 240,
      cost_usd: null,
    });
    expect(session.events[session.events.length - 1]).toBe(ended);
    expect(await session.code).toBe(0);
  });

  test("a fatal arriving during the shutdown drain costs success", async () => {
    // Review live7, major 2: once `finish` began, its re-entry guard
    // ignored every later failure call — the driver emitted the tier-3
    // fatal and still exited 0 with reason "shutdown". Cleanup stays
    // idempotent; the verdict does not freeze until the child settles: a
    // fatal line arriving inside the grace window raises the exit code
    // to 1. FAKE_SIGTERM_PERSIST=garbage keeps the fake alive past the
    // shutdown SIGTERM and emits one non-JSON line before dying (the
    // drained result after it still reaches the caller — both facts
    // hold at once).
    const session = await startSession({}, { FAKE_SIGTERM_PERSIST: "garbage" });
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
    expect(ended.reason).toBe("shutdown");
    const fatal = session.events.find(
      (event) => event.type === "error" && event.fatal === true
    );
    expect(fatal).toBeDefined();
    expect(fatal!.source).toBe("harness");
    expect(fatal!.message).toContain("unusable harness output");
    // The drain still delivered the open turn's completion alongside the
    // fatal: the grace window is not forfeited by the failure.
    expect(of("turn_completed")(session.events)).toBeDefined();
    expect(session.events[session.events.length - 1]).toBe(ended);
    expect(await session.code).toBe(1);
  });

  test("caller input during the shutdown drain is rejected shutting_down, never dropped", async () => {
    // Review live9, contracts: §4.1 and the README promise every input
    // line is acknowledged, but the driver's guard returned before
    // parsing once `finished` flipped — the documented `shutting_down`
    // reason was unreachable dead code. The drain window (`finished`,
    // not yet `settled`) now answers every line with the rejection.
    const session = await startSession();
    send(session.driver, { type: "user", text: "scenario:basic one" });
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

  test("a harness exiting nonzero during the drain with its turn open costs success", async () => {
    // Review live9, correctness 2 (the agy sibling): finish() resolved
    // with the initiating end's success code and ignored the child's
    // exit — driver exit 0 while session_ended.exit_code said 42. The
    // verdict now reads the child: a turn still open at the drain's end
    // (no result envelope delivered) plus a nonzero exit is a failure,
    // with the error on the stream ahead of session_ended. Signal deaths
    // fail too. Turn 1 must complete first: a fresh
    // agy session has no identity until its first result.
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
    expect(fatal!.source).toBe("harness");
    expect(fatal!.message).toContain("exited with code 42 during the shutdown drain");
    // Review live12: this exit class used to leave `turn_started t2`
    // unpaired — the failure verdict and the synthesis were mutually
    // exclusive. The open turn is now answered too: a failed completion
    // whose reason mirrors the fatal, after the error, before the end.
    const completions = session.events.filter((event) => event.type === "turn_completed");
    expect(completions).toHaveLength(2);
    expect(completions[1]!.turn_id).toBe("t2");
    expect(completions[1]!.finish).toBe("failed");
    expect(completions[1]!.reason).toContain("exited with code 42 during the shutdown drain");
    expect(completions[1]!.raw).toBeNull();
    expect(completions[1]!.usage).toEqual({
      input_tokens: null,
      output_tokens: null,
      cached_input_tokens: null,
      total_tokens: null,
      cost_usd: null,
    });
    expect(session.events[session.events.length - 1]).toBe(ended);
    expect(await session.code).toBe(1);
  });

  test("a wrapper exiting 143 during the drain fails the session", async () => {
    // Code 143 fails like every other nonzero or signal exit. The open
    // turn must also receive a failed completion. The first turn gives
    // the fresh session its identity before this shutdown.
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
    // The open turn is still answered — synthesized failed,
    // codemux-originated, usage never guessed.
    const second = session.events.filter((event) => event.type === "turn_completed")[1] as Event;
    expect(second).toBeDefined();
    expect(second.turn_id).toBe("t2");
    expect(second.finish).toBe("failed");
    expect(second.reason).toContain("exited with code 143");
    expect(second.usage).toEqual({
      input_tokens: null,
      output_tokens: null,
      cached_input_tokens: null,
      total_tokens: null,
      cost_usd: null,
    });
    expect(session.events[session.events.length - 1]).toBe(ended);
    expect(await session.code).toBe(1);
  });

  test("a crash mid-turn reports one fatal and still answers the open turn", async () => {
    // Review live11, minor 5: the crash path already told the failure
    // story ("exited unexpectedly"), but the live9 verdict then added a
    // second, false "during the shutdown drain" fatal for the same exit,
    // and the open turn's turn_started was never answered — the synthesis
    // only covered exit codes null and 0. The crash now emits one fatal
    // and the turn receives a failed completion.
    const session = await startSession();
    send(session.driver, { type: "user", text: "scenario:crash boom" });
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
    // usage never guessed. Events before the first result carry an empty
    // session id — the identity never landed.
    const completed = of("turn_completed")(session.events) as Event;
    expect(completed).toBeDefined();
    expect(completed.turn_id).toBe("t1");
    expect(completed.finish).toBe("failed");
    // Review live17: the reason is the fatal that ended the session.
    expect(completed.reason).toContain("the agy process exited with code 1 during the shutdown drain before completing its open turn");
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
});
