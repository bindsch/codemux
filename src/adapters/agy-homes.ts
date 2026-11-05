// The stale-probe sweep and the directory-identity helpers the agy
// adapter's private-home lifecycle uses: a probe home is removed only
// after its directory identity (device and inode) is confirmed on disk,
// and only identified homes whose owner process is gone are swept.

import { lstatSync, readFileSync, readdirSync, realpathSync, rmSync, type Stats } from "node:fs";
import { join } from "node:path";
import { UNREADABLE_OWNER_STALE_MS, parseOwnerPid, pidProbeAlive } from "../process-table.js";

export const PROBE_MARKER = ".codemux-probe-owner";
export const PROBE_PID = ".codemux-probe-pid";

/** Remove only identified private homes whose owner is known to have exited. */
export function sweepStaleHomes(root: string): void {
  const rootStat = lstatSync(root, { throwIfNoEntry: false });
  if (!rootStat) return;
  if (!rootStat.isDirectory()) throw new Error("agy probe home root must be a directory, not a symlink");
  if (rootStat.uid !== process.getuid?.() || realpathSync(root) !== root) {
    throw new Error("agy probe sweep root must be canonical and user-owned");
  }
  for (const name of readdirSync(root)) {
    if (!name.startsWith("run-")) continue;
    try {
      const home = join(root, name);
      const identity = lstatSync(home, { throwIfNoEntry: false });
      if (!identity?.isDirectory() || identity.uid !== rootStat.uid) continue;
      const marker = join(home, PROBE_MARKER);
      if (!lstatSync(marker, { throwIfNoEntry: false })?.isFile() ||
          !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(readFileSync(marker, "utf8"))) continue;
      const pidPath = join(home, PROBE_PID);
      if (!lstatSync(pidPath, { throwIfNoEntry: false })?.isFile()) continue;
      const pid = parseOwnerPid(readFileSync(pidPath, "utf8"));
      // A dead owner is swept. An unreadable one (the child can rewrite the file) only once the file is old.
      if (pid === null ? Date.now() - lstatSync(pidPath).mtimeMs <= UNREADABLE_OWNER_STALE_MS : pidProbeAlive(pid)) continue;
      // Never follow a replacement introduced during the owner check.
      if (sameDirectory(root, rootStat) && sameDirectory(home, identity)) rmSync(home, { recursive: true, force: true });
    } catch (error) {
      // Another launch or normal cleanup may have removed this entry already.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

/** Whether `path` is still the directory `identity` describes. */
export function sameDirectory(path: string, identity: Stats): boolean {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  return Boolean(stat?.isDirectory() && stat.dev === identity.dev && stat.ino === identity.ino);
}

/** Where `identity` now lives under `parent`, by device and inode. */
export function findDirectory(parent: string, identity: Stats): string | undefined {
  return readdirSync(parent).map((name) => join(parent, name)).find((path) => sameDirectory(path, identity));
}
