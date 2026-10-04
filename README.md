# codemux

> **Beta software (v0.6.0).** `codemux` is under active development. Expect behavior changes as adapters and sandbox policy continue to harden.

`codemux` is a unified CLI for AI coding agents. It gives one command surface
for multiple harnesses, normalizes autonomy/effort semantics, and can route
`run` and `tui` execution through `scode` for a single sandbox boundary.

## Quickstart

```bash
# 1) install and link
bun install
bun link

# 2) run one prompt (default agent: claude)
codemux run -p "summarize this repository"

# 3) run with explicit agent/model/autonomy
codemux run -a codex -m gpt5-codex --auto medium -p "refactor auth module"

# 4) opt out of the default scode sandbox (high autonomy only)
codemux run -a claude --no-sandbox --auto high -p "audit dependencies"

# 5) inspect wiring and effective sandbox commands
codemux verify --show-scode
```

## Why codemux

- One CLI across multiple agent harnesses.
- Normalized autonomy levels: `read-only`, `low`, `medium`, `high`.
- Optional normalized effort levels for harnesses that support them.
- External sandbox boundary through `scode` for `run` and `tui`.
- Built-in diagnostics (`doctor`, `check`, `autonomy`, `verify`).
- Optional normalized subscription usage through the standalone `usagemux` CLI.

## Installation

### Prerequisites

- [Bun](https://bun.sh) 1.3.14 or newer (runtime + package manager; CI pins 1.3.14 exactly)
- Installed agent CLIs you plan to use (`aider`, `claude`, `cline`, `copilot`, Cursor's `agent`, etc.)
- [scode](https://github.com/bindsch/scode) 0.2.0 or newer if you use `--sandbox`

The installed launcher and process-tree controls currently support macOS and
Linux. Windows is not a supported target in this release.

### Install from source

```bash
git clone https://github.com/bindsch/codemux.git
cd codemux
bun install --frozen-lockfile
bun link
```

This release is distributed as source through GitHub. The package is
intentionally private and is not published to npm.

## Usage

```text
codemux [command] [options]
```

### Commands

| Command | Purpose |
|---------|---------|
| `run` | Non-interactive prompt execution |
| `tui` | Interactive harness session |
| `check` | Live provider/model probe (uses credentials and may incur charges) |
| `list` | Agent capability overview |
| `doctor` | Installation and capability diagnostics |
| `usage` | Subscription quota through optional `usagemux` integration |
| `autonomy` | Autonomy equivalence matrix |
| `verify` | Static wiring validation + optional scode preview |

### `run` options

| Flag | Description |
|------|-------------|
| `-a, --agent <agent>` | Agent id (default: `claude`) |
| `-m, --model <model>` | Model name or alias |
| `-p, --prompt <prompt>` | Prompt text |
| `-f, --file <path>` | Read prompt text from file, or from stdin with `-` |
| `--timeout <seconds>` | Kill a hung non-interactive run and its whole process tree (a descendant whose parent chain broke before the first snapshot can still escape; also bounds the `-f -` stdin prompt read — a producer that stalls with the pipe open fails the run at the timeout; default: `1800`, maximum: `86400`) |
| `--pass-env <names>` | Explicitly pass comma-separated parent environment names |
| `--enable-playwright-mcp` | Enable a local Playwright MCP binary inside `--sandbox` |
| `--hermetic` | Load none of the operator's customizations (instruction files, skills, plugins, hooks, MCP servers); the login still works. Claude, Z.AI and Codex; others are refused. See [docs/HERMETIC.md](docs/HERMETIC.md) |
| `--tools <selection>` | Built-in tools the harness exposes: `default` or `none`. Independent of `--hermetic`; Codex takes `none` only with `--auto read-only` |
| `--result-json` | Return a structured result envelope on stdout instead of plain text, so a caller can read what the run consumed (tokens, cost). Claude, Z.AI and Codex; other harnesses refuse the flag rather than silently returning text. Claude-family envelopes are the harness's own with one added `codemux` block; Codex reports the final assistant message as `result` plus the same block. See [Result envelopes](#result-envelopes) |
| `-s, --sandbox` | Execute via `scode` (default: on; `--no-sandbox` opts out, and autonomy below `high` then refuses) |
| `--sandbox-trust <level>` | `scode` trust override (`trusted`, `standard`, `untrusted`) |
| `--sandbox-no-net` | Add `--no-net` to `scode` |
| `--sandbox-scrub-env` | Add `--scrub-env` to `scode` |
| `--sandbox-account <file>` | Request scode's per-run scratch accounting; scode appends one JSON line per run (scratch KiB, duration, exit code) to `file` — absolute path required; keep it outside the sandbox's writable area (a sink inside the working directory warns: records there are forgeable) |
| `--sandbox-account-id <id>` | Opaque correlation token recorded in that accounting line; accepts letters, digits, and `. _ : -` (1-128 chars), and requires `--sandbox-account` |
| `--auto <level>` | Autonomy (`read-only`, `low`, `medium`, `high`) |
| `--effort <level>` | Effort (`none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, `ultra`; availability is harness-specific) |
| `--cwd <path>` | Working directory |

Use `--file` instead of `--prompt` for sensitive input so the Codemux command
line itself does not expose the prompt through process inspection; `-f -`
reads the same prompt from stdin (a terminal stdin is refused — pipe it
instead). Stdin is not argv, so it is not bound by the argv limit, but a
stdin prompt above 16 MiB is rejected and an empty one is an error. The
stdin read is bounded by `--timeout` like the run itself, so a prompt
producer that stalls with the pipe open fails the run instead of hanging
the caller. Some
upstream harnesses only accept their final task as an argument; Codemux
cannot remove that upstream limitation for Aider, Cline, Copilot, Gemini,
Goose, Kimi, OpenHands, or legacy `qwen-coder`. Codemux rejects argv
prompts above 32 KiB — the rule applies to the prompt's content wherever it
came from, so use an stdin-capable harness for larger prompts.

### `check` options

`codemux check` makes a real request to the selected provider and requires that
harness to be installed and authenticated. It can consume quota or incur
charges. Its `--timeout` defaults to 60 seconds. Harnesses whose safe mode needs
an outer boundary (including Cursor and Gemini read-only) are probed under
the default sandbox. `check --hermetic` proves a harness ignores its
customizations: it plants instruction files with a code word in a scratch
directory and probes twice, once hermetically (the model must answer `OK`)
and once as a control (the planted code word must reach the model). Two
requests. Use `--help` for the full option list.

### `tui` options

`codemux tui` defaults to `read-only`. TUI capabilities can be narrower than
headless capabilities; for example, Droid's interactive CLI accepts autonomy
but not model or effort flags.

### `verify` options

| Flag | Description |
|------|-------------|
| `-a, --agent <agent>` | Verify one agent only |
| `--show-scode` | Print effective `scode` commands (`run`/`tui` x autonomy) |
| `--sandbox-trust` / `--sandbox-no-net` / `--sandbox-scrub-env` | Same overrides as `run`/`tui`, applied to preview output |

### Examples

```bash
# non-interactive
codemux run -a droid -m sonnet --auto high --effort high -p "fix flaky tests"

# read prompt from file
codemux run -a codex -f prompt.md

# reproducible: no operator customizations, no built-in tools
codemux run -a codex --hermetic --tools none -f prompt.md

# interactive
codemux tui -a claude
codemux tui -a codex -s --auto high

# diagnostics
codemux list
codemux doctor
codemux check -a claude -m sonnet
codemux autonomy
codemux verify --show-scode --sandbox-trust trusted
```

## Supported Agents

| Agent | Binary | Model | Autonomy | Effort |
|-------|--------|-------|----------|--------|
| `aider` | `aider` | yes | yes | yes |
| `claude` | `claude` | yes | yes | yes |
| `cline` | `cline` | yes | yes | yes |
| `codex` | `codex` | yes | yes | yes |
| `copilot` | `copilot` | yes | yes | yes |
| `cursor` | `agent` (`cursor-agent` fallback) | yes | yes | no |
| `droid` | `droid` | yes | yes | yes |
| `gemini` | `gemini` | yes | yes | no |
| `goose` | `goose` | yes | yes | no |
| `kimi` | `kimi` | yes | yes | no |
| `opencode` | `opencode` | yes | yes | headless |
| `openhands` | `openhands` | yes (`--override-with-envs`) | yes | no |
| `pi` | `pi` | yes | yes | yes |
| `qwen` | `qwen` (`qwen-coder` fallback is sandbox-only) | current CLI only | yes | no |
| `zai` | `claude` (z.ai proxy) | yes | yes | no |

Adapter flags follow current upstream CLI interfaces and can drift when a
provider releases a breaking change. The audited versions, upstream sources,
and manual checks are recorded in [the compatibility ledger](docs/HARNESS-COMPATIBILITY.md).
Run `bun run test:contracts` against installed harnesses before releasing or
upgrading them.

## Model Aliases

Aliases are resolved per adapter. Unknown names pass through unchanged; a known
alias that has no mapping for the selected agent fails with a descriptive error.

| Alias | claude | droid | codex | gemini | copilot | cursor |
|-------|--------|-------|-------|--------|---------|--------|
| `sonnet` | `sonnet` | `claude-sonnet-5` | - | - | `claude-sonnet-5` | `claude-sonnet-5-high` |
| `opus` | `opus` | `claude-opus-5` | - | - | `claude-opus-4.8` | `claude-opus-5-high` |
| `haiku` | `haiku` | `claude-haiku-4-5-20251001` | - | - | `claude-haiku-4.5` | - |
| `gpt5` | - | `gpt-5.6-sol` | `gpt-5.6` | - | `gpt-5.6-sol` | `gpt-5.6-sol-medium` |
| `gpt5-codex` / `gpt53` | - | `gpt-5.3-codex` | `gpt-5.3-codex` | - | `gpt-5.3-codex` | `gpt-5.3-codex` |
| `gemini-pro` | - | `gemini-3.1-pro-preview` | - | `gemini-3.1-pro-preview` | `gemini-3.1-pro-preview` | `gemini-3.1-pro` |
| `gemini-flash` | - | `gemini-3.5-flash` | - | `gemini-3.6-flash` | `gemini-3.6-flash` | `gemini-3.6-flash-high` |

## Autonomy Mapping

`codemux` maps normalized autonomy levels to each harness's native controls.

| Harness | `read-only` | `low` | `medium` | `high` |
|---------|-------------|-------|----------|--------|
| `aider` | `--dry-run` | decline headless confirmations | `--yes-always` | `--yes-always` |
| `claude` | `--permission-mode plan` | `--permission-mode manual` | `--permission-mode acceptEdits` + `--allowedTools Edit(//<launch dir>/**)` (headless) | `--dangerously-skip-permissions` + `--allowedTools Edit Write NotebookEdit Bash` (headless) |
| `cline` | `--plan` | `--auto-approve false` | `--auto-approve true` | `--auto-approve true` |
| `codex` | `-s read-only` + `-c approval_policy="never"` | `-s workspace-write` + `-c approval_policy="untrusted"` | `-s workspace-write` + `-c approval_policy="never"` | `-s danger-full-access` + `-c approval_policy="never"` |
| `copilot` | `--plan` | `--allow-tool read` | `--allow-all-tools` | `--allow-all` |
| `cursor` | `--mode plan` + required `scode --ro` | default approvals + required sandbox | `--auto-review` + required sandbox | `--force` |
| `droid` | default mode | `--auto low` | `--auto medium` | `--auto high` |
| `opencode` | `--agent plan` + required `scode --ro` | `--agent build` | `--agent build` | `--agent build --auto` |
| `goose` | `GOOSE_MODE=chat` | `GOOSE_MODE=approve` | `GOOSE_MODE=smart_approve` | `GOOSE_MODE=auto` |
| `gemini` | `--approval-mode plan` + required `scode --ro` | `--approval-mode default` | `--approval-mode auto_edit` | `--approval-mode yolo` |
| `kimi` | `--plan` (TUI); headless rests on `scode --ro` | default prompts (TUI); headless rests on scode | `--yolo` (TUI); headless rests on scode | `--auto` (TUI) |
| `openhands` | `--headless` auto-approves; rests on `scode --ro` | rests on scode | rests on scode | `--headless` |
| `qwen` | `--approval-mode plan` | `--approval-mode default` | `--approval-mode auto` | `--approval-mode yolo` |
| `pi` | extensions off + read tools | extensions off + read/edit/write tools | default tools | default tools |
| `zai` | `--permission-mode plan` | `--permission-mode manual` | `--permission-mode acceptEdits` + `--allowedTools Edit(//<launch dir>/**)` (headless) | `--dangerously-skip-permissions` + `--allowedTools Edit Write NotebookEdit Bash` (headless) |

The `claude` and `zai` adapters run with `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1`
for subprocess env hygiene. Claude Code 2.1.25x couples that variable to a
permission hardening that force-resets the requested mode to `default`, so
medium carries an explicit `--allowedTools Edit(//<launch dir>/**)` grant
on headless runs (the double slash is Claude's absolute-path form) —
anchored to the launch directory, the same paths acceptEdits would
auto-approve, and immovable by an approved `cd` — and high carries bare
tool grants on headless runs, a subset of the bypass it always requested.
The native flags stay, so versions without the hardening keep their
previous headless behavior exactly. Under the hardening, `high` remains
weaker than a full bypass: managed deny rules, safety checks, and
ungranted tools still gate. A TUI keeps the native flags — a human
approves, and the grants cannot survive a mode switch. Plan mode is
discarded too, so a hardened read-only TUI prompts instead of planning;
the sandbox's read-only boundary still enforces the level. At medium, a
launch directory containing a parenthesis, a backslash, a glob
metacharacter, a tab or line break, or trailing whitespace refuses the
launch — the rule grammar cannot represent any of them.

## Sandbox Integration (scode)

When `--sandbox` is enabled, `codemux` wraps harness commands with `scode` and applies policy resolution from `src/sandbox-policy.ts`.

Default policy keeps hosted model APIs reachable while applying filesystem mode
explicitly:

- `read-only`: `standard` + `--ro`
- `low`, `medium`, `high`: `standard` + `--rw`

Use `--sandbox-trust untrusted` for strict, read-only, scrubbed, offline
execution. The preset denies the harness-state directories. Environment
scrubbing can also remove provider credentials; prefer
harness keychains/config files when using `--sandbox-scrub-env`.

Codemux builds child environments from a small operational allowlist and the
selected harness's credentials. Aider receives its documented common provider
keys; other multi-provider harnesses primarily use their own credential stores.
If a task needs another variable, grant its exact name with
`--pass-env NAME` (comma-separated). Runtime loader variables such as
`BASH_ENV`, `NODE_OPTIONS`, `PYTHONPATH`, `LD_*`, and `DYLD_*` are always blocked.
For example, Claude Bedrock users can explicitly grant the required AWS
credential names. Treat every grant as authority available to model-invoked tools.

Cursor's programmatic mode exposes write and shell tools. Codemux prefers the
current `agent` binary, sends the prompt through stdin, uses native Plan and
Auto Review modes, trusts the already-validated workspace, and disables
Cursor's nested sandbox when `scode` is active. Direct `read-only`, `low`, and
`medium` runs still require `--sandbox` for a durable boundary.

OpenCode always launches with `--pure`, and both headless and TUI launches
reject project `opencode.json`/`opencode.jsonc` files plus non-empty
`.opencode/{agent,agents,mode,modes,plugin,plugins,tool,tools}` directories and
`.opencode/package.json` manifests between the working directory and its Git
root. Those inputs can load executable project code, install dependencies, or
replace policy before normalized autonomy is meaningful. Direct `read-only`
OpenCode runs additionally require `--sandbox` for a durable filesystem boundary.

Current Qwen runs use `--safe-mode`, and Pi uses `--no-approve`, so repository
hooks, extensions, MCP configuration, and local packages cannot silently alter
the generated policy. Codemux also rejects executable project configuration
for Cline, Codex, Cursor, Droid, Gemini, and Goose at launch boundaries.

Copilot headless and TUI runs reject repository-local MCP, hook, and custom-agent
configuration between the working directory and its Git root. These files can
execute repository-controlled commands before the requested autonomy policy is
meaningful.

Gemini headless Plan Mode can transition into implementation automatically, so
direct `read-only` runs are rejected unless `--sandbox` supplies a durable
read-only boundary. Codemux supplies an authoritative system setting that
disables generic project `.env` loading, rejects `.gemini` project controls,
and explicitly disables Gemini's nested sandbox so project Dockerfiles or
Seatbelt profiles cannot replace the selected boundary.

## Result envelopes

`codemux run --result-json` prints a result envelope on stdout instead of the
plain reply. Claude and Z.AI keep the harness's own envelope (Claude Code's
`--output-format json`), with one codemux-owned field appended; Codex, whose
`codex exec --json` prints JSONL events rather than one object, gets an
envelope codemux builds: `result` holds the final assistant message as plain
text. Every envelope carries the same block:

```json
"codemux": {
  "agent": "codex",
  "model": "gpt-5.3-codex",
  "usage": {
    "input_tokens": 200,
    "output_tokens": 50,
    "cached_input_tokens": 800,
    "total_tokens": 1050,
    "cost_usd": null
  },
  "session_id": null
}
```

`model` is the model that served the run when the harness names it, else the
model codemux selected, else null; a run the envelope says was served by
several models (`modelUsage` with several entries) reports null, not the
requested model. Codex names a model only when it reroutes one mid-run — the
reroute rides the event stream as an error item (`model rerouted: <from> ->
<to>`), and the envelope's `model` is then the model that served the run, with
a stderr note saying the run was rerouted, so the requested model is never
mistaken for the served one. Fields the harness does not report are null,
never guessed.
Usage means the same thing for every harness: `input_tokens` counts input not
served from a prompt cache, `cached_input_tokens` counts input served from or
written to one, and `total_tokens` is their sum plus output — computed only
when every component was reported. `session_id` is always null in this
release: no run persists a session (Claude and Z.AI launch with
`--no-session-persistence`, Codex with `--ephemeral`), and the field is
reserved for the planned live-sessions release.

A failed run is a failed run on every channel: the exit code is non-zero even
when the harness's own was not, and the diagnostic rides
on stderr on its own line after the harness's own output — separated even
when the harness's last stderr line was unterminated. An empty result is a
failed run on every path, plain or structured: a Claude-family envelope whose
`result` is empty or whitespace only, or a codex turn whose final
`agent_message` carried text that is empty or whitespace only, fails instead
of passing a run with no reply. In a codex-built envelope `result`
is null too (a partial message from an earlier completed item never poses as
the final one); a Claude-family envelope keeps the harness's own `result`
field verbatim, since it re-emits the harness's record rather than building
one. A codex
stream whose last turn never ended with `turn.completed` fails the same way:
a completed message item is not a completed turn upstream, so a zero-exit
wrapper that drops the final event cannot pass a truncated result off as
done — and an item event after the last `turn.completed` (`item.started`,
`item.updated`, or a completed item of any type) with
no turn reopened, a `thread.started` that is not the stream's first event
(a second announcement included), or a `turn.started` inside a turn still
open or after a turn already completed (one `codex exec` run is one turn),
is format
drift the stream parser refuses outright (the shapes a wrapper
concatenating two streams produces). A Claude-family
envelope that reports its own failure (`is_error`, or
an `error_*` subtype like `error_during_execution`) fails the run even when
the harness exited 0 — a wrapper that masks the exit code cannot mask the
structured failure too; the harness's own fields stay in the envelope. Stdout
that breaks the JSON promise —
Claude-family plain text, an envelope that names no outcome (a bare
`{"type":"result"}`, or a success whose `result` text is missing), or a codex
event stream codemux cannot parse (a recognized `agent_message` whose `text`
is not a string included — the stream is the documented source for messages,
so one it cannot carry is drift, not an item to skip) —
fails the same way, with the raw stdout kept for inspection, never a silent
success. The empty reply is the one difference in shape: an envelope whose
`result` text is empty or whitespace only is refused as no reply and fails
the run like an error envelope does — non-zero exit — and the envelope is
re-emitted with the codemux block attached rather than kept as raw stdout,
so a caller inspecting stdout sees codemux-appended content, not the bare
bytes the harness printed.
One codex nuance the other direction: a turn that ends with only a
`Plan` item is a success, because codex itself treats that Plan as the
turn's final message even though the JSONL stream drops the item — the
launch also passes `--output-last-message`, and the message codex recorded
is the `result`, with a stderr note saying the stream carried no
`agent_message`. `--sandbox-trust untrusted` is the one exception: on a
non-hermetic run it denies the child write access to the harness state
directory the fallback file lives in, so codemux passes no file there and
the event stream is the result's only source — a Plan-only turn under
`untrusted` therefore reports `result: null` and exits non-zero. A
hermetic run names its fallback file whatever the trust (the file lives
in the private home), but the outcome is the same there: `untrusted`
denies the private home itself, so the child cannot write the file and
the stream is still the result's only source. A turn that reports no
usage leaves the fields
null — the
all-zero `Usage::default()` snapshot codex 0.159.3 emits when no
token-usage update arrived counts as unreported, not as a measured zero —
and a
failed run reports null usage fields as well: an exact-looking figure that
understates a failed run is worse than none.

## Optional Usage Integration

Codemux does not implement provider billing or subscription APIs. Install the
standalone `usagemux` CLI to enable normalized quota reporting:

```bash
codemux usage                 # all Codemux clients
codemux usage -a codex        # one client
codemux usage -a claude --json
```

`codemux usage` invokes `usagemux` directly, validates its versioned JSON
protocol, and renders quota percentages, resets, credits, and subscription
renewal/expiry timestamps when available. Credentials, provider detection,
caching, and upstream API compatibility remain owned by `usagemux`. Codemux
passes no credentials in command arguments.

The integration is optional. When `usagemux` is absent, only `codemux usage`
returns unavailable (exit 69); run, TUI, diagnostics, and every other command
continue to work. `codemux doctor` reports the integration without treating a
missing installation as a failure. Usage queries can access provider APIs and
local credential stores, but do not send model prompts.

## Configuration

Config path: `$XDG_CONFIG_HOME/codemux/config.yaml`, or
`~/.config/codemux/config.yaml` when `XDG_CONFIG_HOME` is unset. Invalid,
oversized, malformed, or unknown configuration fails closed instead of silently
falling back to defaults. `--help`, `--version`, and `doctor` remain available
for recovery. Relative `XDG_CONFIG_HOME` values are ignored.

```yaml
defaultAgent: claude

models:
  my-alias:
    claude: sonnet
    droid: claude-sonnet-5
```

## Z.AI Adapter Credentials

```bash
# file-based
umask 077
read -rs ZAI_KEY
printf '%s\n' "$ZAI_KEY" > ~/.zai
unset ZAI_KEY

# env var
export ZAI_API_KEY=your-api-key
```

The key file must be a regular file owned by the current user with mode `0600`
or stricter. Codemux removes the source `ZAI_API_KEY` from the child environment
after translating it to the Claude-compatible token.

## Optional Playwright MCP

Codemux does not download or inject MCP code by default. To opt into Playwright
for sandboxed Claude/Z.AI sessions, install an audited `playwright-mcp` binary
locally and pass `--enable-playwright-mcp` together with `--sandbox`. Codemux
requires the resolved binary to be a regular executable owned by the current
user or root, not group/world writable, and outside the execution working
directory. It supplies a session-only `mcpServers` configuration pinned to that
canonical path; it never executes `@latest` via `npx` or adds `--no-sandbox`
itself. The outer `scode` runtime may disable a nested browser sandbox for
compatibility; review `scode`'s browser-security tradeoff before enabling this
integration.

## Shell Shortcuts

`scripts/aliases.sh` includes quick sandboxed TUI wrappers:

```bash
source ./scripts/aliases.sh
codemux-claude
codemux-droid
```

These aliases inherit the least-privilege `read-only` TUI default. Add an
explicit `--auto` level when you intend to permit writes.

## Development

```bash
bun install
make check
make release-gate
```

## Project structure

```text
codemux/
├── bin/       Hardened executable launcher
├── docs/      Testing, release, and historical design documentation
├── scripts/   Repository maintenance utilities
├── src/       CLI, sandbox policy, and agent adapters
└── tests/     Unit, integration, and launcher regression tests
```

See:

- `docs/TESTING.md`
- `docs/RELEASE-GATE.md`
- `docs/RELEASING.md`
- `docs/HISTORICAL-DESIGN.md`

Contributions are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) before
opening a change. Report suspected vulnerabilities through the private process
in [SECURITY.md](SECURITY.md), not a public issue.

## License

[MIT](LICENSE)
