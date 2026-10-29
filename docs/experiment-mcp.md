# Experiment MCP

`run --experiment-mcp <spec.json>` connects one experiment-owned stdio MCP
server with `-a claude`, `-a zai`, `-a codex`, or `-a kimi`. It requires `--hermetic
--tools none --auto read-only`, scode, and no Playwright MCP. Claude and
Z.AI use Claude Code's SDK control bridge. Codex and Kimi use a loopback HTTP
relay. Codex and Kimi require explicit result-header opt-ins. Other adapters refuse before
reading the spec or starting a model.

The server runs **outside scode** with only the environment names in the spec.
Its command and arguments are operator-controlled. The harness remains inside
read-only scode. Hermetic mode excludes operator-configured MCP integrations;
this explicitly requested server is the exception.

## Specification

The file must be valid UTF-8 JSON, at most 64 KiB, and a single object with
exactly these supported fields. Unknown properties, including `control`, fail.

| Field | Required | Validation |
|---|---|---|
| `name` | Yes | String matching `[A-Za-z][A-Za-z0-9_-]{0,63}`; 1–64 ASCII characters |
| `command` | Yes | Absolute executable path, no NUL |
| `args` | Yes | Array of strings without NUL; may be empty |
| `env` | Yes | Array of unique names matching `[A-Za-z_][A-Za-z0-9_]*`; every named variable must be set |
| `recording` | No | Nonempty directory path without NUL; relative to the spec's directory; existing non-directory rejected |
| `accept_harness_prefix` | No | Array of unique strings: `"codex-wall-time"` and `"kimi-wall-time"`. Each harness requires its own value; ignored on Claude/Z.AI |

The command must be a trusted regular executable owned by the user or root,
not group/world writable, and outside the execution cwd. No shell is inserted.
Claude and Z.AI prompts must fit a 1 MiB serialized control frame, including
escaping and wrapper. Codex uses a 16 MiB stdin limit; Kimi uses a 32 KiB argv bound.

## Runnable fixture example

The repository ships a sanitized server at
[`tests/fixtures/experiment-mcp.ts`](../tests/fixtures/experiment-mcp.ts).
Its `bash` tool returns a fixed marker and executes no command. The fixture
also supports intentional failure cases for tests; use the prompt below.

From the checkout, these commands write a specification with actual absolute
paths. Shell `~` expands in shell expressions; JSON does not expand it.

```sh
mkdir -p scratch
bun -e 'console.log(JSON.stringify({
  name: "experiment",
  command: process.execPath,
  args: [process.cwd() + "/tests/fixtures/experiment-mcp.ts"],
  env: [],
  recording: "recordings"
}, null, 2))' > scratch/experiment-mcp.json
codemux run -a claude --hermetic --tools none --auto read-only \
  --experiment-mcp scratch/experiment-mcp.json \
  -p "Call the experiment bash tool with command marker, then repeat its result." \
  --result-json
```

This last command is a real model request and consumes quota. A trusted Bun
installation outside the checkout is required. Server code is supplied as
an explicit argument; the experiment operator is responsible for that code.
The recording directory above resolves to `scratch/recordings/`.

For Codex, add `"accept_harness_prefix": ["codex-wall-time"]` to the spec
and select `-a codex -m <cached-model-slug>` using the cache described below. For Kimi, add
`"accept_harness_prefix": ["kimi-wall-time"]` and select `-a kimi`.
Omitting the harness's prefix refuses the run before launch. Unknown prefixes,
duplicate entries, and non-array values fail spec validation. Codex requires
CLI 0.165.0 or later; Claude/Z.AI require Claude Code 2.1.280 or later.
Kimi requires Code 2.3.2 or later and a clean working directory as described
in [isolation](isolation.md).

## Protocol and recordings

The server speaks newline-delimited JSON-RPC 2.0. Responses must match pending
request IDs (strings or safe integers) and contain exactly one of result/error.
The transport permits at most 64 pending requests. Request/response and Claude
control frames are limited to 1 MiB. This prompt bound applies only to Claude and Z.AI. Codex retains its 16 MiB stdin prompt limit; Kimi retains its 32 KiB argv bound. A server notification with method
`notifications/tools/list_changed` and no `id` is recorded as
`server_notification`. The bridge rechecks the full paginated `tools/list`
against the validated inventory and records `tool_inventory_recheck` with
`equal` and both definition sets (`previous` and `current`). Recheck requests
have their own `mcp_request` records. Deep-equal definitions allow the run to
continue; changed definitions fail the run. The notification never reaches
Claude, and call responses still resolve by their pending request IDs.
Every other server-initiated message, including `notifications/progress`,
sampling, elicitation, and requests with an `id`, is refused. JSON-RPC errors
are fatal, including errors on `ping`.

`tools/list` must produce a complete nonempty inventory, following pagination
without repeated cursors. Tool names are unique, match `[A-Za-z0-9_-]{1,64}`,
and keep the namespaced name `mcp__<name>__<tool>` within 64 characters, the
bound Claude Code 2.1.300's SDK bridge applies to tool names. The shared inventory validator rejects sanitized-name collisions,
such as `foo-bar` and `foo_bar`, with `inventory_mismatch` for every harness before any calls.
Definitions, `inputSchema` included, pass through unchanged and must not change during the run; a large inventory (a hundred tools with schemas) is bounded only by the 1 MiB control frame.
Claude's exposed inventory must equal the advertised namespaced set before
conversation frames or tool calls are accepted.

### Codex and Kimi relay

Codemux starts the stdio server outside scode and exposes a per-run
`http://127.0.0.1:<port>/mcp` endpoint. The operating system chooses the port.
A random 32-byte bearer token authenticates requests. The private harness MCP
configuration names only this endpoint. Both `--sandbox-no-net` and `--sandbox-trust untrusted` are refused before launch because they block networking needed by the loopback relay.
Codex experiments also refuse a nonempty system MCP configuration, including
MCP tables inside profiles, because system tables merge into the private
config. Unreadable or malformed system config is refused. Windows experiments
are refused until the system config location can be verified. Administrator
managed settings remain subject to the limits in [isolation](isolation.md).

Each `/mcp` POST must carry one JSON-RPC object. Arrays fail with HTTP 400; missing
or incorrect authorization gets 401; GET and DELETE get 405; a body over
1 MiB gets 413. A request is forwarded to the stdio server and answered with
HTTP 200 and `application/json`. Valid notifications get HTTP 202 with no body. A `tools/call` notification lacks a required request ID, so it gets HTTP 400 and fails with `protocol` before dispatch. Non-object `arguments`, including explicit null, also get HTTP 400 and `protocol` before dispatch. Omitted arguments become `{}` in both native correlation and the forwarded request. The Claude bridge applies the same argument rules.
Malformed authenticated JSON or JSON-RPC envelopes also return HTTP 400 and fail the run with `protocol`.
HTTP 413 headers are flushed immediately; rejected uploads drain only until the original 30-second request deadline. HTTP 408 closes without another drain period.
Inventory validation and definition rechecks use the same rules as Claude.
The relay records `http_request` with method, path, token match, and base64
body bytes, and `http_response` with status and base64 body bytes. Accepted
bodies have `body_complete: true`. An oversized body is stopped at the first
chunk past the limit; its recorded prefix has `body_complete: false`, and
the connection closes after HTTP 413. Authentication precedes body reads. Invalid methods get 405 before body reads. An authenticated oversized `Content-Length` gets 413 before body reads. A body must complete within 30 seconds; otherwise it gets 408 and the connection closes. An unauthorized request gets HTTP 401 and only an `http_request` record with empty body bytes and `body_complete: false`. Its disconnect cannot fail the experiment.

### Codex delivery evidence

Codex experiments require an explicit `-m`; omission fails with `model_required`.
Before launch, Codemux reads the real `CODEX_HOME/models_cache.json`, bounded
at 2 MiB. The populated cache must contain the requested slug and match the
detected Codex `client_version`. Defaults and bundled fallback slugs are not used.
A slug absent from the account's catalog fails with `model_unavailable`;
the diagnostic names the cache path, `fetched_at`, and listed slugs.
With `--result-json`, preflight failures `model_required`, `model_unavailable`, and `code_mode` return the failure envelope with `recording: null` because no recording has been created.

Only cached `code_mode` or `code_mode_only` requests use a catalog override.
Codemux removes `tool_mode` from the requested entry and preserves every other
entry and field. It serves `{"models":[...]}` with a 1 MiB response cap, falling
back to the requested entry alone if necessary. That entry exceeding the cap
fails with `code_mode`. Direct-tool requests leave the catalog unchanged.

For an override, this token-free config selects a custom provider. It has no
`base_url`; Codex keeps its normal authenticated backend route.

```toml
model_provider = "codemux-experiment"

[model_providers.codemux-experiment]
name = "OpenAI"
wire_api = "responses"
http_headers = { version = "<detected codex version>" }
env_http_headers = { "OpenAI-Organization" = "OPENAI_ORGANIZATION", "OpenAI-Project" = "OPENAI_PROJECT" }
requires_openai_auth = true
supports_websockets = true
supports_standalone_web_search = true
model_catalog_url = "http://127.0.0.1:<port>/catalog/<nonce>"
```

The provider retains `name = "OpenAI"` and ChatGPT authentication. See
[provider differences](experiment-codex-catalog.md#provider-selection-and-differences)
for reserved IDs, metadata, cyber access, and defaults. A catalog override
cannot coexist with an active `CODEMUX_CODEX_PROVIDER_*` override; Codemux
refuses the combination before private config writes. Direct-mode experiments
without a catalog override retain existing provider override behavior.
Experiment flags still include `--disable code_mode --disable code_mode_host`.
Both direct-model and catalog-override runs set `omit_tools_from = ["deferred", "code_mode"]` in the private `[mcp_servers.<name>]` table. `run_start.omit_tools_from` records the same list.
Finding, October 29, 2026: Codex `rust-v0.165.0` subtracts these surfaces before deferral, leaving only `direct` in the initial tool list (`codex-rs/core/src/tools/spec_plan.rs:255-287`). The server field is at `codex-rs/config/src/mcp_types.rs:266-269`; the serialized surface names are at `codex-rs/protocol/src/config_types.rs:396-407`.
With no searchable deferred tools, the builder omits tool search (`codex-rs/core/src/tools/spec_plan.rs:392-417,454-461`). An unexpected call fails with `unknown_tool`, names the tool, and reports an exposure policy change. See the [dated source finding](experiment-codex-catalog.md#direct-mcp-exposure).

Each experiment declaration must match the relay description (absent means `""`) and set `strict: false`. Its `parameters` must be a recursive subset of the original relay `inputSchema`: retained keys, indices, and values stay at the same paths; only object keys and array suffix entries may be omitted. Additions, changed values, or shifted indices fail with `inventory_mismatch`. Each declaration records omitted JSON Pointer paths in `catalog_pruned_paths`. Codemux does not reproduce Codex schema lowering, pruning, compaction, or byte budgets. See the [catalog contract and direct-renderer source](experiment-codex-catalog.md#built-in-declarations).

The exact Codex 0.165.0 built-in declarations accepted by `CODEX_BUILTIN_DECLARATIONS` are `functions.list_mcp_resources`, `functions.list_mcp_resource_templates`, `functions.read_mcp_resource`, `functions.request_user_input`, `functions.request_user_input_async`, `functions.apply_patch`, `clock.curr_time`, `clock.sleep`, `collaboration.followup_task`, `collaboration.interrupt_agent`, `collaboration.list_agents`, `collaboration.send_message`, `collaboration.spawn_agent`, and `collaboration.wait_agent`. `apply_patch` has type `custom`; the others have type `function`. Catalog records mark them `builtin`. Every other declaration outside the experiment inventory fails with `inventory_mismatch`. Calling any built-in still fails with `unknown_tool`. See the [source references for each declaration](experiment-codex-catalog.md#built-in-declarations).

A refused `exec` call fails with `code_mode` for either `function_call` or `custom_tool_call`; an inventory function named `exec` remains allowed.
An override run also fails with `code_mode` if Codex has not fetched the catalog before call ID resolution and dispatch, including requests with `_meta.callId`.

The preserved October 29, 2026 `gpt-6-astra` probe completed direct experiment delivery. Replay verifies its saved rollout, relay result, and exec completion after the catalog fix. No new live probe was run. See [Codex catalog and delivery details](experiment-codex-catalog.md) for nonce authentication, recording fields, rollout evidence, and exact header comparison.

### Kimi configuration and delivery evidence

Codemux writes the relay URL and bearer header into a private mode 0600
`mcp.json`, containing only `mcpServers.<spec.name>`. The token stays out of
argv and the child environment. The private home, config, empty skill
directory, explicit agent profile, and project-path refusals follow the
Kimi hermetic contract in [isolation](isolation.md).

The existing preflight rules still apply. A request that would expose the
working directory or recording directory to Kimi's built-in tools is
refused before launch: experiments require `--tools none` and the MCP-only
profile. The existing project instruction and configuration path checks
also apply. The experiment adds no broader path exception.

The generated entry has this shape; the URL and token are unique per run:

```json
{"mcpServers":{"experiment":{
  "url":"http://127.0.0.1:<port>/mcp",
  "headers":{"Authorization":"Bearer <per-run-token>"},
  "startupTimeoutMs":120000,"toolTimeoutMs":600000
}}}
```

For experiments, `--tools none` excludes all built-in tools while the agent
profile permits `mcp__<sanitized-server>__*`. Kimi's tool manager applies MCP
patterns separately from its strict built-in allowlist. An ordinary
tools-none run still uses `tools: []` and exposes no tools. The wire log's
`llm.tools_snapshot` must equal the exact experiment inventory before any
call is dispatched. Kimi 2.3.2 preserves each description, using an empty string when absent,
and maps `inputSchema` unchanged to `parameters`. Changed metadata fails with `inventory_mismatch`.
Source: `mcpCore/client-shared.ts:68-73`, `mcpCore/connection-manager.ts:509-512`, and `agent/mcp/tools/mcp.ts:37-39` under `packages/agent-core-v2/src/` in Kimi 2.3.2.
A built-in or foreign MCP tool fails the run.

Kimi qualifies tools as `mcp__<server>__<tool>`, replacing characters outside `[A-Za-z0-9_-]` with `_` and collapsing underscore runs within each part (`mcpCore/tool-naming.ts`). Codex replaces every character outside `[A-Za-z0-9_]` in the qualified name with `_`, preserving underscore runs (`codex-mcp/src/mcp/mod.rs:601`).
The shared inventory validator checks both sanitizers for every harness before exposing tools, including collisions across pages. Thus `foo__bar` / `foo_bar` collide under Kimi, while `foo-bar` / `foo_bar` collide under Codex. Both fail with `inventory_mismatch`.
Codemux matches each harness's qualified name and records the server's bare name. Kimi's profile pattern and evidence parser share the same sanitizer, which collapses every underscore run. The shared 64-character namespaced bound keeps experiment names below Kimi's hash-shortening threshold.

Codemux tails the private session's `wire.jsonl` every 250 ms during the run.
Each `tools/call` waits up to five seconds for a unique unmatched native `tool.call`
with the same qualified name and deeply equal arguments. HTTP arrival order may differ.
Kimi cannot carry identical concurrent calls. Multiple pending identical requests or matching native calls fail with `call_id_unresolved` before dispatch, even when native records arrive in separate polls. Claude and Codex carry native IDs and are unaffected.
The forwarded request carries its native `toolCallId` as
`params._meta["codemux/callId"]`. Unresolved calls fail before server dispatch.
The first `tool.call` emits a turn. Content-first turns retain the first `content.part` timestamp
and wait for a call or successful `step.end`. `step.end` emits usage; `tool.result` emits delivery.
An error step without usage and without calls records `harness_retry` with its UUID in `message_id`, including partial provider responses. It emits no turn and consumes no completed assistant message. An error step with calls emits a turn and fails later with `harness_log_missing` if usage is absent.
Final verification requires `sessions/<workspace>/session_<id>/agents/main/wire.jsonl` to match the native session hint.
It uses the same cursor and checks the complete wire log against server results and turn-end assistant/tool messages before cleanup. Stdout assistant call IDs, qualified names, and parsed arguments must match wire `tool.call` evidence. Missing, duplicate, or contradictory declarations fail with `protocol`. Assistant, tool, and resume-hint frames use the session parser grammar.
Missing, duplicate, inconsistent, or incomplete evidence fails the run, except missing final usage on an actual timeout as described below.
The native log is copied before private-home cleanup. The recording closes after cleanup, so a cleanup error produces a `failure` record and the same failure code in `run_end`. Capture failures preserve complete prefix events and replies before malformed or truncated lines. The failure result names the parse error and retains the session ID, effective model, and usage when the wire log is readable. The paired check validates its generated control before either probe starts. It adds `KIMI_CODE_HOME` only when absent and refuses a control that would exceed the 64-name environment limit.

Kimi's model-bound bytes are **reconstructed**, unlike Claude's observed frames and Codex's rollout output item. The wire log does not contain the provider request. Codemux reproduces Kimi 2.3.2's `agent/contextMemory/toolResultRender.ts` and `agent/contextProjector/projection.ts`, using raw tool-message content and the loop result's `isError`, `durationMs`, and `note`. The producer is `agent/loop/loopService.ts`; `agent/contextMemory/loopEventFold.ts` attaches these fields. These paths are under `packages/agent-core-v2/src/`.

The `kimi-wall-time` opt-in accepts `Wall time: N.NNN seconds\n`, with exactly three
decimals from `(durationMs / 1000).toFixed(3)`, prepended to the first text part.
If the first output part is non-text, the header is a separate text part without a
trailing newline. An error also carries `<system>ERROR: Tool execution failed.</system>`:
followed by a newline for single text output, or as a separate part for multipart
output. Codemux records and compares that status exactly under the same prefix.
Notes are appended as Kimi renders them; projection then drops whitespace-only text
parts. Empty server output is refused because Kimi substitutes status text.
The October 29, 2026 live probe's reply confirmed `Wall time: 0.123 seconds\n` before
the marker, matching the loop result's `durationMs: 123`.

`model_tool_result.content` and `output` hold the reconstructed projection;
`wire_content` retains the raw tool-message content. `result_comparison` records
`harness_prefix: "kimi-wall-time"` and the exact removed `header`, including the trailing newline in `Wall time: N.NNN seconds\n` for text results. A separate media timing block records its exact text without an added newline. Comparison removes only
the accepted header and checks the error status and server conversion exactly.
A single text block becomes a string; images become data URLs, with Kimi's image-only
wrapper. Attachment notices, dropped whitespace, changed bytes, and added notes fail
strict comparison. Kimi 2.3.2's inline-image preservation adds attachment notices,
so affected images fail even when their bytes stay unchanged. Other content types,
`structuredContent`, and `_meta` are refused at the relay before HTTP delivery. Malformed text and image blocks fail there with `unsupported_result`. Text over 50,000 characters can undergo
2,000-character line shaping and saved-output pointers; changed or truncated results
fail. Kimi spill files are not accepted.

### Claude and Z.AI result comparison

`tools/call` returns an MCP content array. If present, `isError` must be
boolean. Codemux compares it with the emitted model-bound `tool_result`,
including boolean `is_error`. The server's blocks are compared as Claude
Code 2.1.300 rebuilds them before delivery: a text block as `{type, text}`
plus a truthy `_meta` (annotations dropped); an image block whose media
type Claude inlines (PNG, JPEG, GIF, WebP) as the API's base64 image source
with the same bytes, which holds for an image within Claude's size and
dimension budgets (a larger one is resized, and its changed bytes fail the
run); audio, resource, and resource link blocks become Claude's own text
and fail the run. A single text block may be represented as its text, a
plain string, with its trailing whitespace removed (Claude Code 2.1.300
delivers error results this way); whitespace Claude adds is a change.
Other content must be deeply equal. Any unaccepted difference, unmatched IDs,
duplicate calls/results, or unknown Claude frame types fail the run.
Documented Claude notifications are recorded without becoming tool calls.

Every forwarded `tools/call` includes the native tool-use ID in
`params._meta["codemux/callId"]`. Claude and Z.AI also retain
`params._meta["claudecode/toolUseId"]` with that same ID.

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

### Shared recordings

Recordings are mode 0600 JSONL files under the codemux state directory's
`experiments/<run-id>.jsonl`, or the chosen recording directory.
Each record has `run_id`, monotonic `seq`, `kind`, and kind-specific fields.
Raw server stdin/stdout/stderr records use `bytes_base64`; control frames,
rollout or wire-log evidence, inventories, tool calls, server results, model-bound
results, comparisons, failures, and the terminal `run_end` are separate records.
They can contain prompts and tool content. They are not the prompt-free
[call ledger](results-and-usage.md).

The recording budget is 256 MiB, with failure/end records allowed afterward. A failed record write truncates the file to its previous length before rethrowing, so later records cannot append to a partial JSON fragment. Codex and Kimi use the runner's actual timeout state, tolerate only missing final usage, preserve unterminated stdout bytes in `harness_stdout_partial` without parsing them, and retain exit 124. Completed catalogs, results, and native call correlations are still checked. Ordinary completed runs with missing usage fail with `harness_log_missing`. Recordings survive cleanup. `CODEMUX_CALL_LOG=off` disables only the ledger, not evidence recordings. A relocated ledger changes the default recording state directory. `--result-json` reports the path as `codemux.recording`.

Before private-home cleanup, successful and failed Codex/Kimi runs attempt to copy the native log beside the recording as `<run-id>.codex-rollout.jsonl` or `<run-id>.kimi-wire.jsonl`. Copies use mode 0600 and a 256 MiB cap. `harness_log_copy` contains exactly `{harness, path, bytes}` on success or `{harness, path, error}` on failure, besides the common record fields. `path` names the destination. A copy error preserves the run's existing verdict.

### Normalized records

Claude, Z.AI, Codex, and Kimi recordings also contain these harness-neutral records
with the same `run_id` and `seq` fields:

```text
Usage = {"input":int,"output":int,"cache_read":int,"cache_write":int}
{"run_id":…,"seq":…,"kind":"turn","message_id":str,"t":float,"usage":Usage|null,"tool_calls":[{"call_id":str,"name":str}]}
{"run_id":…,"seq":…,"kind":"turn_usage","message_id":str,"usage":Usage,"t":float}
{"run_id":…,"seq":…,"kind":"turn_call","message_id":str,"call_id":str,"name":str,"t":float}
{"run_id":…,"seq":…,"kind":"tool_result_delivered","call_id":str,"t":float}
```

`turn` appears once per model response as soon as its native identity is available. `usage` is the counter object or null if usage is not yet known. Usage separates uncached input, output, cache reads, and cache writes; Codex uncached input is `max(0, input_tokens - cached_input_tokens - cache_write_input_tokens)`, with absent cache writes treated as zero. `turn_usage` appears exactly once per turn when usage is known, even when the turn already contains it. Its `t` is the usage event's timestamp. Missing, duplicate, or conflicting turn usage fails consistency verification with `harness_log_missing` when detected or at turn end. An exact repeated Codex snapshot after completion is a retry marker as described below.

`turn_call` appears once for every call, including calls in the initial `turn.tool_calls` snapshot. Streaming frames can add calls later, so `turn_call` is the complete call list. Its `t` is the native call event's timestamp or Claude's frame receipt time, even when a later message supplies the turn's native ID. Call IDs are native; names are the server's bare tool names.

Claude and Z.AI emit `turn` on the first assistant frame for a native `message.id`; its `usage` is always null. Experiment launches include `--include-partial-messages`. Native `message_start` and `message_delta` events supply per-message counters. Assistant counters remain supported; zero placeholders never replace real values. `turn_usage` emits the final counters at `message_stop`, ID change, or `result`; its timestamp is the last usage frame's receipt time. A completed turn without real counters or a repeated completed `message.id` fails with `harness_log_missing`. Result-envelope usage is cumulative and does not replace per-message counters. Later assistant frames can add `turn_call` records. Legacy Claude frames without `message.id` remain raw-only for turns.

Codex uses a native response message item ID or function-call item ID and never invents an ID. A response with neither fails with `message_id_missing`. Each `token_usage_record.response_id` identifies one response; overlapping IDs, repeated response IDs, or conflicting response counters fail with `harness_log_missing`. A new response ID or advanced cumulative totals means a new response, even with equal per-response counters. A `token_count` snapshot for the same completed response with equal counters and unchanged cumulative totals records `harness_retry` with that `response_id` and creates no turn or usage record. A pending response with different counters keeps waiting for its own snapshot. A conflicting idle snapshot fails with `harness_log_missing`. Codex 0.165.0 re-emits stored usage during rate-limit recovery; the [upstream path](experiment-codex-catalog.md#rollout-evidence) explains the retry sequence. Rate-limit-only events with `info: null` carry no usage. Codemux polls the rollout every 250 ms; turn and call emission does not wait for `token_count`. Usage arrives separately from that event. A nonempty `tools/call` request `_meta.callId` is used immediately, copied to `_meta["codemux/callId"]`, and recorded on `tool_call` with `native_call_id_source: "request_meta"`. Live and final rollout verification checks its ID, name, and arguments independently of HTTP arrival order. Without request metadata, resolution waits up to five seconds for matching native call evidence in arrival order, without waiting for usage. Unresolved calls fail before dispatch.

Kimi uses the stable native step UUID as `message_id`. The first `tool.call` emits the turn; content-first turns wait for a call or successful step end and retain the first-content timestamp. Provider retries emit no turn, including partial responses. Every call emits `turn_call`. `step.end` emits `turn_usage` with its own timestamp. A provider `messageId` remains optional raw evidence; a present malformed value fails with `protocol`. Kimi maps `inputOther`, `output`, `inputCacheRead`, and `inputCacheCreation` to the four counters. Native call resolution waits for wire evidence, without waiting for usage.

`tool_result_delivered` marks appending a result to the model context:
receipt of Claude's user frame or the timestamp of Codex's rollout
`function_call_output`, or Kimi's `tool.result` loop event. `t` is Unix epoch
seconds as a float. Claude uses codemux's receipt clock; Codex and Kimi use their native log timestamps. These records do not establish when a provider processed the result.

### Failure codes

An experiment failure records a stable `code` in both `failure` and terminal
`run_end` records. Stderr prints the failure diagnostic once in this format:

```text
codemux: experiment failure [<code>]: <message>
```

`--result-json` reports the same code as `codemux.failure_code`. Its type is
`string | null`; success and non-experiment runs report null.

| Code | Meaning |
|---|---|
| `call_id_unresolved` | A call could not be matched to its native harness call ID before dispatch. |
| `result_changed` | The model-bound result differs from the accepted server result. |
| `unknown_tool` | The harness called a tool outside the validated experiment inventory. |
| `model_required` | A Codex experiment omitted explicit `-m`. |
| `model_unavailable` | The account's Codex catalog lacks the requested slug. The diagnostic names its cache path, `fetched_at`, and listed slugs; Codex itself cannot run that model for this account. |
| `code_mode` | Codex catalog evidence is unusable, a catalog override cannot coexist with an active provider override, an override exceeds its cap or was not fetched before the first function call, or the rollout calls a refused `exec` through `function_call` or `custom_tool_call`. |
| `inventory_mismatch` | The advertised inventory or a later definition recheck differs from the validated inventory. |
| `harness_log_missing` | Required harness log evidence is missing, unreadable, incomplete, or invalid. |
| `message_id_missing` | A required native response identity is absent or malformed: Claude and Z.AI require a valid assistant `message.id` when present; Codex requires a message item ID or function-call item ID; Kimi requires a stable native step UUID. |
| `server_error` | The experiment server failed or returned a JSON-RPC error. |
| `unsupported_result` | The server returned a result shape the harness path cannot preserve. |
| `protocol` | Other malformed, duplicate, incomplete, or inconsistent protocol evidence was observed. |

Shutdown stops the server process tree, bounds pipe drainage, finalizes the
recording, and reports incomplete capture or cleanup. A protocol failure
remains a failure even if the child exits zero. Unexpected synchronous exit emits `failure` before `run_end` with the same protocol code and message. Every interrupted Kimi experiment records `protocol`: `interrupted before harness evidence` before stdout, or `interrupted before verification` afterward. Stopping evidence collection cannot count as successful verification.

## Verification

`check --hermetic --tools none --experiment-mcp <spec.json>` extends the
paired canary for Claude, Z.AI, and Kimi. Kimi plants its instruction in a
scratch brand home and keeps the working directory clean. The hermetic
probe keeps the experiment spec exactly as a run would. Its non-hermetic
control keeps that spec and tools selection, reads the planted home instruction, and must reveal the code word.
Kimi passes the planted `KIMI_CODE_HOME` to the control. Its experiment `mcp.json` stays in that home. After cleanup, the check verifies that the planted brand home is absent before reporting OK.
The operator's real brand home receives no experiment config. The existing canary verdict and control reporting apply. Recordings distinguish the control with a
`.control.jsonl` suffix. Codex supports `run` only; its paired
`check` is refused before installation checks or a model request because
the control requires a non-hermetic run.
The paired canary tests the specified channels against a positive control,
not prompt-only reproducibility or every possible upstream customization.
See the dated [experiment investigation](experiment-mcp-report.md) and
[testing instructions](TESTING.md). The rebuild runs fixture tests only;
it does not claim fresh live-provider evidence. Codex's relay and rollout
contract is grounded in CLI 0.165.0 source and synthetic fixtures. Historical
Codex refusal evidence in the investigation predates the explicit header
opt-in. Kimi's relay, naming, tool policy, and reconstructed projection are
grounded in Kimi Code 2.3.2 source. The October 29 live probes established
the Kimi header and Codex code-mode call. The 01:41 Codex probe called tool search;
the 01:58 probe called the experiment tool directly and reached the relay, then failed while waiting for usage. The preserved `gpt-6-astra` probe completed delivery and now verifies by replay. No new live probe was run for these fixes.
