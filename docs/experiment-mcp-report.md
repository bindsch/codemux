# Native-harness experiment MCP build and investigation

Date: 2026-10-12. Branch: `experiment-mcp`. Worktree:
`~/Programming/Ops/codemux-expmcp`. HEAD remains
`2492b127a78f73aaefec45051ba327c78c071915`. Codemux: `0.11.0`.
No commit, push, or release. This report supersedes the earlier refusal-only
investigation on this branch.

## Outcome

Claude's experiment mechanism is **VERIFIED** on Claude Code 2.1.280.
The operator ran the marker probe and extended hermetic canary from an
unsandboxed process on this branch. The marker probe exited 0 and recorded
matching server and model-bound results. The canary reported
`HERMETIC claude: OK` with a leaking positive control.

Codex still refuses `--experiment-mcp`, explicitly naming its
`Wall time:` header. No stripping or alternate authentication was added.

Antigravity 1.3.3 hermetic and tools-none policies with the per-run Keychain
mirror are **VERIFIED** on the operator's Round 11 tree with installed scode
0.6.0: the plain run and public check (`HERMETIC agy: OK`, `TOOLS agy: OK`)
passed, the user search list was unchanged, and no private home remained.
Private HOME and a clean working directory exclude operator configuration.
Deny-all settings, plan mode, and native attempt detection enforce text-only
runs. The Round 11 live record below supplies the date and outcomes. Round 12
records subsequent command-ordering and cancellation fixes with synthetic
regressions and the current release gate; no Round 12 live run is claimed.
Earlier candidate verdicts, authentication
diagnoses, and gate counts below are historical.

## Part 1: Claude implementation

The installed Claude Code 2.1.280 binary retains SDK-type MCP servers under
`--safe-mode` while dropping explicit stdio entries. The prior
investigation established that filter; this run inspected the embedded
`initialize.sdkMcpServers`, `mcp_message`, and
`control_response.response.mcp_response` protocol paths.

The new implementation consists of:

- `src/experiment-mcp.ts`: bounded regular-file spec reading, strict
  schema validation, adapter refusals, and launch constraints.
- `src/experiment-server.ts`: the external stdio process, environment
  allowlist, bounded JSON-RPC messages, correlation, and process-tree cleanup.
- `src/experiment-bridge.ts`: Claude SDK registration, duplex control
  traffic, permission decisions, native call matching, and result recording.
- `src/adapters/claude.ts`: per-run context, stream-JSON flags,
  SDK configuration, result processing, and cleanup.
- The existing process runner retains ownership of timeout and signals.
  Its optional duplex sink keeps stdin open for control replies.
  `launch.ts` enforces Claude's 2.1.280 minimum and rejects a mismatch
  between request and launch autonomy or working directory.

The CLI requires `--hermetic --tools none --auto read-only` with scode.
It also rejects Playwright MCP. The specification names exactly one server:

```json
{
  "name": "experiment",
  "command": "/opt/homebrew/bin/bun",
  "args": [
    "--no-env-file",
    "--no-install",
    "--config=~/Programming/Ops/codemux-expmcp/bunfig.runtime.toml",
    "~/Programming/Ops/codemux-expmcp/tests/fixtures/experiment-mcp.ts"
  ],
  "env": []
}
```

Home paths in this displayed spec use `~/` for privacy; the actual spec
uses absolute paths because arguments do not undergo shell expansion.
The executable spec is available locally at `scratch/experiment-mcp.json`.
The command must be absolute. Arguments are passed directly, without a
shell. `env` contains unique variable names, not values; only those
variables are copied. An unset named variable fails before the prompt is
sent. The server cwd is the run directory.

Claude receives `--safe-mode --tools "" --strict-mcp-config`, the single
SDK server, and stream-JSON input/output. Its permission mode is
`default` for this path so native plan mode cannot suppress experiment
tools that write. Codemux approves only the registered experiment tool
names. The harness remains under read-only scode. Every built-in tool
definition is removed; an unexpected tool inventory or call fails closed.

The server is deliberately outside scode. The experiment owns containment
of that server and its commands; changing cwd is not containment.
This avoids making the run directory writable to the harness merely so
the server can write. Codemux kills the server process group and known
descendants on cleanup, including timeout and signal exits. The existing
process-tree limitation still applies to descendants orphaned before the
first observable snapshot; this host also denies `ps`, which is reported.

Authentication follows the existing Claude adapter unchanged. No SDK
package, model API proxy, provider credential, or new login flow was added.

### Recording contract

Each run records to `experiments/<run-id>.jsonl` under codemux's state
directory (beside the `calls.jsonl` ledger) with mode 0600 and exclusive
creation. A spec `recording` names a directory, absolute or relative to the
spec file, created with mode 0700 if absent. An existing non-directory is
refused before spawn. Each run writes `<dir>/<run-id>.jsonl`; a paired
`check` control writes `<dir>/<run-id>.control.jsonl` with its own run ID.
Both paths are printed on stderr. Every entry has a run ID and sequence number.

| Record | Evidence |
|---|---|
| `server_stdin`, `server_stdout`, `server_stderr` | Raw bytes, base64 encoded; stdout chunks concatenate back to the original server stream |
| `control_stdin`, `control_stdout` | Claude control traffic, separately identified |
| `mcp_request` | Control request ID, MCP request ID, and native tool-use ID when applicable |
| `tool_inventory`, `tool_call` | Harness-emitted tools and actual native calls |
| `server_tool_result` | Parsed MCP result, correlated to the native call |
| `model_tool_result` | Claude's emitted model-bound `tool_result` block |
| `result_comparison` | Equality of content and error status across the two boundaries |
| `failure`, `cancellation`, `run_end` | Failure information and completion counts |

A single text block may be emitted by Claude as a string. Its text must
remain identical. Other content arrays must match structurally.
Changed content, truncation, missing results, unknown tools, malformed
messages, or cancellation aborts the experiment. An MCP `isError` result
is forwarded and compared; a JSON-RPC error is retained in raw traffic
and aborts rather than pretending the harness-generated error was the
server's tool output.

This records the control-protocol boundary requested by the operator.
It is not a capture of the final provider HTTP request. The operator's installed-harness probe verified marker fidelity at this
boundary. Recordings are
unredacted experiment data and are not tamper-resistant against the
trusted server running as the same user.

Bounds: 64 KiB spec, 1 MiB message, 64 pending MCP requests, 256 MiB
recording, and the existing 16 MiB retained harness transcript.
The server must provide a fixed tool list containing a
subset of `bash`, `bash_bg`, `poll`, `kill`, `read`, and `write`.
Round 10 fetches all pages before validating the combined inventory.
Server-initiated requests and notifications are refused.

### Extended canary

`check --hermetic --tools none --experiment-mcp …` plants project
instructions, a Claude skill, a prompt hook, and an MCP configuration.
The hermetic probe and deliberate non-hermetic control use the same
experiment server and empty built-in tool list. The control enables the
project instruction source and omits safe mode. This internal control
cannot be selected through `run`.

The hermetic answer must be exactly OK with no planted marker anywhere
in the native trace. The control must leak the marker. Native tool
inventory and calls are checked independently of the model's self-report.
Canary fixtures are planted under `.codemux-experiment-check-<random>/`
in the system temp root and removed when the check ends — on success,
failure, or signal. Recordings go to the state directory like any run.

The MCP canary checks exclusion; it does not claim that every planted
configuration channel would load in the control. In particular, strict
MCP configuration also excludes the planted extra server in that control.
The instruction-file control remains the positive leakage control.

## Part 1: Codex refusal

The operator verified Codex 0.160.1's timing wrapper. The
[version-matched MCP handler](https://github.com/openai/codex/blob/rust-v0.160.1/codex-rs/core/src/tools/handlers/mcp.rs#L229)
measures elapsed time, and the
[result serializer](https://github.com/openai/codex/blob/rust-v0.160.1/codex-rs/core/src/tools/context.rs#L171)
adds `Wall time: … seconds` and `Output:` to model-bound output.
Server logging alone cannot prove equality with those bytes.

Both CLI surfaces and programmatic adapter validation retain the refusal,
before spec reading or server startup. README, HERMETIC.md, and CHANGELOG
name the header. Existing read-only scode restrictions remain intact.
Codex's `apply_patch` exception remains documented. **Observed apply_patch
calls: not measured**, because no Codex experiment was launched.

A tool-result hook remains weaker for this study: appending treatment text
does not remove native timing. Claude's current hook schema includes
output replacement, but ordinary hooks are excluded by safe mode.
Re-enabling them would reopen operator channels. Use the verified Claude SDK
bridge; keep Codex excluded until its native
serialization offers the required control.

## Part 2: Antigravity investigation and candidate

`agy --version` returned **1.3.2**. `./bin/codemux doctor` exited **0**
and reported agy installed, with hermetic runs and tool selection both
unsupported. Doctor does not authenticate, so it cannot confirm login.
The operator's subsequent plain run and all five diagnostics reached agy
and reported authentication required.

The official [authentication documentation](https://antigravity.google/docs/cli/install)
describes silent OS-keyring sign-in. No
`~/.gemini/antigravity-cli/antigravity-oauth-token` file was present here.
The installed binary contains the CLI file-token storage and Keyring
paths, the `JETSKI_OAUTH_TOKEN` name, and the constructed token-name
suffix `-oauth-token`. No token values or Keychain entries were printed
or modified. No API-key substitution was attempted.

A private HOME redirects user configuration and `~/.agents` discovery
without redirecting scode's protected paths. The candidate lives in
`src/adapters/agy.ts`, separate from the MCP bridge. It creates a home
under the real `~/.gemini/.codemux-isolation-probes/`, passes HOME and
XDG assignments after scode through `env`, and includes no operator
instructions, settings, project state, memories, plugins, or manifests.
If a regular file token exists at the expected path, the private home gets
a mode-0600 copy, never a link. A file-token rotation during a probe lands
only in the private home, which cleanup removes. The copy is never written
back; the real file store is never modified. Cleanup verifies the original
parent, directory identity, and run marker before deletion. The mode-0600
copy exists only for the probe's lifetime. Cleanup holds open home and
parent descriptors, checks their identities with `fstat`, and searches the
parent's entries by inode if the home path is absent. A cleanup failure
names the token copy that may remain and makes the diagnostic exit nonzero.
SIGKILL or a host crash can prevent cleanup from running.
Live token rotation remains unverified; synthetic rotation tests pass.
With no file token, the native Keyring path remains unchanged; the live
probes require the operator to log in first.

A later check of the binary's strings found `zalando/go-keyring` with its
`macOSXKeychain` backend and `fallbackServiceProvider`, and the Keychain
on this machine holds a generic-password item labeled `gemini` with
account `antigravity` (metadata only; the secret was not read). The
login store is therefore the macOS Keychain, and the file copy covers only
the keyring's file fallback. The initial diagnosis attributed `silent auth
failed` to a stale or revoked item. Later operator evidence superseded it:
scode blocked the real Keychain, and `security` resolves login through HOME.
Round 8 implements that lookup with a private mirror.

The initial probes used an undocumented customization switch found in
binary strings. Round 6 removes it because agy 1.3.3 rejects it.
This was a candidate mechanism, not a guarantee from a successful live run. Existing rejection
of executable project configuration remains in force. A first diagnostic
planted `.agents/rules/canary.md` and correctly failed that guard;
the final canary plants admitted `GEMINI.md` and `AGENTS.md` instead.

No advertised tool-removal switch appears in 1.3.2's help. The official
[permission reference](https://www.antigravity.google/docs/permissions?tab=cli)
documents deny rules for `read_file`, `write_file`, `read_url`,
`execute_url`, `command`, `unsandboxed`, and `mcp`.
The tools candidate puts `action(*)` for all seven in a private settings
file. This tests denial, not schema removal, and does not establish
coverage of internal tools or future action namespaces.

**Plan mode plus read-only scode in an empty cwd is not enough to certify
a text-only protocol.** Read-only filesystem policy does not remove read
tools, harmless shell commands, network tools, or model-visible tool
schemas. The [headless documentation](https://antigravity.google/docs/cli/headless)
also warns that permission denials can still exit successfully.
A successful exit or an assistant saying NO_TOOLS is therefore insufficient.

`check -a agy --agy-isolation-probe <mode>` is an explicitly unverified
diagnostic with modes `login`, `hermetic`, `control`, `tools`, and
`tools-control`. It requires default read-only scode and rejects other
isolation flags. It writes `native-events.jsonl`, stderr, expected
markers/secrets, and a summary under `.codemux-agy-check-<random>/` in
the system temp root and removes the directory when the probe ends; a
one-line summary goes to stderr.
The summary inspects native `init.tools` and `step_update.step_type`;
unknown non-text step types count as possible tool activity. It never
infers tool absence from assistant prose. Empty output is not a pass.

Both ordinary capability flags remain refused until live hermetic and
tool checks, including positive controls, pass.

## Live commands and transcripts

These results were supplied by the operator from an unsandboxed process
on this exact branch. Every launch used `./bin/codemux`. They supersede
the earlier exit-71 attempts from a sandboxed parent.

### Claude marker probe: exit 0

```sh
./bin/codemux run -a claude -m haiku --hermetic --tools none --experiment-mcp scratch/experiment-mcp.json --auto read-only --cwd scratch/claude-mcp-run --timeout 180 --result-json -f tests/fixtures/experiment-probe.txt
```

The recording `.codemux-experiment-<id>.jsonl` contains 46 records. (That
run used the Round 1 layout, a cwd-local file; recordings now live under
the state directory, as above.)
Its kinds are `run_start`, `server_spawn`, `control_stdin` (7),
`control_stdout` (19), `mcp_request` (4), `server_stdin` (4),
`server_stdout` (3), `tool_inventory`, `tool_call`, `permission`,
`server_tool_result`, `model_tool_result`, `result_comparison`, and
`run_end`. The marker `CODEMUX-MCP-RESULT-8B73E209` is present, and the
model's reply mentions it. Names seen across the trace are `bash`,
`experiment`, and `mcp__experiment__bash`; no built-in shell tool was
exposed. The retained recording reports `result_comparison.equal:true`.

### Claude extended canary: VERIFIED

```sh
./bin/codemux check -a claude -m haiku --hermetic --tools none --experiment-mcp scratch/experiment-mcp.json --auto read-only --timeout 180
```

```text
HERMETIC claude: OK
control: planted code word reached the model, as expected
```

The successful marker delivery and leaking positive control establish the
Claude experiment mechanism for this installed version. Round 2 protocol
hardening is covered by automated regressions below; the operator's
live results predate those edits.

### Antigravity: login required

```sh
./bin/codemux run -a agy --auto read-only -p "Reply with exactly: OK"
./bin/codemux check -a agy --agy-isolation-probe login --auto read-only --timeout 90
./bin/codemux check -a agy --agy-isolation-probe hermetic --auto read-only --timeout 90
./bin/codemux check -a agy --agy-isolation-probe control --auto read-only --timeout 90
./bin/codemux check -a agy --agy-isolation-probe tools --auto read-only --timeout 90
./bin/codemux check -a agy --agy-isolation-probe tools-control --auto read-only --timeout 90
```

The plain run reported:

```text
authentication required. Run 'agy' to log in
```

All five diagnostic modes failed for the same reason. The operator must
log in before the probes can mean anything. Ordinary `--hermetic` and
`--tools none` remain refused. After login, the hermetic probe must omit
its planted marker and its control must leak it. The tools control must
read its unknown secret and execute the requested transform. Native tool
inventory and steps must establish tool absence; denials alone do not.

### Codex refusal: exit 1, no request

```sh
./bin/codemux check -a codex --hermetic --tools none --experiment-mcp scratch/experiment-mcp.json --auto read-only
```

```text
Error: --experiment-mcp is unavailable: Codex adds its own Wall time: header to MCP results; the experiment cannot control every result byte. See docs/experiment-mcp-report.md
```

## Automated verification (Round 1 history)

Runtime this turn: Bun **1.4.2** (the prior run used 1.3.14), scode **0.6.0**,
Claude **2.1.280**, agy **1.3.2**. The repository's minimum Bun remains 1.3.14.

Final targeted command, exit **0**:

```sh
bun test --preload ./tests/setup.ts tests/agy-isolation.test.ts tests/experiment-mcp.test.ts tests/experiment-bridge.test.ts
```

**48 pass, 0 fail**, 135 assertions, 48 tests across three files.
The preceding targeted run had 45 pass, 0 fail; three new regression
tests cover absent cleanup contexts and mismatched launch boundaries.
Compared with the previous branch report's 26 tests, this is 22 more.

`make typecheck` exited **0**. `make release-gate` exited **2**.
Its runtime-floor, typecheck, and shell-syntax steps passed. The final
full, unfiltered suite reported:

```text
1768 pass
6 skip
2 fail
8903 expect() calls
Ran 1776 tests across 70 files. [118.75s]
```

The first full gate in this turn had 1756 pass, 6 skip, 11 fail
(1773 tests). Nine failures came from the new cleanup overrides assuming
a context always exists. For example, a Claude session completed normally,
then `src/session/cli.ts:1278` called cleanup with no run context and
changed exit 0 into exit 1. The overrides now accept an absent context
(`src/adapters/claude.ts:336`, `src/adapters/agy.ts:135`).
All nine session failures disappeared. The final suite adds three tests.
Relative to the prior report's full suite: 22 more passes, the same six
skips, and the same two pre-existing failures.

Remaining failures:

- `tests/codex-provider.test.ts:285`: stale session-home cleanup.
- `tests/codex-provider.test.ts:539`: cleanup of the truly idle directory.

Both use the real default registry. A read-only diagnostic this turn
returned `unknown` from
`sessionHoldState(sessionRegistryPath(), "deadbeefdeadbeef")`.
The guard at `src/hermetic-home.ts:328` removes a directory only when
that state is `free`. Thus a 29-day-old directory is preserved when the
host cannot establish that it is unused. Those files are unchanged;
the guard was not weakened to make the test pass.

Because make stops at failed tests, later checks were run separately:

| Command | Exit | Result |
|---|---|---|
| `make contracts` | 2 | 2 pass, 1 fail, 3 tests; Copilot cannot create its bundled cache under `~/Library/Caches/copilot/pkg/darwin-arm64` (EPERM) |
| `make sandbox-contract smoke` | 0 | scode contract and all CLI smoke checks passed |
| `bun run scripts/check-source-coverage.ts` | 0 | Conservative whole-source coverage: 85.99% lines, 92.01% functions |
| `bun audit` | 0 | No vulnerabilities in nine packages |
| `bun install --frozen-lockfile --dry-run` | 0 | Existing lockfile accepted |
| Additional run/check/tui/usage/verify help and sandbox previews | 0 | Expected preview-only warning without `--show-scode` |
| `git diff --check` | 0 | No whitespace errors |

The automated fake-peer tests cover CLI parsing, all unsupported adapters,
spec validation, safe-mode/tool flags, real duplex subprocess traffic,
recording content and file mode, altered and missing results, built-in
tool detection, environment isolation, cwd, timeout, and structured CLI
output through a fake scode. Agy tests cover its retained refusals,
private-home contents, token-link cleanup, command construction, project
config rejection, and native-event inspection. No default test starts
a real provider-backed harness.

## Requirement disposition

| Item | Status |
|---|---|
| Claude SDK bridge retaining safe mode and read-only scode | Built; automated checks pass |
| External experiment server, named env only, process-tree cleanup | Built; environment/cwd and lifecycle tests pass |
| Raw server bytes plus emitted model-bound result recording | Built; fake-peer marker equality verified |
| Extended installed-Claude canary and stub-server probe | VERIFIED by operator; commands and evidence above |
| Codex refusal naming the wall-time header, with docs | Complete |
| Agy private-home and tool-denial investigation | Complete as an unverified diagnostic; no public capability enabled |
| Agy login and paired live canaries | Authentication required in all five modes; operator login needed |
| README, HERMETIC.md, TESTING.md, CHANGELOG, report | Updated |
| Full release gate | Round 1 failed; see Round 2 below for the current result |
| Stage all work without commit, push, or release | Completed with git add -A (exit 0); HEAD remains the base commit |

## Round 2

The operator's default-profile review was run `20261012-133015-ebe704bb`.
No code-review command was run during Round 2. Each behavioral finding has
a regression test. The original orphan test at `tests/base.test.ts:408`
is unchanged.

### Fixes and regression evidence

| Finding | Fix and regression |
|---|---|
| Orphan holds output open | `src/process-runner.ts:374` bounds the exit promise with pipe abandonment. The duplex callbacks retain the subprocess; canceling readers alone left the separate `proc.exited` wait unbounded. `tests/process-protocol.test.ts:10` models an exit promise that never settles and requires exit 124 with partial output. The unchanged real-orphan test passed five consecutive runs. |
| Unsafe agy cleanup | `src/adapters/agy.ts:151` checks an in-process ownership record, original parent and home device/inode, direct parent, canonical parent path, and a regular marker containing this run's nonce before removal. `tests/agy-isolation.test.ts:126` replaces the parent with a symlink to an unrelated directory with the same basename; its contents survive. The marker/ownership regression is at line 142. |
| Credential rotation | `src/adapters/agy.ts:164` refuses to delete a home whose token symlink became a regular file. It preserves the refreshed credential and does not overwrite the operator's login. `tests/agy-isolation.test.ts:153` reproduces atomic replacement using synthetic credentials only. |
| Identical parallel calls | `src/experiment-bridge.ts:169` maps the native ID in `claudecode/toolUseId` to the call and validates its name and arguments. The server correlates JSON-RPC IDs, and line 187 verifies the returned ID. `tests/experiment-protocol.test.ts:49` reverses identical request order and response order with distinct results; lines 68 and 79 reject mismatched or missing IDs. There is no first-unclaimed fallback. |
| Cleanup loses receipts | `src/experiment-bridge.ts:239` writes and syncs `run_end` before server cleanup, with descriptor and server cleanup in nested finalizers. `src/process-runner.ts:441` wraps cleanup errors in `CapturedRunFailure`, so launch writes its failure receipt. `tests/experiment-protocol.test.ts:149` checks the retained terminal record; `tests/process-protocol.test.ts:25` checks the actual call ledger after a completed child and failed cleanup. |
| Agy model aliases (correctness and edges) | `src/check-command.ts:95` resolves the model before dispatching the diagnostic. `tests/agy-isolation.test.ts:169` configures `fast: { agy: "gemini-3.1-pro" }` and checks that the fake executable receives `--model=gemini-3.1-pro`, not `--model=fast`. |
| Premature success (edges) | `src/experiment-bridge.ts:146` requires SDK initialization, completed tools/list, validated system/init, and no active control requests before accepting a result. `tests/experiment-protocol.test.ts:88`, line 94, and line 102 cover each missing prerequisite. |
| Wrong-role evidence (edges) | `src/experiment-bridge.ts:124` and line 131 require assistant tool_use and user tool_result frames, including their inner roles. `tests/experiment-protocol.test.ts:110` and line 116 reject the reversed roles. |
| Host-to-Claude message bound | `src/experiment-bridge.ts:72` checks the serialized outbound control frame. `tests/experiment-protocol.test.ts:126` supplies an escaped server result below 1 MiB whose control envelope exceeds the limit and requires failure. |
| Notification reply | `src/experiment-server.ts:59` returns no JSON-RPC response for a notification. `src/experiment-bridge.ts:183` sends only the outer control acknowledgment. `tests/experiment-protocol.test.ts:141` and the real duplex fixture at `tests/fixtures/experiment-claude.ts:16` reject a fabricated MCP response. |
| Comment contracts | `src/adapters/claude.ts:425` documents the bridge's stream-json extraction; the structured round-trip regression remains at `tests/experiment-bridge.test.ts:124`. `src/hermetic-canary.ts:65` describes retained experiment fixtures; the retention regression at `tests/experiment-bridge.test.ts:74` verifies the behavior. |
| Test portability | `src/hermetic-canary.ts:43` accepts an explicit parent while preserving the CLI default. `tests/experiment-bridge.test.ts:75` uses the temporary directory, so the test needs no repository-root writes. |
| Stale live status (contracts-2) | `README.md:93`, `docs/HERMETIC.md:73`, and `CHANGELOG.md:16` now record the operator's successful Claude marker and canary checks. The exact results and authentication failures replace the old live-status claims above. |
| Full-gate host dependencies | `tests/codex-provider.test.ts:285` and line 537 consult an empty private registry for age tests. `tests/installed-contract.test.ts:24` gives Copilot's bundled help package a private extraction cache. The existing assertions now pass without weakening production cleanup or omitting any installed harness. |
| Home-path scrub | Every spelled-out home path in this report was rewritten as `~/...`; obsolete failure transcripts were replaced by the operator's current results. Displayed spec paths are privacy abbreviations, not executable shell expansion. |

For example, two native calls with identical arguments can request RPC 20
and RPC 10 in reverse order and return different content. Previously the
first request claimed the first call and compared that call against the
wrong output. The native metadata and JSON-RPC ID checks now preserve both
associations (`src/experiment-bridge.ts:169`).

The orphan failure did not reproduce before editing in this sandbox.
The added deterministic regression isolates the unbounded exit wait;
the operator's reported intermittent failure is not presented as a
locally reproduced failure.

### Verification

The unchanged orphan test was run with:

```sh
for attempt in 1 2 3 4 5; do bun test --preload ./tests/setup.ts tests/base.test.ts -t 'unreachable orphan' || exit $?; done
```

Exit **0**. Each run reported **1 pass, 0 fail**, three assertions, about
3.1 seconds. All five completed. The full gate also includes this test.

The first Round 2 `make release-gate` exited **2**: **1784 pass, 6 skip,
2 fail**, 1792 tests. Both failures were the registry-dependent fixtures.
After isolating their registries and Copilot's package cache,
`make release-gate` exited **0**: **1786 pass, 6 skip, 0 fail**, 1792 tests
across 72 files; installed contracts added **3 pass, 0 fail**. The summary
was `Release gate passed. Review docs/RELEASE-GATE.md before tagging.`
The final run after the missing-ID regression is recorded below.

Both Round 2 live reruns used the exact Claude commands in the live section
above, including `--timeout 180`. Both exited **71** before the harness
started: `sandbox-exec: sandbox_apply: Operation not permitted`. The
operator can run those commands from an unsandboxed process to validate
the hardening. This does not replace the operator's successful earlier
live evidence. No additional agy request was needed: login remains the
prerequisite for all five modes.

Final `make release-gate` exited **0**. Summary:

```text
1787 pass
6 skip
0 fail
Ran 1793 tests across 72 files. [119.28s]
3 pass
0 fail
Ran 3 tests across 1 file. [12.57s]
Release gate passed. Review docs/RELEASE-GATE.md before tagging.
```

The final suite adds one test to the preceding green run (1792 to 1793)
and 17 to Round 1 (1776 to 1793). Round 1's two failures are now passes;
the six skips are unchanged. Whole-source coverage is 86.94% lines and
92.42% functions. Type checking, shell syntax, scode compatibility, CLI
smoke checks, dependency audit, and frozen-lockfile validation passed.

```sh
uv run --no-project ~/Programming/Agents/agent-scripts/skills/humanizer/scripts/check_american.py README.md CHANGELOG.md docs/HERMETIC.md docs/TESTING.md docs/experiment-mcp-report.md
git diff --check
git add -A
```

All three exited **0**. The prose check reported `American English: CLEAN`
with zero British spellings. An additional check of 19 touched prose and
source files also passed. The report home-path assertion exited 0 with
`Report home-path scrub: PASS`.

| Requested work | Final status |
|---|---|
| Timeout root cause; unchanged orphan test, five runs | Done; 5/5 and full suite pass |
| Every review finding and notification handling | Done; fixes and regressions listed above |
| Operator live results in report, README, HERMETIC.md | Done; Claude VERIFIED, agy login prerequisite and refusals retained |
| Home-path scrub | Done; report assertion passes |
| Full gate, Round 2 report, American English, staging | Done; exit 0 for each check and git add -A |

All changes are staged. No commit, push, or code-review run was made.
Branch remains `experiment-mcp`; HEAD remains `2492b12`.

## Round 3

The operator's default-profile review was run `20261012-141423-4058d97b`.
The contracts and contracts-2 lanes produced no verdict: both timed out
after 900 seconds under machine load, and the operator reruns them. The
findings below come from the correctness, security, and edges lanes. No
code-review command was run during Round 3. Every fix is at the root cause
with at least one regression test.

### Fixes and regression evidence

| Finding | Fix and regression |
|---|---|
| Bridge failure after a successful finish (correctness major) | `src/experiment-bridge.ts:266` makes `closeProtocol()` the run's single decision point: it closes the recording and then throws the recorded failure, so a failure that lands after Claude's own successful `finish()` — a server exit, a canceled control request — still fails the run, while `run_end` keeps its `error`. `tests/experiment-protocol.test.ts:189` proves the invariant: a result_received run with a non-null `run_end` error can never complete successfully, and a second `closeProtocol()` still throws. `tests/experiment-bridge.test.ts:217` reproduces it end to end: the server exits 200 ms after its last reply, after the result was already delivered, and the run rejects with the recorded failure. |
| agy diagnostics ignore the result envelope (correctness major) | `src/adapters/agy.ts:215` reverse-scans the probe's stdout for the terminal `result` event and validates it with the ordinary path's `parseAgyResultEnvelope` (`:222`). An `ERROR` status or a missing result event fails the probe even when agy exits 0, with the same stderr wording the ordinary path uses; the native events are still written first. Regression: `tests/agy-isolation.test.ts:169` (failed, passed, and no-event cases against `processRunResult`). |
| Duplex `start()` throws after spawn (edges major) | `src/process-runner.ts:367` wraps the `start()` call; a throw gets the same tree termination a signal gets — SIGTERM, the usual grace, then SIGKILL of the tree — waits for the exit, and rethrows as `CapturedRunFailure` (`:386`). Regression: `tests/process-protocol.test.ts:53` — the child is dead and reaped, none survive. |
| JSON-RPC error responses pass unnoticed (edges major) | `src/experiment-bridge.ts:215` fails the bridge on any JSON-RPC error object, for any method — `ping` included, as documented in HERMETIC.md. Regression: `tests/experiment-protocol.test.ts:161`. |
| Tool inventory not compared (edges major) | `src/experiment-bridge.ts:137` records `tool_inventory` with both sets, and `:139` requires Claude's exposed tools to equal the server's advertised set (as a set) before the first turn; a missing or extra tool fails the run. Regression: `tests/experiment-protocol.test.ts:172` (subset inventory throws with both sets recorded). |
| Prompt size checked only mid-run (edges major) | `src/experiment-mcp.ts:72` refuses a prompt whose serialized user frame exceeds the 1 MiB control-frame bound during request validation, before anything is spawned. One constant and one measurer, `MAX_EXPERIMENT_MESSAGE_BYTES` and `experimentUserFrameBytes` (`src/experiment-bridge.ts:20`), serve both the preflight and the runtime bound. Regression: `tests/experiment-bridge.test.ts:81` (at the limit passes; one byte more fails). |
| Working-directory gate miscompares an omitted cwd (edges minor) | `src/launch.ts:66` compares effective directories, applying the `process.cwd()` default to both sides before the boundary check. Regression: `tests/experiment-bridge.test.ts:47` — an omitted launch cwd passes for a request cwd naming the current directory, and a following deterministic failure (invalid model) proves the gate was cleared. |
| Leftover canary directories (security minors) | `src/hermetic-canary.ts:60` adds scratch tracking on the exit/signal pattern from hermetic-home; `plantCanary` (`:86`, `:109`) plants under the system temp root and now removes its directory at the end in both modes, including on SIGINT/SIGTERM/SIGHUP. `src/agy-isolation-probe.ts:20` plants the probe the same way and cleans in a `finally` (`:49`). Regressions: `tests/experiment-bridge.test.ts:120` (plant, clean, listener counts restored) and `:235` (a SIGINT-interrupted check exits 143 with nothing left in the temp root or the invoking directory); `tests/agy-isolation.test.ts:232` (a failed probe removes its directory). |
| Recordings written to the run directory (security minor) | `src/call-log.ts:170` adds `codemuxStateDir`, which follows the ledger relocation; `src/experiment-bridge.ts:55` writes `experiments/<run-id>.jsonl` there (0600 file inside a 0700 directory) unless the spec names `recording:` — validated at `src/experiment-mcp.ts:49`, relative paths resolved against the spec file at `:54`. `src/adapters/claude.ts:440` reports the path as `codemux.recording` in the `--result-json` envelope and `:454` names it on a plain run's stderr. The `.gitignore` entries for `.codemux-experiment-*.jsonl` and the check directories are gone; fixtures live under the temp root and recordings under the state directory, so nothing lands in a repository or run directory anymore. Regressions: `tests/experiment-bridge.test.ts:102` (default location, modes, and both relocation forms) and `:193` (the CLI envelope carries the recording path; the run directory keeps no JSONL). |

The unit fixtures keep their recordings inside the test ledger's temp
directory through the existing `CODEMUX_TEST_LEDGER` preload redirect, so
no test writes to the operator's state directory. The stale-gate note from
Round 2 does not apply: README.md, docs/HERMETIC.md, and CHANGELOG.md were
updated in place with the recording location, the fail-closed JSON-RPC and
prompt-preflight behavior, and the temp-root canary lifetimes.

### Verification

The first Round 3 gate run and three intermediate suite runs exposed one
race in the new late-failure regression itself: when the fixture's server
exits, the bridge sometimes records the stdout closure first and sometimes
the exit event, so the test now accepts either message — both are the same
failure arriving after the delivered result. Eight consecutive runs of
`tests/experiment-bridge.test.ts` then passed 18/18.

Final `make release-gate` exited **0**:

```text
1798 pass
6 skip
0 fail
Ran 1804 tests across 72 files. [122.67s]
3 pass
0 fail
Ran 3 tests across 1 file. [15.21s]
Release gate passed. Review docs/RELEASE-GATE.md before tagging.
```

Against the operator's pre-Round-3 baseline of **1791 pass, 0 fail**, the
suite grew to 1804 tests and reports **1798 pass, 0 fail** with the same
six skips — every Round 3 regression included, nothing dropped.

```sh
python ~/.claude/skills/humanizer/scripts/check_american.py \
  README.md CHANGELOG.md docs/HERMETIC.md docs/TESTING.md docs/experiment-mcp-report.md
```

Exited **0** with `American English: CLEAN` (0 British spellings). No
spelled-out home path appears in any touched prose, source, or test file;
the only `/Users/` strings in the tree are the pre-existing live-capture
fixtures under `tests/fixtures/live/`. `git diff --check` was clean and
`git add -A` staged everything. No commit, push, or code-review run was
made. Branch remains `experiment-mcp`; HEAD remains `2492b12`.

## Round 4

Review run `20261012-160501-4273a59f` supplied the correctness, security,
and edges findings addressed here. The contracts lanes had no verdict:
Z.AI hit a provider rate limit, and Kimi was out of quota.
No code-review command, commit, or push was run during Round 4.

### Fixes and regressions

| Finding | Root cause fix and regression |
|---|---|
| Paired checks collide on explicit recordings | Round 4 separated probe and control files. Round 5 supersedes its filename rule: `recording` names a directory, runs write `<dir>/<run-id>.jsonl`, and controls write `<dir>/<run-id>.control.jsonl` with their own run IDs. The paired CLI regression verifies mode-0600 files and printed paths and confirms the input spec stays unchanged. README.md and HERMETIC.md document the filenames. |
| Empty agy replies succeed | `src/adapters/agy.ts:218` passes the extracted terminal envelope through ordinary adapter handling and retains the raw events for the diagnostic summary. The probe's separate verdict logic is deleted. `tests/agy-isolation.test.ts:204` checks empty and whitespace responses against the ordinary path's failure and diagnostic. |
| Successful agy probes discard usage | The same ordinary handling at `src/adapters/agy.ts:218` supplies normalized usage. `tests/agy-isolation.test.ts:217` checks input 7, output 3, and cache reads 2 against the ordinary result: uncached input 5, output 3, cached input 2, total 10. |
| Duplicate inventories bypass equality | `src/experiment-bridge.ts:138` compares sorted unique arrays and separately requires no duplicates in Claude's list. The `tool_inventory` record includes `equal: false` on failure. `tests/experiment-protocol.test.ts:208` covers duplicates with a missing advertised tool and duplicates whose unique set is complete. |
| Calls execute before inventory validation | `src/experiment-bridge.ts:192` refuses `tools/call` until `system/init` validates the inventory. `tests/experiment-protocol.test.ts:225` advertises a tool and emits a matching native call before validation; the server receives only the earlier list request. |
| Result does not end the protocol | `src/experiment-bridge.ts:117` rejects every frame after a result. The result handler closes stdin before processing can continue. `tests/experiment-protocol.test.ts:237` puts a result and tool call in the same chunk, verifies one stdin close, and proves no call reaches the server. |
| Capture failure returns before child exit | `src/process-runner.ts:338` separates read cancellation from bounded exit abandonment; `:350` starts tree termination on capture failure. The exit race at `:413` waits for `proc.exited` or the existing grace plus pipe deadline. `tests/process-protocol.test.ts:82` covers overflow, invalid UTF-8, and protocol rejection using real children that ignore SIGTERM; cleanup observes each child already reaped. |
| Timeout loses to an incomplete frame | `src/process-runner.ts:67` passes timeout state to the sink. `src/experiment-bridge.ts:257` records incomplete timed-out output as `control_stdout_partial` without throwing. `tests/experiment-bridge.test.ts:237` verifies exit 124 and the exact partial bytes in JSONL. |
| File-token refresh modifies the real store | `src/adapters/agy.ts:137` creates a mode-0600 copy, never a link. Cleanup never copies it back. `tests/agy-isolation.test.ts:153` checks in-place and atomic replacement refreshes, permissions, and unchanged original contents after cleanup. A file-token rotation during a probe lands only in the private home; the real file store is never modified. The macOS login uses the Keychain; Round 8 mirrors that store separately. HERMETIC.md documents both stores. |

For example, when the server advertises `bash` and `read`, Claude's list
`bash, bash` previously passed while omitting `read`. It now records
`equal: false` and fails before an experiment tool can execute
(`src/experiment-bridge.ts:138`).

### Verification

`make release-gate` exited **0**. Its exact summaries were:

```text
1809 pass
6 skip
0 fail
9040 expect() calls
Ran 1815 tests across 72 files. [128.17s]
3 pass
0 fail
148 expect() calls
Ran 3 tests across 1 file. [13.86s]
Release gate passed. Review docs/RELEASE-GATE.md before tagging.
```

Compared with the operator's **1802 pass, 2 skip, 0 fail** baseline,
there are **11 additional tests** (1804 to 1815), seven additional passes,
and four additional skips. Those four existing tests require the process
table, which this sandbox denies: `EPERM: operation not permitted,
posix_spawn '/bin/ps'`. The runner also reported denied process-group
signals. No sandbox workaround was attempted. All new regressions passed,
including all three real SIGTERM-ignoring children. The two ordinary
installed-contract skips were exercised separately: **3 pass, 0 fail**.

The gate passed type checking, shell syntax, coverage, installed contracts,
scode compatibility, CLI smoke checks, dependency audit, and frozen-lockfile
validation. Conservative whole-source coverage was **87.00% lines** and
**91.96% functions**. There is no separate lint target in this repository.

The initial targeted run had **59 pass, 2 fail** across 61 tests. One
remaining spec-reader call used the old import; the usage test asserted
the raw field name instead of `cached_input_tokens`. Both were corrected
before the full gate. A second duplicate-inventory case brought that
targeted set to 62 tests; the full suite includes every case.

```sh
python ~/.claude/skills/humanizer/scripts/check_american.py \
  README.md docs/HERMETIC.md docs/experiment-mcp-report.md \
  src/adapters/agy.ts src/adapters/claude.ts src/experiment-bridge.ts \
  src/experiment-mcp.ts src/process-runner.ts src/run-context.ts \
  tests/agy-isolation.test.ts tests/experiment-bridge.test.ts \
  tests/experiment-protocol.test.ts tests/fixtures/experiment-claude.ts \
  tests/process-protocol.test.ts
```

Exited **0**: `American English: CLEAN`, 14 files, zero British spellings.

| Requested item | Status |
|---|---|
| All review findings, with regressions | Done; fixes and tests listed above |
| Recording and token-store documentation | Done; README.md, HERMETIC.md, and this report |
| Full release gate and baseline comparison | Done; exit 0, exact counts above |
| Round 4 report and missing contracts verdicts | Done |
| American English and home-path checks | Done; exit 0 |

Round 4 changed 14 files. Earlier staged work remains intact. Branch:
`experiment-mcp`; HEAD: `2492b12`. No commit, push, or code-review run.

## Round 5

Review run `20261012-182034-254a6fb0` passed at the blocker threshold.
The operator supplied six findings and the required decisions. Kimi's
lane was out of quota. The operator's full-gate baseline was **1813 pass,
2 skip, 0 fail**, or 1815 tests.

### Fixes and regressions

| Finding | Root cause fix and regression |
|---|---|
| Truncated server traffic returns success | `src/experiment-server.ts:101` records every buffered fragment as `server_stdout_partial` and fails the bridge. `src/experiment-bridge.ts:297` validates that buffer before writing `run_end`. Partial Claude traffic is also retained and fails the run, with exit 124 preserved on timeout. `tests/experiment-protocol.test.ts:191` feeds a valid reply followed by `{"jsonrpc":` without a newline, accepts Claude's result, then requires cleanup to fail with the exact fragment recorded and a non-null terminal error. The two cases at line 221 cover partial Claude JSON and whitespace. |
| Missing agy home path skips cleanup | `src/adapters/agy.ts:132` opens the parent and home directory descriptors before copying credentials. Cleanup at line 173 verifies their identities with `fstat`. If the home path is absent, it searches the parent's entries by inode. A parent renamed within its own parent is located the same way. Missing or unsafe paths produce a persistent cleanup error naming the token copy and original home identity. Both descriptors close on success or failure. `tests/agy-isolation.test.ts:153` covers renamed homes and parents. The CLI regression at line 191 moves the home outside its parent and verifies a nonzero diagnostic exit and token warning. |
| Fixed recording path fails on reuse | `src/experiment-mcp.ts:65` rejects an existing non-directory during preflight. `src/experiment-bridge.ts:55` creates a missing directory with mode 0700 and writes a unique mode-0600 `<run-id>.jsonl` file. Internally marked controls use `<run-id>.control.jsonl` in that directory, including with the default state location. `tests/experiment-bridge.test.ts:121` verifies repeated runs and refusal before any spawn. The paired-check regression at line 251 verifies both filenames, permissions, and printed paths. README.md, HERMETIC.md, and the Round 4 entry now use the directory contract. |
| Constructor leaks a recording descriptor | `src/experiment-bridge.ts:66` closes the descriptor and removes the partial file if construction fails after exclusive creation. `tests/experiment-bridge.test.ts:142` injects a write failure after writing partial bytes, then verifies EBADF on the descriptor and an empty recording directory. |
| Credential-copy lifetime is undocumented | `src/adapters/agy.ts:149` and `docs/HERMETIC.md:112` document the mode-0600 copy, its probe lifetime, and removal or a loud cleanup failure. The real store receives no write-back. The documentation also states that SIGKILL or a host crash can prevent cleanup. `tests/agy-isolation.test.ts:173` checks copy mode and separate inode, removes the ownership marker, and requires repeated cleanup calls to name the copy while leaving the real token unchanged. |
| Envelope docstrings claim only JSON launches | `src/result-envelope.ts:111` and line 178 now describe both ordinary `--output-format json` output and the validated result extracted from an experiment's `--output-format stream-json` launch. `tests/experiment-protocol.test.ts:234` passes a bridge-extracted result through both helpers and verifies the result and recording metadata. |

### Verification

```sh
bun test --preload ./tests/setup.ts tests/agy-isolation.test.ts tests/experiment-bridge.test.ts tests/experiment-protocol.test.ts
make typecheck
```

Both exited **0**. The targeted suite reported **66 pass, 0 fail**, with
245 assertions across three files. Round 5 adds ten regression cases to
the full suite; no existing cases were removed.

`make release-gate` exited **0**. Its exact summaries were:

```text
1819 pass
6 skip
0 fail
9087 expect() calls
Ran 1825 tests across 72 files. [127.07s]
3 pass
0 fail
148 expect() calls
Ran 3 tests across 1 file. [12.88s]
Release gate passed. Review docs/RELEASE-GATE.md before tagging.
```

Compared with **1813 pass, 2 skip, 0 fail**, this is six more passes,
four more skips, and ten more tests (1815 to 1825). The four additional
skips are existing process-table tests: the sandbox denies `/bin/ps` with
`EPERM: operation not permitted, posix_spawn '/bin/ps'`. It also denied
some process-group signals. Those operations remain blocked; no sandbox
workaround was attempted. All ten new regression cases passed. The
installed-contract stage reported **3 pass, 0 fail** separately.

The gate passed type checking, shell syntax, coverage, installed contracts,
scode compatibility, CLI smoke checks, dependency audit, and frozen-lockfile
validation. Conservative whole-source coverage was **87.05% lines** and
**91.99% functions**. The repository has no separate lint target.

```sh
python ~/.claude/skills/humanizer/scripts/check_american.py \
  README.md docs/HERMETIC.md docs/experiment-mcp-report.md \
  src/adapters/agy.ts src/experiment-bridge.ts src/experiment-mcp.ts \
  src/experiment-server.ts src/result-envelope.ts \
  tests/agy-isolation.test.ts tests/experiment-bridge.test.ts \
  tests/experiment-protocol.test.ts
```

The prose check exited **0**: `American English: CLEAN`, 11 files,
zero British spellings. `git diff --check` exited **0**.

| Requested item | Status |
|---|---|
| All six findings with regression coverage | Done; fixes and evidence above |
| Directory recording contract throughout README, HERMETIC.md, report, and tests | Done |
| Credential lifetime and launch-format documentation | Done |
| Full release gate and comparison with 1813/2/0 | Done; exit 0, with sandbox limitations stated above |
| Round 5 report and American English check | Done |

Round 5 changed 11 files: README.md, docs/HERMETIC.md,
docs/experiment-mcp-report.md, src/adapters/agy.ts, src/experiment-bridge.ts,
src/experiment-mcp.ts, src/experiment-server.ts, src/result-envelope.ts,
tests/agy-isolation.test.ts, tests/experiment-bridge.test.ts, and
tests/experiment-protocol.test.ts. Earlier rounds remain intact. The
handoff uses `git add -A` without a commit or push. No code-review command
was run. Branch: `experiment-mcp`; HEAD: `2492b12`.

## Final live verification on the Round 5 tree

Run by the operator from an unsandboxed process on 2026-10-12 at 19:13 CEST,
on the staged Round 5 tree (gate: 1819 pass, 6 skip, 0 fail in the fixing
agent's sandbox; the operator's own gate is recorded in the session log).
Both commands are the ones documented above.

### Stub-server probe

```
./bin/codemux run -a claude -m haiku --hermetic --tools none --experiment-mcp scratch/experiment-mcp.json --auto read-only --cwd scratch/claude-mcp-run --timeout 180 --result-json -f tests/fixtures/experiment-probe.txt
```

Exit 0. Stderr named the recording,
`~/Library/Application Support/codemux/experiments/8c54590c-1be1-4a42-b4f5-988bf214870c.jsonl`.
The recording holds 47 records: run_start 1, server_spawn 1, control_stdin 7,
control_stdout 20, mcp_request 4, server_stdin 4, server_stdout 3,
tool_inventory 1, tool_call 1, permission 1, server_tool_result 1,
model_tool_result 1, result_comparison 1, run_end 1. The `tool_inventory`
record reads `tools: ["mcp__experiment__bash"]`,
`server_tools: ["mcp__experiment__bash"]`, `equal: true`, with the
`experiment` server `connected` from source `sdk`. The only tool name in
the recording is `mcp__experiment__bash`; the marker
`CODEMUX-MCP-RESULT-8B73E209` is present; `run_end` reads
`result_received: true, tool_calls: 1, model_results: 1, error: null`.
The model's reply quoted the marker and stated that it has no built-in
shell tool, only the experiment server's.

### Extended hermetic canary

```
./bin/codemux check -a claude -m haiku --hermetic --tools none --experiment-mcp scratch/experiment-mcp.json --auto read-only --timeout 180
```

Exit 0. Output: `HERMETIC claude: OK` and `control: planted code word
reached the model, as expected`. The probe and the control each named
their own recording under the same `experiments/` directory, the control's
with the `.control.jsonl` suffix.

## Round 6

### Operator's live evidence

The operator logged into Antigravity 1.3.3 and ran all five diagnostic
modes. These facts supersede the earlier authentication diagnosis:

- Login lives in the macOS Keychain through `go-keyring`. The sandbox blocked
  `~/Library`, causing the authentication failures. The operator tested a
  development scode policy later rejected by security review. Round 8
  replaces that login path with a per-run mirror under scode 0.6.0.
  In this historical run, the `login` probe answered OK,
  and the `control` probe revealed its planted code word. The existing
  private HOME under `~/.gemini/.codemux-isolation-probes/run-*/` works.
- The `hermetic` and `tools` probes failed because agy 1.3.3 rejected the
  undocumented customization flag with `flags provided but not defined`.
  Its help lists no such flag. Round 6 removes it from code, tests, and docs.
- The old `tools-control` exited 1 with
  `denied_actions: [{action: "command"}]` and `no output produced`.
  Headless agy auto-denies command permissions without allow rules, so
  that control proved nothing.
- No agy flag removes built-in tools. The permission reference documents
  seven action classes: `read_file`, `write_file`, `read_url`, `execute_url`,
  `command`, `unsandboxed`, and `mcp`.

No live model request or code-review run was made in Round 6. The operator
runs the redesigned canaries afterward and records their result. Both
Antigravity mechanisms remain candidates, not VERIFIED. The review
findings section supplied for this round was empty, so item 7 is skipped.

### Changes and regressions

| Requested item | Change and regression |
|---|---|
| Remove the unsupported flag | `src/adapters/agy.ts:230` emits only supported switches. The exact argv regression in `tests/agy-isolation.test.ts:59` prevents an extra customization switch. The historical report entry now describes its removal. |
| Hermetic private HOME and clean cwd | `src/adapters/agy.ts:134` accepts the operator home as a parameter and copies only regular-file login fallback state. `src/adapters/agy.ts:316` requires explicit cwd and read-only scode, refuses GEMINI.md, AGENTS.md, and any .agents entry, and names the path. Ancestors through the project root and dangling symlinks are checked. `tests/agy-canary.test.ts:30` covers all three paths and ancestors. |
| Scratch operator home canary | `src/agy-isolation-probe.ts:15` plants GEMINI.md and a fake MCP configuration outside the empty cwd. `src/agy-isolation-probe.ts:45` requires a clean reply and an init event without that server; the direct-HOME control must reveal the code word. `tests/agy-canary.test.ts:41` checks scratch derivation, absence of real-home writes, both contamination channels, and the control. |
| Tools-none protocol and positive control | `src/adapters/agy.ts:276` checks the native stream before accepting a text-only result. `src/agy-stream.ts:2` treats every non-text step and non-empty denied_actions as an attempt. The adapter installs all seven denials and plan mode. `src/agy-isolation-probe.ts:45` accepts a denied command only without its output and requires native activity plus expected output in the bypass-permission control. `tests/agy-canary.test.ts:66` and `:91` cover settings, plain and JSON failures, unknown actions, and both probe verdicts. |
| Lift refusals and gate scode compatibility | `src/adapters/agy.ts:98` enables candidate capabilities. `src/check-command.ts:114` routes public checks through paired canaries. The original development-version requirement in `src/launch.ts:156` is superseded by Round 8's mirror and scode 0.6.0 minimum. `src/launch.ts:175` and `src/sandbox.ts:61` allow only the diagnostic's temporary HOME as writable state because shared temp is otherwise hidden; cwd stays read-only. `tests/agy-canary.test.ts:117` exercises both public checks and their combination using a synthetic CLI; its version and state-allowance regressions remain. |
| Documentation | `docs/HERMETIC.md:119` defines the agy rule; `docs/HERMETIC.md:230` labels both mechanisms candidate, pending the operator's live canary. `README.md:392` and `CHANGELOG.md:25` document the mechanisms, controls, and version minimum. `tests/agy-canary.test.ts:142` guards the candidate labels. |

For example, a native SUCCESS reply saying OK with
`denied_actions: [{action: "command"}]` previously escaped tool detection.
Now `src/agy-stream.ts:30` records command as an attempted action, and
`src/adapters/agy.ts:302` makes the ordinary `--tools none` run fail by
name. The diagnostic separately treats a denied command without output
as its expected observation. A successful diagnostic is not a successful
text-only production run.

Static `verify` builds commands without preparing a home. Enabling agy's
capabilities exposed its old diagnostic-only preparation guard there.
`src/adapters/agy.ts:259` now builds a placeholder path without writing
state, matching the other private-home adapters. `:267` still refuses an
actual launch without preparation. The regression is
`tests/agy-canary.test.ts:154`.

### Verification

Final `make release-gate` exited **0**. Exact summaries:

```text
1833 pass
6 skip
0 fail
9153 expect() calls
Ran 1839 tests across 73 files. [132.90s]
3 pass
0 fail
148 expect() calls
Ran 3 tests across 1 file. [14.92s]
Release gate passed. Review docs/RELEASE-GATE.md before tagging.
```

Compared with **1823 pass, 2 skip, 0 fail**, this adds **14 tests**
(1825 to 1839): ten more passes, four more skips, and no failures.
No existing test was removed. The four extra skips are the existing
process-table checks: the sandbox denied `/bin/ps` with
`EPERM: operation not permitted, posix_spawn '/bin/ps'`. Some process-group
signals were also denied. Those operations remain blocked; no workaround
was attempted. The separate installed-contract stage passed all three
tests and exercised 14 installed binaries without a model request.

The gate passed type checking, shell syntax, coverage, installed
contracts, scode compatibility, CLI smoke checks, dependency audit, and
frozen-lockfile validation. Conservative coverage was **87.03% lines**
and **92.04% functions**. There is no separate lint target.

The first completed full suite reported 1815 pass, 6 skip, 17 fail,
and five errors across 1838 tests. Two failures exposed the static
verification guard fixed above. The next full suite included that fix
and its new regression: 1829 pass, 6 skip, 4 fail, and one error across
1839 tests. Host load averaged as high as 496 during those runs, and
existing startup, shutdown, and large-output tests missed deadlines.
The final full gate passed after load fell, with those tests and their
assertions unchanged. Its runtime was 132.90 seconds, versus 402.28 and
265.54 seconds for the earlier full suites.

The focused verification after the static-preview fix also exited **0**:

```sh
bun test --preload ./tests/setup.ts tests/agy-canary.test.ts tests/verify.test.ts tests/agy-isolation.test.ts
```

It reported **46 pass, 0 fail**, with 292 assertions across three files.
The final full suite includes all 14 new regression cases.

```sh
python ~/.claude/skills/humanizer/scripts/check_american.py \
  README.md CHANGELOG.md docs/HERMETIC.md docs/experiment-mcp-report.md \
  src/adapters/agy.ts src/adapters/base.ts src/agy-isolation-probe.ts \
  src/agy-stream.ts src/check-command.ts src/cli-runtime.ts src/launch.ts \
  src/run-context.ts src/sandbox.ts tests/agy-isolation.test.ts \
  tests/agy-canary.test.ts tests/fixtures/agy-canary.ts tests/helpers/cli.ts \
  tests/hermetic.test.ts tests/new-adapters.test.ts
```

The prose check exited **0**: `American English: CLEAN`, 19 files,
zero British spellings. `git diff --check` exited **0**. No literal
operator home path was added; displayed home paths use `~`.

| Requested item | Status |
|---|---|
| Unsupported flag removal with regression | Done |
| Private HOME and clean run-directory rule with regression | Done |
| Scratch operator canary and leaking control with regression | Done |
| Seven denials, text-only detection, and command control with regression | Done |
| Public candidate flags, paired checks, and scode minimum with regressions | Done |
| README, HERMETIC, CHANGELOG, and Round 6 report | Done |
| Appended review findings | Skipped; the supplied section was empty |
| Full release gate and baseline comparison | Done; exit 0, counts above |
| American English, path checks, and staging | Done |
| Operator's live candidate canaries | Pending the operator, as requested; not claimed VERIFIED |

Round 6 changed 19 files: CHANGELOG.md, README.md, docs/HERMETIC.md,
docs/experiment-mcp-report.md, src/adapters/agy.ts, src/adapters/base.ts,
src/agy-isolation-probe.ts, src/agy-stream.ts, src/check-command.ts,
src/cli-runtime.ts, src/launch.ts, src/run-context.ts, src/sandbox.ts,
tests/agy-isolation.test.ts, tests/agy-canary.test.ts,
tests/fixtures/agy-canary.ts, tests/helpers/cli.ts, tests/hermetic.test.ts,
and tests/new-adapters.test.ts. `git add -A` stages these changes and the
earlier rounds together. No commit, push, or code-review run was made.
Branch remains `experiment-mcp`; HEAD remains `2492b12`.

## Round 7

Antigravity 1.3.3 hermetic and tools-none mechanisms are **VERIFIED** from
the operator's evidence below. This round makes no live canary or model
request. Its login access was subsequently rejected by security review.
Round 8 replaces it with a mirror and restores the scode 0.6.0 minimum.
The verdict here covers the historical run, not Round 8's untested live
integration. Gate counts remain in their respective rounds.

### Operator fixes retained

| Fix | Implementation and regression |
|---|---|
| scode probe environment | `src/launch.ts:163` passes the parent environment to the agy scode-version probe, matching doctor. Without HOME, scode refused with `unsafe HOME`. `tests/agy-canary.test.ts:154` makes a synthetic scode reject an absent HOME before reporting its version, then requires the public check to pass. |
| Keychain lookup through HOME | The operator established that `security` resolves the login store through HOME. Round 8 retains that discovery but replaces all real-Keychain links with a private mirror. `src/agy-keychain.ts` builds it in the parent; `tests/agy-keychain.test.ts` checks the sequence, layout, refusal, secret handling, and cleanup. |
| Native deny-rule reporting | `src/agy-stream.ts:30` reads a tool step's `tool_info.error.message` alongside result `denied_actions`. An ERROR tool step naming `Permission denied for unsandboxed(...)` records `unsandboxed`, the actual rule class. The operator's regression at `tests/agy-canary.test.ts:203` remains and now checks the public run failure too. |
| Diagnostic denial class | `src/agy-isolation-probe.ts:58` accepts any denied attempted action when the command's output is absent. The operator's realpath-safe assertion remains at `tests/agy-canary.test.ts:56`. The deny-rule regression also checks that `unsandboxed` passes the diagnostic only without the expected command output. |

### Live evidence (historical)

Live evidence (operator, 2026-10-12, agy 1.3.3, development scode in PATH; logs in the session scratch).
The obsolete login requirement has been removed from this excerpt; Round 8
documents its replacement. The command outcomes below are unchanged.

- `codemux check -a agy --agy-isolation-probe {login,hermetic,control,tools,tools-control}`: all five
  `passed: true`, exit 0 (login answered `OK`; hermetic reply had no code word and the init event listed
  no planted MCP server; control reply carried the code word; tools: `run_command` attempted and denied by
  the rule, output absent; tools-control: the command ran under `--dangerously-skip-permissions` in
  read-only scode and its output was quoted).
- `codemux check -a agy --hermetic --tools none --auto read-only`: `HERMETIC agy: OK` and `TOOLS agy: OK`,
  exit 0.
- `codemux run -a agy --hermetic --tools none --auto read-only -p "Reply with exactly: OK"`: exit 0,
  response `OK`. The same run asked to execute `echo CODEMUX-X` with its command tool: the attempt was
  denied by the rule and codemux failed the run with `agy --tools none forbids attempted actions: tool,
  unsandboxed`, exit 1.

Verdict: **VERIFIED** for hermetic and tools-none headless runs on this
evidence. Hermetic used private HOME and a clean working directory with
the former login access. Round 8 replaces only that access with a mirror.
Tools-none uses deny-all settings + plan mode + attempt
detection, under read-only scode. Tool schemas can remain visible; any
attempt makes an ordinary text-only run fail.

### Round-5 findings closed

| Finding | Root cause fix and regression |
|---|---|
| Protocol abort could return success (major) | `src/process-runner.ts:395` records protocol abort separately from capture exceptions; line 497 rejects even when the child exits zero. `tests/process-protocol.test.ts:10` uses a real child whose SIGTERM handler exits zero and requires `protocol capture aborted`. |
| Recording finalized before server readers (major) | `src/experiment-server.ts:126` terminates the server and awaits both readers with `Promise.allSettled` before partial-frame validation. `src/experiment-bridge.ts:300` awaits that close before `run_end`, fsync, and descriptor close. `tests/experiment-shutdown.test.ts:23` queues partial stdout during shutdown, holds stderr open, verifies no premature `run_end`, then supplies late stderr and requires failure with all bytes retained. |
| Cleanup abort recreated timers (major) | Timer state exists before protocol start. `src/process-runner.ts:357` refuses to create termination timers once cleanup starts at line 462. Every earlier termination path assigns each timer at most once. Async protocol cleanup is awaited after runner cleanup; its abort still fails the run. `tests/process-protocol.test.ts:21` aborts twice during async close and verifies no timer creation or signal to the finished group. |
| Inbound frame boundary (minor) | `src/experiment-server.ts:85` and `src/experiment-bridge.ts:118` count the newline in the 1 MiB limit, as outbound writes do. A delimiter-free buffer already at the limit is also rejected. `tests/experiment-shutdown.test.ts:68` tests both transports at exactly the limit and one byte over. |
| Untrusted server executable (minor) | `src/experiment-server.ts:35` calls `resolveTrustedExecutable` before spawn with the run directory as the forbidden root. `tests/experiment-shutdown.test.ts:54` rejects a group/world-writable file and an executable inside cwd, with no spawn. |
| External server termination (minor) | `src/experiment-bridge.ts:285` exposes synchronous server termination; `src/process-runner.ts:320` and line 346 call it on signal and timeout. The server also registers an exit backstop. `tests/experiment-shutdown.test.ts:94` checks both stop paths terminate the external process group before protocol close. SIGKILL and host crashes remain uncatchable; documentation states the limit. |
| Token-copy note (minor) | Round 7 distinguished the macOS Keychain from the file fallback's temporary 0600 copy. Round 8 now copies the whole macOS token into a 0600 per-run keychain too, with no write-back. The earlier file-fallback mode, refresh, cleanup-refusal, and unchanged-original regressions remain; mirror regressions are in `tests/agy-keychain.test.ts`. |
| Stale Outcome gate count (minor) | Outcome points to Round 7 instead of duplicating a final count. `tests/agy-canary.test.ts:144` checks that reference, rejects pass counts in Outcome, and requires both VERIFIED rows. Historical gates retain their original counts. |
| Cleanup contract drift (minor) | `src/adapters/base.ts:269` documents throwing or asynchronous cleanup. Launch awaits it and retains both errors if launch and cleanup fail (`src/launch.ts:242`); exit cleanup reports failures without masking the exit. `tests/process-protocol.test.ts:44` requires both launch rejection and asynchronous cleanup refusal in the diagnostic. Existing cleanup-receipt coverage remains. |

For example, a child can catch SIGTERM and exit zero after its protocol
consumer rejects output. The old runner returned success; the runner now
rejects with `protocol capture aborted` (`src/process-runner.ts:497`).
A separate late partial server frame is retained and makes `run_end.error`
non-null even if Claude already supplied an OK result.

### Verification

`make release-gate` exited **0**. Exact summaries:

```text
1846 pass
6 skip
0 fail
9201 expect() calls
Ran 1852 tests across 74 files. [146.21s]
3 pass
0 fail
148 expect() calls
Ran 3 tests across 1 file. [14.39s]
Release gate passed. Review docs/RELEASE-GATE.md before tagging.
```

Compared with Round 6's **1833 pass, 6 skip, 0 fail**, this adds 13
tests (1839 to 1852): the operator's deny-rule test and 12 new cases in
this round. No tests were removed. The separate installed-contract stage
passed all three tests and exercised 14 installed harness binaries without
a model request. The gate passed type checking, shell syntax, coverage,
installed contracts, scode compatibility, CLI smoke checks, dependency
audit, and frozen-lockfile validation. Conservative coverage was **87.09%
lines** and **91.96% functions**. There is no separate lint target.

The six skips are unchanged: four process-table-dependent tests and two
installed-contract cases exercised separately. The sandbox refused
`/bin/ps` with `EPERM: operation not permitted, posix_spawn '/bin/ps'`
and some process-group signals with `EPERM: Operation not permitted`.
Those denied operations remain blocked; no workaround was attempted.
The new server signal and timeout regressions use synthetic processes.

The focused command also exited **0**:

```sh
bun test --preload ./tests/setup.ts tests/experiment-shutdown.test.ts \
  tests/agy-canary.test.ts tests/experiment-protocol.test.ts \
  tests/experiment-bridge.test.ts
```

It reported **68 pass, 0 fail**, 269 assertions across four files.
An earlier three-file run reported 45 pass and one failure: the new
deny-rule production assertion omitted the prepared run context. Passing
the context fixes the test setup and verifies the existing operator fix.
An initial focused run was interrupted after a synthetic shutdown test
waited for rejection before supplying EOF; the corrected test queues EOF
before awaiting rejection. Neither issue changed production semantics.

`check_american.py` on all 20 Round 7 prose/source/test files exited **0**:
`American English: CLEAN`, zero British spellings. `git diff --check`
exited **0**. No literal operator home path was introduced.

| Requested item | Status |
|---|---|
| Preserve and document all four operator fixes, with regressions | Done |
| Operator evidence and VERIFIED verdict in all requested docs | Done; obsolete login requirement superseded in Round 8 |
| Close all Round-5 findings with regression coverage | Done; uncatchable SIGKILL limit documented |
| Full release gate and test-count comparison | Done; exit 0, exact summaries above |
| American English and whitespace checks | Done; exit 0 |
| Stage all changes, without commit, push, or code-review | Done |
| Rerun live canaries | Not run, as requested |
| Sandbox-denied process-table and group-signal operations | Blocked by the sandbox; stopped without a workaround |

This round edits 18 files: CHANGELOG.md, README.md, docs/HERMETIC.md,
docs/experiment-mcp-report.md, src/adapters/agy.ts, src/adapters/base.ts,
src/adapters/claude.ts, src/experiment-bridge.ts, src/experiment-server.ts,
src/launch.ts, src/process-runner.ts, src/run-exit-cleanup.ts,
src/session/cli.ts, tests/agy-canary.test.ts,
tests/experiment-bridge.test.ts, tests/experiment-protocol.test.ts,
tests/experiment-shutdown.test.ts, and tests/process-protocol.test.ts.
The operator's staged src/agy-isolation-probe.ts and src/agy-stream.ts
fixes remain unchanged and are included in the 20-file prose check.
`git add -A` stages all work, including earlier rounds. No commit, push,
code-review, or live canary was run. Branch: `experiment-mcp`;
HEAD: `2492b12`.

## Round 8

Every sandboxed agy run now gets a per-run HOME and a parent-built
Keychain mirror. The required scode version is **0.6.0**. No live canary,
model request, code-review, commit, or push was run in this round.
The operator subsequently ran the final live table below on this Round 8
tree with installed scode 0.6.0. The policies and mirror integration are
**VERIFIED** on that basis.

### Why the previous login access was rejected

Scode's security review rejected and reverted the read-only allowance for
`~/Library/Keychains`. Antigravity's `go-keyring` invokes `/usr/bin/security`,
and the credential items trust that executable in their access lists.
Allowing the real directory would therefore let any sandboxed child invoke
that same executable to read every trusted item, including Claude Code's
credential, gh's token, and Antigravity's refresh token. Read-only access
does not prevent disclosure. Scode 0.6.0 continues to block `~/Library`.
The mirror exposes only the Antigravity item during this run.

### Operator-established mechanics

The operator demonstrated these mechanics before this implementation:

- `security` resolves the login keychain through HOME at
  `$HOME/Library/Keychains/login.keychain-db`.
- Outside scode, `security find-generic-password -s gemini -a antigravity -w`
  reads the item without a prompt because its access list trusts
  `/usr/bin/security`. The operator reported 2270 bytes of opaque text.
  This round did not read or print that credential.
- `security create-keychain -p <random-hex> <private-home>/Library/Keychains/login.keychain-db`
  creates an unlocked keychain. `security set-keychain-settings <file>`
  disables auto-lock. An explicit unlock reports a wrong passphrase on
  the observed backend, so the builder never calls it.
- Round 8 put `-w <secret>` in the `add-generic-password` process argv.
  This exposed the credential to process inspection. Round 9 sends that
  command through `/usr/bin/security -i` stdin instead.
- With relocated HOME under scode 0.6.0, `security list-keychains` resolves
  the mirror as the login keychain and its item is readable. The real
  Keychain stays hidden. This did not verify the real user's search list:
  creation adds the mirror there. After the live runs, the operator found
  thirteen dangling mirror entries and restored the list to the login
  keychain only. Round 9 snapshots and immediately restores the real list.

The operator accepted a whole-token mirror, including the refresh token,
in a 0600 file inside a 0700 private home for the run's lifetime. A refresh
inside the run updates only the mirror. The next run re-mirrors the real
Keychain item; there is no write-back. SIGKILL and host crashes can prevent
cleanup. Ordinary cleanup retains the existing directory identity and
ownership-marker checks and fails loudly if it cannot remove the home.

### Changes and regressions

| Change | Implementation and evidence |
|---|---|
| Parent-side mirror builder | `src/agy-keychain.ts:9` resolves `security` on PATH and skips only when unavailable. Line 21 reads the single service/account item; lookup failure returns exactly "agy is not logged in; run `agy` to log in". Lines 29–37 create, configure, and populate the keychain with a random hex password, a resolved agy ACL entry, and mode 0600. Subprocess stdout, stderr, and thrown errors never enter an error message. |
| Every sandboxed run has a private HOME | `src/adapters/agy.ts:124` prepares a home even for plain runs. Line 154 builds the mirror before launch; line 156 links plain `.gemini` to the operator's real state. Hermetic and probe homes remain clean. Existing tools-none runs also retain their clean state so deny settings cannot overwrite the operator's settings. Unsandboxed runs remain unchanged. |
| Controls and cleanup | `src/adapters/agy.ts:173` copies only planted instructions and settings into the control's own home. `src/agy-isolation-probe.ts:24` no longer links either scratch operator home to Keychains. `src/adapters/agy.ts:194` retains identity-checked cleanup; line 234 names a remaining mirror on refusal. `src/run-context.ts:27` documents the expanded context lifetime. |
| Plain output and session compatibility | `src/adapters/agy.ts:268` keeps ordinary JSON output for plain runs despite HOME relocation. Line 291 reserves native-stream extraction for isolation modes. `tests/agy-keychain.test.ts:35` checks the plain reply and symlink alongside the hermetic layout. The existing session environment lookup at `src/session/cli.ts:934` supplies no run context; `src/adapters/agy.ts:281` retains that contract, checked at `tests/agy-isolation.test.ts:38`. The mirror lifecycle belongs to `run` and `check`; session and TUI launch paths are unchanged. |
| scode minimum | `src/launch.ts:160` restores 0.6.0, preserving the parent environment on the version probe. `tests/agy-canary.test.ts:123` exercises paired public checks at 0.6.0, rejects 0.5.0, and retains the HOME-sensitive version probe. |
| Credential-safe synthetic security | `tests/fixtures/agy-security.ts:1` records sanitized argv only, validates the opaque secret in memory, and can emit it on both failure streams. `tests/agy-keychain.test.ts:35` checks exact create/settings/add ordering and ACLs; line 79 covers every failure stage and partial cleanup; line 119 checks CLI output, errors, ledger, and no prompt launch on refusal. Line 138 checks native recordings; line 152 checks concurrent mirrors and refresh isolation; line 168 checks loud cleanup refusal. |
| Existing fixture isolation | `tests/helpers/cli.ts:89` supplies fake security for synthetic agy binaries, preventing test access to the operator's real Keychain. `tests/agy-isolation.test.ts:89` and `tests/agy-canary.test.ts:170` replace the old real-home/link expectations with private-home and no-link assertions. |
| Documentation | `README.md:397`, `docs/HERMETIC.md:108`, and `CHANGELOG.md:25` describe the mirror, lifetime, refresh trade-off, and scode 0.6.0. The operator's final live table below establishes VERIFIED status. Earlier report sections retain historical command outcomes and gate counts. |

For example, when `security add-generic-password` fails and echoes its
secret-bearing arguments, `src/agy-keychain.ts:12` discards both streams
and returns only `cannot populate agy keychain mirror`. Preparation removes
the partial home before the prompt can launch. The CLI regression checks
that no prompt-launch marker or ledger exists after this refusal. The
existing compatibility check may run `agy --version` before preparation.

### Verification

The focused command exited **0**:

```sh
bun test --preload ./tests/setup.ts tests/agy-keychain.test.ts tests/agy-isolation.test.ts tests/agy-canary.test.ts
```

It reported **57 pass, 0 fail**, 286 assertions across three files. The
first focused run had 52 pass and two failures: documentation still had
the old version requirement, and a JSON assertion expected pretty printing.
Both are corrected. A subsequent compatibility check exposed Bun's absent
`signalCode` on successful synchronous processes; accepting an absent signal
restored success handling. No live credential or harness request was involved.

The first `make release-gate` exited **2** with **1862 pass, 6 skip,
2 fail**, 9310 assertions, and 1870 tests across 75 files. Both failures
were in the new no-launch fixture: its marker treated `agy --version`
as a prompt launch (`tests/agy-keychain.test.ts:21`). The fixture now
handles the version probe separately. No production check was weakened.
The corrected mirror-only command exited **0**:

```sh
bun test --preload ./tests/setup.ts tests/agy-keychain.test.ts
```

It reported **18 pass, 0 fail**, 111 assertions across one file.

A second gate had already loaded the broader environment guard when the
session regression was added. It reported **1864 pass, 6 skip, 1 fail**,
9312 assertions, and 1871 tests. The new test reproduced the session
refusal against that loaded code. A fresh focused run with the retained
session contract exited **0**: **58 pass, 0 fail**, 289 assertions across
three files. The final gate was restarted on the settled implementation.

The sandbox refused `/bin/ps` with `EPERM: operation not permitted,
posix_spawn '/bin/ps'` and some process-group signals with
`EPERM: Operation not permitted`. These operations remain blocked; no
workaround was attempted. Four process-table-dependent cases are skipped,
alongside the two installed-contract cases that the gate exercises separately.

Final `make release-gate` exited **0**. Exact summaries:

```text
1865 pass
6 skip
0 fail
9313 expect() calls
Ran 1871 tests across 75 files. [141.11s]
3 pass
0 fail
148 expect() calls
Ran 3 tests across 1 file. [14.75s]
Release gate passed. Review docs/RELEASE-GATE.md before tagging.
```

Compared with Round 7's **1846 pass, 6 skip, 0 fail**, the full suite
adds **19 tests**, from 1852 to 1871, with 19 more passes and unchanged
skips. Compared with the preceding run's 1871 tests, the count is unchanged
and the session regression now passes. No test was removed or filtered.
The separate installed-contract stage passed all three cases and exercised
14 installed binaries without a model request. The gate passed type
checking, shell syntax, coverage, installed contracts, scode compatibility,
CLI smoke checks, dependency audit, and frozen-lockfile validation.
Conservative coverage is **87.11% lines** and **92.04% functions**.
There is no separate lint target.

```sh
python ~/.claude/skills/humanizer/scripts/check_american.py \
  README.md CHANGELOG.md docs/HERMETIC.md docs/experiment-mcp-report.md \
  src/adapters/agy.ts src/agy-keychain.ts src/agy-isolation-probe.ts \
  src/launch.ts src/run-context.ts tests/agy-canary.test.ts \
  tests/agy-isolation.test.ts tests/agy-keychain.test.ts \
  tests/fixtures/agy-security.ts tests/helpers/cli.ts
git diff --check
git add -A
```

All three exited **0**. The prose check reported `American English: CLEAN`,
14 files, zero British spellings. The home-path check found no literal
operator home paths in these files; displayed home paths use `~`.

| Requested item | Status |
|---|---|
| Private HOME, one-item mirror, ordinary-state symlink, and clean isolation state | Done; full gate passes |
| Missing-login refusal, unavailable-security fallback, and secret-safe diagnostics | Done; synthetic security tests pass |
| Restore scode 0.6.0 and replace obsolete login instructions | Done in launcher, README, HERMETIC, CHANGELOG, and report |
| Builder, layout, cleanup, refresh, and recording regressions | Done; 19 new cases, full suite passes |
| Round 8 report with file references, rejection reason, and mechanics | Done; VERIFIED by the operator's final live table below |
| Full release gate and Round 7 count comparison | Done; exit 0, exact summaries above |
| American English, home-path, whitespace, and staging checks | Done; exit 0 |
| Live canaries | VERIFIED; subsequently run by the operator, as recorded below |
| Sandbox-denied process-table and process-group operations | Blocked; no workaround |
| Commit, code-review, and push | Not run, as requested |

Round 8 changes 14 files: CHANGELOG.md, README.md, docs/HERMETIC.md,
docs/experiment-mcp-report.md, src/adapters/agy.ts, src/agy-keychain.ts,
src/agy-isolation-probe.ts, src/launch.ts, src/run-context.ts,
tests/agy-canary.test.ts, tests/agy-isolation.test.ts,
tests/agy-keychain.test.ts, tests/fixtures/agy-security.ts, and
tests/helpers/cli.ts. Earlier staged rounds remain intact. `git add -A`
stages all work. No commit, code-review, push, or live canary was run.
Branch remains `experiment-mcp`; HEAD remains `2492b12`.

## Final live verification on the Round 8 tree (mirror keychain, installed scode 0.6.0)

Run by the operator from an unsandboxed process on 2026-10-12 at 21:58 CEST
with the installed scode 0.6.0 (no Keychain carve-out; `~/Library` blocked)
and agy 1.3.3, logged in. Every command is the documented one.

| Command | Result |
| --- | --- |
| `codemux run -a agy --auto read-only -p "Reply with exactly: OK"` | `OK`, exit 0 |
| `codemux check -a agy --agy-isolation-probe login` | `passed: true`, exit 0 |
| `codemux check -a agy --agy-isolation-probe hermetic` | `passed: true`, exit 0 |
| `codemux check -a agy --agy-isolation-probe control` | `passed: true`, exit 0 |
| `codemux check -a agy --agy-isolation-probe tools` | `passed: true`, exit 0 |
| `codemux check -a agy --agy-isolation-probe tools-control` | `passed: true`, exit 0 |
| `codemux check -a agy --hermetic --tools none --auto read-only` | `HERMETIC agy: OK`, `TOOLS agy: OK`, exit 0 |
| `codemux run -a agy --hermetic --tools none --auto read-only --result-json -p "Reply with exactly: OK"` | exit 0 |

No private home or mirror keychain remained under
`~/.gemini/.codemux-isolation-probes/` after the runs. Antigravity's hermetic
mode and tools-none are therefore VERIFIED on this tree with the mirror
mechanism, and no scode change is required.

## Round 9

The operator verified both mirror defects by hand. `security create-keychain`
adds its new file to `security list-keychains -d user`, the real user's
search list. After the live runs, that list contained thirteen dangling
mirror entries. The operator restored it to the login keychain only.
The relocated-HOME check in Round 8 did not establish that the real list
was unchanged. Round 8 also put the whole credential, refresh token included,
in `security` process argv, readable through `ps -axww`.

### Changes and regression evidence

| Finding | Root correction and regression |
|---|---|
| Unchecked security executable | `src/agy-keychain.ts:13` selects only absolute `/usr/bin/security`; `src/agy-keychain.ts:21` applies the harness executable trust check. The subprocess receives only the real login HOME and a fixed system PATH. `tests/agy-keychain.test.ts:189` proves a fake on PATH cannot replace the production path or receive ambient environment variables; `tests/agy-keychain.test.ts:206` rejects a writable executable before invocation. |
| Credential exposed in argv | `src/agy-keychain.ts:45` quotes the interactive input and rejects line breaks, NUL, and oversized commands before creation. `src/agy-keychain.ts:102` invokes only `security -i`, with `add-generic-password ... -w <secret>` on stdin. `tests/agy-keychain.test.ts:213` requires the synthetic secret in stdin only and absent from every argv. The existing mirror tests also verify quotes, backslashes, spaces, and ACL paths. `tests/agy-keychain.test.ts:247` covers malformed interactive input. |
| Real search list changed | `src/agy-keychain.ts:78` snapshots the user list before creation. `src/agy-keychain.ts:87` restores the exact entries immediately after creation, even when creation reports failure, before permissions, settings, or insertion. The next read verifies restoration. `src/adapters/agy.ts:212` checks for lingering mirror entries during cleanup and reports them even while removing the private home. `tests/agy-keychain.test.ts:224` covers creation and later failures; lines 232 and 239 cover failed or ineffective restoration and cleanup detection. |
| Server cleanup exceeds timeout | `src/experiment-server.ts:128` starts the existing runner's 2000 ms grace plus 1000 ms pipe give-up deadline at termination. `src/experiment-server.ts:138` drains within that deadline, abandons readers that cannot reach EOF, and reports incomplete capture. `tests/experiment-shutdown.test.ts:23` creates real detached orphans retaining stdout and stderr after their leader exits; both cases return within the bound. |
| Cleanup hides the first failure | `src/process-runner.ts:463` retains the first capture/start error. `src/process-runner.ts:489` appends cleanup failure as a note, preserving the original message and cause. `tests/process-protocol.test.ts:55` covers startup, output capture, and protocol abort followed by cleanup refusal. For example, `original protocol failure` followed by `cleanup refused` now reports `original protocol failure; cleanup failed: cleanup refused`. Preparation also retains its original error if private-home cleanup fails (`src/adapters/agy.ts:184`). |
| Wrong file-fallback source | `src/adapters/agy.ts:161` reads the fallback token from `os.homedir()` through the host seam. The operator-home parameter supplies only instruction/config state. The Keychain client also sets HOME from that real-home source in every mode (`src/agy-keychain.ts:23`). `tests/agy-keychain.test.ts:255` plants different tokens in the real and operator homes and checks all five probe modes without security. |
| Contradictory verification status | `README.md:94`, `README.md:397`, `docs/HERMETIC.md:23`, `docs/HERMETIC.md:108`, `docs/HERMETIC.md:262`, `CHANGELOG.md:27`, and `src/adapters/agy.ts:98` now say VERIFIED from the final Round 8 live table with installed scode 0.6.0. This report's Outcome and Round 8 close use the same evidence. `tests/agy-canary.test.ts:159` rejects the contradictory current claims. No new live run is claimed. |
| Stale capability comment | `tests/new-adapters.test.ts:59` now describes the verified isolation and tools-none mechanisms asserted beneath it. `tests/agy-canary.test.ts:175` guards that correction. |

Apple's [interactive command parser](https://github.com/apple-oss-distributions/SecurityTool/blob/main/security.c)
uses a 4096-byte line buffer and backslash quoting. Its
[line reader](https://github.com/apple-oss-distributions/SecurityTool/blob/main/readline.c)
ends input at a newline. The builder sends exactly one quoted command, followed
by EOF, so a later command cannot overwrite a failed insertion's exit status.
The random keychain creation password remains separate from the credential.

`tests/fixtures/agy-security.ts:1` records raw synthetic argv and stdin and
models creation adding an entry to the search list. `tests/fixtures/agy-host.ts:1`
injects the fake only in tests; production has no environment-controlled path
override. `tests/helpers/cli.ts:27` preloads that seam for synthetic agy CLI
tests. `tests/setup.ts:19` prevents the full suite from reading real file
credentials, and `tests/agy-isolation.test.ts:20` supplies an isolated login
home for file-copy tests. No real Keychain command or live agy request ran.

### Verification

The first focused five-file run reported **94 pass, 1 fail**, 95 tests.
The new carriage-return regression found that the old newline trim also
removed a credential's final carriage return. Trimming only security's final
newline preserves that byte so the interactive-input validator rejects it
before creation. The corrected two-file run exited **0**:

```sh
bun test --preload ./tests/setup.ts tests/agy-keychain.test.ts tests/agy-canary.test.ts
```

It reported **53 pass, 0 fail**, 260 assertions across two files. A separate
stdin-only regression was then added before starting the full release gate.
The initial type checks found only fixture typing issues; those were corrected
before the gate.

`make release-gate` exited **0** on Bun **1.3.14**. The full output is in
`scratch/round9-release-gate.log`. Exact summaries:

```text
1889 pass
6 skip
0 fail
9385 expect() calls
Ran 1895 tests across 75 files. [156.32s]
3 pass
0 fail
148 expect() calls
Ran 3 tests across 1 file. [18.43s]
Release gate passed. Review docs/RELEASE-GATE.md before tagging.
```

Compared with Round 8's **1865 pass, 6 skip, 0 fail**, this adds **24 tests**,
from 1871 to 1895, with 24 more passes and unchanged skips. No tests were
removed or filtered. The separate installed-contract stage passed all three
cases and exercised 14 installed harness binaries through help/version
commands, without model requests. The gate passed the runtime floor, type
checking, shell syntax, coverage, installed contracts, scode compatibility,
CLI smoke checks, dependency audit, and frozen-lockfile validation. Conservative
coverage is **87.16% lines** and **91.99% functions**. There is no separate
lint target.

The six skips are unchanged: four process-table-dependent cases and two
installed-contract cases exercised separately. The sandbox refused `/bin/ps`
with `EPERM: operation not permitted, posix_spawn '/bin/ps'` and some process-group
signals with `EPERM: Operation not permitted`. Those operations remain blocked;
no workaround was attempted. Both new real-orphan pipe tests passed.

```sh
python ~/.claude/skills/humanizer/scripts/check_american.py \
  README.md CHANGELOG.md docs/HERMETIC.md docs/experiment-mcp-report.md \
  src/adapters/agy.ts src/agy-keychain.ts src/experiment-server.ts \
  src/process-runner.ts tests/agy-canary.test.ts tests/agy-isolation.test.ts \
  tests/agy-keychain.test.ts tests/experiment-shutdown.test.ts \
  tests/fixtures/agy-host.ts tests/fixtures/agy-security.ts tests/helpers/cli.ts \
  tests/new-adapters.test.ts tests/process-protocol.test.ts tests/setup.ts
git diff --check
git add -A
```

All three exited **0**. The prose check reported `American English: CLEAN`:
18 files, zero British spellings. No literal operator home path was added;
displayed home paths use `~`.

| Requested item | Status |
|---|---|
| Trusted security executable, stdin credential transfer, immediate list restoration, and cleanup verification | Done; synthetic regressions and full gate pass |
| Bounded server readers with real-orphan regressions | Done; stdout and stderr cases pass |
| First-error preservation and real-home file-fallback source | Done; startup/capture/abort and all five fallback modes pass |
| One VERIFIED record and matching capability comment | Done; all requested documents use the final Round 8 live table |
| Round 9 report with file references and operator search-list fact | Done |
| Full release gate and Round 8 count comparison | Done; exit 0, exact summaries above |
| American English, whitespace, home-path check, and staging | Done; exit 0; earlier staged rounds retained |
| Sandbox-denied process-table and process-group operations | Blocked; stopped without a workaround |
| Commit, code-review, push, and live model requests | Not run, as requested |

Round 9 changes 18 files: CHANGELOG.md, README.md, docs/HERMETIC.md,
docs/experiment-mcp-report.md, src/adapters/agy.ts, src/agy-keychain.ts,
src/experiment-server.ts, src/process-runner.ts, tests/agy-canary.test.ts,
tests/agy-isolation.test.ts, tests/agy-keychain.test.ts,
tests/experiment-shutdown.test.ts, tests/fixtures/agy-host.ts,
tests/fixtures/agy-security.ts, tests/helpers/cli.ts,
tests/new-adapters.test.ts, tests/process-protocol.test.ts, and tests/setup.ts.
Branch remains `experiment-mcp`; no commit was created.

## Final live verification on the Round 9 tree (search list and argv)

Run by the operator on 2026-10-12 at 23:13 CEST with the installed scode
0.6.0 and agy 1.3.3. `security list-keychains -d user` listed only the login
keychain before the runs and only the login keychain after them. The plain
login run answered `OK` (exit 0); the public check reported `HERMETIC agy: OK`
and `TOOLS agy: OK` (exit 0); no private home remained. During a further plain
run, a 0.2 s sampler of `ps -axww` restricted to `security` processes saw no
`add-generic-password` invocation: the item is added through `security -i`
with the command on stdin, so the token is on no process's command line.

## Round 10

The operator's Round 9 review passed at the blocker threshold but identified
a concurrent search-list race and the lifecycle and protocol findings below.
The operator separately proved that a copied empty template accepts the
Antigravity item and remains readable under relocated HOME without changing
the search list. This round implements that mechanism. No live model
request, code-review command, commit, or push was run.

### Template mechanism

`src/agy-keychain.ts:70` acquires an O_EXCL lock file with a process owner,
bounded waiting, and stale detection. `src/agy-keychain.ts:109` keeps
`agy-mirror-template.keychain-db` and its adjacent `.password` file in the
codemux state directory. Both have mode 0600; the random password is 32 hex
characters. Creation snapshots and restores the user's exact search list
inside the lock and verifies restoration before publishing the password.
The template contains no credential. Normal reuse never calls
`create-keychain` or writes the search list.

Each run copies the template into its private
`Library/Keychains/login.keychain-db`. `src/agy-keychain.ts:167` sends
unlock, settings, and insertion as separate commands over stdin to
`security -i`. Separating commands preserves each exit status. The observed
unlock error, `passphrase not correct` (-25293), is tolerated only when the
subsequent insertion succeeds. On insertion failure, the builder locks,
invalidates that template generation, rebuilds, copies, and retries once.
If another process already rebuilt it, the retry uses that generation.
A second insertion failure refuses launch. Cleanup retains the check that
no private mirror remains listed (`src/agy-keychain.ts:61`).

### Changes and regression evidence

| Finding | Root correction and regression |
|---|---|
| Concurrent search-list corruption, including ordinary sandboxed runs | Template creation, restoration, and copying run under the lock at `src/agy-keychain.ts:115`. `tests/agy-keychain.test.ts:53` starts two real builder processes against synthetic security; the second waits, creation occurs once, both copies accept the item, and the original list survives. The fixture requires the lock during creation and simulates failed unlocks (`tests/fixtures/agy-security.ts:20`). Rebuild success and repeated insertion failure are covered at `tests/agy-keychain.test.ts:41`; stale-owner recovery is covered at line 82. Existing mirror tests now check both 0600 template files and reuse without per-run creation. |
| Signals bypass asynchronous cleanup | `src/process-runner.ts:485` awaits protocol cleanup before removing signal handlers. A signal during cleanup marks interruption without restarting timers against the finished group (`src/process-runner.ts:321`). `tests/process-protocol.test.ts:12` sends real SIGTERM during asynchronous drainage in a subprocess and requires a final `run_end`, interruption receipt, exit cleanup, and exit 143. |
| Ledger reports success before cleanup failure | `src/launch.ts:66` disposes each context once. Both successful paths await cleanup before their receipt at lines 146 and 214; rejection cleanup finishes before the failure receipt at line 227. Known usage survives a cleanup failure. `tests/process-protocol.test.ts:47` checks direct and sandboxed launches, no receipt during cleanup, one cleanup invocation, one failure receipt, and exit code 1. |
| Missing native initialization passes tools-none enforcement | `src/agy-stream.ts:51` marks a stream without `init` malformed. `tests/agy-canary.test.ts:31` supplies only a successful result and requires the adapter to reject it with exit 1. Older successful-probe fixtures now include their native initialization. |
| Conversation precedes validated inventory | `src/experiment-bridge.ts:154` rejects assistant and user frames until inventory validation. `tests/experiment-protocol.test.ts:104` checks both roles, including plain text without tool calls, and requires protocol cleanup to preserve the failure. |
| Empty pagination cursor drops later tools | `src/experiment-bridge.ts:242` treats every string as a cursor, including the empty string, and fetches through the final page. The combined inventory is checked before exposure; duplicate tools, repeated cursors, and protocol errors fail. `tests/experiment-protocol.test.ts:112` covers three pages with an empty middle page and empty cursor, both with valid tools and a forbidden tool on the final page. |
| Probe walks unrelated ancestors | `src/agy-isolation-probe.ts:28` creates an empty `.git` boundary in the working directory. `tests/agy-canary.test.ts:43` plants all three forbidden instruction channels in its parent and verifies the owned working directory remains admissible. The synthetic CLI allows only this boundary (`tests/fixtures/agy-canary.ts:7`). |
| Probe modes missing from the launched request | `src/agy-isolation-probe.ts:75` sets `hermetic` and `tools` on the launched request. `tests/agy-canary.test.ts:52` checks all five modes; line 65 verifies that a synthetic hermetic check writes `hermetic: true` for the probe and false for its control. |
| Ownership registered before marker write | `src/adapters/agy.ts:150` writes the marker first. If it fails, the unregistered fresh directory and open descriptors are removed. `tests/agy-isolation.test.ts:28` injects ENOSPC at the marker write and requires an empty private-home root. |
| Mechanism documentation | `README.md:409`, `docs/HERMETIC.md:73`, `docs/HERMETIC.md:117`, and `CHANGELOG.md:43` describe the template, stdin commands, pagination, and ordering. Historical live evidence stays attributed to the operator. |

For example, a harness can return exit 0 and then fail to remove its private
home. Previously the ledger already contained exit 0. The launcher now waits
for that cleanup and writes one failure receipt with exit 1
(`src/launch.ts:227`).

### Verification

The first focused run reported **128 pass, 3 fail** across 131 tests. Two
older successful-probe fixtures lacked initialization; one bridge test
expected rejection after a conversation frame that now fails immediately.
The corrected focused command exited **0**:

```sh
bun test --preload ./tests/setup.ts tests/agy-keychain.test.ts tests/agy-canary.test.ts tests/agy-isolation.test.ts tests/experiment-protocol.test.ts tests/process-protocol.test.ts
```

It reported **131 pass, 0 fail**, 509 assertions across five files.
`make typecheck` also exited **0**.

`make release-gate` exited **0** on Bun **1.3.14**. Full output is retained
in `scratch/round10-release-gate.log`. Exact summaries:

```text
1909 pass
6 skip
0 fail
9461 expect() calls
Ran 1915 tests across 75 files. [176.12s]
3 pass
0 fail
148 expect() calls
Ran 3 tests across 1 file. [16.11s]
Release gate passed. Review docs/RELEASE-GATE.md before tagging.
```

Compared with the operator's Round 9 **1893 pass, 2 skip, 0 fail**, this
adds **20 tests**, from 1895 to 1915: 16 more passes and four more skips.
No test was removed or filtered. The four additional skips require process
table access, which this sandbox denies with
`EPERM: operation not permitted, posix_spawn '/bin/ps'`. Some process-group
signals were also denied. No workaround was attempted. The other two skips
are installed-contract cases exercised by the separate three-test stage.
That stage checked 14 installed binaries through help and version commands;
it made no model requests.

The gate passed runtime pinning, type checking, shell syntax, full tests,
coverage, installed contracts, scode compatibility, CLI smoke checks,
dependency audit, and frozen-lockfile validation. Conservative coverage is
**87.21% lines** and **92.09% functions**. There is no separate lint target.

```sh
git diff --name-only -z | xargs -0 uv run --no-project ~/.agents/skills/humanizer/scripts/check_american.py
git diff --check
git add -A
```

The prose check exited **0**: `American English: CLEAN`, 18 files, zero
British spellings. Whitespace and added-home-path checks exited **0**.
`git add -A` stages this round and preserves all earlier staged changes.

| Requested item | Status |
|---|---|
| Locked template, private copies, tolerated unlock error, one rebuild, cleanup safety net | Done; synthetic builder and concurrency regressions pass |
| Signal handling through drainage and final recording | Done; real SIGTERM subprocess regression passes |
| Post-cleanup receipts with actual failure exit | Done; direct and sandboxed regressions pass |
| Required native init, bridge ordering, complete pagination | Done; all regressions pass |
| Probe git boundary, truthful request flags, marker before ownership | Done; all regressions pass |
| Round 10 report and matching mechanism documentation | Done |
| Full release gate, American English, whitespace, home-path check, staging | Done; exit 0 |
| Commit, code-review, push, live model requests | Not run, as requested |

Round 10 changes 18 files: CHANGELOG.md, README.md, docs/HERMETIC.md,
docs/experiment-mcp-report.md, src/adapters/agy.ts,
src/agy-isolation-probe.ts, src/agy-keychain.ts, src/agy-stream.ts,
src/experiment-bridge.ts, src/launch.ts, src/process-runner.ts,
tests/agy-canary.test.ts, tests/agy-isolation.test.ts,
tests/agy-keychain.test.ts, tests/experiment-protocol.test.ts,
tests/fixtures/agy-canary.ts, tests/fixtures/agy-security.ts, and
tests/process-protocol.test.ts. Branch remains `experiment-mcp`;
no commit was created.

## Final live verification on the Round 10 tree (template keychain)

Run by the operator on 2026-10-13 at 00:49 CEST with the installed scode
0.6.0 and agy 1.3.3. The user search list held only the login keychain before
and after. A plain run answered `OK` (exit 0) and left
`agy-mirror-template.keychain-db` and its 32-hex password file, both mode
0600, under codemux's state directory. Two plain runs launched at the same
instant both answered `OK`, while a 0.2 s sampler of `security` processes saw
no `create-keychain` call during either. The public check reported
`HERMETIC agy: OK` and `TOOLS agy: OK` (exit 0). No private home remained.

## Round 11

The operator's Round 10 review failed on authentication precedence and
identified the concurrency, recovery, canary, retention, and finalization
findings below. This round fixes every finding using synthetic credentials
and local process fixtures. The experiment server remains outside scode,
and a needed mirror still contains the complete token, including refresh
material. Those are documented design decisions. No live agy request,
code-review command, commit, or push was run.

### Changes and regression evidence

| Finding | Root correction and regression |
|---|---|
| API-key and file-token login fails before launch | `src/adapters/agy.ts:186` selects an adapter-environment `GEMINI_API_KEY` or `GOOGLE_API_KEY`, or the real-home file token, before constructing a mirror. Only the remaining Keychain path looks up a credential; an absent login refuses. `tests/agy-keychain.test.ts:41` covers both keys and a file token with a missing Keychain item in plain and hermetic modes. The five probe modes retain real-home file-token coverage at line 398. |
| Different call-log directories create competing locks | `src/agy-keychain.ts:24` derives the fixed state root from the real login home without log overrides. Both recovery and template creation use that root's single lock. `tests/agy-keychain.test.ts:129` starts two real builder processes with different `CODEMUX_CALL_LOG` paths, verifies one creation, and checks the exact original search list. |
| Template passphrase appears on argv | `src/agy-keychain.ts:158` sends `create-keychain` through `security -i`, with the complete command on stdin. The fake rejects creation on argv (`tests/fixtures/agy-security.ts:17`). `tests/agy-keychain.test.ts:58` covers creation and rebuilding and checks every recorded argv against both passphrases. |
| Crashes leave credential mirrors on disk | `src/adapters/agy.ts:181` writes the owner's PID before copying credentials. Every launch sweeps identified stale `run-*` homes at line 33, including direct and API-key launches. `tests/agy-keychain.test.ts:72` kills a real synthetic builder with SIGKILL, checks that its mirror remains, then verifies the next launch removes it while preserving a live owner's home. `tests/agy-isolation.test.ts:51` retains live, unknown, and symlinked homes; line 73 covers simultaneous removal. |
| Interrupted creation leaves the user search list changed | `src/agy-keychain.ts:86` removes template and private-mirror entries under the same fixed lock, preserving other entries and their order and verifying restoration. `src/adapters/agy.ts:156` runs recovery before every launch, independently of mirror selection or cache validity. `tests/agy-keychain.test.ts:98` covers cached and incomplete templates, mirrors, and legacy log-directory templates on API-key launches. |
| Unrelated tool activity falsely passes the command canary | `src/agy-isolation-probe.ts:56` accepts only command-class denials and rejects unrelated denials, including mixed lists. Its control requires the expected output in a completed command step and in the reply. `src/agy-stream.ts:24` extracts command output and native command permission refusals. `tests/agy-canary.test.ts:170`, line 177, and line 190 cover unrelated denials, fabricated assistant/file output, and `run_command` denial evidence. |
| Consumed server output remains retained | `src/experiment-server.ts:83` registers one give-up reaction per reader and cancels the pending read. `tests/experiment-shutdown.test.ts:23` drains twenty 1 MiB chunks, checks one reaction, forces collection, and verifies all chunks are collectible before give-up resolves. Existing real-orphan stdout and stderr tests retain bounded-shutdown coverage. |
| Cleanup replaces timeout or output-limit results | `src/process-runner.ts:428` and line 465 retain the first failure and its returned result. Line 495 appends cleanup failure as a note without replacing exit 124 or 125 or partial output. `tests/process-protocol.test.ts:140` covers both a timeout and an overflow followed by a recording finalization error. |
| Authentication and recovery documentation | `README.md:401` and `docs/HERMETIC.md:115` document precedence, the fixed state root, stdin-only passphrases, and recovery. The synthetic CLI uses an explicit test API key (`tests/helpers/cli.ts:91`), and its tools control emits native command output (`tests/fixtures/agy-canary.ts:23`). |

For example, an API-key user with no Keychain item previously failed before
agy could launch. The adapter now skips credential lookup and mirror creation
for that run (`src/adapters/agy.ts:189`). Recovery still repairs any search-list
entries left by an earlier interrupted run.

The native output check follows Google's documented
[headless tool-step schema](https://www.antigravity.google/docs/cli/headless/):
a completed `run_command` step carries its actual output in `tool_info.output`.
Assistant text alone is insufficient. No new live verification is claimed.

### Verification

The first focused run stopped at an existing in-process diagnostic fixture
that lacked an explicit synthetic login. That fixture now supplies its test
API key. Type checking also identified one unused test binding, which was
removed. The corrected focused command exited **0**:

```sh
bun test --preload ./tests/setup.ts tests/agy-keychain.test.ts tests/agy-canary.test.ts tests/agy-isolation.test.ts tests/process-protocol.test.ts tests/experiment-shutdown.test.ts
```

It reported **130 pass, 0 fail**, 539 assertions across five files. Two more
sweep regressions were then added before the full release gate.
`make typecheck` exited **0** before those additions.

The first `make release-gate` exited **0**: **1927 pass, 6 skip, 0 fail**,
9528 assertions, 1933 tests across 75 files, plus **3 pass, 0 fail** in the
installed-contract stage. Its log is `scratch/round11-release-gate.log`.
A final mixed-denial assertion was then added: a generic file-tool refusal
alongside a command refusal must still fail. The complete gate was rerun
against that final tree.

Final `make release-gate` exited **0** on Bun **1.3.14**. Its complete output
is retained in `scratch/round11-final-release-gate.log`. Exact summaries:

```text
1927 pass
6 skip
0 fail
9529 expect() calls
Ran 1933 tests across 75 files. [144.03s]
3 pass
0 fail
148 expect() calls
Ran 3 tests across 1 file. [11.73s]
Release gate passed. Review docs/RELEASE-GATE.md before tagging.
```

The final run keeps all 1933 tests from the first gate and adds one assertion.
Compared with the operator's Round 10 **1913 pass, 2 skip, 0 fail**
(1915 tests), this adds **18 tests**, with 14 more passes and four more
skips. Nothing was removed or filtered. Four process-table tests cannot run
because the sandbox denies `/bin/ps` with
`EPERM: operation not permitted, posix_spawn '/bin/ps'`; some process-group
signals are also denied. No workaround was attempted. The other two skips
are installed-contract tests exercised in the separate three-test stage.
That stage inspected 14 installed binaries through help and version commands
without model requests. The local Cursor model-alias check remains skipped
because there is no Cursor login.

The gate passed runtime pinning, type checking, shell syntax, the full test
suite, coverage, installed contracts, scode compatibility, CLI smoke checks,
dependency audit, and frozen-lockfile validation. Conservative coverage is
**87.25% lines** and **92.07% functions**. There is no separate lint target.

```sh
git diff --name-only -z | xargs -0 uv run --no-project ~/.agents/skills/humanizer/scripts/check_american.py
git diff --check
git add -A
```

All three commands exited **0**. The prose check reported
`American English: CLEAN`: 17 files, zero British spellings. The added-line
home-path check also exited **0**. No literal operator home path was added.
Staging preserves all earlier rounds; no commit was created.

| Requested item | Status |
|---|---|
| Authentication precedence and documented refusal | Done; API-key and file-token regressions pass |
| One fixed template and lock per user | Done; concurrent builders with different logs pass |
| No passphrase on argv, including creation | Done; creation and rebuild stdin regressions pass |
| Stale-home sweeping and search-list crash recovery | Done; real SIGKILL and synthetic restoration regressions pass |
| Command-class denial and actual command-output canaries | Done; unrelated and mixed denials and fabricated output fail |
| Bounded server-output retention | Done; all twenty consumed chunks are collectible before give-up |
| Timeout and limit classifications survive cleanup failure | Done; exits 124 and 125 and partial output retained |
| Round 11 report with file references | Done |
| Full gate, American English, whitespace, home-path check, staging | Done; exit 0 |
| Process-table checks denied by the sandbox | Blocked by host permissions; four existing tests skipped |
| Commit, code-review, push, live agy requests | Not run, as requested |

Round 11 changes 17 files: README.md, docs/HERMETIC.md,
docs/experiment-mcp-report.md, src/adapters/agy.ts,
src/agy-isolation-probe.ts, src/agy-keychain.ts, src/agy-stream.ts,
src/experiment-server.ts, src/process-runner.ts, tests/agy-canary.test.ts,
tests/agy-isolation.test.ts, tests/agy-keychain.test.ts,
tests/experiment-shutdown.test.ts, tests/fixtures/agy-canary.ts,
tests/fixtures/agy-security.ts, tests/helpers/cli.ts, and
tests/process-protocol.test.ts. Branch remains `experiment-mcp`.

## Final live verification on the Round 11 tree

Run by the operator on 2026-10-13 at 07:41 CEST with installed
scode 0.6.0 and agy 1.3.3. The operator verified the Round 11 gate:
**1931 pass, 2 skip, 0 fail**, exit 0. The user search list held
only the login keychain before and after. The plain run answered
`OK` (exit 0). The public check reported `HERMETIC agy: OK` and
`TOOLS agy: OK` (exit 0). No private home remained.

This verifies the Round 11 authentication precedence, template mirror, and
recovery implementation. Earlier Round 8 and Round 10 live records remain
historical evidence for their respective trees. Round 12 changes below were
not included in this live run.

## Round 12

This round fixes all six Round 11 review findings. The operator's Round 11
live verification above is the latest live evidence. No live agy command,
code-review command, commit, or push was run during Round 12.

### Changes and regression evidence

| Finding | Root correction and regression |
|---|---|
| Tools check passes after command execution | `src/agy-stream.ts:11` tracks command attempts by native step identity. Line 45 retains any completed command or command output, regardless of later denial. `src/agy-isolation-probe.ts:57` requires exactly one denied command attempt. `tests/agy-canary.test.ts:205` rejects completion without output, unrelated or empty output, execution before or after denial, and repeated denied attempts. Updates sharing a step index still count as one attempt. |
| Canceled stdout hides the original capture failure | `src/process-runner.ts:121` finalizes canceled stdout with an explicit aborted state and calls the sink once. Line 386 retains the first capture error in arrival order. `src/experiment-bridge.ts:287` records partial bytes and cancellation without treating them as normal EOF. `tests/process-protocol.test.ts:101` exercises a real bridge with partial Claude JSON and synthetic stderr overflow, invalid UTF-8, or protocol abort. Overflow returns exit 125 with the captured stderr; the other cases retain their original failures. |
| Signal shutdown loses cleanup errors | `src/process-runner.ts:491` retains the cleanup diagnostic separately; line 514 writes it to stderr before exit 143. `tests/process-protocol.test.ts:81` sends real SIGTERM during asynchronous finalization in a synthetic subprocess and requires both the interruption message and recording failure. |
| Live verification refers to older mechanisms | `docs/experiment-mcp-report.md:1686` records the supplied Round 11 date, versions, gate, search list, plain reply, public check, and cleanup outcome. Current claims in `README.md:398`, `docs/HERMETIC.md:110`, `CHANGELOG.md:27`, `src/adapters/agy.ts:126`, and `tests/new-adapters.test.ts:59` identify that tree. `tests/agy-canary.test.ts:278` guards those claims; line 308 preserves every supplied live fact. Round 12 automated evidence is distinguished from the Round 11 live record. |
| Base capability comment is stale | `src/adapters/base.ts:380` now describes supported mechanisms and their verification evidence, including Antigravity. `tests/agy-canary.test.ts:301` checks the comment and the actual enabled capability. |
| scode minimum appears conditional on login | `src/launch.ts:159` and line 164 say every sandboxed agy run requires scode 0.6.0 or newer. `README.md:44`, `docs/HERMETIC.md:139`, and `CHANGELOG.md:34` state the unconditional requirement. `tests/agy-canary.test.ts:240` covers API-key, file-token, and Keychain logins against old scode and checks the documentation. |

For example, a completed command returning unrelated text followed by a denied
command previously passed because neither contained the expected canary output.
The completion now makes the probe fail permanently (`src/agy-stream.ts:45`).
A separate stderr overflow with partial Claude JSON now returns exit 125 and
the captured stderr instead of rejecting with an incomplete-frame error
(`src/process-runner.ts:425`).

### Verification

The new behavioral regressions first reported **0 pass, 5 fail**, reproducing
both major findings and the signal diagnostic loss. After the fixes, the same
five cases reported **5 pass, 0 fail**, exit 0, with 43 assertions.

```sh
bun test --preload ./tests/setup.ts tests/agy-canary.test.ts tests/process-protocol.test.ts tests/experiment-protocol.test.ts tests/experiment-bridge.test.ts tests/new-adapters.test.ts
make typecheck
```

Both commands exited **0**. The focused suite reported **147 pass, 0 fail**,
570 assertions across five files.

`make release-gate` exited **0** on Bun **1.3.14**. Its full output is retained
in `scratch/round12-release-gate.log`. Exact summaries:

```text
1936 pass
6 skip
0 fail
9601 expect() calls
Ran 1942 tests across 75 files. [148.23s]
3 pass
0 fail
148 expect() calls
Ran 3 tests across 1 file. [13.54s]
Release gate passed. Review docs/RELEASE-GATE.md before tagging.
```

Compared with the operator's Round 11 **1931 pass, 2 skip, 0 fail**, this
adds **nine tests**, from 1933 to 1942: five more passes and four more skips.
No tests were removed or filtered. Four existing process-table tests are
skipped because this environment denies `/bin/ps` with
`EPERM: operation not permitted, posix_spawn '/bin/ps'`. Some process-group
signals are also denied. No workaround was attempted. The other two skips
are installed-contract cases exercised by the separate three-test stage.
That stage uses installed help and version commands without model requests.

The gate passed runtime pinning, type checking, shell syntax, the full test
suite, coverage, installed contracts, scode compatibility, CLI smoke checks,
dependency audit, and frozen-lockfile validation. Conservative coverage is
**87.26% lines** and **92.07% functions**. There is no separate lint target.

```sh
git diff --name-only -z | xargs -0 uv run --no-project ~/.agents/skills/humanizer/scripts/check_american.py
git diff --check
git add -A
```

All three commands exited **0**. The prose check reported
`American English: CLEAN`: 14 files, zero British spellings. The added-line
home-path check exited **0** with `Added home-path check: PASS`.
Staging preserves all earlier rounds. No commit was created.

| Requested item | Status |
|---|---|
| One denied command attempt, with no execution anywhere in the stream | Done; ordering, output, completion, and repeated-attempt regressions pass |
| Cancellation preserves the original capture failure and exit 125 | Done; overflow, invalid UTF-8, and protocol-abort regressions pass |
| Signal shutdown reports cleanup failures before exit 143 | Done; real SIGTERM synthetic subprocess regression passes |
| Round 11 live record and accurate current verification claims | Done; supplied facts recorded and guarded by tests |
| Base capability comment and unconditional scode minimum | Done; comment, three login methods, and prose regressions pass |
| Round 12 report with file references | Done |
| Full release gate, American English, whitespace, home-path check, staging | Done; exit 0 |
| Four process-table tests | Blocked by host permissions; existing skips retained |
| Commit, code-review, push, live agy commands | Not run, as requested |

Round 12 changes 14 files: CHANGELOG.md, README.md, docs/HERMETIC.md,
docs/experiment-mcp-report.md, src/adapters/agy.ts, src/adapters/base.ts,
src/agy-isolation-probe.ts, src/agy-stream.ts, src/experiment-bridge.ts,
src/launch.ts, src/process-runner.ts, tests/agy-canary.test.ts,
tests/new-adapters.test.ts, and tests/process-protocol.test.ts.
Branch remains `experiment-mcp`.

## Round 13

This round applies the Round 12 review findings to the **0.13.0 merge** in
worktree `codemux-013`, branch `release-0.13`. The experiment work is merged
onto codemux 0.12.0. The operator's review passed at the blocker threshold;
the Claude lane reached its session limit. Earlier round counts and live
evidence describe their historical trees. No new live verification is claimed.

### Changes and regression evidence

| Finding | Root correction and regression |
|---|---|
| Successful non-command tools pass the tools canary | `src/agy-stream.ts:40` tracks every non-text attempt and completion. Line 82 accepts only one denied command attempt across the stream. `tests/agy-canary.test.ts:170` rejects file, MCP, generic, and unknown tools before or after the denial, including reused step indexes and incomplete attempts. This closes both duplicate canary findings. |
| Supplied HOME loses the selected file token | `src/adapters/agy.ts:192` prevents the shared directory link from bypassing the copy at line 203. Line 205 links other configuration entries only after copying the selected token from the real login home. `tests/agy-keychain.test.ts:123` covers plain and hermetic runs with different login and supplied homes, copy permissions, shared configuration, no mirror, and isolated refreshes. |
| Capture abort leaves the external server running | `src/process-runner.ts:381` centralizes protocol termination, harness-tree termination, and bounded shutdown. Signals, timeout, and capture abort all call it. `tests/experiment-shutdown.test.ts:144` checks server termination before harness cleanup for timeout, signal, explicit abort, parsing failure, invalid UTF-8, and output overflow. |
| Repeated bridge cleanup replaces exits 124 and 125 | `src/experiment-bridge.ts:326` caches a settled close outcome and reports its rejection once. The protocol decision at line 322 retains recorded failures. `tests/process-protocol.test.ts:226` exercises the launcher and inherited Claude cleanup after server-close or recording-sync failure, preserving partial output, exit code, and one cleanup diagnostic. `tests/experiment-protocol.test.ts:193` checks one finalization and a harmless later close. |
| Keychain recovery removes an unrelated matching basename | `src/agy-keychain.ts:28` matches the exact template path or a normalized path under a private run directory. Line 90 reports unrelated matching names without removing them. `tests/agy-keychain.test.ts:98` covers cached and incomplete templates, private mirrors and templates, unrelated matching names, path traversal, and preserved search-list order. |
| Malformed message content is silently omitted | `src/experiment-bridge.ts:158` requires an array before inspecting conversation blocks. `tests/experiment-protocol.test.ts:112` covers both roles with missing, null, scalar, and object content, including a hidden tool call. Each case rejects the later result and records one failure and a failed terminal record. |
| Retention test depends on garbage collection | `tests/experiment-shutdown.test.ts:23` spies on the give-up promise while draining twenty chunks. It requires one reaction throughout all reads and after completion. No WeakRef or garbage-collection timing assertion remains. |
| Interrupted canary deletes scratch before credential cleanup | `src/run-exit-cleanup.ts:42` prepends adapter cleanup to exit callbacks. `src/hermetic-canary.ts:53` lets that ordered exit sequence remove scratch on signals too. `tests/agy-isolation.test.ts:30` exercises ordinary exit and SIGTERM, requiring adapter cleanup before parent deletion and no false cleanup diagnostic. |

For example, a completed `read_file` followed by one denied command used to
pass the tools probe. It now fails even if both events reuse the same native
step index (`src/agy-stream.ts:47`). A launcher timeout followed by recording
sync failure now returns exit 124 and its partial output, with one cleanup
note, instead of rejecting again during adapter cleanup
(`src/experiment-bridge.ts:326`).

### Verification

The first focused run reported **179 pass, 1 fail** across 180 tests.
It exposed an existing contract: repeated `closeProtocol()` must still reject
a recorded protocol failure. That decision remains separate from idempotent
`close()` disposal. The corrected command exited **0**:

```sh
bun test --max-concurrency=1 --preload ./tests/setup.ts tests/agy-canary.test.ts tests/agy-keychain.test.ts tests/agy-isolation.test.ts tests/experiment-protocol.test.ts tests/experiment-shutdown.test.ts tests/process-protocol.test.ts
```

It reported **180 pass, 0 fail**, with the same 180 tests. Two additional
recording-sync cases were then added. The focused finalization command exited
**0**, reporting **53 pass, 0 fail** across two files:

```sh
bun test --max-concurrency=1 --preload ./tests/setup.ts tests/process-protocol.test.ts tests/experiment-protocol.test.ts
```

`make typecheck` exited **0**. The full release gate below verifies the final
implementation, including persistent protocol-failure decisions after a
recording-sync failure.

The first `make release-gate` exited **0**: **2282 pass, 6 skip, 0 fail**,
17,680 assertions, 2288 tests across 80 files; installed contracts added
**3 pass, 0 fail**. The log is `scratch/round13-release-gate.log`.
The shutdown regression then gained a final assertion outside the mocked
signal function: the server's signal must precede the harness's signal.
This prevents the runner's signal-error handling from catching the assertion.

```sh
bun test --max-concurrency=1 --preload ./tests/setup.ts tests/experiment-shutdown.test.ts
```

That command exited **0**: **14 pass, 0 fail**, 74 assertions. The complete
gate was rerun against the final test file. The merged-tree baseline in
`scratch/release-0.13-verified-gate.log` was **2267 pass, 6 skip, 0 fail**,
2273 tests. Round 13 adds **15 tests**, from 2273 to 2288; no tests were
removed or filtered. The original Round 12 counts predate the 0.13.0 merge.

Final `make release-gate` exited **0** on Bun **1.3.14**. The complete log is
`scratch/round13-final-release-gate.log`. Exact summaries:

```text
2282 pass
6 skip
0 fail
17692 expect() calls
Ran 2288 tests across 80 files. [219.19s]
3 pass
0 fail
148 expect() calls
Ran 3 tests across 1 file. [13.16s]
Release gate passed. Review docs/RELEASE-GATE.md before tagging.
```

Compared with the first gate, all 2288 tests remain and the final signal-order
checks add 12 assertions. The six skips are unchanged: four process-table
tests cannot run because the environment denies `/bin/ps`; the other two are
installed-contract cases exercised in the separate stage. Some process-group
signals are also denied. No workaround was used. Installed contracts checked
14 binaries through help and version commands, without model requests; the
Cursor alias check remains unavailable without a Cursor login.

The gate passed runtime compatibility, type checking, shell syntax, the full
test suite, coverage, installed contracts, scode compatibility, CLI smoke
checks, dependency audit, and frozen-lockfile validation. Conservative coverage
is **87.63% lines** and **92.95% functions**. There is no separate lint target.

```sh
git diff --name-only -z | xargs -0 uv run --no-project ~/.agents/skills/humanizer/scripts/check_american.py
git diff --check
git add -A
```

All three commands exited **0**. The prose check reported
`American English: CLEAN`: 14 files, zero British spellings. The added-line
home-path check exited **0** with `Added home-path check: PASS`. Earlier staged
merge work is preserved. No commit, push, code-review, or live agy request ran.

| Requested item | Status |
|---|---|
| All eight findings, including the duplicate tools-canary report | Done; root corrections and regression evidence above |
| One denied command attempt and no completed non-text tool | Done |
| Selected file token copied with every supplied environment | Done |
| One termination path for capture abort, timeout, and signals | Done |
| Idempotent close with one cleanup diagnostic and retained exits | Done |
| Keychain recovery by owned path, preserving unrelated names | Done |
| Malformed conversation content fails closed and is recorded | Done |
| Deterministic retention assertion and ordered canary cleanup | Done |
| Round 13 report identifies the 0.13.0 merged tree | Done |
| Full gate, American English, whitespace, home-path check, staging | Done; exit 0 |
| Four process-table tests | Blocked by host permissions; existing skips retained |
| Commit, code-review, push, live agy requests | Not run, as requested |

Round 13 changes 14 files: docs/experiment-mcp-report.md,
src/adapters/agy.ts, src/agy-keychain.ts, src/agy-stream.ts,
src/experiment-bridge.ts, src/hermetic-canary.ts, src/process-runner.ts,
src/run-exit-cleanup.ts, tests/agy-canary.test.ts,
tests/agy-isolation.test.ts, tests/agy-keychain.test.ts,
tests/experiment-protocol.test.ts, tests/experiment-shutdown.test.ts,
and tests/process-protocol.test.ts. Branch remains `release-0.13`.

## Round 14 — merged-tree review corrections

The operator's baseline is **2286 pass, 2 skip, 0 fail**, 2288 tests.
This round fixes all five distinct findings from the correctness and edges
reviews. The repeated authentication and version findings share their fixes.

| Change | Implementation and regression evidence |
|---|---|
| Authentication after scrubbing | `src/adapters/base.ts:254` accepts the resolved sandbox options; `src/launch.ts:161` passes them into preparation. `src/adapters/agy.ts:192` selects authentication from the built environment and the same keep-env exemption used by execution. A removed API key cannot suppress the Keychain mirror. `tests/agy-keychain.test.ts:59` checks hermetic scrubbing, untrusted mode, and an exempt key. `tests/agy-keychain.test.ts:97` checks refusal before harness spawning when no credential survives. |
| One environment for version gates | `src/launch.ts:192` resolves and probes scode and Claude using the completed adapter environment, including per-run variables. `tests/launch-environment.test.ts:11` checks both gates with newer ambient binaries and older binaries selected by the adapter's per-run PATH, and verifies context cleanup on refusal. |
| Exception-safe protocol termination | `src/process-runner.ts:382` arms forced child reaping and bounded pipe abandonment before calling the protocol hook. The hook's exception becomes a note at `src/process-runner.ts:562`; capture failure, exit 124, and exit 125 retain their original diagnoses. Server SIGTERM still precedes harness SIGTERM. Start failures use the same abort path at `src/process-runner.ts:466`. `tests/process-termination.test.ts:6` checks capture failure, output overflow, and timeout with a throwing hook and a real synthetic child that ignores SIGTERM. Each case checks timer ordering, reaping before protocol closure, and absence of the child afterward. |
| Plain initialization object | `src/agy-stream.ts:26` rejects array initialization payloads. `tests/agy-isolation.test.ts:19` supplies an array init followed by a valid result and requires malformed evidence. |
| Role consistency on every conversation frame | `src/experiment-bridge.ts:159` checks the outer type against the inner role before inspecting blocks. `tests/experiment-protocol.test.ts:126` checks both text-only role mismatches, refusal of a later result, and the recorded failure. |

The regression runs reproduced all five defects before their fixes. The first
termination tests also exposed the uncaught timeout exception. Two test
assertions were then corrected: this host can emit a process-table permission
warning, and Bun's `exitCode` can remain null after signal termination. The
tests now check the `exited` promise and reject escaped hook exceptions.

The focused seven-file run reached **150 pass, 3 fail** across 153 tests; all
three failures were the signal-exit assertion. After that assertion was fixed:

```sh
bun test --max-concurrency=1 --preload ./tests/setup.ts tests/process-termination.test.ts
```

This command exited **0**: **3 pass, 0 fail**, 21 assertions. The log is
`scratch/round14-termination.log`. `make typecheck` also exited **0**.
The full release gate verifies the final source and tests below.

The first `make release-gate` exited **2**: **2290 pass, 6 skip, 1 fail**,
2297 tests. Moving version gates after environment preparation exposed an
incomplete Keychain fixture: it reported successful creation without creating
the template file. `tests/agy-canary.test.ts:160` now uses the existing synthetic
security fixture, which implements creation and the search-list side effects.
The three existing old-scode tests still require refusal before the harness
launches, with API-key, file-token, and Keychain authentication.

```sh
bun test --max-concurrency=1 --preload ./tests/setup.ts tests/agy-canary.test.ts
```

That command exited **0**: **38 pass, 0 fail**, 254 assertions. Its log is
`scratch/round14-canary.log`. No production change was needed after the first
full gate; the final gate includes the corrected fixture.

The next gate stopped at type checking with exit **2** because the fixture's
object spread no longer inferred a string-indexed environment. Its return type
at `tests/agy-canary.test.ts:160` is now explicit. No tests ran in that attempt.

The following full attempt exited **2**, with **2290 pass, 6 skip, 1 fail**
across the same 2297 tests. The only failure was the existing queued-timeout
timing test at `tests/session-codex-e2e.test.ts:2617`, which expected
`interrupted` but received `failed`. It passed in the first full run and then
passed unchanged in isolation:

```sh
bun test --max-concurrency=1 --preload ./tests/setup.ts tests/session-codex-e2e.test.ts --test-name-pattern 'a queued timeout interrupt whose delivery is refused'
```

That diagnostic run exited **0**: **1 pass, 0 fail**, 95 filtered out,
3 assertions. The log is `scratch/round14-codex-timing.log`. The session code
and test remain unchanged; the final verification is another unfiltered gate.

That attempt exited **2**: **2289 pass, 6 skip, 2 fail**, still 2297 tests.
The session timing test passed, but two existing cleanup tests failed because
their synthetic Bun child produced no output before a 150 ms timeout.
`tests/process-protocol.test.ts:210` now supplies buffered output for the
finalization tests, removing the dependency on child startup speed. Their
assertions are unchanged. The separate real-child reaping tests remain.

```sh
bun test --max-concurrency=1 --preload ./tests/setup.ts tests/process-protocol.test.ts
```

This command exited **0**: **25 pass, 0 fail**, 102 assertions. Its log is
`scratch/round14-buffered-output.log`. The final full gate starts after this
fixture correction and retains all 2297 tests.

Final `make release-gate` exited **0**. The complete log is
`scratch/round14-complete-release-gate.log`. Exact summaries:

```text
2291 pass
6 skip
0 fail
17738 expect() calls
Ran 2297 tests across 82 files. [253.78s]
3 pass
0 fail
148 expect() calls
Ran 3 tests across 1 file. [22.82s]
Release gate passed. Review docs/RELEASE-GATE.md before tagging.
```

Compared with **2286/2/0**, the suite adds **nine tests**, from 2288 to 2297.
The pass count increases by five because four existing process-table tests
skip when this host denies `/bin/ps`. The other two skips are installed-contract
cases exercised in the separate stage. Compared with the previous full run,
the test count is unchanged and both failures now pass. The gate passed runtime
compatibility, type checking, shell syntax, the full suite, coverage, installed
contracts, scode compatibility, CLI smoke checks, dependency audit, and
frozen-lockfile validation. There is no separate lint target. Conservative
coverage is **87.67% lines** and **92.95% functions**.

`check_american.py` on all 14 touched files exited **0** with
`American English: CLEAN`. `git diff --check` and the added-line home-path check
exited **0**. `git add -A` exited **0**, preserving the earlier staged merge.
No commit, code-review, push, or live Agy request ran. Installed contracts used
help and version commands only.

| Requested item | Status |
|---|---|
| Authentication precedence after scrubbing, including refusal without credentials | Done |
| Version gates use the adapter-built execution environment | Done |
| Protocol termination is armed first and exceptions retain the original outcome | Done |
| Array init and text-only role mismatches fail validation | Done |
| Regression coverage for every finding | Done; nine added tests |
| Round 14 report with file:line references | Done |
| Full release gate, American English, whitespace, home-path check, staging | Done; exit 0 |
| Four existing process-table tests | Blocked by host permissions; skipped |

Round 14 changes 14 files: docs/experiment-mcp-report.md, src/adapters/agy.ts,
src/adapters/base.ts, src/agy-stream.ts, src/experiment-bridge.ts, src/launch.ts,
src/process-runner.ts, tests/agy-canary.test.ts, tests/agy-isolation.test.ts,
tests/agy-keychain.test.ts, tests/experiment-protocol.test.ts,
tests/launch-environment.test.ts, tests/process-protocol.test.ts, and
tests/process-termination.test.ts. Branch remains `release-0.13`.

## 0.13.1

This fix release starts from `a5af184` on branch `release-0.13.1` in
worktree `codemux-0131`. It addresses every supplied finding after the
Round 14 and al41 budgets. Repeated findings share their root fix and
regression. Historical rounds above retain their original decisions;
the rules in this section supersede their conflicting cleanup behavior.

### Findings and regression evidence

| Finding | Disposition and evidence |
|---|---|
| API-key launch reads an unused fallback | Fixed. `src/adapters/agy.ts:208` selects a surviving API key before even inspecting the token file. `tests/release-0131.test.ts:15` makes token inspection throw and checks both keys with an unreadable fallback and no private token copy. Existing scrubbed-key tests still require the fallback or Keychain. |
| Cleanup replaces a child's result, reported twice | Fixed. `src/process-runner.ts:553` appends cleanup failures to every completed result. `src/launch.ts:68` applies the same rule to adapter cleanup before recording the receipt. `tests/release-0131.test.ts:107` preserves exits 0 and 2, stdout, and an authentication diagnostic. The server/fsync matrix in `tests/process-protocol.test.ts:253` covers timeout, capture limit, success, and nonzero exit through the launcher, including repeated cleanup and exactly one diagnostic. |
| Sweep precedes HOME validation and lacks ownership evidence | Fixed. `src/adapters/agy.ts:162` validates absolute, user-owned directories first. The sweep at `:34` visits only the real user's canonical probe root and requires a user-owned directory, UUID ownership marker, and dead PID. `tests/release-0131.test.ts:40` rejects relative and foreign-owned HOME before deleting anything, then preserves an unmarked home and a supplied profile's probe directory. |
| Recovery deletes unrelated Keychain entries | Fixed. `src/agy-keychain.ts:30` resolves path components before prefix comparison, including symlink parents and missing suffixes. Only the canonical template or real user's probe-root descendants qualify. `tests/release-0131.test.ts:78` preserves the reported volume-path lookalike, a symlink escape, a symlink followed by `..`, and an ordinary entry in order; owned entries are removed and lookalikes are reported. |
| A rejected control forwards a later call in the same chunk | Fixed. `src/experiment-bridge.ts:295` latches validation failure synchronously; `:122` stops chunk parsing. The first new test in `tests/experiment-protocol.test.ts` puts a rejected control before a valid native tool call and proves that no later server request occurs. It covers invalid IDs as well as unsupported requests. |
| Error flags use truthiness | Fixed. `src/experiment-bridge.ts:182` and `:279` require booleans for present Claude and MCP flags. Omitted optional flags mean false. The error-flag regression in `tests/experiment-protocol.test.ts` rejects strings, numbers, null, arrays, and objects on each boundary. |
| Unknown or malformed frame types disappear | Fixed. `src/experiment-bridge.ts:198` rejects missing, non-string, and unknown types. The corresponding regression covers `{}`, null, a number, and an unknown string. Known `system/status` notifications remain accepted and retain the existing frame-size boundary tests. |
| Exit cleanup starts promises it cannot await | Fixed. `src/run-exit-cleanup.ts` calls only synchronous termination and `cleanupRunSync`. All adapters with file cleanup implement that hook. Agy restores and verifies the search list through synchronous spawns before removing its home. Claude's `src/experiment-bridge.ts:336` records an incomplete-cleanup error, writes `run_end`, syncs, and closes the descriptor synchronously. `tests/release-0131.test.ts:173` proves that the exit listener never starts async cleanup and finalizes only once; the Agy Keychain regression restores a reintroduced mirror entry synchronously. The real SIGTERM drainage regression now awaits an asynchronous pre-exit callback before writing its receipt. |
| Fatal errors no longer cancel Aider/OpenCode shutdown waits, reported twice | Fixed. Both drivers' `awaitEndAnswer` predicates observe fatal errors and raised exit codes. `tests/session-shutdown-fatal.test.ts:7` drives a fatal into each pending drain, checks immediate predicate cancellation, and preserves raw exit 143 as `harness_failed`. |
| Turn completion should cancel the same shutdown wait | No longer applicable as an independent completion shortcut after al41. A completed turn must still wait for the child's raw exit; stopping on the turn event would introduce a signal exit before learning whether the child exits cleanly. Signal attribution remains removed. The fatal-error part is fixed above. |
| Kimi rejects spawn with null | Fixed. `src/session/kimi-driver.ts` distinguishes success by the returned child, not the rejection value. `tests/session-kimi-e2e.test.ts:676` rejects with null and requires a fatal error, exit 1, one completed shutdown, and no child outcome. |
| Custom HOME prepares another Claude mirror | Fixed. `src/adapters/claude.ts` resolves the mirror and profile redirects from its injected environment. `src/credentials.ts` accepts the selected HOME. `tests/release-0131.test.ts:155` refreshes a synthetic mirror under the same HOME returned by `buildExecutionEnv`. |
| A nonzero Codex exit discards a completed Plan reply | Fixed. `src/plain-unwrap.ts:1111` consults the fallback for a completed messageless turn even after nonzero exit. `tests/release-0131.test.ts:120` retains the Plan text and stderr with exit 2 and failure status. |
| Human output exceeds the cumulative capture limit | Fixed. `src/plain-unwrap.ts:1422` computes remaining space before each append and retains only a UTF-8-safe prefix. `tests/release-0131.test.ts:130` sends two 10 MiB lines whole and separately, requires overflow, and caps retained output at 16 MiB. The existing chunking property test now expects the bounded prefix for whitespace, complete lines, and an unfinished multibyte tail. |
| A warning after turn.failed passes as a startup warning | Fixed. `src/result-envelope.ts:715` tracks whether any turn started. `:850` allows outside-turn warnings only before that first start. `tests/release-0131.test.ts:144` requires trailing drift after a failed turn and excludes the warning from retained startup warnings. |

For example, a child that writes an authentication diagnostic and exits 2
still returns that diagnostic, its stdout, and exit 2 when recording sync
fails. The extra stderr line names the cleanup failure. A malformed
protocol remains a protocol failure; an operational server-cleanup error
does not create a new protocol abort.

### Verification

- `make install`: exit 0; the worktree initially had no installed dependencies.
- First focused command: 141 pass / 6 fail across 147 tests. Six old token-copy
  fixtures also supplied API keys; they now select file authentication explicitly.
- Second focused command: 94 pass / 0 fail across 94 tests, including the new
  Kimi and shutdown-wait regressions. `make typecheck`: exit 0.
- First full gate: exit 2, 2304 pass / 6 skip / 3 fail; 2313 tests across 84
  files. The corrections preserve known status notifications, update bounded
  prefix expectations, and refresh the release-version header in the session
  report. The boundary rerun passed 3/0 across 3 tests.
- A strengthened canonical-path regression exposed a symlink-plus-parent path
  being normalized before resolution. Component-wise resolution fixes it.
  The second full gate had already loaded that code: exit 2, 2306 pass /
  6 skip / 1 fail across the same 2313 tests.
  The cleanup matrix was also expanded to ordinary success and nonzero exit.
  `bun run test tests/process-protocol.test.ts tests/release-0131.test.ts`:
  exit 0, 39 pass / 0 fail across 39 tests.
- Final command:
  `env -u NODE_OPTIONS COPILOT_PKG_CACHE_HOME="$PWD/scratch/copilot-cache-0131" make release-gate`
  — **exit 0**, log `scratch/0131-release-gate-verified.log`.
  The full, unfiltered suite reported **2311 pass / 6 skip / 0 fail**:
  `Ran 2317 tests across 84 files. [243.42s]`.
  Installed contracts reported **3 pass / 0 fail**:
  `Ran 3 tests across 1 file. [14.49s]`.
  Compared with the supplied **2286/2/0** baseline, this adds 29 tests,
  25 passes, and four skips. Nine tests came from Round 14 and twenty
  from this fix release. Compared with the preceding full run, four
  added cleanup-matrix cases and the recovery fix add five passes;
  the test count rises from 2313 to 2317 and the last failure is gone.
- Four existing process-table checks skip because this host denies the
  required operations: two descendant-cleanup tests, the remembered-descendant
  test, and the live process-table test. The other two skips run in the
  separate installed-contract stage. No workaround or test filter was used.
- Runtime validation, type checking, shell syntax, coverage, installed
  contracts, scode compatibility, smoke checks, dependency audit, and
  frozen-lockfile validation passed. There is no separate lint target;
  documentation assertions run in the full suite. Conservative coverage:
  **87.81% lines / 93.11% functions**. Exact gate summary:
  `Release gate passed. Review docs/RELEASE-GATE.md before tagging.`
- `uv run --no-project ~/.claude/skills/humanizer/scripts/check_american.py`
  on all 35 touched files: **exit 0**, zero British spellings,
  `American English: CLEAN`. The added-line home-path check and
  `git diff --check`: **exit 0**. Final prose and staged whitespace checks
  are repeated after recording these results.

| Requested work | Final status |
|---|---|
| Fourteen distinct root fixes and regression coverage | Done; full suite passes |
| Findings superseded by al41 | Done; completion shortcut disposition above, no signal attribution restored |
| Version 0.13.1, dated changelog, README, HERMETIC, release report | Done |
| Full release gate, American English, whitespace, and home-path checks | Done; exit 0 |
| Existing process-table-dependent checks | Environment-blocked; four skips, unchanged tests |
| Stage all changes with `git add -A` | Done; no commit |

No code-review, commit, push, or live Agy request ran. Installed contracts use
help and version commands only. No literal home path was added. Branch remains
`release-0.13.1` at `a5af184`.

## 0.13.2

This release starts from `a88329d` on `release-0.13.2` in worktree
`codemux-0132`. The two regressions introduced by 0.13.1 were fixed first.
The decisions below supersede conflicting historical recovery rules above.

### Fixes and regressions

| Finding | Fix and evidence |
|---|---|
| Valid Claude notifications abort experiments | `src/experiment-bridge.ts:14` lists accepted SDK and control-transport frame types. Compaction boundaries, heartbeats, and other documented notifications remain in the raw recording and trace. Missing, non-string, and unknown types still fail. `tests/experiment-protocol.test.ts` adds a successful run containing a compaction boundary and a tool-progress heartbeat, then checks their recorded bytes. |
| Codex fallback prints after a protocol failure | `src/plain-unwrap.ts:1112` requires no protocol failure before consulting the Plan fallback. `tests/release-0132.test.ts:38` completes a messageless turn, emits a top-level error, and requires empty stdout, failure status, and no fallback read. A later nonzero process exit without a protocol error still preserves the completed Plan reply. |
| API-key runs expose the unused file token | `src/adapters/agy.ts:217` shares configuration entries individually, excluding the token and probe directory. `tests/release-0132.test.ts:50` covers both API keys, distinct login and injected tokens, and plain and hermetic runs. Writing a new private token leaves both originals unchanged. |
| Relocated HOME loses stale credential recovery | `src/adapters/agy.ts:163` validates both roots before recovery or sweeping. `tests/release-0132.test.ts:75` plants marked homes with dead owners and mirrors in both roots, then checks removal of both homes and both search-list entries. |
| Recovery removes unrelated Keychain entries | `src/agy-keychain.ts:46` rejects symlinked, noncanonical, or foreign-owned probe roots before search-list access. `:66` recognizes only the template or an exact mirror path beneath a direct `run-*` directory in a validated root. `tests/release-0132.test.ts:92` proves a symlinked root causes no search-list mutation; `:105` preserves unrelated files and directory layouts. |
| An inaccessible unrelated Keychain entry blocks recovery | `src/agy-keychain.ts:70` preserves entries whose canonicalization fails. `tests/release-0132.test.ts:116` injects EACCES and ENOTDIR for unrelated entries and still recovers the owned mirror. |
| Signal handling waits indefinitely for adapter cleanup | `src/process-runner.ts:559` bounds the asynchronous callback by the existing 2000 ms grace and reports that adapter cleanup and the interruption receipt remain incomplete before exit 143. `tests/release-0132.test.ts:142` runs a synthetic subprocess with cleanup that never settles and checks bounded exit and the diagnostic. |
| Relative or empty HOME can prepare credentials in the wrong directory | `src/adapters/base.ts:64` rejects those values in the shared constructor, before adapter preparation. `tests/release-0132.test.ts:136` checks every registered adapter with empty and relative values. |

The notification shapes follow the
[SDK reference](https://code.claude.com/docs/en/agent-sdk/typescript#sdkcompactboundarymessage)
and [streaming documentation](https://code.claude.com/docs/en/agent-sdk/streaming-output#message-flow).
No compaction-boundary sample existed in the repository fixtures, so the
regression uses the documented shape with synthetic session identifiers.

For example, `turn.completed` followed by `error` previously printed a stale
Plan from the fallback file. It now prints no reply and retains the protocol
failure. The regression confirms the file reader is never called.

### Verification

- `make install`: exit 0; nine dependencies installed in the new worktree.
- The first two new regressions failed before their fixes: 32 pass / 2 fail.
  Afterward the same command passed 34/0 across 34 tests.
- The remaining regression file reproduced seven failures before their fixes.
  Afterward it passed 8/0 across eight tests, including the Codex regression.
- The broader focused run reported 270 pass / 4 fail across 274 tests.
  Four older fixtures encoded superseded rules: preserving a relocated stale
  home, removing any Keychain filename beneath a probe root, sharing the whole
  configuration directory, and supplying a nonexistent HOME to a security-path
  test. Their assertions now match the approved rules while retaining the
  original checks for unrelated entries and login-home Keychain selection.
- `bun run test tests/release-0131.test.ts tests/release-0132.test.ts tests/agy-keychain.test.ts`:
  exit 0, 69 pass / 0 fail across 69 tests. Log: `scratch/0132-recovery.log`.
- `make typecheck`: exit 0 after correcting a filesystem mock's overload type.

- Final full gate:
  `env -u NODE_OPTIONS COPILOT_PKG_CACHE_HOME="$PWD/scratch/copilot-cache-0132" make release-gate`
  — exit 0. Log: `scratch/0132-release-gate.log`.

```text
2320 pass
6 skip
0 fail
17954 expect() calls
Ran 2326 tests across 85 files. [242.26s]
3 pass
0 fail
148 expect() calls
Ran 3 tests across 1 file. [14.02s]
Release gate passed. Review docs/RELEASE-GATE.md before tagging.
```

Compared with the supplied 0.13.1 baseline of **2315/2/0**, this adds nine
tests, five passes, and four skips. Four existing process-table checks skip
because this host denies the required operations. The other two skips are
installed-contract cases covered by the separate stage. No test filter or
permission workaround was used. The full suite grows from 2317 to 2326 tests.

Runtime compatibility, type checking, shell syntax, the unfiltered suite,
coverage, installed contracts, scode compatibility, CLI smoke checks,
dependency audit, and frozen-lockfile validation passed. There is no separate
lint target. Conservative coverage is 87.82% lines and 93.00% functions.

`uv run --no-project ~/.agents/skills/humanizer/scripts/check_american.py`
on all 14 touched files exited 0: zero British spellings,
`American English: CLEAN`. Final prose, whitespace, and added-line home-path
checks also exited 0. `git add -A` exited 0; all 14 changed files are staged.

| Requested item | Status |
|---|---|
| Two 0.13.1 regressions fixed first | Done |
| Every remaining supplied finding fixed at its root cause | Done |
| Regression coverage for every finding | Done; nine new tests |
| Version 0.13.2, dated changelog, and this report section | Done |
| Full release gate | Done; exit 0, 2320/6/0 |
| Existing process-table checks | Host-blocked; four skips |
| American English, whitespace, and added-line home-path checks | Done; exit 0 |
| Stage all changes with `git add -A` | Done; no commit |

No code-review, commit, push, or live Agy request ran. Installed contracts use
help and version commands only. No literal home path was added.
