import { readdirSync, readFileSync } from "node:fs";

/**
 * Process enumeration for the runner's tree-scoped termination: which
 * processes exist, who their parents are, which process group each is in,
 * and when each started. The start time is the identity check: a pid seen
 * again with a different start time belongs to a different process, so pid
 * reuse does not mislead the walk (short of the token-resolution caveat on
 * `ProcessEntry.start`).
 */

export interface ProcessEntry {
  ppid: number;
  /** Process group id, so a signal already delivered to a whole group is not
   * delivered to its members a second time. */
  pgid: number;
  /** Opaque start-time token (`ps lstart` text on macOS, one-second
   * resolution; `starttime` clock ticks on Linux). Compared for equality
   * only. A pid reused within the same token resolution would compare
   * equal, which takes a full cycle of the pid space inside a second. */
  start: string;
}

export type ProcessTable = Map<number, ProcessEntry>;

// `/bin/ps -A` takes tens of milliseconds; the bound only caps a pathological
// host, and it is what the initial termination signal can be delayed by at
// most, since the snapshot deliberately precedes that signal (see
// `signalProcess` in process-runner.ts).
const PROCESS_TABLE_TIMEOUT_MS = 1_000;

let processTableWarned = false;

/** Warn once per process: a silent degrade to the group-only kill is the
 * exact leak the tree walk exists to prevent, so the operator must see it. */
function warnProcessTable(detail: string): void {
  if (processTableWarned) return;
  processTableWarned = true;
  console.error(
    `codemux: could not read the process table (${detail}); ` +
      "descendants of a timed-out run that escaped its process group may survive"
  );
}

/** Whether this host lets the runner enumerate processes. Exported so tests
 * can skip the tree-walk cases where it cannot (e.g. nested in a sandbox
 * that denies process enumeration), instead of failing for the wrong reason. */
export function processTableReadable(): boolean {
  return readProcessTable().size > 0;
}

/**
 * Snapshot of `pid -> ppid` for every process on the host. Linux reads
 * `/proc` directly, with no spawn at all; macOS runs `/bin/ps` by absolute
 * path, never via PATH, because this runs outside the scode sandbox with the
 * operator's environment and a PATH entry writable from inside the sandbox
 * would otherwise let an agent plant the binary the runner executes. Returns
 * an empty map (after warning) when the table cannot be read, so termination
 * degrades to the process-group path instead of failing.
 */
export function readProcessTable(): ProcessTable {
  const table: ProcessTable = new Map();
  if (process.platform === "win32") return table;
  if (process.platform === "linux") return readProcTable(table);
  let result: ReturnType<typeof Bun.spawnSync>;
  try {
    // -ww: unlimited width, so an exported COLUMNS cannot truncate the
    // trailing start-time column that the identity check depends on.
    result = Bun.spawnSync(["/bin/ps", "-A", "-ww", "-o", "pid=,ppid=,pgid=,stat=,lstart="], {
      stdout: "pipe",
      stderr: "ignore",
      stdin: "ignore",
      timeout: PROCESS_TABLE_TIMEOUT_MS,
    });
  } catch (error) {
    warnProcessTable(error instanceof Error ? error.message : String(error));
    return table;
  }
  if (result.exitCode !== 0) {
    warnProcessTable(`/bin/ps exited ${result.exitCode}`);
    return table;
  }
  parsePsOutput(result.stdout?.toString() ?? "", table);
  if (table.size === 0) warnProcessTable("/bin/ps printed nothing usable");
  return table;
}

/** Parse `ps -o pid=,ppid=,pgid=,stat=,lstart=` output: "pid ppid pgid stat
 * start..." per line, the start time being the rest of the line (it
 * contains spaces). A zombie (stat beginning with `Z`) is omitted: it is
 * dead, cannot be signaled, and its children have already been reparented. */
export function parsePsOutput(
  output: string,
  table: ProcessTable = new Map()
): ProcessTable {
  for (const line of output.split("\n")) {
    const [pidText, ppidText, pgidText, stat = "", ...start] = line.trim().split(/\s+/);
    const pid = Number(pidText);
    const ppid = Number(ppidText);
    const pgid = Number(pgidText);
    if (!Number.isInteger(pid) || !Number.isInteger(ppid) || !Number.isInteger(pgid)) continue;
    if (stat.startsWith("Z")) continue;
    // A row without a start time has no identity to check against; it is
    // dropped rather than given an empty token every reused pid would match.
    if (start.length === 0) continue;
    table.set(pid, { ppid, pgid, start: start.join(" ") });
  }
  return table;
}

/** Read the table from a procfs tree. `procRoot` is a parameter only so tests
 * can point it at a fixture; production always reads `/proc`. */
export function readProcTable(
  table: ProcessTable = new Map(),
  procRoot = "/proc"
): ProcessTable {
  let entries: string[];
  try {
    entries = readdirSync(procRoot);
  } catch (error) {
    warnProcessTable(error instanceof Error ? error.message : String(error));
    return table;
  }
  let listed = 0;
  for (const name of entries) {
    if (!/^\d+$/.test(name)) continue;
    listed += 1;
    let stat: string;
    try {
      stat = readFileSync(`${procRoot}/${name}/stat`, "utf8");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // ENOENT/ESRCH: exited between readdir and read. EACCES/EPERM: another
      // user's process on a hidepid procfs, which cannot be a descendant of
      // ours (same uid, so readable) and could not be signaled anyway.
      if (code === "ENOENT" || code === "ESRCH" || code === "EACCES" || code === "EPERM") {
        continue;
      }
      // Anything else (EIO, a broken procfs) makes the snapshot untrustworthy:
      // report it as unreadable so callers treat the table as unknown.
      warnProcessTable(error instanceof Error ? error.message : String(error));
      return new Map();
    }
    // "pid (comm) state ppid pgrp ... starttime ..." — comm may itself
    // contain spaces and parentheses, so the fields are taken after the last
    // ')': state is then field 0, ppid field 1, pgrp field 2, and starttime
    // (field 22 of the whole line) field 19. A zombie (state Z) is omitted
    // for the reason given at `parsePsOutput`.
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const ppid = Number(fields[1]);
    const pgid = Number(fields[2]);
    if (fields[0] === "Z") continue;
    const start = fields[19];
    // A truncated stat line has no identity to check against; drop it.
    if (Number.isInteger(ppid) && Number.isInteger(pgid) && start !== undefined && start.length > 0) {
      table.set(Number(name), { ppid, pgid, start });
    }
  }
  if (listed > 0 && table.size === 0) {
    warnProcessTable(`every entry under ${procRoot} was unreadable`);
  }
  return table;
}

/** Every process below any of `roots` in the table, breadth first, each
 * listed once. The parent index is built once per call, so walking from
 * many roots costs the same as walking from one. */
export function listDescendants(
  roots: number | Iterable<number>,
  table: ProcessTable
): number[] {
  const children = new Map<number, number[]>();
  for (const [pid, { ppid }] of table) {
    const siblings = children.get(ppid) ?? [];
    siblings.push(pid);
    children.set(ppid, siblings);
  }
  const queue = typeof roots === "number" ? [roots] : [...roots];
  const seen = new Set<number>(queue);
  const descendants: number[] = [];
  while (queue.length > 0) {
    const pid = queue.shift() as number;
    for (const child of children.get(pid) ?? []) {
      if (seen.has(child)) continue;
      seen.add(child);
      descendants.push(child);
      queue.push(child);
    }
  }
  return descendants;
}

/**
 * Whether a remembered pid is still the process that was seen: it is in
 * the table with the same start time. Reparenting (to init, or on Linux to
 * a subreaper such as a user's systemd) does not change the start time, so
 * an orphan stays ours; a pid reused by a new process has a new start time
 * (to the token's resolution, see `ProcessEntry.start`), so a stranger does
 * not. A zombie is not in the table, so it is not ours either (it is dead).
 */
export function isStillOurs(
  pid: number,
  remembered: ProcessEntry,
  table: ProcessTable
): boolean {
  const current = table.get(pid);
  return current !== undefined && current.start === remembered.start;
}
