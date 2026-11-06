---
read_when: "Checking a command, option, exit code, or output schema."
---
# CLI reference

Every command accepts `-h, --help`. Root `-V, --version` reads the package
version. Options below are parsed by codemux; unknown options and missing
option arguments are parser errors (exit 1, or 64 for a missing `--label` or `--by`
argument). An option given on the command line with an empty value —
`--model ""`, typically an unset shell variable — is present, not absent:
it is refused with exit 64 instead of silently falling back to the option's
default. Environment variables and config files keep their own convention,
where a blank value means unset. On run, tui, check, and session every
request check runs before the harness and scode are looked up, so a usage
error exits 64 even when the harness is not installed. There is no generic pass-through
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
| `--effort <level>` | Unset; `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, `ultra`; mapped only where supported. `none` always means "send no effort flag": on a harness without a native `none` the launch carries no effort flag, on run, tui, check, and session alike |
| `-s, --sandbox` | Enabled; requires compatible scode |
| `--no-sandbox` | Disable scode; requires `--auto high` |
| `--sandbox-trust <level>` | Policy default; `trusted`, `standard`, `untrusted`; sandboxed sessions refuse `untrusted` |
| `--sandbox-no-net` | Off; deny networking through scode |
| `--sandbox-scrub-env` | Off; request scode environment scrubbing |
| `--pass-env <names>` | Empty; comma-separated environment variable names, at most 64 |
| `--cwd <path>` | Current directory; must resolve to an accessible directory; check canaries manage their own directory |
| `--quota-ceiling <percent>` | Config `quota.minRemainingPercent`, initially 10; refuse the launch when a bounding usage window is below this percent remaining; 0–100 |
| `--no-quota-gate` | Skip the pre-launch usagemux quota check for this invocation |

Before anything spawns, `run`, `tui`, `check`, and `session` pass the
[quota gate](results-and-usage.md#quota-gate): one usagemux query about the
client the selected agent spends from (its own account, or the client named
by `quota.spendsFrom`), refusing at exit 64 when the primary usage window —
or a week-long tier window — is below the ceiling. An absent, untrusted,
slow, or stale usagemux warns and proceeds. A
validated provider override in force for the agent (with a base URL, on a
harness that carries overrides) routes the spend off the native account, so
the gate skips it and prints one stderr line instead.

`--sandbox-account <file>` and `--sandbox-account-id <id>` are available on
`run` and `tui`, not `session` or `check`. They append scode scratch-accounting
JSON with an optional correlation token. The file must be absolute. The ID
requires the file option and matches `[A-Za-z0-9._:-]{1,128}`.
`--sandbox-block <path>` (repeatable, absolute paths only) is available on
`run` and `session`; it passes extra scode `--block` paths through to the
sandbox, an operator-side extra on top of the blocks codemux attaches itself
under `--experiment-project-settings`. Block paths are canonicalized once
when the flags are parsed (symlinks dereferenced where they resolve, the
missing tail kept literal, then deduplicated and sorted), and that
canonical spelling is what every sandboxed child enforces and what a session
records, so a symlink retargeted later cannot change which tree a block
names. `--print-sandbox` is available on
`run` and `session`: it runs the version preflights (not the quota gate: a
print spends nothing), then prints the scode argv the launch would exec and
exits 0 without starting the harness run or recording anything. The version preflight is the harness's
`--version`; for the opted-in Cursor desktop entry (`CODEMUX_CURSOR_ENTRY=cursor`,
which the operator must pass through on purpose) that probe is `cursor agent
--version`, which can install or update `cursor-agent`, as its opt-in
documents. Each argument prints on its own line with
control characters escaped (a newline inside an argument, such as a
multi-line `-p` prompt, prints as `\n`), so one argument can never read as
several. The private config directory is created and removed. The adapter prepares only the paths the argv names: no credential is read or written (agy creates no private Keychain, reads no login, and repairs no search list). It
requires `--sandbox` and is refused (exit 64) together with
`--experiment-mcp`: the MCP relay is minted at start, so its argv cannot be
shown without starting it. The credential sandbox preparation
(`prepareSandbox`, which refreshes the claude credential mirror) is
skipped, and the per-run credential copy into the private config directory
is deferred: the command is print only, never reads the credential mirror,
and writes nothing into the private directory it creates and removes.
After validation, sandbox policy/accounting options with `--no-sandbox` are
warned about and ignored. See
[policy details](autonomy-and-sandboxing.md).

`--enable-playwright-mcp` is available on `run`, `tui`, and `session`.
It requires Claude or Z.AI and sandboxing; sessions also require `--auto low`.
It is incompatible with `--hermetic` and `--tools none`; the sessions spelling
of hermetic isolation, `--hermetic --experiment-project-settings`, is refused
the same way. The locally installed
`playwright-mcp` must pass executable trust checks, revalidated immediately
before the spawn; codemux cannot control the moment Claude starts the server
after that, so a swap in the later window is the sandbox's to contain. Codemux does not download
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
| `--experiment-project-settings` | Off; run `claude`/`zai` in a private per-run Claude config directory with `--setting-sources project,local`, or `opencode` without `OPENCODE_DISABLE_PROJECT_CONFIG` and `--pure`, so a fixture repository's own permission rules and plugins apply without the operator's user-level customizations. Requires `--hermetic` and scode; `--auto low` on `claude`/`zai`, `--auto low` or `high` on `opencode`. Refused when any ancestor of the working directory carries a project memory file (`claude`/`zai`: `CLAUDE.md`, `CLAUDE.local.md`, `.claude/CLAUDE.md`, `.claude/rules`; `opencode`: `opencode.json`, `opencode.jsonc`, `.opencode`, `AGENTS.md`, `CLAUDE.md`, `CONTEXT.md`) — a home directory normally does. See [isolation](isolation.md) |
| `--no-web` | Off; deny the Claude-family web tools (`WebSearch`, `WebFetch`) with a deny rule, which holds at `--auto high` and over approvals saved in the operator's settings; headless `claude` and `zai` otherwise grant them at every autonomy level, and other agents refuse the flag |
| `--experiment-mcp <spec.json>` | Unset; experiment MCP server for `claude`, `zai`, `codex`, or `kimi`; requires hermetic mode, tools none, and read-only scode |
| `--label <KEY=VALUE>` | Repeatable; metadata stored with the run; otherwise read `CODEMUX_LABELS` |
| `--result-json` | Off; structured result with harness-specific normalization |

Claude and Z.AI headless `--auto medium` runs use `--permission-mode acceptEdits`
with `--allowedTools Edit(//<launch dir>/**) Bash WebSearch WebFetch`. Shell
commands run inside the required scode sandbox. Persistent sessions retain
their per-tool ceiling callback and receive no medium `Bash` grant. Gemini
medium uses `--approval-mode yolo`. Qwen medium keeps `--approval-mode auto`,
which can approve shell commands headless after classifier review. Every
harness requires scode at medium. See
[medium shell execution](autonomy-and-sandboxing.md#medium-shell-execution)
for native mappings.

Timeouts must be finite and greater than zero, at most 86400 seconds.
Fractional seconds are accepted and rounded up to milliseconds. The timeout
is not an end-to-end wall-clock cap: input collection, execution, setup, and
shutdown are distinct phases.

See [isolation](isolation.md), [experiment MCP](experiment-mcp.md), and
[results](results-and-usage.md) for these contracts.

Kimi supports both `--hermetic` and `--result-json`. Hermetic runs reject project instruction/configuration paths and `--pass-env KIMI_CODE_HOME`. Result-json returns assistant text, parsed stream events, the native session ID, and wire-log usage. See [isolation](isolation.md) and [results](results-and-usage.md).

### Labels

Use labels to identify a workflow or step in the call ledger and
`--result-json` output:

```sh
codemux run -a codex -f prompt.md --label wf=review --label step=scan
```

Each key must match `^[a-z][a-z0-9_.-]{0,63}$`. A value may be empty or
contain `=`, but must fit in 256 UTF-8 bytes and contain no characters in
U+0000–U+001F or U+007F–U+009F. Missing `=`, empty keys, duplicate keys, and other
invalid labels fail with exit 64.

With no `--label` flags, `run` reads comma-separated pairs from
`CODEMUX_LABELS`, such as `CODEMUX_LABELS='wf=review,step=scan'`. Any
`--label` flag ignores that variable entirely. A wrapper can set the variable
to label nested `codemux run` calls. Use flags for values containing commas.
`session`, `tui`, and `check` do not accept labels.

Labels are stored as plain text under the state directory or the configured
ledger path. Never put prompt text, secrets, or anything the ledger should
not retain in a label. See [the ledger fields](results-and-usage.md#call-ledger).

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

Signals end a tui run the way the exit-code table promises. After SIGTERM or
SIGHUP the exit is 143 whatever the child itself exited with, so a harness
that answers the forwarded SIGTERM with 0 still reads as terminated, not as
success. SIGINT is never forwarded: a terminal Ctrl-C reaches the foreground
child through the shared process group on its own, and a second interrupt
makes several harnesses quit. A SIGINT sent to codemux alone (`kill -INT` on
its pid) therefore does not stop the child; stop a tui from outside with
SIGTERM or SIGHUP. Three SIGINTs within a second still force the child's
SIGTERM-then-SIGKILL termination.

Droid and OpenCode TUI refuse `--effort` with a level (exit 64): the interactive
entry has no effort carrier; `--effort none` (no flag) and `run` remain. On every
other harness, tui resolves effort exactly as run does, so a value outside the
adapter's set refuses with exit 64 instead of a warning. Provider overrides can
use both environment and argv configuration: Claude also receives inline
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
| `--experiment-mcp <spec.json>` | Extend the `claude`, `zai`, or `kimi` hermetic canary with an experiment MCP server; `codex` paired checks are unsupported |
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
Tool selection is refused for sessions, and so is a plain `--hermetic`; the
one hermetic session mode is `--hermetic --experiment-project-settings`
(Claude/Z.AI), which runs the session in a private per-session Claude config
directory with the repository's own settings — see
[isolation](isolation.md) and
[hermetic project-settings sessions](sessions.md#hermetic-project-settings-sessions).
Sessions also take `--permission-policy <policy>` (`default`, or `deny` to
answer every permission request with an immediate deny) and `--final`
(remove that session's private config directory when it ends).

## calls

| Option | Default and meaning |
|---|---|
| `-n, --limit <count>` | 20; integer 1–100000; bounds the listing only, never the totals |
| `-a, --agent <id>` | All agents |
| `--since <when>` | No cutoff; integer duration with s/m/h/d/w, or a date accepted by JavaScript Date |
| `--label <KEY=VALUE>` | Repeatable; retain records matching every supplied key and value |
| `--json` | Stored JSONL instead of a table; DEL and C1 characters are escaped |
| `--sum` | Append human-readable totals over every matching record in the whole ledger; with `--json`, output is mixed |
| `--by <KEY>` | Group totals by this label's value; requires `--sum`; missing labels use `Totals for records without label KEY` |

Use ISO timestamps with a timezone for portable date interpretation.
Records appear in reverse ledger append order, not start-timestamp order.
The command streams the whole ledger: filters, the `--since` window, and
the `--sum` totals see every record. Retained memory is proportional to
`-n` and to the number of distinct sessions, never to the ledger's
length: a ring of `-n` records for the listing (raw lines only under
`--json`), one closing record per session for the totals, and — under
`--since` — one session key per session with an in-window turn. A session
is keyed by its agent and session id together (review round 127), so
records of two agents never share a session however their ids collide; an
empty session id keys nothing, so a recent empty-id turn selects no old
closings.
A token total that would leave the safe-integer range prints `unknown`;
so does a cost total that would leave the finite range, on the totals line
and on the harness-estimate line.
Label
filters use the [label syntax](#labels) above;
`calls` does not read
`CODEMUX_LABELS`. Invalid filters or grouping keys fail with exit 64.
The [results and usage reference](results-and-usage.md#ledger-selection-and-totals)
defines filtering, summary selection, and interval limitations.

## usage

| Option | Default and meaning |
|---|---|
| `-a, --agent <agent>` | Query one agent |
| `--all` | Query all agents, agy included; incompatible with `--agent`. Without `-a` or `--all` the query covers every agent except agy, whose probe can take up to 90 seconds |
| `--json` | Validated usagemux JSON; DEL and C1 characters are escaped, as in `calls --json` |
| `--timeout <seconds>` | 30; finite, greater than zero, at most 300, rounded up to milliseconds; fractional values forward as decimal seconds |

The process deadline adds five seconds of shutdown grace. A parsed snapshot
exits 0; a usagemux that exits nonzero is an unreadable query and exits 1
whatever its stdout held; 69 is reserved for usagemux being
absent or untrusted. See
[subscription usage](results-and-usage.md#subscription-usage) for installation,
protocol compatibility, and unavailable results.

## Static information and diagnostics

| Command | Options and behavior |
|---|---|
| `list` | `--json` prints the same facts machine-readable (schema `codemux-list-1`: each agent's id, availability, binary name, and the `hermetic`, `resultJson`, `toolsNoneRequiresHermetic`, `toolsNoneRequiresReadOnly`, `isolationRequiresReadOnly`, `providerOverride`, `sessions`, `model`, and `effort` capability booleans, `effortLevels` (the accepted values, or null), plus `experimentMcp`, `experimentPrefix`, and `servedModelEvidence`); without it, available adapters and capability labels (`model`, `autonomy`, `effort`, `hermetic`, `tools`, `provider`, `result-json`, `sessions`). A label carries the condition the adapter enforces: `tools(read-only)` (codex, agy: `--tools none` needs `--auto read-only`), `tools(hermetic)` (OpenCode: `--tools none` on hermetic runs only), `hermetic(read-only)` (agy: read-only scode and a clean `--cwd`) |
| `autonomy` | No command options; per-harness autonomy mappings |
| `doctor` | `--format <format>` (`text`, the default, or `json`, schema `codemux-doctor-1`), `--only <agents>`/`--skip <agents>` (narrow the harness set, comma-separated), `--timeout <seconds>` (per-probe bound for one version verdict, default 10; a number of seconds from 0.001 to 60 with at most three decimals, whole milliseconds from 1 to 60000), `--strict` (warnings count as broken for the exit code), `--capabilities` (print only the per-harness capabilities block, the pre-2.0 output), and the paid stage `--spend`, `--spend-cap <n>` (at most n spend probes, default one per eligible harness), `--spend-unreadable` (spend on harnesses whose usage row is unreadable too; each spend probe is one real `codemux check` request labeled `machine-check=<date>`). Without `--spend` it makes no model requests: installation, configuration, scode, optional usagemux status. Per installed harness it also prints the capability rows and a version-contract verdict: `ok`, `above audited ceiling` (newer than this codemux audited), `below minimum` (older than this codemux enforces), `known break at <levels> autonomy from <version> (sandbox mitigates or no mitigation)` (a recorded contract break names the autonomy levels it affects), `no contract` (no version contract exists for that harness), `untrusted binary (<reason>)` (the probe refused to run a binary that fails the same trust check as a launch: not a regular file owned by the invoking user or by root, group- or world-writable, or inside the working directory), `unreadable` (the version probe returned nothing parseable), or `unreadable (timed out)` (the probe exceeded its 10 s bound), `unreadable (binary not found)`, or `unreadable (<reason>)` (the probe failed before producing output: a spawn error with its cause). Version probes run in parallel |
| `verify` | `-a, --agent <agent>`, `--show-scode`, `--sandbox-trust <level>`, `--sandbox-no-net`, `--sandbox-scrub-env` |

`verify` checks wiring without model requests. Sandbox policy flags are parsed
even without `--show-scode`; they affect previews when requested. These
commands may inspect local binaries or execute version/help paths.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Command succeeded; does not imply every optional harness is installed |
| 1 | Parser errors, configuration/I/O/launch or protocol failures, and runtime errors |
| 64 | Every pre-launch refusal of a caller mistake, with the same code on run, tui, check, session, calls, usage, and verify: unknown agent (also the unknown `--agent` of calls/usage and `--agent` combined with `--all`); a request the named agent cannot carry (model, effort, autonomy without sandbox, hermetic, tools, result JSON, provider override, --experiment-project-settings); prompt refusals ("No prompt provided. Use -p or -f", an unreadable or empty -f file, a malformed, empty, oversized, or terminal -f - read); sandbox policy option rules ("--sandbox-block requires absolute paths", "--sandbox-account requires an absolute path", "--sandbox-account-id without --sandbox-account"); capability and combination refusals ("--enable-playwright-mcp requires --sandbox", "--no-web applies to the claude and zai agents only"); "--print-sandbox requires --sandbox"; bad option values (--timeout, --pass-env, --auto, --effort, --tools, --sandbox-trust, an invalid `-m/--model` name, an inaccessible `--cwd`, an explicitly empty value given to any option above); project-execution configuration refusals (a forbidden harness execution knob in the project tree) and the codex multi-agent knob's on/off rule; invalid labels, calls cutoff/grouping, quota-gate refusals, and unsupported session agents. Parser errors stay exit 1. |
| 66 | Requested resume identity not found |
| 69 | Optional usagemux absent or untrusted; a usagemux that exits nonzero is an unreadable query and exits 1 |
| 78 | Session policy/trust refusal; registry access failure can instead be 1 |
| 124 | Captured run execution timeout; session timeout exits 1 |
| 125 | Captured output limit |
| 143 | Codemux-handled termination signal, including SIGINT and SIGTERM |

Child failures can preserve other nonzero child exit codes. Session fatal
errors, interrupted turns, and shutdown ordering have more specific rules in
the [protocol reference](session-protocol.md). Consult stderr for the cause;
do not classify every exit 1 as a harness failure.
