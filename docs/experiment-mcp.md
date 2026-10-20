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
change. Other content must be deeply equal. Any unaccepted difference, unmatched IDs,
duplicate calls/results, or unknown Claude frame types fail the run.
Documented Claude notifications are recorded without becoming tool calls.

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
shape, the longest integer left ungrouped, and the numeral set), never
with a leading zero; a count past 1e21 is matched as the full digits
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
