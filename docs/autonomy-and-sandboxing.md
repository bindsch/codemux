---
read_when: "Choosing autonomy, sandbox trust, or environment scrubbing."
---
# Autonomy and sandboxing

Autonomy chooses the harness's native approval/tool policy. Scode supplies the outer filesystem and network boundary. They are separate controls.

Headless `run` and interactive `tui` default to read-only autonomy and scode. Every level below high requires scode. `--no-sandbox` requires `--auto high`.

## Native mappings

| Harness | Read-only | Low | Medium | High |
| --- | --- | --- | --- | --- |
| Claude, Z.AI | Plan, with headless web grants | Manual, with headless web grants | Accept edits, with headless edit grant scoped to launch directory and web grants | Skip permissions, with headless edit/write/notebook/shell and web grants |
| Codex | read-only + never approve | workspace-write + untrusted approval | workspace-write + never approve | danger-full-access + never approve |
| Antigravity | Plan + required scode | Native prompting | Accept edits | Skip permissions |
| Aider | dry-run | Decline headless confirmations | Auto-confirm | Auto-confirm |
| Cline | Plan | Auto-approve false | Auto-approve true | Auto-approve true |
| Copilot | Plan | Allow read | Allow all tools | Allow all tools, paths, and URLs |
| Cursor | Plan + required scode | Default approvals | Auto-review | Force |
| Droid | Default mode | Native low | Native medium | Native high |
| Goose | chat | approve | smart_approve | auto |
| Gemini | plan | default | auto_edit | yolo |
| Kimi | Interactive plan | Interactive prompting | Interactive yolo | Interactive auto |
| OpenHands | Interactive always-ask | Interactive always-ask | Interactive always-ask | Always approve |
| OpenCode | Plan + required scode | Build | Build | Build + auto |
| Pi | No extensions; read/grep/find/ls | No extensions; add edit/write | Default tools | Default tools |
| Qwen | plan | default | auto | yolo |

Kimi's headless `--prompt` rejects its interactive autonomy flags. OpenHands headless mode auto-approves. Their headless boundaries therefore depend on scode, not the interactive rows. Antigravity can soft-deny a headless approval while still exiting 0; native success alone does not establish that a requested action ran.

Claude's subprocess environment hardening can reset its requested native mode to default, which headless denies every tool that would prompt. Codemux's scoped headless tool grants preserve the intended write behavior, and every headless `run` level also grants `WebSearch` and `WebFetch`; without that grant a read-only or low run could not search or fetch. Neither tool writes locally, but the grant is a trade-off: the run reads pages nobody approved, and the model picks the URLs it fetches, so content it reads (a prompt injection in an untrusted repository) can carry local data out in a URL. `--sandbox-no-net` would deny that but also denies the model provider, so it is no remedy here; a review of an untrusted tree passes `--no-web`, which denies the two tools with a deny rule (so it holds at high, where the bypass flag would ignore an absent allow rule, and over an allow rule saved in the operator's settings) and changes nothing else. Persistent sessions do not take the grant: their ceiling answers each tool call and denies the web tools at every level but low. This is a version-sensitive adapter mapping, not a property scode can enforce for Claude.

## Scode policy

Codemux maps read-only to scode `--ro` and other levels to `--rw`. Standard trust is the default at every autonomy level. Codex/OpenCode read-only filesystem mode is enforced explicitly. Harness state can remain writable in read-only mode.

| Option | Effect |
| --- | --- |
| `--sandbox-trust standard` | Default scode trust policy. |
| `--sandbox-trust trusted` | Broader trust under scode's policy; independent of autonomy. |
| `--sandbox-trust untrusted` | Scode's strict, no-network, scrubbed, read-only preset. Harness state is denied; persistent sessions refuse it. |
| `--sandbox-no-net` | Add network denial. Remote providers will generally be unreachable. |
| `--sandbox-scrub-env` | Scrub ambient environment. Codemux's deliberately injected variables use the conditional exemption below. |
| `--sandbox-account`, `--sandbox-account-id` | Request scode scratch accounting. Keep its output sink outside the child's writable area; hiding the variables is not protection against file tampering. |

Scode enforcement depends on the installed scode version and platform. The version check verifies the stated minimum, not every operating-system restriction. Harness-native enforcement also remains version-sensitive.

### Conditional scode requirements

| Launch or feature | Requirement |
| --- | --- |
| Ordinary sandboxed launch | General scode minimum 0.2.0. |
| Any sandboxed Antigravity headless run, including API-key/file-token login | Scode 0.6.0 or newer. |
| Scrubbed launch whose injected environment carries its only credential, including provider overrides and Z.AI | A scode that documents `--keep-env` in help, introduced in 0.6.0. Missing support refuses before spawn. |
| Scrubbed launch without a required injected credential | Use `--keep-env` if supported; otherwise omit the unsupported flag and preserve the older scrub behavior. |
| Launch without explicit scrub or untrusted trust | No `--keep-env` argument; it has no effect without scrubbing. |
| Scrub enabled only inside a scode config file | Codemux cannot observe it. Use `--sandbox-scrub-env` for automatic exemption handling or configure credential exemptions yourself. |

The exemption covers names injected by the adapter, not every ambient credential. The same policy applies to run, TUI, and session spawns. A `--pass-env` variable is not automatically exempt from scode's credential-pattern scrub.

Codemux removes ambient `SCODE_*` variables, except the accounting values it sets itself. It trust-checks both wrapper and harness executables and rejects known executable project configuration before launch. These checks do not make a same-user concurrent process or administrator-managed configuration untrusted to the operating system.

[Isolation](isolation.md) covers customization loading and tool restrictions. [Authentication](authentication.md) covers writable harness credentials.

Sources: [autonomy mappings](../src/autonomy.ts), [sandbox flags](../src/sandbox.ts), [enforced policy](../src/sandbox-policy.ts), [runtime compatibility](../src/cli-runtime.ts), [headless launch](../src/launch.ts).
