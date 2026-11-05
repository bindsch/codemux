/**
 * Kimi lifecycle interleavings, the pair matrix: every ordered pair of
 * end, spawn, and exit events from a spawning and a running session,
 * asserting the end invariants (exactly one session_ended, the first
 * cause's reason, the raised code, no unconfirmed success, the record
 * release) for every ordering. Split from tests/session-kimi-interleavings.
 * test.ts; the rig is tests/helpers/session-kimi-interleavings.ts.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { SESSION_SIGNAL_EXIT_CODE } from "../src/session/process.js";
import {
  armSignalSwallow,
  drainRig,
  FakeTurnProcess,
  finish,
  ID,
  inject,
  type Injection,
  recordEnded,
  send,
  startRig,
  until,
} from "./helpers/session-kimi-interleavings.js";

armSignalSwallow();
afterAll(drainRig);

/** The code an event contributes as a cause: its own when it is the
 * FIRST cause (stdin_eof included — a clean close is a cause at 0), and
 * the same value as a later one, for the code is the MAX over the end
 * path's causes (turn-per-process.ts, invariant 3). Events not listed
 * are never causes of their own. The exits are context-dependent: a
 * child's death during a graceful end's drain is a cause (the
 * external-death diagnostics), while the same death in a live session
 * is the turn's own verdict and costs the code nothing — and after a
 * killing end the child is already dead, suppressed at a code at least
 * its own. `spawn_fail` after a killing end is the abandoned spawn,
 * recorded nowhere, at a code already at least its 1. */
const CAUSE_CODE: Partial<Record<Injection, number>> = {
  stdin_eof: 0,
  signal: SESSION_SIGNAL_EXIT_CODE,
  session_timeout: 1,
  fatal: 1,
  spawn_fail: 1,
  exit_143: 1,
  exit_crash: 1,
};

/** The pair's expected process exit code: the first cause's floor,
 * raised by every later cause the end path meets. The rig's delivery
 * rule is part of the expectation: a killing first end resolves done
 * before the second injection runs (its guard sees session_ended, or
 * the event lands in an ended machine and is ignored), so only a
 * graceful first end — still draining — actually meets the second
 * event. Only the caller-driven stdin close is graceful: a signal is a
 * killing end too (review round 96, whole tree), and its 143 dominates
 * every later cause's code, so the numeric expectations do not change. */
function expectedCode(pair: readonly Injection[]): number {
  let code: number | null = null;
  let gracefulEndOpen = false;
  for (const event of pair) {
    if (code === null) {
      // No end owns yet: the first event that is a cause fixes the
      // floor. A live child's death is not one — it completes the turn.
      if (event === "exit_143" || event === "exit_crash" || event === "exit_normal") continue;
      const first = CAUSE_CODE[event];
      if (first === undefined) continue; // spawn_ok
      code = first;
      gracefulEndOpen = event === "stdin_eof";
      continue;
    }
    if (!gracefulEndOpen) continue; // done already resolved; nothing delivered
    // A graceful drain is open: a clean close is the end already
    // running, a landed child's plain exit 0 completes the drained turn;
    // every other cause here is delivered and raises the code.
    if (event === "stdin_eof" || event === "spawn_ok" || event === "exit_normal") continue;
    code = Math.max(code, CAUSE_CODE[event] ?? 0);
  }
  // No event of the pair ended the session: the finisher's clean close
  // is the first cause.
  return code ?? 0;
}

/** The reason an event spells as the FIRST cause — the reason the
 * session_ended event carries, fixed forever by whichever cause landed
 * first (invariant 2). Events not listed are never causes of their own
 * (the exits complete the turn they belong to; spawn_ok lands a child),
 * and a pair with no cause at all ends through the finisher's clean
 * stdin close. The matrix asserts this for every ordering (round al37,
 * contracts item 5): a second cause may raise the code, never the
 * reason. */
const CAUSE_REASON: Partial<Record<Injection, string>> = {
  stdin_eof: "stdin-close",
  signal: "signal",
  session_timeout: "timeout",
  fatal: "crash",
  spawn_fail: "crash",
};

function expectedReason(pair: readonly Injection[]): string {
  for (const event of pair) {
    const reason = CAUSE_REASON[event];
    if (reason !== undefined) return reason;
  }
  return "stdin-close";
}
// --- the matrix --------------------------------------------------------------

const END_EVENTS = ["stdin_eof", "signal", "session_timeout", "fatal"] as const;
const SPAWN_EVENTS = ["spawn_ok", "spawn_fail"] as const;
const EXIT_EVENTS = ["exit_normal", "exit_143", "exit_crash"] as const;

interface Scenario {
  start: "spawning" | "running";
  first: Injection;
  second: Injection;
}

const scenarios: Scenario[] = [];
// From spawning: end events and spawn resolutions, both orders, minus the
// pair of two spawn resolutions (one spawn resolves once); a spawn that
// lands first is followed by the child's exits too, for the running half
// of its own ladder.
const spawningEvents: Injection[] = [...END_EVENTS, ...SPAWN_EVENTS];
for (const first of spawningEvents) {
  for (const second of spawningEvents) {
    if (first === second) continue;
    if (
      (SPAWN_EVENTS as readonly string[]).includes(first) &&
      (SPAWN_EVENTS as readonly string[]).includes(second)
    ) {
      continue;
    }
    scenarios.push({ start: "spawning", first, second });
  }
}
for (const second of EXIT_EVENTS) {
  scenarios.push({ start: "spawning", first: "spawn_ok", second });
}
// From running: end events and the child's exits, both orders.
const runningEvents: Injection[] = [...END_EVENTS, ...EXIT_EVENTS];
for (const first of runningEvents) {
  for (const second of runningEvents) {
    if (first === second) continue;
    scenarios.push({ start: "running", first, second });
  }
}

describe("kimi session interleavings (round al28)", () => {
  for (const { start, first, second } of scenarios) {
    test(`${start}: ${first} then ${second}`, async () => {
      const timer =
        first === "session_timeout" ? 60 : second === "session_timeout" ? 300 : null;
      const rig = await startRig(timer);
      send(rig, "pair scenario");
      if (start === "running") {
        const child = new FakeTurnProcess();
        rig.children.push(child);
        rig.spawn.settle(child);
        await Bun.sleep(5);
      }
      await inject(rig, first);
      await inject(rig, second);
      await finish(rig);

      // Invariant 1: exactly one session_ended.
      const endings = rig.events.filter((event) => event.type === "session_ended");
      expect(endings).toHaveLength(1);
      // Invariant 2's reason half (round al37, contracts item 5): the
      // reason is the FIRST cause's, asserted for every ordering — a
      // later cause may raise the code, never the reason.
      const outcome = endings[0]!.harness_exit;
      const failedChild = outcome !== null && (outcome.code !== 0 || outcome.signal !== null);
      expect(endings[0]!.reason).toBe(failedChild ? "harness_failed" : expectedReason([first, second]));
      // Invariant 2: the reason is the first cause's and the exit code
      // is the end path's summary — the floor raised by every later
      // cause it met.
      expect(await rig.code).toBe(Math.max(expectedCode([first, second]), failedChild ? 1 : 0));
      // Invariant 3: no unconfirmed turn ever read success.
      for (const completed of rig.events.filter(
        (event) => event.type === "turn_completed"
      )) {
        expect(["failed", "interrupted"]).toContain(completed.finish);
      }
      // Invariant 2's ended half: nothing is accepted past the end. The
      // late input, a late resume hint (it would adopt and confirm — a
      // meta line naming the known id, the exact shape the parser maps),
      // and a late close all leave the stream untouched.
      const before = rig.events.length;
      rig.driver.handleCallerLine(JSON.stringify({ type: "user", text: "late" }));
      rig.driver.handleHarnessLine(
        `{"role":"meta","type":"session.resume_hint","session_id":"${ID}","command":"kimi -r ${ID}","content":"To resume this session: kimi -r ${ID}"}`
      );
      rig.driver.handleCallerEnd();
      await Bun.sleep(20);
      expect(rig.events.length).toBe(before);
      // Invariant 4: the record releases only once no child can exist.
      await until("the registry release", () => recordEnded(rig) != null);
      for (const child of rig.children) {
        expect(child.alive).toBe(false);
      }
    }, 15_000);
  }
});
