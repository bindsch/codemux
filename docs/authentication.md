---
read_when: "Diagnosing native login or private-home cleanup."
---
# Authentication

Native login-store access is off by default. On macOS, opt in for sandboxed Claude or agy with `--sandbox-login-store` or user/global config `sandboxLoginStore: true`. With this grant, every process inside the sandbox can read Keychain items whose access list trusts `/usr/bin/security` without a dialog. This includes the harness's own login and refresh token, and tokens other tools stored through `security`, for example a GitHub CLI token. Every process can read and copy `login.keychain-db`, which is encrypted with the account login password, and attack it offline. It can also create, modify, or delete files in `Library/Keychains`. The optional `Library/Preferences/com.apple.security.plist` is read-only when it exists, so the sandbox cannot change the default keychain or search list through that preference file. This is not per-item Keychain isolation.

`--sandbox-no-login-store` or `sandboxNoLoginStore: true` overrides any opt-in. Without the grant, codemux omits native login-store access and Claude's plaintext credential, staged-file, and refresh-lock grants. A Keychain login cannot then be used inside this sandbox; native file login or refresh that needs these grants also stops working. A supported API key or provider override can supply authentication instead. `--sandbox-trust untrusted`, provider overrides, and Z.AI never receive native login-store grants, even with opt-in; untrusted also disables networking and is refused for persistent sessions. With the grant, the harness can use and refresh its existing login in place: codemux does not read, copy, or change the macOS login and never runs `security`.

Codemux uses the selected harness's login or its supported [provider override](provider-overrides.md). It does not implement a separate account login. Credential variables are allowlisted per harness; `--pass-env` explicitly adds names subject to the launch safeguards. Sandboxed environment scrubbing can remove ambient credentials.

## Claude Code

On macOS, Claude Code reads and refreshes its own native login. Codemux launch preparation does not read, copy, rewrite, back up, or remove login tokens. A private `CLAUDE_CONFIG_DIR` isolates settings and transcripts while `CLAUDE_SECURESTORAGE_CONFIG_DIR` selects the existing login independently.

Upgrade from 2.0.3: codemux previously read the Keychain and copied a short-lived Claude access token on every launch. Version 2.0.4 never reads it. Sandboxed macOS Claude and agy now need `--sandbox-login-store` or user/global `sandboxLoginStore: true` to use Keychain authentication. Without the grant, stderr says the login is inaccessible every launch, once per session, even when redirected. It does not say the account is logged out. Native authentication advice repeats the denied-grant limitation instead of treating another login as a remedy for denied access.

| Condition | Behavior |
| --- | --- |
| Default macOS login with private configuration | Set `CLAUDE_SECURESTORAGE_CONFIG_DIR` to the empty string. An absolute `~/.claude` path would select a different Keychain entry. |
| Operator `CLAUDE_CONFIG_DIR` profile with private configuration | Preserve that operator directory as `CLAUDE_SECURESTORAGE_CONFIG_DIR` before redirecting configuration. |
| Launch that does not redirect configuration (run, TUI, or session without a private configuration directory) | The login follows the configuration the child reads. An operator `CLAUDE_CONFIG_DIR` forwarded with `--pass-env` selects that profile's login. One that is exported but not forwarded does not reach the child, which reads `~/.claude`, so the login and the login-store grants are the default ones. |
| Explicit `CLAUDE_SECURESTORAGE_CONFIG_DIR` | Preserve its value, including the empty string. |
| Existing macOS plaintext credential file | Leave its contents unchanged; with native login-store opt-in, grant the individual file when its operator directory is blocked. |
| Missing macOS credential file | Do not create one or infer that the native login is missing. |
| Linux private configuration | Copy only the access token into private `.credentials.json`, mode 0600; omit the refresh token and leave the source unchanged. |
| Untrusted sandbox | Grant neither native Keychain paths nor the operator plaintext credential file. |
| Provider override or Z.AI | Add no operator secure-storage binding or native login grants; use the gateway credential. |

On macOS, opted-in trusted and standard sandbox launches grant read/write access to the native `Library/Keychains` directory and read-only access to `Library/Preferences/com.apple.security.plist` when it exists. Native writes need the directory for sidecars and replacement files. Every sandboxed process receives this access, with the cross-tool exposure stated above. The deny flag/config and caller blocks remain authoritative. A provider override removes ambient `ANTHROPIC_API_KEY` and `CLAUDE_CODE_OAUTH_TOKEN` from the child environment and receives no native login grant.

An opted-in macOS launch with an existing `Library/Preferences/com.apple.security.plist` requires scode 0.6.7+ for `--allow-ro`. Older versions refuse the launch (on macOS the 0.6.11 floor refuses them first); the preference file never receives a writable fallback grant. This requirement also applies to agy.

Claude's native refresh locks follow the secure-storage directory, even when configuration is private. With opt-in, codemux grants the individual `.oauth_refresh.lock` directory, `.oauth_refresh.lock.owner` file, and legacy `<secure-storage-directory>.lock` sibling. It does not grant the whole operator config directory. These paths can be absent before the harness creates them.

Claude 2.1.325 writes plaintext credentials and lock-owner metadata through sibling staging files: `.credentials.json.tmp.<8 hex digits>` and `.oauth_refresh.lock.owner.tmp.<8 hex digits>`. The macOS kernel matches these grants without regard to case; codemux also refuses caller blocks of uppercase or mixed-case staging names. With scode 0.6.8 or newer, codemux uses `--allow-staged` for these base files on macOS. Each grant permits only the base file and its bounded staging siblings, including atomic replacement, while operator settings remain blocked. Older scode retains exact `--allow` grants and cannot complete this staging path under a blocked operator directory; on macOS that case no longer arises, because every sandboxed launch there requires scode 0.6.11.

The same native-login selection applies to hermetic runs, project-settings runs, persistent sessions, and caller-owned homes. Cleanup removes private configuration; Claude's login remains in its native store. On Linux the private access-token copy lasts until cleanup and cannot refresh itself.

Health reports an unknown macOS login unless it has positive evidence. An absent plaintext file is not evidence of a missing Keychain login. Neither doctor nor the live gate recommends login merely because inspection is unavailable; a native harness authentication error supplies that evidence.

A launch never inspects or rewrites the operator's own login files on macOS; only `codemux doctor` and health reports read `.credentials.json`, and only to report a login state. A file-only or leftover `~/.claude/.credentials.json`, including one still holding a refresh token, is the harness's own file and the user's to remove. That stance and the opt-in-only login store are owner decisions; see [owner decisions](isolation.md#owner-decisions).

`CLAUDE_SECURESTORAGE_CONFIG_DIR` first appears in the official macOS arm64 npm distribution at Claude Code 2.1.144; the immediately preceding 2.1.143 binary lacks it. Static inspection confirms the default and profile selection logic in 2.1.144 and installed 2.1.325. The existing 2.1.220 contract minimum already exceeds that boundary. The official changelog does not name the variable. Scode 0.6.8 is the minimum for zero scode-owned credential commands. It removed credential synchronization, retains `--no-credential-sync` as a no-op, preserves empty kept variables, and adds bounded staging grants. See [release checks](RELEASE-GATE.md).

Implementation: [Claude credential environment](../src/adapters/claude-credentials.ts), [Claude sandbox preparation](../src/adapters/claude.ts), and [Z.AI adapter](../src/adapters/zai.ts).

## Z.AI

The `zai` adapter runs Claude Code against
`https://api.z.ai/api/anthropic`. A nonblank `ZAI_API_KEY` takes precedence
over `~/.zai` under the adapter's effective home. The file must be a regular
file owned by the current user, mode 0600 or stricter, with no final symlink.
Input is limited to 16 KiB, trimmed, and must contain one credential line
without NUL. Codemux removes the source ZAI_API_KEY after translating it into
the child gateway token.

A sandboxed Z.AI launch uses its gateway token. Codemux does not inspect or
change the operator's Claude credential file, bind its secure-storage profile,
or grant its native login paths.

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

The private run pins `cli_auth_credentials_store="file"` and requires the corresponding `auth.json` for subscription authentication. An absent file prevents this private-home path; it does not prove that the native Codex login is missing. Codemux does not inspect its Keychain login or prescribe signing in from that absence alone.

An effective `CODEX_API_KEY` takes precedence and leaves the private home without a linked login. An unrelated `OPENAI_API_KEY` does not select this path. Provider overrides also use a private home without operator auth. A passed-through CODEX_HOME selects the same real home a plain run would use.

Known exits remove one-shot homes. A later launch sweeps dead-owner one-shot homes only after their newest tree modification is at least two days old. Session homes have separate retention and registry rules; see [sessions](sessions.md).

Implementation: [private homes](../src/hermetic-home.ts), [Codex adapter](../src/adapters/codex.ts).

## Kimi Code

Hermetic runs create a private HOME and KIMI_CODE_HOME with a filtered `config.toml`. The private `credentials` directory is a symlink to the real brand home's credentials directory. Kimi writes refreshed tokens to temporary files and renames them inside that directory. The symlink keeps those renames in the real directory. A hard link to an individual token file would retain the old inode after replacement and let the two logins diverge.

Kimi's token storage constructor accepts the directory without a symlink check. Its recursive directory creation and permission tightening follow the directory symlink. Private homes copy `region` and `device_id` when present to preserve the native login identity. Each is read as a regular file of at most 4096 bytes without following symlinks and written mode 0600. Cleanup removes the private home and its credential-directory link; refreshed credentials remain in the real directory. Passing through KIMI_CODE_HOME is refused on hermetic runs.

Kimi serializes token refresh across processes itself. Before it rotates the refresh token it takes a lock under its brand home: the lock directory `oauth/<provider>.lock` in `KIMI_CODE_HOME` (Kimi 2.6.0; not on Windows). A private home that shared only `credentials` shared the token file and not that lock, so a private-home Kimi and any other Kimi could rotate the same refresh token at the same time, and the provider revoked the login. Every private Kimi home therefore links `oauth` to the real brand home's `oauth` directory, the way it links `credentials`: hermetic and `--tools none` runs, private policy homes, project-settings runs, hermetic sessions, caller-owned `--harness-home` directories, and check canaries. Codemux creates the real directory with mode 0700 when it is absent. A brand home codemux cannot write is left unchanged: the link then names a directory that does not exist yet, and Kimi refuses to refresh without its lock, as a native Kimi does in that home. The directory is `<brand home>/oauth` as configured, also when `credentials` itself is a symlink to another directory. A session home created by 2.0.3 or earlier gains the link on resume; a directory Kimi made for itself there, holding only its empty lock files, is replaced, and any other entry at that path refuses the launch by path and is never deleted. A caller-owned home's sandbox grants the directory beside the credential store.

Codemux holds no lock of its own while a Kimi child runs. Concurrent Kimi launches, a Kimi run beside an open Kimi TUI or session, and a Kimi agent that delegates to `codemux run -a kimi` all start without waiting. Codemux never sets `KIMI_DISABLE_OAUTH_LOCK`. An exported value reaches the child unchanged under `--pass-env KIMI_DISABLE_OAUTH_LOCK`, like any other variable; with it Kimi takes no lock and concurrent refreshes are unprotected. Private homes copy `device_id` and `region` from the real brand home before each child and publish a value Kimi created there afterward, under a short exclusive lock held only for the copy. A plain run reads the real brand home directly and is never refused or changed by this step. Provider-side revocation is outside codemux's control. Health reports readable empty token fields or an expired access token without a refresh token as file facts. It cannot establish provider revocation from those facts and gives no login advice. A native Kimi authentication error supplies the basis for following Kimi's login remedy.

Implementation: [Kimi private homes](../src/kimi-hermetic.ts), [the refresh-lock link](../src/kimi-oauth-link.ts), and [device state](../src/kimi-auth-state.ts).

## Copilot on macOS

For sandboxed runs, both headless and TUI, codemux sets `COPILOT_PKG_CACHE_HOME` to
`~/.cache/copilot` under the adapter's HOME. Copilot 1.0.85 appends
`pkg/darwin-arm64` when extracting its bundled package. Scode permits this
cache directory; the default `~/Library/Caches/copilot` is blocked.

Passing through a `COPILOT_PKG_CACHE_HOME` or `COPILOT_CACHE_HOME` that is set
with `--pass-env` preserves the operator's value and suppresses this default —
an empty-string value included: the passthrough is the operator's authorization
for that name, and copilot then falls back to its own default cache.
Copilot gives `COPILOT_PKG_CACHE_HOME` precedence over `COPILOT_CACHE_HOME`.
Unsandboxed runs, other platforms, adapters without HOME, and passed-through
cache settings that are set receive no cache override. The extracted
package cache persists between runs.

## Cursor on macOS

Cursor's default login lives in the macOS Keychain, which scode blocks.
For sandboxed runs, headless and TUI alike, codemux sets `AGENT_CLI_CREDENTIAL_STORE=file`
when `~/.cursor/auth.json` exists under the adapter's HOME, unless
`AGENT_CLI_CREDENTIAL_STORE` is passed through with
`--pass-env AGENT_CLI_CREDENTIAL_STORE` while set — an empty-string value
included: the passthrough is the operator's authorization for that name, and
cursor then falls back to its default store. The file-store selection also
applies when an API key or auth token is set.

A passed-through API key (`--pass-env CURSOR_API_KEY`) or auth token
(`--pass-env CURSOR_AUTH_TOKEN`) also works.

If a sandboxed run fails with `Authentication required` in stderr, codemux
appends `cursor reported authentication required; the sandbox cannot reach the
macOS Keychain login, so log in with the file store
(AGENT_CLI_CREDENTIAL_STORE=file cursor-agent login), or pass an API key or
auth token` to stderr. The file-store spelling matters: `cursor-agent login`
without `AGENT_CLI_CREDENTIAL_STORE=file` stores the login in the Keychain the
sandbox cannot read, so the next sandboxed run fails the same way. This advice
follows Cursor's own error and preserves its exit code. An absent file by
itself produces no login instruction.

`--no-sandbox` keeps Cursor's default Keychain login. Codemux does not copy
Keychain credentials into the file store.

## Antigravity

Antigravity authenticates itself through its native login. Unsandboxed plain runs keep their existing behavior. Sandboxed runs use a temporary private HOME; scode 0.6.8 or newer is required for zero scode-owned credential commands, and on macOS every sandboxed launch requires scode 0.6.11 or newer. On macOS, codemux links the real `Library/Keychains` directory and, when present, `Library/Preferences/com.apple.security.plist` into that home, on the native-login route and on the API-key route alike: the directory link selects no login, and it keeps the child out of the state in which macOS shows a keychain dialog (see [private homes and the macOS default keychain](isolation.md#private-homes-and-the-macos-default-keychain)). The file token is linked on the native-login route only. Only opted-in eligible trusted and standard sandboxes receive read/write access to the Keychains directory and read-only access to the existing preference file. Untrusted sandboxes and provider overrides receive neither grant. Mach lookup is otherwise permitted, but scode 0.6.11 denies the Mach services a keychain or authorization dialog is requested through (`com.apple.authd`, the security agent names, and `com.apple.securityd.xpc`) to every sandbox without the applied login-store grant. So only a sandbox with the grant reaches the keychain services; every process in such a sandbox does, with the cross-tool exposure stated above.

The native file token, `.gemini/antigravity-cli/antigravity-oauth-token`, is linked when present. It is agy's own state file, not the Keychain login store, so it needs no `--sandbox-login-store`. Every agy sandbox that authenticates with the operator login is granted that one existing file, read-write and by exact path, never its directory, on every platform and without the opt-in. This covers plain, hermetic, and `--tools none` runs and sessions, whose private home links to the token inside the blocked real `~/.gemini`. `--sandbox-trust untrusted` and `--sandbox-no-login-store` withhold it, and so does an effective `GEMINI_API_KEY` or `GOOGLE_API_KEY`, which replaces the operator login. A withheld token that no other block covers is blocked by exact path, because a plain run leaves the rest of `~/.gemini` reachable. The grant is read-write at every `--auto` level, `read-only` included, because agy refreshes the token in place; a read-only sandboxed agy can therefore overwrite that one file. A caller's `--sandbox-block` over the token wins over this default grant; with `--sandbox-login-store` the same conflict is refused. A missing token is never created. Codemux does not read or copy agy's credential contents, create a Keychain, or query or change the Keychain search list or default. Agy reads and refreshes its own live login. Effective API-key environment variables still follow the sandbox environment policy. No API key is required solely because HOME is private.

Plain sandboxed runs and sessions share existing settings, conversations, and project state through individual links. The whole `.gemini` directory is never linked. A plain sandboxed session also blocks the operator's real `.gemini`, then re-allows its private home and, by exact path, each shared entry the private home links to: the entries of `.gemini` and of `.gemini/antigravity-cli` that existed at launch, and the `conversations` directory. The link targets sit inside the blocked tree and the sandbox decides on the resolved path, so each needs its own grant. The `.gemini` and `antigravity-cli` directories themselves, other launches' private homes, and anything created there later stay blocked. A caller's `--sandbox-block` over a shared entry keeps that entry closed; a block inside a shared directory is refused. Medium runs use a private settings copy with the headless command grant. The temporary HOME is removed after the child exits; conversations remain available for resume.

Hermetic runs and sessions keep configuration and conversation state private while sharing the same live native login. A hermetic session's home persists across turns and resume, settles onto `session-<conversation id>`, and is removed by `--final` or the stale-home sweep. Resume checks its login marker and native links without reading Keychain items, and adds a link for a login path the operator gained since the last turn. A hermetic session home written by 2.0.1 through 2.0.3 held a private login copy: a copied token file, or a private `Library/Keychains` directory with a codemux-made mirror and the private preference file that selected it. On resume codemux removes those copies, which are its own files inside the private home, links the native login in their place, and rewrites the marker to `native`. A private Keychains directory that holds anything other than the mirror files refuses the resume and removes nothing. Opening a hermetic agy session also migrates the other idle 2.0.x session homes the registry reports as free, so a copied login does not stay on disk until its session is resumed. Caller-owned `--harness-home` sessions use the same native login links and retain caller settings. See [sessions](sessions.md).

When neither a file token nor an API key is present on macOS, health and `doctor` report `LOGIN-UNKNOWN` with store `macOS Keychain`. This does not claim that the account is logged out or that authentication succeeds. Usage and quota paths do not read Keychain credentials; an unavailable measurement remains unknown. The live gate allows an unknown login to reach the harness instead of skipping it as logged out.

Cleanup removes private homes and their links, not the native login targets. Known exit paths and stale-home recovery do not invoke Keychain commands. The former private-Keychain mirror and recovery implementation was retired in 2.0.4. This promise covers codemux-owned code; native harnesses and external scode versions can perform their own credential operations. Historical live results do not certify the replacement: observing whether macOS displays a prompt requires an owner-run live check, recorded separately from offline tests.

Implementation: [Antigravity adapter](../src/adapters/agy.ts), [native login links](../src/agy-auth.ts), and [session private-home content](../src/session/agy-private-home.ts).
