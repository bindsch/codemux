---
read_when: "Checking the renderer and rollout evidence behind the experiment MCP contract."
---
# Experiment MCP evidence

Dated renderer-internals and rollout evidence moved out of the operator
contract pages [experiment MCP](../experiment-mcp.md) and
[Codex catalog](../experiment-codex-catalog.md). These sections record how a
recorded harness rebuilt its bytes; no codemux flag exposes them. They are
evidence about the named binary versions, not a current specification.

## Claude and Z.AI oversize result spills

Claude Code 2.1.300 replaces an oversize result in one of two forms, both
read from its binary and checked against recorded runs; a spill is accepted
only when the delivered string is one of those forms exactly and the saved
file equals the server result.

The token form (the MCP tool's own token limit) applies to exactly one text
block (Claude drops a truthy `_meta` first; a block keeping a falsy one goes
to its JSON form) whose size could have spilled: Claude's estimate,
`round(characters / 4)`, must exceed half of `MAX_MCP_OUTPUT_TOKENS`
(a passed-through value, parsed as Claude parses its environment integers,
otherwise 25,000; a limit the child takes from elsewhere, a remote flag
included, is not seen, so a smaller spill is rejected: the check fails
closed), and the tool must not carry
`anthropic/maxResultSizeChars`, for which Claude skips the token form. Claude saves the text under
`mcp-<server>-<tool>-<milliseconds>.txt` (server and tool names with every
character outside `[A-Za-z0-9_-]` replaced by `_`; a server named
`claude.ai ...` also has runs of `_` collapsed and leading or trailing `_`
removed, as Claude names it). The delivered string must
equal, character for character, Claude's header (`Error: result (N characters
across L lines) exceeds maximum allowed tokens. Output has been saved to
<path>.\nFormat: Plain text\n`, with N the text's length and L its line
count, both formatted with Claude's unpinned `toLocaleString()`: the
message's counts must all be what one locale prints, which codemux reads
from its own runtime's locale data once per process as a set of locale
signatures (grouping mark, grouping style of groups of three or the Indian
shape, the longest integer left ungrouped, and the numeral set; the
apostrophe and the right single quotation mark, and the no-break space and
its narrow form, stand for each other because Claude's bundled runtime may
carry another CLDR release), never with a leading zero; a count past 1e21 is matched as the full digits
`toLocaleString()` prints, and a read limit that overflows the span to
Infinity as the infinity sign and `Infinity`, as Claude prints them), one of its two
guidance templates (the default one, or the subagent one behind a remote
flag; a passed-through `MCP_TRUNCATION_PROMPT_OVERRIDE`, trimmed as Claude
trims it, pins the default template when it is `legacy` and the subagent
template for any other nonempty value), and, when the persist byte cap was
hit, Claude's note naming the cap. Each template has a chunked variant and
a slicing variant, which Claude picks by its file-read limit; that limit
may come from the child's environment, a settings file, or a flag, so it
is not modeled: the chunk size is any positive integer spelled exactly as a
template literal prints it (what `String()` gives back, or `Infinity`), the span any
count (or the infinity sign) printed alike wherever it recurs, the chunked variant needs more than one line, and the slicing
variant for several lines needs a span below the longest line. The templates are reproduced from the binary, so a changed
word, another path, or appended text fails the comparison. The token
form's JSON variant (several blocks, `Format: JSON array ...`) is not
accepted. A spill path holds no line
break, so it ends at the message's first one: codemux refuses an experiment run whose config root contains a line break
(a passed-through `CLAUDE_CONFIG_DIR`, even an empty one, otherwise HOME), and the rest of the path is Claude's own naming.

The persisted form (the generic result cap, 50,000 characters unless a remote
flag raises it; it fires when the token form did not) applies to any number of text blocks whose characters together exceed the tool's result cap
(50,000 for a plain tool; for a tool whose definition carries
`_meta["anthropic/maxResultSizeChars"]`, that value up to 500,000, as
Claude applies it) and, unless the tool carries that annotation (Claude then never takes the token form), whose
token estimate does not exceed four times the MCP output token limit, past
which the token form fires first (a result outside that range could not
have taken this form), which Claude rebuilds as `{type, text}` (annotations and
key order are dropped; a block's `_meta` is kept by Claude's MCP client
and dropped by its remote-tool path, so both spellings are accepted and
the size label tells them apart) and writes as
`JSON.stringify(blocks, null, 2)` to `<tool-results>/<tool_use_id>.json`
(the id escaped as Claude escapes leaf names). The delivered string must be
`<persisted-output>\nOutput too large (<size>). Full output saved to: <path>\n\nPreview (first 2KB):\n<preview>\n...\n</persisted-output>`
with `<size>` Claude's file-size label of the JSON's length (KiB steps, one
decimal, a trailing `.0` dropped, `N bytes` under 1 KiB) and the preview the
saved file's first 2,000 characters cut back to the last newline past the
half-way point (`\n...` exactly when the file is longer); the persist-cap header
(`Output exceeded the <cap> persist limit; only the first <cap> were saved
to: <path>`) is the capped variant. A save failure (`<truncated-output>`)
is not a spill. A result with an image or document block is never a spill.

For both forms the saved path must be absolute, spelled under either the
configured `<configDir>/projects` or its symlink-resolved form (a sandbox
may hand the child a resolved HOME), and its real path must lie under the
real projects directory at `<project>/<session id>/tool-results/<name>`,
with the session id a UUID and the project the slug names. configDir is
the directory the child sees: `CLAUDE_CONFIG_DIR` only when it is passed
through with `--pass-env`, otherwise `$HOME/.claude` (HOME always reaches the
child; an ambient `CLAUDE_CONFIG_DIR` that is not passed through is ignored;
a passed-through empty one leaves the binary's root empty and the directory
unknown, so spills are rejected).
A passed-through `CLAUDE_CODE_PROJECT_DIR_NAME` (Claude Code accepts
`[A-Za-z0-9_-]{1,64}`, not a reserved Windows device name) replaces the slug
as the project directory name, but only alongside a passed-through
`CLAUDE_CONFIG_DIR`, as the binary applies it.
The slug is taken from the canonical working directory (absolute, symlinks
resolved, NFC-normalized, as Claude Code reads its own cwd; the bridge
takes the directory the child was spawned in, which the launch helper
resolved once before the spawn and the process runner hands over, so a
working-directory symlink retargeted after that resolution does not move
the project) and replaces every
character outside `[A-Za-z0-9]` with `-` (a slug longer than 200 characters
uses the first 200 plus `-` and the base-36 absolute value of Claude's
32-bit string hash of the directory, computed the same way).
Claude NFC-normalizes the projects path before writing; on macOS, where
the filesystem ignores normalization and a resolved path comes back in its
stored form, resolved paths are compared NFC-normalized, elsewhere exactly.
The reported path must not itself be a symlink (Claude writes a regular
file); the file is opened without following a final symlink and without
blocking (a FIFO cannot stall the run; the filesystem calls themselves are
synchronous, so a config directory on an unresponsive network filesystem
would hold the comparison, and the run's timeout, until it answers), must be regular, must still resolve
to the checked location after the open and be that location's inode (a
parent directory swapped for a symlink around the open is rejected), and is
read with a bound of the
expected content's UTF-8 byte length, so a file that grows after the check
is still rejected. Its UTF-8 content must equal the server text or JSON
(in the well-formed form Claude's UTF-8 write produces: a lone surrogate
becomes U+FFFD)
exactly when the message names no cap, or, when it names one, be the
longest prefix of whole code points that fits a byte cap with that label
(Claude truncates at a code-point boundary and names the cap only when it
cut the file), so a prefix inconsistent with the cap, a prefix without a
cap, and a complete file with a cap are rejected.

The `is_error` comparison remains unchanged. An accepted spill's
`result_comparison` records `equal: true`, `spilled: true`, `spill_kind`
(`token` or `persisted`), `chars` (the text's or the JSON's character
count), `path`, `truncated` (whether the file is a capped prefix), and
`guidance` (`default` or `subagent`) for the token form or `preview_chars`
for the persisted form. A rejection records `equal: false`, `spilled: false`,
`spill_rejected` naming the failed check, and `spill_kind` once the delivered
string parsed as one of the two forms (header, path, and tail), whatever
the server content (an error-flag mismatch after a verified spill keeps the
kind; a string that parses as neither form, a save failure included, has none).
Failed saves and other changed strings still fail. Plain matches have no
`spilled` key. Comparison records never include the text.

## Codex rollout evidence

Codemux polls Codex's private rollout every 250 ms while the harness runs.
It emits `turn` at the first native assistant message or function-call item,
with null usage, and `turn_call` for every call. The following `token_count`
emits exactly one `turn_usage`; completed runs require one per turn.
The runner's actual timeout state permits only missing final usage and
preserves exit 124. Completed catalogs, results, and native call correlations
are still checked. An ordinary completed run with missing usage fails with
`harness_log_missing`.
Each `token_usage_record.response_id` belongs to one pending response.
Overlapping distinct response IDs, repeated response IDs, and conflicting
counters between the response record and its `token_count` fail with
`harness_log_missing`. A new response ID or advanced cumulative totals means a
new response, even with equal per-response counters. A snapshot for the same
completed response with equal counters and unchanged cumulative totals records
`harness_retry` with that `response_id`, without another turn or usage record.
A pending response with different counters keeps waiting for its own snapshot. A
conflicting idle snapshot still fails. Rate-limit-only events with `info: null`
carry no usage.

The inspected Codex `rust-v0.165.0` checkout contains this recovery path.
Paths below start at `codex-rs/`. In `core/src/session/turn.rs`,
`try_run_sampling_request` marks rate-limit updates for token-count emission
at lines 3181-3185. A recoverable stream error breaks the loop at lines
2861-2886. The post-loop code at lines 3432-3437 still calls
`send_token_count_event`, then returns the error. In
`core/src/session/mod.rs:5374-5380`, that method reads and emits stored token
info, which can still contain the previous response's counters.
`run_sampling_request` in `core/src/session/turn.rs:1840-1867` calls
`handle_response_stream_error` and retries. That handler in
`core/src/responses_retry.rs:57-175` permits recovery within the retry budget.
The matching repeated snapshot therefore records a retry rather than new usage.
It emits `tool_result_delivered` when it observes the corresponding
`function_call_output` line, before the next model reply. Final verification
reads the complete rollout with the same cursor and checks consistency. It
does not emit duplicate normalized records.

Codemux uses a nonempty request `params._meta.callId` immediately and records
`native_call_id_source: "request_meta"` on `tool_call`. Live and final rollout
checks require the same native ID, bare name, and deeply equal arguments.
Native IDs determine correlation when present; HTTP arrival order can differ
from rollout order for parallel calls. The relay index records arrival order
and does not replace native identity. An ID mismatch fails with
`call_id_unresolved` and names the request and observed IDs. Without
request metadata, dispatch waits up to five seconds for the matching rollout
`function_call` in arrival order, without waiting for usage. The ID is attached to the
forwarded request as `params._meta["codemux/callId"]`. An unresolved call fails
with `call_id_unresolved` and never reaches the server. Missing, duplicate,
malformed, or unmatched evidence fails the run. Built-ins such as `update_plan`
and `apply_patch` fail even if undeclared. The resource trio follows the local exception above.

Experiment flags disable `code_mode` and `code_mode_host`. A refused `exec`
fails with `unknown_tool` for either `function_call` or `custom_tool_call`.
An inventory function named `exec` remains allowed. A hallucinated function or custom tool with its matching native `unsupported call: <name>` or `unsupported custom tool call: <name>` output records `model_tool_error` with `call_id`, qualified `name`, `input`, and exact `harness_output`. Codex's source emits these errors at `core/src/tools/registry.rs:1049-1054`. Such calls do not reach the experiment server or affect native-ID correlation. `run_end.model_tool_errors` counts them; an otherwise verified run reports `failure_code: null`. Missing or inconsistent error evidence and non-resource built-in calls still fail with `unknown_tool`. The
earlier October 29, 2026 probe established the custom `exec` call form.
The 01:41 probe above fetched the override but called tool search.
The 01:58 probe called the experiment tool directly, then failed waiting for
usage. The preserved `c008786c-0ec2-4909-a1df-37e6b51eec44` probe
started at `2026-10-29T01:13:24.377Z`. Its private-server policy omitted
`deferred` and `code_mode`. It completed `experiment.bash`, preserved the
marker in the native model output, and recorded a true
`result_comparison.equal` and a successful `run_end`. Replay verifies this
saved rollout with the built-in catalog declarations accepted. These facts describe the
preserved run; no new live delivery claim is made.

Exec MCP completions also match by native call ID when one is present.
Otherwise they match server, tool, arguments, content, and expected status
(`completed` or `failed`). Identical successful and error calls can complete
in either order.
An `isError: true` relay result requires `failed` status. A non-null completion `error` is accepted only with that status and matching server, tool, arguments, and content; `harness_tool_result.error_text` records its string or `message` text beside the raw error. Successful completions with a non-null error still fail. In the inspected Codex source (`codex-rs/core/src/mcp_tool_call.rs:1061`), a transport error produces `failed`, no result, and an error message; an `isError` tool result produces `failed`, preserves the result, and has no error. Transport errors without matching result content remain refused.

The relay records what the server returned. Rollout output items establish
what reached the model context; the exec JSON stream's MCP result alone is
not delivery evidence. Final verification compares both sources with the
server result before cleanup.
Before private-home cleanup, Codemux copies the raw rollout to
`<recording dir>/<run-id>.codex-rollout.jsonl`, mode 0600, capped at 256 MiB.
`harness_log_copy` records the destination and byte count or a nonfatal error.

Rollouts may identify a tool with the flattened name
`mcp__<server>__<tool>` or a `namespace` of `mcp__<server>` and a bare `name`.
Raw call fields are recorded; normalized tool names stay bare.
The relay's `tool_call` records carry a zero-based `relay_index` and the native
`call_id` resolved before dispatch. `harness_tool_call` retains the raw
rollout call; `harness_tool_result` retains the exec MCP result. Each raw model
output is stored in `model_tool_result`. Missing calls or model-bound outputs
fail.

Codex prepends this separate text item, with four decimal places for elapsed
seconds:

```text
Wall time: 0.1234 seconds
Output:
```

The `codex-wall-time` opt-in accepts only that header shape. The recording
retains its exact text and all model-bound items; comparison removes only
the accepted header. Other changes fail. Results carrying `structuredContent`
or `_meta` are refused. Results past Codex's MCP output budget fail the run:
truncation is a content change, and no spill file is accepted on this path.

## Codex delivery findings

Finding, October 29, 2026: the 01:41 `gpt-6-astra` probe fetched the override
twice and initialized and listed MCP tools through the relay. It made no
code-mode `exec` call. Its only call was `tool_search.tool_search_tool` with
`{"query":"+experiment bash","limit":1}`. That call failed with `unknown_tool`.
The probe preceded the exposure setting above. The preserved passing probe
described below used it.

Finding, October 29, 2026: Atomix rig `brain18`, run `s105`, lock `lw`, case
`A6`, exposed `clock.sleep`, `clock.curr_time`, `collaboration.followup_task`,
`collaboration.interrupt_agent`, `collaboration.list_agents`, and `apply_patch`
twice at Codemux `ee9f3d0`. A `clock.sleep` call failed with `unknown_tool`.
Rejecting calls did not prevent the model from seeing these tools.

## Codex direct-exposure source evidence

Source: Codex `rust-v0.165.0`. These paths start at `codex-rs/`:

| Source lines | Finding |
|---|---|
| `protocol/src/config_types.rs:396-407` | `ToolExposureSurface` serializes `code_mode`, `deferred`, and `direct` in snake_case. `direct` means the initial tool list. |
| `config/src/mcp_types.rs:266-269` | Each MCP server accepts `omit_tools_from`. |
| `core/src/tools/spec_plan.rs:198-290` | The policy subtracts omitted surfaces at line 255. At lines 266-274, a search-capable model loses `direct` only if `deferred` remains. Omitting `deferred` and `code_mode` yields `DirectModelOnly` at line 283. |
| `core/src/tools/spec_plan.rs:392-417,454-461` | The builder registers tool search only when the model supports it and another allowed tool is searchable and deferred. With no such tools, it does not offer tool search. |
| `core/src/tools/spec_plan.rs:663-687` | `spec_for_model_request` selects code-mode augmentation only for eligible code-mode tools; otherwise it returns the direct spec unchanged. |
| `tools/src/responses_api.rs:164-172` | The MCP Responses renderer uses the tool definition's description and input schema and sets `strict: false`. |
| `core/src/tools/spec_plan.rs:1621-1637`; `core/src/tools/handlers/tool_search_spec.rs:16-20,97-105` | Registration builds the handler and its `ToolSpec::ToolSearch` schema. The match at `spec_plan.rs:989-999` only selects an existing search tool for code mode. |
| `features/src/lib.rs:1647-1652` | `tool_search` is Removed. It is not a working disable switch. No extra flag or catalog-field removal is needed. |
| `protocol/src/models.rs:1150-1163,4297-4336` | Native `tool_search_call` response items omit `name`. They also receive the search-specific failure diagnostic. |
