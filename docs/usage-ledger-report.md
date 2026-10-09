# The per-call usage ledger and `codemux calls` (0.11.0)

Task report, 2026-10-08. Branch `usage-log-2` (cut from main at 0.10.0).
Task text: `scratch/usage-log-reference-report.md` is the earlier attempt
this task's brief named as reference-only; nothing from it was applied —
the reference patch was read for ideas, and every line here was written
against the current tree.

**Bottom line: all four build items are done, the gate is green, and the
ledger is proven live through `./bin/codemux` alone** — a zai run whose
receipt carries real usage and the served model, a two-turn zai session
(plant/recall) that wrote two `session_turn` records plus the closing
`session` record with the cumulative cost, and an opencode run against
the override gateway whose receipt names `localhost:8011` as the
provider. `make release-gate` exits 0. Nothing is committed; the tree is
staged with `git add -A`, as asked.

## Deliverables, item by item

1. **The ledger — done.** `src/call-log.ts` (548 lines) appends one JSON
   line per completed `run` and `check` (wired in `src/launch.ts`'s
   `recordCompletedLaunch`, after `processRunResult` on both paths) and
   per completed session turn plus one closing line per session (wired
   beside every `turn_completed`/`session_ended` emission in all five
   session drivers). Location follows `sessionRegistryPath`'s platform
   rule: `~/Library/Application Support/codemux/calls.jsonl` on macOS,
   `~/.local/state/codemux/calls.jsonl` elsewhere — derived from `$HOME`
   alone, never `$XDG_STATE_HOME` (the registry's own rule; see round
   ul2, contracts 5). `CODEMUX_CALL_LOG=<absolute path>` relocates;
   `=off` disables. Directory 0700 at creation, file 0600 and
   re-tightened when looser; an existing directory is tightened only
   when it is the default state directory (round ul2, security). Each
   append is
   one `writeSync` on an `O_APPEND` descriptor, so concurrent runs never
   interleave. A ledger failure warns once on stderr and never fails the
   run (pinned end to end: stdout stays byte-for-byte the reply, and the
   default path's EPERM under a restricted runner produced exactly that
   warning while the run exited 0). The record is flat, 16 fields always
   present (`ts`, `kind`, `agent`, `model`, `model_effective`, `provider`,
   `session_id`, `turn_id`, `autonomy`, `hermetic`, `sandboxed`,
   `exit_code`, `finish`, `duration_ms`, `cwd`, `usage`), with
   `provider` the override base URL's host or `default` — never a key —
   and `usage` the envelope's block, all-null when the harness reports
   nothing.
2. **`codemux calls` — done.** `src/calls-command.ts` (448 lines):
   newest-first table of the last 20 by default, `-n/--limit`
   (1..100000), `-a/--agent` (validated), `--since <duration|ISO>` (an
   unusable value — neither shape, or a duration whose cutoff falls
   outside the date range — is a usage error at exit 64, never a
   silently empty view; round ul7),
   `--json` (raw lines), `--sum` (totals over the shown records with
   closing `session` summaries folded per field — a summary contributes
   only the fields its shown turns left unreported, so tokens come from
   the turns, never twice, and the claude family's session cost — null
   on every turn — comes from the summary; a null field totals to
   "unknown" with the count of unreported records, never zero). Reads
   are bounded to a 16 MiB tail; corrupt or wrong-shaped lines are
   skipped and counted on stderr, never fatal.
3. **Honesty — done.** The README's ledger section and the
   HARNESS-COMPATIBILITY addendum carry the per-harness table: claude,
   zai, and agy report full usage on plain runs; codex plain runs carry
   the blended `tokens used` figure from stderr (total_tokens alone —
   see round ul3), while `--result-json` runs report full usage;
   opencode reports tokens and cost when its endpoint does (the local
   vLLM gateway reports real tokens and zero cost); aider reports none
   headlessly, so its records carry null usage. Session turns: the
   claude family's per-turn cost is null by wire design
   (`total_cost_usd` is a session-lifetime figure the closing record
   adopts), codex reports per-turn usage, opencode sums its
   `step_finish` parts, agy reports per-turn usage, aider stays null.
4. **Docs, version, gate — done.** README (command row, `calls` options,
   result-envelope plain-run paragraph, the ledger section),
   `docs/HARNESS-COMPATIBILITY.md` 2026-10-08 addendum, CHANGELOG
   `## [0.11.0] - 2026-10-08` with upgrade notes (plain runs of
   claude/zai, agy, and opencode now launch structured output mode;
   codex plain runs keep human mode and the stderr figure — round ul3;
   the stdout contract is unchanged; wrapper-argv expectations change),
   `package.json` 0.11.0, smoke/Makefile `calls --help` lines, this
   report.

## Why plain runs changed

A receipt needs usage, and usage lives in the structured streams the
harnesses only emit when asked. So claude/zai launch with
`--output-format json`, agy with `--output-format=json`, and opencode
with `--format json` on every plain run. Codex is the exception (round
ul3, correctness-2 2): its `--json` stream carries every event with all
tool output, tens of MiB on an agentic run, so forcing it onto plain
runs pushed them past the 16 MiB stdout capture and killed them at exit
125 with the reply lost — a plain codex run keeps human mode instead,
stdout verbatim exactly as before the ledger, and the run's usage is
the blended `tokens used` figure human mode prints on stderr
(`total_tokens` alone; the figure mixes input and output and cannot be
split back apart). `src/plain-unwrap.ts` (630 lines) unwraps each
grammar back to the plain reply byte-for-byte (one trailing newline
when the message lacks one; opencode's parts each trimmed on their own
line), records `usage`/`servedModel` on the RunResult, and passes
unrecognized stdout through verbatim as the escape hatch. `--result-json`
now only changes codemux's own output shape for every harness but codex —
claude/zai, agy, and opencode commands are identical either way (pinned
as parity tests where the old suites pinned absence); a codex
`--result-json` run is the one launch that adds `--json` and
`--output-last-message`.

## Live verification (through `./bin/codemux` only)

Environment: this agent session runs under scode, so sandboxed codemux
runs exit 71 (`sandbox_apply: Operation not permitted` — the documented
nesting failure); the live checks ran `--no-sandbox --auto high`, and the
failed sandboxed attempt itself became a ledger receipt (exit 71, honest
null usage). `~/Library` is denied to this process tree, so the checks
relocated the ledger with `CODEMUX_CALL_LOG` (the feature's own env
var) and the session redirected HOME to a writable temp dir for the
registry, passing zai's key in-shell via `ZAI_API_KEY="$(cat ~/.zai)"`
(never printed; the ledger was grepped for key material, prompt text,
and the session codename — zero hits).

| Check | Result |
|-------|--------|
| `./bin/codemux run -a zai -p "Reply OK"` | stdout exactly `OK`, exit 0; receipt: `kind:"run"`, `model_effective:"claude-opus-5-5"`, usage 26410 in / 3 out / $0.1057 |
| two-turn `./bin/codemux session -a zai` | replies exactly `noted` then `marble-otter-77` (plant/recall); receipts: `session_turn` t1 20372/4, t2 19648+768 cached/20, closing `session` 40020 in / 768 cached / 24 out / $0.1607136, per-turn cost null by the claude-family rule |
| override run, `CODEMUX_OPENCODE_PROVIDER_*` against `http://localhost:8011/v1`, caps 4096/32768 | stdout `OK`, exit 0; receipt: `provider:"localhost:8011"` (host only), usage 24709 in / 2 out / cost 0 — the gateway's own report |
| default ledger path under the restricted runner | one stderr warning (`could not append to the call log`), run exit 0, stdout untouched — the never-fail contract |

The session probe is `scratch/live-session-probe.ts` (ignored); the
first attempt deadlocked waiting for `session_started` before sending
input — the claude family announces only after the first input is
forwarded (the mirror of opencode's deferred-identity rule), so the
probe sends turn 1 immediately. Both aborted session attempts also
wrote their closing `session` receipts with null usage.

## Gates (run this turn)

- `make release-gate` (with `COPILOT_PKG_CACHE_HOME` redirected and HOME
  pointed at a neutral temp home — see deviations): **exit 0**, "Release
  gate passed."
- Test stage, quoted from this turn's gate run (round ul8,
  re-measured): **1722 pass / 0 fail / 6 skip**, 1728 tests across 67
  files. Clean HEAD (main at 0.10.0, re-measured in round ul3 from a
  `git archive` extraction under the same neutral HOME): **1588 pass /
  0 fail / 6 skip**, 1594 tests across 59 files. The delta is exactly
  this branch's +134: 136 tests in eight new files (call-log 29,
  plain-unwrap 44, calls-command 29, call-ledger-e2e 20,
  session-call-ledger 2, test-mode-ledger 2, fixtures/test-mode-pin 1,
  usage-ledger-docs 9) minus 2 in `tests/adapters.test.ts`, which went
  106 → 104 (the old codex "no envelope unless asked" pins left with
  the always-on flags; the ul3 inverse pin and the claude parity pin
  replaced them). Round ul4 added 13 of those (two call-log, seven
  plain-unwrap, one calls-command, one call-ledger-e2e, two
  usage-ledger-docs); round ul5 added 8 more (three call-log, three
  plain-unwrap, two call-ledger-e2e); round ul6 added 12 (three
  call-log, three calls-command, two plain-unwrap, three
  call-ledger-e2e, one session-call-ledger) and the operator's hand
  application of the bunfig preload added its spawn pin (the second
  test-mode-ledger test, round ul6's closing note); round ul7 added 8
  more (five plain-unwrap, two calls-command, one call-ledger-e2e);
  round ul8 added the last 5 (one plain-unwrap, four call-ledger-e2e).
  The 6 skips are the environmental `skipIf` guards (platform,
  process-table readability, `/usr/bin/script`) that pre-date this
  branch.
- Coverage (% lines, this turn's full-suite run):
  `src/plain-unwrap.ts` 100%, `src/call-log.ts` 98.88%,
  `src/process-runner.ts` 94.95%, `src/launch.ts` 84.33%,
  `src/calls-command.ts` 76.95%; whole-source
  conservative line coverage 85.99% (gate threshold met, exit 0). The
  launch number rose from 81.76% (ul7) because round ul8's in-process
  test drives the new failure-receipt arm directly (`launchRunRequest`
  with a throwing adapter); the spawned-CLI receipts stay invisible to
  the reporter, as before. The
  launch and calls-command numbers stand below their in-process highs
  (98.48/82.49 at ul5) for the reason round ul6 recorded: the
  interrupted-run receipt and the `--since` window are proven by the
  spawned-CLI e2e tests, and a subprocess is invisible to the coverage
  reporter; the in-process suites cover the rest of both files as
  before.
- Contracts: **3 pass / 0 fail** — the flag contract exercised 14
  installed harness binaries (agy, aider, claude, codex, agent, copilot,
  droid, gemini, goose, kimi, openhands, opencode, pi, qwen) and the
  version-probe contract 11 (agy, aider, claude, codex, copilot, cursor,
  droid, kimi, openhands, opencode, zai), both quoted from this turn's
  gate log (round ul8, re-measured; the same counts as ul6 and ul7);
  cline is not installed here, and cursor's model-alias probe needs a
  cursor login.
- `bun run typecheck`: clean (inside the gate's `check` target).
- `python3 ~/.claude/skills/humanizer/scripts/check_american.py` on
  README.md, CHANGELOG.md, docs/HARNESS-COMPATIBILITY.md,
  docs/live-sessions-d-report.md, and this report: **0 hits, exit 0**.

## Deviations and environment constraints

1. **Two pre-existing suite failures under this runner, root-caused.**
   `tests/codex-provider.test.ts:285` and `:539` fail under this agent's
   sandbox because the real session registry
   (`~/Library/Application Support/codemux/live-sessions.json`) is
   unreadable here (EPERM, probed directly), so `sessionHoldState`
   answers `unknown` and the review-D5 fail-safe spares every keyed
   session home — a deletion needs a positive `free`. On an unrestricted
   runner the registry reads (or is absent) and both pass — proven this
   round ul3 by rerunning the file with the neutral HOME (17/17) while
   the unrestricted-registry baseline (`git archive` of clean HEAD,
   same neutral HOME) stays at 1588/0/6. The gate therefore ran
   with HOME pointed at a neutral temp home — the fresh-machine state
   (registry missing → `free`) — which is the operator-side condition,
   not a weakening of any rule. No test or source was changed for this.
2. **The registry HOME redirect also moved the live session's
   registry**; its records live under that temp home, and the ledger
   receipts (the deliverable) live in `scratch/live-calls.jsonl`,
   ignored, with the key-leak grep noted above.
3. **The gateway was up.** Earlier prompt-D rounds found
   localhost:8011 down; this turn it answered `/v1/models` with
   `clawvm-qwen32b-coder`, so the override-provider proof ran as
   specified. The bearer key in that run is a placeholder the gateway
   accepts, not a secret.
4. **The test-ledger guard is the `CODEMUX_TEST_LEDGER` preload**: every
   package.json test script loads `tests/setup.ts` with
   `--preload ./tests/setup.ts`, which sets `CODEMUX_TEST_LEDGER` to a
   per-process temp file; the variable is consulted only when
   `CODEMUX_CALL_LOG` is unset (`appendLedgerPath`), so an explicit
   relocation or `off` always keeps its word and no generic variable —
   `NODE_ENV` included — is read anywhere. History: the first cut wired
   the same preload through the package.json scripts; round ul2
   (contracts 2) replaced it with a source-level default keyed on
   `NODE_ENV=test` and deleted `tests/setup.ts`; round ul4 (contracts 1)
   reversed that — the generic-variable detection silently discarded an
   operator's real records — and restored the preload (see round ul4
   below). Round ul6 (major 1) found the remaining gap — a BARE
   `bun test`, no script and no preload flag, bypasses the redirect and
   writes fake records into the operator's real ledger. Its fix is
   bunfig.toml's `[test] preload = ["./tests/setup.ts"]`, which bun
   reads for every `bun test` in the repo: this session's sandbox
   refused the bunfig.toml edit (the file is guarded as sensitive
   config), so the operator applied the four-line block by hand after
   round ul6 and added the spawn regression test ("a bare `bun test`,
   with no `--preload` flag, still redirects through bunfig.toml and
   never creates the real ledger (ul6)",
   `tests/test-mode-ledger.test.ts`; the round's closing note records
   the hand application). The tree now carries both guards — the
   bunfig line and the package.json `--preload` flags — and a bare
   `bun test` loads the redirect either way.
5. **Reference material untouched**: `scratch/usage-log-reference.patch`
   was read for approach, not applied; extraction logic main already
   has was not re-implemented — `plain-unwrap` builds on the existing
   envelope parsers in `src/result-envelope.ts`.

## Files

New: `src/{call-log,calls-command,plain-unwrap}.ts`,
`tests/{call-log,plain-unwrap,calls-command,call-ledger-e2e,
session-call-ledger}.test.ts`, this report. Round ul2 added
`tests/{test-mode-ledger,usage-ledger-docs}.test.ts` and
`tests/fixtures/test-mode-pin.test.ts`, and deleted `tests/setup.ts`
(the preload it described became the source-level test-mode default);
round ul4 restored `tests/setup.ts` as the `CODEMUX_TEST_LEDGER`
preload (the source-level default is gone). Round ul4 also touched
`src/{process-runner,cli-runtime,run-context}.ts` (the `StdoutSink`
streaming seam) and rewrote the two test-mode files around the preload.
Round ul5's fixes stayed inside `src/{plain-unwrap,call-log}.ts` and
their test files; the file list itself did not change. Round ul6
touched `src/{launch,process-runner,cli-runtime,call-log,
calls-command,plain-unwrap}.ts`, the three id-adopting session drivers
(`src/session/{codex,opencode,agy}-driver.ts`), README (the `--since`
row, the ledger section), CHANGELOG, and this report; the test files
gained regressions in place (no new files). Round ul7 touched
`src/{calls-command,plain-unwrap}.ts`, the plain-path comments in
`src/adapters/{claude,zai,agy}.ts`, README, CHANGELOG,
HARNESS-COMPATIBILITY, and this report; the test files gained
regressions in place (no new files).
Modified:
README.md, CHANGELOG.md, docs/HARNESS-COMPATIBILITY.md,
docs/live-sessions-d-report.md (version header, pinned by
tests/session-docs.test.ts), package.json, Makefile, src/index.ts,
src/launch.ts, src/check-command.ts, src/types.ts,
src/result-envelope.ts, `src/adapters/{claude,zai,codex,agy,opencode}.ts`,
`src/session/{driver,codex-driver,agy-driver,opencode-driver,
opencode-session,aider-driver}.ts`, and the seven test files whose
command-shape pins moved with the structured-output flags (codex's
back to the `--result-json`-gated shape at round ul3). Finished with
`git add -A`; no commit, per the task.

## Round ul2 — the three-lens review fixes

A correctness-2/security/contracts review of this branch returned ten
findings. Every one is fixed at the root cause below, each with its
regression test; the stdout contract holds throughout (plain-run stdout
is the reply and nothing else, also on failure), no directory codemux
did not create or do not own is ever chmod'd, and `lstat` precedes every
chmod.

### correctness-2

1. **major — `--sum` counted session tokens twice** (`totalField` summed
   every shown record, so a session beside its own turns doubled them).
   Fix: `printTotals` sums the per-call records only —
   `src/calls-command.ts:150` filters `kind !== "session"` — and the
   output line names how many session summaries were excluded and why
   (`src/calls-command.ts:176-177`). The README `--sum` row and the
   CHANGELOG say the same. Test:
   `tests/calls-command.test.ts` "--sum excludes closing session
   summaries so their turns are not counted twice (ul2)" — a closing
   record of 30 over turns of 10 and 20 totals input=35 with the run,
   never 65.
2. **major — a failed plain run printed the raw JSON wire on stdout.**
   Fix: every error path now prints the harness's own text — the
   claude/zai error envelope's `result` (`src/plain-unwrap.ts:72-92`),
   the agy error envelope's `response` (`src/plain-unwrap.ts:117-140`,
   "" when the envelope carries none), and the text opencode streamed
   before its error line (`src/plain-unwrap.ts:254-269`) — exactly what
   plain mode would have printed, so stdout never carries the wire,
   failed or not. Tests: `tests/plain-unwrap.test.ts` (one per adapter)
   and the end-to-end `tests/call-ledger-e2e.test.ts` "a failed plain
   run prints the harness's error text, never the wire (ul2)" (a fake
   claude printing an error envelope; stdout is `the tool run failed`,
   the receipt keeps exit 1 and the envelope's usage).
3. **minor — an opencode run with an `error` line recorded no usage.**
   Fix: the error return carries the folded `step_finish` usage
   (`src/plain-unwrap.ts:266`) — the tokens were spent even though the
   run failed. Test: `tests/plain-unwrap.test.ts` "an error line keeps
   the streamed text on stdout and records the usage it reported (ul2)".
4. **minor — `isCallRecord` accepted a line without `usage`.** Fix: the
   check now validates the full flat shape — all 16 fields, the four
   kinds, and a usage block whose five counts are number-or-null
   (`src/call-log.ts:310-370`) — so a wrong-shaped line is malformed
   like an unparseable one and the README's "skipped and counted, never
   fatal" promise holds for lines that parse. Tests:
   `tests/call-log.test.ts` "a line without the record's full shape is
   malformed, never a record (ul2)" and `tests/calls-command.test.ts`
   "wrong-shaped JSON lines are skipped and counted like corrupt ones
   (ul2)".

### security

**major — the ledger changed permissions on any parent directory the
user named.** Three failure shapes: a relative or `~/` path chmod'd the
cwd or `$HOME`; a shared directory (`/tmp`, mode 777) failed EPERM
before the first `openSync`, leaving the ledger empty for the whole
process; and a swapped symlink would have been chmod'd through to its
target because `statSync`/`chmodSync` follow links. Fix
(`src/call-log.ts`): the append probes whether the directory exists
before `mkdirSync` (`:217-221`) and tightens only a directory it just
created or the default state directory (`:224`,
`defaultStateDir` at `:117`); `tightenDirectory` (`:257-269`)
`lstat`s first — a symlink is refused, never followed — and swallows
its own failures, so a tightening problem cannot stop the append;
`tightenFile` (`:272-282`) applies the same lstat-first,
never-fail-the-append rule after the record is on disk. Tests:
`tests/call-log.test.ts` "a relocated ledger never tightens an existing
directory (ul2)" (a 0777 directory stays 0777 and the record lands —
the `/tmp` shape), "the default state directory arriving wider is still
tightened (ul2)", and "a directory swapped for a symlink is not chmod'd
through its link (ul2)".

### contracts

1. **major — the plain-run error paths left the structured payload on
   stdout.** The same fix as correctness-2 2 above; the module header
   (`src/plain-unwrap.ts:15-20`) now states the failure rule.
2. **major — the test-ledger preload was wired only into package.json
   scripts while its header claimed bunfig.toml.** The bunfig.toml
   route is not editable in this session (the file is
   permission-guarded as sensitive config), so the fix is the task's
   other sanctioned option: a default that detects test mode, in the
   source. `appendLedgerPath` (`src/call-log.ts:177-187`) resolves
   every append: an explicit `CODEMUX_CALL_LOG` keeps its word, and an
   unconfigured process that looks like a test run — `NODE_ENV=test`
   (what `bun test` sets) or a main module matching bun's test-file
   pattern, covering a direct `bun test` behind an exported NODE_ENV
   (`isTestRun`, `:152-158`) — appends to a per-process throwaway file
   removed at exit (`testLedgerFile`, `:161-174`). `tests/setup.ts` is
   deleted and the `--preload` flags are gone from package.json, so
   there is exactly one mechanism and nothing to remember before
   running `bun test`. Tests: `tests/test-mode-ledger.test.ts` spawns a
   direct `bun test` with the variable stripped and a neutral HOME (the
   child is `tests/fixtures/test-mode-pin.test.ts`, which fails unless
   the redirect fired), and `tests/call-log.test.ts` "a test process
   with no configuration writes a throwaway, never the real ledger
   (ul2)" covers both detection arms in-process. Documented in README
   ("appends to a per-process throwaway file instead"), the CHANGELOG,
   and deviation 4 above. `bunfig.toml` is untouched.
3. **minor — "a corrupt line is skipped and counted, never fatal" did
   not hold for lines that passed the lenient shape check.** The
   `isCallRecord` fix (correctness-2 4) makes it hold, and the README
   now says "a corrupt or wrong-shaped line".
4. **minor — the `SessionCallContext` comment was wrong twice** ("only
   opencode sessions can be hermetic, so the other drivers pass false":
   aider forwards the flag too, and no session can be hermetic in this
   release). Fix: `src/call-log.ts:415-421` now states the real rule —
   the session CLI refuses `--hermetic` outright (src/session/cli.ts),
   opencode and aider forward their option, the claude family, codex,
   and agy hard-code false. Test:
   `tests/usage-ledger-docs.test.ts` "the session ledger comment states
   the real hermetic rule" refuses the stale wording.
5. **minor — the report invented an XDG rule the code deliberately does
   not have.** Fix: item 1 above now says `~/.local/state/codemux`
   derived from `$HOME` alone, never `$XDG_STATE_HOME` (the registry's
   own rule, now also stated in `callLogPath`'s doc at
   `src/call-log.ts:96-105`); README already agreed. Tests:
   `tests/call-log.test.ts` "elsewhere: state under HOME, never
   `$XDG_STATE_HOME` (ul2)" pins the behavior — `XDG_STATE_HOME` cannot
   move the file — and `tests/usage-ledger-docs.test.ts` pins the doc.
6. **minor — README and this report contradicted each other about the
   vLLM override gateway's usage.** The live receipt is the truth
   (`scratch/live-calls.jsonl`, 2026-10-08): the gateway reported real
   token counts — 24709 in, 2 out, 0 cached — and `cost_usd: 0`, a
   reported zero, not a missing figure. README ("What an endpoint
   reports is its own choice…", `README.md:745-751`) and the
   HARNESS-COMPATIBILITY addendum's OpenCode row (`docs/
   HARNESS-COMPATIBILITY.md:909`) now say exactly that; the stale
   "carried no usage on its `step_finish` lines" claim is gone. Test:
   `tests/usage-ledger-docs.test.ts` "the docs say what the vLLM
   override gateway really reported" refuses the stale wording on both
   pages.

## Round ul3 — the second three-lens review fixes

A second correctness-2/security/contracts review returned eight
findings. Every one is fixed at the root cause below, each with its
regression test; the stdout contract holds throughout (plain-run stdout
is the reply and nothing else — on success, failure, timeout, and
truncated output — and the wire never reaches stdout), and the gates
were re-run after the fixes (Gates above; `make release-gate` exit 0).

### correctness-2

1. **major — a cut-off last line put opencode's raw JSON on stdout.**
   `opencodePlainResult` returned the whole JSON stream as stdout when
   any single line failed to parse — a timeout mid-write of a
   `step_finish` line dumped the wire as the reply and the ledger
   recorded all-null usage though earlier `step_finish` lines had
   reported tokens. Fix (`src/plain-unwrap.ts:244-351`): the escape
   hatch opens only when NO line is wire evidence (`:296-300`); with
   wire evidence present, the broken lines become a bounded stderr
   diagnostic (`withBreakNote`, `:301-311`) and the reply is the text
   streamed so far plus the usage folded so far — on success, failure,
   and truncation alike. The claude family's sibling (a partial
   envelope, less likely: the envelope is one write at the end) fails
   the run with empty stdout and a stderr excerpt instead
   (`claudeFamilyPlainResult`, `src/plain-unwrap.ts:77-99`, the excerpt
   bounded to 80 flattened characters by `diagnosticExcerpt`,
   `:59-65`). Tests: `tests/plain-unwrap.test.ts` "a cut-off trailing
   line keeps the reply, the usage, and never dumps the wire (ul3)"
   (`:336`), "an unparseable line among wire lines is a diagnostic,
   never a dumped stream (ul3)" (`:354`), "a truncated envelope never
   passes through: failed run, empty stdout (ul3)" (`:65`), "a complete
   JSON object that is not the envelope fails the same way (ul3)"
   (`:78`); end to end, `tests/call-ledger-e2e.test.ts` "a cut-off
   trailing opencode line keeps the reply and usage, never the wire
   (ul3)" (`:279`) — a fake opencode whose last line is cut
   mid-`step_finish` at exit 124: stdout is `the reply so far`, stderr
   says "not the wire", and the receipt keeps input 8 / output 3 /
   total 11 / cost 0.
2. **major — plain codex runs captured the whole event stream into the
   16 MiB bound.** The always-on `--json` (`src/adapters/codex.ts`,
   the `cmd.push("--json")` the finding cited) streams every event with
   all tool output, so an agentic run's stream hit
   `MAX_CAPTURE_BYTES`, exited 125, lost the reply, and wrote no
   receipt — a run that succeeded before the branch. Fix (the brief's
   stderr-figure option, the one the old reference took): the gating is
   main's again — `buildRunCommand` adds `--json` and
   `--output-last-message` only under `request.resultJson`
   (`src/adapters/codex.ts:344-352`), `prepareRun` creates the
   fallback file and scratch state only for those runs (`:452-471`),
   and `processRunResult` routes a plain run through the new
   `codexPlainResult` (`:643-648`): stdout verbatim — human mode,
   exactly what the binary printed — with usage from the `tokens used`
   figure human mode prints on stderr (`parseCodexTokenTotal`,
   `src/plain-unwrap.ts:204-232`: ANSI stripped, exact-label match
   scanning from the end, locale-separated digits accepted;
   `total_tokens` alone because the figure is (input − cached) +
   output and cannot be split back apart). `check` builds plain
   requests, so probes are back to main's shape too. Test:
   `tests/call-ledger-e2e.test.ts` "a long plain codex run succeeds and
   receipts the stderr figure, not a 16 MiB stream (ul3)" (`:228`) — a
   fake codex that answers `--json` with ~17.7 MB of events exits 0,
   stdout is `the reply`, the receipt carries total_tokens 2048; unit
   pins for the figure parser at `tests/plain-unwrap.test.ts:205-282`
   and for the gated argv at `tests/adapters.test.ts` ("--result-json
   turns the event stream on; a plain run keeps human mode (ul3)") and
   `tests/hermetic.test.ts` (the hermetic and `--tools none` codex
   commands).

### security

1. **major — plain opencode output lost line breaks.** The old
   accumulation (`text += parse.text`) joined parts with nothing
   between them, breaking the byte-for-byte promise. Fix
   (`src/plain-unwrap.ts:277-281`): the join is pinned against
   upstream v1.18.18's run command (`scratch/upstream-run.ts`,
   `packages/opencode/src/cli/cmd/run.ts`: each completed text part
   `trim()`ed, empty-after-trim skipped, one `os.EOL` after every
   part; the banner, tool lines, and errors all print to stderr
   through `UI.*`, `scratch/upstream-ui.ts`). Tests:
   `tests/plain-unwrap.test.ts` "each text part prints trimmed on its
   own line, as plain mode does (ul3)" (`:284`) and "a multi-line part
   keeps its interior newlines — the live wire (ul3)" (`:297`), the
   latter pinned against the recorded live capture (part
   `alpha\nbravo\ncharlie` → `alpha\nbravo\ncharlie\n`; both captures
   of the same prompt live in `scratch/opencode-wire-probe/`).
2. **minor — one unexpected line dumped the raw JSON event stream as a
   successful reply.** The same fix as correctness-2 1: the hatch
   needs NO wire evidence at all (`src/plain-unwrap.ts:296-300`);
   anything else keeps the folded text and usage with the break on
   stderr.
3. **minor — `calls --sum` never counted claude/zai session cost.**
   Turns carry `cost_usd: null` (`total_cost_usd` is a session-lifetime
   figure only the closing `session` record adopts) and the ul2 fix
   dropped every `session` record from the totals, so the only record
   carrying the cost was never counted. Fix
   (`src/calls-command.ts:156-233`): a per-field fold — a shown
   closing record contributes usage field F only when no shown
   `session_turn` of the same `session_id` reported F. Tokens, which
   every family's turns report, come from the turns (never twice);
   cost, which claude/zai turns never report, comes from the summary;
   a summary whose turns are not shown contributes everything it
   reported; a summary with a null `session_id` matches no session and
   is excluded, with both counts named in the note line. README states
   the rule exactly (the `--sum` row, `README.md:353`, and the
   session-cost paragraph, `README.md:765-772`).
   Tests: `tests/calls-command.test.ts` "--sum folds session summaries
   per field: turns' tokens once, the session's cost (ul3)" (`:227`),
   "--sum counts a session summary whole when its turns are not shown
   (ul3)" (`:259`), "--sum excludes a session summary with no session
   id" (`:283`); the doc pin `tests/usage-ledger-docs.test.ts` "the
   README states the --sum session-summary fold (ul3)" refuses the ul2
   exclusion wording.

### contracts

1. **the no-text opencode path dropped the usage the wire reported.**
   Fix: the no-reply return carries the folded usage like the error
   path already did (`usage ?? emptyUsage()`,
   `src/plain-unwrap.ts:330-343`). Test:
   `tests/plain-unwrap.test.ts` "a wire with no assistant text is a
   failed run that still records its usage (ul3)" (`:404`).
2. **this report described a tree that no longer matched itself.**
   Stale line counts (call-log 325 vs 495, calls-command 266 vs 334,
   plain-unwrap 255 vs 351) and stale per-file test counts broke the
   "+57 delta" arithmetic; item 2's `--sum` description and item 3's
   codex plain-run claim predated the ul3 fixes, and the contracts
   count named binaries the probe does not exercise. Fix: every count
   and claim re-measured this turn against the current tree — the
   delta is +87 (Gates above), the per-file counts are call-log 21,
   plain-unwrap 26, calls-command 23, call-ledger-e2e 9, the contracts
   stage's eleven binaries — and this section records the round.
3. **`src/adapters/claude.ts:399` carried a stale comment** —
   "Anything that is not the envelope fails loudly" sat above both
   branches, false for the plain branch (the escape hatch passes
   non-envelope stdout through verbatim). Fix: the sentence is scoped
   to the `--result-json` branch (`src/adapters/claude.ts:399-404`)
   and the plain branch's own comment states the hatch and the
   broken-envelope failure (`:415-420`); zai's twin comment matched
   (`src/adapters/zai.ts:268-270`, plain branch `:281`).

A second session worked this same round in this worktree at the same
time; the two Round ul3 drafts were reconciled into this one section
(the duplicate appendix was removed), and every line reference and
count above was re-measured against the reconciled tree.

## Round ul4 — the third three-lens review fixes

A third correctness-2/security/contracts review returned five findings
(one security note was informational only). Every one is fixed at the
root cause below, each with its regression test; the gates were re-run
after the fixes (Gates above; `make release-gate` exit 0).

### correctness-2

1. **major — plain opencode runs buffered the whole JSON event stream
   into the 16 MiB capture bound** (`src/adapters/opencode.ts:351`
   always launches `--format json`, and every tool's output rides the
   `tool_use` events), so an agentic run's stream hit
   `MAX_CAPTURE_BYTES`, exited 125, lost the reply, and wrote its
   receipt against the truncated wire — the exact codex finding's
   mirror. Fix (the brief's stream-parse option): the run's stdout is
   never captured whole anymore. `StdoutSink`
   (`src/process-runner.ts:45`) is an incremental consumer the runner
   feeds decoded chunks (`readBounded`'s sink branch, `:109-119`); the
   bound now measures what the sink keeps (`keptBytes`), and
   `runDirect` and the sandboxed path thread it through
   (`src/launch.ts:199`, `:140`; `runSandboxedWithStdin`'s ninth
   parameter, `src/cli-runtime.ts:567`). `OpenCodePlainFold`
   (`src/plain-unwrap.ts:412`) implements it for opencode: one shared
   per-line fold (`foldOpenCodeLine`, `:277`) and one shared verdict
   (`opencodeVerdict`, `:312`) with the whole-capture unwrap, so the
   streamed and captured paths cannot drift (a parity test pins five
   verdict shapes through 7-byte chunk boundaries). The fold keeps the
   reply text, the folded `step_finish` usage, and the break notes;
   tool parts are dropped as they arrive, so no volume of tool output
   can reach the bound. One line larger than the whole capture bound is
   dropped unread with a note rather than buffered — `{`-shaped, it is
   the wire's grammar and drops as wire noise; anything else could only
   have been the escape hatch's plain stdout, and the fold reports
   over the bound so the run fails at the capture limit exactly as the
   whole-stream capture always did, never a silent truncation. The
   verbatim stream is kept only until the first wire line frees it.
   The adapter hangs the fold on the run context (`prepareRun`,
   `src/adapters/opencode.ts:415`; the `stdoutSink` member,
   `src/run-context.ts:81`) and `processRunResult` reads the verdict
   off the same object, falling back to the whole-capture unwrap for a
   caller without the sink (`:385`). Test (mandated by the brief):
   `tests/call-ledger-e2e.test.ts` "an opencode run with more than
   16 MiB of tool events still succeeds (ul4)" — a fake opencode
   emitting 1100 tool_use lines of 16 KiB (~17.9 MiB) around a real
   text part and step_finish exits 0 with stdout `the reply` and
   usage 8/3/11/$0; unit coverage in `tests/plain-unwrap.test.ts`
   ("OpenCodePlainFold" describe: tool parts dropped, oversized line
   dropped unread, hatch verbatim including the unterminated tail,
   over-limit marking, and the chunked-vs-whole parity). README's
   per-harness table now says what the path can and cannot know
   ("tool parts are dropped as they arrive… what the tool events
   carried… is not kept anywhere").
2. **minor — `agyPlainResult` passed unparseable `{`-shaped stdout
   through as the reply.** The claude family failed a broken envelope
   (review ul3); agy's twin path returned it verbatim as a successful
   run. Fix (`src/plain-unwrap.ts:147-166`): the claude family's rule —
   stdout that opens like the envelope but is not a parseable one (a
   kill or the capture cap cut it, or it is a complete but
   unrecognized object) fails the run with nothing on stdout and the
   bounded excerpt on stderr. Tests:
   `tests/plain-unwrap.test.ts` "a truncated envelope never passes
   through: failed run, empty stdout (ul4)" and "a complete JSON
   object that is not the agy envelope fails the same way (ul4)".
3. **minor — `appendCallRecord` could throw before its guard.**
   `appendLedgerPath(environment)` ran outside the `try`
   (`src/call-log.ts:195` pre-fix), and `testLedgerFile()`'s
   `mkdtempSync` could throw inside it — a hostile environment value
   (a non-string `CODEMUX_CALL_LOG`) or a full temp directory took the
   run down with a TypeError. Fix (`src/call-log.ts:172-181`): path
   resolution moved inside the never-throw guard, with the warn-once
   message shaped by whether the path resolved (pathless:
   "could not append to the call log: …"). Test:
   `tests/call-log.test.ts` "appendCallRecord never throws, path
   resolution included (ul4)" — a non-string `CODEMUX_CALL_LOG` and a
   non-string `HOME` each warn once and return.

### contracts

1. **major — `NODE_ENV=test` alone redirected an operator's real
   records to a deleted temp file** (`src/call-log.ts:142-145,183`
   pre-fix: `isTestRun` keyed on the generic marker `bun test` sets and
   every other test runner, and half the ecosystem, sets too). Fix: the
   test mode is scoped to codemux's own test runner through an env var
   codemux owns — `CODEMUX_TEST_LEDGER=<path>`
   (`src/call-log.ts:52`), consulted only when `CODEMUX_CALL_LOG` is
   unset, so an explicit relocation or `off` always keeps its word
   (`appendLedgerPath`, `:158`). The preload `tests/setup.ts` (new
   again, deleted in ul2 for the source-level default that this
   finding rejected) sets it to a per-process temp file, and every
   package.json test script loads it with `--preload ./tests/setup.ts`.
   `isTestRun` and `testLedgerFile` are gone; no generic variable is
   read. Tests: `tests/call-log.test.ts` "CODEMUX_TEST_LEDGER
   redirects appends; CODEMUX_CALL_LOG outranks it (ul4)" and "a
   generic NODE_ENV=test never diverts an operator's records (ul4)"
   (the operator-protection regression: `{NODE_ENV: "test"}` resolves
   to the REAL default path and the record lands there);
   `tests/test-mode-ledger.test.ts` spawns a `bun test --preload
   ./tests/setup.ts` child with both variables stripped and a neutral
   HOME, and `tests/fixtures/test-mode-pin.test.ts` fails unless the
   redirect fired (set, resolved to, and received a real append).
   README, CHANGELOG, and deviation 4 below say the new rule.
2. **major — a resumed claude/zai session double-counted its
   pre-resume cost under `calls --sum`.** The resume reuses
   `resumeId` as the session's id (`src/session/cli.ts:1136`), so the
   resumed run writes a SECOND closing `session` record under the same
   `session_id`, and each closing carries session-lifetime usage —
   `contributes()` (`src/calls-command.ts:185-189` pre-fix) admitted
   both, so the pre-resume cost landed twice (and pre-resume tokens
   would have too, had the turns not reported them). Fix
   (`src/calls-command.ts:186-206`): the writer cannot subtract (the
   resumed run's wire reports only the new session-lifetime total,
   blended with the resumed turn — "this run's share" is not
   recoverable at the write), so the fold marks it instead: the shown
   records are newest-first, the FIRST closing per session is the
   newest one and wins, and older closings of the same session are
   superseded — excluded from the totals and named in the note
   ("1 superseded session summary excluded"). README states the rule
   in the `--sum` row and the session-cost paragraph;
   HARNESS-COMPATIBILITY's claude/zai row says it too. Test:
   `tests/calls-command.test.ts` "--sum folds a resumed session's
   closings to the newest one (ul4)" — closings of $1.00 and $2.00
   under one session id over turns of 10 and 20 input total
   input=30, cost=$2.0000, never $3.0000.

## Round ul5 — the fourth three-lens review fixes

A fourth correctness-2/security/contracts review returned five findings
and one informational security note; the correctness-2 major, the
security major, and contracts 1 all named one root defect in the
opencode streaming fold. Every finding is fixed at the root cause
below, each with its regression test, and the note's hardening landed
too. The reviewer traced the code by hand (sandbox approval blocked
execution; the review's own suite run hit exactly the two environmental
failures Deviations 1 documents), so each fix below was proven by
running it — the end-to-end tests drive the real CLI. The gates were
re-run after the fixes (Gates above; `make release-gate` exit 0).

### correctness-2 and security (one defect)

**major — one long opencode tool line could still kill a plain run at
the 16 MiB capture limit.** All three findings trace to one root: the
pre-fix `keptBytes()` counted buffered bytes the fold can never return.
In the wire regime the buffer holds the unterminated partial line —
almost always a `tool_use` event on its way to being parsed and
dropped. Two failure shapes. First, while a partial line was still
under the bound, reply text plus buffer could cross it, and
`readBounded`'s sink check (`src/process-runner.ts:114`) threw the
output-limit error: exit 125, reply lost — the outcome the fold exists
to prevent. Second, once a line passed the bound and the drop tripped,
`push` kept appending that line's later chunks to the buffer (the size
check ran only outside the drop), so a line over about twice the bound
(~32 MiB — one `tool_use` event whose embedded output has no interior
newline) re-grew the buffer past it and killed the run again. Both ul4
pins fed a line of `MAX_CAPTURE_BYTES + 1`, under the twice threshold,
so they passed while the documented guarantee did not hold. Fix
(`src/plain-unwrap.ts`): the discard tail is never buffered — while the
drop is active, `push` drops whole chunks until the newline that ends
the oversized line (`:454-463`), so the rest of a line of any size
costs nothing; and `keptBytes()` (`:488-501`) counts only what the fold
can still return — the reply text plus the kept break notes once the
wire was seen, or the hatch's verbatim bytes (buffered tail included,
for it becomes raw byte-for-byte) while no line has yet been the wire.
An oversized line that is not wire-shaped could only have been the
hatch's plain stdout, so dropping it marks the run over the bound
(`overflowed`, `:446-449`, `:489`) and the run fails at the capture
limit exactly as the whole-stream capture always did — never a silent
truncation. The reviewer's secondary note — `keptBytes` sums decoded
characters against a byte-named bound, where the no-sink path counts
raw bytes (`src/process-runner.ts:120-124`) — was not taken: the sink's
residue is a string, the mismatch predates the fold, and it errs
permissive, never fatal. Tests: `tests/plain-unwrap.test.ts` "the
discard tail of an oversized line is dropped chunk by chunk, never
buffered (ul5)" (`:513` — 24 more MiB after the drop trips; keptBytes
stays under 1024 the whole way, and the reply, usage, and drop note
survive) and "an oversized line as the very last output, unterminated,
is still just dropped (ul5)" (`:538` — the stream ends inside the
discarded line; nothing of it is folded); end to end,
`tests/call-ledger-e2e.test.ts` "a 40 MiB opencode tool line still
succeeds: dropped unread, reply and usage kept (ul5)" (`:361`) — one
wire-shaped line of ~2.5× the bound, past the threshold the old pins
missed: exit 0 (125 would be the output-limit kill), stdout
`the reply\n`, usage 8/3/11/$0, the drop note on stderr — and "an
oversized opencode line as the last output, unterminated, still
succeeds (ul5)" (`:412`).

### security (the note)

**hardening — the ledger file's check-then-open window.** The append
checked the path's shape, then opened it, so a symlink swapped in
between was followed to its target; the reviewer graded this hardening
only, since it needs write access to the operator's own state
directory. Fix (`src/call-log.ts:194-232`): the open itself refuses —
`O_NOFOLLOW` where the platform has it, and `O_NONBLOCK` — with ELOOP
and ENXIO mapped to the existing "not a regular file" warning
(`:212-221`; a FIFO with no reader fails ENXIO instead of hanging),
and `fstat` on the OPEN descriptor — not the path, which a race could
swap after any path-based check — confirms a regular file before the
first byte is written (`:222-228`). Tests: `tests/call-log.test.ts` "a
symlinked ledger path is refused by the open itself, never written
through (ul5)" (`:259` — the target keeps its sentinel bytes; nothing
is written through the link) and "a special file that opens is refused
by the descriptor check before any write (ul5)" (`:287` — `/dev/null`
opens, the descriptor check refuses it).

### contracts

1. **minor — the class doc's "dropped unread … rather than buffered"
   was false past ~16 MiB of tail.** The same rework as the major
   above: the tail is dropped chunk by chunk
   (`src/plain-unwrap.ts:454-463`) and the class doc states the rule
   ("the chunks of its tail are dropped whole until the newline that
   ends it, so the line's full size never touches the residue",
   `:417`). The 40 MiB end-to-end test is the pin at ~2.5× the bound,
   where the ul4 pins' `MAX_CAPTURE_BYTES + 1` input passed while the
   claim did not.
2. **minor — `broken[]` was residue `keptBytes()` did not count,
   breaking the `StdoutSink` contract** ("`keptBytes` bounds that
   residue", `src/process-runner.ts:41-44`): one note per non-wire
   line, unmeasured — 16 MiB of 2-byte lines was ~8M notes of heap
   while keptBytes stayed near zero, and the run never failed at the
   limit. Fix: the fold keeps exactly the notes the verdict prints —
   the first two plus a count (`noteOpenCodeBreak`,
   `src/plain-unwrap.ts:284-287`; the verdict's note line,
   `:333-341`) — and `keptBytes` counts them (`:497`), so the notes
   are bounded residue the bound really measures. Test:
   `tests/plain-unwrap.test.ts` "break notes are bounded residue: a
   flood of noise keeps keptBytes near the reply (ul5)" (`:555`) —
   100,000 noise lines leave keptBytes under 1024 and stderr saying
   "100000 opencode output line(s) were not the wire".
3. **minor — `readCallLog`'s docstring claimed a throw that invalid
   UTF-8 cannot produce.** The decode is non-fatal (replacement
   characters); the affected lines land in `malformed`. Fix: the doc
   says so (`src/call-log.ts:372-375`). Test: `tests/call-log.test.ts`
   "invalid UTF-8 never throws: the broken line lands in malformed
   (ul5)" (`:412`) — a 0xff 0xfe pair mid-line does not throw, and the
   line counts as malformed.


## Round ul6 — the fifth three-lens review fixes

A fifth correctness/security/contracts review returned six findings (two
major, four minor). Every one is fixed in this tree, each with its
regression test; major 1's fix (the bunfig.toml preload) was applied by
the operator by hand after the round, because this session's sandbox
refused the bunfig edit — the closing note and deviation 4 record the
hand application. The gates were re-run after the fixes (Gates above;
`make release-gate` exit 0).

### correctness

1. **major — a bare `bun test` wrote fake records into the operator's
   real ledger.** The redirect lives in `tests/setup.ts`, loaded by the
   `--preload ./tests/setup.ts` flag on every package.json test script —
   but `bun test` typed directly runs none of those scripts, so a bare
   invocation (no script, no env var) appended every fake record to
   `~/Library/Application Support/codemux/calls.jsonl`. Fix (the brief's
   mandated mechanism): `bunfig.toml`'s `[test] preload`, which bun reads
   for every `bun test` in the repo, loads `tests/setup.ts` — and its
   `CODEMUX_TEST_LEDGER` redirect — before any test file; the explicit
   variable stays the mechanism (`appendLedgerPath` unchanged,
   `src/call-log.ts:158`), and no `NODE_ENV` fallback is introduced.
   bunfig.toml is permission-guarded as sensitive config (it grants
   code execution) and the edit was refused in this autonomous
   session, so the operator applied the four-line block by hand after
   the round and added the spawn regression test — a bare `bun test` on
   a tiny fixture with a clean environment, proving the real default
   path was not touched (the closing note below quotes it). The
   package.json `--preload` flags stay as a second guard; the bunfig
   line covers a bare `bun test` either way.
2. **major — `calls --since … --sum` dropped the cost of a claude-family
   session that started before the cutoff.** A closing `session`
   record's `ts` is the session's start, so a session that began before
   the window and ran turns inside it lost the only record that ever
   carries its cost. Fix (`src/calls-command.ts:387-401`): the window
   keeps a record whose `ts` is inside, and a closing `session` record
   also when any `session_turn` of the same `session_id` is inside —
   chosen over the window judging the session's end because the closing
   record carries no end timestamp to judge by. Test:
   `tests/calls-command.test.ts` "--since keeps a session whose turns
   are inside even when its closing record predates the window (ul6)" —
   a session with a turn inside and its closing record outside totals
   input=10 (the turn's) and cost=$0.0500 (the closing record's), while
   a session wholly outside stays out with its $9.00.
3. **minor — sessions without a native id merged under `""` in the
   totals.** The agy, codex, and opencode drivers recorded `""` for a
   session that ends before its first identity-bearing result, so every
   such session shared one key: the reader's fold matched the second
   session's closing record against the first's turns and a
   resumed-looking pair double-counted. Fix, both sides. Writers: each
   driver mints a codemux id at construction and keys its ledger
   records by it until the harness names its own (`codemuxSessionId`
   and `ledgerSessionId`, `src/session/agy-driver.ts:140,896-898`,
   `src/session/codex-driver.ts:237,2175-2176`,
   `src/session/opencode-driver.ts:143,999-1000` — native-first, so
   the ul4 resumed-session fold still groups a resume with its turns).
   Reader: `sessionKey` (`src/calls-command.ts:191`) treats `""` like
   null for the old ledgers that already carry it. Tests:
   `tests/session-call-ledger.test.ts` "two id-less sessions never
   share a ledger key: codemux's own id, never `""` (ul6)" (writer —
   two auth-failed sessions over the same ledger: four non-empty ids,
   each closing record matching its own turn, the two keys different)
   and `tests/calls-command.test.ts` "--sum never merges sessions that
   recorded `''`: the empty id keys nothing, like null (ul6)" (reader).
4. **minor — a run interrupted by a signal wrote no ledger record.**
   `runCapturedCommand`'s signal path exits 143 from inside its
   `finally`, so `recordCompletedLaunch` never ran and an interrupted
   run — tokens spent — left the ledger silent. Fix: the runner exposes
   a pre-exit hook (`onSignaled`, `src/process-runner.ts:237`, fired at
   `:416` right before the `process.exit(SIGNAL_EXIT_CODE)` —
   `SIGNAL_EXIT_CODE` exported at `:26`), the launcher wires its
   receipt into it on both paths (`src/launch.ts:107` direct, `:152`
   sandboxed through `runSandboxedWithStdin`'s tenth parameter,
   `src/cli-runtime.ts:571,605`), and the new
   `appendInterruptedLaunchReceipt` (`src/launch.ts:264`) writes
   through the same never-fail append: `exit_code` 143, nulls for what
   no structured stream reported, and the usage folded so far when the
   run's sink is an `OpenCodePlainFold` (`foldedUsage`,
   `src/plain-unwrap.ts:515`) — never a guess. Tests:
   `tests/call-ledger-e2e.test.ts` "a run interrupted by SIGTERM exits
   143 and still writes its receipt (ul6)" (spawned CLI, fake claude:
   exit 143, stderr "interrupted", one record with all-null usage) and
   "an interrupted opencode run receipts the usage folded so far
   (ul6)" (one record with the step_finish counts 8/3/11/$0).
5. **minor — reading a ledger over 16 MiB dropped one complete
   record.** The tail read always discarded through the first newline,
   so a window whose cut fell exactly between two records (the byte
   before the cut a newline) threw away one complete record with the
   partial line it never was. Fix (`src/call-log.ts:420-446`): the
   read checks the byte before the cut — a newline means the window
   already starts on a record boundary and stays whole; only a
   mid-line cut drops through the first newline. The docstring states
   the rule (`:403-407`) and README now says the view is bounded to
   the file's newest 16 MiB with no complete record dropped for the
   bound. Tests: `tests/call-log.test.ts` "a cut landing exactly on a
   record boundary keeps the complete record there (ul6)" (4096
   records of exactly 4096 bytes behind newline-terminated junk — all
   4096 survive, malformed 0) and "a cut landing inside a line still
   drops the partial line (ul6)" (junk with no trailing newline merges
   into the first record's line — that line goes, 4095 survive).

### security

**minor — terminal control injection through a stored model name.**
`src/calls-command.ts` printed `model_effective` (and `finish`)
unescaped, and a provider override serves whatever model string its
endpoint reports — one carrying an ANSI sequence or a C0/C1 control
would replay into the operator's terminal on every view of the table.
Fix, both ends: the append seam strips ANSI escape sequences (bodies
printable) and then every C0/DEL/C1 control — newlines included, so a
field cannot forge terminal output — from `model`, `model_effective`,
`provider`, and `finish` before the record is stored
(`sanitizeReportedString`, `src/call-log.ts:110-125`, applied at
`:208-215`; a provider that sanitizes to empty falls back to
`default`), and the table strips again at render for ledgers written
before the store-side strip (`src/calls-command.ts:102,117`); `--json`
keeps the stored bytes verbatim by contract. Tests:
`tests/call-log.test.ts` "harness-reported strings are stored stripped
of escapes and controls (ul6)", `tests/calls-command.test.ts` "the
table strips escapes and control characters a stored record still
carries (ul6)", and end to end `tests/call-ledger-e2e.test.ts` "an
escape-carrying model name from the wire is stored clean (ul6)" (a
poisoned envelope's `modelUsage` key `claude-\u001b[31mopus` is stored
as `claude-opus`; the file carries no escape byte at all).

### contracts

1. **minor — deviation 4 below asserted the reversed ul2 `NODE_ENV`
   mechanism in the present tense.** The opening described the
   source-level test-run detection that round ul4 deleted, presenting
   it as the live guard. Fix: deviation 4's opening now states the
   live mechanism — the `CODEMUX_TEST_LEDGER` preload the package
   scripts load — with the ul2 and ul4 reversals as history and the
   ul6 bunfig gap appended.
2. **minor — `keptBytes()` was documented in bytes but counted UTF-16
   code units.** `string.length` under-counts multibyte text 2-3×, so
   a multibyte reply could slip past the capture bound by that
   measure; the code and the `StdoutSink` contract comment
   (`src/process-runner.ts:41-44`) disagreed about the unit. Fix
   (count bytes, the unit the bound enforces): every sum in
   `keptBytes()` goes through `Buffer.byteLength`
   (`src/plain-unwrap.ts:67,502-509`), and the inline comment says the
   unit matches the whole-capture path's `bytesRead`. Test:
   `tests/plain-unwrap.test.ts` "keptBytes counts UTF-8 bytes, the
   capture bound's unit — not code units (ul6)" — `あああ` counts 9 in
   the hatch regime and 10 with its newline in the wire regime.

### Round ul6 closing note: the bunfig preload

The agent's sandbox refused to edit `bunfig.toml`, so the operator applied
the four-line `[test] preload = ["./tests/setup.ts"]` block by hand and
added the spawn regression test: `tests/test-mode-ledger.test.ts` "a bare
bun test, with no --preload flag, still redirects through bunfig.toml and
never creates the real ledger (ul6)" spawns `bun test` on the pin fixture
with a neutral HOME and no ledger variables, asserts the fixture passes
(the redirect fired), and asserts neither default ledger path exists
afterward. With the preload line removed the test fails; with it, it
passes.

## Round ul7 — the sixth three-lens review fixes

The sixth review PASSED and returned six minor findings (three
correctness, three contracts). Every one is fixed at the root cause
below, each code finding with its regression test; the gates were
re-run after the fixes (Gates above; `make release-gate` exit 0).

### correctness

1. **minor — `calls --since` with an out-of-range or unparseable
   duration was a silent empty result.** `parseSinceOption` validated
   its Date on the ISO branch only; the duration branch returned
   `new Date(now − count×unit)` unchecked, and a huge duration
   ("99999999999999w") overflows the representable date range into an
   invalid Date whose every window comparison is false — the command
   answered "no matching calls" at exit 0 as though the ledger were
   empty. Fix, both halves: the duration branch refuses a cutoff that
   lands outside the date range exactly as the ISO branch refuses an
   unparseable timestamp (`src/calls-command.ts:69-70`), and an
   unusable `--since` value — neither shape, or a duration whose cutoff
   overflows — is a usage error at exit 64 (the EX_USAGE convention the
   option validators set, `validation.ts`), with a message
   (`usageFail`, `src/calls-command.ts:337`, applied at `:360`), never
   a silently empty view. Only `--since` moved to 64: `--limit` and
   `-a` keep their exit-1 refusal, which predates this branch and is
   not what the finding named. README and the CHANGELOG state the rule.
   Tests: `tests/calls-command.test.ts` "a duration whose cutoff
   overflows the date range is refused, never an invalid Date (ul7)"
   (`:95`, unit) and "--since refuses a duration whose cutoff overflows
   the date range, never a silent empty table (ul7)" (`:230`, spawned
   CLI: exit 64, the message names the date range, stdout carries no
   "no matching calls"); the two existing refusal pins moved from exit
   1 to 64 with the same message (`:220`, `:613`).
2. **minor — a JSON array on claude/zai stdout passed through as the
   reply with no usage.** The escape hatch checked only for a leading
   `{`, so stdout starting with `[` — JSON, but on a launch that asked
   for JSON output, and not the envelope — was returned verbatim as a
   successful reply and the ledger recorded nulls. Fix: the line is
   JSON, not a leading bracket. `jsonShapedStdout`
   (`src/plain-unwrap.ts:97`) treats stdout as the structured wire when
   it opens with `{` or parses as JSON, so the claude family
   (`:120`) and agy (`:181`) fail any JSON value that is not the
   envelope — an array, a scalar, an unrecognized object — exactly as
   they fail an object a kill cut mid-write (the ul3 rule), while text
   that opens with `[` without being JSON keeps the hatch. The gate
   caught the first, over-broad cut of this fix: returning true for
   every `[` prefix broke the pre-existing hermetic pin
   (`tests/cli-run.test.ts`, the fake claude whose argv echo starts
   `[--safe-mode]` — `[`-shaped but not JSON), which is why the rule is
   "parses as JSON", and the boundary is now pinned on both sides.
   Tests: `tests/plain-unwrap.test.ts` "a JSON array, or any JSON that
   is not the envelope, never passes through as the reply (ul7)"
   (`:87`), "stdout that opens with '[' but is not JSON keeps the
   escape hatch (ul7)" (`:105`), "a JSON array on agy stdout fails
   like every other JSON non-envelope (ul7)" (`:248`); end to end,
   `tests/call-ledger-e2e.test.ts` "a JSON array on a plain run fails
   as a broken stream, never the reply (ul7)" (`:213`) — a fake claude
   printing `[{"items":[]}]` exits nonzero with empty stdout, the
   diagnostic on stderr, and a receipt of exit 1 with all-null usage.
3. **minor — `keptBytes` was quadratic in the fallback path.** The
   hatch regime re-measured `raw` and `buffer` with `Buffer.byteLength`
   on every call, and the runner calls after EVERY chunk
   (`src/process-runner.ts:114`), so a plain reply delivered in small
   chunks re-scanned the growing residue once per chunk. Fix: every
   term of `keptBytes` (`src/plain-unwrap.ts:542`) is now a running
   byte total the mutation that grows it maintains — `textBytes` and
   `brokenBytes` on the shared fold state (`:319`, `:337`),
   `bufferBytes` and `rawBytes` on the sink (`:488`, fed at `:516`,
   consumed with each extracted line, `rawBytes` accumulated per line
   at `:598`) — so the answer is O(1) and no chunk feeds a re-measure.
   Test: `tests/plain-unwrap.test.ts` "keptBytes is a running total:
   the per-chunk cost stays linear, not quadratic (ul7)" (`:541`) —
   the framing pin's CPU discriminator (`tests/session-process.test.ts`):
   the same 12 MiB of non-wire stdout fed in 8 KiB versus 1 MiB chunks
   must cost within 2× plus slack (`process.cpuUsage()`, best of two,
   no absolute bound; measured with the fix 19 ms versus 10 ms, with
   the re-measure reinstated 361 ms versus 4 ms — 80× apart), and both
   feeds keep exactly the bytes pushed (the counters cannot drift from
   the strings they measure).

### contracts

4. **minor — the oversized-line drop trigger counted UTF-16 code units
   against the byte bound.** The trigger read `this.buffer.length >
   MAX_CAPTURE_BYTES` while the ul6 fix made `keptBytes` count bytes:
   an ~18 MiB line of 3-byte characters is ~6M code units, under the
   16 MiB bound as the trigger read it, so the drop never tripped, the
   line stayed buffered, and keptBytes pushed the run to the
   capture-limit failure instead of dropping the wire-shaped line the
   class contract promises to drop. Fix: the trigger reads
   `bufferBytes` (`src/plain-unwrap.ts:525`) — bytes, the unit the
   bound and keptBytes both enforce — and the running counter the
   linearity fix introduced makes the check O(1) too. Test:
   `tests/plain-unwrap.test.ts` "the oversized-line drop counts bytes,
   the bound's unit — not code units (ul7)" (`:584`) — a wire-shaped
   line of 6M `あ` (≈18 MiB of bytes, ~6M code units): the drop trips,
   keptBytes stays under 1 KiB, and the verdict keeps the reply, the
   usage, and the drop note.
5. **minor — the report's line counts were stale.** The three "(N
   lines)" figures named files that had grown through six rounds of
   fixes: call-log 500 → 548, calls-command 368 → 448, plain-unwrap
   543 → 610 (re-measured with `wc -l` this round). The test-stage
   counts, per-file test counts, delta arithmetic, coverage, and
   contracts lines were re-measured with them — the Gates section
   above quotes this round's gate run throughout.
6. **minor — the "permission-blocked, ships in the handoff question"
   statements described a tree the branch no longer contained.** The
   operator applied the bunfig.toml `[test] preload` by hand after
   round ul6 and added the spawn regression test, so deviation 4 and
   the Round ul6 section's blocked/pending wording was stale. Both now
   describe the tree as it is: the preload is in bunfig.toml, the
   spawn pin is in `tests/test-mode-ledger.test.ts`, and the
   package.json `--preload` flags remain as a second guard (the Round
   ul6 closing note records the hand application).

## Round ul8 — the seventh three-lens review fixes

The seventh review PASSED and returned two minor findings (one
correctness, one contracts). Both are fixed at the root cause below,
each with its regression test; the gates were re-run after the fixes
(Gates above; `make release-gate` exit 0). The review's contracts
lens also asked for the report's stated counts to be re-measured —
done throughout, see the closing note.

### correctness

1. **minor — `OpenCodePlainFold.push` rescanned the whole partial-line
   buffer on every chunk.** The boundary search ran
   `this.buffer.indexOf("\n")` from offset 0, so one long line
   arriving in 64 KiB pipe chunks rescanned the 0–15 MiB already
   buffered on every chunk — and flattening the grown cons string per
   chunk is its own quadratic copy besides. A scratch probe measured
   the old shape at 1,911,076,575 characters scanned for one 15 MiB
   stream. Fix: the buffered partial line provably carries no newline
   — every exit from `push` leaves it that way — so the search runs
   over the newly arrived chunk alone, resuming where the previous
   pass stopped (`chunk.indexOf("\n", start)`,
   `src/plain-unwrap.ts:531`); `carried` holds the partial line and is
   consumed by the first line it completes, so each buffered byte is
   prepended at most once (`push`, `src/plain-unwrap.ts:507`; the
   invariant comment at `:520`, the class doc at `:467`). A scan
   offset into `this.buffer` alone would not have fixed it: searching
   the buffer, even from an offset, flattens the grown string per
   chunk, so the search is chunk-local by design. The existing
   7-byte-chunk parity pin (the sink and the whole-capture fold agree
   on every verdict shape) guarantees the chunk-local search finds
   identical boundaries. Test: `tests/plain-unwrap.test.ts` "one long
   line fed in 64 KiB chunks is scanned once, never rescan per chunk
   (ul8)" (`:584`) — a 15 MiB tool_use line (a reply line and a
   step_finish around it) fed in 64 KiB chunks with
   `String.prototype.indexOf` intercepted for the synchronous feed,
   counting the characters its calls examine: the total stays under
   4× the stream's own length (measured 15,794,415 characters against
   the 62,915,356 bound; the rescan shape measures
   len²/(2·chunk) ≈ 1.7 GiB), counted rather than timed so the host's
   speed cannot mask a regression, and the verdict still keeps the
   reply and the folded usage. Discrimination run: with `push`
   reverted to the old whole-buffer loop, exactly this test fails
   (43 pass / 1 fail); restored, all 44 pass.

### contracts

2. **minor — a launch whose capture rejected wrote no ledger line.**
   A run whose stdout is not valid UTF-8 rejects the capture after the
   harness ran and spent tokens (`readBounded`'s TextDecoder is
   fatal), and a `processRunResult` throw fails a launch the same way;
   both left no receipt, so the ledger under-counted real spend. Fix,
   in three parts. The runner marks the rethrown capture error
   `CapturedRunFailure` (`src/process-runner.ts:44`, thrown at `:390`)
   so the launch path can tell a failed capture from a pre-spawn
   refusal. The exit code comes from one shared rule the CLI itself
   uses (`unexpectedErrorExitCode`, `src/cli-runtime.ts:244`: 64 for
   a usage refusal, else 1), so the record matches the CLI's actual
   exit. And `appendFailedLaunchReceipt` (`src/launch.ts:348`,
   documented at `:338`) writes the receipt through the never-fail
   append whenever the harness ran — a rejected capture (the marker)
   or a post-capture throw (`captured` true) — on both the direct
   path (`src/launch.ts:113`, called at `:127`) and the sandboxed path
   (`:167`, called at `:185`), with the usage folded so far (the
   opencode fold's `foldedUsage`, all-null when none). A launch
   refused before the spawn — a missing sandbox, an unresolved binary
   — ran nothing and still records nothing, per
   `recordCompletedLaunch`'s documented contract (`:260`); the
   receipt-writing try covers only run + `processRunResult`, so a
   signal death keeps its own 143 receipt and no path writes two.
   README and the CHANGELOG state the rule. Tests:
   `tests/call-ledger-e2e.test.ts` "a run whose stdout is not valid
   UTF-8 still writes its receipt (ul8)" (`:254` — a fake claude
   printing `ok\377\376ok\n`: exit 1, the stderr diagnostic, one
   receipt with exit_code 1 and all-null usage), "the sandboxed path
   receipts a rejected capture the same way (ul8)" (`:302` — the same
   fake behind a passthrough scode; `sandboxed: true`), "a rejected
   opencode capture receipts the usage folded so far (ul8)" (`:345` —
   a step_finish, then invalid bytes; the receipt carries
   8 in / 3 out / total 11 / cost 0), and "a processRunResult throw is
   receipted; a pre-spawn refusal is not (ul8, in process)" (`:393` —
   `launchRunRequest` with a throwing adapter writes exactly one
   receipt; a missing-binary adapter writes none). Discrimination run:
   with `appendFailedLaunchReceipt` neutralized, exactly these four
   tests fail (16 pass / 4 fail); restored, all 20 pass.

### re-measured counts

The review's contracts lens found the report's stated counts stale.
All of them were re-measured this round and the Gates section above
quotes the new figures: line counts by `wc -l` (call-log 548,
calls-command 448, plain-unwrap 630 — the ul7-era tree measured 612,
so round ul7's "543 → 610" understated it by two; this round's edits
brought it to 630), the test stage (1722/0/6, 1728 tests), the
per-file test counts and delta arithmetic (+134), coverage
(process-runner 94.95%, launch 84.33%, whole-source 85.99%), and the
contracts counts. The ul7 section's figures stand as the history of
that round's re-measure; the Gates section is the current tree's.
