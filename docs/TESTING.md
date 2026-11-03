---
read_when: "Choosing focused tests or interpreting release-gate evidence."
---
# Testing

Install dependencies with `bun install --frozen-lockfile`.
The [release gate](RELEASE-GATE.md#automated-gate) is the single full
verification entry point. Its checklist defines required checks and evidence.

## Focused development checks

```sh
make typecheck
make shell
bun run test tests/result-envelope.test.ts tests/cli-result-json.test.ts
bun run test tests/session-exit-contract.test.ts tests/session-cli-happy-path.test.ts
bun run test tests/experiment-mcp.test.ts tests/experiment-bridge.test.ts tests/agy-isolation.test.ts
bun run test tests/live-gate.test.ts tests/installed-layout.test.ts
```

These selected suites help diagnose a change. They do not replace the
unfiltered suite in the full gate. There is no separate lint target;
type checking and shell syntax checks are included.

`tests/file-size.test.ts` fails when any `.ts` file under `src/`,
`scripts/`, or `tests/` exceeds 500 physical lines (a final line without a
trailing newline still counts), keeping the repository's one-responsibility-per-
file rule enforced rather than advisory.

All package test scripts preload `tests/setup.ts`. Its
`CODEMUX_TEST_LEDGER` redirect prevents test receipts from entering the
operator ledger. Do not rely on `NODE_ENV=test` for that isolation. The
same preload disables the quota gate for in-process launch tests: it
generates a random nonce, sets `CODEMUX_TEST_NO_QUOTA_GATE` to it, and
mirrors it on `globalThis.__codemuxTestNoQuotaGate`; the gate honors the
variable only when the two match, so the variable alone — exported by an
operator or leaked into a child — disables nothing.
`bunfig.toml` sets `[test] root = "tests"`, so a bare `bun test` never
discovers test files outside `tests/` (a probe once left under
`scratch/` was counted by a plain `bun test` run before this). Discovery
still covers everything inside `tests/`, `tests/scratch` included, and bun
offers no ignore list for it; `tests/file-size.test.ts` therefore asserts
that no `*.test.ts` file hides under `tests/scratch`.

## Test seams and fixtures

`bin/codemux` carries no test hook. The launcher suites use a
copy-and-rewrite seam instead: `runPinnedLauncher` (tests/launcher.test.ts)
and its tool-resolution extension (tests/launcher-tools.test.ts) copy the
launcher to a scratch directory and rewrite the copy's `tool_dirs=`
assignment to point at fake `stat`, `id`, and `readlink` scripts, so the
resolution branches run as real shell against controlled tools.

Fixtures that outlive a test write a two-line identity file,
`pid\nstart`, where `start` is the process's launch token from the process
table. `tests/helpers/fixture-leak.ts` reads and writes that format, and
the `tests/setup.ts` exit sweep kills a leaked fixture only when its
recorded identity is still alive. The token is the reuse check: a pid the
OS reassigned to a different process is never signaled. On a host whose
process table cannot be read the token is empty and the sweep falls back
to pid-only signaling.

## Coverage

`bun run test:coverage` runs the unfiltered suite and enforces at least
80% whole-source line and function coverage, and — as a per-file floor —
at least 80% line and 80% function coverage in every file under `src/`
and `scripts/`. Bun reports loaded modules and does not merge
spawned-child coverage into the parent report, so a file only a spawned
process exercises counts as uncovered; the in-process command tests
(`tests/cli-run-command.test.ts`, `tests/cli-tui-command.test.ts`, and
the session command suites `tests/session-cli-command*.test.ts` with
`tests/session-cli-phases.test.ts`) exist for that reason — the session
command's phases are pure functions the commander action calls, so
running `registerSessionCommand` in process measures them directly and
keeps `src/session/cli*.ts` inside the per-file floor. Only the spawned
suites can pin the real process boundary (exit codes as the OS sees
them, signal handling), which is why both shapes are kept.
`scripts/check-source-coverage.ts` counts omitted
source files as entirely uncovered (missing files are counted as their
physical line count and their parsed function count) before enforcing
the thresholds, and an empty or malformed lcov parse fails the check
rather than reading as zero. It also refuses a stale report: the Makefile
`test` target touches `coverage/.run-stamp` before each covered run, and
the checker fails when `coverage/lcov.info` is older than the stamp (or
missing under it) — a report that survived from an earlier run cannot
green the gate. A tree without a stamp is not refused; the guard arms once
the stamp exists. A matched record that reports zero lines or
functions for a source file that has them is an incomplete or malformed
report: it breaches the floor and its physical counts stand in as
uncovered. Files the floor cannot meaningfully measure
are waived inline in that script, each with its reason: type-only
modules with no runtime code, child-process entry files that do
nothing but register commands and parse argv (their logic lives in the
registered modules and is tested in process — `scripts/live-gate/run.ts`
and `scripts/check-installed-layout.ts` are inside the floor, not
waived, because their suites import them in process), and platform- or
dispatch-gated files whose unhit code cannot execute in this
environment (the win32 no-process-groups arm of `src/process-signal.ts`;
the signal dispatch of `src/private-dir-signals.ts`, which would end the
test process — the module holds the dispatch and nothing else, split out
of `src/hermetic-home.ts` so every other line of that file stays inside
the floor). Bun does not report
branch coverage here.

The test scripts pass `--timeout=10000` so every test's own budget sits
above the shared `waitFor` default (8 seconds): a condition that never
becomes true reports the waitFor diagnostic, not a silent runner
timeout.

## Installed contracts

`bun run test:contracts` enables installed-harness help and version checks.
The full release gate already runs this target. The default test suite skips
those opt-in checks; the release gate does not leave them disabled.

Absent binaries are skipped and reported. Installed versions must satisfy
their required help contracts and compatibility rules. The checks run
serially with a 60-second per-command timeout and terminate timed-out process
trees. Copilot extraction uses a private temporary cache rather than the
operator cache. Cursor uses a standalone entry, not the desktop installer.

A missing harness is not verified by a passing skip. Record available
versions, skipped harnesses, and separate upstream evidence in the
[compatibility reference](harnesses.md). The scode contract likewise
skips when scode is absent. CI runs the full gate on macOS and Linux, on
pushes to `main`, `release/**`, and `ci/**`, with the job capped at 40
minutes; the workflow appends the gate's wall time to `gate.log`.

## Static checks and live probes

Help, version, `list`, `autonomy`, `doctor`, and `verify` do not submit
model prompts. The gate covers every command's help surface, including
`check --help` and `session --help`.

Actual `check`, `run`, `session`, and `tui` invocations can send provider
requests and spend quota. They are outside the automated gate. The owner-run
[live gate](RELEASE-GATE.md#live-harness-gate) is the authorized way to spend
that quota for a release: its probe table names the per-probe cost, and its
tests (`tests/live-gate.test.ts`) pin the probe matrix to the adapters'
declared capabilities so an `UNSUPPORTED` cell can never silently count as a
pass. A hermetic check normally makes two requests: the isolated probe and
its plain control. Obtain explicit authorization and a budget before new
live probes. Use codemux for authorized model work and record the exact
version, authentication conditions, requested capabilities, result, and
evidence path. The installed distribution is exercised without quota by
`make installed-layout` (see the
[distribution section](RELEASE-GATE.md#distribution-and-installed-layout)).

A `usage` query can invoke usagemux and access provider APIs or local
credentials. `usage --help` does neither. Follow
[isolation evidence requirements](isolation.md) and the
[experiment procedure](experiment-mcp.md) when applicable.

## Reporting a failure

Include the failing command, exit code, diagnostic, environment limitation,
and whether a focused rerun or full rerun passed. Separate missing binaries,
host-dependent skips, schema fixtures, and successful live observations.
An isolated passing retry does not make a failed full gate green.
