/**
 * The non-macOS Claude credential copy a project-settings run or session
 * places in its private config directory: an access-token-only copy,
 * read without following links and bounded, written through the safe
 * private-file path; a missing mirror removes any copy a previous run
 * left. Split from claude-project-config.ts for the 500-line ceiling;
 * that module re-exports copyClaudeCredentialMirror.
 */
import { closeSync, constants as fsConstants, fstatSync, lstatSync, openSync, readSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { claudeOauthObject } from "./credentials.js";
import { writePrivateFile } from "./private-write.js";

/** The credential mirror's read bound: the mirror is a file the sandboxed
 * child can write, and this module's threat model treats ~/.claude as
 * child-writable, so a prior run's child could have inflated it. A real
 * credential object is small JSON (a few KiB); 64 KiB is far above it and
 * the read never exceeds the bound. */
const MIRROR_READ_LIMIT_BYTES = 64 * 1024;

/** An absent source means no credential copy in the private directory: a copy
 * a previous run of this persistent session left there would hand the
 * resumed child a token the operator has since logged out of or removed
 * (round 31, edges 1). Unlinked without following: the entry itself goes,
 * whatever it is; a missing entry is the expected state. */
function removeStaleCredentialCopy(configDir: string): void {
  const stale = join(configDir, ".credentials.json");
  try {
    unlinkSync(stale);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new Error(`claude: cannot remove the stale credential copy at ${stale}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * On non-macOS platforms, read once and copy only claudeAiOauth without
 * refresh capability or co-stored MCP credentials. Bound the read and reject
 * links, irregular files, malformed JSON, and invalid UTF-8. Private writes
 * refuse planted destination symlinks. The operator's source is never changed.
 * macOS returns before any file operation; Claude uses its native store.
 */
export function copyClaudeCredentialMirror(
  configDir: string,
  mirrorPath: string,
  /** The launch a refusal names; --harness-home sessions pass their own. */
  run = "--experiment-project-settings run",
  platform = process.platform
): void {
  // macOS uses Claude's native store directly. Do not even inspect the file.
  if (platform === "darwin") return;
  // lstat, never stat: a
  // symlink at the mirror path is not read through, whatever it points at
  // (review round 15, edges 1). A non-regular mirror (a link, a device
  // node) is refused the same way.
  let info;
  try {
    info = lstatSync(mirrorPath);
  } catch (error) {
    // Only a missing source means there is no file to copy:
    // any other stat failure — permissions, an unreadable parent —
    // refuses with its own message instead of silently running without
    // a credential the operator believes this run carries.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      removeStaleCredentialCopy(configDir);
      return;
    }
    throw new Error(
      `claude: cannot read the credential mirror at ${mirrorPath}: ` +
        (error instanceof Error ? error.message : String(error))
    );
  }
  const refuseIrregularMirror = (): Error =>
    new Error(
      `claude: the credential mirror at ${mirrorPath} is not a regular file; refusing the ` +
        `${run} (a symlinked mirror is never read through)`
    );
  if (!info.isFile()) throw refuseIrregularMirror();
  // One read feeds both the check and the write: a second read could see a
  // different file (a swap between the two), and what is checked must be
  // exactly what is copied. The descriptor itself refuses a link
  // (O_NOFOLLOW, ELOOP), so a swap between the lstat above and this open
  // still cannot be read through.
  let text: string;
  let fd: number | null = null;
  // The oversize and invalid-encoding refusals, kept by reference so the
  // catch below rethrows them verbatim instead of re-wrapping them as read
  // failures.
  let oversize: Error | null = null;
  let invalid: Error | null = null;
  try {
    // O_NONBLOCK beside O_NOFOLLOW: a FIFO planted between the lstat above
    // and this open would otherwise block the open itself, before any
    // timeout exists (round 33, edges 1); the descriptor is then judged by
    // fstat, and anything but a regular file refuses.
    fd = openSync(mirrorPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
    // The read is bounded: the mirror is a file the sandboxed child can
    // write, so a prior run's child could have inflated it. The bound is
    // far above every real credential object (small JSON, a few KiB).
    const stated = fstatSync(fd);
    if (!stated.isFile()) {
      throw new Error(`claude: the credential mirror at ${mirrorPath} is not a regular file; refusing the ${run}`);
    }
    if (stated.size > MIRROR_READ_LIMIT_BYTES) {
      oversize = new Error(
        `claude: the credential mirror at ${mirrorPath} is ${stated.size} bytes, over the ` +
          `${MIRROR_READ_LIMIT_BYTES}-byte read bound; refusing the ${run}`
      );
      throw oversize;
    }
    const buffer = Buffer.alloc(stated.size);
    let offset = 0;
    while (offset < buffer.length) {
      const read = readSync(fd, buffer, offset, buffer.length - offset, offset);
      if (read === 0) break;
      offset += read;
    }
    // Decoded fatally, never with replacement characters (review round
    // 104): a lossy decode turns an invalid byte inside a JSON string into
    // U+FFFD, which still parses and would be copied as a DIFFERENT token
    // than the one the mirror holds. The refusal never names the content.
    try {
      text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
        buffer.subarray(0, offset)
      );
    } catch {
      invalid = new Error(
        `claude: the credential mirror at ${mirrorPath} is not valid UTF-8; refusing the ` +
          run
      );
      throw invalid;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      removeStaleCredentialCopy(configDir);
      return; // the source vanished: no file to copy
    }
    if (oversize !== null && error === oversize) throw oversize;
    if (invalid !== null && error === invalid) throw invalid;
    // The refusal keeps, but the reason names what actually failed — an
    // open or read error (EACCES, EIO, a loop) is not a regularity
    // finding; the lstat above owns those.
    const reason = (error as NodeJS.ErrnoException).code
      ?? (error instanceof Error ? error.message : String(error));
    throw new Error(
      `claude: could not read the credential mirror at ${mirrorPath} (${reason}); ` +
        `refusing the ${run}`
    );
  } finally {
    if (fd !== null) closeSync(fd);
  }
  const oauth = claudeOauthObject(text);
  if (oauth === null) {
    throw new Error(
      `claude: the credential mirror at ${mirrorPath} is not a parseable credential object; ` +
        `refusing the ${run} (nothing unparseable is copied into ` +
        "the private config directory)"
    );
  }
  // Only the parsed `claudeAiOauth` object is re-serialized into the copy:
  // every other top-level key the mirror carries (co-stored `mcpOAuth`
  // entries with their own refresh tokens) never reaches the private
  // directory, whatever the file holds.
  const { refreshToken: _refresh, refreshTokenExpiresAt: _expiry, ...accessOnly } = oauth;
  writePrivateFile(configDir, ".credentials.json", `${JSON.stringify({ claudeAiOauth: { ...accessOnly, refreshToken: "" } })}\n`);
}
