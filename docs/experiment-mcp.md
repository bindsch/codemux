# Experiment MCP

`run --experiment-mcp <spec.json>` connects one experiment-owned stdio MCP
server through Claude's SDK control bridge. It requires `-a claude --hermetic
--tools none --auto read-only`, scode, and no Playwright MCP. Other adapters
refuse it before reading the spec or starting a model. Codex's MCP output adds
a `Wall time:` header, so its result bytes do not satisfy this contract.

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

The command must be a trusted regular executable owned by the user or root,
not group/world writable, and outside the execution cwd. No shell is inserted.
The prompt's serialized control frame, including escaping and wrapper, must
fit 1 MiB. This is tighter than the general prompt limit.

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

## Protocol and recordings

The server speaks newline-delimited JSON-RPC 2.0. Responses must match pending
request IDs (strings or safe integers) and contain exactly one of result/error.
The transport permits at most 64 pending requests. Request/response and Claude
control frames are limited to 1 MiB. A server notification with method
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
bound Claude Code 2.1.300's SDK bridge applies to tool names. Definitions, `inputSchema` included, pass through unchanged and must not change during the run; a large inventory (a hundred tools with schemas) is bounded only by the 1 MiB control frame.
Claude's exposed inventory must equal the advertised namespaced set before
conversation frames or tool calls are accepted.

`tools/call` returns an MCP content array. If present, `isError` must be
boolean. Codemux compares it with the emitted model-bound `tool_result`,
including boolean `is_error`. A single text block may be represented as its
text, a plain string, with its trailing whitespace removed (Claude Code
2.1.300 delivers error results this way); whitespace Claude adds is a
change. Other content must be deeply equal. Any other difference, unmatched IDs,
duplicate calls/results, or unknown Claude frame types fail the run.
Documented Claude notifications are recorded without becoming tool calls.

Recordings are mode 0600 JSONL files under the codemux state directory's
`experiments/<run-id>.jsonl`, or the chosen recording directory.
Each record has `run_id`, monotonic `seq`, `kind`, and kind-specific fields.
Raw server stdin/stdout/stderr records use `bytes_base64`; control frames,
inventories, tool calls, server results, model-bound results, comparisons,
failures, and the terminal `run_end` are separate records.
They can contain prompts and tool content. They are not the prompt-free
[call ledger](results-and-usage.md).

The recording budget is 256 MiB, with failure/end records allowed afterward.
Recordings survive cleanup. `CODEMUX_CALL_LOG=off` disables only the ledger,
not evidence recordings. A relocated ledger changes the default recording
state directory. `--result-json` reports the path as `codemux.recording`.

Shutdown stops the server process tree, bounds pipe drainage, finalizes the
recording, and reports incomplete capture or cleanup. A protocol failure
remains a failure even if the child exits zero.

## Verification

`check --hermetic --tools none --experiment-mcp <spec.json>` extends Claude's
paired canary. It tests the specified channels against a positive control,
not prompt-only reproducibility or every possible upstream customization.
See the dated [experiment investigation](experiment-mcp-report.md) and
[testing instructions](TESTING.md). The rebuild runs fixture tests only;
it does not claim fresh live-provider evidence.
