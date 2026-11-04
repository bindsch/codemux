// The mirror write engine and its backups: the atomic credential-file
// rewrite every mirror change goes through, and the refresh-token copies
// kept where the sandbox cannot read them. src/credentials.ts owns the
// mirror lifecycle and re-exports this.

import {
  chmodSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
  lstatSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

import { readUtf8FileBounded } from "../file-io.js";
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
function backupCredential(backupDir: string, current: string): string | null {
  if (backupDir === "") return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  backupSequence += 1;
  const backup = join(backupDir, `credentials-${stamp}-${process.pid}-${backupSequence}.json`);
  try {
    // A redirected path (a symlink, or a file where the directory should
    // be) gets no backup and no permission change: following it would
    // write the refresh-token copy wherever it points (review round 51).
    const existing = lstatSync(backupDir, { throwIfNoEntry: false });
    if (existing !== undefined && (existing.isSymbolicLink() || !existing.isDirectory())) return null;
    mkdirSync(backupDir, { recursive: true, mode: 0o700 });
    chmodSync(backupDir, 0o700); // an existing directory is tightened too
    writeFileSync(backup, current.endsWith("\n") ? current : `${current}\n`, { flag: "wx", mode: 0o600 });
    return backup;
  } catch {
    return null;
  }
}

/** After a rewrite succeeded, drop the backups OLDER than the one this
 * launch wrote (names start with an ISO timestamp, so they sort by age).
 * Never a newer one: a parallel launch may have written it and may still
 * need it. Never before the rename: until then the one just written is the
 * only copy the operator was told about, and a failed rewrite must leave
 * every earlier copy where it was. */
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
    if (/^credentials-.*\.json$/.test(name) && name < own) removeQuietly(join(dir, name));
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
