# Troubleshooting

Start with `codemux --version`, `codemux doctor`, and
`codemux verify --show-scode`. They do not send model prompts.
`codemux check` does and can consume quota even when it fails.

| Symptom | Action |
|---|---|
| scode missing/incompatible | Install the [required version](harnesses.md); ordinary launches use sandboxing by default |
| Unknown option or missing argument | Check `<command> --help`; parser errors exit 1 |
| Invalid configuration | Correct the YAML at the path in the diagnostic; help/version/doctor remain available |
| Model rejected before network request | Check the harness's supported models and [provider routing](provider-overrides.md) |
| 401 or expired Claude access token | Refresh the operator login and read [credential mirror behavior](authentication.md); mirror access tokens cannot refresh |
| Agy login/Keychain failure | Read [Agy recovery](authentication.md); retain diagnostics and avoid editing private-home ownership markers |
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
