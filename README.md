# codemux

> **Beta software (v0.7.0).** `codemux` is under active development. Expect behavior changes as adapters and sandbox policy continue to harden.

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
- Installed agent CLIs you plan to use (`aider`, `agy`, `claude`, `cline`, `copilot`, Cursor's `agent`, etc.)
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
| `--hermetic` | Load none of the operator's customizations (instruction files, skills, plugins, hooks, MCP servers); the login still works. Claude, Z.AI, Codex and OpenCode (OpenCode also refuses while its login carries remote configuration — a well-known login or an active organization, whose fetched config could override the run's guarantees); every other harness is refused until its mechanism passes the live check. Aider alone keeps an implemented mapping behind its refusal; the mechanisms that sat unverifiable behind the other refusals were removed in 0.7.0. See [docs/HERMETIC.md](docs/HERMETIC.md) |
| `--tools <selection>` | Built-in tools the harness exposes: `default` or `none`. Independent of `--hermetic`; Codex takes `none` only with `--auto read-only`, OpenCode only with `--hermetic` (on a plain run the operator's opencode config can override the deny per agent; `check --hermetic --tools none` refuses for it, since its control probe would be that plain run), and harnesses that cannot remove their tools refuse `none` |
| `--result-json` | Return a structured result envelope on stdout instead of plain text, so a caller can read what the run consumed (tokens, cost). Claude, Z.AI, Codex and Antigravity; other harnesses refuse the flag rather than silently returning text. Claude-family and Antigravity envelopes are the harness's own with one added `codemux` block; Codex reports the final assistant message as `result` plus the same block. See [Result envelopes](#result-envelopes) |
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

### Provider overrides

Point one harness at a different model provider — an OpenAI-compatible
gateway, an Anthropic Messages endpoint, or a subscription endpoint such
as Z.AI's — by exporting three
environment variables before invoking codemux:

```bash
export CODEMUX_AIDER_PROVIDER_BASE_URL=https://api.z.ai/api/coding/paas/v4
export CODEMUX_AIDER_PROVIDER_API_KEY=…        # keep it out of argv and committed files
export CODEMUX_AIDER_PROVIDER_MODEL=glm-5.3
codemux run -a aider -p "Reply with: OK"
```

`<AGENT>` is the codemux agent id uppercased. Blank values count as unset,
and a half-configured override fails loudly instead of silently reaching the
harness's native provider. The base URL and the model name must not contain
braces: OpenCode substitutes `{env:…}`/`{file:…}` and Droid and Pi expand
`${VAR}` templates in the config files an override writes, and the model
lands in the same files, so a brace could splice another
value into them. The key is delivered to the harness through the
environment codemux itself provides or through a private per-run file codemux
creates and removes — never through an operator configuration file, which is
what lets the override survive `--hermetic`. Aider translates the override
into litellm's `openai/` model prefix with `OPENAI_API_BASE` and
`OPENAI_API_KEY`
([aider.chat/docs/llms/openai-compat.html](https://aider.chat/docs/llms/openai-compat.html)),
OpenCode into a private `OPENCODE_CONFIG`
provider file plus a key environment it references, Kimi Code into
the `KIMI_MODEL_*` group that synthesizes a provider in memory, Droid
into a per-run BYOK `customModels` entry inside a private `--settings`
file whose key is a `${VAR}` reference into the environment
codemux provides, Pi into a private agent directory behind
`PI_CODING_AGENT_DIR` holding a one-provider `models.json` with the same
kind of `${VAR}` key reference, and Goose into the pure-environment
`GOOSE_PROVIDER`/`OPENAI_HOST`/`OPENAI_BASE_PATH`/`OPENAI_API_KEY`/`GOOSE_MODEL`
group of its built-in OpenAI provider.

Claude Code routes through the same gateway variables Z.AI's endpoint
uses — `ANTHROPIC_BASE_URL` plus `ANTHROPIC_AUTH_TOKEN` carrying the key
— with the model on `--model`, and the haiku, small-fast, sonnet and opus
tier variables pinned to the same model when `CODEMUX_CLAUDE_PROVIDER_MODEL`
names it, so background requests and subagents never ask the endpoint for a
model it does not serve (with the model on `--model` alone the tiers keep
Claude Code's defaults). Claude Code
still reads the operator's user
settings on a plain run, and an `env` block there naming either variable
competes with the override; run with `--hermetic` (which loads no user
settings) when the override must be the only source of those values. The endpoint must serve the Anthropic
Messages API (`/v1/messages`) and accept Claude Code's own request shape:
Claude Code >= 2.1.2xx puts `system`-role turns inside the `messages`
list (feature gate `mid-conversation-system-2026-04-07`, with a force
variable but no disable one), so an endpoint that validates roles to
user/assistant rejects the run. vLLM 0.12's Messages shim does exactly
that, answering

```
400 {'type': 'literal_error', 'loc': ('body', 'messages', 1, 'role'), 'msg': "Input should be 'user' or 'assistant'", 'input': 'system', 'ctx': {'expected': "'user' or 'assistant'"}}
```

(the same request with the entry folded into the top-level `system`
field is accepted), so a proxy in front of such a shim must do that
folding before forwarding; an OpenAI-compatible `/v1/chat/completions`
gateway is not enough in any case. With the override set the
operator's Claude login
plays no part: the sandboxed Keychain credential-mirror sync is skipped
entirely, and the operator's own `ANTHROPIC_API_KEY` and
`CLAUDE_CODE_OAUTH_TOKEN` are kept out of the child environment so no
second, operator-funded credential path exists. Codex gets a private
per-run `CODEX_HOME` whose `config.toml` names a `model_providers.codemux`
entry — base URL plus `env_key`, so the key rides the environment and
never a file — with `wire_api = "responses"` (the only value every
supported release accepts, so the endpoint must speak the OpenAI
Responses API, not only chat completions). The operator's `config.toml`
is not read at all on an override run, which also means profiles, MCP
servers, and hooks from it do not load. One codex-specific variable
shapes that config: `CODEMUX_CODEX_PROVIDER_MULTI_AGENT=off` writes
`features.multi_agent = false` into it (`on`, the default, writes
nothing — codex's own default). Off removes the grouped `namespace`
tool (`multi_agent_v1`) that codex's subagent feature adds to every
Responses request, so an endpoint whose Responses API does not
implement OpenAI's namespace tool grouping can still serve codex —
vLLM 0.12's `/v1/responses` validator rejects that tool with a 400
(`tools[N]` carrying `type: "namespace"`). The trade is semantic: the
run cannot spawn codex subagents. An operator holding the model fixed
across harnesses may want that for the comparison's sake too — a
harness that fans out subagents runs a different workload than one that
cannot, and `off` keeps codex's turn comparable to a harness with no
subagent feature. The knob accepts only `on`/`off`, and like a token
cap it fails the run when set without an override. OpenHands carries the override
through `--override-with-envs`, the same channel its model selection
uses, with `LLM_BASE_URL`/`LLM_API_KEY`/`LLM_MODEL` (litellm's `openai/`
model prefix added, as aider's). The Codex, Droid, Pi, and OpenCode
overrides support headless runs only — their per-run config files ride
the launch lifecycle — and `codemux tui` refuses them; the Claude Code,
OpenHands, Aider, Kimi Code, and Goose overrides carry into the TUI,
which delivers them through the environment alone. OpenHands has no equivalent of codex's `shell_environment_policy`: both of its terminal implementations (subprocess and tmux) build the shell's environment from the CLI process's own, and the sanitizer in between strips only `SESSION_API_KEY` (`sanitized_env`, openhands.sdk under CLI 1.16.0, verified 2026-10-07), so the provider key in `LLM_API_KEY` is visible to any command the model runs. Codemux prints that warning at launch; use a key you can revoke and scope it to the endpoint.

Two optional variables cap the override's tokens:
`CODEMUX_<AGENT>_PROVIDER_MAX_OUTPUT_TOKENS` and
`CODEMUX_<AGENT>_PROVIDER_MAX_CONTEXT_TOKENS`, each a positive integer.
A cap applies only to an override (one set without an override fails the
run), and only where the harness can actually carry it — a cap it cannot
honor fails the run loudly before launch instead of being silently
dropped:

| Harness | Output cap | Context cap |
|---------|-----------|-------------|
| Claude Code | `CLAUDE_CODE_MAX_OUTPUT_TOKENS` | refused — Claude Code exposes no context-window variable |
| Codex | refused — no such config key exists | `model_context_window` in the override's config.toml |
| OpenCode | `limit.output` (both caps required together) | `limit.context` (both caps required together) |
| Aider | refused — no max-tokens flag exists | refused — no max-tokens flag exists |
| Kimi Code | `KIMI_MODEL_MAX_COMPLETION_TOKENS` | `KIMI_MODEL_MAX_CONTEXT_SIZE` |
| Droid | `maxOutputTokens` in the BYOK entry | refused — the BYOK entry has no context field |
| Pi | `maxTokens` in the model entry | `contextWindow` in the model entry |
| Goose | refused — the knobs live only in its config file | refused — the knobs live only in its config file |
| OpenHands | refused — the LLM trio is the whole surface | refused — the LLM trio is the whole surface |

The other harnesses have no override: Copilot, Gemini CLI, Cline, and
Qwen carried override machinery only to ground their refusals' live
checks, and it was removed in 0.7.0 as dead surface (OpenHands kept its
channel because `--override-with-envs` is also how its model selection
works). An override exported for any harness without support — Z.AI,
Antigravity, Cursor, the rest — fails the run before launch rather than
being ignored. The Cursor agent CLI, which has no custom-provider
mechanism, documents that limit instead.

### `check` options

`codemux check` makes a real request to the selected provider and requires that
harness to be installed and authenticated. It can consume quota or incur
charges. Its `--timeout` defaults to 60 seconds. Harnesses whose safe mode needs
an outer boundary (including Cursor and Gemini read-only) are probed under
the default sandbox. `check --hermetic` proves a harness ignores its
customizations: it plants instruction files with a code word in a scratch
directory and probes twice, once hermetically (the model must answer `OK`)
and once as a control carrying everything but `--hermetic` — the same
tools selection included (the planted code word must reach the model).
Two requests. Use `--help` for the full option list.

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
| `agy` | `agy` | yes | yes | yes |
| `aider` | `aider` | yes | yes | yes |
| `claude` | `claude` | yes | yes | yes |
| `cline` | `cline` | yes | yes | yes |
| `codex` | `codex` | yes | yes | yes |
| `copilot` | `copilot` | yes | yes | yes |
| `cursor` | `agent` (preferred; `cursor-agent` fallback; desktop `cursor agent` only via the `CODEMUX_CURSOR_ENTRY=cursor` opt-in) | yes | yes | no |
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
| `agy` | `--mode=plan` + required `scode --ro` | default prompting (headless soft-denies) + required sandbox | `--mode=accept-edits` + required sandbox | `--dangerously-skip-permissions` |
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

Cursor's programmatic mode exposes write and shell tools. Codemux runs the
standalone `agent` entry, then the legacy `cursor-agent` alias, and reports
cursor as not installed when neither resolves. The desktop CLI's
`cursor agent` subcommand wraps the same agent, but the wrapper may
install or update it on first use — the Cursor.app launcher downloads and
runs the Cursor installer when `~/.local/bin/cursor-agent` is absent and
updates it when old, before forwarding to that same binary — so Codemux
executes that entry only when you opt in: set
`CODEMUX_CURSOR_ENTRY=cursor` and pass the name through
(`--pass-env CODEMUX_CURSOR_ENTRY`). The opt-in is the argv you typed,
not something a repository or shell profile can inject. With it, the
trust check applies to the `cursor` binary resolved against the requested
working directory, and the version gate probes `cursor agent --version`
only after that check, only on the launch path — never in `list`,
`doctor`, or `verify`, which stay spawn-free. `verify` also builds its
commands against an empty environment view, so an exported
`CODEMUX_CURSOR_ENTRY` never changes its result. Codemux sends the prompt
through stdin, uses native Plan and
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
read-only boundary. Three protections ride every gemini run: the packaged
system setting that disables generic project `.env` loading, a launch-time
rejection of `.gemini` project controls, and `--sandbox=false` in argv so
Gemini's nested sandbox cannot hand project Dockerfiles or Seatbelt profiles
the selected boundary. Only the first rides the settings file — and on a
user-owned prefix (Homebrew, a source checkout) gemini silently skips that
file, because its security walk requires the file and every ancestor
directory to be root-owned (unchanged since the audited 0.53.1), so that one
pin applies only on root-owned installs. The other two are launch-boundary
mechanisms and apply everywhere ([ledger](docs/HARNESS-COMPATIBILITY.md)).

## Result envelopes

`codemux run --result-json` prints a result envelope on stdout instead of the
plain reply. Claude and Z.AI keep the harness's own envelope (Claude Code's
`--output-format json`), with one codemux-owned field appended; Antigravity's
`--output-format=json` envelope (the `=`-form its pre-parsed value flags
require) passes through the same way; Codex, whose
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
