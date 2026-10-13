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
bun run test tests/session-exit-contract.test.ts tests/session-cli.test.ts
bun run test tests/experiment-mcp.test.ts tests/experiment-bridge.test.ts tests/agy-isolation.test.ts
```

These selected suites help diagnose a change. They do not replace the
unfiltered suite in the full gate. There is no separate lint target;
type checking and shell syntax checks are included.

All package test scripts preload `tests/setup.ts`. Its
`CODEMUX_TEST_LEDGER` redirect prevents test receipts from entering the
operator ledger. Do not rely on `NODE_ENV=test` for that isolation.

## Coverage

`bun run test:coverage` runs the unfiltered suite and enforces at least
80% whole-source line and function coverage. Bun reports loaded modules and
does not merge spawned-child coverage into the parent report.
`scripts/check-source-coverage.ts` counts omitted source files as entirely
uncovered before enforcing the thresholds. Bun does not report branch
coverage here.

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
[compatibility reference](HARNESS-COMPATIBILITY.md). The scode contract likewise
skips when scode is absent. CI runs the full gate on macOS and Linux.

## Static checks and live probes

Help, version, `list`, `autonomy`, `doctor`, and `verify` do not submit
model prompts. The gate covers every command's help surface, including
`check --help` and `session --help`.

Actual `check`, `run`, `session`, and `tui` invocations can send provider
requests and spend quota. They are outside the automated gate. A hermetic
check normally makes two requests: the isolated probe and its plain control.
Obtain explicit authorization and a budget before new live probes.
Use codemux for authorized model work and record the exact version,
authentication conditions, requested capabilities, result, and evidence path.

A `usage` query can invoke usagemux and access provider APIs or local
credentials. `usage --help` does neither. Follow
[isolation evidence requirements](HERMETIC.md) and the
[experiment procedure](experiment-mcp.md) when applicable.

## Reporting a failure

Include the failing command, exit code, diagnostic, environment limitation,
and whether a focused rerun or full rerun passed. Separate missing binaries,
host-dependent skips, schema fixtures, and successful live observations.
An isolated passing retry does not make a failed full gate green.
