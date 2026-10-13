# codemux

> **Beta software (v0.13.0).** `codemux` is under active development. Expect behavior changes as adapters and sandbox policy continue to harden.

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
- Installed agent CLIs you plan to use (`aider`, `agy`, `claude`, `cline`, `copilot`, Cursor's `cursor-agent`, etc.)
- [scode](https://github.com/bindsch/scode) 0.2.0 or newer if you use `--sandbox`. Every sandboxed agy run requires scode 0.6.0 or newer, regardless of login method.
  A run whose only credential is one codemux injects (a provider override's key or a `zai` run's Z.AI gateway token) needs 0.6.0's `--keep-env` under `--sandbox-scrub-env` or `--sandbox-trust untrusted`, both of which scrub.

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
| `session` | Live agent session over stdio (JSONL in, JSONL events out) |
| `tui` | Interactive harness session |
| `check` | Live provider/model probe (uses credentials and may incur charges) |
| `list` | Agent capability overview |
| `doctor` | Installation and capability diagnostics |
| `usage` | Subscription quota through optional `usagemux` integration |
| `calls` | Recent records from the per-call usage ledger |
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
| `--experiment-mcp <spec.json>` | Claude only: one experiment stdio server through a codemux-owned SDK control bridge. Requires `--hermetic --tools none --auto read-only` and scode. Records server bytes and Claude's emitted tool results separately; the recording lives under codemux's state directory and `--result-json` names its path as `codemux.recording`. VERIFIED on Claude 2.1.280 by the operator's marker probe and extended canary with a leaking control. Codex refuses because its `Wall time:` header changes result bytes. See [the experiment report](docs/experiment-mcp-report.md). |
| `--hermetic` | Load none of the operator's customizations (instruction files, skills, plugins, hooks, MCP servers); the login still works. Claude, Z.AI, Codex, OpenCode, and Antigravity have live verification evidence (OpenCode refuses logins carrying remote configuration). Antigravity uses private HOME + a Keychain mirror + an explicit clean run directory under read-only scode 0.6.0 or newer; VERIFIED on the operator's Round 11 tree. Other harnesses refuse. See [docs/HERMETIC.md](docs/HERMETIC.md) |
| `--tools <selection>` | `default` or `none`. Codex requires `--auto read-only`; OpenCode requires `--hermetic` and refuses the combined canary because its plain control cannot enforce the deny. Antigravity uses deny-all settings + plan mode + attempt detection under read-only scode 0.6.0 or newer; any native tool attempt fails the run. VERIFIED with the login mirror on the operator's Round 11 tree. Other unsupported harnesses refuse `none`. |
| `--result-json` | Return a structured result envelope on stdout instead of plain text, so a caller can read what the run consumed (tokens, cost). Claude, Z.AI, Codex and Antigravity; other harnesses refuse the flag rather than silently returning text. Claude-family and Antigravity envelopes are the harness's own with one added `codemux` block; Codex reports the final assistant message as `result` plus the same block. See [Result envelopes](#result-envelopes) |
| `-s, --sandbox` | Execute via `scode` (default: on; `--no-sandbox` opts out, and autonomy below `high` then refuses) |
| `--sandbox-trust <level>` | `scode` trust override (`trusted`, `standard`, `untrusted`; the `untrusted` preset implies the scrub, so the `--keep-env` exemption below rides on it as on `--sandbox-scrub-env`) |
| `--sandbox-no-net` | Add `--no-net` to `scode` |
| `--sandbox-scrub-env` | Add `--scrub-env` to `scode`. scode 0.6.0's scrub strips by pattern, credentials included, so the environment codemux itself injected for the run (a provider override's gateway pair and key above all) rides the paired `--keep-env` exemption. The exemption rides whenever the scrub may be on through codemux's own flags — `--sandbox-scrub-env`, and `--sandbox-trust untrusted`, whose scode preset implies the scrub — and only then, because scode 0.6.0 prints a "no effect" warning on every non-scrubbed run that carries `--keep-env`. A run whose injected environment carries its only credential — a provider override's key, or zai's Z.AI gateway token, which zai injects on every launch with no override involved — refuses before the spawn on a scode whose `--help` does not document `--keep-env` (0.5.0 does not; the refusal names the flag you passed and scode 0.6.0), because a launch that might run stripped is not launched. Every other scrubbed run keeps its previous behavior on a scode without the flag: the exemption is dropped, never rendered as an unknown flag. A scode config file that sets `scrub_env: true` is invisible to codemux, so the exemption does not ride there — an operator who scrubs through the config passes the credential names to `--keep-env` themselves, or uses `--sandbox-scrub-env` so codemux's exemption rides. `verify`'s static preview shows the scrub alone — the exempted names are computed at launch from what the adapter injects |
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

### Experiment MCP runs

The experiment specification has five fields, the last optional:

```json
{
  "name": "experiment",
  "command": "/absolute/path/to/server",
  "args": [],
  "env": ["EXPERIMENT_VARIABLE"],
  "recording": "/absolute/path/to/recordings"
}
```

`env` names variables to copy from codemux's environment. Nothing else is
inherited. The server runs outside scode with the run's working directory;
the experiment owns its containment. The server executable must pass the
harness trust check: a regular
executable owned by the user or root, without group/world write permission,
outside the run directory. Its process group is terminated on timeout,
signal, and normal cleanup. SIGKILL or a host crash cannot run cleanup.
Both server readers settle before the recording is finalized. Claude runs
under read-only scode, with safe mode enabled and every built-in tool removed. Claude
2.1.280 or newer is required. Supported tool names are `bash`, `bash_bg`,
`poll`, `kill`, `read`, and `write`; a server may expose a subset — and
Claude must expose exactly the server's advertised set, checked before the
first turn. A prompt whose user control frame exceeds the 1 MiB message
bound is refused before anything is spawned.

```sh
codemux run -a claude --hermetic --tools none --auto read-only \
  --experiment-mcp spec.json --cwd /absolute/run-directory -f prompt.txt
```

The per-run recording is `experiments/<run-id>.jsonl` under codemux's state
directory (beside the `calls.jsonl` ledger), created with mode 0600. A spec
`recording` names a directory, absolute or relative to the spec file, created
with mode 0700 if absent. An existing non-directory is refused before spawn.
Each run writes `<dir>/<run-id>.jsonl`; a paired `check` control writes
`<dir>/<run-id>.control.jsonl` using its own run ID. Repeated runs keep
separate files. The check prints both paths on stderr.
`--result-json` reports the path as `codemux.recording`, and a plain run
names it on stderr. It preserves raw server bytes as base64,
native tool calls, control traffic, emitted model-bound result blocks,
and content comparisons. Changed or missing result content fails the run,
and so does any JSON-RPC error from the server, for any method — `ping`
included; tool failures should use MCP `isError` results instead.
Recordings contain the full prompt and tool data; they are not redacted.
They establish the control-protocol boundary, not a capture of a provider's
HTTP request. See [HERMETIC.md](docs/HERMETIC.md) for limits and verification.

Codex is refused before the spec is read: version 0.160.1 prepends its own
`Wall time: … seconds` header to MCP results. Codemux does not strip it.
Every other adapter, including Z.AI and Antigravity, refuses this flag.

### `session` options

`codemux session` starts (or resumes) a live agent session for `claude`,
`zai`, `codex`, `agy`, `opencode`, `aider`, or `kimi`: JSONL input on stdin,
JSONL events on stdout,
and the harness's own stderr passed through on codemux's stderr as `run`
passes it — the protocol, capability matrix, and per-harness version floors are in
[Live sessions](#live-sessions). The safety seams are `run`'s: the scode
sandbox is the default, and `--pass-env` validates the same names.
Autonomy maps the way `run` maps it, with one exception: a claude or zai
session at `high` runs `--permission-mode default` with `run`'s grant
list (`Edit`, `Write`, `NotebookEdit`, `Bash`) and never
`--dangerously-skip-permissions`. Any other tool asks: the request
reaches the caller as a `permission_request`, and the ceiling refuses an
`allow` for it (`autonomy_escalation`). A `high` session is therefore
narrower than a `high` run.

Provider overrides reach session spawns exactly as they reach `run`'s:
the same `CODEMUX_<AGENT>_PROVIDER_*` variables (token caps, codex's
`MULTI_AGENT` knob, and codex's refused `STORE` knob included) flow
through the same adapter seams, so a session's turns hit the override's
endpoint under the session protocol.
The caps ride where the harness can carry them and fail the session
loudly where it cannot — an aider session started with a cap set is
refused before spawn with the same message `run` gives. One codex
difference: an override session owns a `CODEX_HOME` keyed per session
(`~/.codex/.codemux-provider/session-home-<hash of the base URL>-<session
id>`) so its threads survive across that session's turns and resumes,
where a `run` gets a fresh per-run home. The home is written atomically
(the sandboxed child can write its parent), is never shared between
sessions, and is removed at any non-resumable end of a fresh session —
at a resumable end it is settled onto its key before the registry
record is released, so a `--resume` never finds a closed record whose
home path does not exist yet. A resumed home is never removed at
settlement (its state predates the
resuming process; the sweep reclaims it); a codemux that dies
mid-session leaves it to a 28-day sweep that never takes a home the
session registry holds live, and spares every home when the registry
cannot be read — a deletion needs a positive free answer. The registry records the
provider identity (the override base URL, or operator login when none)
with every session, and `--resume` refuses a mismatch with exit 78: a
transcript recorded on one endpoint never replays on another.

| Flag | Description |
|------|-------------|
| `-a, --agent <agent>` | Agent id (default: `claude`) |
| `-m, --model <model>` | Model name or alias |
| `--resume <id>` | Resume a recorded session id (claude/zai UUID, codex thread id, agy conversation id, opencode `ses_…` id, aider codemux UUID, kimi `session_<uuid>` id); the session registry must vouch for it |
| `--auto <level>` | Autonomy (`read-only`, `low`, `medium`, `high`) |
| `--effort <level>` | Effort (`none` through `ultra`; availability is harness-specific; `none` is refused for codex sessions, whose turn carrier has no audited `none`) |
| `--cwd <path>` | Working directory |
| `--timeout <seconds>` | Absolute cap on the whole session (default: none); expiry runs the shutdown path, ends with `session_ended` reason `timeout`, and exits 1 — the same code as a failure, distinguishable only by the reason, so a broker reading the code alone cannot tell them apart |
| `--turn-timeout <seconds>` | Per-turn cap; expiry interrupts the turn and the session continues; a turn still open one further period after that interrupt ends the session (`reason: timeout`, exit 1) (default: none; refused for agents whose sessions cannot interrupt — `agy`, `opencode`, `aider`, `kimi`) |
| `--permission-timeout <seconds>` | How long a permission request waits before codemux answers deny (default: `300`; never grants beyond the autonomy ceiling) |
| `--shutdown-grace <seconds>` | How long the harness gets to answer the end (the end-interrupt, or for agy the stdin close) before SIGTERM, and again to exit after it before the kill (default: `10`) |
| `--no-author-prefix` | Do not prefix harness-bound text with `[author]` |
| `--pass-env <names>` | Explicitly pass comma-separated parent environment names |
| `--tools <selection>` | Refused for sessions: no verified carrier restores a tool selection for a resumed session on any harness |
| `--hermetic` | Refused for sessions (see [docs/HERMETIC.md](docs/HERMETIC.md)) |
| `-s, --sandbox` | Execute via `scode` (default: on; `--no-sandbox` opts out, and autonomy below `high` then refuses) |
| `--sandbox-trust <level>` | `scode` trust override; `untrusted` is refused for sandboxed sessions — it denies the harness state a persistent session must write. With `--no-sandbox` the flag is ignored with a warning, as in `run` |
| `--sandbox-no-net` / `--sandbox-scrub-env` | Add `--no-net` / `--scrub-env` to `scode` (the scrub — which a session can only request through `--sandbox-scrub-env`, since `untrusted` is refused above — carries the same `--keep-env` exemption as `run` at every session spawn, and a session whose turns carry an injected credential — a provider override's key, or zai's Z.AI gateway token — refuses to start on a scode whose `--help` lacks `--keep-env`; see [Sandbox Integration](#sandbox-integration-scode)) |
| `--enable-playwright-mcp` | Enable the local Playwright MCP inside the sandbox (claude/zai only; requires `--sandbox` and `--auto low`: the session ceiling grants no MCP tool at `medium` or `high`, and `read-only` allows no tool use) |

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
Claude Code's defaults). The model id must be what the endpoint serves;
the tier the client assumes is codemux's to declare: Claude Code >= 2.1.280
validates `--model` against its own model catalog before any request
leaves the client, and a provider-format id is not in it — the run dies
client-side ("There's an issue with the selected model (<id>)") with zero
requests reaching the endpoint. Under an override codemux therefore also
passes `--settings` with a `modelPicker` row mapping the override's model
onto `behavesAs: "claude-sonnet-5"` — the binary's own remedy: the row
names the catalog tier whose client-side handling applies, and it
"changes neither the row's label nor the model ID sent". The payload
rides argv as inline JSON, outranks the operator's user settings, and
lives exactly as long as the launch; `run`, `tui`, and `session` all
carry it, and without an override nothing is added. The base URL is the
host root: Claude Code appends `/v1/messages` itself, so a value ending
in `/v1` doubles the segment (`/v1/v1/messages`, a 404) — unlike codex's
override, whose config `base_url` does include the `/v1`. Claude Code
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
cap it fails the run when set without an override. A response-storage
knob does not exist to set: `CODEMUX_CODEX_PROVIDER_STORE` is refused
outright, for any value that is non-empty after trimming and on every
path — an empty or whitespace-only value counts as unset, the same
convention as `MULTI_AGENT` (both knobs trim before they test). No supported
Codex release has a response-storage config key (the generated config
schema shipped in codex-cli 0.159.3 and the 0.160.1 binary's own config
surface both lack it), and both already send `store: false` on every
Responses request, with `previous_response_id` absent from the HTTP wire
entirely, so turn 2+ never relies on server-side response storage in the
first place. OpenHands carries the override
through `--override-with-envs`, the same channel its model selection
uses, with `LLM_BASE_URL`/`LLM_API_KEY`/`LLM_MODEL` (litellm's `openai/`
model prefix added, as aider's). The Codex, Droid, Pi, and OpenCode
overrides support headless runs only — their per-run config files ride
the launch lifecycle — and `codemux tui` refuses them; the Claude Code,
OpenHands, Aider, Kimi Code, and Goose overrides carry into the TUI,
which delivers them through the environment alone. `codemux session`
carries the override for every session-capable harness through the same
seams `run` uses, with the codex difference above: a session's override
home persists across turns and resumes instead of living one run.
OpenHands has no equivalent of codex's `shell_environment_policy`: both of its terminal implementations (subprocess and tmux) build the shell's environment from the CLI process's own, and the sanitizer in between strips only `SESSION_API_KEY` (`sanitized_env`, openhands.sdk under CLI 1.16.0, verified 2026-10-07), so the provider key in `LLM_API_KEY` is visible to any command the model runs. Codemux prints that warning at launch; use a key you can revoke and scope it to the endpoint.

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

With `--experiment-mcp`, Claude's canary also plants a skill, hook, and MCP
configuration. Both probes retain the same experiment server and tool
selection. The control intentionally omits safe mode. Canary fixtures are
planted under `.codemux-experiment-check-<random>/` in the system temp
root and removed when the check ends — on success, failure, or
interruption. Recordings go to the state directory like any run.

The operator verified Claude 2.1.280 on this branch from an unsandboxed
process. The marker run exited 0 and retained 46 JSONL records with
`CODEMUX-MCP-RESULT-8B73E209` in the delivered result and the model's reply.
Names seen were `bash`, `experiment`, and `mcp__experiment__bash`, with no
built-in shell tool. The extended check reported `HERMETIC claude: OK`
and `control: planted code word reached the model, as expected`.

Antigravity's `--hermetic` and `--tools none` policies are **VERIFIED** on agy 1.3.3
with the login mirror by the operator's Round 11 live checks on installed scode 0.6.0.
Hermetic runs require an explicit clean `--cwd`
owned by the run and refuse `GEMINI.md`, `AGENTS.md`, or `.agents/`, naming
the path. Every sandboxed agy run gets a private HOME. Authentication precedence
is an API key in the adapter environment (`GEMINI_API_KEY` or `GOOGLE_API_KEY`),
then a file token from the real login home, then the Keychain item. API-key and
file-token runs do not build a mirror or look up a Keychain credential. Only a
Keychain login needs a parent-built `Library/Keychains/login.keychain-db`
containing the Antigravity item. With none of these credentials, launch refuses
with "agy is not logged in; run `agy` to log in".
Plain runs link `.gemini` to the operator's real `~/.gemini`; hermetic,
tools-none, and probe runs retain clean state. The mirror is a 0600 file holding the whole
token, including the refresh token, for the run's lifetime. A refresh stays
in the mirror; the next run copies the real Keychain item again. Cleanup
removes the private home or fails loudly and names any remaining credential.
The parent trust-checks `/usr/bin/security`. Creation, unlocking, and credential
insertion use interactive stdin; neither token nor passphrase enters process argv.
An empty template keychain and its random password are cached with mode 0600
in the real user's fixed codemux state root. `CODEMUX_CALL_LOG` cannot move
the template or its lock, so runs with different logs share both.
Template creation runs once under an exclusive lock with stale detection;
that step snapshots and restores the user's search list. Every launch first
repairs leftover template or mirror entries under the same lock, including
when a cached template exists or an API key supplies authentication. Per-run
copies leave the list untouched. Failed insertion rebuilds and retries once.
Each private home records its owner's PID before credentials are copied.
Every launch sweeps stale `run-*` homes when `kill(pid, 0)` reports that the
owner is gone. This removes mirrors left by SIGKILL or a crash on the next
launch. Live owners and uncertain process states are retained.
Cleanup verifies that no mirror entry remains. File-token copies read
from `os.homedir()`, independently of the instruction/config home.
Tools-none runs use plan mode, deny all seven documented action classes,
and fail on native attempts, including tool-step refusals and
`denied_actions`, naming the attempted actions. Tool schemas remain.
Both policies require read-only scode. Every sandboxed agy run requires scode 0.6.0 or newer,
including API-key and file-token runs that do not need a Keychain mirror.

`check -a agy --hermetic` uses a planted scratch operator home and an empty
cwd, then requires its non-hermetic control to reveal the code word.
`check -a agy --tools none` requires a denied shell attempt and a control
that executes the same command with `--dangerously-skip-permissions`
under read-only scode. Only `command`, `unsandboxed`, or a denied `run_command`
step qualifies; unrelated denials fail. The first and only command attempt must
be denied. Any completed command step or command output anywhere in the stream
fails the probe, even if another attempt is denied. The control must contain the expected
output in a completed native command step and in its reply.
Combining the flags runs both pairs.
`check -a agy --agy-isolation-probe <mode>` exposes `login`, `hermetic`,
`control`, `tools`, and `tools-control` separately. Checks never write the
real `~/.gemini`; scratch homes and native logs are removed at completion.
The operator's Round 11 plain run answered `OK` and the public check reported
`HERMETIC agy: OK` and `TOOLS agy: OK`, both exit 0, on 2026-10-13 at 07:41 CEST
with agy 1.3.3 and installed scode 0.6.0. The user search list held only the
login keychain before and after. No private home remained. Round 12's stricter
command ordering and cancellation changes have synthetic regression coverage;
no Round 12 live run is claimed.
Commands and live results are in the
[experiment report](docs/experiment-mcp-report.md).

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

### `calls` options

`codemux calls` shows the last 20 ledger records, newest first. See
[The call ledger](#the-call-ledger) for what a record carries and where the
file lives.

| Flag | Description |
|------|-------------|
| `-n, --limit <count>` | Records to show, most recent first (1 to 100000; default 20) |
| `-a, --agent <id>` | Show only one agent's calls |
| `--since <when>` | Cutoff as a duration (`90m`, `24h`, `7d`) or an ISO timestamp. A value that is neither, or a duration whose cutoff falls outside the date range, is a usage error (exit 64 with a message), never a silently empty view. A record counts when its `ts` is inside; a closing `session` record also counts when any turn of the same session is inside, so a session that started before the cutoff keeps its cost — the claude family reports it only on that closing record |
| `--json` | Print the raw JSONL records instead of the table |
| `--sum` | Print totals over the shown records — filters run first, so the totals cover exactly what is shown. Closing `session` summaries fold in per field: a summary contributes a usage field only when no shown turn of the same session reported that field, so a session's tokens come from its turns (never counted twice) while the claude family's session cost — null on every turn, because the wire's `total_cost_usd` is a session-lifetime figure only the closing record adopts — comes from the summary; a summary whose turns are not shown contributes everything it reported. A resumed session's several closings fold to the newest one, so the pre-resume share is never counted twice. A field no record reported is `unknown`, never zero, with the count of records that did not report it |

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
| `cursor` | `cursor-agent` (preferred; `agent` fallback; desktop `cursor agent` only via the `CODEMUX_CURSOR_ENTRY=cursor` opt-in) | yes | yes | no |
| `droid` | `droid` | yes | yes | yes |
| `gemini` | `gemini` | yes | yes | no |
| `goose` | `goose` | yes | yes | no |
| `kimi` | `kimi` | yes | yes | no |
| `opencode` | `opencode` | yes | yes | headless |
| `openhands` | `openhands` | yes (`--override-with-envs`) | yes | no |
| `pi` | `pi` | yes | yes | yes |
| `qwen` | `qwen` (`qwen-coder` fallback is sandbox-only) | current CLI only | yes | no |
| `zai` | `claude` (z.ai proxy) | yes | yes | yes |

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
| `gemini-flash` | - | `gemini-3.6-flash` | - | `gemini-3.6-flash` | `gemini-3.6-flash` | `gemini-3.6-flash-high` |

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
execution. The preset denies the harness-state directories. scode 0.6.0's
`--scrub-env` strips by pattern, credentials included, and pairs the scrub
with a `--keep-env <NAME[,NAME...]>` exemption; on a sandboxed `run` the
environment codemux itself injected (the adapter's standing and per-run
variables — a provider override's gateway pair and key above all) rides
that exemption, so the scrub takes the ambient environment without taking
codemux's choices. The exemption rides whenever the scrub may be on
through codemux's own flags, and only then: under `--sandbox-scrub-env`,
and under `--sandbox-trust untrusted`, whose scode 0.6.0 preset implies
the scrub and cannot be weakened by config. Nowhere else — scode 0.6.0
prints a "no effect" warning on every non-scrubbed run that carries
`--keep-env`, so an unsolicited flag would warn on every launch. A run
whose injected environment carries its only credential refuses before
the spawn on a scode whose `--help` does not document `--keep-env`
(0.5.0 does not; the refusal names the flag you passed — the scrub-env
spelling, the untrusted spelling, or both — and scode 0.6.0): a provider
override's key — the operator's own was omitted on purpose — and zai's
Z.AI gateway token alike, for zai injects `ANTHROPIC_AUTH_TOKEN` (from
`ZAI_API_KEY` or `~/.zai`) on every launch with no override involved, so
a scrubbed zai run's only credential is one codemux injected and it
refuses on the same rule. Every other scrubbed run keeps its previous
behavior on a scode without the flag: the exemption is dropped, never
rendered as an unknown flag. One scrub is outside codemux's reach: a
scode config file that sets `scrub_env: true` is invisible to codemux,
so the exemption does not ride there — that case is the operator's to
manage (pass the credential names to scode's `--keep-env` yourself, or
request the scrub through `--sandbox-scrub-env`, where codemux's
exemption covers it). A `session` applies the same rule at its spawns —
the long-lived child once, each per-turn process of the
turn-per-process agents (kimi, opencode, aider) per turn; a session can
only scrub through `--sandbox-scrub-env` (`--sandbox-trust untrusted` is
refused for sessions up front, since a persistent session must write
harness state) — and a session whose turns carry an injected credential
(an override's key, zai's gateway token) refuses to START on a scode
without `--keep-env`, with the run path's message verbatim. `tui` carries
the same exemption: the names the launch injected ride `--keep-env` too,
and a tui carrying an injected credential refuses to start on a scode
without `--keep-env`, with the run path's message verbatim.

Codemux builds child environments from a small operational allowlist and the
selected harness's credentials. Aider receives its documented common provider
keys; other multi-provider harnesses primarily use their own credential stores.
If a task needs another variable, grant its exact name with
`--pass-env NAME` (comma-separated). Runtime loader variables such as
`BASH_ENV`, `NODE_OPTIONS`, `PYTHONPATH`, `LD_*`, and `DYLD_*` are always blocked.
For example, Claude Bedrock users can explicitly grant the required AWS
credential names. Treat every grant as authority available to model-invoked tools.

Cursor's programmatic mode exposes write and shell tools. Codemux runs the
standalone `cursor-agent` entry, then the `agent` alias, and reports
cursor as not installed when neither resolves. `cursor-agent` is the name
Cursor's own installer lays down and the name scode's known-harness list
carries — scode 0.6.0 dropped the bare `agent` name from that list (the
surface was too generic to keep), and `agent` is a name other tools
install too, so it stays only as a fallback for machines where
`cursor-agent` does not resolve. The desktop CLI's
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

The envelope's inputs ride plain runs too: claude/zai (`--output-format
json`), agy (`--output-format=json`), opencode (`--format json`), and codex
(`--json`) launch in their structured mode unconditionally, and codemux
unwraps the structured stdout back to the plain reply byte for byte
wherever the wire can carry the bytes —
opencode's reply is spelled the way its run command prints it in plain mode,
each text part trimmed on its own line; codex's is the final assistant
message its human mode prints — verbatim plus exactly one trailing
newline, whatever the message ends with (the printer's own append; an
empty or whitespace-only message keeps its bytes and gains the newline)
— so `run`'s stdout contract holds while
[the call ledger](#the-call-ledger) still gets the usage. The opencode and
codex streams carry the same volume — every event with all tool output — so
neither stdout is ever captured whole: the launcher feeds the event stream
through a fold that keeps only the reply text and the folded usage — on
codex the served model too; opencode's wire names no model, so its fold
reports none — tool output is dropped as it arrives — and the output bound
measures that residue, so tool volume spread over lines under the cap
cannot kill the run, and the same stream
read in different chunkings always earns the same verdict. One rule for
a line past the bound itself (round al37): the run fails at the capture
limit — exit 125, the diagnostic on stderr, the output that preceded
the line, never a silent truncation — whatever the stream's regime (the
pass-through below still open, the wire proven, a stream that never
decided) and whatever the line's opening bytes identify, for the wire is
committed only by a line read whole as the announcement, and a dropped
line proves nothing; the check runs while the line accumulates and
again when it completes, so a final line that never got its newline
fails the run the moment it crosses. Rounds al8–al36 classified the
dropped head instead — a tool part or a warning item dropping with a
note alone (the warning's carve reaching before the first
`turn.started`), any other wire shape failing as drift, the open
pass-through arming a provisional overflow that a later wire line freed
(a giant tool part before any text succeeding) — and al37 deleted them
all: the retained-bytes check counts bytes retained, nothing more, and
no oversized line is dropped silently. The
codex fold's verdict is the envelope path's, stream-reduced, with one arm
of its own: a turn that never completed, or one whose completion a
failure outlives — a failed turn, a top-level error event after the
closing turn.completed, a broken or truncated stream, a kill — prints
nothing, exactly what human mode printed, and reports no usage; a turn
that ends with only a Plan answers
through the recorded final message (`--output-last-message`) with a note;
when the stream completed the turn but codex itself exited non-zero, the
final message stays on stdout — human mode printed it before exiting —
while the run fails and records no usage; and a turn that completed with
no message anywhere succeeds with empty stdout and keeps the usage, human
mode's own exit-0 verdict for that turn. The fallback file is the one
bounded exception: a plain run names `--output-last-message`, and the
verdict consults it only for the turn the wire cannot carry — one that
completed with no agent_message (the Plan-only shape) — so the file can
never contradict a stream that carried the reply or failed its own way
(readable, the recorded message is the answer with a note; an empty
readable file is upstream's messageless-turn record — an empty answer
with no note; missing, the run fails
naming the unwritten file — upstream writes an empty file for a
genuinely messageless turn, so a named file that is not there is a write
codex only logged; unreadable, the run fails
with the read error), while a `--result-json` run that names a fallback
file carries the same split: a named file that is missing fails the
turn naming the absent file, and one that cannot be read fails the run
with `could not read codex's --output-last-message file: <error>` — the
read error alone, no file named — for the read failed, which is not a
verdict about the file's contents. A
structured stream that arrives
broken never passes through as
the reply: for opencode one unparseable or cut-off line among wire lines (a
timeout can cut the last write) keeps the text and usage folded so far with
the break on stderr; for codex a line that is not the event grammar — not
JSON, or JSON that is not an object (an array or a scalar), or any drift
the envelope path's
parser refuses — fails the run with nothing on stdout (the turn never
completed, and human mode printed nothing for it); and for the claude
family and agy a stdout that is
JSON but not a parseable envelope (any JSON value — an array or a scalar
included — or an object a kill cut mid-write; the envelope is one write a
kill can halve)
fails the run with nothing on stdout. Stdout that is not the structured
output the launch asked for at all — an older binary, a wrapper that strips
the flag, not one line of the wire — passes through verbatim with the run
unchanged and nothing recorded; a codex binary that ignored `--json` and
printed human mode anyway leaves its blended `tokens used` stderr figure as
the one usage there is (`total_tokens` alone; the figure mixes input and
output and cannot be split back apart). The same verdict rules as the
envelope path apply to the unwrap: an error result or a result with no text
fails the run.

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
when every component was reported. `session_id` is always null in a run
envelope: no run persists a session (Claude and Z.AI launch with
`--no-session-persistence`, Codex with `--ephemeral`); the field stays
null and session identity belongs to [`codemux session`](#live-sessions),
which owns it through the session registry.

A failed run is a failed run on every channel: the exit code is non-zero even
when the harness's own was not, and the diagnostic rides
on stderr on its own line after the harness's own output — separated even
when the harness's last stderr line was unterminated. An empty result is a
failed run on every path, plain or structured: a Claude-family envelope whose
`result` is empty or whitespace only, or a codex turn whose final
`agent_message` carried text that is empty or whitespace only, fails instead
of passing a run with no reply — the one exception is the codex plain run,
where a completed turn with no message or an empty one keeps the exit-0
verdict human mode gave it: no message at all prints nothing, and an empty or
whitespace-only message prints its bytes plus exactly one trailing newline
(`println!`'s own spelling, never an emptied string). In a codex-built envelope `result`
is null too (a partial message from an earlier completed item never poses as
the final one); a Claude-family envelope keeps the harness's own `result`
field verbatim, since it re-emits the harness's record rather than building
one. A codex
stream whose last turn never ended with `turn.completed` fails the same way:
a completed message item is not a completed turn upstream, so a zero-exit
wrapper that drops the final event cannot pass a truncated result off as
done — and an item event outside a turn (`item.started`,
`item.updated`, or a completed item of any type): before the first
`turn.started` as well as after the last `turn.completed` with
no turn reopened — a pre-turn item could otherwise overwrite the served
model with a reroute notice no turn of this run served — with the one
exception round al35 carved: a completed `error` item before the first
`turn.started`, its message a plain string that is not the reroute
notice's own, is a startup warning — codex reports initialization
warnings in exactly that shape between the thread announcement and the
first turn, and the run it annotates succeeds (never past a turn
completion: after the last `turn.completed` an item is the
concatenated-stream shape again, wherever its message would have come
from) — a `thread.started` that is not the stream's first event
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
`--result-json` launch also passes `--output-last-message`, and the
message codex recorded
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

## The call ledger

Every completed call writes one JSON line to a ledger file: each `run`, each
`check`, each session turn, and one closing line per session with the
cumulative usage. Whoever the caller is and however the run was launched —
hermetic, sandboxed, or against a provider override, whose throwaway homes
leave no harness transcript behind — the receipt lands in one place. A run
interrupted by SIGINT or SIGTERM writes its receipt too: exit code 143 and
the usage folded so far. So does a run that ran its harness and still
failed to finish — a capture the runner could not take (a stream that is
not valid UTF-8) or a throw while post-processing — with the launch's
failure exit code (1, or 64 for a usage refusal) and the usage folded so
far; a launch refused before the spawn (a missing sandbox, an unresolved
binary) ran nothing and records nothing. All through the same never-fail
append. A
ledger failure never fails the run: the first failure warns on stderr, later
ones stay silent, and nothing about the ledger ever touches stdout.

The file is `calls.jsonl` beside the session registry —
`~/Library/Application Support/codemux/` on macOS,
`~/.local/state/codemux/` elsewhere, derived from `$HOME` alone. 
`CODEMUX_CALL_LOG=<absolute path>` relocates it (a relative value resolves
against the working directory); `CODEMUX_CALL_LOG=off` disables it. The
file is created 0600 and tightened when it arrives with wider permissions;
the directory is created 0700, and an existing directory is tightened only
when it is the default state directory — a relocated ledger never changes
its directory's permissions (the directory the operator named, `/tmp`
included, keeps what it has, and a failure to tighten never stops the
append). The append itself never throws: everything, including resolving
the path, sits inside the never-fail guard, so a hostile environment value
warns once and the run proceeds. codemux's own test suite redirects appends
through `CODEMUX_TEST_LEDGER=<path>` (the preload `tests/setup.ts` sets with
`--preload`); it is consulted only when `CODEMUX_CALL_LOG` is unset, and no
generic variable — `NODE_ENV=test` included — ever diverts records, so a
process outside codemux's test runner that happens to set one keeps its
real ledger. Each line is one `O_APPEND` write so concurrent codemux processes
never interleave half-lines. What a harness reports about itself — the
model names, the provider host, the finish reasons — is stored stripped of
ANSI escape sequences and C0/C1 control characters, so a hostile or merely
decorated endpoint cannot store bytes that replay into the operator's
terminal on every view; `--json` prints the stored bytes verbatim, and the
table sanitizes again at render for ledgers written before the strip.
`codemux calls` reads it back (see
[`calls` options](#calls-options)); the view is bounded to the file's
newest 16 MiB, and a cut landing mid-line drops that partial line only —
a complete record is never dropped for the bound, and a corrupt or
wrong-shaped line is skipped and counted, never fatal.

A record has the same shape on every line — fields that do not apply are
null, not absent:

```json
{
  "ts": "2026-10-08T12:00:00.000Z",
  "kind": "run",
  "agent": "codex",
  "model": null,
  "model_effective": "gpt-5.3-codex",
  "provider": "default",
  "session_id": null,
  "turn_id": null,
  "autonomy": "high",
  "hermetic": false,
  "sandboxed": true,
  "exit_code": 0,
  "finish": null,
  "duration_ms": 4310,
  "cwd": "/repo",
  "usage": {
    "input_tokens": 200,
    "output_tokens": 50,
    "cached_input_tokens": 800,
    "total_tokens": 1050,
    "cost_usd": null
  }
}
```

`ts` marks the start of the call, turn, or session; `duration_ms` carries
the wall time from there. `model` is what the caller requested and
`model_effective` the model the harness says served the call (null when
unreported — the codex reroute rule from
[Result envelopes](#result-envelopes) applies). `provider` is `default` or
the host of a provider override's base URL — the endpoint's identity, never
its key. `kind` is `run`, `check`, `session_turn`, or `session`; session
records carry `session_id` and (for turns) `turn_id`, `finish` names how a
turn or session ended, and `usage` is the envelope's block exactly: nulls
when the harness did not report, never guessed. A session whose harness
has not named a native id yet — one that ends before its first
identity-bearing result — is keyed by a codemux-minted id instead of
an empty one, so id-less sessions never share a key in `calls --sum`.
`cwd` is the run's working
directory. Nothing else is recorded: no prompt text, no API keys, no
environment values.

What the ledger can know is what the harness reports, and that differs by
harness:

| Harness | Usage | Cost | Effective model |
|---------|-------|------|-----------------|
| claude, zai | Full (input, output, cached; total computed) | Yes (`total_cost_usd`, per run) | Yes (`modelUsage`, single-model runs) |
| codex | Full, plain and `--result-json` runs alike (input, output, cached incl. cache writes): every run launches `--json`, and a plain run's stream is folded down to the reply and the usage snapshot as it arrives — the 16 MiB output bound measures the residue, never the stream. The plain-unwrap escape hatch (a binary that ignored `--json`) keeps the blended `tokens used` stderr figure alone (total only — the figure mixes input and output) | No | Yes, on a mid-run reroute |
| agy | Full (input, output, cache reads; total computed) | No | No |
| opencode | Per-run sums (input, output, cache read+write, total, cost when the provider reports one). The plain-run path streams the `--format json` events through a fold that keeps the reply text and folded usage alone — tool parts are dropped as they arrive, so the run cannot outgrow the 16 MiB output bound, and what the tool events carried (their inputs, their outputs) is not kept anywhere | When reported | No |
| aider | None — its headless wire reports no usage | No | No |
| kimi | None — the stream-json wire carries no usage | No | No |
| everything else | None — plain text stdout, no structured mode | No | No |

For opencode sessions the numbers come from the per-turn wire the session
driver already parses; for claude, zai, codex, and agy sessions, from the
same envelope or event stream the `--result-json` path reads. A run whose
stdout is not the structured output the launch asked for (the plain-unwrap
escape hatch) records null usage honestly rather than a guess — codex
excepted (the table row above): its hatch run parses the blended `tokens
used` figure human mode prints on stderr, so the hatch records a real
total even from a binary that ignored `--json`. What an
endpoint reports is its own choice: the local vLLM override gateway this
release's live check ran against reported real token counts (24709 in,
2 out, 0 cached) and a zero cost — a reported zero, not a missing figure —
while an endpoint that reports nothing leaves nulls. The wire's
capability, not a fixed promise.

Session turns carry that turn's own usage where the harness reports one
per result (claude, zai, codex, agy, opencode); claude/zai's cost is
session-lifetime, so a `session_turn` record reports it null and the
closing `session` record carries the adopted final figure — which is why
`calls --sum` folds closing summaries per field (see
[`calls` options](#calls-options)) instead of dropping them: the tokens
come from the turns, the session's cost from the summary. A resumed
session writes a second closing record under the same session id, and each
closing carries session-lifetime usage (the writer cannot subtract the
pre-resume share: the wire reports only the new total), so `--sum` folds
the closings of one session to the newest — the older closing is
superseded and named in the note, never added. Aider and kimi sessions
report no usage on their wires, so their records carry nulls.

## Live sessions

`codemux session` is one protocol over every session-capable harness:
JSONL input lines on stdin, JSONL event envelopes on stdout, one harness
process per session with its whole process tree killed at the end —
except the three turn-per-process harnesses: `opencode` spawns one
`opencode run` per turn over the harness's own native session store,
`aider` spawns one headless `aider --message` per turn over a chat
history file codemux owns, whose ownership, regular-file shape, and
0600 mode are re-checked before every turn — a symlink planted between
turns fails the turn instead of being followed, and `kimi` spawns one
headless `kimi --prompt --output-format stream-json` per turn over
kimi's own on-disk session store, resuming the id the first turn's
`session.resume_hint` line named (`--session <id>`); the prompt rides
argv, so the run path's 32 KiB argv bound is the per-turn cap. A turn
whose process
has not landed yet when a graceful end begins (stdin close,
`shutdown`) still runs: the end path delivers the turn's payload
itself — the prompt on opencode's stdin, the canned negatives on
aider's — and drains the turn to completion (kimi's late child needs
nothing delivered: its prompt already rides its argv), so `printf one
user line
| codemux session -a <agent>` answers its one prompt; only a signal,
timeout, or crash end stops a late child on arrival. Aider runs a
prompt whose first non-whitespace character is `/` or `!` as its own
command before any model turn — `!` is the `/run` alias and executes
the shell immediately, ungated by `--dry-run` — so such a prompt is
refused outright, on the run path (exit 64) and the session path
(`input_rejected`, `unsupported`) alike: relaying one would execute a
line the autonomy never
authorized. Kimi's refusal is narrower (round al17): 0.31.1's headless
path parses only goal-creates before the model turn (`/goal
<objective>` and `/goal replace …` run the goal flow with their own
exit codes and never reach the model), and every other prompt — any
other slash command, a `/`-leading path like `/tmp/notes.md please
summarize`, even `! …` — reaches the model unchanged, the last verified
live through `codemux run -a kimi`. codemux refuses the word-bounded
`/goal` name, all spellings, and the `!` shell-escape shape: the
subcommand spellings and `!` are model text today, but they are kimi's
command grammar and interactive shell escape, and one name-and-shape
boundary is stable where per-spelling dispatch has already changed
once. The history read-back
is bounded per turn, never per file: a session's history grows without
limit, and codemux reads only each turn's delta past a byte offset. A
turn killed partway leaves the history half-written (aider writes the
user block at the turn's start, the reply only at its end), so that
session's end is not resumable: a resume would replay the unanswered
prompt. Supported: `claude`, `zai`, `codex`, `agy`,
`opencode`, `aider`, `kimi`; any other agent refuses with
exit 64 rather than falling back to another harness. Each harness runs
behind its own session-only version floor (claude and zai 2.1.280, codex
0.159.3, agy 1.2.14, opencode 1.18.18, aider 0.86.2, kimi 0.31.1)
because the resume
and permission contracts are
only audited down to those builds — a harness whose version the probe
cannot read is refused like a below-floor build, not waved through.

Input lines (one JSON object per line):

| Type | Meaning |
|------|---------|
| `{"type":"user","text":"…","author":"…"}` | Submit a turn. `author` is optional; with the default author prefix the harness sees `[author] text` |
| `{"type":"steer","text":"…"}` | Steer the open turn (`codex` only; agents whose matrix says `steer: false` reject it with `unsupported`) |
| `{"type":"interrupt"}` | Interrupt the open turn |
| `{"type":"permission_decision","request_id":"…","decision":"allow"\|"deny"}` | Answer a permission request; codemux only relays decisions the autonomy ceiling already allows — and only ones the wire can carry (an allow on a request offering no accept decision is answered deny and rejected `unsupported`) |
| `{"type":"shutdown"}` | End the session cleanly |

Every non-blank input line is acknowledged (a blank line is skipped,
and a trailing CR is stripped): `input_accepted` or `input_rejected`
with a reason — `malformed`, `unknown_type`, `invalid_author`,
`text_too_long`, `text_nul`, `reason_too_long`, `unsupported` (an input
the agent's capability matrix does not carry, or one it refuses to
relay — an aider prompt that would run as one of aider's own commands),
`busy` (a `user` line
while a turn runs, on agents whose `user_during_turn` is false),
`no_active_turn`, `unknown_request`, `autonomy_escalation`, or
`shutting_down`. `text_too_long` also answers a `permission_decision`
whose `updated_input` makes the answer too large for the harness write
cap; the request stays pending. A line that is not valid UTF-8 is
rejected `malformed`. A `permission_decision` whose answer cannot be
written to the harness is rejected `shutting_down`, because the failed
write ends the session. Nothing is silently dropped: a line landing inside the
shutdown drain is rejected `shutting_down` (stdin is still being relayed
while the session ends), and once `session_ended` is out the stream is
closed — nothing follows it.

Input codemux holds in memory is bounded. On codex, a `user` line queued
behind an open turn and a `steer` held until the server names its turn
are rejected `busy` past 256 held lines or 32 MiB. Lines sent before the
codex handshake completes are held the same way; past that bound the
session ends with a fatal error, and every held line is rejected
`shutting_down` in order. On every agent, a harness that stops reading
its stdin ends the session with a fatal error once 64 MiB of written
input is still unread.

Output events are envelopes: `seq`, `ts`, `session_id`, `type`, `raw`,
and event fields. `raw` carries the harness's original line verbatim
(null on codemux-originated events — and note codex's `session_started`
is an exception the other way on a FRESH thread: it mirrors the
`thread/started` notification it translated, so its `raw` is a string
there; a RESUMED thread is announced from the `thread/resume` response —
the server sends no `thread/started` on resume — so its `raw` is null),
so a
caller can inspect anything codemux translated. A valid-JSON harness line
that matches no known shape passes through as a `raw` event with type
`unknown` and the session continues — never dropped. A line the parser
flags as a wire-grammar violation (a foreign session id, a second thread
announcement) is mirrored as `unknown` and then ends the session with a
fatal `error` event rather than guessing. A lifecycle violation the
driver catches instead (a result with no open turn, a duplicate
permission id, a codex response that names no turn or an unknown
request id) is handled the same way: the line is mirrored as `unknown`,
then the fatal `error`. A non-JSON or non-UTF-8 line ends the session
with a fatal `error` too, carrying a bounded excerpt (the first 4 KiB of
the line's bytes) instead of the line itself.
`session_started` carries the full capability matrix; `turn_started`,
`assistant_message`, `assistant_delta`, `usage`, `permission_request`,
`file_change`, `turn_completed`, `session_ended` follow. What each
harness honestly supports:

| Capability | claude | zai | codex | agy | opencode | aider | kimi |
|------------|--------|-----|-------|-----|----------|-------|------|
| `live_input` | true | true | true | true | true | true | true |
| `user_during_turn` | false (rejected `busy`) | false (same) | `queue` | false (rejected `busy`) | false (rejected `busy`) | false (rejected `busy`) | false (rejected `busy`) |
| `steer` | false (rejected `unsupported`) | false (same) | true | false | false (rejected `unsupported`) | false (rejected `unsupported`) | false (rejected `unsupported`) |
| `interrupt` | true | true | true | false | false | false | false |
| `permissions` | true | true | true (native server requests) | false | false | false | false (headless kimi auto-approves) |
| `deltas` | true | true | true | false | false | false | false |
| `file_changes` | derived from tool calls | derived | `native` item | false | false | false | false |
| `usage_stream` | false (usage only in the turn's `result`) | false (same) | true | false (usage only in the result) | false (usage only in each turn's `step_finish`, folded into `turn_completed`) | false (aider reports no usage headlessly) | false (the stream-json wire carries no usage) |
| `resume` | true | true | true | true | true (native `--session <id>`) | true (the history file) | true (kimi's own store, via `--session <id>`) |

A `false` is honest: the unsupported input is rejected by name, never
accepted and ignored. On claude and zai, `user_during_turn` is false
because print mode folds a mid-turn message into the running turn when
that turn makes another model request and runs it as its own turn when
it does not, so no result can be attributed to it in advance; send the
next `user` line after `turn_completed`, or interrupt first.

Permission requests are events, not prompts: the caller must answer
with a `permission_decision` line, an unanswered request is denied after
`--permission-timeout` (default 300 s), and codemux refuses to relay a
decision the current autonomy ceiling forbids — the session can never
run above the autonomy it was started with, even resumed (the registry
refuses a resume at a higher autonomy). At medium the ceiling relays an
`allow` only for edits inside the launch directory, and never for
executable configuration below it: `.git`, the harnesses' project
settings (`.claude`, `.codex`, `.gemini`, `.cursor`), editor and hook
directories (`.vscode`, `.idea`, `.husky`), `.envrc`, `.mcp.json`,
`.claude.json`, `.ripgreprc`, git's `.gitconfig`/`.gitmodules`, and
shell startup files. Whatever lands there
runs later, outside the sandbox, without anyone running it on purpose.
The ceiling judges only the requests the harness sends to the caller.
A medium claude or zai session carries `run`'s scoped edit grant, so
Claude Code approves an edit inside the launch directory by itself,
except under the paths it treats as sensitive itself (`.git`,
`.claude`, `.vscode`, `.idea` in the audited build). An edit to
`.envrc` or `.husky/pre-commit` inside the launch directory is never
asked about, and a sandboxed codex session never asks at all. For those
paths a medium session is exactly as wide as a medium `run`, no wider. A
request that outlives the moment it belonged to is denied the
same way (`permission_resolved: "superseded"`): one that arrives after
the session has begun ending (no decision could reach it anymore, and
the harness would otherwise wait on an answer inside the shutdown grace
window), and one still pending when its own turn completes or fails —
a later decision for it is rejected `unknown_request`.

Sessions are recorded in a local registry
(`~/Library/Application Support/codemux/live-sessions.json` on macOS,
`~/.local/state/codemux/live-sessions.json` elsewhere) with the
id, agent, working directory, harness home, autonomy, `--pass-env`
names (never values), and timestamps.
`--resume` accepts only ids the registry vouches for — same agent, same
harness home, same working directory, no `--pass-env` name or
`--enable-playwright-mcp` the creation lacked, not above the recorded
autonomy, and not below the
recorded containment (a session created under scode resumes under scode,
one created with `--sandbox-no-net` or `--sandbox-scrub-env` resumes with
it, judged as the resume effectively runs; the autonomy bound is ranked
per agent — on claude, zai, and codex a low-created session may resume
at high because high's ceiling denies what low's caller could approve,
while agy's ladder is strict: no resume above the creating level) — and
a corrupt or
tampered registry fails closed (resume refused), never silently
reinterpreted. A resume claims the record under the registry's lock
before it starts the harness, so of two concurrent resumes of one id
the second is refused `session_busy` (exit 78) before its harness can
act on any input. A resume that ends cleanly before its first turn
releases the claim and still reports `resumable: true`; a resume the
harness refuses (for example a claude transcript already cleaned up)
releases it and reports `resumable: false`. A registry that cannot be written ends the session
before it runs: an untracked live session must not run. A fresh claude,
zai, or aider session is recorded before its harness starts (codemux
chooses its session id — for aider a UUID whose chat history file it
creates under `~/.aider/.codemux/sessions/<id>/`), and a fresh agy,
opencode, or kimi session, whose id only its first
result names (kimi's: the closing `session.resume_hint` of its first
turn), checks that the registry can be written before it starts;
either failure exits 1 with nothing spawned. A fresh claude or zai
session that ends before its harness confirmed it leaves no record, so
a later `--resume` of its id exits 66. Killing codemux
mid-session still leaves a resumable
session: the harness persists its own state, and the registry's
owner-liveness check refuses resume only while the recorded owner is
still alive — a stale record (owner gone, `ended` never set) resumes.

Shutdown first uses the harness's protocol: an interrupt followed by stdin
close for claude, zai, and codex; stdin close for agy; and the end of the
per-turn process for kimi, aider, and opencode. The harness gets a grace
period to exit before SIGTERM, then another before tree SIGKILL. A child
that requires a signal has not shut down orderly: every nonzero code or
signal exit fails the session with reason `harness_failed`. There are
no exceptions for code 1, 137, or 143, and no signal attribution.
Code 0 can succeed; an idle session with no child can also succeed.
Other failures, including a caller stdin read error, still fail the session.

Every `session_ended` carries `harness_exit`, the last observed child's
raw `{code, signal}` outcome, or null when no outcome was observed.
Its `exit_code` summarizes the session's exit. Its `shutdown_requested`
boolean records whether stdin close, a `shutdown` input, or a signal to
codemux requested the end, independently of the child outcome.
An unanswered turn receives a synthesized `turn_completed`: `failed`
for a child failure or fatal error, otherwise `interrupted`, with
the usage the turn reported before the end — a codex turn's streamed
usage; all-null on the claude family and agy, which report it in the
result. A fresh Kimi resume hint is emitted after `session_started`,
only after registry recording succeeds,
so every turn is answered even where the harness cannot answer it
itself. A harness crash reports `harness_failed` and a fatal error. Exit
codes: 0 clean end, 1 crash, codemux failure, a registry codemux
could not reach (a lock held past its budget or an I/O error; a retry
may pass), or `--timeout` expiry
(the `session_ended` event's `reason: "timeout"` is what distinguishes
it), 64 usage, 66 unknown `--resume` id, 78 policy refusal (any resume
guard, including an untrusted registry), 143 signal.

Contract details per harness — the codex `app-server` method table, the
claude stream-json control round-trips, the agy NDJSON loop, the
opencode `run` wire, the aider history-file loop, the kimi stream-json
prompt wire — are in
[the compatibility ledger](docs/HARNESS-COMPATIBILITY.md).

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
for sandboxed Claude/Z.AI runs, install an audited `playwright-mcp` binary
locally and pass `--enable-playwright-mcp` together with `--sandbox`. A live
session (`codemux session`) also requires `--auto low`, where the caller
answers each MCP tool request; its ceiling grants no MCP tool above that. Codemux
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
