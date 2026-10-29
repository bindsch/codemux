import { rememberDescendants, signalDescendant, signalDescendants, type TerminationTarget } from "./process-tree.js";
import { readProcessTable } from "./process-table.js";

/**
 * Signal the child. `scope: "tree"` also signals its process group (when it
 * leads one) and every descendant found by walking the process table;
 * `scope: "process"` signals the child alone but still records its
 * descendants so a later tree-scoped escalation can reach them. This
 * function sends signals and reports send failures. Every nonzero or
 * signal child exit remains a failure, regardless of signal delivery.
 * Process-table reads serve tree cleanup alone:
 * `signalDescendants` walks before it signals — an agent that exits
 * promptly reparents its escaped descendants within milliseconds, so the
 * walk must come first or the tree kill has nothing to remember — and
 * the process-scope arm's `rememberDescendants` read keeps the map a
 * later escalation will need.
 *
 * The child is signaled through its subprocess handle, which cannot
 * address a reused pid even before the exit continuation runs. After an
 * observed exit only tree cleanup runs: the group and remembered
 * descendants, with isStillOurs guarding remembered pid reuse.
 *
 * A send that throws ESRCH is silent — the pid no longer exists.
 * Every other refusal names a process that exists (EPERM above
 * all — a live process the sender may not signal), so it is reported on
 * stderr as a signal failure the operator should see, never taken to
 * mean the child is gone (round al35, edges major 3).
 */
export function signalProcess(
  target: TerminationTarget,
  signal: NodeJS.Signals,
  scope: "process" | "tree"
): void {
  const { proc, processGroup } = target;
  if (process.platform !== "win32") {
    const groupSignaled = processGroup && scope === "tree" ? proc.pid : null;
    let leftToGroup: number[] = [];
    if (scope === "tree") {
      leftToGroup = signalDescendants(target, signal, groupSignaled);
    } else {
      // Remember the descendants a process-scoped send leaves alive, so
      // the later tree-scoped escalation can reach them (the tree-kill
      // mechanics above).
      rememberDescendants(target, readProcessTable());
    }
    if (groupSignaled !== null) {
      try {
        process.kill(-proc.pid, signal);
        return; // the group send reached the child with it
      } catch (error) {
        // The group signal did not go out. ESRCH means the group is gone
        // (the child exited between the timer and delivery); anything else
        // is reported. Either way the members left to it are reached one by
        // one: a member that moved to another group since the snapshot is
        // still alive, and ESRCH per pid is harmless.
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
          console.error(
            `codemux: could not send ${signal} to process group ${proc.pid}: ` +
              (error instanceof Error ? error.message : String(error))
          );
        }
        for (const pid of leftToGroup) signalDescendant(pid, signal);
      }
    }
    // The handle also guards the interval before the exit callback runs.
    if (target.childExited) return;
    try {
      proc.kill(signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
        console.error(
          `codemux: could not send ${signal} to child ${proc.pid}: ` +
            (error instanceof Error ? error.message : String(error))
        );
      }
    }
    return;
  }
  // The same pid-reuse guard on the platform without process groups.
  if (target.childExited) return;
  try {
    proc.kill(signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
      console.error(
        `codemux: could not send ${signal} to child ${proc.pid}: ` +
          (error instanceof Error ? error.message : String(error))
      );
    }
  }
}
