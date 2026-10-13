# CLI reference

Every command accepts `-h, --help`. Root `-V, --version` reads the package
version. Options below are parsed by codemux; unknown options and missing
option arguments are parser errors (exit 1). There is no generic pass-through
for arbitrary harness flags.

## Shared launch options

`run`, `tui`, `check`, and `session` accept these options unless a row
says otherwise. Harness capabilities can impose additional restrictions;
see [harnesses](harnesses.md) and [session capabilities](sessions.md).

| Option | Default and meaning |
|---|---|
| `-a, --agent <agent>` | Configured default, initially `claude`; resume must select the recorded agent |
| `-m, --model <model>` | Unset; resolves aliases, otherwise adapter/harness default |
| `--auto <level>` | `read-only`; also `low`, `medium`, `high` |
| `--effort <level>` | Unset; `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, `ultra`; mapped only where supported |
| `-s, --sandbox` | Enabled; requires compatible scode |
| `--no-sandbox` | Disable scode; requires `--auto high` |
| `--sandbox-trust <level>` | Policy default; `trusted`, `standard`, `untrusted`; sandboxed sessions refuse `untrusted` |
| `--sandbox-no-net` | Off; deny networking through scode |
| `--sandbox-scrub-env` | Off; request scode environment scrubbing |
| `--pass-env <names>` | Empty; comma-separated environment variable names, at most 64 |
| `--cwd <path>` | Current directory; must resolve to an accessible directory; check canaries manage their own directory |

`--sandbox-account <file>` and `--sandbox-account-id <id>` are available on
`run` and `tui`, not `session` or `check`. They append scode scratch-accounting
JSON with an optional correlation token. The file must be absolute. The ID
requires the file option and matches `[A-Za-z0-9._:-]{1,128}`.
After validation, sandbox policy/accounting options with `--no-sandbox` are
warned about and ignored. See
[policy details](autonomy-and-sandboxing.md).

`--enable-playwright-mcp` is available on `run`, `tui`, and `session`.
It requires Claude or Z.AI and sandboxing; sessions also require `--auto low`.
It is incompatible with `--hermetic` and `--tools none`. The locally installed
`playwright-mcp` must pass executable trust checks. Codemux does not download
it or execute an unpinned package. See [authentication and integrations](authentication.md).

## run

```sh
codemux run -a claude -p "Reply with OK."
codemux run -a codex -f prompt.md --result-json
printf 'Reply with OK.\n' | codemux run -a claude -f -
```

| Option | Default and meaning |
|---|---|
| `-p, --prompt <prompt>` | Inline prompt; exactly one of prompt/file is required |
| `-f, --file <path>` | UTF-8 file; `-` reads piped stdin, never a terminal |
| `--timeout <seconds>` | 1800; each of stdin collection and subprocess execution gets a separate budget |
| `--hermetic` | Off; suppress supported automatic customization loading |
| `--tools <selection>` | `default`; `none` has harness-specific residual capabilities |
| `--experiment-mcp <spec.json>` | Unset; Claude-only experiment bridge with required isolation policy |
| `--result-json` | Off; structured result with harness-specific normalization |

Timeouts must be finite and greater than zero, at most 86400 seconds.
Fractional seconds are accepted and rounded up to milliseconds. The timeout
is not an end-to-end wall-clock cap: input collection, execution, setup, and
shutdown are distinct phases.

See [isolation](isolation.md), [experiment MCP](experiment-mcp.md), and
[results](results-and-usage.md) for these contracts.

### Prompt input

Prompts must be nonblank, contain no NUL, and have at most 16 MiB of UTF-8.
File/stdin decoding rejects invalid UTF-8. Harnesses that put prompts in argv
also impose a 32 KiB limit, including when codemux reads the input from a file
or stdin. This applies to Agy, Aider, Cline, Copilot, Gemini, Goose,
Kimi, OpenHands, and the legacy `qwen-coder` fallback. Claude, Z.AI, Codex,
Cursor, Droid, OpenCode, Pi, and current Qwen use stdin for prompt text.
An inline `-p` always exposes the prompt in
codemux's own process arguments.

Agy passes the complete prompt as `--print=…`; file/stdin input does not hide
it from process inspection. Aider rejects prompts that invoke its command
language. Kimi refuses the word-bounded `/goal` command name and `!` shell-line
shapes as codemux policy. Other slash-leading paths remain model text.
Upstream Kimi 0.31.1 does not execute `!` as a headless shell command.
Use the [session reference](session-protocol.md) for session-specific input bounds.

## tui

`codemux tui -a claude` inherits the terminal and defaults to `read-only`.
Its full option set is the shared launch table, accounting options, and
Playwright option above. It has no prompt/file, timeout, result-JSON, hermetic,
tool-selection, or experiment-MCP option.

Droid TUI refuses model selection and ignores requested effort with a warning.
OpenCode TUI also ignores effort with a warning. Unsupported effort on other
harnesses is resolved through the capability map. Provider overrides can use
both environment and argv configuration: Claude also receives inline
`--settings` for its model picker. See [provider overrides](provider-overrides.md).

## check

`check` makes real model requests, uses credentials, and consumes quota.
The default prompt asks for OK. A failed check can still consume quota.
Hermetic checks compare planted customization channels with a positive control;
they do not prove that every possible customization channel is absent.

| Option | Default and meaning |
|---|---|
| `--timeout <seconds>` | 60 per probe; same positive/86400 bound and rounding as run |
| `--hermetic` | Off; paired checks in a managed directory; incompatible with `--cwd` |
| `--tools <selection>` | `default` or `none`, subject to harness restrictions |
| `--experiment-mcp <spec.json>` | Extend Claude's hermetic canary with the experiment bridge |
| `--agy-isolation-probe <mode>` | Diagnostic mode: `login`, `hermetic`, `control`, `tools`, `tools-control` |

Shared launch options apply, except accounting and Playwright. Paired or
multiple probes each receive the requested timeout, so aggregate runtime can
exceed it. Controls can fail or be inconclusive; see [testing](TESTING.md).

An accepted Agy diagnostic command is:

```sh
codemux check -a agy --agy-isolation-probe login --timeout 60
```

Agy diagnostics require default read-only scode and manage cwd and HOME.
They reject `--hermetic`, `--tools none`, `--experiment-mcp`, `--no-sandbox`,
non-read-only autonomy, `--cwd`, nonempty `--pass-env`, `--sandbox-trust`,
`--sandbox-no-net`, `--sandbox-scrub-env`, and `--effort`.
Agy hermetic/tools canaries have the same default policy restrictions,
without the diagnostic-mode option. Model and timeout selection remain available.

## session

`session` shares launch options and the Playwright option, but not accounting.
Its additional options and resume restrictions are defined once in the
[session guide](sessions.md#options).
The [protocol reference](session-protocol.md) defines JSONL input and output.
It supports Claude, Z.AI, Codex, Agy, OpenCode, Aider, and Kimi.
Hermetic mode and tool selection are refused for sessions.

## calls

| Option | Default and meaning |
|---|---|
| `-n, --limit <count>` | 20; integer 1–100000 |
| `-a, --agent <id>` | All agents |
| `--since <when>` | No cutoff; integer duration with s/m/h/d/w, or a date accepted by JavaScript Date |
| `--json` | Raw stored JSONL instead of a table |
| `--sum` | Append human-readable selected-record totals; with `--json`, output is mixed |

Use ISO timestamps with a timezone for portable date interpretation.
Records appear in reverse ledger append order, not start-timestamp order.
The [results and usage reference](results-and-usage.md#ledger-selection-and-totals)
defines filtering, summary selection, and interval limitations.

## usage

| Option | Default and meaning |
|---|---|
| `-a, --agent <agent>` | Query one agent |
| `--all` | Query all agents; default; incompatible with `--agent` |
| `--json` | Validated usagemux JSON |
| `--timeout <seconds>` | 30; finite, greater than zero, at most 300, rounded up to milliseconds |

The process deadline adds two seconds for shutdown. See
[subscription usage](results-and-usage.md#subscription-usage) for installation,
protocol compatibility, and unavailable results.

## Static information and diagnostics

| Command | Options and behavior |
|---|---|
| `list` | No command options; available adapters and capability labels |
| `autonomy` | No command options; per-harness autonomy mappings |
| `doctor` | No command options; installation, configuration, scode, optional usagemux status |
| `verify` | `-a, --agent <agent>`, `--show-scode`, `--sandbox-trust <level>`, `--sandbox-no-net`, `--sandbox-scrub-env` |

`verify` checks wiring without model requests. Sandbox policy flags are parsed
even without `--show-scode`; they affect previews when requested. These
commands may inspect local binaries or execute version/help paths.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Command succeeded; does not imply every optional harness is installed |
| 1 | Parser errors, many validation errors, configuration/I/O/launch or protocol failures |
| 64 | Explicit usage refusals, including invalid calls cutoff and unsupported session agents; not all parser errors |
| 66 | Requested resume identity not found |
| 69 | Optional usagemux unavailable |
| 78 | Session policy/trust refusal; registry access failure can instead be 1 |
| 124 | Captured run execution timeout; session timeout exits 1 |
| 125 | Captured output limit |
| 143 | Codemux-handled termination signal, including SIGINT and SIGTERM |

Child failures can preserve other nonzero child exit codes. Session fatal
errors, interrupted turns, and shutdown ordering have more specific rules in
the [protocol reference](session-protocol.md). Consult stderr for the cause;
do not classify every exit 1 as a harness failure.
