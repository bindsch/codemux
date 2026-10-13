# codemux

One CLI for AI coding agents. Run a prompt, start an interactive harness, or
exchange JSONL messages with a resumable session. Codemux normalizes launch
options, autonomy, results, and reported usage.

## Install

Normal execution uses the scode sandbox by default. Install scode and an
authenticated harness before running a prompt. Homebrew installs scode and Bun
as dependencies:

```sh
brew install bindsch/tap/codemux
codemux doctor
```

The maintained bottle targets Apple Silicon macOS (the formula's
`arm64_golden_gate` platform). For a source installation on macOS or Linux:

```sh
git clone https://github.com/bindsch/codemux.git
cd codemux
bun install --frozen-lockfile
bun link
```

Source installs require Bun 1.3.14 or newer and
[scode](https://github.com/bindsch/scode). See the
[installation guide](https://github.com/bindsch/codemux/blob/main/docs/installation.md)
for platform requirements and upgrades.

## First run

With Claude Code installed and authenticated:

```sh
codemux run -a claude -p "Reply with OK."
codemux run -a claude -f prompt.md --result-json
```

The default autonomy is `read-only`. Use `--auto low`, `medium`, or `high`
when the task needs more access. `--no-sandbox` requires `--auto high`.

## First session

A session reads JSONL requests on stdin and writes JSONL events to stdout.
EOF drains accepted work and closes the session:

```sh
printf '%s\n' '{"type":"user","text":"Reply with OK."}' |
  codemux session -a claude --shutdown-grace 120
```

This example allows 120 seconds to drain the prompt after EOF. Clients that
need longer should keep stdin open until `turn_completed`, then send shutdown.
Save the `session_id` from `session_started`. Resume it with
`codemux session -a claude --resume <session-id>`. See the
[session guide](https://github.com/bindsch/codemux/blob/main/docs/sessions.md)
for explicit shutdown and resume examples, and the
[protocol reference](https://github.com/bindsch/codemux/blob/main/docs/session-protocol.md)
for complete event schemas.

## Commands

| Command | Purpose |
|---|---|
| `run` | One non-interactive prompt |
| `tui` | Interactive harness |
| `session` | Multi-turn JSONL protocol |
| `check` | Real model probes; consumes provider quota |
| `calls` | Local call ledger and selected-record totals |
| `usage` | Optional subscription reporting through usagemux |
| `list`, `doctor` | Installed harnesses, diagnostics, and alias names |
| `autonomy`, `verify` | Policy mappings and static wiring checks |

Every command accepts `--help`. The
[CLI reference](https://github.com/bindsch/codemux/blob/main/docs/cli.md)
lists options, defaults, incompatibilities, and exit codes.

## Essential limits

- Hermetic mode suppresses specified automatic customization loading. It does
  not make a result reproducible from a prompt alone. See
  [isolation and persistence](https://github.com/bindsch/codemux/blob/main/docs/isolation.md).
- Some adapters place the prompt in process arguments, including Agy even when
  input comes from a file or stdin. See
  [prompt transport](https://github.com/bindsch/codemux/blob/main/docs/cli.md#prompt-input).
- A run's null codemux session ID is not a guarantee that the upstream harness
  retained no state. Resume requires a trustworthy registry entry and usable
  harness state.
- Usage fields can be unknown. Filtered ledger totals describe selected records;
  they are not necessarily usage incurred during the selected interval. See
  [results and usage](https://github.com/bindsch/codemux/blob/main/docs/results-and-usage.md).

## Documentation

The [documentation index](https://github.com/bindsch/codemux/blob/main/docs/index.md)
separates current guides, references, contributor instructions, and dated
historical reports. Start with
[harness compatibility](https://github.com/bindsch/codemux/blob/main/docs/harnesses.md),
[configuration](https://github.com/bindsch/codemux/blob/main/docs/configuration.md),
or [authentication](https://github.com/bindsch/codemux/blob/main/docs/authentication.md).

In a checkout, the same pages are under `docs/`. Homebrew keeps them under
`$(brew --prefix codemux)/libexec/docs/`. README links use repository URLs so
they also work when Homebrew installs README above `libexec`.

Read [contributing instructions](https://github.com/bindsch/codemux/blob/main/CONTRIBUTING.md)
before submitting changes. Report vulnerabilities through the
[security policy](https://github.com/bindsch/codemux/blob/main/SECURITY.md).

Licensed under [MIT](https://github.com/bindsch/codemux/blob/main/LICENSE).
