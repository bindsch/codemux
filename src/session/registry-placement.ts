/**
 * The registry's placement rules (design §4.8, rule 3): the ancestor
 * walk and the leaf checks every registry open runs before trusting the
 * file. Split from registry-io.ts, which keeps the lock, the identity
 * helpers, and the atomic replace; that module re-exports these names so
 * every importer keeps one address. Pure path and metadata checks — no
 * session model, no lock, no writes.
 */

import { lstatSync } from "node:fs";
import { realpathSync } from "node:fs";
import { dirname } from "node:path";
import type { Stats } from "node:fs";

/** The registry file's mode, the one this check demands and the writer's
 * atomic replace produces. Defined here (the module with no codemux
 * imports) so the writer can share it without a cycle; registry-io
 * re-exports it. */
export const REGISTRY_FILE_MODE = 0o600;

/** Resolve symlinked ancestors away: realpath the deepest existing
 * ancestor and re-attach the not-yet-existing tail (ceiling.ts resolves
 * tool targets with the same walk). Symlinked system ancestors are the
 * normal case for a real home — macOS `/var -> /private/var`, Linux
 * `/home -> /data/home` — so the registry resolves them instead of
 * refusing; every registry open then names the real directory, and a
 * later re-link of the friendly spelling cannot redirect it. Unlike
 * the ceiling's resolver this keeps the on-disk spelling (no NFC
 * normalization): the result is opened, and macOS directory names are
 * NFD. Never fails — realpath of `/` is the floor. */
export function resolveRegistryPath(path: string): string {
  let probe = path;
  for (;;) {
    try {
      const real = realpathSync(probe);
      return probe === path ? real : real + path.slice(probe.length);
    } catch {
      const parent = dirname(probe);
      if (parent === probe) return path;
      probe = parent;
    }
  }
}

/** Placement checks the design runs on every open (rule 3, §4.8): the
 * ancestor walk runs on the resolved chain — symlinked system ancestors
 * resolved away by `resolveRegistryPath`, anything that survived
 * resolution (an unreadable step degrades the walk and can leave links
 * in the unresolved tail) is still the tamper class this check exists
 * for — and the registry's own directory and the file itself are
 * codemux's: owned by the invoking user, the directory not group- or
 * other-writable, the file a regular 0600 non-symlink. The leaf rules
 * read the original spelling: a symlinked leaf directory or file must
 * refuse even though ancestor resolution would follow it. Ownership is
 * enforced on the codemux-owned leaf only; system ancestors (`/Users`,
 * `/`) are root's by design. Returns the first problem found, or
 * null. */
export function registryPlacementProblem(path: string): string | null {
  const uid = typeof process.getuid === "function" ? process.getuid() : -1;
  const canCheckUid = uid >= 0;
  const dir = dirname(path);
  // Nothing exists yet: the next write creates the directory (0700) and
  // the file, so there is nothing to inspect. A missing registry is the
  // clean `missing` outcome, not an untrusted one. Existence is lstat's,
  // never `existsSync`'s: that follows links, so a dangling symlink read
  // as "nothing yet" and skipped the refusal below (review live23).
  // ENOTDIR (a file where an ancestor directory belongs) is "nothing
  // yet" too: the write's mkdir then fails as unavailable.
  let leafStat: Stats;
  try {
    leafStat = lstatSync(dir);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    return `cannot inspect registry directory ${dir} (${code ?? "error"})`;
  }
  if (leafStat.isSymbolicLink()) {
    return `registry directory ${dir} is a symbolic link`;
  }
  let walk = dirname(resolveRegistryPath(path));
  const chain: string[] = [];
  for (;;) {
    chain.unshift(walk);
    const parent = dirname(walk);
    if (parent === walk) break;
    walk = parent;
  }
  for (const segment of chain) {
    let stat: Stats;
    try {
      stat = lstatSync(segment);
    } catch (error) {
      return `cannot inspect registry directory ${segment} (${(error as NodeJS.ErrnoException).code ?? "error"})`;
    }
    if (stat.isSymbolicLink()) {
      return `registry directory ${segment} is a symbolic link`;
    }
  }
  // The leaf is not a symlink, so its original-spelling lstat and the
  // resolved chain's leaf are the same directory.
  if (canCheckUid && leafStat.uid !== uid) {
    return `registry directory ${dir} is not owned by the invoking user`;
  }
  if ((leafStat.mode & 0o022) !== 0) {
    return `registry directory ${dir} is group- or other-writable`;
  }
  let stat: Stats;
  try {
    stat = lstatSync(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    return `cannot inspect the registry (${code ?? "error"})`;
  }
  if (stat.isSymbolicLink()) return "the registry is a symbolic link";
  if (!stat.isFile()) return "the registry is not a regular file";
  if (canCheckUid && stat.uid !== uid) return "the registry is not owned by the invoking user";
  if ((stat.mode & 0o777) !== REGISTRY_FILE_MODE) {
    return `the registry mode is ${stat.mode.toString(8).padStart(3, "0")}, not 0600`;
  }
  return null;
}
