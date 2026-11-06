/**
 * The bounded wait a turn-per-process end path holds on an in-flight
 * turn spawn, and the hold it leaves behind when the wait runs out
 * (review round 110). The opencode and aider end paths await their
 * open turn's spawn inside finish; a spawn whose closure stalls — a
 * probe that never answers — must not stretch that wait past the
 * operator's stop grace: session_ended, the registry release, and
 * run() all land inside it, and the late child is the hold's to stop.
 * Kimi's driver abandons its spawn on every killing end instead
 * (turn-per-process.ts's divergence note); these two drivers bound the
 * wait for every end, the graceful ends included — clearTimers already
 * disarmed the turn timeout inside finish, so the stop grace is the
 * only bound left.
 */

import type { SessionProcess } from "./process.js";
import type { SessionEndReason } from "./agy-driver.js";
import type { SessionStopEscalation } from "./stop-escalation.js";

/** What a bounded spawn wait found (review round 110). */
export type BoundedSpawnWait =
  | { kind: "landed"; child: SessionProcess }
  | { kind: "rejected"; error: unknown }
  | { kind: "expired" };

/** Race an in-flight turn spawn against the stop grace (review round
 * 110): the child when it lands, the error when the spawn fails, or
 * `expired` once the grace runs out with the spawn still silent. The
 * timer never outlives the answer it lost to. */
export function awaitSpawnWithGrace(
  spawn: Promise<SessionProcess>,
  graceMs: number
): Promise<BoundedSpawnWait> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ kind: "expired" }), graceMs);
    spawn.then(
      (child) => {
        clearTimeout(timer);
        resolve({ kind: "landed", child });
      },
      (error) => {
        clearTimeout(timer);
        resolve({ kind: "rejected", error });
      }
    );
  });
}

/** The hold an end path leaves on a spawn it gave up waiting for
 * (review round 110): a child that lands afterwards is stopped and its
 * tree settled; a rejection is absorbed (the expiry already reported
 * it). A spawn that stays silent past a second application of the
 * grace is given up on: the alternative is a CLI that never exits.
 * Giving up is safe because the drivers hand their abandonment flag to
 * the spawn itself (spawnSessionChild's `abandoned`, review round 111):
 * a spawn that leaves its probe after the flag is set rejects instead of
 * creating a process, so nothing can start against state the CLI's
 * cleanup already removed. The continuation stays attached as the second
 * line for a child created before the flag was set. A child that lands
 * before the grace runs out wins over the timer: the hold waits for its
 * full settle. */
export function holdAbandonedSpawn(
  spawn: Promise<SessionProcess>,
  graceMs: number,
  escalation?: SessionStopEscalation
): Promise<void> {
  return new Promise((resolve) => {
    let landed = false;
    const timer = setTimeout(() => {
      if (!landed) resolve();
    }, graceMs);
    spawn.then(
      async (child) => {
        landed = true;
        // A second signal latched while the hold ran: the late child
        // gets the tree SIGKILL on arrival, not the stop with grace
        // (review round 162, finding 2; kimi's rule, round al31).
        if (escalation === undefined || !escalation.escalateIfRequested(child)) {
          child.requestStop();
        }
        try {
          await child.settled;
          await child.exited;
        } catch {
          // The child is gone, which is all the hold asserts.
        }
        clearTimeout(timer);
        resolve();
      },
      () => {
        clearTimeout(timer);
        resolve();
      }
    );
  });
}

/** The finished-arm verdict for a turn child that landed after the end
 * path began (the startTurn race): a graceful end still intends to run
 * it (review D11) — unless the end path has already given up on the
 * spawn (review round 110), when nothing is left that would run it. */
export function lateChildRuns(
  endReason: SessionEndReason | null,
  spawnAbandoned: boolean
): boolean {
  return (
    !spawnAbandoned &&
    (endReason === "stdin-close" || endReason === "shutdown")
  );
}
