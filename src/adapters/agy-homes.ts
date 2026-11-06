// The stale-probe sweep and the directory-identity helpers the agy
// adapter's private-home lifecycle uses: a probe home is removed only
// after its directory identity (device and inode) is confirmed on disk,
// and only identified homes whose owner process is gone are swept.

import { lstatSync, readdirSync, realpathSync, rmSync, type Stats } from "node:fs";
import { join } from "node:path";
import { UNREADABLE_OWNER_STALE_MS, parseOwnerPid, pidProbeAlive } from "../process-table.js";
import { FileContentError, FileShapeError, readFileBytesBounded } from "../file-io.js";

export const PROBE_MARKER = ".codemux-probe-owner";
export const PROBE_PID = ".codemux-probe-pid";

/** The read bound on a probe marker or PID file: a marker is a
 * 36-character UUID and a PID file a short decimal, so 256 bytes holds
 * either with room to spare. A file past it is skipped by the sweep and
 * refused by the cleanup, never read to find out (review round 199). */
export const PROBE_FILE_MAX_BYTES = 256;

const MARKER_PATTERN = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;

/** What one bounded read of a probe marker or PID file found. */
type ProbeEntry = { kind: "text"; text: string } | { kind: "oversized" } | { kind: "absent" };

/** One bounded read of a probe marker or PID file (review round 199).
 * The read never follows a link and never passes the bound, so a file a
 * harness left in the home cannot grow it without limit or park it on a
 * FIFO. The bytes are decoded as the old whole-file read decoded them —
 * nothing stripped, nothing refused — so a marker with a byte-order mark
 * or stray bytes still fails the exact comparisons its callers make
 * (review round 204). `absent` covers a missing entry, a link, and a
 * non-regular file. An error the entry's shape cannot explain — an
 * unreadable parent, an I/O error — propagates as before; one follow-up
 * lstat classifies an entry the open itself refused (a socket), and it
 * is used only to skip, never to read. */
function readProbeEntryFile(path: string): ProbeEntry {
  try {
    const bytes = readFileBytesBounded(path, {
      maxBytes: PROBE_FILE_MAX_BYTES,
      label: "agy probe entry file",
      noFollow: true,
    });
    return { kind: "text", text: bytes.toString("utf8") };
  } catch (error) {
    if (error instanceof FileContentError) return { kind: "oversized" };
    if (error instanceof FileShapeError) return { kind: "absent" };
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "absent" };
    const entry = lstatSync(path, { throwIfNoEntry: false });
    if (entry === undefined || !entry.isFile()) return { kind: "absent" };
    throw error;
  }
}

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
      // A home is identified by a marker that reads as one: an oversized
      // marker is not one, and the home is left alone.
      const marker = readProbeEntryFile(join(home, PROBE_MARKER));
      if (marker.kind !== "text" || !MARKER_PATTERN.test(marker.text)) continue;
      const pidPath = join(home, PROBE_PID);
      const owner = readProbeEntryFile(pidPath);
      if (owner.kind === "absent") continue;
      // An owner file past the bound names no pid, like any other content
      // that parses to none: the age rule below decides.
      const pid = owner.kind === "text" ? parseOwnerPid(owner.text) : null;
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
