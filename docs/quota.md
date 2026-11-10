---
read_when: "Checking subscription usage, quota windows, or why a launch was refused or warned about quota."
---
# Quota and subscription usage

## Subscription usage

Install the standalone [usagemux tool](https://github.com/bindsch/usagemux#install)
to use `codemux usage`. This is separate from the local call ledger.
The [CLI reference](cli.md#usage) lists all options and timeouts.

Codemux invokes `usagemux snapshot --format json`, validates schemaVersion
`"1"`, and requires exactly one result for every requested client.
Unknown schema versions, missing/duplicate/unrequested clients, invalid
fields, or oversized output fail. Results report quota windows, credits,
account/plan information, and subscription timestamps when available.
A window may carry usagemux 1.0.1's `placeholder` boolean: true marks a
window upstream reports as a placeholder, whose percentages are both null;
false says nothing more than that, and such a window may still lack a
percentage. The quota gate judges only the windows that report a remaining
percentage.
`usage --json` prints the field when usagemux sent it.
Usagemux owns credential lookup, provider compatibility, and caching.

The executable must pass codemux's trust checks. A missing or untrusted
installation exits 69 without affecting other commands; a usagemux that
exits nonzero is an unreadable query and exits 1 whatever its stdout held. A provider query can read credential
stores and contact billing/usage APIs, but sends no model prompt. Usagemux must
support the requested agents; an older version lacking newer agents can make
an all-agent query fail. Use `-a` for a supported client or upgrade.

With no `-a`, `codemux usage` queries every agent except agy, mirroring
usagemux's own default client set: agy's probe can take up to 90 seconds, and
a bare `codemux usage` stays fast. `-a agy` and `--all` include it. The full
invocation codemux makes is one usagemux call per command:

```
usagemux snapshot --client <agent> [--client <agent> ...] --format json --timeout <seconds>
```

## Quota gate

`run`, `check`, `tui`, and `session` ask usagemux about the one agent a
launch will spend from and refuse (exit 64) when a bounding usage window is
below the configured ceiling. The check runs after request validation (the
experiment and agy canary checks build their own request and validate it
after the gate) and before anything spawns, so a refused launch spends
nothing and records
nothing in the call ledger. It uses the same trust checks as
`codemux usage`.

The `quota` config key carries the policy; an absent key means the defaults.
`quota: false` disables the gate globally. Per invocation, `--no-quota-gate`
skips it and `--quota-ceiling <percent>` overrides the ceiling for that one
launch. See [configuration.md](configuration.md).

| Setting | Default | Meaning |
|---|---|---|
| `minRemainingPercent` | 10 | Refuse when a bounding window has less than this percent remaining |
| `weeklyWarnUsedPercent` | 50 | Warn (stderr) when a weekly window is more than this percent used. A window counts as weekly when its kind names a week or its span is one week (10 080 minutes) within an hour of provider rounding; a longer window, such as a monthly cap, never triggers this warning |
| `timeoutSeconds` | 60 | Per-launch bound on the usagemux query. One number applies to every agent; a per-agent map `{default: 60, claude: 90}` keys by agent ID with `default` required |
| `spendsFrom` | none | Maps an agent to the usagemux client its launches spend from, for agents whose account is another provider's subscription (an opencode install on Claude credentials: `spendsFrom: { opencode: claude }`). The gate asks usagemux about the mapped client and names it in messages |

Decision table, per launch:

| usagemux answer | Gate action |
|---|---|
| Not installed, or untrusted | Warn once on stderr, proceed |
| Query timeout, unparseable output, a snapshot older than 10 minutes, or no result for the agent | Warn on stderr with the reason, proceed |
| A snapshot dated in the future, beyond the 60-second clock tolerance | Warn on stderr with the reason, proceed |
| Status `not-applicable` | Print one stderr line — the agent's usage is not measured; it spends from its configured provider — and proceed |
| Status `error` or `unavailable` | Warn on stderr with the provider's message, proceed: an unreadable provider is not an exhausted one |
| Status `ok`, but no window that bounds model calls reports a remaining percent | Warn on stderr, proceed |
| Status `ok`, the result reports credits with zero or fewer remaining | Warn on stderr (`credits exhausted (0 credits left); proceeding`), whatever the windows say |
| Status `ok`, the `primary` window below the ceiling, or a `secondary`/`tertiary` window whose span is one week below the ceiling | Refuse, naming the window kind, percent left, reset time, and ceiling |
| Status `ok`, another bounding window below the ceiling (a third-party model pool, a model-tier pool, a window that names weekly but is not a week long) | Warn on stderr, naming it and `(not the primary window)`, proceed |
| Status `ok`, a weekly window more than `weeklyWarnUsedPercent` used | Warn on stderr, proceed |
| An invalid `quota:` block in the config | Config error at load, exit 1 (before any launch, like every other config key) |
| A policy that reaches the gate and fails its own launch-time validation (a timeout the process runner refuses) | Refuse, exit 64 |
| A validated provider override with a base URL in force for the agent, on a harness that carries overrides | Skip the native gate, print one stderr line naming the override host |

Windows whose kind matches `mcp` (per-window MCP budgets) never gate: an
MCP tool budget does not bound model calls. A `scoped` window does gate:
it is a real pool, and it warns below the ceiling like any window that is
not the primary one. A fetched snapshot
is reused for 60 seconds inside one process, so a batch or a resumed session
does not pay the usagemux query per launch.

The gate is fail-open for an unreadable snapshot by design: an interactive
launch must not hang or die on a slow provider query, and a provider whose
usage cannot be read (a usage backend that answers too late, a provider that
needs browser cookies the machine lacks) is not one whose quota is spent.
Only the usagemux-side failures above fail open; an error from codemux's own
validation — a `timeoutSeconds` the process runner refuses — means the gate
itself is misconfigured and the launch is refused instead. A refusal needs
the `primary` window (every provider's main pool) or a `secondary`/
`tertiary` window whose span is one week: those bound every call the launch
can make. Window names never decide a refusal, because providers name the
same pool differently — a weekly-named third-party pool (cursor's
third-party model usage, agy's antigravity pools) warns, and a week-long
tier window refuses whatever the provider calls it. Reset times in refusal
and warning messages print in local time with a relative span —
`2026-11-07 09:00:00 (in 2 d 3 h)` — so no operator converts a raw UTC
timestamp by hand. Batch callers get the
strict fail-closed behavior from cmx (codemux-workflows), which keeps its own
policy and pauses on a quota refusal instead of proceeding.
