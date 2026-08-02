# codemux

> **Beta software (v0.2.1).** `codemux` is under active development. Expect behavior changes as adapters and sandbox policy continue to harden.

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

# 4) sandbox execution through scode
codemux run -a claude -s -p "audit dependencies"

# 5) inspect wiring and effective sandbox commands
codemux verify --show-scode
```

## Why codemux

- One CLI across multiple agent harnesses.
- Normalized autonomy levels: `read-only`, `low`, `medium`, `high`.
- Optional normalized effort levels for harnesses that support them.
- External sandbox boundary through `scode` for `run` and `tui`.
- Built-in diagnostics (`doctor`, `check`, `autonomy`, `verify`).

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
| `autonomy` | Autonomy equivalence matrix |
| `verify` | Static wiring validation + optional scode preview |

### `run` options

| Flag | Description |
|------|-------------|
| `-a, --agent <agent>` | Agent id (default: `claude`) |
| `-m, --model <model>` | Model name or alias |
| `-p, --prompt <prompt>` | Prompt text |
| `-f, --file <path>` | Read prompt text from file |
| `--timeout <seconds>` | Kill a hung non-interactive run (default: `1800`, maximum: `86400`) |
| `--pass-env <names>` | Explicitly pass comma-separated parent environment names |
| `--enable-playwright-mcp` | Enable a local Playwright MCP binary inside `--sandbox` |
| `-s, --sandbox` | Execute via `scode` |
| `--sandbox-trust <level>` | `scode` trust override (`trusted`, `standard`, `untrusted`) |
| `--sandbox-no-net` | Add `--no-net` to `scode` |
| `--sandbox-scrub-env` | Add `--scrub-env` to `scode` |
| `--auto <level>` | Autonomy (`read-only`, `low`, `medium`, `high`) |
| `--effort <level>` | Effort (`none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, `ultra`; availability is harness-specific) |
| `--cwd <path>` | Working directory |

Use `--file` instead of `--prompt` for sensitive input so the Codemux command
line itself does not expose the prompt through process inspection. Some upstream
harnesses only accept their final task as an argument; Codemux cannot remove
that upstream limitation for Aider, Cline, Copilot, Gemini, Goose, or
legacy `qwen-coder`. Codemux rejects argv prompts above 32 KiB; use an
stdin-capable harness for larger prompts.

### `check` options

`codemux check` makes a real request to the selected provider and requires that
harness to be installed and authenticated. It can consume quota or incur
charges. Its `--timeout` defaults to 60 seconds. Harnesses whose safe mode needs
an outer boundary (including Cursor and Gemini read-only) can be probed with
`check --sandbox`. Use `--help` for the full option list.

### `tui` options

`codemux tui` defaults to `read-only`. TUI capabilities can be narrower than
headless capabilities; for example, Droid's interactive CLI accepts autonomy
but not model or effort flags.

### `verify` options

| Flag | Description |
|------|-------------|
| `-a, --agent <agent>` | Verify one agent only |
| `--show-scode` | Print effective `scode` commands (`run`/`tui` x autonomy) |
| `--sandbox-*` | Same sandbox policy overrides as above, applied to preview output |

### Examples

```bash
# non-interactive
codemux run -a droid -m sonnet --auto high --effort high -p "fix flaky tests"

# read prompt from file
codemux run -a codex -f prompt.md

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
| `opencode` | `opencode` | yes | yes | headless |
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
| `claude` | `--permission-mode plan` | `--permission-mode manual` | `--permission-mode acceptEdits` | `--dangerously-skip-permissions` |
| `cline` | `--plan` | `--auto-approve false` | `--auto-approve true` | `--auto-approve true` |
| `codex` | `-s read-only -a never` | `-s workspace-write -a untrusted` | `-s workspace-write -a never` | `-s danger-full-access -a never` |
| `copilot` | `--plan` | `--allow-tool read` | `--allow-all-tools` | `--allow-all` |
| `cursor` | `--mode plan` + required `scode --ro` | default approvals + required sandbox | `--auto-review` + required sandbox | `--force` |
| `droid` | default mode | `--auto low` | `--auto medium` | `--auto high` |
| `opencode` | `--agent plan` + required `scode --ro` | `--agent build` | `--agent build` | `--agent build --auto` |
| `goose` | `GOOSE_MODE=chat` | `GOOSE_MODE=approve` | `GOOSE_MODE=smart_approve` | `GOOSE_MODE=auto` |
| `gemini` | `--approval-mode plan` + required `scode --ro` | `--approval-mode default` | `--approval-mode auto_edit` | `--approval-mode yolo` |
| `qwen` | `--approval-mode plan` | `--approval-mode default` | `--approval-mode auto` | `--approval-mode yolo` |
| `pi` | extensions off + read tools | extensions off + read/edit/write tools | default tools | default tools |
| `zai` | `--permission-mode plan` | `--permission-mode manual` | `--permission-mode acceptEdits` | `--dangerously-skip-permissions` |

## Sandbox Integration (scode)

When `--sandbox` is enabled, `codemux` wraps harness commands with `scode` and applies policy resolution from `src/sandbox-policy.ts`.

Default policy keeps hosted model APIs reachable while applying filesystem mode
explicitly:

- `read-only`: `standard` + `--ro`
- `low`, `medium`, `high`: `standard` + `--rw`

Use `--sandbox-trust untrusted` for strict, read-only, scrubbed, offline
execution. Environment scrubbing can also remove provider credentials; prefer
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
