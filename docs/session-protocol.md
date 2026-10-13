---
read_when: Implementing or debugging a codemux session JSONL client.
---

# Session protocol

This specifies `codemux-live-session/1` as shipped in v0.13.3. See
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
stops reading or stdout fails; even acknowledgments can be lost then.

Input objects reject unknown keys. Optional means omitted, not `null`.
Validation depends on capability and lifecycle state, so a disabled
operation can return `unsupported` before its fields are inspected.

## Input schema

| `type` | Required fields | Optional fields | Meaning |
|---|---|---|---|
| `user` | `text: string` | `author: string` | Open a turn, or follow `user_during_turn` while busy |
| `steer` | `text: string` | `author: string` | Adjust an active turn; supported only by Codex |
| `interrupt` | none | `reason: string` | Interrupt the active turn; supported idle interrupt is an acknowledged no-op |
| `permission_decision` | `request_id: string`, `decision: "allow" \| "deny"` | `updated_input: object` | Resolve one pending request within the launch ceiling |
| `shutdown` | none | none | End the session with the configured grace period |

`text` may be empty, cannot contain NUL, and is at most 16 MiB of UTF-8.
The whole input line is at most 17 MiB. Transport wrapping and escaping can
make a smaller text undeliverable and produce `text_too_long`. Aider and
Kimi impose a stricter 32 KiB limit on harness-bound text, including the
author prefix, because they pass the prompt in argv.

An author has 1–64 Unicode code points. It cannot contain `[` or `]`, an
unpaired surrogate, or characters in Unicode categories Cc, Cf, Zl, or Zp
(controls, format characters, line and paragraph separators). An interrupt
reason has at most 4096 UTF-16 code units and no NUL. A request ID has
1–128 UTF-16 code units and no NUL. `updated_input` must be a non-null JSON
object, not an array. It substitutes Claude/ZAI tool arguments and is
checked against the ceiling; Codex rejects it as `unsupported`.

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
| `input_rejected` | `input_seq: positive integer`; `reason: string` from the rejection table |
| `user_message` | `input_seq: positive integer`; `text: string`; optional `author: string`; optional `turn_id: string` |
| `turn_started` | `turn_id: string` |
| `assistant_delta` | `delta: string`; `turn_id: string \| null` |
| `assistant_message` | `text: string`; `turn_id: string \| null` |
| `tool_call` | `call_id: string`; `name: string`; `input: object` |
| `tool_result` | `call_id: string`; `output: JSON`; `is_error: boolean` |
| `file_change` | `path: string`; `action: "add" \| "edit" \| "delete"`; optional `derived: true` |
| `usage` | `turn_id: string \| null`; `usage: Usage` below |
| `permission_request` | `request_id: string`; `tool: string`; `input: object`; `options: ["allow", "deny"] \| ["deny"]` |
| `permission_resolved` | `request_id: string`; `resolution: "allow" \| "deny" \| "timeout" \| "superseded"` |
| `turn_completed` | `turn_id: string \| null`; `finish: "end" \| "interrupted" \| "failed"`; optional `reason: string`; `usage: Usage` |
| `unknown` | No additional fields; `raw` carries the unmapped line |
| `error` | `fatal: boolean`; `source: "codemux" \| "harness"`; `message: string` |
| `session_ended` | `reason: "shutdown" \| "stdin-close" \| "signal" \| "timeout" \| "crash" \| "harness_failed"`; `exit_code: integer`; `harness_exit: {code: integer \| null, signal: string \| null} \| null`; `shutdown_requested: boolean`; `usage: Usage`; `resumable: boolean` |

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
tool result. Its raw line is the earlier tool-call line. Native Codex file
changes omit `derived`. Permissions are resolved once, including expiry and
supersession on completion, interrupt, or shutdown. Requests arriving during
the shutdown drain are denied immediately.

Pending unacknowledged input is rejected when shutdown starts. Previously
accepted input that cannot run gets a nonfatal error rather than a second
acknowledgment. A driver may synthesize a failed/interrupted turn completion
if the harness closes without one, preserving available turn usage.

`session_ended` is last. `harness_exit` is the last observed child's raw
outcome, or null if no outcome was observed. Every nonzero child exit or
signal forces `reason: "harness_failed"` and a nonzero summary exit,
regardless of who requested shutdown. `shutdown_requested` records stdin
close, shutdown input, or a signal to codemux. It does not excuse failure.
Absolute timeout is a failure; a first turn timeout can interrupt and leave
the session running. A second expiry on the same turn ends it.

## Unmapped and invalid harness output

For the strict JSON transports (Claude/ZAI, Codex, Agy, OpenCode, Kimi):

1. A valid unrecognized event is emitted as `unknown`; the stream continues.
2. A recognized lifecycle event that violates identity or turn grammar is
   mirrored as `unknown`, then a fatal harness `error` ends the session.
3. Invalid JSON or UTF-8 is fatal. Diagnostics include an excerpt bounded
   to the first 4 KiB of offending bytes. Empty harness lines are skipped;
   whitespace-only strict-JSON lines are invalid.

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
| Pending stdout events | 1024 ordinary events or 64 MiB; failure ends the session |
| Unread harness stdin backlog | 64 MiB; refusal is fatal |
| Each Codex pre-handshake / user / steer hold | 256 lines or 32 MiB; queued user/steer overflow is `busy`; handshake overflow is fatal |
| Reserved terminal queue | 8 extra slots; at most 7 fatals, reserving one for the final event |
| Final stdout flush | 1 second before abandoning delivery and exiting nonzero |

Accepted events are not silently truncated to fit. Terminal capacity does
not guarantee delivery to a broken or stalled reader. Keep draining stdout
while writing stdin, and always collect the process exit code. CLI exit
codes, including parser syntax errors versus session validation refusals,
are listed in [sessions](sessions.md#end-conditions-and-failures).
