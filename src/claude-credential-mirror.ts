/**
 * The Claude credential mirror copy a project-settings run or session
 * places in its private config directory: an access-token-only mirror,
 * read without following links and bounded, written through the safe
 * private-file path; a missing mirror removes any copy a previous run
 * left. Split from claude-project-config.ts for the 500-line ceiling;
 * that module re-exports copyClaudeCredentialMirror.
 */
import { closeSync, constants as fsConstants, fstatSync, lstatSync, openSync, readSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { claudeOauthObject, credentialTextCarriesRefreshToken } from "./credentials.js";
import { writePrivateFile } from "./private-write.js";

/** The credential mirror's read bound: the mirror is a file the sandboxed
 * child can write, and this module's threat model treats ~/.claude as
 * child-writable, so a prior run's child could have inflated it. A real
 * credential object is small JSON (a few KiB); 64 KiB is far above it and
 * the read never exceeds the bound. */
const MIRROR_READ_LIMIT_BYTES = 64 * 1024;

/** No operator login means no credential in the private directory: a copy
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
 * Writes the credential mirror's `claudeAiOauth` into the private directory
 * so a sandboxed child can authenticate: the sandbox cannot reach the
 * Keychain, and the redirected config directory means the default mirror is
 * no longer read. The mirror is read ONCE, as bytes: the check and the copy
 * decide on that one buffer, so a mirror swapped between two reads cannot
 * hand the copy content the check never saw. A mirror that carries a
 * refresh token refuses the run — the mirror rule (credentials.ts): a
 * child holding that token could revoke the operator's login — and so does
 * a mirror that is not a parseable credential object: nothing unparseable
 * is copied, and so does a mirror whose bytes are not valid UTF-8: a lossy
 * decode would copy a different token than the one the mirror holds.
 * No mirror at all copies nothing; the harness then reports its
 * own authentication failure, exactly as a plain sandboxed run without one
 * does. A mirror that is not a regular file — a symlink first of all —
 * refuses the run instead of being read through (the sync path's rule,
 * credentials/sync.ts; review round 15, edges 1). The copy is BUILT, never the file copied (review round 13): the
 * file Claude Code keeps also holds co-stored `mcpOAuth` entries, each with
 * its own refresh token, and a project-settings child reads whatever lands
 * in its config directory. Nothing but the access-only `claudeAiOauth`
 * object is ever written into a private directory, mode 0600, never
 * through an existing entry (writePrivateFile): a resumed session's
 * directory was writable by the previous harness child, so a planted
 * symlink at `.credentials.json` must refuse the resume, not follow it.
 */
export function copyClaudeCredentialMirror(
  configDir: string,
  mirrorPath: string,
  /** The launch a refusal names; --harness-home sessions pass their own. */
  run = "--experiment-project-settings run"
): void {
  // lstat, never stat — the sync path's rule (credentials/sync.ts): a
  // symlink at the mirror path is not read through, whatever it points at
  // (review round 15, edges 1). A non-regular mirror (a link, a device
  // node) is refused the same way.
  let info;
  try {
    info = lstatSync(mirrorPath);
  } catch (error) {
    // Only a missing mirror means "no operator login" (round 20, minor
    // 16): any other stat failure — permissions, an unreadable parent —
    // refuses with its own message instead of silently running without
    // a credential the operator believes this run carries.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      removeStaleCredentialCopy(configDir);
      return; // no mirror: this run carries no operator login
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
      return; // the mirror vanished: no login to copy
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
  if (credentialTextCarriesRefreshToken(text)) {
    throw new Error(
      `claude: the credential mirror at ${mirrorPath} holds a refresh token; refusing the ` +
        `${run} (a child holding that token could revoke your ` +
        "Claude login). One plain sandboxed claude run scrubs it, then retry."
    );
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
  writePrivateFile(configDir, ".credentials.json", `${JSON.stringify({ claudeAiOauth: oauth })}\n`);
}
