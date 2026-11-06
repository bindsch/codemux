/** The interactive-run wait, split from src/process-runner.ts (review
 * round 169): everything `guardedWait` needs lives here, and
 * src/process-runner.ts re-exports the function so its importers are
 * unchanged. */

import { signalProcess } from "./process-signal.js";
import {
  createTerminationTarget,
  waitForDescendantsGrace,
  type TerminationTarget,
} from "./process-tree.js";
import { FORCE_KILL_DELAY_MS, SIGNAL_EXIT_CODE, validateTimeout } from "./process-runner.js";

/** The window inside which three SIGINTs count as the burst that forces the
 * child's termination; exported for the tests that pace it. */
export const SIGNAL_BURST_WINDOW_MS = 1_000;
const TIMEOUT_EXIT_CODE = 124;

/**
 * SIGTERM now, SIGKILL after the grace period. `termScope` decides whether the
 * initial SIGTERM reaches the whole tree (non-interactive runs) or only the
 * child (interactive runs, which get the grace period to shut down their own
 * children). The SIGKILL escalation always covers the tree.
 */
function forceKillAfterGrace(
  target: TerminationTarget,
  termScope: "process" | "tree"
): ReturnType<typeof setTimeout> {
  signalProcess(target, "SIGTERM", termScope);
  return setTimeout(
    () => signalProcess(target, "SIGKILL", "tree"),
    FORCE_KILL_DELAY_MS
  );
}

/**
 * Wait for an interactive process the caller has not spawned yet,
 * shielding it from signals that would otherwise propagate through the
 * process group and kill grandchildren (e.g. a Playwright browser).
 *
 * The wait takes the spawn itself as a function and installs its three
 * signal handlers before calling it (review round 223), the order the
 * captured runner has used since round 169: until the first process.on
 * there is no handler at the operating-system level, so a SIGTERM or
 * SIGHUP that landed between the spawn and the installation took codemux's
 * default disposition and left the child and its sandbox running. A spawn
 * that throws removes the handlers again before the refusal propagates,
 * and no caller can pass a pre-spawned child, so the window cannot reopen.
 *
 * - SIGINT: swallowed in parent, because a terminal Ctrl-C reaches the
 *   foreground child through the shared process group too. It is never
 *   forwarded: a SIGINT sent to codemux alone (`kill -INT`) cannot be told
 *   apart from the terminal's inside a handler, and a forward would hand
 *   a second interrupt to every harness that keeps running after a
 *   terminal Ctrl-C, which several treat as "quit" (review round 211; the
 *   limit is documented in docs/cli.md). Rapid triple-SIGINT forces a
 *   SIGTERM to the child; from outside, SIGTERM or SIGHUP stops the run.
 * - SIGTERM/SIGHUP: forwarded to child only (a child-directed
 *   process.kill inside signalProcess), not broadcast, so
 *   the child gets the grace period to shut down its own children. The
 *   SIGKILL escalation after the grace period covers the whole process tree.
 * - Exit code: a timeout reports 124, a termination signal codemux received
 *   (SIGTERM, SIGHUP, or the burst escalation) reports 143 whatever the
 *   child then exited with -- the documented signal exit, so a child that
 *   answers the forwarded SIGTERM with 0 cannot read as a normal completion
 *   (round 211). Every other end reports the child's own exit code.
 */
export async function guardedWait(
  spawn: () => ReturnType<typeof Bun.spawn>,
  timeoutMs?: number
): Promise<number> {
  if (timeoutMs !== undefined) validateTimeout(timeoutMs);
  // Null until the spawn returned. No handler can run inside the
  // synchronous stretch that installs it and spawns, but the handler
  // checks anyway, so the type says what the code does (as in
  // process-runner.ts, review round 169).
  let target: TerminationTarget | null = null;
  let forceKillDeadline = 0;
  // True once a termination signal reached codemux (SIGTERM, SIGHUP, or the
  // burst escalation; a timeout arms the same path but 124 wins first):
  // the wait then reports 143 whatever the child exited with.
  let terminated = false;
  const armForceKill = (): void => {
    terminated = true;
    if (target === null || forceKillTimer !== null) return;
    forceKillTimer = forceKillAfterGrace(target, "process");
    // Measured from SIGTERM delivery, after the table read inside it, so a
    // slow enumeration cannot eat into the grace period.
    forceKillDeadline = performance.now() + FORCE_KILL_DELAY_MS;
  };
  let sigintCount = 0;
  let sigintTimer: ReturnType<typeof setTimeout> | null = null;
  let forceKillTimer: ReturnType<typeof setTimeout> | null = null;
  let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
  let timedOut = false;

  const onSigint = () => {
    sigintCount++;
    if (sigintCount >= 3) {
      armForceKill();
      return;
    }
    if (sigintTimer) clearTimeout(sigintTimer);
    sigintTimer = setTimeout(() => {
      sigintCount = 0;
    }, SIGNAL_BURST_WINDOW_MS);
  };
  const onSigterm = () => {
    armForceKill();
  };
  const onSighup = () => {
    armForceKill();
  };

  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);
  process.on("SIGHUP", onSighup);

  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = spawn();
  } catch (error) {
    // Nothing is running and no timer is armed: undo the handlers and let
    // the refusal propagate, the same undo the captured runner does when
    // its spawn throws.
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
    process.off("SIGHUP", onSighup);
    throw error;
  }
  target = createTerminationTarget(proc);

  if (timeoutMs !== undefined) {
    timeoutTimer = setTimeout(() => {
      timedOut = true;
      armForceKill();
    }, timeoutMs);
  }

  try {
    const exitCode = await proc.exited;
    return timedOut ? TIMEOUT_EXIT_CODE : terminated ? SIGNAL_EXIT_CODE : exitCode;
  } finally {
    if (sigintTimer) clearTimeout(sigintTimer);
    if (timeoutTimer) clearTimeout(timeoutTimer);
    if (forceKillTimer) {
      clearTimeout(forceKillTimer);
      // The child exited on SIGTERM before the grace period ran out, so the
      // scheduled tree-scoped SIGKILL was canceled with it. Its remembered
      // descendants keep the rest of the grace period, then get the SIGKILL
      // they were promised; otherwise they would outlive the run for good.
      // The signal listeners stay installed until this is done, so a second
      // Ctrl-C or SIGTERM in that window cannot kill codemux first. The
      // SIGKILL is unconditional: cheap when nothing is left, and the only
      // escalation there is when the table could not be read.
      await waitForDescendantsGrace(target, forceKillDeadline);
      signalProcess(target, "SIGKILL", "tree");
      // A Ctrl-C during that wait re-armed the burst timer; clear it again
      // so no pending timer keeps the event loop alive after we return.
      if (sigintTimer) clearTimeout(sigintTimer);
    }
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
    process.off("SIGHUP", onSighup);
  }
}
