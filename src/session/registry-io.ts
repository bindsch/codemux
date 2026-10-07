/**
 * Registry file mechanics (design §4.8): the placement checks every
 * open runs, the writer lock, and the atomic replace. The lock is held
 * through never-reused file names (review live9): each acquisition
 * creates its own `.<lock>.<pid>.<salt>.held` file in the registry
 * directory, so stealing a dead holder's lock can only unlink the exact
 * name whose payload was verified dead — a name that is never handed
 * out again. A single reused lock pathname made the steal-race
 * fixable-looking but unsound: two writers that both read a dead
 * holder's lock could unlink each other's successors and both hold the
 * lock. Pure file plumbing — no session model, no resume rules (those
 * live in registry.ts); the two are separate so each mechanism tests
 * alone, as the design demands for lock versus ownership.
 */

import { randomBytes } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  lstatSync,
  openSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
  type Stats,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { FileContentError, readUtf8FileBounded } from "../file-io.js";
import { readProcessTable, type ProcessTable } from "../process-table.js";

export const REGISTRY_DIR_MODE = 0o700;
export const REGISTRY_FILE_MODE = 0o600;
const LOCK_RETRY_MS = 250;
const LOCK_ATTEMPTS = 40;

/** Synchronous, timer-free sleep for the lock's bounded retry loop. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Whether a remembered (pid, start-token) pair is still that live
 * process. With a start token present AND the process table readable it
 * is identity-checked (pid reuse gets a new token). Without a token —
 * recorded null because the table was unreadable at record time — or
 * wherever the table is unreadable at check time, it degrades to bare
 * pid existence (a signal-0 probe, where only ESRCH means dead); either
 * way the residual is the pid-reuse window. A caller that checks many identities in one pass
 * (prune) may hand in one snapshot: each unread table costs a process
 * enumeration, and a thousand of those inside the held writer lock is
 * its own contention defect (review live13). */
export function processIdentityAlive(
  pid: number,
  start: string | null,
  table?: ProcessTable
): boolean {
  const snapshot = table ?? readProcessTable();
  if (snapshot.size > 0) {
    const entry = snapshot.get(pid);
    if (entry === undefined) return false;
    return start === null || entry.start === start;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // Only ESRCH proves the pid is gone. EPERM means it exists under
    // another identity or a sandbox denies the probe, and reading that as
    // dead let a live lock holder or owner be stolen (review live16) —
    // the same rule every other `processAlive` in codemux follows.
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/** Our own identity for `owner_pid`/`owner_start`. */
export function currentProcessIdentity(): { pid: number; start: string | null } {
  const table = readProcessTable();
  return { pid: process.pid, start: table.get(process.pid)?.start ?? null };
}

/** Resolve symlinked ancestors away: realpath the deepest existing
 * ancestor and re-attach the not-yet-existing tail (ceiling.ts resolves
 * tool targets with the same walk). Symlinked system ancestors are the
 * normal case for a real home — macOS `/var -> /private/var`, Linux
 * `/home -> /data/home` — so the registry resolves them instead of
 * refusing; every registry open then names the real directory, and a
 * later re-link of the friendly spelling cannot redirect it. Unlike the
 * ceiling's resolver this keeps the on-disk spelling (no NFC
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

export interface LockHandle {
  path: string;
  release(): void;
}

/** Serialize writers through held lock files carrying pid + start token,
 * stolen only when that holder is dead — staleness is liveness, not
 * age. The lock is seconds-scoped (bounded retries), per write. The
 * retry sleep is a synchronous Atomics.wait (registry updates are
 * synchronous), so a waiting acquisition blocks the caller's event loop
 * for the whole budget; `attempts: 1` never sleeps — one sweep, fail
 * fast — which is what every caller on a live event path owes (the
 * turn-path touch, review live13). */
export interface LockOptions {
  attempts?: number;
  retryMs?: number;
}

/** A held file's state for this lock, judged from its own payload. */
type HeldState = "dead" | "live" | "unknown" | "gone";

/** The held-file namespace for one lock: files named
 * `.<lock-base>.<pid>.<salt>.held` in the lock's directory. Every name
 * is unique per acquisition (pid plus random salt), so a name read and
 * verified dead stays safe to unlink forever after — no successor can
 * ever occupy it. */
function heldLockNames(dir: string, base: string): string[] {
  const prefix = `.${base}.`;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return names.filter((name) => {
    if (!name.startsWith(prefix) || !name.endsWith(".held")) return false;
    const middle = name.slice(prefix.length, name.length - ".held".length);
    return /^\d+\.[0-9a-f]+$/.test(middle);
  });
}

/** The acquirer's pid, as encoded in the never-reused held name. Null
 * when the name does not carry the held-name shape. */
function heldNamePid(name: string): number | null {
  const match = /\.(\d+)\.[0-9a-f]+\.held$/.exec(name);
  if (match === null) return null;
  const pid = Number(match[1]);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

/** Judge one held file by its payload: two lines, pid and start token.
 * A payload that cannot be judged (junk, or a corpse emptied by a write
 * that died mid-flight) falls back to the pid in the name — the name is
 * never handed out twice, so a dead name-pid can only be that failed
 * acquisition's leftover, which is stealable (review live14; pre-fix
 * such a file blocked every registry write until deleted by hand). A
 * live name-pid, or an unreadable file, stays `unknown` — never stolen
 * (fail closed); a vanished file is `gone`. */
function heldLockState(dir: string, name: string): HeldState {
  let text: string;
  try {
    text = readUtf8FileBounded(join(dir, name), {
      maxBytes: 4096,
      label: "session registry lock",
      noFollow: true,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "gone";
    // Bytes that break the content bounds (invalid UTF-8, oversize) are
    // junk like any other unjudgeable payload: the name's pid decides
    // (review live23; they used to stay `unknown` and block every write).
    if (!(error instanceof FileContentError)) return "unknown";
    text = "";
  }
  const [pidText, startText] = text.split("\n");
  const pid = Number(pidText);
  if (Number.isInteger(pid) && pid > 0) {
    return processIdentityAlive(pid, startText?.length ? startText : null) ? "live" : "dead";
  }
  const namePid = heldNamePid(name);
  if (namePid !== null && !processIdentityAlive(namePid, null)) return "dead";
  return "unknown";
}

/** Test seam: every held file this lock currently owns, with its parsed
 * holder (null when the payload cannot be judged). */
export function listHeldLocks(
  lockPath: string
): Array<{ path: string; holder: { pid: number; start: string | null } | null }> {
  const dir = dirname(lockPath);
  const held: Array<{ path: string; holder: { pid: number; start: string | null } | null }> = [];
  for (const name of heldLockNames(dir, basename(lockPath))) {
    const path = join(dir, name);
    try {
      const text = readUtf8FileBounded(path, {
        maxBytes: 4096,
        label: "session registry lock",
        noFollow: true,
      });
      const [pidText, startText] = text.split("\n");
      const pid = Number(pidText);
      const holder = Number.isInteger(pid) && pid > 0
        ? { pid, start: startText?.length ? startText : null }
        : null;
      held.push({ path, holder });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      held.push({ path, holder: null });
    }
  }
  return held;
}

/** A dead holder's file that cannot be removed: reported with its cause
 * instead of retried as if a live writer held it (review live25). */
function stealFailure(name: string, error: unknown): Error {
  return new Error(
    `cannot remove the dead session registry lock ${name}: ${error instanceof Error ? error.message : String(error)}`
  );
}

export function acquireLock(lockPath: string, options: LockOptions = {}): LockHandle {
  const attempts = options.attempts ?? LOCK_ATTEMPTS;
  const retryMs = options.retryMs ?? LOCK_RETRY_MS;
  const dir = dirname(lockPath);
  const base = basename(lockPath);
  const identity = currentProcessIdentity();
  const payload = `${identity.pid}\n${identity.start ?? ""}\n`;
  // Steals and confirms do not consume wait budget; only waiting behind
  // a live (or unjudgeable) holder does. The spins cap bounds a sweep
  // that keeps finding stealable corpses.
  let attempt = 0;
  let spins = 0;
  while (attempt < attempts && spins < attempts * 4) {
    spins += 1;
    // Sweep every held file this lock owns. A dead holder is stolen by
    // unlinking ITS OWN never-reused name — the steal cannot remove any
    // successor's lock, because no name is ever handed out twice.
    let blocked = false;
    for (const name of heldLockNames(dir, base)) {
      const state = heldLockState(dir, name);
      if (state === "gone") continue;
      if (state === "dead") {
        try {
          unlinkSync(join(dir, name));
        } catch (error) {
          // ENOENT: another writer stole the same corpse first. The file
          // is gone, which is what the steal wanted; counting it as
          // contention failed every single-attempt touch that lost the
          // race (review live20). Any other failure is not contention
          // either: no live writer holds a dead corpse (review live25).
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw stealFailure(name, error);
        }
        continue;
      }
      blocked = true;
    }
    if (blocked) {
      attempt += 1;
      if (attempt < attempts) sleepSync(retryMs);
      continue;
    }
    // Namespace clear: claim it with a name no other acquisition can
    // ever produce.
    const ourName = join(dir, `.${base}.${identity.pid}.${randomBytes(8).toString("hex")}.held`);
    try {
      const fd = openSync(ourName, "wx", REGISTRY_FILE_MODE);
      try {
        writeSync(fd, payload);
      } finally {
        closeSync(fd);
      }
    } catch (error) {
      // The create may have succeeded with the payload unwritten — the
      // write threw (ENOSPC, EIO), or this process died between the two
      // and was retried. Remove the possibly-empty file: its unjudgeable
      // corpse would otherwise block every later write behind `unknown`
      // (review live14; the name-pid fallback in `heldLockState` is the
      // other half, for the process that never came back).
      try {
        unlinkSync(ourName);
      } catch {
        /* already gone (the create itself failed) */
      }
      // Only a name collision is contention. Any other failure (EACCES on
      // a denied directory, EROFS, ENOSPC) is thrown at once with its own
      // cause: retrying it slept the whole budget and then blamed a live
      // writer that did not exist (review live25).
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw new Error(
          `cannot create the session registry lock in ${dir}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
      attempt += 1;
      if (attempt < attempts) sleepSync(retryMs);
      continue;
    }
    // Confirm sole ownership: two writers' clear-namespace scans can
    // interleave, so the winner is decided after the create, by looking
    // again. A dead rival found here is stolen and the confirm repeats;
    // a live one wins and we release and wait.
    let conflict = false;
    for (;;) {
      const rivals = heldLockNames(dir, base).filter((name) => join(dir, name) !== ourName);
      if (rivals.length === 0) break;
      conflict = false;
      let stole = false;
      for (const name of rivals) {
        const state = heldLockState(dir, name);
        if (state === "gone") continue;
        if (state === "dead") {
          try {
            unlinkSync(join(dir, name));
            stole = true;
          } catch (error) {
            // ENOENT: another writer stole it first, which is the same
            // outcome; the confirm repeats (review live20, the sweep's
            // sibling).
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
              try {
                unlinkSync(ourName);
              } catch {
                /* already gone */
              }
              throw stealFailure(name, error);
            }
            stole = true;
          }
          continue;
        }
        conflict = true;
      }
      if (conflict || !stole) break;
    }
    if (!conflict) {
      return {
        path: ourName,
        release: () => {
          try {
            unlinkSync(ourName);
          } catch {
            // Already gone; the never-reused name cannot be anyone
            // else's lock, so there is nothing left to clean up.
          }
        },
      };
    }
    // A live rival won the race: release our claim and wait behind it,
    // jittered so two racers do not lockstep through every retry.
    try {
      unlinkSync(ourName);
    } catch {
      /* already gone */
    }
    attempt += 1;
    if (attempt < attempts) sleepSync(retryMs + Math.floor(Math.random() * retryMs));
  }
  throw new Error(`the session registry lock ${lockPath} is held by a live writer`);
}

/** Write the whole payload and flush it to disk before the rename: a
 * single `writeSync` may write part of a large payload, and without the
 * fsync a crash after the rename can leave an empty or torn registry
 * (review live18). */
function writeAndSync(fd: number, payload: string): void {
  writeFileSync(fd, payload);
  fsyncSync(fd);
}

/** Atomic replace: write a 0600 temp file in the registry directory,
 * flush it, revalidate the directory between temp-write and rename (same
 * identity), then rename over the target. Any failure after the temp
 * file exists removes it before the error propagates (review live18 — a
 * failed write such as ENOSPC left it behind). `writePayload` is a test
 * seam for that failure. */
export function writeRegistryAtomic(
  path: string,
  payload: string,
  writePayload: (fd: number, payload: string) => void = writeAndSync
): void {
  const dir = dirname(path);
  const before = statSync(dir);
  const temp = join(dir, `.${basename(path)}.${process.pid}.tmp`);
  let fd: number;
  try {
    fd = openSync(temp, "wx", REGISTRY_FILE_MODE);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EEXIST") throw error;
    unlinkSync(temp);
    fd = openSync(temp, "wx", REGISTRY_FILE_MODE);
  }
  try {
    try {
      writePayload(fd, payload);
    } finally {
      closeSync(fd);
    }
    const after = statSync(dir);
    if (after.dev !== before.dev || after.ino !== before.ino) {
      throw new Error("the registry directory changed during the write");
    }
    // rename(2) replaces atomically; the mode travels with the temp file.
    renameSync(temp, path);
  } catch (error) {
    try {
      unlinkSync(temp);
    } catch {
      /* already gone */
    }
    throw error;
  }
}
