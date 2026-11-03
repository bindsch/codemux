import { existsSync, rmSync } from "node:fs";
import { readProcessTable } from "../../src/process-table.js";
import { readFixtureIdentity } from "./fixture-leak.js";

/** Whether `pid` still runs, by the process table (which omits zombies, so a
 * killed process awaiting a slow reaper does not count as alive). Throws if
 * the table cannot be read, so an enumeration failure can never pass as
 * "exited"; callers guard on `processTableReadable()` first. */
export function stillRunning(pid: number): boolean {
  const table = readProcessTable();
  if (table.size === 0) throw new Error("process table unreadable; cannot judge liveness");
  return table.has(pid);
}

/**
 * Kill a detached fixture by process group (it is its own leader), polling
 * briefly for its pid file first: an early assertion failure can beat the
 * fixture's write while the process still spawns and idles forever. The
 * disposer unregisters the setup.ts exit guard's handle.
 */
export async function killDetachedFixture(
  untrack: () => void,
  pidFile: string,
  cwd: string
): Promise<void> {
  try {
    const deadline = Date.now() + 2_000;
    while (!existsSync(pidFile) && Date.now() < deadline) await Bun.sleep(10);
    if (existsSync(pidFile)) {
      const identity = readFixtureIdentity(pidFile);
      if (identity !== null) {
        for (const target of [-identity.pid, identity.pid]) {
          try {
            process.kill(target, "SIGKILL");
          } catch {
            // Already gone, or not a group leader.
          }
        }
      }
    }
  } finally {
    untrack();
    rmSync(cwd, { recursive: true, force: true });
  }
}
