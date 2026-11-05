// The mirror write engine and its backups: the atomic credential-file
// rewrite every mirror change goes through, and the refresh-token copies
// kept where the sandbox cannot read them. src/credentials.ts owns the
// mirror lifecycle and re-exports this.

import {
  chmodSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
  lstatSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, parse, resolve, sep } from "node:path";

import { readUtf8FileBounded } from "../file-io.js";
import { UNREADABLE_OWNER_STALE_MS, pidProbeAlive } from "../process-table.js";
import { carriesRefreshToken, claudeOauthObject } from "./oauth.js";

/** The file's contents with only its `claudeAiOauth` field replaced by the
 * mirror of `oauth` (the Keychain's entry, or the file's own when scrubbing).
 * Everything else — notably the co-stored `mcpOAuth` state Claude Code keeps
 * in this same file — is left exactly as Claude wrote it. The caller only
 * reaches this with a file `classifyMirror` accepted, so `current` parses. */
function mergedCredential(current: string, claudeAiOauth: Record<string, unknown>): string {
  const parsed = JSON.parse(current) as Record<string, unknown>;
  return JSON.stringify({ ...parsed, claudeAiOauth });
}

/** Replace the file's `claudeAiOauth` with the mirror of `oauth`, atomically
 * (staging file + rename, 0600), re-checking immediately before the rename
 * that the WHOLE file is still exactly `current` — another writer (Claude
 * Code updating co-stored mcpOAuth, or deleting the file) must not be
 * clobbered. "conflict" means the file changed; "vanished" that it was
 * deleted (it is left deleted, never recreated); "error" that the write
 * itself failed. The residual window between the re-check and the rename is
 * microseconds, and a lost write self-heals on the next launch; nothing in
 * that window can reach the Keychain or the grant. */
/** The mirror's size bound, read and written alike: a file over it is
 * refused unread (a child-writable directory can have enlarged it), and a
 * mirror that would exceed it is never written, or the next launch could
 * not read what this one wrote (review rounds 73 and 76). */
export const MAX_CREDENTIAL_MIRROR_BYTES = 1024 * 1024;

export function writeMirror(
  target: string,
  current: string,
  claudeAiOauth: Record<string, unknown>,
  backupDir: string
): "written" | "conflict" | "vanished" | "error" {
  // A file that still carries a refresh token is backed up first, in a
  // directory the sandbox cannot see (never beside the mirror, which the
  // child reads): that token may be the operator's only working login, and
  // codemux never destroys a credential it cannot prove superseded. A
  // failed backup fails the write, which the callers turn into "unsafe".
  const merged = mergedCredential(current, claudeAiOauth);
  // The file is written with a trailing newline; the next launch reads the
  // whole file against the same bound. Judged before any backup exists, so
  // a refused write leaves no copy behind (review round 77).
  if (Buffer.byteLength(merged) + 1 > MAX_CREDENTIAL_MIRROR_BYTES) return "error";
  const existing = claudeOauthObject(current);
  let backup: string | null = null;
  if (existing !== null && carriesRefreshToken(existing)) {
    backup = backupCredential(backupDir, current);
    if (backup === null) return "error";
  }
  const staging = `${target}.${process.pid}.tmp`;
  // The backup exists for the rewrite. When the rewrite does not happen and
  // the file still holds its token (conflict, error), the copy is redundant
  // and is removed again, so repeated refusals cannot pile up copies. When
  // the file VANISHED under us the backup is the last copy and stays.
  const kept = (outcome: "written" | "conflict" | "vanished" | "error"): void => {
    if (backup === null) return;
    if (outcome === "conflict" || outcome === "error") {
      removeQuietly(backup);
      return;
    }
    console.error(
      `claude: the credential mirror held a refresh token; a copy was kept at ${backup} ` +
        (outcome === "written"
          ? "(0600, outside the sandbox) and the mirror was rewritten without it"
          : "(0600, outside the sandbox); the mirror itself was deleted meanwhile")
    );
  };
  try {
    try {
      writeFileSync(staging, `${merged}\n`, { flag: "wx", mode: 0o600 });
    } catch {
      removeQuietly(staging); // a symlink/stray entry — never a directory we own
      writeFileSync(staging, `${merged}\n`, { flag: "wx", mode: 0o600 });
    }
    let live: string;
    try {
      // The same bounded, no-follow read as every other read of the mirror:
      // a huge file or a FIFO swapped in since the first read is refused,
      // never read whole or blocked on (review round 78).
      live = readUtf8FileBounded(target, { maxBytes: MAX_CREDENTIAL_MIRROR_BYTES, label: "the Claude credential mirror", noFollow: true });
    } catch (error) {
      removeQuietly(staging);
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
        kept("vanished");
        return "vanished";
      }
      kept("error");
      return "error";
    }
    if (live !== current) {
      removeQuietly(staging);
      kept("conflict");
      return "conflict";
    }
    renameSync(staging, target);
    if (backup !== null) pruneOlderBackups(backup);
    kept("written");
    return "written";
  } catch {
    removeQuietly(staging); // never leave a staged credential behind
    kept("error");
    return "error";
  }
}

/** Where refresh-token backups go by default: under `~/Library`, which the
 * scode sandbox blocks wholesale on macOS, so no sandboxed child can read a
 * backup. Scrubs happen only where a Keychain entry exists, i.e. on macOS;
 * on any other platform there is no safe default and the backup (and so the
 * scrub) fails closed. */
export function defaultCredentialBackupDir(): string {
  if (process.platform !== "darwin") return "";
  return join(homedir(), "Library", "Application Support", "codemux", "credential-backups");
}

let backupSequence = 0;

/** Keep a copy of the file as it was before a refresh token is removed from
 * it: `<backupDir>/credentials-<timestamp>-<pid>-<n>.json`, directory 0700,
 * file 0600, created exclusively so nothing is ever overwritten. Older
 * copies are pruned only once the rewrite this copy was made for has
 * succeeded (see `pruneOlderBackups`). The operator is told where it is
 * and may delete it once the login is known good. An empty `backupDir`
 * means there is no safe place: the backup fails, and with it the scrub. */
/** Build `dir` as a chain of real directories, walked from the filesystem
 * root one component at a time: an existing component must be a real
 * directory, a missing one is created by a non-recursive mkdir (0o700) and
 * looked at again. A symbolic link refuses the backup wherever it sits —
 * below a missing component, or above components that already exist
 * (review round 111; round 110 walked only from the nearest existing
 * ancestor, and round 51 looked at the final component alone). The one
 * link accepted is a link root owns, such as macOS's `/var` and `/tmp`:
 * a process running as an unprivileged operator, a sandboxed child
 * included, cannot create one. The walk continues from that link's real
 * path, and the finished chain must resolve to exactly where it ended. */
function createPrivateDirectory(dir: string): boolean {
  try {
    if (!isAbsolute(dir)) return false;
    const absolute = resolve(dir);
    let current = parse(absolute).root;
    for (const part of absolute.slice(current.length).split(sep)) {
      if (part === "") continue;
      const candidate = join(current, part);
      if (lstatSync(candidate, { throwIfNoEntry: false }) === undefined) {
        mkdirSync(candidate, { mode: 0o700 }); // never recursive: nothing below is followed
        chmodSync(candidate, 0o700); // the mode is stated whatever the umask is
      }
      // What is on disk now decides: a link or a file that won a race for
      // the name is refused exactly as one that was there before.
      const entry = lstatSync(candidate);
      if (entry.isSymbolicLink()) {
        if (entry.uid !== 0) return false;
        current = realpathSync(candidate);
        if (!lstatSync(current).isDirectory()) return false;
        continue;
      }
      if (!entry.isDirectory()) return false;
      current = candidate;
    }
    chmodSync(current, 0o700); // an existing final directory is tightened too
    return realpathSync(dir) === current;
  } catch {
    return false;
  }
}

function backupCredential(backupDir: string, current: string): string | null {
  if (backupDir === "") return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  backupSequence += 1;
  const backup = join(backupDir, `credentials-${stamp}-${process.pid}-${backupSequence}.json`);
  // A redirected path anywhere in the chain gets no backup and no
  // permission change: following it would write the refresh-token copy
  // wherever it points.
  if (!createPrivateDirectory(backupDir)) return null;
  try {
    writeFileSync(backup, current.endsWith("\n") ? current : `${current}\n`, { flag: "wx", mode: 0o600 });
    return backup;
  } catch {
    return null;
  }
}

/** The exact name `backupCredential` writes: `credentials-<stamp>-<pid>-
 * <sequence>.json`, the stamp being the ISO time with `:` and `.` replaced
 * by `-`. Anchored, so a name of any other shape is never a prune
 * candidate. */
const BACKUP_NAME = /^credentials-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-(\d+)-\d+\.json$/;

/** After a rewrite succeeded, drop the backups OLDER than the one this
 * launch wrote (names start with an ISO timestamp, so they sort by age).
 * Never a newer one: a parallel launch may have written it and may still
 * need it. An older one written by ANOTHER LIVE PROCESS stays too: its
 * writer may not have finished its own rewrite, and deleting its backup
 * could destroy the operator's only refresh-token copy while the code
 * reports one was kept — that process prunes it once its rewrite
 * succeeds, and a later launch prunes it once the writer is gone. A
 * matching name whose pid is this process's own is always ours to drop;
 * one whose pid no kernel assigns (pidProbeAlive refuses 0, negatives,
 * and out-of-range values) reads as not alive. A name of any other shape
 * is left alone. Never before the rename: until then the one just written
 * is the only copy the operator was told about, and a failed rewrite must
 * leave every earlier copy where it was (review round 137). */
function pruneOlderBackups(backup: string): void {
  const dir = dirname(backup);
  const own = basename(backup);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    const match = BACKUP_NAME.exec(name);
    if (match === null || name >= own) continue;
    const pid = Number(match[1]);
    if (pid !== process.pid && pidProbeAlive(pid) && !olderThanAnyRun(join(dir, name))) continue;
    removeQuietly(join(dir, name));
  }
}

/** Whether a backup is older than any run lasts. A live pid in its name
 * then says nothing about its writer: the number was reused by another
 * process, and the copy would otherwise be kept for as long as that
 * process lives (review round 144). A file that cannot be read is kept. */
function olderThanAnyRun(path: string): boolean {
  try {
    return Date.now() - lstatSync(path).mtimeMs > UNREADABLE_OWNER_STALE_MS;
  } catch {
    return false;
  }
}

/** Best-effort removal of OUR staging FILE — never recursive, so a directory
 * that happens to occupy the staging path is left intact (its EISDIR is
 * swallowed), and a failed sync is never turned into an aborted launch. */
function removeQuietly(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch {
    // Cleanup is best-effort by contract.
  }
}
