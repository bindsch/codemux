# lab-service features: would-be commits

The pre-commit `code-review gate` cannot run inside this sandbox, so nothing
was committed. Each feature below is one would-be commit, in order, with the
message body and the files it touches. Everything is staged (`git add -A`).

## Commit 1 — feat(run): --result-json returns the harness's result envelope with token usage

Body:

```
--result-json now works for Codex and Z.AI, and every envelope carries one
codemux-owned block. Codex is asked for its JSONL event stream
(`codex exec --json`, pinned against codex-rs/exec/src/exec_events.rs at
rust-v0.159.3, the installed codex-cli 0.159.3): the stream names the
session, the final assistant message, and the thread's cumulative token
usage as of the last completed turn, none of
which the human-mode stderr summary carries (it prints one blended total
that discounts cached input). codemux reduces the stream to an envelope
whose `result` is the final assistant message as plain text. Z.AI shares
Claude Code's `--output-format json` envelope. Claude-family envelopes keep
every harness field unchanged with the block appended:
"codemux": {"agent", "model", "usage": {"input_tokens", "output_tokens",
"cached_input_tokens", "total_tokens", "cost_usd"}, "session_id"}. Fields
the harness does not report are null, never guessed; usage means the same
thing per harness (uncached input, cache traffic, output, their sum), so
Codex's input_tokens, which includes cached input upstream, is normalized
before it lands in the block. session_id names a session a later
`--session resume:<id>` can continue and is null otherwise.
```

Files:

- `src/result-envelope.ts` (new) — envelope parsing/building: claude
  `--output-format json`, codex `--json` event-stream reduction, the
  normalized `codemux` block.
- `src/types.ts` — `ResultUsageBlock`, `CodemuxResultBlock`, capability
  `supportsResultJson`.
- `src/adapters/base.ts` — `processRunResult` seam; capability gate
  (harnesses without a verified envelope refuse the flag).
- `src/adapters/claude.ts`, `src/adapters/zai.ts`, `src/adapters/codex.ts` —
  `--output-format json` / `--json` on request; result post-processing.
- `src/launch.ts` — both launch paths (sandboxed and direct) run
  `processRunResult`.
- `src/index.ts` — `--result-json` option.
- `tests/result-envelope.test.ts` (new), `tests/cli-result-json.test.ts`
  (new); additions to `tests/adapters.test.ts`,
  `tests/adapters-extended.test.ts`, `tests/installed-contract.test.ts`.
- `README.md` (option row + "Result envelopes" section),
  `CHANGELOG.md`, `docs/HARNESS-COMPATIBILITY.md` (2026-10-03 addendum).

Verified live (2026-10-03, unsandboxed through `./bin/codemux`): codex
returned `{"result":"OK","codemux":{"usage":{"input_tokens":10997,
"output_tokens":5,"cached_input_tokens":13184,"total_tokens":24186},
"session_id":"01a10306-…"}}`; claude's envelope passed through with the
block appended (model `claude-haiku-4-5-20251001`, cost 0.0301436). The
codex event-stream format is pinned against upstream source at
rust-v0.159.3, which matches the installed codex-cli 0.159.3; the stderr
parser from the usage-log branch was rejected as the primary source (one
blended total, no message boundary, no session id).

## Commit 2 — feat(run): --session none|new|resume:<id> persists and continues harness sessions

Body:

```
--session <mode> on run carries a conversation across runs: none (the
default) keeps today's behavior exactly, including
--no-session-persistence on Claude-family runs and --ephemeral on Codex;
new persists the session and reports the id (in codemux.session_id with
--result-json, or named on stderr without it); resume:<id> continues that
session, prompt-only. Claude Code and Z.AI pin the id with
--session-id <uuid> and continue with --resume <id>; Codex persists under
CODEX_HOME and continues with `codex exec resume <id>`, reading the thread
id from its event stream. Harnesses without a verified mechanism refuse the
flag, as with --hermetic. Resuming needs the same session store — same
host, same CLAUDE_CONFIG_DIR/CODEX_HOME, same --cwd (a relocated home must
be passed through with --pass-env). A resume naming a session the harness
cannot find fails with exit code 66 (EX_NOINPUT), distinct from every other
failure, after the harness's own error on stderr; the classification rests
on the pinned failure wording (Claude Code 2.1.280: "No conversation found
with session ID:"; codex-cli 0.159.3: "no rollout found for thread id"),
and an upstream rewording degrades to exit 1 with the harness's stderr.
Codex refuses --session new/resume together with --hermetic, because its
private home is destroyed at exit; Claude and Z.AI allow the combination,
verified live (see docs/HERMETIC.md).
```

Files:

- `src/session.ts` (new) — mode parsing, UUID validation, missing-session
  signatures, `SESSION_MISSING_EXIT_CODE = 66`.
- `src/types.ts` — `SessionMode`, `RunRequest.sessionMode/sessionId`,
  capability `supportsSessions`.
- `src/adapters/base.ts` — session validation (mode enum, capability gate,
  UUID shape).
- `src/adapters/claude.ts`, `src/adapters/zai.ts` — `--session-id` /
  `--resume` replacing `--no-session-persistence`; id named on stderr for a
  plain `new` run.
- `src/adapters/codex.ts` — `--ephemeral` dropped for new/resume;
  `exec resume <id>`; `--json` rides along for `new` (thread id); stdout
  rebuilt as the reply; hermetic combination refused.
- `src/result-envelope.ts` — `codexResult` takes a resume-id hint.
- `src/index.ts` — `--session` option and the exit-66 classification.
- `tests/session.test.ts` (new), `tests/cli-session.test.ts` (new);
  additions to `tests/adapters.test.ts`, `tests/adapters-extended.test.ts`.
- `README.md` (option row + "Sessions" section), `CHANGELOG.md`,
  `docs/HERMETIC.md` ("Sessions and hermetic runs"),
  `docs/HARNESS-COMPATIBILITY.md` (2026-10-03 addendum).

Verified live (2026-10-03, unsandboxed through `./bin/codemux`): codex
`new` → `resume` recalled a planted word ("marzipan", thread
`01a1030f-10f6-79a1-8892-f90bb8fe8e29`); claude `new` → `resume` recalled
it too (haiku, session `55debc73-…`); claude `--hermetic --session new` →
`resume` recalled it ("licorice", session `5b4ee192-…`); missing-session
resumes exit 66 on both harnesses with the harness error still on stderr;
codex `--hermetic --session new` refused at validation. Sandboxed forms
were not live-runnable from this session (it already sits inside a sandbox
that cannot nest another); the scode wiring is covered by the fake-scode
e2e test, and scode's keeping harness state writable is the documented
property the hermetic private home already relies on.

## Commit 3 — feat(run): -f - reads the prompt from stdin

Body:

```
-f - reads the prompt from stdin, the same way a prompt file is read, so a
caller can pipe a prompt without staging a file (printf '…' | codemux run
-a codex -f -). Stdin is not argv: the read is bounded at 16 MiB (the
prompt-file limit) rather than the 32 KiB argv cap, though the argv rule
still applies to the prompt's content for harnesses that pass it as an
argument. An empty or whitespace-only stdin prompt is refused, and so is a
terminal stdin — a non-interactive command reading a TTY would hang until
the run's timeout; pipe the prompt instead.
```

Files:

- `src/index.ts` — `readStdinPrompt` (TTY refusal, bounded read), wired
  into the `-f` branch; `-f` help text mentions `-`.
- `tests/cli-stdin-prompt.test.ts` (new) — piped prompt reaches the
  harness, empty/whitespace refused, `-p` conflict, TTY refused (under a
  `script` pty), 16 MiB bound, and the 32 KiB argv rule still enforced for
  an argv-prompt harness (aider).
- `tests/helpers/cli.ts` — `runCli` can pipe stdin to the spawned CLI.
- `README.md` (option row + the `-f` paragraph), `CHANGELOG.md`.

Verified live (2026-10-03, unsandboxed through `./bin/codemux`):
`printf 'Reply with just OK.' | ./bin/codemux run -a codex --no-sandbox
--auto high -f -` → `OK`, exit 0.

## Gate

Run after all three features, from this session:

- `make check` — exit 0. Typecheck clean; 570 pass, 6 skip, 0 fail (576
  tests, 31 files; coverage 81.50% lines / 89.60% functions). Baseline
  before the work: 489 pass, 6 skip, 0 fail (495 tests, 26 files; 81.37% /
  89.44%). Delta: +75 passing tests, +5 files, no failures.
- `bun run test:contracts` — 1 pass, 1 fail. The failure is the
  environmental copilot probe (`EPERM: mkdir ~/Library/Caches/copilot` —
  this session cannot write `~/Library`), identical to baseline; it passes
  on a normal terminal.
- `check_american.py` over every changed prose and code file — clean.

Nothing was committed (the pre-commit `code-review gate` cannot run in this
sandbox); everything is staged with `git add -A` for the operator to commit
from a normal terminal, in the order above.

## Review fixes

A five-auditor review of the staged set (correctness, security, contracts,
edges) recorded findings on all three features. Every finding, blocker
through minor, is fixed below with one regression test each. The biggest
one invalidates a claim in this report: Commit 1's live envelope printed
`"session_id":"01a10306-…"` for a default (`--ephemeral`) codex run — that
was the bug, not the feature; the same run now prints `null`.

1. **`session_id` was reported for an unpersisted session (blocker, every
   auditor).** A default codex `--result-json` run launches with
   `--ephemeral`, so its thread id names nothing a later resume can reach,
   yet the block offered it as one. `codemux.session_id` is now null unless
   the run persisted a session (`--session new`, reporting the thread the
   stream named, or `resume:<id>`), for every harness — claude family via
   `persistedSessionId(request)`, codex via the session-mode check in
   `codexResult`. Fix: `src/result-envelope.ts`. Tests:
   `tests/result-envelope.test.ts` (claude persisted/not-persisted, codex
   default-null and new-thread-id), `tests/adapters.test.ts`
   (processRunResult null), `tests/cli-result-json.test.ts` (e2e null, plus
   a new `--session new` e2e that reports the thread id).

2. **A reported zero cache count became null (minor, two auditors).** Both
   parsers turned an explicit `0` into "not reported": the claude envelope
   and each codex turn. With multi-turn aggregation, one zero-cache turn
   nulled the whole run's `cached_input_tokens` while `total_tokens` still
   counted it — the two stopped reconciling. A reported zero now stays zero
   in both parsers. Fix: `src/result-envelope.ts`
   (`parseClaudeResultEnvelope`, `parseCodexEventStream`). Tests:
   `tests/result-envelope.test.ts` (claude zero stays 0 and total stays
   checkable; codex zero stays 0; the review's two-turn 0+10 repro now sums
   to 10 with total 40).

3. **An unreported `input_tokens` was guessed as 0 (minor).** The codex
   turn normalization computed `Math.max(0, (input ?? 0) - …)`, so a
   `turn.completed` usage object omitting `input_tokens` produced a
   fabricated 0. Each normalized field is now computed exactly from the raw
   fields it needs and stays null when any is unreported — a missing field
   stays missing. Fix: `src/result-envelope.ts`. Test:
   `tests/result-envelope.test.ts` (a turn reporting only
   `output_tokens: 5` yields input/cached/total null, output 5).

4. **`--hermetic` + `resume:<id>` continued a non-clean context (security).**
   A session created without `--hermetic` carries the creating run's
   instruction files, skills, and hooks into the conversation, so resuming
   it under `--hermetic` would not start from a clean context. The safer
   option was chosen: refuse every hermetic resume, in
   `BaseAdapter.validateRunRequest`, because codemux records no marker
   saying which sessions were created hermetically and cannot vouch for
   any of them. Claude/Z.AI keep `--hermetic --session new` (the session is
   created clean under `--safe-mode`); codex refuses both modes (its
   private home dies at exit). Documented in `docs/HERMETIC.md` ("Sessions
   and hermetic runs" rewritten) and `README.md`. Tests:
   `tests/adapters.test.ts` (claude resume throws, new does not; codex
   narrowed to `new` so the base rule shows through),
   `tests/cli-session.test.ts` (CLI-level refusal, exit 1).

5. **Codex approval policy never reached exec runs (security observation).**
   Autonomy emitted `-a <policy>` at the top level, before `exec`: codex's
   root-to-exec handoff copies only the shared options (`-s`, `-m`) and
   drops a root `-a`, `exec` has no `-a` of its own, and at 0.159.x `-a`
   accepts only `on-request`/`never` anyway — so `low`'s `untrusted` was an
   invalid value and every level's policy was silently whatever codex
   configured. The policy now rides the config override
   `-c approval_policy="…"` (serde values `untrusted`/`never`), the one
   channel that reaches `exec`, `exec resume`, and the TUI alike — the same
   mechanism `mapEffort` already used. Grammar verified against codex-rs at
   rust-v0.159.3. Fix: `src/adapters/codex.ts` (`mapAutonomy`). Tests:
   `tests/adapters.test.ts` (all four levels for fresh runs, a pinned
   resume run carrying the flags, TUI, `mapAutonomy`). Noted in
   `docs/HARNESS-COMPATIBILITY.md` and `CHANGELOG.md` (Fixed — released
   behavior changed).

6. **Dead version-fallback machinery contradicted its own test (minor).**
   `HarnessContract` carried `fallbackVersionArgs`/`fallbackPattern` and
   `probeHarnessVersion` implemented the branch, while the test suite fails
   if any contract ever defines a fallback (they were tried and withdrawn —
   see the copilot entry). A future contributor reading the interface
   comment would have implemented what the test forbids. The fields and the
   branch are gone; `probeHarnessVersion` runs one flag with no fallback.
   Fix: `src/harness-compatibility.ts`. Test:
   `tests/harness-compatibility.test.ts` (the source now fails the suite if
   either name returns).

Security observations needing no change, confirmed: claude/Z.AI re-pass
autonomy flags on every launch; session ids are UUID-gated in both
`parseSessionOption` and `validateRunRequest`, so a crafted id cannot
inject argv; `-f -` reads are bounded before the argv rules apply.

Docs: `README.md` (sessions/hermetic paragraph), `CHANGELOG.md` (session
bullet amended; new Fixed bullet for the codex approval policy),
`docs/HERMETIC.md`, `docs/HARNESS-COMPATIBILITY.md`.

Gate after the review fixes (this session):

- `make check` (inside `make release-gate`, exit 0): typecheck clean, 579
  pass, 6 skip, 0 fail — 585 tests across 31 files, coverage 81.55% lines /
  89.60% functions. That is +9 passing tests over the 570/6/0 above, one
  regression test per finding; no failures.
- `bun run test:contracts` — 1 pass, 1 fail, the same environmental copilot
  probe as baseline (`EPERM: mkdir ~/Library/Caches/copilot`; this session
  cannot write `~/Library`). `make release-gate` stops there, so the
  remaining steps were run directly and all exited 0: `sandbox-contract`,
  `smoke`, `bun audit` (no vulnerabilities), frozen-lockfile dry run,
  `run --help`, `tui --help`.
- `check_american.py` over every changed file — clean.

Verified live after the fixes (2026-10-03, unsandboxed):
`./bin/codemux run -a codex --no-sandbox --auto high --result-json -p
"Reply with: OK"` → `{"result":"OK","codemux":{…,"usage":{"input_tokens":
10996,"output_tokens":5,"cached_input_tokens":13184,"total_tokens":24185},
"session_id":null}}`, exit 0 — the default run reports `session_id: null`,
the total reconciles (10996 + 13184 + 5 = 24185), and the new
`-c approval_policy="never"` argv is accepted by the installed codex
0.159.3.

## Review fixes, round 2

Five auditors reviewed the staged 0.6.0 set again; every finding lived in
`src/result-envelope.ts`. All are fixed, each with a regression test. The
Codex JSONL format is now pinned against the installed `codex-cli 0.159.3`
by fetching the upstream sources at tag rust-v0.159.3
(`codex-rs/exec/src/exec_events.rs` for the event shapes,
`codex-rs/exec/src/event_processor_with_jsonl_output.rs` for the
semantics), cited in the comments of `parseCodexEventStream`.

1. **Codex failure diagnostics were discarded (correctness, Major).**
   `error` and `turn.failed` events carried the only record of why a run
   died (the JSONL processor prints them on stdout), and both result paths
   replaced stdout, so a usage-limit failure exited 1 with empty stderr
   under `--result-json`. The reduction now tracks the failure: a failed
   turn forces a non-zero exit even when codex's own was 0, `result` is
   null, `session_id` is null, and the diagnostic rides on stderr after
   codex's own output. An `error` the harness retried is superseded when
   its turn later completes (upstream keeps the run `Running` on
   `ServerNotification::Error`), and a `turn.failed` discards earlier
   `item.completed` messages, matching upstream's `self.final_message =
   None` on `TurnStatus::Failed`. Fix: `src/result-envelope.ts`
   (`parseCodexEventStream`, `codexResult`). Tests:
   `tests/result-envelope.test.ts` (failed turn discards messages; retried
   error superseded; fallback literal; every-channel failure) and
   `tests/cli-result-json.test.ts` (CLI-level: fake codex exits 0 with a
   `turn.failed` stream; the run still exits 1 with the diagnostic).

2. **`turn.completed.usage` is cumulative thread usage (edges, Major).**
   Upstream's `usage_from_last_total` copies `last_total_token_usage`, the
   running thread counter, so a resumed thread's snapshot includes every
   earlier run and a caller would double-count. The reduction keeps the
   last snapshot (replace, not sum — each snapshot is the same counter at
   a later point), and a resume reports null usage fields with a stderr
   note rather than a thread total the caller would read as one run's
   cost. A pre-existing test encoded the wrong per-turn-summing semantics
   and failed against the pinned truth; it now asserts the cumulative
   rule. Fix: `src/result-envelope.ts`. Tests:
   `tests/result-envelope.test.ts` (last-snapshot semantics; resume nulls
   with note).

3. **`session_id` was reported for failed runs (contracts, minor).**
   `persistedSessionId` and `codexResult` emitted the id whenever the mode
   was `new`/`resume` with no success check — a codex resume of a missing
   session could exit 66 while its envelope claimed the nonexistent id was
   resumable. Both families now withhold the id on failure, the rule the
   plain-text paths already had. Fix: `src/result-envelope.ts`
   (`claudeFamilyResult`, already gated in `codexResult`). Tests:
   `tests/result-envelope.test.ts` (failed claude run; failed codex resume
   at exit 66).

4. **Claude/Z.AI non-JSON stdout on exit 0 stayed a success (edges,
   Major).** `--result-json` launched with `--output-format json`, so
   plain-text stdout breaks the contract; the run now fails loudly —
   non-zero exit, the raw stdout kept for inspection, a stderr line saying
   what is missing. Fix: `src/result-envelope.ts` (`claudeFamilyResult`).
   Tests: `tests/result-envelope.test.ts` (strengthened to assert exit,
   success, stderr) and `tests/cli-result-json.test.ts` (CLI level).

5. **Several `modelUsage` entries fell back to the requested model (edges,
   Major).** `servedModel: null` for multiple models is a report (the run
   was served by more than one), but the `?? request.model` fallback
   replaced it; the block now reports null, and only a run that names no
   models at all falls back. Fix: `src/result-envelope.ts`. Test:
   `tests/result-envelope.test.ts` (block-level, with a requested model
   present).

6. **Partial Claude-family usage invented totals (edges, Minor).**
   `{output_tokens: 5}` produced `total_tokens: 5` by guessing the
   unreported counters as zero, and a one-sided cache report (read without
   write) summed the missing half as zero. `total_tokens` is now computed
   only when input, cached, and output are all reported, and
   `cached_input_tokens` only when both cache counts are; a reported zero
   still stays zero. An adapter-level test that expected the invented
   total was corrected with the rule. Fix: `src/result-envelope.ts`.
   Tests: `tests/result-envelope.test.ts`, `tests/adapters-extended.test.ts`.

7. **The 0.6.0 notes contradicted themselves on pass-through (contracts,
   minor).** The older `--result-json` bullet still said "passes it through
   unchanged" while the newer one described the appended codemux block
   both release. The older bullet now says the envelope is re-emitted with
   every harness field unchanged plus the block. The same stale sentence
   in `src/types.ts` and a stale "passes through verbatim with a warning"
   comment in `src/adapters/claude.ts` were updated with it, and the new
   failure semantics (failed runs, resume usage nulls, loud contract
   violations) are recorded in `CHANGELOG.md` and `README.md`.

Gate after the round-2 fixes:

- `make check` (typecheck, shell, coverage suite): 590 pass, 6 skip,
  0 fail — 596 tests across 31 files, coverage 81.63% lines / 89.39%
  functions. That is +11 passing tests over the round-1 gate's 579/6/0
  (585 tests): eleven new regression tests, one pre-existing test
  rewritten to the pinned cumulative semantics, one adapter test
  corrected off the invented total.
- `make release-gate` stops at `contracts` on the same environmental
  copilot probe as every baseline this session (`EPERM: mkdir
  ~/Library/Caches/copilot` — this sandbox cannot write `~/Library`;
  1 pass / 1 fail there, unchanged in kind from round 1). `runtime` and
  `check` passed inside the gate; the remaining steps were run directly
  and all exited 0: `sandbox-contract`, `smoke`, `bun audit` (no
  vulnerabilities), frozen-lockfile dry run, `run --help`, `tui --help`,
  `usage --help`, `verify --help`, both `verify --show-scode` variants.
- `check_american.py` over every changed file — clean.

Verified live after the fixes (2026-10-03, unsandboxed):
`./bin/codemux run -a codex --no-sandbox --auto high --result-json -p
"Reply with: OK"` → `{"result":"OK","codemux":{"agent":"codex",
"model":null,"usage":{"input_tokens":5108,"output_tokens":5,
"cached_input_tokens":19072,"total_tokens":24185,"cost_usd":null},
"session_id":null}}`, exit 0 — the ephemeral default reports
`session_id: null`, and the total reconciles (5108 + 19072 + 5 = 24185).

## Review fixes, round 3

Round 3 reviewed the same staged 0.6.0 tree. Nine distinct findings (the
file's correctness section duplicated its blocker as a Major); all are
fixed, minors included, each with a regression test. The round's rule, in
one place: `codexStreamVerdict` in `src/result-envelope.ts` decides every
codex event-stream run — a `turn.failed` or `error` event, a stream that
ends without a final assistant message, codex's own non-zero exit, or a
requested persisted session (`new`, `resume`) whose stream named no
`thread.started` id is a failure with a non-zero exit, `result: null`
where an envelope is emitted, `session_id: null`, and the diagnostic on
stderr — the same verdict with and without `--result-json`, for `new` and
`resume:<id>` alike. One scope note: a plain `resume` without
`--result-json` keeps today's passthrough (that run launches without
`--json`, so there is no stream to parse, and codex's own non-zero exit
already fails it); the verdict governs every path where codemux parses a
stream.

1. **Plain `--session new` ignored `stream.failure` (correctness Major +
   edges blocker, duplicated).** A `thread.started` + `turn.failed`
   ("Usage limit reached") stream with codex exit 0 exited 0 from codemux
   with empty stdout, a lost diagnostic, and stderr claiming the session
   persisted — while the identical events under `--result-json` correctly
   exited 1. The adapter path now applies the shared verdict: forced
   non-zero exit, `success: false`, the diagnostic on stderr, no
   "persisted" claim; drift (an unparseable stream) fails the run too,
   keeping the raw stdout for inspection the way the envelope path does.
   Fix: `src/adapters/codex.ts` (`processRunResult`) +
   `src/result-envelope.ts` (`codexStreamVerdict`). Tests:
   `tests/adapters.test.ts` (turn failure, thread-less stream, unparseable
   stream) and `tests/cli-session.test.ts` (CLI-level reproduction).

2. **Parsers accepted unrelated or incomplete output as success (edges
   Major).** Claude `{}` parsed into a successful envelope with null usage;
   an empty codex stream reduced to a null-everything success. The Claude
   parser now requires the envelope's discriminator (`type: "result"`), so
   `{}` fails loudly like plain text; the verdict's no-final-message rule
   fails empty and message-less codex streams (which also catches an
   interrupted turn — upstream clears its final message on
   `TurnStatus::Interrupted` without emitting `turn.failed`). Fix:
   `src/result-envelope.ts`. Tests: `tests/result-envelope.test.ts`
   (discriminator; empty stream; message-less stream) and
   `tests/cli-result-json.test.ts` (both, CLI level).

3. **A successful `--session new` without a `thread.started` id stayed
   successful with a warning (edges Major).** A run that promised a
   resumable session but could not name one now fails; `new` and `resume`
   alike, because `exec resume` runs the same event pipeline and
   re-announces the continued thread (verified against
   `print_config_summary` in codex-rs
   `event_processor_with_jsonl_output.rs` at rust-v0.159.3, and live
   below). The old "falls back to the id it resumed" behavior is gone: a
   stream without the id is drift, never a place to quietly trust the
   request's id. Fix: `codexStreamVerdict`. Tests:
   `tests/adapters.test.ts` (warning test rewritten as a failure test;
   resume-envelope test rewritten to the strict rule) and
   `tests/result-envelope.test.ts` (`new` and `resume` in one test).

4. **An unparseable successful resume still reported the resumed id
   (edges Major).** Failed envelopes now report `session_id: null`
   unconditionally — the resume-hint parameter is deleted from
   `codexResult`, so no code path can promise a session for a run whose
   stream codemux could not read. Fix: `src/result-envelope.ts`. Test:
   `tests/result-envelope.test.ts` (unparseable resume fails, exit 1,
   null id).

5. **Codex did not validate `sessionMode: "resume"` without `sessionId`
   (edges minor).** A programmatic request put runtime `undefined` into
   `codex exec resume`'s argv. The adapter now refuses it at validation
   with the same wording claude and zai use. Fix:
   `src/adapters/codex.ts` (`validateRunRequest`). Test:
   `tests/adapters.test.ts` (new and resume).

6. **`-f -` decoded stdin leniently (edges minor).** Malformed bytes
   became replacement characters, so the two advertised-equivalent prompt
   paths could submit different text; stdin now decodes with the same
   fatal UTF-8 decoder as a prompt file and errors
   (`-f - prompt must contain valid UTF-8`). Fix: `src/index.ts`
   (`readStdinPrompt`). Test: `tests/cli-stdin-prompt.test.ts` (raw
   `0xff` bytes piped; the `runCli` helper's stdin option widened to
   `Uint8Array`).

7. **A Z.AI envelope without `modelUsage` reported `model: null` (edges
   minor).** The run always passes `--model opus` when the request names
   none, but result processing saw the unchanged request. The default is
   now one constant (`ZAI_DEFAULT_MODEL`) used by `buildRunCommand`,
   `buildTuiCommand`, and `claudeFamilyResult`, so the envelope reports
   the model codemux selected. Fix: `src/adapters/zai.ts`. Test:
   `tests/adapters-extended.test.ts`.

8. **The README autonomy table still documented codex's removed `-a`
   arguments (edges minor).** The row now shows the real flags —
   `-s <mode>` plus `-c approval_policy="…"` per level, matching
   `mapAutonomy`. Fix: `README.md`.

9. **Z.AI shared Claude's session store (security).** `--session
   resume:<id>` on zai passed `--resume <id>` to the same `claude` binary
   with no separate `CLAUDE_CONFIG_DIR`, so both agents read and wrote
   `~/.claude/projects/<cwd>/`: a claude session — with whatever it read
   from the repository — could be resumed through zai and sent to
   `https://api.z.ai/api/anthropic`. The zai adapter now pins
   `CLAUDE_CONFIG_DIR` to `~/.claude-zai` (adapter-provided environment
   beats both the parent environment and `--pass-env`, so an inherited
   value cannot re-share Claude's store) and creates the directory in
   `beforeLaunch`, which every launch path calls (TUI included). The
   boundary is bidirectional: neither agent can resume the other's
   sessions (exit 66), and zai's user-level Claude Code settings move to
   `~/.claude-zai` — recorded in `CHANGELOG.md` (Changed), `README.md`
   (Sessions), and `docs/HARNESS-COMPATIBILITY.md`. The scode sandbox
   keeps env-named harness state writable, so sandboxed zai runs persist
   sessions to the private store unchanged. Fix: `src/adapters/zai.ts`.
   Tests: `tests/adapters-extended.test.ts` (getEnv value; execution-env
   precedence over an inherited `CLAUDE_CONFIG_DIR`; `beforeLaunch`
   creates the dir) and `tests/zai.test.ts` (full-env equality with the
   private dir pinned).

Gate after the round-3 fixes:

- `make release-gate` stops at `contracts` on the same environmental
  copilot probe as every baseline this session (`EPERM: mkdir
  ~/Library/Caches/copilot/pkg/darwin-arm64` — this sandbox cannot write
  `~/Library`; 1 pass / 1 fail there, unchanged in kind from rounds 1 and
  2). Everything before it passed inside the gate — `runtime`, `check`
  (typecheck, shell, coverage suite) — and every step after it was run
  directly and exited 0: `sandbox-contract`, `smoke`, `bun audit` (no
  vulnerabilities), the frozen-lockfile dry run, and all six
  help/`--show-scode` variants.
- The coverage suite inside the gate: **606 pass, 6 skip, 0 fail — 612
  tests across 31 files**, coverage 81.71% lines / 89.69% functions.
  Against the task's stated 574-pass baseline that is +32 passing tests;
  against round 2's 590 pass / 6 skip / 0 fail (596 tests) it is +16, all
  new regression tests for this round (skips unchanged at 6, fails 0
  throughout).
- `check_american.py` over all sixteen changed files — clean.

Verified live after the fixes (2026-10-03, unsandboxed, codemux only):

- `./bin/codemux run -a codex --no-sandbox --auto high --result-json -p
  "Reply with: OK"` → exit 0,
  `{"result":"OK","codemux":{"agent":"codex","model":null,
  "usage":{"input_tokens":5108,"output_tokens":5,
  "cached_input_tokens":19072,"total_tokens":24185,"cost_usd":null},
  "session_id":null}}` — the welcome `session_id: null` for the ephemeral
  default, total reconciling (5108 + 19072 + 5 = 24185).
- `… --session new --result-json -p "Reply with: OK"` → exit 0, same
  shape, `session_id: "01a10369-21a5-7710-a2b1-8c51819f2de9"`.
- `… --session resume:01a10369-… --result-json -p "Reply with just: OK2"`
  → exit 0, `result: "OK2"`, the resumed id back as `session_id`, all
  usage fields null with the cumulative-usage note on stderr — and the
  resumed stream carried `thread.started`, confirming the strict rule
  matches the installed codex-cli 0.159.3.

## Review fixes, round 4

Round 4 reviewed the same staged 0.6.0 tree. The findings file listed nine
items across its correctness, security, contracts, edges, and contracts-2
sections; the correctness section duplicated its stdin blocker as Major
and its turn-completion minor is the same finding the edges section
carried as Major, so seven distinct findings. All are fixed, minors
included, each with a regression test. The contracts-2 section of the
file is empty (its "Added" heading has no findings under it), so nothing
there waited on a fix. The round's fail-closed rule, in one place: a
wrapper (masked exit code, truncated stream, error envelope), a symlink
at `~/.claude-zai`, a missing terminal event, or a stalled stdin producer
now ends the run with a non-zero exit, `result: null` and
`session_id: null` in any envelope emitted, and the diagnostic on stderr
— and where a finding asked for it (the unparseable codex stream), the
raw stdout stays available verbatim.

1. **`-f -` bypassed the run timeout (correctness Major, listed twice).**
   `readSync` had no deadline: with a pipe open and nothing arriving, the
   read blocked forever and `--timeout` was parsed and enforced only
   afterward. The finding's reproduction (`run -a claude -f - --timeout 1`,
   stdin left open) still sat blocked at 1.5 seconds and needed SIGTERM.
   The timeout is now parsed before the prompt is read and bounds the
   read: `readStdinPrompt` is async, reads the stream with a deadline, and
   a producer that stalls with the pipe open fails the run (exit 1,
   `-f - read no complete prompt from stdin before --timeout elapsed` on
   stderr) instead of hanging the caller. Fix: `src/index.ts`. Test:
   `tests/cli-stdin-prompt.test.ts` (open pipe, `--timeout 1`, exit 1
   with the diagnostic, in well under the hang budget).

2. **Incomplete codex streams returned success (correctness minor +
   edges Major, one finding).** The verdict required an assistant message
   but never a terminal `turn.completed`, so a fixture of
   `thread.started` + `turn.started` + a completed message item exited 0,
   reported that message as the result, and claimed a persisted session —
   exactly what a zero-exit wrapper (`codex-real "$@" | sed '$d'`)
   produces. Upstream separates the two completions (exec_events.rs at
   rust-v0.159.3: a turn "encompasses all events" and ends only at
   `turn.completed`/`turn.failed`), so the reduction now tracks open
   turns: success requires a `turn.completed` with no turn left open,
   on the envelope path and the plain `--session new` path alike, with
   `result: null`, `session_id: null`, exit 1, and the diagnostic naming
   the missing event. Fix: `src/result-envelope.ts` (parser +
   `codexStreamVerdict`). Tests: `tests/result-envelope.test.ts` (message
   item without turn completion; an earlier completed turn does not
   excuse a truncated later one; the wrapper shape through `codexResult`),
   `tests/adapters.test.ts` (the plain session-new path), and
   `tests/cli-result-json.test.ts` (CLI level). Two existing thread-less
   fixtures gained the `turn.completed` event so they keep pinning only
   the thread-id rule.

3. **Claude error envelopes retained success (correctness minor).**
   Result processing ignored `is_error` and the `error_*` subtypes: an
   envelope with `is_error: true` and subtype `error_during_execution` on
   exit 0 kept `success: true` and reported a resumable session id, so a
   wrapper masking the exit code defeated structured failure detection.
   `is_error: true` or an `error_*` subtype now fails the run — non-zero
   exit, `session_id: null`, the codemux diagnostic on stderr — while the
   harness's own envelope fields stay verbatim (they are the harness's
   record of the failure). Fix: `src/result-envelope.ts` (parse +
   `claudeFamilyResult`; zai inherits both). Tests:
   `tests/result-envelope.test.ts` (error envelope on exit 0; `is_error`
   without an error subtype) and `tests/cli-result-json.test.ts` (CLI
   level).

4. **The codex envelope path deleted the raw stdout it promised to keep
   (contracts major).** README, CHANGELOG, and the adapter's own comment
   ("like the envelope path keeps it") promised the raw stdout stays for
   inspection on an unparseable stream, but `codexResult` overwrote
   stdout with a null-everything envelope, and two tests pinned the
   replacement. The code now matches the docs it broke: the raw stdout
   stays verbatim on stdout, the exit is non-zero, the codemux line rides
   on stderr, and no envelope is emitted — the same failure shape the
   Claude-family path already had and the plain session-new path already
   had, because there is no stream to build an envelope from. Fix:
   `src/result-envelope.ts` (`codexResult`). Tests: the two pinned tests
   rewritten to the documented contract plus the assertions that raw
   stdout survives, in `tests/result-envelope.test.ts`.

5. **The CHANGELOG's shared-verdict bullet claimed a scope the code does
   not have (contracts minor).** It promised the same result "with and
   without `--result-json`, for `--session new` and `resume:<id>` alike",
   but a plain `resume:<id>` run launches without `--json` (pinned in
   `tests/adapters.test.ts`), so no stream is parsed and no codemux
   verdict can fire there. The bullet now states the real scope —
   `--result-json` in any session mode and plain `--session new` — and
   says plainly that a plain resume keeps codex's own exit code as the
   only verdict, as before. Fix: `CHANGELOG.md` only; code and tests
   unchanged, per the finding.

6. **Z.AI's private config dir dropped the operator's user-level
   enforcement without saying so (security).** Pinning
   `CLAUDE_CONFIG_DIR=~/.claude-zai` moves the whole user settings source
   with it: `--setting-sources user` now resolves to
   `~/.claude-zai/settings.json`, so the operator's
   `~/.claude/settings.json` — `PreToolUse` guards, permission rules, the
   user `CLAUDE.md` — no longer loads in any zai run (headless and TUI,
   sandboxed and direct). The code comment called this intended, but no
   doc said user-level enforcement was dropped. The policy is now stated
   in `CHANGELOG.md` (the Changed bullet spells out what does not load
   and why, and how to keep the guards: copy the settings file to
   `~/.claude-zai/settings.json` once), `README.md` (Sessions),
   `docs/HARNESS-COMPATIBILITY.md`, and the adapter comments themselves
   (`zaiConfigDir`, `buildRunCommand`). The session isolation itself is
   unchanged — that trade-off was round 3's finding 9 and stays.

7. **`mkdirSync(recursive)` accepted a symlinked `~/.claude-zai`
   (edges Major).** A symlink at `~/.claude-zai` pointing at `~/.claude`
   would have the pinned `CLAUDE_CONFIG_DIR` follow it, defeating the
   session-store isolation and letting Claude sessions be resumed through
   Z.AI. `beforeLaunch` now validates the directory before creating it —
   no-follow `lstat` refuses a symlink or a non-directory — re-checks
   after creation (closing the swap-in race), and requires it writable;
   every refusal aborts the launch (exit 1, diagnostic on stderr) on all
   four launch paths. Fix: `src/adapters/zai.ts`. Tests:
   `tests/zai.test.ts` (symlink to a Claude-shaped target; a regular
   file; the fresh-directory path still works).

Gate after the round-4 fixes (against the baseline gate run on the same
staged tree immediately before them):

- `make release-gate` again stops at `contracts` on the environmental
  copilot probe (`EPERM: mkdir ~/Library/Caches/copilot/pkg/darwin-arm64`
  — this sandbox cannot write `~/Library`); that step read 1 pass /
  1 fail before the fixes and 1 pass / 1 fail after, unchanged in kind
  from rounds 1 through 3. With HOME redirected to a writable temp
  directory, `test:contracts` passes 2/0 — the failure is the sandbox's
  write denial, not the tree. Everything before it passed inside the
  gate (`runtime`, `check`: typecheck, shell, coverage suite), and every
  step after it was run directly and exited 0: `sandbox-contract`,
  `smoke`, `bun audit` (no vulnerabilities), the frozen-lockfile dry
  run, and all six help/`--show-scode` variants.
- The coverage suite inside the gate: **618 pass, 6 skip, 0 fail — 624
  tests across 31 files**, against the pre-fix baseline's 606 pass /
  6 skip / 0 fail (612 tests): +12 passing tests, all new regression
  tests for this round, skips unchanged at 6, fails 0. Whole-source
  conservative coverage reads 81.30% lines / 88.55% functions (from
  81.71% / 89.69%): the added defensive branches that no test can reach
  honestly (the post-creation symlink re-check, the writability
  refusal, the stdin error path) account for the dip; the enforced 80%
  thresholds pass. One intermediate full-suite run showed a single
  failure that did not reproduce in six further full runs or any
  targeted run; the new timing test was hardened with an explicit 10s
  test timeout regardless.
- `check_american.py` over all twelve changed files — clean.

## Review fixes, round 5

Round 5 reviewed the same staged 0.6.0 tree. Nine distinct findings: two
correctness minors (each duplicated in the file), a security major and two
security minors, three contracts findings, and two edges majors; the
contracts-2 section is empty. All are fixed, minors included, each with a
regression test. The round's fail-closed rule, in one place: an envelope
that names no outcome, a settings file whose guards would silently not
load, a directory swapped mid-run, or a version gate skipped by a redirect
now ends in a refusal or a non-zero exit with `result: null` and
`session_id: null` where an envelope is emitted and the diagnostic on
stderr — and the one finding that ran the other way (a valid run that
failed) now succeeds with its real message.

1. **Incomplete Claude envelopes returned success (correctness minor,
   listed twice).** `{"type":"result"}` with exit 0 — the shape of a
   malformed wrapper response — parsed into `success: true` with no result
   text and no status, silently satisfying `--result-json`. The parser now
   requires an outcome field (`result`, `subtype`, or `is_error`, which
   names a failure and already fails the run downstream); the
   discriminator alone is rejected the way plain text already was. Fix:
   `src/result-envelope.ts` (`parseClaudeResultEnvelope`). Tests:
   `tests/result-envelope.test.ts` (parse-level rejection; the bare
   discriminator through `claudeFamilyResult` failing loudly with exit 1;
   the `is_error`-only envelope still parsing).

2. **A new codex turn retained the previous one's message (correctness
   minor, listed twice).** `turn.started` did not clear `finalMessage`, so
   a completed reply followed by a completed turn without an agent message
   returned the earlier reply with exit 0 — exactly the failure shape the
   messageless-turn rule exists to produce. A new turn now supersedes the
   previous one's message, and the same edit window pinned the thread id
   to its documented first-`thread.started` semantics (the adjacent
   contracts finding: the code overwrote it on every announcement). Fix:
   `src/result-envelope.ts` (`parseCodexEventStream`). Tests:
   `tests/result-envelope.test.ts` (the two-turn repro failing through the
   verdict; a second `thread.started` not replacing the first).

3. **Z.AI runs dropped the operator's user-level hooks and deny rules
   (security major).** Pinning `CLAUDE_CONFIG_DIR=~/.claude-zai` moved the
   `--setting-sources user` resolution with it, so `PreToolUse` guards and
   `permissions.deny` in `~/.claude/settings.json` stopped loading in any
   zai run while the operator believed they were active. The launch is now
   refused outright when the operator's file registers hooks or deny rules
   and `~/.claude-zai/settings.json` does not exist — with the one-step
   fix in the message — and also when either settings file exists but
   cannot be read or parsed, because codemux cannot tell whether it
   carries enforcement and a guess would be the silent drop the guard
   exists to prevent. A seeded private settings file launches as before;
   so does an operator file with no hooks and no deny rules. Fix:
   `src/adapters/zai.ts` (`assertOperatorSettingsCarried`, called from
   `beforeLaunch` on every launch path). Tests: `tests/zai.test.ts`
   (hooks refusal, deny refusal, seeded launch, nothing-to-carry launch,
   unreadable operator file, unreadable private file).

4. **A passed-through redirect skipped the version gate (security
   minor).** `--pass-env OPENCODE_BIN_PATH` returned from
   `assertHarnessSupported` before `assertSupportedHarnessVersion` ran,
   so a below-floor release launched without the compatibility override
   and with only the "cannot confirm" warning. The warning stays — the
   probe cannot speak for the redirected executable without running it
   outside the sandbox — but the PATH-resolved default binary is still
   probed and still refused below the floor, and the operator's
   `CODEMUX_ALLOW_UNTESTED_HARNESS=1` covers a deliberate redirect there
   as anywhere else. Fix: `src/cli-runtime.ts`. Tests:
   `tests/harness-compatibility.test.ts` (redirect active + below-floor
   binary: warning and refusal; override downgrades to the override
   warning).

5. **The symlink check on `~/.claude-zai` could be raced (security
   minor).** The launch-time `lstat` cannot cover the run. The directory
   is now created through a staging directory and a single rename (which
   cannot overwrite whatever stands at the name, so a swap during
   creation lands back in validation), the launch records the validated
   directory's device/inode identity, and `processRunResult` re-verifies
   it: a swap or removal mid-run fails the run closed — non-zero exit, no
   persisted claim, `session_id: null` in the envelope, which still goes
   out with the harness's own fields. Fix: `src/adapters/zai.ts`
   (`ensureZaiConfigDir`, `zaiConfigDirSwapped`, `processRunResult`).
   Tests: `tests/zai.test.ts` (symlink swap, removal, envelope path,
   unchanged-directory control).

6. **The codex `--result-json` bullet promised per-turn usage (contracts
   minor).** The Added bullet said the stream names "per-turn token
   usage" — the semantics the same bullet lower down explicitly withdraws
   (the snapshot is the cumulative thread counter; there is no per-turn
   figure to subtract). The sentence now states the real semantics. Fix:
   `CHANGELOG.md` only, per the finding.

7. **A test title named withdrawn behavior (contracts minor).** "a
   passed-through secret does not reach the probe, but a selector does"
   asserted the opposite of its body (nothing passed through reaches the
   probe; carrying the selector was tried and withdrawn). Retitled to
   "neither a passed-through secret nor a selector reaches the probe".
   Fix: `tests/harness-compatibility.test.ts`.

8. **A successful codex plan-only turn was rejected (edges major).**
   Codex 0.159.3 treats the last `Plan` item as the turn's final message,
   but the JSONL mapper drops the item, so the stream carried no message
   and a valid completed run exited 1 on both the envelope path and plain
   `--session new`. Every stream run now also passes
   `--output-last-message <file>` (under the real `CODEX_HOME` — scode
   keeps that harness state writable, unlike the Linux temp root — named
   per run by pid and uuid, removed once read, bounded and no-follow on
   the read), and when the last turn completed without an
   `agent_message`, the recorded message is the result, with a stderr
   note saying where it came from. The fallback supplements rather than
   bypasses: no message anywhere still fails, a failed turn cannot be
   rescued by a file, and a stream that carries its own `agent_message`
   stands. Fix: `src/adapters/codex.ts` (prepareRun, buildRunCommand,
   processRunResult, readFinalMessageFallback) +
   `src/result-envelope.ts` (`applyCodexFinalMessageFallback`,
   `CODEX_FINAL_MESSAGE_FALLBACK_NOTE`, `codexResult`'s third parameter).
   Tests: `tests/result-envelope.test.ts` (success with the note; null
   fallback still failing; stream's own message standing; failed turn
   not rescued), `tests/adapters.test.ts` (adapter-level plan-only run
   with the real file, per-run uniqueness, cleanup), and CLI level in
   `tests/cli-session.test.ts` (plain path) and
   `tests/cli-result-json.test.ts` (envelope path), both with a fake
   codex that writes the `-o` file; the exact `--json` argv pins gained
   the new flag, and the installed-contract suite now requires
   `--output-last-message` in `codex exec --help`.

9. **Plain `--session new` treated exit 0 alone as proof (edges major).**
   A zero-exit wrapper or silent harness failure on claude or zai still
   printed "session <id> persisted" over a session no resume can reach.
   Plain-text mode has no structured record to check, so the reply itself
   is the evidence: an empty stdout fails the run (non-zero exit, the
   diagnostic on stderr, no persisted claim). The codex plain path
   already failed empty streams via the shared verdict. Fix:
   `src/adapters/claude.ts`, `src/adapters/zai.ts`. Tests:
   `tests/adapters.test.ts` (claude), `tests/zai.test.ts` (zai), and
   `tests/cli-session.test.ts` (CLI-level claude reproduction).

The contracts-2 section of the findings file is empty, so nothing there
waited on a fix. Docs updated with the behavior changes: `CHANGELOG.md`
(seven new Fixed bullets, the Added usage sentence corrected, the Changed
Z.AI bullet states the enforced refusal), `README.md` (Result envelopes:
the bare-discriminator rejection and the plan-only success; Sessions: the
promise-from-evidence rule, the mid-run identity check, the settings
refusal), `docs/HARNESS-COMPATIBILITY.md` (the `--output-last-message`
pin against `exec_cli.rs`/`map_item_with_id` at rust-v0.159.3, and the
zai settings-refusal plus identity-recheck policy).

Gate after the round-5 fixes (against the baseline gate run on the same
staged tree immediately before them):

- `make release-gate` stops at `contracts` on the same environmental
  copilot probe as every baseline this session (`EPERM: mkdir
  ~/Library/Caches/copilot/pkg/darwin-arm64` — this sandbox cannot write
  `~/Library`); that step read 1 pass / 1 fail before the fixes and 1
  pass / 1 fail after, unchanged in kind from rounds 1 through 4. With
  HOME redirected to a writable temp directory, `test:contracts` passes
  2/0 (117 expect calls, one more than round 4: the
  `--output-last-message` requirement). Everything before it passed
  inside the gate (`runtime`, `check`: typecheck, shell, coverage suite),
  and every step after it was run directly and exited 0:
  `sandbox-contract`, `smoke`, `bun audit` (no vulnerabilities, 9
  packages), the frozen-lockfile dry run, and all the help variants.
- The coverage suite: **643 pass, 6 skip, 0 fail — 649 tests across 31
  files**, against the pre-fix baseline's 618 pass / 6 skip / 0 fail (624
  tests): +25 passing tests, all new regression tests for this round,
  skips unchanged at 6, fails 0. Whole-source conservative coverage reads
  82.49% lines / 88.91% functions (from 81.30% / 88.55%) — the new code
  is exercised by its tests rather than merely added.
- `check_american.py` over every changed file — clean.

## Review fixes, round6

Findings from the round6 review, every severity, one regression test each.
All on the staged 0.6.0 tree; still uncommitted (the pre-commit gate cannot
run in this sandbox), finished with `git add -A`.

1. **Concurrent codex runs shared the fallback file pointer (correctness
   major, listed three times; the same defect class covered the hermetic
   home field).** `lastMessageFile` and `hermeticHome` were plain adapter
   fields on a singleton, so run B's `prepareRun` overwrote run A's: A's
   completion read and removed B's `--output-last-message` file (A could
   return B's message) and left B without its fallback — failing a
   successful Plan-only turn — and A's hermetic command would have pointed
   at B's home. Both are recorded per run now, keyed by the request object
   in a WeakMap from `prepareRun` to `processRunResult`, and
   `BaseAdapter.run` no longer copies the request (autonomy is pinned
   before the copy was made, so it changed only the object's identity —
   which is exactly what the keying needs to stay stable); the
   `prepareRun` docstring states the same-object contract. Fix:
   `src/adapters/codex.ts`, `src/adapters/base.ts`. Tests:
   `tests/adapters.test.ts` ("two concurrent runs keep their own
   --output-last-message fallback"), `tests/hermetic.test.ts` ("two
   concurrent hermetic runs each launch in their own home"; the existing
   hermetic tests now hold one request object per run, the shape every
   launch path uses).

2. **The zai settings guard ran for hermetic runs and the default TUI
   (edges major), and the operator reported it blocks every Z.AI run on a
   machine whose Claude settings carry hooks — the normal case.** The
   round-5 refusal is gone entirely, replaced by the mirror the operator
   report asked for: when `~/.claude-zai/settings.json` is missing, the
   launch copies `~/.claude/settings.json` into it, and refreshes the copy
   whenever the source is newer (mtime compared against the copy's, which
   the mirror pins to the source's own timestamps with `utimesSync`, so
   the comparison reads the operator's clock and a hand-edited copy stands
   until the source changes). The source is stat'd before it is read
   (symlinks followed — fidelity to what `claude` loads); the destination
   is `lstat`ed and anything not a regular file there is replaced by the
   staging-plus-rename, never followed; an unreadable source or an
   unwritable copy is a warning and the launch proceeds — never a
   refusal. (Round7 narrowed both points — a directory at the copy's name
   now refuses the launch, and an unreadable source refuses rather than
   warns; see "Review fixes, round7" below.) Hermetic runs and the
   default TUI pass `--safe-mode` and
   ignore settings either way, which is what made the old guard wrong for
   them. Fix: `src/adapters/zai.ts` (`mirrorOperatorSettings`; the
   `beforeLaunch` sequence). Tests: `tests/zai.test.ts` describe "Z.AI
   operator settings mirror" — hooks mirrored rather than refused, seeded
   copy left alone while the source is not newer, refresh when newer and
   a hand edit standing after it, unreadable source warns and launches,
   no `~/.claude` at all, symlinked destination replaced.

3. **Claude-family structured results reported the requested session UUID
   without verifying the envelope (edges major).** A successful envelope
   omitting `session_id`, or naming a different session, exited 0 and
   advertised the requested UUID as resumable. `claudeFamilyResult` now
   checks the envelope's own `session_id` for exactly the id a `new` run
   pinned or a `resume` continued: a mismatch fails the run (non-zero
   exit, `codemux.session_id` null, the diagnostic on stderr) while the
   harness's envelope still goes out intact with the block attached — the
   same fail-closed shape the error-envelope path uses. Fix:
   `src/result-envelope.ts` (`envelopeSessionProblem`). Tests:
   `tests/result-envelope.test.ts` (different-session and
   omitted-session-id failures; the persisted-session test now pins the
   envelope's own id, which is what the block reports).

4. **Codex session validation checked only that some thread id was
   reported (edges major).** A `resume:<A>` stream announcing thread `<B>`
   succeeded and reported `<B>` — the run continued some other
   conversation — and a new-session stream could report a non-UUID id a
   later resume refuses. `codexStreamVerdict` gained the request's session
   id: a `resume` fails unless the stream re-announces the very id that
   was resumed, and a `new` fails unless the announced id is a session-id
   UUID (`isSessionId`, the same check `--session resume:<id>` applies).
   Fix: `src/result-envelope.ts` (`codexStreamVerdict`,
   `codexResult`). Tests: `tests/result-envelope.test.ts` (resume with a
   mismatched thread, non-UUID thread on new).

5. **The zai directory identity was shared mutable state (edges
   major).** Run B's validation overwrote run A's recorded device/inode
   identity, so A compared against an identity its own launch never
   approved and accepted a mid-run replacement. The identity is recorded
   per run by a `prepareRun` override (`ensureZaiConfigDir` now returns
   what it validated), keyed by the request object, and
   `processRunResult` checks the identity the run's own launch approved.
   Fix: `src/adapters/zai.ts`. Test: `tests/zai.test.ts` ("a later run's
   validation cannot excuse an earlier run's mid-run swap"); the swap
   describe's existing tests now run the real launch sequence
   (`beforeLaunch` → `prepareRun` with one request object).

6. **An `item.completed` after `turn.completed` replaced the final
   message (edges major).** No turn was reopened, `turnCompleted` stayed
   true, and a truncated or concatenated stream could return its trailing
   uncompleted message as a successful result. The reduction now refuses
   the stream when an agent message completes with no open turn after a
   turn completion — the same fail-closed drift handling as a malformed
   line: the raw stdout kept verbatim, a non-zero exit, the codemux line
   on stderr. The guard is scoped to that exact shape
   (`openTurns === 0 && sawTurnCompletion`): streams whose items precede
   the first completion without a `turn.started` — the shape every
   existing fixture uses — still parse. Fix: `src/result-envelope.ts`
   (`parseCodexEventStream`). Test: `tests/result-envelope.test.ts`
   ("an agent message after the last turn.completed is drift, not a
   result", at both the parser and `codexResult` seams).

Docs updated with the behavior changes: `CHANGELOG.md` (the Z.AI refusal
bullet rewritten as the mirror, the swap bullet states the per-run
identity, four new Fixed bullets), `README.md` (Result envelopes: the
session-id evidence rule and the trailing-item drift; Sessions: the
mirror replaces the refusal text), `docs/HERMETIC.md` (the operator
guardrails bullet notes the mirror and that hermetic Z.AI still uses
`--safe-mode`), `docs/HARNESS-COMPATIBILITY.md` (the mirror policy and
the thread-id validation rules).

Gate after the round-6 fixes (against the round-5 gate on the same staged
tree):

- `make release-gate` stops at `contracts` on the same environmental
  copilot probe as every baseline this session (`EPERM: mkdir
  ~/Library/Caches/copilot/pkg/darwin-arm64` — this sandbox cannot write
  `~/Library`); that step read 1 pass / 1 fail before the fixes and 1
  pass / 1 fail after. With HOME redirected to a writable temp directory,
  `test:contracts` passes 2/0 (117 expect calls, unchanged from round 5).
  Everything before it passed inside the gate (`runtime`, `check`:
  typecheck, shell, coverage suite), and every step after it was run
  directly and exited 0: `sandbox-contract`, `smoke`, `bun audit` (no
  vulnerabilities, 9 packages), the frozen-lockfile dry run, and all the
  help variants.
- The coverage suite: **651 pass, 6 skip, 0 fail — 657 tests across 31
  files**, against the round-5 gate's 643 pass / 6 skip / 0 fail (649
  tests): +8 passing tests, all new regression tests for this round,
  skips unchanged at 6, fails 0. Whole-source conservative coverage reads
  82.57% lines / 88.96% functions (from 82.49% / 88.91%).
- `check_american.py` over the 12 changed files — clean.
- The operator regression proven gone live:
  `./bin/codemux run -a zai --no-sandbox --auto high -p "Reply with: OK"`
  prints `OK` and exits 0 (it refused before the fix), and the mirror ran
  on this machine: `~/.claude-zai/settings.json` now exists, mode 0600,
  byte-identical to `~/.claude/settings.json`, carrying its mtime.

## Review fixes, round7

Findings from the round7 review, every severity, one regression test each
(or a flipped pin where the finding overturned a round6 behavior). All on
the staged 0.6.0 tree; still uncommitted (the pre-commit gate cannot run
in this sandbox), finished with `git add -A`.

1. **An uppercase session id failed its own resume (correctness major).**
   `parseSessionOption` accepts UUIDs in either case while the harness
   reports lowercase, so the byte comparison in
   `envelopeSessionProblem` (claude-family envelopes) and
   `codexStreamVerdict` (codex streams) rejected the very session the run
   asked for: a successful resume exited 1 with `result: null` and
   `session_id: null`, and the exit-66 classification missed the pinned
   failure beside it. A `sameSessionId` helper compares
   case-insensitively everywhere codemux matches a harness-reported id
   against the requested one. Fix: `src/result-envelope.ts`
   (`sameSessionId`, used by both verdicts), `src/session.ts` (the
   classification's id check). Tests: `tests/result-envelope.test.ts` —
   "an uppercase session id is confirmed by the lowercase id the envelope
   names", "an uppercase resume id matches the lowercase id the stream
   announces"; `tests/session.test.ts` — "the requested id must be the
   one the harness names beside its message" (either case).

2. **A subtype-only success envelope satisfied --result-json with no
   reply (correctness minor).** `{"type":"result","subtype":"success"}`
   carries no result text, yet any string subtype counted as an outcome,
   so the run exited 0 over an envelope with no reply anywhere. A
   successful envelope now owes its `result` text; only a failing one
   (`is_error`, an `error_*` subtype) may omit it. Fix:
   `src/result-envelope.ts` (`parseClaudeResultEnvelope`'s outcome
   check). Tests: `tests/result-envelope.test.ts` — "a subtype alone is
   not an outcome: success without result text is rejected", "a
   subtype-only success envelope fails the run, not passes as one".

3. **A deleted operator settings file never reached the private copy
   (security major).** The mirror ran only when a source existed to read,
   so deleting `~/.claude/settings.json` left the last mirrored copy
   loading forever — hooks and deny rules the operator removed kept
   reaching every Z.AI run. An ENOENT on the source now removes the
   private copy (a failure to remove refuses). Fix:
   `src/adapters/zai.ts` (`mirrorOperatorSettings`). Tests:
   `tests/zai.test.ts` — "a deleted operator file removes the stale
   private copy".

4. **The mirror failed open on an unreadable source (security major).**
   Over the 1 MiB bound, invalid UTF-8, EACCES, a directory standing at
   the source's name — every non-ENOENT read error warned and launched,
   so Z.AI runs sailed on with hooks and permission rules silently not
   applying. Those refusals now fail the launch; the ordinary cases (a
   readable source, or none at all) never refuse. This flips the round6
   "never a refusal" pin. Fix: `src/adapters/zai.ts`
   (`mirrorOperatorSettings`, refusals through `beforeLaunch`). Tests:
   `tests/zai.test.ts` — "an operator file that cannot be read refuses
   the launch" (the round6 pin, flipped).

5. **Freshness compared mtimes only (security minor).** A source
   rewritten and restored to an old timestamp (`cp -p`, `rsync -a`) read
   as current, so the stale copy stood. Size joins the comparison — but
   only at equal mtimes: the mirror stamps the source's own timestamps
   onto the copy, so equal-mtime-different-size is stale, while a
   hand-edited copy (newer than the source) stands regardless of its
   size. Comparing size unconditionally would have clobbered hand edits,
   the round6 behavior the same test pins. Fix: `src/adapters/zai.ts`
   (the `fresh` predicate). Tests: `tests/zai.test.ts` — "a same-mtime,
   different-size copy is refreshed".

6. **run() stopped pinning read-only when autonomy was unset (security
   minor).** The staged refactor left the pin to
   `requiresSandboxForAutonomy("read-only")` throwing first — true for
   every shipped adapter, but an adapter enforcing read-only natively
   would reach `buildRunCommand` with no autonomy flags at all. The pin
   rides on the request object itself (no copy: adapters key per-run
   state by its identity). Fix: `src/adapters/base.ts` (`run`). Tests:
   `tests/base.test.ts` — "omitted autonomy reaches buildRunCommand
   pinned to read-only, not unset".

7. **Stale comments described the withdrawn "selector passthrough" probe
   design as current (contracts).** `src/cli-runtime.ts` claimed the
   probe "must carry everything the launch keeps that selects an
   executable" and `src/environment.ts` said "a passed-through name
   reaches the probe only if it selects an executable" — the shipped
   code does the opposite (`EXECUTABLE_SELECTORS` is deliberately empty,
   `probeEnvironment` drops every passed-through name,
   `activeRedirects` warns "cannot confirm"). Both comments now state
   the real behavior and why the selector-carrying design was withdrawn.
   Fix: `src/cli-runtime.ts` (`assertHarnessSupported` comment),
   `src/environment.ts` (`probeEnvironment` comment). Tests: the
   existing `tests/harness-compatibility.test.ts` pins ("neither a
   passed-through secret nor a selector reaches the probe") already
   cover the behavior; comments carry no new one.

8. **"Replaced, never followed" overclaimed for directories
   (contracts).** `rename` onto a standing directory fails EISDIR, so
   the mirror's catch warned and continued with the operator's settings
   silently never loading; CHANGELOG and this report (round6, above)
   repeated the overclaim. A directory at the copy's name now refuses
   the launch; a symlink or regular file there is still replaced, never
   followed. Fix: `src/adapters/zai.ts` (`mirrorOperatorSettings`);
   docs amended (CHANGELOG 0.6.0 mirror bullet; round6 sentence above).
   Tests: `tests/zai.test.ts` — "a directory at the private copy's name
   refuses the launch".

9. **A second thread.started was called drift but silently ignored
   (edges major).** A wrapper concatenating two valid codex streams
   returned the second run's final message with the first run's session
   id. The reduction now refuses the stream like any other format
   drift — parse returns null, non-zero exit, the raw stdout kept.
   Fix: `src/result-envelope.ts` (`parseCodexEventStream`). Tests:
   `tests/result-envelope.test.ts` — "a second thread.started is drift,
   not an announcement to ignore" (the round6 pin, flipped),
   "two concatenated complete streams fail closed, raw stdout kept".

10. **Nonempty stdout was proof enough that a --session new session
    persisted (edges major).** For claude (`src/adapters/claude.ts`) and
    zai (`src/adapters/zai.ts`), a wrapper masking a harness failure
    with a banner and exit 0 still printed `session <id> persisted`. The
    plain-text path now verifies the session store the harness writes:
    `claudeSessionPersisted` scans `<config>/projects/*/<uuid>.jsonl`
    case-insensitively (no dependence on Claude's cwd-slug scheme), with
    the claude config dir resolved where the child actually wrote — the
    adapter's home seam, or a passed-through `CLAUDE_CONFIG_DIR` — and
    zai always its private `~/.claude-zai`. No reply, or a store with no
    session file, fails the run: non-zero exit, diagnostic on stderr, no
    persisted claim, the reply kept on stdout. `ClaudeAdapter` gains the
    home seam zai and codex already had, so the check (and its unit
    tests) read a scratch home rather than the operator's. Fix:
    `src/session.ts` (`claudeSessionPersisted`),
    `src/adapters/claude.ts` (`childConfigDir`, the plain-path check),
    `src/adapters/zai.ts` (the same check against the private store).
    Tests: `tests/session.test.ts` — describe `claudeSessionPersisted`;
    `tests/adapters.test.ts` — "a reply over an empty session store is
    not confirmed persisted"; `tests/zai.test.ts` — "a reply with no
    session file in the store is not confirmed persisted";
    `tests/cli-session.test.ts` — "a reply without a session file is
    not proof the session persisted"; the session-new success fakes now
    write the store file the real harness writes.

11. **Exit 66 classified without checking the harness named the
    requested session (edges minor).** A stderr carrying the
    missing-session signature for session B while the run resumed
    session A exited 66 telling automation A is missing — potentially
    discarding a valid session. The classification now requires the
    signature line to name the requested id (extracted
    case-insensitively; a line naming no id falls back to the id
    appearing anywhere in stderr). Fix: `src/session.ts`
    (`sessionMissingError`), `src/index.ts` (passes the requested id).
    Tests: `tests/session.test.ts` — "the requested id must be the one
    the harness names beside its message", "a signature line naming no
    id falls back to the id appearing in stderr";
    `tests/cli-session.test.ts` — "a resume whose harness failure names
    another session keeps exit 1" (and the codex exit-66 fake now
    echoes the requested id, as the real harness does).

The findings file's truncated "contracts-2" tail items were verified as
prior-round echoes already fixed in the staged tree (stdin timeout,
codex approval policy, raw-stdout retention, the README autonomy table)
and needed no change.

### Gate (round7)

- `make release-gate` as one command stops at `contracts` on this
  machine's known sandbox limitation (round6's, unchanged): the copilot
  installed-contract cannot extract its bundled package because the
  sandbox denies writing `~/Library/Caches/copilot/pkg/darwin-arm64`
  (EPERM); the step read 1 pass / 1 fail with the fixes in place. Every
  gate step was therefore run directly, each exiting
  0: `runtime` (bun 1.4.2 above the 1.3.14 floor), `check` (typecheck,
  `sh -n`, coverage suite), `contracts` under a writable HOME (2 pass /
  0 fail, 117 expect calls — unchanged from round6), `sandbox-contract`,
  `smoke`, `bun audit` (no vulnerabilities, 9 packages), the
  frozen-lockfile dry run, and all six help/verify variants.
- The coverage suite: **668 pass, 6 skip, 0 fail — 674 tests across 31
  files**, against the round6 gate's 651 pass / 6 skip / 0 fail (657
  tests): +17 passing tests, all new or flipped regression tests for
  this round, skips unchanged at 6, fails 0. Whole-source conservative
  coverage reads 82.83% lines / 89.34% functions (from 82.57% / 88.96%).
- `check_american.py` over the 18 changed files — clean.

## Review fixes, round 8

Round 8 opened with a decision rather than a list: seven review rounds had
not converged, and almost every remaining finding lived in code that existed
only to support `--session` for Z.AI — the private config directory, the
settings mirror, the swap check, the session-store verification. That surface
was deleted instead of hardened, and the findings closed with it. All on the
staged 0.6.0 tree; still uncommitted, finished with `git add -A`.

### The simplification

1. **Z.AI uses the Claude Code home it always used.** The private
   `~/.claude-zai` directory, the `settings.json` mirror (copy, refresh,
   delete), the device/inode swap verification, and every launch-time
   directory validation are gone (`src/adapters/zai.ts` rewritten; the
   adapter sets only the Z.AI endpoint variables). `CLAUDE_CONFIG_DIR` is
   untouched — a Z.AI run reads and writes the shared Claude store, and
   `--setting-sources user` loads the operator's own
   `~/.claude/settings.json`, exactly as before 0.6.0. Documented in the
   README (Sessions): a session id is unique in the store, and
   `codemux run -a zai --session resume:<id>` must name a session the same
   home created.
2. **Persistence proof from the envelope, not the store.** A plain
   `--session new` run on claude or zai now always launches with
   `--output-format json` (as a `--result-json` run does): the envelope's
   own `session_id` must name the id the run pinned with `--session-id`,
   and the reply is unwrapped to stdout when `--result-json` was not
   requested (`claudeFamilyResult` gained an `unwrap` mode;
   `claudeSessionPersisted` and its store scan are deleted from
   `src/session.ts`). Mismatch, absence, or a non-envelope stdout fails the
   run with `session_id: null`, the raw stdout kept, and a non-zero exit —
   the same evidence on every path. A failed process exit keeps the raw
   stdout and prints no persisted line (the same `result.success` gate the
   block's `session_id` has). Codex keeps its `thread.started` role: the
   one announcement is the session evidence.
3. **Strict codex stream parsing.** Exactly one `thread.started` naming a
   non-empty thread id (a stream without one — an empty stream included —
   or with a second is a parse failure, never a warned run); every
   `turn.completed`/`turn.failed` must match an open `turn.started` (an
   unmatched terminal event is the shape of a prefix-truncated stream —
   refused, not clamped); `turn.failed` is terminal and no later event
   clears it; a top-level `error` is still superseded by a later matched
   `turn.completed` (retry semantics). `CodexEventStream.threadId` is a
   string now, and the verdict's old missing-thread checks are gone
   because the parser enforces them first.
4. **Config-dir passthrough.** A passed-through `CLAUDE_CONFIG_DIR` (claude
   and zai, run and TUI) must be absolute; a relative one refuses the
   launch (`src/claude-family.ts`, `assertAbsoluteClaudeConfigDir`) with a
   message saying the harness would resolve it against the run's working
   directory.

### Round-8 findings

- **Mirror freshness (zai.ts:417, correctness major ×2) — closed by the
  deletion.** The settings mirror no longer exists; there is no copy to go
  stale.
- **Relative `CLAUDE_CONFIG_DIR` resolved against the wrong directory
  (claude.ts:243, correctness major ×2) — closed by the refusal.** Task 4
  above: a relative value never reaches the child, so there is no
  resolution to get wrong.
- **`--result-json --session new` bypassed the store verification (edges
  1) — closed by the redesign.** There is no store verification to bypass;
  both paths now share the one envelope check.
- **Mirror ran before hermetic/TUI validation (edges 4) and the mtime+size
  freshness heuristic (edges 6) — closed by the deletion.**
- **Unmatched `turn.completed` was clamped to zero open turns (edges 2) —
  fixed.** `parseCodexEventStream` returns null on a terminal event with no
  open turn; the codexResult path fails with "cannot parse", raw stdout
  kept. Tests: `tests/result-envelope.test.ts` — "a turn.completed no
  turn.started opened is drift, not a count to clamp" (the failed-terminal
  twin included).
- **`turn.completed` cleared an earlier `turn.failed` (edges 3) — fixed.**
  The failure is sticky; only a top-level `error` is superseded. Tests:
  `tests/result-envelope.test.ts` — "a turn.failed is terminal: a later
  completed turn does not clear it" (parse, verdict, and codexResult
  levels; no session id survives the failure).
- **CHANGELOG contradicted the code on Z.AI settings (contracts 1) —
  closed by the bullet deletion.** The Changed bullet describing the
  private directory is gone; its replacement states the shared home and
  the new absoluteness refusal.
- **A claude.ts comment described zai's mechanism (contracts 2) —
  fixed.** The comment now describes the envelope as the session evidence.
- **README's "result is null" claim was over-general (contracts 3) —
  fixed.** Scoped to codex-built envelopes; Claude-family envelopes keep
  the harness's `result` verbatim (README and CHANGELOG).
- **The report's own "per-turn token usage" (contracts 4) — fixed.** The
  stream carries the thread's cumulative total; the Commit 1 body now says
  so.

Test moves: the store/mirror describe blocks are gone
(`tests/session.test.ts` lost `claudeSessionPersisted`; `tests/zai.test.ts`
gained "Z.AI sessions share the Claude Code home"), the codex fixtures all
carry the `turn.started` events the strict grammar matches terminals
against, and the new evidence has its own tests at every seam — adapter
(`adapters.test.ts`, `zai.test.ts`, `adapters-extended.test.ts`), envelope
(`result-envelope.test.ts`, including six unwrap-mode tests), and CLI
(`cli-session.test.ts` — envelope-naming fakes, the mismatched-envelope
case; `cli-result-json.test.ts`).

### Gate (round 8)

- `make release-gate` as one command stops at `contracts` on this
  machine's known sandbox limitation (unchanged since round6): the copilot
  probe cannot write `~/Library/Caches/copilot/pkg/darwin-arm64` (EPERM);
  the step read 1 pass / 1 fail. Every other step ran to completion, each
  exiting 0: `runtime` (bun 1.4.2 over the 1.3.14 floor), `check`
  (typecheck, `sh -n`, coverage suite), `contracts` re-run under a
  writable HOME (**2 pass / 0 fail, 117 expect calls — identical to
  round7**), `sandbox-contract`, `smoke`, `bun audit` (no vulnerabilities,
  9 packages), the frozen-lockfile dry run, and all six help/verify
  variants.
- The coverage suite: **665 pass, 6 skip, 0 fail — 671 tests across 31
  files**, against round7's 668 pass / 6 skip / 0 fail (674 tests): −15
  deleted store/mirror/verification tests, +12 new evidence tests, skips
  unchanged at 6, fails 0. Whole-source conservative coverage reads
  82.33% lines / 88.94% functions (from 82.83% / 89.34% — the deleted
  code was heavily tested).
- `check_american.py` over the 17 changed files — clean.
- Live checks (unsandboxed, `--auto high`):
  `run -a zai --session new --result-json -p "Reply with: OK"` exited 0
  with `result: "OK"` and the envelope's `session_id`
  (`ac74f6be-d384-44ff-a1cb-bf01da721bd7`) confirmed and reported in the
  codemux block; `run -a zai --session
  resume:ac74f6be-d384-44ff-a1cb-bf01da721bd7 -p "Reply with: OK"`
  exited 0 with `OK` on stdout — the session lived in the shared Claude
  home and resumed from it.

## Review fixes, round 9

Round 9 returned four findings — three major, one minor, all in the "edges"
group, with the correctness, security, and contracts groups silent. Every
one is fixed on the staged 0.6.0 tree with the smallest correct change and a
regression test that was mutation-checked (each test fails with its fix
reverted). Still uncommitted, finished with `git add -A`.

### Round-9 findings

1. **Post-processing skipped on a rejected launch (edges major,
   `src/launch.ts:30`, `src/launch.ts:48`) — fixed.** A rejection from
   `adapter.run()` (direct) or `runSandboxedWithStdin()` (sandboxed)
   bypassed `processRunResult()`, so the `--output-last-message` file a
   Codex JSON run had already written — model output, under the real
   `CODEX_HOME` — was never removed; a stdout that is not valid UTF-8 is
   exactly such a late rejection. `launchRunRequest` now wraps the whole
   launch in one try/catch that calls the new
   `BaseAdapter.cleanupRun(request)` (Codex's override removes the per-run
   file, keyed by the same request object as ever) and rethrows: the run
   still fails closed with the launch's own error (non-zero exit,
   diagnostic on stderr) and no envelope is built for a run that never
   finished. Tests: `tests/adapters.test.ts` — "a rejected sandboxed launch
   still removes the run's --output-last-message file" and its direct-run
   twin (a subclass captures the file `buildRunCommand` names and writes
   what codex would have; the sandboxed path rejects through a
   `.scode.yaml` working directory, the direct path through an unresolvable
   harness binary, both after `prepareRun`).
2. **Sessions accepted with `--sandbox-trust untrusted` (edges major,
   `src/index.ts:219-227`) — fixed.** That preset denies the
   harness-state directories where Claude, Z.AI, and Codex store sessions,
   so a valid resume surfaced as exit 66 "no session" and a new session
   could not be written for a later resume. The combination is now refused
   before launch for both `new` and `resume`, with the reason on stderr.
   Test: `tests/cli-session.test.ts` — "--sandbox-trust untrusted refuses
   session runs before launch".
3. **Codex parser ignored its documented ordering (edges major,
   `src/result-envelope.ts:486`, `src/result-envelope.ts:503`) — fixed.**
   A late `thread.started` was accepted — `turn.started`, message,
   `turn.completed`, then the announcement parsed successfully and could
   pair the completed response with an unrelated persisted session id —
   and nested `turn.started` events were counted as turns. Now
   `thread.started` must be the stream's first event (subsuming the round7
   second-announcement rule, whose test still guards it) and a
   `turn.started` with a turn still open is refused; both fail closed the
   way every parse drift does (non-zero exit, raw stdout kept, no
   envelope). Tests: `tests/result-envelope.test.ts` — "a thread.started
   after any other event is drift, not an announcement" and "a
   turn.started inside an open turn is drift, not a nested turn".
4. **Stale usage from a usage-less final turn (edges minor,
   `src/result-envelope.ts:543`) — fixed.** Snapshots replace rather than
   join, but a final `turn.completed` with the usage field absent — or an
   object carrying no counts — broke out early and left the previous
   turn's cumulative totals standing as the run's. Both shapes now reset
   the usage fields to null and clear `usageReported` (documented as
   whether the LAST completion carried a figure). Test:
   `tests/result-envelope.test.ts` — "a last turn that reports no usage
   resets the counts, never keeps stale ones" (absent and empty both).

Docs: four CHANGELOG bullets under 0.6.0 Fixed; README — the untrusted
refusal in Sessions and Sandbox Integration, the new drift shapes and the
usage reset in Result envelopes; one sentence in `docs/HERMETIC.md` where
scode keeping harness state writable is stated.

### Gate (round 9)

- `make release-gate` stops at `contracts` on this machine's known sandbox
  limitation (unchanged since round6): the copilot probe cannot write
  `~/Library/Caches/copilot/pkg/darwin-arm64` (EPERM); the step read
  1 pass / 1 fail. Re-run under a writable HOME: **2 pass / 0 fail,
  117 expect calls — identical to round 8**. Every other step ran to
  completion exiting 0 (those before `contracts` by make's own sequencing,
  those after re-run by hand): `runtime` (bun 1.4.2 over the 1.3.14
  floor), `check` (typecheck, `sh -n`, coverage suite),
  `sandbox-contract`, `smoke`, `bun audit` (no vulnerabilities, 9
  packages), the frozen-lockfile dry run, and the six help/verify
  variants.
- The coverage suite: **671 pass, 6 skip, 0 fail — 677 tests across 31
  files, 2315 expect() calls**, against round 8's 665 pass / 6 skip /
  0 fail (671 tests, 2297 expects): +6 tests — two launch-cleanup, one
  untrusted refusal covering both session modes, two ordering, one usage
  reset — skips unchanged at 6, fails 0. Whole-source conservative
  coverage 83.01% lines / 89.22% functions (from 82.33% / 88.94%).
- `check_american.py` over the 11 changed prose/comment files — clean.
- No live model calls this round (none needed); round 8's live session
  checks stand.

## Review fixes, round 10

Round 10 returned six actionable findings — four major, three minor counting
the correctness duplicates and the test-hygiene item — all in the "edges" and
"correctness" groups; the security group held informational confirmations
only (no defects) and both contracts groups were empty. The findings file
itself arrived partially corrupted: the correctness entry for the
`CLAUDE_CONFIG_DIR` trim mismatch appears twice, both contracts sections are
empty stubs, and the one security bullet touching `--output-last-message` is
truncated mid-sentence — its surviving text is a confirmation of the round-8
fallback design, so nothing actionable was lost. One line reference was
stale (`src/session.ts:1271` in a 111-line file; the target was the
classification loop at ~104). Every actionable finding is fixed on the
staged 0.6.0 tree with the smallest correct change, one regression test
each, and every test was mutation-checked (it fails with its fix reverted).
Still uncommitted, finished with `git add -A`.

### Round-10 findings

1. **Stdin consumed before adapter validation (edges major,
   `src/index.ts:261`) — fixed.** `-f -` read stdin before
   `validateRunRequest`, so an unsupported combination
   (`-a droid --session new -f -`) blocked on the read — up to the full
   30-minute default timeout for a producer that never closes the pipe —
   instead of rejecting `--session` at once. The run action now runs every
   prompt-independent check (capabilities, model, autonomy, availability,
   scode) and a preflight `adapter.validateRunRequest` before anything
   consumes stdin. The preflight carries a stand-in prompt
   (`PREFLIGHT_PROMPT`, the shortest text satisfying every prompt rule) so
   the single validator API is untouched — no adapter override changed —
   and the real prompt replaces the stand-in on the same request object
   (adapters key per-run state by its identity) for the authoritative
   second pass after the read. Prompt resolution from argv and prompt
   files stays ahead of the availability checks exactly as before: the
   first gate run failed three pinned precedence tests in
   `tests/cli-run.test.ts` (a missing prompt, an unreadable file, and the
   `-p`/`-f` conflict had started reporting "not installed" errors), so
   the reorder keeps those errors first and moves only the blocking stdin
   read. The read itself was already timeout-bounded (round 9's
   predecessor work); that is unchanged. Test:
   `tests/cli-stdin-prompt.test.ts` — "an unsupported flag combination is
   rejected before stdin is consumed" (a never-closed stdin pipe with
   `--timeout 30` must exit 1 within seconds, with the session-refusal
   diagnostic and no timeout diagnostic; under mutation it blocks the
   full 10s test budget).
2. **Empty structured results accepted as successful (edges major,
   `src/result-envelope.ts:104`, `:528`, `:729`) — fixed.** A Claude-family
   envelope with `result: ""` satisfied `--result-json` as a successful
   run while the plain `--session new` path refused the same envelope, and
   a codex turn whose only `agent_message` carried empty text passed the
   shared verdict. Both paths now treat an empty reply as absent:
   `claudeFamilyResult` gains a `replyAbsent` verdict (the envelope is
   still re-emitted with the block attached — its fields are the
   harness's own record — but `codemux.session_id` is null, the exit is
   non-zero, and stderr says why), and `codexStreamVerdict` fails an empty
   final message with the existing messageless-turn diagnostic. Tests:
   `tests/result-envelope.test.ts` — "the structured path refuses the
   empty result the plain path refuses" and "an empty agent message is no
   message, and a recorded one does not paper over it" (a nonempty
   `--output-last-message` fallback must not rescue the empty in-stream
   message).
3. **Malformed `agent_message.text` silently ignored (edges major,
   `src/result-envelope.ts:525`) — fixed.** A recognized
   `agent_message` item whose `text` was not a string was skipped, so a
   nonempty fallback file could pass the malformed stream off as a
   successful Plan-only turn. `parseCodexEventStream` now returns null for
   that item — the stream is the documented source for agent messages,
   and one it cannot carry is format drift, failing closed like every
   other drift shape (raw stdout kept verbatim, non-zero exit, codemux
   line on stderr). Test: `tests/result-envelope.test.ts` — "an
   agent_message with malformed text is drift, not an item to skip"
   (parse-level and through `codexResult` with the planted fallback).
4. **Trim-validation mismatch on `CLAUDE_CONFIG_DIR` (edges major +
   duplicated as the two correctness minors, `src/claude-family.ts:25`) —
   fixed.** Validation trimmed the value before the absolute-path check
   while the child received the original, so `" /var/claude-profile"`
   passed the check and still resolved relative against the run's working
   directory. `assertAbsoluteClaudeConfigDir` now validates the exact
   untrimmed value (only the literal empty string counts as no redirect;
   whitespace-only is refused as relative). The same rule applied to the
   sibling boundary the finding's class covers: `realCodexHome` in
   `src/adapters/codex.ts` validated nothing at all on a passed-through
   `CODEX_HOME` — it now refuses a non-absolute value the same way, an
   extension beyond the named site. Tests: `tests/adapters.test.ts` — "a
   whitespace-padded CLAUDE_CONFIG_DIR is refused, not trimmed absolute"
   (run and TUI, both padding shapes, empty-string passthrough) and "a
   whitespace-padded passed-through CODEX_HOME is refused, not trimmed";
   `tests/zai.test.ts` — the zai twin of the first.
5. **Missing-session classification stopped at the first match (edges
   minor, `src/session.ts:104`) — fixed.** The scan returned after the
   first line carrying the harness signature and compared only the first
   UUID on that line, so a wrapper id printed ahead of the harness's — or
   an earlier diagnostic naming another session — hid the line naming the
   requested one and a missing session degraded to exit 1 instead of 66.
   The scan now reads every signature line and compares every UUID on
   each; the no-id fallback is unchanged. Test:
   `tests/session.test.ts` — "every signature line is read, and every id
   on a line" (both shapes classify; other-session-only still does not).
6. **Diagnostics glued onto an unterminated stderr line (edges minor,
   `src/result-envelope.ts:232`, `:289`, `:305`, `:846`) — fixed.** The
   append sites assumed stderr ended with a newline, so `"boom"` became
   `"boomcodemux: …"`. A shared `appendDiagnostic` helper now separates
   the codemux line first, and the same-defect sites beyond the finding's
   list (`claudeFamilyResult`'s persisted-session line, `codexResult`'s
   parse-null, and codex's `processRunResult` appends) use it too. Test:
   `tests/result-envelope.test.ts` — "diagnostics append after an
   unterminated stderr line, not onto it" (a Claude-family and a codex
   site, both directions asserted).
7. **Test clobbered a caller's `CODEMUX_ALLOW_UNTESTED_HARNESS` (minor,
   `tests/harness-compatibility.test.ts:202`) — fixed.** The test assumed
   the override was initially unset and deleted it unconditionally, so
   running the suite with the documented override exported failed 1/35
   and removed the caller's value. It now saves the entry value, deletes
   for its refusal half, and restores in the cleanup. Verified both
   directions against the exported-override run: the staged pre-fix file
   fails exactly that one test; the fixed file passes 35/35.

Docs: six CHANGELOG bullets under 0.6.0 Fixed; README — the empty-result
and malformed-text rules plus the diagnostic separation in Result
envelopes, the exact-value validation and the any-line classification in
Sessions.

### Gate (round 10)

- `make release-gate` stops at `contracts` on this machine's known sandbox
  limitation (unchanged since round6): the copilot probe cannot write
  `~/Library/Caches/copilot/pkg/darwin-arm64` (EPERM); the step read
  1 pass / 1 fail. Re-run under a writable HOME: **2 pass / 0 fail,
  117 expect calls — identical to rounds 8 and 9**. Every other step ran
  to completion exiting 0 (those before `contracts` by make's own
  sequencing, those after re-run by hand): `runtime` (bun 1.4.2 over the
  1.3.14 floor), `check` (typecheck, `sh -n`, coverage suite),
  `sandbox-contract`, `smoke`, `bun audit` (no vulnerabilities, 9
  packages), the frozen-lockfile dry run, and the six help/verify
  variants.
- The coverage suite: **680 pass, 6 skip, 0 fail — 686 tests across 31
  files, 2353 expect() calls**, against round 9's 671 pass / 6 skip /
  0 fail (677 tests, 2315 expects): +9 tests — four result-envelope
  (empty Claude result, malformed text, empty codex message, diagnostic
  separation), one session scan, two adapter env-dir paddings, one zai
  twin, one stdin ordering — skips unchanged at 6, fails 0.
  Whole-source conservative coverage 82.52% lines / 89.29% functions
  (from 83.01% / 89.22%): functions up; lines down because the round adds
  CLI-wiring lines in `src/index.ts`, whose coverage report is omitted
  (its code runs in spawned processes) and which the conservative figure
  counts as fully uncovered.
- `check_american.py` over the changed files — clean (11 source/test
  files, then the three docs after their edits).
- No live model calls this round (none needed); round 8's live session
  checks stand.

## Review fixes, round 11

Round 11 returned no actionable findings. Of the five auditor groups only
security carried entries, and all five of its bullets are confirmations of
the staged tree — each restates a protection rounds 8 through 10 put in
place and says so in its own words ("no weaker", "All of this tightens",
the fail-closed reads). The correctness, contracts, edges, and contracts-2
groups are empty. Nothing to fix, so no code changed this round, no
regression tests were added, and CHANGELOG/README stay as the earlier
rounds left them (no behavior changed). Each bullet was re-verified against
the staged tree before being accepted as a confirmation rather than taken
on trust; all five hold.

### Round-11 findings (all five informational)

1. **Codex autonomy flags — verified, no change.** `mapAutonomy` passes
   `-c approval_policy="…"` with never/untrusted per level
   (`src/adapters/codex.ts:135-156`); none is looser than the old `-a`
   values. The reviewer's open question — whether codex drops `-a` before
   `exec` — could not be probed here either: the codemux-guard hook blocks
   a raw `codex --help` (PreToolUse denial, the same wall the reviewer
   hit), and bypassing it was not an option. The claim stands as documented
   in the code comment (the root parser owns `-a`, the exec handoff copies
   only SharedCliOptions, and at 0.159.x `-a` accepts only on-request and
   never), and the mapping is no weaker either way — the finding's own
   conclusion. Pinned by `tests/adapters.test.ts:776-782` and
   `1399-1402`.
2. **Version probe environment — verified, no change.** The probe runs
   with an allowlist, not the parent environment
   (`probeEnvironment`, `src/environment.ts:124-192`);
   `COPILOT_CLI_DIST_DIR` is on the forbidden list (`:86`), and a
   passed-through `OPENCODE_BIN_PATH` warns that the version is
   unconfirmed while still probing and refusing the default binary below
   the minimum (`src/cli-runtime.ts:405-440`) — the one line reference in
   the findings that matches this tree.
3. **`--output-last-message` file — verified, no change.** Read with
   `O_NOFOLLOW`, a regular-file check, and the 16 MiB bound
   (`readFinalMessageFallback`, `src/adapters/codex.ts:489-519` over
   `readUtf8FileBounded`, `src/file-io.ts:26-46`), then removed; a launch
   that rejects removes it too through `cleanupRun`
   (`src/launch.ts:62-72`).
4. **Session ids — verified, no change.** Checked against the UUID
   pattern before they reach argv (`src/session.ts:26-32`, enforced at
   `src/adapters/base.ts:329-334`); a hermetic resume is refused for every
   harness (`base.ts:337-348`), and codex refuses a hermetic
   `--session new` because the private home dies at exit
   (`codex.ts:367-378`).
5. **`-f -` stdin prompt — verified, no change.** A terminal stdin is
   refused, the read is byte-capped, and `--timeout` bounds it
   (`src/index.ts:45-115`); the run timeout governs the read — the
   never-closing-producer test fails at the timeout, not after it
   (`tests/cli-stdin-prompt.test.ts:172`).

One pattern worth recording: every line reference in the findings except
`cli-runtime.ts:408-435` is stale — `launch.ts` cited at 619-628 in a
73-line file, `session.ts` at 690-727 in a 121-line file, `index.ts` at
637-695 and 860-876 in a 614-line file, and the rest landing on unrelated
code. The claims themselves all match the tree; the numbers read as if
computed against a different state. Round 10 saw the same thing for one
citation; round 11's file does it systematically.

### Gate (round 11)

- `make release-gate` stops at `contracts` on this machine's known sandbox
  limitation (unchanged since round6): the copilot probe cannot write
  `~/Library/Caches/copilot/pkg/darwin-arm64` (EPERM); the step read
  1 pass / 1 fail. Re-run under a writable HOME: **2 pass / 0 fail,
  117 expect calls — identical to rounds 8 through 10**. Every other step
  ran to completion exiting 0 (those before `contracts` by make's own
  sequencing, those after re-run by hand): `runtime` (bun 1.4.2 over the
  1.3.14 floor), `check` (typecheck, `sh -n`, coverage suite),
  `sandbox-contract`, `smoke`, `bun audit` (no vulnerabilities, 9
  packages), the frozen-lockfile dry run, and the six help/verify
  variants.
- The coverage suite: **680 pass, 6 skip, 0 fail — 686 tests across 31
  files, 2353 expect() calls — identical to round 10**, as expected for a
  round that changes no code. Whole-source conservative coverage 82.52%
  lines / 89.29% functions, unchanged.
- `check_american.py` over all 34 staged files — clean.
- No live model calls this round (none needed; the contracts step probes
  installed `--help`/`--version` output only); round 8's live session
  checks stand.

Still uncommitted; finished with `git add -A`.

## Review fixes, round 12

Five auditors ran again; this round produced findings. Correctness (codex)
and security (claude) passed; edges (opencode) errored out with exit 124 and
reported nothing; contracts (zai) returned one minor; contracts-2 (kimi)
returned the round's one major plus seven minors. The verifier (codex)
confirmed the major, confirmed five minors, partly confirmed the probe
allowlist one, and refuted the compatibility-ledger one. The zai finding
duplicates kimi's changelog finding, so eight unique findings, all addressed
below. One behavior change is release-relevant (the exit-66 classification),
two more are error-path and environment changes; the rest are comment and
documentation corrections.

### Round-12 findings and dispositions

1. **Exit-66 fallback misclassification (major) — fixed.** The docstring
   promised the incidental fallback (the requested id appearing anywhere in
   stderr) only "when no signature line names an id at all," but the code
   armed it when ANY signature line lacked one, even beside a line naming
   another session's UUID. Resuming A against stderr naming B missing, an
   id-less signature line, and A mentioned elsewhere — a concatenating
   wrapper's shape — exited 66 claiming A is gone while the harness
   reported only B missing. The fallback now fires only when no signature
   line named any id (`src/session.ts:110-131`); the mixed shape degrades
   to exit 1 with the harness's own stderr. Regression test:
   `tests/session.test.ts:168`.
2. **Changelog outcome-field parenthetical (minor, found by both kimi and
   zai) — fixed.** The 0.6.0 bullet listed `subtype` as a sufficient
   outcome field while the code (and the bullet's own next sentences)
   reject a bare success subtype; round 7's tightening never amended the
   round-5 wording. The parenthetical now names the two real outcomes:
   the `result` text, or a failure the envelope itself reports
   (`is_error`, an `error_*` subtype).
3. **Compatibility-ledger header (minor, refuted by the verifier) —
   clarified anyway.** The verifier held that the 2026-10-03 addendum is a
   verification pass, not an audit, and the table's audit versions stand.
   The reader-confusion part is still real — the header named the newest
   activity as 2026-09-21 while a dated 2026-10-03 addendum sat below — so
   the header now names the most recent verification pass as exactly that,
   with the audited versions unchanged
   (`docs/HARNESS-COMPATIBILITY.md:3-5`).
4. **Pre-stdin ordering comment (minor) — fixed.** The comment claimed
   every no-prompt-text check runs before stdin is consumed, but the
   version gate runs after the (timeout-bounded) read. The comment now
   says the request checks run first and names the one deliberate
   exception (`src/index.ts:311-317`).
5. **`turnCompleted` field doc (minor) — fixed.** The doc read "the
   stream's last turn ended with `turn.completed`," but the computed value
   is true whenever every turn closed and at least one completed — a last
   failed turn included, with `failure` carrying the bad news. The doc now
   states that, and a new test pins the field to its documented value so
   they cannot drift apart again (`src/result-envelope.ts:433-445`,
   `tests/result-envelope.test.ts:768`).
6. **Z.AI `||` vs `??` model fallback (minor) — fixed.** `buildRunCommand`
   fell back on `||` while result processing used `??`, so an empty-string
   model would have run `--model opus` with the envelope reporting `""`.
   Validation rejects the empty name on every launch path, so nothing
   reachable split — both now use `||`, and a test pins the argv and the
   envelope to the same fallback (`src/adapters/zai.ts:268,293`,
   `tests/zai.test.ts:161`).
7. **Unguarded `rmSync` in the codex fallback reader (minor) — fixed.**
   The final `rmSync` sat outside its try/catch, so an `EACCES`/`ENOTEMPTY`
   there rejected processing of a finished run and replaced its result
   with a cleanup error. It is now guarded the way the rejected-launch
   cleanup's twin is: the failure is said on stderr and stays out of the
   run's way (`src/adapters/codex.ts:517-528`). Regression test: a
   read-only `CODEX_HOME` makes the removal fail with `EACCES` while the
   read succeeds, and the run's result stands
   (`tests/adapters.test.ts:1240`).
8. **Probe allowlist omitted `LC_*` (minor, partly confirmed) — fixed.**
   `probeEnvironment` matched `INERT_ENV` alone while
   `sanitizeEnvironment` also keeps every `LC_*` name, so the `--version`
   exec and the run could resolve locales differently. The prefix rule now
   matches, keeping the probe a subset of the launch
   (`src/environment.ts:225-234`). Regression test:
   `tests/harness-compatibility.test.ts:490`.

CHANGELOG gained three bullets under 0.6.0 Fixed (the exit-66 fallback, the
codex cleanup guard, the probe locale names) and the corrected outcome-field
wording; no README claim changed with them, so README is untouched.

### Gate (round 12)

- `make release-gate` stops at `contracts` on this machine's known sandbox
  limitation (unchanged since round6): the copilot probe cannot write
  `~/Library/Caches/copilot/pkg/darwin-arm64` (EPERM); the step read
  1 pass / 1 fail. Re-run under a writable HOME: **2 pass / 0 fail,
  117 expect calls — identical to rounds 8 through 11**. Every other step
  ran to completion exiting 0: `runtime` (bun 1.4.2 over the 1.3.14
  floor), `check` (typecheck, `sh -n`, coverage suite),
  `sandbox-contract`, `smoke`, `bun audit` (no vulnerabilities, 9
  packages), the frozen-lockfile dry run, and the six help/verify
  variants.
- The coverage suite: **685 pass, 6 skip, 0 fail — 691 tests across 31
  files, 2373 expect() calls** against round 11's 680/6/0 over 686 tests
  and 2353 expects: +5 tests (the five regression tests above), +20
  expects, no failures. Whole-source conservative coverage 82.53% lines /
  89.32% functions (round 11: 82.52% / 89.29%).
- `check_american.py` over the 13 changed source, test, and doc files —
  clean.
- No live model calls this round (the contracts step probes installed
  `--help`/`--version` output only); round 8's live session checks stand.

Still uncommitted; finished with `git add -A`.

## Review fixes, round 13

Five auditors again; the round13 gate verdict was FAIL at major. Correctness
(codex), security (claude), and contracts-2 (kimi) passed; edges (opencode)
returned the round's three majors (blocking), and contracts (zai:glm-5.3)
returned one minor. The verifier (codex) confirmed both failing reports.
Four unique findings, all fixed below. (The findings file itself was cut
mid-write at eight lines, ending inside the zai section header; the full
review text was recovered from `review-060m.log` in the same scratchpad.)
Three fixes are code, one is a doc-drift fix resolved in the code's favor;
none change a successful run's output.

### Round-13 findings and dispositions

1. **Concurrent same-request launches race the per-run record (major) —
   fixed.** Codex keys per-run state (the `--output-last-message` file, the
   private hermetic home) by the request object, so two overlapping launches
   through ONE object let run B's `prepareRun` overwrite run A's record:
   A's completion consumed B's fallback file while A's own went unread and
   undeleted. `prepareRun` now refuses a request whose record still stands
   (`RunRequestInFlightError`, thrown before any mutation), so the live
   launch's state survives whole; the launch paths rethrow that error
   without running `cleanupRun` (the refusing launch recorded nothing, and
   cleanup would dispose the live launch's file), and `BaseAdapter.run`
   gained the same disposal-on-rejection the sandboxed path already had, so
   a direct-path rejection cannot wedge a request as permanently in flight
   (`src/adapters/base.ts:48,477`, `src/adapters/codex.ts:89,116,329`,
   `src/launch.ts:97`). Sequential reuse of a request object keeps working
   once the earlier launch consumed its record. Regression test:
   `tests/adapters.test.ts:1190` (verified red against the staged sources).
2. **Untrusted sandbox + sessions unchecked on the shared launch path
   (major) — fixed.** The refusal lived only in the CLI action, so a direct
   caller of `launchRunRequest` could report a new session as persisted
   even though the untrusted preset denies the harness-state directories
   its storage needs, or misreport an existing resumed session as missing
   (exit 66). The shared path now refuses on the RESOLVED trust preset
   (`src/launch.ts:62-75`), which also covers a policy that resolves to
   untrusted without the explicit flag; the CLI preflight stays so the
   rejection still precedes a `-f -` stdin read, whose only bound is the
   run's timeout (`src/index.ts:235-244`). Regression test:
   `tests/adapters.test.ts:1250` (verified red).
3. **Exit-66 classification read post-processed stderr (major) — fixed.**
   The missing-session scan ran on `result.stderr` after adapter
   post-processing, and a post-processor can append a codemux diagnostic
   naming the requested id (an envelope naming another session says which
   id it expected). With an id-less harness signature line, codemux's own
   line was the only place the id appeared, and the scan's incidental
   fallback took it as the harness identifying the session — exit 66 for a
   run the harness never classified. The launch path now keeps the
   harness's own stderr on the result (`rawStderr`, attached only when
   post-processing changed stderr, so untouched results keep their exact
   shape) and the CLI classifies against it
   (`src/types.ts:107-118`, `src/launch.ts:19-28`,
   `src/index.ts:431-445`). Regression test: the false-66 shape now exits 1
   (`tests/cli-session.test.ts:301`, verified red) and the true positive
   under `--result-json` — the harness naming the id on the signature line
   — still exits 66 (`tests/cli-session.test.ts:336`).
4. **Padding doc overclaim (minor, zai) — fixed in the code's favor.** The
   CHANGELOG and README say a whitespace-padded `CLAUDE_CONFIG_DIR` or
   `CODEX_HOME` passed through `--pass-env` is refused, but the checks read
   only `isAbsolute`, which inspects the leading character: `"/var/claude "`
   (absolute, trailing space) passed while the harness — which does not
   trim either variable — would keep the padding, landing the session
   store in a directory whose name still carries it. The published contract
   stands and the checks now enforce it: surrounding whitespace on an
   absolute value is refused with its own diagnostic
   (`src/claude-family.ts:31-53`, `src/adapters/codex.ts:186-201`); the
   CHANGELOG bullet gained the absolute-with-padding sentence
   (`CHANGELOG.md:287-298`). Regression tests:
   `tests/adapters.test.ts:438,777` (both verified red).

The zai report's "could not be checked" item — whether Claude Code's
`--resume <id>` under `--output-format json` reports the same `session_id`
the resume named, which `envelopeSessionProblem` requires — needs a paid
model call and is left exactly as the reviewer left it.

CHANGELOG gained four entries under 0.6.0 Fixed (the in-flight refusal,
the shared-path untrusted refusal, the raw-stderr classification, and the
absolute-with-padding sentence on the round10 bullet); README's session
section now says the exit-66 scan reads the harness's own stderr and that
the untrusted refusal is enforced on the shared launch path.

### Gate (round 13)

- `make release-gate` stops at `contracts` on this machine's known sandbox
  limitation (unchanged since round6): the copilot probe cannot write
  `~/Library/Caches/copilot/pkg/darwin-arm64` (EPERM); the step read
  1 pass / 1 fail. Re-run under a writable HOME: **2 pass / 0 fail,
  117 expect calls — identical to rounds 8 through 12**. Every later step
  ran to completion exiting 0: `sandbox-contract`, `smoke`, `bun audit`
  (no vulnerabilities, 9 packages), the frozen-lockfile dry run, and the
  six help/verify variants; `runtime`, `typecheck`, and `sh -n` passed
  ahead of it.
- The coverage suite: **691 pass, 6 skip, 0 fail — 697 tests across 31
  files, 2392 expect() calls**, against the same invocation before this
  round's changes (685 pass, 6 skip, 0 fail over 691 tests, 2373
  expects): +6 tests (the six regression tests above, each verified red
  against the staged pre-fix sources), +19 expects, no failures. The
  previous gate log (`gate-060m.log`) records 689 pass / 2 skip for the
  same tree; the four-test delta is environmental skip behavior on this
  machine, not a code difference — the round12 report's own run read
  685/6/0.
- `check_american.py` over the ten changed source, test, and doc files —
  clean.
- No live model calls this round (the contracts step probes installed
  `--help`/`--version` output only); round 8's live session checks stand.

Still uncommitted; finished with `git add -A`.

## Review fixes, round 15

This round was structural. Fourteen review rounds kept finding ways for per-run
state living on singleton adapters to leak between launches, so the state moved
off the adapters entirely: `prepareRun` now returns a `RunContext` (the
`--output-last-message` path, the private hermetic home) that the launcher owns
and threads through `buildRunCommand`, `getRunEnv`, `processRunResult`, and
cleanup. Every adapter field and WeakMap that held per-run data is deleted
(`runStates`, `hermeticHomes`, `disposeHermeticHome`), and with them
`RunRequestInFlightError` and the request-identity rules — overlapping launches
through one request object are legal again, each carrying its own context. A
launch that rejects cleans up only the context it created: one that rejects
before `prepareRun` (an untrusted sandbox, a refused request) has no context at
all, and one that rejects after disposes its own. `BaseAdapter.run` follows the
same ownership rule — a caller-supplied context is used but never disposed; a
self-created one is disposed before the result returns. Static previews
(`verify`) call `buildRunCommand` without a context and get placeholder scratch
paths, the same fail-closed shape as before. A hermetic home is now finalized
when its launch ends rather than at process exit — the same `finalize`, earlier;
the exit sweep in `hermetic-home.ts` still covers a crashed launch.

The launch path also has one `passthroughEnv` source now: `LaunchOptions`
carried a second list that only the sandbox environment was built from, and it
is gone — validation and the build read `request.passthroughEnv` alone. The
`--session` surface was re-verified unchanged and minimal: codemux-generated
ids pinned by `--session-id` with envelope equality on Claude and Z.AI, the
single `thread.started` id on Codex, exit 66 only on the pinned per-harness
signature naming the resumed id, no store verification or heuristics anywhere.

### Round-15 findings and dispositions

1. **Rejected launch destroys another run's state (major, listed twice) —
   closed by the restructure.** With per-run state keyed by the request object,
   a second launch that rejected before `prepareRun` (untrusted sandbox
   options) ran `cleanupRun` against the live run's record, deleting its
   `--output-last-message` file — a successful Plan-only run then lost its
   reply and reported failure. The reviewer reproduced it without launching a
   harness; the regression test reproduces it the same way and was verified
   red against the staged sources (`existsSync(fileA)` came back false at the
   first rejection). Fix: the context ownership rule above.
   `tests/adapters.test.ts:1254`.
2. **`passthroughEnv` validated from the request, built from the options
   (edges, major) — fixed.** A programmatic caller could pass a relative
   `CLAUDE_CONFIG_DIR` only through `LaunchOptions.passthroughEnv`: validation
   read the request's list and passed, while the child received the relative
   value from the options list, bypassing the absolute-path guard. The options
   field is deleted; the request's list is the single source.
   `tests/adapters.test.ts:1356` pins the contract through the launch path
   (the bypass itself is no longer constructible — exercising it would need
   the deleted field, a type error).
3. **A session id with mode `none` or no mode was silently ignored (edges,
   major) — fixed.** A programmatic `RunRequest` carrying a valid id with the
   mode omitted or `none` ran an unrelated ephemeral conversation; the id must
   now arrive exactly with `new` or `resume`, and those modes refuse to run
   without it. The rule moved into `BaseAdapter.validateRunRequest` — the one
   validator every launch path runs — replacing the three per-adapter copies
   (claude, zai, codex) that each covered only half of it.
   `tests/base.test.ts:613`.
4. **Cross-harness session replay (security trigger) — documented behavior.**
   A claude-created session resumed under zai (or the reverse) replays the
   transcript through the other agent's endpoint. That is inherent to two
   harnesses sharing one session-store layout, and README's Sessions section
   already says it in those words ("resume a session through the agent you
   mean", lines 429-433). Kept as documented.
5. **The remaining bullets are confirmations of rounds 11 through 14** — the
   codex approval-flag mapping, the version-probe environment subset, the
   `--output-last-message` file hygiene (pid + uuid name, no-follow read,
   removed on both paths), the untrusted-sandbox session refusals on both the
   CLI preflight and the resolved-trust launch path, the hermetic session
   rules, the padded `CODEX_HOME`/`CLAUDE_CONFIG_DIR` refusals, and the
   `-f -` stdin bounds — plus a contracts pass confirming the tree matched the
   gated state and the documented envelope/session/version contracts. Nothing
   to change.

Regression tests, one per finding plus the ownership rule: four of the five
verified red against the staged pre-fix sources (the rejected-launch
isolation, the overlapping same-request launches, the session-id/mode rule,
and `run()`'s context ownership); the fifth (finding 2) pins a contract whose
bypass channel no longer exists. Net +4 tests over the round-14 tree (the
in-flight-refusal test became the overlapping-launches test).

CHANGELOG: two 0.6.0 entries rewritten (they described request-keyed state and
the in-flight refusal, neither of which ships) and three Fixed entries added
for findings 1 through 3. README, HARNESS-COMPATIBILITY, and HERMETIC needed
no change — the restructured internals never appeared in them, and the
cross-harness replay note already covers finding 4.

### Gate (round 15)

- `make release-gate` stops at `contracts` on this machine's known sandbox
  limitation (unchanged since round6): the copilot probe cannot write
  `~/Library/Caches/copilot/pkg/darwin-arm64` (EPERM); the step read
  1 pass / 1 fail. Re-run under a writable HOME: **2 pass / 0 fail,
  117 expect calls — identical to rounds 8 through 13**. Every later step ran
  to completion exiting 0: `sandbox-contract`, `smoke`, `bun audit` (no
  vulnerabilities, 9 packages), the frozen-lockfile dry run, and the six
  help/verify variants; `runtime`, `typecheck`, `sh -n`, and the coverage
  suite passed ahead of it inside the gate.
- The coverage suite: **695 pass, 6 skip, 0 fail — 701 tests across 31 files,
  2412 expect() calls**, against 697 tests / 2392 expects before this round:
  +4 tests, +20 expects, no failures.
- `check_american.py` over the changed prose (CHANGELOG.md, this section, the
  scratch notes) — clean.
- Live checks through `./bin/codemux run --no-sandbox --auto high` (the
  task's `--no-sandbox` is a `run` flag, not a global one): `zai
  --session new --result-json` exited 0 with result `OK` and
  `codemux.session_id` `1c36395b-e1cf-4616-a858-7b8508b87053`, the envelope's
  own `session_id` equal to it; the matching `resume:` run exited 0 with
  `STILL OK`, the same session id, and 768 cached input tokens — the
  conversation actually carried over; `codex --result-json` exited 0 with
  `OK` and `session_id` null (an ephemeral none-mode run, by design).

Still uncommitted; finished with `git add -A`.

## Review fixes, round 17

One major and seven smaller findings. The major closed the last open
classification hole in exit 66: `sessionMissingError` compared the requested id
against every UUID on a signature line, so a wrapper banner carrying the
requested id ahead of the harness's own phrase made the harness's report about
some *other* session classify as the requested one missing. The id that counts
is now the UUID that follows the harness's own phrase, read per occurrence:
each signature span on a line names the first UUID after it, never one before
it, and exit 66 requires some span to name the requested id. The round10
multi-line scan and the round12 fallback (fires only when no signature line
names any id at all) are unchanged.

The security minors got real fixes rather than documentation this round. The
cross-provider replay hazard — a claude-created session resumed under zai sends
the transcript to Z.AI's endpoint — is closed by an ownership record: the CLI
writes the creating agent of every session it persists into `sessions.json`
beside its config file (fail-open reads, ids validated as UUIDs, agents
validated against the registry, keys lowercased) and refuses a resume of a
recorded session through a different agent before launch, naming the agent to
use instead. The record lives at the CLI level only, not in the adapters —
adapter unit tests call `processRunResult` with successful `new`-mode requests
and would otherwise write the operator's real config directory. Codex is
excluded on purpose: no other agent reads `CODEX_HOME`, and the persisted id
there is the thread id, not the generated `session.sessionId`. The second
security minor moved direct-path validation ahead of `prepareRun`, so a request
the run will refuse never writes codex's `--output-last-message` path or a
hermetic home to disk first.

The remaining minors and contracts items: a whitespace-only reply (`" \n"`)
now fails on both the Claude-family envelope path and the codex verdict, like
the empty reply already did; a codex run whose last turn failed reports null
usage fields instead of carrying the last completed turn's cumulative figure
into the failure envelope; `total_tokens` needs the cache-read count too (the
uncached input and the joined cached count both need it, so a total without it
claimed a sum of components that were themselves null); the stale
`tests/base.test.ts` comment citing deleted request-identity machinery is
rewritten; and README no longer says raw stdout is kept for the empty-result
case — the `--result-json` path re-emits the envelope with the codemux block
there, and the sentence now says so.

### Round-17 findings and dispositions

1. **A wrapper prefix containing the requested id yields exit 66 while the
   harness named a different id (major) — fixed.** The scan read every UUID on
   the line as the harness naming one; now only the UUID following the
   harness's own phrase counts, per occurrence, so a prefix id cannot lend the
   signature to another session. Anything else is an ordinary exit-1 failure.
   `tests/session.test.ts:174` (prefixed line with a different named id must
   not classify as missing; the control line must).
2. **Whitespace-only replies pass as success (minor, both harness families) —
   fixed.** `src/result-envelope.ts:270` (Claude-family `replyAbsent`) and
   `src/result-envelope.ts:801` (codex `codexStreamVerdict`) now treat
   trimmed-empty as absent. `tests/result-envelope.test.ts:547` and
   `:1226`.
3. **A failed turn keeps the earlier turn's usage totals (minor) — fixed.**
   The end-of-parse failure branch now resets usage to nulls alongside the
   final message (`src/result-envelope.ts:706`), so the failure envelope
   cannot state exact usage for a run whose true total is that figure or more.
   `tests/result-envelope.test.ts:784` and `:1205`.
4. **Cross-provider session resume replays the conversation to another
   provider (security minor) — fixed with the ownership record.**
   `src/session.ts:178-247` (`sessionOwnersPath`, `readSessionOwners`,
   `recordSessionOwner`, `assertSessionResumableThrough`), wired in
   `src/index.ts:268` (refusal before launch) and `src/index.ts:454`
   (recording after a successful `new` run, claude and zai only). Round 15 had
   dispositioned this as documented behavior; round 17 asked for the fix.
   `tests/session.test.ts:226` (four tests: record and refuse, case
   insensitivity, unknown session passes, corrupt file fails open) and the
   end-to-end `tests/cli-session.test.ts:512` (a shared fake home: create
   through claude, zai resume refused, claude resume control passes).
5. **Codex scratch state is created before validation (security minor) —
   fixed.** The direct path validates before `prepareRun` now
   (`src/launch.ts:59`), matching the sandboxed path.
   `tests/adapters.test.ts:1386`.
6. **`total_tokens` computed without `cached_input_tokens` (contracts) —
   fixed.** All four raw counts must be reported for the sum
   (`src/result-envelope.ts:657-660`). `tests/result-envelope.test.ts:763`.
7. **Stale comment citing deleted machinery (contracts) — rewritten.**
   `tests/base.test.ts:561-562` now describes the request-object pin as it is;
   no code change, no test.
8. **README's "raw stdout kept" claim is wrong for the empty-result case
   (contracts) — corrected.** The empty-reply failure re-emits the envelope
   with the codemux block under `--result-json` (codemux-appended content, not
   bare bytes); plain `--session new` keeps raw stdout. README's envelope
   passages (`README.md:356`, `:384`) and the Sessions section
   (`README.md:442`) now say both. No code change beyond finding 2's, which
   the passages document.

Regression verification: the eight new tests were run against the staged
pre-fix sources (`git diff -- src/` parked aside, `git checkout -- src/`,
restore after). All eight red — seven as failures plus `tests/session.test.ts`
failing at module load (its new registry import does not exist pre-fix), so the
major's own case was additionally checked by direct invocation against the
staged `session.ts`: the prefixed line returned `true` (the bug) and the
control line `true` (correct). With the fixes restored the four files run
243 pass / 0 fail. Net +12 tests over the round-15 tree.

CHANGELOG: six 0.6.0 Fixed entries (findings 1 through 6). README and
HARNESS-COMPATIBILITY updated for findings 2, 4, and 8; the registry's
location and fail-open reads are documented in README's Sessions section.

### Gate (round 17)

- `make release-gate` exits 2 at `contracts` on this machine's known sandbox
  limitation (unchanged since round6): the copilot probe cannot write
  `~/Library/Caches/copilot/pkg/darwin-arm64` (EPERM); in-gate the step read
  1 pass / 1 fail, 67 expect calls. Re-run under a writable HOME:
  **2 pass / 0 fail, 117 expect calls — identical to rounds 6 through 15**.
  Every later step ran to completion exiting 0: `sandbox-contract`, `smoke`,
  `bun audit` (no vulnerabilities, 9 packages), the frozen-lockfile dry run,
  and the six help/verify variants; `runtime`, `typecheck`, `sh -n`, and the
  coverage suite passed ahead of it inside the gate. One gate-only fix during
  the run: the new ProbeAdapter test needed an explicit
  `AdapterCapabilities` return annotation — `bun test` runs inferred types
  fine, `tsc` does not (the inferred `autonomyLevels` widens to `string[]`).
- The coverage suite: **707 pass, 6 skip, 0 fail — 713 tests across 31 files,
  2448 expect() calls**, against the round-15 baseline of 695 pass / 6 skip,
  701 tests, 2412 expects: +12 tests, +36 expects, no failures.
- `check_american.py` over the changed prose (README.md, CHANGELOG.md,
  docs/HARNESS-COMPATIBILITY.md, this section) — clean.

Still uncommitted; finished with `git add -A`.

## Review fixes, round 19

Round 19 reviewed the tree that still carried session resume, and its
findings split cleanly in two: four defects in code that stays, and a set of
defects in the session machinery itself. The session machinery is gone this
round — deferred to the live-sessions design — which closes its findings the
only way that does not spend fixes on code about to be rewritten.

### Deferred: session resume

Removed, completely:

- The `--session <new|resume:<id>>` option on `run`, and with it the
  `sessionMode`/`sessionId` fields on `RunRequest`.
- `src/session.ts` — option parsing and UUID pinning, the exit-66
  `sessionMissingError` classification and its phrase-following-UUID scan,
  and the ownership record (`sessions.json` beside the config file) with
  `readSessionOwners` / `recordSessionOwner` / `assertSessionResumableThrough`
  and everything that read or wrote it (`src/index.ts`'s record-after-success
  and refuse-before-launch wiring included).
- The session branches in the adapters: claude and zai resume argv and
  envelope session verification, codex `exec resume` and the
  thread-id-vs-resume-id check. The persistence-avoidance flags stay and are
  now unconditional: Claude and Z.AI launch with `--no-session-persistence`,
  Codex with `--ephemeral`.
- `tests/session.test.ts` and `tests/cli-session.test.ts` in full, plus every
  session case inside the kept suites.
- The Sessions section of README, the session passages in
  docs/HERMETIC.md and docs/HARNESS-COMPATIBILITY.md, and the session bullets
  in the CHANGELOG's 0.6.0 entries.

Why: resume was built for a single-process CLI, and the design that actually
needs it — live sessions held by a service, `~/Programming/Ops/lab-service/
docs/codemux-live-session-prompts.md` — ships in a later release. Carrying
the unshipped surface through 0.6.0 costs review findings against code that
will be rewritten around a different lifecycle (and the round-19 findings
below are exactly that cost). With the flags above unconditional, no codemux
run persists a session, so nothing exists for another provider or process to
resume. `codemux.session_id` stays in the `--result-json` block — always
`null`, documented as reserved for the live-sessions release — so envelope
consumers keep a stable field to read when it lands.

When it returns, the design must answer what the removal left open: how a
hermetically created session is marked clean enough to resume under
`--hermetic` again, and what a resume means for a Codex run whose private
`CODEX_HOME` is destroyed at exit (docs/HERMETIC.md, "Session persistence").

### Round-19 findings and dispositions

Fixed — the findings in code that survives:

1. **`run()` mutates the caller's request (major, edges) — fixed.** Pinning
   an unset autonomy assigned `request.autonomy` on the caller's object: a
   `TypeError` on a frozen request, and one caller's launch editing a
   request another caller shared. The pin lands on an effective copy, and a
   launch that already ran `beforeLaunch` (a caller-supplied run context)
   does not fire it again — exactly once per launch either way.
   `src/adapters/base.ts` (`run`). `tests/base.test.ts`: "run() never
   writes to the caller's request object" — a frozen request without
   autonomy runs green and the object stays untouched, while the command
   builder observes the pinned level.
2. **The codex parser accepts a second completed turn after one
   `thread.started` (major, edges) — fixed.** A concatenated or malformed
   stream could return the second run's result while the single
   announcement still named the first run's thread. One `codex exec` run is
   one turn: a `turn.started` after any `turn.completed` — or while another
   turn is open — is drift, refused like any other grammar break (raw
   stdout kept, non-zero exit, no envelope). `turn.failed` is not a
   completion, so the round-8 failed-then-retried shape still parses with
   the failure standing and usage nulled. `src/result-envelope.ts`
   (`parseCodexEventStream`). `tests/result-envelope.test.ts`: "a second
   turn after a completed one is drift: one run is one turn".
3. **The unsandboxed path ran `prepareRun()` before `beforeLaunch()`
   (minor) — fixed.** Both launch paths now run validation, then
   `beforeLaunch`, then `prepareRun`; a request the launch will refuse never
   writes scratch state, and preparation may rely on initialization
   `beforeLaunch` performed. `src/launch.ts`.
4. **`total_tokens` summed the unclamped input (minor) — fixed.** Cached
   input above total input clamps the uncached term to zero, but the total
   still used the raw figure, so input 5 / cached 10 / output 1 reported
   components summing to 11 under a total of 6. The total now sums the
   three normalized fields the envelope publishes:
   `max(0, input − cached) + cached + output` — 11, as it reads.
   `src/result-envelope.ts`. `tests/result-envelope.test.ts`: the clamp
   fixture asserts both the clamped fields and the total.

Closed by the removal — findings in session code that no longer exists:

5. **Ownership records silently disappear at the size limit (major,
   correctness; reported twice).** The reader rejected `sessions.json` over
   256 KiB and then treated every session as unowned, with no writer-side
   limit or pruning, and the next write replaced the whole history —
   ordinary accumulation eventually disabled the cross-provider guard.
6. **The owner was recorded only on success (security).** Claude Code
   writes the transcript during the run, so a persisted-then-failed session
   was never recorded and could be resumed through the other provider.
7. **Concurrent `--session new` runs raced the ownership file (major,
   edges).** An unlocked read-modify-write could drop one run's entry.
8. **Ownership followed `XDG_CONFIG_HOME` while sessions followed
   `HOME`/`CLAUDE_CONFIG_DIR` (major, edges).** Moving only
   `XDG_CONFIG_HOME` between creation and resume hid the record without
   moving the store.
9. **A whitespace-only final message leaked to stdout on the failed plain
   codex session path (minor).** The plain-session path itself is gone.
10. **Exit-66 classification and session-guard contracts (contracts).**
    Moot: there is no session mode to classify or guard. The surviving
    halves of the contracts checks — usage math and the envelope verdicts
    minus sessions — still hold and are pinned by the tests that remain.

One fixture consequence of finding 2, handled rather than reverted: the
multi-turn tests that asserted cumulative usage across turns ("keeps the
last usage snapshot", "a last turn that reports no usage resets", "a new
turn discards the previous one's message") described exactly the
wrapper-concatenation shape the parser must now refuse, and were removed;
the turn-failed-terminality, turn-completed-semantics, and failed-run
null-usage tests were re-shaped failed-first so they still exercise their
original rules under the one-turn grammar.

### Gate (round 19)

- The coverage suite: **614 pass, 6 skip, 0 fail — 620 tests across 29
  files, 2171 expect() calls**, against the round-17 baseline of 707 pass /
  6 skip, 713 tests, 2448 expects: −93 tests and −277 expects, all of them
  session machinery or session cases in kept suites, plus ten regression
  tests added this round (the four fixes above and the re-shaped codex
  fixtures). Two test files fewer (`session.test.ts`,
  `cli-session.test.ts`). `bun run typecheck` exits 0.
- `make release-gate` exits 2 at `contracts` on the known machine
  limitation (unchanged since round6): the copilot probe cannot write
  `~/Library/Caches/copilot/pkg/darwin-arm64` (EPERM); in-gate the step
  read 1 pass / 1 fail, 67 expect calls. Re-run under a writable HOME:
  **2 pass / 0 fail, 117 expect calls — identical to rounds 6 through 17**.
  Everything around it ran to completion exiting 0: `runtime`, `typecheck`,
  `sh -n`, and the coverage suite inside the gate (whole-source line
  coverage 82.57%, function 89.52% — the floor is 80), then, run as the
  recipe's own steps after the gate stopped, `sandbox-contract`, the six
  smoke commands, `bun audit` (no vulnerabilities, 9 packages), the
  frozen-lockfile dry run, and the six help/verify variants.
- The one live check allowed this round,
  `./bin/codemux run -a codex --no-sandbox --auto high --result-json -p
  "Reply with: OK"`, exited 0 with a codex-built envelope: `result` the
  plain `OK`, `session_id` null (`--ephemeral`, as every run now launches),
  and real usage totals in the codemux block.

Still uncommitted; finished with `git add -A`.

## Review fixes, round 21

One major, no minors — the round's findings file listed the major twice,
verbatim, and both contracts sections came back empty. The major: an
interrupted run retained Codex's output files. On SIGINT/SIGTERM the
process runner ends a captured run with `process.exit(143)` from inside
the runner — the tree is dead, but the launch path never resumes, so
neither `processRunResult` (where codex reads and removes its
`--output-last-message` file) nor `cleanupRun` runs, and the file the
harness had already written stayed under the real `CODEX_HOME`, hermetic
runs included. Unlike the private hermetic home, that file had no exit
handler and no stale-file sweep. `src/run-exit-cleanup.ts` now registers
`cleanupRun` as a per-run exit handler the moment the launcher (or a
standalone `BaseAdapter.run`) holds a context, and the returned disposer
unregisters it once the lifecycle has disposed of the context itself —
normal completion, rejection, and timeout all release it, so a finished
run leaves nothing registered and no second cleanup fires at exit. The
backstop agrees with the hermetic home's own exit handler because both
are idempotent; the home's fires first and turns the backstop's
`finalize` into a no-op.

Tests: "a SIGTERM to a codex --result-json run removes the
--output-last-message file" (direct path) and "a SIGTERM to a sandboxed
hermetic codex run leaves neither scratch nor private home" (sandboxed
path, both artifacts) run against a fake codex that writes the named
file and then holds the run in flight, so the signal lands inside the
leak window the finding described; a base.test.ts unit test pins the
register/release lifecycle (the exit-listener count returns to its
baseline after a successful launch, a rejected launch, a standalone run,
and a caller-context run). Each registration site is load-bearing on its
own: disabling only the direct branch fails the first test, disabling
only the sandboxed branch fails the second.

### Gate (round 21)

- The coverage suite: **617 pass, 6 skip, 0 fail — 623 tests across 29
  files, 2189 expect() calls**, against the round-19 baseline of 614 pass /
  6 skip, 620 tests, 2171 expects: +3 tests and +18 expects, all three new
  tests from this round. `bun run typecheck` exits 0.
- `make release-gate` exits 2 at `contracts` on the known machine
  limitation (unchanged since round6): the copilot probe cannot write
  `~/Library/Caches/copilot/pkg/darwin-arm64` (EPERM); in-gate the step
  read 1 pass / 1 fail, 67 expect calls. Re-run under a writable HOME:
  **2 pass / 0 fail, 117 expect calls — identical to rounds 6 through 19**.
  Everything around it ran to completion exiting 0: `runtime`,
  `typecheck`, `sh -n`, and the coverage suite inside the gate
  (whole-source line coverage 82.49%, function 89.37% — the floor is 80;
  the dip from round19's 82.57/89.52 is the new module's
  cleanup-throws error branch, which a real exit path cannot reach
  without an adapter violating its contract), then, run as the recipe's
  own steps after the gate stopped, `sandbox-contract`, the six smoke
  commands, `bun audit` (no vulnerabilities, 9 packages), the
  frozen-lockfile dry run, and the six help/verify variants.
- No live model calls this round.

Still uncommitted; finished with `git add -A`.

## Review fixes, round 23

Three majors, all in the Codex event-stream parser
(`src/result-envelope.ts`), plus two contracts minors. One naming note
first: this round's task template carried the stale header "Review fixes,
round 17" (round 21's template said the same and logged as round 21); the
findings file is round23 and a round-17 section already exists above, so
this section is round 23.

The majors:

1. **Any recognized event after `turn.completed` must fail the parse.**
   The ordering rule covered only a trailing `agent_message` item, so a
   trailing reasoning or tool item completing after the last
   `turn.completed` -- or an `item.started`/`item.updated` arriving there
   -- was silently accepted and the completed turn's response returned
   successfully over a stream whose tail belonged to no turn of the run.
   The check is hoisted to every item event: `item.started`,
   `item.updated`, and `item.completed` (whatever the item's type --
   the event is grammar-recognized, and items belong inside turns) are
   all refused after the last `turn.completed` with no turn reopened.
   Regression test: four trailing shapes (reasoning item, command
   execution item, item.started, item.updated) each return null from
   `parseCodexEventStream`, and the same events inside a turn still
   parse with the turn's message intact.
2. **An all-zero usage snapshot is `Usage::default()`, not a reported
   zero total.** Codex 0.159.3 fills `turn.completed.usage` with every
   count zero when the thread never received a token-usage update, and
   the parser treated that synthetic snapshot as reported usage,
   publishing `total_tokens: 0` for a nonempty completed run. A turn
   that completed has consumed tokens -- output above all -- so four
   zeros now leave the fields null and `usageReported` false, exactly
   like a turn that reports no usage object at all. A genuine
   mixed zero (input 10, cached 0, output 5) still reports, pinned by
   the existing zero-cache test. Regression test: the all-zero snapshot
   yields `emptyUsage()` with `usageReported` false while the message
   survives.
3. **A failed envelope carries null usage, never copied from the
   stream.** A complete event stream paired with codex's own non-zero
   exit correctly failed, but the envelope still carried the stream's
   snapshot as exact usage. The codemux block now reports
   `emptyUsage()` whenever the verdict failed: the parser already
   nulled usage for stream-level failures (`turn.failed`/`error`), and
   the envelope-level rule extends that to the non-zero-exit and
   messageless-turn paths, honoring the documented contract that failed
   Codex runs report null usage. Regression test: the standard complete
   fixture with exit 1 fails with `result` null and null usage fields.

The minors:

- **CHANGELOG 0.6.0 "Fixed" bullets described states that exist in no
  released version and contradicted each other about the same prior
  release.** Every 0.6.0 "Fixed" bullet for the result envelopes, the
  codex parser, `-f -`, the `--output-last-message` lifecycle, and the
  RunContext cleanup fixed behavior of machinery introduced within the
  same unreleased 0.6.0 (verified against the `v0.5.2` tag:
  `src/result-envelope.ts`, `-f -`, and `--output-last-message` did not
  exist there), so no release ever carried the bugs -- while the
  "Added" bullets introduced the same features as new, the
  contradiction the finding named. The intra-0.6.0 bullets are folded
  into the feature bullets, which now describe the final behavior
  (grammar and ordering, usage nulls including the all-zero default
  snapshot and failed envelopes, envelope outcome rules, the `-f -`
  read bounds and validation order, the scratch lifecycle); five
  genuine pre-0.6.0 fixes stay in "Fixed" (codex `-a` approval policy,
  copilot `--reasoning-effort`, the probe's allowlisted environment --
  now carrying the locale and redirect clauses itself, the
  adapter-field hermetic home shared by overlapping runs, and the one
  `passthroughEnv` list, each verified to exist at v0.5.2); and three
  dev-regression bullets with no user-facing 0.5.2-to-0.6.0 delta were
  dropped (request-object mutation, scratch-before-validation,
  rejected-launch cleanup scoping -- 0.5.2 already behaved correctly or
  lacked the machinery; this report keeps the round-by-round record).
- **`BaseAdapter.cleanupRun`'s doc comment misstated when the method
  runs.** It claimed cleanup runs only when `processRunResult` will
  not; it actually runs after every finished launch (disposing what
  `processRunResult` left behind), after a rejected launch, and at
  process exit through the round-21 backstop. The comment now says so.

Docs that pinned the old rules moved with the code: README's
`--result-json` passage (any item event after `turn.completed` is
drift; the all-zero snapshot counts as unreported) and
docs/HARNESS-COMPATIBILITY.md's grammar addendum (same two rules, dated
2026-10-04). No code changed in the minors, so no tests there; the
majors carry one regression test each.

### Gate (round 23)

- The coverage suite: **620 pass, 6 skip, 0 fail -- 626 tests across 29
  files, 2202 expect() calls**, against the round-21 baseline of 617
  pass / 6 skip, 623 tests, 2189 expects: +3 tests and +13 expects, all
  three new tests from this round's majors. `bun run typecheck` exits
  0. Whole-source conservative coverage 82.53% line / 89.37% function
  (round 21: 82.49/89.37; the floor is 80).
- `make release-gate` exits 2 at `contracts` on the known machine
  limitation (unchanged since round6): the copilot probe cannot write
  `~/Library/Caches/copilot/pkg/darwin-arm64` (EPERM); in-gate the step
  read 1 pass / 1 fail, 67 expect calls. Re-run under a writable HOME:
  **2 pass / 0 fail, 117 expect calls -- identical to rounds 6 through
  21**. Everything around it ran to completion exiting 0: `runtime`,
  `typecheck`, `sh -n`, and the coverage suite inside the gate, then,
  run as the recipe's own steps after the gate stopped,
  `sandbox-contract`, the six smoke commands, `bun audit` (no
  vulnerabilities, 9 packages), the frozen-lockfile dry run, and the
  six help/verify variants.
- `check_american.py` over every changed prose file (CHANGELOG, README,
  both docs, and the changed sources' comments): clean, exit 0.
- No live model calls this round.

Still uncommitted; finished with `git add -A`.

## Review fixes, round 25

Three majors -- the Codex cache-write double count, the standalone
`run()` bypass, and the `--output-last-message` placement -- plus two
contracts minors. One naming note first: this round's task template
again carried the stale header "Review fixes, round 17" (rounds 21 and
23 said the same and logged as rounds 21 and 23); the findings file is
round25 and a round-17 section already exists above, so this section
is round 25.

The majors:

1. **Codex cache writes were counted twice.** The normalization added
   `cache_write_input_tokens` to an input count that already includes
   them: upstream maps both `cached_input_tokens` and
   `cache_write_input_tokens` as breakdowns of `input_tokens`
   (responses.rs at rust-v0.159.3), so `input - cached` still contained
   the writes, and the cached count added them again -- every cache
   write counted once inside the input and once inside the cache
   figure. The finding's reproduction (input 1000, cached reads 600,
   cache writes 200, output 50) published input 400 / cached 800 /
   total 1250 where the correct normalized figures are 200 / 800 /
   1050. Both breakdowns are now subtracted (`input_tokens` is
   `max(0, input - cached - cacheWrite)`, all three raw counts
   required, else null -- upstream's TokenUsage serializes every
   numeric field, so a missing one is drift, not a zero to guess) and
   both join `cached_input_tokens`; the total sums the components with
   every component required. Regression test: "cache writes are
   subtracted from the input, not added on top of it"
   (tests/result-envelope.test.ts) -- the finding's exact reproduction;
   the pinned usage expectations in tests/result-envelope.test.ts and
   tests/cli-result-json.test.ts carry the corrected 200/800/1050, and
   the clamp test (round 19) and the zero-stays-zero tests pass
   unchanged.
2. **Standalone `BaseAdapter.run()` returned raw harness output.**
   `run()` spawned the child itself and returned the captured result
   without `processRunResult()`, so a direct `resultJson: true` call
   had none of the envelope the flag promises -- no codemux block for
   claude/zai, codex's raw JSONL on stdout -- and a Plan-only codex
   result was unrecoverable, its fallback file already deleted by the
   time the caller could look. `launchRunRequest` (src/launch.ts) is
   now the only place a run is spawned and post-processed, as the
   finding prescribed: its direct branch refuses a request that claims
   an external sandbox, pins an unset autonomy on an effective copy
   (the round-19 frozen-request rule), refuses autonomy that needs a
   sandbox, and runs the full validate, beforeLaunch, prepareRun,
   exit-backstop, spawn, processRunResult, cleanupRun sequence through
   a new `runDirect` helper; `run()` is a thin delegate to it, and the
   caller-supplied-context mode is gone, so the launcher owns the
   context on every path. Regression tests: "a standalone resultJson
   run returns the envelope, not raw harness output" and the rewritten
   "run() delegates to the launch path: one context, processed, then
   cleaned" (tests/base.test.ts); the exit-backstop test now runs the
   standalone case through the same delegation, and the round-17
   probe's control launch spawns a real no-op command -- its `run()`
   override became dead code under the new flow and would otherwise
   have launched a real `claude -p`.
3. **The `--output-last-message` file lived under the real
   `CODEX_HOME`, which `--sandbox-trust untrusted` denies.** With
   API-key auth a Plan-only `--result-json` run could complete but
   find its fallback file unwritable, and the verdict converted the
   successful turn into exit 1. The file now lives in a per-run
   `mkdtemp` directory under the OS temp root -- unique per run, so
   the round-6 concurrency property stands, and `cleanupRun` removes
   the directory whole -- and a hermetic run keeps the file inside its
   private home, which finalize removes with the home; both placements
   sit where the sandbox keeps writable whatever it keeps reachable of
   harness state. Regression test: "the fallback file stays out of the
   harness state dir: temp root, or the private hermetic home"
   (tests/adapters.test.ts), pinning both halves at the adapter seam,
   and the two CLI SIGTERM tests were reworked to track the file by
   the path the fake codex records, asserting the placement
   end-to-end together with the exit-backstop removal. Two honest
   limits, read from scode 0.4.0's profiles (an empirical probe is
   impossible here: this session's own shell already sits inside a
   sandbox that cannot nest `sandbox-exec`): on macOS the untrusted
   preset denies the parent temp root too -- its profile allows writes
   only to scode's own scratch and `--allow` paths -- so the finding's
   exact untrusted-on-macOS case needs an scode-side carve-out codemux
   does not plumb yet; and on Linux the sandbox mounts a fresh private
   `/tmp` in every mode, so a sandboxed plain run's fallback may not
   surface to the parent (documented in docs/HERMETIC.md). Hermetic
   runs are robust on both platforms: the private home follows harness
   state.

One consequence of moving the file off `CODEX_HOME`: the placeholder
`buildRunCommand` names without a context no longer derives from
`CODEX_HOME`, and the round10/round13 CODEX_HOME checks (absolute,
unpadded) lived in that path construction, so they moved into
`validateRunRequest`, which every launch path runs before spawning.
Strictly broader: a plain codex run with a padded passed-through
`CODEX_HOME` now refuses at validation instead of launching unchecked
(the two refusal tests follow the check to its new home).

The minors:

- **The zero-cache-count contracts minor.** No code change: a reported
  zero stays zero on both families, pinned by the existing
  zero-stays-zero tests. The one behavioral widening beside it:
  `input_tokens` now also requires the write count, so a turn
  reporting input and cached reads but no write count reports null
  rather than guessing the write as zero -- the same never-guess rule
  the round-17 total already followed.
- **The `cleanupRun` doc comment.** Round 23 had already corrected the
  substance; this round it is refreshed to name its exact call sites
  now that `run()` delegates (after every finished launch, after a
  rejected launch, and at process exit through the backstop in
  launch.ts).

Docs that pinned the old rules moved with the code: README's example
block (200/800/1050), docs/HARNESS-COMPATIBILITY.md's normalization
sentence (`input - cached - cache_write`, both counts joined into
`cached_input_tokens`), docs/HERMETIC.md's new paragraph (the file
follows the opposite rule from the private home: OS temp root for
plain runs, private home for hermetic ones, with the Linux caveat),
and the CHANGELOG 0.6.0 feature bullet (the temp-root placement and
the corrected normalization).

### Gate (round 25)

- The coverage suite: **623 pass, 6 skip, 0 fail -- 629 tests across 29
  files, 2216 expect() calls**, against the round-23 baseline of 620
  pass / 6 skip, 626 tests, 2202 expects: +3 tests and +14 expects,
  the three new regression tests, one per major. `bun run typecheck`
  exits 0. Whole-source conservative coverage 82.56% line / 89.37%
  function (round 23: 82.53/89.37; the floor is 80).
- `make release-gate` exits 2 at `contracts` on the known machine
  limitation (unchanged since round6): the copilot probe cannot write
  `~/Library/Caches/copilot/pkg/darwin-arm64` (EPERM); in-gate the step
  read 1 pass / 1 fail, 67 expect calls. Re-run under a writable HOME:
  **2 pass / 0 fail, 117 expect calls -- identical to rounds 6 through
  23**. Everything around it ran to completion exiting 0: `runtime`,
  `typecheck`, `sh -n`, and the coverage suite inside the gate, then,
  run as the recipe's own steps after the gate stopped,
  `sandbox-contract`, the six smoke commands, `bun audit` (no
  vulnerabilities, 9 packages), the frozen-lockfile dry run, and the
  six help/verify variants.
- `check_american.py` over every changed prose file (CHANGELOG, README,
  both docs, and the changed sources' and tests' comments): clean,
  exit 0.
- No live model calls this round.

Still uncommitted; finished with `git add -A`.

## Review fixes, round 27

One major -- the `--output-last-message` fallback file, placed under the
OS temp root in round 25, never crossed scode's Linux sandbox -- plus two
contracts minors. The naming note stands as in rounds 21 through 25: the
task template again carried the stale header "Review fixes, round 17"
and a round-17 section already exists above; the findings file is
round27, so this section is round 27.

The major:

1. **[src/adapters/codex.ts] Linux sandboxed runs lost the final-message
   fallback.** scode's Linux sandbox mounts a fresh `/tmp` in every mode,
   so a sandboxed run's `--output-last-message` write landed inside the
   sandbox's private temp root and the parent's read at the named path
   found nothing: a non-hermetic `--result-json` run whose turn
   successfully ended Plan-only completed, lost its fallback, and came
   back `result: null` with exit 1. The fix adopts the placement the
   private hermetic home already proved (hermetic-home.ts): under a
   hermetic run the file stays inside the private home; otherwise it gets
   a per-run `run-<pid>-<random>/` directory under `.codemux-scratch/` in
   the real CODEX_HOME -- harness state, which scode keeps writable on
   every platform (the standard posture leaves it writable, and strict
   auto-allows it read-write) and never shadows. Under `--sandbox-trust
   untrusted`, which disables the harness-state auto-allow (deny-default:
   only scode's own scratch and `--allow` paths stay writable -- the
   round-25 record's macOS observation, with Linux read-only besides), no
   location is both writable by the child and readable by the parent, so
   that run passes no fallback file at all and the event stream is the
   result's only source; a Plan-only turn there reports `result: null`
   and exits 1, documented in README's result-envelope section. Two
   mechanism notes: `prepareRun` now receives the RESOLVED sandbox trust
   (launch.ts passes `sandboxOptions.trust` on the sandboxed path; a
   direct launch passes nothing) so preparation can shape scratch for the
   sandbox the child will actually run in, and `buildRunCommand` names
   the file only when the context carries one -- a static preview keeps a
   fail-closed placeholder under `.codemux-scratch/unprepared/`. The
   parent directory comes from `prepareRunDirParent` (hermetic-home.ts),
   the maker the hermetic home used inline until now: mkdir, the
   symlink/ownership check, and the stale sweep, now shared with
   `.codemux-scratch` so a SIGKILL'd codemux's model output does not
   accumulate forever in the operator's CODEX_HOME -- the price of moving
   off the OS-cleaned temp root, paid with the same sweep homes already
   had. Hermetic runs keep their file whatever the trust: an untrusted
   sandbox denies the private home itself, so the fallback is not what
   decides that run. Regression tests, one per branch (tests/
   adapters.test.ts): "a plain run's fallback file lives in a per-run
   scratch directory under the real CODEX_HOME" (direct and
   standard-trust `prepareRun` alike, per-run uniqueness, the parent
   reading the file back at the same path, `cleanupRun` removing the
   per-run directory while the root persists), "a hermetic run's fallback
   file lives inside the private home" (the surviving half of the round-25
   placement test), and "an untrusted sandbox run passes no fallback
   file: the stream is the only source" (no flag in argv, nothing created
   on disk, a Plan-only turn reporting `result: null` with exit 1 and the
   no-message diagnostic, cleanup a no-op). The end-to-end "under
   `--sandbox-trust untrusted` a codex plan-only turn reports null: no
   fallback file" (tests/cli-result-json.test.ts) proves the trust
   plumbing through the CLI -- its fake codex announces the flag and
   exits 5 if it ever sees one -- and the plain-run SIGTERM test was
   re-pinned to the new placement. Honest limit, unchanged from round 25:
   no Linux end-to-end execution on this macOS host; the mount behavior
   is read from scode's implementation, and the placement now rides the
   same harness-state rule the verified hermetic mechanism already
   depends on.

The minors:

- **HERMETIC.md and codex.ts sold the temp-root placement as the answer
  to the untrusted sandbox's write denial, disclosing only the Linux
  caveat.** The repo's own round-25 record said the macOS untrusted
  preset denies the parent temp root too, so the stated fix did not fix
  the stated problem there and README's "a turn that ends with only a
  `Plan` item is a success" could not hold under `untrusted`. Resolved
  structurally rather than editorially: the major's placement rule
  removed the temp-root story, the HERMETIC paragraph now states the
  same-rule placement and the untrusted no-file branch, and README
  documents the carve-out (`result: null` under `untrusted`).
- **The `parseCodexEventStream` doc claimed "codemux reports nulls on
  resume (see codexResult)".** No resume path exists -- round 19 removed
  `--session resume:<id>` and every run launches `--ephemeral` -- and
  `codexResult` contains no resume detection; the adjacent test comment
  already said so. The sentence now ends on the facts: the counter is a
  thread-lifetime total, so the reduction keeps the last snapshot rather
  than summing, and every codemux run starts its own thread, so no run's
  snapshot carries another's.

One consequence of moving the file back under `CODEX_HOME`: path
construction reads it again (the scratch root derives from
`realCodexHome`), so the round10/round13 absolute-and-unpadded refusals
matter before scratch exists. They still live in `validateRunRequest`,
which both launch paths run before `prepareRun`, so a refused value
never touches disk; the codex.ts comment and the two refusal tests'
comments say so now.

Docs that pinned the old rule moved with the code: HERMETIC.md's
paragraph (same rule as the private home, the untrusted branch), README's
Plan nuance (the `untrusted` carve-out), and the CHANGELOG 0.6.0 feature
bullet, corrected in place because the release has not shipped.

### Gate (round 27)

- The coverage suite: **626 pass, 6 skip, 0 fail -- 632 tests across 29
  files, 2230 expect() calls**, against the round-25 baseline of 623
  pass / 6 skip, 629 tests, 2216 expects: +3 tests and +14 expects, the
  three per-branch regression tests replacing the round-25 placement test
  (two in tests/adapters.test.ts) plus the end-to-end untrusted test
  (tests/cli-result-json.test.ts). `bun run typecheck` exits 0.
  Whole-source conservative coverage 82.59% line / 89.39% function
  (round 25: 82.56/89.37; the floor is 80).
- `make release-gate` exits 2 at `contracts` on the known machine
  limitation (unchanged since round6): the copilot probe cannot write
  `~/Library/Caches/copilot/pkg/darwin-arm64` (EPERM); in-gate the step
  read 1 pass / 1 fail, 67 expect calls. Re-run under a writable HOME:
  **2 pass / 0 fail, 117 expect calls -- identical to rounds 6 through
  25**. Everything around it ran to completion exiting 0: `runtime`,
  `typecheck`, `sh -n`, and the coverage suite inside the gate, then,
  run as the recipe's own steps after the gate stopped,
  `sandbox-contract`, the six smoke commands, `bun audit` (no
  vulnerabilities, 9 packages), the frozen-lockfile dry run, and the six
  help/verify variants.
- `check_american.py` over every changed prose file (CHANGELOG, README,
  docs/HERMETIC.md, this report, and the changed sources' and tests'
  comments): clean, exit 0.
- No live model calls this round.

Still uncommitted; finished with `git add -A`.

## Review fixes, round 29

No majors; one security minor and two contracts minors. The naming note
stands as in rounds 21 through 27: the task template again carried the
stale header "Review fixes, round 17" and a round-17 section already
exists above; the findings file is round29, so this section is round 29.

The security minor is the reviewer's symlink experiment, which they could
not run ("permission prompts blocked it") and which now runs as a
red-checked regression test. The guard on the `--output-last-message`
fallback covered the file's own name only: `O_NOFOLLOW` refuses a symlink
at the last path component, but a sandboxed child that replaced the
per-run directory — or the `.codemux-scratch`/`.codemux-hermetic` parent —
with a symlink pointed the parent's read and its `rmSync(path, { force:
true })` at `<victim>/last-message`, outside the sandbox: the victim's
text became the run's `result` and the file was then deleted. Node has no
dirfd-relative open, so the fix is the lstat pair the finding prescribed
first: `assertTrustedDirectory` (`src/hermetic-home.ts:169`, extracted
from `prepareRunDirParent`, which keeps applying it to the parent at
creation time) refuses anything that is not a real directory owned by the
current user, and `readFinalMessageFallback`
(`src/adapters/codex.ts:483`) applies it to the per-run directory and its
parent before the read and the delete — a swapped directory loses the
fallback with a warning ("refusing codex's --output-last-message file"),
so the run fails closed (`result: null`, exit 1) like any run whose
fallback is unreadable, and nothing is deleted through the link. The
regression test (`tests/adapters.test.ts:1050`) plants both swaps — the
finding's exact example (the run directory becomes a symlink to a victim
holding a `last-message`) and the subtler one (the parent becomes the
symlink and the attacker re-creates the run directory under it, so the
run-directory check alone would pass; lstat follows intermediate
components) — and asserts the warning, the null result, the victim's
file intact after both the read and `cleanupRun` (which removes only the
link). Red against the reconstructed pre-fix sources, both edits parked
aside: the pre-fix run **succeeded** through the planted symlink
(`Expected: false / Received: true` at the success assertion) — the
reviewer's documented-behavior claim, now demonstrated, including that
the delete would have removed the victim's file. `cleanupRun` needed no
change: `rmSync` lstats and unlinks a symlink rather than following it,
which the test pins for the run-directory case.

The contracts minors:

- **README and HERMETIC.md overstated the `untrusted` carve-out.** Both
  said codemux "passes no `--output-last-message` file at all" under
  `--sandbox-trust untrusted`; the hermetic branch sets the path before
  the trust check (the adapter's own comment: "Hermetic runs keep their
  file whatever the trust"), so the reachable command `codemux run -a
  codex --hermetic --sandbox-trust untrusted --result-json` does name a
  fallback. Both documents now state the split the code implements: a
  non-hermetic `untrusted` run passes no file (harness state denied); a
  hermetic run names its file whatever the trust, and `untrusted` denies
  the private home itself, so the child cannot write it — same
  user-visible outcome (`result: null`, exit 1), different mechanism
  (`README.md:386`, `docs/HERMETIC.md:101`). The CHANGELOG's 0.6.0
  bullet carried the same unqualified claim and is corrected in place,
  like round 27's corrections. README's stale parenthetical "(and scode's
  Linux sandbox shadows the temp root besides)" went with it — that
  placement died in round 27.
- **The ledger test exempted the rows it exists to check.**
  `installedRows` dropped any installed cell matching
  `/^Installed during/i` — a pattern whose only live purpose was skipping
  the header row, whose third column reads "Installed during audit", but
  which would equally exempt a data row worded "Installed during the
  re-audit": a claim that a machine exercised the harness, silently
  skipping the version-contract requirement. The header is skipped by its
  name cell now (`tests/harness-compatibility.test.ts:338`), and a
  phrased installed cell counts like any other. Regression test at
  `:390` parses a synthetic ledger with exactly that wording; red against
  the old filter (the row vanished from the installed set). No current
  ledger row matches the pattern, as the finding noted — the fix is at
  the guard, and the map still fails on unknown names.

CHANGELOG: the 0.6.0 Added bullet gains the refusal sentence (the
behavior change) and the non-hermetic qualifier. Docs only elsewhere; no
code change beyond the security fix and the test guard.

One process note, for the record: a stash used to park the src diff mid
red-check also reset the staged/unstaged split for `src/` (the index
briefly held HEAD there while the working tree kept the full 0.6.0 set).
No content changed — every parked diff was re-applied and the suites
re-run green — and the closing `git add -A` stages the whole tree, so the
final state is the one every previous round finished in.

### Gate (round 29)

- The coverage suite: **628 pass, 6 skip, 0 fail — 634 tests across 29
  files, 2244 expect() calls**, against the round-27 baseline of 626
  pass / 6 skip, 632 tests, 2230 expects: +2 tests and +14 expects, the
  symlink regression test and the ledger-parse test. `bun run typecheck`
  exits 0. Whole-source conservative coverage 82.62% line / 89.42%
  function (round 27: 82.59/89.39; the floor is 80).
- `make release-gate` exits 2 at `contracts` on the known machine
  limitation (unchanged since round6): the copilot probe cannot write
  `~/Library/Caches/copilot/pkg/darwin-arm64` (EPERM); in-gate the step
  read 1 pass / 1 fail, 67 expect calls. Re-run under a writable HOME:
  **2 pass / 0 fail, 117 expect calls — identical to rounds 6 through
  27**. Everything around it ran to completion exiting 0: `runtime`,
  `typecheck`, `sh -n`, and the coverage suite inside the gate, then,
  run as the recipe's own steps after the gate stopped,
  `sandbox-contract`, the six smoke commands, `bun audit` (no
  vulnerabilities, 9 packages), the frozen-lockfile dry run, and the six
  help/verify variants.
- `check_american.py` over every changed file (CHANGELOG, README,
  docs/HERMETIC.md, the two sources, the two test files): clean, exit 0.
- No live model calls this round.

Still uncommitted; finished with `git add -A`.

## Review fixes, round 31

Four majors, all from the edges auditor, plus two minors that state the
first major a second time (the parent-swap cleanup gap; the reviewer's
own reproduction was blocked by EPERM on the disposable fixture). The
naming note stands as in rounds 21 through 29: the task template again
carried the stale header "Review fixes, round 17", and a round-17
section already exists above; the findings file is round31, so this
section is round 31.

- **cleanupRun revalidates the scratch parent before the recursive
  removal.** Round 29 hardened the read — `readFinalMessageFallback`
  lstats the per-run directory and its `.codemux-scratch` parent before
  reading and deleting the file — but left the other removal
  unchecked, and pathname resolution follows an intermediate symlink
  like any other component: a sandboxed child that replaced the parent
  with a link pointed `cleanupRun`'s recursive `rmSync` at a matching
  run directory of its choosing, outside the sandbox, even on a launch
  whose result read had already refused the swap (the minors: the
  round-29 parent-swap test stopped at the read). rm does not follow a
  symlink at the run directory's own name — it removes the link, which
  the round-29 test already pinned — so the parent is the one component
  that needs the check. `assertTrustedDirectory(dirname(
  context.lastMessageDir))` (`src/adapters/codex.ts:383`) now runs
  before the removal; a parent that fails keeps its directory with the
  reader's wording ("refusing to remove codex's --output-last-message
  directory"), distinct from a cleanup that merely failed. Red-checked
  regression test at `tests/adapters.test.ts:1141` — with the check
  disabled, the planted victim directory is deleted; the existing
  parent-swap test at `:1050` covers the read side.

- **An `OPENCODE_BIN_PATH` the gate can resolve answers the gate.**
  The verdict used to come from the PATH-resolved launcher even when
  the launch would exec the redirect, so a supported launcher approved
  a below-floor redirect without the override, and an old launcher
  blocked a supported one. The redirect is resolved one level up from
  the probe environment (`resolveRedirectedBinary`,
  `src/cli-runtime.ts:406`): exactly one active redirect whose value is
  an absolute path goes through `resolveTrustedExecutable` — the same
  real-file, not-group-or-world-writable, user-or-root-owned validation
  the PATH binary gets, which is what makes probing it outside the
  sandbox acceptable, and the reason the selector stays out of the
  probe environment (`EXECUTABLE_SELECTORS` in `src/environment.ts`)
  — and the verdict is read from that binary, with no "cannot confirm"
  warning. Anything else — not absolute, missing, failing the trust
  check, a relative value whose resolution differs between the
  launcher's cwd and codemux's own, or a second redirect — keeps the
  old fallback: warn and still gate the PATH binary below the floor,
  because the operator's redirect does not make a below-minimum
  launcher acceptable. The probe environment still never carries the
  selector, and the structural pin on cli-runtime (`activeRedirects(`,
  "cannot confirm the version") still holds, now on the fallback
  branch. Red-checked tests at `tests/harness-compatibility.test.ts:223`
  (below-floor redirect refuses behind a supported PATH binary; the
  override downgrades) and `:268` (supported redirect runs behind an
  old PATH binary with no warning at all); the pre-existing
  unresolvable-redirect test keeps the fallback half.

- **A copilot that reports no version is refused, per contract.**
  `--binary-version` arrived in 1.0.3, below the 1.0.77 floor, so
  copilot 1.0.0 through 1.0.2 cannot answer the probe — and a null
  version took the gate's unconditional warn-and-continue path, letting
  below-floor releases run without the documented override. The
  behavior is pinned per contract now: `HarnessContract.unknownVersion`
  (`src/harness-compatibility.ts:70`) defaults to "warn" (wrappers,
  shims, and vendored builds legitimately report nothing) and copilot
  sets "refuse" (`:163`) — the tier table's below-min rule with the
  same override as every refusal. The branch (`:428`) refuses with a
  message stating the invariant the pin asserts (every release at or
  above the floor answers the probe), so an unreadable version is a
  below-floor release or a probe that cannot vouch for itself, refused
  either way; the copilot contract's comment and the ledger row
  (`docs/HARNESS-COMPATIBILITY.md`) say the same. Red-checked test at
  `tests/harness-compatibility.test.ts:358` (refuses, names the floor,
  the override downgrades); the wrapper-script warn test above it pins
  the default for the rest of the table, and the no-fallback-machinery
  comment now names the split instead of the old blanket sentence.

- **A rerouted codex run names the model that served it.** Codex 0.159.3
  reports a reroute in the `--json` stream as a completed `error` item
  whose message reads `model rerouted: <from> -> <to> (<reason>)` —
  verified against the tag's exec_events.rs (ModelRerouted formats the
  message with a trailing Debug-formatted parenthetical) and the
  installed binary's format string. The parser matches the
  parenthetical as a unit
  (`/^model rerouted: (.+) -> (.+) \((.*)\)$/`,
  `src/result-envelope.ts:501`) so a reason containing parentheses still
  parses, and the last reroute wins. `CodexEventStream.servedModel`
  (`:287`) carries it, the envelope's `model` becomes
  `stream.servedModel ?? request.model ?? null` (`:787`) — the rule
  README already states for the family ("the model that served the run
  when the harness names it") — and a stderr note names the served
  model, so an operator who selected the other one does not misread the
  attribution. A reroute is not a failure (the failure channels stay
  `turn.failed` and the top-level `error` event), and a message outside
  the pinned shape attributes nothing rather than half-parsing.
  Red-checked tests at `tests/result-envelope.test.ts:791` (parser:
  last reroute wins, parenthesized reason, run still completes), `:821`
  (unmatched shape stays null and is not drift), and `:877` (envelope:
  the model is the served one, the note on stderr) — with the model
  line reverted, the envelope reported the requested `gpt-5.3`.

CHANGELOG: four entries under 0.6.0's Fixed, one per behavior change
(the copilot refusal, the redirect verdict, the cleanup revalidation,
the reroute attribution). Docs: README's `model` paragraph gains the
reroute sentence; the ledger's copilot paragraph gains the null-version
refusal; the stale comments in `src/environment.ts` and the three
harness-compatibility tests now describe the resolved-redirect flow and
the per-contract null rule.

### Gate (round 31)

- The coverage suite: **635 pass, 6 skip, 0 fail — 641 tests across 29
  files, 2268 expect() calls**, against the round-29 baseline of 628
  pass / 6 skip, 634 tests, 2244 expects: +7 tests and +24 expects, the
  seven regression tests above (two redirect, one copilot, one cleanup,
  three reroute). `bun run typecheck` exits 0. Whole-source conservative
  coverage 82.76% line / 89.44% function (round 29: 82.62/89.42; the
  floor is 80).
- `make release-gate` exits 2 at `contracts` on the known machine
  limitation (unchanged since round6): the copilot probe cannot write
  `~/Library/Caches/copilot/pkg/darwin-arm64` (EPERM); in-gate the step
  read 1 pass / 1 fail, 67 expect calls. Re-run under a writable HOME:
  **2 pass / 0 fail, 117 expect calls — identical to rounds 6 through
  29**. Everything around it ran to completion exiting 0: `runtime`,
  `typecheck`, `sh -n`, and the coverage suite inside the gate, then,
  run as the recipe's own steps after the gate stopped,
  `sandbox-contract`, the six smoke commands, `bun audit` (no
  vulnerabilities, 9 packages), the frozen-lockfile dry run, and the six
  help/verify variants.
- `check_american.py` over every changed file (the five sources, the
  three test files, CHANGELOG, README, the ledger): clean, exit 0.
- No live model calls this round.

Still uncommitted; finished with `git add -A`.
