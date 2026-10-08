# Live sessions D: OpenCode and Aider sessions, overrides inside sessions

Prompt D report, 2026-10-07. Branch `sessions-d-0.10` (cut from main
299066b at version 0.9.0; release prep landed 2026-10-08, so this tree
carries version 0.10.0 and the CHANGELOG entry sits under `[0.10.0]`).
Task text: `scratch/prompt-d.md`; operator request:
`scratch/provider-overrides-2-request.md`.

**Bottom line: all four deliverables are implemented and verified.** `codemux
session` now drives six harnesses (claude, zai, codex, agy, opencode, aider);
provider overrides reach every session-capable harness's spawn through the same
seams `run` uses; the live acceptance (plant/recall across turns against the
local override gateway, including the 12-turn aider compaction check) passed on
every run; `make release-gate` exits 0. Nothing is committed — the tree is
staged with `git add -A`, as asked.

## Deliverables, item by item

1. **OpenCode session driver — done.** `src/session/opencode-session.ts`
   (floor, capabilities, argv) and `src/session/opencode-driver.ts` (wire
   parsing, turn lifecycle). One `opencode --pure run --format json` process
   per caller input over the harness's native session store: a fresh session's
   `ses_…` id is adopted from the first output line (`session_started` waits
   for it; a first turn that exits naming no id ends the session), later turns
   pass `--session <id>`, and `--resume` accepts the native id against the
   registry pattern (`OPENCODE_SESSION_FLOOR = "1.18.18"`,
   src/session/opencode-session.ts:33). Capability flags are honest:
   `live_input` and `resume` true; `user_during_turn`, `steer`, `interrupt`,
   `permissions`, `deltas`, `file_changes` false (a false flag rejects the
   input by name); `usage_stream` false because usage arrives only in each
   turn's `step_finish`. The registry entry and resume guards (same agent,
   same harness home, autonomy no higher, containment no lower) are the ones
   every driver shares; a fresh opencode session pre-checks registry
   writability before the first turn because the id is harness-minted (the agy
   rule).
2. **Aider session driver — done.** `src/session/aider-session.ts` and
   `src/session/aider-driver.ts`. Turn-per-process: each turn spawns one
   `aider --message=<prompt> --restore-chat-history --chat-history-file
   <path>` with canned `n` confirmations on stdin. Codemux mints the identity
   (a UUID) and owns a private per-session directory
   (`~/.aider/.codemux/sessions/<id>/history.md`), recorded in the registry
   before spawn; a resume whose history file is gone fails before any turn
   (`AIDER_SESSION_FLOOR = "0.86.2"`, src/session/aider-session.ts:46). All
   stdout is human transcript (tier-1 `unknown` passthrough); the turn reply
   is the text aider appended after this turn's `#### <prompt>` header, and
   the verdict is the exit code plus the history delta — a clean exit with no
   new exchange fails the turn, a history that shrank below what codemux
   consumed ends the session. Usage stays null (aider reports none
   headlessly).
3. **Overrides inside sessions — done.** Session spawns route through the same
   adapter seams `run` uses (`prepareRun`/`getRunEnv`/`wireModelFor` over
   `readProviderOverride`), so `CODEMUX_<AGENT>_PROVIDER_*` — caps and codex's
   `MULTI_AGENT` knob included — applies to a session's turns identically.
   Harness-specific shapes: an opencode session keeps the real data directory
   under the override and carries the wire model as `codemux/<model>`; a codex
   override session owns a persistent home keyed per session id
   (`~/.codex/.codemux-provider/session-home-<sha256 of the base URL, first 12
   hex>-<thread id>`, `codexSessionProviderHomePath`,
   src/codex-provider.ts:272) so threads survive turns and resumes with no two
   sessions ever sharing a directory; an
   aider session with a cap set is refused before spawn with `run`'s own
   message (src/provider-override.ts:202) because aider 0.86.2 has no
   carrier for either cap. The blanket 0.9.0 refusal (session exit 64 while
   any override variable is set) is gone.
4. **Docs, fixtures, tests, gates — done.** README session rows and override
   paragraphs; `docs/HARNESS-COMPATIBILITY.md` 2026-10-07 addendum (wire
   contracts for both drivers plus the overrides-in-sessions rules);
   `docs/LIVE-SESSIONS-DESIGN.md` §11 addendum; CHANGELOG `[Unreleased]`
   (now `[0.10.0]`, the release this tree carries);
   compatibility-ledger floors opencode 1.18.18 / aider 0.86.2; sanitized
   live fixtures `tests/fixtures/live/opencode-session.ndjson` (27 records)
   and `aider-session.ndjson` (51 records) with README entries; fakes
   (`fake-opencode-run.ts`, `fake-aider-run.ts`) and unit + e2e suites per
   driver (153 tests across the seven session files, all passing); the full
   gate and prose checks below.

## What "state" means for each harness

- **OpenCode:** the harness's native session store, keyed by the `ses_` id.
  Each turn is a fresh `run` process that reopens the store; codemux holds no
  copy of the conversation. The 3-turn run proves the store carries across
  per-turn processes under an override (the data directory is real, only the
  provider is swapped).
- **Aider:** exactly two things — the chat history file codemux owns
  (`~/.aider/.codemux/sessions/<uuid>/history.md`) plus aider's own
  summarization on top of it (ChatSummary, which runs through the weak model;
  under an override the weak model maps to the same endpoint). Codemux keeps
  no second state: the turn reply is read from the history delta, never
  re-derived. When the history grows past `--max-chat-history-tokens`,
  aider's summarizer compacts it — that is the compaction the operator's eval
  protocol exercises, and it is aider's, not codemux's.

## Live acceptance evidence

All runs went through `bin/codemux session` only (no raw harness CLIs), against
the operator's gateway `http://localhost:8011/v1`, model
`clawvm-qwen32b-coder`, through `CODEMUX_{OPENCODE,AIDER}_PROVIDER_*`. The
opencode runs carried the caps (`MAX_OUTPUT_TOKENS=4096`,
`MAX_CONTEXT_TOKENS=32768`); the aider runs could not (see deviations) and
carried base URL, key, and model only. Recordings are dir-tagged NDJSON from
`scratch/probes/record-session.ts`; the probe's meta line records exit code,
turn count, and whether the codename appeared.

| Run | Turns | Exit | Recall evidence |
|-----|-------|------|-----------------|
| opencode 3-turn (`scratch/probes/opencode-session-raw.ndjson`) | 3 | 0 | turn 1 reply `noted`, turn 2 `42`, turn 3 exactly `zephyr-mango-42`; `session_started.model` = `codemux/clawvm-qwen32b-coder` — the override's wire model, proving the session spawn hit the gateway |
| aider 3-turn (`scratch/probes/aider-session-raw.ndjson`) | 3 | 0 | same plant/recall shape (`noted` / `42` / `zephyr-mango-42`) across three turn-per-process exchanges over the history file |
| aider 12-turn compaction check (`scratch/probes/aider-compaction-raw.ndjson`) | 12 | 0 | codename planted in turn 1, ten arithmetic filler turns, probe in turn 12; turn 12's assistant message is exactly `zephyr-mango-42`; 12 `turn_completed` events |

The sanitized fixtures (`tests/fixtures/live/opencode-session.ndjson`,
`aider-session.ndjson`) are the 3-turn recordings after
`scratch/probes/sanitize.ts` (home → `/Users/example`, checkout →
`/Users/example/project`, key-scan assert);
`tests/session-fixtures-privacy.test.ts` passes against them.

## Deviations and environment constraints

1. **The recordings ran `--no-sandbox --auto high` with an isolated HOME.**
   From inside this agent session neither sandboxed combination can run:
   scode 0.5.0 on macOS 27 exits 71 (`sandbox-exec: sandbox_apply: Operation
   not permitted`) for any profile built from an isolated HOME (bisected past
   flag grammar, subpath population, and path spelling — HOME is the sole
   discriminator), and with the real HOME the session registry cannot be
   created because `~/Library` is TCC-denied to the whole agent process tree
   (EPERM on `mkdir ~/Library/Application Support/codemux`; no registry
   override exists). This is the same nesting failure prompt B's report
   documented; the override plumbing itself is exercised through the normal
   launch path, and the sandboxed session shape is covered by the e2e fakes
   and the sandbox-contract gate.
2. **Aider caps are refused by design, so its acceptance ran without them.**
   `CODEMUX_AIDER_PROVIDER_MAX_OUTPUT_TOKENS cannot be honored: aider 0.86.2
   has no max-tokens flag (--max-chat-history-tokens, --thinking-tokens and
   --map-tokens cap other budgets) and codemux writes no aider config` — the
   same refusal `run` gives, firing before spawn. The aider recordings
   therefore carried only the base URL, key, and model. This is the
   documented per-harness cap table (README, ledger), not a gap in the
   session path.
3. **The opencode probe sends turn 1 immediately after spawn.** OpenCode's
   identity is deferred (`session_started` only after the first output line),
   so a caller that waits for the announcement before submitting deadlocks —
   the mirror of the claude-family init-frame rule, and the probe documents
   it (scratch/probes/record-session.ts).
4. **`make contracts` needed `COPILOT_PKG_CACHE_HOME` redirected** (the
   ledger's documented in-session workaround): copilot's loader must extract
   under `~/Library/Caches`, which this process tree cannot write. With
   `COPILOT_PKG_CACHE_HOME=/tmp/codemux-d-copilot-cache` the stage passes.
5. **Raw recordings stay in `scratch/probes/`** (ignored, not staged); only
   the sanitized fixtures are committed. `scratch/opencode-debug.ndjson` is a
   failed debug run kept for the record.

## Gates (run this turn)

- `make release-gate` with `COPILOT_PKG_CACHE_HOME` set: **exit 0**, "Release
  gate passed." (runtime, typecheck, shell, test:coverage, contracts,
  sandbox-contract, smoke, `bun audit`, frozen-lockfile dry-run, help and
  verify invocations).
- `test:coverage`: **1492 pass / 6 skip / 0 fail**, 1498 tests across 58
  files (81.79 s). The first gate run this turn failed one test —
  `tests/session-docs.test.ts:134` pinned the 0.9.0 promise "Overrides reach
  sessions in the next release.", which this branch delivers; the pin now
  refuses the stale promise and asserts the delivered claim (README: "Provider
  overrides reach session spawns exactly as they reach `run`'s"). Total test
  count is unchanged (1498); the same test now passes.
- `contracts`: **3 pass / 0 fail**.
- Session suites for this branch (`session-opencode`, `-opencode-e2e`,
  `-aider`, `-aider-e2e`, `session-cli`, `session-fixtures-privacy`,
  `session-docs`): **153 pass / 0 fail** across 7 files.
- `python3 ~/.claude/skills/humanizer/scripts/check_american.py` on README.md,
  CHANGELOG.md, docs/HARNESS-COMPATIBILITY.md, docs/LIVE-SESSIONS-DESIGN.md,
  tests/fixtures/live/README.md, and this report: **0 hits, exit 0**.

## Reproduction

```
# environment: the operator's override exported for the agent under test
export CODEMUX_OPENCODE_PROVIDER_BASE_URL=http://localhost:8011/v1
export CODEMUX_OPENCODE_PROVIDER_API_KEY=…      # never in argv or prompts
export CODEMUX_OPENCODE_PROVIDER_MODEL=clawvm-qwen32b-coder
export CODEMUX_OPENCODE_PROVIDER_MAX_OUTPUT_TOKENS=4096
export CODEMUX_OPENCODE_PROVIDER_MAX_CONTEXT_TOKENS=32768

# 3-turn plant/recall recording (same shape for aider, without the cap vars)
bun scratch/probes/record-session.ts opencode scratch/probes/opencode-session-raw.ndjson \
  'Remember this codename for the rest of our conversation: zephyr-mango-42. Reply with exactly: noted' \
  'What is 17 + 25? Reply with just the number.' \
  'Which codename did I ask you to remember earlier in this conversation? Reply with exactly the codename and nothing else.'

# 12-turn aider compaction check: the same plant, ten filler turns, the probe last
bun scratch/probes/record-session.ts aider scratch/probes/aider-compaction-raw.ndjson \
  'Remember this codename …' 'What is 2 + 2? …' … 'Which codename did I ask you to remember …'

bun scratch/probes/summarize-session.ts scratch/probes/<recording>.ndjson   # inspect
bun scratch/probes/sanitize.ts scratch/probes/<raw>.ndjson <agent> tests/fixtures/live/<agent>-session.ndjson
```

## Files

New: `src/session/{opencode-driver,opencode-session,aider-driver,
aider-session}.ts`, `tests/session-{opencode,opencode-e2e,aider,
aider-e2e}.test.ts`, `tests/fixtures/live/{fake-opencode-run,fake-aider-run}.ts`,
`tests/fixtures/live/{opencode,aider}-session.ndjson`, this report, and the
probe scripts under `scratch/probes/`. Modified: README.md, CHANGELOG.md,
docs/HARNESS-COMPATIBILITY.md, docs/LIVE-SESSIONS-DESIGN.md,
tests/fixtures/live/README.md, tests/session-cli.test.ts,
src/session/{cli,process,registry,codex-driver,codex-session}.ts,
src/{provider-override,codex-provider,aider-history}.ts,
src/adapters/{aider,opencode}.ts, tests/fixtures/live/fake-codex-app-server.ts
(the session-spawn seams the two drivers and the override share).
`tests/session-docs.test.ts` is updated for the delivered override claim
above. Finished with `git add -A`; no commit, per the task. One exclusion:
`undefined/` (an untracked directory of bun cache droppings a gate-run spawn
created at the repo root when some environment variable resolved to the
string "undefined") is left unstaged and undeleted pending the operator's
call — `git add -A -- . ':(exclude)undefined/'`.

## Review fixes, round 1

Every finding of `scratch/review-d1-findings.md` (prompt D, round 1) is
fixed — blocker through minor — with the smallest correct change and one
regression test each, plus the two same-class audits the task named.

**Finding 3 (blocker, multi-line prompts leaked into the reply).** The
driver now anchors on the exact history block aider writes for the turn's
prompt, not on a `#### ` search. `aiderHistoryHeader`
(src/aider-history.ts:210) builds the block byte-exactly from io.py
0.86.2 (`io.user_input` + `append_chat_history`): `#### ` before EVERY
line, joined on two-space lines, rstripped, closed with two spaces —
including Python `str.splitlines` parity (\r, \v, \f, \x1c-\x1e, \x85,
U+2028/U+2029) and the `<blank>` line for an empty prompt.
`completeTurn` (src/session/aider-driver.ts:497) finds the block's first
occurrence in the delta (only the per-process banner precedes it) and
takes the reply past it; the old `#### ` search survives only as the
fallback for a harness that writes the prompt back altered — the one
path where continuation lines could leak, now unreachable for real
aider. The fake (`tests/fixtures/live/fake-aider-run.ts`) was rewritten
to the real wire format — banner at every process start, the same user
block construction — deliberately NOT importing the builder, so fixture
and driver are two independent renderings of the pinned source; the
existing multi-line e2e (tests/session-aider-e2e.test.ts) now exercises
the real format, and byte pins of the header itself live in
tests/aider-history.test.ts (4 tests).

**Finding 1 (security, write-through-symlink and cross-session carryover
in the codex override session home).** The session home is now keyed per
session id — `session-home-<sha256(baseUrl) first 12>-<thread id>`
(`codexSessionProviderHomePath`, src/codex-provider.ts:272) — so two
sessions on one endpoint (or one id across two endpoints) never share a
directory: codemux never runs one session in another session's home.
That is a naming rule, not an access boundary (stated exactly since
review D5, security): the homes share one parent under `~/.codex` that
every sandboxed codex child can write, so one session's child can plant
files (`rules/`, `AGENTS.md`, hooks) in another session's home — the
same trust the operator's real `~/.codex` always carried; what codemux
vouches for is that each launch rewrites its home's `config.toml`
atomically before anything spawns. A fresh session starts on a
run-shaped `run-<pid>-<random>` directory in the same parent and is
renamed onto its key at an orderly resumable end (`createCodexSessionProviderHome`,
src/codex-provider.ts:341); a resume opens the keyed path
(`openCodexSessionProviderHome`, src/codex-provider.ts:399) and rewrites
the config. Every config write is atomic (`writeCodexProviderConfigInto`,
src/codex-provider.ts:179): temp file under an unguessable name with
`flag: "wx"` (O_EXCL refuses any existing entry, a symlink included),
then `rename` — a symlink the child planted at `config.toml` is swapped
out, never followed. (Review D5, correctness 3 moved that rewrite after
the resume claim, so a racing second resume refused `session_busy`
rewrites nothing.) The driver settles the home from its end path
(`settleSessionHome` seam, src/session/codex-driver.ts:1953) and records
the keyed path in the registry from the moment the id exists
(`harnessHomeFor`, src/session/codex-driver.ts:2034); the CLI wires both
(src/session/cli.ts:812, 959, 967) and abandons the home when the spawn
throws (src/session/cli.ts:1138). Non-resumable ends and never-adopted
ids remove the home; a codemux that dies mid-session leaves the
run-shaped name to the existing stale-run sweep and the keyed one to a
new age-gated sweep (28 days, the age aider's session directories use —
`STALE_SESSION_HOME_MS`, src/hermetic-home.ts:138). Regression tests:
tests/codex-provider.test.ts (6 tests: symlink canary, lifecycle
settle/abandon both shapes, cross-session isolation, sweep) and the
rewritten override-session describe in tests/session-cli.test.ts (3
tests: live run-shaped home + keyed settle, resume e2e reopening the key
with a rewritten config inode, no-id session leaves nothing).

**Finding 2.1 (registry comment claimed strictly additive flags).** The
comment now states the truth (src/session/registry.ts:129-147): each
ladder has one adjacent tie (opencode low==medium `--agent build`,
aider medium==high `--yes-always`), and strict ranking stays because a
refusal of a byte-identical resume costs nothing while no folded ranking
could bound the command. Regression test: tests/session-registry.test.ts
pins the tie flags AND the refused upward resume.

**Finding 2.2 (fixtures README claimed per-turn `step_finish` usage).**
The opencode entry now says no `step_finish` line arrived in the
recording (verified: 0 in the fixture) so all usage blocks are null, and
that the driver folds `step_finish` into `turn_completed.usage` had any
arrived (tests/fixtures/live/README.md:68-73). Pinned in
tests/session-docs.test.ts.

**Finding 2.3 (runLike comment claimed the placeholder carries the argv
prompt bound).** The comment now says the placeholder's prompt is a
constant, never a turn's text, so that one rule is enforced per turn at
the driver — aider's `text_too_long` check before the ack
(src/session/cli.ts:638-641). Pinned in tests/session-docs.test.ts.

**Same-class audits.** Every write into a directory the sandboxed child
can also write: the codex run path, hermetic homes, opencode/droid/pi
provider configs, kimi's no-tools agent file, and aider's run-path
history file all write into a fresh, unguessably named, pre-spawn
directory (or already use `wx` + rename — the credentials mirror); none
persists across sessions, so none offers the plant-then-rewrite window
the finding used. Aider is the only driver that splits caller text into
lines for the wire (opencode's prompt rides stdin whole; codex and the
claude family ride JSON), and its split is now Python-parity exact.

**Live acceptance kept true.** The aider reply-extraction path is
wire-visible, so the 3-turn plant/recall was re-run against
localhost:8011 (`clawvm-qwen32b-coder`):
`probe: exit 0, 3 turns, recall=true` — replies exactly `noted`, `42`,
`zephyr-mango-42`, all turns `end`, clean shutdown. The opencode change
is comment-only; no re-run needed.

**Gates.** `bun x tsc --noEmit` clean. `make release-gate` exit 0:
1509 pass / 0 fail / 6 skip (1515 tests, 59 files) plus the contracts
stage 3 pass / 0 fail (cursor aliases skipped: no login on this machine).
The round's target was 1496/0/2; this branch started the round at
1492/0/6 (the four extra skips are environmental and pre-date this
round), and this round adds 17 tests — 6 codex-provider, 2 net
session-cli (3 replacing 1), 4 aider-history pins, 1 registry, 4 docs
pins — all passing. `check_american.py` over the changed prose: clean.
Docs updated to the new home shape: README.md, CHANGELOG.md,
docs/HARNESS-COMPATIBILITY.md, docs/LIVE-SESSIONS-DESIGN.md §11, with
tests/session-docs.test.ts refusing the per-endpoint wording.

**Deviations from the operator note (both conservative).** "Removed at
session end" is implemented as removed at any NON-RESUMABLE end: a
resumable end keeps the home because it IS the resume state (codex
threads live in CODEX_HOME; deleting it would break the same note's
"survives across turns of ONE session" for the resume chain, which is
one session id). Second, the sweep for keyed homes is age-gated (28
days) rather than pid-gated like run dirs: a closed session has no live
owner pid, so age is the only sound gate, and 28 days matches aider's
own session-directory sweep (src/session/aider-session.ts:149).

## Review fixes, round 2

Every finding of `scratch/review-d2-findings.md` (prompt D, round 2) is
fixed — blocker through minor — with the smallest correct change and one
regression test each, plus the two same-class audits (consolidated to
eight: S1, S2-aider, S2-codex, K1, K2, K3, C2, C3).

**S1 (security, the project-config guard ran once per session).** Both
new agents are turn-per-process: turn N's sandboxed child can write the
very `opencode.json` or `.aider.model.settings.yml` turn N+1's process
reloads, and a guard that ran only at start left that window open for
the session's whole life. `spawnTurn` now re-runs
`adapter.validateRunRequest(runLike)` before EVERY turn it spawns
(src/session/cli.ts:925, with the reasoning at 914-920): a trip rides
the drivers' spawn-failure path — a fatal codemux error naming the
guard's refusal inside `could not spawn the <agent> turn process`, end
code 1. Regression: tests/session-cli.test.ts, "a project config
written between turns stops the next turn before it spawns" — turn 1
completes, `opencode.json` is planted, turn 2 ends the session with the
refusal named, and the fake's argv log shows exactly one process spawn.

**S2 (two auditors, sweeps deleted live sessions on paper).** Aider
only APPENDS to `history.md` in place, so the session directory's own
mtime never moves after creation — every live session's directory hit
28 days old and the sweep removed it mid-conversation. The sweep now
ages by the history file's mtime, falling back to the directory's own
for crash leftovers with no file (`sessionDirAgeMs`,
src/session/aider-session.ts:215, used by `sweepStaleSessionDirs`
at 231), and never touches an id the registry holds live:
`sessionHeldLive` (src/session/registry.ts:658 — an OPEN record whose
owner identity is alive), passed by the driver when a registry exists.
Codex had the same blind spot: the `STALE_SESSION_HOME_MS` comment
claimed "the harness writes its thread state on every turn," but codex
writes under SUBDIRECTORIES, which never move the home's top mtime.
Both that sweep and the same-class stale-run-dir sweep now age by the
NEWEST mtime anywhere in the tree (`newestMtimeMs`,
src/hermetic-home.ts:148, an lstat-only walk — a planted symlink can
make a tree look fresher, which keeps it, the safe direction, but can
never aim the probe outside it). Regressions: tests/session-aider.test.ts
(history-file aging; a directory aged by mtime alone survives while its
file is fresh; a registry-held id is never swept however stale; a
crash leftover ages by its own mtime), tests/session-registry.test.ts
(`sessionHeldLive` truth table), and tests/codex-provider.test.ts (a
29-day-old top directory with yesterday's write under `sessions/`
survives; the same shape on a dead-pid run dir survives the 2-day gate;
a fully idle home still goes).

**K1 (contracts, opencode usage read from the wrong wire level).** The
pinned 1.18.18 `run --format json` emitter spreads its payload beside
the envelope, so a `step_finish` line is
`{type, timestamp, sessionID, part}` — the tokens and cost ride INSIDE
`part`. The parser read them off the line's top level, so every real
turn reported all-null usage, and the fake encoded the defect (the
recorded fixture has no `step_finish` lines, which is why nothing
caught it). The parser now reads `event.part` and a `step_finish`
without one is a grammar error (src/session/opencode-session.ts:269;
the check at 258-267); the fake emits the real shape. Regressions:
tests/session-opencode.test.ts (the part-level pin, and "a
step_finish line whose tokens sit at the top level is a grammar error,
not null usage"). Live-proven below — the re-run recording parses real
usage where the round-1 recording parsed nulls.

**K2 (contracts, the cost fold contradicted its own ledger).** The
ledger said the cost is a session-lifetime figure codemux adopts, the
driver summed it, and both were wrong: the binary runs
`assistantMessage.cost += step.cost`, so each part's cost is that
step's OWN. Turn = sum of steps, session = sum of turns — `addUsage`
at all three fold sites (src/session/opencode-driver.ts:446, 478, 706);
`addTurnUsage` (adopt-latest) remains the claude family's rule for
`total_cost_usd` alone. docs/HARNESS-COMPATIBILITY.md, README.md's
matrix cell, the fixture README note, and the e2e pin (session_ended
cost 0.02 = two turns x 0.01) all carry the corrected rule;
tests/session-docs.test.ts refuses the old wording verbatim.

**K3 (contracts, report still described the superseded home).** The
deliverable-3 paragraph still described the pre-D1 shape — one home per
endpoint, shared across sessions — and cited a stale line number. It
now names the session-id-keyed home and cites
`codexSessionProviderHomePath` (src/codex-provider.ts:272);
tests/session-docs.test.ts refuses the superseded wording in this
report too.

**C2 (correctness, resumable after a failed settle).** A settle whose
rename could not land still reported `resumable: true`, and
`openCodexSessionProviderHome` re-made the keyed path as an EMPTY home
— the resume then died inside codex with thread-not-found; the same
empty home appeared after any death between record write and settle.
`settle` now returns whether the home ended where a resume finds it
(src/codex-provider.ts:300-307; false on rename failure, on
double-settle, and — reported, not thrown — for removals), the driver
folds it into the reported verdict
(`resumable: resumable && settledHome`, src/session/codex-driver.ts:1975,
with a thrown settle counting as unsettled), and opening a missing or
untrusted keyed home refuses outright instead of silently remaking it
(src/codex-provider.ts:427). Regressions: tests/codex-provider.test.ts —
the settle lifecycle's return values, "a settle whose rename cannot
land returns false" (both directories stay), and "opening a missing
keyed home refuses instead of silently remaking it" (nothing created).

**C3 (correctness, orphaned aider history directory).** A fresh session
created its history directory before writing the start record; a failed
registry write then left the directory orphaned until the 28-day sweep.
`removeFreshHistory` (src/session/aider-driver.ts:213 — a no-op on
resume) delegates to `removeAiderSessionHistory`
(src/session/aider-session.ts:198), which revalidates the sessions
directory's ownership before removing only the fresh session
directory; the CLI calls it on the record-failure path before exiting 1
(src/session/cli.ts:1132). Regression: tests/session-cli.test.ts, "a
failed start record removes the fresh session's history directory" —
exit 1 with the registry refusal, `~/.aider/.codemux/sessions` left
empty.

**Same-class audits.** (a) Every write into a directory the sandboxed
child can also write: the round-1 inventory is unchanged and this
round's additions keep its rules — `removeAiderSessionHistory`
revalidates the parent directory's ownership before any removal and
`rmSync` never follows a link at the final component;
`newestMtimeMs` is lstat-only (above); the keyed-home refusal path
writes nothing; the per-turn guard performs no writes of its own.
(b) Drivers that split caller text into lines: aider remains the only
one (round 1 made its split Python-parity exact and byte-pinned);
opencode's prompt rides stdin whole, codex and the claude family ride
JSON. Nothing in this round changed a split.

**Live acceptance kept true.** Both wire-visible paths re-ran against
localhost:8011 (vLLM `clawvm-qwen32b-coder`; the gateway accepts any
bearer token, so the probe's placeholder key is not a secret and keys
never ride argv). opencode (K1 changed what the parser reads): `probe:
exit 0, 3 turns, recall=true`, replies exactly `noted`, `42`,
`zephyr-mango-42` — and, the point of the re-run, every
turn_completed.usage is real (input 7297/7325/7361, session_ended
summing input 21983; cost_usd 0.00 because the gateway itself reports
zero cost). aider (S1 changed the spawn gate): `probe: exit 0, 3 turns,
recall=true`, the same three replies — three turns through the
re-validated guard with no false positive. Recordings kept in
scratch/probes/opencode-d2-recheck.ndjson and
scratch/probes/aider-d2-recheck.ndjson (ignored). Re-runs reused the
round-1 probe and environment shape; no new deviation.

## Review fixes, round 3

Every finding of `scratch/review-d3-findings.md` (prompt D, round 3) is
fixed — blocker through minor — with the smallest correct change and one
regression test each, plus the two same-class audits the task named.

**Security 1 (major, `--resume` never checked which provider a session
was recorded under).** The override does not move a recorded session's
state directory — claude keeps `~/.claude`, opencode its real data dir,
aider `~/.aider` — so a transcript grown on one endpoint replayed on
another the moment `--resume` matched ids. Every session record now
carries its provider identity (`provider_base_url`, the override's base
URL or null for the operator's own login; src/session/registry.ts:77),
recorded at start by all five drivers through one required option
(src/session/driver.ts:1395 and its four siblings), derived once in
the CLI (`override?.baseUrl ?? null`, src/session/cli.ts:732 —
`validateRunRequest` already refuses half-configured overrides and
zai/agy refuse them outright, so the null/URL pair is exact). The
resume judge refuses a mismatch with exit 78 in both directions,
sitting with the containment guards (`judgeResumeEntry`,
src/session/registry.ts:812: "was created against the provider override
at \<url\> and cannot resume against the operator's own login", or the
mirror, via `providerSurface` at 781). Codex was already covered by the
harness-home hash; the new rule catches the harnesses whose recorded
state does not move with the endpoint. 0.9.0 records predate the field,
so exactly one missing key — this one — reads as operator login rather
than corrupt (src/session/registry.ts:180-186, type-checked at 214),
the reader normalizes absent to null (238) and the next write persists
it; the strict alternative would have marked every existing registry
corrupt at upgrade. Regressions: tests/session-registry.test.ts —
"the provider identity pins the endpoint a resume may replay against
(review D3, security)" (same URL resumes; different URL refused with
both surfaces named; operator-login and mirror directions) and "a 0.9.0
record without the provider field reads as operator login (review D3)"
(reads and resumes, refused under an override, normalizes null at the
next write; any other missing key stays corrupt); and
tests/session-cli.test.ts end-to-end — "a session recorded under an
override refuses a resume on another provider or the operator login
(review D3, security)": one turn under an override at
`http://127.0.0.1:9/v1` (port 9, never dialed — the refusal precedes
any spawn), then a resume at `:10` exits 78 naming both endpoints and a
resume with no override exits 78 naming the operator's login.

**Correctness (major, a failed or interrupted resume deleted the stored
codex override home).** `openCodexSessionProviderHome().settle` removed
the home whenever `resumable` was false, so a resumed process that
settled after a failed turn, an interrupt, or a bad drain destroyed the
very turns it was resumed to continue. A resumed home's settle never
removes anything now (src/codex-provider.ts:445-457): it only records
that the home stands where a resume finds it, always answering true,
and reclamation belongs to the 28-day sweep, exactly as `abandon` (the
prior turn of this test) leaves it. A FRESH session's settle still
removes at a non-resumable end — the round-1 rule, untouched.
Regression: tests/codex-provider.test.ts:140 — its tail now settles a
resumed home twice over: `settle(id, true)` and `settle(id, false)`
both answer true with the keyed path still present (a non-resumable end
of a resumed session removes nothing), the once-only second settle
answers false, and the home survives all of it.

**Minor (the opencode provider config outlived its turn).** The config
was written once at the first turn into the child-writable data
directory and reloaded by every later turn through `OPENCODE_CONFIG`,
so turn N's child could add a permission or an MCP server that turn
N+1 ran with. Each turn now gets a FRESH config: `spawnTurn` finalizes
the previous turn's context (the idempotent cleanup) and runs
`prepareRun` again before every opencode spawn (src/session/cli.ts:937-
954), the run path's own one-file-per-process rule — one
`provider-<pid>-<rand>` directory per turn process, finalized at the
next spawn and at codemux exit. Aider's override rides environment
variables alone (`OPENAI_API_BASE`/`OPENAI_API_KEY`), so its launch env
stays built once and cached: nothing the child can write carries it.
Regression: tests/session-cli.test.ts, "each turn loads a fresh
provider config; an earlier turn's rewrite never reaches the next
(review D3, security 2)" — turn 1 runs under an override, the test
plants `{"permission":{"bash":"allow"}}` into turn 1's config file, and
turn 2's `OPENCODE_CONFIG` (logged per spawn by the fake's env.jsonl)
points at a different file under the provider-dir pattern while turn
1's is gone; after the clean shutdown the live config is gone too.

**Same-class audits.** (a) Every write into a directory the sandboxed
child can also write: the round-1/2 inventory is unchanged, and this
round's only new write is the registry field itself — codemux-owned and
placement-guarded outside cwd and home — while the one write that lived
too long (the opencode provider config) now follows the run path's
fresh-per-process rule, the very class the finding named. (b) Drivers
that split caller text into lines: aider remains the only one (grep
re-verified; round 1 made its split Python-parity exact). Nothing this
round changed a split.

**Live acceptance kept true.** One wire-visible path changed: opencode
spawns now re-run `prepareRun` per turn, so the 3-turn plant/recall
re-ran against localhost:8011 (`clawvm-qwen32b-coder`): `probe: exit 0,
3 turns, recall=true`, replies exactly `noted`, `42`,
`zephyr-mango-42`, `session_started.model`
`codemux/clawvm-qwen32b-coder`, real per-turn usage (input
7299/7327/7363, session 21989) — the fresh-config path holds the
session across turns. Recording kept in
scratch/probes/opencode-d3-recheck.ndjson (ignored). Aider changed no
wire-visible path (its override still rides env; the provider guard
refuses before any spawn), so its round-2 recording stands.

**Gates.** `bun x tsc --noEmit` clean. `make release-gate` (with
`COPILOT_PKG_CACHE_HOME` set): **exit 0** — "Release gate passed" —
runtime, typecheck, shell, test:coverage, contracts (**3 pass /
0 fail**), sandbox contract, smoke, `bun audit` (no vulnerabilities),
frozen-lockfile dry-run, help and verify invocations. Test stage, quoted
from a standalone `test:coverage` run: **1533 pass / 0 fail / 6 skip**
(1539 tests, 59 files, 82.90 s). The round's target was 1530/0/2; this
round adds 7 net tests (2 registry, 2 CLI, 3 docs pins — the
codex-provider regression rewrites an existing test's tail rather than
adding one), and the 4 skips above the target's 2 are the environmental
`skipIf` guards that pre-date the round (platform, process-table
readability, `/usr/bin/script`) — the suite has skipped 6 at every gate
since the branch began. `check_american.py` over the changed prose
(README.md, CHANGELOG.md, docs/HARNESS-COMPATIBILITY.md,
docs/LIVE-SESSIONS-DESIGN.md, this report): **0 hits, exit 0**.

**Judgment call (logged like a deviation).** The operator note says
"record the provider identity … and refuse a resume whose provider
differs"; read strictly, a record without the field is invalid, which
would mark every 0.9.0 registry corrupt the moment this binary reads
one. The tolerance above — absent field reads as operator login exactly,
normalized to explicit null at the next write — keeps existing
registries loadable while still refusing the replay that matters (an
override resuming a login-era transcript, and the mirror). The
semantics are pinned in docs/LIVE-SESSIONS-DESIGN.md §4.8's record
example (`"provider_base_url": null`) and by the registry tests.

## Review fixes, round 4

Every finding of `scratch/review-d4-findings.md` (prompt D, round 4) is
fixed — minor through major — with the smallest correct change and one
regression test each, plus the two same-class audits the task named.
One flag: the findings file carries no operator note this round (38
lines, auditor text only — the task's "with an operator note at the end"
does not match the file as delivered), so no operator directive had to
be reconciled; the fix set is the auditor's three findings alone.

**Security 1 (minor, the codex session-home sweep had no liveness
check).** The sweep fires from `prepareRunDirParent` — every codemux
codex run, hermetic home, and session start — so a resumed codex
override session left open past 28 days with no new turns had its
CODEX_HOME deleted by the next unrelated codemux codex run, under its
running app-server. Past the age gate the sweep now consults
`sessionHeldLive` before removing a `session-home-…` entry
(src/hermetic-home.ts:226-234), keyed by the id in the directory name:
a codex thread id may itself contain `-`, so the parse anchors on the
endpoint hash (exactly 12 hex) and takes the rest whole. The skip's
default consults the machine's one registry
(`sessionHeldLive(sessionRegistryPath(), id)`, HOME-derived exactly as
the session CLI derives it) because no killer call site carries session
context; the parameter exists for test injection. Fail-safe directions
preserved: an unreadable registry vouches for nothing (age decides, as
before), and a process table the probe cannot read counts the owner
alive (the live16 rule), so a restricted machine keeps homes rather
than deleting a live one. Regression: tests/codex-provider.test.ts:220
— "a session home the registry holds live is never swept, however
stale (review D4, security 1)": one OPEN record with a live owner and
one ended record, both homes 30 days idle; one `prepareRunDirParent`
spares the held home and reclaims the ended one.

**Security 2 (minor, a planted intermediate symlink aimed the aider
history directory).** `mkdirSync(recursive)` resolves an intermediate
symlink and creates through it, and the existing check lstat'd only the
final component — a planted `~/.aider/.codemux` symlink pointed the
fresh session's directory creation, the 28-day UUID sweep, and the
record-failure removal wherever it named (`~/.aider` is writable by
the sandboxed child). Every component the child can replace is now
lstat'd: `assertOwnedHistoryChain` (src/session/aider-session.ts:179)
checks `.codemux`, `sessions`, and the session dir — a permissive
pre-pass before the `mkdirSync` (a missing component cannot be a
planted link) and a strict re-assert after (a component swapped while
the mkdir ran); a dangling link is still refused, because lstat sees
the link itself, never its target. The removal path asserts the
intermediates only (`assertOwnedRemovalIntermediates`,
src/session/aider-session.ts:196): `rmSync` never follows a link at
the removal's own final name. The harness home itself is deliberately
not asserted — `~/.aider` is an entry of `~`, above the child's write
reach, and asserting it would refuse an operator's deliberate
symlinked dotdir. Regression: tests/session-aider.test.ts:237 — "a
symlinked .codemux intermediate is refused: no history directory, no
sweep, no removal through it (review D4)": a planted `.codemux` link
with a stale UUID directory beyond it; the create refuses with nothing
created under the target and the stale directory the sweep would have
deleted still there, and the removal refuses the same way.

**Correctness (major, the reply anchor split one line too many).**
Python `str.splitlines` drops the one trailing empty element a final
line break leaves; JS `split` keeps it. A prompt ending in a line
break rendered a header with a spurious `#### ` line, the delta search
missed the block aider had actually written, and the loose fallback
anchored on the first `#### ` line — leaking the prompt's continuation
lines into `assistant_message`. The fix is one slice:
`aiderHistoryHeader` drops the trailing empty element after the split
(src/aider-history.ts:208). The fixture carried the twin defect
(`tests/fixtures/live/fake-aider-run.ts` rendered the same wrong
block), which is why every e2e agreed with the wrong driver; both
sides now render the pinned Python semantics independently.
Regressions: tests/aider-history.test.ts:156 — "a trailing line break
adds no line: splitlines drops the empty tail JS split keeps (review
D4)" (byte pins: a prompt ending in a line break renders the same
block as the same prompt without it; the interior blank and
lone-newline cases keep their extra `#### ` line); and
tests/session-aider-e2e.test.ts:352 — "a multi-line
prompt ending in a line break anchors the same block (review D4)",
through real argv and real history bytes.

**Same-class audits.** (a) Every place a session or run writes into a
directory the sandboxed child can also write: the round-1/2/3 inventory
re-verified unchanged — codex config.toml and the keyed-home settle
(`wx` + rename, components re-asserted), the opencode/droid/pi provider
configs and kimi's agent file (fresh unguessable per-process directory,
parent lstat'd, written pre-spawn), credentials (staging `wx` +
rename), hermetic homes (mkdtemp), the registry (placement-guarded).
The aider session history was the one place a long-lived, guessable
intermediate sat above a write target — fixed this round. The read side
was checked too: `readAiderHistory`'s O_NOFOLLOW covers the final
component, and a mid-session swap of `.codemux` can only redirect
codemux's read at a path ending `sessions/<uuid>/history.md` the child
cannot place outside its sandbox — the read fails closed. (b) Every
driver that splits caller text into lines: aider remains the only one
(re-grepped — the run path passes `--message=` whole, opencode rides
stdin, codex and the claude family and agy ride JSON); its split is now
Python-parity exact including the trailing-empty rule, in both driver
and fixture.

**Live acceptance — one required re-run, blocked.** Aider's reply
anchor changed wire-visibly (the block bytes for a trailing-newline
prompt differ), so the 3-turn plant/recall re-run was required — and
could not run: the gateway at localhost:8011 is down this round
(`curl http://localhost:8011/v1/models` fails with connection refused
on 127.0.0.1 and ::1 alike; nothing is listening). It is the
operator's vLLM server, not this session's to restart, and a
substitute endpoint would not be the live acceptance the claim needs —
logged, not papered over. The changed path is exercised end-to-end by
the new e2e regression (the real driver over the fixture, through real
argv and history bytes) and byte-pinned against the Python semantics
above. OpenCode and codex changed nothing wire-visible (the fixes are
codemux-side filesystem behavior), so their round-2/3 recordings
stand. Re-run when the gateway is back, from a terminal with the
Reproduction block's `CODEMUX_AIDER_PROVIDER_*` exports:

```
bun scratch/probes/record-session.ts aider scratch/probes/aider-d4-recheck.ndjson \
  'Remember this codename for the rest of our conversation: zephyr-mango-42. Reply with exactly: noted' \
  'What is 17 + 25? Reply with just the number.' \
  'Which codename did I ask you to remember earlier in this conversation? Reply with exactly the codename and nothing else.'
```

**Gates.** `bun x tsc --noEmit` clean. `make release-gate` (with
`COPILOT_PKG_CACHE_HOME` set): **exit 0** — "Release gate passed" —
runtime, typecheck, shell, test:coverage, contracts (**3 pass /
0 fail**), sandbox contract, smoke, `bun audit` (no vulnerabilities),
frozen-lockfile dry-run, help and verify invocations. Test stage,
quoted from the gate log (scratch/release-gate-d4.log): **1540 pass /
0 fail / 6 skip** (1546 tests, 59 files, 86.13 s). The round's target
was 1537/0/2 (=1539 tests); this round adds 7 (one aider-history pin,
one aider e2e, one aider-session symlink refusal, one codex-provider
sweep pin, three docs pins), and the 4 skips above the target's 2 are
the same environmental `skipIf` guards as at every gate since the
branch began (platform, process-table readability, `/usr/bin/script`).
`check_american.py` over the changed prose (README.md, CHANGELOG.md,
docs/HARNESS-COMPATIBILITY.md, docs/LIVE-SESSIONS-DESIGN.md, this
report): **0 hits, exit 0**.

**Deviation.** The aider live re-run above is the one item this round
could not close (gateway down; evidence and re-run command recorded).
Everything else in the task ran to completion.

## Review fixes, round 5

Every finding of `scratch/review-d5-findings.md` (prompt D, round 5) is
fixed — all four, one security and three correctness, every one rated
minor — with the smallest correct change and one regression test each,
plus the two same-class audits the task named. The
findings file's operator note is reconciled as follows: the lab gateway
(localhost:8011) is down, and this round changed nothing wire-visible
(the four fixes are a comment's honesty, a sweep policy, a child-stop
ordering, and a filesystem write's timing — no protocol byte changed), so
the report's re-run rule requires no live re-run this round; the re-run
commands from rounds 3 and 4 stay in place for when the gateway returns.

**Security (minor, the isolation comment promised more than the sandbox
delivers).** The comments at the old `src/codex-provider.ts:52-56` and in
`codexSessionProviderHomePath`'s doc claimed keying homes per session id
meant "nothing a sandboxed session writes there (`rules/`, `AGENTS.md`,
hooks) reaches a later session" — false: every `session-home-*` sits in
the same `~/.codex/.codemux-provider/` parent, and scode lets a
sandboxed codex child write anywhere under `~/.codex`. Per the operator
note the claim is now stated, not enforced: the header
(src/codex-provider.ts:52-67) and the path helper's doc say exactly what
codemux vouches for — a NAMING rule (no two sessions run in one
directory), a parent that stays child-writable, one session's child able
to plant files in another session's home (the same trust the operator's
real `~/.codex` always carried), and against that the one guarantee that
holds: each launch rewrites its home's config.toml atomically before
anything spawns, never through a symlink. Enforcement (reset everything
but config.toml at every start/resume) was rejected deliberately: the
home's `sessions/` tree is codex thread state the resume needs, and
content-level plants (`rules/`, `AGENTS.md`) stay reachable through the
shared parent whatever a reset did to the directory. The stale phrase is
refused everywhere it appeared, in code and docs, by the docs pin
(tests/session-docs.test.ts:337 — "the codex session-home isolation
claim states the naming boundary, never the access one"), which also
pins the delivered boundary wording in the provider header, the CLI
comment (src/session/cli.ts:712-713), this report (round 1, finding 1),
the design §11, and CHANGELOG.

**Correctness 1 (minor, a transient registry read error could delete a
live session's home).** `sessionHeldLive` answered false for every
not-ok read, so the stale-home sweeps in `src/hermetic-home.ts` and
aider's session-directory sweep treated `unavailable` (EMFILE, EIO —
transient failures) as "not held" and removed a live session's home. The
answer is now tri-state: `SessionHold = "held" | "free" | "unknown"`
(src/session/registry.ts:701), `sessionHoldState` (:703) returning
`unknown` for `unavailable`, `untrusted`, and corrupt alike, `free` only
for a missing registry (no entry to vouch from), an absent id, an ended
record, or a dead owner, and `held` for an open record with a live
owner. Both sweeps act only on positive `free`:
`sweepStaleRunDirs` skips anything else (src/hermetic-home.ts:241), and
`createAiderSessionHistory` spares the same way
(src/session/aider-session.ts:232). Regressions: the truth-table pin
(tests/session-registry.test.ts:124 — every row of the read-outcome
table including a symlinked registry → untrusted → unknown); the codex
corrupt-registry sweep (tests/codex-provider.test.ts:299 — a stale home
spared under a corrupt registry while a stale run dir still goes, and a
missing registry still frees); and aider's unknown-spare
(tests/session-aider.test.ts:213). `unavailable` itself cannot be forced
deterministically in a test (it arises only from EMFILE-class syscalls),
so the class is covered through its branch-mates corrupt and untrusted,
which share the not-ok path.

**Correctness 2 (minor, a turn child could briefly outlive its
session).** In both turn-per-process drivers, a shutdown or signal
arriving while `spawnTurn` was still awaiting resolved `done` with
`turnProc === null` — nothing waited for the child about to land — and
the CLI's cleanup (opencode's provider-config deletion among it) ran
while a late child was starting with an `OPENCODE_CONFIG` pointing at a
file about to be deleted. Both drivers now track the in-flight spawn
(`turnSpawn`, set synchronously inside startTurn's try before the first
await, cleared in a guarded finally: src/session/opencode-driver.ts:117,
src/session/aider-driver.ts:129), and `finish` gains an arm for it
(src/session/opencode-driver.ts:686, src/session/aider-driver.ts:627):
await the spawn, `requestStop()`, await `settled` — all BEFORE `done`
resolves. The late child's exit is codemux's own kill, not a turn
verdict: the open turn is answered by the ordinary synthesis
(`finish: interrupted`) and `session_ended` reports `exit_code: null`,
exactly as an idle session does. A synchronous `spawnTurn` throw is also
now caught inside the try (it used to escape startTurn as an unhandled
rejection path). Regressions, one per driver, both through the real
CLI-shaped spawn closure: tests/session-opencode-e2e.test.ts:747 and
tests/session-aider-e2e.test.ts:639 — a 250 ms spawn hold, a shutdown
mid-hold, and the assertion that the child settled before `done`
resolved, in that exact order (`spawned`, `settled`, `done`).

**Correctness 3 (minor, a racing second resume rewrote the live
session's config).** A codex override resume rewrote its session home's
`config.toml` at the home open — before `claimForResume` — so a second
`--resume` whose lock-free lookup had already passed rewrote the live
session's config (a different model, or caps) and only then exited
`session_busy`; that exit also skipped `abandon()`, so a fresh override
home left before the spawn was reclaimed only by the stale-run sweep.
The write moved behind the claim for both constructors: the home object
now carries `prepareConfig` (src/codex-provider.ts:309) —
`createCodexSessionProviderHome` builds a bare `mkdtemp` and writes
nothing until it runs, `openCodexSessionProviderHome` leaves the resumed
config untouched until it runs — and the CLI calls it as the first
statement inside the spawn block (src/session/cli.ts:1211), after the
claim, before anything spawns. The claim-refusal path now abandons
explicitly (src/session/cli.ts:1142-1152; for a resumed home the call is
the designed D3 no-op, kept so the path cannot silently depend on which
constructor built the home), and the action's outer catch abandons only
when the spawn never began (src/session/cli.ts:1265) — a live child's
CODEX_HOME is never deleted under it. Regressions:
tests/session-cli.test.ts:2693 — the race itself, end to end: session
one to a resumable end, a loser parked at the harness version probe (the
CLI's order is lookup, probe, home open, claim) by a wrapper whose
`--version` waits on a release file beside it (the probe's environment
is allowlisted, so no test variable reaches it), the winner claiming and
spawning meanwhile, then the loser released to its `session_busy` exit
78 with the keyed config byte-for-byte the winner's and the same inode —
verified to FAIL against the pre-D5 write-at-open behavior re-simulated
in place; plus the unit pins that a fresh home holds no config until
`prepareConfig` and a resumed home's planted symlink survives the open
and is replaced only at `prepareConfig` (tests/codex-provider.test.ts:79,
:146).

**Same-class audits.** (a) Every place a session or run writes into a
directory the sandboxed child can also write, re-verified from the
round-4 inventory: the codex session home was the one site whose comment
over-claimed the boundary — restated this round, everything else
unchanged (codex config.toml `wx`+rename, opencode/droid/pi provider
configs and kimi's agent file in fresh unguessable per-process
directories, credentials staging, hermetic homes, the placement-guarded
registry; aider's history chain lstat'd top-down since round 4). (b)
Every driver that splits caller text into lines: aider remains the only
one (re-grepped — opencode rides stdin, codex and the claude family and
agy ride JSON), unchanged from the round-4 Python-parity fix.

**Live acceptance — none required this round.** No wire-visible path
changed: the four fixes alter a comment, a deletion policy, a stop
ordering, and a config write's timing. The fixture e2e suites remain
the pin (opencode and aider 3-turn flows over the recorded wires, now
including the late-child ordering). The gateway being down (operator
note; connection refused on 127.0.0.1 and ::1) therefore blocks nothing
this round, and the re-run commands in rounds 3 and 4 stand for the next
wire-visible change.

**Gates.** `bun x tsc --noEmit` clean. `make release-gate` (with
`COPILOT_PKG_CACHE_HOME` set): **exit 0** — "Release gate passed" —
runtime, typecheck, shell, test:coverage, contracts (**3 pass /
0 fail**), sandbox contract, smoke, `bun audit` (no vulnerabilities),
frozen-lockfile dry-run, help and verify invocations. Test stage,
quoted from the gate log: **1549 pass / 0 fail / 6 skip** (1555 tests,
59 files, 84.78 s). Round 4's gate was 1540/0/6 (1546 tests); the +9 is
exactly this round's tests (four docs pins, one corrupt-registry sweep
pin, one aider unknown-spare pin, two late-child e2e, one busy-race
e2e; the registry truth-table pin replaced its predecessor in place).
The 6 skips are the same environmental `skipIf` guards as at every gate
since the branch began (platform, process-table readability,
`/usr/bin/script`), not new. `check_american.py` over the changed prose
(19 files: the four docs, this report, and the round's source and test
comments): **0 hits, exit 0**.

**Deviations and judgment calls.** (1) The isolation claim is stated,
not enforced — the reasoning is in the Security paragraph (thread state
in the home, content-level plants regardless), and the operator note
allowed exactly this. (2) `unavailable` is covered through its
branch-mates corrupt/untrusted rather than forced (no deterministic
EMFILE in a test); the rule it exercises — not-ok reads never answer
`free` — is the same branch. (3) The busy-race regression was verified
against the pre-D5 behavior by re-simulating the write-at-open in place
(a patched `openCodexSessionProviderHome`), confirming the test fails
(content and inode rewritten) before the fix and passes after; the
patch was reverted and the tree re-gated. Everything else in the task
ran to completion.

## Review fixes, round 7

Every finding of `scratch/review-d7-findings.md` (prompt D, round 7) is
fixed or dispositioned — one security major and three correctness
minors, plus the contracts reviewer that timed out (no findings
delivered; recorded below). The findings file's operator note is
reconciled as follows: the lab gateway is down and the note says not to
block on live re-runs, and this round changed no protocol shape — the
one caller-visible novelty is a new failure REASON string on a path that
previously could not fail this way (an aider turn refused before its
spawn), which is free-form reason text by design. The note's directive
for the aider check — re-run the ownership-chain check and lstat the
history file (regular, not a link, owned by the invoking user, 0600)
before EVERY turn spawn, fail the turn rather than the session, and
audit the same class for opencode and the codex session home — is
implemented verbatim.

**Security (major, the aider history file could be swapped for a symlink
between turns).** The creation-time chain check and the post-turn
`O_NOFOLLOW` read left the between-turns window open: a sandboxed child
that can write `~/.aider` replaces `history.md` with a symlink (the
finding's example: `~/.ssh/authorized_keys`), and the next turn's aider
— running outside that sandbox — follows it, reading the target into the
model context and appending to it. `assertAiderHistoryForTurn`
(src/session/aider-session.ts:219) now runs at the top of the driver's
startTurn (src/session/aider-driver.ts:429), before `spawnTurn`: the
owned chain (`.codemux` down, lstat) plus an lstat of the file itself —
regular (a link fails `isFile`), owned by the invoking user, mode 0600;
a missing file throws too, so a turn never spawns against state codemux
cannot see. A trip fails the TURN, not the session: the open turn is
finished `failed` ("the chat history file cannot be trusted for this
turn") with a non-fatal `error` event ("failed its pre-turn check"), and
the caller may end the session deliberately. The mode check cannot
false-positive on a live session: aider only ever appends in place
(`append_chat_history` opens with `"a"`, io.py at 0.86.2), so a
codemux-created 0600 file never carries another mode. Regressions: the
unit table (tests/session-aider.test.ts:252 — the created file passes;
0644 trips; a symlink at an `authorized_keys` canary trips with the
canary untouched; a missing file trips) and the end-to-end window
(tests/session-aider-e2e.test.ts:435 — turn 1 completes, the history is
swapped for a symlink between turns, turn 2 finishes `failed` with the
new reason after exactly ONE spawn, the canary is never read or written,
and the session still ends cleanly on shutdown).

**Contracts (zai:glm-5.3).** The reviewer timed out after 900 s and
delivered no findings. Nothing to fix from it; the stage's findings are
the ones above and below.

**Correctness 1 (minor, the record was released before the override
home settled onto its key).** The codex driver's end path released the
registry record ahead of `settleSessionHome`'s rename, and the release
is what a `--resume` in another process waits on — a resume landing in
that window found a closed record whose `harness_home` named a keyed
path that did not exist yet and was refused "missing or untrusted". The
settlement (with its existing try/catch and `settledHome` result) now
runs BEFORE `releaseSessionRecord` (src/session/codex-driver.ts:1970
before :1980), and `session_ended`'s `resumable` stays
`resumable && settledHome`. Regression (tests/session-codex-e2e.test.ts:
262): a `settleSessionHome` seam that reads the registry inside the
settlement and records whether the record was still open — the
observation must be exactly one settle with the record OPEN (`ended`
unset), and the record closed after.

**Correctness 2 (minor, the stale sweep walked every tree before the
liveness check).** `sweepStaleRunDirs` walked an entry's whole tree
before the `run-<pid>` liveness check, so a child-plantable deep or wide
tree under `~/.codex` slowed every later codemux codex run. Two changes
(src/hermetic-home.ts): a run-shaped entry's pid gate comes from its
NAME first (:237, :245 — a live run is never walked at all), and the
freshness walk carries an entry budget (`MTIME_WALK_ENTRY_CAP` = 4096,
:152) — an over-budget tree answers null and is SPARED, the safe
direction under the D5 rule that a removal needs a positive reading.
Regression (tests/codex-provider.test.ts:272): a session-home tree one
entry past the cap, every entry a month old, is spared while a small
stale tree beside it still goes. The pid-first reorder is a performance
change invisible by design (same deletions, less walking); its pin is
the code claim ("comes from its NAME (no walk for a live run)") in the
docs test.

**Correctness 3 (minor, `provider_base_url` breaks a co-installed 0.9.0
binary).** 0.10.0's validator already tolerates the field's absence (one
missing key accepted, review D3), but a co-installed or downgraded 0.9.0
binary validates records by exact key count and reads a whole
0.10.0-written registry as corrupt — every `--resume` refused, recording
stopped. Per the finding ("the fix belongs in the release notes or the
upgrade path"): the 0.10.0 CHANGELOG opens with an "Upgrade notes"
section naming the field, the 0.9.0 failure mode, upgrade-every-binary
advice, and the downgrade path (remove the registry file, with its
location on each platform and the lost-resume-history cost), and the
validator's comment states the tolerance is one-directional by design —
widening 0.10.0's own validator cannot fix the old binary
(src/session/registry.ts:185). Docs pin: tests/session-docs.test.ts:441.

**Same-class audits (the operator note's scope).** (a) The codex session
home had a real window: the resumed home is asserted at the open
(`openCodexSessionProviderHome`, src/codex-provider.ts:459) but the
config is written at `prepareConfig`, after the resume claim — which may
wait out the lock budget — and the shared parent is writable by every
sandboxed codex child, so another session's child could swap the home
DIRECTORY for a symlink while this resume waited. Closed:
`writeCodexProviderConfigInto` re-asserts the home itself
(`assertTrustedDirectory`, src/codex-provider.ts:197) before computing
any path — the config lands in a trusted, owned directory or not at
all. Regression (tests/codex-provider.test.ts:193): the home swapped for
a symlink between the open and `prepareConfig` → the call throws /must
be a directory owned by the current user/, the link's target stays
empty, and the link itself stands for the operator to see. (b) OpenCode
needed no change: its per-turn provider config is written fresh before
every turn into an unguessable per-turn directory (the D3 fix — a
previous turn's child cannot have predicted the path to plant at it),
and its session store is harness-owned state under the real data
directory (the override swaps the provider, never the store), not a
codemux-written cross-turn file — the same trust class as the operator's
own `~/.codex` thread state. The conclusion is recorded in CHANGELOG.
(c) The claude family and agy homes are likewise the harness's own state
(`~/.claude` transcripts, agy's conversation store) with no
codemux-written cross-turn carrier; resume trust there is the registry's
agent/home match, unchanged.

**Live acceptance — none required this round.** The operator note: the
gateway is down, do not block on live re-runs. Nothing wire-visible
changed shape — the fixes are a filesystem check, an end-path reorder,
a sweep policy, and release notes; the fixture e2e suites remain the
pin, and the new aider e2e drives the symlink refusal end to end over
the recorded wire. The re-run commands from rounds 3 and 4 stand for the
next wire-visible change.

**Gates.** `bun x tsc --noEmit` clean. `make release-gate` (with
`COPILOT_PKG_CACHE_HOME` set): **exit 0** — "Release gate passed" —
runtime, typecheck, shell, test:coverage, contracts (**3 pass /
0 fail**, 147 expect() calls), sandbox contract, smoke, `bun audit` (no
vulnerabilities), frozen-lockfile dry-run, help and verify invocations.
Test stage, quoted from the gate log: **1559 pass / 0 fail / 6 skip**
(1565 tests, 59 files, 83.62 s). The task's 1554/0/2 baseline is
gate-d8.log — the pre-change tree, 03:52 this morning, 1556 tests — and
1556 + exactly this round's 9 tests (one aider unit, one aider e2e, two
codex-provider, one codex e2e, four docs pins) = 1565; the split
differs only in the four tests behind `processTableReadable()`
(src/process-table.ts:48), which answers false in this runner — the
sandbox denies `posix_spawn /bin/ps` (EPERM), the exact case the guard's
doc names — so they skip here and ran at gate-d8; 0 fail at both.
`check_american.py` over the changed prose (16 files: the four docs,
this report, and the round's source and test comments): **0 hits, exit
0**.

**Deviations and judgment calls.** (1) The first gate attempt failed at
the contracts stage on the copilot loader's `EPERM mkdir
~/Library/Caches/copilot/pkg` — the documented round-1 workaround
(`COPILOT_PKG_CACHE_HOME` redirected to a scratch cache) was missing
from the invocation; the gate was rerun with it set and passed. (2) The
aider resume e2e fixture seeded its prior history at the filesystem
default 0644 — a codemux-created file is 0600, so the new pre-turn check
correctly refused it; the fixture now seeds `{ mode: 0o600 }` (the
check catching an unrealistic fixture is the check working). (3) The D3
README pin moved to the reworded sentence ("A resumed home is never
removed at settlement") — the D7 settle-before-release rewording changed
the phrasing, the never-removed claim survives, and the pin's comment
says so. (4) `MTIME_WALK_ENTRY_CAP` is exported so the regression test
consumes the real constant — hardcoding 4097 in the test would silently
drift if the cap ever changes. Everything else in the task ran to
completion.

## Review fixes, round 8

Every finding of `scratch/review-d8-findings.md` (prompt D, round 8) is
fixed — one correctness major that blocked and two minors — plus one
more bug the same-class audit found in the minors' class. The findings
file's operator note is reconciled as follows: the tree is the Prompt D
work on 0.9.0 with version 0.10.0, and the version is untouched; the
lab gateway is down and the note says not to block on live re-runs, and
nothing this round needed one — every fix is exercised by the fake
harness fixtures, including the oversize-history session (the fake
aider replays a pre-seeded history file, so a 32 MiB session needed no
model at all).

**Correctness (major, blocks: a long aider session crashed and every
later resume was refused).** `readAiderHistory` answered null once the
history file passed `MAX_HISTORY_BYTES` (32 MiB, src/aider-history.ts:161
— sized for one `--message` run's prompt-plus-reply), a session's
history only grows, so past the bound every finished turn reported
"unreadable or truncated" and ended the session, and every `--resume`
failed the same way in `run()` — though nothing was corrupt. The bound
was never wrong for the RUN path (one exchange cannot legitimately
outgrow it, and a harness that can write the directory could grow a
file without bound); it was wrong to apply it to the SESSION path's
whole accumulated file. The session driver now keeps a byte offset
instead of reading the file whole: `run()` baselines it with
`aiderHistorySizeBytes` (src/aider-history.ts:280 — the shared
`openTrustedHistory` trust rules: O_NOFOLLOW, O_NONBLOCK, regular-file
fstat, reading none of the content, no size limit at all), and each
`completeTurn` reads only the delta past it with
`readAiderHistoryDelta` (src/aider-history.ts:244), which refuses a
file that shrank below the offset (the session's own state truncated),
a delta larger than one run's whole history (fails closed), and a
mid-read shrink; `sizeBytes` returns the last byte actually read, so
bytes landing between the fstat and the read are the next turn's delta,
never skipped. The driver's old `consumedChars` (a UTF-16 length) is
`consumedBytes` (src/session/aider-driver.ts:143), set at :281 and
advanced at :560. The run path's whole-file read keeps its bound, and
its doc says the session path must not use it. Worked example, now the
e2e: a resumed session seeded past 32 MiB completes its next turn and
shuts down 0, where the pre-fix tree answered "the resumed conversation
is not recoverable" before any turn. Same class audited across the
other drivers: aider's history file is the only artifact codemux itself
reads back that accumulates over a session's life — opencode's session
store is harness-native state codemux never reads whole, the claude
family's transcripts are harness-native, codex's thread state lives in
its own home and reaches codemux only through the app-server stream
(parsed per line, and the driver's in-memory holds are bounded at 256
lines / 32 MiB by the live19 round), agy holds nothing codemux reads
back, and the hermetic-home walks that touch unbounded trees are
entry-capped (D7). No other driver needed a change.

**Contracts (minor: the aider-history module header stated two facts
the branch falsifies).** The header claimed "nothing reads the
extraction today" and "Only hermetic runs create the file" — while the
new aider session driver imports the extraction helpers and reads the
history every turn, and every session owns a persistent
`~/.aider/.codemux/sessions/<uuid>/history.md` kept as the resume
state, never removed at exit. The header (src/aider-history.ts:1-42)
now splits the two surfaces: the run path stays as described (the
hermetic check is refused, so no reachable run reads or creates a
file; plain runs keep /dev/null), and the session path is named as the
extraction's live reader with the per-session file's lifecycle (kept
as the resume state, swept after 28 idle days, distinct from run
files' removed-at-exit). Same class audited: the other
Prompt-D-touched headers (aider-session, aider-driver,
opencode-driver/session, codex-driver, the CLI's runLike comment) all
carry pins from their own review rounds refusing their stale wordings,
and a re-read found no other claim the branch falsifies; the
aider-history header is the one module whose header had never been
pinned, and the docs-pin family now covers it (a test refuses both
stale phrases and pins the delivered claims).

**Correctness (minor: `codexHarnessHome` validated CODEX_HOME for every
agent).** The session CLI computed the codex home once at shared setup
— unconditionally, because the resume guard's harness-home cover needed
it before the agent arms — so `codemux session -a claude --pass-env
CODEX_HOME` with `CODEX_HOME=rel/path` exited 64 on a codex rule
claude never reads (same for zai, agy, opencode, aider). The
computation is now a lazy memo (src/session/cli.ts:700,
`codexHome()`), called only inside the codex arms (the home ternary,
the two provider-home constructors, `harnessHomeFor`); no other agent
validates or computes it. Same class audited across the whole shared
setup region, and the audit found one more instance of exactly the bug
the finding describes: `assertAbsoluteClaudeConfigDir` — the claude
family's CLAUDE_CONFIG_DIR validation, whose refusals are the same
absolute/unpadded pair — also ran eagerly for every agent
(src/session/cli.ts:557 then), so `codemux session -a aider
--pass-env CLAUDE_CONFIG_DIR` with a relative value exited 64 on a
claude rule aider never reads. It now runs for claude and zai only
(the whole family shares the one store, `claudeFamilyHarnessHome`),
which is also the run path's shape — there the check has always lived
in the two adapters' `validateRunRequest`, never in the shared
launcher. The rest of the region is clean: the agy/opencode/aider home
helpers are pure path joins with no refusal behavior, and every other
validation is either shared (flag parsing, `--cwd`,
`--pass-env` names), agent-gated (playwright's claude/zai refusal), or
agent-parameterized by construction (`resolveSandboxOptionsForAgent`).

**Regression tests (eight, one per fix plus the pins).**
`tests/aider-history.test.ts` — the delta read over a
`MAX_HISTORY_BYTES+1` file returns exactly the tail exchange with the
advanced offset, while the whole-file read refuses it, a zero-offset
delta read refuses it, and a past-the-end offset refuses it.
`tests/session-aider-e2e.test.ts` — a resumed session seeded past
32 MiB completes a turn, the history grows past the bound, shutdown
exits 0, resumable stays true. `tests/session-cli.test.ts` — an aider
session with a relative passed-through `CODEX_HOME` runs a full turn
to a clean end; the audit sibling does the same with a relative
`CLAUDE_CONFIG_DIR`. Both e2e refusals were verified against the
pre-fix behavior by re-simulating the eager calls in place and
observing the tests fail (0 pass / 1 fail each) before restoring the
fixes. `tests/session-docs.test.ts` — four pins: the header's stale
phrases refused and the delivered claims pinned, the per-turn bound
wording pinned across README/design/compatibility/CHANGELOG and the
code's single-line comments, the driver pinned to
`readAiderHistoryDelta` and refused the whole-file read, and both
CLI scoping comments pinned.

**Gates.** `bun x tsc --noEmit` clean. `make release-gate` (with
`COPILOT_PKG_CACHE_HOME` redirected to a scratch cache): **exit 0** —
"Release gate passed" — runtime, typecheck, shell, test:coverage,
contracts (**3 pass / 0 fail**, 14 installed harness binaries
exercised), sandbox contract, smoke, `bun audit` (no vulnerabilities),
frozen-lockfile dry-run, help and verify invocations. Test stage,
quoted from the gate log (scratch/release-gate-d8r8.log): **1567 pass
/ 0 fail / 6 skip** (1573 tests, 59 files, 84.44 s). Round 7 ended at
1565 tests (1559/0/6 here); 1565 + exactly this round's 8 tests (one
aider-history unit, one aider e2e, two session-cli, four docs pins) =
1573. The task's 1554/0/2 baseline (1556 tests) differs in the four
tests behind `processTableReadable()` (src/process-table.ts:48), which
skip in this runner as in every round since — the sandbox denies
`posix_spawn /bin/ps` (EPERM); 0 fail at both.
`check_american.py` over the changed prose (12 files: the four docs,
this report, and the round's source and test comments): **0 hits, exit
0**.

**Deviations and judgment calls.** (1) The finding-2 fix keeps the run
path's whole-file bound untouched rather than raising it — the bound is
correct for one exchange and doubles as the session delta's ceiling, so
one constant governs both reads and the session bound falls out as
"one turn cannot outgrow one run". (2) The delta read returns the
bytes actually read, not the fstat's size, so a concurrent append
between fstat and read is never skipped — the appended bytes become the
next turn's delta. (3) For a codex session with both a malformed
`--resume` id and a bad CODEX_HOME, the resume-pattern refusal now
fires first (the lazy home computation defers the CODEX_HOME error);
both exit 64 and no test pins that ordering. (4) The CODEX_HOME
pre-fix verification mid-round briefly wiped the fix itself — `git
checkout -- src/session/cli.ts` restored the staged pre-D8 file instead
of only the perl re-simulation; the fix was re-applied and re-verified
(tsc clean, session-cli 64/0, codex-provider 13/0 at that point), and
the CLAUDE_CONFIG_DIR sibling's verification used a file backup
instead. Everything else in the task ran to completion.

## Review fixes, round 9

Every finding of `scratch/review-d9-findings.md` (prompt D, round 9) is
fixed — one correctness major that blocked and one contracts minor —
with the same class audited across every sweep in the tree. The
operator note is followed as written: the sweep fix falls back to the
directory's own mtime (the note's first option), and the version stays
at 0.10.0.

**Correctness (major, blocks: dead run directories larger than the walk
cap were never swept).** `sweepStaleRunDirs` aged a `run-<pid>-*`
directory by the tree-newest mtime, and the capped walk (D7) answers
null past 4,096 entries — the branch then spared the directory. A
codemux that died before `finalize` (SIGKILL, OOM, a crash) left the
directory under `~/.codex/.codemux-hermetic/` (or `.codemux-scratch`,
or `.codemux-provider` for a crashed fresh override session) forever:
every tool the run's child executed (npm, pip, cargo) wrote caches into
that HOME, and past the cap the sweep neither removed the tree nor
stopped paying for it — each later run walked it to the cap again, the
slowdown the cap was added to prevent. The pid gate had already shown
nothing owns the tree, so nothing was being protected. The fix
(src/hermetic-home.ts): once the pid gate passes, an over-budget walk
falls back to the directory's OWN mtime (`directoryMtimeMs`) — the
pre-D2 rule, correct for a tree with no owner — so the crash leftover
is reclaimed once its own age passes `STALE_RUN_DIR_MS` (2 days), and
the recurring walk ends with it. An entry nothing can stat still stays
put. A session home kept the D7 spare on every over-budget walk at this
round — it is live, resumable state (an OPEN record can hold it for
weeks), and its removal needs a positive reading, never an exhausted
probe; round 10 superseded that branch (the registry is consulted
before the walk, and a keyed home it has POSITIVELY freed is reclaimed
by its own mtime even over budget — see the round 10 section below).
Worked
example, now the regression test (tests/codex-provider.test.ts):
`run-999999999-crashed` holding 4,097 fresh files but a top directory
three days old is swept by the next `prepareRunDirParent`; an identical
tree a second old stays. Verified against the pre-fix tree by reverting
only the run-branch fallback and watching the test fail (the file's two
"too big to walk" tests: 1 pass — the D7 session-home spare — / 1
fail) before restoring the fix. Same class audited across every sweep
in the tree (eight, by grep): `hermetic-home.ts` owns the only tree
walk, and its session-home branch is the deliberate spare above;
`sweepStaleFiles` in aider-history and kimi-no-tools age a single
file's own mtime; `sweepStaleDirectories` in droid-provider,
opencode-provider, and pi-provider and `sweepStaleHomes` in
opencode-hermetic age the directory's own mtime — the exact rule this
fix adopts for over-cap run directories; `sweepStaleSessionDirs` in
aider-session ages by the history file's mtime behind the registry's
positive-`free` gate. No other sweep shares the defect, and
`newestMtimeMs` has no caller beyond the sweep's two branches. Docs:
DESIGN §11 and the compatibility addendum now state the split rule,
the CHANGELOG's D7 sentence is amended to it, and a D9 bullet records
the round.

**Contracts (minor: the report's header asserted a version state the
tree contradicts).** The header claimed the version sat unchanged at
0.9.0 with the CHANGELOG entry under `[Unreleased]`, while the tree
ships `"version": "0.10.0"` and a dated `## [0.10.0]` section — both
added by release prep the day after the header was written, so the
document contradicted itself (its round-8 section already acknowledged
0.10.0).
The header now states both facts: cut from main 299066b at version
0.9.0, release prep landed 2026-10-08, the tree carries 0.10.0 with the
entry under `[0.10.0]`; deliverable 4's "CHANGELOG `[Unreleased]`"
mention carries the same correction. The docs-pin suite now reads
package.json and pins the header's version claim and CHANGELOG section
against it (tests/session-docs.test.ts), so the next version bump
cannot leave the header behind — this file is a maintained contract
document (its wording has been pinned since the D2 round). Same class
audited: every remaining `0.9.0`/`[Unreleased]` mention in the report
is round history (each round describes its own time) or the
0.9.0-compatibility rules, which are current and stay.

**Regression tests (three).** tests/codex-provider.test.ts — the
dead-run over-cap sweep above (stale by its own mtime goes, young
stays). tests/session-docs.test.ts — two pins: the split sweep rule
(both doc sentences, the CHANGELOG clause, the `?? directoryMtimeMs`
fallback in the run branch, and refusals of the two stale blanket
claims) and the report header's version pinned against package.json
with the stale claim refused.

**Gates.** `bun x tsc --noEmit` clean. `make release-gate` (with
`COPILOT_PKG_CACHE_HOME` redirected to the scratch cache): **exit 0**
— "Release gate passed" — runtime, typecheck, shell, test:coverage,
contracts (**3 pass / 0 fail**, 14 installed harness binaries
exercised), sandbox contract, smoke, `bun audit` (no vulnerabilities),
frozen-lockfile dry-run, help and verify invocations. Test stage,
quoted from the gate log (scratch/release-gate-d9r9.log): **1570 pass
/ 0 fail / 6 skip** (1576 tests, 59 files, 85.11 s). Round 8 ended at
1567/0/6 (1573 tests); 1567 + exactly this round's 3 tests = 1576. The
task's 1554/0/2 baseline differs in the four tests behind
`processTableReadable()` (src/process-table.ts:48), which skip in this
runner as in every round since — the sandbox denies
`posix_spawn /bin/ps` (EPERM); 0 fail at both. `check_american.py`
over the changed prose (seven files: CHANGELOG, the compatibility doc,
the design doc, this report, and the round's source and two test
files' comments): **0 hits, exit 0**.

**Deviations and judgment calls.** (1) The fix takes the operator
note's first option — fall back to the directory's own mtime — rather
than treating an over-cap walk as "old": the fallback keeps the 2-day
age gate meaningful (a codemux that died may leave a codex child
running in its home for as long as a run may last, and the top-level
mtime still shields it for the gate's span) while bounding both the
leak and the recurring walk in time. (2) The pre-fix verification's
restore step briefly over-applied its regex — both sweep branches
matched `const newest = newestMtimeMs(path);`, so the session-home
branch gained the fallback too; grep caught it, the branch was
restored, and the three affected suites were re-run green
(codex-provider + session-docs + hermetic, 110 pass / 0 fail). (3) The
CHANGELOG's D7 sentence was amended inside the same unreleased 0.10.0
entry rather than left to contradict the D9 bullet beside it — both
describe one release. Everything else in the task ran to completion.

## Review fixes, round 10

*(Recorded in round 11: this round's fixes landed everywhere but the
report — the round-11 contracts finding. The body below is the round's
prepared record, its Gates paragraph completed then from the surviving
logs.)*

Every finding of `scratch/review-d10-findings.md` (prompt D, round 10)
is fixed — one security major that blocked, one security minor, and
three correctness-2 minors — with the same class audited across the
other session drivers and the other sweeps. The operator note is
followed as written: the aider slash rule refuses (never escapes) on
both surfaces with a regression test on each, the registry records the
base URL without query or fragment and compares resumes on that same
form, and the version stays at 0.10.0.

**Security (major, blocks: aider session turns ran caller text as
aider slash commands).** Aider's `preproc_user_input` dispatches any
message whose first non-whitespace character is `/` or `!` as one of
aider's own commands, BEFORE any model turn — and `!` (the `/run`
alias) executes the shell immediately, ungated by `--dry-run`. The
session driver relayed caller text into `--message=` verbatim, so a
prompt like `!touch /tmp/pwned` under `--auto read-only` executed a
shell line the autonomy never authorized. The fix refuses such a
prompt on both surfaces: the session path rejects the input line
`unsupported` before the ack (src/session/aider-driver.ts, judged on
harnessText — the argv text is what aider dispatches, and an author
prefix `[author] …` sits ahead of it and neutralizes the dispatch, so
a prefixed line stays model text), and the run path throws from
`AiderAdapter.validateRunRequest` (src/adapters/aider.ts,
`aiderPromptIsCommand`) a `UsageRefusalError` (src/validation.ts) that
the runtime maps to exit 64 (src/cli-runtime.ts), so a script can tell
a caller fix from a run failure. Worked example, now the regression
tests: `!touch /tmp/codemux-d10-pwned` and `"  /run curl … | sh"`
(leading whitespace) are both rejected `unsupported` before anything
spawns, while an author-prefixed `/run whoami as plain text` completes
as a turn and the fake's argv log records exactly that one spawn
(tests/session-aider-e2e.test.ts); `codemux run -a aider -p "!touch …"`
exits 64 naming the rule on stderr with a marker the fake binary would
have written never appearing — the refusal precedes the version probe
and the spawn (tests/cli-stdin-prompt.test.ts); the predicate's
positives and negatives, `[ana] /run whoami` included, and the
validateRunRequest throw are pinned in tests/new-adapters.test.ts.
Verified against the pre-fix tree by reverting each surface in
isolation: the adapter revert failed the run and unit tests (2 fail),
and the driver revert failed the session test by timeout — pre-fix the
line is acked and spawned, so no rejection event ever arrives (1 fail,
restored and re-run green, 25/0). Same class audited across the other
session drivers: no other harness dispatches caller text from prompt
position as its own commands — claude/zai stream-json user frames,
codex app-server `turn/start` input, agy stream-json frames, and
opencode's stdin prompt are model input on every verified surface, and
agy carries `--disable-slash-commands` in its own contract — so
aider's preproc dispatch was the one relay in the tree. Docs: README
(aider session paragraph, both paths), DESIGN §11, the compatibility
addendum, and a CHANGELOG bullet record the round.

**Security (minor: the registry recorded the raw override base URL,
query included).** A gateway key can ride the query string
(`?key=…`), and `provider_base_url` went to disk raw and came back in
resume-mismatch refusals through `providerSurface` — the key persisted
in the registry and was echoed to whoever forced the mismatch. The fix
records and compares the base URL's identity form:
`providerIdentityBaseUrl` (src/provider-override.ts) strips the query
and fragment by slicing at the first `?` or `#` (deliberately not
`new URL().toString()`, which re-spells the URL and would break the
string comparison), one seam in src/session/cli.ts (`providerBaseUrl`)
feeds the record, the resume probe, and the refusal surface, and
`codexSessionProviderHomePath` hashes the same identity form
(src/codex-provider.ts) so a rotated query key keeps a session's home
instead of forking it. Worked example, now the regression tests: a
claude session opened under `?key=e2e-secret` records
`http://127.0.0.1:9/v1` with the secret absent from the registry file,
resumes under `?key=rotated-other` into the same session id and
completes a turn, and a cross-endpoint resume under a second gateway's
key exits 78 naming both stripped endpoints and echoing neither key
(tests/session-cli.test.ts); the strip shapes (query, fragment, both,
trailing slash preserved) and the hash equalities (`?key=k1`, `?key=k2`,
and `#frag` all equal the plain path; `/v2` differs) are pinned in
tests/provider-override.test.ts and tests/codex-provider.test.ts.
Verified against the pre-fix tree by reverting the seam: the registry
carried the secret (1 fail). Same-class audit: `providerBaseUrl` is the
only writer of `provider_base_url` and the hash is its only other
consumer; no query-carrying session homes exist to migrate (the live
acceptance used query-less URLs). Docs: DESIGN §4.8, the compatibility
addendum, and the CHANGELOG (the Added sentence amended and a D10
bullet).

**Correctness-2 (minor 1: a killed aider turn still ended
`resumable: true`).** Aider writes the `#### ` user block at the
turn's start (io.user_input) and the reply only at the turn's end, so
a turn killed partway (SIGTERM → exit 143) leaves the history
half-written. `drainFailureCode` excludes 143 — the signal's coded
spelling, not a failure — so `endExitCode` stayed 0 and the end
reported `resumable: true`; a resume's `--restore-chat-history` then
replays the unanswered prompt as if it were answered state. The fix
(src/session/aider-driver.ts finish()): an open turn at the drain
(`openTurnInterrupted`, captured before the synthesis block — the
transition inside moves the FSM) makes the end not resumable. Worked
example, now the regression test: with the fake exiting 143 mid-wait,
the turn finishes interrupted, the session ends exit_code 143 with
`resumable: false`, and the history holds the `#### scenario:wait two`
user block but not its reply (tests/session-aider-e2e.test.ts); the
stdin-close and exit-143 tests assert the same verdict and the
half-written history. Verified against the pre-fix tree: three
failures before the fix (the resumable verdict and the history
assertions), green after. Same class audited across the other session
drivers: opencode keeps turns in its own `ses_` store, the claude
family in transcripts, codex in threads, agy in server-side
conversations — an interrupted turn leaves a harness-native store in
the harness's own consistent shape, and codemux owns no half-written
file there, so aider was the only driver whose resumable verdict
contradicted state codemux itself had written. Documented (README,
DESIGN §11, the compatibility addendum), no change needed. The fake's
wait scenario now writes the user block at turn start, so the fixture
models the real order.

**Correctness-2 (minor 2: an over-cap session home was kept forever
and re-walked on every run).** The capped walk (D7) answers null past
4,096 entries, and the session-home branch spared every null — so any
`session-home-*` tree past the cap survived forever while costing every
later codemux run a walk to the cap, the recurring slowdown the cap was
added to prevent. The fix (src/hermetic-home.ts, the session branch):
the directory's OWN mtime is a floor on the tree-newest age (the walk
includes the root), so a home young by its own mtime costs neither the
registry nor the walk; the id extracted from the name is consulted in
the registry BEFORE the walk, so a held or unknown id is spared without
walking at all (the pid-gate reorder's twin); and an over-cap walk
falls back to the own mtime for exactly the keyed homes the registry
has POSITIVELY freed — that answer is the ownership proof the run
branch's pid gate provides — so a huge freed home is reclaimed by age
instead of leaking, while every other over-cap home keeps the D7 spare
and an entry whose name carries no parseable id keeps the spare but
stays removable on a completed stale walk. Worked example, now the
regression test: of two 4,097-file trees past the cap, the one under a
registry-freed id is removed and the one under an unknown id is spared,
an id-less huge tree is spared, and a small stale home beside them is
still swept (tests/codex-provider.test.ts). Verified against the
pre-fix tree: the freed huge home was spared (1 fail). Same class
audited: this sweep owns the only tree walk in the tree (the D9
audit's finding), and aider-session's own sweep already ages behind the
registry's positive-`free` gate. Docs: DESIGN §11, the compatibility
addendum, and the CHANGELOG record the split.

**Correctness-2 (minor 3: a resume's own setup deleted the home it was
about to open).** `openCodexSessionProviderHome` calls
`prepareRunDirParent` — the sweep — after `lookupForResume` had already
vouched for the home; the registry answers `free` for the ended record
(the removal condition), so a home idle past the 28-day gate was
deleted right there and the resume failed "missing or untrusted", a
refusal its own setup caused. The fix: `prepareRunDirParent` and
`sweepStaleRunDirs` take a `spareEntry` (src/hermetic-home.ts) — an
entry the caller is about to open is skipped before any stat or walk —
and the open passes its home's basename (src/codex-provider.ts:468).
Any OTHER codemux run may still sweep the home; this one refuses to
delete what it came to open. Worked example, now the regression test:
a keyed home and its config.toml both aged 29 days (the file too — a
fresh write inside would keep the home by the walk and hide the
verdict) with a stale sibling run directory beside it: the open
succeeds, the config survives, and the sibling is swept
(tests/codex-provider.test.ts). Verified against the pre-fix tree: the
open threw "missing or untrusted" (1 fail). Same class audited: the
resume's open is the only `prepareRunDirParent` caller that both
consults a registry and opens the keyed entry it just vouched for; the
other call sites (hermetic, scratch, the plain-run home, a fresh
session's home) have no entry they came for. Docs: DESIGN §11, the
compatibility addendum, and the CHANGELOG.

**Regression tests (13).** tests/session-aider-e2e.test.ts — the
slash-command refusal (two rejected shapes, one author-prefixed turn,
one spawn) and the killed-turn not-resumable verdict, with the
stdin-close and exit-143 tests extended to assert it.
tests/cli-stdin-prompt.test.ts — the run-path exit-64 refusal with the
harness never run. tests/new-adapters.test.ts — the predicate and the
validateRunRequest throw. tests/provider-override.test.ts — the
identity form's strip shapes. tests/codex-provider.test.ts — the hash's
identity-form equalities, the over-cap sweep split (the D7 test
rewritten to carry both verdicts), and the resume's spare.
tests/session-cli.test.ts — the registry identity end to end, with the
rotated-key resume and the cross-endpoint refusal.
tests/session-docs.test.ts — five pins: the slash rule on both paths
and in code, the identity form in every doc and at the seam, the
not-resumable verdict, the sweep's registry-before-walk split, and the
resume's spare.

**Gates.** `bun x tsc --noEmit` clean. `make release-gate` (with
`COPILOT_PKG_CACHE_HOME` redirected to the scratch cache): **exit 0**
— "Release gate passed" — runtime, typecheck, shell, test:coverage,
contracts (**3 pass / 0 fail**, 11 harness version probes exercised),
sandbox contract, smoke, `bun audit`, frozen-lockfile dry-run, help
and verify invocations. Test stage, quoted from the gate log
(scratch/session-14c66a93/gate-d10.log): **1571 pass / 0 fail /
2 skip** (1573 tests) — a mid-round snapshot, not this round's final
counts: the final tree carries 16 more tests than that log saw, and in
that runner two tests skipped where this runner skips six. No clean
full-suite log of the round's final tree survives — both scratch
test-coverage logs are mid-fix (test-coverage-d10.log: 1582 pass /
6 skip / 1 fail, exit 1; test-coverage-d10-r2.log: 1554 pass /
6 skip / 29 fail), each captured while a fix or revert-check was
half-applied — so the final counts are pinned by arithmetic and
confirmed by the round-11 audit, which ran the full suite on the
merged tree this round produced: round 9 ended at 1570/0/6 (1576
tests); 1576 + exactly this round's 13 tests = 1589 tests; measured
**1583 pass / 6 skip / 0 fail** (1589 tests across 59 files). The
task's 1554/0/2 baseline differs in the four tests behind
`processTableReadable()` (src/process-table.ts:48), which skip in this
runner as in every round since — the sandbox denies `posix_spawn
/bin/ps` (EPERM); 0 fail at both. `check_american.py` over the changed
prose (21 files: README, CHANGELOG, both design/compatibility docs,
and the round's nine source and seven test files' comments): **0
hits, exit 0**.

**Deviations and judgment calls.** (1) The session-path rejection
reason is `unsupported`, the taxonomy's member for an input the agent
will not relay — not a new reason, and not `autonomy_escalation`, which
is reserved for permission allows. (2) The check judges harnessText,
after the author prefix is applied: the argv text is what aider
dispatches, and a `[prefix] /cmd` line is model text (pinned both
ways). (3) The run-path refusal is `UsageRefusalError` mapped to exit
64 — a caller fix, not a run failure; that test needs `--auto high`
with `--no-sandbox` because aider read-only without a sandbox is
refused earlier (a pre-existing rule) and the slash rule would never be
reached. (4) The identity form strips by string slice, not
`new URL().toString()`, which re-spells the URL and would break string
comparison; the home hash reads the same form so a rotated key cannot
fork a session's home, and no query-carrying homes exist to migrate.
(5) The sweep's gate order is own-mtime floor, registry, walk, with the
over-cap fallback granted only to keyed homes with a positive `free`
answer — the ownership proof — while id-less entries keep the D7
spare. (6) The resume's spare is scoped to the entry name, skipped
before any stat or walk; the default registry consult (an absent id
answers `free`) is exactly the finding's condition. (7) Two pre-fix
verification incidents, both caught and corrected: the F5 test's first
draft passed under revert because the freshly written config kept the
home by the walk — the test now ages the whole tree and fails as
required; the F1 session-path revert-check ran after the gate (tree
restored byte-identical, the file re-run green, 25/0), so the gate's
verdict applies to the final tree. (8) Two source comments were
rewrapped so the docs-pin suite's single-line pins hold (the collapse
keeps wrapped comment lines' leading `*` and `//`): hermetic-home.ts's
positive-reading sentence (a D9 pin) and codex-provider.ts's
hash-input sentence. Everything else in the task ran to completion.

## Review fixes, round 11

Every finding of `scratch/session-14c66a93/review-d11-findings.md`
(prompt D, round 11) is fixed — one correctness major that blocked,
one correctness minor, and one contracts minor — with the same class
audited across the other session drivers and every removal site in the
tree. The operator note is followed as written: a graceful end
(stdin-close or shutdown) runs a turn whose spawn is still pending to
completion through the normal end path with its grace period, pinned
by the exact trigger (one user line piped into a sandboxed session,
the opencode original and the aider twin) through the fakes; only a
signal, timeout, or crash end kills a late child on arrival; and the
version stays at 0.10.0.

**Correctness (major, blocks: one prompt then EOF killed the turn
before it ran).** Under `-s` every turn's spawn goes through
`assertCompatibleScode` — a real `scode --version` subprocess
(src/cli-runtime.ts:114) — so each opencode and aider turn has a
window where its child does not exist yet.
`printf '{"type":"user","text":"fix the bug"}\n' | codemux session -a
opencode -s` closes stdin while that window is open: the end path
began with the turn's spawn still pending, and its late-spawn branch
awaited the spawn then immediately `late.requestStop()` — the turn
died before it ran, its `turn_started` was answered only by synthesis,
and the session's one prompt was never delivered. Same for aider. The
fix (both turn-per-process drivers, src/session/opencode-driver.ts and
src/session/aider-driver.ts): a GRACEFUL end reason (`stdin-close`,
`shutdown`) treats the late child like a landed one — `finish` wires
the child (`turnProc` and its exit handler), delivers the payload
itself (the turn's prompt, kept in the new `turnPrompt` field, written
raw to opencode's stdin; the canned `HEADLESS_NEGATIVE_RESPONSES` on
aider's), half-closes, and drains through the same `awaitEndAnswer`
grace the landed path uses; only `signal`, `timeout`, and `crash` keep
the D5 kill-on-arrival. `startTurn`'s finished-arm reads the new
`endReason` field and defers — returns without touching the child —
exactly for the graceful reasons: `finish`, whose `await spawn`
registered first (startTurn sets `turnSpawn` and awaits before any end
path can run), is the single writer that wires the child, so the
ordering is guaranteed rather than racy. The D5 invariant survives
intact: the child runs INSIDE `finish`, so it is stopped and its tree
settled BEFORE done resolves (the CLI's cleanup — for opencode, the
turn's provider-config removal — runs the moment done does), and a
harder end arriving during the drain (a signal bumping `endExitCode`
to 143) still cuts the grace short through `awaitEndAnswer`'s
predicate. A late child that cannot take its payload (it died on
arrival) reports the delivery failure and falls back to the kill; the
synthesis answers the turn failed. The graceful arm additionally
requires the FSM to still hold the turn open — belt-and-suspenders,
since a pending spawn implies an open turn — so a late child can never
be wired into a session whose turn was already answered. Worked
example, now the regression tests — the operator note's exact trigger
through the fakes: opencode takes one user line, then the caller's
stdin close with the spawn held 250 ms; the turn completes with the
fake's answer ("Done: scenario:basic one"), `session_ended` carries
reason `stdin-close`, exit_code 0, `resumable: true`, and the fake's
prompts.jsonl holds exactly the one prompt; the aider twin records
exactly the 128 canned-negative bytes on the fake's stdin,
`--message=scenario:basic one` in argv, both the user block and the
reply in the history, and the same resumable verdict
(tests/session-opencode-e2e.test.ts, tests/session-aider-e2e.test.ts).
The two D5 kill-arm tests were retitled to the timeout end
(`sessionTimeoutMs` 100 with the spawn still pending) so the hard-end
kill stays pinned where the note leaves it. Verified against the
pre-fix tree by reverting each driver in isolation to its staged form:
each new test failed on its own driver (2 fail — the turn synthesized
`interrupted`, the prompt never delivered), fixes restored, suites
green. Same class audited across the other session drivers: claude/zai
(src/session/driver.ts), codex (src/session/codex-driver.ts), and agy
(src/session/agy-driver.ts) attach their one child process
synchronously before `run()`, and their end paths never await a spawn
— there is no pending-spawn window on those harnesses, so the defect
class is the two turn-per-process drivers only. Docs: README
(live-sessions intro), DESIGN §11, the compatibility addendum (both
harness paragraphs), and the CHANGELOG's D11 bullet.

**Correctness (minor: one undeletable stale entry failed every later
run's sweep).** Both branches of `sweepStaleRunDirs` called `rmSync`
unguarded (src/hermetic-home.ts), and the sweep runs inside
`prepareRunDirParent` — so a stale entry whose subtree could not be
removed (a sandboxed child's directory without write permission; Bun
surfaces the stall as ENOTEMPTY) threw out of the sweep and failed
every later codex override run, hermetic run, and session start that
reaches it, until someone removed the directory by hand. The fix: both
branches route their removal through `removeSweepEntry`, which warns
on stderr and moves on — the rule the other sweeps already carry
(opencode-hermetic, droid/opencode/pi-provider, aider-session),
message shape included. Worked example, now the regression test: a
stale run directory and a stale keyed session home, each holding a
0o500 no-write subtree, both aged past their gates, beside a
deletable stale sibling home — `prepareRunDirParent` returns normally,
the locked entries stay (warned), and the sibling is swept
(tests/codex-provider.test.ts). Verified against the pre-fix tree by
reverting the file to its staged form: the sweep threw out of
`prepareRunDirParent` (1 fail), fix restored, green. Same class
audited across every removal site in the tree: the four sweeps named
above already warn and continue (they were the pattern mirrored),
`removeAiderSessionHistory` and the codex home settlement paths run
inside callers that already catch and report their failures, and the
launcher's own teardown is best-effort by design; only this sweep's
two branches lacked the guard. Documented in the CHANGELOG's D11
bullet.

**Contracts (minor: the report had no round-10 record and carried a
pre-D10 sweep rule).** The report records every round as a section and
is pinned as a maintained contract document, but it ended at round 9
while 39 sites in `src/` and `tests/` cite "review D10", and its
round-9 section still stated "A session home keeps the D7 spare on an
over-budget walk" as the rule — contradicting the D10 code
(src/hermetic-home.ts:314-324 removes a keyed home the registry has
POSITIVELY freed even over budget). A reader of the report alone got
the pre-D10 rule and no record that the D10 security fix exists. Fixed
both: the round-9 sentence now names itself as that round's state with
a forward pointer to the superseding rule, and the round-10 section
above is appended from the round's prepared draft
(scratch/session-14c66a93/report-d10-section.md) with its Gates
paragraph completed from the surviving logs — the gate log's test
stage is quoted as the mid-round snapshot it is (1571/0/2, 1573
tests), the missing final-tree full-suite run is stated plainly (both
scratch coverage logs are mid-fix), and the final counts are pinned by
the round-9 end plus the round's 13 tests, then confirmed by this
round's audit measurement of the merged tree (1583/6/0, 1589 tests).

**Regression tests (five).** tests/session-opencode-e2e.test.ts and
tests/session-aider-e2e.test.ts — the graceful-late-turn tests (the
operator trigger through the fakes) and the retitled D5 timeout tests
keeping the hard-end kill pinned. tests/codex-provider.test.ts — the
undeletable-entry sweep test. tests/session-docs.test.ts — two pin
tests: the graceful-late rule across README, DESIGN, and the
compatibility doc, the CHANGELOG, and both drivers' comments (the
hard-end kill arm pinned present on both), and the sweep's
warn-and-continue rule in code and the CHANGELOG.

**Gates.** GATE_PLACEHOLDER

**Deviations and judgment calls.** (1) The two D5 tests were rewritten
from the shutdown end to the timeout end: the operator note moves a
shutdown plus pending spawn into the graceful class, so their old
shape pinned behavior the note retires; the kill-on-arrival arm itself
stays pinned through the timeout twin on both drivers. (2) A first
draft of two docs pins spanned wrapped comment lines and failed — the
suite's collapse keeps the leading `*` of wrapped comment lines (the
convention D10's deviation 8 recorded) — so the pins were shortened to
single-line phrases instead. (3) The round-10 section's Gates
paragraph quotes the mid-round gate log rather than re-running the D10
gate now: the tree has moved (round 11's changes), so a re-run would
measure this round, not round 10 — the honest record is the log that
exists plus the arithmetic and the audit measurement. Everything else
in the task ran to completion.
