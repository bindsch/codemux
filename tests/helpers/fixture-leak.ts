/**
 * The fixture-leak guard's shared half (audit round 2, C-4): the identity
 * file a tracked fixture leaves — `pid\nstart`, the start token naming the
 * process's own launch — and the exit-time sweep tests/setup.ts runs. The
 * token is the reuse check: a pid the OS handed to a different process
 * after the fixture died must not be signaled, so the sweep only kills a
 * fixture whose recorded identity is still alive (the same rule
 * processIdentityAlive applies to lock holders in the session registry).
 */

import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { processIdentityAlive } from "../../src/session/registry-io.js";
import { readProcessTable, type ProcessTable } from "../../src/process-table.js";

export interface TrackedFixture {
  label: string;
  pidFile: string;
}

export interface FixtureIdentity {
  pid: number;
  start: string | null;
}

/** Read a fixture identity file: the first line is the pid, an optional
 * second line the start token. A missing, empty, or unparsable file reads
 * as null (nothing to signal). */
export function readFixtureIdentity(pidFile: string): FixtureIdentity | null {
  let text: string;
  try {
    text = readFileSync(pidFile, "utf8");
  } catch {
    return null;
  }
  const [pidLine, startLine] = text.split("\n");
  const pid = Number(pidLine);
  if (!Number.isFinite(pid) || pid <= 1) return null;
  return { pid, start: startLine === undefined || startLine === "" ? null : startLine };
}

/** Write `pid\nstart` for a pid the caller already holds (a spawned
 * child), taking the start token from the process table — empty when the
 * table is unreadable, in which case the sweep degrades to kill(pid, 0),
 * the pre-identity behavior. */
export function writeFixtureIdentity(pidFile: string, pid: number): void {
  const start = readProcessTable().get(pid)?.start ?? "";
  writeFileSync(pidFile, `${pid}\n${start}`);
}

/** The statement an embedded child script runs to write its own (or a
 * spawned descendant's) identity file, so a fixture that only a child
 * process can name carries the same two-line format. `pidExpr` is a JS
 * expression evaluating to the pid inside that script. */
export function childIdentityWrite(pidFile: string, pidExpr: string): string {
  const tableUrl = pathToFileURL(
    new URL("../../src/process-table.ts", import.meta.url).pathname
  ).href;
  return (
    `const { readProcessTable } = await import(${JSON.stringify(tableUrl)}); ` +
    `await Bun.write(${JSON.stringify(pidFile)}, (${pidExpr}) + "\\n" + (readProcessTable().get(${pidExpr})?.start ?? ""));`
  );
}

/** Kill every tracked fixture still alive under its recorded identity and
 * return what was killed, so the caller can fail the run loudly. The
 * process-group send goes first (a detached fixture is its own leader),
 * then the pid itself; both are best effort. `table` lets a test pin the
 * aliveness verdict instead of reading the host's real process table. */
export function sweepLeakedFixtures(
  fixtures: readonly TrackedFixture[],
  table?: ProcessTable
): Array<{ label: string; pid: number }> {
  const killed: Array<{ label: string; pid: number }> = [];
  for (const fixture of fixtures) {
    const identity = readFixtureIdentity(fixture.pidFile);
    if (identity === null) continue;
    if (!processIdentityAlive(identity.pid, identity.start, table)) continue;
    for (const target of [-identity.pid, identity.pid]) {
      try {
        process.kill(target, "SIGKILL");
      } catch {
        // Gone already, or not a group leader.
      }
    }
    killed.push({ label: fixture.label, pid: identity.pid });
  }
  return killed;
}
