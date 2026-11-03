// Process-wide signal-listener bookkeeping for suites that build in-process
// session drivers. A driver's constructor installs SIGINT/SIGTERM/SIGHUP
// handlers; a test that ends without disposing its driver leaves them behind,
// and a later synthetic signal in another test would then end the whole test
// process. Moved from tests/helpers/hermetic-codex.ts (review round 4,
// session finding 8) so session suites need not import codex-home helpers.
import { afterEach, beforeEach, expect } from "bun:test";

const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
/** Listener identity only: the set is compared by reference. */
export type SignalListener = unknown;
/** Every process-wide signal listener, by reference. A test compares the
 * set before and after (a beforeEach baseline), never a count taken at
 * import: other files in the same test process install and dispose
 * session drivers on their own schedule, and a count would move with
 * them. */
export const signalListeners = (): Set<SignalListener> =>
  new Set<SignalListener>(SIGNALS.flatMap((signal) => process.listeners(signal)));
/** The listeners installed since `before` and still present: the handlers
 * a driver under test left behind. */
export const newSignalListeners = (before: Set<SignalListener>): number =>
  [...signalListeners()].filter((listener) => !before.has(listener)).length;
/** Waits until every listener installed since `before` is gone, or the
 * deadline, and returns what remains. A kimi driver keeps its handlers
 * past dispose while an abandoned spawn hold settles (by design, round
 * al30) and drops them a moment later; suites that end such holds assert
 * through this wait instead of an immediate count. */
export const awaitSignalsDropped = async (before: Set<SignalListener>, timeoutMs = 5_000): Promise<number> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const remaining = newSignalListeners(before);
    if (remaining === 0 || Date.now() >= deadline) return remaining;
    await Bun.sleep(20);
  }
};

/** The suite-standard signal hygiene (review round 4, session finding 8):
 * a beforeEach baseline, then an afterEach that ends every session the
 * test built (`drainSince(mark)`, with `markNow()` captured in the same
 * beforeEach) and asserts no listener installed during the test survived
 * it. `settleMs` lets a kimi driver's abandoned-spawn hold finish
 * dropping its handlers; the returned `exemptNeverSettlingHold` marks a
 * test whose hold never settles by design, where the driver's own three
 * handlers (one per signal) are required to remain. */
export function registerNoLeakedSignals(
  drainSince?: (mark: number) => Promise<void> | void,
  markNow: () => number = () => 0,
  options: { settleMs?: number } = {}
): { exemptNeverSettlingHold: () => void } {
  let baseline = signalListeners();
  let mark = 0;
  let exempt = false;
  beforeEach(() => {
    baseline = signalListeners();
    mark = markNow();
  });
  afterEach(async () => {
    if (drainSince !== undefined) await drainSince(mark);
    const remaining = exempt
      ? newSignalListeners(baseline)
      : await awaitSignalsDropped(baseline, options.settleMs ?? 0);
    expect(remaining).toBe(exempt ? 3 : 0);
    exempt = false;
  });
  return { exemptNeverSettlingHold: () => { exempt = true; } };
}
