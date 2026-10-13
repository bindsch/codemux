---
read_when: "Choosing hermetic runs or removing tools."
---
# Isolation

`--hermetic` suppresses the supported harness's automatic loading of specified operator and project customizations. It does not make a result reproducible from a prompt alone. Harness versions, built-in instructions, managed settings, the environment, authentication, and the working directory still matter.

`--tools none` is a separate request to restrict tools. Neither flag replaces the filesystem and network boundary supplied by [scode](autonomy-and-sandboxing.md). Both are headless `run`/`check` options; persistent sessions and TUI do not accept them.

## Supported mechanisms

| Harness | Hermetic | Tools none |
| --- | --- | --- |
| Claude Code, Z.AI | `--safe-mode` suppresses user/project instructions, skills, plugins, hooks, custom agents, commands, and operator MCP configuration. | Empty built-in tool list. |
| Codex | Private HOME/CODEX_HOME; project document limit zero; user config and execpolicy rules ignored; customization features disabled. Provider overrides use their generated config instead. | Disables shell, execution, image, browser, computer-use, multi-agent, discovery, and web features. **Keeps `update_plan` and `apply_patch`.** Accepted only at read-only autonomy. |
| Antigravity | Private HOME and XDG state, plus rejection of project instruction paths. Requires explicit clean `--cwd` and read-only scode. | Private deny settings and plan mode; rejects native tool attempts after parsing the stream. Requires read-only scode. Tool schemas can remain visible. |
| OpenCode | Private HOME/config/cache/state, real login data retained; discovery and customization channels disabled; login-carried remote configuration refused. | Hermetic runs only. Deny-all permission configuration; plain operator config could override it. |
| Droid | Refused. Instruction, skill, hook, and MCP channels remain. | `--only-tools ToolSearch`; executable tools are excluded. |
| Kimi Code | Refused. Global and project AGENTS.md loading remains. | Private agent profile with `tools: []`. |
| Pi | Refused. Global SYSTEM.md and APPEND_SYSTEM.md discovery remains. | `--no-tools`, with autonomy's explicit allowlist suppressed. |
| Goose | Refused. Context files and configured system prompts remain. | `--no-profile`, removing tool-bearing extensions. |
| Aider | Refused. Its config, env, and model-settings discovery can inject content despite pinned files. | Refused. No supported empty tool-set mapping. |
| Cursor | Refused. Rules, instructions, hooks, and MCP cannot all be disabled while preserving login. | Refused. |
| OpenHands | Refused. Project and public skill loading remains. | Refused. |
| Copilot | Refused. The required paired canary cannot demonstrate isolation under the standing hardening flags. | Refused. Empty allowlist spellings do not remove tools. |
| Gemini CLI, Cline | Refused. Workspace instruction channels remain. | Refused. No verified complete removal mechanism. |
| Qwen | Refused. Every normal run already uses safe mode, so the paired control cannot leak. | Refused. Safe mode ignores the core-tool allowlist; exclusions can miss new tools. |

These are implemented contracts, not a claim that every currently installed upstream release has passed a live check. See [versions and dated evidence](harnesses.md).

Codex's remaining `apply_patch` can write wherever scode permits writes, including writable harness state and scratch storage. Read-only autonomy protects the project, not every path. Unknown upstream feature names may only warn, so a newer Codex can invalidate a feature-based restriction.

Antigravity denies the native `read_file`, `write_file`, `read_url`, `execute_url`, `command`, `unsandboxed`, and `mcp` action classes. A non-text step, permission refusal, nonempty `denied_actions`, unknown step type, or malformed stream fails an ordinary tools-none run. This detects attempted actions; it does not remove their schemas. The MCP action is denied at its native gateway.

## Directory and login requirements

Antigravity hermetic runs require a dedicated clean directory supplied with `--cwd`. Codemux rejects `GEMINI.md`, `AGENTS.md`, and `.agents`, including empty directories and dangling links, in that directory and ancestors through the project root. Executable project configuration checks still apply.

Codex rejects project `.agents/skills` and `.codex/skills`. Its private home is created inside the real CODEX_HOME, where scode can expose harness state. HOME changes only inside the sandbox command; scode still derives its protections from the real operator home.

OpenCode retains its real data directory for login. Before a hermetic launch, codemux rejects well-known auth entries and active account organizations that can fetch remote configuration. Unreadable, oversized, malformed, linked, or nonregular stores fail closed. The hermetic prefix also removes `OPENCODE_AUTH_CONTENT`. Administrator-managed settings remain.

[Authentication](authentication.md) explains credential linking, mirrors, rotation, and recovery.

## Verification

`codemux check --hermetic -a <agent>` spends model quota. It plants an instruction canary and requires a clean `OK` reply, then runs a control that must reveal the planted code word. A clean control is inconclusive and fails. A model's tool inventory claim is not a capability test.

For most harnesses, adding `--tools none` keeps the same tool selection in both runs. OpenCode's combined check is refused: its non-hermetic control cannot legally use tools-none. Check OpenCode hermetic isolation alone; its tool restriction has separate capability evidence.

Antigravity uses paired instruction/MCP and command-denial probes in scratch operator homes. The tools probe requires the first and only command attempt to be denied with no command output; the control must execute a native command and quote its actual output. Combining flags runs both pairs. Probe scratch homes, native logs, and working directories are removed on known exit paths.

### Experiment MCP exception

Claude alone accepts an explicitly supplied experiment MCP server under `--hermetic --tools none --auto read-only`, starting at Claude 2.1.280. Safe mode remains enabled, the built-in tool list stays empty, and the explicit server is delivered through the SDK control protocol. This is an intentional exception to suppression of operator MCP configuration.

The experiment server runs **outside scode**, with the run directory as cwd and only named environment variables. Its cwd is not containment. The command must pass the executable trust check and sit outside the run directory. The host permits requests only for that server and checks inventory and returned content. Persistent raw recordings may contain sensitive data.

Codex and all other adapters refuse experiment injection. Codex 0.160.1 was observed adding wrapper text to MCP results; codemux does not strip it. See [experiment MCP](experiment-mcp.md) for the specification and recording contract.

## Residual inputs and enforcement

- Tools that remain can read reachable working-directory and harness-state files. Hermetic disables automatic customization loading, not arbitrary file access.
- The sanitized environment and explicitly passed variables remain inputs. Hermetic does not create a fixed environment.
- Administrator-managed Claude, Codex, and OpenCode settings can still apply, including managed hooks.
- Vendor system prompts and bundled skills remain and can change with the harness version.
- Safe modes can remove the operator's own hooks and deny rules. Scode supplies filesystem/network restrictions; native harness policies still decide tool exposure and approvals.
- Same-user concurrent processes can modify readable enforcement files or the harness binary. Scode is not isolation between mutually hostile processes owned by the same user.
- Login and server-side account state can affect behavior. Network responses are not pinned.
- Cleanup is not guaranteed after SIGKILL or a host crash.

## What persists

| State | Lifetime and behavior |
| --- | --- |
| Codex hermetic HOME and one-shot provider home | Removed after the run. Stale one-shot directories are eligible only after two days based on the newest tree modification and a dead owner; live owners are retained. |
| OpenCode hermetic home and per-run provider files; Kimi tool profile; Droid/Pi provider files | Removed by their run cleanup. Interrupted runs can leave files for later cleanup. |
| Antigravity private home and file-token/Keychain copies | Removed on known exits. Recovery considers validated, marked, user-owned homes with dead owners; see authentication. |
| Codex real auth.json | Linked into subscription hermetic homes; in-place refreshes persist in the real login. Provider-key runs do not link it. |
| Claude access-token mirror and credential backups | Persistent shared credential state; backups are not temporary run data. |
| Antigravity plain-run settings, conversations, and project state | Existing entries are individually linked from the operator's state. OAuth and probe-root entries are excluded. Hermetic/tools-none runs use private state. |
| Other harness-owned state | May persist according to that harness. A one-shot codemux result does not promise zero disk writes or no native history for every adapter. |
| Calls ledger | Persistent per-call metadata in codemux's state directory, unless explicitly disabled. |
| Experiment recordings | Persistent raw protocol/byte recordings; cleanup of the run does not remove them. |
| Session registry, native transcripts, session provider homes | Deliberately persistent and resumable; session does not support hermetic mode. |

Claude/Z.AI use `--no-session-persistence`; Codex uses `--ephemeral` for one-shot runs. Those flags do not erase credential mirrors, shared state, the calls ledger, or experiment recordings.

Implementation: [adapters](../src/adapters/), [Codex private homes](../src/hermetic-home.ts), [OpenCode private homes](../src/opencode-hermetic.ts), and [canary checks](../src/hermetic-canary.ts).

