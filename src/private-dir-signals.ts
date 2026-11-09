/**
 * The one shared signal machinery for private per-run directories: codex
 * hermetic homes (src/hermetic-home.ts) and Claude project-settings config
 * directories (src/claude-project-config.ts) register their finalizers
 * here, so the two never install competing handlers.
 *
 * The dispatch is the only signal-only code: `onSignal` and the handler
 * arrows `trackPrivateDir` installs run from a real signal, which ends the
 * test process. That is why this module, and nothing larger, is waived
 * from the per-file coverage floor (scripts/check-source-coverage.ts,
 * docs/TESTING.md); the register and unregister functions around it are
 * ordinary covered code.
 */

import { hasActiveSignalOwner } from "./process-runner.js";

// Private directories not yet finalized. One set of signal handlers exists
// while this is non-empty: between creating a directory and spawning the
// run (the scode version probe sits there) nothing else handles a signal.
// While the run's command is in flight, the process runner owns the signal
// instead: it terminates the tree, then exits, and the exit event
// finalizes the directories.
const liveHomes = new Set<() => void>();
const SIGNALS = [["SIGINT", 130], ["SIGTERM", 143], ["SIGHUP", 129]] as const;
const signalHandlers = new Map<NodeJS.Signals, () => void>();

function onSignal(code: number): void {
  if (hasActiveSignalOwner()) return;
  for (const finalize of [...liveHomes]) finalize();
  process.exit(code);
}

/** Registers a private per-run directory's finalize with the one shared
 * signal machinery, so codex hermetic homes and Claude project-settings
 * config directories never install competing handlers. */
export function trackPrivateDir(finalize: () => void): void {
  liveHomes.add(finalize);
  if (signalHandlers.size > 0) return;
  for (const [signal, code] of SIGNALS) {
    const handler = (): void => onSignal(code);
    signalHandlers.set(signal, handler);
    process.on(signal, handler);
  }
}

/** Drops a finalize from the shared machinery, removing the handlers when
 * the last live directory went away. */
export function untrackPrivateDir(finalize: () => void): void {
  liveHomes.delete(finalize);
  if (liveHomes.size > 0) return;
  for (const [signal, handler] of signalHandlers) process.off(signal, handler);
  signalHandlers.clear();
}
