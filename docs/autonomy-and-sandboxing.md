---
read_when: "Choosing autonomy, sandbox trust, or environment scrubbing."
---
# Autonomy and sandboxing

Autonomy chooses the harness's native approval/tool policy. Scode supplies the outer filesystem and network boundary. They are separate controls.

Headless `run` and interactive `tui` default to read-only autonomy and scode. Every level below high requires scode. `--no-sandbox` requires `--auto high`.

## Native mappings

Read-only runs under scode `--ro` on every harness; the rows below name each harness's native policy only.

| Harness | Read-only | Low | Medium | High |
| --- | --- | --- | --- | --- |
| Claude, Z.AI | Plan, with headless web grants | Manual, with headless web grants | Accept edits, with headless edit grant scoped to launch directory, shell grant, and web grants | Skip permissions, with headless edit/write/notebook/shell and web grants |
| Codex | read-only + never approve | workspace-write + untrusted approval | workspace-write + never approve | danger-full-access + never approve |
| Antigravity | Plan + required scode | Print-mode soft denials (default) | Accept edits, with headless command grant | Skip permissions |
| Aider | dry-run | Decline headless confirmations | Auto-confirm | Auto-confirm |
| Cline | Plan | Auto-approve false | Auto-approve true | Auto-approve true |
| Copilot | Plan | Allow read | Allow all tools | Allow all tools, paths, and URLs |
| Cursor | Plan + required scode | Default approvals (print mode rejects a command that needs approval) | Auto-review | Force |
| Droid | Default (read-only mode: no execution without --auto) | Native low | Native medium | Native high |
| Goose | chat | approve | smart_approve | auto |
| Gemini | plan | default | yolo | yolo |
| Kimi | Interactive plan | Interactive prompting | Interactive yolo | Interactive auto |
| OpenHands | Interactive always-ask | Interactive always-ask | Interactive always-ask | Always approve (the headless default) |
| OpenCode | Plan + required scode | Build | Build | Build + auto |
| Pi | No extensions; read/grep/find/ls | No extensions; add edit/write | Default tools | Default tools |
| Qwen | plan | default | auto (classifier approves shell commands) | yolo |

Kimi 2.5.2's headless `--prompt` rejects its interactive autonomy flags (`--plan`, `--yolo`, `--auto`) and their hidden yolo aliases (`--yes`, `--auto-approve`). OpenHands 1.16.0 headless mode auto-approves: its TUI selects the never-confirm policy whenever `--headless` is set. Their headless boundaries therefore depend on scode, not the interactive rows. Antigravity can soft-deny a headless approval while still exiting 0; native success alone does not establish that a requested action ran.

Each cell names what carries the level: a harness flag, the harness's own default state, a stdin answer, or an environment variable; where no native headless carrier exists, scode alone carries the level and the cell says so. Kimi at every level, OpenHands below high, and Pi at medium and high have no native headless carrier, so scode carries them; OpenHands high, Antigravity low, Cursor low, and Droid read-only are carried by the harness's own default state; Aider low is carried by the stdin decline stream; Goose is carried by `GOOSE_MODE`. `codemux autonomy` prints the carrier class per cell.

Aider's low row declines headless confirmations through its stdin: codemux feeds a repeating stream of `n` lines for the child's whole lifetime and never sends EOF while it lives, because aider reads EOF as acceptance of a yes-default confirmation prompt. The stream is bounded and paced: one pending write at a time, and at most one block of 64 lines every 10 ms. A child that stops reading does not grow codemux's memory, and a child that discards its stdin does not keep codemux busy. The child's exit or the run's own termination ends the feeding. Runs and session turns both behave this way.

Codex's row names the flags an unsandboxed launch passes. On the default sandboxed `run` path Codex uses `--dangerously-bypass-approvals-and-sandbox`, so scode alone enforces the level; low and medium sessions keep native read-only access plus `on-request` approvals, including inside scode.

Pi passes `--no-approve` at every level, in the TUI and in headless runs: at 0.85.1 the flag means ignore project-local files (its `--approve` counterpart trusts them), so it gates project trust, not autonomy.

Antigravity medium headless runs add `command(*)` to `permissions.allow` in a private copy of the operator's settings. Existing allow, ask, and deny rules remain; deny rules take precedence. The command grant relies on scode for filesystem and network limits. Read-only, low, and interactive runs keep their native policies.

Claude's subprocess environment hardening can reset its requested native mode to default, which headless denies every tool that would prompt. Codemux's scoped headless edit grant and shell grant preserve the intended write and command behavior, and every headless `run` level also grants `WebSearch` and `WebFetch`; without that grant a read-only or low run could not search or fetch. Neither web tool writes locally, but the web grant is a trade-off: the run reads pages nobody approved, and the model picks the URLs it fetches, so content it reads (a prompt injection in an untrusted repository) can carry local data out in a URL. `--sandbox-no-net` would deny that but also denies the model provider, so it is no remedy here; a review of an untrusted tree passes `--no-web`, which denies the two tools with a deny rule (so it holds at high, where the bypass flag would ignore an absent allow rule, and over an allow rule saved in the operator's settings) and changes nothing else. Persistent sessions do not take the web grant: their ceiling answers each tool call and denies the web tools at every level but low. This is a version-sensitive adapter mapping, not a property scode can enforce for Claude.

Persistent Claude and Z.AI sessions map autonomy with different flags by design: no web grants, medium keeps only the scoped edit grant (no shell grant), and high is `--permission-mode default` plus an explicit grant list rather than the bypass flag, so the session ceiling still answers every tool call. The meaning of each level is unchanged; the flags are not. `codemux autonomy` prints the session note per agent.

For programmatic Claude and Z.AI requests, `web: false` denies both tools even when `autonomy` is omitted. A defined `web` value must be a boolean. Programmatic requests meet the CLI's Playwright option rules in the shared validators: `enablePlaywrightMcp: true` is refused without `sandboxed: true`, refused for an agent whose command builder never attaches the server, and refused with `hermetic: true` or `tools: "none"`; the unsandboxed interactive entry point refuses it outright.

### Medium shell execution

Claude and Z.AI headless `--auto medium` runs add `Bash` alongside the launch-directory `Edit` grant and web grants. Shell commands run inside the required scode sandbox. Persistent sessions retain their per-tool ceiling callback and receive no medium `Bash` grant.

For every harness, `--auto medium` runs edits and shell commands inside the required scode sandbox.

## Scode policy

Codemux maps read-only to scode `--ro` and other levels to `--rw`. Standard trust is the default at every autonomy level. Codex/OpenCode read-only filesystem mode is enforced explicitly. Harness state can remain writable in read-only mode.

| Option | Effect |
| --- | --- |
| `--sandbox-trust standard` | Default scode trust policy. |
| `--sandbox-strict` | Requires `--sandbox`. Deny-default filesystem access; keep project, system, scratch, detected harness state, and explicit grants. Overrides trusted's strict-off setting. External hooks can still fail; see [strict limitations](harnesses.md#harness-limitations). |
| `--sandbox-trust trusted` | Broader trust under scode's policy; independent of autonomy. |
| `--sandbox-trust untrusted` | Scode's strict, no-network, scrubbed, read-only preset. Harness state is denied; persistent sessions refuse it. |
| `--sandbox-no-net` | Add network denial. Remote providers will generally be unreachable. |
| `--sandbox-scrub-env` | Scrub ambient environment. Codemux's deliberately injected variables use the conditional exemption below. |
| `--sandbox-account`, `--sandbox-account-id` | Request scode scratch accounting. Keep its output sink outside the child's writable area; hiding the variables is not protection against file tampering. |

Scode enforcement depends on the installed scode version and platform. The version check verifies the stated minimum, not every operating-system restriction; a prerelease of the minimum (for example `0.6.0-rc1` against the `0.6.0` floor) counts as below it, the same ordering harness versions follow. Harness-native enforcement also remains version-sensitive.

With scode 0.6.7+, executable exceptions use exact-file `--allow-ro` grants. Strict and untrusted executable checks accept them, and strict can read executables behind nested `env` wrappers outside system roots. Older scode retains writable `--allow` exceptions and strict refusals. Caller blocks and refusals for writable state covering executable code remain in force. `--print-sandbox` and `verify --show-scode` use the resolved scode version to select the policy. See [isolation](isolation.md#directory-and-login-requirements) for the remaining runtime limits.

### Conditional scode requirements

| Launch or feature | Requirement |
| --- | --- |
| Ordinary sandboxed launch | General scode minimum 0.2.0. |
| `--sandbox-strict` | The flag exists in scode 0.2.0. Live runtime grants were checked against scode 0.6.5 on macOS; accepting the flag does not certify a harness or customization. |
| Any sandboxed Antigravity headless run, including API-key/file-token login | Scode 0.6.0 or newer. |
| Scrubbed launch whose injected environment carries its only credential, including provider overrides and Z.AI | A scode that documents `--keep-env` in help, introduced in 0.6.0. Missing support refuses before spawn. |
| Scrubbed launch without a required injected credential | Use `--keep-env` if supported; otherwise omit the unsupported flag and preserve the older scrub behavior. |
| Launch without explicit scrub or untrusted trust | No `--keep-env` argument; it has no effect without scrubbing. |
| Scrub enabled only inside a scode config file | Codemux cannot observe it. Use `--sandbox-scrub-env` for automatic exemption handling or configure credential exemptions yourself. |

The exemption covers names injected by the adapter, not every ambient credential. The same policy applies to run, TUI, and session spawns. A `--pass-env` variable is not automatically exempt from scode's credential-pattern scrub.

Codemux removes ambient `SCODE_*` variables, except the accounting values it sets itself. It trust-checks both wrapper and harness executables and rejects known executable project configuration before launch. These checks do not make a same-user concurrent process or administrator-managed configuration untrusted to the operating system.

[Isolation](isolation.md) covers customization loading and tool restrictions. [Authentication](authentication.md) covers writable harness credentials.

Sources: [autonomy mappings](../src/autonomy.ts), [sandbox flags](../src/sandbox.ts), [enforced policy](../src/sandbox-policy.ts), [runtime compatibility](../src/cli-runtime.ts), [headless launch](../src/launch.ts).
