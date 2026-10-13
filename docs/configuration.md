# Configuration

Codemux reads `$XDG_CONFIG_HOME/codemux/config.yaml` when XDG_CONFIG_HOME is
absolute. Otherwise it reads `~/.config/codemux/config.yaml`. The home is an
absolute HOME, then USERPROFILE, then the operating system's home fallback.
Relative XDG_CONFIG_HOME is ignored.

```yaml
defaultAgent: claude
models:
  my-alias:
    claude: sonnet
    droid: claude-sonnet-5
```

The UTF-8 YAML file is limited to 1 MiB. Its only top-level keys are
`defaultAgent` and `models`. An empty file uses defaults. The default agent is
`claude`. Unknown keys, invalid types, invalid agents, malformed YAML, and
oversized files fail commands that need configuration. Help, version, and
`doctor` remain available for recovery.

An alias matches `[A-Za-z0-9][A-Za-z0-9._-]{0,63}`. Its value maps supported
agent IDs to model names. User mappings merge with built-in mappings per alias
and agent. Model names must have 1–256 UTF-8 bytes, no surrounding whitespace,
and no control, format, or surrogate characters. A recognized alias without a
mapping for the requested agent is an error; an unrecognized alias is treated
as a literal model name. `codemux doctor` lists effective alias names and agents.

## Defaults and precedence

An explicit `--agent` overrides `defaultAgent`. An explicit `--model` resolves
through the effective alias map. Without it, the adapter or harness selects its
default model. Provider routing can supply a model and has its own validated
[override rules](provider-overrides.md).

Built-in aliases are `sonnet`, `opus`, `haiku`, `gpt5`, `gpt5-codex`,
`gpt53`, `gemini-pro`, and `gemini-flash`. They are not universal model names.

| Alias | Built-in mappings |
|---|---|
| `sonnet` | Claude: sonnet; Droid/Copilot: claude-sonnet-5; Cursor: claude-sonnet-5-high |
| `opus` | Claude: opus; Droid: claude-opus-5; Copilot: claude-opus-4.8; Cursor: claude-opus-5-high |
| `haiku` | Claude: haiku; Droid: claude-haiku-4-5-20251001; Copilot: claude-haiku-4.5 |
| `gpt5` | Codex: gpt-5.6; Droid/Copilot: gpt-5.6-sol; Cursor: gpt-5.6-sol-medium |
| `gpt5-codex`, `gpt53` | Codex/Droid/Copilot/Cursor: gpt-5.3-codex |
| `gemini-pro` | Droid/Gemini/Copilot: gemini-3.1-pro-preview; Cursor: gemini-3.1-pro |
| `gemini-flash` | Droid/Gemini/Copilot: gemini-3.6-flash; Cursor: gemini-3.6-flash-high |

## Environment

Child environments remove known code-loader and sensitive variables.
`--pass-env NAME,OTHER_NAME` allows named variables through codemux's filter;
it does not promise that scode's separate scrub policy will preserve them.
At most 64 names are accepted. Each must match `[A-Za-z_][A-Za-z0-9_]*`.
Do not put values in this option.

[Provider overrides](provider-overrides.md) use dedicated
`CODEMUX_<AGENT>_PROVIDER_*` variables.
[Authentication](authentication.md) defines credential inputs and
`CODEMUX_NO_KEYCHAIN_SYNC`.
[Results and usage](results-and-usage.md) defines `CODEMUX_CALL_LOG`.
[Harnesses](harnesses.md) documents harness-specific entry and home controls.

The packaged `scripts/aliases.sh` provides `codemux-claude` and
`codemux-droid` sandboxed TUI wrappers:

```sh
source ./scripts/aliases.sh
codemux-claude
```

They retain the default `read-only` autonomy.
