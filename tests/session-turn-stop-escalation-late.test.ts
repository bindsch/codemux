/** The second-signal escalation reaches a turn child the end path holds
 * only in a local (review round 164): the turn-per-process drivers
 * (aider, opencode) do not assign a child that lands after a signal end
 * to `turnProc`, and the abandoned-spawn hold keeps its late child to
 * itself, so the driver's own snapshot of owned children cannot name
 * either. The escalation remembers every child an end path adopts, and
 * a second signal that arrives while such a child is still being stopped
 * kills its tree at once. Without that, a SIGTERM-trapping child keeps
 * the whole stop grace. Signals reach the drivers only through the
 * gate's `trigger`, never the test process. */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SessionProcess } from "../src/session/process.js";
import {
  cleanups as opencodeCleanups,
  of,
  send as sendOpencode,
  startSession as startOpencode,
  waitFor as waitForOpencode,
} from "./helpers/session-opencode-e2e.js";
import {
  cleanups as aiderCleanups,
  send as sendAider,
  startSession as startAider,
  waitFor as waitForAider,
} from "./helpers/session-aider-e2e.js";

/** Traps SIGTERM and holds past every deadline here: only a SIGKILL
 * ends it inside the test's window. */
const HOLD = fileURLToPath(new URL("./fixtures/live/fake-hold-then-exit.ts", import.meta.url));
const LONG_GRACE_MS = 30_000;

const ownCleanups: Array<() => Promise<void>> = [];

afterAll(async () => {
  for (const clean of ownCleanups.reverse()) await clean();
  for (const clean of opencodeCleanups.reverse()) await clean();
  for (const clean of aiderCleanups.reverse()) await clean();
});

const trigger = (driver: object): void =>
  (driver as unknown as { signals: { trigger(signal: NodeJS.Signals): void } })
    .signals.trigger("SIGTERM");

/** A turn spawn that stays in flight until `land()`: the child exists
 * and its SIGTERM trap is installed before the spawn resolves, so the
 * stop the end path sends on arrival cannot end it. */
function gatedHoldSpawn(): {
  spawnTurn: () => Promise<SessionProcess>;
  land(): void;
  child(): SessionProcess;
} {
  const dir = mkdtempSync(join(tmpdir(), "codemux-turn-hold-"));
  let land: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    land = resolve;
  });
  let proc: SessionProcess | null = null;
  const spawnTurn = async (): Promise<SessionProcess> => {
    let childReady: () => void = () => {};
    const ready = new Promise<void>((resolve) => {
      childReady = resolve;
    });
    proc = new SessionProcess({
      command: ["bun", HOLD],
      cwd: dir,
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: dir, FAKE_HOLD_MS: "60000" },
      // READY is not JSON and reaches no parser; it only says the trap
      // is installed.
      onLine: (line) => {
        if (line === "READY") childReady();
      },
      onFatal: () => {},
      graceMs: LONG_GRACE_MS,
    });
    const spawned = proc;
    ownCleanups.push(async () => {
      spawned.escalateStop();
      await spawned.settled;
    });
    await ready;
    await gate;
    return spawned;
  };
  return {
    spawnTurn,
    land,
    child: () => {
      if (proc === null) throw new Error("the turn spawn has not started");
      return proc;
    },
  };
}

/** The child's exit, or "alive" when it outlives the bound. */
async function exitWithin(proc: SessionProcess, ms: number): Promise<string> {
  const outcome = await Promise.race([proc.exited, Bun.sleep(ms).then(() => null)]);
  return outcome === null ? "alive" : String(outcome.signal ?? outcome.code);
}

interface Rig {
  driver: object;
  events: Array<Record<string, any>>;
  code: Promise<number>;
  ended(): Promise<Record<string, any>>;
}

async function start(
  agent: "opencode" | "aider",
  spawnTurn: () => Promise<SessionProcess>,
  spawnGraceMs: number
): Promise<Rig> {
  if (agent === "opencode") {
    const session = await startOpencode({ spawnTurn, spawnGraceMs });
    sendOpencode(session.driver, { type: "user", text: "hold this turn" });
    await waitForOpencode(session.events, of("turn_started"), "turn_started");
    return {
      driver: session.driver,
      events: session.events,
      code: session.code,
      ended: () => waitForOpencode(session.events, of("session_ended"), "session_ended"),
    };
  }
  const session = await startAider({ spawnTurn, spawnGraceMs });
  sendAider(session.driver, { type: "user", text: "hold this turn" });
  await waitForAider(session.events, of("turn_started"), "turn_started");
  return {
    driver: session.driver,
    events: session.events,
    code: session.code,
    ended: () => waitForAider(session.events, of("session_ended"), "session_ended"),
  };
}

describe("second-signal escalation - a turn child the end path holds locally (review round 164)", () => {
  for (const agent of ["opencode", "aider"] as const) {
    test(`${agent}: a second signal after the late child landed kills it at once`, async () => {
      const spawn = gatedHoldSpawn();
      const rig = await start(agent, spawn.spawnTurn, 8_000);
      // First signal while the spawn is in flight: the end waits for it.
      trigger(rig.driver);
      spawn.land();
      // The end path adopted the child and sent the stop it traps.
      expect(await exitWithin(spawn.child(), 300)).toBe("alive");
      const startedAt = Date.now();
      trigger(rig.driver);
      const ended = await rig.ended();
      expect(Date.now() - startedAt).toBeLessThan(5_000);
      expect(ended.harness_exit).toEqual({ code: null, signal: "SIGKILL" });
      expect(ended.exit_code).toBe(143);
      expect(await rig.code).toBe(143);
      expect(rig.events.filter((event) => event.type === "session_ended")).toHaveLength(1);
    }, 20_000);

    test(`${agent}: a second signal reaches a child the abandoned-spawn hold is stopping`, async () => {
      const spawn = gatedHoldSpawn();
      const rig = await start(agent, spawn.spawnTurn, 1_500);
      // First signal: the end waits out the spawn grace, gives up on the
      // spawn, and ends the session; the hold keeps waiting for a child.
      trigger(rig.driver);
      const ended = await rig.ended();
      expect(ended.exit_code).toBe(143);
      expect(await rig.code).toBe(143);
      // The child lands inside the hold's own window and traps the stop.
      spawn.land();
      expect(await exitWithin(spawn.child(), 300)).toBe("alive");
      trigger(rig.driver);
      expect(await exitWithin(spawn.child(), 5_000)).toBe("SIGKILL");
    }, 20_000);
  }
});
