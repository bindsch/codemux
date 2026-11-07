---
read_when: Implementing or debugging a codemux session JSONL client.
---

# Session protocol

This specifies `codemux-live-session/1`. See
[sessions](sessions.md) for commands, capability availability, and resume.
The implementation is [protocol.ts](../src/session/protocol.ts), the
[drivers](architecture.md#sessions), and [process.ts](../src/session/process.ts).

## Framing and acknowledgments

Each stdin message is one UTF-8 JSON object followed by LF. CRLF is accepted;
the trailing CR is removed. Blank or whitespace-only lines are skipped and
consume no input sequence number. A final nonempty line at EOF is processed.
Invalid UTF-8, oversized lines, invalid JSON, arrays, and scalar JSON receive
`input_rejected` with `reason: "malformed"`. An oversized physical line is
discarded through its newline before reading resumes.

Codemux assigns `input_seq` starting at 1 to each processed nonblank line.
It answers once with `input_accepted` or `input_rejected`. An acknowledgment
means acceptance by codemux, not completion by the model. Codex may park
input until its handshake completes or queue an accepted user message.
During shutdown draining, new lines are rejected `shutting_down`. Nothing
is emitted after `session_ended`. Delivery guarantees end when the caller
stops reading or stdout fails; even acknowledgments can be lost then. Once a
pending-event bound breaches, ordinary events are refused for the rest of the
session; only the terminal events the end path needs (the crash notices and
`session_ended`) are still delivered, so the stream never resumes a
normal-looking continuation after the gap it acknowledged.

Input objects reject unknown keys. Optional means omitted, not `null`.
Validation depends on capability and lifecycle state, so a disabled
operation can return `unsupported` before its fields are inspected.

## Input schema

| `type` | Required fields | Optional fields | Meaning |
|---|---|---|---|
| `user` | `text: string` | `author: string` | Open a turn, or follow `user_during_turn` while busy |
| `steer` | `text: string` | `author: string` | Adjust an active turn; supported only by Codex |
| `interrupt` | none | `reason: string` | Interrupt the active turn; supported idle interrupt is an acknowledged no-op |
| `permission_decision` | `request_id: string`, `decision: "allow" \| "deny"` | `updated_input: object`, `message: string` (deny only) | Resolve one pending request within the launch ceiling |
| `shutdown` | none | none | End the session with the configured grace period |

`text` may be empty, cannot contain NUL, and is at most 16 MiB of UTF-8.
The whole input line is at most 17 MiB, measured on the delivered payload:
the carriage return of a CRLF-terminated line is stripped before delivery
and does not count against the cap. Transport wrapping and escaping can
make a smaller text undeliverable and produce `text_too_long`. Aider and
Kimi impose a stricter 32 KiB limit on harness-bound text, including the
author prefix, because they pass the prompt in argv.

An author has 1–64 Unicode code points. It cannot contain `[` or `]`, an
unpaired surrogate, or characters in Unicode categories Cc, Cf, Zl, or Zp
(controls, format characters, line and paragraph separators). An interrupt
reason has at most 4096 UTF-16 code units and no NUL. A harness request ID
has 1–128 UTF-16 code units and no NUL; a Codex `request_id` is that id's
JSON spelling and may be longer (up to 770 code units), while Claude and
ZAI request ids are the raw string. `updated_input` must be a non-null JSON
object, not an array. It substitutes Claude/ZAI tool arguments and is
checked against the ceiling; Codex rejects it as `unsupported`.

A denial `message` has 1–2000 UTF-16 code units, no NUL, and no control
characters other than newline. It is valid only with `decision: "deny"`:
with `allow`, or outside those rules, the line is rejected `malformed`.
Claude/ZAI send it to the harness as the rejection text the model sees.
Codex rejects it as `unsupported`, since its decline carries no text. When
no message is given, every deny codemux sends — a caller deny, the session
permission policy, the autonomy ceiling, the permission and turn timeouts,
supersession, and shutdown — uses the text Claude Code itself gives the
model when the user rejects a prompt (it begins "The user doesn't want to
proceed with this tool use."), so the agent reads the denial as its own
harness's answer, never as an outside wrapper's.

```json
{"type":"user","text":"Explain the failing assertion.","author":"reviewer"}
{"type":"steer","text":"Focus on the parser."}
{"type":"interrupt","reason":"Change of task"}
{"type":"permission_decision","request_id":"request-1","decision":"deny"}
{"type":"shutdown"}
```

These illustrate individual message shapes, not a sequence to send at once.
Copy a real request ID from `permission_request` before answering it.

### Rejection reasons

| Reason | Meaning |
|---|---|
| `malformed` | Invalid framing/JSON/object shape, extra key, or invalid field type/value |
| `unknown_type` | Unrecognized string `type` |
| `invalid_author` | Author fails its type, character, or length rules |
| `text_too_long` | Text, argv text, or serialized harness frame exceeds its bound |
| `text_nul` | Text contains NUL |
| `reason_too_long` | Interrupt reason exceeds 4096 code units |
| `unsupported` | Capability, decision payload, or command-shaped prompt is not supported |
| `busy` | Mid-turn user input is disabled, or a Codex input queue is full |
| `no_active_turn` | Steer has no active turn |
| `unknown_request` | Permission ID is unknown, expired, or already resolved |
| `autonomy_escalation` | An allow decision exceeds the launch ceiling; harness receives deny |
| `shutting_down` | The session is ending or delivery failed while ending |

## Output envelope

Every stdout line is one JSON object. The first five keys are serialized in
this order; event-specific fields follow. Clients should parse keys rather
than depend on order.

| Key | Type | Contract |
|---|---|---|
| `seq` | positive integer | Starts at 1; increases for each generated event in this invocation; delivery failure can create observed gaps |
| `ts` | string | UTC ISO 8601 timestamp; not a monotonic clock |
| `session_id` | string | Stable adopted ID; may be empty before a harness supplies one or on an early failure |
| `type` | string | Event name below |
| `raw` | string or null | Original mirrored harness line without LF, or null for codemux-originated events |

One harness line can produce several events sharing `raw`. JSON key order,
duplicate keys, and spacing inside `raw` are preserved. Aider extracted
assistant text has `raw: null`. Synthetic turn completions also have null
raw. Treat session IDs and turn IDs as opaque; counters and local turn IDs
restart in a resumed invocation.

## Output event fields

Fields below are additional to the envelope. Unless marked optional, every
field is present. `JSON` means any JSON value, including null. Strings have
no extra length guarantee beyond the framing and queue bounds below.

| `type` | Fields |
|---|---|
| `session_started` | `agent: string`; `model: string \| null`; `autonomy: "read-only" \| "low" \| "medium" \| "high"`; `cwd: string`; `sandboxed: boolean`; `sandbox_trust: "trusted" \| "standard" \| "untrusted"`; `capabilities: object` below; `protocol: "codemux-live-session/1"` |
| `input_accepted` | `input_seq: positive integer` |
| `input_rejected` | `input_seq: positive integer`; `reason: string` from the rejection table; optional `message: string` — the denial text sent to the harness, present on `autonomy_escalation` |
| `user_message` | `input_seq: positive integer`; `text: string`; optional `author: string`; optional `turn_id: string` |
| `turn_started` | `turn_id: string` |
| `assistant_delta` | `delta: string`; `turn_id: string \| null` |
| `assistant_message` | `text: string`; `turn_id: string \| null` |
| `tool_call` | `call_id: string`; `name: string`; `input: object` |
| `tool_result` | `call_id: string`; `output: JSON`; `is_error: boolean` |
| `file_change` | `path: string`; `action: "add" \| "edit" \| "delete"`; optional `derived: true` |
| `usage` | `turn_id: string \| null`; `usage: Usage` below |
| `permission_request` | `request_id: string`; `tool: string`; `input: object`; `options: ["allow", "deny"] \| ["deny"]` |
| `permission_resolved` | `request_id: string`; `resolution: "allow" \| "deny" \| "timeout" \| "superseded"`; optional `message: string` — the denial text sent to the harness, omitted when none was (an allow, or a Codex decline, whose wire answer carries no text) |
| `permission_denied` | `request_id: string`; `tool: string`; `message: string` — the `--permission-policy deny` record of a request codemux answered the moment it arrived, with the denial text it sent; such a request never joins the pending set, so a caller decision for it receives `unknown_request` and no `permission_resolved` follows |
| `turn_completed` | `turn_id: string \| null`; `finish: "end" \| "interrupted" \| "failed"`; optional `reason: string`; `usage: Usage` |
| `unknown` | No additional fields; `raw` carries the unmapped line |
| `error` | `fatal: boolean`; `source: "codemux" \| "harness"`; `message: string` |
| `session_ended` | `reason: "shutdown" \| "stdin-close" \| "signal" \| "timeout" \| "crash" \| "harness_failed"`; `exit_code: integer`; `harness_exit: {code: integer \| null, signal: string \| null} \| null`; `shutdown_requested: boolean`; `usage: Usage`; `resumable: boolean` |

The process exit code is the `exit_code` `session_ended` reported, unless
the event's delivery failed (the sink rejected or stalled), which ends the
process nonzero instead: a signal or a failure that lands while the final
event is still being flushed no longer changes the exit code, because the
session had already ended and reported its verdict.

A `request_id` is the harness request's id as codemux presents it, and the
decision echoes it back verbatim. Claude and ZAI present the raw id string.
Codex presents the JSON-RPC id's JSON spelling: numeric ids as their digits
(`42`), string ids with their quotes (`"appr-1"`), so two Codex requests
whose ids differ only by JSON type never collide. A numeric id must be a
safe integer (review round 110): a number JSON serialization corrupts —
`1e400` folds to Infinity and back to `null`, an unsafe integer rounds,
`-0` renders as `0` — so such an id never joins the pending set; two
requests differing only by the corruption would have collided on one
answer. A `permission_request`
never carries an id a decision cannot answer (empty, over the request-id
bound, containing NUL, or an unsafe number): the same predicate guards both
sides, and a Claude/ZAI `can_use_tool` with such an id is answered by the
driver itself
with the control protocol's error response instead of joining the pending
set.

`model` is the requested/resolved selection, or null when none was selected;
it is not a guarantee of the model actually served. Session CLI launches
currently refuse sandboxed untrusted trust. The envelope retains the wider
trust enum used by the registry and drivers.

Tool and file events do not include `turn_id`. There is no permission
`summary` field: inspect `tool` and `input`. `user_message.turn_id` is omitted
until known, while assistant and usage turn IDs can explicitly be null.
`assistant_message` contains completed text blocks when the harness reports
them; it is not guaranteed to be exactly one message per turn. Never assume
a failed turn produced an assistant message.

### Capabilities

All nine fields are present:

| Field | Type |
|---|---|
| `live_input` | boolean |
| `user_during_turn` | `"inject" \| "queue" \| false` |
| `steer` | boolean |
| `interrupt` | boolean |
| `permissions` | boolean |
| `deltas` | boolean |
| `file_changes` | `"native" \| "derived" \| false` |
| `usage_stream` | boolean |
| `resume` | boolean |

No shipped driver reports `inject`. Only Codex reports `queue`, steer,
native file changes, or streaming usage. The remaining values are listed in
[the agent matrix](sessions.md#supported-agents).

### Usage

`Usage` always has five fields, each `number | null`: `input_tokens`,
`output_tokens`, `cached_input_tokens`, `total_tokens`, and `cost_usd`.
Null means unreported, never zero. Input excludes cache-served tokens;
cached input includes cache reads and writes; total requires all token parts.
An unknown or overflowing count is null: token counts are whole non-negative
safe integers, and a count past that range — or a fold whose sum would
leave it — reports null in the event and in the ledger's closing summary,
never a rounded number.
See [results and usage](results-and-usage.md) for normalization details.

`usage` events exist only for Codex. They contain notification deltas, not
an additional charge to add to `turn_completed.usage`. A late notification
for a closed turn has `turn_id: null` and updates the session aggregate.
The latest 1024 closed Codex turns remain recognized for late events.
`session_ended.usage` token counts aggregate this driver instance, including
after resume, not the entire stored conversation. Known component values
survive missing later values; derived `total_tokens` becomes null if a
contributing turn omits a component.

Claude/ZAI turn cost is null. Their session cost adopts the latest reported
harness-lifetime cost, which can include earlier invocations. Aider and Kimi
report all-null usage. Do not add turn totals, usage events, and session
totals together.

## Ordering and lifecycle

A normal turn has `turn_started`, content/tool/permission events, then
`turn_completed`. `session_started` is not necessarily the first event:
some harnesses only reveal their identity after the first accepted prompt.
Clients must be able to send that prompt before seeing `session_started`.
`input_accepted` and `user_message` may therefore precede it. A queued Codex
message is echoed on acceptance, potentially without a turn ID.

A successful derived Claude/ZAI file change follows its matching successful
tool result. Its raw line is the earlier tool-call line. A candidate whose
result never arrived is dropped when its turn completes, so no later turn's
reused or delayed call id can confirm it. Native Codex file
changes omit `derived`. Permissions are resolved once, including expiry and
supersession on completion, interrupt, or shutdown. Requests arriving during
the shutdown drain are denied immediately. On Claude/ZAI every deny — a
caller's, the policy's, the ceiling's, a timeout's, a supersede's, the end
path's — carries the same default rejection text unless the caller's
decision supplied `message`, so the model cannot tell which side refused.

Pending unacknowledged input is rejected when shutdown starts. Previously
accepted input that cannot run gets a nonfatal error rather than a second
acknowledgment. A driver may synthesize a failed/interrupted turn completion
if the harness closes without one, preserving available turn usage. An
OpenCode `error` event, and a Kimi roleless `{type:"error",message}` frame,
are nonfatal for the session but fail their turn even when the per-turn
process exits zero, the plain-run rule; the first error message is the
completion's `reason`, and the session continues with the next turn. A Kimi
error event that names no message fails the turn the same way, with a fixed
reason.

`session_ended` is last. `harness_exit` is the last observed child's raw
outcome, or null if no outcome was observed. Every nonzero child exit or
signal forces `reason: "harness_failed"` and a nonzero summary exit,
regardless of who requested shutdown. `shutdown_requested` records stdin
close, shutdown input, or a signal to codemux. It does not excuse failure.
Absolute timeout is a failure; a first turn timeout can interrupt and leave
the session running. A second expiry on the same turn ends it. A second
signal to codemux while the first signal's end still runs SIGKILLs the
child tree at once, so the end lands with no additional event and the
summary exit stays the signal convention's.

## Unmapped and invalid harness output

For the strict JSON transports (Claude/ZAI, Codex, Agy, OpenCode, Kimi):

1. A valid unrecognized event is emitted as `unknown`; the stream continues.
2. A recognized lifecycle event that violates identity or turn grammar is
   mirrored as `unknown`, then a fatal harness `error` ends the session.
3. Invalid JSON or UTF-8 is fatal. Diagnostics include an excerpt bounded
   to the first 4 KiB of offending bytes. Empty harness lines are skipped,
   including a line of one carriage return (the blank line of a CRLF wire);
   whitespace-only strict-JSON lines are invalid. An oversized harness
   line is fatal the moment an unterminated run passes the line bound —
   the session must not wait for a newline that may never arrive — and
   its reported byte count is the bytes seen at that crossing; the rest
   of the run is discarded through the newline without being counted.

Aider is different: its stdout is a human transcript, and every nonempty
line, including non-JSON, is forwarded as `unknown`. UTF-8 and size bounds
still apply. Permission-shaped requests that cannot be safely interpreted
are denied or answered with a protocol error, preserved raw, and reported
with a nonfatal error rather than killed solely for their shape. A Codex
approval offering no refusal choice also interrupts its turn.

## Resource limits and failure delivery

| Resource | Bound / consequence |
|---|---|
| Caller text | 16 MiB UTF-8; `text_too_long` |
| Caller line / harness write | 17 MiB; caller line overflow is `malformed`; undeliverable text is `text_too_long` |
| Aider/Kimi argv text | 32 KiB including author prefix; `text_too_long` |
| Harness stdout line | 16 MiB; fatal overflow |
| Pending stdout events | 1024 ordinary events or 64 MiB; failure ends the session, and ordinary events stay refused after it |
| Unread harness stdin backlog | 64 MiB; refusal is fatal |
| Each Codex pre-handshake / user / steer hold | 256 lines or 32 MiB; queued user/steer overflow is `busy`; handshake overflow is fatal |
| Reserved terminal queue | 8 extra slots; at most 7 fatals, reserving one for the final event |
| Final stdout flush | 1 second before abandoning delivery and exiting nonzero |

Accepted events are not silently truncated to fit. Terminal capacity does
not guarantee delivery to a broken or stalled reader. Keep draining stdout
while writing stdin, and always collect the process exit code. CLI exit
codes, including parser syntax errors versus session validation refusals,
are listed in [sessions](sessions.md#end-conditions-and-failures).
