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
 * that file, so Claude's two copies of its own credential agree again. It is
 * a mirror, not a credential manager. The scope is drawn deliberately narrow
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
 *   - The Keychain replaces the file when it is a strictly newer credential
 *     (or, when an expiry is absent on one side and so unorderable, whenever
 *     the two `claudeAiOauth` objects differ at all — the Keychain being
 *     authoritative); a file that already leads is left alone. An emptied
 *     stub cannot lead at all: the Keychain replaces it regardless of
 *     expiry ordering (see `shouldReplace`). Writes are atomic (temp + rename) with a final
 *     re-check against the live file, so the residual concurrent-rotation
 *     window is microseconds and self-heals next launch — nothing corrupts.
 *
 * KNOWN LIMITATION (accepted): lock-free by design. In the microsecond
 * window between the final re-check and the rename, a sandboxed Claude that
 * rotates its token to the file can be overwritten, losing that one
 * rotation. Fully closing it needs file locking, which Claude Code itself
 * does not use on this file and which — tried in development — trades this
 * one narrow race for a lock lifecycle with worse failure modes. codemux
 * matches Claude's own atomicity level here deliberately.
 *
 * Set CODEMUX_NO_KEYCHAIN_SYNC=1 to disable it (used by this repo's own CLI
 * tests; also an operator escape hatch).
 */

import {
  lstatSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, join } from "node:path";

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
  | "failed"; // a credential should be mirrorable but could not be delivered

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
  if (raw.length === 0) return { kind: "missing" };
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

/** Whether a Keychain blob actually carries a usable Claude credential.
 * Claude Code's Keychain entry can momentarily hold only co-stored MCP OAuth
 * data with no `claudeAiOauth` token (anthropics/claude-code#36779);
 * mirroring that over a working file would break auth, so it does not count
 * as something to mirror. */
export function hasUsableClaudeCredential(blob: string): boolean {
  return claudeOauth(blob) !== null;
}

function claudeOauth(blob: string): Record<string, unknown> | null {
  const oauth = claudeOauthObject(blob);
  return oauth !== null && hasUsableToken(oauth) ? oauth : null;
}

function hasUsableToken(oauth: Record<string, unknown>): boolean {
  const usable = (value: unknown): boolean =>
    typeof value === "string" && value.length > 0;
  return usable(oauth.refreshToken) || usable(oauth.accessToken);
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

/** claudeAiOauth.expiresAt from a credential file/blob, or null. */
function claudeExpiry(oauth: Record<string, unknown> | null): number | null {
  const expiry = oauth?.expiresAt;
  return typeof expiry === "number" ? expiry : null;
}

/** The file's contents with only its `claudeAiOauth` field replaced by the
 * Keychain's — everything else (notably co-stored `mcpOAuth` state Claude
 * keeps in this same file) is left exactly as Claude wrote it. The caller
 * only reaches this when `shouldReplace` confirmed the file parses and
 * carries a Claude credential, so the parse here always succeeds. */
function mergedCredential(current: string, keychainOauth: Record<string, unknown>): string {
  const parsed = JSON.parse(current) as Record<string, unknown>;
  return JSON.stringify({ ...parsed, claudeAiOauth: keychainOauth });
}

/**
 * Refresh the `claudeAiOauth` field of an EXISTING credential file from the
 * Keychain. See the module header for the deliberately narrow scope. Only
 * that one field is ever read or written; the rest of Claude's file is left
 * untouched. The caller warns on "failed", because a silently stale mirror
 * is the exact 401 this exists to prevent.
 */
export function syncKeychainCredential(
  service: string,
  target: string,
  readSecret: SecretReader = readKeychainSecret
): SyncOutcome {
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
  if (info.isSymbolicLink() || !info.isFile()) return "failed";
  // Refuse a symlinked parent too (~/.claude linked elsewhere): writing
  // through it would land the credential wherever the link points, e.g. a
  // repository. lstat the immediate parent — the fixed target's grandparents
  // are the home directory, not attacker-controlled.
  try {
    if (lstatSync(dirname(target)).isSymbolicLink()) return "failed";
  } catch {
    return "failed";
  }

  // Read the Keychain first (its lookup can take up to 3s), tolerating an
  // OS-level spawn throw so it becomes "failed" rather than escaping and
  // aborting the launch.
  let read: SecretReadResult;
  try {
    read = readSecret(service);
  } catch {
    return "failed";
  }
  if (read.kind === "error") return "failed";
  const keychainOauth = read.kind === "secret" ? claudeOauth(read.value) : null;
  const keychainExpiry = claudeExpiry(keychainOauth);

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

  // Without a usable Keychain credential there is nothing to refresh with.
  // A mirror that still carries a usable token authenticates on its own, so
  // this stays "missing" as before. An emptied stub, though, launches with
  // no usable token at all — the exact silent 401 this module exists to
  // prevent — so it reports "failed" and the adapter warns. The Keychain
  // can also hold only co-stored mcpOAuth state for a while
  // (anthropics/claude-code#36779), which lands here too.
  if (keychainOauth === null) {
    if (!hasUsableToken(file.oauth)) return "failed";
    return "missing";
  }
  if (!shouldReplace(file.oauth, keychainOauth, keychainExpiry)) return "current";

  const merged = mergedCredential(current, keychainOauth);
  const staging = `${target}.${process.pid}.tmp`;
  try {
    try {
      writeFileSync(staging, `${merged}\n`, { flag: "wx", mode: 0o600 });
    } catch {
      removeQuietly(staging); // a symlink/stray entry — never a directory we own
      writeFileSync(staging, `${merged}\n`, { flag: "wx", mode: 0o600 });
    }
    // TOCTOU re-check immediately before committing: re-read the WHOLE file
    // and back off if it changed AT ALL since we read it — another writer
    // (Claude rotating its token, updating co-stored mcpOAuth, or deleting
    // the file) got there, and our staged snapshot would clobber their work.
    // Comparing full content (not just claudeAiOauth.expiresAt) covers every
    // field and the deletion case; a vanished file is left deleted, not
    // recreated. The residual window is the microseconds between this read
    // and the rename, and any loss self-heals on the next launch.
    try {
      const live = readFileSync(target, "utf8");
      if (live !== current) {
        removeQuietly(staging);
        // The other writer leads only if what it wrote can authenticate and
        // is not itself older than the Keychain (an emptied stub, or a
        // co-stored field updated around one, leaves the child without a
        // usable token). Otherwise the mirror is still stale: report it, so
        // the operator hears about it; the next launch retries.
        const liveFile = classifyMirror(live);
        const stillStale =
          liveFile.kind !== "mirror" ||
          shouldReplace(liveFile.oauth, keychainOauth, keychainExpiry);
        return stillStale ? "failed" : "current";
      }
    } catch {
      removeQuietly(staging); // file deleted under us — do not recreate it
      // Whoever deleted it owns that decision, but a child launched now has
      // nothing to authenticate with; when the file we read could not have
      // authenticated either (a stub), the operator must hear about it.
      return hasUsableToken(file.oauth) ? "current" : "failed";
    }
    renameSync(staging, target);
    return "synced";
  } catch {
    removeQuietly(staging); // never leave a staged credential behind
    return "failed";
  }
}

/** Whether the Keychain's Claude credential should replace the file's. A
 * file whose tokens are emptied (the stub Claude Code leaves once the
 * Keychain owns the credential) cannot lead, so the Keychain replaces it
 * regardless of expiry. Otherwise acts only when the Keychain is a strictly
 * newer credential; a file that already holds an equal-or-newer
 * `claudeAiOauth` is left alone (covers a sandbox-rotated token the Keychain
 * has not caught up to, and avoids touching the file when only unrelated
 * fields differ). When either side lacks a numeric expiry, fall back to
 * acting whenever the two objects differ at all (equality was ruled out
 * above) — the Keychain is authoritative in that degenerate case, and any
 * misjudgment self-heals next launch. */
function shouldReplace(
  fileOauth: Record<string, unknown>,
  keychainOauth: Record<string, unknown>,
  keychainExpiry: number | null
): boolean {
  if (JSON.stringify(fileOauth) === JSON.stringify(keychainOauth)) return false;
  // A stub whose tokens Claude Code emptied cannot lead: the Keychain does.
  if (!hasUsableToken(fileOauth)) return true;
  const fileExpiry = claudeExpiry(fileOauth);
  if (fileExpiry !== null && keychainExpiry !== null) {
    return keychainExpiry > fileExpiry;
  }
  // Degenerate: an expiry is absent on one side, so freshness is
  // unorderable. The Keychain is authoritative, so refresh; any misjudgment
  // self-heals next launch.
  return true;
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
