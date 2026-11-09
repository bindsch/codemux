/** The captured-command signal bookkeeping, split from
 * src/process-runner.ts (review round 169): the count of captured commands
 * in flight and the coordination that decides which signaled command exits
 * the process. The runner owns the handlers; this file owns the numbers. */

// Captured commands in flight. While one runs, its own signal handlers own
// the shutdown (terminate the tree, then exit); outside that window, other
// exit-time cleanup (a hermetic home) has to handle a signal itself.
let activeCapturedCommands = 0;

export function hasActiveCapturedCommand(): boolean {
  return activeCapturedCommands > 0;
}

// Interactive waits in flight (guardedWait). Each owns SIGINT, SIGTERM and
// SIGHUP while its child runs: it swallows a terminal Ctrl-C and forwards
// a termination signal to the child. The private-directory handlers must
// defer to it as they do to a captured command, or a single Ctrl-C in a
// TUI with a private directory exits codemux under the running child.
let activeGuardedWaits = 0;

export function beginGuardedWait(): void { activeGuardedWaits++; }
export function endGuardedWait(): void { activeGuardedWaits--; }

/** True while a captured command or an interactive wait owns the signals;
 * exit-time cleanup handlers then leave the signal to that owner. */
export function hasActiveSignalOwner(): boolean {
  return activeCapturedCommands > 0 || activeGuardedWaits > 0;
}

// The signal handler of every captured command in flight. A signal's
// dispatch runs the listeners that were registered when it began, so a
// command started by an earlier listener of the same dispatch has its
// own listener installed too late to hear it. The first handler to run
// signals every command registered here, that one included.
const activeSignalHandlers = new Set<() => void>();

/** Counted and registered before the child is spawned and until the run's
 * cleanup has finished, so no window exists in which a signal has neither
 * the runner's handler nor the private-directory handlers (review round
 * 169). `onSignal` must be idempotent. */
export function beginCapturedCommand(onSignal: () => void): void {
  activeCapturedCommands++;
  activeSignalHandlers.add(onSignal);
}

/** The exact undo of beginCapturedCommand, once per run. */
export function endCapturedCommand(onSignal: () => void): void {
  activeCapturedCommands--;
  activeSignalHandlers.delete(onSignal);
}

// Signaled captured commands whose cleanup has not finished. A signal to
// codemux reaches every active command's own handler, so every command
// alive at the signal terminates its own tree and writes its own receipt;
// the first one to finish must not exit the process under the others
// (their SIGKILL escalation and receipts would be cut off, leaving a child
// that ignores SIGTERM running in its own process group).
let signaledCapturedCommands = 0;

/** Called once per run, when its handler first sees a signal. Every
 * other command in flight is signaled with it: a signal to codemux is a
 * signal to all of them, whichever listeners the dispatch happened to
 * include (review round 171). */
export function noteSignaledRun(): void {
  signaledCapturedCommands++;
  for (const onSignal of [...activeSignalHandlers]) onSignal();
}

/** True while a signaled captured command has not finished its cleanup.
 * That command exits codemux when it has, so a command that would start
 * now is not started: its child would be left running in its own process
 * group by that exit, with no handler ever having seen the signal. */
export function signalShutdownPending(): boolean {
  return signaledCapturedCommands > 0;
}

/** Awaited by a captured command that would start while a signaled one
 * is still cleaning up. The signal meant "stop codemux", and the signaled
 * run's exit ends the process with this waiter still pending, which is
 * the intended cut-off. */
export const neverSettles: Promise<never> = new Promise<never>(() => {});

/** Called by a signaled run whose cleanup (notes, receipt, tree
 * termination) has finished. True for the last one: it prints the
 * interruption line and exits with the signal code, in the same
 * synchronous stretch as this call, so no command can start between the
 * count reaching zero and the exit. False while other signaled runs are
 * still finishing theirs: the caller gives them the time their bounded
 * cleanup can take, then exits itself, so one peer whose protocol cleanup
 * never settles cannot hold codemux open after a signal (review round
 * 171). */
export function finishSignaledRun(): boolean {
  signaledCapturedCommands--;
  return signaledCapturedCommands === 0;
}
