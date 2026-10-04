# Merging `hermetic-all-harnesses` into main — 0.7 merge report

Branch `hermetic-all-harnesses` (25 commits, live pass 2026-09-17) merged
into main at 0.6.1, in the worktree `codemux-hermetic-merge` on branch
`hermetic-all-0.7`, resolved 2026-10-04. This report is committed with
the merge.

## What the branch carries

Provider overrides (`CODEMUX_<AGENT>_PROVIDER_{BASE_URL,API_KEY,MODEL}`)
for aider, opencode, droid, kimi, copilot, pi, goose, qwen,
cline and openhands, and implemented — or refused, each on live evidence
— hermetic and `--tools none` mappings for every harness beyond Claude
Code, Z.AI and Codex. The branch's own account, including every live
output of its pass, is
[`docs/hermetic-all-harnesses-report.md`](hermetic-all-harnesses-report.md).

## The design conflict and its resolution

Main moved to the RunContext design after the branch diverged: adapters
are singletons, per-run state is forbidden on them, and every launch
goes through `prepareRun(request)` → `buildRunCommand(request, context)`
/ `getRunEnv(request, context)` → `processRunResult(result, request,
context)` → `cleanupRun(context)`, with `cleanupRun` wired into the
launcher's exit path. The branch had put its per-run artifacts — the
aider chat-history file, the opencode hermetic home and provider config,
the copilot hermetic home, the cline provider data directory, the droid
provider settings file, the gemini no-tools settings, the kimi
no-tools agent file, the pi provider agent directory — in adapter
fields.

The resolution follows main: every branch artifact became an optional
member of `RunContext` (new module `src/run-context.ts`, re-exported
from `src/adapters/base.ts`), created in the harness's `prepareRun` and
removed by its `cleanupRun`, through the context the launcher owns.
Static previews (`verify`, capability checks) build commands without a
context and fail closed on placeholder paths, as main's codex design
already did. Two branch behaviors the rework had to keep:

- Aider's answer extraction: `RunResult` gained `reply?` and
  `scanSurface?`, filled by `processRunResult` from the per-run
  chat-history file (aider's stdout is a transcript); the check's
  exact-`OK` test reads `reply` and the code-word scan covers
  `scanSurface` (stdout plus the full history, reasoning included).
- The provider overrides' key handling: the key rides the environment
  codemux provides (or a 0600 per-run file referencing it), never argv,
  never an operator file, and a half-configured override refuses naming
  the missing variable's name only.

Every branch test was reworked to the same ownership rule the launcher
follows — a per-describe `prepared: { adapter; context }[]` list with
`adapter.cleanupRun(context)` in `afterEach` — never a whole-adapter
sweep. The old "dispose removes them all" tests became "cleanupRun
removes each launch's own only": two contexts, the first cleaned up, the
second's files still present. `--result-json` and usage extraction are
main's and untouched.

## Conflicts, file by file

- `CHANGELOG.md` — branch entries under `## [Unreleased]`, main's
  history intact from `## [0.6.1]`. Entries the branch carried that
  main had already shipped in 0.5.2 (the `run --hermetic` / `run
  --tools` / `check --hermetic` features, `CODEX_API_KEY` forwarding,
  the README Kimi/OpenHands listing, the check module move, signal
  forwarding, the `env NAME=value` base validation, the verify
  empty-argument rule) are dropped as duplicates. The branch's deletion
  of a stale 0.5.2 heading is not repeated.
- `README.md` — the options table keeps the branch's `--hermetic` row
  (at merge time: Claude Code, Z.AI, Codex, Aider, OpenCode; Aider's
  claim was withdrawn by the h1 review — see "Review fixes, h1" —
  leaving Claude Code, Z.AI, Codex, OpenCode; every other
  harness refused until its mechanism passes the live check) and its
  `--tools` row, plus main's `--result-json` row. The branch's
  "Provider overrides" section landed intact.
- `docs/HERMETIC.md` — 16-row union table: the branch's per-harness
  rows (each with its live grounding) plus main's Antigravity row
  (2026-10-04, no login on the audit machine). Main's grouped "Cline,
  Gemini CLI, Goose, Pi, Qwen — not installed" row is superseded.
- `docs/HARNESS-COMPATIBILITY.md` — date-ordered union: the branch's
  "2026-09-17 addendum: hermetic across the remaining harnesses" sits
  after main's "2026-09-17 addendum: hermetic runs" and before main's
  2026-10-03 and 2026-10-04 addenda.
- `src/adapters/copilot.ts` — both sides had independently renamed
  `--effort` to `--reasoning-effort`; the merge keeps one copy of the
  mapping inside the branch's expanded adapter, whose private-home
  mechanism lives in `src/copilot-hermetic.ts` and whose BYOK override
  is the documented `COPILOT_PROVIDER_*` environment group.
- `tests/hermetic.test.ts` — main's RunContext ownership pattern
  applied to the branch's expanded coverage; the refusal matrix at
  merge time claimed hermetic for claude, zai, codex, aider, opencode
  and tools for claude, zai, codex, opencode, kimi, droid, pi, goose
  (aider's hermetic claim was withdrawn later in the review round;
  the matrix now names claude, zai, codex, opencode).
- `tests/installed-contract.test.ts` — union: main's contract probes
  plus the branch's pins (copilot `--reasoning-effort` included;
  `--available-tools` is deliberately absent — codemux never emits it,
  and a pin there would fail the gate on an upstream removal codemux is
  indifferent to). The expectation count is environment-dependent (the
  probes run per installed harness); this tree's measured counts are in
  the Gate section.

`src/run-context.ts` is new in this merge. No test was dropped; every
expectation reflects the union of both sides. (The h1 review found one
exception as the merge first resolved: HEAD's `describe("hermetic home
signal handling")` block had been lost with no source change to justify
it — `src/hermetic-home.ts` is byte-identical to HEAD. The block was
restored verbatim in the review round, which makes the sentence above
true of the final tree.)

## Gate

All commands run in the merge worktree on 2026-10-04, final tree
(including all seven review rounds' fixes):

- `bun run typecheck`: exit 0.
- `bun test --max-concurrency=1`: 815 tests across 36 files, 809 pass,
  6 skip, 0 fail, 2823 expect() calls. For comparison: main baseline
  before the merge, 680 tests across 29 files, 674 pass, 6 skip, 0
  fail, 2438 expect() calls; the merge as first resolved, 841/835/2847;
  the h1 round's final tree, 846/840/2862 (the h2 audit's measurement,
  verified twice — the h1 round's own gate log, 841/839/2859, was
  recorded before its last test additions landed); the h2 fixes landed
  at 848/842/2874; the h3 fixes added the login-carrier, model-braces
  and history-bound regression tests at 851/845/2889; the h4 round's
  dead-surface cut removed more than its regressions added, landing at
  807/801/2776; the h5 fixes added the FIFO-hang regression at
  808/802/2779; the h6 fixes added six regressions at 814/808/2815;
  the h7 fixes replaced the opencode default-tools control test with
  the refusal test and added the same-tools control regression, landing
  at 815/809/2823.
- `make release-gate`: exit 0, "Release gate passed." — runtime check,
  typecheck, shell, the full suite above (84.13% lines / 92.01%
  functions conservative coverage), contracts (3 tests, 3 pass,
  0 fail, 147 expect() calls; 11 harness version probes exercised,
  cline absent locally), the scode sandbox contract, smoke, `bun
  audit` (no vulnerabilities, 9 packages), a frozen-lockfile dry run
  and the CLI help probes. Ran with `COPILOT_PKG_CACHE_HOME` exported
  to a writable scratch path, the documented remedy for the pre-existing
  copilot cache EPERM (see "Deviations").

One environment note. The contracts target exercises the installed
copilot, whose loader self-extracts about 132 MB under
`~/Library/Caches/copilot/pkg` on first run. A sandboxed session cannot
create that directory — `ls ~/Library/Caches/copilot/pkg/` answers
"Operation not permitted" from this shell — so the target fails there
with `EPERM ... mkdir '/Users/kane/Library/Caches/copilot/pkg/darwin-arm64'`.
This is pre-existing, not a merge regression: `bun run test:contracts`
fails identically on the main checkout (1 pass, 1 fail, the same
copilot EPERM). The remedy is the one the branch's ledger documents:
`COPILOT_PKG_CACHE_HOME` redirected to a writable path
(`$TMPDIR/codemux-copilot-pkg-cache` here); the gate above ran green
with it exported.

## Live re-verification

Every claim the branch's live pass backed was re-checked 2026-10-04
through this worktree's `./bin/codemux` with `--no-sandbox --auto
high`, per the method in
[`docs/hermetic-all-harnesses-report.md`](hermetic-all-harnesses-report.md).
Endpoint: Z.AI's OpenAI-compatible coding endpoint
(`https://api.z.ai/api/coding/paas/v4`), model `glm-5.3`. The task
named `ZAI_KEY_FOR_TESTS`; no such variable exists on this machine (not
in any rc file), so the key came from `$HOME/.zai` — the source the
branch's own report documents. It was read into the
`CODEMUX_<AGENT>_PROVIDER_API_KEY` variables only, never printed, never
in argv, never in a committed file. Quota before and after
(`usagemux snapshot --client zai`): primary 97% remaining (resets
2026-10-04T19:08:02Z), zai-mcp 96.45% — the floor was never approached.

### `check --hermetic` — opencode (with `--tools none`) and aider

(The aider pass below was later withdrawn by the h1 review — its
canary plants `AGENTS.md`/`CLAUDE.md`, a channel the control probe
already exercises through `--read`, and never rode aider's own config
layers, which no flag closes; `check --hermetic -a aider` now refuses
with that reason. See "Review fixes, h1".)

```
$ ...CODEMUX_OPENCODE_PROVIDER_* ./bin/codemux check --hermetic --tools none --no-sandbox --auto high -a opencode
Checking opencode hermetically (planted code word CODEMUX-CANARY-8F1CDC35)...
Control probe without --hermetic...
HERMETIC opencode: OK
control: planted code word reached the model, as expected
exit: 0

$ ...CODEMUX_AIDER_PROVIDER_* ./bin/codemux check --hermetic --no-sandbox --auto high -a aider
Checking aider hermetically (planted code word CODEMUX-CANARY-FA5EBA98)...
Control probe without --hermetic...
HERMETIC aider: OK
control: planted code word reached the model, as expected
exit: 0
```

Both verified claims held at the time: the hermetic probe answered
exactly `OK` while the plain control leaked the planted code word.
OpenCode's still does — re-run again after the h2 review scoped its
`--tools none` to hermetic runs, with the control probe on default
tools (see "Review fixes, h2"; the h7 review later removed that
substitution — the control now repeats the tools selection, and the
OpenCode combination refuses instead — see "Review fixes, h7");
aider's was withdrawn (see the note above).

### `--tools none` capability probes — droid, kimi, pi, goose

Probe design (the branch's): a fresh directory holds `notes.txt` with
an unguessable `CODEMUX-SECRET-<hex>` line the prompt never contains.
Read probe: "reply with its exact contents". Shell probe: `cat
notes.txt | tr a-z A-Z`. A plain run must produce the planted value
(its transform for the shell probe); a `--tools none` run must not.
Numeric shell variant for droid (`cat notes.txt | wc -c`, true count
28): a wrong number proves no execution. Verdict lines verbatim:

```
== agent: droid
=== [read-plain]  exit=0, PRODUCED the planted secret
=== [read-none]   exit=0, did-not-produce the planted secret
=== [shell-plain] exit=0, PRODUCED the planted transform
=== [shell-none]  exit=0, did-not-produce the planted transform
== numeric shell probes (true byte count: 28)
=== [num-plain]   exit=0, PRODUCED the planted transform
=== [num-none]    exit=0, did-not-produce the planted transform

== agent: kimi
=== [read-plain]  exit=0, PRODUCED the planted secret
=== [read-none]   exit=0, did-not-produce the planted secret
=== [shell-plain] exit=0, PRODUCED the planted transform
=== [shell-none]  exit=0, did-not-produce the planted transform

== agent: pi
=== [read-plain]  exit=0, PRODUCED the planted secret
=== [read-none]   exit=0, did-not-produce the planted secret
=== [shell-plain] exit=0, PRODUCED the planted transform
=== [shell-none]  exit=0, did-not-produce the planted transform

== agent: goose
=== [read-plain]  exit=0, PRODUCED the planted secret
=== [read-none]   exit=0, did-not-produce the planted secret
=== [shell-plain] exit=0, PRODUCED the planted transform
=== [shell-none]  exit=0, did-not-produce the planted transform
```

The `--tools none` replies, decisive lines (banners and warnings
elided):

```
droid read-none:   {content}
droid shell-none:  cat notes.txt | tr a-z A-Z          (the command echoed, no output)
droid num-none:    6                                     (true count 28 — fabricated)
kimi read-none:    • The user wants me to read notes.txt and reply with its exact
                    contents and nothing else. Let me read the file.
                   (the model announced the task and never executed — same shape as
                    the branch's pass; no secret produced)
pi read-none:      I don't have access to any tools in this session, so I'm unable to
                    read files or execute commands. ...
goose read-none:   I'm unable to read files because no extensions with file access
                    tools are currently enabled. ...
```

Plain-run controls, decisive lines:

```
droid num-plain:   28                                     (the true byte count)
pi shell-plain:    CODEMUX-SECRET-EC8E8AFCCDBB
goose shell-plain: command: cat notes.txt | tr a-z A-Z
                   CODEMUX-SECRET-FD86C55E5615CODEMUX-SECRET-FD86C55E5615
                                                                    (tool echo plus reply)
```

One variance worth recording: droid's first shell-plain run executed
the command (exit 0) but declined to echo the token — "the file
contains a string explicitly labeled as a secret ... echoing secrets
back into chat is exactly how they leak" — the same behavior the
branch recorded for copilot. The numeric variant settles it: the plain
run answered the true byte count (28), the `--tools none` run a
fabricated 6. A second standard shell-plain run also produced the
transform. The claim stands on all probes.

**One claim was later demoted, by the h1 review:** aider's
`--hermetic` (implemented mechanism kept, claim withdrawn on a live
config-channel leak — see "Review fixes, h1"). Every other capability
the merge claims passed its live check again on 2026-10-04.

## Final per-harness table

| Harness | `--hermetic` | `--tools none` | Backing |
|---------|--------------|----------------|---------|
| Claude Code 2.1.270 | verified | verified | main's live pass (2026-09-17) |
| Z.AI | verified | verified | main's live pass |
| Codex 0.154.0 | verified | verified (read-only only) | main's live pass |
| Aider 0.86.2 | refused | refused (no tool set) | branch live 2026-09-17; withdrawn 2026-10-04 by the h1 review — config layers leak (docs/HERMETIC.md) |
| OpenCode 1.18.18 | verified (refused while the login carries remote configuration) | verified on hermetic runs; refused on plain runs | branch live 2026-09-17; both re-verified 2026-10-04; plain-run refusal proven live and the claim re-checked after the scoping — the h2 review; the login-side remote-config refusal proven live and the claim re-checked after it — the h3 review; the hermetic claim re-verified without `--tools` after the h7 control fix, and `check --hermetic --tools none` now refuses for OpenCode (see "Review fixes, h2", "h3" and "h7") |
| Droid 0.221.0 | refused | verified | branch live leaks/probes; probes re-run 2026-10-04 |
| Kimi Code 0.31.1 | refused | verified | branch live leaks/probes; probes re-run 2026-10-04 |
| Pi 0.85.1 | refused | verified | branch live leaks/probes; probes re-run 2026-10-04 |
| Goose 1.50.1 | refused | verified | branch live leaks/probes; probes re-run 2026-10-04 |
| Qwen Code 0.24.0 | refused (hermetic by construction) | refused | branch live 2026-09-17 |
| Cline 3.0.62 | refused | refused | branch live leaks 2026-09-17 |
| Copilot 1.0.85 | refused (the control cannot leak by construction) | refused (no empty allowlist disarms the tools) | branch live 2026-09-17 |
| Gemini CLI 0.60.0 | refused | refused (the mapping cannot load on a user-owned prefix) | branch live 2026-09-17; the unclaimable mapping removed by the h4 round |
| OpenHands CLI 1.16.0 | refused | refused | branch live leak 2026-09-17 |
| Cursor Agent 2026.08.11 | refused | refused | no mechanism; no login on this machine |
| Antigravity 1.2.14 | refused | refused | main 2026-10-04; no mechanism, no login |

The refusals keep their live grounding from the branch's pass; nothing
in this merge changes a harness mapping, so they were not re-probed —
the re-verification above covered every claim the merge made that the
branch's live pass backed (opencode hermetic+tools, aider hermetic —
since withdrawn — droid/kimi/pi/goose tools). Aider's row now rests on
the h1 review's live leak through the `.aider.conf.yml` channel.
`maxAudited` is unchanged by the branch and by this merge.

## Deviations

- `ZAI_KEY_FOR_TESTS` does not exist on this machine; the key was read
  from `$HOME/.zai`, the branch report's own documented source. Same
  key, same handling constraints.
- The gate ran with `COPILOT_PKG_CACHE_HOME` exported to a writable
  scratch path (documented remedy for the pre-existing copilot cache
  EPERM; fails identically on main without it).
- The copilot live battery from the branch pass was not re-run (both
  its capabilities are refusals; no claim rests on it).

## Review fixes, h1

A four-auditor review round (h1) ran against this merge on 2026-10-04;
every finding, blocker through minor, was fixed in this tree. The
appendix that round promised was cut off before it landed, so this
section reconstructs its account from the findings and the fixes in
the tree; its gate numbers were recorded before the h2 round's test
additions and are superseded by the Gate section above.

- Correctness, major (reported by two auditors): a provider-prefixed
  OpenCode override model (`--model codemux/glm-5.3`) keyed the
  config's models entry by the prefixed name while the run's selector
  splits on the first `/`, so the run could not resolve its own model.
  The prefix is now normalized away before the entry is written
  (`src/opencode-provider.ts`; regression in
  `tests/opencode-provider.test.ts`).
- Security, major: aider's `--hermetic` claim was withdrawn. The pinned
  flags do not close aider's own config layers — configargparse reads
  `.aider.conf.yml` from the working directory, the git root and the
  home alongside the pinned `--config`, and `.env` and
  `.aider.model.settings.yml` load the same way, inside the aider
  process where the `AIDER_*` sanitizer block cannot see them.
  Confirmed live on 2026-10-04: a plain run whose working directory
  held only a `.aider.conf.yml` naming a canary note answered with the
  note's code word, every pinned flag in place. The refusal is
  recorded in `docs/HERMETIC.md`, the README and the CHANGELOG, and in
  the tables above; the answer machinery stays for the day aider grows
  a switch.
- Security, minor: the `env` prefix trust check honored `-u NAME` after
  a `NAME=value` assignment, where env would treat the option as the
  program to run. Past an assignment the check now refuses the prefix
  (`src/executable-security.ts`).
- Security, minor: aider's answer extraction anchored on the last
  `#### ` header, so a reply of `Laurent\n#### Note\nOK` extracted as
  exactly `OK`. It now anchors after the run's own user header
  (`src/aider-history.ts`; regression in `tests/aider-history.test.ts`).
- Contracts, major: droid's effort mapping resolved `request.model`
  instead of the session's effective model, so an override model in the
  gpt-5.6 family got the generic `off` droid rejects for it. The
  mapping now resolves the session's model — the request's, else the
  override's (`src/adapters/droid.ts`).
- Contracts, minors (documentation and comment accuracy): the merge
  report no longer lists a gemini provider override (none exists); the
  three gemini protections are attributed to their real carriers (one
  settings-file pin, two launch-boundary mechanisms) in the CHANGELOG,
  README and ledger; HERMETIC.md's verification header no longer says
  the OpenCode/aider probes ran sandboxed (they ran `--no-sandbox
  --auto high`, the branch's method); the CHANGELOG's duplicate
  copilot effort bullet is gone; the lost `describe("hermetic home
  signal handling")` block was restored verbatim to
  `tests/hermetic.test.ts`, making "no test was dropped" true of the
  final tree; the stale 2026-09-17 addendum intro in the ledger was
  corrected; the kimi-no-tools, gemini-no-tools, opencode-provider and
  copilot comments describing superseded states were rewritten to the
  current facts; the copilot test comments saying "not installed" now
  record the live-verified refusals; the finalize docstrings no longer
  overclaim sibling cleanup; the table count is 16 rows and the branch
  carried 25 commits; the README's goose override group lists all five
  variables including `GOOSE_MODEL`.

Gate after the h1 fixes: `bun test --max-concurrency=1` — 841 tests,
839 pass, 2 skip, 0 fail, 2859 expect() calls; `make release-gate`
exit 0.

## Review fixes, h2

A second four-auditor round (h2) reviewed the h1-fixed tree on
2026-10-04. Every finding, blocker through minor, is fixed in this
tree.

- Correctness, major (reported by two auditors): the adapter factories
  did not forward the environment view `getAdapter` is handed, so an
  exported `CODEMUX_*_PROVIDER_*` override leaked into `verify`'s
  deliberately empty view — a configured cline threw from
  `buildRunCommand` ("cline provider data directory was not prepared
  before launch") and `verify` reported broken static wiring for a
  working setup. All twelve view-consuming factories now forward the
  view (`src/adapters/index.ts`); regression in
  `tests/adapters.test.ts` ("an explicit environment view hides
  exported provider overrides").
- Security, minor — OpenCode `--tools none` on plain runs: the
  auditor's hypothesis (per-agent permission rules append after the
  global deny, and the last matching rule wins) was confirmed against
  the installed 1.18.18 source and then proven live through codemux's
  own plain-run path: with the `OPENCODE_PERMISSION={"*":"deny"}` deny
  in place, an operator config of `"agent": {"build": {"permission":
  {"bash": "allow"}}}` put the bash tool into the model's request —
  `{"tools":["bash"],"userText":"golfSay OK."}` in the driven mock's
  log — while the same run against an empty operator config sent no
  tools (`{"tools":[],...}`), and a run without the deny sent the full
  ten-tool set (probe: a local OpenAI-compatible mock behind
  `CODEMUX_OPENCODE_PROVIDER_*`, sandboxed, `--auto medium`; log
  preserved in this worktree's ignored `scratch/leak-proof/`). No
  environment variable spells per-agent or mode permissions, a
  codemux-written config layer merges before the mode fold, and remote
  `.well-known` layers load from the login — the channel cannot be
  closed outside a hermetic run, so plain runs now refuse with
  "opencode --tools none requires --hermetic: the operator's opencode
  config can override the permission deny per agent"
  (`src/adapters/opencode.ts`, thrown from both `buildRunCommand` and
  `validateRunRequest`; regressions in
  `tests/hermetic-harness-mappings.test.ts`; surfaced through the CLI
  with `--sandbox`, since without it the autonomy gate fires first at
  read-only). The capability keeps its hermetic-run claim — the
  private home loads no operator config — and was re-proven live after
  the scoping:

  ```
  $ ...CODEMUX_OPENCODE_PROVIDER_* ./bin/codemux check --hermetic --tools none --no-sandbox --auto high -a opencode
  Checking opencode hermetically (planted code word CODEMUX-CANARY-862F967F)...
  Control probe without --hermetic (default tools; opencode refuses --tools none without it)...
  HERMETIC opencode: OK
  control: planted code word reached the model, as expected
  ```

  The check's control probe varies `--hermetic` alone, so it now runs
  with the default tools for a harness that scopes `--tools none` to
  hermetic runs (`toolsNoneRequiresHermetic` in the adapter
  capabilities, `src/check-command.ts`; regression in
  `tests/cli-run.test.ts`, "check --hermetic --tools none runs the
  opencode control with default tools"). `verify` is unaffected — it
  builds `--tools none` only inside its hermetic request. The README's
  `--tools` row, HERMETIC.md's OpenCode row and verification section,
  and the CHANGELOG's Changed entry record the scoping.
- Contracts, minor: the Gate section's test counts were stale for the
  tree they are committed with — the h1 round's test additions landed
  after the numbers were recorded (the h2 auditor measured 846 tests,
  840 pass, 2862 expects where the report said 841/835/2847). The Gate
  section now carries the final tree's measured counts, and the "79
  expectations (main: 77)" contracts figure — environment-dependent
  pin counting the auditor could not confirm — is replaced by the
  verifiable statement in "Conflicts, file by file".
- Contracts-2, minors — comments this merge added that described
  superseded states or wrong rationales, all rewritten to the real
  facts: the hermetic-home finalize backstop (`src/opencode-hermetic.ts`,
  `src/copilot-hermetic.ts` — both modules do install their own
  `process.once("exit", …)` finalizer, idempotent with the launcher's
  cleanup through the context); `aiderHistoryFile`'s "answer source"
  (`src/run-context.ts` — nothing reads it while aider's hermetic
  stays refused); the two `src/aider-history.ts` extraction comments
  (the first-header anchor; the leading-block strip); `src/gemini-no-tools.ts`'s
  "read at launch" (the packaged pins are read and copied into the
  private file at every prepared run); and `src/adapters/copilot.ts`'s
  capabilities comment (the control's inability to leak is a
  consequence of `--no-custom-instructions` riding every run, not the
  refusal's reason).
- Contracts-2, minors — docs/tests drift:
  `docs/hermetic-all-harnesses-report.md` now marks aider's
  `--hermetic` verdict "withdrawn 2026-10-04 (h1 review)" and OpenCode's
  `--tools none` verdict "plain runs refused 2026-10-04 (h2 review)"
  where it presents the branch's live pass; `tests/installed-contract.test.ts`
  no longer pins copilot's `--available-tools` (codemux never emits
  it); `tests/hermetic.test.ts` asserts the realpathed `sh` itself
  instead of a `/(sh|dash)$/` suffix; and the sweep tests in
  `tests/aider-history.test.ts`, `tests/hermetic-harness-mappings.test.ts`
  and `tests/opencode-provider.test.ts` plant a fresh sibling beside
  the stale artifact, proving the sweep removes only the stale one.

Live checks this round spent Z.AI quota as any check does; after them
(`usagemux snapshot --client zai`): primary 86% remaining (resets
2026-10-04T19:08:02Z), zai-mcp 96.45%.

## Review fixes, h3

A third four-auditor round (h3) reviewed the h2-fixed tree on
2026-10-04. Every finding, blocker through minor, is fixed in this
tree. (The findings file carried an empty `contracts-2` section — that
auditor filed nothing.)

- Correctness, major: remote configuration bypasses OpenCode's hermetic
  isolation. The auditor's mechanism was confirmed from the tagged
  source (v1.18.18, github.com/anomalyco/opencode): config load
  iterates the auth store, and for every entry of type `wellknown`
  fetches `<url>/.well-known/opencode` (`config.ts`; the document's
  `config` field is arbitrary JSON, `ConfigV1.WellKnown` in
  `packages/core/src/v1/config/config.ts`), merging it as a global
  config layer — custom prompts, plugins and agent permissions included
  — unconditionally, behind no flag; `OPENCODE_DISABLE_PROJECT_CONFIG`
  and the private hermetic home change nothing, because the login's
  data directory stays real. Per-agent permission rules append after
  the `OPENCODE_PERMISSION={"*":"deny"}` top-level deny and the last
  match wins — the exact mechanism the h2 round proved live for the
  operator's config. Two further facets surfaced while fixing it:
  `Auth.all` reads a passed-through `OPENCODE_AUTH_CONTENT` before the
  auth.json file (an alternate carrier for the same login), and the
  active organization in the data directory's `opencode.db` fetches
  `<account>/api/config` the same way — both are covered by the fix.

  The channel was then proven live, not only read. The refusal itself
  blocks driving a carrier-bearing login through the CLI (that is the
  fix), so the proof built the launch the CLI would have built — the
  adapter's own `prepareRun`/`buildRunCommand`/`buildScodeCommand`
  code, wrapped in scode exactly as at `--auto medium` — and ran it
  twice against a local mock (`scratch/h3-leak-proof/`, the h2
  mock-LLM pattern extended to serve a well-known document setting
  `agent.build.permission.bash = "allow"`). The only difference between
  the two runs was the scratch auth store's content:

  ```
  {"kind":"completion",...,"tools":[],"userText":"control\nSay OK."}          (auth store: {})
  {"kind":"wellknown-fetch","path":"/.well-known/opencode"}                   (auth store: well-known entry)
  {"kind":"completion",...,"tools":["bash"],"userText":"wellknown\nSay OK."}  (bash under the --tools none deny)
  ```

  Full log preserved in this worktree's ignored
  `scratch/h3-leak-proof/proof-log.final.jsonl`. With the well-known
  entry, OpenCode fetched the login's document inside the hermetic
  environment and the model's request carried the bash tool under the
  deny; the identical launch with an empty store fetched nothing and
  sent no tools. Both runs exited 0 and answered `OK`, so the armed
  run differs in no way a caller could detect.

  The fix is the refusal the finding's own first prescription names,
  not isolation: a private `XDG_DATA_HOME` carrying hard-linked login
  files would freeze a snapshot of the data directory that diverges on
  every in-place rewrite and silently reopens on any future store
  OpenCode adds (the db already is one), while a fresh per-launch
  inspection refuses the class — whatever in the login's data
  directory carries remote config — not the two instances known today.
  A hermetic run now inspects the login state before launch
  (`src/opencode-remote-config.ts`: a well-known entry in `auth.json`,
  an active organization in `opencode.db` — both naming their remedy —
  and an account store that exists but cannot be read, which fails
  closed) and refuses from both `validateRunRequest` (the CLI path)
  and `buildRunCommand` (`verify`'s static previews), with the reason
  in the message; the hermetic env prefix also removes
  `OPENCODE_AUTH_CONTENT` alongside the config variables
  (`src/adapters/opencode.ts`; regressions in
  `tests/hermetic-harness-mappings.test.ts`, covering both carriers
  and the unreadable store). Admin-managed settings
  (`/Library/Application Support/opencode`, `/etc/opencode`, MDM
  plists) can carry the same per-agent rules and cannot be refused;
  they were already the documented residual in HERMETIC.md ("What
  hermetic does not cover") and are now named in the OpenCode row too.
  The README's `--hermetic` row, HERMETIC.md, the CHANGELOG and the
  tables above record the scoping. Surfaced through the CLI
  (`scratch/h3-refusal-proof.sh`, verbatim):

  ```
  $ XDG_DATA_HOME=<scratch>/.local/share ./bin/codemux run -a opencode --hermetic …
  Error: opencode --hermetic is refused while the login carries remote configuration: a well-known login
  (https://login.example) in the auth store, whose .well-known/opencode config OpenCode fetches and merges
  into every run (clear it with `opencode auth logout https://login.example`); agent permissions from it
  would override the --tools none deny (docs/HERMETIC.md)
  exit: 1
  $ … ./bin/codemux check --hermetic --no-sandbox --auto high -a opencode   (same refusal, exit 1)
  $ … ./bin/codemux run -a opencode --tools none …
  Error: opencode --tools none requires --hermetic: the operator's opencode config can override the
  permission deny per agent
  exit: 1
  $ … (carrier-free login) ./bin/codemux verify -a opencode
  | opencode | yes | yes | yes | yes | 0 | PASS |
  Summary: PASS 1, WARN 0, FAIL 0
  exit: 0
  ```

  The claims were re-proven live after the fix on this machine's real
  login (which carries neither carrier):

  ```
  $ ...CODEMUX_OPENCODE_PROVIDER_* ./bin/codemux check --hermetic --tools none --no-sandbox --auto high -a opencode
  Checking opencode hermetically (planted code word CODEMUX-CANARY-98D2E00E)...
  Control probe without --hermetic (default tools; opencode refuses --tools none without it)...
  HERMETIC opencode: OK
  control: planted code word reached the model, as expected
  exit: 0
  ```

- Security, minor: `src/adapters/opencode.ts` claimed the
  `OPENCODE_PERMISSION={"*":"deny"}` rule was "the whole story" under a
  private hermetic home, while hermetic keeps the real `XDG_DATA_HOME`
  (the login must work) and HERMETIC.md itself said remote
  `.well-known` layers load from that auth store. The comment block now
  states the real condition — the deny is the whole story only where no
  later fold can append per-agent permission rules after it — and names
  the three places that can: the operator's config (plain runs,
  refused), the login's remote configuration (refused via the carrier
  inspection this round adds), and admin-managed settings (the
  documented residual). The `OPENCODE_AUTH_CONTENT` mouth is closed in
  the same fix.
- Security, minor: `src/opencode-provider.ts` wrote `--model` text
  unescaped into an OpenCode config file, and `validateModelName`
  allows `{`/`}` — which OpenCode substitutes (`{env:…}` and
  `{file:…}`, `ConfigVariable.substitute` in
  `packages/opencode/src/config/variable.ts`) in config text before
  parsing, so a crafted model id could splice an environment variable
  or a file's content into the config codemux writes.
  `opencodeBareModel` now refuses braces with that reason, surfaced
  from `validateRunRequest` and `prepareRun` alike (regression in
  `tests/opencode-provider.test.ts`).
- Security, minor: `src/adapters/aider.ts` read the post-run history
  file — which the sandboxed harness can write — with an unbounded
  `readFileSync` that follows symlinks, on every plain aider run. The
  read now opens with `O_NOFOLLOW`, verifies a regular file via
  `fstatSync` on the descriptor, and stops at a 32 MiB bound (the
  largest legal prompt plus the reply and reasoning around it); any
  refusal fails closed on stdout alone (`src/aider-history.ts`;
  regression in `tests/aider-history.test.ts`).
- Contracts, minor: `tests/hermetic.test.ts` called droid and kimi
  "implemented-but-unclaimed" for `--tools none`; both are claimed and
  were verified live. The comment now says what the suite actually
  pins: the four `--tools none` claimants live in their per-harness
  suites, each verified live through a provider override.
- Contracts, minor: `tests/adapters.test.ts` attributed gemini's
  refusals to a probe "pending an install"; gemini 0.60.0 is installed
  and was exercised live. The capabilities comment now carries the live
  evidence: nothing closes the workspace context channels, and the
  `tools.core` allowlist rides a system-settings layer that never loads
  from a user-owned prefix.
- Contracts, minor: HERMETIC.md's introduction said "`--tools none`
  works without `--hermetic` too" — no longer true for OpenCode since
  the h2 scoping, while the same document said so twice below. The
  introduction now carries the exception with its reason and a pointer
  to the table.

Gate after the h3 fixes: `bun run typecheck` exit 0;
`bun test --max-concurrency=1` — 851 tests, 845 pass, 6 skip, 0 fail,
2889 expect() calls; `make release-gate` exit 0 (contracts 2 tests,
2 pass, 133 expect() calls, conservative coverage 84.79% lines /
93.13% functions, `bun audit` clean). Quota after the round's Z.AI
checks (`usagemux snapshot --client zai`): primary 82% remaining
(resets 2026-10-04T19:08:02Z), zai-mcp 96.45%; the mock leak proof ran
against a local endpoint and spent no Z.AI quota.

## Review fixes, h4

A fourth review round (h4) ran against this merge on 2026-10-04; every
finding that still applied was fixed in this tree. No live model calls
were needed — the round's evidence came from the installed binaries,
the runtime floor, and fixture tests.

- Blocker, runtime floor: `src/opencode-remote-config.ts` (the h3
  round's login-carrier inspection) imported `node:sqlite`, which the
  pinned runtime floor does not have — `make runtime` pins Bun 1.3.14,
  and `node:sqlite` first ships in Bun 1.4. The adapter registry loads
  the module eagerly, so on the floor every CLI command broke through
  one import: `./bin/codemux --help` printed
  `error: No such built-in module: node:sqlite` and still exited 0,
  reporting success. (Not reproducible on the dev machine's local Bun
  1.4.2, which has the module — the floor is the CI pin.) The store is
  now read through `bun:sqlite` (`new Database(path, { readonly: true })`,
  one `SELECT` through `db.query(...).get()`, `db.close()` in a
  `finally`), a Bun-core API present on 1.3.14, so no new dependency
  and no floor change. Same fail-closed semantics: an unreadable
  `opencode.db` still refuses `--hermetic` naming the file. The refusal
  design itself is unchanged and now corroborated by the 1.18 docs
  (opencode.ai/docs/config): remote config is precedence item 1 —
  "fetched automatically when you authenticate with a provider that
  supports it" — and the documented config and env surface
  (`OPENCODE_CONFIG`, `OPENCODE_CONFIG_DIR`, `OPENCODE_CONFIG_CONTENT`,
  `disabled_providers` and the rest) gates neither the
  `.well-known/opencode` fetch nor the organization's `/api/config`,
  matching what the h3 round read out of the 1.18.18 binary. The
  fixture test builds its `opencode.db` through `bun:sqlite`, and the
  import carries the floor comment.
- The h4 review's cut, executed: every harness whose `--hermetic` and
  `--tools none` are both refused keeps only its refusal and reason.
  Copilot, Gemini CLI, Cline, OpenHands and Qwen (Cursor never had
  machinery) lost their provider-override and no-tools modules
  (`src/copilot-hermetic.ts`, `src/cline-provider.ts`,
  `src/gemini-no-tools.ts` trashed; `tests/gemini-no-tools.test.ts`
  with them), their flags, env prefixes, per-run artifacts in
  `RunContext`, and their tests and README enumeration. OpenHands
  model selection reverted to the 0.6.1 shape (`--override-with-envs`
  with `LLM_MODEL` only). The refusals and their live grounding stay in
  docs/HERMETIC.md; the adapters still refuse with the same errors; the
  installed-contract entries had nothing to remove (0.6.1 already
  carried none of the machinery). Plain-run commands for the five are
  unchanged.
- Major: Pi's provider override now declares `reasoning: true` on the
  generated model entry. Pi 0.85.1 defaults a custom model's reasoning
  to false, which clamps the `--thinking` flag `--effort` maps to off —
  observed at the composer as
  `{"reasoning":false,"requested":"high","effective":"off"}` — so the
  bare entry silently disabled reasoning on every `--effort` run.
  Regression: the models.json assertion in
  `tests/provider-override-mappings.test.ts` pins the field.
- Security, minor: a provider-override base URL containing `{` or `}`
  is refused. OpenCode substitutes `{env:…}`/`{file:…}` in config text
  (the reason `opencodeBareModel` already refuses braces in models) and
  droid and pi expand `${VAR}` templates at read time, so a base URL
  carrying a brace could splice an environment variable's value or a
  file's content into a config file codemux writes. One rule in
  `src/provider-override.ts` covers both shapes; regression: two brace
  cases in `tests/provider-override.test.ts`.
- Security, minor: one bad stale entry no longer blocks every later
  run. The artifact sweeps in `src/aider-history.ts`,
  `src/kimi-no-tools.ts`, `src/opencode-provider.ts`,
  `src/droid-provider.ts` and `src/pi-provider.ts` called `rmSync`
  unprotected, so a single unremovable entry — a directory named like
  the file pattern, `EISDIR` on a non-recursive rm — threw out of the
  sweep and failed every subsequent launch of that harness. Each
  removal is now guarded and warns on stderr, claude.ts's
  warn-don't-fail style. Regressions cover the two deterministically
  reproducible sites (aider's and kimi's non-recursive rm: the bad
  directory stays, the good stale file is still swept, nothing
  throws). The three recursive sweeps (opencode, droid, pi) are
  hardened uniformly without a dedicated test: a chmod-based
  "unremovable entry" fixture would not hold under a root-running CI
  or a privileged sandbox, making an "entry remains" assertion flaky,
  and the guard is the same one the two tested sites exercise.
- Closed by the removal itself: the h4 gemini finding (an unremovable
  stale entry in the `--tools none` settings sweep blocking later
  runs — the same pattern as kimi's) and the contracts finding that
  the README's provider-override section still enumerated copilot's
  BYOK group as a shipped surface. `src/gemini-no-tools.ts` no longer
  exists and the enumeration now lists only the six harnesses whose
  overrides ship.
- Docs: HERMETIC.md's rows for the five cut harnesses keep refusal and
  reason with the machinery marked removed ("a provider override this
  tree no longer ships"); README's `--hermetic` row and
  provider-override section match the shipped surface; CHANGELOG
  carries the cut under Removed and the round's fixes under Fixed; the
  ledger has a dated addendum.

Gate after the h4 fixes: `bun run typecheck` exit 0;
`bun test --max-concurrency=1` — 807 tests across 36 files, 801 pass,
6 skip, 0 fail, 2776 expect() calls (the h3 tree was 851/845/2889:
the cut removed more tests than the round's regressions added);
`make release-gate` exit 0, "Release gate passed." — contracts 2
tests, 2 pass, 0 fail, 133 expect() calls, conservative coverage
84.19% lines / 91.98% functions, `bun audit` clean (9 packages), the
frozen-lockfile dry run and the CLI help probes included, run with
`COPILOT_PKG_CACHE_HOME` exported to a writable scratch path as before.

## Review fixes, h5

A fifth four-auditor round (h5) reviewed the h4-fixed tree on
2026-10-04. The findings file carries one unique correctness finding
(recorded twice — a recording artifact), a security PASS with one
minor note attached, and contracts sections that pass; the fourth
auditor (contracts-2) timed out and filed nothing. Every finding is
fixed or accounted for in this tree. No live model calls were needed:
the round's evidence was an isolated local reproduction, and no
capability claim changed, so nothing needed re-proving through the
live check.

- Correctness, major: a harness could hang codemux after its own exit.
  Aider's post-run history read opened the file blocking, and the read
  runs in `processRunResult` — after the subprocess timeout is
  cleared, so `--timeout` cannot reach it. A harness that replaced its
  writable history file (`~/.aider/.codemux/` is harness state) with a
  FIFO and exited parked `openSync(O_RDONLY)` before `fstatSync` could
  reject the file; the auditor's isolated reproduction blocked until
  SIGKILL. The open now carries `O_NONBLOCK` (`src/aider-history.ts`)
  — the pattern the bounded reads in `src/file-io.ts` already use;
  main learned this before the branch diverged, and the branch module
  missed it. Regular files ignore the flag, the descriptor's type
  check rejects the FIFO, and the read fails closed on stdout as every
  other refusal does. Regression in `tests/aider-history.test.ts`: the
  prepared run's history file is replaced by a real FIFO and the read
  runs in a child process under a spawn timeout, so a regression fails
  the test in seconds instead of hanging the suite — verified both
  ways before landing (the test fails on the un-fixed code with the
  child killed; the fixed tree passes).
- Security — PASS, with one minor note (no demonstrated trigger): the
  per-run files that enforce a guarantee sit in harness-state
  directories a concurrent sandboxed run can write — kimi's
  `tools: []` agent file, OpenCode's provider config holding the
  override's base URL (Droid's settings file and Pi's `models.json`
  are the same shape) — so a malicious concurrent run could edit
  another run's file between write and read, disarming its
  `--tools none` or redirecting its override key to another host. The
  auditor's own verdict frames it: sandboxed harnesses can already
  rewrite every other file in those directories (OpenCode's
  `auth.json` included), so this is not a new class of exposure. The
  resolution follows the h3 precedent for an unclosable residual (the
  admin-managed settings): documented, not withdrawn. No capability is
  withdrawn because no capability claims to close it — and none could:
  any path a harness can read, a same-user process can write
  (the user-installed harness binaries themselves included, which
  carry every guarantee argv makes), so the named writer defeats
  argv-based mechanisms — Droid's and Pi's `--tools none` among them —
  exactly as file-based ones. Every withdrawal this merge has made
  (aider h1, OpenCode plain-run tools h2, the OpenCode login carriers
  h3) stood on a live demonstration of the named channel defeating the
  specific mechanism; this note carries none. The class is now in
  HERMETIC.md ("What hermetic does not cover"), naming the files, the
  edit-between-write-and-read attack, and why no mapping closes it.

Gate after the h5 fixes: `bun run typecheck` exit 0;
`bun test --max-concurrency=1` — 808 tests across 36 files, 802 pass,
6 skip, 0 fail, 2779 expect() calls (one regression test added, three
expects with it); `make release-gate` exit 0, "Release gate passed." —
contracts 2 tests, 2 pass, 0 fail, 133 expect() calls, conservative
coverage 84.19% lines / 91.98% functions, `bun audit` clean (9
packages), unchanged from the h4 tree everywhere except the one added
test, run with `COPILOT_PKG_CACHE_HOME` exported to a writable
scratch path as before.

## Review fixes, h6

A sixth review round (h6) ran against this merge on 2026-10-04; every
finding — the duplicated major through the minors — was fixed in this
tree. No capability claim changed, so no live model call was needed to
re-prove anything: the fixes harden reads, refusals and tests behind
claims that already stand on their recorded live evidence.

- Correctness, major (filed twice, identical): the OpenCode login-state
  inspection read `auth.json` with a bare synchronous `readFileSync`,
  which blocks forever on a FIFO with no writer — and the read runs
  during validation, before the subprocess timeout starts, so a harness
  that replaced its store with a FIFO hung codemux until SIGKILL (the
  auditor reproduced it; the h5 round fixed the identical shape in
  aider's post-run read but left this one). `src/opencode-remote-config.ts`
  now reads the store through `readUtf8FileBounded`
  (`src/file-io.ts`) with a 1 MiB bound and `noFollow`, the repository's
  bounded, nonblocking, regular-file-only reader. The semantics turn
  fail-closed by the same move: only an absent store (ENOENT) reads as
  "no login" — a symlinked, oversized, unparsable or FIFO store refuses
  `--hermetic` naming the file, because OpenCode itself follows
  symlinks codemux refuses, so treating an unreadable store as empty
  would skip a real carrier. `opencode.db` is lstat'd to a regular file
  before `bun:sqlite` opens it (its own open blocks on a FIFO and
  follows symlinks), with the same named refusal. Regression:
  `tests/hermetic-harness-mappings.test.ts` covers the symlinked,
  oversized, unparsable and both FIFO stores, the FIFO cases driven in
  a child process so a regression fails the test instead of hanging the
  suite. The task's grep also ran: this was the only remaining raw
  `readFileSync` on a harness-home or workspace path among the new
  modules (`src/aider-history.ts` reads through an already-validated
  descriptor; the rest were converted in h3/h5).
- Security, minor: the h4 brace refusal covered the override's base URL
  only, but the model lands in the same template-expanded files — the
  `model` and `id` fields of droid's settings entry, the `id` and
  `name` of pi's `models.json` entry — so a crafted model name
  (`validateModelName` allows braces) could splice an environment
  variable's value into the config codemux writes. `droidProviderModelId`
  (`src/droid-provider.ts`) and the new `piProviderBareModel`
  (`src/pi-provider.ts`) now refuse `{` and `}` with the reason; both
  adapters' `validateRunRequest` call the check before launch (the
  pattern `src/adapters/opencode.ts` already had), and the droid write
  hoists the check ahead of its `mkdirSync`, so a refused model leaves
  no directory behind for the sweep to find. OpenCode needed nothing:
  `opencodeBareModel` has refused braces since h3. Regressions: the
  droid and pi brace tests in `tests/provider-override-mappings.test.ts`.
- Security, minor: every aider run wrote its full conversation to
  `~/.aider/.codemux/history-*.md`, where plain runs used to write
  `/dev/null`. The history file exists for the hermetic check's answer
  extraction, and the check is refused — so nothing reads a plain run's
  history and the file persisted the whole conversation for nothing.
  `prepareRun` (`src/adapters/aider.ts`) creates the file only when
  `request.hermetic` is set; plain runs keep
  `--chat-history-file /dev/null` and create no directory. Regression:
  "plain runs keep /dev/null and write no history at all"
  (`tests/aider-history.test.ts`); the four tests that exercised the
  prepared machinery now say `hermetic: true`, which is the only shape
  that reaches it. docs/HERMETIC.md's aider row and the CHANGELOG state
  the new rule.
- Security, minor: for `opencode --hermetic --tools none`, the check's
  control probe runs with the default tools in the planted directory
  (check-command.ts) — the armed control the h2 scoping inherited. No
  capability change and no test: nothing new to enforce, because the
  control's job is to leak through the operator's own channels (that
  leak is what makes the hermetic probe's clean `OK` meaningful), and
  every closure available would either refuse the plain run the control
  needs (codemux's own adapter already refuses plain `--tools none` for
  OpenCode), break the check's own method (`--no-sandbox --auto high`
  is the documented launch for provider-override checks, which need the
  network), or disarm the channel the control exists to exercise.
  Resolved as the h5 round resolved its unclosable residual: documented,
  not withdrawn. The verification section of docs/HERMETIC.md now states
  that the substituted control runs armed — full tools at the probe's
  autonomy, unsandboxed under `--no-sandbox` — that no mapping closes
  it, and that only the hermetic probe carries the `--tools none`
  claim. The provider-override state the probes would touch still lives
  only in the RunContext, per the merge's rule.
- Contracts, minor: the h4 sweep hardening covered five stale-artifact
  sweeps and missed the sixth — OpenCode's hermetic homes
  (`src/opencode-hermetic.ts`), where one unremovable stale home threw
  out of the sweep and failed every later hermetic launch, the exact
  regression class the h4 round claimed closed. The `rmSync` is now
  guarded like the other five: warn on stderr, move on. Regression:
  "a stale home the sweep cannot remove neither throws nor blocks later
  sweeps" (`tests/hermetic-harness-mappings.test.ts`), skipped under
  root and on Windows where the chmod fixture does not hold (the h4
  round's own rationale, handled by `skipIf` so the test still runs
  everywhere the fixture works).
- Contracts, minor: aider's installed-contract pins included
  `--map-tokens` and `--read`, which no reachable run sends — the first
  rides only the `--hermetic` branch (refused since h1), the second
  rides `instructionDirs`, which only the check's refused hermetic
  probe sets. That violates the pinning rule the copilot
  `--available-tools` comment states in the same file: a pin belongs
  only on flags codemux sends, or the gate fails on upstream removals
  codemux is indifferent to. Both pins are removed with a comment
  citing the rule, and a new always-on test — "every aider pin appears
  in a command a reachable run builds" — builds every reachable aider
  command shape (plain headless runs at both autonomy extremes, with
  model and effort on, plus the TUI command) and fails on any pin none
  of them sends, matching tokens exactly or as a `pin=` prefix so
  `--model` never matches `--model-settings-file`. The contracts table
  moved to module scope so the test and the installed probes read one
  table (which took `cursorBinary` up with it, still resolved only when
  the installed suite runs).
- Contracts, minor (the fragmentary verbatim quotes): the stale text
  was real but not shipped behavior — four sections of
  `docs/hermetic-all-harnesses-report.md` (OpenHands, Qwen Code, Cline,
  Copilot) still presented the provider overrides the h4 round removed
  as current surface, with no removal marker, while the aider and
  OpenCode sections carry h1/h2/h3 markers. The README and CHANGELOG
  were already correct ("an override that no longer ships"). Dated
  "Removed 2026-10-04 (h4 review)" blockquote markers now head those
  four sections in the h1 marker style, each noting the section stands
  as the record of the 2026-09-17 pass; Gemini's section and its
  summary-row cell carry the same marker for its removed
  `--tools none` mapping, which the section still described as
  implemented.

Gate after the h6 fixes: `bun run typecheck` exit 0;
`bun test --max-concurrency=1` — 814 tests across 36 files, 808 pass,
6 skip, 0 fail, 2815 expect() calls (the h5 gate: 808 tests, 802 pass,
6 skip, 0 fail, 2779 expects — six regression tests added, all six
passing, no other test moved); `make release-gate` exit 0, "Release
gate passed." — contracts 3 tests, 3 pass, 0 fail, 147 expect() calls
(the h5 gate: 2 tests, 2 pass, 133 expects; the third test is the
always-on pin-sync check, so it now counts in every gate), 14 installed
binaries exercised (cline absent locally, cursor model aliases skipped
for no login — both unchanged), conservative coverage 84.27% lines /
92.01% functions (h5: 84.19% / 91.98%), `bun audit` clean (9
packages), run with `COPILOT_PKG_CACHE_HOME` exported to a writable
scratch path as before. `check_american.py` over every changed file:
clean. No live checks were run this round — no capability was granted,
withdrawn or rescoped, so nothing needs re-proving; the first live
check after this tree should re-run the OpenCode pair, whose claims the
FIFO hardening now guard from a hang rather than change.

## Review fixes, h7

A seventh review round (h7) ran against this merge on 2026-10-04. The
findings file carries one security minor and three contracts minors (the
`contracts-2` section was empty — that auditor filed nothing); every
finding is fixed in this tree.

- Security, minor: `check --hermetic --tools none` ran its control probe
  with every tool enabled. The control probe now repeats the hermetic
  probe's `tools` selection unchanged (`src/check-command.ts`), so
  `--hermetic` is the only difference between the two requests: a
  control that leaks with the same tools proves the planted files
  reached the model through a channel that needed no tool, which is what
  makes the hermetic probe's clean `OK` attribute to isolation rather
  than tool removal. The h2-era substitution — default tools on the
  control for a harness that scopes `--tools none` to hermetic runs —
  varied two things at once, and the h6 round had documented its armed
  control as an unclosable residual; that residual is closed by the same
  change (under `--tools none` the control now runs with no tools at
  all). The one harness so scoped, OpenCode, cannot meet the bar — its
  plain control would be a `--tools none` run the adapter itself refuses
  (the h2 finding's live-proven override channel) — so
  `check --hermetic --tools none` now refuses for it before any request
  is spent, naming the remedy. No capability moved: OpenCode's
  `--hermetic` is unchanged and was re-verified live on this tree, and
  its `--tools none` (hermetic runs) keeps the read and shell probes of
  the live pass, which this change does not touch; the README,
  HERMETIC.md (verification section and OpenCode row), the CHANGELOG
  and the tables above record the rule. Regressions in
  `tests/cli-run.test.ts`: the control's own command is asserted (a
  stand-in claude logs its arguments; the control invocation must carry
  `--tools ""` when `--tools none` was given), and the h2-era "opencode
  control with default tools" test became the up-front refusal test,
  asserting no probe runs.
- Contracts, minor: `src/run-context.ts`'s `aiderHistoryFile` comment
  still said "Every run gets one" — the pre-h6 rule, under which plain
  runs would persist their whole conversation, exactly what h6 removed.
  The comment now states the real rule: only a hermetic run creates the
  file, plain runs keep `/dev/null`.
- Contracts, minor: this report's Gate section described the "final tree
  (including all five review rounds' fixes)" with the h5 tree's counts
  while shipping the h6 fixes whose own section recorded 814/808/2815 —
  the identical staleness the h2 round had fixed in this section once
  before. The Gate section now carries the final tree's measured counts
  (the chain runs through h7) and the right round count.
- Contracts, minor: `src/opencode-remote-config.ts` attributed the
  bounded store read to "the reader the aider history uses" — aider's
  history read is its own descriptor-based implementation that borrows
  `readUtf8FileBounded`'s pattern, not the function. The comment now
  names the function, its module, and the relationship correctly.

Live checks this round (through this worktree's `./bin/codemux
--no-sandbox --auto high`; the Z.AI key from `$HOME/.zai` was read into
the provider-override environment only, never printed, never in argv):

```
$ ...CODEMUX_OPENCODE_PROVIDER_* ./bin/codemux check --hermetic --tools none --no-sandbox --auto high -a opencode
Error: check --hermetic --tools none cannot run for opencode: the control probe would be a plain
--tools none run, which opencode refuses. Run the check without --tools for the isolation claim; the
--tools none claim keeps its own capability probes (docs/HERMETIC.md)
exit: 1

$ ...CODEMUX_OPENCODE_PROVIDER_* ./bin/codemux check --hermetic --no-sandbox --auto high -a opencode
Checking opencode hermetically (planted code word CODEMUX-CANARY-DEB06DB8)...
Control probe without --hermetic...
HERMETIC opencode: OK
control: planted code word reached the model, as expected
exit: 0

$ ./bin/codemux check --hermetic --tools none --no-sandbox --auto high -a zai
Checking zai hermetically (planted code word CODEMUX-CANARY-C47D569C)...
Control probe without --hermetic...
HERMETIC zai: OK
control: planted code word reached the model, as expected
exit: 0
```

The first proves the new refusal surfaces through the CLI, and it spends
no quota — it fires before any request is made. The second re-proves
OpenCode's hermetic claim on the h7 tree (the h6 round asked for exactly
that re-run; the control here keeps the unchanged default-tools shape,
since no `--tools` was given). The third is the fix's own live proof:
both zai probes carried `--tools ""` — the claude-family spelling of
tools-none — and the control still leaked the planted code word, through
context-injection files no tool is needed to read, so the hermetic
probe's clean `OK` stands attributed to isolation. Z.AI's native key
(`~/.zai`, the zai adapter's own documented source) drove that check; no
override was needed.

Gate after the h7 fixes: `bun run typecheck` exit 0;
`bun test --max-concurrency=1` — 815 tests across 36 files, 809 pass,
6 skip, 0 fail, 2823 expect() calls (the h6 gate: 814 tests, 808 pass,
2815 expects — one test replaced by the refusal test, the same-tools
control regression added); `make release-gate` exit 0, "Release gate
passed." — contracts 3 tests, 3 pass, 0 fail, 147 expect() calls
(unchanged from h6; 11 harness version probes exercised, cline absent
locally), conservative coverage 84.13% lines / 92.01% functions
(h6: 84.27% / 92.01%; the dip is the new refusal branch in
`src/check-command.ts`, which the conservative count treats as an
omitted module), `bun audit` clean (9 packages), run with
`COPILOT_PKG_CACHE_HOME` exported to a writable scratch path as before.
Quota after the round's Z.AI checks (`usagemux snapshot --client zai`):
primary 95% remaining (resets 2026-10-05T00:08:11Z), zai-mcp 96.42% —
the floor was never approached. `check_american.py` over every changed
file: clean.
