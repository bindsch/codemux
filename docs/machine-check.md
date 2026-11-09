---
read_when: "Checking whether this machine can run codemux and its harnesses, without spending quota."
---
# Machine check

`codemux doctor` answers one question without spending quota: does this
setup work, per harness? It is the check to run after installing, after an
upgrade, or whenever a launch refuses and the reason is not obvious. It never
certifies a release — that is the [live gate](RELEASE-GATE.md), which spends
quota. `make machine-check` runs the check twice, JSON first for tooling,
then the human table.

Without `--spend` the check makes no model requests and launches nothing
that spends. Every credential read is an existence check, a file mode, or an
expiry timestamp: a token value or account name never enters the output.

## What it checks

Environment rows, then one row per installed harness.

| Row | What it reports |
| --- | --- |
| codemux | The running version and runtime, and whether the runtime matches the pinned one the installed keg was built for. |
| config | Whether the configuration loads; the effective quota policy (ceiling, weekly warn, timeout) or the parser's message. |
| aliases | The model aliases: tiers that map no harness, or an alias whose tier names an unknown harness. |
| scode | Version, the global minimum, `--keep-env` support, and one sandboxed probe command — the same probe CI's scode contract runs, because only a sandboxed probe detects a scode that answers `--version` but cannot sandbox. |
| usagemux | `USAGEMUX-MISSING` (absent; optional), `USAGEMUX-UNREADABLE` (installed but its `--version` failed, printed no version, timed out, or failed the trust check; the detail names why), `USAGEMUX-STALE` (below the protocol minimum), or the installed version. An unreadable usagemux still counts as present: the usage rows query it and report their own unreadable verdict instead of "not installed". |
| keychain | macOS only: whether the credential Keychain item is readable. Informational elsewhere or when disabled. |
| codexbar | Whether a retired usage tool is still on PATH and should be removed in favor of usagemux. |

Each harness row runs the free checks a launch would run, in the same
order: binary trust, version contract, feature floors, the scode floor for
harnesses that need a newer sandbox, provider override validity, login
state, and the usage window behind the quota gate. The usage summary's
`week N% used` line names the weekly window with the quota gate's own rule:
a kind that names a week or a one-week span within an hour of provider
rounding, whatever the provider called the window. Binary trust runs even
when a harness has no version contract, so an untrusted or missing binary
never prints as `no contract`. The row's state is the
first broken candidate, else the first warn candidate, else `OK`; the row
also carries a remedy line naming the fix.

## Harness states

| State | Severity | Meaning |
| --- | --- | --- |
| `OK` | ok | Every free check passed. |
| `NOT-INSTALLED` | info | The harness binary is not on PATH. |
| `UNTRUSTED` | broken | The binary failed the same trust check a launch runs: not a regular file owned by the invoking user or root, group- or world-writable, or inside the working directory. |
| `VERSION-BELOW-MIN` | broken | Below the enforced contract minimum — or the version is unreadable on a harness whose contract refuses an unknown version. |
| `VERSION-ABOVE-CEILING` | warn | Newer than the audited ceiling. Usable; the ceiling says what this codemux verified. |
| `VERSION-UNREADABLE` | warn | The version probe returned nothing parseable (a timeout, a missing binary, or a spawn error names which). |
| `KNOWN-BREAK` | warn or broken | A recorded break removes enforcement at named autonomy levels. Broken unless the sandbox mitigates it and scode is present; a mitigated row says so and warns. |
| `FEATURE-FLOOR` | broken | A feature this codemux gates (hermetic runs, result JSON, sessions, experiment MCP) needs a newer harness than the installed one. |
| `NO-LOGIN` | broken | No credential store where the adapter looks for one — or a store the launch path refuses: a claude mirror without an access token, empty codex token strings, or a zai key file that is a symlink or owned by another user. |
| `LOGIN-EXPIRED` | broken | The stored credential is expired and the harness cannot renew it. Kimi's access token lives 15 minutes and kimi renews it from its refresh token on its next run, so a kimi store with a refresh token is `logged-in`; the row notes an aged-out access token. |
| `LOGIN-UNKNOWN` | warn | The adapter cannot tell (a mirror may be absent, or a config file ambiguous). |
| `QUOTA-LOW` | broken | The quota gate would refuse the launch: the usage window is below the ceiling. |
| `QUOTA-UNREADABLE` | warn | The usage window could not be read; the gate warns and proceeds. |
| `SANDBOX-TOO-OLD` | broken | scode is older than this harness's floor (or the global minimum). |
| `SANDBOX-MISSING` | broken | scode is not installed, or the binary is untrusted. |
| `OVERRIDE-INVALID` | broken | A provider override names the harness but is malformed (a variable missing or empty). |
| `PROBE-FAILED` | broken | A free probe itself failed (the scode sandboxed command, on the environment row). |

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Healthy: no broken rows (and no warnings, with `--strict`). |
| 1 | At least one broken row — or, with `--strict`, at least one warning. |
| 2 | The configuration is invalid; the check still prints everything it could. |

Mistakes in the options below are caller errors and exit 64, like every
command.

## Options

- `--only <agents>` / `--skip <agents>`: narrow the harness set,
  comma-separated.
- `--timeout <seconds>`: the per-probe bound for one version verdict,
  0.001 to 60 with at most three decimals (whole milliseconds), default 10.
- `--strict`: warnings count as broken for the exit code.
- `--capabilities`: print only the per-harness capabilities block.
- `--format <format>`: `text` (default) or `json`.

## JSON output

`--format json` prints schema `codemux-doctor-1`:

```json
{
  "schema": "codemux-doctor-1",
  "codemux": { "version": "…" },
  "environment": { "config": { "state": "…", "severity": "…", "detail": "…", "remedy": null }, "…": {} },
  "harnesses": [{ "id": "…", "installed": true, "state": "…", "severity": "…", "checks": {}, "remedy": null, "detail": [] }],
  "summary": { "ok": 0, "warn": 0, "broken": 0, "notInstalled": 0 },
  "exitCode": 0
}
```

Every environment and harness row carries `state`, `severity`, `detail`,
and `remedy`; `remedy` is null when the row needs no action. The `exitCode`
field is the code the command exits with, so tooling can compare without
re-deriving the rule.

## The paid stage

`--spend` adds one real `codemux check` request per eligible harness — the
harnesses whose free row is clean enough to try. Each request carries the
label `machine-check=<stamp>` (the run's start as `YYYY-MM-DDTHHMMSS.sssZ`, then
the process id and a per-process counter, so two checks that start in the
same millisecond still get their own values; one value per run). The stamp
is not predictable, so each row's JSON `spend` detail names the label its
probe carried, and `codemux calls --label machine-check=<that stamp> --sum`
reports exactly what the stage spent (a bare `machine-check=<date>` matches
nothing: the label value is the whole stamp); `--spend-cap <n>` bounds the
number of probes and `--spend-unreadable` extends the stage to harnesses
whose usage row is unreadable. `make machine-check` never passes `--spend`:
the target stays free. Run the paid stage deliberately, when a free row
passes but the harness still refuses real work.
