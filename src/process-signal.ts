import { rememberDescendants, signalDescendant, signalDescendants, type TerminationTarget } from "./process-tree.js";
import { readProcessTable, type ProcessTable } from "./process-table.js";

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
 * observed exit only tree cleanup runs: remembered descendants with
 * isStillOurs guarding pid reuse, and the group address only when the
 * table lists a member of that group besides the leader slot
 * (groupAddressSafe below, review round 401, item 8) — a reaped child's pid may have been recycled
 * into a stranger's group leader, and the group signal must not reach
 * that group.
 *
 * A send that throws ESRCH is silent — the pid no longer exists.
 * Every other refusal names a process that exists (EPERM above
 * all — a live process the sender may not signal), so it is reported on
 * stderr as a signal failure the operator should see, never taken to
 * mean the child is gone (round al35, edges major 3).
 */
/** Whether the group address `-proc.pid` still names the child's own
 * process group (review round 401, item 8). While the child lives the
 * group is its own. After the exit the reaped pid may have been recycled
 * into a stranger's group leader, so the address is used only when the
 * table lists a member of that group other than the leader slot: a
 * process carries the child's group id only by descending from the child
 * (a stranger that reuses a pid inherits its own parent's group), so any
 * such member, remembered or not, keeps the group ours and keeps the
 * reach the group kill exists for (a descendant forked between two
 * snapshots). A listed leader slot alone is the recycled pid and takes no
 * signal. An unreadable table (size 0) keeps the old guarantee — the
 * group signal fires as before rather than losing reach on a host that
 * denies enumeration. Residual: a leader recycled inside the sampling
 * window that has already forked a child of its own looks like a live
 * group. */
function groupAddressSafe(target: TerminationTarget, table: ProcessTable): boolean {
  if (!target.childExited) return true;
  if (table.size === 0) return true;
  for (const [pid, entry] of table) {
    if (pid !== target.proc.pid && entry.pgid === target.proc.pid) return true;
  }
  return false;
}

export function signalProcess(
  target: TerminationTarget,
  signal: NodeJS.Signals,
  scope: "process" | "tree"
): void {
  const { proc, processGroup } = target;
  if (process.platform !== "win32") {
    // One table read serves the descendant walk and the group-address
    // check, so the two never disagree about the same moment.
    const table = readProcessTable();
    const groupSignaled = processGroup && scope === "tree" ? proc.pid : null;
    let leftToGroup: number[] = [];
    if (scope === "tree") {
      leftToGroup = signalDescendants(target, signal, groupSignaled, table);
    } else {
      // Remember the descendants a process-scoped send leaves alive, so
      // the later tree-scoped escalation can reach them (the tree-kill
      // mechanics above).
      rememberDescendants(target, table);
    }
    // After the child's exit the group address is refused unless the table
    // shows a still-ours member of that group (round 401, item 8): a
    // reaped pid recycled into a stranger's group leader must not take a
    // group signal. The members left to the group are then reached one by
    // one, exactly as a failed group send reaches them below.
    const groupSafe = groupSignaled !== null && groupAddressSafe(target, table);
    if (groupSignaled !== null && !groupSafe) {
      for (const pid of leftToGroup) signalDescendant(pid, signal);
    }
    if (groupSignaled !== null && groupSafe) {
      try {
        process.kill(-proc.pid, signal);
        // A child can leave its original group. Only skip its handle when
        // the snapshot confirms membership (the handle guards pid reuse).
        if (target.childExited || table.get(proc.pid)?.pgid === proc.pid) return;
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
  // The platform without process groups and without a process table
  // reader (readProcessTable answers empty on win32): a tree-scoped
  // signal reaches the immediate child only, and descendants the harness
  // created survive. A KNOWN LIMITATION, stated in docs/sessions.md:
  // closing it needs a Windows job object or a taskkill tree walk, and
  // every Windows path that spawns a process tree of its own (the
  // experiments) is refused already (review rounds 232 and 235).
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
