// The mirror sync decision procedure: when the Keychain's Claude
// credential replaces the file's, when a refresh token is scrubbed from
// it, and which outcome the adapter acts on. src/credentials.ts owns the
// mirror lifecycle and re-exports this.

import { lstatSync, readFileSync, statSync } from "node:fs";
import { dirname } from "node:path";

import {
  accessTokenLive,
  carriesRefreshToken,
  claudeOauth,
  claudeOauthObject,
  hasUsableToken,
  mirrorCredential,
  readKeychainSecret,
  scrubbedCredential,
  type SecretReadResult,
  type SecretReader,
} from "./oauth.js";
import { defaultCredentialBackupDir, writeMirror } from "./backups.js";

/** Every key Claude Code writes under `claudeAiOauth` in the on-disk stub.
 * A stub carrying any other key is not overwritten: it is either some other
 * program's state under Claude's key, or a Claude Code newer than this
 * codemux knows, and either way the operator is told (see "unrecognized"
 * below) rather than having the object replaced or the launch fail
 * silently. */
const CLAUDE_STUB_KEYS = new Set([
  "accessToken",
  "refreshToken",
  "expiresAt",
  "scopes",
  "subscriptionType",
  "rateLimitTier",
  "refreshTokenExpiresAt",
]);

type MirrorClass =
  | { kind: "mirror"; oauth: Record<string, unknown> }
  | { kind: "foreign" }
  | { kind: "unrecognized" };

/** Classify a file's `claudeAiOauth` value. It is a mirror when it carries a
 * usable token (the 0.5.0 rule), or when it is the stub Claude Code 2.1.25x
 * leaves on disk once the Keychain owns the credential — string
 * `accessToken` and `refreshToken` both present (emptied), a numeric
 * `expiresAt`, a `scopes` array, and no key outside `CLAUDE_STUB_KEYS`.
 * That stub is a stale mirror to refresh, not a foreign file. The same
 * fields with an unknown key alongside are "unrecognized": left alone and
 * warned about. Anything else under the key (an array, an object for some
 * other provider, an emptied token without the rest of the stub) is foreign
 * and left alone silently, as in 0.5.0. The Keychain side (`claudeOauth`)
 * demands the usable token only. */
export function classifyMirror(blob: string): MirrorClass {
  const oauth = claudeOauthObject(blob);
  if (oauth === null) return { kind: "foreign" };
  if (hasUsableToken(oauth)) return { kind: "mirror", oauth };
  const isStub =
    typeof oauth.accessToken === "string" &&
    typeof oauth.refreshToken === "string" &&
    typeof oauth.expiresAt === "number" &&
    Array.isArray(oauth.scopes);
  if (!isStub) return { kind: "foreign" };
  const known = Object.keys(oauth).every((key) => CLAUDE_STUB_KEYS.has(key));
  return known ? { kind: "mirror", oauth } : { kind: "unrecognized" };
}

export type SyncOutcome =
  | "synced" // the mirror was refreshed from the Keychain
  | "current" // the mirror already holds the Keychain's Claude credential
  | "foreign" // the file exists but is not a Claude credential mirror we manage
  | "unrecognized" // Claude's emptied stub, but with keys this codemux does not know: left alone, warned about
  | "absent" // no mirror file to refresh (feature does not apply here)
  | "missing" // no usable Keychain credential to mirror
  | "skipped" // disabled via CODEMUX_NO_KEYCHAIN_SYNC
  | "failed" // nothing usable could be delivered: the adapter warns, the launch proceeds
  | "unsafe"; // the mirror still carries a refresh token and could not be scrubbed: refuse the launch

/**
 * Refresh the `claudeAiOauth` field of an EXISTING credential file from the
 * Keychain — access token only — and make sure no refresh token is left in
 * it. See the module header for the rules. Only that one field is ever read
 * or written; the rest of Claude's file is left untouched. The caller warns
 * on "failed" (a silently stale mirror is the exact 401 this exists to
 * prevent) and refuses the launch on "unsafe" (a refresh token the child
 * could reach and that could not be removed safely). `options.backupDir` is
 * where a refresh-token-carrying file is copied before the token goes.
 */
export interface SyncOptions {
  /** Where a file that still carries a refresh token is copied before the
   * token is removed. Defaults to a directory the scode sandbox does not
   * expose (see `defaultCredentialBackupDir`); tests point it elsewhere. */
  backupDir?: string;
}

export function syncKeychainCredential(
  service: string,
  target: string,
  readSecret: SecretReader = readKeychainSecret,
  options: SyncOptions = {}
): SyncOutcome {
  const backupDir = options.backupDir ?? defaultCredentialBackupDir();
  // The escape hatch means "do not consult the Keychain", and without the
  // Keychain codemux cannot tell a mirror (scrub it) from Claude Code's only
  // store (leave it alone), so it neither scrubs nor refuses: the file is
  // left exactly as it is, and the operator who set the hatch owns what is
  // in it. The adapter says so when the file carries a refresh token.
  if (process.env.CODEMUX_NO_KEYCHAIN_SYNC === "1") return "skipped";

  // Only refresh a mirror that already exists: the bug is a stale file, so
  // the file is present; never fabricate one for a setup that does not use
  // it. A genuinely absent file is "absent" (the feature does not apply); a
  // file that exists but cannot be stat'd or read is "failed", so the
  // operator is warned rather than left with a silently broken launch.
  // lstat, not stat — a symlink at the path is refused rather than followed.
  let info;
  try {
    info = lstatSync(target);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : "failed";
  }
  // A symlinked mirror, or a symlinked parent (~/.claude linked elsewhere),
  // is never written through: the write would land wherever the link
  // points, e.g. a repository. Whether it may be launched through is decided
  // after the Keychain read below: when a Keychain entry exists, the file is
  // a mirror, and one that carries a refresh token behind a link would hand
  // the child that token — "unsafe"; when there is no entry at all the file
  // is Claude Code's own store (a dotfile-managed ~/.claude on Linux is the
  // common case) and the launch proceeds as "failed" — nothing synced,
  // nothing refused.
  let linked = info.isSymbolicLink() || !info.isFile();
  if (!linked) {
    try {
      linked = lstatSync(dirname(target)).isSymbolicLink();
    } catch {
      return "failed";
    }
  }

  // Read the Keychain first (its lookup can take up to 3s), tolerating an
  // OS-level spawn throw so it counts as an unreadable entry ("error":
  // nothing mirrored, nothing scrubbed, a refresh-token-carrying file
  // refused) rather than escaping and aborting the launch.
  let read: SecretReadResult;
  try {
    read = readSecret(service);
  } catch {
    read = { kind: "error", detail: "the Keychain read threw" };
  }
  const keychainOauth = read.kind === "secret" ? claudeOauth(read.value) : null;

  if (linked) {
    if (read.kind === "missing") return "failed";
    try {
      // Only a regular file behind the link is read (a FIFO would block).
      if (!statSync(target).isFile()) return "failed";
      const behind = claudeOauthObject(readFileSync(target, "utf8"));
      return behind !== null && carriesRefreshToken(behind) ? "unsafe" : "failed";
    } catch {
      return "failed";
    }
  }

  // Read the file as late as possible, then decide against THAT snapshot.
  let current: string;
  try {
    current = readFileSync(target, "utf8");
  } catch {
    return "failed";
  }
  // A file that does not parse as a Claude credential mirror is not ours to
  // manage (an API-key setup's file, or corrupt): report "foreign" so the
  // adapter neither warns nor fabricates a credential into it. A stub with
  // keys this codemux does not know is reported so the adapter warns.
  const file = classifyMirror(current);
  if (file.kind !== "mirror") return file.kind;

  // No Keychain credential to mirror. Two very different situations:
  //
  //   - No Keychain ENTRY at all ("missing": Linux, or a macOS setup that
  //     never logged in through the Keychain). Then this file is not a
  //     mirror but Claude Code's one and only credential store, its refresh
  //     token the operator's only copy, and the sandboxed child is the same
  //     Claude Code rotating the same file — one copy, no divergence, no
  //     lockout. The file is left exactly as it is.
  //   - An entry exists but yields nothing usable: a locked Keychain or a
  //     denied/timed-out read ("error"), an entry holding only co-stored
  //     mcpOAuth state (anthropics/claude-code#36779), or an access token
  //     that is empty or already expired. Then the Keychain owns the
  //     credential and the file IS a mirror, so a refresh token in it is the
  //     second copy that caused the lockout: scrubbed here, locally, with
  //     nothing from the Keychain; when even that write fails the outcome is
  //     "unsafe" and the launch is refused. A mirror that still carries a
  //     usable access token then authenticates on its own ("missing",
  //     silent); one that does not leaves the child with no usable token —
  //     the exact 401 this module exists to prevent — so "failed", and the
  //     adapter warns.
  if (keychainOauth === null) {
    if (read.kind === "missing") {
      // Untouched either way; an emptied stub with no Keychain behind it
      // still leaves the child nothing to authenticate with, so say so.
      return hasUsableToken(file.oauth) ? "missing" : "failed";
    }
    if (read.kind === "error") {
      // The entry exists but could not be read (locked keychain over SSH,
      // denied ACL, timeout, empty value). Nothing can be mirrored, and
      // nothing is destroyed either: the file's refresh token might be the
      // only working login (an old sandbox rotation could have left the
      // Keychain's copy dead), so it is not emptied blind. A file that
      // carries one is not launched through; one without launches and
      // reports its own 401 if stale.
      return carriesRefreshToken(file.oauth) ? "unsafe" : "failed";
    }
    let own = file.oauth;
    if (carriesRefreshToken(own)) {
      const scrubbed = scrubRefreshToken(target, current, own, backupDir);
      if (scrubbed !== "clean") return scrubbed;
      // Judge what is on disk now, not the copy read before the scrub (a
      // concurrent writer may have changed it).
      try {
        own = claudeOauthObject(readFileSync(target, "utf8")) ?? own;
      } catch {
        return "failed";
      }
    }
    // The mirror stands alone only while its own access token is live; an
    // expired one (the usual state after an idle period, with the Keychain
    // token expired too) is the undiagnosed 401 this module exists to name.
    return accessTokenLive(own) ? "missing" : "failed";
  }
  if (!shouldReplace(file.oauth, keychainOauth)) return "current";

  const written = writeMirror(target, current, mirrorCredential(keychainOauth), backupDir);
  if (written === "written") return "synced";
  if (written === "vanished") {
    // Whoever deleted the file owns that decision, but a child launched now
    // has nothing to authenticate with; when the file we read could not
    // have authenticated either (a stub), the operator must hear about it.
    return hasUsableToken(file.oauth) ? "current" : "failed";
  }
  // Another writer changed the file under us. It leads only if what it
  // wrote can authenticate and carries no refresh token; a refresh token
  // left there is scrubbed on the spot, and a mirror that cannot be
  // scrubbed refuses the launch. Otherwise the mirror is still stale:
  // report it, so the operator hears about it; the next launch retries.
  let live: string;
  try {
    live = readFileSync(target, "utf8");
  } catch {
    return "failed";
  }
  const liveFile = classifyMirror(live);
  if (liveFile.kind !== "mirror") return "failed";
  if (carriesRefreshToken(liveFile.oauth)) {
    const scrubbed = scrubRefreshToken(target, live, liveFile.oauth, backupDir);
    if (scrubbed !== "clean") return scrubbed;
    return liveFile.oauth.accessToken === keychainOauth.accessToken ? "current" : "failed";
  }
  return shouldReplace(liveFile.oauth, keychainOauth) ? "failed" : "current";
}

/** Empty the refresh token of a mirror in place, keeping everything else,
 * and verify the result: "clean" once the file carries no refresh token
 * (written by us, or by a concurrent writer who got there first), "failed"
 * when the file vanished meanwhile (nothing is left for a child to read,
 * and a vanished mirror is never recreated), "unsafe" when a refresh token
 * is still there and could not be removed — the caller refuses the launch.
 * A conflict is retried once against the live content; two conflicts in a
 * row with the token still present are treated as unsafe rather than
 * looping against a writer that keeps putting it back. */
function scrubRefreshToken(
  target: string,
  current: string,
  oauth: Record<string, unknown>,
  backupDir: string
): "clean" | "failed" | "unsafe" {
  let content = current;
  let fileOauth = oauth;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const written = writeMirror(target, content, scrubbedCredential(fileOauth), backupDir);
    if (written === "written") return "clean";
    if (written === "vanished") return "failed";
    if (written === "error") return "unsafe";
    // conflict: another writer changed the file; judge what is there now.
    try {
      content = readFileSync(target, "utf8");
    } catch {
      return "failed";
    }
    const live = claudeOauthObject(content);
    if (live === null || !carriesRefreshToken(live)) return "clean";
    fileOauth = live;
  }
  return "unsafe";
}

/** Whether the Keychain's Claude credential should replace the file's.
 * Always when the file still carries a refresh token: the mirror must never
 * hold one (module header), whatever else it says. Otherwise whenever the
 * file's access token is not the Keychain's — a stale mirror, the stub Claude
 * Code leaves once the Keychain owns the credential, or a token the operator
 * re-logged in for. A file already holding the Keychain's access token is
 * current. Expiry ordering plays no part: the mirror cannot refresh, so it
 * can never be "newer" than the Keychain, and a revoked token with a later
 * expiry must not be kept. */
function shouldReplace(
  fileOauth: Record<string, unknown>,
  keychainOauth: Record<string, unknown>
): boolean {
  if (carriesRefreshToken(fileOauth)) return true;
  return fileOauth.accessToken !== keychainOauth.accessToken;
}
