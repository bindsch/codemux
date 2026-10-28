# Results and usage

## Run results

`run` normally prints the reply on stdout and diagnostics on stderr.
`--result-json` requests a structured result with harness-specific
normalization. Claude/Z.AI retain their JSON envelope. Agy normally uses
`--output-format=json`; its isolation/probe paths use
`--output-format=stream-json` and normalize the terminal result.
Codex JSONL is reduced into a codemux-built envelope.

The codemux-owned block contains:

```json
{
  "agent": "codex",
  "model": "gpt-5.3-codex",
  "labels": {
    "wf": "review",
    "step": "scan"
  },
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

It appears under `codemux` in the envelope. Experiment runs also include
`codemux.recording`. Model is the served model when reported, otherwise the
selected model, otherwise null. A reported multi-model result has null model.
Codex reroute events can identify the served model and produce a stderr note.
`codemux.labels` contains the run's labels, or null when none are supplied.
See [label syntax and environment defaults](cli.md#labels).
Unsupported structured-result adapters refuse `--result-json`; capability
support is listed in [harnesses](harnesses.md).

Run `session_id` is always null: codemux does not register a run for resume.
Claude/Z.AI request `--no-session-persistence`; Codex requests `--ephemeral`.
Other harnesses can retain native state. A null field is not a promise that no
upstream conversation state survives. See [persistence](isolation.md).

Plain launches also select structured output for Claude/Z.AI, Agy, OpenCode,
and Codex, then unwrap the reply. OpenCode trims each text part onto its own
line. Codex preserves the final assistant message and appends one newline,
as its human-mode printer does. Other adapters currently collect plain text
or their adapter-specific transcript without extracting structured usage;
this describes codemux's selected path, not all upstream CLI capabilities.

## Failure and output limits

Captured output is bounded at 16 MiB. The streaming Codex and OpenCode
reducers have separate limits for an individual input line and retained
reply/output data. Stderr remains bounded too. A line is checked while it
accumulates and when it completes, including an unterminated final line.
Exceeding a capture limit fails with exit 125 and a stderr diagnostic.

Discarded tool events do not accumulate against retained-output capacity.
They can still exceed the individual-line limit. For example, many 1 KiB
tool events can be discarded without filling the reply buffer, but a single
40 MiB tool event fails. A long reply or stderr stream can also fail.
Codemux does not retain discarded OpenCode tool inputs or outputs.

Codex plain mode chooses the stream regime from the first nonempty line.
`thread.started` commits to structured parsing; otherwise the output remains
plain text. Later text that resembles event JSON cannot change that choice.
Within the structured regime, malformed events and failures invalidate the
turn and its usage. A valid completed reply survives a later nonzero child
exit, but the run still fails and records unknown usage.

Codex's Plan-only completion can require its `--output-last-message` file.
The fallback is consulted only for a completed turn with no assistant message,
never after protocol failure. A named missing/unreadable file fails.
An empty readable file represents a message-free completion. Non-hermetic
untrusted sandbox runs cannot write that fallback file and do not request it.

OpenCode malformed/truncated streams retain text and usage folded before the
error, with a diagnostic. Claude-family/Agy JSON that is not a valid result
fails instead of becoming plain reply text. Output that never uses the
requested structured grammar can pass through as plain text without usage.
The Codex fallback can recover a blended `tokens used` stderr total only.
Result errors fail even when the child exited zero. Empty structured replies
fail; Codex plain-mode completed empty/message-free replies retain the
upstream success behavior.

## Usage fields

Every usage object has five nullable numeric fields. Null means unreported,
never zero. Reported zero remains zero.

| Field | Meaning |
|---|---|
| `input_tokens` | Input not served from cache |
| `cached_input_tokens` | Cache reads and, where reported, cache writes |
| `output_tokens` | Reported output tokens |
| `total_tokens` | Sum only when all components are known, or an explicitly reported total |
| `cost_usd` | Reported dollar cost; never estimated from token prices |

| Harness | Run usage | Session usage |
|---|---|---|
| Claude/Z.AI | Input/output/cache, computed total, reported cost | Turn token counts; closing tokens accumulate within this driver invocation; closing cost adopts the latest reported session-lifetime cost |
| Codex | Structured token snapshot, no cost; plain fallback total only | Reported turn tokens and driver-invocation accumulation; no cost |
| Agy | Input/output/cache-read counts, computed total; no cost | Turn counts and driver-invocation accumulation; no cost |
| OpenCode | Sum of step usage and reported step costs | Steps summed per turn, turns summed within the driver invocation |
| Aider/Kimi | Unknown | Unknown |
| Other adapters | Unknown | Sessions unsupported |

A resumed driver starts token counters empty. If the first invocation reports
100 input tokens and the resumed invocation reports 20, the new closing record
reports 20, not 120. Claude/Z.AI cost is different: a reported lifetime cost
is adopted, not added to prior results. Turn cost is null for these agents.
OpenCode cost sums the steps in the current invocation.

## Call ledger

The append-only ledger is `calls.jsonl` under
`~/Library/Application Support/codemux/` on macOS or
`~/.local/state/codemux/` elsewhere. It is derived from HOME, not XDG_STATE_HOME.
`CODEMUX_CALL_LOG=<path>` relocates it (relative paths use cwd);
`CODEMUX_CALL_LOG=off` disables it.

Each record contains:

| Field | Shape |
|---|---|
| `ts` | Start time as an ISO string |
| `kind` | `run`, `check`, `session_turn`, or closing `session` |
| `agent`, `provider`, `cwd` | Strings; provider is `default` or override URL host, never its key |
| `model`, `model_effective` | Requested and reported model, each string or null |
| `session_id`, `turn_id` | Strings or null; turns identify their session |
| `autonomy` | Autonomy string or null |
| `labels` | String-keyed object of string values, or null |
| `hermetic`, `sandboxed` | Booleans |
| `exit_code` | Number or null (turns use finish instead) |
| `finish` | End/turn reason string or null |
| `duration_ms` | Nonnegative elapsed time from the record's start |
| `usage` | The five-field object above |

Every new record includes `labels`. A labeled run stores its key/value pairs;
an unlabeled run, check, session turn, or closing session stores null.
Older records without the field are treated as unlabeled.

Codemux does not automatically record prompt text, API keys, or environment
values. Labels are caller-supplied plain text and are retained in the ledger.
Never put prompt text, secrets, or anything the ledger should not retain in
a label. `CODEMUX_LABELS` supplies labels for runs only when no `--label`
flag is present; explicit flags ignore that variable entirely.
Harness-reported model/provider/finish strings have terminal controls stripped.
Native identity may be deferred; a codemux-owned identity keeps closing ledger
records from unrelated unconfirmed sessions separate.

New ledger files use mode 0600 and new directories mode 0700. Existing default
state directories can be tightened; a relocated ledger does not tighten an
existing operator-owned directory. Permission-tightening failure does not undo
an append. Final symlinks and nonregular files are refused. Append failures
warn once and do not fail the model run.

Readers inspect only the newest 16 MiB, discard a leading partial line, and
skip/count malformed or wrong-shaped records. `CODEMUX_TEST_LEDGER` is the
test preload's explicit redirect; NODE_ENV does not redirect operator records.

## Ledger selection and totals

`calls` filters before limiting and displays reverse append order. Because
`ts` is the start time, overlapping calls can appear out of timestamp order.
`--since` accepts integer durations (s/m/h/d/w) or anything JavaScript Date
can parse. Prefer an ISO timestamp with timezone. Invalid dates or cutoffs
outside the representable date range fail with exit 64.

Repeat `--label KEY=VALUE` to require every supplied pair. For example,
`codemux calls --label wf=review --label step=scan` selects only records with
both labels. A missing label does not match, including a filter with an empty
value. `calls` does not read `CODEMUX_LABELS`.

A matching turn also selects closing summaries of that session even when
their start timestamps precede the cutoff. `--sum` covers shown records:
for each session and field, shown turn values take precedence over the closing
summary. With several closings, only the newest shown closing contributes.
Closings without a nonempty session ID are excluded. Unknown fields are
reported with missing-value counts. `--json --sum` emits raw JSONL followed
by human-readable totals; it is not a pure JSONL stream.

Use `codemux calls --sum --by wf` to group shown-record totals by the value
of the `wf` label. Records without that label appear under `(none)`.
`--by` requires `--sum` and a valid label key; invalid use fails with exit 64.
Each group uses the same session and missing-usage rules as the overall totals.

Example: a Claude session starts at 09:00, costs $1 before 10:00, then costs
$0.20 afterward. A shown 10:05 turn can select a closing lifetime cost of
$1.20 under `--since 10:00`. That is selected-record cost, not $0.20 of
interval-attributable spending.

There is another limitation: if the 100-token pre-resume and 20-token
post-resume closings are shown without their turns, the newest-summary rule
uses 20. It cannot recover 120. A partial set of shown turns can similarly
omit usage from other invocations. Complete per-turn records provide better
token accounting, but the ledger has no invocation ID or persisted baseline
that makes arbitrary filtered/resumed summaries exact. This remains a
deferred code change; no lifetime-total guarantee is made.

## Subscription usage

Install the standalone [usagemux tool](https://github.com/bindsch/usagemux#install)
to use `codemux usage`. This is separate from the local call ledger.
The [CLI reference](cli.md#usage) lists all options and timeouts.

Codemux invokes `usagemux snapshot --format json`, validates schemaVersion
`"1"`, and requires exactly one result for every requested client.
Unknown schema versions, missing/duplicate/unrequested clients, invalid
fields, or oversized output fail. Results report quota windows, credits,
account/plan information, and subscription timestamps when available.
Usagemux owns credential lookup, provider compatibility, and caching.

The executable must pass codemux's trust checks. A missing installation exits
69 without affecting other commands. A provider query can read credential
stores and contact billing/usage APIs, but sends no model prompt. Usagemux must
support the requested agents; an older version lacking newer agents can make
the default all-agent query fail. Use `-a` for a supported client or upgrade.
