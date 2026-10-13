---
read_when: "Diagnosing login, credential mirrors, or private-home cleanup."
---
# Authentication

Codemux uses the selected harness's login or its supported [provider override](provider-overrides.md). It does not implement a separate account login. Credential variables are allowlisted per harness; `--pass-env` explicitly adds names subject to the launch safeguards. Sandboxed environment scrubbing can remove ambient credentials.

## Claude Code

Before a normal sandboxed Claude launch, codemux refreshes an **existing** default `.claude/.credentials.json` mirror from the macOS Keychain service `Claude Code-credentials`. It never creates a missing mirror or updates the Keychain. It copies only usable access-token fields into `claudeAiOauth`, empties `refreshToken`, and drops `refreshTokenExpiresAt`. Co-stored MCP OAuth state is preserved.

This prevents a stale child refresh token from rotating or revoking the interactive login's grant. The child cannot refresh this access-only mirror. A long run can fail authentication when its access token expires or is revoked; launching again can refresh the mirror from a usable Keychain entry.

Before removing an existing refresh token, codemux backs up the original file in the login user's codemux `credential-backups` directory under macOS Application Support, outside the sandbox. The directory is mode 0700 and files are mode 0600. A successful replacement prunes older backups, preserving the new backup and newer concurrent backups. Failed replacement does not prune earlier backups.

| Condition | Behavior |
| --- | --- |
| Existing mirror and usable Keychain access token | Atomically update the Claude credential fields after checking for concurrent changes. |
| Readable Keychain entry but expired/missing usable access token | Do not replace a working access token with unusable credentials. Scrub a mirror's refresh token after backing it up. |
| Keychain lookup errors, locks, or times out | Do not copy or scrub. Refuse if the reachable mirror still carries a refresh token; otherwise warn and let the harness report authentication failure. |
| No Keychain entry at all, including file-only login | Leave the file as the harness's only credential store, including its refresh token. |
| Linked mirror/parent or backup/write failure | Do not write through it. Refuse an unsafe refresh-token mirror; do not silently discard credentials. |
| `CODEMUX_NO_KEYCHAIN_SYNC=1` | Do not consult the Keychain, scrub, or refuse solely for the token. Warn if the file holds a refresh token; the operator owns this exception. |
| Passed-through alternate credential profile | Do not manage that profile. Warn about its refresh token; the default reachable mirror is still checked. |
| Untrusted sandbox | Skip mirror refresh because harness state is inaccessible. |
| Provider override | Copy no operator credentials. Still inspect a reachable refresh-token file: refuse if a Keychain entry exists or cannot be read. A truly absent entry or explicit sync opt-out keeps the file-only behavior. |

Unsandboxed Claude reads its own login directly. Z.AI uses its gateway token rather than the Claude subscription. A provider override removes ambient `ANTHROPIC_API_KEY` and `CLAUDE_CODE_OAUTH_TOKEN` from the child environment.

Implementation: [credential synchronization](../src/credentials.ts), [Claude sandbox preparation](../src/adapters/claude.ts), and [Z.AI adapter](../src/adapters/zai.ts).

## Z.AI

The `zai` adapter runs Claude Code against
`https://api.z.ai/api/anthropic`. A nonblank `ZAI_API_KEY` takes precedence
over `~/.zai` under the adapter's effective home. The file must be a regular
file owned by the current user, mode 0600 or stricter, with no final symlink.
Input is limited to 16 KiB, trimmed, and must contain one credential line
without NUL. Codemux removes the source ZAI_API_KEY after translating it into
the child gateway token.

To save a key without putting its value in shell history:

```sh
umask 077
read -rs ZAI_KEY
printf '%s\n' "$ZAI_KEY" > ~/.zai
unset ZAI_KEY
```

The default model is `opus`. `API_TIMEOUT_MS` controls the upstream API
timeout: default 3000000 milliseconds, accepted integers 1–86400000.
It is separate from codemux's launch timeout. Scrubbing this injected
credential requires scode's [credential exemption](autonomy-and-sandboxing.md#conditional-scode-requirements).

## Codex

A hermetic subscription run creates a private HOME/CODEX_HOME and links the real `auth.json`: a hard link when available, otherwise a symlink. Codex 0.154.0 was observed updating this file in place, so token refresh updates the shared login. If a later version replaces the inode, codemux warns that rotation was discarded. It never copies a private token back over a possibly newer concurrent login.

The private run pins `cli_auth_credentials_store="file"`. A Keychain-only login is refused because its lookup depends on the original CODEX_HOME. Configure Codex's file store and log in with Codex when this mode is needed.

An effective `CODEX_API_KEY` takes precedence and leaves the private home without a linked login. An unrelated `OPENAI_API_KEY` does not select this path. Provider overrides also use a private home without operator auth. A passed-through CODEX_HOME selects the same real home a plain run would use.

Known exits remove one-shot homes. A later launch sweeps dead-owner one-shot homes only after their newest tree modification is at least two days old. Session homes have separate retention and registry rules; see [sessions](sessions.md).

Implementation: [private homes](../src/hermetic-home.ts), [Codex adapter](../src/adapters/codex.ts).

## Antigravity

Every sandboxed Antigravity headless run uses a private HOME and requires scode 0.6.0 or newer. Scode keeps the real login user's Library blocked. Authentication selection is:

1. Effective `GEMINI_API_KEY` or `GOOGLE_API_KEY` surviving the sandbox environment policy.
2. A regular file token from the real OS login home, copied mode 0600 into the private home.
3. The real Keychain item with service `gemini`, account `antigravity`, copied into a private Keychain.

An API key skips all file-token inspection and copying. API-key and file-token authentication skip credential lookup and mirror creation; search-list recovery still runs. An unavailable Keychain tool or missing item refuses before launching the harness.

The file token source is the login home's `.gemini/antigravity-cli/antigravity-oauth-token`, never an instruction/configuration home supplied for a canary. The private copy is never linked or written back. Token refresh stays private and is lost at cleanup.

For Keychain login, codemux keeps one empty template and a random password file, both mode 0600, in the fixed login user's codemux state directory. A lock serializes template creation and search-list recovery. Neither relocated HOME nor `CODEMUX_CALL_LOG` moves this location.

Each run copies and unlocks the template, disables auto-lock, and inserts only the selected item. The trusted `/usr/bin/security` receives commands, passphrases, and credentials on interactive stdin; credentials do not enter argv. Insertion grants access to security and the resolved agy executable. Failure rebuilds the template and retries once. The private mirror contains the full token, including refresh credentials, for that run.

Plain runs share existing state entries individually from `.gemini` and its `antigravity-cli` subdirectory. They exclude `.codemux-isolation-probes` and `antigravity-oauth-token`; the whole directory is never linked. Settings, conversations, and project state can therefore remain shared while auth stays private. Hermetic, tools-none, and probe runs retain private state. Controls copy only planted instruction/settings files.

### Recovery

Every launch validates **both** the OS login home and supplied HOME before recovery. Each must resolve to an absolute user-owned directory. Their canonical `.gemini/.codemux-isolation-probes` roots must be user-owned and free of a linked probe-root path.

Search-list recovery removes only the fixed template or recognized private-mirror paths beneath those validated roots. Unrelated lookalikes remain in their original order and are reported. Template creation snapshots and restores the real user search list. Per-run copies do not need to join that list.

Stale-home recovery removes only user-owned `run-*` directories with valid ownership markers and a PID whose process no longer exists. Live owners, permission errors, unmarked homes, and linked homes are retained. Cleanup keeps directory descriptors, verifies identities, and can locate a renamed home by inode. Failures report the remaining token/mirror path without replacing a completed child's result.

SIGKILL and host crashes can leave private credentials behind until a later recovery. Refreshes in private file tokens or Keychains never update the real login.

The retained live record is agy 1.3.3 with scode 0.6.0 on 2026-10-13; subsequent hardening has automated coverage rather than a new live check. See [verification evidence](archive/isolation-verification.md).

Implementation: [Antigravity adapter](../src/adapters/agy.ts) and [Keychain mirror/recovery](../src/agy-keychain.ts).
