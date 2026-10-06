/**
 * Keep a sandboxed harness's on-disk credential mirror fresh.
 *
 * Claude Code stores its live credential in the macOS Keychain and keeps an
 * on-disk MIRROR of it at `~/.claude/.credentials.json` — a file Claude Code
 * itself creates, writes, and reads. The scode sandbox cannot reach the
 * Keychain, so a sandboxed Claude reads only that mirror; when the Keychain
 * token rotates the mirror goes stale, and a stale rotated refresh token
 * reads as "revoked" (401) on every sandboxed run.
 *
 * This module does exactly one thing: mirror the Keychain entry back into
 * that file — minus the refresh token — so a sandboxed Claude can
 * authenticate without ever being able to rotate the operator's login. It
 * is a mirror, not a credential manager. The scope is drawn deliberately narrow
 * so corner cases cannot matter:
 *
 *   - It only refreshes a file that ALREADY EXISTS. The bug it fixes is a
 *     stale file, which means the file is present; a mirror is never
 *     fabricated for a setup that does not use one (direct API-key auth,
 *     etc.), and no target path is ever created.
 *   - The target is the fixed default path. No caller-supplied target and no
 *     repository-exfiltration surface to reason about.
 *   - Only the `claudeAiOauth` field is ever read or written; everything else
 *     Claude keeps in this file (notably co-stored `mcpOAuth` state) is left
 *     exactly as Claude wrote it, both when the file leads and when the
 *     Keychain does. A file that carries no `claudeAiOauth` object is not
 *     touched; one that carries the full stub Claude Code 2.1.25x leaves
 *     once the Keychain owns the credential (emptied `accessToken` and
 *     `refreshToken`, numeric `expiresAt`, `scopes` array, no unknown keys)
 *     is a stale mirror and is refreshed; that stub with unknown keys is
 *     reported "unrecognized" so the adapter warns. See `classifyMirror`.
 *   - The mirror NEVER carries the refresh token. Only the access token
 *     (and the descriptive fields beside it) is copied; `refreshToken` is
 *     written emptied and `refreshTokenExpiresAt` is dropped. A sandboxed
 *     child therefore authenticates for the access token's lifetime (hours)
 *     and, when that token expires or is revoked, fails with a plain 401 —
 *     it cannot refresh. This is the whole point: a child that could refresh
 *     would rotate the grant the operator's interactive Claude Code holds in
 *     the Keychain, and a stale copy presented later makes the provider
 *     revoke the entire grant family. That is exactly what logged the
 *     operator out of every Claude session (2026-10-05): the Keychain token
 *     rotated, a sandboxed copy still held the old refresh token, and its
 *     refresh attempt took the live login down with it. The access token is
 *     a bearer credential with no rotation, so copies of it are harmless.
 *   - The Keychain replaces the file whenever the file's access token differs
 *     from the Keychain's, and always when the file still carries a refresh
 *     token (a mirror written by an older codemux or by Claude Code itself is
 *     scrubbed on the next launch). The scrub does not need a USABLE
 *     Keychain credential: with the entry readable but holding nothing
 *     usable (mcpOAuth-only, or an expired access token), a refresh token
 *     in the file is still emptied in place — after a copy of the file is
 *     written under `~/Library/Application Support/codemux/` (0700/0600),
 *     which the sandbox cannot see, because a token codemux cannot prove
 *     superseded is never destroyed. When the backup or the write fails, or
 *     the mirror sits behind a symlink, the outcome is "unsafe" and the
 *     adapter refuses the sandboxed launch. A Keychain entry that exists but
 *     cannot be READ (locked over SSH, denied, timed out, empty) mirrors
 *     nothing and scrubs nothing: a file that carries a refresh token is
 *     then refused, one without launches and reports its own 401 if stale.
 *     `CODEMUX_NO_KEYCHAIN_SYNC=1` means "do not consult the Keychain", and
 *     without it a mirror cannot be told from Claude Code's only store, so
 *     that path neither scrubs nor refuses: the file is left as it is and
 *     the adapter reports a refresh token in it. A passed-through
 *     `CLAUDE_CONFIG_DIR` profile is treated the same way (its Keychain
 *     entry, if any, is not codemux's to read); the default mirror is still
 *     checked, because the sandbox lets the child read `~/.claude` either
 *     way. The one case left alone is a machine with no
 *     Keychain entry at all (Linux, or a file-only macOS login): there the
 *     file is Claude Code's only credential store, not a mirror, and the
 *     sandboxed child rotates the same single copy the operator uses — no
 *     divergence, so nothing to scrub. A file whose access token already
 *     matches the Keychain's is left alone. Writes are atomic (temp + rename) with
 *     a final re-check against the live file, so a concurrent writer is
 *     never clobbered.
 *
 * Lock-free by design, like Claude Code's own handling of this file: in the
 * microsecond window between the final re-check and the rename another
 * writer can be overwritten, and the loss self-heals on the next launch.
 * Nothing in that window can touch the Keychain or the grant.
 *
 * Set CODEMUX_NO_KEYCHAIN_SYNC=1 to disable it (used by this repo's own CLI
 * tests; also an operator escape hatch).
 */

import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, userInfo } from "node:os";
import { basename, dirname, join } from "node:path";

export type SecretReadResult =
  | { kind: "secret"; value: string }
  | { kind: "missing" } // no entry (or not macOS): nothing to mirror
  | { kind: "error"; detail: string }; // locked keychain, denied, timeout

export type SecretReader = (service: string) => SecretReadResult;

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
 * result is valid JSON, otherwise keep the raw text. */
export function decodeSecurityOutput(raw: string): string {
  const hex = raw.startsWith("0x") || raw.startsWith("0X") ? raw.slice(2) : raw;
  if (/^(?:[0-9A-Fa-f]{2})+$/.test(hex)) {
    try {
      const decoded = Buffer.from(hex, "hex").toString("utf8");
      JSON.parse(decoded);
      return decoded;
    } catch {
      // Not hex-encoded JSON after all; keep the raw text.
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
function claudeOauth(blob: string, now: number = Date.now()): Record<string, unknown> | null {
  const oauth = claudeOauthObject(blob);
  return oauth !== null && accessTokenLive(oauth, now) ? oauth : null;
}

function usableString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** A non-empty access token whose `expiresAt`, when present, lies ahead. */
function accessTokenLive(oauth: Record<string, unknown>, now: number = Date.now()): boolean {
  if (!usableString(oauth.accessToken)) return false;
  return typeof oauth.expiresAt !== "number" || oauth.expiresAt > now;
}

/** Whether a FILE holds a token at all (either kind): the 0.5.0 rule for
 * telling a mirror from the emptied stub. What a sandboxed child can use is
 * the access token alone; a refresh token in the file is what the scrub
 * removes. */
function hasUsableToken(oauth: Record<string, unknown>): boolean {
  return usableString(oauth.refreshToken) || usableString(oauth.accessToken);
}

/** The raw `claudeAiOauth` value of a blob when it is a plain object. */
function claudeOauthObject(blob: string): Record<string, unknown> | null {
  try {
    const oauth = JSON.parse(blob)?.claudeAiOauth;
    return typeof oauth === "object" && oauth !== null && !Array.isArray(oauth)
      ? (oauth as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** Every key Claude Code writes under `claudeAiOauth` in the on-disk stub.
 * A stub carrying any other key is not overwritten: it is either some other
 * program's state under Claude's key, or a Claude Code newer than this
 * codemux knows, and either way the operator is told (see "unrecognized")
 * rather than having the object replaced or the launch fail silently. */
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
function classifyMirror(blob: string): MirrorClass {
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
function carriesRefreshToken(oauth: Record<string, unknown>): boolean {
  return typeof oauth.refreshToken === "string" && oauth.refreshToken.length > 0;
}

/** Whether the credential file at `path` (read through any symlink, regular
 * files only) carries a refresh token. Unreadable or absent: false. */
export function fileCarriesRefreshToken(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    const oauth = claudeOauthObject(readFileSync(path, "utf8"));
    return oauth !== null && carriesRefreshToken(oauth);
  } catch {
    return false;
  }
}

/** The file's contents with only its `claudeAiOauth` field replaced by the
 * mirror of `oauth` (the Keychain's entry, or the file's own when scrubbing).
 * Everything else — notably the co-stored `mcpOAuth` state Claude Code keeps
 * in this same file — is left exactly as Claude wrote it. The caller only
 * reaches this with a file `classifyMirror` accepted, so `current` parses. */
function mergedCredential(current: string, claudeAiOauth: Record<string, unknown>): string {
  const parsed = JSON.parse(current) as Record<string, unknown>;
  return JSON.stringify({ ...parsed, claudeAiOauth });
}

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

/** Replace the file's `claudeAiOauth` with the mirror of `oauth`, atomically
 * (staging file + rename, 0600), re-checking immediately before the rename
 * that the WHOLE file is still exactly `current` — another writer (Claude
 * Code updating co-stored mcpOAuth, or deleting the file) must not be
 * clobbered. "conflict" means the file changed; "vanished" that it was
 * deleted (it is left deleted, never recreated); "error" that the write
 * itself failed. The residual window between the re-check and the rename is
 * microseconds, and a lost write self-heals on the next launch; nothing in
 * that window can reach the Keychain or the grant. */
function writeMirror(
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
  const existing = claudeOauthObject(current);
  let backup: string | null = null;
  if (existing !== null && carriesRefreshToken(existing)) {
    backup = backupCredential(backupDir, current);
    if (backup === null) return "error";
  }
  const merged = mergedCredential(current, claudeAiOauth);
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
      live = readFileSync(target, "utf8");
    } catch {
      removeQuietly(staging);
      kept("vanished");
      return "vanished";
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

export const CLAUDE_KEYCHAIN_SERVICE = "Claude Code-credentials";

/** The default credential-mirror path Claude Code maintains — resolved the
 * same way Claude Code resolves it (`$HOME`-based), so codemux refreshes the
 * exact file the sandboxed child will read. There is no caller-supplied
 * target; the only path ever written is Claude's own existing mirror. */
export function claudeCredentialTarget(): string {
  return join(homedir(), ".claude", ".credentials.json");
}
