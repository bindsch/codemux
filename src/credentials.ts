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

import { homedir } from "node:os";
import { join } from "node:path";

export const CLAUDE_KEYCHAIN_SERVICE = "Claude Code-credentials";

/** The default credential-mirror path Claude Code maintains — resolved the
 * same way Claude Code resolves it (`$HOME`-based), so codemux refreshes the
 * exact file the sandboxed child will read. There is no caller-supplied
 * target; the only path ever written is Claude's own existing mirror. */
export function claudeCredentialTarget(home = homedir()): string {
  return join(home, ".claude", ".credentials.json");
}

// The mirror machinery lives in ./credentials/ (oauth.ts reads the
// Keychain and classifies blobs, sync.ts decides, backups.ts writes);
// re-exported here so importers keep this one path.
export {
  readKeychainSecret,
  decodeSecurityOutput,
  hasUsableClaudeCredential,
  mirrorCredential,
  scrubbedCredential,
  claudeOauthObject,
  credentialTextCarriesRefreshToken,
  fileCarriesRefreshToken,
} from "./credentials/oauth.js";
export type { SecretReadResult, SecretReader } from "./credentials/oauth.js";
export { syncKeychainCredential } from "./credentials/sync.js";
export type { SyncOutcome, SyncOptions } from "./credentials/sync.js";
export { defaultCredentialBackupDir } from "./credentials/backups.js";
