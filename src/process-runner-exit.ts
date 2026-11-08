/**
 * The runner's termination timing constants, the signal exit code, and
 * the exit tail a signaled run takes — split from process-runner.ts at
 * the 500-line cap (review round 401, item 2). process-runner.ts
 * re-exports the constants, so every existing import path is unchanged.
 */
import { finishSignaledRun } from "./process-runner-signals.js";

export const FORCE_KILL_DELAY_MS = 2_000;
// After a timeout's SIGKILL escalation, how much longer to keep reading the
// captured pipes before abandoning them. A descendant no signal can reach
// (orphaned into another process group before the first snapshot) may hold
// them open forever; the run must still return.
export const PIPE_GIVE_UP_MS = 1_000;
/**
 * How long the experiment bridge's close() waits for finalization before
 * abandoning it (review round 331, item 18). Strictly longer than
 * finalization's own bounds, so the abandonment never replaces a real
 * outcome: the server's close drains for FORCE_KILL_DELAY_MS +
 * PIPE_GIVE_UP_MS, the inventory recheck waits PIPE_GIVE_UP_MS more, and
 * one PIPE_GIVE_UP_MS is margin (review round 334: an equal bound raced
 * the server's shutdown and won).
 */
export const BRIDGE_CLOSE_ABANDON_MS = FORCE_KILL_DELAY_MS + 3 * PIPE_GIVE_UP_MS;
// What a signaled run's cleanup can take once the signal has landed (the
// force-kill delay, the pipe give-up, the protocol cleanup's grace, and
// the interruption receipt's grace), plus a second of margin so a peer
// that used every deadline still runs its last continuation first.
export const SIGNALED_PEER_WAIT_MS = FORCE_KILL_DELAY_MS + PIPE_GIVE_UP_MS + 2 * FORCE_KILL_DELAY_MS + 1_000;
// 128 + SIGTERM: the child tree was terminated after a signal to codemux.
export const SIGNAL_EXIT_CODE = 143;

/** The exit tail every signaled run takes (review rounds 171 and 174):
 * the last signaled run to finish prints the line and exits; an earlier
 * one still waits no longer than the peer bound and then exits itself, so
 * nothing a peer does can hold codemux open after a signal. The caller
 * passes its own cleanup note and the peer bound; the run returns to no
 * caller either way. */
export async function exitSignaledRun(options: {
  cleanupNote?: string;
  peerWaitMs: number;
}): Promise<never> {
  // The signal meant "stop codemux", not "skip this step": an interrupted
  // version probe must not fall through to the launch. The launch's
  // receipt is written first: recordCompletedLaunch never runs.
  if (options.cleanupNote) console.error(`Note: ${options.cleanupNote}`);
  if (!finishSignaledRun()) await Bun.sleep(options.peerWaitMs);
  console.error("codemux: interrupted; the agent's process tree was terminated");
  process.exit(SIGNAL_EXIT_CODE);
}
