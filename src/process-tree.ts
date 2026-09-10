import {
  isStillOurs,
  listDescendants,
  readProcessTable,
  type ProcessEntry,
  type ProcessTable,
} from "./process-table.js";

/**
 * Descendant bookkeeping for the runner's tree-scoped termination: what one
 * spawned command has started, directly or through its children, and how to
 * signal all of it. See process-runner.ts for the signal sequencing.
 */

const DESCENDANT_POLL_MS = 200;

/**
 * Everything the runner must signal to stop one spawned command. Agents such
 * as Codex place each tool command in its own process group, so a group kill
 * alone leaves shell loops behind (a stray `xargs ... --version` once opened
 * `gtk3-demo-application` on the desktop after its agent had timed out). The
 * runner therefore also walks the process tree by parent pid.
 *
 * `descendants` remembers every pid seen under the child together with its
 * parent and start time at the time. Once the child dies its orphans are
 * reparented and vanish from a walk rooted at the child, so the memory is
 * what lets the SIGKILL escalation still reach them. A remembered pid is
 * signaled only while it is still ours (see `isStillOurs`): same start
 * time, so a pid reused by a stranger is not signaled (short of reuse
 * within the start token's resolution, see `ProcessEntry.start`).
 * A table that could not be read is treated as unknown, never as empty:
 * nothing is forgotten, remembered pids are signaled unverified (the one
 * place pid reuse inside the grace window could still misfire), and the
 * process-group SIGKILL that 0.5.0 delivered on timeout fires at once, as
 * it did then, so an enumeration-denied host keeps the old guarantee and
 * the old latency rather than losing either. One residual gap: a
 * remembered pid whose snapshot put it in the signaled group is left to
 * the group kill, so if it left that group after its snapshot and the
 * group kill lands without error, it escapes this escalation. Unverified
 * signaling trades precision for reach; that trade is the accepted
 * degraded mode, not a guarantee.
 *
 * KNOWN LIMITATION (accepted): the first snapshot is taken when the first
 * termination signal fires, so a descendant whose chain of parents back to
 * the child had already broken by then (its parent exited earlier in the
 * run) is never seen; likewise one that forks a new process and exits
 * between two snapshots. Both leave a process the reaper owns and no
 * pid-tree walk can attribute. Closing that needs kernel help (cgroups on
 * Linux, nothing on macOS short of a sandbox), which the scode boundary is
 * for; this runner catches the ordinary case of a tool loop still attached
 * to the agent when the timeout fires.
 */
export interface TerminationTarget {
  proc: ReturnType<typeof Bun.spawn>;
  processGroup: boolean;
  descendants: Map<number, ProcessEntry>;
  /** Set once `proc.exited` resolves. Tracked here rather than read from
   * `proc.exitCode`, which stays null after a death by signal. */
  childExited: boolean;
}

export function createTerminationTarget(
  proc: ReturnType<typeof Bun.spawn>,
  processGroup = false
): TerminationTarget {
  const target: TerminationTarget = {
    proc,
    processGroup,
    descendants: new Map(),
    childExited: false,
  };
  const markExited = () => {
    target.childExited = true;
  };
  proc.exited.then(markExited, markExited);
  return target;
}

export function rememberDescendants(
  target: TerminationTarget,
  table: ProcessTable
): void {
  // Walk from every remembered descendant that is still ours, and from the
  // child while it is still alive, so a process started by a still-running
  // descendant after the last snapshot is found even once its own ancestor
  // chain to the child has broken. An exited child's pid is never used as a
  // root: Bun has reaped it, so the pid may already belong to someone else.
  const roots = target.childExited ? [] : [target.proc.pid];
  for (const [pid, entry] of target.descendants) {
    if (isStillOurs(pid, entry, table)) roots.push(pid);
  }
  // One walk for all roots: the parent index is built once, so a large
  // table with many remembered pids stays linear per poll.
  for (const pid of listDescendants(roots, table)) {
    const entry = table.get(pid) as ProcessEntry;
    const seen = target.descendants.get(pid);
    // New, or a pid reused by a new descendant of ours since it was last
    // seen (different start time): record the process that is there now.
    if (seen === undefined || seen.start !== entry.start) {
      target.descendants.set(pid, entry);
    }
  }
}

/** Deliver `signal` to one descendant. ESRCH means it exited on its own;
 * any other failure (EPERM after a setuid exec, say) leaves it running, so
 * the operator is told rather than left to assume the tree is dead. */
export function signalDescendant(pid: number, signal: NodeJS.Signals): void {
  // Never below 1: 0 would signal codemux's own process group and -1 every
  // process the user owns. The table never yields those, but the blast
  // radius of any future parser bug is bounded to one process here.
  if (!(pid > 0)) return;
  try {
    process.kill(pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
    console.error(
      `codemux: could not send ${signal} to descendant ${pid}: ` +
        (error instanceof Error ? error.message : String(error))
    );
  }
}

/**
 * Signal every remembered descendant, except members of `groupSignaled`
 * when `signal` is SIGTERM: a second delivery would turn a program's
 * "SIGTERM twice means now" into a lost grace period. At SIGKILL that
 * concern is void — a second delivery is meaningless and a missed one is
 * permanent — so every remembered descendant is signaled individually
 * there, closing the window where a descendant that left the group after
 * its snapshot escapes a successful group kill. Returns the members it
 * left to the group signal, so the caller can reach them one by one if
 * that signal cannot be delivered.
 */
export function signalDescendants(
  target: TerminationTarget,
  signal: NodeJS.Signals,
  groupSignaled: number | null
): number[] {
  const leftToGroup: number[] = [];
  const table = readProcessTable();
  if (table.size === 0) {
    // Unknown, not empty: signal what is remembered, unverified, and
    // forget nothing, so a transient read failure cannot erase the
    // escalation. A pid remembered inside the signaled group stays with
    // the group kill for SIGTERM (the lost-grace trade-off), and is
    // signaled individually at SIGKILL where a missed delivery is
    // permanent.
    for (const [pid, entry] of target.descendants) {
      if (signal === "SIGTERM" && entry.pgid === groupSignaled) {
        leftToGroup.push(pid);
      } else {
        signalDescendant(pid, signal);
      }
    }
    return leftToGroup;
  }
  rememberDescendants(target, table);
  for (const [pid, entry] of target.descendants) {
    // Gone, or present with a new start time (reused): forget it either way.
    if (!isStillOurs(pid, entry, table)) {
      target.descendants.delete(pid);
      continue;
    }
    // Compare the CURRENT group from the fresh table, not the remembered
    // one: a descendant that left the group after its snapshot would
    // otherwise be skipped here and missed by the group signal too. A
    // member still inside the group stays with the group signal for
    // SIGTERM (a second delivery would cost a compliant program its
    // grace period); at SIGKILL that concern is void — a second delivery
    // is meaningless and a missed one is permanent — so every remembered
    // descendant is signaled individually there, closing the window where
    // a descendant that left the group after its snapshot escapes a
    // successful group kill.
    if (
      signal !== "SIGKILL" &&
      (table.get(pid) as ProcessEntry).pgid === groupSignaled
    ) {
      leftToGroup.push(pid);
      continue;
    }
    signalDescendant(pid, signal);
  }
  return leftToGroup;
}

/**
 * Wait until every remembered descendant has exited or the grace deadline
 * (a `performance.now()` instant, immune to wall-clock adjustments) passes,
 * whichever is first. A child that shut its children down cleanly costs no
 * extra latency; each poll also records any new process a live descendant
 * has started. An unreadable table returns at once: with nothing observable
 * there is nothing to wait for, and the caller's immediate SIGKILL is the
 * 0.5.0 behavior on such a host. The caller escalates afterwards
 * regardless; the wait is only ever about giving the grace period. If the
 * deadline has already passed when this is entered, it returns at once.
 */
export async function waitForDescendantsGrace(
  target: TerminationTarget,
  deadline: number
): Promise<void> {
  while (true) {
    // Expired before anything else: scanning the table here would only
    // delay the caller's SIGKILL, by up to a full table-read timeout on
    // macOS, past the grace that was promised.
    const remaining = deadline - performance.now();
    if (remaining <= 0) return;
    const table = readProcessTable();
    if (table.size === 0) return;
    rememberDescendants(target, table);
    let alive = false;
    for (const [pid, entry] of target.descendants) {
      if (!isStillOurs(pid, entry, table)) {
        target.descendants.delete(pid); // exited, or its pid reused
        continue;
      }
      alive = true;
    }
    if (!alive) return;
    await Bun.sleep(Math.min(remaining, DESCENDANT_POLL_MS));
  }
}

