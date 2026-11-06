/** The process exit code versus the final event's `exit_code` (review
 * round 169, finding 3): the end path reads its exit code ONCE, before
 * `session_ended` is built, and resolves `done` from that read unless the
 * event's delivery failed. A signal that lands while the final flush is
 * still pending enters `finish`'s re-entry arm and raises `endExitCode`
 * after the event was already sent — it must not change the process exit
 * code. A sink that rejects during the same flush still fails the process
 * nonzero (exit-code honesty). One pair of tests per driver. Exit 143 is
 * for a signal that stopped the session, which `session_ended` then
 * reports; a signal after the event stops nothing (docs/sessions.md, under
 * the exit table; the kimi machine has always behaved this way). The closing
 * ledger line carries the process exit code in every case (review round
 * 171): it is written after the flush, from the same value `done`
 * resolves with. */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCallLog } from "../src/call-log.js";
import {
  cleanups as claudeCleanups,
  of,
  startSession as startClaude,
  waitFor,
} from "./helpers/session-e2e.js";
import {
  cleanupSessions as cleanupCodex,
  startSession as startCodex,
} from "./session-codex-e2e-helpers.js";
import {
  cleanups as agyCleanups,
  startSession as startAgy,
} from "./helpers/session-agy-e2e.js";
import {
  cleanups as opencodeCleanups,
  startSession as startOpencode,
} from "./helpers/session-opencode-e2e.js";
import {
  cleanups as aiderCleanups,
  startSession as startAider,
} from "./helpers/session-aider-e2e.js";

type Event = Record<string, any>;
type LineDriver = { handleCallerLine(line: string): void };

const send = (driver: LineDriver, message: unknown): void => {
  driver.handleCallerLine(JSON.stringify(message));
};

const triggerSignal = (driver: object): void => {
  (driver as unknown as { signals: { trigger(signal: NodeJS.Signals): void } })
    .signals.trigger("SIGTERM");
};

/** A sink that records every line like the helpers' default one and hands
 * the test the final `session_ended` write: `endArrived` resolves when the
 * flush reaches that line, and `release`/`reject` settle it. The release
 * must land inside awaitFinalFlush's one-second give-up, so every test
 * releases on the line after its trigger. */
interface HeldEnd {
  events: Event[];
  endArrived: Promise<void>;
  release(): void;
  reject(): void;
  sink: (line: string) => Promise<void> | void;
}

function heldEndSink(): HeldEnd {
  const events: Event[] = [];
  let sawEnd: () => void = () => {};
  let settle: () => void = () => {};
  let fail: (error: unknown) => void = () => {};
  const endArrived = new Promise<void>((resolve) => {
    sawEnd = resolve;
  });
  const held = new Promise<void>((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });
  const sink = (line: string): Promise<void> | void => {
    const event = JSON.parse(line) as Event;
    events.push(event);
    if (event.type === "session_ended") {
      sawEnd();
      return held;
    }
  };
  return {
    events,
    endArrived,
    release: () => settle(),
    reject: () => fail(new Error("the sink rejected during the final flush")),
    sink,
  };
}

// The ledger this process appends to, owned by this file for assertions.
const ledgerDir = mkdtempSync(join(tmpdir(), "codemux-end-flush-ledger-"));
const ledgerPath = join(ledgerDir, "calls.jsonl");
const previousLog = process.env.CODEMUX_CALL_LOG;
beforeAll(() => {
  process.env.CODEMUX_CALL_LOG = ledgerPath;
});

/** The exit code on the newest closing session line. */
const closingExitCode = (): number | null => {
  const sessions = readCallLog(ledgerPath).entries.filter((entry) => entry.record?.kind === "session");
  return sessions[sessions.length - 1]!.record!.exit_code;
};

afterAll(async () => {
  if (previousLog === undefined) delete process.env.CODEMUX_CALL_LOG;
  else process.env.CODEMUX_CALL_LOG = previousLog;
  rmSync(ledgerDir, { recursive: true, force: true });
  for (const clean of claudeCleanups.reverse()) await clean();
  await cleanupCodex();
  for (const clean of agyCleanups.reverse()) await clean();
  for (const clean of opencodeCleanups.reverse()) await clean();
  for (const clean of aiderCleanups.reverse()) await clean();
});

describe("the end flush cannot change the exit code the session reported", () => {
  test("claude: a signal during the final flush leaves the process code at the event's", async () => {
    const held = heldEndSink();
    const session = await startClaude({ sink: held.sink });
    send(session.driver, { type: "user", text: "scenario:wait open turn" });
    await waitFor(held.events, of("session_started"), "session_started");
    await waitFor(held.events, of("assistant_message"), "assistant_message");
    session.driver.handleCallerEnd();
    await held.endArrived;
    // The re-entry arm raises endExitCode to 143 here, after the event.
    triggerSignal(session.driver);
    held.release();
    const code = await session.code;
    const ended = held.events[held.events.length - 1] as Event;
    expect(ended.type).toBe("session_ended");
    expect(ended.reason).toBe("stdin-close");
    expect(ended.exit_code).toBe(0);
    expect(code).toBe(ended.exit_code);
    expect(closingExitCode()).toBe(code);
  }, 15_000);

  test("claude: a sink that rejects during the final flush fails the process nonzero", async () => {
    const held = heldEndSink();
    const session = await startClaude({ sink: held.sink });
    send(session.driver, { type: "user", text: "scenario:wait open turn" });
    await waitFor(held.events, of("session_started"), "session_started");
    await waitFor(held.events, of("assistant_message"), "assistant_message");
    session.driver.handleCallerEnd();
    await held.endArrived;
    held.reject();
    const code = await session.code;
    expect(code).toBeGreaterThanOrEqual(1);
    expect(closingExitCode()).toBe(code);
  }, 15_000);

  test("claude: a sink that throws on the final event fails the process and the ledger line alike", async () => {
    // The failure lands inside the enqueue, before any flush: the event
    // was built with exit code 0, the process ends nonzero, and the
    // closing ledger line must say what the process did.
    const events: Event[] = [];
    const session = await startClaude({
      sink: (line: string) => {
        const event = JSON.parse(line) as Event;
        events.push(event);
        if (event.type === "session_ended") throw new Error("the sink threw on the final event");
      },
    });
    send(session.driver, { type: "user", text: "scenario:wait open turn" });
    await waitFor(events, of("session_started"), "session_started");
    await waitFor(events, of("assistant_message"), "assistant_message");
    session.driver.handleCallerEnd();
    const code = await session.code;
    expect(code).toBeGreaterThanOrEqual(1);
    expect(closingExitCode()).toBe(code);
  }, 15_000);

  test("codex: a signal during the final flush leaves the process code at the event's", async () => {
    const held = heldEndSink();
    const session = await startCodex({ sink: held.sink });
    send(session.driver, { type: "user", text: "scenario:basic hello" });
    await waitFor(held.events, of("turn_completed"), "turn_completed");
    send(session.driver, { type: "shutdown" });
    await held.endArrived;
    triggerSignal(session.driver);
    held.release();
    const code = await session.code;
    const ended = held.events[held.events.length - 1] as Event;
    expect(ended.type).toBe("session_ended");
    expect(ended.reason).toBe("shutdown");
    expect(ended.exit_code).toBe(0);
    expect(code).toBe(ended.exit_code);
    expect(closingExitCode()).toBe(code);
  }, 15_000);

  test("codex: a sink that rejects during the final flush fails the process nonzero", async () => {
    const held = heldEndSink();
    const session = await startCodex({ sink: held.sink });
    send(session.driver, { type: "user", text: "scenario:basic hello" });
    await waitFor(held.events, of("turn_completed"), "turn_completed");
    send(session.driver, { type: "shutdown" });
    await held.endArrived;
    held.reject();
    const code = await session.code;
    expect(code).toBeGreaterThanOrEqual(1);
    expect(closingExitCode()).toBe(code);
  }, 15_000);

  test("agy: a signal during the final flush leaves the process code at the event's", async () => {
    const held = heldEndSink();
    const session = await startAgy({ sink: held.sink });
    send(session.driver, { type: "user", text: "scenario:basic hi" });
    await waitFor(held.events, of("turn_completed"), "turn_completed");
    send(session.driver, { type: "shutdown" });
    await held.endArrived;
    triggerSignal(session.driver);
    held.release();
    const code = await session.code;
    const ended = held.events[held.events.length - 1] as Event;
    expect(ended.type).toBe("session_ended");
    expect(ended.reason).toBe("shutdown");
    expect(ended.exit_code).toBe(0);
    expect(code).toBe(ended.exit_code);
    expect(closingExitCode()).toBe(code);
  }, 15_000);

  test("agy: a sink that rejects during the final flush fails the process nonzero", async () => {
    const held = heldEndSink();
    const session = await startAgy({ sink: held.sink });
    send(session.driver, { type: "user", text: "scenario:basic hi" });
    await waitFor(held.events, of("turn_completed"), "turn_completed");
    send(session.driver, { type: "shutdown" });
    await held.endArrived;
    held.reject();
    const code = await session.code;
    expect(code).toBeGreaterThanOrEqual(1);
    expect(closingExitCode()).toBe(code);
  }, 15_000);

  test("opencode: a signal during the final flush leaves the process code at the event's", async () => {
    const held = heldEndSink();
    const session = await startOpencode({ sink: held.sink });
    send(session.driver, { type: "user", text: "scenario:basic one" });
    await waitFor(held.events, of("turn_completed"), "turn_completed");
    send(session.driver, { type: "shutdown" });
    await held.endArrived;
    triggerSignal(session.driver);
    held.release();
    const code = await session.code;
    const ended = held.events[held.events.length - 1] as Event;
    expect(ended.type).toBe("session_ended");
    expect(ended.reason).toBe("shutdown");
    expect(ended.exit_code).toBe(0);
    expect(code).toBe(ended.exit_code);
    expect(closingExitCode()).toBe(code);
  }, 15_000);

  test("opencode: a sink that rejects during the final flush fails the process nonzero", async () => {
    const held = heldEndSink();
    const session = await startOpencode({ sink: held.sink });
    send(session.driver, { type: "user", text: "scenario:basic one" });
    await waitFor(held.events, of("turn_completed"), "turn_completed");
    send(session.driver, { type: "shutdown" });
    await held.endArrived;
    held.reject();
    const code = await session.code;
    expect(code).toBeGreaterThanOrEqual(1);
    expect(closingExitCode()).toBe(code);
  }, 15_000);

  test("aider: a signal during the final flush leaves the process code at the event's", async () => {
    const held = heldEndSink();
    // The persisting fake is what makes the drain end 0: the open turn's
    // exchange lands inside the grace and the child exits cleanly.
    const session = await startAider({ sink: held.sink }, { FAKE_SIGTERM_PERSIST: "1" });
    send(session.driver, { type: "user", text: "scenario:basic one" });
    await waitFor(held.events, of("turn_completed"), "turn_completed");
    send(session.driver, { type: "user", text: "scenario:wait two" });
    await waitFor(
      held.events,
      (events) => events.filter((event) => event.type === "turn_started")[1],
      "second turn_started"
    );
    send(session.driver, { type: "shutdown" });
    await held.endArrived;
    triggerSignal(session.driver);
    held.release();
    const code = await session.code;
    const ended = held.events[held.events.length - 1] as Event;
    expect(ended.type).toBe("session_ended");
    expect(ended.reason).toBe("shutdown");
    expect(ended.exit_code).toBe(0);
    expect(code).toBe(ended.exit_code);
    expect(closingExitCode()).toBe(code);
  }, 15_000);

  test("aider: a sink that rejects during the final flush fails the process nonzero", async () => {
    const held = heldEndSink();
    const session = await startAider({ sink: held.sink }, { FAKE_SIGTERM_PERSIST: "1" });
    send(session.driver, { type: "user", text: "scenario:basic one" });
    await waitFor(held.events, of("turn_completed"), "turn_completed");
    send(session.driver, { type: "user", text: "scenario:wait two" });
    await waitFor(
      held.events,
      (events) => events.filter((event) => event.type === "turn_started")[1],
      "second turn_started"
    );
    send(session.driver, { type: "shutdown" });
    await held.endArrived;
    held.reject();
    const code = await session.code;
    expect(code).toBeGreaterThanOrEqual(1);
    expect(closingExitCode()).toBe(code);
  }, 15_000);
});
