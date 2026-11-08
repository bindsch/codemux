---
read_when: "Checking the experiment MCP server contract, flags, or recordings."
---
# Experiment MCP

`run --experiment-mcp <spec.json>` connects one experiment-owned stdio MCP server with `-a claude`, `-a zai`, `-a codex`, or `-a kimi`. It requires `--hermetic --tools none --auto read-only`, scode, and no Playwright MCP. Claude and Z.AI use Claude Code's SDK control bridge. Codex and Kimi use a loopback HTTP relay and require explicit result-header opt-ins. Other adapters refuse before reading the spec or starting a model.

The server runs **outside scode** with only the environment names in the spec. Its command and arguments are operator-controlled. The harness remains inside read-only scode. Hermetic mode excludes operator-configured MCP integrations; this explicitly requested server is the exception.

## Specification

The file must be valid UTF-8 JSON, at most 64 KiB, and a single object with
exactly these supported fields. Unknown properties, including `control`, fail.

| Field | Required | Validation |
|---|---|---|
| `name` | Yes | String matching `[A-Za-z][A-Za-z0-9_-]{0,63}`; 1–64 ASCII characters |
| `command` | Yes | Absolute executable path, no NUL |
| `args` | Yes | Array of strings without NUL; may be empty |
| `env` | Yes | Array of unique names matching `[A-Za-z_][A-Za-z0-9_]*`; every named variable must be set |
| `recording` | No | Nonempty directory path without NUL; relative to the spec's directory; existing non-directory, symlinked leaf, or foreign-owned directory rejected; symlinked ancestors resolved before creation; mode forced to 0700 |
| `tool_timeout_seconds` | No | Positive integer, default 7200, maximum 86400; private Codex and Kimi tool-call timeout |
| `accept_harness_prefix` | No | Array of unique strings: `"codex-wall-time"` and `"kimi-wall-time"`. Each harness requires its own value; ignored on Claude/Z.AI |

The command must be a trusted regular executable owned by the user or root, not group/world writable, and outside the execution cwd. No shell is inserted. Claude and Z.AI prompts must fit a 1 MiB serialized control frame, including escaping and wrapper. Codex uses a 16 MiB stdin limit; Kimi uses a 32 KiB argv bound.

## Runnable fixture example

The repository ships a sanitized server at [`tests/fixtures/experiment-mcp.ts`](../tests/fixtures/experiment-mcp.ts). Its `bash` tool returns a fixed marker and executes no command. With `command: "hold:<milliseconds>"`, it waits for that duration, up to 3600000 ms, then returns the marker. The fixture also supports intentional failure cases for tests; use the prompt below.

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

This last command is a real model request and consumes quota. A trusted Bun installation outside the checkout is required. Server code is supplied as an explicit argument; the experiment operator is responsible for that code. The recording directory above resolves to `scratch/recordings/`.

For Codex, add `"accept_harness_prefix": ["codex-wall-time"]` to the spec and select `-a codex -m <cached-model-slug>` using the cache described below. For Kimi, add `"accept_harness_prefix": ["kimi-wall-time"]` and select `-a kimi`.

Omitting the harness's prefix refuses the run before launch. Unknown prefixes, duplicate entries, and non-array values fail spec validation. Codex requires CLI 0.165.0 or later; Claude/Z.AI require Claude Code 2.1.280 or later. Kimi requires Code 2.3.2 or later and a clean working directory as described in [isolation](isolation.md).

## Protocol and recordings

The server speaks newline-delimited JSON-RPC 2.0. Responses must match pending
request IDs (strings or safe integers) and contain exactly one of result/error.
The transport permits at most 256 pending requests, including held calls. Request/response and Claude
control frames are limited to 1 MiB. This prompt bound applies only to Claude and Z.AI. Codex retains its 16 MiB stdin prompt limit; Kimi retains its 32 KiB argv bound. A server notification with method
`notifications/tools/list_changed` and no `id` is recorded as
`server_notification`. The bridge rechecks the full paginated `tools/list`
against the validated inventory and records `tool_inventory_recheck` with
`equal` and both definition sets (`previous` and `current`). Recheck requests
have their own `mcp_request` records. Deep-equal definitions allow the run to
continue; changed definitions fail the run. The notification never reaches
Claude, and call responses still resolve by their pending request IDs.
Every other server-initiated message, including `notifications/progress`,
sampling, elicitation, and requests with an `id`, is refused. Forwarded JSON-RPC errors
are fatal. Claude and Z.AI forward `ping` and also fail on its errors.

`tools/list` must produce a complete nonempty inventory, following pagination
without repeated cursors and within 100 pages; a server whose pagination
exceeds that bound fails the run instead of being collected without end.
Tool names are unique, match `[A-Za-z0-9_-]{1,64}`,
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

Each `/mcp` POST must carry one JSON-RPC object. The route matches its path
without a query string — a client appending `?session_id=…` still reaches
it, and the recorded `http_request` entry keeps the full URL. Arrays fail with HTTP 400; missing
or incorrect authorization gets 401; GET and DELETE get 405; a body over
1 MiB gets 413. Fast `tools/call` replies and successful replies to other JSON-RPC methods use HTTP 200 with `application/json`. A tool call still pending after two seconds starts HTTP 200 with `Content-Type: text/event-stream`, `Cache-Control: no-cache`, and `Connection: keep-alive`. The relay writes `: keepalive` comments every 15 seconds, then one `event: message` whose `data` is the JSON-RPC response, and ends the stream. GET remains 405.
Valid notifications get HTTP 202 with no body. A `tools/call` notification lacks a required request ID, so it gets HTTP 400 and fails with `protocol` before dispatch. Non-object `arguments`, including explicit null, also get HTTP 400 and `protocol` before dispatch. Omitted arguments become `{}` in both native correlation and the forwarded request. The Claude bridge applies the same argument rules.
Malformed authenticated JSON or JSON-RPC envelopes also return HTTP 400 and fail the run with `protocol`.
HTTP 413 headers are flushed immediately; rejected uploads drain only until the original 30-second request deadline. HTTP 408 closes without another drain period.
The 30-second deadline covers request-body receipt only. The relay sets `requestTimeout = 0`, `timeout = 0`, `headersTimeout = 120000`, and `keepAliveTimeout = 86400000`. A regression test checks the running server object for `requestTimeout === 0`, `timeout === 0`, and `keepAliveTimeout >= 86400000`. `ExperimentServer.request()` has no pending-request deadline. The private tool timeout and the run's `--timeout` remain configured bounds; the harness or host can terminate a hold earlier.

The relay answers `ping` locally with `{jsonrpc: "2.0", id, result: {}}` and records `relay_ping` with `rpc_id` and `t`. A synchronous stdio server can block on a held tool call, leaving a forwarded ping unanswered past Kimi's five-second liveness deadline. The Claude/Z.AI bridge continues forwarding pings.
The relay caches the original successful `initialize` result. A later `initialize` replays that result with the new request ID and records `relay_reinitialize` with `rpc_id` and `t`. It does not restart the server or clear pending tool calls. The fixture schedules `hold:<ms>` replies with a timer, so its stdin loop keeps answering other requests, including pings.

For either relay harness, a retry requires the same tool name, deeply equal arguments, and no distinct native identity. The prior matching pending request's own HTTP connection must already be closed by the client. A distinct Codex `_meta.callId` starts a new call. Reusing the same ID still requires the abandoned connection. Identical requests with open connections are legitimate concurrent calls. They dispatch separately and match native calls FIFO when no native ID distinguishes them. A retry can attach while native resolution is pending and reuses the original native call ID. Its `tool_call` record has `correlation: "retry"`, the original and retry IDs in `rpc_ids`, and the shared `relay_request_seq`.

The completed-result cache serves only calls whose delivery recorded `relay_delivery_failed` because the client closed the connection. It never replays delivered calls. The cache is scoped to the run, and successful delivery consumes the cached result. A cached retry records `correlation: "retry_cached"` with the same `rpc_ids` and `relay_request_seq` joins. Each delivered HTTP request has one `call_ledger` with the shared sequence and content hash. A client-closed connection records `relay_delivery_failed` with `rpc_id`, `relay_request_seq`, and `message` without failing the run. A delivery whose close itself throws fails the run with `protocol`, naming the close error, instead of surfacing an unhandled rejection.

The supplied October 29, 2026 Kimi 2.4.0 recording from 21:57 (`4a844cd5-a72e-465d-a667-a773f9d9d65c`) shows a second hold failure after the blocked-stdin fix. Its first `tools/call` POST, ID 2, arrived at `t=1793307080.048`. Kimi resent the same arguments with ID 4 at `t=1793307381.396`, 301.348 seconds later and 313.264 seconds after run start. No second native `tool.call` appeared, so the old relay failed with `call_id_unresolved`. The wire log records `fetch failed` and `durationMs: 306424` at `1793307386471` ms. `toolTimeoutMs: 7200000` did not fire. The compiled Kimi runtime's fetch response-start timeout is about 300 seconds, while local Bun 1.4.4 survives a 320-second delayed response. This explains the Atomix sweeps' roughly 300-second cutoff. Codemux cannot set that Kimi runtime timeout, so delayed replies use SSE. Evidence is in `scratch/session-14c66a93/exp/probe/recordings/4a844cd5-a72e-465d-a667-a773f9d9d65c.jsonl` and its `.kimi-wire.jsonl` copy. No fresh live probe was run for this change.

Inventory validation and definition rechecks use the same rules as Claude.
The relay records `http_request` with method, path, token match, and base64 body bytes. `http_response` records status and base64 response bytes. Accepted bodies have `body_complete: true`.
An oversized body stops at the first chunk past the limit. Its recorded prefix has `body_complete: false`, then the connection closes after HTTP 413. Authentication precedes body reads. Invalid methods get 405 before body reads. An authenticated oversized `Content-Length` gets 413 before body reads. A body must complete within 30 seconds or it gets 408 and the connection closes. An unauthorized request gets HTTP 401 and only an `http_request` record with empty body bytes and `body_complete: false`. Its disconnect cannot fail the experiment.

### Codex delivery evidence

Codex experiments require an explicit `-m`; omission fails with `model_required`.
Before launch, Codemux reads the real `CODEX_HOME/models_cache.json`, bounded
at 2 MiB. The populated cache must contain the requested slug. Defaults and
bundled fallback slugs are not used. A cache whose `client_version` differs
from the detected Codex version is served anyway, with a stderr warning and a
`catalog_client_version_mismatch` record naming both versions: the cache is
shared by every Codex client on the machine, and the ChatGPT desktop app's
app-server daemon (0.166.0 on 2026-11-02) rewrites it about hourly while the
CLI is 0.165.0, so an equality rule refused every experiment the daemon had
touched. The served catalog body is recorded either way.
A slug absent from the account's catalog fails with `model_unavailable`;
the diagnostic names the cache path, `fetched_at`, and listed slugs.
With `--result-json`, preflight failures `model_required`, `model_unavailable`, and `code_mode` return the failure envelope with `recording: null` because no recording has been created.

Every Codex experiment serves a sanitized catalog, including direct, omitted, and null tool modes. For every served model, Codemux deletes `tool_mode` and `multi_agent_version`, removes only `clock` from `experimental_supported_tools`, and sets `apply_patch_tool_type` to null. Other fields stay unchanged. It serves `{"models":[...]}` with a 1 MiB response cap, falling back to the requested entry alone if necessary. That entry exceeding the cap fails with `code_mode`. The real cache is unchanged.

This token-free config selects a custom provider. It has no
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
for reserved IDs, metadata, cyber access, and defaults. Every experiment refuses an active `CODEMUX_CODEX_PROVIDER_*` override before private config writes.
Experiment flags disable `code_mode`, `code_mode_host`, `sleep_tool`, `current_time_reminder`, `multi_agent`, `multi_agent_v2`, `send_message_to_user_async`, `request_permissions_tool`, `token_budget`, and `deferred_executor`, in addition to the existing shell, image, browser, and plugin controls. They set `multi_agent_v2.disable_native_tools=true`, `tools.update_plan.enabled=false`, and `tools.experimental_request_user_input.enabled=false`. See [all built-in names, removal switches, and source registrations](experiment-codex-catalog.md#native-tool-removal-and-startup-check).
Every run sets `omit_tools_from = ["deferred", "code_mode"]` in the private `[mcp_servers.<name>]` table. `run_start.omit_tools_from` records the same list.
Finding, October 29, 2026: Codex `rust-v0.165.0` subtracts these surfaces before deferral, leaving only `direct` in the initial tool list (`codex-rs/core/src/tools/spec_plan.rs:255-287`). The server field is at `codex-rs/config/src/mcp_types.rs:266-269`; the serialized surface names are at `codex-rs/protocol/src/config_types.rs:396-407`.
With no searchable deferred tools, the builder omits tool search (`codex-rs/core/src/tools/spec_plan.rs:392-417,454-461`). An unexpected call fails with `unknown_tool`, names the tool, and reports an exposure policy change. See the [dated source finding](experiment-codex-catalog.md#direct-mcp-exposure).

Each experiment declaration must match the relay description (absent means `""`) and set `strict: false`. Its `parameters` must be a recursive subset of the original relay `inputSchema`: retained keys, indices, and values stay at the same paths; only object keys and array suffix entries may be omitted. Additions, changed values, or shifted indices fail with `inventory_mismatch`. Each declaration records omitted JSON Pointer paths in `catalog_pruned_paths`. Codemux does not reproduce Codex schema lowering, pruning, compaction, or byte budgets. See the [catalog contract and direct-renderer source](experiment-codex-catalog.md#built-in-declarations).

The 14 historical Codex 0.165.0 built-in declarations remain accepted for saved-rollout replay and recorded as `builtin`. Live dispatch first requires `world_state.state.top_level_tools` to contain only qualified experiment tools and `functions.list_mcp_resources`, `functions.list_mcp_resource_templates`, and `functions.read_mcp_resource`, with their namespace headers. One tool appears under at most one accepted spelling, the resource trio included: two spellings of one callable, such as `mcp__experiment.lookup` beside `mcp__experiment__lookup`, fail with `inventory_mismatch`. `harness_top_level_tools` records the raw `tools` map and native `t`. Extra names fail with `inventory_mismatch` and terminate before dispatch. All `tools/call` requests, including `_meta.callId` requests, wait within the existing five-second native-ID deadline; missing inventory evidence fails with `harness_log_missing`. See the [historical declarations and complete restricted list](experiment-codex-catalog.md#built-in-declarations).

The resource trio is unavoidable when Codex has an MCP server. The relay answers `resources/list` with `{"resources":[]}`, `resources/templates/list` with `{"resourceTemplates":[]}`, and `resources/read` with error `-32002`, message `no resources`, without forwarding or failing the run. It records `relay_resources` with `method`, `rpc_id`, and `t`. Native trio calls record `harness_builtin_call` with `call_id`, qualified `name`, `input`, exact `harness_output`, and common `t`, then continue outside experiment-call and model-error counts. Final verification fails with `harness_log_missing` when a rollout trio call has no matching exec-stream completion (review round 110), the same rule relay calls already followed; the one exemption is the harness's own unsupported-call refusal as the call's whole output, where nothing executed and no completion can exist. Every other built-in call fails with `unknown_tool` even if undeclared or paired with an unsupported-call error.

A refused `exec` call fails with `unknown_tool` for either `function_call` or `custom_tool_call`; an inventory function named `exec` remains allowed.
An override run also fails with `code_mode` if Codex has not fetched the catalog before call ID resolution and dispatch, including requests with `_meta.callId`. A fetch counts only once the whole catalog response finished, and stops counting if the client then resets the connection with the body unread (`catalog_fetch_reset`); a transfer the client abandons leaves the catalog unserved.

The preserved October 29, 2026 `gpt-6-astra` excerpt verifies delivery with an explicitly synthetic restricted world state, and an unmodified preserved rollout is rejected for its visible built-ins; the same day a live Atomix run exposed restricted built-in tools, which motivates the startup check. The dated findings and preserved-rollout provenance are [delivery evidence](archive/experiment-evidence.md#codex-delivery-findings); see the [Codex catalog contract](experiment-codex-catalog.md).

### Kimi configuration and delivery evidence

Codemux writes the relay URL and bearer header into a private mode 0600
`mcp.json`, containing only `mcpServers.<spec.name>`. The token stays out of
argv and the child environment. The private home, config, empty skill
directory, explicit agent profile, and project-path refusals follow the
Kimi hermetic contract in [isolation](isolation.md).

Every hermetic Kimi child sets `KIMI_CODE_NO_AUTO_UPDATE=1` and never updates the installed binary, and `KIMI_CODE_REPEAT_BREAKER=false` so kimi never appends its repeated-call reminder to a tool result (seen live on 2026-10-30 in a lock-holding run: the reminder made the model-bound result differ from the server's and failed the run as result_changed).
This disables both the startup update check and background installation, for experiment and ordinary runs.
Plain runs, including non-hermetic check controls, may still update the binary. Record the Kimi version used in the live-gate notes.

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
  "startupTimeoutMs":120000,"toolTimeoutMs":7200000
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
A built-in call fails the run. An unknown name with Kimi's own error result follows the `model_tool_error` rule below.
Codex writes `tool_timeout_seconds` as `tool_timeout_sec` and keeps `startup_timeout_sec = 120`. Kimi writes seconds multiplied by 1000 to both `mcp.json`'s `toolTimeoutMs` and private `config.toml`'s `[mcp] tool_timeout_ms`. In Kimi 2.3.2, `app/mcpConfig/configSection.ts:9-12` defines the global setting, `mcpCore/connection-manager.ts:444-445` chooses server `toolTimeoutMs` over that default, and `mcpCore/client-http.ts:113-114` passes the selected `toolCallTimeoutMs` to the SDK. These paths are under `packages/agent-core-v2/src/`.
Both Codex and Kimi record the effective integer in `run_start.tool_timeout_seconds`, including the default 7200. Hermetic Kimi launches use `env -u` to remove `KIMI_MCP_TOOL_TIMEOUT_MS` and `KIMI_MCP_STARTUP_TIMEOUT_MS`, so the private configuration supplies these settings.
Kimi's tool executor catches an MCP timeout and emits an error tool result; the turn can continue and print a resume hint. A turn that ends in error throws before printing that hint. Wire `tool.result` timeout errors or timeout-bearing error steps fail with `server_error` and `kimi tool call timed out after N ms`, before a missing-hint or closed-stdout diagnostic. A server exit triggers shutdown immediately. Before recording its failure, Codemux waits for Kimi to exit and polls the wire log every 25 ms until its size stays unchanged for 100 ms, bounded at one second. A late native timeout takes precedence over the generic server-exit message. So does the first substantive failure found during the flush wait, such as wire-log corruption the final poll sees; only the native timeout outranks it. An earlier unrelated failure retains precedence. Source: `agent/toolExecutor/toolExecutorService.ts:539-552` and `apps/kimi-code/src/cli/v2/run-v2-print.ts:356,652-656,770-773` in Kimi 2.3.2.

Kimi qualifies tools as `mcp__<server>__<tool>`, replacing characters outside `[A-Za-z0-9_-]` with `_` and collapsing underscore runs within each part (`mcpCore/tool-naming.ts`). Codex replaces every character outside `[A-Za-z0-9_]` in the qualified name with `_`, preserving underscore runs (`codex-mcp/src/mcp/mod.rs:601`).
The shared inventory validator checks both sanitizers for every harness before exposing tools, including collisions across pages. Thus `foo__bar` / `foo_bar` collide under Kimi, while `foo-bar` / `foo_bar` collide under Codex. Both fail with `inventory_mismatch`.
Codemux matches each harness's qualified name and records the server's bare name. Kimi's profile pattern and evidence parser share the same sanitizer, which collapses every underscore run. The shared 64-character namespaced bound keeps experiment names below Kimi's hash-shortening threshold.

Codemux tails the private session's `wire.jsonl` every 250 ms during the run. Each `tools/call` waits up to five seconds for an unmatched native `tool.call` with the same qualified name and deeply equal arguments. HTTP arrival order may differ.
Kimi resolves an initial dispatch against the earliest unmatched native call. Ambiguous matches use `correlation: "fifo"` on `tool_call` and `tool_call_identified`; unambiguous matches use `correlation: "exact"`. These labels describe native attribution when the dispatch is identified. Retry attachments reuse that attribution and share its result, including after completion. Native evidence verification assigns each FIFO-group delivery one unused server result in that group. Separate groups cannot share results. An exact call must match its own result. `result_comparison.server_relay_index` identifies the matched server result for FIFO groups. Initial Claude and Codex dispatches retain native-ID correlation.
The forwarded request carries its native `toolCallId` as `params._meta["codemux/callId"]`. Unresolved calls fail before server dispatch.
A call Kimi rejects itself for arguments that fail the tool's schema never reaches the server: the wire records `args: {}`, the loop result is an `Invalid args for tool "<name>"` error, and the model receives that error. Codemux records it as `harness_invalid_args`, and the final native check accepts the assistant message's unparseable `arguments` string for that call only, recording `native_arguments_malformed` with the byte count and the parse error. The 2026-11-02 hold probe (recording `23a82a67-6520-4115-b126-e034b17b21d5`) saw Kimi 2.4.0 reject a 14 KB unterminated argument string 13 times before the model sent a shorter one; the run's two markers were correct, and the previous check failed the whole run on the first rejected call. Unparseable arguments on a call Kimi ran are still a `protocol` failure.
The first `tool.call` emits a turn. Content-first turns retain the first `content.part` timestamp
and wait for a call or successful `step.end`. A `content.part` after a step that already carried
content or calls before its `step.end` fails with `protocol`: the end finalizes what the final
assistant-message comparison checks. The early-usage shape — `step.end` arriving before the
step's first content — still flushes its parts after the end and emits its turn from them.
`step.end` emits usage; `tool.result` emits delivery.
An error step without usage and without calls records `harness_retry` with its UUID in `message_id`, including partial provider responses. It emits no turn and consumes no completed assistant message. An error step with calls emits a turn and fails later with `harness_log_missing` if usage is absent.
Final verification requires `sessions/<workspace>/session_<id>/agents/main/wire.jsonl` to match the native session hint.
It uses the same cursor and checks the complete wire log against server results and turn-end assistant/tool messages before cleanup. Stdout assistant call IDs, qualified names, and parsed arguments must match wire `tool.call` evidence. Missing, duplicate, or contradictory declarations fail with `protocol`. Assistant, tool, and resume-hint frames use the session parser grammar.
Missing, duplicate, inconsistent, or incomplete evidence fails the run, except missing final usage on an actual timeout as described below.
The native log is copied before private-home cleanup. The recording closes after cleanup, so a cleanup error produces a `failure` record and the same failure code in `run_end`. Capture failures preserve complete prefix events and replies before malformed or truncated lines. The failure result names the parse error and retains the session ID, effective model, and usage when the wire log is readable. The paired check validates its generated control before either probe starts. It adds `KIMI_CODE_HOME` only when absent and refuses a control that would exceed the 64-name environment limit.

Kimi's model-bound bytes are **reconstructed**, unlike Claude's observed frames and Codex's rollout output item. The wire log does not contain the provider request. Codemux reproduces Kimi 2.3.2's `agent/contextMemory/toolResultRender.ts` and `agent/contextProjector/projection.ts`, using raw tool-message content and the loop result's `isError`, `durationMs`, and `note`. The producer is `agent/loop/loopService.ts`; `agent/contextMemory/loopEventFold.ts` attaches these fields. These paths are under `packages/agent-core-v2/src/`.

The October 29, 2026 source comparison of tags `@moonshot-ai/kimi-code@2.3.2` and `@moonshot-ai/kimi-code@2.4.0` keeps the experiment floor at 2.3.2. The renderer, projection, MCP output conversion, wire event contracts, prompt renderer, and MCP schema are unchanged. `loopService.ts` adds logging and a ten-minute warning watchdog (`2.4.0:133-134,1140-1195,1263,2124`); its result producer is unchanged (`1790-1810`). `loopEventFold.ts` adds a mutable sink (`229-366`), retaining the result-field mapping (`193-208`). `run-v2-print.ts` changes telemetry, Plan mode handling, and workspace leases (`273-283,441-451,474,495,522-528,554-571`), while retaining completion/error and resume-hint behavior (`633-685,361`). `mcpCore/connection-manager.ts` adds probing and reconnect states (`484-660,725-779`); timeout precedence (`793-794`) and tool mapping (`868-875`) remain equivalent. `workspace/sessionLifecycle/sessionLifecycle.ts:8,10` and `sessionLifecycleService.ts:348,358-412,429-442` add reclaim reasons and lifecycle telemetry without changing the wire-log contract. These are source checks, not a successful live 2.4.0 delivery check.

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

Claude Code 2.1.300 replaces an oversize result in one of two forms — a
token-limit form for one text block and a persisted form for any number of
text blocks — and a spill is accepted only when the delivered string equals
Claude's message exactly and the saved file equals the server result.
Accepted spills record `spill_kind` (`token` or `persisted`); rejected ones
record `spill_rejected` naming the failed check. The exact message templates,
locale-count rules, path and slug layout, and file-read bounds are
[renderer evidence](archive/experiment-evidence.md#claude-and-zai-oversize-result-spills).

### Shared recordings

Recordings are mode 0600 JSONL files under the codemux state directory's `experiments/<run-id>.jsonl`, or the chosen recording directory. Each record starts with `run_id`, monotonic `seq`, `t` (Unix epoch seconds as a float), and `kind`, followed by kind-specific fields. The recorder supplies codemux's current time when `t` is absent. Existing `t` values on `turn`, `turn_usage`, `turn_call`, `tool_result_delivered`, and `call_ledger` are preserved, including native-event and frame-receipt times.

Raw server stdin/stdout/stderr records use `bytes_base64`; control frames, rollout or wire-log evidence, inventories, tool calls, server results, model-bound results, `call_ledger`, comparisons, failures, and the terminal `run_end` are separate records. They can contain prompts and tool content. They are not the prompt-free [call ledger](results-and-usage.md).

The recording budget is 256 MiB, with failure/end records allowed afterward. A failed record write truncates the file to its previous length before rethrowing, so later records cannot append to a partial JSON fragment. Codex and Kimi use the runner's actual timeout state, tolerate only missing final usage, preserve unterminated stdout bytes in `harness_stdout_partial` without parsing them, and retain exit 124. Completed catalogs, results, and native call correlations are still checked. Ordinary completed runs with missing usage fail with `harness_log_missing`. Recordings survive cleanup. `CODEMUX_CALL_LOG=off` disables only the ledger, not evidence recordings. A relocated ledger changes the default recording state directory. `--result-json` reports the path as `codemux.recording`.

Before private-home cleanup, successful and failed Codex/Kimi runs attempt to copy the native log beside the recording as `<run-id>.codex-rollout.jsonl` or `<run-id>.kimi-wire.jsonl`. Copies use mode 0600 and a 256 MiB cap. `harness_log_copy` contains exactly `{harness, path, bytes}` on success or `{harness, path, error}` on failure, besides the common record fields. `path` names the destination. A copy error preserves the run's existing verdict. Test runs scan every file the run produced in the recording directory (the JSONL recording and the harness-log copies) for the bytes `Bearer ` and the run's catalog nonce, so a harness that started logging its MCP transport would fail the test suite rather than persist the relay secret. A live check of a real recording greps the same two strings: `grep -F 'Bearer ' <recording>.jsonl <run-id>.codex-rollout.jsonl <run-id>.kimi-wire.jsonl` and the same with the nonce from the run's `model_catalog_url` (`/catalog/<nonce>`), expecting no match.

### Normalized records

Claude, Z.AI, Codex, and Kimi recordings also contain these harness-neutral records
with the same common fields:

```text
Usage = {"input":int,"output":int,"cache_read":int,"cache_write":int}
{"run_id":…,"seq":…,"t":float,"kind":"turn","message_id":str,"usage":Usage|null,"tool_calls":[{"call_id":str,"name":str}]}
{"run_id":…,"seq":…,"t":float,"kind":"turn_usage","message_id":str,"usage":Usage}
{"run_id":…,"seq":…,"t":float,"kind":"turn_call","message_id":str,"call_id":str,"name":str}
{"run_id":…,"seq":…,"t":float,"kind":"tool_result_delivered","call_id":str}
{"run_id":…,"seq":…,"t":float,"kind":"call_ledger","relay_request_seq":int|str,"native_call_id":str|null,"dispatched_t":float,"delivered_t":float,"correlation":"exact"|"fifo"|"request_meta"|"retry"|"retry_cached","rpc_id":int|str,"result_sha256":str}
{"run_id":…,"seq":…,"t":float,"kind":"relay_ping","rpc_id":int|str}
{"run_id":…,"seq":…,"t":float,"kind":"relay_reinitialize","rpc_id":int|str}
{"run_id":…,"seq":…,"t":float,"kind":"relay_resources","method":str,"rpc_id":int|str|null}
{"run_id":…,"seq":…,"t":float,"kind":"harness_top_level_tools","tools":object}
{"run_id":…,"seq":…,"t":float,"kind":"harness_builtin_call","call_id":str,"name":str,"input":unknown,"harness_output":unknown}
{"run_id":…,"seq":…,"t":float,"kind":"relay_sse","rpc_id":int|str,"keepalives":int}
{"run_id":…,"seq":…,"t":float,"kind":"relay_delivery_failed","rpc_id":int|str,"relay_request_seq"?:int,"message":str}
```

`call_ledger` records one delivered request with exactly seven fields beyond the common `run_id`, `seq`, `t`, and `kind`. `relay_request_seq` is the zero-based dispatch ordinal for Codex/Kimi, or the string control-request ID for Claude/Z.AI. `rpc_id` is the harness's JSON-RPC request ID. Request identity remains independent of native attribution: `native_call_id` is a string or null, and `correlation` records `exact`, `fifo`, `request_meta`, `retry`, or `retry_cached`. Codex, Claude, and Z.AI can use request metadata. Initial HTTP dispatches require native resolution; retries reuse it. `relay_ping`, `relay_reinitialize`, `relay_resources`, `harness_top_level_tools`, `harness_builtin_call`, `relay_sse`, and `relay_delivery_failed` do not count as delivered calls. `relay_sse` records the request ID, keepalive count, and time. `relay_delivery_failed` has the request ID, an optional dispatch sequence, and the error message.

`dispatched_t` is captured before forwarding to the server. `delivered_t` is captured when the SSE result data is written, on JSON HTTP response `finish`, or after writing the Claude control response. Both are Unix epoch seconds as floats. This records transport delivery. SSE headers and keepalive comments do not count as result delivery. `tool_result_delivered` records separate model-context evidence. `run_end.calls_delivered` counts emitted `call_ledger` records, including successful retry deliveries.

`result_sha256` is the lowercase hexadecimal SHA256 of canonical JSON for the server's `result.content`, encoded as UTF-8. Recursively sort object keys in JavaScript UTF-16 code-unit order, preserve array order, and use JSON serialization for strings and primitives. Match an original `mcp_request` by `rpc_id` and `relay_request_seq`. Retry `rpc_ids` join the same dispatch through `tool_call` attachments. Match `server_tool_result` by `relay_request_seq` and `result_sha256`. These server-result records gain both fields and retain existing `relay_index` or `tool_use_id` fields where applicable.

`turn` appears once per model response as soon as its native identity is available. `usage` is the counter object or null if usage is not yet known. Usage separates uncached input, output, cache reads, and cache writes; Codex uncached input is `max(0, input_tokens - cached_input_tokens - cache_write_input_tokens)`, with absent cache writes treated as zero. `turn_usage` appears exactly once per turn when usage is known, even when the turn already contains it. Its `t` is the usage event's timestamp. Missing, duplicate, or conflicting turn usage fails consistency verification with `harness_log_missing` when detected or at turn end. An exact repeated Codex snapshot after completion is a retry marker as described below.

`turn_call` appears once for every call, including calls in the initial `turn.tool_calls` snapshot. Streaming frames can add calls later, so `turn_call` is the complete call list. Its `t` is the native call event's timestamp or Claude's frame receipt time, even when a later message supplies the turn's native ID. Call IDs are native; names are the server's bare tool names.

Claude and Z.AI emit `turn` on the first assistant frame for a native `message.id`; its `usage` is always null. Experiment launches include `--include-partial-messages`. Native `message_start` and `message_delta` events supply per-message counters. Assistant counters remain supported; zero placeholders never replace real values. `turn_usage` emits the final counters at `message_stop`, ID change, or `result`; its timestamp is the last usage frame's receipt time. A completed turn without real counters or a repeated completed `message.id` fails with `harness_log_missing`. Result-envelope usage is cumulative and does not replace per-message counters. Later assistant frames can add `turn_call` records. Legacy Claude frames without `message.id` remain raw-only for turns.

Codex uses a native response message item ID or function-call item ID and never invents an ID. A response with neither fails with `message_id_missing`. Each `token_usage_record.response_id` identifies one response; overlapping IDs, repeated response IDs, or conflicting response counters fail with `harness_log_missing`. A new response ID or advanced cumulative totals means a new response, even with equal per-response counters. A `token_count` snapshot for the same completed response with equal counters and unchanged cumulative totals records `harness_retry` with that `response_id` and creates no turn or usage record. A pending response with different counters keeps waiting for its own snapshot. On an actual timeout, a pending response with usage but no evidence item — no assistant message, reasoning item, or function call on that turn — fails with `harness_log_missing`, the same code as the non-timeout path; a pending response with evidence but no `token_count` is still accepted. A conflicting idle snapshot fails with `harness_log_missing`. Codex 0.165.0 re-emits stored usage during rate-limit recovery; the [upstream path](archive/experiment-evidence.md#codex-rollout-evidence) explains the retry sequence. Rate-limit-only events with `info: null` carry no usage. Codemux polls the rollout every 250 ms; turn and call emission does not wait for `token_count`. Usage arrives separately from that event. A nonempty `tools/call` request `_meta.callId` is used immediately, copied to `_meta["codemux/callId"]`, and recorded on `tool_call` with `native_call_id_source: "request_meta"`. Live and final rollout verification checks its ID, name, and arguments independently of HTTP arrival order. Without request metadata, resolution waits up to five seconds for matching native call evidence in arrival order, without waiting for usage. Unresolved calls fail before dispatch.

Kimi uses the stable native step UUID as `message_id`. The first `tool.call` emits the turn; content-first turns wait for a call or successful step end and retain the first-content timestamp. Provider retries emit no turn, including partial responses. Every call emits `turn_call`. `step.end` emits `turn_usage` with its own timestamp. A provider `messageId` remains optional raw evidence; a present malformed value fails with `protocol`. Kimi maps `inputOther`, `output`, `inputCacheRead`, and `inputCacheCreation` to the four counters; an absent `inputCacheRead`, which Kimi Code 2.5.0 leaves out when nothing was read from cache, is zero, and every other missing or invalid count fails with `protocol`. Native call resolution waits for wire evidence, without waiting for usage.

`tool_result_delivered` marks appending a result to the model context:
receipt of Claude's user frame or the timestamp of Codex's rollout
`function_call_output`, or Kimi's `tool.result` loop event. `t` is Unix epoch
seconds as a float. Claude uses codemux's receipt clock; Codex and Kimi use their native log timestamps. These records do not establish when a provider processed the result.
Codex and Kimi record `model_tool_error` with `{call_id, name, input, harness_output}` when an unknown native name receives the harness's own missing-tool error. `harness_output` preserves Codex's rollout output or Kimi's loop error output. The call never reaches the experiment server. Built-ins other than Codex's resource trio still fail closed. Missing or inconsistent error evidence fails verification. `run_end.model_tool_errors` counts these records; an otherwise verified run reports `failure_code: null`.

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
| `unknown_tool` | A restricted built-in was called, or an unknown call lacked its verified harness error. |
| `model_required` | A Codex experiment omitted explicit `-m`. |
| `model_unavailable` | The account's Codex catalog lacks the requested slug. The diagnostic names its cache path, `fetched_at`, and listed slugs; Codex itself cannot run that model for this account. |
| `code_mode` | Codex catalog evidence is unusable, a catalog override cannot coexist with an active provider override, or an override exceeds its cap or was not fetched before the first function call. |
| `inventory_mismatch` | The advertised inventory or a later definition recheck differs from the validated inventory. |
| `harness_log_missing` | Required harness log evidence is missing, unreadable, incomplete, or invalid. |
| `message_id_missing` | A required native response identity is absent or malformed: Claude and Z.AI require a valid assistant `message.id` when present; Codex requires a message item ID or function-call item ID; Kimi requires a stable native step UUID. |
| `server_error` | The experiment server failed or returned a JSON-RPC error, or native Kimi evidence identified a tool-call timeout. |
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
Kimi passes the planted `KIMI_CODE_HOME` to the control and carries the planted brand home on the control request itself, so its experiment `mcp.json` and rewritten `config.toml` stay in that home by construction rather than through the planted adapter's environment. After cleanup, the check verifies that the planted brand home is absent before reporting OK.
The operator's real brand home receives no experiment config. The existing canary verdict and control reporting apply. Recordings distinguish the control with a
`.control.jsonl` suffix. Codex supports `run` only; its paired
`check` is refused before installation checks or a model request because
the control requires a non-hermetic run.
The paired canary tests the specified channels against a positive control,
not prompt-only reproducibility or every possible upstream customization.
See the dated [experiment investigation](archive/experiment-mcp-report.md) and
[testing instructions](TESTING.md). The rebuild runs fixture tests only;
it does not claim fresh live-provider evidence. Codex's relay and rollout
contract is grounded in CLI 0.165.0 source and synthetic fixtures. Historical
Codex refusal evidence in the investigation predates the explicit header
opt-in. Kimi's relay, naming, tool policy, and reconstructed projection are
grounded in Kimi Code 2.3.2 source. The October 29 live probes established
the Kimi header and Codex code-mode call. The 01:41 Codex probe called tool search;
the 01:58 probe called the experiment tool directly and reached the relay, then failed while waiting for usage. The preserved `gpt-6-astra` excerpt verifies delivery with a synthetic restricted world state; the unmodified preserved rollout is rejected. No new live probe was run for these fixes.
