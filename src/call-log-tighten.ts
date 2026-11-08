/**
 * Permission tightening for the call ledger, split from the append in
 * call-log.ts (which sat at the 500-line cap). The old helpers lstat'd
 * the path and chmod'd the path; a symlink swapped in between was
 * chmod'd through, stripping permissions from whatever it named — what
 * the comment claimed could not happen (review round 401, item 10). The
 * mode is now applied to the OPEN DESCRIPTOR: the open refuses a final
 * symlink (O_NOFOLLOW; O_DIRECTORY for the directory) and fchmodSync
 * pins the change to the inode that was inspected, so a swapped link is
 * never chmod'd through. The mode is stated in full (0600, 0700), not
 * merely narrowed: a umask that strips the owner-write bit (0277) would
 * otherwise leave the ledger 0400 in a 0500 directory, and the next
 * append would fail to open its own file. Residual: the reopen is
 * O_RDONLY, so a umask that strips the owner-read bit (0400 set) leaves
 * the created mode as is (0200, 0300); appends still succeed, and the
 * reader reports the EACCES when `codemux calls` opens the ledger. A
 * failure to tighten never reaches the caller — the record is already
 * on disk by the time the file is tightened.
 */

import { closeSync, constants, fchmodSync, fstatSync, openSync } from "node:fs";

const NOFOLLOW = process.platform !== "win32" ? constants.O_NOFOLLOW : 0;
const ODIRECTORY = constants.O_DIRECTORY ?? 0;
// O_NONBLOCK keeps a FIFO swapped in for the entry from blocking the
// open (the append's own open uses it for the same reason).
const ONONBLOCK = constants.O_NONBLOCK ?? 0;

/** Tightens one directory codemux owns: one this append just created, or
 * the default state directory. An entry that is not a real directory —
 * a symlink included — is refused by the open, so permissions are never
 * stripped from a link's target, and any failure is swallowed: the
 * append that follows must proceed even where tightening cannot succeed
 * (a shared directory such as /tmp, review ul2). */
export function tightenDirectory(path: string, owned: boolean): void {
  if (!owned) return;
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | ODIRECTORY | NOFOLLOW | ONONBLOCK);
  } catch {
    return;
  }
  try {
    if (!fstatSync(fd).isDirectory()) return;
    fchmodSync(fd, 0o700);
  } catch {
    // Tightening is hygiene; the append below proceeds regardless.
  } finally {
    closeSync(fd);
  }
}

/** Same rule for the file: the open refuses a final symlink and the
 * fchmod lands on the inspected inode; a failure to tighten never
 * reaches the caller. */
export function tightenFile(path: string): void {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | NOFOLLOW | ONONBLOCK);
  } catch {
    return;
  }
  try {
    if (!fstatSync(fd).isFile()) return;
    fchmodSync(fd, 0o600);
  } catch {
    // The record is already on disk; loose file permissions are the
    // operator's to fix, not a reason to warn or fail.
  } finally {
    closeSync(fd);
  }
}
