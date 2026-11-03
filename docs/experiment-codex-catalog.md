---
read_when: "Checking how the Codex model catalog override and code-mode exposure work."
---
# Codex experiment catalog and delivery

Read this with the [experiment MCP contract](experiment-mcp.md). Codex
experiments require explicit `-m` and the spec's `codex-wall-time` opt-in.
The preserved October 29, 2026 `gpt-6-astra` probe completed direct experiment
tool delivery; replay verifies its saved native rollout, relay result, and
exec completion. The dated probe and Atomix findings moved to
[delivery evidence](archive/experiment-evidence.md#codex-delivery-findings).

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

Every experiment serves a sanitized catalog, including direct, omitted, and
null tool modes. The requested mode must be one of those values,
`code_mode`, or `code_mode_only`; unsupported modes fail. For every served
model, Codemux deletes `tool_mode` and `multi_agent_version`, removes `clock`
from `experimental_supported_tools`, and sets `apply_patch_tool_type` to null.
Other supported-tool entries and model fields stay unchanged. The source
cache is never rewritten.

The served JSON has exactly the envelope `{"models":[...]}`. Its serialized
UTF-8 body is capped at 1 MiB. If the full catalog exceeds the cap, Codemux
serves only the requested entry and records `requested_only: true`. If that
entry alone exceeds the cap, the run fails with `code_mode`.

## Direct MCP exposure

Every Codex experiment writes this setting in the private
experiment server table, beside its relay URL and bearer header:

```toml
[mcp_servers.<name>]
startup_timeout_sec = 120
tool_timeout_sec = 7200
omit_tools_from = ["deferred", "code_mode"]
```

`tool_timeout_sec` uses the spec's optional `tool_timeout_seconds` (positive integer, default 7200, maximum 86400). Startup stays at 120 seconds. Held calls wait for the experiment server within that tool deadline; the run's `--timeout` is the only other bound. `run_start.omit_tools_from` records the same list. The setting leaves only
`direct`, which places the experiment tools in the model's initial tool list.
The requested entry keeps `supports_search_tool`. Catalog sanitation and the
disable switches below remove native tool sources independently of MCP exposure.

The dated source-line findings for the exposure setting moved to
[direct-exposure evidence](archive/experiment-evidence.md#codex-direct-exposure-source-evidence).

An unexpected `tool_search`, `tool_search_tool`, or native `tool_search_call` fails with
`unknown_tool`. Its diagnostic names the qualified tool and says Codex offered
tool search instead of the experiment tools. The server table omits the
deferred surface, so this means the exposure policy changed.

### Native tool removal and startup check

Codex `rust-v0.165.0` registers the native tools below in
`core/src/tools/spec_plan.rs`. These are the removal controls; the complete
restricted-name list follows. `--disable` names are feature keys.

| Native tools | Removal control | Source lines |
|---|---|---|
| `exec_command`, `write_stdin` | `--disable shell_tool --disable unified_exec` | 1242-1272 |
| `update_plan` | `-c tools.update_plan.enabled=false` | 1299-1300 |
| `wait_for_environment` | `--disable deferred_executor` | 1303-1312 |
| `request_user_input`, `request_user_input_async` | `-c tools.experimental_request_user_input.enabled=false` | 1315-1349 |
| `send_message_to_user_async` | `--disable send_message_to_user_async`; a catalog entry can still enable it and fails the startup check | 1352-1360 |
| `request_permissions` | `--disable request_permissions_tool` | 1363-1364 |
| `new_context`, `get_context_remaining` | `--disable token_budget` | 1367-1378 |
| `clock.curr_time` | `--disable current_time_reminder` and remove catalog `experimental_supported_tools` entry `clock` | 1381-1388 |
| `clock.sleep` | `--disable sleep_tool`; this feature defaults to true (`features/src/lib.rs:1118-1121`) | 1390-1406 |
| `list_available_plugins_to_install`, `request_plugin_install` | `--disable tool_suggest`; hermetic flags also disable apps and plugins | 1409-1422 |
| `apply_patch` | Set catalog `apply_patch_tool_type` to null | 1425-1427 |
| `test_sync_tool` | No feature switch; its catalog entry fails the startup check | 1430-1436 |
| `view_image` | `--disable view_image` and `-c tools.view_image=false` | 1439-1450 |
| V1 `spawn_agent`, `send_input`, `resume_agent`, `wait_agent`, `close_agent`; V2 `spawn_agent`, `send_message`, `followup_task`, `wait_agent`, `interrupt_agent`, `list_agents` | `--disable multi_agent --disable multi_agent_v2`, `-c multi_agent_v2.disable_native_tools=true`, and remove catalog `multi_agent_version` | 1455-1582; activation at 733-745 |

Model `multi_agent_version` can override feature selection. Removing it and
setting `multi_agent_v2.disable_native_tools=true` closes both activation paths.
Other existing switches disable `code_mode`, `code_mode_host`, `browser_use`,
`computer_use`, and `image_generation`, and set `web_search="disabled"`.
Hermetic flags also disable native app, plugin, memory, and goal sources.

Before dispatching any `tools/call`, Codemux reads the first rollout
`world_state.state.top_level_tools`. This is a map of tool names to hashes.
It permits only the qualified experiment names and the resource trio below.
Namespace header keys are permitted only for those allowed members. The producer
stores both headers and qualified leaves at
`core/src/context/world_state/top_level_tools.rs:51-76,90-94,133`.
`harness_top_level_tools` records the raw map as `tools` with its native `t`.
An extra name fails with `inventory_mismatch` and terminates the run before
server dispatch. Calls, including those with `_meta.callId`, wait for this
check within the existing five-second native-ID deadline. Missing inventory
evidence fails with `harness_log_missing`.

### Resource exception

An MCP server unconditionally adds `functions.list_mcp_resources`,
`functions.list_mcp_resource_templates`, and `functions.read_mcp_resource`
(`core/src/tools/spec_plan.rs:1276-1291`). No removal switch exists on this path.
The relay answers `resources/list` locally with `{"resources":[]}` and
`resources/templates/list` with `{"resourceTemplates":[]}`. It answers
`resources/read` with JSON-RPC error `-32002`, message `no resources`.
These methods never reach the experiment server and never fail the run.
Each records `relay_resources` with `method`, `rpc_id`, and `t`.

Native calls to this trio record `harness_builtin_call` with `call_id`,
qualified `name`, `input`, exact `harness_output`, and common `t`. They continue
without entering the experiment call list or `model_tool_errors` count.
Resource MCP exec completions must match a native resource call's name, server,
arguments, and exact output. A literal `functions.` prefix inside the native
call's `name` is not a resource alias and remains restricted.
Every other built-in call still fails with `unknown_tool`.

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

These historical declarations remain accepted for saved-rollout replay. The
startup check permits only experiment tools and the resource trio in a live
inventory. Other built-in calls fail with `unknown_tool`. Unknown native names can follow the verified harness-error rule below. The
declaration set does not allow other tools in `functions`, `clock`, or
`collaboration`. Replay of the preserved excerpt with a synthetic restricted
world-state inventory verifies its catalog, turns, usage, and call/output. Adding
a foreign declaration fails with `inventory_mismatch`. This replay does
not establish a new live delivery result.

Calls use a broader restricted set than declarations. Every built-in below except the resource trio fails with `unknown_tool`, even if undeclared and followed by its own unsupported-call error. Experiment inventory calls keep their qualified MCP names and remain allowed. Sources below are from Codex `rust-v0.165.0`, relative to `codex-rs/`.

| Restricted names | Registration and name sources |
|---|---|
| `exec_command`, `write_stdin` | `core/src/tools/spec_plan.rs:1242-1272`; `core/src/tools/handlers/unified_exec/exec_command.rs:110-112`, `write_stdin.rs:47-49`. |
| `list_mcp_resources`, `list_mcp_resource_templates`, `read_mcp_resource` | `core/src/tools/spec_plan.rs:1276-1289`; `core/src/tools/handlers/mcp_resource_spec.rs:26,55,84`. |
| `update_plan` (also `plan`), `wait_for_environment`, `request_user_input`, `request_user_input_async`, `send_message_to_user_async`, `request_permissions`, `new_context`, `get_context_remaining` | `core/src/tools/spec_plan.rs:1294-1378`; names in `core/src/tools/handlers/plan_spec.rs:43`, `wait_for_environment.rs:19`, `request_user_input_spec.rs:9`, `request_user_input_async.rs:22`, `send_message_to_user_async.rs:21`, `request_permissions.rs:33-35`, `new_context_window_spec.rs:8`, `get_context_remaining_spec.rs:10`. |
| `clock.curr_time`, `clock.sleep`, `list_available_plugins_to_install`, `request_plugin_install`, `apply_patch`, `test_sync_tool`, `view_image` | `core/src/tools/spec_plan.rs:1381-1450`; handler names in `current_time.rs:24-25,53-54`, `sleep.rs:26-27,66-67`, `list_available_plugins_to_install_spec.rs:32`, `request_plugin_install_spec.rs:102,161`, `apply_patch_spec.rs:19`, `test_sync_spec.rs:59`, `view_image.rs:73-75`, under `core/src/tools/handlers/`. |
| `spawn_agent`, `send_input`, `resume_agent`, `close_agent`, `send_message`, `followup_task`, `wait_agent`, `interrupt_agent`, `list_agents` | `core/src/tools/spec_plan.rs:1455-1582`; `core/src/tools/handlers/multi_agents_spec.rs:14,89-92,190-193,272-275,289-292,343-346`; `core/src/tools/multi_agent_tool.rs:68-74` applies configured namespaces such as `collaboration`. |
| `tool_search`, `tool_search_tool`, `exec`, `wait` | `core/src/tools/spec_plan.rs:1093-1102,1621-1637`; `tools/src/tool_discovery.rs:6`; `core/src/tools/tool_namespaces_info.rs:16,39-41,63-66`; `code-mode-protocol/src/lib.rs:54-55`. |
| `web_search`, `web.run`, `image_gen.imagegen` | `core/src/tools/spec_plan.rs:701-717,787-795,1650-1659`; `tools/src/tool_spec.rs:39-40,64`; `ext/web-search/src/tool.rs:41-42,54-56`; `ext/image-generation/src/lib.rs:8-9`, `ext/image-generation/src/tool.rs:127-130`. |
| `get_goal`, `create_goal`, `update_goal`, `multi_env_copy_file` | `app-server/src/extensions.rs:73-134` installs native contributors; `ext/goal/src/spec.rs:9-11`, `ext/goal/src/extension.rs:555-609`; `ext/multi-env-copy-file/src/tool.rs:21,42-44`. |
| `create_channel`, `get_channels`, `list_threads`, `search_posts`, `read_thread`, `read_post`, `subscribe`, `unsubscribe`, `post` | `ext/agent-message-board/src/extension.rs:129-136` selects the nine `DISCUSSION` tools at `message-board/src/tools/selection.rs:23-45`. The optional library action `append` is not registered. |
| `history.list_windows`, `history.list_items`, `history.read_item`, `history.search_contents`, `notes.list_files_by_prefix`, `notes.read_file`, `notes.search_contents`, `notes.append_to_file`, `notes.write_file` | `ext/history-notes/src/tools.rs:28-29,48-84`. |
| `memories.add_ad_hoc_note`, `memories.list`, `memories.read`, `memories.search` | `ext/memories/src/lib.rs:18-22`; `ext/memories/src/tools/mod.rs:55-56`. |
| `skills.list`, `skills.read`, `skills.installations` | `ext/skills/src/tools/mod.rs:53,83-94,342-343`; `ext/skills/src/tools/list.rs:31`, `read.rs:38`, `installations.rs:31`. |
| `user_message.search_messages`, `user_message.read_messages` | `core/src/mcp_tool_call/conversation_history.rs:38-64,92-110` defines the fixed Guardian wrappers. |

Browser and computer actor calls are also blocked in `node_repl` and `cua_repl` namespaces, including their `mcp__` and flat aliases. `protocol/src/mcp.rs:41-64` defines those spellings. `plugin/src/bundled_hooks.rs:65-97` connects the browser and computer plugins to these MCP servers. The public source has no core handler registrations for those feature names. Qualified native names remain distinct from invented names such as `invented.sleep`. Native extension executors enter the model router at `core/src/tools/spec_plan.rs:350-365,1640-1664`. Queue and agent runtime extensions add no model tools.

`tests/experiment-codex-native-replay.test.ts` repeats both checks using
`tests/fixtures/experiment-codex-native-excerpt.json`. That excerpt keeps
the full captured tool catalog, native response identities, timestamps,
usage, model output, relay result, and exec completion. It omits account
metadata, instructions, user input, world state, workspace metadata, and rate limits.
Its provenance records the original run ID, rollout size, and SHA-256.
The replay adds an explicitly synthetic restricted world state. The unmodified
`8415a55b-5587-4255-bd7d-d80c22ca40f6.codex-rollout.jsonl` instead fails the
inventory check for its visible built-ins in `tests/experiment-codex-task-aa.test.ts`.

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
Codemux refuses the combination before writing private configuration for every
experiment, including a requested model with direct, omitted, or null tool mode.

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

`run_start.catalog_override` is true for every prepared Codex experiment.
`run_start.omit_tools_from` records `["deferred", "code_mode"]`. Each emits:

| Record | Fields |
|---|---|
| `catalog_override` | `slug`, `source_path`, `source_fetched_at`, `served_models`, `served_bytes`, `removed: ["tool_mode", "experimental_supported_tools.clock", "multi_agent_version", "apply_patch_tool_type"]`, `requested_only` |
| `catalog_served` | `client_version`, `bytes` |

`source_path` and `source_fetched_at` identify the real cache used.
`served_models` counts model entries; `served_bytes` and `bytes` count the
serialized response's UTF-8 bytes. `removed` names sanitation operations;
`apply_patch_tool_type` is set to null rather than deleted. `catalog_served` establishes a successful
fetch. If Codex produces its first `function_call` before fetching the override,
the run fails with `code_mode` before dispatching that call.

## Rollout evidence and correlation

The rollout is polled every 250 ms; turn, usage, call, and delivery records
follow the [normalized record contract](experiment-mcp.md#normalized-records).
A refused `exec` call fails with `unknown_tool` for either `function_call` or
`custom_tool_call`; an inventory function named `exec` remains allowed. The
rate-limit retry sequence, the recovery source path, the preserved-rollout
provenance, the wall-time header rules, and the exec-completion matching
evidence moved to
[rollout evidence](archive/experiment-evidence.md#codex-rollout-evidence).
