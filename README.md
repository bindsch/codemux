# codemux

Unified CLI for AI coding agents. Run prompts across multiple AI coding assistants with a single interface.

## Supported Agents

| Agent | Binary | Model | Autonomy | Effort |
|-------|--------|-------|----------|--------|
| claude | `claude` | ✅ | ✅ | - |
| codex | `codex` | ✅ | ✅ | ✅ |
| droid | `droid` | ✅ | ✅ | ✅ |
| gemini | `gemini` | ✅ | - | - |
| goose | `goose` | - | - | - |
| opencode | `opencode` | ✅ | ✅ | - |
| qwen | `qwen-coder` | - | - | - |
| zai | `claude` (via z.ai) | ✅ | ✅ | - |

## Installation

```bash
bun install
bun link
```

## Usage

### Run a prompt (non-interactive)

```bash
# Default agent (claude)
codemux run -p "fix the bug in main.ts"

# Specify agent and model alias
codemux run -a droid -m sonnet -p "review this code"

# Read prompt from file
codemux run -a codex -f prompt.md

# Set autonomy and effort
codemux run -a droid --auto medium --effort high -p "refactor auth module"

# Sandboxed execution (requires scoder)
codemux run -a claude -s -p "install deps and run tests"

# Working directory
codemux run -a claude --cwd /path/to/project -p "analyze the codebase"
```

### Interactive TUI

```bash
codemux tui
codemux tui -a droid -m opus
codemux tui -a claude -s          # sandboxed, defaults to high autonomy
```

### Diagnostics

```bash
codemux list                       # show agents and capabilities
codemux doctor                     # check installation status
codemux check -a claude -m sonnet  # probe agent/model config
```

## Model Aliases

Aliases resolve to agent-specific model identifiers:

| Alias | claude | droid | codex | gemini |
|-------|--------|-------|-------|--------|
| `sonnet` | claude-sonnet-4-5-20250929 | claude-sonnet-4-5-20250929 | claude-sonnet-4-5-20250929 | - |
| `opus` | claude-opus-4-5-20251101 | claude-opus-4-5-20251101 | - | - |
| `haiku` | claude-haiku-4-5-20251001 | claude-haiku-4-5-20251001 | - | - |
| `gpt5` | - | gpt-5.1 | gpt-5.1 | - |
| `gpt5-codex` | - | gpt-5.1-codex | gpt-5.1-codex | - |
| `gemini-pro` | - | gemini-3-pro-preview | - | gemini-3-pro |
| `gemini-flash` | - | gemini-3-flash-preview | - | gemini-3-flash |

Unrecognized aliases pass through as literal model names.

## Autonomy Levels

| Level | Description | claude | codex | droid | opencode |
|-------|-------------|--------|-------|-------|----------|
| `read-only` | No modifications (default) | (default) | `-s read-only` | (default) | `--agent explore` |
| `low` | Accept edits | `--permission-mode acceptEdits` | `-s read-only` | `--auto low` | - |
| `medium` | Auto-approve | `--permission-mode dontAsk` | `-s workspace-write` | `--auto medium` | - |
| `high` | Full access | `--dangerously-skip-permissions` | `-s danger-full-access` | `--auto high` | `--agent build` |

## Configuration

`~/.config/codemux/config.yaml`:

```yaml
defaultAgent: claude

models:
  my-alias:
    claude: claude-sonnet-4-5-20250929
    droid: gpt-5.1
```

## Z.AI Adapter

The `zai` agent proxies Claude through the z.ai API. Set up credentials:

```bash
# Option 1: file
echo "your-api-key" > ~/.zai

# Option 2: env var
export ZAI_API_KEY=your-api-key
```

## Shell Aliases

Source `aliases.sh` for quick sandboxed TUI shortcuts:

```bash
source ./aliases.sh
codemux-claude    # codemux tui -s -a claude
codemux-droid     # codemux tui -s -a droid
```

## Development

```bash
bun install
bun run typecheck
bun test
bun link              # install globally
```

## License

[BSL-1.1](LICENSE.md) (converts to MIT on 2030-01-01)
