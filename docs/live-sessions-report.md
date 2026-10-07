# Live sessions — implementation report

Worktree `<workspace>/codemux-live`, branch `live-sessions` (from
main at 0.7.0). Per the task: no commits are made in this sandbox (the
pre-commit review gate cannot run); each step records its intended commit
here and stages everything with `git add -A`.

## Step 0 — evidence first

**Intended commit:** `feat(session): record live wire fixtures for claude-family, codex, and agy sessions`

**Probes run** (2026-10-04/05; drivers and raw records in `scratch/probes/`,
sanitized fixtures in `tests/fixtures/live/` — see that directory's README
for the per-file map):

1. stream-json output without `--verbose` — REQUIRED. Print mode exits with
   "When using --print, --output-format=stream-json requires --verbose".
2. init `system` message — carries `session_id` + 26-tool list, arrives
   once PER TURN; `--resume <uuid>` reports the same id (no `resume` field).
3. mid-turn delivery — recorded here as "next-turn, not inject: the
   mid-turn message left the active turn's result untouched and was
   answered in the following turn's result", with `user_during_turn:
   "queue"` for claude-family. That reading was wrong (review live21): the
   fixture's mid-turn message is folded into the ACTIVE turn and answered
   in that turn's own result (`zai-session-a.ndjson` lines 59 and 74). The
   flag is now `false`; see "Review fixes, live21".
4. interrupt shape — `control_request{subtype:"interrupt"}` →
   `control_response{still_queued:[]}` → `user` frame
   "[Request interrupted by user]" → `result` subtype
   `error_during_execution`, `is_error:true`, exit 1.
5. permission round-trip — the carrier is `--permission-prompt-tool stdio`
   (design §4.7 had `--permission-prompts host`; under `host` with no host
   attached, asks are auto-denied with no request). Full `can_use_tool`
   request/response shapes recorded. Also pinned the auto-decision band:
   `echo` auto-allowed, `touch /tmp/...` and `sw_vers` auto-denied
   (`system/permission_denied`) under `--permission-mode default`.
6. scode-wrapped session end to end — NOT RUN: scode cannot nest in the
   implementing sandbox (`sandbox-exec: sandbox_apply: Operation not
   permitted`), same refusal as the registry probes. Stays flagged; the
   e2e fake-harness tests carry the framing coverage.
7. shutdown/`--resume` — clean stdin close exits 0 after the final result;
   `--resume` verified in probe 2's follow-up.
8. codex app-server exchange with relocated `CODEX_HOME` — full
   `initialize → thread/start → turn/start ×2 → turn/completed ×2`;
   `CODEX_HOME` honored (initialize result `codexHome`, rollout path);
   process-list diff before/after empty (no shared daemon attach).
   Response grammar: responses omit `jsonrpc`; thread id at
   `params.thread.id` and in the `thread/start` result.
9. second codex turn — `thread/tokenUsage/updated` `last` = per-turn delta,
   `total` = cumulative (turn 2: total 37974 / last 18995);
   `turn/completed` carries no usage.
10. agy two-turn exchange — NOT RUN: agy's login is expired and re-login is
    interactive. One live frame recorded: result envelope keyed `event`
    (not `type`), auth-failure shape with zeroed usage.

**Quota spent:** 11 paid harness requests — 9 claude-family turns/exchanges
through the zai endpoint (the `usagemux` claude snapshot timed out twice, so
claude-family format probes were routed through zai: same binary, same
stream-json wire format, endpoint-independent; recorded as a substitution),
2 codex app-server turns, 1 agy attempt (failed before any model call).

**Design amendments driven by the probes:** §3.1 (verbose, carrier,
per-turn init, mid-turn delivery (misread as next-turn; corrected in
live21), interrupt round-trip, auto-decision
band), §3.2 (response grammar, thread shapes, usage-only-via-tokenUsage,
ambient notifications, daemon isolation verified), §3.4 (matrix cells, agy
envelope), §4.3 (carrier + probe-5 outcome, `user_during_turn: "queue"`,
now `false` after live21),
§4.7 (spawn block: `--verbose` unconditional, `--permission-prompt-tool
stdio`), §4.5 (codex thread-id regex note), §8 (step-0 outcomes, spend,
not-run probes), §9 (Round 6 addendum). Panel doc header + F18 updated to
match. §10 untouched.

**Gate:** docs-only step — `bun run typecheck`, `bun test`, and
`make release-gate` unchanged from the pre-step baseline (no source
touched); run at the next code step. American-English check on all
touched prose: clean.

## Step 1 — streaming session process runner

**Intended commit:** `feat(session): add the streaming session process runner with bounded event delivery`

`src/session/process.ts` (new): `SessionProcess` — one harness child in
its own process group, newline-framed stdio in both directions
(16 MiB harness line cap with discard-and-resync on overflow, 17 MiB
input line cap rejected before the wire, NUL/newline/CR refused),
fatal-strict per-line UTF-8, a final unterminated line still delivered,
blank lines treated as framing whitespace, bounded lossy stderr capture
for diagnostics only, and the §4.6 end path: `requestStop` SIGTERMs the
child alone, SIGKILLs the tree when the grace runs out, and `settled`
unconditionally kills the tree on every end path (including clean exit
and crash) after the remaining grace, with a 1 s pipe give-up so it
always resolves. Descendants are captured continuously (5 s cadence)
while the session runs so the end-path kill reaches processes a
post-mortem walk could no longer attribute. `BoundedOutboundQueue`
carries event lines to the caller under the 1024-event / 64 MiB bounds —
an entry stays counted until the sink completes the write, which is what
makes a stopped reader trip the bound. `installSessionSignalHandlers`
runs the shutdown path to completion on the first signal (no
`process.exit` in the handler) and leaves the 143 exit to the caller.

Two test-caught bugs during the step (fixed before staging): the queue
decremented pending bytes when a line was handed to the sink instead of
when the sink completed it — a never-resolving sink (a stopped caller)
never accumulated pending and the bound could never trip; and the test
helper awaited a thunk instead of calling it, which the A/B debug
isolated. `signalProcess` gained an `export` in `src/process-runner.ts`
(behavior unchanged); `tsconfig.json` excludes the git-ignored
`scratch/` from typecheck (probe drivers are not product code).

Tests (`tests/session-process.test.ts`, 18): framing and the final
partial line; blank lines skipped; exactly-at-cap delivered vs over-cap
fatal (unterminated and complete-line variants); invalid UTF-8 fatal
with excerpt; stdin round-trip and rejection paths (framing, oversize,
closed-after-endInput) leaving the stream intact; requestStop killing a
remembered grandchild; clean-exit unconditional kill of
periodically-captured descendants; a spawned-driver SIGTERM end-to-end
exiting 143 with the grandchild dead; queue ordering/flush, event and
byte bounds, sink-error poisoning; signal gate fire-once. Note: this
implementing sandbox denies `posix_spawn '/bin/ps'`, so
`readProcessTable` returns unknown here and the EPERM warning prints
during the kill-path tests; the kill assertions still hold via the
process-group SIGKILL, and on an unrestricted machine the table walk
adds the pid-level escalation on top.

**Gate:** `bun run typecheck` exit 0; `bun test --max-concurrency=1`
827 pass / 0 fail / 6 skip across 833 tests in 37 files (baseline before
this step: 809 pass / 815 tests / 36 files — all 18 new tests pass, no
regressions). `make release-gate` stops at the `contracts` target with
one failure — `installed binaries expose every adapter-required flag`:
the installed copilot binary's `--help` exits 1 with
`EPERM: operation not permitted, mkdir ~/Library/Caches/copilot/pkg/darwin-arm64`.
This is the implementing sandbox's `~/Library` write denial, not a code
change: running `/opt/homebrew/bin/copilot --help` directly outside the
test framework reproduces the identical error, and no file this step
touches is involved. Every other gate component passes — runtime
(Bun floor), check (typecheck + shell + coverage suite), sandbox-contract,
smoke, `bun audit` (0 vulnerabilities), frozen-lockfile dry-run, and the
help-flag smoke set — run to completion after the contracts stop.

## Step 2 — protocol core

**Intended commit:** `feat(session): add the session protocol core, FSM, and event envelope`

`src/session/protocol.ts` (new): `parseInputLine` — total, never-throwing
validation of every caller line against the §4.1 grammar (strict
unknown-field rejection, `text` ≤ 16 MiB with NUL refused, `author` per
the §4.4 allowlist, capability-false inputs rejected with
`unsupported`/`busy`, `steer` without an active turn
`no_active_turn`, `permission_decision` gated on pending-set membership,
everything but `shutdown` refused once shutting down);
`validateAuthor` (1..64 code points; Cc/Cf/Zl/Zp, `[`/`]`, and lone
surrogates rejected); `applyAuthorPrefix`; and the envelope builders —
`buildEvent` fixes key order `seq, ts, session_id, type, raw, …` with
`raw` a string on harness-mirrored events and `null` on codemux-originated
ones, plus the ack, `user_message`, `permission_resolved`, and tier-1
`unknown` builders. `src/session/fsm.ts` (new): the
starting → idle ⇄ turn_active → shutting_down → ended machine with the
pending-permission set (`addPending`/`removePending`/`supersedePending`
for the every-end-path deny rule) and the monotonic `input_seq`;
forbidden transitions return an error value instead of throwing — the
value the drivers turn into the tier-2 outcome (raw preserved + fatal
end), so that path stays uniform across harnesses.

Tests (`tests/session-protocol.test.ts`, 18): author allowlist edges
(categories, brackets, surrogates, code-point vs UTF-16 length), every
message type's accept/reject shapes, bounds and NUL, capability-false
rejections, shutting-down gating, pending-set membership, envelope key
order and raw placement, and the full FSM transition table including the
grammar violations and idempotent end paths.

**Gate:** `bun run typecheck` exit 0; `bun test --max-concurrency=1`
845 pass / 0 fail / 6 skip across 851 tests in 38 files (step 1:
827/833/37 — all 18 new tests pass, no regressions); `make check` exit 0
(coverage 85.06% line, 91.13% function, above the 80% floor); the
`contracts` environmental failure documented at step 1 is unchanged and
untouched by this step (no installed-binary surface involved).

## Step 3 — the autonomy ceiling

**Intended commit:** `feat(session): add the table-driven autonomy ceiling for permission answers`

`src/session/ceiling.ts` (new): pure predicates deciding whether one
permission request is allow-able at the session's start-time autonomy
level — never throw, never touch a process, verdict is a value.
`claudeCeiling` runs the §4.1 tool × level table: read-only denies
everything; low allows everything (the level whose meaning is "the
caller answers"; amended live6: the schema check runs before low's fast
path, so a known tool carrying an argument key outside its known schema
denies at low too — the shipped rule the live5 header fix states);
medium allows only the editing tools
(Edit/Write/NotebookEdit) with the target path inside the launch
directory; high grants the mapping's list (Edit/Write/NotebookEdit/Bash)
with editing bare-granted (any path). Unknown tools and `mcp__*` default
to deny everywhere but low. The medium path predicate decodes the scope
out of the one `grantRule` implementation (`src/claude-autonomy.ts`,
which gained an `export` — behavior unchanged), so the predicate and the
`--allowedTools` grant can never disagree; targets resolve through the
deepest existing ancestor (a Write creating a new file is still
judgeable), NFC on both sides, a symlink pointing outside denies, and a
launch directory whose grammar cannot carry a grant is a deny verdict
rather than an exception. An argument key outside the tool's known
schema denies — codemux does not judge what it cannot read, the
fail-closed §4.1 rule. `codexCeiling` measures ExecApprovalRequest/
ApplyPatchApprovalRequest the same way: read-only denies both, medium
allows workspace patches (every `+++` destination inside the scope) and
denies commands, low/high grant both (high's mapping is approval-never;
a request surfacing there is drift measured against its own level). The
caller-side enforcement — answer the harness deny and reject the line
with `autonomy_escalation` — is the drivers' job (steps 5–8); this
module only supplies the verdict.

Tests (`tests/session-ceiling.test.ts`, 16): the mandated diff of the
tool table against the recorded init `tools` fixture (all 26 fixture
tools known; the table holds exactly those plus 8 documented extras), a
table-entry allow/deny matrix per level (read-only deny-all, low
allow-all including unknown and MCP, medium scoped-edit allow with
outside/`..`/absolute denials, high bare grants with ungranted tools
denied), schema and path-key checks, symlink stay/flee, the
grammar-refusing launch directory, and the codex verdicts including
patch parsing (`b/` prefix, quoted paths, `/dev/null`, one-bad-target
denies, unparsable denies). Two test-authoring bugs were caught and
fixed before staging: the schema-reason assertion ran at read-only where
the deny reason is the level's own, and the "staying inside" symlink in
fact pointed at a sibling temp directory — the ceiling's deny was
correct and the test was wrong.

**Gate:** `bun run typecheck` exit 0; `bun test --max-concurrency=1`
861 pass / 0 fail / 6 skip across 867 tests in 39 files (step 2:
845/851/38 — all 16 new tests pass, no regressions); `make check` exit 0
(coverage 85.33% line, 91.27% function; `src/session/ceiling.ts` at
100% line / 98.85% function); `make release-gate` stops at the same
documented environmental `contracts` failure as steps 1–2 (installed
copilot `--help` EPERM under this sandbox's `~/Library` write denial) —
no file this step touches is involved.

## Step 4 — the session registry

**Intended commit:** `feat(session): add the session registry with fail-closed resume guards`

`src/session/registry.ts` (new) + `src/session/registry-io.ts` (new,
the file mechanics split out to keep both under the 500-line rule):
the §4.8 registry. Path from `$HOME` alone (macOS
`~/Library/Application Support/codemux/live-sessions.json`, Linux
`~/.local/state/codemux/live-sessions.json`; `XDG_STATE_HOME`
deliberately ignored). Strict total validation — the exact 14 fields
(this step's shape; the live4 review's containment-flags fix superseded
it with the 16-field record adding `sandbox_no_net` and
`sandbox_scrub_env`),
the right types, 1000-entry bound — anything else is `corrupt`, and
every read returns a distinct outcome (`ok`/`missing`/`untrusted`/
`corrupt`) so the failure policy can fail closed per class. Writers
serialize through an `O_EXCL` lockfile holding pid + the opaque
process-start token from `src/process-table.ts`, stolen only when its
holder is dead (staleness is liveness, not age; a successful steal
retries the create immediately without burning wait budget); writes are
0600-temp + rename with the directory's dev/ino revalidated between
temp-write and rename. Placement checks on every open: no symlinked
ancestor, the codemux-owned directory not group- or other-writable, the
file a regular 0600 non-symlink owned by the invoking user. Entries are
recorded at `session_started` (same id updates in place, `created_at`
preserved), pruned by `last_activity` to 1000 never evicting a live
owner while an evictable entry remains (an all-live overflow evicts the
oldest anyway — a registry its own validator rejects is the worse loss;
review live13). The resume guard bundle refuses: agent mismatch (the
cross-agent replay guard, by agent so it holds on the shared
claude/zai home), harness-home mismatch, containment drop, trust rise,
autonomy above creation ranked by reach (`read-only < medium < high <
low` — low out-reaches high because a low caller can approve anything),
hermetic mismatch, a live owner (`session_busy`), and a registry that
sits inside the entry's own `cwd` or `harness_home` (untrusted — the
file the child could have altered). A corrupt registry refuses resume
and the next new session backs it up beside the registry and starts
fresh. One design amendment: the entry's owner identity is the opaque
start token (`owner_start`) rather than the sketch's `owner_start_ms` —
the token is the identity mechanism the repo's process tree already
trusts, and ms are not reliably derivable from `lstart` text or proc
ticks; §4.8's sketch now says so.

Tests (`tests/session-registry.test.ts`, 20): path derivation per
platform; identity liveness; record/touch/end round trips and in-place
update; every resume guard including the full autonomy ladder (8
directed cases, among them the called-out low→high narrowing) and the
registry-inside-cwd/home untrusted class; corrupt fail-closed, the
backup-and-reset path, and updates-against-corrupt failing; placement
(mode, leaf symlink, symlinked ancestor, group-writable directory,
missing-is-clean); lock round-trip, stale steal, live-holder bounded
refusal; prune keeping 1000 with the live-owner survivor. Two
test-caught product bugs fixed before staging, both with the regression
test above: a missing registry *directory* was reported untrusted
instead of the clean `missing` outcome (the placement walk ran before
anything existed to inspect), and a lock steal consumed one of the
bounded wait attempts (a stolen lock now retries the create
immediately). Test-authoring bugs fixed: the trust-rise case needed
`sandboxed: true` on the probe to reach the trust rule; a `..`-bearing
cwd can never match a literal path prefix; `mkdir` mode bits are
umask-stripped, so the group-writable directory needed a chmod.

**Gate:** `bun run typecheck` exit 0; `bun test --max-concurrency=1`
881 pass / 0 fail / 6 skip across 887 tests in 40 files (step 3:
861/867/39 — all 20 new tests pass, no regressions); `make check` exit 0
(coverage 85.77% line, 91.63% function; `registry.ts` 100% line /
99.19% function, `registry-io.ts` 100% line / 90.65% function);
`make release-gate` stops at the same documented environmental
`contracts` failure (installed copilot `--help` EPERM), untouched by
this step. The `/bin/ps` EPERM note from step 1 applies here too: on
this sandbox owner-liveness degrades to the signal-0 probe, which the
busy/steal/prune tests still exercise.

## Step 5 — the claude session driver, the `session` CLI, and wiring

Intended commit: `feat(session): add the claude session driver and the
codemux session CLI`.

**Code.** `src/session/claude-session.ts` — the pure layer for the
claude-family wire: `claudeSessionAutonomyFlags` (high = permission-mode
default + the Edit/Write/NotebookEdit/Bash grant list, never the bypass
flag; medium/low/read-only reuse the run mapping verbatim),
`buildClaudeSessionCommand` (the §4.7 spawn shape — resume id before
every autonomy flag, `--setting-sources user --strict-mcp-config`, no
`--no-session-persistence`, random-UUID `--session-id` on fresh
launches, effort skipped when "none"), `claudeSessionCapabilities`
(all true, `user_during_turn: "queue"`, `file_changes: "derived"`),
the writers (`buildHarnessUserMessage`, `buildInterruptRequest`,
`buildControlResponse` with the fixture-pinned nested shape), and
`ClaudeStreamParser.feed` — the §4.2 three-tier parse with per-line
facts only: session-id mismatch or a second/no-id init is a
`grammar_error`, message-id dedupe suppresses repeated assistant
frames (usage never summed from them), tool_use derives file changes
(Edit/NotebookEdit edit, Write adds), the replay echo is unknown, and
a line that is not a JSON *object* reports `unusable` (tier 3). The
session floor `CLAUDE_SESSION_FLOOR = "2.1.280"` lives here.

`src/session/driver.ts` — `ClaudeSessionDriver`, the launcher-owned
context: the FSM, the parser, the pending-permission timers, the
bounded outbound queue (overflow → stderr diagnostic + crash), the
signal gate (143), and the registry writes. The turn model from the
design's claude amendments: codemux owns the boundary — a turn opens
when an accepted input is submitted from idle (`t1`, `t2`, …), a
mid-turn input queues harness-side and the next turn rolls open the
moment the running one completes, and the echo carries `turn_id` only
once assigned (absent, not null, while queued). Permissions: request
→ `permission_request` event + timer; an allow is judged by
`claudeCeiling` on the *effective* input (substituted arguments
included) and an above-ceiling allow is answered deny to the harness,
resolved deny, and rejected as `autonomy_escalation`; timeout answers
deny with `resolution: "timeout"`; every end path supersedes remaining
pending requests with deny before anything else. Interrupts close the
active turn (`finish: "interrupted"`); the turn timeout marks the
completion `reason: "turn-timeout"` and the session continues; the
session timeout ends the session (exit 1). `finish()` is the single
end path: supersede, best-effort interrupt so the harness can persist,
tree kill after the grace, registry end stamp best-effort, and
`session_ended` last with the *child's* exit code. Cumulative usage
starts at zero and sums field-wise; `session_ended.usage` is that
cumulative (claude-family has no standalone usage events). Registry
start-write failure is a fatal codemux error (exit 1) — an untracked
live session must not run.

`src/session/cli.ts` — `codemux session`: one flag surface, the
session-only refusals (`--hermetic` and `--sandbox-trust untrusted`
exit 64 before anything spawns; `--turn-timeout` refused for
interrupt-false agents), `SESSION_AGENTS` gating (claude only this
step; anything else exits 64 "not implemented"), UUID-validated
`--resume` through `lookupForResume` (66 unknown/untrusted, 78
refused), the threaded session floor through `assertHarnessSupported`'s
new `minimumOverride`, and the caller-stdin framer (CRLF-tolerant,
blank lines skipped, an unterminated run past the 17 MiB cap rejected
as malformed without unbounded buffering). Wiring: `harness-compatibility.ts`
and `cli-runtime.ts` grew the override parameter; `spawn.ts` gained
the NUL/shape guard and `envOmissions` (parity with
`resolveExecutionCommand` and `runSandboxedWithStdin`); the
`normalizeClaudeUsage` extraction moved to `result-envelope.ts`;
`index.ts` registers the command.

**Tests** — four new files, 50 tests. `tests/session-claude.test.ts`
(22): the autonomy mappings incl. the created-high/resumed-read-only
tail equality; the command shapes and floor-vs-contract ordering; the
fixture-pinned writers; the parser parse-by-parse (init rules,
foreign-session grammar error, one-line text+tool_use+derived change,
Write/NotebookEdit/Bash derivation, dedupe, tool_result vs replay
echo, deltas, finish end/failed/interrupted, can_use_tool shapes).
`tests/session-e2e.test.ts` (20) drives the real driver over
`SessionProcess` against `tests/fixtures/live/fake-claude-session.ts`,
a scenario-driven fake built from the step-0 fixtures (basic, tools,
ask, wait, crash, garbage, badinit, wrongsession; live queueing — the
fake itself queues mid-turn input and drains it at turn end, matching
`user_during_turn: "queue"`; everything it receives recorded as JSONL):
full lifecycle incl. the fixed envelope key order and the registry end
stamp; queue rollover; steer-echo-author + interrupt + the queued
steer's turn; permission allow with `updated_input` substitution
(asserted on the fake's recorded response), deny, medium and read-only
ceiling escalations, timeout + late-decision `unknown_request`; turn
timeout continuing the session; stdin-close; session timeout; crash;
tier-3 garbage; tier-2 wrongsession/badinit; rejected caller lines;
the registry resume guards against a live session; author prefix on
the harness-bound text (asserted in the fake's `input-lines.jsonl`)
with the echo unprefixed, and `--no-author-prefix`; seq monotonicity.
`tests/session-cli.test.ts` (7): the exit-code surface through
`bin/codemux` with the fake `claude` on PATH — 64 for a non-session
agent, `--hermetic`, untrusted trust, a non-UUID `--resume`; 66 for an
unknown UUID against the empty isolated-home registry; the floor
refusal (fake answers `--version` as 2.1.100 → refusal naming 2.1.280;
the probe's environment is allowlisted, so the version must come from
the wrapper, not an env var); and a deterministic happy path —
`--pass-env` carrying the fake's state through the sanctioned seam,
session_started/turn_completed observed on stdout, shutdown →
`session_ended` last, exit 0, and the fake's recorded argv checked for
the carrier, the codemux session id, and high's grants with no bypass
flag. `tests/session-spawn.test.ts` (1): the §4.7 parity test — a fake
scode records its argv and execs; `spawnSessionChild`'s sandboxed
command equals `buildScodeCommand`'s output for the same request.

**Bugs the tests caught** (each fixed with its pinning test): (1) the
parser passed non-JSON and non-object lines through as tier-1
`unknown`, so garbage streamed on instead of the §4.2 tier-3 fatal —
now `unusable` with a 4 KiB excerpt; (2) the cumulative usage was
initialized from `emptyUsage()` (all null), so every field-wise sum
stayed null and `session_ended.usage` was always null — it now starts
at zero (a turn that reported nothing still shows nulls in its own
event); (3) interrupt request ids consumed the turn counter, shifting
the caller-visible turn ids (t1, t3, …) — request ids now live in
their own namespace; and (4, caught in the unit pass) a `result`
framed `error_during_execution` for an interrupted turn marked the
turn failed — an interrupt is the outcome, not an error. Test-side
facts pinned along the way: the queued echo omits `turn_id` (the
design's `turn_id?` once known), and the version-gate probe
environment drops unlisted variables.

**Gate:** `bun run typecheck` exit 0; `bun test --max-concurrency=1`
931 pass / 0 fail / 6 skip across 937 tests in 44 files (step 4:
881/887/40 — all 50 new tests pass, no regressions; the four new files
re-run twice in isolation, stable); `make check` exit 0 (coverage
83.85% line, 90.08% function; `driver.ts` 88.57% line / 95.83%
function, `claude-session.ts` 90.91% line / 100% function);
`make release-gate` exit 2 at the same documented environmental
`contracts` failure (installed copilot `--help` needs `mkdir
~/Library/Caches/copilot`, denied in this sandbox) — unchanged from
steps 1–4, not touched by this step.

## Step 6 — the codex app-server session driver

Intended commit: `feat(session): add the codex app-server session
driver`.

**Code.** `src/session/codex-session.ts` (the pure layer): the spawn
command — one dedicated `codex app-server` per session, never the
shared daemon (§4.7) — the session-only floor
`CODEX_SESSION_FLOOR = "0.159.3"`, and the resume id pattern
`CODEX_THREAD_ID_PATTERN` (fixture ids are UUIDv7-shaped; a pasted
claude UUID matches the pattern — its 36 chars are all in the class —
and is refused later by the registry, the same mechanism step 7 records
for the mirror case: 66 when no codex entry carries the id, 78 on the
agent match when one does; amended live6). The
capability set is all-true with codex's two honest deviations:
`user_during_turn: "queue"` (the codemux FIFO) and `file_changes:
"native"` (the fileChange item, not tool-call derivation).
`codexSessionPolicy(level, sandboxed, cwd)` builds the sandbox/
approval pair every thread and turn carries: a scode-wrapped session
passes the bypass pair (`danger-full-access` + `never` +
`{type:"dangerFullAccess"}`) at every level — mirroring run's bypass
flag — and the unsandboxed shape translates the adapter's mapAutonomy
mapping onto the JSON-RPC carriers (`readOnly` /
`workspaceWrite`+writableRoots / `dangerFullAccess` objects), so
config.toml is never the source of sandbox behavior. The builders
emit exactly seven methods (`CODEX_SESSION_METHODS`, pinned by a
grammar test): `initialize` (codemux name/title/version from
package.json), `notifications/initialized`, `thread/start` /
`thread/resume` (cwd, policy pair, the ignore-rules `config`
`--ignore-rules` rides, optional model), `turn/start` (the
fixture-pinned input shape `[{"type":"text","text}]` — no
text_elements — policy pair as objects, optional effort, "none"
dropped), `turn/steer` (texts batched, `text_elements: []` the way
openclaw's client writes them, `expectedTurnId`), and `turn/interrupt`.
Responses omit `jsonrpc`, matching the server's own frames.
`normalizeCodexTokenUsage` unfolds codex's input count — both cache
reads and writes fold into `inputTokens` — into `ResultUsageBlock`
semantics (the same unfolding as `--result-json`), nulls when
unreported, negatives and non-finite rejected.
`codexApprovalCeiling` judges the three approval kinds against
start-time autonomy (read-only denies all; low is caller approval;
medium allows workspace patches via `pathInsideScope` and denies
commands and turn-scoped permissions; high is full access, still no
turn-scoped permissions; unparsable patches deny fail-closed).
`pickApprovalDecision` respects `availableDecisions`, never
`acceptForSession`. `CodexStreamParser.feed` is the §4.2 three-tier
parse with codex's two scope helpers — `threadScopedParams` for
turn/started|completed (the turn identity rides the `turn` object, no
params-level turnId) and `scopedParams` for item/tokenUsage events —
plus the openclaw raw-newline quirk: a line opening an object that
fails with "Unterminated string" or "Unexpected end of JSON input"
buffers and rejoins with an escaped newline, bounded (8 MiB / 1000
lines) before the tier-3 fatal. Responses classify on
id-without-method; server requests on method+id; approval requests
split into `permission_request` (parsable) or `unparseable_approval`
(never fatal on shape alone); unimplemented server requests surface
for the -32601 answer.

`src/session/codex-driver.ts` — `CodexSessionDriver`, the
launcher-owned context: the FSM, the JSON-RPC id correlation
(`pendingCalls`), the parser, the pending-approval timers, the
bounded outbound queue, the signal gate, the registry writes. Turn
model: codemux-local ids `t1, t2, …` assigned at submit from idle
(the echo carries its turn synchronously); the harness turn id from
the turn/start response maps onto it, and the caller-facing
`turn_started` rides the harness's turn/started notification — the
turn the harness actually opened is the proof. Steers and interrupts
buffer until the harness id is known, then flush; mid-turn user input
queues in the FIFO and the next turn rolls open on completion. The
handshake codemux owns: initialize, the initialized notification,
then thread/start (or resume) — the wire order the fixture recorded.
Usage: `thread/tokenUsage/updated` notifications accumulate into the
per-turn block and emit `usage` events; the session cumulative folds
exactly once, at turn completion. `turn/start` refusals fail the open
turn (`turn_completed failed`) without ending the session; steer and
interrupt errors are non-fatal. Every end path funnels through
`finish`: pending approvals are answered decline, an active turn is
interrupted so the harness persists inside the grace window, the tree
is killed, `session_ended` is last. `src/session/cli.ts` gained the
codex branch: `codexHarnessHome` (CODEX_HOME honored only through
`--pass-env`, absolute and unpadded, else `~/.codex`), the resume
pattern check, and `--tools` (initially accepted for codex with `none`
refused everywhere; the live1 review showed the honest flag is false —
codex has no verified carrier either — so "Review fixes, live1" below
made the refusal blanket).

**Tests.** `tests/fixtures/live/fake-codex-app-server.ts` — a
scenario-driven fake built from the fixture's shapes: `scenario:<name>`
prefixes select basic, tools (commandExecution + three-change
fileChange + two usage updates), ask / askpatch (approvals that freeze
the turn until the decision response), wait, steer, failstart, crash,
garbage, rawnewline (a real newline inside a delta string), badthread,
secondthread, unknownreq (fs/readFileText), and badapproval; every
request, decision, steer, and interrupt is recorded as JSONL for the
assertions. `tests/session-codex.test.ts` (52): spawn/capabilities/
pattern; the policy pairs at every level; the seven-method allowlist
and every builder's grammar (jsonrpc on requests, absent on
responses; effort "none" dropped; steer batching); usage
normalization (the unfold, the nulls, the rejects); the ceiling
matrix; decision picking (absent list, preference, alternates, never
acceptForSession); and the parser tiers — response classification,
thread/started exactly-once, turn lifecycle with no-open-turn
grammar errors, foreign thread/turn grammar errors, statuses with
inProgress→unknown, deltas (empty→unknown), final vs commentary
agentMessage, userMessage/mcpToolCall unknown, commandExecution and
fileChange mapping (all-or-nothing), tokenUsage, ambient unknowns,
approval classification + the method table + unparsable and
foreign-turn approvals, fs/readFileText, tier-3 unusable, the
raw-newline rejoin and its 1000-line bound, non-bufferable failures,
and reset. `tests/session-codex-e2e.test.ts` (24): the fresh
handshake (initialize → initialized → thread/start, verified in the
fake's request log) with one clean turn and a registry entry stamped
ended; pre-session buffering and replay; stdin-close mid-turn; the
session timeout; resume (thread/resume + the adopted id); the queue
rolling `t2` after an interrupted `t1`; steer with the harness
`expectedTurnId`; interrupt (recorded in the fake); the turn timeout
with its reason; a failed turn/start not killing the session; the
author prefix riding the harness-bound text; tool/file/usage events
with two usage notifications summing into one turn usage and
`session_ended.usage` equal to it; approvals allow/deny/timeout/
escalation (the ceiling refuses an allow above medium and answers
decline, with `input_rejected autonomy_escalation`); an in-scope
patch passing medium; unparsable and unimplemented server requests;
and the stream tiers — tier-3 garbage, tier-2 foreign-thread and
second-thread with raw preserved, the rejoined raw-newline delta, and
the crash path. `tests/session-cli.test.ts` grew five codex tests:
`--tools none` and `--tools` on a carrier-less agent both exit 64; a
`--resume` id that is not a thread id exits 64; a codex harness below
the session floor refuses before spawn; and a full happy path through
`bin/codemux session -a codex` — one turn over the app-server
protocol, clean shutdown, resumable end, and the fake's argv log
showing exactly `codex app-server`. (The not-implemented refusal test
moved to `-a zai`, the next driver to land.)

**Bugs the tests caught** (each fixed with its pinning test): (1) the
usage notifications double-counted — the `usage` case folded into the
session cumulative AND completion folded the per-turn accumulator, so
`session_ended.usage` doubled every turn; the cumulative now folds
only at completion (the tools e2e test pins
`ended.usage == completed.usage`). (2) The parser's turn-lifecycle
scope check demanded a params-level `turnId` the real notification
does not carry — every genuine turn would have been a grammar error;
turn/started|completed now read the turn object
(`threadScopedParams`). (3) Test-side: the escalation wait watched
for an `input_ack` event type that does not exist — the protocol
emits `input_rejected`; and the codex version probe reads the
`codex-cli <version>` line the real binary prints, so the fake's
preamble must print that form or the gate warns and allows.

**Gate:** `bun run typecheck` exit 0; `bun test --max-concurrency=1`
1012 pass / 0 fail / 6 skip across 1018 tests in 46 files (step 5:
931/937/44 — all 81 new tests pass, no regressions); `make check`
exit 0 (coverage 84.78% line, 90.15% function); `make release-gate`
exit 2 at the same documented environmental `contracts` failure
(installed copilot `--help` needs `mkdir ~/Library/Caches/copilot`,
denied in this sandbox) — unchanged from steps 1–5, not touched by
this step.

## Step 7 — the zai session wiring

Intended commit: `feat(session): add the zai session wiring on the
claude-family path`.

**Code.** `src/session/zai-session.ts` — the Z.AI mode of the
claude-family path, as the design specifies: zai is not a second
harness but the same `claude` binary pointed at the Z.AI endpoint
through the adapter's env (`ANTHROPIC_AUTH_TOKEN` /
`ANTHROPIC_BASE_URL`, the key checked by `beforeLaunch` — `ZAI_API_KEY`
or `~/.zai`). The module holds the identity the registry and the
caller see: `ZAI_SESSION_FLOOR` (the claude floor verbatim — one
binary, one gate), `zaiSessionCapabilities()` (claude's matrix
unchanged: `user_during_turn: "queue"`, `file_changes: "derived"`,
everything else true), and `buildZaiSessionCommand()` (the claude
argv; the Z.AI identity rides the environment, never the command
line). The driver, parser, ceiling, and FSM are the step-5 ones —
`ClaudeSessionDriver.agent` was already `"claude" | "zai"`.
`src/session/cli.ts` gained the `zai` entry in `SESSION_AGENTS`
(UUID resume pattern — the registry's agent match is what refuses a
claude-created id, not the pattern; `--tools` refused like claude's,
same binary, same missing carrier) and the `claudeFamilyAgent`
narrowing so the driver and the registry record the true agent.

Two latent step-5 defects surfaced and were fixed while wiring the
agent through (both would have shipped zai sessions pointing at state
that does not exist): (1) `buildClaudeSessionCommand` selected a
`zai` binary for the zai agent — no such executable exists; the
adapter's `binaryName` is `claude`, so the spawn is always `claude`
(the Z.AI mode is env-only). (2) `claudeFamilyHarnessHome` defaulted
the zai home to `~/.zai` — that directory holds only the API key;
zai transcripts live in the same `~/.claude` (or `CLAUDE_CONFIG_DIR`)
store claude uses, which is precisely why round 17's replay hazard
exists and why the guard is the registry's agent match, not a split
path. Both fixes carry regression tests.

**Tests.** `tests/session-zai.test.ts` (3): the floor equals the
claude floor; the capability matrix equals claude's with the two
documented deviations; the spawn argv is byte-identical to the
claude-family argv (no zai binary, no bypass flag).
`tests/session-cli.test.ts` grew three zai tests: resuming a
claude-recorded session through `-a zai` refuses with 78 and the
round-17 reason ("belongs to agent claude, not zai") against a seeded
registry; a session with no API key refuses before spawn (exit 1,
"Z.AI API key not found.", no stack); and a full happy path through
`bin/codemux session -a zai` — one turn, clean shutdown, the fake
harness's recorded env showing the Z.AI endpoint and token with the
raw `ZAI_API_KEY` omitted from the child, and the registry entry
recording agent `zai` against the shared `.claude` home. The fake
claude harness now records its startup env (endpoint identity) for
that assertion; the not-implemented refusal test moved to `-a agy`,
the last driver to land. Test-count history: 931 → 1012 → 1018.

**Gate:** `bun run typecheck` exit 0; `bun test --max-concurrency=1`
1018 pass / 0 fail / 6 skip across 1024 tests in 47 files; `make
check` exit 0; `make release-gate` exit 2 at the same documented
environmental `contracts` failure (installed copilot `--help` needs
`mkdir ~/Library/Caches/copilot`, denied in this sandbox) — unchanged
from steps 1–6, not touched by this step.

## Step 8 — the agy session driver

**Intended commit:** `feat(session): add the agy session driver`

**Code.** `src/session/agy-session.ts` (236 lines): the floor (1.2.14,
the audited installed build), the honest capability matrix (live input
and resume true; user-during-turn, steer, interrupt, permissions,
deltas, file changes, usage stream all false — the design table's
"unknown" cells, reported as false rather than guessed), the spawn
command (the NDJSON input loop `--input-format=stream-json
--output-format=stream-json` with its required pairing,
`--disable-slash-commands`, the run path's autonomy flags, `=`-form
model/effort, `--conversation=<id>` resume last, no `--print`), and the
`event`-keyed result parser under the three tiers. The parser reuses
the run path's `parseAgyResultEnvelope` verbatim for the envelope's
status/response/error contract and usage arithmetic, so the run and
session surfaces cannot disagree about what a result is. A JSON object
that is not a `result` event is tier-1 unknown; a frame with no `event`
name, no result object, an unusable envelope, or a conversation id that
disagrees with the session's is tier-2. `AGY_CONVERSATION_ID_PATTERN`
deliberately accepts the registry's own id class (non-empty,
whitespace-free, ≤128 chars) because no live conversation id was ever
recorded — the fixture's frame carries an empty one.

`src/session/agy-driver.ts` (575 lines, above the ~500 guideline but
half the codex driver's 1129): the launcher-owned driver. Identity
model: a fresh agy session has no init frame, so the FSM leaves
`starting` silently on the first user input while the caller-facing
`session_started` event and the registry record wait for the first
result envelope that names a conversation; events before that carry an
empty session id (the alternative — buffering the first user line —
would deadlock, since its result is what names the conversation). A
resumed session adopts its registry-vouched id at spawn. The
fixture-pinned auth failure (a first result with an empty
conversation_id) completes the open turn as failed and then ends the
session fatally: an untracked live session must not run (§4.8). Turn
ids are codemux-local and `turn_started` rides the write of the input
line — writing it is what opens an agy turn. Because the capability
matrix is honestly narrow, the driver carries no turn queue, no steer
or interrupt buffering, and no approval machinery: the input parser
rejects each unsupported message type by name (`unsupported`, `busy`)
before anything reaches the harness.

`src/session/cli.ts`: `agy` joins SESSION_AGENTS (floor 1.2.14,
interrupt false — `--turn-timeout` is refused by the existing generic
check — resume pattern, tools false); the harness home is
`~/.gemini/antigravity-cli` (confirmed on disk; no verified env
redirect exists, so unlike claude/codex there is no passthrough
variable to honor); `assertNoAgyProjectExecutionConfig(workdir)` runs
before spawn, the same repository-executable guard the run path
applies; and the driver construction is now a three-way branch.

**Tests.** `tests/fixtures/live/fake-agy-session.ts` (223 lines): the
scenario-driven fake built from the fixture's shapes — claude-style
user frames in, `event`-keyed results out, no init frame, nine
scenarios (basic, errorturn, authfail verbatim from the fixture, wait,
crash, garbage, wrongid, noevent, badresult). Success frames carry no
`error` field: the shipped envelope parser treats any present error
string — empty included — as a failure, and the documented shape
carries `error` on failing envelopes only.

`tests/session-agy.test.ts` (19): the floor; the exact capability
matrix; the session autonomy flags equal the adapter's `mapAutonomy`
for every level (the no-drift pin); the resume pattern's accepts and
refusals; the spawn command's shape for every autonomy level plus
model/effort/conversation ordering and the no-`--print` rule; and the
parser tiers — the fixture's input line equals `buildAgyUserMessage`
byte-for-byte, the fixture's auth-failure frame parses as a no-identity
error result, usage normalizes through the run path's arithmetic
(100/40/20/5 → 60 uncached + 40 cached + 20 output = 120 total),
non-JSON is tier-3, an unrecognized event is tier-1, and each grammar
violation (no event name, no result object, no usable envelope, foreign
conversation) is tier-2.

`tests/session-agy-e2e.test.ts` (14): the real driver over the fake —
the two-turn exchange with the deferred identity (echo and
turn_started precede session_started and carry the empty id;
assistant_message, usage, and turn_completed after it carry the
conversation id; the registry records agent `agy` under that id with an
end stamp); resume adopts its id at spawn before any turn; the
fixture-pinned auth failure fails the turn and ends the untrackable
session (code 1, crash, never recorded, resumable false); an error
result with a known conversation fails the turn but not the session;
stdin close mid-turn and the session timeout; the author prefix rides
the harness line; the honest-false rejections by name (steer,
interrupt, permission_decision all `unsupported`; a mid-turn user line
`busy`); and the three tiers' end paths including a foreign
conversation with the raw preserved and a process crash.

`tests/session-cli.test.ts`: the not-implemented refusal moved to
`-a gemini` (every supported agent now has a driver); five agy tests —
the floor refusal (1.2.13 → exit 1), `--turn-timeout` refused with 64,
a non-token `--resume` id refused with 64, an `.agents/skills.json` in
the working directory refused before spawn (exit 1), and the happy path
through `bin/codemux session -a agy` (session_started with the honest
matrix, one turn, clean shutdown, the exact NDJSON-loop argv, and the
registry entry naming agy under `~/.gemini/antigravity-cli`). The CLI
test sends the first turn before waiting for session_started — the
deferred identity means the event cannot precede the first result.
Test-count history: 931 → 1012 → 1018 → 1056.

**Gate:** `bun run typecheck` exit 0; `bun test --max-concurrency=1`
1056 pass / 0 fail / 6 skip across 1062 tests in 49 files; `make
check` exit 0 (coverage 84.56% lines / 89.99% functions); `make
release-gate` fails at the same documented environmental `contracts`
stage (installed copilot `--help` needs `mkdir
~/Library/Caches/copilot`, EPERM in this sandbox — verified identical
this step by re-running `CODEMUX_RUN_INSTALLED_CONTRACTS=1 bun test
tests/installed-contract.test.ts`), and the `/bin/ps` EPERM descendant
warning — both unchanged from steps 1–7, neither touched by this step.
`check_american` clean on all seven touched files.

## Step 9 — docs and contracts

**Intended commit:** `docs(session): document live sessions`

**Docs.** Four files, one test fix they forced.

`README.md`: a `session` row in the commands table; a `session` options
subsection after `run`'s (every flag with its session-only refusals —
`--tools` any value, `--hermetic`, `--sandbox-trust untrusted` — and the
two timeouts' semantics); a new "Live sessions" section after "Result
envelopes" carrying the input line types (each acknowledged, nothing
silently dropped), the output envelope with `raw` verbatim and the
unknown-passthrough/fatal-grammar split, the capability matrix, the
registry (both platform paths, vouching rules, fail-closed on a corrupt
registry), the lifecycle (stdin close mid-turn, crash path, process
tree), and the exit codes. The Result envelopes note on `session_id`
now points at `codemux session` instead of a "planned" release; run
envelopes stay null because runs stay stateless.

`docs/HARNESS-COMPATIBILITY.md`: a 2026-10-05 "live sessions" addendum
before "Version enforcement". It records the session floors and why
they sit above the run floors (claude/zai 2.1.280 — the audited
`--permission-prompt-tool` build; codex 0.159.3 — the build the
app-server method table was recorded against; agy 1.2.14 — the only
audited release), the capability matrix with per-harness wire
carriers, the codex app-server contract (one dedicated `app-server`
per session, the seven-method allowlist with the never-sent families
named, jsonrpc-on-requests/responses-omit-it, thread/started exactly
once, tokenUsage `{total, last}`, the policy pair on every thread and
turn start, approval answers, the resume id pattern), the claude
stream-json contract at 2.1.280 (the full argv, `--session-id` minted
by codemux vs `--resume` first, per-turn `system/init` with no resume
marker on the wire — the registry vouches, the stream cannot, the
`can_use_tool` control round-trip and the auto-deny path without the
carrier, the interrupt round-trip and the interrupted-not-failed
verdict, `--replay-user-messages`, high as `default` plus grants,
never the bypass), zai's shared-home registry guard, and agy's
documented-not-live-verified status with what the contract rests on
(the auth-failure fixture, the 1.2.14 help text, the official docs,
fake-driven e2e) — the deferred identity, the run-path envelope parser
reuse with its any-present-`error`-is-failure rule, and the permissive
conversation-id pattern with the registry as the real vouching layer.

`docs/HERMETIC.md`: "Session persistence" rewritten. Runs stay
stateless; sessions are the persistence surface and the reason
`--hermetic` is refused for them; the three open questions named (a
hermetically created session's resume-cleanliness, Codex's destroyed
private `CODEX_HOME` at exit, agy having no verified mechanism at
all); the registry's paths, permissions, vouching rules, and
fail-closed reads; and `--sandbox-trust untrusted` refused because it
denies the state a persistent session must write.

`CHANGELOG.md`: `[Unreleased]` → Added, one entry for the whole
feature (protocol, four agents, floors, honest matrix, agy's
documented status, safety seams, permission events and ceiling,
registry vouching, lifecycle, refusals, doc pointers).

**Test fix.** The ledger-agreement test
(`tests/harness-compatibility.test.ts`) failed on the new addendum:
`installedRows` scanned every pipe table in the whole file, so the
capability matrix's rows read as installed-harness claims and
"Capability" failed the agent-map lookup. Root cause: the parser
assumed the ledger contains exactly one table. Fixed by scoping the
scan to the region before the first `## ` heading (the master table)
and adding a regression test with a synthetic ledger whose addendum
table must not count as installed rows — the same synthetic-ledger
style the round29 regression already uses. The strictness the test was
written for is untouched: an unknown name in the master table still
fails.

**Gate.** `bun run typecheck` exit 0; `bun test --max-concurrency=1`
1057 pass / 0 fail / 6 skip across 1063 tests in 49 files (was
1056/0/6 across 1062 — the +1 is the regression test; the first run
of this step failed 1 on the ledger test before the fix); `make
check` exit 0 (coverage 84.56% lines / 89.99% functions, unchanged);
`make release-gate` fails at the same documented environmental
`contracts` stage — installed copilot `--help` needs `mkdir
~/Library/Caches/copilot/pkg/darwin-arm64`, EPERM in this sandbox,
re-verified identical this step via
`CODEMUX_RUN_INSTALLED_CONTRACTS=1 bun test
tests/installed-contract.test.ts` (2 pass / 1 fail, the copilot help
extraction; version probes exercised for all eleven installed
harnesses) — and the `/bin/ps` EPERM descendant warning. Both
unchanged from steps 1–8, neither touched by this step.
`check_american` clean on README.md,
docs/HARNESS-COMPATIBILITY.md, docs/HERMETIC.md, CHANGELOG.md, and
tests/harness-compatibility.test.ts.

**Not done (deliberate):** the design's optional `codemux check`
live-session probe. The plan marks it "optional if budget remains";
the four required deliverables and the gate are complete, and the
probe is a self-contained follow-up that does not gate this step.

## Host fixes, live1

**Intended commit:** `fix(session): resolve symlinked registry ancestors and pin the spawn parity test to run's canonical paths`

`make release-gate` failed on the host (outside the implementing
sandbox): 71 fail and 48 "Unhandled error between tests", against
1057 pass inside the sandbox. Two root causes, both verified by
direct probe before fixing.

**Root cause 1 — the registry placement check refused symlinked
system ancestors.** `registryPlacementProblem`
(`src/session/registry-io.ts`) walked every ancestor of the registry
directory and refused any symlink — on macOS that is `/var -> 
/private/var`, so a registry under any tmpdir-derived `$HOME` (every
e2e suite) returned `untrusted session registry: registry directory
/var is a symbolic link` before `session_started`, killing each
session at the record-write (the 44 `timed out waiting for
session_started; saw: error,session_ended` failures) and failing every
writing test in `tests/session-registry.test.ts`. A real user whose
`$HOME` sits behind a symlink (macOS `/home` autofs, Linux
`/home -> /data/home`) would be locked out of `codemux session` the
same way — a product bug, not a test bug. Fix, at the root: the new
`resolveRegistryPath` realpaths the deepest existing ancestor and
re-attaches the not-yet-existing tail (the technique `ceiling.ts`
already uses for tool targets; no NFC normalization, because the
result is opened and macOS directory names are NFD); the ancestor
walk runs on the resolved chain, so a symlink that survives
resolution (an unreadable step degrades the walk) is still refused;
and every registry operation — read, lock, atomic write, corrupt
backup — runs on the resolved path, so a later re-link of the friendly
spelling cannot redirect the open. The leaf rules are unchanged and
now explicitly read the original spelling: the registry's own
directory and the file must not be symlinks, the directory owned by
the invoking user and not group/other writable, the file a regular
0600. `lookupForResume`'s containment rule (registry inside the
entry's own `cwd`/`harness_home`) compares both sides resolved, so a
symlinked ancestor cannot hide a real containment. The design doc
§4.8's two trust-check passages now say exactly that (resolved chain,
leaf rules). One regression test added: a registry under a self-made
symlinked ancestor records successfully and the file lands in the real
directory; the existing leaf-symlink and file-symlink refusals stay.

**Root cause 2 — the spawn parity test compared unresolved paths.**
`spawnSessionChild` (correctly) mirrors `run`: `validateWorkingDirectory`
realpaths the cwd (launch.ts:165, cli-runtime.ts:558) and
`resolveTrustedExecutable` realpaths the binary, so the sandboxed
child records `/private/var/...` spellings while
`tests/session-spawn.test.ts` built its expectation from the raw
`workDir` and `Bun.which("claude")` — equal only where the temp dir
spells the same unresolved (the sandbox), a string-equal-by-luck
assertion. The product code needed no change (verified seam by seam
against `runSandboxedWithStdin`); the test now builds the expectation
the way run does — `validateWorkingDirectory(workDir)` for the
directory, `realpathSync` for the binary — so the parity claim holds
on any host.

**Gate.** `bun run typecheck` exit 0. Full suite with the host
condition reproduced (TMPDIR pointed through an explicit `ln -s`,
`--max-concurrency=1`, this sandbox's own tmp being the resolved
`/private/var` spelling): **1058 pass / 0 fail / 6 skip across 1064
tests in 49 files** — the step-9 baseline 1057/0/6 across 1063 plus
the one new regression test; the plain-TMPDIR run is identical.
`make release-gate` exit 2 at the same documented environmental
`contracts` stage as steps 1–9 (installed copilot `--help` needs
`mkdir ~/Library/Caches/copilot`, EPERM wherever this account's
`~/Library` is denied — `/opt/homebrew/bin/copilot --help` run
directly exits 1 the same way); every other component passes when run
past the stop: runtime, check (coverage 84.57% line / 90.00%
function), sandbox-contract, smoke, `bun audit` (0 vulnerabilities),
frozen-lockfile dry-run, and the help-flag smoke set.
`check_american` clean on `src/session/registry-io.ts`,
`src/session/registry.ts`, `tests/session-registry.test.ts`,
`tests/session-spawn.test.ts`, `docs/LIVE-SESSIONS-DESIGN.md`, and
this report.

## Review fixes, live1

**Intended commit:** `fix(session): apply the live1 review findings — per-turn init, pre-init turns, sink failures, honest trust and tools flags, guards, and docs`

Every finding from the live1 review, blocker through minor, is fixed
on this branch with the smallest correct change and a regression test
each. Labels below are short quotes from the findings, not codes.

**Blockers.** The parser treated every `system/init` after the first as
fatal, so any real second turn killed a claude/zai session (the
committed `zai-session-a.ndjson` fixture has one init per turn): a
subsequent init with the *same* session id is now tier-1 passthrough
and only a foreign or missing id is the tier-2 grammar error — the
fake now emits init per turn, the fixture-replay and parser tests pin
the split, and the two-turn proof below re-proves it live. And input
arriving before the init frame was forwarded but never opened its
turn, fataling the first result: the driver now counts pre-init inputs
and opens the queued turn at init (`queuedInputs`), pinned by the e2e
lifecycle test, which sends the user line before waiting for
`session_started` exactly the way the CLI relays caller stdin.

**Majors.** A rejected event sink cleared the queue without firing the
failure callback, so a stopped reader left the harness running and a
later stdin close could still "succeed": the queue now reports both
classes through one `OutboundFailure` union (`overflow` | `sink`), the
sink class latches and fires exactly once, and every driver ends the
session on it (pinned by the queue unit tests and the e2e
"a failing event sink ends the session with exit 1"). Codex approval
replies stringified numeric JSON-RPC ids (`id:42` answered as
`"42"`): ids are now carried with their original type through the
round-trip. All three drivers hardcoded `sandbox_trust: "standard"` in
their registry records, so a `--sandbox-trust trusted` session could
not resume at its own trust: the CLI's actual trust now threads
through to every record (e2e: "the sandbox trust is reported and
recorded as given"). And `claudeFamilyHarnessHome` honored
`CLAUDE_CONFIG_DIR` even without `--pass-env` while the child
environment removed it, so the registry could record a home the child
never used: the recorded home now honors a redirect only when the name
is passed through (unit test covering both cases).

**Security.** `codemux session -a codex` spawned in working
directories that ship `.codex/config.toml` or `.codex/rules/`, which
`run` refuses: the codex branch now runs
`assertNoCodexProjectExecutionConfig(workdir)` before spawn (CLI test:
exit 1, "refuses repository executable configuration").

**Contracts.** An unparsable `can_use_tool` request was never answered
deny: the driver now answers deny, reports it, and continues — never
fatal (e2e: "an unparsable can_use_tool is answered deny, reported,
and never fatal"). Design §4.8's start-time writable-set refusal
existed nowhere: a registry that would sit inside the working
directory or harness home is refused at start (exit 64; CLI test), and
`lookupForResume` treats containment as `untrusted` — the live B1 run
below tripped the start-time refusal for real when its temp home sat
inside the cwd. Pending permission requests are now superseded with
deny on interrupt and turn-timeout expiry, as §4.1 promises (e2e:
"an interrupt denies a pending request as superseded", "the turn
timeout denies a pending request as superseded too"). `--tools` was
documented as refused while codex accepted `default` silently: the
honest flag is false — no harness has a verified carrier — so the
refusal is now blanket at exit 64 (CLI test: "codex --tools is refused
like every other agent (honest capability flag)"), with the design
§4.7, README, and this report's step-6 note amended to say so.
`--enable-playwright-mcp` was missing from the session surface: it now
rides the same sandbox-scoped carrier as `run`, claude/zai only, with
the two refusal tests (without `--sandbox`, and for codex) and a
README row.

**Docs.** README's passthrough guarantee contradicted the code and
itself (it called unknown shapes fatal and promised non-JSON lines
were mirrored): rewritten to the real split — valid-JSON unknown
passes through and the session continues; a wire-grammar violation is
mirrored then fatal; non-JSON/non-UTF-8 is fatal with a bounded
excerpt instead of the line. README's owner-liveness sentence claimed
stale records get marked ended: now says resume is refused only while
the recorded owner is alive. The design doc's header said nothing was
implemented: it now states the branch and points here. CHANGELOG
folded the superseded-on-interrupt/turn-timeout rule, the
registry-placement refusal, and the playwright-mcp carrier.

**Minors.** Comment and test-contract fixes, each with the finding
named in place: `protocol.ts`'s inverted "everything but nothing"
sentence; `ceiling.ts`'s nonexistent bare high grant (the conclusion
stood, the citation did not); `claude-session.ts`'s wrong flag name
(`--permission-prompt-tool stdio`); `codex-driver.ts`'s
"Windows buffered" comment (it is the interrupt buffered while the
harness turn id was unknown); `agy-driver.ts`'s conversation-id
comment (the id is harness-issued, adopted from the first result);
the tautological `code === null || signal !== null || code !== null`
assertion in the process tests; the agy e2e comment claiming
`session_started` precedes the turn events (it follows them);
`sigterm-driver.ts` calling `process.exit(143)` inside the signal
handler against the documented contract; the registry test renamed for
what it actually pins (a symlinked *leaf* directory refused, symlinked
ancestors resolved and allowed); and the spawn parity test extended to
the environment byte-for-byte (shell artifacts filtered), with
`spawn.ts`'s doc now naming the one deliberate exception — run's
scode-accounting checks have no session counterpart because the
session surface exposes no accounting flags.

## Live-check discovery — the false "invalid-utf8"

**Intended commit:** `fix(session): report registry write failures and handler exceptions as codemux's own, never as unusable harness output`

Found while re-proving the per-turn-init fix live. A real zai session
died on its init frame with `unusable harness output (invalid-utf8,
5536 bytes)` — while the same line, tee'd on disk and re-decoded, was
pure ASCII and byte-identical to what codemux assembled. Two defects
stacked:

1. `updateRegistry` (`src/session/registry.ts`) violated its own
   outcome contract: `mkdirSync` of the registry directory threw
   straight past the driver's designed `!outcome.ok` branch. The
   trigger here is environmental — this sandbox denies `~/Library`
   writes, so the registry directory cannot be created — but any
   filesystem error on the write path escaped the same way. The
   outcome contract is now total: every unexpected throw inside
   `updateRegistry` returns `{ok:false, "cannot update the session
   registry: …"}`, so the driver's §4.8 fail-closed branch (an
   untracked live session must not run) is what fires.
2. `SessionProcess.deliver` wrapped `onLine(...)` inside the same
   try as the UTF-8 decode, so any exception the driver threw was
   recast as this layer's tier-3 `invalid-utf8` — blaming a perfectly
   valid harness line for a codemux failure (the misleading message
   is what made this bug expensive to find). A handler exception is
   now its own fatal class (`kind: "handler"`, carrying the error),
   and every driver's `handleFatal` reports it as
   `source: "codemux"` — "internal error while processing a harness
   line: …" — with the stack on stderr, never as unusable harness
   output. Riding the fatal channel keeps the end path (and its tree
   kill) running; a bare propagation was rejected because the
   rejection is unhandled until `runEndPath` reaches it, which Bun
   reports while the child is still alive — before any kill.

Regression tests: the registry unit test ("an uncreatable registry
directory fails as an outcome, never a throw" — a regular file where
the directory chain needs one), the process test ("a throwing onLine
becomes a handler fatal, never an invalid-utf8 one"), and two e2e
tests ("a registry start-write failure ends the session as a codemux
failure, not a harness one"; "a driver exception on a harness line is
a codemux fatal, never unusable harness output" — the latter injects
through the private `recordStart`, the seam the live failure actually
threw from).

**Live proofs (2026-10-05, through `./bin/codemux session -a zai
--no-sandbox --auto high`, key auto-read from `~/.zai`).** With the
ambient home, the same environmental EPERM now ends the session with
`source: codemux`, "cannot record the session in the registry: cannot
update the session registry: EPERM …", exit 1 — the designed
fail-closed path, no false tier-3 label. With a writable redirected
home (key staged at 0600, home outside the working directory — the
first attempt sat inside it and was correctly refused at exit 64 by
the §4.8 start-time check), the full two-turn exchange completed:
`session_started` (agent zai), turn 1 `end` replying "one", the
second user line accepted, turn 2 `end` replying "two" with its
per-turn init passing through as tier-1 unknown (the blocker's wire
fact, now proven on the real 2.1.280 stream rather than the fixture
alone), clean shutdown, exit 0, and the registry recording the session
(agent zai, autonomy high, ended). The non-delta `stream_event`
frames, `system/status` frames, and the replay echo all passed through
as `unknown` exactly as documented. Spend: 2 completed turns
(39,352 total tokens, $0.23) plus the fail-closed run, which dies at
init before any turn completes.

**Gate.** `bun run typecheck` exit 0. Full suite with the host
condition reproduced (symlinked TMPDIR, `--max-concurrency=1`):
**1078 pass / 0 fail / 6 skip across 1084 tests in 49 files** — the
pre-review gate was 1058/0/6 across 1064 in 49, so the review fixes
and this discovery add 20 tests with no regressions. `make
release-gate` stops at the same documented environmental `contracts`
stage as steps 1–9 and the host fixes (installed copilot `--help`
needs `mkdir ~/Library/Caches/copilot/pkg/darwin-arm64`, EPERM under
this sandbox's `~/Library` denial; re-verified identical); run past
the stop, every other component passes — runtime, check, and the
sandbox-contract, smoke, `bun audit` (0 vulnerabilities),
frozen-lockfile dry-run, and help-flag smoke set all exit 0.
`check_american` clean on every file this batch touches.

## Review fixes, live2

**Intended commit:** `fix(session): live2 review fixes — no-dedupe claude frames, honest deliverability, exit-code honesty`

Four auditors reviewed the live-sessions tree (correctness, security,
contracts ×2); every finding, blocker through minor, is fixed here with
the smallest correct change and a regression test each.

**Blocker — the claude-family parser deduplicated assistant frames by
`message.id`** (`src/session/claude-session.ts`). The recorded wire
sends one content block per frame under a shared id — the dedupe
dropped real sibling blocks (zai-permission.ndjson lost its Bash tool
call after a thinking block; zai-permission2.ndjson lost its final
text). The dedupe is removed; sibling frames all parse. Usage was never
read from assistant frames and still is not — turn usage comes from the
turn's `result` event only. Regression: the dedupe test rewritten as
"sibling assistant frames sharing a message id all parse", plus a
fixture-replay describe replaying both committed fixtures end to end
(asserting the Bash tool call and the final text survive).

**Security major — a `..` after a missing directory escaped the
medium-autonomy path check** (`src/session/ceiling.ts`,
`pathInsideScope`/`resolveRealPath`). An absolute target went to
`resolveRealPath` as written; that helper realpaths the deepest
existing ancestor and re-attaches the rest unnormalized, so
`<launch>/nonexist/../../etc/x` started with the scope prefix and was
called allowable while the harness would resolve it to `/etc/x`. The
joined path is now `resolve`d before comparison. Regression:
"a `..` after a missing directory cannot walk out of the scope"
(the dangerous spelling is built as a template string — `join` would
lexically normalize the `..`s away and never exercise the bug).

**Major — an oversized caller line's remainder was parsed as a second
command** (`src/session/cli.ts`, `frameCallerStdin`). After the cap
rejection the framer resumed mid-line; the same physical line could
produce a second synthetic rejection or a `{"type":"shutdown"}` parse,
chunk-boundary dependent. The framer now discards through the line's
terminating newline — one rejection per physical line. Regression: a
spawned CLI fed one 17 MiB-plus-spaces line followed by a shutdown
object asserts exactly one `input_rejected` and a `stdin-close` end,
never a parsed shutdown.

**Major — input that cannot reach the harness was acknowledged**
(`src/session/driver.ts`; codex-driver.ts and agy-driver.ts the same).
A caller line at the 17 MiB cap acks fine and then frames past the
harness stdin write limit; the failed write printed a diagnostic while
the turn hung open. Two fixes: drivers now pre-validate deliverability
before the ack — the exact harness frame where it is fully buildable at
ack time (claude/agy: `harnessLineDeliverable`), a conservative 1 KiB
margin where frame ids are assigned only at send (codex:
`harnessTextDeliverable`) — rejecting `text_too_long`; and a
`writeToHarness` failure is now a fatal codemux error ending the
session, not a silent diagnostic (guarded by `finished` so end-path
writes stay silent). Regressions per driver: a 16 MiB text asserts the
`text_too_long` rejection with no turn started, and an injected
stdin-write failure mid-session asserts the fatal codemux error and
exit 1.

**Major — a failed final-event delivery reported success**
(`src/session/driver.ts`; codex/agy the same). Shutdown had already set
`finished`, so the flush rejection was swallowed and the process exited
0 with the `session_ended` event undelivered. `finish()` now tracks
whether the final event was actually delivered (queue-accepted and
flushed within a 1 s give-up) and reports exit 1 otherwise. Regression
per driver: a sink throwing on `session_ended` asserts exit 1.

**Major (contracts) — `usage_stream: true` was dishonest for
claude/zai.** The capability advertised a stream the driver never
emits: usage arrives only in the turn's `result`. The flag is now
`false` for claude and zai in the code and in every matrix
(docs/HARNESS-COMPATIBILITY.md, README, design §4.2), codex keeps
`true` (`thread/tokenUsage/updated`), agy stays false. Regression: the
capability assertions pin `usage_stream: false`.

**Minors.** The outbound queue's overflow failure re-fired on every
further enqueue against its "exactly once each" docstring — both
classes now latch (process.ts, with a regression test). The
registry-sits-inside-writable-set resume guard returned `untrusted`
mapped to exit 66, the missing-entry code; it is a policy refusal and
now exits 78 (cli.ts, regression through a seeded registry). The dead
`codexCeiling`/`patchTargets` pair — a second codex predicate only
tests consumed, able to drift from the live `codexApprovalCeiling` — is
deleted with its tests (design §4.2's usage-accounting wording and the
`scope` field that no code ever emitted are corrected in the same
pass). The ceiling header's "fail-closed everywhere" now states the low
exception, and `launchScope` decodes `grantRule("/")` so a root launch
directory grants medium edits instead of denying every one with a
misleading reason (both with regressions). Docs: the panel plan's
probe-disproven `--permission-prompts host` replaced with
`--permission-prompt-tool stdio`, its `--tools none` understatement
replaced with the blanket any-value refusal the code ships, the
design's transitional "fails closed until the registry lands" sentence
replaced with the shipped 66/78 split, the agy installed-version
records corrected to 1.2.16-with-1.2.14-floor, and the ledger's stale
"planned live-sessions release" wording updated. Comment honesty: the
agy fake's `wrongid` scenario notes the mismatch check needs an adopted
id; the codex driver header names approvals as the one surface without
recorded-reality backing; the agy e2e ordering assertion pins both
sides.

**Live re-proof (2026-10-05, one zai turn through
`./bin/codemux session -a zai --no-sandbox --auto high`, key auto-read
from `~/.zai`, HOME redirected to a writable staged-0600 home outside
the working directory and trashed after).** The blocker's fix on the
real wire: a turn engineered for sibling content produced the text
frame "Banana." and the Bash `tool_use` frame under one shared id
(`msg_202610051245121f3b92f2dc87427b`) — both surfaced (`assistant_message`,
then `tool_call` Bash running `echo live2-shared-id-proof`, its
`tool_result`, the final `assistant_message` "shared-id ok",
`turn_completed` finish `end`), clean shutdown, exit 0, the registry
recording the session (agent zai, autonomy high, ended), and session
usage taken from the turn's result alone (input 40,589 / output 34 /
cached 768 / total 41,391, $0.16). Spend: one completed turn. The run
also pinned a wire fact the fixtures could not show: 2.1.280 emits its
first `system/init` only once stdin input arrives, so the user line
must be submitted without waiting for `session_started` — recorded in
the compatibility ledger's claude contract. (The session floor is
satisfied — installed 2.1.280 equals the floor; the launch prints the
usual newer-than-run-maxAudited warning every launch on this machine
prints.)

**Gate.** `bun run typecheck` exit 0. `bun test --max-concurrency=1`:
**1091 pass / 0 fail / 6 skip across 1097 tests in 49 files** — the
pre-review gate was 1078/0/6 across 1084 in 49, so the review fixes
add 13 tests net (16 new, 3 dead `codexCeiling` tests removed) with no
regressions. `make release-gate` stops at the same documented
environmental `contracts` stage (installed copilot `--help` needs
`mkdir ~/Library/Caches/copilot/pkg/darwin-arm64`, EPERM under this
sandbox; 2 pass / 1 fail in that file, version probes exercised across
the installed set); run past the stop, every other component passes —
runtime, check, sandbox-contract, smoke, `bun audit` (0
vulnerabilities), frozen-lockfile dry-run, and the help-flag smoke set
all exit 0. `check_american` clean on all 51 changed `.ts`/`.md` files.

## Review fixes, live3

**Intended commit:** `fix(session): live3 review fixes — bounded final flush, atomic registry claim, dangling-symlink denial, move-destination judgment, honest steer flag, docs`

Four auditors reviewed the live-sessions tree again (correctness,
security, contracts); every finding, major through minor, is fixed here
with the smallest correct change and a regression test each. No finding
was a blocker this round.

**Correctness major — a stalled final flush reported success**
(`src/session/driver.ts:722`; `src/session/codex-driver.ts:1058`;
`src/session/agy-driver.ts:525`). `finish()` raced the final flush
against a 1 s give-up and, on give-up, resolved with the session's own
exit code — so a sink that accepted the last event but never returned
(a stalled broker reader) reported success with `session_ended`
undelivered. All three drivers now share one helper,
`awaitFinalFlush(queue, giveUpMs)` (`src/session/process.ts`): it
awaits the flush with the same 1 s bound, and on give-up it calls the
queue's new `abandon()` — dropping the entries and releasing a `flush()`
that was waiting on the stalled sink — so the end path always resolves,
and reports `false`, which forces the exit code to at least 1. The
happy path clears its timer and never delays exit. Regression per
driver: "a sink that stalls on the final event still resolves run()
with exit 1" (the sink returns a never-settling promise on
`session_ended`). Queue-level regressions in `session-process.test.ts`:
`abandon` drops entries and releases a stalled flush;
`awaitFinalFlush` reports stalled as undelivered, completed as
delivered, throwing as undelivered.

**Correctness minor — concurrent resumes could overwrite live
ownership** (`src/session/registry.ts:273`). Two `--resume` starts of
the same id both read a dead owner, both updated the entry, and the
second overwrote the first's `owner_pid` — two live codemux processes
believing they owned one session. `updateRegistry`'s mutate callbacks
now return an error string on failure (null on success), and
`recordSessionStart` claims ownership atomically under the writer lock:
an entry with a different live owner (`owner_pid` plus `owner_start`,
judged by the process table, degrading to signal-0) fails the write
with `session_busy`, and the loser dies through the existing
fail-closed registry-start path (exit 1, nothing launched). A
self-owned or dead owner still updates in place, preserving the
documented resumed-session semantics. The registry stays what it was: a
lookup hint that decides who owns the record, never an authorization
boundary. Regression: "a start cannot steal a live foreign owner's
record (atomic claim)" seeds a genuinely live `sleep 30` child as owner
and asserts the refusal, then kills the child and asserts the in-place
update once liveness flips.

**Security major — a dangling symlink defeated the medium ceiling**
(`src/session/ceiling.ts:157-172`). `resolveRealPath` realpaths the
deepest existing ancestor; for `<scope>/link -> <outside>/not-there-yet`
the symlink itself throws, the walk fell back to the scope root, and a
path whose destination was entirely outside the scope was judged
allowable. A symlink whose realpath threw is now unjudgeable: the catch
lstats the probe and, if it is a symlink (dangling or looping), returns
null → deny ("cannot resolve target path"). The fix is shared — the
claude-family ceiling and the codex approval ceiling both go through
`pathInsideScope`/`resolveRealPath`. Regression: "a dangling symlink
denies, even though its name sits inside the scope" (with an
ordinary missing in-scope file as the allowing control).

**Security minor — the codex session was described as carrying
`--ignore-rules`** (`src/session/codex-session.ts:182-200`). It does
not. The thread-level `config` object carries exactly
`{project_doc_max_bytes: 0, project_doc_fallback_filenames: []}` — the
AGENTS.md-skip pair; execpolicy rules (`~/.codex/rules`) have no
verified thread-config carrier, so a codex session still loads them
where a run does not. The code is unchanged (a fake carrier would be
dishonest); the comment, the design (§4.7), the compatibility ledger,
and docs/HERMETIC.md now record the parity gap instead. The gap is
unreachable through any launchable session today — every one runs
`approvalPolicy: "never"` inside scode — but `run`'s boundary flag does
not carry over, and the ledger says so. Regression: the thread/start
test pins the config to exactly those two keys, so the gap stays
visible.

**Security minor — a codex move was judged by its source only**
(`src/session/codex-session.ts`, `fileChangePaths`). A patch change of
`kind.move_path` writes the file at the destination, and the ceiling
never saw it: `move_path: "/etc/codemux-outside.txt"` on a
medium-scoped thread was allowable. `fileChangePaths` now includes the
move destination alongside the source and fails closed — a non-string
or empty `move_path` makes the whole change unparsable (deny). The
shape follows openclaw's `PatchChangeKind`
(`{diff, kind: {type, move_path}, path}`, `move_path: string|null`).
Regression: "an update's move destination is judged with its source"
(move inside allows at medium, move outside denies with "resolves
outside the launch directory", `move_path: null` is no move and allows,
`move_path: 7` denies).

**Contracts — honest capability flags (README:525/553).** The README
and matrices steered callers to `steer` on claude/zai. The claude
family's `steer` is now `false` in `claudeSessionCapabilities()`: the
wire has no in-turn steering carrier — probe 3 and the
`zai-session-a.ndjson` fixture show a mid-turn `user` message queues to
the next turn — and advertising one would hand a caller an input the
harness never shapes. The protocol's existing capability gate
(`protocol.ts`, before the `no_active_turn` check) rejects a `steer`
line with `unsupported`, so the flip is the whole change; the dead
`case "steer"` arm in `driver.ts` is removed rather than kept behind a
flag that can never reach it. `user` is the documented carrier for
mid-turn input on claude/zai (it queues); codex keeps `steer: true`
(`turn/steer`). Regressions: the e2e lifecycle asserts
`capabilities.steer === false`, and the old steer test is rewritten as
"steer is rejected unsupported; a queued user message is the honest
mid-turn carrier" (steer mid-turn → `input_rejected` `unsupported`;
then a mid-turn `user` plus interrupt → turn 1 interrupted, turn 2
completes with the message answered).

**Contracts — the README named a nonexistent `deltas` event
(README:545).** The code emits `assistant_delta`. The event list is
corrected; the capability flag stays `deltas` (it gates the event, it
is not one). Design §4.2 already matched; no code change.

**Contracts — `--timeout` expiry's exit code was undocumented
(README, cli.ts header, design §4.6).** Expiry runs the shutdown path
and exits 1 with `session_ended.reason: "timeout"` — the one thing that
distinguishes it from a failure at that exit code, and a broker reading
the code alone could not tell them apart. The README's exit-codes
paragraph, the CLI's header, and design §4.6 now all say it.

**Contracts — two stale claims in the panel doc**
(`docs/LIVE-SESSIONS-PANEL.md`). F36 still described the usage dedupe
live2 removed; it now states the shipped behavior (`message.usage` on
assistant frames is never read, there is no dedupe, and deduping by id
would drop real sibling blocks). F28 named `owner_start_ms`; the field
is `owner_start`, the opaque process-start token.

**Contracts — the design bracketed `[--include-partial-messages]` as
optional (design §4.7).** It is unconditional — partial messages are
the `deltas` carrier every launch wants, and `--verbose` the same. The
brackets are removed and a sentence states both flags are unconditional
with no flag to omit either. (The same block's effort-override and
`--ignore-rules` sentences are corrected in the security-minor item
above.)

**Live checks.** None run this round, by decision: every fix is either
a codemux-internal path proven by the new regressions (final-flush
give-up, registry claim, symlink denial, move judgment) or a
restatement of a fact the step-0 probes already proved live — the steer
flip restates probe 3's recorded next-turn delivery, which
`tests/fixtures/live/zai-session-a.ndjson` pins. No new wire claim is
made, so nothing needs re-proving against the endpoint.

**Gate.** `bun run typecheck` exit 0. `bun test --max-concurrency=1`:
**1099 pass / 0 fail / 6 skip across 1105 tests in 49 files** — the
live2 gate was 1091/0/6 across 1097 in 49, so this round adds 8 tests
net (two queue-level, one registry claim, one dangling symlink, one
move-destination, three stalled-sink e2e; the old steer e2e is
replaced by the honest-carrier test rather than added, its assertions
carried over) with no regressions. `make release-gate` stops at the same
documented environmental `contracts` stage (installed copilot `--help`
needs `mkdir ~/Library/Caches/copilot/pkg/darwin-arm64`, EPERM under
this sandbox) — unchanged from the live2 gate; run past the stop, every
other component passes. `check_american` clean on all changed `.ts`
and `.md` files.

## Review fixes, live4

**Intended commit:** `fix(session): live4 review fixes — attach-window stop, startup shutdown, rejected interrupts, containment-flag resume guard, honest agy usage, keep-semantics sums, docs`

Four auditors reviewed the live-sessions tree a fourth time
(correctness, security, contracts); every finding, blocker through
minor, is fixed here with the smallest correct change and a regression
test each.

**Correctness blocker — a signal before attach stranded the harness
process** (`src/session/codex-driver.ts:208-221`; `src/session/driver.ts:164-177`;
`src/session/agy-driver.ts:159-172`; the finding named codex, the window
is every driver's). The signal handlers are installed at driver
construction, but the child is attached only after the CLI's async
spawn; a SIGTERM in that window ran the end path with no child to
stop — the driver finished, then the spawn completed and attached a
harness nothing would ever stop. `attach()` now assigns the process and,
when the driver is already finished, stops it at once (`requestStop()`:
synchronous SIGTERM, tree kill at grace end); `run()` on a finished
driver returns the recorded code instead of starting the session. The
guards close the window without narrowing the public surface:
`handleCallerEnd()` before attach is the same end a signal produces.
Regressions, one per driver: "a signal that fires before attach stops
the child instead of stranding it" — end the driver pre-attach, spawn
the fake, attach, and prove `run()` resolves 0 while the child exits
(a 4 s race against `proc.exited`).

**Correctness blocker — shutdown hung behind Codex initialization**
(`src/session/codex-driver.ts:301-316`). The starting-state input branch
buffered every caller line until the `initialize` response arrived, so
with a stalled init a `shutdown` got no ack, no stop, and an unlimited
default session timeout kept the process alive until something external
killed it. The starting branch now parses a peek of each line without
consuming a seq: a `shutdown` is acked (the seq assigned then, and only
then — replay assigns seqs for buffered lines, so the peek must not
count) and ends the session immediately; everything else still buffers
for replay. Regression: "a shutdown that arrives while the handshake is
stalled still ends the session" — a new `FAKE_STALL_INIT` mode in the
fake app-server records the `initialize` request and never responds;
the test sends shutdown at once and asserts exit 0, reason `shutdown`,
no `session_started`, and that whatever the fake recorded before the
SIGTERM is handshake-only (its bun startup races the kill, so the file
may be empty — the assertion is race-free, not `["initialize"]`).

**Correctness blocker — a rejected interrupt recast the turn's real
completion** (`src/session/codex-driver.ts:697-700`). The app-server can
reject a `turn/interrupt` (a turn in an uninterruptible state);
`applyResponseError` surfaced the non-fatal error but left
`interruptPending` set, so when the turn later completed on its own,
`completeTurn` overrode the finish to `interrupted` — the caller was
told the turn was interrupted after the harness had refused exactly
that. A rejected interrupt never happened: both pending flags are
cleared before the error is emitted, and the turn's real completion
stands. Regression: "a rejected interrupt leaves the turn's real
completion standing" — a new `refuseinterrupt` scenario in the fake
(emit a commentary "Uninterruptible" message, hold, reject the
interrupt with an error response, then complete the turn) pins the
non-fatal error naming the rejection, `finish: "end"` with no
`interrupted`, the interrupt recorded exactly once, and the session
surviving a second turn.

**Security blocker — `--sandbox-no-net`/`--sandbox-scrub-env` were
neither recorded nor resume-checked** (`src/session/registry.ts:54,115,357,435-446`;
recording in all three drivers; `src/session/cli.ts:365,469,552,569,585`).
A session created under those boundaries recorded only
`sandboxed`/`sandbox_trust`, so a resume without the flag passed every
guard — and design §4.8's "containment may not drop below creation"
let a prompt-injected transcript run with network and the full
environment creation never allowed. The registry entry gains
`sandbox_no_net`/`sandbox_scrub_env` (strict key-set validation
extended, so a stale registry fails closed as corrupt, not silently
reinterpreted); `ResumeProbe` gains the flags the resuming command
effectively runs with, and a resume may not clear either — one-directional
like trust: adding a boundary only tightens. The probe reads the
resolved sandbox options, not raw argv — `--sandbox-no-net` without
`--sandbox` is a warned-and-ignored bit (`parseSandboxPolicyOverrides`),
and the guard must judge the containment the resume actually runs at.
Regressions: "a recorded --sandbox-no-net or --sandbox-scrub-env may
not be cleared on resume" (registry level: each flag dropped refuses
naming its `--sandbox` flag, both kept resumes, a plain entry resumes
with both added — one-directional), and "a session created with
--sandbox-no-net refuses a resume that drops it, argv or not" (CLI
level: a seeded entry refuses an unsandboxed resume at 78, and passing
the raw `--sandbox-no-net` flag unsandboxed still refuses, pinning the
resolved-options probe).

**Contracts — agy reported `usage_stream: false` while emitting
standalone `usage` events** (`src/session/agy-driver.ts:401`). The flag
said usage arrives only in the turn's result envelope; the driver also
emitted a per-turn `usage` event, and the e2e test pinned both halves
of the contradiction. The honest contract is the one the flag already
described — the same carrier claude/zai ship — so the emission is
removed rather than the flag flipped (the agy wire has no usage
notification stream to stream; surface removed, not hardened). Usage
rides `turn_completed.usage` and the session cumulative on
`session_ended.usage`. Regression: the agy lifecycle test now asserts
no `usage` event exists after the turn has completed (absence after
completion is settled, not early).

**Contracts — the `--tools` help text implied `default` was accepted**
(`src/session/cli.ts:293`). "Tool selection: default ('none' is refused
for sessions)" suggested `default` works; every value refuses with 64
(no verified carrier on any harness). The help now states the refusal
outright, the way `--hermetic`'s entry does: "Tool selection (refused
for sessions in this release)". Regression: "the --tools help text
says the flag itself is refused" asserts both the flag line and the
phrase against whitespace-collapsed output (commander wraps the
description, and the wrap point must not be able to break the test).

**Contracts — one partially-reporting turn nulled the session
cumulative** (`src/session/usage.ts:11`). `addUsage` returned null for
the sum whenever either side was null, so a turn reporting no cache
counts nulled the cumulative's known `cached_input_tokens` for the
whole session, in all three drivers — the `zeroUsage` comment even
claimed "the session total keeps what it has" while the code did the
opposite. The sums are now
keep-semantics: a null side yields the other side, two nulls stay
null, and no field is ever guessed as zero — the same honesty rule the
run path's null-usage paragraph already states (an unreported counter
is not a measured zero). `zeroUsage` is deleted (the cumulative starts
`emptyUsage()`, all-null: a counter no turn ever reported must stay
null, not 0). Codex's `accumulateUsage` — first delta replaces, later
ones add — is unchanged and now documented as the deliberate contrast.
Regression: new `tests/session-usage.test.ts` (five tests: field-wise
sum, null-yields-known both directions, two nulls stay null, the
live4 wipe defect exactly, `accumulateUsage`'s replace-then-add).

**Contracts — the design claimed a resumed codex thread's first update
"yields nulls for that turn, honestly"** (`docs/LIVE-SESSIONS-DESIGN.md:518`).
No such rule exists in code — the doc/code disagreement the auditor
flagged. The passage now states the real contract: each
`tokenUsage/updated` notification's `last` delta is its own `usage`
event with `raw` preserved (codex's `usage_stream: true` is honest —
it really has a stream), deltas fold into `turn_completed.usage`
first-replaces-then-adds, the session cumulative is the running sum of
completed turns with keep-semantics, and resume changes nothing (no
baseline is subtracted; deltas count from the first update the resumed
process sees). The registry sketch (§4.8) and the containment resume
rule gain the two new flags, and the panel doc's F36 — which carried the
same stale nulls claim — states the real contract too.

**Live checks.** None run this round, by decision: every fix is either
a codemux-internal path proven by the new regressions (attach-window
stop, startup shutdown, interrupt clearing, registry guard, usage
arithmetic) or a correction of what the docs claim — the agy event
removal restates a contract the recorded fixtures already pin, and no
fix changed what a real harness sees on its wire (no argv, env, or
protocol change). No new wire claim is made, so nothing needs
re-proving against the endpoint.

**Gate.** `bun run typecheck` exit 0. `bun test --max-concurrency=1`:
**1112 pass / 0 fail / 6 skip across 1118 tests in 50 files** — the
live3 gate was 1099/0/6 across 1105 in 49, so this round adds 13 tests
(three codex e2e, one claude e2e, one agy e2e, one registry, two CLI,
five usage in the new `tests/session-usage.test.ts`) with no
regressions and no removals. `make release-gate` stops at the same
documented environmental `contracts` stage (installed copilot `--help`
needs `mkdir ~/Library/Caches/copilot/pkg/darwin-arm64`, EPERM under
this sandbox) — unchanged from the live2/live3 gates; the `runtime`
and `check` stages pass before the stop, and run past it, every other
component passes. `check_american` clean on all 18 changed `.ts` and
`.md` files (exit 0).

## Review fixes, live5

**Intended commit:** `fix(session): live5 review fixes — signal gate through cleanup, the shutdown drain, both-spelling scope judgment, exit-64 funnels, honest comments and docs`

Four auditors reviewed the live-sessions tree a fifth time
(correctness, security, contracts); every finding, blocker through
minor, is fixed here with the smallest correct change and a regression
test each (per driver where the defect repeated).

**Correctness major — the signal gate was disposed before cleanup
completed** (`src/session/driver.ts:713`, `src/session/codex-driver.ts:1065`,
`src/session/agy-driver.ts:515` — every driver's `finish()` disposed
`signals` early in the end path). A second SIGINT/SIGTERM during the
grace window then hit Node's default disposition: codemux died
mid-kill and the harness tree it was stopping survived it. The gate now
stays installed until the child has settled and `session_ended` is
delivered; its fire-once latch absorbs the repeat signals.
Regressions, one per driver: "signal handlers stay installed until
cleanup completes" — read the three signal listener counts after
`shutdown` has run finish()'s synchronous prefix (deterministic: the
awaits from `proc.settled` onward resume only on a later event-loop
turn), assert the gate's three listeners still installed, then gone
exactly after `run()` resolves.

**Correctness major — shutdown silently discarded the harness's final
output and usage** (the `if (this.finished) return` guards in every
driver's harness-line path). The auditor's local test: a successful
final result during shutdown produced no `turn_completed`, a
null-usage `session_ended`, exit 0 — the grace window existed precisely
for that output and dropped it. The fix splits the end path's two
concerns: `finished` stays the re-entry guard (flips at `finish()`
start), while a new `settled` flips only after the child settles
(`src/session/driver.ts:132` and its two siblings). Harness lines are
parsed and emitted through the whole drain; the FSM's
`shutdown_started`/`ended` transitions wait until settlement so a turn
completing mid-drain leaves `turn_active` through its own
`turn_completed`; a first result still adopts the session identity and
completes its turn mid-drain; the codex end-interrupt became a real
correlated JSON-RPC call (its response now arrives during the drain and
the normal handlers consume it — the old uncorrelated string id would
have hit the unknown-request-id fatal). One subtlety the new tests
caught: the drained init of a registry-failed start must not announce
`session_started` — the announcement now follows the record's verdict
(a required record that failed announces nothing, §4.8's fail-closed
rule; `settled` alone was the wrong guard). Regressions, one per
driver: "the shutdown drain delivers the harness's final output" over
a new `FAKE_SIGTERM_PERSIST=1` mode in all three fakes — the fake
survives the shutdown SIGTERM 300 ms, answers the end-interrupt (claude,
codex) or completes the open turn (agy), and the drained
`turn_completed` (finish `interrupted`, its usage) plus the folded
`session_ended.usage` must reach the caller before exit 0. The fakes
document that this mode proves codemux's drain, not a claim about real
harness SIGTERM behavior.

**Security major — a `..` after a missing directory could route an edit
through a symlink out of the launch directory**
(`src/session/ceiling.ts:266`, `pathInsideScope`). The scope check
judged one spelling of the target; `<scope>/gone/../link/settings.json`
(`gone` missing, `link → ~/.claude`) kept the link's name inside the
scope while the write followed it out, and the auditor's proposed
pre-resolve fix leaves the mirror shape `<scope>/link/../x` open. The
fix judges two spellings and requires both inside: the kernel spelling
— every symlink expanded where it stands, in namei order, so a `..`
after a link names the target's parent — and the lexical spelling
(`..` collapsed before any link is followed). Two rounds of this fix:
the first draft trusted `realpathSync` for the kernel spelling, and the
new regression test caught that macOS realpath collapses `link/..`
lexically too (returns the link's parent, not the target's) — so
`expandSymlinkComponents` (`src/session/ceiling.ts:207`) now expands
links itself, bounded like ELOOP, refusing a link whose target cannot
be resolved where it stands (the live3 dangling-link rule keeps its
"cannot resolve" verdict). The claude-family ceiling and the codex
approval ceiling share the predicate, so patch approvals are covered by
the same fix. Regression: "a `..` over a missing directory cannot route
through a symlink, in either spelling" — both attacks deny, and the
control (the same `..` over the same missing directory with no symlink)
still allows, pinning that only the disagreement denies.

**Contracts major — a malformed `--permission-timeout` or
`--shutdown-grace` exited 1** (`src/session/cli.ts:383`): the two
session-only timeouts were parsed with a bare call whose throw landed
in the outer catch (exit 1, an internal error) where every other bad
flag value is usage. Both now go through the same
`parseOptionalTimeout` funnel as `--timeout`/`--turn-timeout` (exit 64,
the flag named). Regression: "a malformed --permission-timeout or
--shutdown-grace refuses with 64", both flags.

**Comment and doc honesty** (eight findings, no code change): the
ceiling module's header claimed low autonomy skips the schema check —
the table runs it before low's fast path for known tools, and the
header now says so (`src/session/ceiling.ts:1`). The codex driver
claimed "no event ever carries an empty session id" /
"impossible by construction" — the starting-state shutdown ack and the
handshake-failure fatals do; the comment now names both classes and
cites the agy driver's precedent for the same window. The FSM header
overstated tier 2 as always mirroring `unknown` — FSM-error paths emit
only the fatal; which shapes mirror is the driver's call, and the
header says that. The codex session matrix comment said read-only
denies "both kinds" of approval (three) and "below low" (above low).
The registry comments' pid-reuse parentheticals: `processIdentityAlive`
needs the token AND a readable table for the identity check, otherwise
bare pid existence; a null `owner_start` makes every later check
pid-only wherever it runs. The fixtures README claimed "timestamps are
dropped" — the sanitizer drops only the probe driver's own `ts` stamp;
harness-carried timestamps (codex `emittedAtMs`/`startedAtMs`, the zai
result `timestamp`) survive, and the README now says which. The design
doc's §4.2 `usage` bullet claimed "emitted per turn" — the event exists
only where `usage_stream: true` (codex), once per notification, and the
harnesses without a stream never emit it; the bullet now states the
capability-gated contract its own accounting passage already pinned.
The design doc's §4.7 claude/zai spawn block omitted the unconditional
`--replay-user-messages` the code and plan text carry; it is in the
block and the unconditional-flags sentence. HERMETIC.md's resume-guard
summary named three of the eight guards; it now enumerates them all.
The report's step-4 "the exact 14 fields" predates live4's
containment-flags fix; the supersession is marked in place. The design
doc also gains what this round's code now implements: §4.6 states the
grace-window drain and the signal gate's lifetime, and the README's
lifecycle sentence with them.

**Fixture defect — the badask deny answered the wrong request**
(`tests/fixtures/live/fake-claude-session.ts`): the `badask` scenario's
deny branch answered `toolu_ask_1` — the ask scenario's id — instead of
the request it was actually denying (`toolu_bad_1`). Both branches now
key the answer by the pending request's own id, the same discipline the
real control-response writer enforces. (Covered by the existing badask
e2e, which pins the session surviving the deny; the id is now the
correct one under it.)

**Live checks.** None run this round, by decision: every fix is a
codemux-internal path proven by the new regressions (gate lifetime,
drain, both-spelling judgment, the parse funnel) or a correction of
what comments and docs claim. Nothing a real harness sees on its wire
changed — the codex end-interrupt now sends the exact correlated frame
the mid-turn interrupt path (fixture-pinned, live-probed in step 0)
already sent, and the persist-mode fakes explicitly model codemux's
drain rather than real SIGTERM behavior. No new wire claim is made, so
nothing needs re-proving against the endpoint.

**Gate.** `bun run typecheck` exit 0. `bun test --max-concurrency=1`:
**1120 pass / 0 fail / 6 skip across 1126 tests in 50 files** — the
live4 gate was 1112/0/6 across 1118 in 50, so this round adds 8 tests
(two e2e per driver — the gate and the drain — plus one ceiling and
one CLI) with no regressions and no removals. `make release-gate`
stops at the same documented environmental `contracts` stage (installed
copilot `--help` needs `mkdir ~/Library/Caches/copilot/pkg/darwin-arm64`,
EPERM under this sandbox — unchanged since the live2 gate); `runtime`
and `check` (typecheck, the full suite, coverage) pass before the
stop, and run past it `sandbox-contract`, `smoke`, `bun audit` (no
vulnerabilities), `bun install --frozen-lockfile --dry-run`, and the
CLI help smoke all pass. `check_american` clean on all 24 changed
`.ts` and `.md` files (exit 0).

## Review fixes, live6

**Intended commit:** `fix(session): live6 review fixes — unjudgeable path spellings deny, the registry path in resume refusals, dead addDirs removed, doc and comment honesty`

Two auditors reported this round (security, contracts; a second
contracts auditor's weekly quota was exhausted with no findings).
Every finding, blocker through borderline, is fixed here with the
smallest correct change and a regression test each where behavior
changed.

**Security blocker — `~`-relative and whitespace-padded targets escaped
the medium ceiling** (`src/session/ceiling.ts`, `pathInsideScope`).
Claude Code's Edit, Write, and NotebookEdit tools expand a leading `~`
or `~/…` to the home directory and trim surrounding whitespace BEFORE
they write; the scope check resolved both spellings as ordinary relative
names inside the launch directory. Worked example: at `--auto medium`,
a prompt-injected `Write {file_path: "~/.bashrc", …}` (or a caller
`allow` whose `updated_input` carries it — the ceiling judges the
merged input, driver.ts) resolved to `<launch>/~/.bashrc`; no `~`
component exists, so the deepest existing ancestor was the launch
directory itself and the verdict was "allowable" — codemux answered
allow and the harness wrote `$HOME/.bashrc`. The same held for
`" /etc/hosts"` (leading space): not absolute, joined to a
scope-prefixed string, judged inside while the harness trimmed and
wrote `/etc/hosts`. scode does not stop the write (the standard-trust
profile is allow-by-default on macOS and binds `$HOME` read-write on
Linux), and `run` is unaffected because its `Edit(//launch/**)` grant
is matched after Claude has already expanded the path — the session
answer path was the only judgeable boundary, and it was wrong. Fix, at
the shared predicate: a target with surrounding whitespace or a
`~` prefix denies fail-closed ("cannot judge target path …
(whitespace-padded or ~-relative)") — codemux refuses spellings whose
meaning varies by reader instead of trying to replicate Claude's
expansion, which would lean on unverified rules. The `~` refusal is
deliberately blanket on `~`-initial spellings (a file literally named
`~x` is pathological, and splitting `~` from `~user` would guess at
expansion rules codemux has not recorded); plain relative and absolute
targets are judged exactly as before — the design's `Edit ./notes.md`
medium example still allows. The predicate is shared, so the codex
approval ceiling (patch paths, move destinations) inherits the same
refusal. Class audit: every path judgment in the session surface flows
through `pathInsideScope` (claudeCeiling medium's `file_path` /
`notebook_path`, `codexApprovalCeiling` over `fileChangePaths`); the
registry's containment checks compare codemux-computed paths (workdir,
harness home), never model-controlled spellings, so no sibling defect
exists there. Regression: `tests/session-ceiling.test.ts`, "a
~-spelled or whitespace-padded target denies: codemux cannot judge
where the write lands" — six attack spellings (`~/.bashrc`, `~`,
`~zshrc`, `" /etc/hosts"`, `"/etc/hosts "`, `" ~"`) deny, and the
plain-relative control still allows, pinning that only the unjudgeable
spellings deny.

**Contracts minors, all doc/comment drift with the code already on the
fail-safe side** (the auditor verified the suite pins the correct side
of each):

1. *The tier-2 mirror promise* — README and design §4.2 claimed every
   wire-grammar violation is mirrored as `unknown` and then fatals. The
   split is real and deliberate (the fsm.ts header has said so since
   live5): parser-caught violations (foreign or missing session id, a
   second thread announcement, an unknown thread/turn reference)
   mirror the raw line then fatal, while driver-caught lifecycle
   violations (a result with no open turn, a duplicate permission or
   approval id) fatal without the mirror — the raw line never reaches
   the caller there. Both docs now state the split; no code change.
2. *The nonexistent `--add-dir`* — design §4.7's spawn block listed
   "add-dir" among the carried run flags and §4.8's rule-2 writable
   set included "each `--add-dir`"; the session CLI has no such option
   and the builder's `addDirs` parameter (`claude-session.ts`) was
   never fed. Surface removed, not documented into existence: the dead
   `addDirs` field and its argv loop are deleted, and both design
   passages (plus the panel doc's F29, found by the class grep) now
   state the union as the cwd and the harness home. The deviation from
   the design's original text is recorded here, which the report had
   never done. No regression test — the typecheck pins the removal.
3. *Permission-answer refusal semantics* — design §4.1's compound claim
   (shape-class answers refused `autonomy_escalation` but left pending)
   matched no code path. Rewritten to the shipped mechanics: codemux's
   input grammar accepts per-request decisions only, so an answer
   carrying an unknown field rejects `malformed` (claude-family) and a
   codex `updated_input` on an approval rejects `unsupported` — both
   leave the request pending; the one `autonomy_escalation` refusal is
   the out-of-bounds `allow`, which is answered to the harness as deny,
   resolved deny, and rejected, pending nothing. §10's round-1 log line
   carried the same conflation and is corrected in place.
4. *"claude UUIDs never match"* — the report's step-6 parenthetical
   claimed the codex resume pattern refuses a pasted claude UUID before
   the wire. It does not: the 36-char UUID is entirely inside
   `[A-Za-z0-9_-]{8,128}`, and the refusal comes from the registry (66
   not-found, or 78 on the agent match when a claude entry carries the
   id) — the mechanism step 7 already records. Step 6 is amended in
   place to say so.
5. *The corrupt-registry error's missing path* — design §4.8's failure
   policy says the refusal "names the path"; the surfaced message named
   only the id and reason. Code fixed rather than doc weakened: the
   CLI's untrusted-branch refusal appends `(registry: <path>)`, which
   covers the unreadable and corrupt classes alike (both map to
   `untrusted` in `lookupForResume`) and gives the operator the file to
   fix. Regression: `tests/session-cli.test.ts`, "a corrupt registry's
   resume refusal names the registry path" (exit 78, the reason, and
   the registry path all asserted).
6. *The agy driver's stale comment* — the empty pending set does not
   keep `unknown_request` the uniform answer; the capability gate
   rejects any decision line `unsupported` before the pending check can
   see the set, so `unknown_request` is unreachable for agy. The
   comment now says that, matching the method doc and the e2e test.
7. *Step-3's blanket "low allows everything"* — superseded by the
   schema-before-low ordering since the ceiling landed, never amended.
   Marked in place (the live5 header-fix precedent), and the two
   siblings the class grep found are corrected with it: design §4.1's
   table sentence and the panel doc's F14 "low: everything" now both
   carry the exception.

**Borderline items.** Design §4.3's "In session mode, high is … never
`--dangerously-skip-permissions`" is now scoped to claude-family, with
agy's exception named and explained (no verified permission carrier,
`permissions: false`, so its session high reuses the run mapping's
bypass flag and there is no answer path for a ceiling to judge). The
README's input-ack gloss "(busy, unsupported, or malformed input)" is
now the full twelve-reason union (`malformed`, `unknown_type`,
`invalid_author`, `text_too_long`, `text_nul`, `reason_too_long`,
`unsupported`, `busy`, `no_active_turn`, `unknown_request`,
`autonomy_escalation`, `shutting_down`). The panel doc's three stale
figures are corrected in place: the writer lock's staleness is
liveness-based with a 250 ms × 40 wait budget (not "30 s staleness"),
the agy flags are the `=`-form 1.2.14 requires, and F14's low cell
carries the schema exception (that one counted under finding 7).

**Capability flags.** None changed this round: the audits verified
every matrix cell honest; the dishonesty found was in prose, and the
prose now matches the code.

**Live checks.** None run this round, by decision: the blocker's fix
is a codemux-internal pure predicate proven by the new regression — it
changes no argv, environment, or wire frame, and only narrows which
caller answers codemux relays — and every other fix is doc or comment
honesty. The `~`-expansion fact the fix rests on could in principle be
re-proved live, but the fix is fail-closed either way (it denies
whether or not Claude expands the spelling; if it does not, the denial
costs only a pathological relative filename), so a paid probe would
confirm a vector that is closed unconditionally. No new wire claim is
made, so nothing needs re-proving against the endpoint.

**Gate.** `bun run typecheck` exit 0. `bun test --max-concurrency=1`:
**1122 pass / 0 fail / 6 skip across 1128 tests in 50 files** — the
live5 gate was 1120/0/6 across 1126 in 50, so this round adds the two
regression tests (one ceiling, one CLI) with no regressions and no
removals. `make check` exit 0 (coverage 85.61% line, 91.53% function).
`make release-gate` stops at the same documented environmental
`contracts` stage (installed copilot `--help` needs
`mkdir ~/Library/Caches/copilot/pkg/darwin-arm64`, EPERM under this
sandbox — unchanged since the live2 gate); `runtime` and `check` pass
before the stop, and run past it `sandbox-contract`, `smoke`,
`bun audit` (0 vulnerabilities), `bun install --frozen-lockfile
--dry-run`, and the CLI help smoke all exit 0. `check_american` clean
on all changed `.ts` and `.md` files (exit 0).

## Review fixes, live7

**Intended commit:** `fix(session): live7 review fixes — relative paths judged before symlink collapse, drain failures cost success, root cwd containment`

The live7 review reported three majors; every finding is fixed here
with the smallest correct change and a regression test each. Each
regression was A/B-verified: with the staged pre-fix sources restored
(the index holds the pre-live7 tree), each new test fails exactly as
the finding describes; with the fixes in place, all pass.

**Security major — a relative `..` bypassed the medium edit scope by
routing through a symlink** (`src/session/ceiling.ts:291`,
`pathInsideScope`). The join `resolve`d a relative target before
symlink expansion existed, collapsing `..` lexically first — so BOTH
spellings judged the collapsed form and the kernel spelling never saw a
`..` land after a link. Worked example, the finding's own homebrew
shape: with `cwd=/opt/homebrew/opt` (whose `bun` is a symlink to
`../Cellar/bun/1.4.2`), a medium `Edit` on
`bun/../1.4.2/INSTALL_RECEIPT.json` was joined to
`<scope>/1.4.2/INSTALL_RECEIPT.json` and called inside, while the
kernel resolves `bun` → `Cellar/bun/1.4.2`, applies `..` to the
TARGET's parent, and reads
`/opt/homebrew/Cellar/bun/1.4.2/INSTALL_RECEIPT.json` — outside the
scope. The equivalent absolute spelling already denied (the live5
two-spelling rule worked there because the absolute target reached
`expandSymlinkComponents` unreduced); only relative spellings fed both
spellings the pre-collapsed form. Fix, at the shared predicate: the
relative target is joined with a literal `${launchDir}/${target}` —
no `resolve` — so the relative components survive until symlink
expansion; the kernel spelling expands links where they stand (a `..`
after a link names the target's parent), the lexical spelling still
collapses `..` first, and the disagreement denies. Plain relative
targets (`notes/new.ts`, `./notes/new.ts`, `gone/../x` with no link)
still allow — only the shapes where the two spellings diverge deny.
`pathInsideScope` is shared, so the codex approval ceiling (patch
paths, move destinations) inherits the fix. Regression:
`tests/session-ceiling.test.ts`, "a relative `..` cannot route through
a symlink out of the scope" — the homebrew layout rebuilt in a temp
parent (relative link, Cellar sibling), the attack denies, the
equivalent absolute spelling denies, and the no-symlink control still
allows.

**Correctness major — fatal errors during the shutdown drain still
returned success** (`src/session/driver.ts:714`;
`src/session/codex-driver.ts:1066`; `src/session/agy-driver.ts:517` —
the identical guard in all three drivers). Once `finish()` began, its
re-entry guard returned early on every later call, so a failure
arriving inside the grace window — after the initiating end, before the
child settles — emitted its fatal `error` event and changed nothing:
the driver exited 0 with the initiating reason (`shutdown`), the audit
report's own reproduction. Fix: `finish` stays idempotent (one cleanup
ever runs) while the verdict stops freezing at the first end request —
a new `endExitCode` field is raised monotonically by re-entrant failure
calls (`Math.max`) and is what `run()` resolves with (still forced to
at least 1 when the final event cannot be delivered). The initiating
`reason` is kept: the fatal error event precedes `session_ended` on the
stream, so the caller sees both the failure and the end that carried
it. Late-failure entry points that now reach the verdict, per driver:
tier-3 and grammar-error parses, handler exceptions
(`handleFatal`), FSM transition errors, a registry start-write failure
during the drain, the outbound queue's failure callback, and codex's
unknown-response-id and handshake failures. Regression per driver:
"a fatal arriving during the shutdown drain costs success" — a new
`FAKE_SIGTERM_PERSIST=garbage` mode in each fake (survive the shutdown
SIGTERM and write one non-JSON line before dying) drives the real end
path over `SessionProcess`: the fatal is on the stream
(`source: "harness"`), `session_ended` is still last with the
initiating reason, and the exit code is 1; the agy test additionally
pins that the drained turn completion still arrives — the failure does
not forfeit the drain.

**Security major — a root working directory bypassed the registry
containment checks** (`src/session/registry.ts:380`,
`registryInside`). The containment prefix for a root scope was built as
`//`, which no real path starts with, so `registryInside(<registry>,
"/")` was false — `--cwd /` escaped both consumers of the predicate:
the §4.8 start-time writable-set refusal (cli.ts) and the resume-time
untrusted guard (`lookupForResume`), letting a session run with the
registry inside the harness's writable scope, exactly what the rule
exists to refuse. Fix, mirroring the root rule the ceiling's scope
check has carried since live2: a root scope contains every absolute
path (`prefix = "/"`, plus the exact-equality case the old prefix form
also lacked). Regression: `tests/session-registry.test.ts`, "a root
cwd or harness home contains every registry placement" — the predicate
returns true, and a seeded entry with `cwd: "/"` resumes untrusted with
the containment reason.

**Class audits** (before the gate, per the task):

- *Path-judgment class (finding 1).* Every path judgment in the session
  surface flows through `pathInsideScope`: `claudeCeiling` medium's
  `file_path`/`notebook_path`, and `codexApprovalCeiling` over
  `fileChangePaths` (path + move destination). The registry's
  containment compares codemux-computed paths (validated workdir,
  harness home), never model-controlled spellings, and was audited
  separately below. No other site collapses a relative spelling before
  judging it (the one `resolve(launchDir, …)` join in the session tree
  was the finding's site). No sibling defect beyond the fix.
- *Lifecycle class (finding 2).* Every signal, shutdown, timeout,
  drain, and exit path was walked in all three drivers and the CLI. The
  three `finish` guards were the only sibling defects. The remaining
  early-returns are deliberate and stand: `run()`'s exited-handler
  `if (this.finished) return` covers an exit observed after `finish`
  began — by then `requestStop()` has already run, the child's own code
  is reported in `session_ended.exit_code`, and a crash
  indistinguishable from the SIGTERM inside one event-loop turn is not
  a verdict codemux can honestly re-weight; `handleFatal`'s settled
  check cannot fire post-settlement (the process layer stops
  delivering); `writeToHarness`'s finished-guard keeps end-path writes
  silent by design (live2). The CLI exit path is clean (`process.exitCode
  = code` straight off `run()`); the sigterm fixture follows the
  documented no-`process.exit`-in-handler contract. The stale "the
  failure callback's own end attempt is a no-op" comments in all three
  drivers' finish paths are corrected to say the callback raises
  `endExitCode`.
- *Doc class.* The same claims were grepped across README, CHANGELOG,
  `docs/*.md`, and the module headers. Amended: design §4.1's medium
  predicate (the relative-join rule), §4.6's drain sentence (a failure
  inside the window raises the exit code to 1), §4.8's rule 2 (a root
  cwd is refused like `--cwd ~`), README's lifecycle paragraph (the
  same failure-during-drain contract), and a CHANGELOG live7 Fixed
  entry alongside the live2–live6 ones. Checked and left alone: the
  compatibility ledger (no drain/exit-code claims), docs/HERMETIC.md
  (its resume-containment summary now holds for root too — it never
  claimed otherwise), and the panel doc's F15 (its "resolves outside
  the scope through a symlink denies" sentence is now true for relative
  spellings as well).

**Live checks.** None run this round, by decision: all three fixes are
codemux-internal — a pure predicate change (which relative spellings
deny), an end-path verdict change (an exit code on an internal path),
and a containment comparison change. No argv, environment, or wire
frame changed; nothing a real harness sees differs. The kernel
path-resolution fact the ceiling fix rests on (a `..` after a symlink
applies to the link's resolved target) is the same namei-order fact the
live5 both-spelling rule was built on and the new regression exercises
it on disk. No new wire claim is made, so nothing needs re-proving
against the endpoint.

**Gate.** `bun run typecheck` exit 0. `bun test --max-concurrency=1`:
**1127 pass / 0 fail / 6 skip across 1133 tests in 50 files** — the
live6 gate was 1122/0/6 across 1128 in 50, so this round adds the five
regression tests (one ceiling, one registry, one e2e per driver) with
no regressions and no removals. `make check` exit 0 (coverage 85.62%
line, 91.53% function). `make release-gate` stops at the same
documented environmental `contracts` stage (installed copilot
`--help` needs `mkdir ~/Library/Caches/copilot/pkg/darwin-arm64`,
EPERM under this sandbox — unchanged since the live2 gate, identical
error text re-observed); `runtime` and `check` pass before the stop,
and run past it `sandbox-contract`, `smoke`, `bun audit` (0
vulnerabilities), `bun install --frozen-lockfile --dry-run`, and the
CLI help smoke all exit 0. `check_american` clean on all 16 changed
`.ts` and `.md` files (exit 0).

## Review fixes, live8

**Intended commit:** `fix(session): live8 review fixes — the session cost adopts the harness's lifetime figure, drain-window permission requests are denied`

The live8 review reported two majors (a third auditor was
provider-rate-limited with no findings); every finding is fixed here
with the smallest correct change and a regression test each. Each
regression was A/B-verified: with the two fixes reverted in place (the
fold back to a plain field-wise sum, the drain-window deny removed),
exactly the three new e2e tests fail — the two-turn cost adoption
(`ended.usage.cost_usd` 0.025 against 0.015) and the drain requests
timing out unanswered after ~5 s — and with the fixes restored the
suite is green again.

**Correctness major — the session cumulative counted the cost
repeatedly** (`src/session/driver.ts:562`). The claude-family result's
`total_cost_usd` is a session-lifetime figure on the wire: every turn's
report already includes the earlier turns (the zai-session-a fixture
shows 0.101124 → 0.1066152 → 0.118512 → 0.118512, the aborted result
repeating the last figure), while the token counts beside it are
per-turn. The cumulative folded all fields with one field-wise sum, so
the session cost was the sum of overlapping figures — replaying the
committed fixture reported $0.4447632 against the harness's own
$0.118512, the finding's exact numbers. Fix, in one shared place:
`addTurnUsage` (`src/session/usage.ts`) sums the token counts
field-wise while the cost adopts the addend's figure when it carries
one and keeps the total's when it does not (the same keep-semantics
every null there follows). All three drivers fold through it — codex
and agy carry no cost on their wires (cost_usd stays null), so their
behavior is unchanged and the shared rule is drift-proof rather than a
claude-only patch. `turn_completed.usage` still mirrors the harness's
own per-turn report untouched. Regressions: two unit tests in
`tests/session-usage.test.ts` (the adoption and the null-keeps), a
fixture-replay fold in `tests/session-claude.test.ts` (the
zai-session-a results folded through the real parser, asserting
input 25636 / output 40 / cached 75840 / cost 0.118512 — the fixture's
own final `modelUsage` snapshot independently states the same token
totals), and the two-turn e2e in `tests/session-e2e.test.ts`
(`ended.usage` cost 0.015, not 0.01 + 0.015, while the tokens sum to
22/8/3/33; the fake now models the real counter — each result reports
the running session total, integer micro-dollars so multi-turn sums
are exact, and the ask/badask results still carry no cost).

**Correctness major — permission requests arriving during the shutdown
drain were never answered** (`src/session/driver.ts:460`;
`src/session/codex-driver.ts:585`). `finish()` denies every request it
finds pending, but a request landing *after* that — inside the grace
window, while the harness is still persisting — was registered like any
other: an expiry timer was set (pointlessly — `finish` had already
cleared the timer set, and `expirePermission`'s `finished` guard
short-circuits expiry besides) while the caller's decision channel was
already closed (`handleCallerLine` refuses everything once an end
request began). The harness waited on an answer that could never come,
stalling the very persistence the grace window exists for. Fix, at both
named sites: the `permission_request` event is emitted first (the
caller still sees what surfaced), then a request that landed with
`finished` set is denied at once through the existing supersede
machinery — deny written to the harness keyed by the request's own id,
`permission_resolved: "superseded"` emitted — and the timer is never
set. Regressions: `tests/session-e2e.test.ts` ("a permission request
arriving during the shutdown drain is denied and resolved") and
`tests/session-codex-e2e.test.ts` ("an approval arriving during the
shutdown drain is declined and resolved"), each pinning the surfaced
request, the superseded resolution, the recorded deny in the fake's
response/decision log carrying "the session is ending", the drained
`turn_completed` still arriving (the denial does not forfeit the
drain), `session_ended` last, and exit 0. The fakes grew
`FAKE_SIGTERM_PERSIST=ask` for these: on the end-interrupt — which the
driver writes *inside* the end path, after `finished` flips — the fake
surfaces an ask/approval before completing the interrupted turn, so the
request deterministically lands inside the drain window (no SIGTERM
ordering race; the codex fake keeps its turn open while the approval is
out, because the classifier requires the approval's turnId to match
the driver's open harness turn).

**Class audits** (before the gate, per the task):

- *Usage-accounting class (finding 1).* Every fold and reporter of
  usage in the session surface: the three driver folds (all now the
  shared `addTurnUsage`), codex's per-turn accumulator
  (`accumulateUsage`, `codex-driver.ts:574` — first-replaces-then-adds
  over `tokenUsage/updated` deltas; codex's wire carries no cost, so
  the sum-vs-adopt distinction cannot arise there, and it is a per-turn
  accumulator rather than the session cumulative), the `usage` events
  (per-notification passthrough, never folded), `turn_completed.usage`
  (the harness's own per-turn report, mirrored), and the run path
  (`--result-json` re-emits one result envelope unchanged — no fold, no
  defect). No sibling defect beyond the fixed fold.
- *Lifecycle class (finding 2).* Every signal, shutdown, timeout,
  drain, and exit path was walked in all three drivers and the CLI.
  agy has no permission machinery at all (`permissions: false`, the
  capability gate rejects decision lines `unsupported`) — no sibling.
  The other harness-side requests codemux owes an answer to were
  already answered unconditionally, drain included: claude's
  `unparseable_permission` (deny keyed by request_id), codex's
  `unparseable_approval` (decline) and unimplemented `server_request`
  (-32601). `expirePermission`/`expireApproval`'s `finished` guards are
  now unreachable in the drain (a drain request never gets a timer) and
  still correct before it; `applyPermissionDecision` cannot fire
  post-`finished` (the caller-line guard refuses all input), which is
  harmless now that drain requests are auto-denied. The end paths'
  own writes stay silent past `finished` by design (live2). The CLI
  exit path owes the harness nothing. No sibling defect beyond the two
  named sites.
- *Doc class.* The claims the fixes change were grepped across README,
  CHANGELOG, `docs/*.md`, and the module headers. Amended: design §4.2
  (the cost exception to the running sum), §4.1 and §4.6 (a request
  landing inside the drain is denied at once), README's permission
  paragraph (the same rule), the panel doc's F36 (the cost exception
  joins the accounting contract), and a CHANGELOG live8 Fixed entry.
  Checked and left alone: the compatibility ledger (its usage claims
  are per-turn carriers, unchanged), the fixtures README (no cost
  claims), and CHANGELOG's run-path `total_cost_usd` mention (single
  result re-emitted unchanged — no cumulative involved).

**Live checks.** None run this round, by decision: both fixes are
codemux-internal arithmetic and answer policy — no argv, environment,
or wire frame changed, and nothing a real harness sees differs. The
one wire fact the cost fix rests on (`total_cost_usd` is a
session-lifetime figure) is already pinned by the recorded
`tests/fixtures/live/zai-session-a.ndjson` (step 0) and by the live2
proof's session usage taken from the turn's result alone; the drain
fix restates the supersede rule `finish` itself already ships. No new
wire claim is made, so nothing needs re-proving against the endpoint.

**Gate.** `bun run typecheck` exit 0. `bun test --max-concurrency=1`:
**1133 pass / 0 fail / 6 skip across 1139 tests in 50 files** — the
live7 gate was 1127/0/6 across 1133 in 50, so this round adds the six
regression tests (two usage unit, one fixture-replay fold, two claude
e2e, one codex e2e) with no regressions and no removals. `make check`
exit 0 (coverage 85.64% line, 91.54% function — up from live7's
85.62/91.53). `make release-gate` exits 2 at the same documented
environmental `contracts` stage as every gate since live2 (installed
copilot `--help` needs `mkdir ~/Library/Caches/copilot/pkg/darwin-arm64`,
EPERM under this sandbox's `~/Library` denial — identical error text
re-observed, 2 pass / 1 fail in that file, version probes exercised
across the installed set); `runtime` and `check` pass before the stop,
and run past it `sandbox-contract`, `smoke`, `bun audit` (0
vulnerabilities), `bun install --frozen-lockfile --dry-run`, and the
CLI help smoke set all exit 0. `check_american` clean on all 52 staged
and changed `.ts`/`.md` files (exit 0).

## Review fixes, live9

**Intended commit:** `fix(session): live9 review fixes — never-reused lock names, honest drain exit codes, per-agent autonomy reach, unknown-version session floors, shutting_down acks during the drain`

The live9 review (correctness, security, contracts lenses; three
auditor reports) recorded five findings — two correctness majors, one
security major, one security minor, one contracts major. Every finding
is fixed here with the smallest correct change and a regression test
each. Each regression was A/B-verified: the pre-fix source restored
from the staged index in place, the new tests confirmed failing for the
finding's own reason, the fix restored, the suite green again.

**Correctness major — stale-lock recovery broke mutual exclusion**
(`src/session/registry-io.ts`). The steal unlinked the lock pathname
without verifying it still identified the dead holder: two writers that
both read a dead holder's lock could interleave so that one replaced
the file (its own acquisition) before the other unlinked it — the
unlinked file was the new writer's lock, and both held it. The
auditor's deterministic in-memory interleaving reproduced both
acquisitions; `scratch/live9-ab/lock-race-ab.ts` replays the same
interleaving against the real module (pre-fix: "RESULT: RACE — both
writers held the lock"). Fix: the lock file's name is never reused.
Each acquisition creates `.<base>.<pid>.<random-salt>.held` (8 random
bytes, `O_EXCL`, mode 0600) beside the registry — that unique name is
itself the lock — writes `pid\nstart\n`, and confirms sole ownership by
a rescan: a rival whose payload names a live process (or cannot be
judged — unreadable, non-integer pid) releases the attempt and retries
with jitter; a rival that died is stolen and the confirmation repeated.
A steal can therefore only unlink the exact file whose payload was
verified dead; the loser of a two-writer race on one corpse either
unlinks nothing (ENOENT) or finds the winner's live file on rescan.
Legacy canonical `.lock` files become inert — the name-shape filter
(`digits.hex`) ignores them, and nothing creates them anymore.
`listHeldLocks` is exported as the test seam. Regressions in
`tests/session-registry.test.ts`: "two writers that both observe a
stale lock cannot both acquire it" (the stale corpse seeded, B
acquires, A's attempt throws, B's file survives, and after B releases,
A acquires) and "an unjudgeable held file blocks and is never stolen"
(junk payload → refusal, file untouched).

**Correctness major — shutdown returned success after a harness
failure** (`finish()` in all three drivers). The end path resolved
`run()` with the initiating end's own code — 0 for a clean `shutdown` —
whatever the child then did: a harness that failed while persisting
during the drain (the auditor's injected child exiting 42) reported
driver exit 0 while `session_ended.exit_code` said 42. Fix, uniform in
all three `finish()`s: the verdict reads the child. `turnOpenAtFinish`
is captured before the end-interrupt runs, and each completion path
sets `drainedCompletion` when it delivers inside the drain; after the
child settles, a nonzero exit with the turn still open and no
completion delivered raises the exit code to 1 and emits a fatal
harness error ahead of `session_ended` ("…exited with code N during
the shutdown drain before completing its open turn"). Two exemptions
keep the honest zero, each pinned by a test: a completion that WAS
delivered (the claude family exits 1 after an interrupted turn by
convention — step-0 probe 4: interrupt → result `error_during_execution`
→ exit 1; the fake's persist mode now models exactly that, and the
live5 drain test doubles as the exemption's companion), and a signal
death (exit code null — the normal kill path for a harness that ignored
the interrupt). The `run()` exited-callback's `finished` early-return
stays deliberately: `finish()` now reads `(await proc.exited).code`
itself, and a crash-report from the callback during every graceful
drain would be a spurious fatal. Regressions, one per driver:
"a harness exiting nonzero during the drain with its turn open costs
success" in `tests/session-e2e.test.ts`,
`tests/session-codex-e2e.test.ts`, and `tests/session-agy-e2e.test.ts`
(`FAKE_SIGTERM_PERSIST=exit42`: the turn held open, the end-interrupt
recorded but never answered, exit 42 — each test pins `exit_code` 42,
the fatal harness error, no `turn_completed` for the open turn, and
driver exit 1).

**Security major — the resume ranking let an agy session resume above
its creation** (`src/session/registry.ts`). One reach ladder served
every agent: `read-only < medium < high < low`. "Low out-reaches high"
holds only where a permission round-trip exists — on claude/zai/codex a
low session's caller can approve anything while high's ceiling denies.
agy has no permission channel at all (`permissions: false`; every
`permission_decision` rejected) and session low passes no mode flag,
so low is agy's *least* reach — the shared ladder let an agy session
created at `--auto low` resume at `--auto high`, which passes
`--dangerously-skip-permissions`. Fix: the ranking is per agent —
`AUTONOMY_REACH_BY_AGENT` maps claude, zai, and codex to the existing
ladder and agy to `STRICT_AUTONOMY_REACH` (`read-only < low < medium <
high`); an agent without a mapping is ranked strict too, the
conservative reading for a name a future release may add (the guard's
no-throw contract is preserved). Regression in
`tests/session-registry.test.ts`: "the agy autonomy ladder is strict:
no resume above creation" — low→high (the finding's escalation),
low→medium, medium→high, and read-only→low all refused; high→medium,
low→low, and read-only→read-only allowed; claude's low→high still
allowed (the documented narrowing move).

**Security minor — an unreadable version skipped the session floor**
(`src/harness-compatibility.ts`). `minimumOverride` (the session floor)
took effect only when the version probe *read* a version: a claude or
zai whose `--version` printed nothing matching `^(\d+\.\d+\.\d+)` (a
wrapper script) fell through the null branch's warn-and-continue, and
the session started with no floor check at all. Fix: the null branch
grows a `minimumOverride` arm — an unreadable version is refused naming
the floor and the override instruction, with
`CODEMUX_ALLOW_UNTESTED_HARNESS=1` downgrading it to a warning exactly
like every refusal. The existing fallthrough stays for `run` (wrapper
scripts and vendored builds legitimately report no version, and a
run's exposure ends with the run), and copilot's
`unknownVersion: "refuse"` contract arm is unchanged above it.
Regressions: `tests/harness-compatibility.test.ts` "an unreadable
version refuses whenever a session floor is in force" (refusal naming
2.1.280 with the floor set, warning without it — the refusal belongs to
the session contract — and the override downgrade) and
`tests/session-cli.test.ts` "a harness whose version cannot be read is
refused before spawn too" (the end-to-end pin: a fake claude printing
`not-a-version` refuses with exit 1 naming 2.1.280).

**Contracts major — the documented input acknowledgment was silently
broken during every end path** (README, CHANGELOG, design §4.1 vs all
three drivers). Every doc promised each input line an
`input_accepted`/`input_rejected` answer, but `handleCallerLine`
returned before parsing once `finished` flipped: a line landing inside
the shutdown drain — stdin is still being relayed through the whole
grace window, a normal broker race, not an exotic one — vanished
unacknowledged, and the documented `shutting_down` reason was
unreachable dead code (every way the protocol layer's `shuttingDown`
flag could become true already implied `finished`). Fix, in all three
drivers: the drain window answers. `handleCallerLine` acks every
non-blank line with `input_rejected` (`shutting_down`) while `finished`
and not yet `settled` — the CLI relays stdin until `run()` resolves, so
the answer lands on the stream before `session_ended`, which stays
last. Once `settled`, `session_ended` is queued and nothing may follow
it, so the driver's silent return there is the ordering contract, not a
drop; the protocol layer's gate stays as the spec and defense in depth.
A repeated `shutdown` inside the window gets the same honest rejection
(the session is already ending; the line was not processed as a new
command). Regressions, one per driver: "caller input during the
shutdown drain is rejected shutting_down, never dropped" in all three
e2e files — `shutdown` then a synchronous `user` line, pinning the
`input_rejected` (`input_seq` 3), exactly one `user_message`,
`session_ended` last, exit 0. Docs amended to say what is now true:
README's ack paragraph names the drain-window rejection and the
post-`session_ended` close, design §4.1 the same, and §4.1's live8
sentence "caller decisions are already refused" now names the mechanism
it always claimed.

**Class audits** (before the gate, per the task):

- *Lifecycle class (the exit-verdict finding).* Every signal, shutdown,
  timeout, drain, and exit path was walked in all three drivers and the
  CLI. The `run()` exited-callback early-returns (one per driver) pair
  correctly with the new verdict — `finish()` reads the child's code
  itself, so the callbacks must not double-report. The
  `writeToHarness` `finished` guards (all three) are deliberate: the
  only codemux-originated write after `finish` begins is the
  end-interrupt inside `finish` itself, whose failure is told by the
  child's exit code; caller-originated writes can no longer occur
  because the input paths reject `shutting_down` before writing.
  `handleFatal`'s settled-guard and monotone `endExitCode` (live7)
  compose with the new rule rather than competing with it: both only
  raise. Timeout paths already carry their own codes (`timeout` 1,
  signal 143) and the rule only adds. The CLI exit path owes nothing
  else: it relays stdin until `run()` resolves and exits with the
  driver's code. No sibling defect beyond the three `finish()`s.
- *Registry-lock class.* `acquireLock` has exactly one caller
  (`updateRegistry`, `registry.ts`); the rewrite covers the whole
  class — sweep, create, confirm, steal, release — and legacy `.lock`
  files are inert by the name-shape filter. No sibling.
- *Ranking class.* `AUTONOMY_REACH` has one consumer
  (`lookupForResume`); the per-agent map covers every session-capable
  agent and defaults unknown agents strict. The autonomy *validation*
  (a record's autonomy must be a known level) is separate and
  unchanged. No sibling.
- *Version-gate class.* The `version === null` branch now has exactly
  three arms — contract refusal (copilot), floor refusal (any session),
  warn (`run`) — each with its override downgrade, and the
  probe/redirect/identity machinery above it is untouched. No sibling.
- *Doc class.* The claims the fixes change were grepped across README,
  CHANGELOG, `docs/*.md`, and the module headers. Amended: design §4.1
  (the drain-window ack, and the live8 sentence now names the
  mechanism), §4.6 (the child's exit is part of the verdict, with both
  exemptions), §4.8 (the never-reused held-name lock scheme; the
  per-agent ladder with agy strict, and the low→high permission
  scoped to the claude-family ladder), the compatibility ledger's
  session addendum (the unknown-version refusal, the agy ladder),
  README (the floor, the ack paragraph, the drain exit rule, the
  per-agent resume bound), and a CHANGELOG live9 Fixed entry. Checked
  and left alone: the panel doc (a record of the review conversation —
  its F13 ladder text describes the claude-family move, which is
  unchanged), HERMETIC (no lock, ladder, ack, or floor claims), the
  fixtures README (no such claims), and the earlier report sections
  (historical rounds, each describing the tree as it stood).

**Live checks.** None run this round, by decision: all five fixes are
codemux-internal — no argv, environment, or wire frame changed, and
nothing a real harness sees differs. The one behavioral fact a fix
leans on — the claude family exiting 1 after an interrupted turn — is
pinned by step-0 probe 4 and the recorded fixtures; the exit-42 shape
is a codemux-side verdict about an exit code the protocol already
reported honestly in `session_ended.exit_code`. No new wire claim is
made, so nothing needs re-proving against the endpoint.

**Gate.** `bun run typecheck` exit 0. `bun test --max-concurrency=1`:
**1144 pass / 0 fail / 6 skip across 1150 tests in 50 files** — the
live8 gate was 1133/0/6 across 1139 in 50, so this round adds the
eleven regression tests (two lock, one ladder, three drain-exit, three
shutting-down, two version-floor) with no regressions and no removals.
`make check` exit 0 (coverage 85.60% line, 91.59% function — live8 was
85.64/91.54; the new uncovered corners are the lock retry's jittered
back-off). `make release-gate` exits 2 at the same documented
environmental `contracts` stage as every gate since live2 (installed
copilot `--help` needs `mkdir ~/Library/Caches/copilot/pkg/darwin-arm64`,
EPERM under this sandbox's `~/Library` denial — identical error text
re-observed, 2 pass / 1 fail in that file); `runtime`, `typecheck`, and
the coverage suite pass before the stop, and run past it
`sandbox-contract`, `smoke`, `bun audit` (0 vulnerabilities),
`bun install --frozen-lockfile --dry-run`, and the CLI help smoke set
all exit 0. `check_american` clean on all changed `.ts`/`.md` files
(exit 0).

## Review fixes, live10

**Intended commit:** `fix(session): live10 review fixes — kernel-order symlink joins in the ceiling, answered pre-handshake input, honest per-turn usage, result-gated file changes, floors that raise the audited ceiling, synthesized agy turn completions, EX_USAGE for bad flag values`

The live10 review (one correctness auditor, FAIL/major, plus a
verification pass recording five minor doc-drift findings) recorded
eight code findings — two majors, six minors — and the five doc
findings. Every finding is fixed here with the smallest correct change
and a regression test each (the doc findings carry the sibling greps
below instead). The full-suite delta versus live9 is +11 tests, no
removals.

**Major — the ceiling's symlink walk collapsed `..` before the kernel
would** (`src/session/ceiling.ts:241`). Expanding a path component by
component, the walk joined a relative link target onto its link's
directory with `resolve`, which collapses the target's own `..` by
string before the symlinks inside that target are followed. The
auditor's layout: `S -> /Users/u/Programming` (absolute, outside the
scope), `L -> S/../.ssh` (relative), an empty `<dir>/.ssh`. A Write to
`L/../.zshrc` then produced a kernel spelling (`<dir>/.zshrc`) and a
lexical spelling (`<dir>/.zshrc`) that both sat inside the scope,
while the real kernel — following `L` to `S/../.ssh` = `/Users/u/.ssh`,
then applying `..` — wrote `/Users/u/.zshrc`. The two-spelling
agreement is the ceiling's whole test, and both spellings were wrong
the same way. Fix: the join is literal —
`${dirname(prefix)}/${linkTarget}` — and the walk expands the inner
links and applies the `..` in namei order, where the kernel applies
it. Regression in `tests/session-ceiling.test.ts`: "a `..` inside a
relative symlink target applies after the links it names" builds the
finding's exact layout and asserts deny; the tightening this adds (a
relative target whose dotted spelling traverses a nonexistent
directory now denies at the dangling-component check rather than
lexically resolving past it) is pinned alongside.

**Major — codex dropped caller lines buffered before the session
started, unanswered, exiting 0** (`src/session/codex-driver.ts`).
While the state was `starting`, every non-shutdown line parked in
`preSessionLines`; the only drain was the `session_started` replay,
guarded by `!finished`, so `printf '{"type":"user","text":"hi"}\n' |
codemux session -a codex` — stdin closing before the
`initialize`/`thread/started` handshake finished — ended the session
with that line never acked, never rejected, never echoed, and exit 0.
Fix: the end path answers what it finds. `finish()` drains
`preSessionLines` with the same `shutting_down` rejection the
drain-window path already used (live9), so every parked line gets its
`input_rejected` before `session_ended`. Two siblings the auditor
named in the same finding, both fixed: mid-turn `user` lines already
acked and queued in the FIFO but foreclosed by the end are reported
with one non-fatal `error` naming the drop (their acks cannot be
retracted and a second answer would double-ack), through the same
`dropBufferedSteer()` helper that now also covers `failOpenTurn`'s
previously silent clearing of the steer buffer. Regressions in
`tests/session-codex-e2e.test.ts`: "caller input buffered during a
stalled handshake is answered, never dropped" (the finding's exact
trigger shape), "queued user input that can no longer run is reported,
not lost silently", and "a steer buffered while the harness turn id is
unknown is reported when its turn dies".

**Minor — per-turn cost was the session-to-date figure**
(`src/session/driver.ts:639`). The claude family's result carries
`total_cost_usd` session-lifetime (the zai-session-a fixture: 0.101 →
0.107 → 0.119 across three turns), and the driver mirrored it into
each `turn_completed.usage.cost_usd` beside per-turn token counts — a
caller summing per-turn costs overcounts. Fix: the per-turn event
carries `cost_usd: null`; the figure rides `session_ended.usage` alone
(where `addTurnUsage` already adopts the latest report, live8).
Regressions: the existing "the session cost adopts the harness's
running figure, never summing turns" e2e test now also pins the null
per-turn cost on both turns, and the lifecycle test's usage assertion
carries `cost_usd: null` with the reason.

**Minor — the cumulative `total_tokens` stopped matching its parts**
(`src/session/usage.ts:37`). The total was summed independently, so a
turn reporting input and output but no cache figure (a null total, per
the wire identity every normalizer enforces) added to the parts and
not to the total — the auditor's example: turns {10,5,3,18} and
{4,2,null,null} reported in 14, out 7, cached 3, total 18 while the
components added to 24. Fix: the cumulative's total is computed from
the summed parts — the identity holds whenever the parts were
reported, and stays null when they were not. Regression in
`tests/session-usage.test.ts`: "the cumulative's total is its parts'
sum, never an independent counter" (the auditor's exact numbers).

**Minor — derived `file_change` events fired before the permission
answer** (`src/session/claude-session.ts`, `src/session/driver.ts:116`).
The parser emitted the derived change when the `tool_use` frame
arrived — before the permission round-trip — so a call the caller, the
ceiling, or the timeout then denied had already been reported as a
change; and `Write` was always `add`, even overwriting. Fix, split
cleanly: the parser only NAMES the candidate, keyed to the tool_use id
and flagged `write` for the one tool whose action depends on a
filesystem check; the driver stashes it at the frame, lstats the target
then (pre-write, because post-write the file always exists — an
existing target is an edit, a fresh one an add), and emits the change
only when the call's own `tool_result` reports success, with the
stashed tool_use line as `raw`. Entries left at session end are
dropped silently — an unknown outcome is not a change. Regressions in
`tests/session-e2e.test.ts`: "a denied edit derives no file_change"
and "the Write add/edit split reads the workspace at the call, and the
change follows the result" (which also pins the ordering: the change
follows the confirming `tool_result`); the parser pin in
`tests/session-claude.test.ts` now expects the named-candidate shape
and the `write` flag.

**Minor — every valid claude/zai/codex session printed a false
"unaudited version" warning** (`src/harness-compatibility.ts:343`).
The session floors sit above the run contracts' audited maximums
(claude/zai 2.1.280 over 2.1.223; codex 0.159.3 over 0.147.0), so any
version that passed the floor then warned `unaudited` — the floor IS
the audited build (the release the session wire contracts were
recorded on), so the warning fired on every launch and said nothing.
Also, `minimumOverride ?? contract.min` replaced the contract minimum
outright, so a floor set below it would have lowered the bar. Fix: the
effective minimum is the larger of the two, and the audited ceiling
follows it — `max(contract.maxAudited, minimum)` — so a version at or
below the floor never warns and a floor can never lower either
boundary. Regressions in `tests/harness-compatibility.test.ts`
("session floors and the audited band"): "a session at exactly its
floor is supported, never unaudited", the above-floor warning naming
the floor, the below-floor refusal, and the override-lowers-nothing
case. Re-proven live below.

**Minor — an agy end mid-turn left the turn open**
(`src/session/agy-driver.ts:590`). agy has no interrupt carrier, so
`finish()` SIGTERMs immediately; the stream showed `turn_started` then
`session_ended` with no completion — the §4.1 pairing (every
`turn_started` answered) broken on the one harness that cannot answer
it. Fix: after the live9 nonzero-exit verdict and before the FSM
closes, `finish()` synthesizes the completion the harness cannot —
`finish: "interrupted"`, a reason naming the session end, all-null
usage (never guessed zeros), `raw: null` (codemux-originated) — but
only when the child's exit is not itself the failure the verdict just
reported (a nonzero exit already told the story; `drainedCompletion`
already covers a result that did arrive). Regression in
`tests/session-agy-e2e.test.ts`: "stdin close mid-turn ends cleanly,
with the open turn answered" — the synthesized completion (interrupted,
raw null, all-null usage) precedes `session_ended`, exactly one
`turn_started` and one `turn_completed`; the garbage-drain and exit-42
tests pin the two suppressions. One deliberate call, flagged: a fresh
session's first turn interrupted this way reports `resumable: false`
even though agy may have persisted the conversation — the registry
vouches ids it recorded, and a session whose `session_started` never
fired (no conversation id vouched) is not resumable through codemux's
fail-closed lookup; the honest answer is false, not a guess.

**Minor — bad flag values exited 1 instead of 64**
(`src/cli-runtime.ts:233`). `failInvalidOption` — `run` and `session`
share it — called `process.exit(1)`, contradicting the session CLI's
own `usageError` (64) for the same mistake class and the comment that
claimed parity. Fix: `process.exit(64)` with the EX_USAGE rationale,
and the now-dead `autonomy === undefined` branch (the resolver throws,
never returns undefined) is removed, with its four call-site guards
simplified (`src/index.ts` run and tui sites,
`src/check-command.ts`, `src/session/cli.ts`). Regression in
`tests/session-cli.test.ts`: "a bad --auto or --sandbox-trust value is
usage (64) on session and run alike" (both commands, the trust-value
case included).

**Doc findings (the verification pass's five minors).** D1: README's
`raw` paragraph now notes codex's `session_started` mirrors the
`thread/started` notification it translated, so its `raw` is a string
there — the one harness-mirrored exception. D2: panel B1's tier-2
text now splits the parser-caught half (mirror plus fatal) from the
driver-caught half (fatal alone, no mirror), matching the amended
design §4.2 and the README. D3: panel F6 now says the
answer-immediately rule shipped for codex only; the claude family's
non-`can_use_tool` control requests are tier-1 `unknown` passthrough
that nothing waits on. D4: panel F11 now states the session `config`
carries only the project-doc overrides and `--ignore-rules` has no
verified carrier (the ledger's execpolicy parity gap). D5: this
report's live9 registry-lock audit names `updateRegistry` — the real
sole caller — instead of the nonexistent `withRegistryLock`.

**Class audits** (before the gate, per the task):

- *Lifecycle class (the codex buffer-drop and agy open-turn findings).*
  Every signal, shutdown, timeout, drain, and exit path was walked in
  all three drivers and the CLI. The codex `preSessionLines`/
  `turnQueue`/`steerBuffer` surfaces are the only unacknowledged-input
  states, and all three now resolve on every end path (rejected,
  noticed, noticed). The claude family's `queuedInputs` sibling drains
  through the same end-interrupt path that closes its turn (live5's
  queued-input flush), and its steer is capability-rejected before any
  buffering exists — nothing to drop. agy has no queue at all: its
  capability rejections precede buffering. For the open-turn pairing:
  claude and codex close through the end-interrupt's drained result
  (pinned by the live5 drain tests), agy synthesizes, and the live9
  nonzero-exit verdict is deliberately the story that suppresses the
  synthesis — the two findings' fixes compose rather than compete.
  The CLI relays stdin until `run()` resolves on every path, so every
  answer lands before `session_ended`, which stays last. No sibling
  defect beyond the finding's own three sites.
- *Usage class (the cost and total findings).* Every normalizer
  (`claude`, `codex`, `agy`) derives `total_tokens` from its parts —
  the cumulative now does too, so the identity holds at both layers.
  Cost exists on exactly one wire (the claude-family result) and now
  appears on exactly one event (`session_ended`); codex and agy report
  null throughout. The run-path envelope's usage block
  (`--result-json`) was checked and is unaffected — it computes from
  one result, not a cumulative.
- *Ceiling class (the symlink finding).* The fix lands in
  `expandSymlinkComponents`, the one walk every ceiling predicate
  consults: the medium Edit/Write/NotebookEdit path check and the
  codex patch-approval check share `pathInsideScope`, so both are
  covered by the one change. The live5 flee-link and live7 bun-spawn
  cases were re-verified against the literal join (they deny as
  before), and the tightening (a relative target traversing a
  nonexistent directory denies at the dangling check) is
  conservative-only: paths that agreed before still agree.
- *Version-gate class (the floor finding).* `evaluateHarnessVersion`
  now has one effective minimum (the larger of contract and override)
  and one audited ceiling (the larger of contract max and minimum);
  agy is unaffected (floor == maxAudited), the run path is unaffected
  (no session floor in force), and `CODEMUX_ALLOW_UNTESTED_HARNESS=1`
  still overrides both tiers as before. The null-version arm (live9)
  reads the effective minimum already.
- *Exit-code class (the flag-value finding).* `failInvalidOption` is
  the one shared invalid-option exit; with it at 64, every command
  surface (run, session, tui, check via the shared parser) answers
  usage errors with EX_USAGE. Grep confirmed no doc pins the old exit
  1 for bad values (the README's session exit-code table already said
  64 usage) and no other test asserted the old code.
- *Doc class.* The claims each doc finding touched were grepped across
  README, CHANGELOG, `docs/*.md`, and the module headers. Amended
  beyond the five findings themselves: design §4.1 (the buffered-line
  and queued-drop clauses), §4.2 (`file_change` timing and the Write
  split; the per-turn cost null on the `turn_completed` bullet), §4.6
  (the open-turn-on-every-end-path bullet with the agy synthesis and
  the resumable note), the usage-accounting paragraph (the per-turn
  cost null), the compatibility ledger's addendum and Version-
  enforcement section (the floor raises the audited ceiling), the
  panel's F36 (the per-turn cost null), the README lifecycle paragraph
  (the synthesized agy completion), and a CHANGELOG live10 Fixed
  entry. Checked and left alone: the archived raw panel transcripts
  (records of their conversations), HERMETIC (no session-usage,
  floor, or lifecycle claims), the fixtures README (no claims
  touched), and the earlier report rounds (historical).

**Live checks.** One, by decision — the floor finding is the one fix
whose observable behavior a real harness can contradict (a warning on
stderr the fakes never exercised). Through `./bin/codemux session -a
zai --no-sandbox --auto high`, key auto-read from `~/.zai` (staged at
0600 under a redirected writable HOME, the established pattern), with
an immediate `shutdown` line and no turn submitted — zero provider
requests, no quota. Installed claude: 2.1.280, exactly the session
floor. Result: exit 0, `input_accepted` then `session_ended`
(`reason: shutdown`) as the whole stream, and **no `unaudited`
warning** on stderr — pre-fix, 2.1.280 over the run contract's 2.1.223
ceiling warned on every launch. The only stderr line is the sandbox's
known process-table EPERM note (documented since the step-0 probes).
No `session_started` fired, so no registry entry was written —
registration happens at `session_started` by design, and a session
shut down before the harness identified itself is not recorded; the
clean exit 0 is the designed path. Every other fix this round is
codemux-internal (no argv, environment, or wire frame a real harness
sees differs), so nothing else needs re-proving.

**Gate.** `bun run typecheck` exit 0. `bun test --max-concurrency=1`:
**1155 pass / 0 fail / 6 skip across 1161 tests in 50 files** — the
live9 gate was 1144/0/6 across 1150 in 50, so this round adds the
eleven regression tests (one ceiling, three codex buffer/drop, one
usage identity, two file_change e2e, three version-floor, one
exit-code) with no regressions and no removals; the per-turn-cost
pins extended two existing tests and the agy open-turn regression
rewrote one. `make release-gate` exits 2 at the same documented
environmental `contracts` stage as every gate since live2 (installed
copilot `--help` needs `mkdir ~/Library/Caches/copilot/pkg/darwin-arm64`,
EPERM under this sandbox's `~/Library` denial — identical error text
re-observed, 2 pass / 1 fail in that file); `runtime`, `check`
(coverage 85.78% line, 91.60% function — live9 was 85.60/91.59), and
the coverage suite pass before the stop, and run past it
`sandbox-contract`, `smoke`, `bun audit` (0 vulnerabilities),
`bun install --frozen-lockfile --dry-run`, and the CLI help smoke set
all exit 0. `check_american` clean on all 23 changed `.ts`/`.md`
files (exit 0).

## Review fixes, live11

**Intended commit:** `fix(session): live11 review fixes — end-path interrupt with turn/start in flight, superseded approvals at turn completion, failed beats interrupted, interrupt rejections matched by call id, response-adopted codex resume, single-fatal crashes with answered turns, 143-aware drain verdict, own-property registry enums, .git-proof medium scope`

The live11 review (one code review run at correctness-2 on Claude
plus security and contracts lenses) recorded four majors, three
minors, two not-verified items, and one operator note. Every finding
is fixed here with the smallest correct change and one regression
test each; the not-verified items are settled (one live probe, one
fake-driven proof); the operator note's state-machine walk is written
out below and produced the siblings listed with it. The full-suite
delta versus live10 is +15 tests, no removals.

**Major 1 — a shutdown while `turn/start` was in flight skipped the
graceful interrupt** (`src/session/codex-driver.ts`). The end path's
interrupt was gated on `harnessTurnId !== null` — but the harness turn
id arrives only with the `turn/start` response, so a shutdown landing
in that window ended the session without ever interrupting the turn:
the child ran until the kill, and its nonzero exit then also produced
the live9 "during the shutdown drain" fatal on top. Fix: the gate is
the state machine's own turn — `fsm.state === "turn_active"` — and
`sendInterrupt()` already buffers until the response names the turn,
so the interrupt goes out the moment it can. Regression in
`tests/session-codex-e2e.test.ts`: "a shutdown while turn/start is in
flight still interrupts the open turn" (FAKE_HOLD_TURNSTART holds the
turn/start response; the test polls the fake's request log before
sending shutdown — the driver's sends are synchronous, so the
shutdown's SIGTERM can otherwise beat the fake's stdin read, a race
the first draft of the test lost).

**Major 2 — approvals pending at turn completion were never cleared**
(`src/session/codex-driver.ts`, `src/session/driver.ts`). A turn that
completed (or failed open) with a permission request still pending
left the request in the pending set with its expiry timer armed: a
later decision for it was acked accepted for a request the harness no
longer held, and the timer would eventually write a stray decline
into whatever turn was running then. Fix: `completeTurn` and
`failOpenTurn` (codex) and `completeTurn` (claude family) supersede
what the turn leaves pending — deny on the wire keyed to the request,
`permission_resolved: "superseded"` to the caller, timer disarmed —
the same treatment interrupt and the end paths already gave.
Regressions: "approvals still pending when the turn completes by
itself are superseded" (`tests/session-codex-e2e.test.ts`, the
asklose scenario) and "permissions still pending when the turn
completes by itself are superseded" (`tests/session-e2e.test.ts`, the
claude-family sibling — the asklose fake waits for the deny record
through the polling helper added this round, because the emit the
test awaits is codemux's, not the fake's, and a single record read
raced the pipe; five consecutive green runs pin the fix). agy has no
permission machinery, so no sibling exists there.

**Major 3 — a turn failing while its interrupt was pending was
reported interrupted, error dropped** (`src/session/codex-driver.ts`).
`completeTurn` recast every completion as interrupted while
`interruptPending` was set, including an explicit `finish: "failed"`
completion — a rate-limited turn answered the caller "interrupted"
with no error anywhere. Fix: an explicit failure keeps
`finish: "failed"` and its own reason; the interrupted recast and the
`turn-timeout` reason override apply only to completions that are not
failures. Regression: "a turn that fails while its interrupt is
pending completes failed with its own error"
(`tests/session-codex-e2e.test.ts`, failoninterrupt; the session
continues to a clean next turn). The claude family needed no change:
its interrupted turns arrive as `isError` results by convention
(step-0 probe 4), where the recast is the honest translation.

**Major 4 — a stale interrupt rejection cleared the next turn's
interrupt state** (`src/session/codex-driver.ts`). `pendingCalls`
recorded an interrupt as the string `"interrupt"`, so ANY interrupt
response — including a rejection of a previous turn's interrupt that
arrived after the next turn's interrupt was already pending — cleared
the new turn's `interruptQueued`/`interruptPending`/`interruptFromTimeout`
flags. The next turn's turn-timeout completion then lost its
`reason: "turn-timeout"`. Fix: `call()` returns its numeric id,
`deliverInterrupt()` records it in `interruptCallId`, and
`applyResponseError` clears the flags only when the rejected call id
matches (a stale rejection still surfaces its own non-fatal error).
Regression: "a stale interrupt rejection cannot clear the next turn's
interrupt state" (`tests/session-codex-e2e.test.ts`, staleinterrupt:
turn 1 interrupted, turn 2's timeout keeps the reason, exactly one
non-fatal rejection error). The claude family has no sibling: its
interrupts are fire-and-forget control requests with no response
correlation to misattribute.

**Minor 5 — a crash mid-turn told the failure story twice and left the
turn unanswered** (all three drivers). The crash path already emits
its fatal ("exited unexpectedly"), but the live9 drain verdict then
added a second, false "during the shutdown drain" fatal for the same
exit, and the open-turn synthesis covered only exit codes null and 0
— a crash's nonzero exit left `turn_started` unpaired. Fix, walked
across every signal, shutdown, timeout, drain, and exit path in all
three drivers: the verdict exempts `reason === "crash"` alongside the
143 exemption below; the synthesis gate admits a crash
(`turn_completed` with `finish: failed`, the crash as its reason,
`usage: emptyUsage()`, raw null) on every driver. Regressions:
"a crash mid-turn reports one fatal and still answers the open turn"
in `tests/session-e2e.test.ts` (claude) and
`tests/session-agy-e2e.test.ts` (agy); the codex sibling is pinned by
extending the existing "a harness crash ends the session through the
crash path" test with the same two assertions (one fatal, no drain
fatal behind it; the synthesized `turn_completed` with the crash as
its reason and all-null usage) — the live10 precedent of extending a
test rather than adding a twin. Siblings fixed in the same walk:
the claude and agy verdicts gain the 143 exemption, and all three
fakes learn the exit143 persist mode (silent on the interrupt, exit
143 after the SIGTERM) so the exemption is pinned by A/B, not by
accident.

**Minor 6 — registry validation accepted prototype-chain spellings**
(`src/session/registry.ts`). `"constructor" in AUTONOMY_REACH` is true
through the prototype, so a tampered record carrying autonomy
`"toString"` or sandbox_trust `"constructor"` validated — and the
trust guard then compared `TRUST_RANK["constructor"]` (a function, so
NaN) against a number, never greater, so a trusted resume above the
recorded trust was never refused. Fix: `Object.hasOwn` for both enum
validations; such records read corrupt, which fails the resume
closed. Regression: "prototype-chain spellings of the enum fields are
corrupt, not ranks" (`tests/session-registry.test.ts`).

**Minor 7 — medium granted executable git configuration, and the NFC
fold admitted a normalization sibling** (`src/session/ceiling.ts`).
Two halves. (1) Medium's launch-directory grant covered
`<cwd>/.git/hooks/*` and `<cwd>/.git/config` — whatever lands in a
hook runs on the next git command, and config can carry it there.
Fix: a `.git` path component in either spelling of the target denies
at medium (high returns the bare grant before the predicate; low
leaves the answer to the caller; the codex patch ceiling shares
`pathInsideScope`, so medium patch approvals refuse the same way).
(2) The NFC fold exists so an NFD-spelled launch directory still
matches its own files — but on a normalization-PRESERVING filesystem
(Linux), a sibling directory whose name is the composed spelling of
the launch directory's own name composes onto the scope string and
rides the NFC comparison to "inside". Fix: containment additionally
requires the target's raw spelling inside the launch directory's own
raw disk spelling (`ResolvedForms` carries both; `spellingsInsideScope`
is the exported pure decision). Regressions in
`tests/session-ceiling.test.ts`: "medium denies writes inside the
launch directory's .git", "a decomposed-name sibling cannot ride the
NFC fold into the scope" (the collision needs a
normalization-preserving disk, so the decision is exercised pure —
macOS APFS is normalization-insensitive and cannot host it), and "an
NFD-spelled launch directory still matches its own files (the fold's
purpose)" — the macOS control that the raw-agreement rule did not
break the fold's own case.

**Not-verified item 1 — does codex announce `thread/started` on
resume?** Settled live (below): it does not, so the resume path is
announced from the `thread/resume` response (`announceSession(null)`,
codemux-originated, `raw: null`); pre-fix, a resumed session waited
for a notification that never comes and never left `starting`. A
late `thread/started` on an already-started session — a server that
announces anyway — is tier-1 `unknown` passthrough, never a fatal
(the parser's seen-once flag governs sightings and cannot know the
driver adopted ahead of the notification); a fresh `thread/start`
still waits for the notification, exactly as the recorded fixture
proves. Regression: "a late thread/started on a resumed thread passes
through, never fatals" (`tests/session-codex-e2e.test.ts`,
FAKE_RESUME_ANNOUNCES), plus the pre-existing resume lifecycle test
now A/B-fails on the pre-fix tree by hanging in `starting`.

**Not-verified item 2 — scode exiting 143 mid-turn could falsely
report exit 1.** Confirmed by inspection and pinned by fake: a
wrapper that answers the shutdown SIGTERM with exit 143 (128+SIGTERM,
the scode spelling) hit the live9 verdict's nonzero clause while the
signal death it encodes (exit code null) exempts itself. Fix: 143
joins the exemption set in all three drivers, and the still-open turn
is synthesized interrupted (nothing else can answer it — the
interrupt's answer died with the wrapper). Regressions: "a wrapper
exiting 143 during the drain is the signal's coded spelling, not a
failure" in `tests/session-e2e.test.ts`,
`tests/session-codex-e2e.test.ts`, and `tests/session-agy-e2e.test.ts`.
Every other nonzero exit keeps the live9 verdict exactly (the exit42
tests still pin it).

**Operator note — the codex driver's state machine, walked.** The
driver holds: `pendingCalls` (JSON-RPC id → kind), `pendingApprovals`
(request id → approval), `turnQueue` (the user FIFO), `steerBuffer`,
`preSessionLines`, `interruptQueued`/`interruptPending`/
`interruptFromTimeout`/`interruptCallId`, `harnessTurnId`, and the
shared `drainedCompletion` verdict input. Every transition was walked
for stale or unpaired state post-fix: a response error clears
interrupt flags only for the matching call id (major 4); turn
completion and fail-open clear the interrupt flags and supersede
approvals (majors 2, 3); the end path interrupts on the FSM's turn,
not on the harness turn id (major 1); a `thread/started` after
adoption is a passthrough (not-verified 1); the verdict and synthesis
read `reason` and the child's exit together (minor 5, item 2). The
walk's sibling findings in the other drivers: the claude family
needed the completion supersede (major 2) and the verdict/synthesis
parity (minor 5, item 2); agy needed only the verdict/synthesis
parity — it has no permission or interrupt machinery to go stale.

**Class audits** (before the gate, per the task):

- *Lifecycle class (majors 1–4, minor 5, item 2):* the signal,
  shutdown, timeout, drain, and exit paths of all three drivers and
  the CLI, walked as above. Siblings fixed: claude's
  completion-time supersede; claude and agy verdict exemptions
  (crash, 143) and open-turn synthesis; claude and agy exit143 fake
  modes.
- *Registry class (minor 6):* every `in`-based enum or table lookup
  in `src/session/registry.ts` audited — the two validations were
  the only ones; the rank guards read numbers only now.
- *Ceiling class (minor 7):* every containment comparison audited
  for the raw/NFC pair — `spellingsInsideScope` is the single
  decision, called from both the claude predicate and the codex
  patch path; the `.git` component check runs at medium only, where
  a predicate runs at all.
- *Doc class:* the medium-scope claim, the §4.6 open-turn and verdict
  bullets, the thread/started claims, and the `session_started.raw`
  exception grepped across README, CHANGELOG, design, panel docs,
  the compatibility ledger, and module headers. Updated: README
  (medium `.git` rule, completion-time supersede, 143 exemption,
  synthesized open turns, the resume half of the raw exception),
  design §4.1 (supersede on completion; `.git` and raw-agreement
  containment), §4.6 (143 and crash exemptions, the generalized
  synthesis, the crash's single fatal), §4.7 (response-adopted
  resume), panel F31 (the resume amendment), the compatibility
  ledger (no `thread/started` on resume, live-proven, with the
  observed notification stream), and a CHANGELOG live11 Fixed entry.
  Checked and left alone: the archived raw panel transcripts
  (records of their conversations), the fixtures README (no claims
  touched), and the earlier report rounds (historical).

**Live checks.** One, by decision — the resume announcement is the
one claim a real harness can contradict. Through `./bin/codemux
session -a codex --no-sandbox --auto high --resume <thread-id>`,
against a staged writable HOME holding a private copy of the codex
home (auth copied at 0600, never printed; one recorded rollout) plus
a seeded fail-closed registry entry vouching the thread id, with no
turn submitted — zero provider requests, `thread/resume` rehydrates
locally. Result: exit 0; the notification stream after resume is
`remoteControl/status/changed`, a deprecation notice,
`account/updated`, two mcp startup statuses, and
`thread/status/changed` idle — and NO `thread/started`; the
`session_started` that follows is codemux-originated (`raw: null`),
adopted from the `thread/resume` response, and a cumulative
`thread/tokenUsage/updated` (163,701 total tokens from the thread's
history) rides the real usage stream before shutdown. Installed
codex: 0.159.3, exactly the floor. The claim in the driver comment
is substantiated; the stage was trashed after the run. Every other
fix this round is codemux-internal (no argv, environment, or wire
frame a real harness sees differs), so nothing else needs re-proving.

**A/B verification.** The five fixed `src/session` modules were
restored from the staged pre-live11 index in place (the live11
copies held in scratch, restored after) and the touched test files
run against the pre-fix tree. Twelve tests failed, each for its
finding's discriminator: majors 1 and 2 timed out waiting for the
interrupt record and the superseded resolution; major 3 received
`finish: "interrupted"` where `failed` was asserted; major 4 received
`reason: undefined` where `turn-timeout` was asserted; the 143 tests
received the false "exited with code 143 during the shutdown drain"
fatal; the crash tests counted two fatals where one was asserted;
the late-thread/started test received `raw` as the notification line
where null was asserted, and the pre-existing resume test hung in
`starting` — the finding's own failure mode; the registry test read
the prototype-keyed record as `outcome: "ok"`. The ceiling file
failed at import (the `spellingsInsideScope` export is new), so the
`.git` half was probed directly against the staged module: medium
returned `allowable: true` for both `.git/hooks/pre-commit` and
`.git/config` pre-fix, `false` with the `.git` reason post-fix. With
the fixes restored, all five files pass (171 tests across them, five
consecutive green runs of the claude file after the polling fix).
The codex crash-test extension was A/B'd separately after the main
pass (its assertions postdate the first swap): against the staged
`codex-driver.ts` alone it fails with two fatals where one is
asserted — the finding's own double-error shape — and passes restored.

**Gate.** `bun run typecheck` exit 0. `bun test --max-concurrency=1`:
**1170 pass / 0 fail / 6 skip across 1176 tests in 50 files** — the
live10 gate was 1155/0/6 across 1161 in 50, so this round adds the
fifteen regression tests with no regressions and no removals.
`make check` exit 0 (coverage 85.91% line, 91.63% function — live10
was 85.78/91.60). `make release-gate` exits 2 at the same documented
environmental `contracts` stage as every gate since live2 (installed
copilot `--help` needs `mkdir ~/Library/Caches/copilot/pkg/darwin-arm64`,
EPERM under this sandbox's `~/Library` denial — identical error text
re-observed); `runtime`, `check`, and the coverage suite pass before
the stop, and run past it `sandbox-contract`, `smoke`, `bun audit`,
`bun install --frozen-lockfile --dry-run`, and the CLI help smoke set
all exit 0. `check_american` clean on all 18 changed `.ts`/`.md`
files plus this report (exit 0).

## Review fixes, live12

**Intended commit:** `fix(session): live12 review fixes — open turns answered on the drain-failure exit class, driver-owned interrupt verdict with a roll-once stale window, resume thread-id echo checked`

The live12 review (one code review run at correctness-2 on Claude)
recorded one major and two minors. Every finding is fixed here with the
smallest correct change and one regression test each. The full-suite
delta versus live11 is +2 tests, no removals; two existing tests that
pinned the old interrupt mislabeling are rewritten to the corrected
semantics (their purpose — the completion-time supersede — is
unchanged).

**Major — the shutdown path could leave an open turn unanswered on the
one exit class the verdict reported** (all three drivers:
`src/session/driver.ts:897-972`, `src/session/codex-driver.ts:1273-1344`,
`src/session/agy-driver.ts:570-640`). Two blocks sit after the child
settles in every `finish()`: the live9 drain-failure verdict (a nonzero
exit that is not 143, not a crash end, a turn still open, no completion
delivered — a fatal plus exit 1) and the live10/11 open-turn synthesis —
and the synthesis's exit-code gate admitted only crash, null, 0, and
143, exactly the complement of the verdict. The two blocks partitioned
the exit space instead of composing, so the usual shutdown shape (the
caller shuts down mid-turn, the harness exits 1 — the claude-family
convention after an interrupt — before writing its result) emitted
`turn_started t1`, the fatal, and `session_ended` with `turn_completed
t1` missing: a caller waiting for each turn to close sees t1 open
forever, breaking §4.1's pairing rule in the one code path the rule was
built for. Fix: the exit facts are computed once — `drainFailureCode`,
non-null exactly when the verdict fires, a const so TypeScript narrows
it through both blocks — the synthesis gate drops the exit-code
disjunction (it now runs for every still-open unanswered turn), and the
synthesized finish is `failed` with the drain failure as the reason when
the verdict fired (mirroring the fatal's message) — `interrupted` with
the session-end reason otherwise, the crash case unchanged.
Regressions: the three exit42 tests extended in place with the
synthesized completion's assertions (turn id, `failed`, the drain
reason, raw null, all-null usage) — "a harness exiting nonzero during
the drain with its turn open costs success" in `tests/session-e2e.test.ts:1282`,
`tests/session-codex-e2e.test.ts:1237`, and
`tests/session-agy-e2e.test.ts:758` — the live11 precedent of extending
a test rather than adding a twin (each driver already had its exit42
test; the missing pairing was the un-asserted half of the same shape).

**Minor — a stale interrupt mislabeled both turns it touched**
(`src/session/driver.ts:610-637`, `src/session/claude-session.ts:370-390`).
The interrupt verdict lived in the parser: `ClaudeParseContext` carried
`interruptPending`, and the parser recast any completion — clean or not
— as `interrupted` while the flag was set, rewriting `isError` to false
for the spellings it recast. The race: the caller interrupts while t1's
result is already in flight → t1's clean result is labeled interrupted
and the flag clears → the already-written interrupt strikes t2 → t2's
error result reports `failed`. Both labels wrong, and neither turn
honest. The claude-family wire has no call-id correlation for interrupts
(unlike codex's `interruptCallId`, live11), so the pairing is bounded
state — and it belongs where the state lives, not in the parser. Fix:
the parser reports the raw error bit (`is_error`, or a subtype starting
with `error`) and the subtype as the reason; the driver's `completeTurn`
decides — an error result with an interrupt outstanding is the interrupt
striking (`interrupted`; `turn-timeout` as the reason only when the
interrupt came from the timeout), while a clean result with one
outstanding ended honestly and the already-written interrupt rolls to
exactly the next turn (`interruptRolled`: a fresh `sendInterrupt`
re-arms the window, a clean completion on the rolled turn too clears
it). Regression: "a stale interrupt labels the next turn interrupted,
never the clean one it missed" (`tests/session-e2e.test.ts:629`, the
fake's new `race` scenario — the interrupt handler completes the racing
turn cleanly and stashes the request id, so the interrupted-turn frames
land deterministically on the next turn). The parser unit test is
rewritten as "results report the raw error bit; the interrupt verdict is
the driver's" (`tests/session-claude.test.ts:374`, with the
`interruptPending` literals gone from every context). Two existing tests
pinned the old mislabeling and are updated with it: the ask+interrupt
and ask+turn-timeout tests' first completion is `end` now — the
supersede-deny ends the ask's turn cleanly before the interrupt lands
(the fake answers the deny synchronously, then bare-acks the interrupt
with no turn open), which is exactly the missed-interrupt case; the
interrupted label keeps its own coverage in the wait-scenario timeout
test and the shutdown-drain test.

**Minor — a codex resume never checked that the server returned the
requested thread** (`src/session/codex-driver.ts:738-755`). `threadId`
is preset to `resumeThreadId` at construction, so the adopt-if-null
never ran on the resume path, and nothing compared the response's id to
the request — the id the driver's own comment calls the subscription
proof, the echo the reference clients of the same app-server validate.
A server resuming into a different thread left codemux recording,
announcing, and steering under the requested id while the harness ran
another thread — the id every later `turn/start` and `turn/steer` would
target. Fix, placed before the adopt-if-null so a fresh `thread/start`
keeps adopting: a `thread/resume` response whose `thread.id` differs
from the request fails closed — one fatal naming both ids, a crash end,
no `session_started`. Regression: "a resume answered with a different
thread id fails closed" (`tests/session-codex-e2e.test.ts:289`, the
fake's FAKE_RESUME_WRONG_THREAD mode: the resume answers
`ffffffff-eeee-dddd-cccc-bbbbbbbbbbbb` and — as the pinned 0.159.3
server does on resume — sends no `thread/started`, so the wrong id rides
the response alone).

**Class audits** (before the gate, per the task):

- *Lifecycle class (the major):* every signal, shutdown, timeout, drain,
  and exit path walked in all three drivers and the CLI (the CLI relays
  driver events; it owns no pairing of its own). The finding itself
  named all three drivers and all three carry the same fix. The
  neighboring verdict inputs re-checked on the walk: `drainedCompletion`
  still exempts any delivered completion (failOpenTurn's included), 143
  still exempts itself, a crash end still emits exactly one fatal, and
  the exit143 and stdin-close paths keep their synthesis shape — pinned
  by the untouched tests beside the flipped ones. One sibling the walk
  surfaced and accepted as intended: the garbage-drain shape (a tier-3
  fatal inside the grace window, then exit 1) now also answers its open
  turn — the same drain-failure class, and the live7 test's assertions
  (first fatal, ended last, exit 1) are unchanged.
- *Interrupt-labeling class:* codex has no sibling — its interrupts are
  turn-addressed and call-id correlated (live11's `interruptCallId`
  handles the stale case; the failed-outranks-interrupt rule of live11
  major 3 is the deliberate contrast and keeps its own test). agy has no
  interrupt machinery at all (`interrupt: false`, honestly). The
  roll-once bound is documented where it lives: the `interruptRolled`
  field, `completeTurn`, and `sendInterrupt`.
- *Response-adoption class:* the fresh `thread/start` path already
  checks its echo — the parser grammar-checks `thread/started` against
  the expected thread id, and `turn/started`'s id must match (the
  ledger's rule) — so the resume response was the one server-issued
  adoption without a check. The registry records what codemux names;
  nothing else adopts a harness-issued id.
- *Doc class:* the drain and open-turn claims, the interrupted-labeling
  claims, and the resume-echo claims grepped across README, CHANGELOG,
  the design doc, the compatibility ledger, the panel docs, and module
  headers. Updated: README (the drain-failure class joins the
  answered-turn enumeration), design §4.2 (the `interrupted` label is
  the driver's verdict, roll-once), §4.6 (the synthesis runs for every
  still-open unanswered turn; the drain paragraph names all three
  shapes), §4.7 (the echo check, fail closed), the compatibility ledger
  (the echo check), and a CHANGELOG live12 Fixed entry. Checked and left
  alone: this report's live1–live11 sections (historical records of what
  those rounds shipped), the archived panel transcripts (records of
  conversations), and the fixtures README (recorded transcripts only —
  the fakes' scenario lists live in the fakes' own headers, both
  updated).

**Live checks.** None, by decision — every fix this round is
codemux-internal verdict, labeling, and adoption-check logic. No argv,
environment variable, or wire frame a real harness sees differs: the
interrupt control request, the `thread/resume` request, and every
translated event keep their shapes (the only new bytes on the stream are
codemux's own synthesized completions for turns that were left
dangling). Nothing needs re-proving against a live harness.

**A/B verification.** The four fixed `src/session` modules (driver,
claude-session, codex-driver, agy-driver) were restored from the staged
pre-live12 index in place (the fixed copies held in scratch, trashed
after; the fakes and tests stayed fixed) and the new and extended tests
run against the pre-fix tree. All failed for their findings'
discriminators: the race test received `interrupted` where `end` was
asserted (t1 mislabeled — the finding's first half); the three exit42
tests failed at the synthesized-completion assertions (no
`turn_completed` exists for the class pre-fix — `of(...)` yields
undefined and the field read throws); the wrong-thread resume test timed
out waiting for the session to end (pre-fix the driver announces the
requested id and the session never ends — the finding's own unguarded
world). With the fixes restored, the four files pass — 148 tests across
the three e2e files plus the parser unit file — and the full suite
below.

**Gate.** `bun run typecheck` exit 0. `bun test --max-concurrency=1`:
**1172 pass / 0 fail / 6 skip across 1178 tests in 50 files** — the
live11 gate was 1170/0/6 across 1176 in 50, so this round adds two
regression tests (the race and the wrong-thread resume; the parser unit
test is a rewrite in place) with no regressions and no removals.
`make check` exit 0 (coverage 85.90% line, 91.63% function — live11 was
85.91/91.63; the line dip is the new branches themselves).
`make release-gate` exits 2 at the same documented environmental
`contracts` stage as every gate since live2 (installed copilot `--help`
needs `mkdir ~/Library/Caches/copilot/pkg/darwin-arm64`, EPERM under
this sandbox's `~/Library` denial — identical error text re-observed);
`runtime`, `check`, and the coverage suite pass before the stop, and
run past it `sandbox-contract`, `smoke`, `bun audit`, `bun install
--frozen-lockfile --dry-run`, and the CLI help smoke set all exit 0.
`check_american` clean on all 14 changed `.ts`/`.md` files plus this
report (exit 0).

## Review fixes, live13

**Intended commit:** `fix(session): live13 review fixes — case-folded .git refusal, registry stamp outcomes reported, never-wait turn-path lock, all-live prune overflow`

The live13 review (correctness-2 and security on Claude; the contracts
auditor on zai GLM-5.3 was provider rate-limited and reported no
findings) returned one minor security finding and three minor
correctness findings — no blockers, no majors. The security lens also
re-audited the seams this design leans on (spawn resolution, project
config refusals, claude settings sources, codex sandbox flags, the
resume guards, the ceiling over caller answers, credential
environments) and confirmed each matches `run` or is narrower; no
capability flag was shown dishonest, so none changed.

This round resumed an interrupted one. The staged tree already carried
three partial fixes: the ceiling's case fold with its regression test
(complete), the prune's all-live second pass (complete), and a
half-made async conversion of `updateRegistry` — its body awaited
`acquireLock` while the three wrappers still returned `UpdateOutcome`
synchronously, so typecheck failed. The conversion was **reverted, not
completed**. Making it coherent would have forced the line dispatch
(`SessionProcess.onLine` is a synchronous callback; `applyParse` runs
inside it) through an async restructure in all three drivers, because
`recordStart` feeds the init frame's announce gate (`registryRecorded`
is read immediately after the call — §4.8's announce-follows-the-record
invariant). That restructure is exactly the event-ordering class the
live12 round just pinned down, and the payoff it uniquely buys —
yielding during the start/end lock waits — was not the finding's harm.
The fix below addresses the harm at its actual site.

**Security, minor — the medium `.git` refusal compared components
case-sensitively (`ceiling.ts`).** `forms.raw.split("/").includes(".git")`
passes `.GIT/hooks/pre-commit`, which a case-insensitive filesystem
(macOS's default, Windows) opens as the real `.git` — a caller could
approve an executable hook at medium, the exact refusal review live11
added; codex patch approvals ride the same predicate. The comparison
now folds case outright, both spellings and both forms (`raw` and
`nfc`). The fold is deliberately blanket: on a case-sensitive disk it
over-denies a directory literally named `.GIT` at medium — a
pathological name, cheap to refuse fail-closed — and it stops leaning
on `realpath`'s manner of rewriting an existing mixed-case spelling
onto the on-disk case. Low and high are untouched (the caller answer
and the bare grant). Regression test in `tests/session-ceiling.test.ts`:
`.GIT` and `.Git` spellings deny at medium with and without a real
`.git` on disk, high still allows, and a plain in-scope file still
passes (whole components, not substrings).

**Correctness 1 — registry stamp failures were silently swallowed.**
`updateRegistry`'s outcome contract is total (it catches everything and
returns `{ok:false}`), so the `try/catch` around every touch and end
stamp was dead code and the outcome went unread: a lost end stamp (the
registry's mode changed mid-session, or the writer lock stayed held
past its budget) left no stderr line, `session_ended` still reported
`resumable: true` at exit 0, and the record kept looking owned by a
live process — so a later resume could be refused `session_busy` (when
a reused pid passes the liveness check) with nothing explaining why.
All six best-effort sites now read the outcome and report on stderr
(the existing `codemux:` diagnostic carrier the queue failures use):
the end stamp always (it fires once per session, and its message names
the `session_busy` consequence), the touch once per session (a
`touchWarned` flag on each driver — the touch is best-effort and now
never waits, and per-turn repetition under sustained contention would
be spam). `resumable` itself stays truthful — a failed end stamp does
not make the session unresumable (the owner-liveness guard clears it
once the process is reaped); the warning is where the caveat lives.
`recordSessionStart` was already checked and fatal at all three sites;
the CLI holds no registry write path (its `--resume` is read-only
through `lookupForResume`), and the four remaining `catch` blocks in
`process.ts` all return outcomes or route to the fatal channel — no
other swallowed-outcome sibling exists in the lifecycle class
(signal, shutdown, timeout, drain, and exit paths walked in all three
drivers).

**Correctness 2 — pruning could write a registry its own validator
rejects.** `prune` skipped every entry with a live owner; with more
than `REGISTRY_MAX_ENTRIES` live sessions the file it wrote was
oversized, `validRegistryFile` reads that as corrupt on the next open,
every resume then fails closed, and the next start backs the file up
and resets it — dropping the records of every live session. The prune
now has a second pass: when every survivor of the live-sparing pass
still leaves the file oversized, it evicts the oldest by
`last_activity` anyway. The registry is a lookup hint (§4.8): an
evicted session's resume answers `not_found`, a smaller and fail-closed
loss than a registry no reader trusts. A sibling defect in the same
hold-the-lock class came out of the audit: pass 1 judged liveness once
per entry, and each unread process table is a full process enumeration
(`ps` on macOS) — a thousand live owners held the writer lock for a
thousand enumerations, starving every other codemux writer into their
(bounded) lock-failure paths. `prune` now reads one snapshot up front
and `processIdentityAlive` accepts it (`registry-io.ts`); one-shot
callers are unchanged.

**Correctness 3 — the turn-path lock wait froze the event loop.**
`acquireLock`'s retry sleep is `Atomics.wait` on the main thread, and
`touchSession` ran it synchronously inside harness-line handling on
every turn completion: behind another codemux process's write, the
session stopped reading the harness's stdout, stopped flushing caller
events, and stopped servicing signal handlers for the lock's full
budget (~10 s). The touch now takes a single-attempt lock
(`attempts: 1` — one namespace sweep, zero sleeps, fail fast) through
a `LockOptions` passthrough on `touchSession`/`updateRegistry`. The
start and end writes deliberately keep the full budget: their writes
are load-bearing (a failed start fails the session closed; a failed end
leaves a live-looking owner — finding 1's harm), and they run at
session boundaries where a wait delays the boundary rather than a live
exchange. `readRegistry`/`lookupForResume` take no lock and were never
in the class; `acquireLock` has no other production caller.

**Sibling audit (docs and comments).** The "never evicts a live owner"
claim appeared in `registry.ts`'s module header (fixed to state the
all-live exception), `docs/LIVE-SESSIONS-DESIGN.md` §4.8 twice (both
fixed, and the lock paragraph now states the never-wait touch rule),
and `docs/live-sessions-report.md`'s registry description (fixed in
place). `docs/LIVE-SESSIONS-PANEL.md` carries the same phrase but is
the archived record of the panel round that adopted the rule, not a
description of current behavior, so it stays as written. README and
CHANGELOG made no claim this round invalidates; CHANGELOG gains the
live13 entry. `registry-io.ts`'s `LockOptions` doc now names the
never-wait contract for live-event-path callers.

**A/B verification.** Each fix was reverted in isolation and its test
run against the pre-fix code, then restored: the case-fold revert fails
the `.GIT` test; removing the prune's second pass fails the all-live
test (the registry reads back corrupt); dropping only `attempts: 1`
from the driver's touch fails the e2e test on timing — the pre-fix run
took 10064 ms, the finding's own ~10 s freeze made visible — while
dropping only the warning fails it on the missing stderr line; and the
swallowed end-stamp revert fails the lost-end-stamp test the same way.
One discriminator cannot fire under this sandbox: the prune-snapshot
timing bound is trivially met when `/bin/ps` is EPERM-denied (the
table reads empty and liveness degrades to signal-0 probes), so that
assertion only discriminates on hosts where process enumeration works.

**Gate.** `bun run typecheck` exit 0. `bun test --max-concurrency=1`:
**1177 pass / 0 fail / 6 skip across 1183 tests in 50 files** — the
live12 gate was 1172/0/6 across 1178 in 50, so this round adds five
regression tests (the ceiling fold, the never-wait touch, the all-live
prune, the touch warning, the end-stamp warning) with no regressions
and no removals. `make check` exit 0 (coverage 85.96% line, 91.63%
function — live12 was 85.90/91.63). `make release-gate` exits 2 at the
same documented environmental `contracts` stage as every gate since
live2 (installed copilot `--help` needs
`mkdir ~/Library/Caches/copilot/pkg/darwin-arm64`, EPERM under this
sandbox's `~/Library` denial — identical error text re-observed);
`runtime` and `check` pass before the stop, and run past it
`sandbox-contract`, `smoke`, `bun audit`, `bun install
--frozen-lockfile --dry-run`, and the CLI help smoke set all exit 0.
One flake was observed across the gate runs and did not reproduce in
five reruns (three of the e2e file and two full coverage suites, all
clean): the turn-timeout test hit bun's default 5 s per-test timeout
once under full-suite coverage load, its session showing an early
harness-process death (two error events, `session_ended`, no
`session_started`). Nothing in this round touches spawn, init handling,
or the turn-timeout machinery, and the test's own content is unchanged;
the signature reads as subprocess startup under load, not logic.

**Live checks.** None this round, deliberately: every fix is internal
to the registry/ceiling paths (no harness wire behavior, no resume
command shape, no capability flag), and each is pinned by the fake-driven
e2e and unit tests above — the one claim a live run could add, that a
real contended registry delays nothing on the turn path, is exactly
what the 10064 ms A/B already demonstrated against the real lock.

`check_american` clean on the twelve changed `.ts`/`.md` files (exit
0). The A/B backups under `scratch/live13-ab/` were trashed after the
verification.

## Review fixes, live14

**Intended commit:** `fix(session): live14 review fixes — lock-corpse steal by name-pid, pinned ps clock, bounded steer batching, wire-verdict finish, ordered early-shutdown acks`

The live14 review (correctness-2 on Claude; contracts on zai
GLM-5.3) returned three major and two minor correctness findings plus
one minor contracts finding — no blockers, no security findings (the
security lens reported nothing this round). Every finding is fixed with
its regression test; no capability flag was shown dishonest, so none
changed.

**Correctness, major — a lock file with no content blocked every
registry write until someone deleted it by hand
(`registry-io.ts`).** `openSync(ourName, "wx")` creates the held file
before `writeSync` fills it, and a write that throws (ENOSPC, EIO) or a
process killed between the two retried the acquisition but never
unlinked the empty corpse. `heldLockState` read `Number("")` as 0 and
answered `unknown`, and an unjudgeable file was never stolen — from
then on every `acquireLock` burned its full ~10 s budget and failed:
no session could start, stamp, or end. Two fixes, one at each end:
the failed acquirer now unlinks its own `ourName` before retrying, and
`heldLockState` falls back to the pid encoded in the never-reused file
name — a held name is `.<lock>.<pid>.<salt>.held`, minted only by
`acquireLock` itself, so a dead name-pid with an unjudgeable payload
(empty, junk, anything) can only be that failed acquisition's leftover
and is stolen by the same name-consuming steal every corpse gets. A
live name-pid still blocks fail-closed: the file's owner may be alive
and merely unreadable, exactly the pre-existing judgment. Tests: the
dead-acquirer corpse is consumed by the steal with only our own held
file remaining; the unjudgeable-live-name-pid case still blocks and
survives (the pre-existing fail-closed test was reseeded to a live pid
— its old seed used the dead 999999, which the name-pid fallback now
correctly steals, so the old test was pinning the wrong arm).

**Correctness, major — the macOS lock-owner check depended on `TZ` and
locale (`process-table.ts`).** BSD `ps` formats `lstart` in the ambient
time zone and locale, and the `Bun.spawnSync` passed the caller's
environment through — two codemux processes with different `TZ` values
minted different start tokens for the same live pid, and the registry's
identity checks (the live-owner guard, the writer lock's steal, the
live-sparing prune) judged a live writer dead: a stolen lock, a
`session_busy` resume waved through while the session ran. The spawn
now pins `TZ=UTC LC_ALL=C` (a pure `psEnvironment` helper the test
asserts on directly — `/bin/ps` is EPERM-denied in this sandbox), so
the token is a property of the process, not the invoker's shell. One
accepted consequence, worth naming: tokens recorded by pre-fix
processes under a different environment will not match a post-fix read.
The registry is unreleased, dev/test-only state, so no live migration
is owed — a stale-seeming pre-fix record reads as resumable (owner
dead), which is the safe direction for a lookup hint.

**Correctness, major — combined steers could crash a codex session
after both were acked (`codex-driver.ts`).** Each steer passed
`harnessTextDeliverable` alone and was acked, but while `turn/start`
was in flight they waited in a buffer whose flush joined every text
into ONE `turn/steer` frame with no size check — two 9 MiB steers made
a ~18 MiB frame over the 17 MiB write cap, `writeToHarness` refused it
as oversize, and the session ended as a codemux crash with both inputs
already accepted. `flushSteer` now grows the batch only while the
built frame fits `harnessLineDeliverable` (the exact `writeLine`
predicate), so the join falls back to one request per steer — the
wire's common shape anyway, since a steer arriving after the turn
started always sent its own request. The probe frame is
byte-identical to the sent one because `call` assigns
`requestCounter + 1` and nothing else moves the counter between the
probe and the send. Test: two 9 MiB steers buffered behind a 250 ms
`turn/start` delay (a new `FAKE_TURNSTART_DELAY` fake mode) land as
two separate `turn/steer` requests of one text each, the turn
completes `end`, no fatal, exit 0.

**Correctness, minor — a codex turn that completed normally was labeled
`interrupted` (`codex-driver.ts`).** When a caller interrupt or a
`--turn-timeout` raced a `turn/completed {status:"completed"}`, the
pending-interrupt override recast the finish to `interrupted` (and the
reason to `turn-timeout` on the timeout path) even though the full
answer was delivered, and the interrupt's later rejection could not
correct the label. The fix is wire truth: codex's `turn/completed`
names `interrupted` itself, so the wire's status is the verdict — a
`completed` stays `end`, a `failed` keeps its message (the live11
rule), and the one label the driver still adds is a wire `interrupted`
that the timeout's own interrupt produced, which names its cause as
`turn-timeout`. This is the deliberate family difference from the
claude side, whose wire never says `interrupted` (an interrupt arrives
as an error result there), which is why its driver-owned pairing at
`driver.ts` stays — that code was audited and is already correct (a
clean result with an interrupt outstanding ends `end`). Tests: a new
`latecomplete` fake scenario holds the interrupt's response while the
turn completes cleanly, then rejects the interrupt — the finish is
`end`, no reason, exactly one non-fatal "no longer running" error; and
the two existing supersede-decline tests (caller interrupt and turn
timeout) now assert `end`, since their wire path emits `completed` once
the declined approval resumes the turn — pre-fix they pinned the
recast. The design doc's `turn_completed` and `--turn-timeout` claims
were updated to the wire-verdict rule (the README's line claims no
label and needed nothing).

**Correctness, minor — an early `shutdown` got its `input_seq` ahead of
an earlier line (`codex-driver.ts`).** A `user` line parked unsequenced
in the startup buffer while the shutdown behind it acked at once as
seq 1; the parked line's later rejection came as seq 2, so a broker
matching acks in order read its user line's rejection as the
shutdown's answer. The starting-state shutdown branch now rejects the
parked lines first, arrival order preserved, then acks the shutdown —
mirroring `finish()`'s own drain of the same buffer, so the pair is
idempotent (the drain finds an empty buffer). Test: user then shutdown
under a stalled handshake yields rejection seq 1 (`shutting_down`)
then accepted seq 2, no session ever announced.

**Contracts, minor (reported only) — the Write add/edit split was
documented as an `lstat` but implemented with `existsSync`.** The code
(`driver.ts`, the stash-time check) follows symlinks: a target that
exists through one is an edit, a dangling link's missing target is an
add — while the comments said `lstat`, whose link-itself semantics
answer the other way. The design's own §4.2 wording matches the code,
so the comments were fixed to name `existsSync` and its follow-the-link
behavior (claude-session.ts, the e2e and claude test comments, the fake
claude harness header); the historical live14-review quote further down
this report is left as written, the established rule for past sections.
No behavior change — the finding named no trigger beyond the comment
disagreement.

**Class audit — the write path (`SessionProcess`).** Walking the
deliverability class past the finding turned up one real sibling: a
line larger than the pipe (64 KiB) hands its remainder to Bun
FileSink's async drain, and a harness dying mid-drain rejects that
write promise with EPIPE — an *unhandled* rejection that killed the
test process (and would kill a broker's codemux) instead of surfacing
through the child's exit, which is what actually reports the death
(the submit already succeeded; `writeLine`'s `{ok:false, reason:
"closed"}` contract covers submit-time failures only). The drain
rejection is now absorbed on both the write and the `end()` half-close
paths, with the child's exit named as the reporting path. Found while
making the steer-split test deterministic: the K3 e2e test waits for
the fake to have read both split frames before shutting down, because
the fake dies at once on the shutdown SIGTERM while a 9 MiB line is
still draining — the split is what the test measures, not the drain's
race with the kill. Test: a child that reads nothing and exits with
most of a megabyte undrained produces no unhandled rejection, the
submit still reports `ok:true`, and the exit path tells the story.

**Class audit — lifecycle.** Signals: the shared gate is unchanged and
pinned by its existing test. Shutdown/ack ordering (the seq finding's
class): the claude and agy drivers take `nextInputSeq()` and ack in the
same synchronous pass at arrival — nothing parks, so the reorder cannot
occur there; codex's three `preSessionLines` sites (the fixed
starting-state shutdown, `finish()`'s drain, the `session_started`
replay) all preserve arrival order and stay idempotent with each
other. Timeout labeling: every path that clears the interrupt flags
was re-checked — `completeTurn` and `failOpenTurn` clear all three on
every completion, and the rejection path clears only the matching call
id, so no stale `interruptFromTimeout` can relabel the next turn's
interrupt. Drains and exits: the live9/10/11 drain verdicts and
syntheses are untouched and covered by their tests. The CLI forwards
caller stdin lines in arrival order with no buffering of its own.

**A/B verification.** Each fix was reverted in isolation (restoring the
pre-fix source from the staged index) and its test run, then restored:
the registry-io revert fails the dead-acquirer steal test (31 pass,
1 fail); the process-table revert fails the whole file on the missing
`psEnvironment` export (0 pass, 1 error); the codex-driver revert fails
all five touched tests — the steer split, the wire-verdict latecomplete
race, the early-shutdown ordering, and both supersede-decline tests
that now assert `end` (48 pass, 5 fail, each on its own discriminator);
the process.ts revert fails the EPIPE test with the unhandled
`EPIPE: broken pipe, write` (22 pass, 1 fail). The comment fixes are
not A/B-able (no behavior to discriminate).

**Gate.** `bun run typecheck` exit 0. `bun test --max-concurrency=1`:
**1183 pass / 0 fail / 6 skip across 1189 tests in 50 files** (exit 0) — the
live13 gate was 1177/0/6 across 1183 in 50, so this round adds six
regression tests (the lock-corpse steal, the pinned ps environment, the
steer split, the wire-verdict race, the early-shutdown ordering, the
absorbed EPIPE) with no regressions and no removals. `make check` exit 0; `make release-gate` on the host exit 0 (1187 pass / 0 fail / 2 skip
across 1189; one run saw the new `racing timeout` test fail under full-suite load and pass 5/5 in
isolation — it is timing-dependent and is reported to the next review round). `check_american` on the changed prose and comment
files: exit 0,
clean on all seventeen changed `.ts`/`.md` files.

**Live checks.** None this round. All six fixes are codemux-internal —
lock mechanics, `ps` invocation, frame batching, a label choice, ack
ordering, comment accuracy — and each is pinned by the fake-driven
tests above; no claim about a real harness's wire behavior changed, so
there is nothing a live run would re-prove that the fixtures and the
A/B runs have not.

## Review fixes, live15

**Intended commit:** `fix(session): live15 review fixes — turn_started at submit, deliverable-only allows, handshake stops at end, strict ids, linear framers`

The live15 review (correctness-2 on Claude; contracts on zai
GLM-5.3, reported-only) returned two confirmed major defects in the
codex driver (one blocker-grade pair under one label), nine minor
correctness findings across the three drivers and the process layer,
one minor documentation finding, and one operator host-gate item.
Every finding is fixed with its regression test; no capability flag
was shown dishonest this round, so none changed.

**Correctness, major — a codex turn could complete without ever
starting (`codex-driver.ts`).** `turn_started` rode the harness's
`turn/started` notification, but the FSM opens the turn at submit and
the claude family emits its own `turn_started` at submit — so a
`turn/start` error (trigger A) completed a turn the caller never saw
open, and a shutdown before the notification (trigger B) synthesized
an interruption for an unannounced turn, both orphan completions
against §4.1's pairing. Fix: `submitTurn` emits the caller-facing
`turn_started` at submit, claude-family style, `raw: null` (no harness
line exists for it yet), and the harness's `turn/started` notification
mirrors as tier-1 `unknown` — the same rule as the claude family's
replay echo of codemux's own user line, never silently dropped. Tests:
the lifecycle test asserts `raw: null` plus the notification's `unknown`
mirror; the failstart test waits the start and asserts it precedes the
completion; the hold-turnstart test asserts the start is on the stream
before the shutdown and the drain delivers exactly one completion, the
harness's own frame. A/B: pre-fix all three fail — no `turn_started`
ever emits.

**Correctness, major — the caller was told allow while codex received
a decline (`codex-driver.ts`, `codex-session.ts`).** `approvalAccept`
substituted `pickApprovalDecision`'s fallback when the wire's
`availableDecisions` omitted plain `accept` (for example
`["acceptForSession","decline"]`) while the driver resolved "allow"
and acked accepted — a success reported on a failure path. codemux
never answers `acceptForSession` (the pinned per-request refusal
rule), so allow is undeliverable there. Fix: `allowDeliverable` gates
the advertised `options` (`["deny"]` alone for such a request) and the
allow path — an allow is rejected `unsupported`, the wire carries the
decline, `permission_resolved` says deny, and a non-fatal error names
what happened. Test: the fake's `acceptless` scenario asserts the
options, the rejection, the resolution, the wire decline keyed to the
request, and the turn completing on it. A/B: pre-fix the test fails at
the `options` assertion.

**Minor — the codex handshake kept going after an end path began
(`codex-driver.ts`).** Neither `applyResponse` nor `applyResponseError`
checked `this.finished`: an initialize response landing inside the
shutdown drain sent the initialized notification and the thread
request, the thread response adopted the id, and the resume path could
record a registry start and announce `session_started` after the
shutdown was already acked. Fix: the handshake is codemux's own
continuation chain — initialize answers into thread/start (or
thread/resume), which answers into the announcement — and it stops the
moment an end path began, on both the success branch (nothing further
sent, adopted, or recorded) and the error branch (a handshake error
nobody waits for no longer turns the acked end into a crash). This is
deliberately unlike the claude family's init frame and agy's first
result — harness-initiated identity frames carrying the first real
content — which keep the live5 announce-during-drain rule; the
distinction is documented at the stop guard. Tests:
`FAKE_STALL_INIT=release` (the fake answers the held initialize on
the shutdown SIGTERM, deterministically inside the drain) for both a
fresh and a resumed thread — no `session_started`, no error,
handshake-only requests, `readRegistry` outcome `missing` — and
`rejectrelease` for the error sibling, exit 0. A/B: pre-fix both
fail (the chain runs, the registry records, the announcement fires).

**Minor — an unrecognized `turn/completed` status left the turn open
forever (`codex-session.ts`).** The line passed through as tier-1
`unknown`, so the FSM never closed the turn, queued input never ran,
and only a timeout or shutdown ended the session. Fix: a
`turn/completed` whose status the driver does not recognize is a
recognized method naming the open turn — it completes the turn
`failed` with the status named ("the turn completed with unrecognized
status expired"; no status at all is its own message), fail-closed.
Test: the fake's `badstatus` scenario plus a queued second user line —
t1 fails with the named status, t2 runs to `end`. A/B: pre-fix the
test times out (t1 never completes).

**Minor — response ids were matched loosely
(`codex-driver.ts`).** `pendingCalls.get(Number(id))` accepted a
string `"1"` as the reply to numeric request 1. Fix: ids match
strictly — `typeof id !== "number"` fails closed ("a response
references unknown request id 1"), in `applyResponse` and
`applyResponseError` symmetrically. Test: `FAKE_STRING_ID_RESPONSE`
echoes the initialize id as a string — fatal, crash end, no
`session_started`. A/B: pre-fix the test times out (the string is
consumed as the reply and the handshake waits forever).

**Minor — a fresh thread's id was never cross-checked
(`codex-driver.ts`).** A `thread/started` notification adopting the id
before the `thread/start` response left the response's own
`thread.id` unchecked — the driver announced one id while the response
named another, two ids for one session, with turn/start aimed at
whichever survived. Fix: the response is compared with the adopted id
and a mismatch fails closed naming both, like the resume-path echo
check (review live12), plus the symmetric notification-side check
("the app-server announced thread X, not the adopted Y"). Tests:
`FAKE_ANNOUNCE_OTHER_THREAD` announces 99999999-… then answers
thread/start with 0123456789abcdef — the session announces under the
adopted id (it did exist), then the contradiction fatals; the badthread
e2e test now finds the SPECIFIC unknown carrying the foreign frame
(the turn/started mirror is an unknown now too). A/B: pre-fix the
mismatch test fails at the fatal's absence.

**Minor — the cumulative `total_tokens` counted a missing figure as
zero (`usage.ts`).** Turn 1 reporting no cache count and turn 2
reporting one produced a cumulative total that guessed turn 1's cache
as zero — the old rule matched the components but the value was still
a guess. Fix: `addTurnUsage` certifies the running total only while
every folded turn reported every part; the total goes null the moment
a fold cannot certify it and stays null (the live10 both-null rule
matched components, this closes the value). Tests: the finding's exact
example ("a turn's missing figure is never counted as zero in the
total") and the strengthened exact-or-null case.

**Minor — claude-family frames with no session id were accepted
(`claude-session.ts`).** The id check ran only when `session_id` was a
string, so a `result` with a missing or null id could close the open
turn. The recorded wire stamps every
system/assistant/user/stream_event/result frame with the id, so its
absence on those types is drift — tier-2, fail-closed — while
unstamped control frames and unknown types keep passing through. Test:
"a stamped frame without a session id is a grammar error, never an
accepted event" (missing and null spellings, unstamped shapes still
legal).

**Minor — an empty `text_delta` was dropped silently
(`claude-session.ts`).** Neither emitted nor mirrored, breaking the
never-dropped rule. Fix: an empty delta mirrors as tier-1 unknown, the
codex parser's delta rule, one rule for both parsers. Test: the delta
test feeds an empty `text_delta` and asserts the `unknown` parse.

**Minor — the Write add/edit check used the wrong directory
(`driver.ts`).** `existsSync` resolved a relative `file_path` against
codemux's own working directory, not the session's `--cwd` — the
harness never runs in codemux's cwd, so the add/edit split consulted a
directory irrelevant to the write. Fix: the target resolves against the
session cwd, the same literal join the ceiling uses. Test: "a relative
Write target resolves against the session cwd, not codemux's own"
(session-e2e, file present in the session cwd only).

**Minor — the line framer rescanned from byte 0 on every chunk
(`process.ts`), and its CLI sibling did the same (`cli.ts`).** A line
near the cap arriving in pipe-sized chunks cost a quadratic scan. Fix:
the harness-side framer grows its buffer on demand and resumes the
newline scan where the last one stopped. The class walk found the
caller-stdin framer guilty twice over — `Buffer.concat` recopied the
whole buffer on every chunk AND the scan restarted at byte 0 — so it
was rewritten to the same shape, and `frameCallerStdin` is now
exported with an injectable `FramedInput` so the framing is testable
without the process's own stdin. Tests: the harness side keeps its
CPU-time-budget test (eight 12 MiB lines through a real pipe); the CLI
side gains a hand-driven unit pair — framing correctness (CR stripped,
blanks skipped, tail on end, unframe detaches) and the same CPU budget
over 32 × 12 MiB lines in 64 KiB chunks. A/B: the quadratic variant
burns 1872 ms of CPU and fails the 600 ms budget; the fix lands at
tens of milliseconds.

**Contracts, minor — the held-lock filename pattern was documented
wrong (CHANGELOG, design doc).** Both documents spelled it
`.<registry>.<pid>.<random>.held`, which matches nothing the code
creates — the real shape is `.<lock>.<pid>.<salt>.held`
(registry-io.ts mints `.${base}.${pid}.${salt}.held` beside
`live-sessions.json.lock`). Fixed in both; the module header and the
live14 report round already carried the correct spelling, and the
live9 round's own historical record (which says `.<base>.…`, the
code's variable name) stays as history.

**Host gate (operator) — the latecomplete race test was flaky under
the full suite.** The flake did not reproduce in this sandbox: two
clean full-suite runs before the restructure and the gate run after it
all passed the test. The test was still made deterministic — the fake
writes the completion and the too-late rejection in one timer callback
(the causal order is structural), and the test now waits for that
specific rejection before the shutdown and asserts the exact counts
(turn_completed × 1, the named error × 1) only after `run()` settles,
removing the order assumption that raced a load-slow event loop. No
driver change: the race the old test tried to observe through timing
is already pinned by the fake's ordering.

**Class audits.** Lifecycle: every signal, shutdown, timeout, drain,
and exit path was walked in all three drivers and the CLI. agy
already emits `turn_started` at submit (no sibling of the major); agy
and claude keep the live5 announce-during-drain rule for their
harness-initiated identity frames (the codex handshake is the one
codemux-initiated chain, and the distinction is documented at the new
stop guard); every other `Number(` cast in the session sources is
pid/version parsing with its own validation, not JSON-RPC id
correlation; the CLI's end sequence (run → unframe → dispose →
stdin.destroy → exitCode) needed no change — its only defect was the
framer sibling, fixed above. Usage folding: all three normalizers
(claude-family and agy in result-envelope.ts, codex in
codex-session.ts) already compute totals only when every addend is
known — no zero-guess siblings. Docs: the held-lock pattern was
grepped everywhere (two wrong spellings, both fixed); no document
claimed the notification-riding turn model, and the design doc's §4.7
now states the submit-time rule and the §4.2 `permission_request`
options line states the deliverable-only rule (a request advertising
`deny` alone); the README's `permission_decision` row gained the same
clause. Historical report round records stay as written.

**A/B verification.** Each codex fix was reverted in isolation and its
test run, then restored: the turn-model revert fails all three tests
(no `turn_started` ever emits); the acceptless revert fails at the
`options` assertion; the handshake-stop revert fails both drain tests
(the chain runs, the registry records); the badstatus revert times out;
the string-id revert times out; the thread-mismatch revert fails at
the fatal's absence. The CLI framer revert fails the CPU budget at
1872 ms. The parser and usage fixes were A/B'd in their rounds of this
same work (the claude no-id and empty-delta tests fail on their
discriminators pre-fix; the usage total test fails with the guessed
zero). The doc fixes are not A/B-able.

**Gate.** `bun run typecheck` exit 0. `bun test --max-concurrency=1`:
**1195 pass / 0 fail / 6 skip across 1201 tests in 50 files** — the
live14 gate was 1183/0/6 across 1189, so this round adds twelve
regression tests (the three turn-model tests, acceptless, the two
handshake-stop tests, badstatus, string-id, thread-mismatch, the usage
total pair, the claude no-id and empty-delta cases, the relative-Write
test, the harness-side CPU framer test, and the CLI framer pair) with
no regressions and no removals. `make release-gate` stops at the same
documented environmental `contracts` failure as every prior round —
the installed copilot binary's `--help` needs
`mkdir ~/Library/Caches/copilot`, denied to this session's process by
macOS (`~/Library` is unreadable even to `stat`), unchanged from the
tree's baseline and outside it; every other gate component passes on
the host: runtime, typecheck, shell, the full test step above,
sandbox-contract, smoke, `bun audit` exit 0, and
`bun install --frozen-lockfile --dry-run` exit 0. `check_american` on
the eighteen changed `.ts`/`.md` files: exit 0, clean.

**Live checks.** None this round. Every fix is codemux-internal —
driver state machine, id correlation, framing arithmetic, docs — and
each is pinned by the fake-driven tests above; no claim about a real
harness's wire behavior changed (the acceptless approval shape comes
from the app-server's documented `availableDecisions`, reproduced by
the fake), so there is nothing a live run would re-prove that the
fixtures and the A/B runs have not.

## Review fixes, live16

**Intended commit:** `fix(session): live16 review fixes — idle-only queue drain, forwarded input in the drain, validated ids and registry writes, resume reach guard`

The live16 review (correctness-2 on Claude, security, contracts)
returned one blocker, two major correctness findings, one major
security finding (the auditor graded it minor with bounded impact; the
gate summary lists it major), and three minor correctness findings. The
contracts lens recorded no findings of its own. Every finding is fixed
with its regression test. No capability flag was shown dishonest this
round, so none changed.

**Correctness, blocker — two early lines crashed a fresh codex session
(`codex-driver.ts`).** Two `user` lines parked before `session_started`
replayed in order: the first opened t1, the second queued. Then
`announceSession` called `drainTurnQueue` unconditionally, which checked
only the queue count and `finished`, so it submitted t2 while t1 was
open. The FSM refused ("turn t2 started while turn t1 is active"), the
session crashed with exit 1, and both lines had already been acked
accepted. Fix: `drainTurnQueue` returns unless the FSM is `idle`, so the
queue drains only from a completion. Test: "two user lines before
session_started run as two turns in order" — t1 and t2 both end `end`,
no error, exit 0. A/B: pre-fix the test times out on the second
completion.

**Correctness, major — a forwarded queued input could turn a clean
shutdown into exit 1 (`driver.ts`).** The claude family forwards a
mid-turn `user` line at once and the harness queues it. On `shutdown`,
`finish` reported the line "dropped", wrote the end-interrupt, and sent
SIGTERM. A harness that answered the interrupt and then ran its queue
inside the grace window emitted a `result` with no open turn, so
`completeTurn` raised a grammar fatal and the exit code became 1. The
"dropped" notice was also false: the harness held the line. Fix:
`finish` records the forwarded count (`forwardedAtEnd`) and the notice
now says the harness may still run the line while shutting down. A
`result` that arrives inside the drain with no open turn while that
count is positive is mirrored as `unknown`, never fatal and never
silently dropped. No turn can open during the drain, so a mirror is the
only honest carrier. The codex notice keeps "dropped": codex's queue is
codemux's own and nothing was forwarded. Test: "a forwarded queued input
the harness runs during the drain is mirrored, not fatal" (the fake under
`FAKE_SIGTERM_PERSIST=1` answers the interrupt and then runs the queued
line). A/B: pre-fix exit 1.

**Correctness, major — a harness-supplied id could corrupt the registry
(`registry.ts`, `codex-session.ts`, `codex-driver.ts`,
`agy-session.ts`).** agy's `conversation_id` and codex's `thread.id`
were adopted if non-empty. An id over the reader's 128-character cap was
written, the reader then rejected the whole file, every `--resume`
exited 78, and the next fresh start's backup-and-reset dropped every
record, live owners included. Two fixes, so the class cannot recur:
`updateRegistry` validates the file with the reader's own
`validRegistryFile` before the atomic write and refuses the update
otherwise ("nothing was written"); and the ids are checked at adoption
against the `--resume` patterns (`CODEX_THREAD_ID_PATTERN` on both the
`thread/started` notification and the `thread/start`/`thread/resume`
response, `AGY_CONVERSATION_ID_PATTERN` on agy's result), each a fatal
grammar error. Tests: the registry pre-write test (an over-cap id is
refused and the earlier record still reads `ok`), the codex parser and
agy parser id tests, and a codex e2e test (`FAKE_THREAD_ID` of 129
characters: fatal, no `session_started`, registry `missing`). A/B: each
of the four reverts fails its test.

**Security, major — a resume could widen reach the sandbox guards did
not cover (`registry.ts`, `cli.ts`, all three drivers).** The record
compared `--sandbox-no-net` and `--sandbox-scrub-env` one-directionally
but not `--pass-env`, `--enable-playwright-mcp`, or `--cwd`. The
auditor's trigger: create a codex session in `/tmp/untrusted-checkout`,
resume with `--cwd ~/repo`; every guard passed and the possibly injected
thread got write access to another tree. Fix: `SessionRecord` gains
`pass_env` (the sorted names, never values) and `playwright_mcp`, set
from the driver options the CLI passes (codex and agy record `false`;
the CLI refuses the MCP for them). `lookupForResume` refuses a
different `cwd` (both sides are canonical: `validateWorkingDirectory`
realpaths them), an added `--pass-env` name, and turning the MCP on;
dropping either narrows and passes. The registry stays a lookup hint:
the record still supplies no flag, env, or path to the resumed process,
it only refuses. Records written by earlier builds of this branch lack
the two keys and read as corrupt; the next fresh start backs that file
up (the existing recovery path). The branch is unreleased, so the
format stays version 1. Tests: the registry guard test (each refusal,
the subset and reorder cases passing, the MCP one-directional), the
sorted-names record test, and a CLI test running the auditor's `--cwd`
trigger and `--pass-env GITHUB_TOKEN`, both exit 78. A/B: each of the
three guard reverts fails the guard test.

**Minor — a non-object JSON-RPC `error` read as success
(`codex-session.ts`).** `{"id":7,"error":"boom"}` classified as a
response with `result: undefined`, so a failed steer or interrupt was
reported as accepted. Fix: an `error` that is present, non-null, and not
an object is a `response_error` ("the app-server returned a malformed
error"). Sibling in the same function: a response with neither `result`
nor `error` was also a success; it is now a `response_error` too. A
`null` error beside a result stays a success. Every recorded and fake
response carries `result`. Test: the parser case covers all four shapes.
A/B: pre-fix it fails on the first.

**Minor — agy emitted `turn_started` after the fatal
(`agy-driver.ts`).** The user path wrote the line first and announced
the turn after, so a refused write put the fatal error ahead of the
turn's start. Fix: the codemux-originated `turn_started` now precedes
the write, as in the claude and codex drivers. Test: the event order for
t2 is `user_message`, `turn_started`, `error`, `turn_completed`. A/B:
pre-fix the start follows the error.

**Minor — `EPERM` read as a dead process (`registry-io.ts`).** With the
process table unreadable, `processIdentityAlive` fell back to
`kill(pid, 0)` and read every throw as dead. Inside a sandbox that
denies signals, a live lock holder or owner then looked dead and could
be stolen. Fix: only `ESRCH` means dead, the rule the seven other
`processAlive` helpers in `src/` already follow (all checked, none
wrong). Test: the probe is stubbed to throw `EPERM` (alive) and `ESRCH`
(dead), independent of the runner's uid. A/B: pre-fix `EPERM` reads
dead.

**Class audits.** Lifecycle: every signal, shutdown, timeout, drain,
and exit path was walked in all three drivers and the CLI.
`drainTurnQueue`'s other callers (`completeTurn`, `failOpenTurn`) run
after the FSM returns to idle, and the claude driver's two queue-drain
sites (init and `completeTurn`) also open a turn only from idle, so the
blocker had no sibling. The forwarded-input rule covers the
pre-init case too: lines forwarded before the init frame and foreclosed
by an end are counted the same way, and an init plus result inside the
drain announce (the live5 rule) and then mirror. The signal, timeout,
and crash ends share `finish`, so they share the fix. agy has no queue
(mid-turn input is rejected `busy`). The write-before-announce order
existed only in agy; claude and codex already announce first. The CLI's
end sequence needed no change. Security: every resume-time flag was
checked for reach. `--tools` and `--hermetic` are refused for sessions,
`--model` and `--effort` grant no reach, and `harness_home` is already
compared, so `cwd`, `--pass-env`, and the Playwright MCP were the whole
remainder. Ids: claude-family ids are codemux-minted UUIDs checked on
every frame, so codex and agy were the only adopters. Docs: the
"dropped" notice claim, the resume guard list, the record example, and
the signal-0 rule were grepped across README, CHANGELOG, docs/*.md, and
the module headers. Updated: the design doc (§4.1 drain notice, §4.5
reported ids, §4.8 record example, pre-write validation, the `ESRCH`
rule, and a new resume rule), README's registry paragraph, HERMETIC's
registry paragraph, and the CHANGELOG. One wrong claim from an earlier
round was found and fixed: the live15 CHANGELOG entry said empty
`text_delta` blocks "now stream as empty deltas", but the code and the
live15 report mirror them as `unknown`.

**Gate.** `make release-gate` exit 2, stopping at the same
environmental `contracts` failure as every prior round: the installed
copilot binary's `--help` needs `mkdir ~/Library/Caches/copilot`, which
macOS denies this session's process. Inside the gate, `runtime` and
`check` passed, including typecheck and the full suite: **1207 pass / 0
fail / 6 skip across 1213 tests in 50 files**. The live15 gate was
1195/0/6 across 1201, so this round adds twelve regression tests with
no regressions and no removals. Run separately after the stop:
`make sandbox-contract smoke` exit 0, `bun audit` exit 0,
`bun install --frozen-lockfile --dry-run` exit 0, and the six gate
`--help`/`verify` probes each exit 0. `check_american` on the changed
`.ts` and `.md` files: exit 0, clean.

**Live check.** One, because the claude-family drain claim depends on
real harness behavior the reviewer could not check. Through
`./bin/codemux session -a zai --no-sandbox --auto high --shutdown-grace
20`, key read from a 0600 copy of `~/.zai` under a redirected HOME
(trashed after): turn 1 asked for a count to 150, a second `user` line
arrived mid-turn, then `shutdown`. Result: exit 0. Stream: both lines
acked, the new notice ("may still run it"), t1 synthesized `interrupted`
with all-null usage, and `session_ended` with `exit_code` 143. Claude
2.1.280 under zai died on the SIGTERM without answering the interrupt,
and it did not run the queued line, so the mirror path did not fire on
the real wire. The fix is correct either way: the notice says "may",
and a harness that does run the line (the fake models one) now ends
clean. Spend: one partial turn.

## Review fixes, live17

Three lenses reviewed the live16 tree: correctness-2 and security (both
Claude) and contracts (Z.AI GLM-5.3). Findings: two majors that blocked
(one security, three correctness, of which one was rated plausible), and
seven minors. All are fixed below, each with one regression test.
Every test that could be A/B-checked was: the fix was reverted in place,
the test failed, and the source was restored byte-identical (`cmp`).

**Security, major — medium let a caller approve writes to executable
configuration (`ceiling.ts`).** `pathInsideScope` denied only a `.git`
component. The reviewer's trigger: at `--auto medium`, a prompt-injected
turn writes `<cwd>/.claude/settings.json` with a `SessionStart` hook,
Claude Code routes the sensitive-file prompt to codemux, the caller
answers `allow`, and the next interactive `claude` in that directory
runs the hook outside scode. A headless medium `run` has no prompt
channel, so the same write is denied there; the session was the wider
of the two. Fix: medium refuses a protected name below the launch
directory, case folded, in both resolved spellings. Directories (any
component): `.git`, `.claude`, `.codex`, `.gemini`, `.cursor`,
`.vscode`, `.idea`, `.husky`. Files (base name): `.envrc`, `.mcp.json`,
`.claude.json`, `.gitconfig`, `.gitmodules`, `.ripgreprc`, `.bashrc`,
`.bash_profile`, `.zshrc`, `.zprofile`, `.zshenv`, `.profile`. Claude
Code's own sensitive set is the floor; the rest are the same class for
the other harnesses. Only the part below the launch directory is
judged: an operator who launched inside `~/.claude/skills/x` granted
that tree. The codex patch ceiling calls the same predicate, so it
inherits the rule. Low and high are unchanged. Test: "medium denies the
harness, editor, hook, and shell config paths" (fourteen protected
targets, mixed case included; three look-alike names still allow; the
launched-inside case; high and low unchanged). A/B: reverting the check
to `.git` only fails the test.

**Correctness, major — harness stderr was captured and thrown away
(`process.ts`).** `stderrText()` had no caller, so a claude that exited
1 at startup (an expired login, a bad `--model`, a refused resume id)
reached the caller only as "exited unexpectedly". Fix, by removing
surface: the child's stderr is inherited, so it passes through on
codemux's stderr as `run` passes it, and the dead capture, its reader,
and its end-path wait are gone. It is still never parsed. The three
"exited unexpectedly" fatals now say where the stderr went. Test: the
process layer runs in a child process whose harness writes to stderr
and exits 3; the outer stderr carries the line and stdout framing is
unchanged. A/B: with `stderr: "pipe"` restored the test fails.

**Correctness, major — a stdin read error exited 0 (`cli.ts`, all three
drivers).** `input.once("error", onEnd)` ran the clean-close handler.
Fix: `frameCallerStdin` has its own error handler. It does not deliver
the trailing partial line (it may be a fragment), removes the `end`
listener, and calls `handleCallerEnd(error)`. Each driver then emits a
fatal `codemux` error ("reading the caller's stdin failed (…)") and
ends through the stdin-close path with exit 1. Tests: the framing test
(the error reaches the driver once, the fragment is not delivered, a
later `end` is ignored) and a claude driver test (fatal, reason
`stdin-close`, exit 1). A/B: finishing with 0 fails the driver test.

**Correctness, major (plausible) — the end-interrupt had no grace window
(all three drivers, `process.ts`).** `finish` wrote the interrupt and
called `requestStop()` in the same synchronous step, so SIGTERM went
out at once, and `endInput()` had no callers. The live16 check had
already seen the effect on the real wire: claude died on the SIGTERM
without answering, and the turn was synthesized with null usage. Fix:
`SessionProcess.awaitEndAnswer` is a first grace window before any
signal. The claude and codex drivers wait in it until the turn closes,
a failure raises the exit code, or the child exits. agy has no
interrupt, so its stdin is closed on every end path, and the window
waits for the exit its input loop then makes. `requestStop` follows
unchanged: SIGTERM, then a second grace before the tree kill. The worst
case is therefore twice `--shutdown-grace`, which the help text, README,
and design doc now say. The agy fake gained the matching behavior: on
stdin close it finishes the running turn and exits 0, and it ignores
the close under `FAKE_SIGTERM_PERSIST` or the new `FAKE_IGNORE_EOF=1`
(the never-answers shape the live10 synthesis test needs). Tests: claude
and codex "the end-interrupt is answered before the stop signal" (the
default fakes die on SIGTERM; the turn now closes `interrupted` with a
raw line and usage), and agy "stdin close mid-turn lets the open turn
deliver its own result" (finish `end`, real usage, the conversation
identified, exit 0). A/B: skipping the window fails the claude test, and
dropping the stdin close fails the agy test.

**Minor — a nonzero exit during an idle shutdown was ignored (all three
drivers).** `drainFailureCode` required `turnOpenAtFinish`. Fix: the
requirement is gone; the exemptions stay (a delivered completion, a
signal death, 143, a crash end). The message drops "before completing
its open turn" when no turn was open, through the shared
`drainFailureMessage`. Tests: one per driver (`FAKE_SIGTERM_PERSIST=exit42`
after a completed turn: exit 1, the idle message, no synthesized turn).
A/B: restoring the requirement fails the claude test.

**Minor — `--turn-timeout` fired once (`driver.ts`, `codex-driver.ts`).**
Fix: the expiry re-arms after its interrupt. A second expiry on the same
turn means the interrupt was refused, lost, or ignored, so the cap ends
the session: a fatal `codemux` error, `reason: timeout`, exit 1. The
open turn is then answered by the normal end path. A new turn resets
the state. Re-sending interrupts forever was the alternative; it leaves
a harness that ignores interrupts uncapped, which is the defect. New
fake scenario `deaf` (both fakes): interrupts are acknowledged and
ignored. Tests: claude and codex "--turn-timeout re-arms, and a turn
that ignores its interrupt ends the session" (two interrupts recorded:
the timeout's and the end's). A/B: removing the re-arm fails the claude
test.

**Minor — agy emitted `user_message` before `turn_started`
(`agy-driver.ts`).** Fix: `submitTurn` emits `turn_started`, as codex's
does, so the order is `turn_started`, `user_message`, then the write.
The live16 rule (both precede a write failure's fatal) holds. Test: the
live16 order test now expects `turn_started`, `user_message`, `error`,
`turn_completed`.

**Minor (dormant) — a codex decline could name a decision the server
did not offer (`codex-session.ts`, `codex-driver.ts`).** Fix, by
removing surface: a commandExecution approval whose `availableDecisions`
names neither `decline` nor `cancel` (`offersRefusal`) never reaches the
caller. It is answered with a JSON-RPC error (a protocol answer, not a
decision), passed through as `unknown` with a non-fatal `error`, and its
turn is interrupted so it cannot hang. Every approval that does reach
the pending set offers a refusal, so `pickApprovalDecision`'s fallback
can no longer answer off-list. openclaw's bridge has the same fallback
(`commandRejectionDecision`); codemux no longer relies on it. New fake
scenario `refusalless`. Test: no `permission_request` or
`permission_resolved`, the fake recorded an error answer with no
decision, one interrupt, the raw frame mirrored, and a clean shutdown.
A/B: disabling the check fails the test.

**Minor (contracts) — a stale test comment (`tests/session-cli.test.ts`).**
The comment said an unreadable version "warn[s], allow[s]" under the
session floor; since live9 it is refused unless
`CODEMUX_ALLOW_UNTESTED_HARNESS=1`. Corrected. The behavior itself is
pinned by the live9 test the reviewer cited.

**Minor (contracts) — the codex fake's scenario menu was incomplete.**
`failoninterrupt`, `staleinterrupt`, and `asklose` were missing from its
header. Fix: listed, along with this round's `deaf` and `refusalless`.
Test, so the drift cannot recur: `tests/session-fake-headers.test.ts`
checks that every `case` in each of the three fakes is named in its
header. Pre-fix it fails on codex (and on claude, below).

**Class audits.**

- *Lifecycle.* Every signal, shutdown, timeout, drain, and exit path was
  walked in all three drivers and the CLI. The answer window applies to
  every `finish` reason, crash included; when the child is already dead
  it returns at once. Signals inside the window hit the gate's
  fire-once latch as before. Timers are cleared before the window, so
  the re-armed turn timer cannot fire inside it. A codex interrupt
  buffered behind an unanswered `turn/start` is bounded by the same
  window. The attach-after-signal path stops the child directly (there
  is no turn to answer). Siblings fixed:
  1. A crash end's synthesized turn said "the X process exited
     unexpectedly before the turn completed" even when the crash was an
     outbound overflow, a registry failure, or now a stdin error, with
     the harness alive. Each driver records its first fatal, and the
     synthesis carries it (`crashSynthesisReason`). The three crash
     tests now assert the fatal's text.
  2. agy's stdin close runs on every end path, not only mid-turn: an
     idle agy also gets the chance to exit cleanly before SIGTERM.
  3. Stale comments: the three drain-verdict comments, the three
     `turnOpenAtFinish` comments, the codex "graceful paths interrupt"
     comment, the `SessionProcess` end-path contract header, and the agy
     driver header ("`turn_started` rides the write itself").
- *Docs.* The `.git`-only claim, the grace sequence, the drain verdict,
  the crash synthesis reason, `--turn-timeout`, stdin errors, stderr,
  and the agy event order were grepped across README, CHANGELOG,
  docs/*.md, the CLI help, and the module headers. Updated: README (the
  session intro now names stderr pass-through, plus the
  `--turn-timeout` and `--shutdown-grace` rows, the medium ceiling
  paragraph, and the lifecycle paragraph), the design doc (§4.1 medium
  ceiling, §4.2 `permission_request`, §4.5 both flags, §4.6 stdin close,
  the drain verdict, crash, and open turn, the stdout/stderr sentence),
  the CLI help for both flags, and the CHANGELOG. Sibling: the claude
  fake's header also omitted `asklose`; listed, and the header test
  covers it. `docs/LIVE-SESSIONS-PANEL.md` is the panel's historical
  record and was left as written.
- *Capability flags.* No flag changed. agy's `interrupt: false` stays
  honest: the stdin close ends the input loop; it does not interrupt a
  turn and continue the session.

**Gate.** `make release-gate` exit 2. It stopped at the same
environmental `contracts` failure as every prior round: the installed
copilot binary's `--help` needs `mkdir ~/Library/Caches/copilot`, which
macOS denies this session's process. Inside the gate, `runtime` and
`check` passed, including typecheck and the full suite: **1222 pass / 0
fail / 6 skip across 1228 tests in 51 files**. The live16 gate was
1207/0/6 across 1213 in 50 files, so this round adds fifteen tests and
one file (`tests/session-fake-headers.test.ts`), with no regressions.
The stderr test replaced the old capture test one for one. Run
separately after the stop: `make sandbox-contract smoke` exit 0,
`bun audit` exit 0, `bun install --frozen-lockfile --dry-run` exit 0,
and the six gate `--help`/`verify` probes exit 0. `check_american` on
the 56 changed `.ts` and `.md` files: exit 0, clean.

**Live check.** One, because the end-interrupt window is the one fix
whose effect depends on how the real harness answers. Command:
`./bin/codemux session -a zai --no-sandbox --auto high --shutdown-grace
20`. The key came from a 0600 copy of `~/.zai` under a redirected HOME
in the ignored scratch directory, trashed after; it was never printed.
Turn 1 asked for a count to 300, and `shutdown` was sent after five
deltas (6.6 s in). Result: exit 0 at 6.9 s. Claude 2.1.280 answered the
end-interrupt in about 0.25 s, so `turn_completed` t1 carried the
harness's own result: raw line present, `finish: interrupted`, reason
`error_during_execution`, and usage counts the wire reported as zeros
rather than nulls. Then the SIGTERM ended it (`session_ended`
`exit_code` 143, `resumable: true`). In the live16 check the same
shape died on the SIGTERM before answering, and the turn was the
synthesized one with null usage. The only stderr line was the known
process-table EPERM note. Spend: one partial turn.

## Review fixes, live18

**Intended commit:** `fix(session): live18 review fixes — allow carries updatedInput, answered control requests, pre-init interrupt, narrowed drain exemption, registry writer parity`

Three lenses reviewed the live17 tree: correctness-2 (Claude), security
(Claude), and contracts (Z.AI GLM-5.3). Findings: six majors from
correctness-2, which blocked; seven correctness minors; one security
minor (the same defect as correctness major 2); and three contracts
minors. Every finding is fixed below. Each code fix has one regression
test, and every one was A/B-checked: the fix was reverted in place, the
test failed, and the source was restored byte-identical (`cmp`). No
capability flag was shown dishonest this round, so none changed.

**Correctness, major 1 — a plain `allow` sent no `updatedInput`
(`claude-session.ts`, `driver.ts`).** `buildControlResponse` omitted the
field unless the caller substituted one, so `{"decision":"allow"}` went
out as `{behavior, message}`. The only allow recorded live
(`zai-permission3.ndjson`) carries the full input, and the harness runs
the tool with that object. Fix: the allow sends the object the ceiling
judged, `updated_input ?? request.input`. Overloads now make an allow
without `updatedInput` a type error, so the defect cannot recur. Test:
"a plain allow carries the request's own input as updatedInput".

**Correctness, major 2, and the security minor — the medium ceiling's
executable-configuration list is enforced only on requests the harness
asks about (docs, `ceiling.ts` comment).** A medium claude or zai
session carries `run`'s `Edit(//<cwd>/**)` grant under `acceptEdits`, so
Claude Code approves an edit inside the launch directory itself, except
under its own sensitive set (`.git`, `.claude`, `.vscode`, `.idea`). A
sandboxed codex session runs with `approvalPolicy: "never"`. A write to
`.envrc` or `.husky/pre-commit` inside the launch directory therefore
never reaches the ceiling. This is not wider than a medium `run`. Fix,
by narrowing the claim rather than adding surface: the README, design
§4.1, the ceiling comment, and the live17 CHANGELOG entry now say the
list judges caller-answered requests only, and that for the other names
a medium session is as wide as a medium `run`. The alternative was
`--disallowedTools Edit(//<cwd>/**/.envrc)`-style deny rules at medium.
They would make the session narrower than `run`, and their effect on
the real harness cannot be proven live under this round's rule (live
checks run only at `--no-sandbox --auto high`). No code test: the code
did not change. The behavior the docs now describe is pinned by the
live17 ceiling test (the list still refuses a caller `allow`).

**Correctness, major 3 — the registry writer accepted a symlinked
registry directory (`registry.ts`).** `updateRegistry` resolved the path
first and read the resolved spelling, so the leaf symlink check never
saw the link. Every session recorded fine and no resume could read the
file. Fix: the writer runs `registryPlacementProblem` on the caller's
own spelling before anything else, the reader's rule exactly. Test:
"the writer refuses a symlinked registry directory the reader refuses"
(refused, nothing written in the real directory).

**Correctness, major 4 — an interrupt before `system/init` was
acknowledged and dropped (`driver.ts`).** The first `user` line is
forwarded at once, but the FSM stays `starting` until the init frame,
so an interrupt in that window was a no-op and the turn ran to the end.
Fix: an interrupt while `starting` with a forwarded input pending sets
`interruptBeforeInit`. The init path opens the turn and sends the
interrupt in the same step. An end path clears the flag. Test: "an
interrupt sent before init is delivered once the forwarded turn opens"
(both lines acked, t1 `interrupted`, the fake recorded `interrupt-1`).

**Correctness, major 5 — claude-family control requests other than
`can_use_tool` were never answered (`claude-session.ts`, `driver.ts`).**
They passed through as `unknown`, and the harness waited until
`--turn-timeout` or the session end. Fix: the parser reports them as
`unsupported_control_request`. A `can_use_tool` without a string
`request_id` is reported the same way. The driver answers with the
control protocol's error response (`subtype: "error"`, keyed to the wire
id with its type kept), mirrors the frame raw, and emits a non-fatal
`error`. A request with no usable id cannot be answered, and the error
says so. New fake scenario `ctlreq`: a `hook_callback` request whose
turn completes only once it is answered. Test: "an unimplemented control
request is answered with an error, not left hanging". The parser test
covers the two shapes.

**Correctness, major 6 — any nonzero exit after a drained completion
read as success (`driver.ts`).** Fix: the exemption is now exactly exit
code 1 after a drained `interrupted` completion (`drainedInterrupted`),
which is the step-0 probe 4 convention. Test: "only exit 1 after an
interrupted drained turn is excused". It covers two cases: the `race`
scenario completes clean on the end-interrupt and exits 1, and a new
fake mode `FAKE_SIGTERM_PERSIST=exit2` is interrupted and exits 2. Both
now exit 1 with the drain fatal. The existing live9 drain test (exit 1
after an interrupted turn) still exits 0.

**Minor — an undeliverable `allow` was acked (`driver.ts`).** The allow
frame is now built before the ack and checked with
`harnessLineDeliverable`. An answer over the write cap is rejected
`text_too_long` and the request stays pending. The README documents this
use of the reason. Test: "an allow whose frame cannot fit is rejected
before the ack and stays pending" (a later `deny` resolves it, exit 0).

**Minor — the caller-stdin cap could be passed by one chunk
(`cli.ts`).** The cap was checked only while the buffer held no newline.
Fix: `deliver` rejects every complete line over the cap, and the
unterminated-run check now runs after delivery on what remains. Test:
"a complete line past the cap is rejected even when its newline shares
the chunk".

**Minor — `handleCallerEnd` had no `settled` guard (`driver.ts`).** Fix:
once settled, a read error goes to stderr only, and nothing follows
`session_ended`. Test: "a stdin error after session_ended adds no event
after it".

**Minor — `requestStop` after the child exited armed an uncleared
SIGKILL timer (`process.ts`).** Fix: after the exit, `requestStop` only
latches. The end path has already run its tree kill. Test:
"requestStop after the child exited arms no kill timer". A child script
with a 5 s grace must exit in under 3 s.

**Minor — a failed registry write leaked its temp file and was not
flushed (`registry-io.ts`).** Fix: the payload is written with
`writeFileSync` on the descriptor, which loops over partial writes, then
`fsync`, and any failure after the temp file exists removes it. The
writer is an injectable parameter for the test. Test: "a failed registry
write removes its temp file and leaves the registry intact".

**Minor — a registry over 4 MiB blocked every new session
(`registry.ts`).** Reader half: an oversize file that passes placement
is `corrupt`, so the next start backs it up and resets. Writer half: the
prune now enforces both reader caps (1000 entries and 4 MiB) with the
same eviction order, and the pre-write validation also refuses a
payload over 4 MiB. Tests: "an oversize registry is corrupt, so the next
start backs it up" and "the writer prunes to the byte cap".

**Minor — late codex usage was charged to the next turn
(`codex-driver.ts`).** A `thread/tokenUsage/updated` that arrived after
its `turn/completed` accumulated into the next turn. Fix: a notification
counts toward the open turn only while that turn is open and either its
harness id is known (the parser has already matched it) or the
notification names a different turn than the one that closed last
(`lastHarnessTurnId`). Otherwise it folds into the session cumulative
alone, and its `usage` event carries `turn_id: null`. New fake scenario
`lateusage`. Test: "a usage update that lands after its turn completed
is not charged to the next turn" (t2 totals 18,979, and the session
19,986).

**Contracts 1–3 (docs).** (1) Design §4.2 Bounds said a caller that
stops reading gets a fatal `error`. The diagnostic goes to stderr,
because the event stream is the channel that failed. The text now says
so. (2) Design §4.3 said session floors sit "above" the run contracts.
agy's equals the run floor (1.2.14, the audited release, no earlier
one). The text now says "at or above" and explains agy. (3) Panel F6
said the codex `error` event carries `raw`. The raw line rides the
`unknown` event, and the `error` event's raw is null. F6 also said the
claude family needs no answer, which correctness major 5 disproved. The
entry now records both corrections. These are doc-only, and the
behavior is pinned by existing tests: the sink-failure and overflow
tests, the CLI floor tests, and the codex `unknownreq` test.

**Class audits.**

- *Lifecycle.* Every signal, shutdown, timeout, drain, and exit path was
  walked in all three drivers and the CLI. Siblings fixed:
  1. codex and agy carried the same unbounded drain exemption with no
     recorded exit convention at all, so it is gone. A nonzero exit
     during their drain (not 143, not a crash end) always costs
     success. Tests: codex "a nonzero exit after the drained completion
     costs success" and agy "a nonzero exit after the drained result
     costs success" (new fake mode `exit1` in both). A/B: restoring the
     old exemption fails both.
  2. `drainedCompletion` only gated the end-path synthesis after that,
     where `fsm.state === "turn_active"` already says the same thing. It
     is removed from all three drivers.
  3. The drain fatal's wording read the turn state at `finish`. It now
     reads the state after the drain in all three drivers, so an exit
     after a delivered completion no longer says "before completing its
     open turn".
  4. codex and agy `handleCallerEnd` gained the same `settled` guard.
     No separate test: the code is identical to the claude driver's.
  Checked with no defect: the harness-side framer already caps every
  complete line; `awaitEndAnswer` returns at the child's exit; agy has
  no harness requests; codex approval answers are bounded by the
  request they echo. One behavior is deliberate and unchanged: a signal
  that lands during the final flush still raises the exit code to 143,
  because the signal is the newer fact.
- *Registry.* `touchSession` and `recordSessionEnd` share
  `updateRegistry`, so they inherit the placement, byte-cap, fsync, and
  cleanup fixes. `lookupForResume` already read the original spelling.
  The lock's held-file create already removed itself on failure.
- *Docs.* The changed claims were grepped across README, CHANGELOG,
  docs/*.md, the CLI help, and the module headers. The medium ceiling
  list, the drain verdict, the `interrupt` no-op rule, control requests,
  codex late usage, registry pruning and placement, the queue-bound
  diagnostic, and the floors are covered. Updated: README (the medium
  paragraph, the reason list, the lifecycle verdict sentence), design
  §4.1 (the interrupt row, the medium ceiling), §4.2 (Bounds, codex
  usage), §4.3 (floors), §4.6 (drain verdict), §4.7 (the codex
  unknown-request sentence, which carried the same misattribution as
  F6), §4.8 (writer placement, fsync, byte cap), HERMETIC (writer
  placement), the registry module header, the ceiling comment, the
  live17 CHANGELOG entry (it said medium refuses those writes outright),
  and a new live18 CHANGELOG entry.

**Gate.** `make release-gate` exit 2. It stopped at the same
environmental `contracts` failure as every prior round: the installed
copilot binary's `--help` needs `mkdir ~/Library/Caches/copilot`, which
macOS denies this session's process. Inside the gate, `runtime` and
`check` passed, including typecheck, `sh -n`, and the full suite with
coverage: **1237 pass / 0 fail / 6 skip across 1243 tests in 51
files**. The live17 gate was 1222/0/6 across 1228 in 51 files, so this
round adds fifteen tests with no regressions and no removals. Run
separately after the stop: `make sandbox-contract smoke` exit 0,
`bun audit` exit 0, `bun install --frozen-lockfile --dry-run` exit 0,
and the six gate `--help`/`verify` probes each exit 0.
`check_american` on the changed `.ts` and `.md` files: exit 0, clean.

**Live check.** One, because the pre-init interrupt fix depends on how
the real harness treats an interrupt written right after its init frame.
Command: `./bin/codemux session -a zai --no-sandbox --auto high
--shutdown-grace 20`. The key came from a 0600 copy of `~/.zai` under a
redirected HOME in the ignored scratch directory, trashed after; it was
never printed. A `user` line ("count to 300") and an `interrupt` were
written back to back, before any harness output. Result: exit 0 at
0.52 s. Both lines were acked at 0.05 s. `session_started` and
`turn_started` t1 came at 0.28 s. The harness answered `interrupt-1`
at 0.29 s, and `turn_completed` t1 carried the harness's own result:
`finish: interrupted`, reason `error_during_execution`, raw present,
usage all zeros on the wire. `shutdown` then ended the session
(`exit_code` 143, `resumable: true`). Pre-fix, the same two lines would
have run the count to completion. A command error on my side started a
second, identical copy of this check right after the first; a `kill`
ended it through the signal path. The staged registry shows it recorded
and ended; its output was discarded, so its usage was not observed.
Spend: the first request reported zero tokens; the second was
interrupted the same way and then killed.

## Review fixes, live19

**Intended commit:** `fix(session): live19 review fixes — resume claims the registry before spawning, bounded stdin backlog and codex input holds, sanitized fixtures, autonomy-parity docs`

Three lenses reviewed the live18 tree: correctness-2 (Claude), security,
and contracts (Z.AI GLM-5.3). Findings: one correctness major (the
concurrent-resume race) and one correctness minor (the unbounded codex
pre-handshake buffer), both blocking; two contracts majors (the
autonomy-parity claim, the fixture privacy leak) and four contracts
minors (docs). Every finding is fixed below. Each code fix has one
regression test, and every one was A/B-checked: the fix was disabled in
place, the test failed, and the source was restored byte-identical
(`cmp`). No capability flag was shown dishonest this round, so none
changed.

**Correctness, major — concurrent resumes both acted on input (`cli.ts`,
`registry.ts`).** `lookupForResume` reads without the lock, and the
claude family recorded ownership only at the init frame, which the
harness sends after the caller's first input. Two resumes of one id
both spawned and both forwarded that input; the loser was refused
`session_busy` only after its harness had started the turn. Fix: a new
`claimForResume` re-runs the whole guard bundle under the writer lock
and stamps this process as the owner, and the CLI calls it right before
the spawn. The lock-free lookup stays as the early exit. The driver's
`recordSessionStart` then finds its own identity and updates in place.
The claim sits in the CLI, so it covers every agent. agy needed it most:
a resumed agy session recorded ownership only at its first result. A
claim whose session never starts leaves `ended` null under an owner that
dies with codemux; every later resume accepts that record. Test: "a
second resume of a claimed id is refused before it spawns a harness".
The first resume sits idle with no input. The second exits 78
`session_busy`, the fake's argv log shows one spawn, and the registry
names the first as owner. The first then runs a turn and ends 0 with
`resumable: true`, which proves the claim and the driver's start write
agree. Pre-fix, the second exited 0 with its harness spawned.

**Correctness, minor — the codex pre-handshake buffer was unbounded
(`codex-driver.ts`).** Fix: the parked lines are bounded at 256 lines or
32 MiB (`MAX_HELD_INPUT_LINES`/`MAX_HELD_INPUT_BYTES`). The count is a
quarter of the outbound queue's 1024 entries, because the replay or the
end path answers the whole buffer in one synchronous burst of up to
three events per line. A first attempt at 1024 lines overflowed the
outbound queue in exactly that burst, which is how the quarter was
chosen. Past the bound the session ends with a fatal. Rejecting the one
line at once would give it an `input_seq` ahead of the lines parked
before it, so the end path instead rejects every parked line
`shutting_down` in order. Test: "caller lines parked behind a stalled
handshake are bounded" (257 lines, exit 1, 257 ordered rejections).

**Contracts, major 1 — autonomy parity (README, CHANGELOG, `cli.ts`
header).** A claude or zai session at `high` runs `--permission-mode
default` with `run`'s grant list, never `--dangerously-skip-permissions`;
the code, the compatibility doc, and the design were right, and the
README, the CHANGELOG feature entry, and the CLI module header said the
mapping was identical. They now state the exception: any other tool
asks, and the ceiling refuses an `allow` for it (`autonomy_escalation`),
so a `high` session is narrower than a `high` run. codex and agy were
checked against their run mappings and do match. Doc-only; the mapping
is pinned by the existing `session-claude` high-mapping test.

**Contracts, major 2 — the fixtures leaked the operator's identity
(`tests/fixtures/live/*.ndjson`).** Every zai init frame carried claude's
project slug `-Users-<name>-<repo path>` in `memory_paths`, and every
fixture carried the checkout path below the home. Fix: the checkout is
now `/Users/example/project` as a path and `-Users-example-project` as a
slug, in all six recorded fixtures. The fixtures README describes the
new rule, and the ignored `scratch/probes/sanitize.ts` applies it. Test:
`tests/session-fixtures-privacy.test.ts` reads `os.homedir()`,
`os.userInfo().username`, and the checkout paths (this tree and, via
`git rev-parse --git-common-dir`, the main checkout) at test time and
fails on any spelling of them under `tests/fixtures/live`: the home and
its slug, the username and the home's other components as whole words,
and each checkout's path below the home as a path, as a slug, and by
directory component. The checkout's own directory name is exempt as a
lone word, because it is the project name and the wire carries it
(`codemux-probe`). A/B: restoring the old `zai-resume.ndjson` fails the
test with five hits.

**Contracts, minors 3–6 (docs).** (3) HARNESS-COMPATIBILITY said any
result with an interrupt outstanding is interrupted; only an error
result is, and a clean result completes `end` with the interrupt rolling
to the next turn. (4) HARNESS-COMPATIBILITY and design §4.7 said any
late `thread/started` is tier-1 passthrough, "never a fatal"; only a
first sighting naming the adopted thread is, and a second sighting or a
foreign id is tier-2. (5) HARNESS-COMPATIBILITY called `updatedInput`
optional on the wire; every allow carries it since live18. (6) The
README's medium list now names `.claude.json` and `.ripgreprc`.
Doc-only; the behavior is pinned by the live12 race test, the codex
`secondthread` and late-thread tests, the live18 plain-allow test, and
the live17 ceiling test.

**Class audits.**

- *Lifecycle (ownership, buffering, end paths).* Every signal, shutdown,
  timeout, drain, and exit path was walked in all three drivers and the
  CLI. Siblings fixed:
  1. agy resume had the same race, worse (ownership at the first
     result). Fixed by the same CLI claim; the CLI test exercises the
     shared code path.
  2. The harness's stdin was unbounded on every driver. Bun's pipe sink
     buffers every unread write; a probe wrote 200 MiB to a child that
     never read, and codemux's RSS reached 648 MB. `writeLine` now
     refuses a write that would leave more than 64 MiB unread
     (`MAX_HARNESS_BACKLOG_BYTES`, reason `backlog`). Bun resolves every
     pending write's promise together when the buffer drains, so a
     generation counter clears the count only on the newest pending
     write. Every driver already treats a refused write as a codemux
     fatal. Tests: "writeLine refuses past the unread stdin backlog and
     recovers once the harness reads" (process layer) and "a harness
     that stops reading stdin ends the session at the backlog bound"
     (claude driver, new fake scenario `nostdin`). Both fail with the
     check disabled.
  3. codex `turnQueue` (user lines behind an open turn) and
     `steerBuffer` (steers held until the server names its turn) were
     unbounded. Both now reject `busy` past the same bounds. Here the
     line's own `input_seq` is already assigned, so the rejection keeps
     order. Test: "user lines queued behind a turn and steers held for
     its id are bounded (busy)". It fails when the bound is disabled.
  4. The claude end path marked its end-interrupt pending without
     checking the write, so a refused write (now possible through the
     backlog) waited a grace for an answer that could not come and left
     `interruptPending` set. It now reads `writeLine(...).ok`. codex's
     end path had the same unchecked write; `writeToHarness` and `call`
     now report delivery, a refused call leaves nothing in
     `pendingCalls`, and `sendInterrupt` returns whether the interrupt
     was written or queued. No separate test: the refused end-interrupt
     only skips a grace wait whose length the e2e harness (500 ms grace)
     cannot distinguish; the backlog e2e test drives this path.
  Checked with no defect: claude-family input is never held in memory
  (it is written at once, now under the backlog bound); agy holds no
  input (a mid-turn line is `busy`); codex and agy record ownership
  before any turn on fresh sessions; `earlyLines` only spans the
  synchronous window between spawn and attach. One residual is
  deliberate: a fresh claude-family session's id is minted by codemux,
  so no concurrent claimant exists, but a registry write that fails at
  its init frame still fails closed after the first input reached the
  harness. Claiming before the spawn would record sessions the harness
  never created.
- *Privacy.* The new files in this diff were grepped for the home path,
  the username, and the workspace path. Fixed: the test author's username in
  the codex and agy e2e tests and `bindsch`/`Laurent B.` in the author
  validation test are now neutral names, and `~/Programming/Ops/` in the
  report, the panel doc, and two panel reviews is `<workspace>/`. Left
  as is: three reports already on `main` (`agy-cursor-report.md`,
  `hermetic-all-0.7-merge-report.md`, `hermetic-all-harnesses-report.md`)
  carry the operator's home path; they predate this diff. The design's
  approval records name the approver.
- *Docs.* The changed claims were grepped across README, CHANGELOG,
  docs/*.md, the CLI help, and the module headers. Updated: README
  (autonomy exception, medium list, held-input bounds, the resume
  claim), CHANGELOG (the feature entry's parity sentence, the live11
  entry's `thread/started` sentence, a new live19 entry), design §4.2
  (stdin backlog, codex holds), §4.7 (`thread/started`), §4.8 (the
  claim), HERMETIC (the claim), the panel doc's amended F-entry (the
  same "never a fatal" claim), HARNESS-COMPATIBILITY (3–5), the
  fixtures README, the `recordSessionStart` and `lookupForResume`
  comments, the CLI module header, and the codex e2e test title that
  said a late `thread/started` "never fatals". The earlier report sections
  record what was true then and are left as written.

**Gate.** `make release-gate` exit 2. It stopped at the same
environmental `contracts` failure as every prior round: the installed
copilot binary's `--help` needs `mkdir ~/Library/Caches/copilot`, which
macOS denies this session's process. Inside the gate, `runtime` and
`check` passed, including typecheck, `sh -n`, and the full suite with
coverage: **1243 pass / 0 fail / 6 skip across 1249 tests in 52
files**. The live18 gate was 1237/0/6 across 1243 in 51 files, so this
round adds six tests and one file (the privacy test) with no
regressions and no removals. Run separately after the stop: `make
sandbox-contract smoke` exit 0, `bun audit` exit 0, `bun install
--frozen-lockfile --dry-run` exit 0, and the six gate `--help`/`verify`
probes each exit 0. `check_american` on the 22 changed `.ts` and `.md`
files: exit 0, clean.

**Live check.** None this round. No changed claim depends on how a real
harness behaves: the claim runs before any harness starts, the backlog
bound only triggers when a harness stops reading its stdin, and the
codex holds are codemux-side. The fake-harness CLI test drives the
claim through a real init frame and a clean, resumable end.

## Review fixes, live20

**Intended commit:** `fix(session): live20 review fixes — resume claims released on every end path, codex stragglers after the next turn opens, honest decision acks, strict caller UTF-8`

Three lenses reviewed the live19 tree: correctness-2 (Claude), security,
and contracts (Z.AI GLM-5.3). The findings file records no security
findings. Correctness-2 reported three majors and three minors and
failed the round; contracts reported one major and two minors. Every
finding is fixed below. Each fix has one regression test, and every
one was A/B-checked: the fix was disabled in place, the test failed,
and the source was restored byte-identical (`cmp`). No capability flag
was shown dishonest this round, so none changed.

**Correctness, major 1 — a resume that ended before its first turn kept
its claim (`driver.ts`, `codex-driver.ts`, `agy-driver.ts`, `cli.ts`).**
`claimForResume` stamps this process as owner before the spawn, but the
claude driver set `registryRecorded` only at the init frame, which
follows the caller's first input. Example: `codemux session -a claude
--resume <id>` with stdin closed at once. The end stamp was skipped, so
the record kept `ended: null` under this pid, and `session_ended`
reported `resumable: false`. Fix: the CLI calls the new
`adoptResumeClaim()` right after the claim, and each driver's `finish`
stamps the end and reports `resumable` when it either recorded the start
or adopted the claim. Test: "a resume that ends before its first turn
releases the claim and stays resumable" (CLI, fake claude): exit 0,
`resumable: true`, and the registry's `ended` is restamped.

**Correctness, major 2 — late codex usage killed a session with queued
input (`codex-session.ts`, `codex-driver.ts`).** `scopedParams` refused
any turn id other than the open turn's. When a queued `user` line opened
turn 2 at once and turn 1's `thread/tokenUsage/updated` arrived after
turn 2's turn/start response, the parser returned a `grammar_error` and
the session ended fatally. Fix: the parse context carries
`previousTurnId` (the driver's `lastHarnessTurnId`). Item, delta, and
usage notifications naming it are accepted as stragglers. The driver
labels them with a null `turn_id` (`turnIdFor`), and their usage folds
into the session total only. Test: "a late usage update and delta from
the previous turn do not end the session once the next turn is named"
(new fake scenario `laggard`): no error, both stragglers carry a null
`turn_id`, t2 ends with its own usage, and the session total includes
the straggler.

**Correctness, major 3 — a codex decision was acked accepted after its
write failed (`codex-driver.ts`).** A refused write starts
`finish("crash")`, which supersedes the approval before its first await.
`resolvePending` then found nothing, and `ack(inputSeq, true)` still ran.
Fix: the deny and allow paths check `writeToHarness` and answer
`input_rejected` `shutting_down` when it fails. The ceiling and
undeliverable-allow paths already reject on their own reasons. Test: "a
decision whose answer cannot be written is rejected, never acked
accepted" (codex e2e; `proc.writeLine` is stubbed to refuse once the
approval is pending).

**Correctness, minor 4 — a missed interrupt relabeled the next turn's
failure (`driver.ts`).** A rolled interrupt struck any error result on
the next turn. A harness that has no turn to interrupt drops the
request, so an API error there was reported `interrupted`. Fix: a rolled
interrupt strikes only an `error_during_execution` result, the
interrupted shape step-0 probe 4 recorded. Test: "an interrupt that
missed its turn does not relabel the next turn's API failure" (new fake
scenario `apierror`): t1 `end`, t2 `failed` with reason `success`.

**Correctness, minor 5 — a resume could refuse its own claim
(`registry.ts`).** `claimForResume` and `recordSessionStart` each read
the process table, and `ps` can time out to an empty table, so one
reading may carry a start token and the other null. The self check
compared tokens and refused the session's own claim as `session_busy`.
Fix: the self check compares the pid alone; no other live process can
hold this one's pid. Test: "a start finds its own claim whatever start
token the claim read" covers a null claim token and a mismatched one, so
it fails pre-fix whether or not `ps` works on the test host.

**Correctness, minor 6 — two writers stealing one dead lock
(`registry-io.ts`).** Both unlink the same corpse; the loser gets ENOENT,
which the sweep counted as contention, so a single-attempt acquisition
(the per-turn touch) failed although the lock was free. Fix: ENOENT
counts as gone. Test: "losing the steal of a dead holder to another
writer is not contention" (an `unlinkSync` spy removes the corpse just
before the real unlink).

**Contracts, major 1 — lossy caller-stdin decoding (`cli.ts`).**
`frameCallerStdin` used `Buffer#toString("utf8")`, which substitutes
U+FFFD. A line with one invalid byte was acked, echoed, and forwarded
with its text changed. Fix: a fatal `TextDecoder` (BOM kept, as before).
An undecodable line reaches the driver as a non-JSON sentinel and is
answered `input_rejected` `malformed`, the same route the oversize
rejection takes. Test: "a line that is not valid UTF-8 is rejected,
never decoded lossily" covers a bad byte mid-line, a valid two-byte
character split across chunks, and a bad trailing tail at end of input.
One side effect: the end-of-input tail now has a trailing CR stripped
like every other line.

**Contracts, minor 2 — the resumed read-only behavioral pin did not
exist.** New test "a session created at high and resumed read-only
enforces read-only's ceiling" (`session-e2e`). A high session runs a
turn and ends. `claimForResume` at read-only succeeds, the fake is
spawned with `buildClaudeSessionCommand`'s real resume argv, and an
`allow` for Bash is rejected `autonomy_escalation`, resolved `deny`, and
answered deny on the wire. The fake's argv equals read-only's and
carries no `--allowedTools`. The test runs at the driver level because
the CLI refuses read-only without `--sandbox`. A/B: the test fails when
the ceiling is fed `high`. The design's sentence now names the test.

**Contracts, minor 3 — `thread/resume` was not pinned.** The
`session-codex` test now checks the full params object with `toEqual`
(thread id, cwd, sandbox, approval policy, config, model) and that the
model-less form differs only by `model`. A/B: dropping the policy pair
from `buildThreadResumeRequest` fails it.

**Class audits.**

- *Lifecycle (ownership, acks, end paths).* Every signal, shutdown,
  timeout, drain, and exit path was walked in all three drivers and the
  CLI. Siblings fixed:
  1. The codex driver had the same unreleased claim: a resumed thread
     whose handshake never answered ended with `resumable: false` and
     `ended` null. Fixed by the same adoption. Test: "a claimed resume
     that ends during the handshake releases the claim and stays
     resumable" (codex e2e, `FAKE_STALL_INIT`). The agy driver got the
     same change; a resumed agy session records at `run()`, so only the
     signal-during-spawn window was exposed there, and the shared
     `finish` code is covered by the two tests above.
  2. A signal during the CLI's async spawn finishes the driver before
     `attach`. With the claim adopted first, that end path now stamps
     the end too. A spawn that throws runs no driver end path, so the
     CLI releases the claim itself before rethrowing.
  3. The claude family acked a decision accepted after a failed write,
     like codex. `writeToHarness` now reports delivery, and the
     deny/allow paths reject `shutting_down` on failure. Test: the
     claude e2e copy of the codex test.
  4. The claude end path's interrupt marked itself pending but did not
     re-arm the roll window the way `sendInterrupt` does. With the minor
     4 fix, a roll left over from an earlier miss would have put the
     drained answer through the rolled-shape check. It now clears
     `interruptRolled`. No separate test: the fake always answers the
     end-interrupt with `error_during_execution`, which strikes either
     way.
  5. The lock's post-create confirm loop had the same ENOENT defect as
     the sweep: a lost steal was read as a live rival, and the claim was
     released. Test: "losing a confirm-time steal to another writer is
     not a conflict either" (`openSync` and `unlinkSync` spies).
  Checked and left as designed: a `user`, `steer`, or `interrupt` line
  acked before a failed write ends through the crash path. The turn it
  opened or targeted is answered by the synthesized `failed` completion,
  so the ack does not misstate an outcome (the live16 ordering rule). A
  decision has no such follow-up, which is why it now answers on its
  own. Late approvals naming a closed turn stay tier-2: a server
  request for a finished turn is not a straggler. The registry's other
  unlink sites already treat a missing file as gone.
- *Docs.* The changed claims were grepped across README, CHANGELOG,
  docs/*.md, and the module headers. Updated: design §4.1 (the rolled
  interrupt's shape), §4.2 (strict caller UTF-8; stragglers after the
  next turn is named), §4.6 (the resumed read-only test now exists),
  §4.7 (`thread/resume` pinned by exact params), §4.8 (claim adoption
  and release, the pid-only self check); HARNESS-COMPATIBILITY (the
  rolled-interrupt shape, codex stragglers); README (invalid UTF-8 and
  undeliverable decisions in the ack list, a resume ending before its
  first turn); CHANGELOG (a live20 entry); the `claimForResume`,
  `recordSessionStart`, `frameCallerStdin`, and `lastHarnessTurnId`
  comments; and the scenario lists of both fakes. The earlier report
  sections record what was true then and are left as written.

**Gate.** `make release-gate` exit 2. It stopped at the same
environmental `contracts` failure as every prior round: the installed
copilot binary's `--help` needs `mkdir ~/Library/Caches/copilot`, which
macOS denies this session's process. Inside the gate, `runtime` and
`check` passed, including typecheck, `sh -n`, and the full suite with
coverage: **1254 pass / 0 fail / 6 skip across 1260 tests in 52
files**. The live19 gate was 1243/0/6 across 1249 in 52 files, so this
round adds eleven tests with no regressions and no removals (one
existing codex test was tightened in place). Run separately after the
stop: `make sandbox-contract smoke` exit 0, `bun audit` exit 0, `bun
install --frozen-lockfile --dry-run` exit 0, and the six gate
`--help`/`verify` probes each exit 0. `check_american` on the 18 changed
`.ts` and `.md` files: exit 0, clean.

**Live check.** One, because the minor 4 fix relies on how the real wire
reports an API error. Command: `./bin/codemux session -a zai
--no-sandbox --auto high --model codemux-no-such-model --shutdown-grace
20 --cwd <scratch dir>`. The key came from a 0600 copy of `~/.zai` under
a redirected HOME in the ignored scratch directory, trashed after; it
was never printed. One `user` line, then `shutdown` after the turn.
Result: exit 0 at 0.83 s. t1 completed `finish: failed`, reason
`success`. The raw result was `subtype: "success"`, `is_error: true`,
`api_error_status: 400`, with result text "API Error: 400 … Unknown
Model". That is the shape the `apierror` fake scenario models, so a
rolled interrupt now leaves such a turn `failed`. `session_ended` had
`exit_code` 143 and `resumable: true`. Spend: none; Z.AI refused the
model before running it.

## Review fixes, live21

**Intended commit:** `fix(session): live21 review fixes — claude-family mid-turn input rejected busy, resumable only when confirmed or cleanly ended, tier-2 lines mirrored raw`

Three lenses reviewed the live20 tree: correctness-2 (Claude), security,
and contracts (Z.AI GLM-5.3). The findings file records no security
findings. Contracts reported one major, which blocked the round, and
four minors. Correctness-2 reported two minors. Every finding is fixed
below with one regression test. Each code fix was A/B-checked: the fix
was disabled in place, the test failed, and the source was restored
byte-identical (`cmp`). One capability flag was shown dishonest and is
now `false`: claude/zai `user_during_turn`.

**Contracts, major 1 — the claude-family mid-turn contract contradicted
its own fixture (`driver.ts`, `claude-session.ts`, `zai-session.ts`).**
The step-0 report, the design, the README, the panel doc, and the
fixture notes all said print mode answers a mid-turn message in the
NEXT turn. The fixture shows the opposite. In
`tests/fixtures/live/zai-session-a.ndjson` the line written at 34,
during the Bash turn, is echoed with `isReplay: true` after the tool
result (59) and answered inside that turn's own result (74:
`"two-b\n\nprobe-permission-ok"`, `num_turns: 2`, `result_index: 2`).
The next result (82) is the interrupted counting turn.

As the operator asked, the fixture decided, and two fresh probes
settled the case the fixture does not cover. Both ran on 2026-10-07
through `./bin/codemux --no-sandbox --auto high` (pre-fix driver):

- Text-only turn ("count from one to forty"; follow-up sent at the
  first delta). The turn's result answered only the count. The
  follow-up was echoed after that result and answered in a result of
  its own ("zebra", `result_index: 1`).
- Tool turn (`sleep 3; echo probe-live21`; follow-up sent at the
  `tool_call`). The follow-up was echoed after the tool result and
  folded into the same result (`"probe-live21\n\nzebra"`,
  `num_turns: 2`). The pre-fix driver then opened t2 for the follow-up.
  No result ever answered t2, and only the shutdown closed it
  (`finish: interrupted`). This is the defect the reviewer predicted,
  reproduced live.

So print mode delivers a mid-turn message at the running turn's next
model request when there is one, and as its own turn when there is not.
Which result answers it cannot be known when it is sent. `"queue"`
misdescribes the first case and `"inject"` the second. Following the
honest-flag rule, claude/zai now report `user_during_turn: false`, and a
mid-turn `user` line is rejected `busy`. That removes the queued-turn
machinery instead of adding an echo-tracking heuristic. A `user` line
accepted before the init frame still opens its turn at init; until
then the session counts as mid-turn, so a second line is also rejected
`busy` rather than handed to a harness that may fold both.

Test: "a mid-turn user line is rejected busy and never reaches the
harness (review live21)". Lines sent before init and mid-turn are both
rejected `busy`. The fake records only the two accepted lines, and the
next idle line opens t2, which its own result answers. A/B: with the
staged driver and flags, the test fails. The fake now echoes each
turn's line with `isReplay: true` as the wire does, and its comment
records both recorded behaviors.

**Contracts, minor 2 — auto-deny evidence.** Design §3.1 claimed every
auto-deny carries a `decision_reason`. The `touch` case
(`zai-permission.ndjson:50`) carries only `message`. The sentence now
says which fixture carries which. Doc only; no code reads the field.

**Contracts, minor 3 — a field no frame has.** The fixtures README
named "the zai result's `timestamp`". Zai result frames carry none. It
now names the `timestamp` on zai user and assistant frames.

**Contracts, minor 4 — codex items and deltas.** The fixtures README
listed `delta` as an item type. It now says the item types are
userMessage/agentMessage, and that text deltas ride the separate
`item/agentMessage/delta` notification, which carries no item.

**Contracts, minor 5 — "session floors sit above the run floors."**
This was false for Antigravity, whose session floor (1.2.14) equals the
run floor. HARNESS-COMPATIBILITY now says "at or above" and names which
floors are raised (claude/zai, codex) and which is equal (agy).

Minors 2-5 are prose corrections. Their regression check is the grep
sweep under "Class audits" below, not a test, because no code reads
those claims.

**Correctness, minor 1 — `resumable` after a refused resume
(`driver.ts`, `codex-driver.ts`, `agy-driver.ts`).** `resumable` was
`ownsRecord && capabilities.resume`, and `ownsRecord` was true as soon
as the CLI's claim succeeded. Example: the registry holds a claude
session whose transcript Claude Code already deleted. `--resume` passes
every guard, claude refuses, and the session ended
`resumable: true`. Fix: `resumable` now requires either harness
confirmation (claude init frame, codex `thread/resume` response, a
result naming the agy conversation) or, for a claimed resume the
harness never confirmed, an end that did not fail (exit 0). The live20
case still holds: a resume that ends cleanly before its first turn is
`resumable: true`.

Agy needed a separate confirmation flag, `harnessConfirmed`. A resumed
agy session records at spawn from the registry-vouched id, so
`registryRecorded` alone proves nothing there.

Tests:

- "a resume the harness refuses is not reported resumable (review
  live21)" (CLI, fake claude): exit 1, `resumable: false`, claim
  released. A new `resume-missing` marker makes the fake answer like
  the real harness. `runCli` gained `holdStdin`, so the harness's own
  exit ends the session rather than EOF.
- Codex: "a claimed resume the server refuses is not reported
  resumable".
- Agy: "a resumed conversation the harness never confirms is not
  reported resumable".

A/B: each fails when the driver's line is restored.

**Correctness, minor 2 — a lost claim release was silent (`cli.ts`).**
When the spawn threw, the CLI called `recordSessionEnd` and discarded
the outcome. The fix removes surface instead of adding a fifth copy of
the stderr report. The new `releaseSessionRecord(path, id)` in
`registry.ts` stamps the end and reports a lost stamp on stderr in the
drivers' exact wording. All four end paths (three drivers and the CLI)
now call it, and `recordSessionEnd` has no other caller in `src/`.
Test: "a lost end stamp is reported on stderr, never dropped (review
live21)" (registry unit test: an uncreatable registry directory yields
exactly one stderr line, and a stamp that lands yields none). Limit:
the test pins the helper. The CLI's use of it is checked by reading
`src/session/cli.ts:733`; making a spawn throw and the release fail
inside one CLI run has no deterministic seam.

**Class audits.**

- *Mid-turn input and turn attribution (the major's class).* I walked
  every path that assumed one result per forwarded line. Siblings fixed:
  1. The stale-interrupt roll (`driver.ts`). Review live12 kept a missed
     interrupt pending for one more turn, and live20 narrowed it to
     `error_during_execution`. Both modeled a next turn already waiting
     harness-side, which only a forwarded mid-turn line could create.
     With mid-turn lines rejected, the next turn's line is written only
     after the result, so the harness reads the late interrupt idle and
     drops it. The roll was removed. Test: "a stale interrupt is spent
     on the clean turn it missed; the next turn is not relabeled" (new
     fake scenario `ede`: an `error_during_execution` result with no
     interrupt behind it). Pre-fix it was labeled `interrupted`; now it
     is `failed`. A/B with the pre-removal driver: fails. The fake's
     race scenario now drops the late interrupt, as the idle harness
     does.
  2. The live16 drain path (`forwardedAtEnd`). It was a count of queued
     mid-turn lines and is now a flag for the one line that can lack a
     turn: a `user` line accepted before init. The end notice now says
     so. Its test was rewritten to that case. The fake runs under
     `exit143`, because no interrupted turn exists to carry the exit-1
     convention.
  3. Four e2e tests used a mid-turn line as a vehicle: the race test,
     the API-error test, the write-failure test, and the live19 backlog
     test. They now send from idle or carry the refused write on an
     interrupt. The backlog test injects the `backlog` refusal at the
     process seam. A caller can no longer push large lines into a
     running claude turn, so only small control lines can reach that
     bound there. The 64 MiB bound itself stays pinned in
     `session-process.test.ts`.
  4. Codex's `queue` is codemux's own FIFO, with one `turn/start` and
     one `turn/completed` per queued line. It stays honest and
     unchanged. Agy already reported `false`.
- *Lifecycle (resume ownership and every end path).* I walked every
  signal, shutdown, timeout, drain, and exit path in the three drivers
  and the CLI. Siblings fixed:
  1. A claimed resume that hangs before init until `--timeout`
     ended exit 1 but still passed the first draft of the rule above,
     which only excluded crash and drain-failure ends. The rule is now
     literally "exit 0". Test: "a claimed resume that times out before
     its init frame is not resumable (review live21)".
  2. The live re-proof of minor 1 found that claude answers a refused
     `--resume` with one `result` and no init frame before it (subtype
     `error_during_execution`, `errors: ["No conversation found with
     session ID: …"]`), then exits 1. The driver reported "turn none
     completed in state starting". It never mirrored that result, and
     its end notice falsely said the harness "may still run" the
     already-answered line. Now a result in `starting` clears the
     pending opener and mirrors the line raw. The fatal names the
     refused resume. The CLI test above pins all three, using a fake
     that now emits the recorded frame.
  3. That raw drop was a whole class. The design's tier 2 (review live6)
     mirrored parse-level violations but emitted only the fatal for
     violations caught by the driver's FSM bookkeeping. The agy driver
     already mirrored its own. Both are now unified on mirroring, which
     the `raw` passthrough invariant asks for: claude init,
     permission-request, and turn-completion paths, and codex
     approval, session-start, and turn-completion paths, through a new
     `emitGrammarViolation`. Design §4.2 and the FSM header now
     describe one rule. Tests: "a line the session state rejects still
     goes out raw before the fatal (review live21)", claude and codex
     (new fake scenario `dupask`: two permission requests under one
     id). A/B: both fail without the mirror. **This reverses a recorded
     design decision (live6).** I took it because the split dropped
     harness evidence the caller needs and the code already
     disagreed with it.
  Checked and left as designed: the `interruptBeforeInit` hold still
  applies (the forwarded first line is the only pre-init input); codex
  `failOpenTurn` has no harness line to mirror (it answers a
  `turn/start` response).
- *Docs.* I grepped the next-turn and queue claims, the roll, and
  `resumable` across README, CHANGELOG, docs/*.md, the fixtures README,
  and the module headers. Updated:
  - Design: §3.1 rewritten from the fixture and probes; §3.1 auto-deny
    evidence; §3.4 matrix rows; §4.1 `user`/`steer` rows; the
    drain-notice paragraph; §4.2 `turn_completed` labeling (roll
    removed) and the tier-2 rule; §4.3 flags; §4.8 `resumable` and the
    refused-resume frame; §9 risk 5; and the §8 and round-6 addendum
    notes, each marked as corrected rather than rewritten.
  - HARNESS-COMPATIBILITY: floors, matrix, interrupt, and replay echo.
  - README: `steer` row, `busy` reason, matrix, a paragraph on why
    claude/zai is false, and the `resumable` sentence.
  - The rest: the panel doc's step-0 summary; this report's step-0
    findings 3, the amendments list, and the §4.3 note (marked as
    corrected); the fixtures README; CHANGELOG (the false wire claim in
    the `steer` entry corrected in place, plus a live21 entry); and the
    `driver.ts`, `claude-session.ts`, `zai-session.ts`, `fsm.ts`, and
    fake headers.
  Later report sections (steps 1-8, live2-live20) record what was true
  then and are left as written, as in earlier rounds.

**Gate.** `make release-gate` exit 2. It stopped at the same
environmental `contracts` failure as every prior round: the installed
copilot binary's `--help` needs `mkdir ~/Library/Caches/copilot`, which
macOS denies this session's process. Inside the gate, `runtime` and
`check` passed, including typecheck, `sh -n`, and the full suite with
coverage: **1261 pass / 0 fail / 6 skip across 1267 tests in 52 files**.
The live20 gate was 1254/0/6 across 1260 in 52 files. This round adds
seven tests with no regressions and no removals: five replaced or
rewritten tests keep their slots.

A first gate run reported 1264 tests. That exposed three e2e tests I
had deleted by accident while replacing the queue test: the derived
file-change and Write add/edit tests. I restored them from the staged
copy and re-ran the gate for the count above.

Run separately after the stop, each exit 0: `make sandbox-contract
smoke`, `bun audit`, `bun install --frozen-lockfile --dry-run`, the
four gate `--help` probes, and both gate `verify` probes. `check_american`
on the 25 changed `.ts` and `.md` files: exit 0, clean.

**Live checks.** Four runs, all through `./bin/codemux session -a zai
--no-sandbox --auto high --shutdown-grace 20 --cwd <scratch dir>`. The
key came from a 0600 copy of `~/.zai` under a redirected HOME in the
ignored scratch directory. It was never printed, and the directory was
trashed afterward.

1. Text-only mid-turn probe, pre-fix: own-turn delivery (above).
2. Tool-turn mid-turn probe, pre-fix: folded delivery and the phantom
   t2 (above).
3. The same tool-turn probe after the fix. The mid-turn line was
   rejected `busy` at 4.9 s. t1 completed `end` on its own result
   (`num_turns: 2`), no second turn opened, and `session_ended` reported
   `resumable: true` with exit 0. The probe script sent its shutdown
   only at 150 s, because its quiet timer is checked only when output
   arrives. That is a flaw in the probe script, not in codemux.
4. Resume of probe 3's recorded session after trashing its transcript.
   Before the raw-mirror fix: the cryptic fatal and the false "may
   still run" notice, but already `resumable: false`. After it: the raw
   `result` mirrored as `unknown`, then the fatal naming the refused
   resume, `session_ended` with `reason: crash`, `resumable: false`,
   `exit_code: 1`, and codemux exit 1 at 0.6 s. Stderr carried "No
   conversation found with session ID: …".

Spend: three short turns on Z.AI (the resume refusals made no model
call).

**Deviations.** Two, both conservative:

- Removing the mid-turn surface instead of tracking replay echoes. The
  echo tracking was workable, but it would have rested on two observed
  timings.
- Unifying tier 2 on mirroring, which reverses the live6 split. See the
  lifecycle audit.

`docs/LIVE-SESSIONS-DESIGN.md` names both.

## Review fixes, live22

**Intended commit:** `fix(session): live22 review fixes — Unicode fold in the medium ceiling, codex usage on every end path, registry written before the first turn, transient registry failures exit 1`

The live22 findings file records two lenses: security (Claude, one
minor) and correctness-2 (Claude, four majors and two minors; it found
no blocker). No contracts findings were recorded. Every finding is
fixed with one regression test. A follow-up audit of the same classes
found five more defects and one minor gap; those are fixed and tested
too (see "Class audits"). Each code fix was A/B-checked: the pre-fix
source was put back in place, the new test failed, and the source was
restored byte-identical (`cmp`). No capability flag changed.

**Security, minor — the medium protected-name check folded case with
`toLowerCase` (`ceiling.ts`).** APFS's case-insensitive lookup folds
more than that. Example: a medium session asks to write
`.vſcode/tasks.json` (long s, U+017F). `toLowerCase` leaves `ſ` as is,
so the component did not match `.vscode` and the write was allowed. On
disk it lands in the real `.vscode/`. Fix: the new
`foldForProtectedLookup` upper-cases and then lower-cases. That maps
`ſ` to `s`, the Kelvin sign to `k`, and ligatures such as `ﬁ` to their
letters. Test: "the protected-name fold is Unicode's: long s, Kelvin,
and ligatures deny" (`.vſcode`, `.huſky`, `.mcp.jſon`, `.zſhrc`,
`.gitmoduleſ`, `.claude.jſon`, `.bash_proﬁle`).

**Correctness, major 1 — codex dropped known usage on a mid-turn end
(`codex-driver.ts`).** Usage for the open turn collected in `turnUsage`,
and only `completeTurn` added it to the session total. Example: a turn
reports 311 tokens through `thread/tokenUsage/updated`, then the caller
shuts down while the turn is still open. The synthesized
`turn_completed` reported all-null usage and `session_ended.usage`
reported nothing. Fix: the synthesis carries `turnUsage` and adds it to
the total. Test: "a session ending mid-turn keeps the open turn's
reported usage" (new fake scenario `usagewait`).

**Correctness, major 2 — agy reported a session resumable when its
start was never recorded (`agy-driver.ts`).** `harnessConfirmed` was
set before `recordStart` ran. When the record failed, the crash end
still said `resumable: true`, and `--resume` would exit 66. Fix:
`resumable` now also requires `ownsRecord`, which matches the claude
driver. Test: "a confirmed conversation whose start was never recorded
is not resumable" (the registry path sits under a regular file).

**Correctness, major 3 — a transient registry failure on resume exited
78 (`registry.ts`, `cli.ts`).** `UpdateOutcome` failures now carry a
`kind`. `untrusted` covers placement, mode, a corrupt file, and a write
no reader would accept. `unavailable` covers I/O errors: a lock held
past its budget, ENOSPC, EACCES. `claimForResume` returns the new
`unavailable` outcome, and the CLI exits 1 on it, the same code as the
equivalent failure on a fresh session. Untrusted stays 78. Test: "a
claim that cannot reach the registry is unavailable, not untrusted".

**Correctness, major 4 — a fresh session ran its first turn before the
registry was checked (`driver.ts`, `cli.ts`, `registry.ts`).** I
checked each harness:

- Claude/zai records at the init frame, which arrives only after the
  caller's first input. codemux chooses the session id, so the CLI now
  writes the record before the spawn (`recordBeforeSpawn`). The init
  frame then confirms the session and writes nothing. That also removes
  a lock wait from harness-line handling.
- Codex already records at the thread handshake, before any turn
  (preSessionLines park input until then).
- Agy cannot record before its first turn, because only that turn's
  result names the id. The CLI now runs `probeRegistryForStart` first:
  the same locked write, with nothing changed. A failure exits 1 with
  nothing spawned. The residual is a registry that becomes unwritable
  between the probe and the first result. Design §4.8 states it.

Tests: "a fresh claude / agy session with an untrusted registry exits 1
before any input reaches the harness" (no `input-lines.jsonl`, empty
stdout), plus "the start probe refuses an untrusted or unreachable
registry and accepts a fresh one".

**Correctness, minor 5 — the turn timer re-armed after the end began
(`driver.ts`, `codex-driver.ts`).** A refused timeout interrupt started
the crash end. The callback then called `armTurnTimer()` with no
`finished` check, and a drain longer than the timeout raised a second,
false "--turn-timeout" fatal. Fix: `armTurnTimer` returns once
`finished` is set, and the callback checks it too. Tests: "a refused
timeout interrupt ends the session once, without a re-armed second
fatal", one each for claude and codex. Both fakes survive SIGTERM for
300 ms (`exit143`), so the drain outlasts the 100 ms timer.

**Correctness, minor 6 — codex `turn/start` success with no turn id
(`codex-driver.ts`).** The server's turn may still be running, and
without its id codemux can neither steer nor interrupt it. Fix: the
session ends on the crash path, which stops the child and answers the
turn `failed`. Sibling fixed in the same place: `sendInterrupt` used to
queue an interrupt to ride a `turn/start` response that would never
come, and the end path then waited a full grace window. It now returns
false when no `turn/start` is in flight. Test: "a turn/start success
that names no turn ends the session at once" (new scenario `noturnid`;
only one `turn/start` reaches the server, no interrupt is sent, and the
end comes in under 5 s; pre-fix it hung until the test timed out).

**Class audits.** I fixed the first round, then had an in-process
subagent walk every signal, shutdown, timeout, stdin-close, crash,
drain, and child-exit path in the three drivers and the CLI. I verified
each of its candidates in the code before fixing it.

- *Usage on end paths (major 1's class).*
  1. Codex `failOpenTurn` reported the turn's usage on its
     `turn_completed` but never added it to the total. Test: "usage
     reported before a refused turn/start reaches the session total"
     (scenario `usagefailstart`).
  2. Claude/zai: the result of a pre-init input drained during the end
     is mirrored as `unknown`, and its usage and cost were dropped from
     the total. The same applied to a result that arrives before init
     (a refused resume). Both are now added. The live16 drain test now
     asserts the total.
  3. Agy has no streamed usage. Its synthesized completion stays
     all-null, which is correct there.
- *Registry before the first turn (major 4's class).* A claude/zai
  resume claimed its record before the spawn but still wrote the full
  record at init. So a busy lock at init failed the session after the
  turn had started, and the resume's narrower flags reached the record
  only then. The resume now calls `recordBeforeSpawn` after the claim.
  On failure the CLI releases the claim and exits 1. Test: "the resume's
  own flags are in the record before any input reaches the harness" (a
  dropped `--pass-env` name is recorded with no input sent).
- *Resumable and ownership (major 2's class).* A fresh claude/zai record
  written before the spawn that the harness never confirmed would
  outlive the session, and a later `--resume` would reach the harness
  (exit 1) instead of the registry's 66. The new
  `discardUnconfirmedRecord` removes only this process's own record. The
  driver end path and the CLI's spawn-failure path both call it. Test:
  "a fresh claude session's pre-spawn record is discarded when the
  harness never confirms it".
- *Transient versus policy codes (major 3's class).* `readRegistry`
  classed every read error other than ENOENT as `untrusted`, so EMFILE
  on the unlocked lookup also exited 78. EMFILE, ENFILE, EIO, EAGAIN,
  EINTR, and ENOMEM are now `unavailable`, through both the lookup and
  `updateRegistry`. Test: "a transient read failure is unavailable for
  resume, never the 78 refusal" (an `openSync` spy).
- *Acting after the end began (minor 5's class).*
  1. All three drivers: an end that raised a fatal during the drain
     (for example the turn-timeout's second expiry, an overlong line,
     or an unknown response id) still answered the open turn
     `interrupted`, "the session ended (shutdown)". It is now `failed`
     with the fatal as the reason. The live17 turn-timeout tests for
     claude and codex now assert `failed`, and design §4.5 says so.
  2. All three drivers: `handleCallerEnd` guarded on `settled`, not
     `finished`, so a stdin read error after an acked shutdown added a
     fatal and turned exit 0 into 1. It is now a non-fatal error event.
     Tests: "a caller-stdin read error during the drain does not fail
     an orderly end", one per driver.
  Checked and correct: the session and permission-expiry timers, the
  `proc.exited` continuations, handshake responses during the drain,
  approvals during the drain, writes after `finished`, and the
  signal-gate latch.
- *Response fields soft-failed (minor 6's class).* Claude/zai passed
  every `control_response` through as `unknown`, including the error
  answer to codemux's own interrupt. The interrupt then stayed pending:
  the turn's own API error was labeled `interrupted`, a drain exit 1
  was excused, and the end path waited out the grace window. The parser
  now reports `control_error`. The driver clears the matching
  interrupt, emits a non-fatal error, and the end-answer wait stops.
  Test: "a refused interrupt is cleared: the turn's own API error stays
  failed" (new fake scenario `refuseint`). No fixture records this
  answer; the shape is the one codemux itself sends
  (`buildControlErrorResponse`). Design §3.1 says so.
- *Case folding (the security class).* No other path comparison folds
  case: a grep of `toLowerCase` and `toUpperCase` across `src/` finds
  only environment-variable names.
- *Docs.* I grepped the exit-78, init-frame record, `resumable`,
  synthesized-usage, turn-timeout, and case-fold claims across the
  README, CHANGELOG, docs/*.md, and the module headers. Updated:
  - The README's exit codes and registry paragraph.
  - Design §3.1 (interrupt refusal), §4.1 (the case-fold list), §4.5
    (turn-timeout synthesis), §4.6 (exit codes; synthesized usage), and
    §4.8 (record timing, `resumable`, unconfirmed records).
  - The HARNESS-COMPATIBILITY agy paragraph.
  - A live22 CHANGELOG entry.
  The CHANGELOG's live10 entry ("all-null usage") is about agy and is
  still true.

Left as designed: the signal gate stays installed through the final
flush, so a SIGTERM after `session_ended` turns exit 0 into 143. The
driver comments make that choice on purpose, and a signal that arrives
is reported honestly.

**Gate.** `make release-gate` exit 2. It stopped at the same
environmental `contracts` failure as every prior round: the installed
copilot binary's `--help` needs `mkdir ~/Library/Caches/copilot`, which
macOS denies this session's process. Inside the gate, `runtime` and
`check` passed, including typecheck, `sh -n`, and the full suite with
coverage: **1279 pass / 0 fail / 6 skip across 1285 tests in 52
files**. The live21 gate was 1261/0/6 across 1267 in 52 files. This
round adds 18 tests, with no regressions and no removals.

Run separately after the stop, each exit 0: `make sandbox-contract
smoke`, `bun audit`, `bun install --frozen-lockfile --dry-run`, the
four `--help` probes, and both `verify` probes. `check_american` on the
19 changed files: exit 0, clean.

One flake: during development, one run of
`tests/session-e2e.test.ts` and `tests/session-codex-e2e.test.ts`
together timed out "the shutdown drain delivers the harness's final
output" (codex, a 5 s wait). It did not reproduce in ten further
runs: four alone, three with its file, two with both files, and the gate.

**Live checks.** Three runs through `./bin/codemux session -a zai
--no-sandbox --auto high --shutdown-grace 20`. The key came from a 0600
copy of `~/.zai` under a redirected HOME in the ignored scratch
directory. It was never printed, and the home was trashed afterward.

1. Fresh session, one turn. The record was already in the registry,
   with `ended: null`, when `session_started` arrived. The turn ended
   `end` ("ok"), and `session_ended` reported `resumable: true`, exit
   0, with the record's `ended` stamped.
2. The same registry at mode 0644: exit 1 with nothing on stdout, and
   stderr "cannot record the session in the registry: untrusted session
   registry: the registry mode is 100644, not 0600 (registry: …)". No
   model call.
3. Resume of run 1's session (record written after the claim, before
   the spawn): the turn ended `end` ("again"), `resumable: true`, exit
   0, and the registry still holds one record.

Spend: two short turns on Z.AI.

**Deviations.** Two, both conservative:

- Claude/zai now record before the spawn. The finding allowed a
  pre-spawn check only. Writing the record removes the gap for that
  family and takes the lock wait out of harness-line handling, at the
  cost of a record for a session that may never start. That record is
  removed at the end.
- A synthesized completion after a drain fatal is now `failed`. This
  changes the live17 tests' expected label, which those tests had
  pinned as `interrupted`.

## Review fixes, live23

**Intended commit:** `fix(session): live23 review fixes — exact-id interrupt refusals, corrupt-not-untrusted registry content, write-before-ack for interrupts and steers, codex mirror-before-fatal`

The live23 findings file records four lens runs. Two produced
findings: contracts (Z.AI GLM, two runs: two majors, eleven minors, one
trivial, with overlap) and correctness-2 (Claude, three minors). The
security run and the second correctness-2 run exited 1 with no
findings, so there was nothing to fix from them. Every finding is fixed
with a regression test. Each code fix was A/B-checked: the pre-fix
source was put back, the new test failed, and the fixed source was
restored (`cmp`). No capability flag changed: no finding showed a flag
that is not honest.

**Contracts, major 1 — a refused end-path interrupt stayed pending
(`driver.ts`).** The end path sent `interrupt-end-N`, and the refusal
check compared `interrupt-N`. Example: a harness answers the shutdown
interrupt with `subtype: "error"`, then the turn's own API error. The
turn was labeled `interrupted`, the child's exit 1 was excused, and the
session ended 0. Fix: the driver stores the id it actually sent
(`interruptId`) and matches the refusal against it. Test: "a refused
end-path interrupt is cleared: the turn stays failed and the drain exit
1 counts" (now `failed`, exit 1).

**Contracts, major 2 — an invalid-UTF-8 registry was untrusted
(`file-io.ts`, `registry.ts`).** The strict decode threw a code-less
error, and the reader classed every such error `untrusted`. Every start
and resume was refused until the file was deleted by hand. Fix:
`readUtf8FileBounded` now throws `FileContentError` for a content bound
(invalid UTF-8, oversize), and the registry reader classes it
`corrupt`. A fresh start backs it up and resets, and a resume still
refuses 78. Test: "an invalid-UTF-8 registry is corrupt, so the next
start backs it up and resets".

**Contracts, minor 3 — the resume containment guard was unreachable
(`cli.ts`).** The start-time check (exit 64) ran before the resume
lookup. Fix: the CLI judges a resume first, so rule 3 answers 78 as the
README says; the 64 check then applies to fresh sessions. The test now
resumes in the recorded cwd and asserts the containment message. Before
the fix it passed only through the cwd-mismatch guard. Test: "a
registry inside the entry's own working directory refuses with 78, not
66" (rewritten).

**Contracts, minor 4 — a dangling symlink at the registry directory
(`registry-io.ts`).** `existsSync` follows links, so a dangling link
read as "nothing exists yet" and skipped the symlink refusal. Fix: both
existence checks use `lstat`; ENOENT and ENOTDIR mean absent. The
registry file's own check had the same shape and is fixed too. Test: "a
dangling symlink at the registry directory is refused as untrusted,
naming the link" (directory and file).

**Contracts, minors 5 and 1b — tier-2 mirror.** The README still
described the pre-live21 split. It now states the unified rule. The
codex driver emitted the fatal without the mirror on its response-side
paths: an unknown or string response id (success and error), a thread
response with a missing or invalid id, the resume and fresh thread-id
mismatches, a `turn/start` success with no turn id, a `thread/started`
naming another thread, and `failOpenTurn`'s FSM error. All now go
through `emitGrammarViolation(rawLine, …)`. Test: "response-side
violations mirror the raw line before the fatal" (string id and
`noturnid`).

**Contracts, minor 6 — the README's synthesized usage.** The README now
says a synthesized completion carries the usage the turn reported (codex),
all-null on claude/zai and agy.

**Contracts, minors 2–7 and 9 (second run), docs.** HERMETIC no longer
lists an absent registry among the refusals (it is 66). Design §4.2
names the `total_tokens` exception. §4.1 routes a non-object
`updated_input` to `malformed` and names the four tools with a schema
at low. It also states the blank-line and CR carve-outs. The excerpt
bound is stated in bytes. The `fsm.ts` header cites §4.6. Tests: nine
cases in the new `tests/session-docs.test.ts`, each refusing the stale
wording.

**Contracts, minor 7 — the excerpt unit (`process.ts`, three
parsers).** The parsers cut 4096 characters (up to 16 KiB of multibyte
text), and the process layer cut bytes. Fix: one exported
`unusableFacts` in `process.ts` cuts 4 KiB of UTF-8 bytes, and the three
parser copies are removed. Test: "the tier-3 excerpt is 4 KiB of bytes
in every parser, not 4096 characters".

**Contracts, minor 8 — the fake's interrupt echo.** The fake claude
answered with an inner `subtype: "success"` the recorded wire never
has. Both echo sites now send `response: {still_queued: []}`. Test:
"the fake's interrupt answer has the recorded wire's shape" (compared
with `zai-session-a.ndjson`).

**Correctness-2, minor 1 — ack before write (`codex-driver.ts`).** An
interrupt or steer was acked before it was written. A refused write
(the backlog cap) left an accepted ack for input the harness never got.
Fix: an interrupt, and a steer whose turn is already named, is written
first; a refused write rejects the line `shutting_down`, the same rule
live20 set for decisions. Tests: "an interrupt whose write is refused is
rejected, never acked accepted" and "a steer whose write is refused is
rejected and never echoed".

**Correctness-2, minor 2 — a rejected steer looked delivered.** The
pending steer call now carries its `input_seq`s and turn. The non-fatal
error names them: "the app-server rejected the steer request (input_seq
2, turn t1; the text did not reach the turn)". A new protocol field was
not added; the message carries it. Test: "a steer the app-server rejects
is reported by its input_seq and turn" (new fake scenario
`refusesteer`).

**Correctness-2, minor 3 — one closed turn remembered.** The codex
driver now keeps a set of closed harness turn ids (the most recent
1024), and the parser's context takes the set. Test: "a straggler from
two turns back is still late, not a grammar error" (new scenario
`laggard2`).

**Class audits.** An in-process subagent walked every signal,
shutdown, timeout, stdin-close, crash, drain, and child-exit path in the
three drivers and the CLI. A second one grepped the corrected claims
across README, CHANGELOG, docs/*.md, and module headers. I checked each
candidate in the code before fixing it. Siblings fixed, each with a
test unless noted:

- *Ack before write (minor 1's class).*
  1. Claude/zai interrupt: the same ack-then-write order. Test: "an
     interrupt whose write is refused is rejected, never acked
     accepted" (claude).
  2. A deferred interrupt (claude before init, codex behind
     `turn/start`) or a codex steer buffered behind `turn/start`, whose
     later write was refused, left no event naming its `input_seq`. Each
     now gets a non-fatal notice naming it. Tests: "an interrupt held
     for init names its input_seq…", "an interrupt queued behind
     turn/start…", "a steer buffered behind turn/start…".
- *Pending state after a refused write (major 1's class).*
  1. Claude `sendInterrupt` set `interruptPending` even when the write
     was refused, so the crash end could label a drained error result
     interrupted. It now marks nothing on a refusal (covered by the
     claude interrupt test above).
  2. Both drivers set the timeout label before the interrupt write. It
     is now set only on a written (or queued) interrupt. Tests: "a
     timeout interrupt that was never written does not label the end's
     interrupt turn-timeout" (claude and codex).
  3. A refused supersede deny started the crash end, which wrote its own
     interrupt; the caller's handler then wrote a second one and
     replaced the id a refusal is matched against. The caller and timer
     paths now stop once the end began. Test: "a caller interrupt after
     a refused supersede writes no second interrupt".
  4. The codex end path's grace wait had no rejection term, so a
     rejected end interrupt held the full grace. It now stops when the
     interrupt's call id is cleared. Test: "a rejected end-path
     interrupt stops the grace wait" (new scenario `refusehold`).
- *Mirror before fatal (minor 5's class).* Five handlers wrote the
  answer before mirroring the raw line, so a refused write put the fatal
  first and a false "answered" notice after it: claude's unparsable
  permission and unsupported control request, and codex's
  no-refusal approval, unparsable approval, and unknown server request.
  Each now mirrors first and emits the notice only after a delivered
  answer. Tests: "a control request whose answer is refused mirrors
  first and claims no answer" (claude) and "a server request whose
  answer is refused…" (codex).
- *Writes after the end began.*
  1. Agy `run()` announced and recorded a resumed session after an
     early line had already crashed it. Test: "an early harness line
     that ends a resumed session starts and records nothing".
  2. Codex `run()` sent `initialize` after the same early crash. Test:
     "an early harness line that ends the session starts no handshake".
  3. Codex sent the thread request after a refused `initialized`
     notification. Test: "a refused initialized notification sends no
     thread request".
  4. Codex `flushSteer` kept writing after a refused write. It now
     stops (covered by the steer tests).
- *Content errors classed as trust (major 2's class).* A lock file with
  invalid UTF-8 left by a dead process stayed `unknown` and blocked
  every write; it is now judged by its name's pid like other junk. Test:
  "a dead acquirer's lock file with invalid UTF-8 is stolen like any
  junk".
- *Docs.* The panel record (tier-2 split, keep-semantics, low schemas,
  "every stdin line"), README's "Every input line is acknowledged", and
  the `protocol.ts` and `ceiling.ts` headers. The design's round-3
  history line gets a forward note. Tests: four more cases in
  `tests/session-docs.test.ts`. The CHANGELOG's live4, live6, and
  live10-era round entries describe their round, and later entries in
  the same section correct them, so they stay.

Left as designed:

- A `user` line keeps ack, `turn_started`, echo, then write. Live16
  ordered it so the fatal follows the turn it failed, and the crash end
  answers that turn `failed` with the delivery error as the reason, so
  the line gets an honest answer through its turn.
- A registry failure while handling codex `thread/started` emits a
  codemux fatal without that line. It is codemux's own failure, not a
  harness violation, and §4.8 forbids the announcement it would carry.

**Gate.** `make release-gate` exit 2. It stopped at the same
environmental `contracts` failure as every prior round: copilot's
`--help` needs `mkdir ~/Library/Caches/copilot`, which macOS denies this
session's process. Inside the gate, `runtime` and `check` passed,
including typecheck, `sh -n`, and the full suite with coverage:
**1316 pass / 0 fail / 6 skip across 1322 tests in 53 files**. The
live22 gate was 1279/0/6 across 1285 in 52 files. This round adds 37
tests and one file (`tests/session-docs.test.ts`), with no regressions
and no removals. Run separately after the stop, each exit 0: `make
sandbox-contract smoke`, `bun audit`, `bun install --frozen-lockfile
--dry-run`, the four `--help` probes, and both `verify` probes.
`check_american` on the 28 changed files: exit 0, clean.

One test race found and fixed during development: the turn-timeout
label tests installed their write refusal after the turn opened, so on
a slow run the 100 ms timer fired first. The refusal is now installed
before the turn starts; three reruns of each passed, and both still fail
on the pre-fix drivers.

**Live check.** One run through `./bin/codemux session -a zai
--no-sandbox --auto high --shutdown-grace 20 --cwd <scratch dir>`. The
key came from a 0600 copy of `~/.zai` under a redirected HOME in the
ignored scratch directory. It was never printed, and the home was
trashed afterward. The registry was seeded with four bytes of invalid
UTF-8. The session started (`session_started` at 0.3 s), and the
registry directory then held a `live-sessions.json.corrupt-…` backup
and a fresh registry. An `interrupt` sent on the first delta was
accepted (`input_seq` 2), the turn ended `interrupted` at 7.1 s after 45
numbers, `session_ended` reported `resumable: true`, and codemux exited
0. Spend: one short turn on Z.AI.

**Deviations.** Three, all conservative:

- The rejected-steer report rides the error message instead of a new
  `input_seq` field on `error` events. That avoids new protocol surface.
- Rule 3 stays and the CLI order changed, instead of removing the
  containment branch. The branch now runs as the design describes.
- User lines keep their ack-then-write order (see "Left as designed").

## Review fixes, live25

**Intended commit:** `fix(session): live25 review fixes — refuse provider overrides, honest lock errors, playwright at low only, codex fragment and end-path fixes, usage exit codes`

The live25 findings file records three lens runs on the merged 0.9.0
tree (`live-sessions-0.9`, main 0.8.0 plus live sessions): security
(Claude, one major), correctness-2 (Claude, two majors and seven
minors), and contracts (Z.AI GLM, seven minors). Every finding is
fixed with a regression test. Each code fix was A/B-checked: the
pre-fix file was restored from the index, the new tests failed, and the
fixed file was put back (`cmp`). No capability flag changed: no finding
showed a flag that is not honest.

The work ran in `~/Programming/Ops/codemux` on `live-sessions-0.9`.
The prompt named `~/Programming/Ops/codemux-live` on `live-sessions`,
but that checkout is the 0.7.0 tree without provider overrides, and the
findings and the operator note target the 0.9.0 tree.

**Security, major — sessions ignored provider overrides (`cli.ts`).**
The session CLI never ran the adapter's override handling. Example:
with `CODEMUX_CODEX_PROVIDER_{BASE_URL,API_KEY,MODEL}` set, a codex
session ran against the operator's own `~/.codex` login, and the
provider key sat unused in the child's environment. Agents whose `run`
refuses an override (agy, zai) started a session anyway. Fix, per the
operator's decision for this release: `codemux session` exits 64 while
any non-blank `CODEMUX_<AGENT>_PROVIDER_*` name is set for the session
agent. The message names the variables (never a value) and says
overrides reach sessions in the next release. The check runs before
anything else is read. Test: "a provider override for the session agent
is refused with 64, naming the variables" (codex override, claude cap,
zai model, agy base URL, codex `MULTI_AGENT`, and a blank value that
does not refuse).

**Correctness-2, major 1 — a failed lock create blamed a live writer
(`registry-io.ts`).** Every `openSync(…, "wx")` failure was retried as
contention. Example: a registry directory the sandbox denies made the
default budget sleep about 10 seconds and then report `held by a live
writer`. Fix: only `EEXIST` retries; any other error is thrown at once
with its cause, and the caller's registry outcome carries it. Test: "a
lock create the directory denies is thrown at once, never blamed on a
live writer" (`EACCES`, under 1 s).

**Correctness-2, major 2 — `--enable-playwright-mcp` above low was
inert (`cli.ts`).** The ceiling maps every `mcp__*` tool to `other`,
denied above low, and read-only allows no tool use. So every Playwright
call at medium or high was rejected `autonomy_escalation`. The
surface-removing fix: the flag now requires `--auto low` for sessions
(exit 64 otherwise). Granting the tools at high would have been new,
unreviewed surface. Test: "--enable-playwright-mcp outside --auto low
is refused with 64" (read-only, medium, high).

**Correctness-2, minor 3 — a codex fragment at end of stream vanished
(`codex-session.ts`, `codex-driver.ts`).** The raw-newline rejoin
buffer held a partial frame, and nothing reported it when the stream
ended. Fix: the unused `reset()` is replaced by `takeFragment()`. The
end path calls it once the child has settled, and a held fragment is a
tier-3 fatal with its excerpt and raises the exit code. Tests: "a
fragment the stream ends inside is reported tier 3, never dropped" (new
fake scenario `fragment`) and the parser unit test "takeFragment hands
back the buffered fragment once".

**Correctness-2, minor 4 — the codex end path waited the full grace
(`codex-driver.ts`).** `call()` registered a request before writing it.
A refused `turn/start` write started the crash end synchronously while
the entry was still pending. So `sendInterrupt` queued behind a
response that could not come, and `awaitEndAnswer` held the whole grace.
Fix: a call is registered only after its write succeeds. Test: "a
refused turn/start write ends at once, without waiting the grace for its
response" (under 400 ms against a 500 ms grace).

**Correctness-2, minor 5 — a deaf harness ended 0 (`driver.ts`).** An
orderly end whose interrupt write was refused (the harness stopped
reading stdin) sent nothing and said nothing. The child died by SIGTERM
(code null, so no drain failure), and the synthesized `interrupted` turn
let the session exit 0. Fix: on a non-crash end, a refused end-path
interrupt is a fatal `codemux` error. The exit code becomes 1, and the
turn is answered `failed`. `resumable` keeps the §4.8 rule (a session
the harness confirmed stays resumable), because the transcript up to
the stop exists. Test: "an orderly end whose interrupt the harness will
not take exits 1, not 0".

**Correctness-2, minor 6 — an unhandled stdout rejection
(`process.ts`).** `stdoutDone` had no handler until the child exited, so
a pipe read error before then ended codemux and left the detached
harness group running. Fix: the reader's rejection becomes a new
`read-error` fatal on the fatal channel, so the driver's end path runs
and kills the tree. The three drivers share `codemuxFatalMessage` for
it and for `handler`. Test: "a stdout read error is a read-error fatal,
never an unhandled rejection" (stubbed reader; no unhandled rejection is
observed, and the child dies by signal).

**Correctness-2, minor 7 — usage errors exited 1 (`cli.ts`).** Plain
errors from run's shared validators fell through to
`handleUnexpectedError`. Fix: `asUsage` turns them into exit 64 for
`--pass-env` (and the `CLAUDE_CONFIG_DIR` check), the sandbox policy
flags, `--model`, `--auto` resolution, `--effort` resolution, and
`--cwd`. Test: "flag values run's shared validators refuse are usage
(64), not exit 1".

**Correctness-2, minor 8 — codex `--effort none` was dropped
(`cli.ts`).** Codex lists `none`, and `buildTurnStartRequest` omits it,
so the default reasoning applied with no notice. Fix: refused for codex
sessions (exit 64). `turn/start`'s `effort` is the one verified carrier,
and it has no audited `none`. Claude already refuses `none` (it is not
in its levels), and zai has no effort support, so `none` there is a
no-op as in `run`. Test: "--effort none is refused for codex sessions
instead of silently dropped".

**Correctness-2, minor 9 — a resume refused its own pid
(`registry.ts`).** `judgeResumeEntry` now exempts `process.pid`, the
same exemption `recordSessionStart` makes. Test: "a record naming this
process's own pid as live owner is not busy" (lookup and claim). Two
existing tests used the test process as the live owner. The registry
test "a live owner refuses with session_busy" now uses a live child
process. The e2e test "the registry guards resume" now asserts the
recorded ownership instead.

**Contracts, minors 1–7 (docs and comments).**

1. The codex driver's `call()` doc sat on `closeHarnessTurn()`. It is
   merged into `call()`'s own doc.
2. Design: the straggler rule now says "any of the most recent 1024
   closed turns".
3. `readRegistry`'s doc names both fresh-start writers that reset a
   corrupt file.
4. The root-containment registry test gained its harness-home half.
5. The whole-session cap is named by its real flag, `--timeout`, in
   the design and in this report; the old name was never a flag.
6. The `--sandbox-trust untrusted` refusal is scoped to sandboxed
   sessions in README, CHANGELOG, and the design. With `--no-sandbox`
   the flag is ignored with a warning, as in `run`.
7. The fake agy's `wrongid` comment states the real trigger.

Tests: seven cases in a new live25 block of `tests/session-docs.test.ts`.

**Class audits.** I walked every signal, shutdown, timeout, drain, and
exit path in the three drivers and the CLI. I also grepped each
corrected claim across README, CHANGELOG, `docs/*.md`, and the module
headers. Siblings fixed:

- *Registry errors read as contention (major 1's class).* The sweep's
  and the confirm loop's failed unlink of a dead holder's file was also
  counted as contention. It now throws its cause at once. Test: "a dead
  holder's lock the directory will not let go is thrown at once".
- *Override surface sessions ignore (the security class).* Codex's
  `CODEMUX_CODEX_PROVIDER_MULTI_AGENT` knob is not one of the five
  override names, and a session ignored it too. The refusal covers the
  whole `CODEMUX_<AGENT>_PROVIDER_` prefix (covered by the override
  test). The `provider-override.ts` header no longer describes a planned
  session path through `readProviderOverride` as current.
- *A refused end-path interrupt read as clean (minor 5's class).* The
  codex driver had the same gap: `sendInterrupt` returned false and the
  end stayed 0. It now reports the same fatal. Test: "an orderly end
  whose interrupt the app-server will not take exits 1, not 0".
- *Codemux-side fatals (minor 6's class).* All three drivers report
  `read-error` as a `codemux` error, never as unusable harness output.
- *Docs.* README's session section and override section, the README
  Playwright section (it said "sessions" for the `run` opt-in), the
  CHANGELOG 0.9.0 summary, and the design's §4.5 flag list now state the
  override refusal, the Playwright `--auto low` requirement, the codex
  `--effort none` refusal, and the usage exit code.

Left as designed:

- Agy has no interrupt. Its end closes stdin and waits the grace, so a
  turn still running when SIGTERM lands is the documented synthesized
  `interrupted` (review live10). It is not minor 5's defect, because no
  write is refused.
- A held lock file that cannot be read stays `unknown` and blocks (fail
  closed, review live14). Only removal failures of files judged dead now
  throw.

**Gate.** `make release-gate` exit 2. It stopped at the same
environmental `contracts` failure as every prior round: copilot's
`--help` needs `mkdir ~/Library/Caches/copilot`, which macOS denies this
session's process (`EPERM`). Inside the gate, `runtime` and `check`
passed, including typecheck, `sh -n`, and the full suite with coverage:
**1411 pass / 0 fail / 6 skip across 1417 tests in 54 files**. The
baseline on this merged tree before the round was 1392 / 0 / 6 across
1398 tests in 54 files (the live23 figure, 1316 across 1322 in 53
files, predates the 0.8.0 rebase). This round adds 19 tests, with no
regressions and no removals. One test was replaced (the parser's
`reset` test is now the `takeFragment` test), and two were rewritten
for minor 9. The first gate run had one failure, the e2e registry-guard
test that relied on the own-pid busy refusal; it is rewritten as
described above. Run separately after the stop, each exit 0: `make
sandbox-contract smoke`, `bun audit`, `bun install --frozen-lockfile
--dry-run`, the four `--help` probes, and both `verify` probes.
`check_american` on the 22 changed files: exit 0, clean.

**Live check.** No paid turn. The new claims are pre-spawn refusals and
end-path edges that the fakes prove. The refusals were run against the
installed binaries through `./bin/codemux`, and nothing spawned:
`CODEMUX_ZAI_PROVIDER_{MODEL,MAX_OUTPUT_TOKENS}` with `session -a zai
--no-sandbox --auto high` exited 64 naming both variables;
`CODEMUX_CODEX_PROVIDER_MULTI_AGENT=off` with `session -a codex` exited
64; `session -a claude --sandbox --auto high --enable-playwright-mcp`
exited 64. While probing the usage exit codes, one `codemux session -a
codex --no-sandbox --auto high --effort ultra` run started the installed
codex app-server with stdin already closed. It ended at once
(`session_ended` reason `stdin-close`, exit 0) before any thread or
prompt, so it spent nothing.

**Deviations.** Five, all conservative:

- The tree: `~/Programming/Ops/codemux` (`live-sessions-0.9`), not
  `codemux-live`, as explained above.
- The override refusal covers the whole `CODEMUX_<AGENT>_PROVIDER_`
  prefix, not only the five override and cap names, so codex's
  `MULTI_AGENT` knob cannot be silently ignored either.
- Playwright at medium and high is refused, not granted. A grant would
  be new ceiling surface.
- Codex `--effort none` is refused, not sent. No audited `none` exists
  on the session carrier.
- A refused end-path interrupt keeps `resumable` as §4.8 defines it and
  changes only the exit code and the turn's `finish`.
