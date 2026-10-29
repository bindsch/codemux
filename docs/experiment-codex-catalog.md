# Codex experiment catalog and delivery

Read this with the [experiment MCP contract](experiment-mcp.md). Codex
experiments require explicit `-m` and the spec's `codex-wall-time` opt-in.
The preserved October 29, 2026 `gpt-6-astra` probe completed direct experiment
tool delivery. Replay verifies its saved native rollout, relay result, and
exec completion. No new live probe was run for the parser fixes below.

## Cache and catalog override

Before creating the private home, Codemux reads the real
`CODEX_HOME/models_cache.json` with a 2 MiB bound. The cache must be populated,
contain exactly one entry for the requested model slug, and have a
`client_version` matching the detected Codex version. Omitting explicit `-m`
fails with `model_required`. A slug absent from the account's catalog fails
with `model_unavailable`. Its diagnostic names the cache path and `fetched_at`,
lists the catalog's listed slugs, and explains that Codex itself cannot run
that model for this account. Codex does not merge bundled models into an
account catalog that has listed models. Other unusable cache evidence fails
with `code_mode`. There is no default-model resolution, config fallback,
bundled slug list, or network catalog fetch during preflight.
These refusals use the experiment failure envelope when `--result-json` is
set. `codemux.failure_code` contains `model_required`, `model_unavailable`,
or `code_mode`; `codemux.recording` is null before preparation.

Only a requested entry marked `code_mode` or `code_mode_only` gets an override.
Codemux deletes that entry's `tool_mode` field. All its other fields and all
other model entries remain unchanged. Direct, omitted, and null modes use the
normal catalog. Unsupported modes fail. The source cache is never rewritten.

The served JSON has exactly the envelope `{"models":[...]}`. Its serialized
UTF-8 body is capped at 1 MiB. If the full catalog exceeds the cap, Codemux
serves only the requested entry and records `requested_only: true`. If that
entry alone exceeds the cap, the run fails with `code_mode`.

## Direct MCP exposure

Both direct-model and catalog-override runs write this setting in the private
experiment server table, beside its relay URL and bearer header:

```toml
[mcp_servers.<name>]
omit_tools_from = ["deferred", "code_mode"]
```

`run_start.omit_tools_from` records the same list. The setting leaves only
`direct`, which places the experiment tools in the model's initial tool list.
The requested entry keeps `supports_search_tool`; `catalog_override.removed`
remains `["tool_mode"]`.

Finding, October 29, 2026: the 01:41 `gpt-6-astra` probe fetched the override
twice and initialized and listed MCP tools through the relay. It made no
code-mode `exec` call. Its only call was `tool_search.tool_search_tool` with
`{"query":"+experiment bash","limit":1}`. That call failed with `unknown_tool`.
The probe preceded the exposure setting above. The preserved passing probe
described below used it.

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

An unexpected `tool_search`, `tool_search_tool`, or native `tool_search_call` fails with
`unknown_tool`. Its diagnostic names the qualified tool and says Codex offered
tool search instead of the experiment tools. The server table omits the
deferred surface, so this means the exposure policy changed.

### Built-in declarations

Codex also records `additional_tools` response items in its rollout. Codemux
records each catalog as `harness_tool_catalog` with its raw `tools` array,
`item`, and normalized `declarations`. Each declaration has `namespace`
(null for a flat tool), `name`, `type`, and `classification`: `builtin`,
`experiment`, or `foreign`. A rejected catalog retains its raw evidence and
the declarations checked through the first rejected entry.
Declarations must belong to the qualified experiment inventory or
the exact built-in set below. A different namespace, name, or declaration
type fails with `inventory_mismatch`, even when the tool was never called.
Each catalog must contain every experiment tool exactly once. Duplicate
declarations fail. A missing or incomplete catalog before the first
`function_call` fails with `inventory_mismatch`.
Codex `protocol/src/models.rs:1053-1061` defines the item's optional `id`,
`role`, and raw `tools` array.

Each experiment declaration's description must equal the relay description,
defaulting an absent description to `""`. Its `strict` field must be `false`.
Its `parameters` must be a recursive subset of the original relay
`inputSchema`. Every retained object key and array index must have the same
path and value. Object keys and array suffix entries may be omitted; entries
cannot move or change. Additions, substituted values, and shifted array
entries fail with `inventory_mismatch`.

Each normalized experiment declaration records its omitted schema paths in
`catalog_pruned_paths`, as JSON Pointers relative to the original `inputSchema`.
For example, omitting a description under property `value` records
`/properties/value/description`; dropping the second and later `required`
entries records their original indices, starting with `/required/1`.
An unchanged schema records an empty array. Codemux compares the original
schema directly; it does not reproduce Codex's schema lowering, pruning,
compaction, or byte budget. The source paths above establish direct exposure
and `strict: false`; they do not justify transforming the reference schema.

`CODEX_BUILTIN_DECLARATIONS` in `src/experiment-codex-parser.ts` contains
only these 14 identities from the preserved
`c008786c-0ec2-4909-a1df-37e6b51eec44.codex-rollout.jsonl` catalog. The
source references are registrations in Codex `rust-v0.165.0`, inspected at
`codex-rs/core/src/tools/spec_plan.rs` in the local Codex checkout.

| Qualified declaration | Type | `core/src/tools/spec_plan.rs` |
|---|---|---|
| `functions.list_mcp_resources` | `function` | 1281-1283 |
| `functions.list_mcp_resource_templates` | `function` | 1284-1286 |
| `functions.read_mcp_resource` | `function` | 1287-1289 |
| `functions.request_user_input` | `function` | 1315-1321 |
| `functions.request_user_input_async` | `function` | 1324-1349 |
| `functions.apply_patch` | `custom` | 1425-1427 |
| `clock.curr_time` | `function` | 1382-1388 |
| `clock.sleep` | `function` | 1390-1406 |
| `collaboration.followup_task` | `function` | 1515-1523 |
| `collaboration.interrupt_agent` | `function` | 1536-1544 |
| `collaboration.list_agents` | `function` | 1545-1553 |
| `collaboration.send_message` | `function` | 1505-1514 |
| `collaboration.spawn_agent` | `function` | 1472-1504 |
| `collaboration.wait_agent` | `function` | 1525-1534 |

This exception permits declarations only. Calling any listed built-in
still fails with `unknown_tool`; only experiment tools may be called. The
declaration set does not allow other tools in `functions`, `clock`, or
`collaboration`. Replay of a byte-identical preserved rollout verifies its
catalog, two turns, two usage records, and experiment call/output. Adding
a foreign declaration fails with `inventory_mismatch`. This replay does
not establish a new live delivery result.

`tests/experiment-codex-native-replay.test.ts` repeats both checks using
`tests/fixtures/experiment-codex-native-excerpt.json`. That excerpt keeps
the full captured tool catalog, native response identities, timestamps,
usage, model output, relay result, and exec completion. It omits account
metadata, instructions, user input, workspace metadata, and rate limits.
Its provenance records the original run ID, rollout size, and SHA-256.

## Provider selection and differences

Codex 0.165.0 refuses a custom `openai` table before merging providers.
Its reserved-ID constant also lists `amazon-bedrock`, `amazon-bedrock-runtime`,
`gcp`, `ollama`, and `lmstudio`; the validator exempts the Bedrock and GCP IDs.
The experiment uses `codemux-experiment` to avoid the `openai` refusal.
The private config explicitly selects it with the top-level `model_provider`
key before declaring the table:

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

The table has no `base_url`. `name = "OpenAI"` makes Codex's `is_openai()`
true and preserves its normal backend routes. The websocket and standalone
web-search flags retain those capabilities. The name and absent `base_url`
also satisfy Codex's OpenAI API-key catalog rule; the explicit catalog URL
allows the catalog on that path too. `requires_openai_auth = true` resolves
the existing ChatGPT login for this custom provider. The `version` header is
the detected Codex version. No credential value is written into the table.

These differences from the built-in provider remain:

| Setting | Effect |
|---|---|
| `include_internal_metadata` | Serde skips this field, so the configured provider gets false instead of the built-in true. Tool-result metadata capture is cleared and internal client metadata is omitted from telemetry. Model-bound content is unchanged. |
| Cyber access program | Enrollment checks the provider ID `openai`. The custom ID does not enroll. |
| `default_model_provider_id` | This default uses the provider ID. The explicit `model_provider` selection makes it irrelevant for the experiment. |

The ordinary `CODEMUX_CODEX_PROVIDER_*` override uses
`CODEX_PROVIDER_ID = "codemux"`, which differs from `codemux-experiment`.
It selects its own provider, so it cannot coexist with a catalog override.
Codemux refuses the combination before writing private configuration.
A direct-mode experiment without a catalog override retains the existing
provider override behavior.

Provider selection does not change model attribution. The result envelope
still reports Codex's served model when a reroute reports one, otherwise the
requested model. The call ledger keeps the requested model in `model` and
the reported served model in `model_effective`, or null when unreported.
Neither field becomes the provider ID. See [results and usage](results-and-usage.md).

## Catalog relay and records

The per-run URL is `http://127.0.0.1:<port>/catalog/<nonce>`, where the nonce is
32 random bytes encoded as 64 hexadecimal characters. This GET route uses the
nonce independently of the MCP bearer token. A missing or wrong nonce gets
HTTP 404. Other methods on the valid route get HTTP 405. The response has no
ETag. All other relay routes retain their existing bearer authentication.

Catalog `http_request` evidence records only the method, sanitized
`path: "/catalog"`, `client_version`, `authorization_present`, and an empty
body (`bytes_base64: ""`, `body_complete: true`). It never records request
headers, authorization values, or the nonce. The generated provider table
contains no token.

`run_start.catalog_override` is a boolean. `run_start.omit_tools_from` records
`["deferred", "code_mode"]` for every Codex experiment. An override also emits:

| Record | Fields |
|---|---|
| `catalog_override` | `slug`, `source_path`, `source_fetched_at`, `served_models`, `served_bytes`, `removed: ["tool_mode"]`, `requested_only` |
| `catalog_served` | `client_version`, `bytes` |

`source_path` and `source_fetched_at` identify the real cache used.
`served_models` counts model entries; `served_bytes` and `bytes` count the
serialized response's UTF-8 bytes. `catalog_served` establishes a successful
fetch. If Codex produces its first `function_call` before fetching the override,
the run fails with `code_mode` before dispatching that call.

## Rollout evidence

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
malformed, or unmatched evidence fails the run. Every function call must
belong to the experiment inventory, so `update_plan` and `apply_patch` fail too.

Experiment flags disable `code_mode` and `code_mode_host`. A refused `exec`
fails with `code_mode` for either `function_call` or `custom_tool_call`.
An inventory function named `exec` remains allowed. Other foreign function
or custom tools fail with `unknown_tool`. Diagnostics name the tool. The
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
