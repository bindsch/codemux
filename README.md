# codemux

Unified CLI for AI coding agents. Run prompts across multiple AI coding assistants with a single interface.

## Supported Agents

| Agent | Binary | Non-interactive | Interactive | Model | Autonomy |
|-------|--------|-----------------|-------------|-------|----------|
| claude | `claude` | ✅ | ✅ | ✅ | ✅ |
| codex | `codex` | ✅ | ✅ | ✅ | ✅ |
| droid | `droid` | ✅ | ✅ | ✅ | ✅ |
| goose | `goose` | ✅ | ✅ | ❌ | ❌ |
| gemini | `gemini` | ✅ | ✅ | ✅ | ❌ |
| opencode | `opencode` | ✅ | ✅ | ✅ | ❌ |
| qwen | `qwen-coder` | ✅ | ✅ | ❌ | ❌ |

## Installation

```bash
# Clone and install
git clone https://github.com/youruser/codemux
cd codemux
bun install
bun link
```

## Usage

### Run a prompt (non-interactive)

```bash
# Use default agent (claude)
codemux run -p "fix the bug in main.ts"

# Specify agent
codemux run -a droid -p "review this code"

# Use model alias
codemux run -a claude -m sonnet -p "explain this function"

# Read prompt from file
codemux run -a codex -f prompt.md

# Set autonomy level
codemux run -a droid --auto medium -p "install deps and run tests"

# Specify working directory
codemux run -a claude --cwd /path/to/project -p "analyze the codebase"
```

### Interactive TUI

```bash
# Start default agent
codemux tui

# Start specific agent
codemux tui -a droid

# With model
codemux tui -a claude -m opus
```

### List agents

```bash
codemux list
```

### Check installation

```bash
codemux doctor
```

## Model Aliases

codemux supports model aliases that map to agent-specific model names:

| Alias | Claude | Droid | Codex |
|-------|--------|-------|-------|
| `sonnet` | claude-sonnet-4-5-20250929 | claude-sonnet-4-5-20250929 | claude-sonnet-4-5-20250929 |
| `opus` | claude-opus-4-5-20251101 | claude-opus-4-5-20251101 | - |
| `haiku` | claude-haiku-4-5-20251001 | claude-haiku-4-5-20251001 | - |
| `gpt5` | - | gpt-5.1 | gpt-5.1 |
| `gpt5-codex` | - | gpt-5.1-codex | gpt-5.1-codex |

## Autonomy Levels

| Level | Description |
|-------|-------------|
| `read-only` | Default. No modifications allowed |
| `low` | Basic file operations |
| `medium` | Development operations (npm install, git commit, etc.) |
| `high` | Full access including git push, dangerous operations |

Mapping to underlying agents:

| codemux | droid | claude | codex |
|---------|-------|--------|-------|
| `read-only` | (default) | (default) | `-s read-only` |
| `low` | `--auto low` | `--permission-mode acceptEdits` | `-s read-only` |
| `medium` | `--auto medium` | `--permission-mode dontAsk` | `-s workspace-write` |
| `high` | `--auto high` | `--dangerously-skip-permissions` | `-s danger-full-access` |

## Configuration

Create `~/.config/codemux/config.yaml`:

```yaml
default_agent: claude

models:
  # Add custom model aliases
  my-model:
    claude: claude-sonnet-4-5-20250929
    droid: gpt-5.1
```

## Development

```bash
# Install dependencies
bun install

# Run CLI
bun run src/index.ts

# Type check
bun run typecheck

# Link globally
bun link
```

## License

MIT
