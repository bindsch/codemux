// The Keychain side of the credential mirror: reading the macOS Keychain
// entry and interpreting `claudeAiOauth` blobs (the Keychain's and a
// file's) into mirror shapes and file classes. src/credentials.ts owns
// the mirror lifecycle and re-exports this.

import { userInfo } from "node:os";

import { readUtf8FileBounded } from "../file-io.js";
import { MAX_CREDENTIAL_MIRROR_BYTES } from "./backups.js";

export type SecretReadResult =
  | { kind: "secret"; value: string }
  | { kind: "missing" } // no entry (or not macOS): nothing to mirror
  | { kind: "error"; detail: string }; // locked keychain, denied, timeout

export type SecretReader = (service: string) => SecretReadResult;

// `security` exits 44 (errSecItemNotFound) for a genuinely absent entry;
// every other nonzero exit (locked keychain, denied ACL, timeout kill) means
// a secret probably exists and could not be read — the caller warns, because
// the launch will then hit the exact undiagnosed 401 this mirror prevents.
const SECURITY_ITEM_NOT_FOUND = 44;

/** Read a generic password from the macOS Keychain. Selected by (service,
 * account) — Claude Code stores under the OS username — with the absolute
 * binary path so PATH cannot redirect the lookup and a hard timeout so a
 * locked keychain or consent dialog cannot hang the launch. */
export function readKeychainSecret(service: string): SecretReadResult {
  if (process.platform !== "darwin") return { kind: "missing" };
  const proc = Bun.spawnSync(
    [
      "/usr/bin/security",
      "find-generic-password",
      "-s", service,
      // Claude Code keys its entry on $USER when set, else the OS username;
      // match that so codemux queries the same entry Claude wrote.
      "-a", process.env.USER || userInfo().username,
      "-w",
    ],
    { stdout: "pipe", stderr: "ignore", timeout: 3000 }
  );
  if (proc.exitCode === SECURITY_ITEM_NOT_FOUND) return { kind: "missing" };
  if (proc.exitCode !== 0) {
    return { kind: "error", detail: `security exited ${proc.exitCode}` };
  }
  const raw = proc.stdout.toString().trim();
  // An entry that exists but yields nothing is unreadable, not absent: the
  // distinction decides whether the file is a mirror or Claude's only store.
  if (raw.length === 0) return { kind: "error", detail: "security returned an empty value" };
  return { kind: "secret", value: decodeSecurityOutput(raw) };
}

/** `security -w` prints the password as hex (optionally 0x-prefixed) when it
 * contains non-printable or non-ASCII bytes; decode transparently when the
 * result is valid JSON, otherwise keep the raw text. The decode is fatal,
 * never with replacement characters (review round 104): a lossy decode
 * turns an invalid byte inside the JSON into U+FFFD, which can still parse
 * and would classify the entry by a credential it does not hold. Bytes
 * that are not valid UTF-8 keep the raw text, which then fails every
 * credential parse — the unreadable direction. */
export function decodeSecurityOutput(raw: string): string {
  const hex = raw.startsWith("0x") || raw.startsWith("0X") ? raw.slice(2) : raw;
  if (/^(?:[0-9A-Fa-f]{2})+$/.test(hex)) {
    try {
      const decoded = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
        Buffer.from(hex, "hex")
      );
      JSON.parse(decoded);
      return decoded;
    } catch {
      // Not hex-encoded JSON (or not valid UTF-8) after all; keep the raw text.
    }
  }
  return raw;
}

/** Whether a Keychain blob carries a Claude credential a sandboxed child
 * could use: a `claudeAiOauth` object with a non-empty, unexpired access
 * token. Claude Code's Keychain entry can momentarily hold only co-stored
 * MCP OAuth state (anthropics/claude-code#36779) with no `claudeAiOauth` at
 * all, or an access token that has already expired; mirroring either over
 * a working file would break auth, so neither counts. */
export function hasUsableClaudeCredential(blob: string): boolean {
  return claudeOauth(blob) !== null;
}

/** The Keychain's `claudeAiOauth` when it can be mirrored: a non-empty
 * access token that has not expired. The refresh token is irrelevant here —
 * the mirror never carries it — so an entry holding only a refresh token,
 * or an access token past `expiresAt`, is not a credential a sandboxed child
 * could use, and mirroring it would replace a working file with a dead one. */
export function claudeOauth(blob: string, now: number = Date.now()): Record<string, unknown> | null {
  const oauth = claudeOauthObject(blob);
  return oauth !== null && accessTokenLive(oauth, now) ? oauth : null;
}

function usableString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** A non-empty access token whose expiry, when the field is absent, is
 * unknown (no expiry to check — the pre-2.0 rule, which the mirror-side
 * stub classification and the sync's stand-alone-mirror verdict rely on),
 * and when present must be a finite number lying ahead: `null`, `"0"`,
 * NaN, or an infinity is a malformed expiry, not a non-expiring token
 * (review round 96, whole tree) — treating it as live could mirror a
 * dead credential over a working file or report one as usable. */
export function accessTokenLive(oauth: Record<string, unknown>, now: number = Date.now()): boolean {
  if (!usableString(oauth.accessToken)) return false;
  const expiresAt = oauth.expiresAt;
  if (expiresAt === undefined) return true;
  return typeof expiresAt === "number" && Number.isFinite(expiresAt) && expiresAt > now;
}

/** Whether a FILE holds a token at all (either kind): the 0.5.0 rule for
 * telling a mirror from the emptied stub. What a sandboxed child can use is
 * the access token alone; a refresh token in the file is what the scrub
 * removes. */
export function hasUsableToken(oauth: Record<string, unknown>): boolean {
  return usableString(oauth.refreshToken) || usableString(oauth.accessToken);
}

/** The raw `claudeAiOauth` value of a blob when it is a plain object. */
export function claudeOauthObject(blob: string): Record<string, unknown> | null {
  try {
    const oauth = JSON.parse(blob)?.claudeAiOauth;
    return typeof oauth === "object" && oauth !== null && !Array.isArray(oauth)
      ? (oauth as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** The credential a sandboxed child may hold: the Keychain's `claudeAiOauth`
 * with the refresh token emptied and its expiry dropped. Everything else
 * (access token, expiry, scopes, subscription, rate-limit tier) is copied as
 * is. Emptied rather than omitted because that is the shape Claude Code
 * itself leaves on disk once the Keychain owns the credential. */
export function mirrorCredential(
  oauth: Record<string, unknown>
): Record<string, unknown> {
  const mirror: Record<string, unknown> = {};
  for (const key of MIRROR_KEYS) {
    if (key in oauth) mirror[key] = oauth[key];
  }
  // A Keychain entry without an access token is never mirrored (see
  // `claudeOauth`), so this branch is a guard: whatever reaches it without
  // one still yields Claude Code's stub shape, which `classifyMirror`
  // recognizes next time instead of calling the file foreign.
  if (typeof mirror.accessToken !== "string" || mirror.accessToken.length === 0) {
    mirror.accessToken = "";
    if (typeof mirror.expiresAt !== "number") mirror.expiresAt = 0;
    if (!Array.isArray(mirror.scopes)) mirror.scopes = [];
  }
  mirror.refreshToken = "";
  return mirror;
}

/** The file's OWN `claudeAiOauth` with the refresh token removed and nothing
 * else changed: used when the Keychain has nothing usable to mirror and only
 * the refresh token must go. Keys a newer Claude Code may have added stay
 * (the shape rule above is for what codemux copies from the Keychain). */
export function scrubbedCredential(oauth: Record<string, unknown>): Record<string, unknown> {
  const { refreshTokenExpiresAt: _dropped, ...rest } = oauth;
  const scrubbed: Record<string, unknown> = { ...rest, refreshToken: "" };
  // With no access token left, complete Claude Code's stub shape so the
  // next launch sees a stale mirror, not a foreign file.
  if (typeof scrubbed.accessToken !== "string" || scrubbed.accessToken.length === 0) {
    scrubbed.accessToken = "";
    if (typeof scrubbed.expiresAt !== "number") scrubbed.expiresAt = 0;
    if (!Array.isArray(scrubbed.scopes)) scrubbed.scopes = [];
  }
  return scrubbed;
}

/** The keys a mirror may carry: Claude Code's own stub keys minus the two
 * refresh-token fields. Anything else in the Keychain entry (a newer Claude
 * Code's addition, or co-stored state) stays in the Keychain, so what is
 * written is always a shape `classifyMirror` recognizes. */
const MIRROR_KEYS = ["accessToken", "expiresAt", "scopes", "subscriptionType", "rateLimitTier"] as const;

/** Whether a mirror still holds a refresh token — something the mirror must
 * never carry (see the module header). */
/** A refresh token the child can still use: present, and not past the
 * expiry the credential records for it (`refreshTokenExpiresAt`, epoch
 * milliseconds); a credential without that field is judged on presence.
 * An expired refresh token mints nothing (review round 301). */
export function refreshTokenLive(oauth: Record<string, unknown>, now: number = Date.now()): boolean {
  if (!carriesRefreshToken(oauth)) return false;
  const until = oauth["refreshTokenExpiresAt"];
  return typeof until !== "number" || !Number.isFinite(until) || until > now;
}

export function carriesRefreshToken(oauth: Record<string, unknown>): boolean {
  return typeof oauth.refreshToken === "string" && oauth.refreshToken.length > 0;
}

/** Whether credential TEXT (already read, not re-read from disk) is a
 * parseable credential object carrying a refresh token. Unparseable text:
 * false — the caller that must refuse unparseable content checks
 * `claudeOauthObject` itself. */
export function credentialTextCarriesRefreshToken(text: string): boolean {
  const oauth = claudeOauthObject(text);
  return oauth !== null && carriesRefreshToken(oauth);
}

/** Whether the credential file at `path` carries a refresh token, read
 * through the shared bounded reader (one open, no pathname stat first):
 * a regular file, read through any symlink, at most
 * MAX_CREDENTIAL_MIRROR_BYTES — the same rules the sync path reads under
 * (src/credentials/sync.ts), so an oversized file the sandboxed child
 * wrote cannot spend unbounded memory here and a regular-file-to-FIFO
 * swap cannot block the launch (review round 96, whole tree). A file
 * that exists but cannot be read or judged — oversized, non-regular,
 * unreadable, invalid UTF-8 — answers TRUE, the fail-closed value for
 * every caller (each treats a carried token as the hazard to warn about
 * or refuse the launch over; codemux cannot rule the token out). A file
 * that does not exist carries nothing: false. */
export function fileCarriesRefreshToken(path: string): boolean {
  let text: string;
  try {
    text = readUtf8FileBounded(path, {
      maxBytes: MAX_CREDENTIAL_MIRROR_BYTES,
      label: "the credential file",
      noFollow: false,
    });
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ENOENT";
  }
  return credentialTextCarriesRefreshToken(text);
}
