/**
 * Safe writes of codemux-owned files into a private run or session
 * directory.
 *
 * The directories this serves (a run's or session's private
 * CLAUDE_CONFIG_DIR, a session's CODEX_HOME) are writable by the sandboxed
 * harness child that runs beside them, so an existing entry at a path
 * codemux writes may be a symlink the child planted: a plain
 * `writeFileSync` follows it and truncates whatever it names — the write
 * escapes the private directory (review round 3, contracts-2 finding 1).
 *
 * Every write therefore re-asserts the directory, refuses an existing
 * entry that is not a regular file owned by the current user, and lands
 * through a fresh exclusively-created temp file (its mode stated on the
 * descriptor, whatever the umask) renamed over the name: `rename`
 * replaces a symlink itself, never follows it. The directory's identity
 * (dev and ino) is revalidated after the staged write and again before
 * the rename, so a same-uid writer that swaps the directory for a
 * symlink between the checks is refused instead of handed the content
 * (review round 401, item 10). Residual: `rename` resolves the directory
 * path itself, so a swap in the last instant between the revalidation
 * and the rename can still redirect the name — node:fs offers no openat
 * to close that.
 */

import { closeSync, lstatSync, renameSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { assertTrustedDirectory } from "./hermetic-sweep.js";
import { openStagingSync, writeAndFlushSync } from "./fs-durable.js";

/** The identity a directory revalidation compares: anything but the same
 * inode on the same device is a different directory, whatever the path
 * says. */
interface DirectoryIdentity {
  dev: number;
  ino: number;
}

function identityOf(path: string): DirectoryIdentity {
  const stat = lstatSync(path);
  return { dev: stat.dev, ino: stat.ino };
}

function sameDirectory(a: DirectoryIdentity, b: DirectoryIdentity): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

/**
 * Writes `bytes` to `<directory>/<name>` without ever following an
 * existing entry at that path. `mode` is the file's permission bits
 * (0600 unless stated). Throws naming the path when the directory is
 * untrusted, changed during the write, or an existing entry there is a
 * symlink, not a regular file, or owned by another user — the resume
 * that hits it refuses rather than write.
 */
export function writePrivateFile(
  directory: string,
  name: string,
  bytes: string | Uint8Array,
  mode: number = 0o600
): void {
  if (!name || name === "." || name === ".." || /[\\/\0]/.test(name)) {
    throw new Error("private file name must be one path component");
  }
  assertTrustedDirectory(directory);
  const before = identityOf(directory);
  const target = join(directory, name);
  let existing;
  try {
    existing = lstatSync(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    existing = undefined;
  }
  if (
    existing !== undefined &&
    (!existing.isFile() ||
      (process.platform !== "win32" &&
        typeof process.getuid === "function" &&
        existing.uid !== process.getuid()))
  ) {
    throw new Error(
      `refusing to write ${target}: it is not a regular file owned by this user ` +
        "(a symlink or foreign entry the previous harness child could have planted); the run or resume is refused"
    );
  }
  const temp = join(directory, `.${name}.${randomBytes(6).toString("hex")}.tmp`);
  try {
    const fd = openStagingSync(temp, mode, true);
    try {
      // Before any byte lands: the exclusive open above resolved the
      // directory path, so a swap ahead of it must be caught here.
      if (!sameDirectory(identityOf(directory), before)) {
        throw new Error(
          `refusing to write ${target}: the directory changed during the staging open; nothing was written`
        );
      }
      writeAndFlushSync(fd, bytes);
    } finally {
      closeSync(fd);
    }
    if (!sameDirectory(identityOf(directory), before)) {
      throw new Error(
        `refusing to write ${target}: the directory changed during the write; nothing was written`
      );
    }
    renameSync(temp, target);
  } catch (error) {
    // Best effort by path: an unswapped directory still holds the temp,
    // and one swapped after the staged write keeps it with the stolen
    // directory itself — no rename into the replacement ever happened.
    rmSync(temp, { force: true });
    throw error;
  }
}
