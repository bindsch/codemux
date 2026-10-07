# Live sessions — consolidated panel review

Status: consolidation of the three panel reviews (`docs/panel/panel-codex.md`,
`docs/panel/panel-claude.md`, `docs/panel/panel-zai.md`) of
`docs/LIVE-SESSIONS-DESIGN.md` (approved 2026-10-04), plus the Prompt B brief
(`<workspace>/lab-service/docs/codemux-live-session-prompts.md`, read
this time; the panels could not read it). Verdicts: codex NOT READY, claude
READY WITH CHANGES, zai READY WITH CHANGES. This document deduplicates every
finding, records the disposition (design amended, or why not), and carries the
amended implementation plan that Prompt B executes. The owner's §10 decisions
are unchanged.

Two evidence updates made while consolidating, both free:

- **The codex app-server wire contract is now verified** from openclaw's
  production client (`~/Programming/OSS/openclaw/extensions/codex/src/app-server/`,
  synced against codex 0.159.x). NDJSON framing; `initialize`/`thread/start`/
  `thread/resume`/`turn/start`/`turn/steer`/`turn/interrupt` param shapes;
  notification set (`thread/started`, `turn/started`, `item/started|updated|
  completed`, `turn/completed` with the full turn, `thread/tokenUsage/updated`
  carrying `{total, last, modelContextWindow}`); server→client approval
  requests `item/commandExecution/requestApproval`,
  `item/fileChange/requestApproval`, `item/permissions/requestApproval`;
  `approvalPolicy` values `untrusted|on-request|{granular…}|never`; thread
  `sandbox` takes the string mode, turn `sandboxPolicy` the structured policy.
  This retires most of the design's codex `[verify]` tags without spending
  quota; the recorded fixtures in step 0 confirm them against the installed
  0.159.3.
- **Claude's blocker CL2 is factually wrong.** `src/adapters/agy.ts` exists,
  is registered (`src/adapters/index.ts`), pinned
  (`src/harness-compatibility.ts`, min = maxAudited = 1.2.14), allowlisted
  (`src/environment.ts`), and covered by `tests/new-adapters.test.ts` and
  `docs/agy-cursor-report.md`. The panel reviewed a stale checkout. agy needs
  no "step 0b run adapter"; it needs a session driver (plan step 8). The
  installed agy is 1.2.16 (unaudited tier: runs with a warning, like `run`).
- **Step 0 has run (2026-10-04/05).** All claude-family and codex probes in
  the plan below executed; sanitized fixtures live in `tests/fixtures/live/`
  and every confirmation and correction is folded into the design's §3, §4,
  and §8 (the two wrong claims it caught: the permission carrier is
  `--permission-prompt-tool stdio`, and claude-family mid-turn messages in
  print mode were read as going to the next turn — a reading review live21
  corrected: the fixture's mid-turn message is folded into the active
  turn, a text-only turn runs it as its own, and the flag is now
  `user_during_turn: false`). Not-run: the
  scode-wrapped session (nesting refusal in the implementing sandbox) and
  agy's full exchange (expired interactive login) — both recorded in
  design §8 with their `[verify]` consequences kept open.

## 1. Codex's NOT READY verdict — blockers, answered

Codex blocked on two findings. Both amend the design; neither blocks
implementation once amended.

- **B1 (blocker): fail-closed parsing contradicts Prompt B's passthrough.**
  The design (§4.2, §6 item 2) demanded loud failure on unknown shapes while
  Prompt B requires malformed and unknown events to pass through as `raw`
  with `type: "unknown"`, never dropped. Resolution — three tiers, adopted
  into §4.2:
  1. A valid JSON object whose type/method codemux does not recognize is an
     **`unknown` event** carrying `raw`; the session continues. Archival
     passthrough, never dropped.
  2. A recognized lifecycle event that violates the grammar — session id
     missing or mismatched, a second thread announcement — is emitted as
     `unknown` (raw preserved) **and** ends the session with a fatal
     `error` (source `harness`). Fail closed without dropping the record.
     The same tier reached by the driver instead (a turn terminal with no
     open turn, a duplicate permission id, a codex response naming no
     turn or an unknown request id) mirrors the line the same way before
     the fatal: review live21 removed the split this entry used to record
     (review live10), and review live23 extended it to the codex
     response paths. The amended §4.2 and the README state the unified
     rule.
  3. A line that is not valid UTF-8 or not JSON is a fatal `error` carrying a
     bounded excerpt (the first 4 KiB of its UTF-8 bytes); the session ends. It cannot be an event,
     but it is never silently dropped.
  Permission-shaped requests never kill the session: an unparsable
  `can_use_tool`/approval request is answered deny (§4.1's opaque-action
  rule) and surfaced with its raw preserved.
- **B2 (blocker): the ceiling does not bound harness-native pre-approval.**
  User settings (`--setting-sources user`) can carry `permissions.allow`
  rules that run tools without reaching the host channel, and scode's
  writable mode does not prohibit Bash at medium. Resolution, adopted into
  §4.1 and §4.3: the ceiling is restated as a bound on the **permission
  channel** — what codemux will answer `allow` to — never as a bound on what
  the harness can do. The enforced boundary below high is scode, exactly the
  repo's standing doctrine (`src/adapters/base.ts`,
  "Harness-native permission controls are treated as defense in depth").
  Sessions load the same setting sources `run` loads (Prompt B: same safety
  boundaries as `run`); the residual — an operator's own allow rules
  pre-approving tools inside the sandbox — is the operator's configuration,
  bounded by scode, and is named in §4.3 instead of papered over.

Codex's three top recommendations: (1) constrain native pre-approval paths
→ B2 above; (2) record installed harness contracts first, then build →
adopted as plan step 0; (3) registry and exclusive ownership before public
persistent launch and resume → adopted as plan step 5 (registry lands before
any `--resume` becomes reachable; live-owner refusal ships with the registry).

## 2. Consolidated findings

Deduplicated across panels. Disposition says what changed in
`docs/LIVE-SESSIONS-DESIGN.md` (section numbers refer to the amended design)
or why nothing did. Severity is the highest any panel assigned.

### Wire contract and parsing

- **F1 (major; codex C-blocker, zai Z6, claude CL-plan): unknown vs malformed
  events.** Adopted — the three-tier rule in §4.2 (see B1). zai wanted
  unknown claude types fatal; Prompt B's passthrough requirement wins, and
  the lifecycle-grammar tier keeps the fail-closed invariant where it
  matters.
- **F2 (major; claude CL14/CL15, zai Z18, codex C10): unbounded lines, fields,
  queues.** Adopted — §4.2: per-line cap 16 MiB on harness output (a line
  over the cap is tier-3 fatal with a 4 KiB excerpt; accepted events are
  never truncated), caller input lines capped at 17 MiB, `text` 16 MiB,
  `author` 64 code points, outbound queue bounded (1024 events / 64 MiB
  pending; overflow ends the session with a fatal `error`), fatal UTF-8
  decoding everywhere.
- **F3 (major; codex C16-plan, claude CL-plan, zai Z3/Z5): probe and record
  fixtures before parsers.** Adopted — plan step 0 records sanitized fixtures
  under `tests/fixtures/live/` and the fake harnesses are generated from
  them, so they cannot drift from reality. The openclaw evidence (above)
  already pins the codex shapes; fixtures confirm against the installed
  binaries.
- **F4 (major; zai Z1): §4.7 contradicted itself on the scode-wrapped codex
  parameter shape.** Adopted — one rule, now in §4.7: parameters are always
  explicit, and a scode-wrapped session carries the bypass pair
  (`sandbox: "danger-full-access"`, `approvalPolicy: "never"`) at every
  level — the same pair `run` passes as
  `--dangerously-bypass-approvals-and-sandbox` — while the `--auto` mapping
  pair applies only to the unsandboxed high-only shape (which resolves to the
  same pair anyway). The step-6 grammar test expects the pair that matches
  the launch shape.
- **F5 (major; codex C18, claude CL6): codex mid-turn user messages — queue
  API vs `turn/start` contradiction.** Adopted — codemux-side FIFO per
  session: a `user` input during an active turn is accepted and queued;
  `turn/start` is issued from the queue on `turn/completed`. Harness
  transport ordering is codemux's; user fairness, priority, and scheduling
  stay with the broker (§5 amended to say so). Reported as
  `user_during_turn: "queue"`.
- **F6 (major; claude CL9, codex via C5): unrecognized harness-initiated
  requests hang the turn.** Adopted for codex — every server→client request
  beyond the three approval methods is answered immediately (the `-32601`
  answer or a decline, keyed to its wire id), mirrored raw as an
  `unknown` event with a non-fatal `error` event beside it (the `error`
  itself carries `raw: null`), and never treated as approved. §4.7.
  Review live10 narrowed this entry from "every harness" to what shipped,
  on the reasoning that a claude-family `control_request` other than
  `can_use_tool` waits on no reply. Review live18 found that reasoning
  wrong: the harness blocks on any control request until it is answered.
  The claude family now answers every other subtype with the control
  protocol's `subtype: "error"` response keyed to its `request_id`, with
  the same `unknown` mirror and non-fatal `error`, so F6 holds for every
  shipped harness again.
- **F7 (minor; claude CL31): outgoing codex JSON-RPC method allowlist.**
  Adopted — codemux sends only `initialize`, `notifications/initialized`,
  `thread/start`, `thread/resume`, `turn/start`, `turn/steer`,
  `turn/interrupt`. Never `fs/*`, `remoteControl/*`, `thread/realtime/*`,
  `turn/settings/update`, `command/*`, `process/*`. Pinned by a grammar
  test. §4.7.
- **F8 (minor; zai Z12, codex C5): `raw` fidelity.** Adopted — `raw` is the
  harness's **original line as a string** (minus the trailing newline), not a
  re-encoded object: key order, duplicate keys, and framing survive for the
  broker's archive. `null` on codemux-originated events. §4.2.
- **F9 (major; codex C5): input correlation, author echoes, unmapped
  carriers.** Adopted — every non-blank stdin line is answered with
  `input_accepted`/`input_rejected` carrying `input_seq` (codemux-assigned,
  monotonic; a blank line is skipped unanswered); `user`/`steer` produce a `user_message` echo event carrying
  `text`, `author`, `input_seq`; unmapped harness events ride the `unknown`
  type (F1). §4.1–4.2.
- **F10 (minor; claude CL12): claude `--resume` accepts search terms.**
  Adopted — claude session ids are validated as UUIDs (`--session-id <uuid>`
  per help) and codex thread ids against `^[A-Za-z0-9_-]{8,128}$` (tightened
  from the step-0 fixture if it is narrower); anything else is refused with
  exit 64 before the value reaches argv. §4.5.
- **F11 (minor; claude CL32): app-server carriers for codex hardening
  flags.** Adopted — the effort override rides `turn/start`'s `effort`
  (verified shape [OSS]). `--ignore-rules` has NO verified carrier: the
  thread-level `config` object codemux sends carries only the project-doc
  overrides (`project_doc_max_bytes: 0`, empty fallback filenames) that
  skip AGENTS.md discovery — execpolicy rules (`~/.codex/rules`) still
  load where a run's `--ignore-rules` would skip them, the parity gap the
  compatibility ledger records (review live3; restated here by review
  live10). No `--tools` value has a verified session carrier either, so
  sessions **refuse `--tools` outright** (any value, every agent, exit 64)
  rather than guess one. §4.5.

### Permissions and the autonomy ceiling

- **F12 (blocker; codex B2, claude CL4): ceiling overclaims.** Adopted —
  see B2. §4.1/§4.3 now say the ceiling bounds the permission channel;
  scode is the enforced boundary below high.
- **F13 (major; claude CL3): pre-hardening builds make the approved
  low→high resume an escalation.** Adopted, two parts — §4.3: sessions carry
  their own claude-family version floor at **2.1.280**, the audited build
  (help + strings + step-0 probes); the run-path contract (2.1.220/2.1.223)
  is untouched. And session high emits `--permission-mode default` plus the
  grant list, **never `--dangerously-skip-permissions`**: high's reach is
  set by codemux's grants, not by a harness side effect, so the ladder's
  low→high move narrows reach on every build the floor admits. Codex
  sessions floor at **0.159.3** (app-server method table), agy at 1.2.14.
  `CODEMUX_ALLOW_UNTESTED_HARNESS=1` overrides, as everywhere.
- **F14 (major; claude CL5): the read-only/high predicate does not classify
  the real tool set.** Adopted — the ceiling is a pure table-driven module
  (`src/session/ceiling.ts`): an explicit tool × level → allow-able table
  covering the built-ins the init `system` message names (Read/Grep/Glob …
  unlisted read tools are allow-able only where the level grants anything;
  WebFetch, WebSearch, Task/Agent, Skill, SlashCommand, ExitPlanMode,
  TodoWrite, BashOutput/KillShell, `mcp__*` explicit) with **default deny for
  unknown tools**; a test diffs the table against the recorded init tools
  fixture. read-only: nothing allow-able (deny all). medium: the three
  editing tools on paths inside the launch-directory scope. high: the grant
  list (Edit/Write/NotebookEdit/Bash). low: everything — except that a
  tool with a known argument schema (Edit, Write, NotebookEdit, Bash)
  carrying a key outside it still denies (the schema check runs before
  low's fast path; corrected live6); schema-less tools such as Read,
  WebFetch, Task, and `mcp__*` accept any arguments (review live23). §4.1.
- **F15 (major; claude CL29, zai Z9): the medium path predicate must reuse
  `grantRule`.** Adopted — the ceiling calls the same `grantRule`
  canonicalization (`src/claude-autonomy.ts`: realpath, NFC, grammar
  refusals); argument keys named per tool (`file_path`, `notebook_path`);
  a path resolving outside the scope through a symlink denies; an
  `updated_input` carrying keys outside the tool's known schema denies.
  §4.1.
- **F16 (major; claude CL30): outgoing control responses must be a strict
  schema.** Adopted — the `control_response` codemux writes is built from
  scratch (`behavior`, `updatedInput`, `message`); no caller field is copied
  through, so `updatedPermissions`-style payloads targeting
  `userSettings`/`localSettings` cannot ride. §4.1.
- **F17 (major; codex C2, claude CL7, zai Z14): pending permission requests
  on timeout/interrupt/shutdown were undefined; Prompt B requires
  configurable deny-on-timeout.** Adopted — `--permission-timeout <s>`
  (default 300, 1..86400): expiry answers the harness deny and emits
  `permission_resolved` (`timeout`). Interrupt, `--turn-timeout`, and every
  shutdown path answer all pending requests deny first
  (`permission_resolved: "superseded"`). Late or duplicate decisions get
  `input_rejected` (`unknown_request`). Pending requests are a set, not one
  slot (parallel tool calls). §4.1–4.2, §4.5.
- **F18 (major; codex C6): "impossible by construction" proved argv, not
  policy.** Adopted — the claim is replaced by the mechanism (grants
  re-derived from the resume invocation's flags alone) plus a behavioral
  test: a created-high session resumed read-only enforces read-only's
  ceiling in the fixture-driven fake (the step-0 probes did not run this
  scenario; the fake is the pinned evidence). §4.7.

### Lifecycle and the session runner

- **F19 (major; zai Z2/claude CL23, codex C15): step 1 was several thousand
  lines across six concerns.** Adopted — split (amended plan): streaming
  process runner, protocol core, ceiling predicate, registry, claude driver
  + CLI, codex driver, zai/agy, docs. Each is one reviewable commit with its
  tests.
- **F20 (major; claude CL10, zai Z15, codex C15): the session runner must
  reuse the launch seams; no adapter state.** Adopted — a `SessionRequest`
  type; a session runner that is a peer spawn path (incremental stdin, no
  cumulative capture cap, its own signal/grace semantics, `run`'s path
  untouched) but reuses, verbatim: `assertNoProjectScodePolicy`,
  `resolveScodeExecutable`/`assertCompatibleScode`, `resolveTrustedCommand`,
  `buildScodeCommand`/`buildSandboxEnv`, `buildExecutionEnv`/
  `sanitizeEnvironment`, `beforeLaunch`, `prepareSandbox`, and
  `assertHarnessSupported` with the session floors. All live state (child
  handle, FSM, pending-request set, seq counters, registry handle) lives in
  a launcher-owned `SessionContext`; adapters gain nothing — session
  command builders live in `src/session/` as pure functions over the
  request. A parity test asserts the session child's scode argv prefix and
  environment match `run`'s for the same request. §4.7.
- **F21 (major; codex C11): descendant cleanup.** Adopted — the session
  runner captures descendants before shutdown and unconditionally
  SIGKILLs the tree after the grace period on every end path (EOF, signal,
  timeout, crash, output-pipe failure), reusing `src/process-tree.ts`. No
  `process.exit` inside signal handlers: the handler runs the shutdown path
  and the process exits 143 at the end of it. §4.6.
- **F22 (major; codex C3): agy has no interrupt, so `--turn-timeout` cannot
  interrupt-and-continue.** Adopted — `--turn-timeout` is refused at start
  (exit 64) for agents whose `interrupt` capability is false; `--timeout`
  (whole-session kill) remains available everywhere. §4.5.
- **F23 (minor; zai Z7): capability-false inputs undefined.** Adopted —
  `steer` with `steer: false` → `input_rejected` (`unsupported`);
  `interrupt` with `interrupt: false` → `input_rejected` (`unsupported`);
  `user` during a turn with `user_during_turn: false` → `input_rejected`
  (`busy`). Nothing is silently ignored (Prompt B). §4.1.
- **F24 (minor; zai Z10): credential mirror staleness mid-session.**
  Adopted — documented: a mid-session auth failure is a session-ending
  (resumable) `error`; no refresh hook in v1. §4.6.
- **F25 (minor; zai Z11): `--timeout` bounds.** Adopted — 1..86400 s like
  `run`; sessions default to no timeout. §4.5.
- **F26 (minor; claude CL20): hermetic on sessions rides an unverified
  mechanism.** Adopted — v1 **refuses `--hermetic` on every session**
  (exit 64): the verified canary covers the run path, not stream-json input
  with persistence and resume. The registry keeps the `hermetic` field and
  its match rule so enabling it later (after a session-path canary) changes
  one refusal, not the schema. §4.5.

### Registry and resume

- **F27 (major; codex C14, claude CL22, zai Z4): `--resume` shipped two
  steps before its guards.** Adopted — the amended plan lands the registry
  and every resume refusal before any `--resume` is reachable; until then
  the flag fails closed (exit 64, "resume arrives with the registry").
- **F28 (major; claude CL11/CL-plan, codex C19, zai Z8): concurrent
  resume/attach.** Adopted — the registry records a live owner
  (`owner_pid`, `owner_start`, the opaque process-start token); resuming a
  session whose owner is alive
  is refused with exit 78 (`session_busy`). A resumed claude session
  continues under the same `session_id`; the registry keeps one entry,
  updated in place. §4.8.
- **F29 (major; claude CL1/zai Z16, codex C-major): the writable-set premise
  was false.** Adopted — rule 2's check is the union codemux can compute
  (the cwd and the harness home; sessions expose no `--add-dir`, so
  those two are the whole union — corrected live6) and refuses (exit 64) when
  the registry path falls inside it. codemux does not pretend to know
  scode's deny presets: step 0 runs a free in-sandbox write probe against
  the registry directory and §3 records the fact it measures. Low and high
  sandboxed children (and any unsandboxed process) remain registry writers
  — the same re-derivation residual §4.8 already accepts, now stated
  plainly instead of over-claimed. §4.8.
- **F30 (major; codex C8): symlinked or writable ancestors redirect registry
  reads/writes.** Adopted — the registry directory is created by codemux
  (0700) and every open lstats: the file must be a regular file owned by
  the invoking user, mode 0600, never a symlink; the directory must not be
  a symlink; the atomic replacement revalidates the directory between
  temp-write and rename. §4.8.
- **F31 (major; codex C9): harness-reported ids must be validated.**
  Adopted — the id claude reports in its init message must equal the
  `--session-id` codemux generated (mismatch is tier-2 fatal); codex
  `thread/started` must arrive exactly once and every turn/item/permission
  event must reference the known thread (and turn, once opened), else
  tier-2 fatal. (Amended review live11: on a resumed thread the server
  sends no `thread/started` at all — the id is adopted from the
  `thread/resume` response — so exactly-once governs sightings, and a
  late `thread/started` on an already-started session is tier-1
  passthrough when it is the first sighting and names the adopted
  thread; a second sighting or another thread's id stays a tier-2
  fatal — corrected review live19, which found "never a fatal" too
  broad.) This is the old wrong-session defect,
  closed at the
  boundary. §4.2.
- **F32 (major; codex C16-plan, claude CL18): registry mechanics tests.**
  Adopted — lock expiry while a writer lives, crash recovery during
  replacement (temp file swept, registry intact), a byte bound on the file,
  registration-write failure (refuses the session, nothing started),
  pruning that never evicts a live owner, staleness judged by pid **plus
  process start time** (pid reuse). The writer lock (seconds, per write)
  is separate from session ownership (entry fields, session lifetime).
  §4.8.
- **F33 (minor; claude CL17): `$XDG_STATE_HOME` movement hides the record.**
  Adopted — the Linux registry path derives from `$HOME` alone
  (`$HOME/.local/state/codemux/live-sessions.json`); XDG_STATE_HOME is
  deliberately ignored (round 19 finding 8). macOS keeps
  `~/Library/Application Support/codemux/live-sessions.json`. §4.8.
- **F34 (minor; claude CL13): harness-side resume failure exit code.**
  Adopted — exit 66 is registry-lookup only; a harness-side resume failure
  is exit 1 with the raw event attached; codemux never scans harness stderr
  text. §4.6.
- **F35 (minor; claude CL19): "the one downward move" wording.** Adopted —
  reworded to "the one downward move this design calls out". §4.8.

### Usage and events

- **F36 (major; claude CL8, codex C4): usage double-counting.** Adopted —
  claude-family: turn usage comes from the turn's `result` event only, and
  `message.usage` on `assistant` frames is never read — there is no dedupe.
  The wire sends one content block per frame under a shared `message.id`,
  so sibling frames are content, not repetitions, and a dedupe by id would
  drop real blocks (the live2 review removed the dedupe the first draft
  shipped; review live3 removed this stale description of it). codex: `thread/tokenUsage/updated`
  carries `{total, last}` ([OSS]); each notification's `last` delta is
  its own `usage` event with `raw` preserved, and the deltas fold into
  `turn_completed.usage` (first delta replaces, later ones add). Session
  cumulative is the running sum of completed turns with keep-semantics —
  a field one turn leaves null never wipes what earlier turns reported
  (review live4), except the derived `total_tokens`, which is null once
  a folded turn leaves a token part unreported (review live15) — with cost the one exception the wire forces: the only
  cost carrier (the claude-family result's `total_cost_usd`) reports a
  session-lifetime figure each turn, so the cumulative adopts the latest
  figure instead of summing (review live8). For the same reason the
  per-turn `turn_completed.usage.cost_usd` is null on the claude family
  (review live10): a session-lifetime figure does not describe one turn.
  Resume changes nothing:
  there is no in-process baseline to subtract. §4.2.
- **F37 (minor; claude CL24): capabilities must exist from the first
  session-capable commit.** Adopted — capability flags ship with the
  claude driver (plan step 6) and the per-agent matrix test lands with each
  driver.

### Plan, deliverables, scope

- **F38 (major; claude CL21, zai Z3, codex C12): probes before parsers.**
  Adopted — step 0 runs every probe through `./bin/codemux --no-sandbox
  --auto high` (scode cannot nest in the implementing sandbox), records
  sanitized fixtures, and amends §3 with confirmed shapes. Probes that
  cannot run (quota under 10%, sandbox limits) are recorded as not-run;
  their `[verify]` tags stay open and the parsers still fail closed.
- **F39 (minor; codex C17): CHANGELOG, baseline test counts,
  `make release-gate`, paid probes separately budgeted.** Adopted —
  Prompt B's reporting requirements are in the plan's every step.
- **F40 (minor; claude CL27): move the `[author]` prefix to the broker.**
  Not adopted — the design's argument stands (attribution should survive
  into the transcript the harness persists; the broker's archive is not
  the only record), §4.4 is owner-approved as written, and the prefix is
  disableable (`--no-author-prefix`). The echoed event stream remains the
  authoritative attribution either way.
- **F41 (minor; claude CL28 vs zai scope note): `--turn-timeout` in the
  broker.** Not adopted — zai's counterargument is right: only codemux
  holds the interrupt channel, and the broker may be dead. Kept, with
  F22's refusal for interrupt-less agents.
- **F42 (minor; zai Z19): the `--event-log` tee.** Adopted — dropped from
  §5's open questions; any tee is the broker reading the stream it already
  receives.
- **F43 (minor; zai Z13): step 4's agy conditional contradicted §10.**
  Adopted — agy ships in v1, unconditional (honest `false` capability
  flags).
- **F44 (minor; zai Z17): symlink traversal from a writable cwd is inside
  the residual.** Adopted — one sentence in §4.8 saying so, instead of
  leaving round 3's class half-documented.

## 3. Amended implementation plan

Ordered by risk; each step is one reviewable commit ending green on the full
gate (`bun run typecheck`, `bun test --max-concurrency=1`,
`make release-gate`), with the tests and fixtures named. No feature flag;
the step gates carry it. Every step records its intended commit in
`docs/live-sessions-report.md`.

**Step 0 — evidence first.** `usagemux snapshot` before anything paid. Free
probes: scode stdio relay (bidirectional, long-lived) where the sandbox
allows it; the registry-directory write probe under `scode --rw`; version
and help surfaces. Paid probes (budget ≈ 8 small claude requests, ≈ 4 codex,
≈ 2 agy; stop on any client under 10%): (1) stream-json without `--verbose`;
(2) init `system` message — session id, tools list; (3) mid-turn message
delivery; (4) interrupt control-request shape; (5) permission round-trip at
`--auto low`; (6) scode-wrapped session stdio (if the sandbox refuses, record
and keep the risk flagged); (7) shutdown and `--resume`; (8) codex
app-server `initialize → thread/start → turn/start → item/* →
turn/completed` exchange with `CODEX_HOME` relocated, daemon isolation
checked, `thread/tokenUsage/updated` shapes; (9) a second codex turn to pin
`total` vs `last`; (10) agy two-turn NDJSON exchange and `--conversation`.
Sanitized fixtures under `tests/fixtures/live/`; §3 of the design amended
with what they show. Fake harnesses are generated from the fixtures.

**Step 1 — streaming session process runner** (`src/session/process.ts`).
Process group; line framing both directions with the F2 caps; fatal UTF-8;
bounded outbound queue; descendant capture and unconditional tree kill
after grace on every end path; signal handling that runs the shutdown path
and exits 143 at its end (no `process.exit` in the handler). Tests against
a fake child: caps, invalid UTF-8, partial last line, stopped reader
(backpressure), SIGTERM mid-stream, descendant cleanup.

**Step 2 — protocol core** (`src/session/protocol.ts`, `src/session/fsm.ts`).
Input validation (types, author allowlist — Unicode categories Cc/Cf/Zl/Zp
rejected, 64 code points, no brackets — text bounds, NUL), `input_seq`
acks, capability-false rejections (F23), the output envelope (`seq`, `ts`,
`session_id`, `type`, `raw` as string), the FSM (starting → idle ⇄
turn_active → shutting_down → ended; pending requests as a set), the
`unknown` tiering (F1). Unit tests for every edge.

**Step 3 — autonomy ceiling** (`src/session/ceiling.ts`). The tool × level
table (F14), `grantRule` reuse and path canonicalization (F15),
`updated_input` merge rules, codex command/patch predicates, default-deny
for unknown tools and opaque arguments. Pure and table-driven; exhaustive
unit tests including every F14/F15 case and the table-vs-fixture diff.

**Step 4 — session registry** (`src/session/registry.ts`). Everything in
§4.8 as amended: HOME-derived Linux path, creation modes, symlink and
ancestor checks (F30), atomic replacement with revalidation, writer lock
(pid + start token; staleness is liveness, not age — the shipped wait
budget is 250 ms × 40 attempts, corrected live6), live owner
(F28), pruning that spares live owners, 1000-entry bound, fail-closed
corrupt handling with backup. `--resume` still refused everywhere (F27).
Tests: every refusal rule, concurrent writers, crash recovery, byte bound,
registration failure, tamper cases (round 4's cross-entry rewrite pinned
to the re-derivation claim), placement refusals.

**Step 5 — claude session driver + `codemux session` CLI**
(`src/session/claude-session.ts`, `src/session/cli.ts`, index wiring).
`buildClaudeSessionCommand` (fresh and resume shapes; resume id first,
autonomy flags unconditional; no `--no-session-persistence`;
`--permission-prompt-tool stdio` (the probe-disproven `host` form is
recorded in §4.7), `--replay-user-messages`,
`--include-partial-messages`; session high = `--permission-mode default` +
grants, never the bypass flag; session floor 2.1.280 via
`assertHarnessSupported`); stream-json parsers for the seven types with
the F1 tiers and F31 id checks; the control-response writer (strict
schema, F16) enforcing the ceiling; permission timeouts (F17); usage
per F36; author prefix per §4.4. The CLI takes run-parity flags plus
session-only ones, builds a `SessionRequest`, reuses every F20 seam, and
keeps all state in the launcher-owned context; a parity test asserts the
argv prefix and environment match `run`'s. e2e tests against the
fixture-generated fake harness: full lifecycle, steering, interrupt,
permission allow/deny/timeout/updated_input both directions, EOF/shutdown/
signal paths, resume command-line assert (created-high resumed read-only
emits exactly read-only's flags), session floor refusal, `--resume`
fail-closed. `session_started` carries capabilities from here (F37).
Registry integration: record at start, update at end, live owner.

**Step 6 — codex app-server driver** (`src/session/codex-session.ts`).
Hand-rolled JSON-RPC client over the step-1 runner (no new dependencies);
`initialize` handshake; `thread/start`/`thread/resume` with explicit
`sandbox`/`approvalPolicy`/`config`/`model`, `turn/start` with
`sandboxPolicy` where the shape requires it — the bypass pair on
scode-wrapped sessions (F4) — on every start, resume included; the FIFO
queue (F5); `turn/steer`, `turn/interrupt`; notification translation with
`raw`; approval round-trips under the same ceiling (dormant in production,
fake-driven in tests); unknown server requests answered with errors (F6);
outgoing method allowlist (F7); id validation (F31); usage per F36;
`--tools` (any value) and `--hermetic` refused (F11/F26). Tests: fake app-server
from fixtures; grammar tests for the notification set and ordering;
malformed-JSON robustness (including openclaw's raw-newline quirk:
fragments of an unterminated string are rejoined before parsing, bounded);
approval timeouts; the ceiling on approval responses; the parameter
grammar on every thread and turn start.

**Step 7 — zai driver** (`src/session/zai-session.ts` reuse of the
claude-family path). Shared-home guard via the registry's agent match;
beforeLaunch's API-key check; the same floor and parser. Tests: the
shared-home cross-agent refusal, capability matrix pinned.

**Step 8 — agy driver** (`src/session/agy-session.ts`). NDJSON input loop
(`--input-format=stream-json --output-format=stream-json`, the `=`-form
agy 1.2.14 requires; `--conversation=<id>` resume), honest false flags (`steer`, `interrupt`,
`user_during_turn`, `permissions`, `deltas`), `--turn-timeout` refused
(F22), output parsed under the same tiers. Tests: fake agy from fixtures,
two-turn exchange, resume, capability matrix.

**Step 9 — docs and contracts.** README sessions section;
`docs/HARNESS-COMPATIBILITY.md` capability table + app-server method table
pinned at 0.159.3 + claude stream-json contract at 2.1.280;
`docs/HERMETIC.md` "Session persistence" rewritten around the registry and
the refused-until-canary hermetic sessions; CHANGELOG under
`[Unreleased]`; this document and the design already amended. Optional (if
budget remains): a `codemux check` live-session probe.

Deviation from the approved §7: the step order changed (registry before any
driver exposes `--resume`; probes pulled ahead of the parsers; step 1
split three ways). The owner's §10 decisions are untouched; §7 is the
plan, and the panels' consensus (all three: codex C12/C14, claude CL21/
CL22/CL23, zai Z2/Z3/Z4) is that this order is the one that never ships a
working unguarded `--resume` and never builds parsers against invented
shapes.
