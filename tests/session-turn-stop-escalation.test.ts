/** The second-signal escalation over the turn-per-process drivers
 * (review round 162, finding 2): aider and opencode share
 * src/session/stop-escalation.ts with the long-lived drivers
 * (tests/session-stop-escalation.test.ts) and add two windows of their
 * own — the turn child a signal end must stop, and the turn's spawn
 * still in flight when the second signal latches (the late child is
 * SIGKILLed on arrival, never drained or run). Signals reach the
 * drivers only through the gate's `trigger`, never the test process. */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SessionProcess } from "../src/session/process.js";
import type { OpenCodeDriverOptions } from "../src/session/opencode-driver.js";
import {
  cleanups as opencodeCleanups,
  of,
  send as sendOpencode,
  startSession as startOpencode,
  waitFor as waitForOpencode,
  type Event as OpencodeEvent,
} from "./helpers/session-opencode-e2e.js";
import {
  cleanups as aiderCleanups,
  fakeRecord,
  send as sendAider,
  startSession as startAider,
  waitFor as waitForAider,
  type Event as AiderEvent,
  type Session as AiderSession,
} from "./helpers/session-aider-e2e.js";

/** A session child that traps SIGTERM and outlives it (the fake-hold-
 * then-exit fixture with a hold past every deadline): only the
 * escalation's tree SIGKILL ends it. */
const HOLD = fileURLToPath(new URL("./fixtures/live/fake-hold-then-exit.ts", import.meta.url));

/** The stop grace every child here runs with: long enough that a
 * regression to the graceful stop alone cannot end the session inside
 * the test's window — only the escalation can. */
const LONG_GRACE_MS = 30_000;

afterAll(async () => {
  for (const clean of opencodeCleanups.reverse()) await clean();
  for (const clean of aiderCleanups.reverse()) await clean();
});

/** Deliver one signal the way a real one arrives, through the gate. */
const trigger = (driver: object): void =>
  (driver as unknown as { signals: { trigger(signal: NodeJS.Signals): void } })
    .signals.trigger("SIGTERM");

/** Wait until the aider fake recorded `name` once: the turn child's
 * argv record implies its SIGTERM trap is installed (the fake installs
 * the handler before it records). */
async function waitRecorded(
  session: AiderSession,
  name: string,
  timeoutMs = 8_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (fakeRecord(session, name).length === 0) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${name}`);
    await Bun.sleep(10);
  }
}

/** The opencode rig's spawnTurn replaced with one that spawns the
 * SIGTERM-trapping child (its READY line never reaches the driver —
 * non-JSON output is a tier-3 fatal for the opencode parser). */
function holdSpawn(): {
  spawnTurn: OpenCodeDriverOptions["spawnTurn"];
  ready: Promise<void>;
} {
  const dir = mkdtempSync(join(tmpdir(), "codemux-opencode-hold-"));
  let childReady: () => void = () => {};
  const ready = new Promise<void>((resolve) => {
    childReady = resolve;
  });
  const spawned: SessionProcess[] = [];
  const spawnTurn: OpenCodeDriverOptions["spawnTurn"] = async () => {
    const proc = new SessionProcess({
      command: ["bun", HOLD],
      cwd: dir,
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: dir,
        FAKE_HOLD_MS: "60000",
      },
      onLine: (line) => {
        if (line === "READY") childReady();
      },
      onFatal: () => {},
      graceMs: LONG_GRACE_MS,
    });
    spawned.push(proc);
    return proc;
  };
  opencodeCleanups.push(async () => {
    for (const proc of spawned) {
      proc.requestStop();
      await proc.settled;
    }
  });
  return { spawnTurn, ready };
}

describe("second-signal escalation - turn-per-process drivers (review round 162)", () => {
  test("opencode: the second signal ends the session at once with the turn child's tree killed", async () => {
    const { spawnTurn, ready } = holdSpawn();
    const session = await startOpencode({ spawnTurn });
    sendOpencode(session.driver, { type: "user", text: "hold this turn" });
    await waitForOpencode(session.events, of("turn_started"), "turn_started");
    await ready; // the child can already survive SIGTERM
    // First signal: the killing end stops the turn child — SIGTERM,
    // which it traps, holding the settle window open.
    trigger(session.driver);
    await Bun.sleep(50);
    // Second signal: the tree SIGKILL, not the 30 s graceful stop.
    const startedAt = Date.now();
    trigger(session.driver);
    const ended = await waitForOpencode(
      session.events,
      of("session_ended"),
      "session_ended"
    );
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expect(
      session.events.filter((event: OpencodeEvent) => event.type === "session_ended")
    ).toHaveLength(1);
    expect(ended.reason).toBe("harness_failed");
    expect(ended.exit_code).toBe(143);
    expect(ended.resumable).toBe(false);
    expect(await session.code).toBe(143);
    expect(ended.harness_exit).toEqual({ code: null, signal: "SIGKILL" });
    const completed = session.events.find(
      (event: OpencodeEvent) => event.type === "turn_completed"
    ) as OpencodeEvent;
    expect(completed.finish).toBe("failed");
  }, 15_000);

  test("opencode: a second signal with no child alive is a no-op", async () => {
    const session = await startOpencode();
    // No turn ever ran, so no child exists: the first signal ends the
    // idle session, the second has nothing to kill and must only latch.
    trigger(session.driver);
    trigger(session.driver);
    const ended = await waitForOpencode(
      session.events,
      of("session_ended"),
      "session_ended"
    );
    expect(
      session.events.filter((event: OpencodeEvent) => event.type === "session_ended")
    ).toHaveLength(1);
    expect(ended.reason).toBe("signal");
    expect(await session.code).toBe(143);
  }, 15_000);

  test("opencode: a second signal while the turn's spawn is still pending kills the child on arrival", async () => {
    // The latch window (kimi's al31 rule): the second signal flies while
    // no child exists — the turn's spawn is held in flight — so the
    // snapshot has nothing to kill. The child that lands afterwards gets
    // the tree SIGKILL on arrival: never the prompt, never the drain.
    let openGate: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    const { spawnTurn } = holdSpawn();
    const session = await startOpencode(
      { spawnTurn, spawnGraceMs: 8_000 },
      {},
      0,
      gate
    );
    sendOpencode(session.driver, { type: "user", text: "hold this turn" });
    await waitForOpencode(session.events, of("turn_started"), "turn_started");
    trigger(session.driver);
    trigger(session.driver);
    await Bun.sleep(50); // the latch is taken while no child exists
    const startedAt = Date.now();
    openGate();
    const ended = await waitForOpencode(
      session.events,
      of("session_ended"),
      "session_ended"
    );
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expect(ended.harness_exit).toEqual({ code: null, signal: "SIGKILL" });
    expect(ended.exit_code).toBe(143);
    expect(await session.code).toBe(143);
  }, 15_000);

  test("aider: the second signal ends the session at once with the turn child's tree killed", async () => {
    // FAKE_SIGTERM_PERSIST=hold: the turn child (the wait scenario —
    // its user block is on disk, its reply never comes) traps the stop
    // SIGTERM and only a tree SIGKILL ends it.
    const session = await startAider(
      {},
      { FAKE_SIGTERM_PERSIST: "hold" },
      undefined,
      0,
      LONG_GRACE_MS
    );
    sendAider(session.driver, { type: "user", text: "scenario:wait one" });
    await waitForAider(session.events, of("turn_started"), "turn_started");
    await waitRecorded(session, "argv.jsonl"); // the trap is up
    trigger(session.driver);
    await Bun.sleep(50);
    const startedAt = Date.now();
    trigger(session.driver);
    const ended = await waitForAider(session.events, of("session_ended"), "session_ended");
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expect(
      session.events.filter((event: AiderEvent) => event.type === "session_ended")
    ).toHaveLength(1);
    expect(ended.reason).toBe("harness_failed");
    expect(ended.exit_code).toBe(143);
    expect(ended.resumable).toBe(false);
    expect(await session.code).toBe(143);
    expect(ended.harness_exit).toEqual({ code: null, signal: "SIGKILL" });
    // The half-written history the kill leaves: the user block, no reply.
    const history = readFileSync(session.historyPath, "utf8");
    expect(history).toContain("#### scenario:wait one");
    expect(history).not.toContain("Done:");
  }, 15_000);

  test("aider: a second signal with no child alive is a no-op", async () => {
    const session = await startAider();
    trigger(session.driver);
    trigger(session.driver);
    const ended = await waitForAider(session.events, of("session_ended"), "session_ended");
    expect(
      session.events.filter((event: AiderEvent) => event.type === "session_ended")
    ).toHaveLength(1);
    expect(ended.reason).toBe("signal");
    expect(await session.code).toBe(143);
  }, 15_000);

  test("aider: a second signal while the turn's spawn is still pending kills the child on arrival", async () => {
    // The latch window again, over the aider end path's own late arm:
    // the escalated child is never fed its stdin negatives and never
    // runs its turn — the kill is the whole encounter.
    let openGate: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    const session = await startAider(
      { spawnGraceMs: 8_000 },
      {},
      undefined,
      0,
      500,
      gate
    );
    sendAider(session.driver, { type: "user", text: "scenario:wait one" });
    await waitForAider(session.events, of("turn_started"), "turn_started");
    trigger(session.driver);
    trigger(session.driver);
    await Bun.sleep(50);
    const startedAt = Date.now();
    openGate();
    const ended = await waitForAider(session.events, of("session_ended"), "session_ended");
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expect(ended.harness_exit).toEqual({ code: null, signal: "SIGKILL" });
    expect(ended.exit_code).toBe(143);
    expect(await session.code).toBe(143);
    // The child was killed before its turn ran: the history holds no
    // part of the exchange (the wait scenario writes its user block
    // only once the process answers its first stdin read).
    expect(readFileSync(session.historyPath, "utf8")).not.toContain("scenario:wait one");
  }, 15_000);
});
