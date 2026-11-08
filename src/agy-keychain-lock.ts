/**
 * The agy keychain host seams and the template lock, split from
 * agy-keychain.ts (review round 381, for the file-size cap): the host
 * object every agy keychain path and test stubs (home, securityPath,
 * spawnSync, and the lock's own injectables), and the synchronous
 * process-owned lock that serializes template creation and search-list
 * recovery across launches. agy-keychain.ts re-exports the public names
 * so every importer keeps one address.
 */

import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  linkSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { MAX_PID, pidProbeAlive } from "./process-table.js";

const LOCK_WAIT_MS = 60_000;
const LOCK_POLL_MS = 25;
const EMPTY_LOCK_STALE_MS = 60_000;
// A lock holds a decimal pid or nothing; anything longer is not a pid
// spelling this program ever wrote, so it is read no further.
const LOCK_MAX_BYTES = 64;
const LOCK_PID_PATTERN = /^[1-9]\d*$/;

export const agyKeychainHost = {
  home: homedir,
  securityPath: (_environment: NodeJS.ProcessEnv): string | undefined =>
    existsSync("/usr/bin/security") ? "/usr/bin/security" : undefined,
  spawnSync: Bun.spawnSync,
  /** The hard link behind the stale-lock claim, injectable so tests can
   * prove the refused-link path without a filesystem that denies links. */
  linkSync,
  /** The lock wait and poll cadence, injectable so tests can prove the
   * waiting behavior without sitting out the production minute. */
  lockWaitMs: LOCK_WAIT_MS,
  lockPollMs: LOCK_POLL_MS,
};

/** One held lock's facts, read from the descriptor the identity came
 * from: the content is bounded and the staleness rule below reads the
 * same inode the unlink check compares. */
interface LockFacts {
  identity: Stats;
  /** The lock's content, or null when it cannot be a pid (empty, or
   * malformed: a non-decimal value, content past the byte bound, or a
   * partial read). */
  owner: string | null;
}

/** Read the lock by descriptor: never a non-regular file (the identity
 * refuses it), never more than the bound's bytes, so a planted huge file
 * is classified, not slurped. */
function readLockFacts(fd: number): LockFacts {
  const identity = fstatSync(fd);
  if (!identity.isFile()) throw new Error("agy template lock must be a regular file");
  if (identity.size > LOCK_MAX_BYTES) return { identity, owner: null };
  const buffer = Buffer.alloc(identity.size);
  let read = 0;
  while (read < buffer.length) {
    const received = readSync(fd, buffer, read, buffer.length - read, read);
    if (received <= 0) break;
    read += received;
  }
  return { identity, owner: read === buffer.length ? buffer.toString("utf8") : null };
}

/** Removes a judged-stale lock incarnation so that exactly one waiter can
 * win. The old shape — lstat the identity, then unlink — was two syscalls:
 * a second waiter's lstat could confirm the stale inode before the first
 * waiter's unlink, and the second waiter's unlink then land after the
 * first had already recreated a fresh lock, deleting it; both waiters held
 * the lock at once and interleaved template creation and search-list
 * restores (review round 341, item 7). The claim makes the removal
 * conditional-atomic instead: a hard link under a name derived from the
 * stale incarnation's own identity can be created by exactly one waiter
 * (link answers EEXIST to every other, and the loser polls again — it
 * meets the winner's fresh lock), and the winner re-verifies the alias
 * before unlinking the lock's name, so a lock replaced between the link
 * and the unlink is never removed. A holder that crashes between its link
 * and its unlink wedges the claim (later waiters poll to the deadline,
 * which names the leftover); the residual that a deleted stale lock's
 * inode is reused by a fresh lock before the winner's unlink predates this
 * fix. Exported for the lock's regression tests. */
export function reclaimStaleLock(path: string, identity: Stats): void {
  const claim = `${path}.reclaim-${identity.dev}-${identity.ino}`;
  try {
    agyKeychainHost.linkSync(path, claim);
  } catch (error) {
    // Another waiter holds this incarnation's claim (EEXIST), or the lock
    // is already gone (ENOENT): either way this waiter polls again. Any
    // other refusal -- a directory or filesystem that denies hard links --
    // makes the claim impossible, so it is reported now instead of being
    // read as a rival until the deadline (review round 344).
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST" || code === "ENOENT") return;
    throw new Error(
      `cannot reclaim the stale agy template lock ${path}: hard link refused (${code ?? String(error)})`,
      { cause: error }
    );
  }
  try {
    const linked = lstatSync(claim, { throwIfNoEntry: false });
    if (linked !== undefined && linked.ino === identity.ino && linked.dev === identity.dev) {
      unlinkSync(path);
    }
  } finally {
    try { unlinkSync(claim); } catch { /* the alias is already gone */ }
  }
}

/** Synchronous preparation uses an exclusive, process-owned lock across launches. */
export function templateLock(path: string): () => void {
  const deadline = Date.now() + agyKeychainHost.lockWaitMs;
  const pause = new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    try {
      const fd = openSync(path, "wx", 0o600);
      const identity = fstatSync(fd);
      try { writeFileSync(fd, String(process.pid)); }
      catch (error) { closeSync(fd); unlinkSync(path); throw error; }
      closeSync(fd);
      return () => {
        const current = lstatSync(path, { throwIfNoEntry: false });
        if (current?.ino === identity.ino && current.dev === identity.dev) unlinkSync(path);
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    try {
      // The type is checked before the open, and the open neither blocks
      // nor follows a link: a FIFO at the lock path would otherwise hold a
      // plain read-only open forever, past the deadline below (review
      // round 111). The descriptor's own fstat repeats the type check.
      if (!lstatSync(path).isFile()) throw new Error("agy template lock must be a regular file");
      const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
      let facts: LockFacts;
      try { facts = readLockFacts(fd); }
      finally { closeSync(fd); }
      const identity = facts.identity;
      const ageMs = () => Date.now() - identity.mtimeMs;
      // The staleness rule, one shape for every content: a live owner
      // (kill succeeds, or EPERM — a process exists that this uid may not
      // signal) holds the lock; a dead owner (ESRCH) is stale at any age;
      // everything else — empty content, a value that is not a decimal
      // pid, content past the byte bound, or a pid outside 1..MAX_PID
      // (0 and below are process groups; above the ceiling no kernel
      // assigns) — is malformed in the empty case's sense: stale once its
      // mtime is older than EMPTY_LOCK_STALE_MS, so an abandoned or
      // corrupted lock recovers instead of failing every later launch
      // (review round 110; the shared range gate, round 115).
      const ownerPid = facts.owner !== null && LOCK_PID_PATTERN.test(facts.owner)
        ? Number(facts.owner) : null;
      const stale = ownerPid !== null && ownerPid <= MAX_PID ? !pidProbeAlive(ownerPid)
        : ageMs() > EMPTY_LOCK_STALE_MS;
      if (stale) {
        reclaimStaleLock(path, identity);
        continue;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (Date.now() >= deadline) {
      // A reclaim wedged by a crash between its link and its unlink answers
      // EEXIST to every later waiter; name the leftover so the operator can
      // clear it.
      let wedged: string | null = null;
      try {
        wedged = readdirSync(dirname(path)).find((entry) =>
          entry.startsWith(`${basename(path)}.reclaim-`)) ?? null;
      } catch { /* the listing is advisory */ }
      throw new Error(
        wedged === null
          ? "timed out waiting for agy template keychain lock"
          : `timed out waiting for agy template keychain lock; ${join(dirname(path), wedged)} is a leftover reclaim file — delete it`
      );
    }
    Atomics.wait(pause, 0, 0, agyKeychainHost.lockPollMs);
  }
}
