# Live harness sessions — design (Prompt A)

Status: implemented. The live-sessions branch (based on 0.7.0, cfaecec) carries
the implementation of §4 — `codemux session` for claude, zai, codex, and agy,
with the drivers, the CLI, and the registry this document specifies. See
`docs/live-sessions-report.md` for the implementation record and its
verification results; deviations from this document are listed there.

Amended 2026-10-05 after the three-panel review consolidated in
`docs/LIVE-SESSIONS-PANEL.md`: §3 carries the openclaw-verified app-server
facts, §4 absorbs the panel findings (permission-channel ceiling, session
version floors, permission timeout, registry live owner and placement
corrections, bounds and tiering), §7 is the amended plan. §10 is unchanged.

## 1. Problem

`codemux run` is one prompt in, one result out. lab-service's broker daemon
needs more: it owns long-running harness sessions on behalf of multiple users
(Slack, web, ssh) and must

1. start a headless session through codemux, in scode, under a chosen account
   (`CLAUDE_CONFIG_DIR` / `CODEX_HOME` passthrough);
2. receive every event the harness emits, normalized and raw;
3. send live input: a user message attributed to its author, a mid-turn steer,
   an interrupt, a permission answer;
4. kill, restart, and resume sessions by id.

`run` cannot do 2–4: it captures stdout once the process exits, passes stdin
once, and persists nothing (`--no-session-persistence`, `--ephemeral`).

## 2. Constraints from this repo's history

`--session` was built for 0.6.0 and removed before release after eighteen
review rounds; the rationale and open questions are in
`docs/lab-service-features-report.md` (round 19, "Deferred: session resume").
`docs/HERMETIC.md` ("Session persistence") records the two questions resume
must answer before it comes back:

1. how to mark a session as created hermetically, so a hermetic resume is
   vouched rather than assumed;
2. whether Codex sessions can resume at all when hermetic runs give Codex a
   private `CODEX_HOME` that is destroyed at exit.

This design answers both (§4.8). Round 17's cross-provider replay hazard (a
Claude-home session resumed through zai replays the transcript to the Z.AI
endpoint) is closed by the same mechanism. Round 19's ownership-record defects
(size limits, record-on-success races, concurrent writers, XDG/HOME split)
shape the registry's mechanics, not just its existence.

Layering rule: `run` stays stateless (its `--no-session-persistence` and
`--ephemeral` flags are unchanged and still unconditional). `session` is the
opt-in persistence path. Nothing about `run` changes.

## 3. Findings

Evidence tags: `[help]` installed `--help` output; `[strings]` static string
extraction from the installed binary (no execution); `[repo]` this repo's
docs/tests; `[OSS]` the openclaw checkout at `~/Programming/OSS/openclaw`;
`[verify]` needs a live probe in Prompt B. Versions: claude 2.1.280, codex
0.159.3, agy 1.2.14 (the audited floor; the installed binary self-updated
to 1.2.16 mid-audit — the compatibility ledger's 2026-10-04 addendum).

### 3.1 Claude Code (Q1)

**Keep sending user messages over stdin: yes.** `--input-format stream-json`
(print mode only) is documented as "realtime streaming input"; the companion
`--replay-user-messages` flag exists precisely to re-emit stdin messages on
stdout for acknowledgment, which only makes sense for multi-message stdin.
`[help]`

**Mid-turn: delivered at the next model request, so no turn is stable.**
The binary contains the strings `Mid-turn, the user added: `, `user added
mid-turn: `, and `processed message(s) that were delivered mid-turn`. The
step-0 probe and two live21 probes show what print mode does with a user
message sent while a turn runs. The harness echoes the message
(`isReplay: true`) at the running turn's next model request and folds it
into that turn: one result answers both prompts. The fixture shows this
(`tests/fixtures/live/zai-session-a.ndjson`): the "also reply with the
word two-b" line (34), sent during the Bash turn, is echoed after the tool
result (59) and answered inside that turn's result (74, `"two-b\n\nprobe-
permission-ok"`, `num_turns: 2`, `result_index: 2`); the next result (82)
is the interrupted counting turn. When the running turn makes no further
model request (a text-only reply), the message runs as a turn of its own
after the result and gets its own result (live21 probe, 2026-10-07). Which
result answers a mid-turn message is therefore not knowable when it is
sent. codemux reports `user_during_turn: false` for claude-family and
rejects a mid-turn `user` line `busy` (review live21; the step-0 reading
of the fixture was wrong, and the driver built on it attributed every
later result to the turn before it). `[live 2026-10-04 and 2026-10-07,
fixture]`

**Interrupt without killing: yes.** The stream-json stdout type union is
`system | user | assistant | stream_event | result | control_request |
control_response` (all seven present in the binary, and all seven seen live).
The step-0 probe pinned the round-trip: the caller sends
`{type:"control_request", request_id, request:{subtype:"interrupt"}}`; the
harness answers `{type:"control_response", response:{subtype:"success",
request_id, response:{still_queued:[]}}}` (no fixture records the
protocol's `subtype:"error"` answer to an interrupt; the driver treats
one as a refusal, so the interrupt stops being pending and cannot label
the turn's own error result — review live22, the codex driver's
rejected-interrupt rule; the driver matches the refusal to the exact id
it sent, the caller's `interrupt-N` or the end path's `interrupt-end-N`,
review live23), emits a `user` message carrying
`[Request interrupted by user]`, and the interrupted turn ends with a
`result` whose `subtype` is `error_during_execution` and `is_error` is true
(the process then exits 1 in print mode). `[live 2026-10-04, fixture]`

**Permissions reach the caller as a control round-trip.** The harness emits a
`control_request` (subtypes around `can_use_tool` / `permission_request`,
carrying the tool name and input); the caller answers on stdin with a
`control_response` keyed by `request_id` and a `behavior` of
`allow` / `deny` / `ask` (all three strings present). The 2.1.280 help lists
`--permission-prompts <host|none>`, but the step-0 probes found the
**working carrier is `--permission-prompt-tool stdio`**: with
`--permission-prompts host` (and no host attached) the harness never emits a
request — the ask is auto-denied and surfaces as `system/permission_denied`
(probe fixtures `zai-permission2.ndjson`); with
`--permission-prompt-tool stdio` a genuine `can_use_tool` request round-trips
(fixture `zai-permission3.ndjson`). The verified request is
`{type:"control_request", request_id, request:{subtype:"can_use_tool",
tool_name, display_name, input, description, permission_suggestions:[{type:
"addRules", rules:[{toolName, ruleContent}], behavior, destination:
"localSettings"}], decision_reason, decision_reason_type, tool_use_id}}`; the
accepted answer is `{type:"control_response", response:{request_id,
subtype:"success", response:{behavior:"allow", updatedInput, message}}}`
(deny: `behavior:"deny"`), and the harness echoes the accepted
`control_response` back on stdout. `[live 2026-10-04, fixtures]`

Two auto-decisions the probes also pinned, both relevant to the ceiling
table: safe read-only commands (`echo`) are auto-ALLOWED without any
request, and file writes outside the allowed working directories (`touch`
in `/tmp`, `sw_vers` which reads system state) are auto-DENIED without any
request under `--permission-mode default` — the deny surfaces as
`system/permission_denied` (with a `decision_reason` in
`zai-permission2.ndjson`; the `touch` case in `zai-permission.ndjson`
carries only a `message`). Requests only arrive
for the ask-worthy band between those poles. `[live 2026-10-04, fixtures]`

**Session identity and resume: yes.** `--session-id <uuid>` pins the id;
`-r, --resume <id>` continues a conversation; `--fork-session` resumes into a
new id. Help also documents kept background conversations (`claude attach`)
but those are interactive affordances; headless resume is `--resume`.
Verified live: the `system/init` message carries `session_id` and the tool
list and arrives **once per turn** (not once per process), and `--resume
<uuid>` reports the SAME `session_id` in the resumed init with no `resume`
field distinguishing it. `[help]` `[live 2026-10-04, fixtures]`

**Under scode: no new mechanism.** stream-json is a flag change on the same
binary; harness state (`CLAUDE_CONFIG_DIR`) stays writable under every scode
preset except `untrusted` (`docs/HERMETIC.md`). Live check is probe 6. `[repo]`
`[verify]`

**Open details for Prompt B: closed by the step-0 probes.** `--verbose` IS
still required (`--output-format stream-json` in print mode exits with
"When using --print, --output-format=stream-json requires --verbose"
without it — despite 2.1.280's help text dropping the mention); the session
id arrives in the per-turn init `system` message; the control-request and
control-response shapes are recorded above and in the fixtures. The probes
also observed `system` subtypes beyond init (`thinking_tokens`,
`permission_denied`, `hook_started`, `hook_response`), which §4.2's
unknown-passthrough handles generically.

### 3.2 Codex (Q2)

**app-server is the live path; `exec --json` is not.** `codex exec --json`
prints its JSONL event stream for exactly one turn and exits — the grammar is
already pinned in `docs/HARNESS-COMPATIBILITY.md` (2026-10-03 addendum,
rust-v0.159.3). Live input needs `codex app-server` ("[experimental] Run the
app server", root help): JSON-RPC 2.0 over stdio. `[repo]` `[help]`

The binary's method table (extracted with `strings`): client→server
`initialize`, `notifications/initialized`,
`thread/start|resume|fork|list|read|items/list|turns/list|inject_items|
compact/start`, `turn/start`, `turn/steer`, `turn/interrupt`,
`turn/settings/update`, `review/start`, `model/list`, `fs/*`,
`thread/queue/*` (list/update/delete/reorder/start), `thread/realtime/*`,
`remoteControl/*`; server→client notifications `thread/started`,
`turn/started`, `item/started|updated|completed`, `plan/updated|delta`,
`turn/completed` (the slash form of the dotted `exec --json` events).
`[strings]`

**The param shapes are now verified from openclaw's production client**
(`src/app-server/` in the openclaw checkout, synced against 0.159.x)
`[OSS]`: framing is NDJSON — one JSON-RPC 2.0 message per line, no
LSP-style headers. `initialize` takes the client info and a client config
object; `thread/start` takes `{model?, sandbox?, approvalPolicy?,
config?, cwd?}`; `thread/resume` the same plus `threadId`; `turn/start`
takes `{threadId, input: [{type: "text", text}…], sandboxPolicy?}` — the
thread-level `sandbox` is the string mode, the turn-level `sandboxPolicy`
the structured policy. Server→client notifications carry the thread or
turn id in `params`; `turn/completed`'s `params.turn` is the full turn;
`thread/tokenUsage/updated`'s `params.tokenUsage` is `{total, last,
modelContextWindow}` — per-turn delta in `last`, cumulative in `total`.
The step-0 fixtures confirm these against the installed 0.159.3; anything
a fixture contradicts wins. Fixture-level confirmations and corrections:
server→client **responses omit the `jsonrpc` field** (requests carry it,
responses do not — the parser keys on `id`/`method`/`result`/`error`, never
on `jsonrpc` being present); `thread/started` params carry the thread as an
OBJECT (`params.thread.id`, plus `sessionId`, `cwd`, `model`, `status`,
`rollout` path, `originator` copied from `clientInfo.name`), and the
`thread/start` RESULT also carries the thread, so either resolves the id;
`turn/started` params carry `{threadId, turn:{id, items, itemsView, status,
error, startedAt, completedAt, durationMs}}`; `turn/completed` params
carry the turn with **no usage inside** — usage arrives only via
`thread/tokenUsage/updated` `{threadId, turnId, tokenUsage:{total, last,
modelContextWindow}}`, where `last` is the per-turn delta and `total` the
cumulative (verified across two turns: turn 2 reported `last` ≈ the turn's
own cost and `total` ≈ double it). The ambient notification stream is
wider than the method table above: `remoteControl/status/changed`,
`account/updated`, `account/rateLimits/updated`,
`mcpServer/startupStatus/updated`, and `thread/status/changed` all arrive
unprompted — §4.2's unknown-passthrough carries them. Item deltas arrive
as `item/agentMessage/delta` `{threadId, turnId, itemId, delta}`. `[live
2026-10-04, fixture]`

**Steering semantics are explicit.** Binary strings: "cannot steer a review
turn", "steering the active task rather than replacing it" (a steer adds a
message the active task must account for), "steer-only submission cannot start
a turn". So `turn/steer` requires an active turn; a user message sent while a
turn runs goes through the thread queue instead. `[strings]` codemux does not
use the experimental `thread/queue/*` surface: it keeps its own per-session
FIFO and issues `turn/start` from the queue on `turn/completed` (§4.7) —
transport ordering is codemux's job; user fairness stays with the broker.

**Approvals surface as server→client JSON-RPC requests** —
`item/commandExecution/requestApproval`, `item/fileChange/requestApproval`,
`item/permissions/requestApproval` — answered with JSON-RPC **result**
payloads openclaw pins exactly `[OSS]`: `{decision: "accept"|"decline"}` for
the first two, `{permissions: {…}, scope: "turn"}` for the third. openclaw's
client also sees `item/tool/call`, `item/tool/requestUserInput`, and
`mcpServer/elicitation/request` from the server; codemux's rule for every
request it does not implement is §4.7's (answer error, never approve).
`[OSS]`

**Under scode with relocated `CODEX_HOME`: same env mechanics as `exec`.**
app-server is the same binary reading the same home; the adapter's `env(1)`
prefix and `--pass-env CODEX_HOME` path apply unchanged, and scode keeps
harness state writable. Hermetic does not carry over: the hard-linked
`auth.json` home is run-scoped and destroyed at exit, which is exactly HERMETIC
question 2 — answered in §4.8 by refusing hermetic codex sessions. Probes 8
and 9 verify app-server honors `CODEX_HOME` and does not attach to the
shared daemon (`codex agents` / `codex queue` / `remote-control` imply one exists; a
`daemon_auto_start` feature flag appears in the binary — a singleton daemon
would escape per-session sandbox and account boundaries, so codemux spawns one
dedicated app-server per session). Probes 8 and 9 ran: the relocated
`CODEX_HOME` is honored (it appears verbatim in the `initialize` result's
`codexHome` and in the rollout path) and the process-list diff before/after
the exchange is empty — no shared daemon attaches. `[strings]` `[repo]`
`[live 2026-10-04, fixture]`

### 3.3 ACP (Q3)

**Maintained adapters exist for both harnesses.** `@agentclientprotocol/
claude-agent-acp` 0.55.0 (JS) and `@zed-industries/codex-acp` 0.16.0 (Rust,
platform binaries), pinned in openclaw's shrinkwrap; acpx also lists droid,
gemini, kimi, opencode, and qwen adapters, and cursor ships a native
`cursor-agent acp` subcommand. `[OSS]` (hermes' own `acp_adapter/` could not be
read — permission denied; noted in §8.)

**Completeness for the broker's needs:** streaming yes (`agent_message_chunk`,
`agent_thought_chunk`, `tool_call`/`tool_call_update`, `usage_update`);
interrupt yes (`session/cancel`); permissions yes (`session/request_permission`
round-trip, the protocol's strongest suit); resume partial (`session/resume` +
`loadSession` replay, semantics adapter-defined). Mid-turn steering is not in
the core protocol — cancel-and-reprompt is the only portable path. Author
labels do not exist. Raw harness events do not pass through (ACP is a
normalization layer). The client must implement `fs/*` and `terminal/*`
methods or the agent stalls. `[OSS]`

**Production precedent cuts against adopting it as the core:** openclaw's
default Codex path is its native app-server plugin (stop, steer, queue);
ACP is the explicit fallback, run with an isolated `CODEX_HOME`. `[OSS]`

**Recommendation: codemux speaks its own JSONL protocol; do not expose live
sessions as an ACP agent.** The broker's hard requirements — verbatim `raw`
events for archival, per-message author attribution, capability flags, scode
and account flags — are all codemux-domain and all absent from ACP, and ACP
drags in editor-client obligations (`fs/*`, `terminal/*`) the broker would have
to stub. Own protocol keeps codemux dependency-free. An ACP server
(`codemux acp`) can be layered on the same session core later if an editor
client ever needs to drive codemux; the plan factors the wire protocol thin so
that road stays open. This mirrors what openclaw concluded for itself.

### 3.4 Capability matrix (Q4)

| | claude 2.1.280 | zai | codex 0.159.3 | agy 1.2.14 | cursor |
|---|---|---|---|---|---|
| live input | yes `[help]` | yes (claude binary) | yes (app-server) `[strings]` | yes (one NDJSON line → one turn) `[help]` | no (print stream-json is output-only) `[help]` |
| user during turn | no (rejected `busy`: folded into the running turn or run as its own, by the turn's shape) `[live]` | same | queue `[strings]` `[live]` | no (turns serialize) | — |
| steer | no on-demand carrier `[live]` | same | `turn/steer` | no mechanism `[help]` | — |
| interrupt | control_request | same | `turn/interrupt` | no (`--print-timeout` only) | — |
| permissions | control round-trip | same | approval round-trip | no host round-trip | — |
| text deltas | `--include-partial-messages` | same | plan/item deltas | unknown | — |
| file changes | derived (Edit/Write calls) | same | native patch events | unknown | — |
| usage stream | per-message + per-turn result `[live]` | same | `thread/tokenUsage/updated` only (`turn/completed` carries none) `[live]` | unknown | — |
| resume | `--session-id` / `--resume` | same (shared-home hazard) | `thread/resume` | `--conversation` | `--resume` (no live input) |
| scode | yes | yes | yes `[verify]` | yes (run path) | yes (run path) |

The agy column was audited at 1.2.14; the installed binary self-updated to
1.2.16 mid-audit (the compatibility ledger's 2026-10-04 addendum records what
that drift does and does not change).

Antigravity is included per instruction: its print mode does accept live input
(one NDJSON message per line, a turn per message), so it can join a later step;
its steer/interrupt/permission cells are empty because nothing in its help or
binary evidences them — the capability flags would report false, honestly. The
remaining agents (droid, gemini, goose, kimi, opencode, openhands, pi, qwen,
aider, cline, copilot) have no verified live-input channel in their headless
CLIs; several have ACP adapters, which matters only if the ACP bridge is built.
(A claude-panel pass read a stale checkout and reported no agy run adapter;
the consolidation corrected it — `src/adapters/agy.ts` is registered and
pinned, so agy needs only a session driver, plan step 8. Its `--help` also
confirms `--input-format stream-json` "reads one NDJSON message per line from
stdin and runs a turn for each" and `--conversation <id>` resume `[help]`.
The step-0 probe adds one live frame: agy's result envelope is keyed
`event`, not `type` — `{"event":"result","result":{conversation_id,
status, response, error, duration_seconds, num_turns, usage}}` — recorded
in the auth-failure fixture; the full exchange could not run, see §8.)

The broker must never assume: v1 ships capability flags on every
`session_started`, and the matrix above is what the flags report.

## 4. Recommended interface: `codemux session`

```
codemux session -a <agent> [run's flags] [--cwd DIR] [--resume <id>]
```

A long-lived codemux process speaking JSONL on stdio: one JSON object per line
in both directions, UTF-8, no framing beyond newlines. stdout carries events
only; diagnostics go to stderr, and the harness's own stderr passes through
there unparsed, as `run` passes it (review live17: it used to be captured
and never read, so a startup failure's reason was lost). Flags match `run` (`-m`, `--auto`, `--effort`,
`--cwd`, `--sandbox*`, `--pass-env`, `--tools`, `--enable-playwright-mcp`,
`--hermetic`) plus session-only flags defined below.

### 4.1 Input messages (caller → codemux)

| type | fields | meaning |
|---|---|---|
| `user` | `text`, `author?` | send a user message. While a turn runs, behavior follows `capabilities.user_during_turn` (queue for codex; rejected `busy` on claude/zai and agy). |
| `steer` | `text`, `author?` | steer the active turn (codex only — claude/zai report `steer: false`: their wire has no carrier that shapes the running turn on demand, so a `steer` line is `input_rejected` `unsupported`). No active turn → `input_rejected` (`no_active_turn`); send `user` instead. |
| `interrupt` | `reason?` | stop the active turn, keep the session. No active turn → acknowledged no-op. One exception: on claude/zai an interrupt that arrives after a `user` line was forwarded but before the init frame opened its turn is held and delivered the moment that turn opens (review live18). |
| `permission_decision` | `request_id`, `decision` (`allow`\|`deny`), payload mirroring the request's per-request options (e.g. `updated_input`) | answer a pending `permission_request`. Unknown id → `input_rejected`. Bound by the autonomy ceiling below: `allow` is honored only when the action that will actually run — the request's tool, with the arguments the answer substitutes when it carries `updated_input` — is within the start-time `--auto` level; anything else is answered deny by codemux. |
| `shutdown` | — | end the session (§4.6); the grace period is `--shutdown-grace` (§4.5) on every path — one knob, no per-message field. |

Every non-blank line is answered by an `input_accepted` or
`input_rejected` event carrying `input_seq` (codemux-assigned,
monotonic), so the broker knows its line was parsed. Two framing
carve-outs: a blank or whitespace-only line is skipped without an
answer or an `input_seq`, and a trailing CR is stripped before parsing
(CRLF framing). An accepted `interrupt` or `steer` is one codemux wrote
to the harness: a write the harness refused ends the session, and the
line is rejected `shutting_down` (review live23). The answer holds inside the shutdown drain too (review
live9): the CLI keeps relaying stdin through the whole grace window, so a
line landing after the end path began — but before `session_ended` — is
answered `input_rejected` (`shutting_down`), never dropped; once
`session_ended` is queued the stream is closed and nothing follows it.
Lines the end path finds still buffered — never yet submitted, like
codex's pre-handshake buffer — get the same `shutting_down` answer, and
lines already acked but foreclosed by the end are reported with one
non-fatal `error` (their acks cannot be retracted and a second answer
would double-ack; review live10). On codex these are mid-turn lines in
codemux's own queue, so the notice names a drop. On the claude family
the only such line is a `user` line accepted before the init frame
(mid-turn lines are rejected `busy`, review live21): it was forwarded at
once, so the notice says the harness may still run it inside the grace
window, and a result it
produces there answers no open turn and mirrors as `unknown` rather
than ending the session as a grammar violation (review live16). Malformed lines are rejected and the stream continues.
`text` is bounded at 16 MiB and may not contain NUL; an input line is
bounded at 17 MiB (an unterminated line over the cap is rejected and the
reader resynchronizes at the next newline). Capability-false inputs are
rejected, never silently ignored: `steer` with `steer: false` →
`input_rejected` (`unsupported`); `interrupt` with `interrupt: false` →
`input_rejected` (`unsupported`); `user` during a turn with
`user_during_turn: false` → `input_rejected` (`busy`).

A pending `permission_request` is answered deny on `--permission-timeout`
expiry (§4.5), on `interrupt`, on `--turn-timeout`, on every shutdown
path (`permission_resolved: "superseded"`, §4.2), and when its own turn
completes or fails without the decision — a request that lost its race
with the turn's result is dead on the harness side, so a later decision
for it is `unknown_request` and no stray deny can land in a later turn
(review live11). A request that lands
inside the shutdown drain — after the end path denied everything it
found pending — gets the same treatment at once: caller decisions are
already refused once an end request began (`input_rejected`
`shutting_down`, review live9), so waiting would leave the
harness blocked on an answer that can never come (review live8). A
`permission_decision` for an unknown, late, or already-resolved id is
`input_rejected` (`unknown_request`); pending requests are a set, so
parallel tool calls each keep their own id.

**Autonomy ceiling.** `--auto` at start fixes what codemux will answer
`allow` to for the session's whole life (the `run` mapping, §4.5; reported
as `autonomy` on `session_started`), and nothing in the input stream raises
it. The ceiling bounds the **permission channel** — what codemux will
approve — never what the harness itself can do: user settings loaded via
`--setting-sources user` can carry `permissions.allow` rules that run tools
without ever reaching the host channel, and scode's writable presets do not
prohibit Bash at medium. The enforced boundary below high is scode, the
repo's standing doctrine (`src/adapters/base.ts`); the residual — an
operator's own allow rules pre-approving tools inside the sandbox — is the
operator's configuration, bounded by scode, and is named here rather than
papered over. Within the channel the ceiling
is a rule over the permission being granted, not over the answer type: an
`allow` is honored only when the action it approves — the tool and the
arguments the harness would actually execute, which is the request's own
pair, or that pair with the arguments an `updated_input` substitutes — is
one the start-time mapping already permits. At read-only, any write or
command execution stays denied whatever the caller answers. At low, caller
approval is exactly what the
level means, so every forwarded request is allow-able. At medium, edits
inside the workspace are allow-able; Bash and the other tools the level
does not grant are not. At high the mapping grants the editing tools and
Bash and nothing else (`src/claude-autonomy.ts`): on hardened builds the
env-scrub hardening discards the bypass and forces default mode (§4.3),
so requests for ungranted tools — WebFetch, MCP — still reach the host,
and high gets a predicate like every other level — the granted tools
allow-able, the rest denied. codemux decides this
itself, per harness, from the request's own payload:

- **claude/zai:** the `can_use_tool` control request carries the tool name
  and its input. codemux applies a pure table-driven predicate
  (`src/session/ceiling.ts`, plan step 3): an explicit tool × level →
  allow-able table covering the built-ins the init `system` message names —
  read tools (Read, Grep, Glob, …) allow-able only where the level grants
  anything; WebFetch, WebSearch, Task/Agent, Skill, SlashCommand,
  ExitPlanMode, TodoWrite, BashOutput/KillShell, and `mcp__*` each
  explicit — with **default deny for unknown tools**, and a test diffing
  the table against the recorded init `tools` fixture. read-only — nothing
  allow-able, deny all; medium — the editing tools (Edit/Write/
  NotebookEdit) on paths inside the `grantRule` launch-directory scope,
  with Bash and ungranted tools denied; low — anything, except that a
  tool with a known argument schema (Edit, Write, NotebookEdit, Bash)
  carrying a key outside that schema still denies (the schema check runs
  before low's fast path); tools without a schema (Read, WebFetch, Task,
  `mcp__*`, and unknown tools) accept any arguments at low; high — the
  mapping's grant list (Edit/Write/NotebookEdit/Bash), with ungranted
  tools denied the same way as at medium. The medium path predicate calls
  the one `grantRule` implementation (`src/claude-autonomy.ts`: realpath
  of the deepest existing ancestor, NFC normalization, grammar refusals)
  rather than reimplementing it; the argument key is named per tool
  (`file_path`, `notebook_path`); the scope never reaches executable
  configuration below the launch directory — a `.git`, `.claude`,
  `.codex`, `.gemini`, `.cursor`, `.vscode`, `.idea`, or `.husky`
  component, or a `.envrc`, `.mcp.json`, `.claude.json`, `.gitconfig`,
  `.gitmodules`, `.ripgreprc`, or shell-startup base name, case folded
  the Unicode way (upper then lower case, so the long s in `.vſcode` and
  the Kelvin sign fold to ASCII as APFS's lookup folds them; review
  live22), denies, because whatever lands there runs later outside the sandbox
  without anyone running it on purpose (review live11 for `.git`, review
  live17 for the rest: a medium `allow` let a turn write
  `.claude/settings.json` hooks; only the part below the launch directory
  is judged; high never consults the predicate, and codex patch approvals
  share the check). The ceiling only judges requests the harness routes
  to the caller (review live18): a medium claude/zai session carries
  `run`'s `Edit(//<cwd>/**)` grant under `acceptEdits`, so Claude Code
  approves an edit inside the launch directory itself, except under its
  own sensitive set (`.git`, `.claude`, `.vscode`, `.idea` in the
  audited build), and a sandboxed codex session runs with
  `approvalPolicy: "never"`; for the other names a medium session is
  exactly as wide as a medium `run`. Containment
  demands the target's raw AND NFC spellings both sit inside the scope's
  own raw disk spelling, so on a normalization-preserving filesystem a
  sibling directory whose name is the composed spelling of the launch
  directory's cannot ride the NFC fold into "inside" (review live11);
  a path that resolves outside the scope
  through a symlink denies; a relative target is joined without
  collapsing `..` first, so the kernel spelling applies each `..` where
  the kernel will — after a symlink, to the link target's parent
  (review live7); a target whose spelling codemux cannot
  interpret the way the harness will — surrounding whitespace, a leading
  `~`, which Claude Code expands to the home directory and trims before
  writing — denies (review live6); an `updated_input` carrying keys
  outside the tool's known schema denies.
- **codex:** an approval request carries the command
  (`ExecApprovalRequest`) or the patch (`ApplyPatchApprovalRequest`), and
  codemux measures it against the thread's `--auto`-derived sandbox and
  approval policy (§4.7). No launchable codex session produces a request
  in the first place: the default sandboxed shape passes the bypass flag
  at every level — the mapping is not even consulted when sandboxed
  (`src/adapters/codex.ts`) — and unsandboxed codex is high-only (every
  level below high refuses to launch without scode,
  `src/adapters/base.ts`), where the mapping yields `never` too. The
  round-trip and this predicate are implemented anyway, so a harness
  change or config drift that surfaces a request still meets the ceiling:
  a genuine low/`untrusted` request is allow-able — that is what the
  level asks for — and a request surfacing anywhere else is measured
  against that level's mapping — read-only denies both kinds, medium
  allows workspace patches and denies commands.

When codemux cannot tell what the action is — tool name missing, arguments
unparsed, a target path it cannot resolve — the answer is deny. An `allow`
that fails the check is not forwarded: codemux answers the harness with
deny itself and rejects the caller's line with `input_rejected` (reason
`autonomy_escalation`), so the turn continues with the tool denied rather
than hanging.

An `allow` that changes the tool's arguments through `updated_input` is
judged, not refused: the ceiling runs on the merged arguments that will
actually execute, so the substitution gets the same predicate as any
other request. Refusing it outright would cost the one legitimate use —
the answering human narrowing an over-broad request (correcting a path,
scoping a command) before allowing it — and would add no safety, because
the check already sees the substituted action rather than the requested
one. The response format cannot swap the tool itself. An `updated_input`
that is not a JSON object is rejected `malformed` and the request stays
pending (the shape rule below); an object carrying an argument key
outside the tool's known schema is an action codemux cannot read, and
the answer is deny. The canonical refusal: at medium the harness asks
`Edit ./notes.md`, the caller answers `allow` with `updated_input`
pointing at `~/.claude/settings.json` — the merged action writes harness
state, medium's mapping denies it, and codemux answers the harness deny
and rejects the caller's line (`autonomy_escalation`) like any
out-of-bounds allow.

An answer's shape is judged before its content, and the shipped refusal
names two different mechanisms (review live6). codemux's input grammar
accepts per-request decisions only, so a shape that would grant beyond
the one request cannot be expressed at all: an answer carrying an
unknown field — claude-family's grammar has no always-allow or
rule-minting key to begin with — is rejected `malformed`, and a codex
`updated_input` on an approval is rejected `unsupported` the same way;
both leave the request pending, so the caller can re-answer within
bounds. The refusal named `autonomy_escalation` is the other mechanism:
an `allow` whose merged action fails the ceiling is answered to the
harness as a deny, the request resolves denied, and the caller's line is
rejected — nothing stays pending.
`permission_request` events therefore offer per-request choices only; a
session-persistent variant in the harness's own request is dropped, not
forwarded, and codemux never picks a session-persistent decision where
the harness offers one (codex `acceptForSession`).

### 4.2 Output events (codemux → caller)

Common envelope: `seq` (monotonic), `ts` (ISO 8601), `session_id`, `type`,
and `raw` — the harness's original line as a string (minus the trailing
newline) for every harness-mirrored event, `null` on codemux-originated
events: key order, duplicate keys, and framing survive for the broker's
archive. Accepted events are never truncated; the bounds are below.

- `session_started` — `session_id`, `agent`, `model`, `autonomy`, `cwd`,
  `sandboxed`, `sandbox_trust`, `capabilities` (§4.3),
  `protocol: "codemux-live-session/1"`.
- `input_accepted` / `input_rejected` — ack per stdin line, carrying
  `input_seq` and, on rejection, a `reason`.
- `user_message` — echo of an accepted `user`/`steer` line: `text`,
  `author?`, `input_seq`, `turn_id?` once known. The authoritative
  attribution record (§4.4).
- `permission_resolved` — `request_id`, `resolution`
  (`allow`|`deny`|`timeout`|`superseded`), emitted when a pending request
  leaves the pending set for any reason.
- `unknown` — a valid harness event codemux does not map, carried with
  `raw` intact (tiering below).
- `turn_started` — `turn_id`.
- `assistant_delta` — `delta`, `turn_id` (capability `deltas`).
- `assistant_message` — `text`, `turn_id` (always emitted, deltas or not).
- `tool_call` / `tool_result` — `call_id`, `name`/`output`, `input`, `is_error`.
- `file_change` — `path`, `action` (add|edit|delete); `derived: true` when
  inferred from Edit/Write/NotebookEdit tool calls rather than a native
  event. A derived change is emitted only when the call's own
  `tool_result` reports success — the `tool_use` frame arrives before the
  permission round-trip, and a denied or failed call changed nothing. A
  Write's action reads the target's pre-write state (an existing file is
  an edit); `raw` is the tool_use frame's line (review live10).
- `usage` — normalized block with `ResultUsageBlock` semantics (input not
  served from cache; cached = served-or-written; total = sum + output; the
  codex counter that folds cached reads into `input_tokens` is unfolded, as
  the `--result-json` code already does). Emitted only where
  `usage_stream: true` (codex), once per harness usage notification — a
  turn can carry several; the harnesses without a usage stream (claude,
  zai, agy) never emit it, their usage riding only `turn_completed.usage`.
  Session usage rides `session_ended.usage`, so there is no `scope` field.
- `permission_request` — `request_id`, summary (tool, command/paths),
  `options` (per-request choices only; session-persistent variants dropped,
  §4.1). Only deliverable answers are listed: a codex commandExecution
  approval whose `availableDecisions` omits plain `accept` (codemux never
  answers `acceptForSession`) advertises `deny` alone, and an `allow` on
  it is rejected `unsupported` and answered deny on the wire (review
  live15). One whose `availableDecisions` names neither `decline` nor
  `cancel` offers no refusal codemux may send, so it is never forwarded:
  it is answered with a JSON-RPC error, passed through as `unknown` with
  a non-fatal `error`, and its turn is interrupted (review live17). The
  ceiling check (§4.1) reads this request's tool and arguments
  — and, when the answer carries `updated_input`, the substituted ones —
  which the event therefore carries in full. Pending until answered,
  timed out, or superseded (§4.1).
- `turn_completed` — `turn_id`, `finish: end|interrupted|failed`, `reason?`,
  final `usage`. On the claude family the `interrupted` label is the
  driver's verdict, not the wire's: an interrupted turn arrives as an
  error result by convention (step-0 probe 4), so the parser reports the
  raw error bit and the driver pairs it with its own interrupt state —
  an error result with an interrupt outstanding is the interrupt
  striking; a clean result with one outstanding ended honestly (review
  live12), and the missed interrupt is spent with it: the harness reads
  it idle and drops it, since the next turn's line is written only after
  this result. Review live12 kept it pending for one more turn and
  live20 narrowed that roll to `error_during_execution`; both modeled a
  forwarded mid-turn line the harness had queued, and review live21
  removed the roll with the queue.
  On codex the wire names `interrupted` itself, so the wire's status is
  the verdict (review live14): a `completed` that a caller interrupt or a
  `--turn-timeout` raced is reported `end` with the full answer
  delivered, and only a wire `interrupted` that the timeout's own
  interrupt produced carries `reason: turn-timeout`.
  The per-turn `usage.cost_usd` is null on the claude family
  (review live10): the wire's only cost figure is session-lifetime, so
  mirroring it beside per-turn token counts invited callers to sum
  overlapping figures — the real figure rides `session_ended.usage`.
- `error` — `fatal`, `source: codemux|harness`, `message`.
- `session_ended` — `reason: shutdown|stdin-close|signal|timeout|crash`,
  `exit_code`, cumulative `usage`, `resumable`.

**Unknown and malformed events — three tiers** (Prompt B's passthrough and
the repo's fail-closed invariant, reconciled):

1. A valid JSON object whose type or method codemux does not recognize is
   an `unknown` event carrying `raw`; the session continues. Never dropped.
2. A recognized lifecycle event that violates the grammar ends the
   session with a fatal `error` (source `harness`), and the line is
   mirrored as `unknown` (raw preserved) first, wherever the violation
   is caught: at the parse (the harness-reported id missing or
   mismatched against the id codemux requested, a second thread
   announcement, an event referencing an unknown thread or turn) or at
   the driver's lifecycle bookkeeping (a turn terminal with no open
   turn, a duplicate permission or approval request id). Review live6
   split the two and emitted only the fatal for the bookkeeping half;
   review live21 unified them, because that half hid harness evidence
   the caller needs — claude's refused-resume `result`, whose `errors`
   carry the reason — and the agy driver already mirrored its own.
3. A line that is not valid UTF-8 or not JSON is a fatal `error` carrying
   a bounded excerpt (the first 4 KiB of the line's UTF-8 bytes, the same
   unit at the process layer and in every parser, review live23); the
   session ends. An empty harness line is framing and skipped; a
   whitespace-only one is not JSON and ends the session here.

Permission-shaped requests never kill the session on shape alone: an
unparsable `can_use_tool` or approval request is answered deny (§4.1's
opaque-action rule) with its raw preserved. Harness-reported ids are
validated at the boundary (§4.5): the id claude reports in its init
message must equal the `--session-id` codemux generated; a codex
`thread/started` must arrive exactly once and every turn, item, or
approval event must reference the known thread (and turn, once opened) —
this closes the wrong-session defect where it starts.

**Bounds.** A harness output line over 16 MiB is tier-3 fatal. The
outbound queue to the caller is bounded (1024 events / 64 MiB pending); a
caller that stops reading ends the session (exit 1, `session_ended`
reason `crash` if the queue still drains) rather than growing codemux
without limit. The diagnostic goes to stderr, not to an `error` event:
the event stream is the channel that failed (review live18). The
harness's stdin is bounded too (review live19): Bun's pipe sink buffers
every write the harness has not read, without limit, so a write that
would leave more than 64 MiB unread is refused, and every driver treats
the refusal as a codemux fatal. The codex driver's in-memory holds —
caller lines parked behind the handshake, `user` lines queued behind an
open turn, `steer` texts held until the server names its turn — are
bounded at 256 lines or 32 MiB each, a quarter of the outbound queue's
count so the burst that answers a whole hold fits the queue. A queued
`user` or held `steer` past the bound is rejected `busy` at its own
`input_seq`; a parked line past the bound ends the session with a fatal,
because rejecting it at once would number it ahead of the lines parked
before it, and the end path rejects every parked line `shutting_down` in
order. UTF-8 decoding is fatal-strict everywhere, caller stdin included:
a caller line with an invalid byte is rejected `malformed`, never decoded
with a substitute character and forwarded (review live20).

**Usage accounting.** claude-family: turn usage comes from the turn's
`result` event only; `message.usage` on `assistant` frames is never read
(the wire sends one content block per frame under a shared `message.id`,
so sibling frames are content, not repetitions — deduping by id would
drop real blocks). codex:
`thread/tokenUsage/updated` carries `{total, last}` `[OSS]`; each
notification's `last` delta is its own `usage` event with `raw`
preserved, and the deltas fold into `turn_completed.usage` — the first
delta of a turn replaces, later ones add (usage_stream is true, so the
standalone event is the stream). A notification that names no open turn
(it arrived after its turn's `turn/completed`) carries a null `turn_id`
and folds straight into the session cumulative, never into the next
turn (review live18). That holds after the next turn is named too: the
parser accepts item, delta, and usage notifications naming any of the
most recent 1024 closed turns (review live23), and the driver labels
them with no turn. Queued input
opens the next turn as soon as one completes, and a late usage update
then used to end the session as a grammar error (review live20). The session cumulative
(`session_ended.usage`) is the running sum of completed turns, and sums
keep what is known: a field one turn leaves null stays null for that
turn and never wipes what earlier turns reported (review live4) — no
field is ever guessed as zero. The derived `total_tokens` is the one
field a later turn can null: it is input + cached + output, so once a
folded turn leaves one of those parts unreported the cumulative total
is null rather than a sum that counts the gap as zero (review live15;
the per-part sums still keep what earlier turns reported). Cost is the one exception the wire
forces: the only carrier of a session cost (the claude-family result's
`total_cost_usd`) reports a session-lifetime figure every turn — each
report already includes the earlier ones — so the cumulative adopts the
latest figure instead of summing per-turn ones (review live8: summing
the zai-session-a fixture's four results reported $0.4447632 against
the harness's own $0.118512). Wires without a cost carrier (codex, agy)
report null and are unaffected. Resume changes nothing: there is no
in-process baseline to subtract, so `last` deltas count from the first
update the resumed process sees.

### 4.3 Capability flags (on `session_started`)

`live_input: bool`; `user_during_turn: "inject"|"queue"|false`; `steer: bool`;
`interrupt: bool`; `permissions: bool`; `deltas: bool`;
`file_changes: "native"|"derived"|false`; `usage_stream: bool`; `resume: bool`.
Claude-family reports `user_during_turn: false`: print mode folds a
mid-turn message into the running turn when that turn makes another model
request and runs it as its own turn when it does not (§3.1), so neither
`"inject"` nor `"queue"` describes it, and a mid-turn `user` line is
rejected `busy` (review live21). `"inject"` stays in the type for a future
verified harness, and no driver may report it without a recorded fixture.
Claude-family also reports `steer: false`: no carrier shapes the running
turn on demand, and advertising one would hand a caller an input the
harness never shapes (review live3); codex keeps `steer: true`
(`turn/steer`, §3.2).

`permissions` describes the mechanism, not the policy, and no autonomy level
is a promise of silence. Sessions carry their own version floors, at or above
the run-path contracts: claude-family **2.1.280** (the audited
`--permission-prompt-tool stdio` build — the run contract's 2.1.220 floor admits
pre-hardening builds where `--dangerously-skip-permissions` is honored and
the approved low→high resume would be an escalation), codex **0.159.3**
(the app-server method table, §3.2), agy 1.2.14 (equal to the run contract's
floor: the audited release, and no earlier one exists).
`CODEMUX_ALLOW_UNTESTED_HARNESS=1` overrides, as everywhere. In session
mode, claude-family high is emitted as `--permission-mode default` plus
the grant list — never
`--dangerously-skip-permissions` — so high's reach is set by
codemux's grants, not a harness side effect, and the resume ladder's
low→high move narrows reach on every build the floor admits. agy is the
one exception: it has no verified permission carrier at all
(`permissions: false`), so its session high reuses the run mapping's
bypass flag (`src/session/agy-session.ts`) — there is no answer path for
a ceiling to judge there, and agy sessions are sandbox-first. Codex gets
approval policy `never` at every level
but low (`untrusted`), set through the adapter's config override
(`-c approval_policy=…`), never `-a`: `exec` has no `-a` of its own and the
root `-a` cannot express `untrusted` (the ledger's 2026-10-03 correction),
and app-server carries the policy as JSON-RPC config (§4.7). No
launchable codex session reaches that low cell: the default sandboxed
shape passes the bypass flag at every level — the mapping is not
consulted when sandboxed (`src/adapters/codex.ts`) — and unsandboxed
codex is high-only (levels below high refuse to launch without scode,
`src/adapters/base.ts`), where the mapping yields `never` as well.
Approval requests surface in no codex session this design can launch;
`permissions: true` reports the mechanism, and the round-trip (§4.1,
§4.7) is dormant defense against harness or config drift. Claude-family
medium is
`acceptEdits` plus an Edit grant with Bash still gated
(`src/claude-autonomy.ts`) — not never-ask. The
`CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1` hardening force-resets claude's mode
to default on current builds. `run` has no permission host, so default
denies the tools that would prompt; a session runs
`--permission-prompt-tool stdio` (§4.7), and default asks the host instead — requests `run` would
auto-deny do surface here, split by build generation: Bash at medium
surfaces on hardened and pre-hardening (≤ 2.1.223) builds alike, while
at high every tool outside the grant list surfaces on hardened builds
only — pre-hardening builds honor the bypass flag and ask nothing at
high, so §4.1's high predicate is a hardened-build rule. Probe 5 ran and
pins the band 2.1.280 actually surfaces: safe read-only commands are
auto-allowed with no request, writes outside the allowed working
directories are auto-denied with no request, and the ask-worthy middle
(the probe's `sw_vers`) round-trips as a `can_use_tool` control_request;
whichever arrive, the ceiling (§4.1) is what holds the level — codemux
measures the requested action, never the harness's mode. The flag never
claims either way, and the broker reads policy from the autonomy field
plus the probe results, not from `permissions`.

### 4.4 Author labels

`user`/`steer` carry optional `author` (a Slack handle, a name). codemux
records it verbatim on the echoed events and, by default, prefixes the
harness-bound text with `[<author>] ` so attribution survives into the
transcript the harness persists — the broker's archive is not the only record.
`--no-author-prefix` disables the prefix. `author` is bounded to at most 64
code points and validated by allowlist: Unicode categories Cc, Cf, Zl, and
Zp are rejected (this covers NUL, ESC, NEL U+0085, bidi overrides such as
U+202E, and every Unicode line break including U+2028/U+2029), as are
`[`, `]`, and unpaired surrogates; a value outside those bounds is rejected
with `input_rejected` (reason `invalid_author`) before anything reaches the
harness — an author containing `]` or a line break could otherwise forge a
second attributed line (`x]\n[admin] approve …`) in the transcript. The
bounds close the `author` field only. `text` is arbitrary user content and
is not sanitized — pasted logs legitimately contain bracketed lines — so it
can carry a lookalike `[admin] …` line, and the prefix cannot make the
transcript an attribution ledger. The authoritative attribution is the
echoed event stream, which carries `author` as a field the caller's text
cannot touch; the transcript prefix is a display aid. Author is data, not
authentication: codemux does not check identities.

### 4.5 Flag integration

- `--resume <id>` starts the session resumed (claude `--resume`, codex
  `thread/resume`); default is a new session. codemux generates the UUID for
  claude-family (`--session-id`) and reports the codex thread id from
  `thread/started` in `session_started`. This is the flag the removed 0.6.0
  `--session` foreshadowed; the `--result-json` envelope's reserved
  `session_id` field stays null for `run` and starts carrying the id for
  session runs' final events. A resumed session re-derives its entire tool
  set and permission flags from the resume invocation's `--auto`: the
  spawn command is the fresh-start command plus the resume id, nothing
  more, so a grant the resume invocation did not specify cannot reach the
  harness (§4.7). The registry entry's `autonomy` is provenance for the
  resume guard (§4.8), never a source of grants. Resume ids are validated
  before they reach argv: claude-family ids as UUIDs (`-r` also accepts a
  search term, which must never be handed through), codex thread ids
  against `^[A-Za-z0-9_-]{8,128}$` (the step-0 fixture's thread ids are
  UUIDv7-shaped and fit; no tightening warranted); anything else is
  exit 64. The same patterns gate the ids a harness reports: a codex
  thread id (from `thread/started` or the `thread/start` response) or an
  agy `conversation_id` that `--resume` would refuse is a fatal grammar
  error, never adopted, so no record carries an id the registry reader
  rejects (review live16). The registry (§4.8) vouches for the id:
  unknown ids exit 66, refusals exit 78.
- `--pass-env CLAUDE_CONFIG_DIR` / `CODEX_HOME` choose the account exactly as
  in `run`, with the same absolute-path and padding validation. The resolved
  home is recorded in the registry (§4.8).
- scode: `session` defaults to sandboxed, autonomy mapping identical to `run`.
  `--sandbox-trust untrusted` is refused for a sandboxed session: it denies
  harness state, which a persistent session must write (transcripts,
  rollouts). With `--no-sandbox` the trust flag is ignored with a warning,
  as in `run`, and the session runs unsandboxed. scode wraps the
  long-lived harness process once, for the whole session — probe 6 confirms
  bidirectional stdio through scode before anything else is built on it.
- `--hermetic`: **refused on every session in v1** (exit 64). The verified
  canary covers the run path; a session rides stream-json input with
  persistence and resume, which no canary has exercised
  (`src/adapters/base.ts` refuses unverified mechanisms, and a session is
  one). The registry keeps the `hermetic` field and its match rule, so
  enabling sessions later is a canary plus one refusal, not a schema
  change.
- Provider overrides: **refused in this release** (exit 64, review
  live25). The session spawn does not run the adapter's override wiring
  (codex's private `CODEX_HOME`, claude's gateway variables), so a session
  started under one would reach the operator's own provider account. Any
  non-blank `CODEMUX_<AGENT>_PROVIDER_*` name for the session agent
  refuses, and the message names the variables. The next release wires
  the override into the session spawn through `readProviderOverride`.
- `--enable-playwright-mcp` (claude/zai, sandboxed): **requires `--auto
  low`** (exit 64 otherwise, review live25). The ceiling grants no
  `mcp__*` tool at medium or high, and read-only allows no tool use, so
  only low, where the caller answers each request, can use the server.
- `--effort none` is refused for codex sessions (exit 64, review live25):
  `turn/start`'s `effort` is the one verified carrier, and no audited
  `none` exists on it.
- A flag value one of `run`'s shared validators refuses (`--pass-env`,
  `--effort`, `--auto`, `--model`, `--cwd`) is usage, exit 64 (review
  live25: it used to exit 1).
- `--timeout <s>`: absolute cap on the whole session, default none (run's
  default does not carry over; sessions are hours long by design), bounded
  1..86400 like `run`. Expiry runs the shutdown path with `reason:
  timeout`.
- `--turn-timeout <s>`: per-turn cap; expiry interrupts the turn and the
  session continues — `turn_completed` reports the wire's verdict
  (`interrupted` with `reason: turn-timeout` when the interrupt struck;
  the turn's own `finish` when it completed while the interrupt was in
  flight). The timer re-arms after that interrupt: a turn still open one
  further period later ignored it, and the cap ends the session (a fatal
  `codemux` error, `reason: timeout`, exit 1; review live17 — the timer
  used to fire once, so a refused or ignored interrupt left the turn
  uncapped). The turn that ignored it is answered `finish: failed`, its
  reason naming that fatal (review live22: a synthesized completion is
  `interrupted` only on an end that raised no fatal). Default none. Refused at start (exit 64) for
  agents whose `interrupt` capability is false (agy) — there is no
  interrupt-and-continue to time out. No idle timeout — broker policy.
- `--permission-timeout <s>`: how long a pending `permission_request`
  waits for the caller's decision before codemux answers the harness deny
  (`permission_resolved: "timeout"`, §4.1). Default 300, bounded
  1..86400. This is Prompt B's configurable deny-on-timeout.
- `--shutdown-grace <s>`: how long the harness gets to answer the end
  (the end-interrupt, or agy's stdin close) before SIGTERM, and again to
  persist and exit after it before codemux kills the tree, default 10;
  the worst case is twice the value (review live17). One knob for every shutdown path — stdin
  close, `shutdown` input, signal, `--timeout` expiry (§4.6). The
  `shutdown` input carries no grace field of its own.

### 4.6 Lifecycle

One invariant spans every path below: the autonomy ceiling set by `--auto` at
start (§4.1) holds until the session ends. A permission answer that would
raise it is refused there — `input_rejected` with reason
`autonomy_escalation`, an out-of-bounds action answered deny — and codemux
widens nothing on its own either: the codex `turn/settings/update` method
(§3.2) is never used to raise approval levels. Resume takes its autonomy
from the new invocation's `--auto` and from nowhere else — grants live
only in the emitted flags (§4.7) — bounded by creation in reach: the
registry (§4.8) records the level and refuses a resume above it in the
reach order defined there.

- **stdin close (EOF):** graceful shutdown — interrupt the active turn, allow
  `--shutdown-grace` (default 10 s) for the harness to answer it before
  any signal, then SIGTERM and a second `--shutdown-grace` for the harness
  to persist and exit before the tree is killed; emit `session_ended`
  with `reason: stdin-close`, exit 0. agy has no interrupt: its stdin is
  closed instead (its input loop finishes the running line and exits),
  on every end path, and the first window waits for that exit (review
  live17 — the interrupt and the SIGTERM used to go out in one step, so a
  harness that dies on SIGTERM never answered, and agy never saw EOF). A
  read error on the caller's stdin runs the same path but is a failure:
  a fatal `codemux` error and exit 1 (review live17). A dead broker must not
  orphan a running agent; the session stays resumable. The grace window is
  also a drain: harness output arriving inside it — the end-interrupt's
  answer, the interrupted turn's completion, its usage — is parsed and
  emitted to the caller before `session_ended`, which stays the last event
  on the stream. A failure arriving inside the window is not absorbed by
  the end already in flight: cleanup stays idempotent, but the fatal (a
  tier-3 line, a codemux failure) surfaces its event and the exit code
  rises to 1 (review live7). The child's own exit is part of the verdict
  (review live9): a child that exits nonzero inside the window — a
  failure while persisting, whether or not a turn was open (review
  live17), and whether or not its turn's completion arrived first
  (review live18) — costs success (exit 1, a fatal `error` ahead of
  `session_ended`).
  Three cases keep the honest zero: exit code 1 after an `interrupted`
  completion the drain delivered, claude family only (it exits 1 after
  an interrupted turn by convention, step-0 probe 4; before review live18
  any delivered completion excused any code on every driver), a
  signal death (exit code null), the normal kill path for a harness that
  ignored the interrupt, and a wrapper answering the shutdown signal
  with exit code 143 — the coded spelling (128+SIGTERM) of the same
  signal death, which a scode-wrapped harness produces — which exempts
  itself exactly like the null (review live11); in every such shape —
  both signal spellings and the nonzero drain failure — the open turn is
  answered by synthesis, not left dangling (review live12).
- **`shutdown` input:** same path, `reason: shutdown`.
- **SIGTERM/SIGINT:** same path, then exit 143 (the process runner's
  convention).
- **Harness crash:** `error` (fatal) + `session_ended` with `reason: crash`
  and the child's exit code; codemux exits 1. The crash is the one story
  told: the verdict above does not add a second, false "during the
  shutdown drain" fatal for the same exit, and a turn the crash left open
  is answered by synthesis — `finish: failed`, the crash as the reason —
  instead of dangling (review live11). Since review live17 that reason
  is the fatal that ended the session, which is not always the harness
  dying (an outbound overflow, a registry failure). Whatever the harness
  managed to persist remains resumable, reported best-effort in
  `resumable`.
- **Pending requests on every end path:** `interrupt`, `--turn-timeout`
  expiry, stdin close, `shutdown`, signal, and `--timeout` all answer every
  pending `permission_request` deny first (`permission_resolved:
  "superseded"`), then run the shutdown path. A request arriving inside
  the drain window is denied the same way at once (review live8) — it
  can never be decided there, and the harness is still waiting on it.
- **Open turn on every end path:** the interrupt-capable drivers close an
  open turn through the end-interrupt's drained result, and agy through
  the result its input loop delivers after the stdin close; each gets the
  first grace window before any signal (review live17). When nothing can
  answer it — a harness that ignores the interrupt or the stdin close; a
  signal death or a 143 wrapper never delivers the answer; a crash takes the
  harness mid-turn; the child exits nonzero during the drain with no
  completion delivered — the driver synthesizes the `turn_completed`
  instead: `finish: interrupted` with a reason naming the session end on
  an orderly end, `finish: failed` with the fatal that ended the session
  or the drain failure as the reason on a crash or a nonzero drain exit,
  all-null usage unless the turn already reported some (codex streams
  per-turn usage; that known usage is carried and folds into
  `session_ended.usage`, review live22),
  `raw: null`, for every still-open unanswered turn — the failure verdict
  and the synthesis used to be mutually exclusive, so the one exit class
  the verdict reported was the one class the synthesis refused to answer
  (review live12; live11 generalized live10's agy-only rule to every
  driver and both finishes).
  Every `turn_started` is
  answered on every path (review live10); a fresh agy session whose first
  turn never completed still reports `resumable: false`, because no
  vouchable conversation id ever existed to resume.
- **Signal handling:** SIGTERM/SIGINT run the shutdown path to completion —
  no `process.exit` inside the handler — and the process exits 143 at the
  end of it. The signal gate stays installed until cleanup completes: a
  second SIGTERM/SIGINT during the grace window hits the gate's fire-once
  latch, never the default disposition that would kill codemux mid-kill
  and leave the tree it was stopping alive. The harness process tree,
  descendants included, is killed unconditionally after the grace period
  on every end path (`src/process-tree.ts`).
- **A mid-session harness auth failure** (rotated credential, stale
  credential mirror) is a session-ending `error` with `resumable` reported
  best-effort; there is no in-session refresh hook in v1.
- **Exit codes:** 0 clean end; 1 harness crash, codemux failure,
  harness-side resume failure (exit 66 is the registry lookup only; a
  harness-level resume failure is exit 1 with the raw event attached, and
  codemux never scans harness stderr text), or `--timeout` expiry — the
  configured shutdown-path end (§4.5), whose `session_ended` carries
  `reason: "timeout"`, the one thing that distinguishes it from a failure
  at this code, or a registry codemux could not reach (a lock held past
  its budget, an I/O error: nothing was judged and a retry may pass —
  review live22; it used to share 78 with the policy refusals); 64
  usage/validation (nothing
  started); 66 unknown `--resume` id; 78 policy refusal (cross-agent
  resume, cross-home resume, hermetic conflict, live owner, untrusted
  registry — §4.8); 143 signal.

### 4.7 Per-harness wiring

**claude/zai** spawn (print mode):

```
claude -p --input-format stream-json --output-format stream-json \
  --include-partial-messages --verbose \
  --permission-prompt-tool stdio \
  --replay-user-messages \
  (--session-id <codemux-uuid> | --resume <id>) \
  …run's flags (model, autonomy, effort, setting-sources, strict-mcp —
  but not add-dir: the session surface exposes no --add-dir)
```

`--verbose`, `--include-partial-messages`, and `--replay-user-messages`
are all unconditional — probe 1 confirmed 2.1.280 still refuses
stream-json output in print mode without `--verbose`, partial messages
are the `deltas` carrier every launch wants, and replay is the
multi-message-stdin acknowledgment companion §3.1 documents (the flag
exists to re-emit stdin messages on stdout); no flag can omit any of
them. Notably **without**
`--no-session-persistence` — that flag is `run`'s
statelessness, wrong here. Parsers handle the seven stream-json types; the
control-response writer keys every reply by `request_id` and enforces the
ceiling on each one: `--permission-prompt-tool stdio` is what turns `run`'s
auto-denials into questions (§4.3), so every `allow` is checked against
the tool and the arguments that will actually run, `updated_input` merged
in (§4.1), before it is written, and codemux writes the deny itself when
the check fails. The flag order in the block above is load-bearing: the
resume id comes first and the autonomy-derived flags after it,
unconditionally, on every launch — fresh or resumed — with the live
invocation's `--auto` as their only input. A session created at high and
resumed at read-only emits exactly read-only's flags; inheriting a
broader grant from the created session is impossible by construction, and
the plan pins it twice — a command-line assert, and a behavioral test
(created-high resumed read-only enforces read-only's ceiling in the
fixture-driven fake; the step-0 live probes did not run this scenario, so
the fake is the pinned evidence and the first live session re-verifies
it). The behavioral test landed in review live20 ("a session created at
high and resumed read-only enforces read-only's ceiling",
`tests/session-e2e.test.ts`): it claims the resume, spawns the fake with
the real resume argv, and checks that an `allow` for Bash is refused
`autonomy_escalation` and answered deny on the wire.

**codex** spawns one dedicated `codex app-server` per session (never the
shared daemon — a singleton escapes per-session sandbox and account
boundaries), runs the `initialize` handshake, then `thread/start` (or
`thread/resume`) and `turn/start` per user message, translating
notifications to §4.2 events with `raw` carried verbatim. On
`thread/resume` the session is announced from the response itself — its
`thread.id` echoes the requested id, and a response naming a different
thread fails closed: one fatal naming both ids, a crash end, no
announcement — codemux must never record and announce the requested id
while the harness runs another thread, the id every later turn/start and
steer would target (review live12) — because the pinned 0.159.3 server
sends no `thread/started` on resume (live-proven, review live11; the
fresh `thread/start` path still waits for the notification, which the
recorded fixture proves follows), so `session_started` is
codemux-originated (`raw: null`) there; a `thread/started` landing on an
already-started session — a server that announces anyway — is tier-1
`unknown` passthrough when it is the session's first and names the
adopted thread, and a tier-2 fatal otherwise (a second one, or one
naming another thread), the exactly-once rule below (review live19).
One rule for the
sandbox and approval parameters, on every thread start, `thread/resume`
included, and every turn start: they are always explicit, and a
scode-wrapped session carries the bypass pair `run` passes as
`--dangerously-bypass-approvals-and-sandbox` — sandbox `danger-full-access`,
approval policy `never` — at every level, scode remaining the enforced
boundary; the `--auto` mapping pair (`src/adapters/codex.ts`) applies to
the unsandboxed high-only shape, where it resolves to the same pair
anyway. app-server's fallback to the user's `config.toml` is therefore
never the source of sandbox or approval behavior — an unsandboxed
`--auto high` session silently inheriting a configured `sandbox_mode` or
`approval_policy` is the leak this closes, in either direction (a
leftover `untrusted` policy resurrecting prompts the mapping calls
`never`; a configured `read-only` sandbox denying writes the level
grants) — and a grammar test pins that every start carries both
parameters in the shape its launch takes (`thread/resume` by exact
params since review live20; it used to check only the thread id and
model). The effort override rides the
one verified carrier it has (`turn/start`'s `effort`) `[OSS]`. The
thread-level `config` object carries only the project-doc overrides
(`project_doc_max_bytes: 0`, empty fallback filenames) that skip
AGENTS.md discovery `[OSS]` — it is **not** the app-server equivalent of
run's `--ignore-rules`: execpolicy rules (`~/.codex/rules`) have no
verified carrier, so a codex session still loads them where a run does
not (the parity gap is recorded in the compatibility ledger; review
live3). No `--tools` value has a verified
carrier on codex either, so codex sessions refuse `--tools` outright
(exit 64) rather than guess one — the same blanket refusal as every
other agent.

A user message arriving while a codex turn runs is accepted and queued in
a codemux-side per-session FIFO; `turn/start` is issued from the queue on
`turn/completed` (`user_during_turn: "queue"`). The caller-facing
`turn_started` is emitted at submit, immediately after the FSM opens the
turn — claude-family style, `raw: null` — so every completion path
answers a start the caller actually saw; the harness's own `turn/started`
notification mirrors as tier-1 `unknown`, like every other harness echo
of something codemux already announced (review live15). codemux sends only
`initialize`, `notifications/initialized`, `thread/start`,
`thread/resume`, `turn/start`, `turn/steer`, `turn/interrupt` — never
`fs/*`, `remoteControl/*`, `thread/realtime/*`, `thread/queue/*`,
`turn/settings/update`, `command/*`, or `process/*` — pinned by a grammar
test, and never a caller-controlled `config` object. Every server→client
request codemux does not implement is answered immediately with a
JSON-RPC error response, mirrored raw as an `unknown` event, and reported
by a non-fatal `error` event (whose own `raw` is null, as on every
codemux-originated event); the approval requests it does implement are answered with the
verified result payloads (`{decision: "accept"|"decline"}`, §3.2) under
the same ceiling as claude-family (§4.1), an unparsable one answered
`decline`. The method table in §3.2 is pinned at 0.159.3 in the
compatibility ledger once the fixtures confirm it.

**The session runner is a peer spawn path, not a detour through
`runCapturedCommand`** (which writes stdin once and closes it, caps
capture at 16 MiB, and force-kills 2 s after a signal — all wrong for a
hours-long stream). It reuses, verbatim, the seams that make "codemux
executes only what it validated" true: `assertNoProjectScodePolicy`,
`resolveScodeExecutable`/`assertCompatibleScode`,
`resolveTrustedCommand`, `buildScodeCommand`/`buildSandboxEnv`,
`buildExecutionEnv`/`sanitizeEnvironment`, `beforeLaunch`,
`prepareSandbox`, and `assertHarnessSupported` at the session floors.
All live state — child handle, FSM, pending-request set, seq counters,
registry handle — lives in a launcher-owned `SessionContext`; adapters
are singletons and gain nothing (session command builders are pure
functions in `src/session/`). A parity test asserts the session child's
scode argv prefix and environment match `run`'s for the same request.
`run`'s own path is untouched.

### 4.8 The session registry — resume's sound home

A JSON registry, one entry per session, at a codemux-owned path outside
harness state — macOS `~/Library/Application Support/codemux/
live-sessions.json`, Linux `$HOME/.local/state/codemux/live-sessions.json`
(derived from `$HOME` alone; `$XDG_STATE_HOME` is deliberately ignored —
round 19 finding 8: moving the variable would hide the record while the
transcripts stay put). codemux creates the directory (mode 0700)
and the file (mode 0600) and owns both; the path is never derived from
`--cwd`, `CLAUDE_CONFIG_DIR`, or `CODEX_HOME`:

```json
{"id": "…", "agent": "claude", "created_at": "…", "last_activity": "…",
 "cwd": "…", "hermetic": false, "harness_home": "/Users/x/.claude",
 "model": "opus", "autonomy": "low", "sandboxed": true,
 "sandbox_trust": "standard", "sandbox_no_net": false,
 "sandbox_scrub_env": false, "pass_env": ["GITHUB_TOKEN"],
 "playwright_mcp": false, "provider_base_url": null, "owner_pid": 1234,
 "owner_start": "Mon Oct  5 09:41:02 2026", "ended": null}
```

Written at `session_started` (not at success — the session exists once the
harness ack'd an id; that was the record-on-success race) and updated at
`session_ended`. Before any caller input can reach a harness, where the
id allows it (review live22): a claude-family session, fresh or
resumed, is recorded before the spawn, because codemux chooses or the
claim vouches for its id and its init frame
arrives only after the caller's first input; codex records at the
thread handshake, before any turn; a fresh agy session, whose id only
its first result names, cannot be recorded before that turn, so the CLI
first runs the same locked write with nothing changed and refuses the
session (exit 1, nothing spawned) when it fails. The residual is a
registry that turns unwritable between that check and the first
result; the session then fails closed as before. Atomic write via rename, with the directory revalidated
between temp-write and rename, and every write validated first with the
reader's own rules: an update that would leave a file the reader
rejects is refused and nothing is written (review live16). The temp file
is flushed (`fsync`) before the rename and removed on any failure, and
the writer applies the reader's placement rules to the caller's own
spelling, so a symlinked registry directory is refused at start as it
is at resume (review live18). The live owner is `owner_pid` plus
`owner_start` (the opaque process-start token `src/process-table.ts`
already uses as its identity check — a pid-only check is fooled by pid
reuse; where the process table is unreadable the check degrades to a
signal-0 probe, where only `ESRCH` means dead — `EPERM` is a live
process the probe may not signal (review live16) — and the pid-reuse
window is the accepted residual):
resuming a session whose owner is alive is refused with exit 78
(`session_busy`). The resume claims ownership before the spawn (review
live19): the CLI's first lookup reads without the lock, so a second,
locked pass re-runs every guard and stamps this process as the owner
before the harness starts. Without it, two concurrent claude-family
resumes both spawned and forwarded the caller's first input, and the
loser learned it had lost only at the init frame, after its harness had
acted on that input. The driver adopts the claim, so every end path
stamps `ended` on every end path, and the CLI releases the claim itself
when the spawn throws (review live20 — a claude resume that ended before
its init frame left the claim open), reporting a lost release on stderr
like the drivers (review live21). `resumable` means the harness confirmed
the session — the claude init frame, the codex `thread/resume` response,
a result naming the agy conversation — and the registry holds this
process's record of it (an agy start whose record failed is not
resumable: `--resume` would exit 66; review live22). A fresh
claude-family record written before the spawn that the harness never
confirmed is removed at the end, since no transcript stands behind it
and a later `--resume` should be the registry's 66, not a harness
refusal. A claude-family resume also writes its record before the
spawn, right after the claim, so the flags it runs under are recorded
before any turn. For a claimed resume the harness never confirmed,
`resumable` means that the end did not fail (exit 0): a resume the harness
refused (a transcript Claude Code already cleaned up) ends on the crash
path or fails the drain, and one that hung until `--timeout`
proved nothing either, so both report `resumable: false`, while one that ended
cleanly before its first turn reports `true` (reviews live20 and
live21). Claude answers that refused resume with one `result` and no
init frame before it (subtype `error_during_execution`, the reason in
`errors`), then exits 1 (live21 probe): the driver mirrors the result
raw and ends with a fatal that names the refused resume. The start write
recognizes the claim by pid alone, since no other live process can hold
this one's pid, so a start token that one of the two `ps` readings
missed cannot refuse the session's own claim as `session_busy`. A resumed claude session continues under the same
`session_id` and the registry keeps one entry, updated in place. Pruning
(1000 entries and 4 MiB, the reader's two caps, by `last_activity`;
review live18 added the byte cap) never evicts an entry whose owner is
live while an evictable entry remains; facing an all-live overflow it
evicts the oldest anyway, because a file the writer's own validator
rejects is the worse loss — every resume fails closed and the next start
resets the registry, live records included (review live13). Concurrent
writers serialize through an `O_EXCL` lockfile holding
pid + start time, stolen only when that process is dead — staleness is
liveness, not age. The lock file's name is never reused (review live9):
each acquisition creates `.<lock>.<pid>.<salt>.held` and that
unique name is itself the lock, so a steal unlinks the exact file whose
payload was verified dead. Two writers racing on one corpse cannot both
win: the loser's unlink meets ENOENT or its confirmation rescan finds the
winner's live file, and it releases and retries with jitter. The writer
lock is seconds-scoped, per write, and the wait is a synchronous
`Atomics.wait` — so the turn-path activity stamp takes a single-attempt
lock that never waits (one sweep, fail fast, the failure reported once on
stderr), while the load-bearing start and end writes keep the full
budget at the session boundaries where a wait delays only the boundary
(review live13); session
ownership is entry fields, session-scoped — separate mechanisms, tested
separately. The file is lstat-checked on every open: regular file, owned
by the invoking user, mode 0600, never a symlink; the registry's own
directory must not be a symlink either, must be owned by the invoking
user, and must not be group- or other-writable. Symlinked ancestors
above the registry's own directory are resolved, not refused: the path
is real-path'd on its deepest existing ancestor (macOS
`/var -> /private/var` and automounted homes are the normal case for a
real `$HOME`, not tamper), and every registry operation — read, lock,
atomic write, corrupt backup — runs on the resolved path, so a later
re-link of the friendly spelling cannot redirect the open. These
mechanics encode round 19's findings rather than re-learning them.

**What the registry is trusted for.** A lookup hint and a cross-agent
guard — not an authorization boundary. The hint: the id → agent, home,
cwd map that lets `--resume` find the session and name its errors. The
guard: the refusal rules below, which stop the accidental classes —
round 17's cross-agent replay, an account hop, a containment drop, a
resume above creation's reach. The boundary it is not: the registry is
one file, and any process running as the user can write it. Tampering is
not scoped to a session's own entry: an unsandboxed session, a
`--no-sandbox --auto high` run (the README's documented opt-out), or any
ordinary user process can rewrite every entry in the file — raise a
sandboxed session's recorded `autonomy` from `read-only` to `high`,
loosen its `sandbox_trust` — and the owner, mode, and placement checks
of rule 3 below pass the forgery, because the file is still user-owned,
still 0600, still at its default path. What bounds tampering is
re-derivation, not the file: every security-relevant value of the
resumed process — tool grants, autonomy flags, sandbox and trust,
hermetic behavior — comes from the resume command alone (§4.5–§4.7; the
spawn is the fresh-start command plus the resume id), and the record
contributes no flag, no env, and no path to the harness. A forged
entry's whole effect is a skipped refusal: the resumed session runs with
exactly the flags the resuming operator chose, and an operator can
choose those flags for a fresh session anyway — a process already
running as the user needs no registry to get them. The guards therefore
hold against accident and confusion, as strong as the account's own
integrity, and not against the account itself. A per-entry MAC keyed by
a secret outside every writable set was considered and declined: a key
the same-user codemux process can read, a same-user attacker can read
too, so it adds key management without moving the boundary. The residual
is named in §9, not papered over.

Within that frame the placement rules still do real work: they make the
guards hold against the sandboxed session child, the one writer codemux
can exclude by placement. Three rules:

1. Outside the child's writable roots by placement: the default path is
   under neither harness home (`CLAUDE_CONFIG_DIR`, `CODEX_HOME` —
   writable by the child under every scode preset except `untrusted`) nor
   anything derived from the session's own flags.
2. Placement alone cannot promise exclusion — `--cwd ~` (a case the
   HERMETIC table already treats specially) puts every `~`-relative path
   inside the workspace, and claude-family medium's Edit grant is
   `Edit(//<cwd>/**)`. So at start codemux resolves the registry path
   against the writable set codemux can actually compute — the cwd and
   the harness home; sessions expose no `--add-dir`, so those two are
   the whole union — and refuses the session (exit 64,
   nothing started) when the registry falls inside it. A resume is
   judged by the registry first, so rule 3's containment refusal answers
   it with 78 like every other resume guard (review live23). On the default
   paths this refuses every `--cwd ~` session; a root cwd (`--cwd /`)
   contains every path and is refused the same way (review live7). This is the union codemux
   constructs, not scode's full writable preset (codemux hands scode only
   `-C`, `--trust`, `--ro|--rw`, `--no-net`, `--scrub-env`; the deny
   rules are scode's presets and not enumerable from here), so the check
   is what it can prove, and step 0 additionally runs a free in-sandbox
   write probe against the registry directory, recording in §3 the fact
   it measures. Low and high sandboxed children — and any unsandboxed
   process — remain registry writers, bounded by the same
   re-derivation residual this section already accepts; a cwd-resident
   symlink escaping the workspace (round 3's class) is inside that
   residual too. A deny-rule carve-out from the Edit grant was considered
   and rejected: it leans on harness-version deny semantics, while
   refusal is enforced in codemux alone.
3. At resume the file is re-checked: not owned by the invoking user,
   group- or other-writable, a symlink, or sitting inside the resumed
   entry's own recorded `cwd` or `harness_home` — any registry the child
   could have altered — is untrusted, and the failure policy below then
   applies to every resume from it. A symlinked leaf redirecting the
   open is the same class: the registry's own directory and the file are
   lstat-checked on the original spelling, and the ancestor walk runs on
   the resolved chain — symlinked system ancestors above the leaf are
   resolved away (resolving is what pins the open to the real
   directory), while anything that survives resolution is still refused. A forged entry written from inside the writable
   area is exactly the containment bypass this rule exists to stop; this
   is the README's `--sandbox-account` rule (records inside the writable
   area are forgeable) applied to codemux's own record.

Rule 3 catches the sandboxed child that could have written the file; it
cannot catch the unsandboxed sibling that wrote it anyway. That asymmetry
is the round-4 finding, and it is why the rules below are refusals whose
strength is the account's integrity — never grants.

Resume rules, each a refusal with exit 78 (or 66 for a missing entry):

- the registry entry must exist and match the id;
- `agent` must match the resuming agent — this closes round 17's replay
  hazard even on the shared claude/zai home, because the check is by agent,
  not by path;
- `harness_home` must match the currently resolved home — a session may not
  hop accounts;
- the provider identity must match (review D3): the record carries the
  override base URL the session ran under, or operator login when none,
  and a resume under anything else is refused — the recorded home does
  not move with the endpoint for claude, opencode, or aider, so this is
  the rule that keeps a transcript recorded on one endpoint from
  replaying on another, or on the operator's own login, or the reverse.
  The identity is the base URL's IDENTITY form — query and fragment
  stripped (review D10): a gateway key can ride the query, the recorded
  value goes to disk and into refusal messages, and a rotated key must
  not fork the identity a resume compares;
- containment may not drop below creation (`sandboxed`, `sandbox_trust`,
  `sandbox_no_net`, `sandbox_scrub_env`): a session created under scode
  resumes under scode, never at a higher trust than it was created with,
  and never without a network or environment boundary it was created
  under (the flags are judged as the resume effectively runs — resolved
  options, not raw argv, since `--sandbox-no-net` without `--sandbox` is
  a warned-and-ignored bit);
- the resume adds no other reach (review live16): `cwd` must match the
  recorded one exactly (both canonical), and the resume may not add a
  `--pass-env` name (`pass_env` records the sorted names, never values)
  or turn on `--enable-playwright-mcp` (`playwright_mcp`) — dropping
  either only narrows. A resumed transcript may carry injected content,
  so it may not gain another tree, a secret, or a browser;
- the resuming `--auto` may not exceed the recorded `autonomy`, ranked by
  reach — what a session can be made to do, not how much it asks — and
  the ranking is per agent (review live9). For claude, zai, and codex:
  `read-only < medium < high < low`, under the ceiling predicates §4.1
  defines (the hardened-build rules). High out-reaches medium: high grants
  the editing tools unscoped and adds Bash, while medium gates Bash and
  scopes edits to the launch directory. Low out-reaches high because a
  low session's caller can approve anything (Bash, MCP, WebFetch) while
  high's ceiling denies every tool outside the grant list whatever the
  caller answers — the round-5 correction: round 3's `low = high` tie
  defended only the low→high direction, and its reverse let a
  high-created session resume at low and gain approvals creation denied;
  on pre-hardening builds, where the bypass flag is honored and the two
  levels really do tie, the ladder's refusal is the safe direction. Low
  out-reaches medium the same way (medium denies Bash, MCP, and WebFetch
  whatever the caller answers) — the round-3 finding: the first draft's
  `low < medium` let a medium-created session resume at low and gain Bash
  approvals. (`run`'s low denies all of these headless, so the escalation
  exists only on the session path; codex fits the same order — low's
  `untrusted` policy makes surfaced requests approve-able, every other
  level's `never` approves nothing, §4.3.) For agy the ladder is strict —
  `read-only < low < medium < high`: agy has no permission channel
  (`permissions: false`, every `permission_decision` rejected), so low's
  caller approves nothing and passes no mode flag — low is the least
  reach, not the most, and the claude order would let a low-created agy
  session resume at high's `--dangerously-skip-permissions` (review
  live9). An agent without a ranking is ranked strict too — the
  conservative reading for a name a future release may add. The
  transcript is the reason
  for the guard: it can carry prompt-injected content, and resuming it
  with more reach than creation allowed lets that content act with rights
  creation never granted. The resume grant itself comes only from the
  resume invocation's flags (§4.5–§4.7); the record bounds, it never
  widens. Low-created → high is permitted on the claude-family ladder —
  the one downward move this design calls out: high's ceiling denies what
  low's caller could approve, so the
  resume narrows reach, trading low's per-request human gate for the
  grant list. That downward permission is a deliberate call, flagged in
  §9. The `hermetic` check below is the same provenance rule for
  clean-context runs; these are its sandbox and autonomy twins — the
  record carries what the session was contained by, not just how it was
  created.
- the `hermetic` flag must match creation (question 1: the record carries
  provenance instead of assuming it; safe→non-safe would load operator
  context into a transcript believed clean, non-safe→safe would mislabel one).

**Failure policy — recommended fail-closed:** an unreadable or corrupt
registry refuses `--resume` (error names the path; the corrupt file is backed
up beside the registry and a fresh one started on the next new session). This
deliberately departs from round 17's fail-open verdict for the run-time
ownership check: that guard protected a low-stakes read, while a resume
silently skipping the cross-agent check is exactly the replay incident class.
Flagged for Laurent in §9 (open calls).

**Codex + hermetic (question 2):** refused, as §4.5 says. Non-hermetic codex
sessions resume via `thread/resume` against the real `CODEX_HOME`. If
hermetic codex sessions are ever wanted, the registry would own a persistent
per-session home — deferred, not designed here.

## 5. What stays out of codemux

Multi-user identity and authorization (`author` is a label, not an auth
check); request queueing and turn scheduling across users (codemux's
per-session FIFO is transport ordering, not fairness); archiving (the
broker persists the event stream it already receives — a codemux-side
`--event-log` tee was considered and dropped: it would be protected state
a sandboxed child could forge or read, duplicating the broker for no
gain); Slack/web frontends; a session-listing API (the registry is an
internal lookup hint and guard, not a product); retries and multi-session
orchestration; attaching to an already-running session (reconnect =
resume after shutdown).

## 6. Risks

Ordered by expected pain:

1. **Claude stream-json wire shapes are inferred from strings + help, not
   exercised.** The type union and semantics are well-evidenced; the exact
   control-request JSON and the init message's session id are not. Mitigation:
   step 1 builds against a fake harness and spends a handful of live probes
   before anything else depends on the shapes.
2. **Codex app-server is experimental and unversioned.** Methods can churn
   across releases. Mitigation: pin at 0.159.3 in the ledger, grammar tests in
   the exec-parser style, and a loud parser failure on unknown shapes rather
   than a quiet drop.
3. **scode stdio for long-lived bidirectional streams.** `run` forwards stdin
   once; `session` needs a persistent pipe both ways through the sandbox
   wrapper. Probe 6 exists to kill this risk first.
4. **app-server daemon attachment.** If the dedicated app-server silently
   attaches to a user-level daemon, sandbox and account isolation are theater.
   Probes 8–9 (scratch `CODEX_HOME`, assert sessions land there; assert no
   daemon attachment).
5. **Mid-turn semantics differ per harness** (inject vs. queue). Handled by
   `user_during_turn` rather than papered over; claude-family print mode
   does both, by the running turn's shape, so it reports `false` (§3.1).
6. **Resume across harness upgrades** — transcript/rollout formats churn.
   Reported honestly via `resumable` and a non-fatal `error` when a resume
   launch fails at the harness level.

## 7. Implementation plan (Prompt B) — amended after the panel review

Steps are risk-ordered; each is one reviewable commit ending green on the
full gate (`bun run typecheck`, `bun test --max-concurrency=1`,
`make release-gate`) before the next begins, with the tests and fixtures
named. Every step records its intended commit in
`docs/live-sessions-report.md`. The amendments versus the approved §7:
probes and fixtures come first (step 0), the old step 1 is split three
ways (runner, protocol, ceiling), the registry lands before any driver can
reach `--resume`, and the drivers are one commit each. The panels' shared
finding — a working unguarded `--resume` shipping two steps before its
guards, and parsers built against invented shapes — is what the order
exists to prevent.

**Step 0 — evidence first.** `usagemux snapshot` before anything paid.
Free probes: the scode bidirectional-stdio relay (the risk §6 item 3 says
to kill first — an echo/relay loop under scode, zero quota); the
registry-directory write probe under `scode --rw` (§4.8 rule 2); version
and help surfaces. Paid probes (budget ≈ 8 small claude requests, ≈ 4
codex, ≈ 2 agy; stop on any client under 10%): (1) stream-json output
without `--verbose`; (2) the init `system` message — session id, tools
list; (3) mid-turn message delivery; (4) the interrupt control-request
shape; (5) a permission round-trip at `--auto low`; (6) one scode-wrapped
session end to end (if the implementing sandbox refuses scode nesting,
record it and keep the risk flagged); (7) shutdown and `--resume`; (8) a
codex app-server `initialize → thread/start → turn/start → item/* →
turn/completed` exchange with `CODEX_HOME` relocated and daemon isolation
checked, `thread/tokenUsage/updated` shapes included; (9) a second codex
turn to pin `total` vs `last`; (10) an agy two-turn NDJSON exchange and
`--conversation`. All paid probes run through `./bin/codemux --no-sandbox
--auto high` (scode cannot nest in the implementing sandbox). Sanitized
fixtures are recorded under `tests/fixtures/live/`, §3 above is amended
with what they confirm, and the fake harnesses later steps test against
are generated from them so they cannot drift from reality. Probes that
cannot run are recorded as not-run; their `[verify]` tags stay open and
the parsers still fail closed.

**Step 1 — streaming session process runner** (`src/session/process.ts`).
Process group; line framing in both directions with §4.2's caps (16 MiB
harness line, 17 MiB input line, resync on overflow); fatal-strict UTF-8;
the bounded outbound queue; descendant capture and unconditional tree
kill after the grace period on every end path (§4.6); signal handling
that runs the shutdown path and exits 143 at its end. Tests against a
fake child: line caps, invalid UTF-8, a partial last line, a stopped
reader (backpressure overflow), SIGTERM mid-stream, descendant cleanup.

**Step 2 — protocol core** (`src/session/protocol.ts`,
`src/session/fsm.ts`). Input validation (types, the §4.4 author
allowlist, text bounds, NUL), `input_seq` acks, the capability-false
rejections (§4.1), the output envelope (`seq`, `ts`, `session_id`,
`type`, `raw` as string), the FSM (starting → idle ⇄ turn_active →
shutting_down → ended; pending requests as a set), and §4.2's three-tier
unknown/malformed rule. Unit tests for every edge.

**Step 3 — autonomy ceiling** (`src/session/ceiling.ts`). The tool ×
level table (§4.1) with default deny for unknown tools; `grantRule` reuse
and path canonicalization; the `updated_input` merge rules; the codex
command/patch predicates; opaque arguments denied. Pure and
table-driven. Exhaustive unit tests — every §4.1 case, plus the
table-vs-init-`tools`-fixture diff.

**Step 4 — session registry** (`src/session/registry.ts`). Everything in
§4.8 as amended: the HOME-derived Linux path, creation modes, the symlink
and ancestor checks, atomic replacement with directory revalidation, the
writer lock (pid + start time, staleness by liveness), the live owner and
`session_busy`, pruning that spares live owners (all-live overflow
excepted, review live13), the 1000-entry bound,
fail-closed corrupt handling with backup. `--resume` is still refused
everywhere (§4.5). Tests: every refusal rule; concurrent writers; crash
recovery mid-replacement; the byte bound; registration-write failure
(refuses the session, nothing started); pruning vs live owners; tamper
cases (round 4's cross-entry rewrite pinned to the re-derivation claim);
placement refusals.

**Step 5 — claude session driver + the `codemux session` CLI**
(`src/session/claude-session.ts`, `src/session/cli.ts`, index wiring).
`buildClaudeSessionCommand` — fresh and resume shapes; resume id first,
autonomy flags unconditional on every launch; no
`--no-session-persistence`; `--permission-prompt-tool stdio`,
`--replay-user-messages`, `--verbose`, `--include-partial-messages`; session high is
`--permission-mode default` plus the grant list, never the bypass flag;
the session floor (2.1.280) via `assertHarnessSupported`. Parsers for the
seven stream-json types under the three tiers, with the §4.2 id checks.
The control-response writer (strict schema, §4.1) enforcing the ceiling.
Permission timeouts. Usage per §4.2. The author prefix per §4.4. The CLI
takes `run`'s flags plus the session-only ones, builds a
`SessionRequest`, reuses every §4.7 seam, and keeps all state in the
launcher-owned `SessionContext`; a parity test asserts the child's scode
argv prefix and environment match `run`'s for the same request. e2e tests
against the fixture-generated fake harness: full lifecycle, steering,
interrupt, permission allow/deny/timeout and `updated_input` in both
directions, the EOF/shutdown/signal paths, the resume command-line and
behavioral asserts (created-high resumed read-only emits exactly
read-only's flags and enforces read-only's ceiling), the session-floor
refusal, and `--resume` still failing closed. Capability flags ship on
`session_started` from this step. Registry integration: record at start,
update at end, live owner.

**Step 6 — codex app-server driver** (`src/session/codex-session.ts`).
The hand-rolled JSON-RPC client over the step-1 runner (no new
dependencies); the `initialize` handshake; `thread/start`/`thread/resume`
with explicit `sandbox`/`approvalPolicy`/`config`/`model`, `turn/start`
with `sandboxPolicy` where the shape requires it — the bypass pair on
scode-wrapped sessions (§4.7) — on every start, resume included; the FIFO
queue; `turn/steer`, `turn/interrupt`; notification translation with
`raw`; approval round-trips under the same ceiling (dormant in
production, fake-driven in tests); unknown server requests answered with
errors; the outgoing method allowlist; id validation; usage per §4.2;
`--tools none` and `--hermetic` refused. Tests: a fake app-server
generated from the fixtures; grammar tests for the notification set and
ordering; malformed-JSON robustness (including openclaw's raw-newline
quirk: fragments of an unterminated string are rejoined before parsing,
bounded); approval timeouts; the ceiling on approval responses; the
parameter grammar on every thread and turn start.

**Step 7 — zai driver** (`src/session/zai-session.ts`, reusing the
claude-family path). The shared-home guard via the registry's agent
match; `beforeLaunch`'s API-key check; the same floor and parser.
Tests: the shared-home cross-agent refusal; the capability matrix pinned.

**Step 8 — agy driver** (`src/session/agy-session.ts`). The NDJSON input
loop (`--input-format stream-json --output-format stream-json`,
`--conversation <id>` resume), honest `false` flags (`steer`,
`interrupt`, `user_during_turn`, `permissions`, `deltas`),
`--turn-timeout` refused (§4.5), output parsed under the same tiers.
Tests: a fake agy from the fixtures; a two-turn exchange; resume; the
capability matrix.

**Step 9 — docs and contracts.** README sessions section;
`docs/HARNESS-COMPATIBILITY.md` — the capability table, the app-server
method table pinned at 0.159.3, the claude stream-json contract at
2.1.280; `docs/HERMETIC.md` "Session persistence" rewritten around the
registry and the refused-until-canary hermetic sessions; CHANGELOG under
`[Unreleased]`. Optional if budget remains: a `codemux check`
live-session probe.

No feature flag: the pre-commit review gate plus the step gates carry it,
the way the repo ships everything else.

## 8. Evidence and experiments

**Paid harness requests: 0.** Nothing ran through `codemux run` (or any
harness); no provider quota was spent.

Free probes, all through permitted surfaces: `usagemux snapshot` (quota check
before anything else); `claude --help` (several greps) and `--version`
(2.1.280); `codex --help` and version (0.159.3); `agy --help` and version
(1.2.14 at audit time; the binary self-updated to 1.2.16 later — see the
compatibility ledger's addendum); `cursor agent --help`; `strings(1)` over
the two installed binaries
(inspection only — the codex guard blocked one attempt at
`codex app-server --help`, which is why app-server param shapes carry
`[verify]` tags); local reads of this repo's docs and tests and of
`~/Programming/OSS/openclaw` (ACP docs, adapter list, shrinkwrap,
auth-bridge).

Reads that were refused (permission denied) and therefore not used:
lab-service's `docs/codemux-live-session-prompts.md` and
`broker-design-notes.md`, and hermes' `acp_adapter/`. If those documents
disagree with this design, the `session` message vocabulary (§4.1–4.2) is
where it would show; the interface is the thing to reconcile.

Reproduce the binary evidence (read-only):

```
claude --version                                   # 2.1.280
codex --version                                    # 0.159.3
claude --help | grep -A3 'input-format\|permission-prompts'
strings /opt/homebrew/Caskroom/codex/0.159.3/bin/codex \
  | grep -E 'thread/(start|resume|steer)|turn/(start|steer|interrupt)|ApprovalRequest'
strings /opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe \
  | grep -E 'Mid-turn, the user added|delivered mid-turn|control_request'
```

Amendment round (2026-10-05): the panel consolidation
(`docs/LIVE-SESSIONS-PANEL.md`) added free evidence — the openclaw
app-server client reads (method and param shapes, approval result
payloads, NDJSON framing), `agy --help`'s `--input-format stream-json`
and `--conversation`, and the correction that the agy run adapter exists.
Prompt B itself was read this time (the panels could not). No paid
harness requests yet; the step-0 probes spend them.

Step-0 registry-writability outcome (2026-10-05): the live scode probes
cannot run in the implementing sandbox (`sandbox-exec: sandbox_apply:
Operation not permitted` — scode cannot nest, even with the session's
sandbox override), so the write probe was answered statically from the
scode 0.4.0 source instead — a stronger result than one live datapoint.
macOS: the profile is allow-default with `~/Library` wholesale-denied
(`DARWIN_EXTRA_BLOCKED`), the Library carve-out arrays are empty, codemux
never passes `--allow`, and a project-dir re-allow fires only for a cwd
inside `~/Library` — so the default macOS registry path is **not
writable** by a scode-wrapped child at standard trust, ro or rw. Linux:
bwrap binds `$HOME` read-write ("mirrors macOS default-allow model") and
`~/.local/state` is not on the block list — so the default Linux
registry path **is writable** by a sandboxed child at every level (even
`--ro`, which only guards the project dir). That asymmetry is exactly
the §4.8 residual: on Linux the sandboxed child remains a registry
writer, bounded by re-derivation; rule 2's computed set still refuses
the covering-cwd cases on both platforms. The bidirectional-stdio relay
probe (§6 item 3) stays not-run and flagged: `codemux session`'s e2e
fake-harness tests cover the framing logic, and the first live
scode-wrapped session gets re-verified when it can actually run.

Step-0 paid probe outcomes (2026-10-04/05): **Paid harness requests: 11**
— 7 claude-family turns and 2 interrupt/permission exchanges through the
zai endpoint (the `usagemux` claude snapshot timed out twice, so the
claude-family format probes were routed through zai instead — same binary,
same stream-json wire format, endpoint-independent), 2 codex app-server
turns, 1 agy attempt. All claude/codex probes in §7's list ran and their
confirmations and corrections are folded into §3.1/§3.2/§3.4 and §4.3/§4.7
(carrier, verbose requirement, per-turn init, mid-turn delivery — read as
next-turn here, corrected to fold-or-own-turn in review live21,
interrupt round-trip, auto-allow/auto-deny band, codex response grammar
and usage-only-via-`tokenUsage`, `CODEX_HOME` relocation honored, no
daemon attach). Probe 6 (a scode-wrapped session end to end) is the one
that cannot run here — same nesting refusal as the registry probes above;
its `[verify]` consequences stay open and covered by fake-harness tests.
agy's full exchange (probes 10) is not-run: its login is expired and
re-login is interactive; the recorded auth-failure frame pins the
`event`-keyed envelope, and the agy driver stays fixture-tested against
that shape with capability flags from `[help]` only. Sanitized fixtures:
`tests/fixtures/live/` (see its README for the per-file map).

## 9. Review history

Five review rounds on this document so far, two auditors each (security,
contracts), blocking at major and above. Rounds 1 and 2 are answered in
the text as staged; rounds 3, 4, and 5 drove revisions. Each finding and
where the design answers it:

**Round 1**

- major: a permission answer could carry a mode change or new rules
  (`setMode: bypassPermissions`) and raise the level → §4.1 answers are
  per-request only; mode changes, always-allow choices, and rule-minting
  payloads cannot be expressed in codemux's input grammar and are
  refused `malformed`/`unsupported` with the request left pending (the
  `autonomy_escalation` name belongs to the out-of-bounds `allow`,
  which resolves deny — corrected live6).
- minor: the codex round-trip claim was wrong (sandboxed codex maps to
  bypass; claude-family medium does prompt) → §4.3 rewritten:
  `permissions` reports the mechanism, not the policy; approval policy
  `never` at every level but low; claude-family medium gates Bash; the
  env-scrub hardening notes.
- minor: `author` could forge a second transcript line → §4.4 bounds.
- minor: registry writability unstated → §4.8, made structural in round 3.
- minor (contracts): "`--permission-prompt-tool` gone from help entirely"
  was false → §3.1 corrected: it appears once, inside `--permission-prompts`
  help text.
- minor (contracts): "no request arrives at medium" misexplained → §4.3
  gives the real mechanism (hardening force-resets the mode;
  version-contingent, probe 5).

**Round 2**

- major: a plain `allow` was always accepted → §4.1 every `allow` is
  measured against the start-time mapping; out-of-bounds actions answered
  deny by codemux itself.
- minor: the codex sandbox/approval carrier was unstated (`config.toml`
  fallback) → §4.7 explicit JSON-RPC parameters on every start, pinned by
  a grammar test.
- minor: the registry lacked `sandboxed`/`sandbox_trust`/`autonomy` →
  §4.8 records all three, with containment and reach guards.
- minor: `author` unbounded → §4.4 (round 1's fix, kept).
- minor (contracts): `-a never`/`-a untrusted` notation → §4.3 uses
  `-c approval_policy=…` and cites the ledger's 2026-10-03 correction.
- minor (contracts): probe numbering off by one → renumbered; §3.1, §3.2,
  §4.5, and steps 1–2 now agree.

**Round 3**

- major: `allow` with `updated_input` bypassed the ceiling (the check read
  the request's arguments, never the substituted ones) → §4.1: judged, not
  refused — the ceiling runs on the merged arguments that will actually
  execute; the tool cannot be swapped; an unparsable substitution is an
  opaque action, answered deny. Step 1 tests both directions. (The code
  now rejects a non-object substitution `malformed`, and the request
  stays pending; only an object with keys outside the tool's
  schema is answered deny — §4.1, review live23.)
- major: the resume ladder `read-only < low < medium < high` let a
  medium-created session resume at low and gain Bash approvals (low
  out-reaches medium on the session path) → §4.5–§4.7: grants re-derive
  from the resume invocation's `--auto` alone and the flag order makes
  inheritance impossible; §4.8 bounds widening with the reach order
  `read-only < medium < low = high`.
- major: a sandboxed child could write the registry (`--cwd ~` at medium
  covers the state path) → §4.8: codemux-owned per-platform path outside
  harness state, directory 0700 and file 0600, start-time refusal when
  the registry lies inside the child's writable set, and a registry the
  child could have altered treated as untrusted at resume.
- minor: `author` bounds do not stop forged attribution through `text` →
  §4.4 enumerates every line-break kind and states the honest boundary:
  `text` is unsanitized user content, the echoed event stream is the
  authoritative attribution, the transcript prefix is a display aid.

**Round 4**

- major: the registry treated tampering as self-scoped — an unsandboxed
  session's write reaching only its own entry — when any process running
  as the user (the README's `--no-sandbox --auto high` opt-out is the
  everyday case) can rewrite every entry in the shared file, including
  entries for sessions created under scode, and the owner, mode, and
  placement checks pass the forgery → §4.8 rewritten around what the
  registry is trusted for (a lookup hint and a cross-agent guard) and
  what it is not (an authorization boundary): resume re-derives every
  security-relevant value from the resume command itself, so a forged
  entry's whole effect is a skipped refusal; the placement rules keep
  their force against the sandboxed child; step 3 gains a cross-entry
  tamper test; the §9 open call restated with the right scope.
- minor (contracts): "At high, nothing is asked" was false for claude/zai
  on hardened builds — the env-scrub hardening discards
  `--dangerously-skip-permissions`, ungranted tools still gate, and a
  session's `--permission-prompts host` turns that into live requests →
  §4.1 gains the high predicate (the mapping's grant list, everything
  else denied), §4.3 notes requests surface at medium and high alike,
  step 1 tests the high case.
- minor (contracts): "Approval requests can therefore arrive only at
  low" described no codex session this design can launch — the sandboxed
  default passes the bypass flag at every level (the mapping is not
  consulted) and unsandboxed codex is high-only, both `never` → §4.1 and
  §4.3 state that no launchable codex session surfaces a request and the
  round-trip is dormant defense; §4.7's leak example replaced with a
  launchable one (unsandboxed high inheriting `config.toml` drift);
  step 2 labels the approval machinery fake-driven.

**Round 5**

- major (both auditors, independently): the resume ladder's `low = high`
  tie contradicted its own ranking standard — §4.1's high ceiling denies
  every tool outside the grant list whatever the caller answers, so low
  strictly out-reaches high on the hardened builds in scope, and the tie
  let a high-created session resume at low and gain approvals creation
  denied (WebFetch, MCP) — the round-3 medium→low class again → §4.8
  order corrected to `read-only < medium < high < low`: high→low refused,
  low→high kept as the one downward move; step 3 gains the high→low
  refusal test; the §9 open call restated.
- minor (contracts): §4.3 claimed ungranted-tool requests surface at high
  "on hardened and pre-hardening builds alike" — pre-hardening builds
  honor the bypass flag and ask nothing at high → §4.3 now splits by
  build generation (Bash at medium on both; high's ungranted-tool
  requests on hardened builds only).
- minor (contracts): `--shutdown-grace` was referenced in §4.6 but never
  defined, and duplicated the `shutdown` input's `grace_ms?` → §4.5
  defines the flag (default 10 s, every shutdown path); the input message
  drops its field — one knob.

**Round 6 — panel consolidation (2026-10-05)**

Three independent panels (codex: NOT READY; claude and zai: READY WITH
CHANGES) reviewed this document against the repo; every finding and its
disposition is in `docs/LIVE-SESSIONS-PANEL.md`. The design changed where
the panels were right: §3 carries the openclaw-verified app-server shapes
and the agy correction; §4.1/§4.3 restate the ceiling as a
permission-channel bound with scode as the enforced boundary, and sessions
get their own floors with a no-bypass high; §4.2 gains the three-tier
unknown/malformed rule, `input_seq`, bounds, and usage dedupe; §4.5 gains
`--permission-timeout` and refuses `--hermetic` and codex `--tools none`
on sessions; §4.6 gains pending-deny on every end path and the exit-code
splits; §4.7 gains the bypass-pair rule, the FIFO, the outgoing method
allowlist, and the runner seams; §4.8 gains the live owner, the computed
writable set, and the symlink checks; §7 is reordered — probes and
fixtures first, the registry before any reachable `--resume`. Codex's two
blockers are answered there (B1: the three-tier rule; B2: the ceiling
restatement). §10 is unchanged.

Round 6 addendum — step-0 probes (2026-10-04/05): every wire claim the
probes could reach is folded in as `[live …, fixture]`, and two design
claims were wrong and are corrected: the permission carrier is
`--permission-prompt-tool stdio` (not `--permission-prompts host`, which
leaves asks auto-denied with no request), and claude-family mid-turn
messages in print mode were read as going to the next turn
(`user_during_turn: "queue"`). Review live21 corrected that reading: the
fixture's mid-turn message is folded into the active turn, and a
text-only turn runs it as its own turn, so the flag is `false` (§3.1). §3.1, §3.4, §4.3, and §4.7 carry the
corrections; §8 records the spend and the not-run probes.

Open calls for Laurent — decisions this design makes that he may want to
overrule:

- The registry fails closed (§4.8): an unreadable, corrupt, or untrusted
  registry refuses every resume. This deliberately departs from round 17's
  fail-open verdict for the run-time ownership check.
- Low-created sessions may resume at high (§4.8): high's reach is
  strictly lower after the round-5 correction — its ceiling denies every
  tool outside the grant list whatever the caller answers — so the resume
  narrows, trading low's per-request human gate for the grant list.
  Refusing downward resumes too is defensible if low's human gate should
  survive resume as provenance.
- Sandboxed sessions whose writable set contains the registry path are
  refused at start (§4.8) — on the default paths, every `--cwd ~`
  session.
- The registry is not an authorization boundary (§4.8): any process
  running as the user — an unsandboxed session, a `--no-sandbox` run,
  any user process — can rewrite every entry and void the resume guards
  for all sessions, not just its own. The design answers by re-deriving
  every resume value from the resume command, so the forgery costs a
  skipped refusal and nothing more. That residual is accepted; a
  per-entry MAC was considered and declined (§4.8).

## 10. Approval

Approved by Laurent on 2026-10-04 with every open call resolved as the
design recommends: the registry fails closed; a low-created session may
resume at high; sessions whose writable set contains the registry path are
refused at start; the registry is a lookup hint and cross-agent guard, not
an authorization boundary; Antigravity ships in v1 with honest `false`
capability flags. Prompt B implements this document as written, after a
panel review (Codex, Gemini, GLM-5.3, Claude) of the plan recorded in
`docs/LIVE-SESSIONS-PANEL.md`.

## 11. Addendum (2026-10-07): OpenCode and Aider; overrides in sessions

Two harnesses joined after v1, both breaking §4.7's "one harness process
per session" shape in the same direction: the process is per TURN, not
per session. Their end paths share one late-child rule as a result: a
graceful end (stdin close, `shutdown`) that begins while a turn's spawn
is still in flight — the scode gate delays every turn's spawn — waits
for the child, delivers its payload (the prompt on opencode's stdin,
the canned negatives on aider's), and runs the turn through the normal
end-path drain, settled before done resolves; only a signal, timeout,
or crash end stops a late child on arrival (review D11, correctness 2
1).

- **OpenCode** runs its own session natively: each caller input spawns
  one `opencode --pure run --format json --session <id>` process, and the
  harness's own session store carries the state between them. §4.7's
  registry rule holds unchanged for resumes; identity follows the agy
  model (deferred — the first output line names the `ses_…` id, so a
  fresh session's first turn runs before the record can exist, and the
  registry-writability pre-check is agy's). The capability matrix is
  honest false everywhere the one-shot `run` wire has no channel:
  no steer, no interrupt (killing the process IS the interrupt, which
  answers the turn synthesized-interrupted, never a live one), no
  permissions, no deltas, no file-change frames.
- **Aider** has no event protocol at all headlessly, so the driver owns
  the least state that still carries: a codemux-minted UUID and a
  per-session chat history file under a directory codemux owns
  (`~/.aider/.codemux/sessions/<id>/history.md`). Each turn is one
  `aider --message=<prompt> --restore-chat-history --chat-history-file
  <path>` process; what carries across turns is exactly aider's own
  history file and aider's own summarization on top of it — codemux adds
  no second state. That makes the history file the integrity object: the
  turn verdict reads its delta (the reply is the text past this turn's
  `#### ` header, rendered exactly as io.py renders it — Python
  `str.splitlines` parity down to the trailing empty element a final
  line break leaves, review D4), and a file that shrank below what
  codemux consumed ends the session, because the resume contract would
  replay state the caller never saw. The directory the file lives in is
  created only after every component from `.codemux` down passes an
  lstat check — `~/.aider` is writable by the sandboxed child, so a
  planted intermediate symlink must never aim the creation, the sweep,
  or the record-failure removal (review D4). And before EVERY turn spawn
  the check runs again — the ownership chain plus an lstat of the file
  itself (a regular file, not a link, owned by the invoking user, mode
  0600): the creation-time check and the post-turn `O_NOFOLLOW` read
  left the between-turns window where a sandboxed child could replace
  the file with a symlink to something outside its sandbox and the next
  turn's aider would follow it — read the target into the model context
  and append to it (review D7). A trip fails the turn, never the
  session. The turn read-back is bounded per TURN, not per file: the
  driver keeps a byte offset and reads only the slice past it — the run
  path's whole-file 32 MiB bound, sized for one `--message` exchange,
  once ended every long session's finished turns as unreadable and
  refused every later resume, though nothing was corrupt (review D8) —
  so a session's history has no size limit from codemux's side (aider's
  own `--max-chat-history-tokens` compaction governs it), while a
  single turn's delta larger than one run's whole history fails closed.
  The same io.py write order shapes the end paths: aider writes the
  turn's `#### ` user block the moment the message is read
  (io.user_input) and the reply only at the turn's end, so a turn
  killed partway — the signal death a shutdown or stdin-close ends on —
  leaves an unanswered prompt in the file, and that session's end is
  not resumable: `--restore-chat-history` would replay the unanswered
  prompt into the next turn as if the caller had sent it again (review
  D10). And a prompt whose first non-whitespace character is `/` or `!`
  is refused before aider ever sees it, on the session path before the
  ack (`input_rejected`, `unsupported`) and on the run path in
  validateRunRequest (a `UsageRefusalError`, exit 64): aider's
  `preproc_user_input` dispatches those as its own commands before any
  model turn, and `!` — the `/run` alias — executes the shell
  immediately, ungated by `--dry-run`, so relaying one is code
  execution the autonomy never authorized (review D10).

**Provider overrides reach session spawns** through the same adapter
seams `run` uses (`prepareRun`/`getRunEnv`/`wireModelFor`), one contract
for both surfaces. The one session-specific shape: a codex override
session's `CODEX_HOME` is keyed per session — one
`session-home-<endpoint hash>-<session id>` directory under the real
CODEX_HOME's `.codemux-provider/`, run-shaped while the session is
young, settled onto its key at a resumable end, and removed at any
other end of a FRESH session (the run path's per-run home would orphan
the session's threads, and a per-endpoint one would carry one session's
planted files into the next — review D1). The endpoint hash reads the
base URL's identity form — query and fragment stripped, the same form
the registry's `provider_base_url` records — so a gateway key riding
the query can rotate without moving the home, and the hash never
varies with credentials (review D10). The key is a naming rule, not
an access boundary: the shared parent stays writable by every sandboxed
codex child, so one session's child can still plant files in another
session's home — codemux vouches for the directory never being shared
and for config.toml being rewritten per launch, no more (review D5). A
resumed session's home is
never removed at settlement — its state predates the resuming process,
so a failed or interrupted resume must not delete the earlier turns
with it; the sweep reclaims it if no resume comes back (review D3) and
never takes a home the registry holds live — the sweep fires from any
codemux codex run, so age alone deleted a resumed session's home while
the session still ran (review D4). An unreadable registry spares every
candidate too: a deletion needs a POSITIVE `free` answer, and `unknown`
— a transient read failure once folded into "not held" — must not
become a delete (review D5). The settlement runs BEFORE the end path
releases the registry record: the release is what a `--resume` in
another process waits on, and a released record whose `harness_home`
names a keyed path the rename has not landed on yet was refused
"missing or untrusted" in that window (review D7). The sweep's
freshness walk is bounded now: a run-shaped entry's pid gate comes from
its NAME (no walk for a live run), the walk carries an entry cap, and
an over-budget tree — `~/.codex` is child-writable, so a child can
plant a huge one — is spared rather than walked (review D7), except a
run directory past its pid gate, which falls back to the directory's
own mtime so a dead run's huge tree is reclaimed by age instead of
leaking (review D9), and so does a session home whose id the registry
has POSITIVELY freed — the ownership proof the pid gate provides —
while every other over-budget home keeps the D7 spare (review D10).
The consult order is the other half of that bound: a home young by its
own mtime is skipped without a walk (the walk includes the root, so
the own mtime is a floor on the tree's age), and the registry runs
BEFORE the walk, so a held or unknown id costs no walk at all — the
cap kept a live session's huge home, but every later run still walked
it to the cap to learn nothing (review D10). And a resume's own open
spares the keyed entry from this sweep entirely: for an ended record
the registry answers `free`, the removal condition, so the sweep that
ran inside the open deleted the home the resume had just been granted
past every guard, and the resume refused "missing or untrusted" — a
refusal its own setup caused; every other codemux run may still sweep
it (review D10). The
config.toml is written atomically
every time: the sandboxed child can
write the parent, so a plain write would follow a planted symlink, and
the write re-asserts the home directory itself — a resumed home's
open-time check can go stale across the registry claim, so the config
lands in a trusted directory or not at all (review D7). And
the turn-per-process agents assemble each turn's environment lazily, at
its own turn, so a session that never starts writes nothing; opencode
re-writes its provider config before every turn — the file lives in the
child-writable data directory, so a config cached at the first turn let
one turn's child rewrite what the next ran with (review D3).
