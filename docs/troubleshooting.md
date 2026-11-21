---
read_when: "Diagnosing a refusal or a failed run."
---
# Troubleshooting

Start with `codemux --version`, `codemux doctor`, and
`codemux verify --show-scode`. They do not send model prompts.
`codemux check` does and can consume quota even when it fails.

| Symptom | Action |
|---|---|
| scode missing/incompatible | Install the [required version](autonomy-and-sandboxing.md#conditional-scode-requirements); ordinary launches use sandboxing by default |
| Unknown option or missing argument | Check `<command> --help`; parser errors exit 1, pre-launch refusals of the request itself exit 64 |
| Invalid configuration | Correct the YAML at the path in the diagnostic; help/version/doctor remain available |
| Model rejected before network request | Check the harness's supported models and [provider routing](provider-overrides.md) |
| Claude reports a native authentication error | If the sandbox was not granted its login store, resolve that policy first; signing in again cannot enable sandbox access. Otherwise keep the harness's diagnostic and follow its login or storage remedy. On macOS Claude owns login and refresh. See [authentication](authentication.md#claude-code) |
| Claude or agy reports `LOGIN-UNKNOWN` on macOS | No login action is implied. Codemux does not inspect Keychain credentials; a missing plaintext file does not establish logout |
| Claude or agy says the login store is inaccessible in the sandbox | Access defaults off in 2.0.4. This does not mean the account is logged out. Review [the exposure](isolation.md#native-login-store-exposure), then opt in with `--sandbox-login-store` or user/global `sandboxLoginStore: true`, or use a supported API key/provider override. The notice appears on stderr every launch, once per session, even when redirected. |
| Opt-in still reports a denied login grant | `--sandbox-no-login-store` or `sandboxNoLoginStore: true` wins; untrusted trust, provider overrides, and Z.AI also never receive the grant. Native authentication advice repeats the denied-grant limitation; signing in again cannot enable sandbox access. A resumed session keeps its recorded grant: resume cannot enable a grant absent from the original session, whatever the config says. |
| Agy login/Keychain failure | Read [Agy native authentication](authentication.md#antigravity); agy owns login and refresh, while codemux only links the native paths. Retain diagnostics; offline checks cannot confirm the absence of macOS prompts |
| A Kimi launch refuses with "refresh-lock" and a path | The private home holds its own entry at `.kimi-code/oauth`, where codemux links Kimi's refresh-lock directory, or the real `oauth` entry is not a directory. Codemux never deletes either. Remove the named entry and launch again; see [Kimi Code authentication](authentication.md#kimi-code) |
| Kimi was signed out after concurrent runs on 2.0.3 or earlier | Private homes shared the token file without Kimi's refresh lock, so two Kimi processes could rotate one refresh token and the provider revoked the login. Sign in again with `kimi login`; 2.0.4 private homes share the lock. A Kimi launch no longer waits for other codemux Kimi processes |
| Kimi health reports empty or expired tokens | These are readable file facts, not proof of provider revocation. Keep any native Kimi authentication error and follow its remedy; health inspection alone gives no login instruction |
| Output exceeds capture limit | Reduce individual tool-result lines, reply volume, or stderr; discarded aggregate tool traffic is not the only bound |
| Resume rejected | Verify the recorded agent, canonical cwd, provider identity, trusted registry, and native state |
| Registry unavailable | Retry after restoring access; I/O failure can exit 1, trust/policy refusals 78 |
| Usage integration unavailable | Install [usagemux](https://github.com/bindsch/usagemux#install); it is optional |

After interruption, resume is possible only if identity, registry, and harness
state were already persisted successfully. A killed process does not itself
establish a resumable session. Session failures remain visible through terminal
events and exit status; see [sessions](sessions.md).

Do not use a canary success as proof of all possible isolation channels.
The [isolation reference](isolation.md) states the supported guarantee and
remaining inputs. Historical probe reports identify their versions and evidence
limitations in the [archive](archive/index.md).
