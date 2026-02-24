# codemux

> **Beta software (v0.1.0).** `codemux` is under active development. Expect behavior changes as adapters and sandbox policy continue to harden.

`codemux` is a unified CLI for AI coding agents. It gives one command surface for multiple harnesses, normalizes autonomy/effort semantics, and can route all execution through `scode` for a single sandbox boundary.

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
codemux run -a claude -s --sandbox-no-net -p "audit dependencies"

# 5) inspect wiring and effective sandbox commands
codemux verify --show-scode
```

## Why codemux

- One CLI across multiple agent harnesses.
- Normalized autonomy levels: `read-only`, `low`, `medium`, `high`.
- Optional normalized effort levels for harnesses that support them.
- External sandbox boundary through `scode` to avoid nested sandbox ambiguity.
- Built-in diagnostics (`doctor`, `check`, `autonomy`, `verify`).

## Installation

### Prerequisites

- [Bun](https://bun.sh) (runtime + package manager)
- Installed agent CLIs you plan to use (`claude`, `codex`, `droid`, etc.)
- `scode` if you use `--sandbox`

### Install from source

```bash
git clone https://github.com/bindscha/codemux.git
cd codemux
bun install
bun link
```

## Usage

```text
codemux [command] [options]
```

### Commands

| Command | Purpose |
|---------|---------|
| `run` | Non-interactive prompt execution |
| `tui` | Interactive harness session |
| `check` | Lightweight model/agent probe |
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
| `-s, --sandbox` | Execute via `scode` |
| `--sandbox-trust <level>` | `scode` trust override (`trusted`, `standard`, `untrusted`) |
| `--sandbox-no-net` | Add `--no-net` to `scode` |
| `--sandbox-scrub-env` | Add `--scrub-env` to `scode` |
| `--sandbox-allow-net` | Force network on (override defaults/`--sandbox-no-net`) |
| `--sandbox-keep-env` | Disable env scrubbing (override defaults/`--sandbox-scrub-env`) |
| `--sandbox-no-defaults` | Disable per-harness sandbox defaults |
| `--auto <level>` | Autonomy (`read-only`, `low`, `medium`, `high`) |
| `--effort <level>` | Effort (`none`, `low`, `medium`, `high`) |
| `--cwd <path>` | Working directory |

### `tui` options

`codemux tui` supports the same model/sandbox/autonomy/effort flags as `run` (except prompt/file input flags).

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
| `claude` | `claude` | yes | yes | no |
| `codex` | `codex` | yes | yes | yes |
| `droid` | `droid` | yes | yes | yes |
| `gemini` | `gemini` | yes | yes | no |
| `goose` | `goose` | no | yes | no |
| `opencode` | `opencode` | yes | yes | no |
| `pi` | `pi` | yes | yes | no |
| `qwen` | `qwen` (`qwen-coder` fallback) | yes | yes | no |
| `zai` | `claude` (z.ai proxy) | yes | yes | no |

## Model Aliases

Aliases are resolved per adapter. Unknown aliases pass through unchanged.

| Alias | claude | droid | codex | gemini |
|-------|--------|-------|-------|--------|
| `sonnet` | `claude-sonnet-4-5-20250929` | `claude-sonnet-4-5-20250929` | `claude-sonnet-4-5-20250929` | - |
| `opus` | `claude-opus-4-5-20251101` | `claude-opus-4-5-20251101` | - | - |
| `haiku` | `claude-haiku-4-5-20251001` | `claude-haiku-4-5-20251001` | - | - |
| `gpt5` | - | `gpt-5.1` | `gpt-5.1` | - |
| `gpt5-codex` | - | `gpt-5.1-codex` | `gpt-5.1-codex` | - |
| `gemini-pro` | - | `gemini-3-pro-preview` | - | `gemini-3-pro` |
| `gemini-flash` | - | `gemini-3-flash-preview` | - | `gemini-3-flash` |

## Autonomy Mapping

`codemux` maps normalized autonomy levels to each harness's native controls.

| Harness | `read-only` | `low` | `medium` | `high` |
|---------|-------------|-------|----------|--------|
| `claude` | default mode | `--permission-mode acceptEdits` | `--permission-mode dontAsk` | `--dangerously-skip-permissions` |
| `codex` | `-s read-only` | `-s read-only` | `-s workspace-write` | `-s danger-full-access` |
| `droid` | default mode | `--auto low` | `--auto medium` | `--auto high` |
| `opencode` | `--agent explore` | `--agent explore` | `--agent build` | `--agent build` |
| `goose` | `GOOSE_MODE=chat` | `GOOSE_MODE=approve` | `GOOSE_MODE=smart_approve` | `GOOSE_MODE=auto` |
| `gemini` | `--approval-mode plan` | `--approval-mode default` | `--approval-mode auto_edit` | `--approval-mode yolo` |
| `qwen` | `--approval-mode plan` | `--approval-mode default` | `--approval-mode auto-edit` | `--approval-mode yolo` |
| `pi` | `--tools read,grep,find,ls` | default tools | default tools | default tools |

## Sandbox Integration (scode)

When `--sandbox` is enabled, `codemux` wraps harness commands with `scode` and applies policy resolution from `src/sandbox-policy.ts`.

Default trust policy:

- `read-only`: `untrusted` + `--ro`
- `low`: `untrusted` + `--rw`
- `medium`: `standard` for `claude/codex/droid/goose/gemini/qwen/zai`, `untrusted` for `opencode/pi`
- `high`: `standard` + `--rw`

`--sandbox-trust` and other `--sandbox-*` overrides always take precedence over defaults.

## Configuration

Config path: `~/.config/codemux/config.yaml`

```yaml
defaultAgent: claude

models:
  my-alias:
    claude: claude-sonnet-4-5-20250929
    droid: gpt-5.1
```

## Z.AI Adapter Credentials

```bash
# file-based
echo "your-api-key" > ~/.zai

# env var
export ZAI_API_KEY=your-api-key
```

## Shell Shortcuts

`aliases.sh` includes quick sandboxed TUI wrappers:

```bash
source ./aliases.sh
codemux-claude
codemux-droid
```

## Development

```bash
bun install
make check
```

See:

- `docs/TESTING.md`
- `docs/RELEASE-GATE.md`
- `docs/RELEASING.md`

## License

[MIT](LICENSE)
