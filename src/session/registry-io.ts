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
  readdirSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { FileContentError, readUtf8FileBounded } from "../file-io.js";
import { openStagingSync, renameIntoPlaceSync, writeAndFlushSync } from "../fs-durable.js";
import { MAX_PID, pidProbeAlive, readProcessTable, type ProcessTable } from "../process-table.js";

export { REGISTRY_FILE_MODE, registryPlacementProblem, resolveRegistryPath } from "./registry-placement.js";
import { REGISTRY_FILE_MODE } from "./registry-placement.js";

export const REGISTRY_DIR_MODE = 0o700;
export const LOCK_RETRY_MS = 250;
export const LOCK_ATTEMPTS = 40;

/** The lock's own contention failure: the wait budget ran out behind a
 * live (or unjudgeable) writer. Typed so `updateRegistry` can classify
 * the update as busy — the one transient class the off-stream session
 * start retries — instead of guessing from the message (review round
 * 341). */
export class LockBusyError extends Error {
  constructor(lockPath: string) {
    super(`the session registry lock ${lockPath} is held by a live writer`);
    this.name = "LockBusyError";
  }
}

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
 * way the residual is the pid-reuse window. A caller that checks many
 * identities in one pass (prune) may hand in one snapshot instead of one
 * process enumeration each inside the writer lock (review live13). */
export function processIdentityAlive(
  pid: number,
  start: string | null,
  table?: ProcessTable
): boolean {
  // A pid no kernel assigns is never live (the probe would read it as alive, round 93).
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid > MAX_PID) return false;
  const snapshot = table ?? readProcessTable();
  if (snapshot.size > 0) {
    const entry = snapshot.get(pid);
    if (entry === undefined) return false;
    return start === null || entry.start === start;
  }
  // The shared probe: success or EPERM is alive, only ESRCH is gone
  // (review live16); the range gate above keeps every probed pid
  // signalable, so no other error can occur.
  return pidProbeAlive(pid);
}

/** Our own identity for `owner_pid`/`owner_start`. */
export function currentProcessIdentity(): { pid: number; start: string | null } {
  const table = readProcessTable();
  return { pid: process.pid, start: table.get(process.pid)?.start ?? null };
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

/** Held files this process created but could not remove at release time
 * (review round 115). Their never-reused names carry this process's own
 * pid, so they can never be a rival's lock; every later acquisition
 * retries them, and the sweep and the confirm below skip what is still
 * unremovable instead of waiting behind "a live writer" that is us. */
const leftoverLocks = new Set<string>();

/** Remove one held file, tolerating ENOENT (already gone — the
 * never-reused name cannot be anyone else's lock) and retrying any other
 * failure once. Returns the errno code when the file is still there, or
 * `UNKNOWN` for a failure that carries none: `undefined` means removed
 * and nothing else (review round 121). */
function unlinkHeldFile(path: string): string | undefined {
  let code = "UNKNOWN";
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      unlinkSync(path);
      return undefined;
    } catch (error) {
      const errno = (error as NodeJS.ErrnoException).code;
      if (errno === "ENOENT") return undefined;
      code = typeof errno === "string" && errno !== "" ? errno : "UNKNOWN";
    }
  }
  return code;
}

/** Retry a leftover of ours; forget it once it is gone. */
function retryLeftover(path: string): void {
  if (unlinkHeldFile(path) === undefined) leftoverLocks.delete(path);
}

export function acquireLock(lockPath: string, options: LockOptions = {}): LockHandle {
  const attempts = options.attempts ?? LOCK_ATTEMPTS;
  const retryMs = options.retryMs ?? LOCK_RETRY_MS;
  const dir = dirname(lockPath);
  const base = basename(lockPath);
  // Our own leftovers first: they block nothing once removed, and the
  // sweep below would otherwise read ours as a live holder (review 115).
  for (const leftover of leftoverLocks) retryLeftover(leftover);
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
      const path = join(dir, name);
      // One of our own unremovable leftovers is not a rival: retry it
      // and move on whether or not it went away (review round 115).
      if (leftoverLocks.has(path)) {
        retryLeftover(path);
        continue;
      }
      const state = heldLockState(dir, name);
      if (state === "gone") continue;
      if (state === "dead") {
        try {
          unlinkSync(path);
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
      // openStagingSync states 0600 on the descriptor: the open mode is
      // masked by the umask, and a masked lock file is one a hardened
      // umask could wedge behind unremovable permissions (round 401, 1).
      const fd = openStagingSync(ourName, REGISTRY_FILE_MODE);
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
        const path = join(dir, name);
        // Our own leftover is never the conflict that loses the race;
        // retry it and let the confirm succeed (review round 115).
        if (leftoverLocks.has(path)) {
          retryLeftover(path);
          continue;
        }
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
          // Only ENOENT means the lock is already gone. Any other failure
          // leaves the file as this process's leftover — remembered for
          // the next acquisition's retry and reported once, never the
          // full path. The release still does not throw: the update that
          // reached it has already written the registry file, so its
          // outcome stays a success (review round 115).
          const failure = unlinkHeldFile(ourName);
          if (failure === undefined) return;
          leftoverLocks.add(ourName);
          console.error(
            `codemux: could not remove the session registry lock ${basename(ourName)} ` +
              `(${failure}); it is retried on the next registry update`
          );
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
  throw new LockBusyError(lockPath);
}

/** Atomic replace: write a 0600 temp file in the registry directory,
 * flush it, revalidate the directory between temp-write and rename (same
 * identity), then rename over the target. The temp's mode is stated on
 * the descriptor (openStagingSync), so the published registry is 0600
 * whatever the umask (round 401, item 1). Any failure after the temp
 * file exists removes it before the error propagates (review live18 — a
 * failed write such as ENOSPC left it behind). `writePayload` is a test
 * seam for that failure. */
export function writeRegistryAtomic(
  path: string,
  payload: string,
  writePayload: (fd: number, payload: string) => void = writeAndFlushSync
): void {
  const dir = dirname(path);
  const before = statSync(dir);
  const temp = join(dir, `.${basename(path)}.${process.pid}.tmp`);
  let fd: number;
  try {
    fd = openStagingSync(temp, REGISTRY_FILE_MODE);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EEXIST") throw error;
    unlinkSync(temp);
    fd = openStagingSync(temp, REGISTRY_FILE_MODE);
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
    renameIntoPlaceSync(temp, path);
  } catch (error) {
    try {
      unlinkSync(temp);
    } catch {
      /* already gone */
    }
    throw error;
  }
}
