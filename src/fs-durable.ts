/**
 * The staging-file discipline every rename-published file owes its
 * readers: create exclusively, state the mode on the descriptor, write
 * the whole payload, fsync it, and publish by rename. Two rules live here
 * because two modules share them (the session registry's atomic replace
 * and the credential mirror's rewrite, review round 401, items 1 and 6):
 * the open mode is masked by the process umask, so the mode is fchmod'd
 * on the descriptor after the open — the mode is stated whatever the
 * umask is — and a rename without a preceding fsync can publish a torn
 * file after a crash or power loss, which the next reader then has to
 * treat as corrupt.
 */

import {
  closeSync,
  constants,
  fchmodSync,
  fsyncSync,
  openSync,
  renameSync,
  writeFileSync,
  writeSync,
} from "node:fs";

/** Host seam: tests swap members to observe the fsync-before-rename
 * order, to interleave a directory swap between the staged write and the
 * rename, and to inject failures. The members are captured once, so a
 * spy on the node:fs namespace does not reach them — swap the object. */
export const durableFs = {
  openSync,
  fchmodSync,
  writeSync,
  writeFileSync,
  fsyncSync,
  closeSync,
  renameSync,
};

const NOFOLLOW = process.platform !== "win32" ? constants.O_NOFOLLOW : 0;

/** Open a fresh staging file whose mode is stated, whatever the umask is:
 * O_EXCL refuses anything already at the name, O_NOFOLLOW (asked for)
 * refuses a symlink planted there, and the fchmod on the descriptor puts
 * the mode beyond the umask's reach. Returns the open descriptor. */
export function openStagingSync(path: string, mode: number, noFollow = false): number {
  const flags =
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (noFollow ? NOFOLLOW : 0);
  const fd = durableFs.openSync(path, flags, mode);
  try {
    durableFs.fchmodSync(fd, mode);
  } catch (error) {
    // Ownership transfers only after the mode is set. Preserve that failure
    // even if closing the descriptor also fails.
    try { durableFs.closeSync(fd); } catch { /* Preserve the permission error. */ }
    throw error;
  }
  return fd;
}

/** Write the whole payload and flush it to disk on an open descriptor:
 * a single `write` may write part of a large payload, and without the
 * fsync a crash after the rename can leave an empty or torn file. */
export function writeAndFlushSync(fd: number, payload: string | Uint8Array): void {
  durableFs.writeFileSync(fd, payload);
  durableFs.fsyncSync(fd);
}

/** The whole discipline in one call for a caller that publishes right
 * after: stage exclusively, state the mode, write, fsync, close. The
 * rename stays with the caller, where its own revalidation belongs. */
export function stageExclusiveSync(
  path: string,
  bytes: string | Uint8Array,
  mode: number,
  noFollow = false
): void {
  const fd = openStagingSync(path, mode, noFollow);
  try {
    writeAndFlushSync(fd, bytes);
  } finally {
    durableFs.closeSync(fd);
  }
}

/** Write or replace a file codemux owns in place, with its mode stated on
 * the descriptor: O_NOFOLLOW refuses a symlink planted at the name and
 * O_TRUNC replaces the previous content (a profile file the run rewrites,
 * such as kimi's agent file). Not atomic: for a reader that must never
 * see a partial file, stage and rename instead. */
export function writeOwnedSync(path: string, bytes: string | Uint8Array, mode: number): void {
  const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | NOFOLLOW;
  const fd = durableFs.openSync(path, flags, mode);
  try {
    durableFs.fchmodSync(fd, mode);
    durableFs.writeFileSync(fd, bytes);
  } finally {
    durableFs.closeSync(fd);
  }
}

/** Publish a staged file by rename: atomic on POSIX, so a reader sees
 * either the old file or the whole new one. Through the seam, so a test
 * can prove the fsync happened first. */
export function renameIntoPlaceSync(from: string, to: string): void {
  durableFs.renameSync(from, to);
}
