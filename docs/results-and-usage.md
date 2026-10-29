# Results and usage

## Run results

`run` normally prints the reply on stdout and diagnostics on stderr.
`--result-json` requests a structured result with harness-specific
normalization. Claude/Z.AI retain their JSON envelope. Agy normally uses
`--output-format=json`; its isolation/probe paths use
`--output-format=stream-json` and normalize the terminal result.
Codex JSONL is reduced into a codemux-built envelope.
Kimi selects `--output-format stream-json` for result-json runs and builds
an envelope from the parsed events and session wire log.

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
  "session_id": null,
  "recording": null,
  "failure_code": null
}
```

It appears under `codemux` in the envelope. `codemux.recording` is the JSONL
path for every experiment run on Claude, Z.AI, Codex, or Kimi, and null otherwise.
The recording includes raw evidence and normalized `turn`, `turn_usage`,
`turn_call`, and `tool_result_delivered` records; see [experiment MCP](experiment-mcp.md).
`turn` has `{message_id, t, usage, tool_calls}`; `usage` is an object or null.
`turn_usage` has exactly `{message_id, usage, t}` with a known usage object.
`turn_call` has exactly `{message_id, call_id, name, t}`. All share `run_id`,
`seq`, and `kind`; usage objects have `input`, `output`, `cache_read`, and `cache_write`.
Every turn in a complete recording has exactly one usage record. Interrupted or
timed-out recordings can omit usage records because final usage verification is
skipped. Claude, Z.AI, Codex, and Kimi skip final usage verification on timeout.
The timeout exit remains 124. Every call has a call record, including calls already listed in the
initial turn. Later streaming frames can add calls.
`codemux.failure_code` is `string | null`. It contains the experiment's
stable failure code, or null for success and non-experiment runs. The same
code appears in the recording's `failure` and `run_end` records. Experiment
diagnostics use `codemux: experiment failure [<code>]: <message>` on stderr.
Codex model preflight refusals use this envelope too, with `recording: null`
and the applicable `model_required`, `model_unavailable`, or `code_mode` code.
The [failure code table](experiment-mcp.md#failure-codes) defines every code.
Model is the served model when reported, otherwise the
selected model, otherwise null. A reported multi-model result has null model.
Kimi's selected model includes `CODEMUX_KIMI_PROVIDER_MODEL` when `--model`
is omitted. A later experiment cleanup failure preserves an already
normalized model, including Z.AI's default `opus` selection. Codex normalizes its captured reply and reads `--output-last-message` before rollout verification, so a verification failure preserves that reply before private-home cleanup. Experiment failure diagnostics appear once on stderr.
Codex reroute events can identify the served model and produce a stderr note.
`codemux.labels` contains the run's labels, or null when none are supplied.
See [label syntax and environment defaults](cli.md#labels).
Unsupported structured-result adapters refuse `--result-json`; capability
support is listed in [harnesses](harnesses.md).

Run `codemux.session_id` is always null: codemux does not register a run for resume.
Claude/Z.AI request `--no-session-persistence`; ordinary Codex runs request
`--ephemeral`. Codex experiment runs read their private rollout before cleanup.
Other harnesses can retain native state. A null field is not a promise that no
upstream conversation state survives. See [persistence](isolation.md).

Codex experiment recordings are written while the harness runs. Codemux polls
the rollout every 250 ms. Native response items emit `turn` and `turn_call`
without waiting for usage; `token_count` emits `turn_usage` with its own timestamp.
Each delivery is written when its output line is observed. Final verification
uses the same cursor and requires exactly one usage record per turn, otherwise
`harness_log_missing`. A nonempty request `_meta.callId` is used immediately,
copied to `params._meta["codemux/callId"]`, and recorded on `tool_call` with
`native_call_id_source: "request_meta"`. Live and final rollout correlation
then verifies the ID, name, and arguments regardless of parallel HTTP arrival
order. Without request metadata,
resolution waits up to five seconds for native call evidence, without waiting
for usage. Unresolved calls fail before dispatch. Claude and Z.AI retain
`claudecode/toolUseId` too. Their first assistant frame emits `turn` with null usage. Experiment launches include `--include-partial-messages`. Native `message_start` and `message_delta` events supply per-message counters; zero placeholders never replace real counts. `turn_usage` records the final values at `message_stop`, message ID change, or result. A completed turn without real counters fails with `harness_log_missing`. Later frames can add calls.
Message IDs are native. A Codex response with neither a message item ID nor
a function-call item ID fails with `message_id_missing`.

Before private-home cleanup, successful and failed Codex/Kimi experiments
attempt to copy the native log beside the recording as `<run-id>.codex-rollout.jsonl`
or `<run-id>.kimi-wire.jsonl`, with mode 0600 and a 256 MiB cap.
`harness_log_copy` contains `{harness, path, bytes}` or `{harness, path, error}`,
besides the common record fields. `path` names the copy. Copy errors preserve
the run's existing verdict.
Private-home cleanup precedes recording closure. A cleanup failure is
recorded in `failure` and `run_end` and changes the result to a failure. Kimi interruptions record `protocol` with `interrupted before harness evidence` before stdout, or `interrupted before verification` afterward.

Every Codex experiment `run_start` records a `catalog_override` boolean. Codex
override runs also record `catalog_override` with `slug`, `source_path`,
`source_fetched_at`, `served_models`, `served_bytes`, `removed: ["tool_mode"]`,
and `requested_only`. The last field is true when the 1 MiB response cap
requires serving only the requested model. A successful fetch records
`catalog_served` with `client_version` and `bytes`. Catalog `http_request`
records contain only the method, `path: "/catalog"`, `client_version`,
`authorization_present`, `body_complete: true`, and an empty body. They omit request headers,
authorization values, and the nonce. See [Codex catalog details](experiment-codex-catalog.md).
Missing explicit `-m` fails with `model_required`. The October 29, 2026, 01:58
probe called the experiment tool directly and reached the relay, then failed
while waiting for usage. The preserved `gpt-6-astra` probe completed direct delivery and now verifies by replay. No new live probe was run for these fixes.

Kimi's envelope has `reply`, `events`, `session_id`, and `codemux` fields.
`reply` is the assistant text with the same block spacing and final newline
as the normalized plain reply. `events` retains each parsed assistant, tool,
meta, or error line. The top-level `session_id` comes from the
`session.resume_hint` meta event and identifies Kimi's native session;
`codemux.session_id` stays null because the run is not registered for resume.
The hint ends an experiment stream. A second hint or any later frame fails
with `protocol`.
Usage sums `usage.record` entries in
`<brand home>/sessions/*/session_<id>/agents/main/wire.jsonl`: `inputOther`
becomes uncached input, `inputCacheRead + inputCacheCreation` becomes cached
input, and `output` becomes output tokens. Their sum is the total; cost is
null. Missing counts remain null. The wire log is read before hermetic home
cleanup, with a 16 MiB limit. A missing session ID, missing log, malformed
stream/log, or error event fails the run and reports a diagnostic.
An experiment provider attempt that fails without usage and without tool calls emits `harness_retry`
with its step UUID and no `turn`, including attempts with partial content.
An error step with tool calls emits a `turn` and fails later with `harness_log_missing` if usage is absent.
Content-first turns wait for a call or successful end and retain their first-content timestamp. Inventory evidence checks descriptions and the unchanged
`inputSchema` to `parameters` mapping as well as qualified names.

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
Codex and Kimi experiment sinks use the same limit and preserve partial output. On a Codex experiment output-limit failure, JSON `result` retains the last complete assistant message from the valid stream prefix; the run still fails with exit 125. Codex experiment parsing failures also retain the valid reply and parsed prefix in `events`; plain failures retain the reply text. Plain Claude and Z.AI experiment capture-limit failures extract the captured result envelope's reply and keep exit 125. Early Claude and Z.AI experiment failure envelopes retain the adapter's effective model, including its configured default. Kimi result JSON always returns an envelope on parsing, session-hint, or wire-log errors. It names the error, preserves complete events before a malformed or truncated line, and reports `failure_code: null` for non-experiment runs.

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
| Kimi | Result-json sums wire-log usage; no cost. Plain experiment runs also read wire-log usage for the call ledger. Other plain runs report unknown usage | Unknown |
| Aider | Unknown | Unknown |
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
Labels are validated on read as on write. Standard JSON parsing keeps the last
value for duplicate label keys; the reader validates the surviving value as on
write and does not detect duplicates. If a label map has an invalid key, value,
or shape, the reader keeps the record, sets its labels to null, and counts the
line as malformed. Such records cannot match a label filter.

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
reported with missing-value counts. `--json --sum` emits stored JSONL followed
by human-readable totals; it is not a pure JSONL stream.

Use `codemux calls --sum --by wf` to group shown-record totals by the value
of the `wf` label. Records without that label appear under
`Totals for records without label wf`. Headings render C0, DEL, and C1 controls
as visible lowercase Unicode escapes such as `\u001b`. Literal backslashes
are doubled so distinct values remain distinct. Other printable text stays
unchanged. `--json` retains the stored record, including invalid labels, with
DEL and C1 characters escaped as `\uXXXX`, alongside JSON's existing C0
escapes. Its decoded values stay unchanged. Raw C0 characters are replaced
with spaces in place. The line is not re-encoded, so number spellings and
key order stay unchanged.
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
