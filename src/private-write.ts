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
 * through a fresh exclusively-created temp file renamed over the name:
 * `rename` replaces a symlink itself, never follows it (the same contract
 * writeCodexProviderConfigInto applies to config.toml).
 */

import { lstatSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { assertTrustedDirectory } from "./hermetic-sweep.js";

/**
 * Writes `bytes` to `<directory>/<name>` without ever following an
 * existing entry at that path. `mode` is the file's permission bits
 * (0600 unless stated). Throws naming the path when the directory is
 * untrusted or an existing entry there is a symlink, not a regular
 * file, or owned by another user — the resume that hits it refuses
 * rather than write.
 */
export function writePrivateFile(
  directory: string,
  name: string,
  bytes: string | Uint8Array,
  mode: number = 0o600
): void {
  assertTrustedDirectory(directory);
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
    writeFileSync(temp, bytes, { mode, flag: "wx" });
    renameSync(temp, target);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}
