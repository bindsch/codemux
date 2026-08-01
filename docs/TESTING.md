# Testing codemux

## Prerequisites

```bash
bun install
```

## Core checks

Run the full quality gate:

```bash
make check
```

Equivalent direct commands:

```bash
bun run typecheck
bun run test:coverage
```

## Targeted test runs

```bash
# CLI-focused tests
bun test tests/cli.test.ts tests/cli-run.test.ts

# Sandbox and policy tests
bun test tests/sandbox.test.ts tests/sandbox-policy.test.ts

# Adapter command construction tests
bun test tests/adapters.test.ts tests/adapters-extended.test.ts tests/new-adapters.test.ts

# Process lifecycle, timeout, output-limit, file-input, and Z.AI credential tests
bun test tests/base.test.ts tests/zai.test.ts

# Order/race stress
bun test --max-concurrency=1 --randomize --rerun-each=3
```

## Installed harness contracts

The default suite is hermetic and never starts locally installed third-party
agents. To compare adapter flags with the harness versions on your machine:

```bash
bun run test:contracts
```

These opt-in checks can be slow or fail after an upstream CLI changes its
interface. They run serially, use a 60-second per-command timeout, and terminate
the process tree on timeout.

The contract output reports which locally installed harnesses were exercised.
Absent harnesses still require the release/changelog and latest-distribution
checks recorded in `docs/HARNESS-COMPATIBILITY.md`.

## CLI smoke checks

These are lightweight runtime checks that do not require network/model calls.

```bash
./bin/codemux --help
./bin/codemux list
./bin/codemux autonomy
./bin/codemux verify
./bin/codemux verify --show-scode
```

## Sandbox behavior checks

```bash
# installed wrapper compatibility (skips when scode is absent)
bun run scripts/check-scode-version.ts

# preview policy overrides
./bin/codemux verify --show-scode -a codex --sandbox-trust trusted --sandbox-scrub-env
```

## Notes

- `verify` is static wiring validation and does not execute model/network calls.
- `check` makes a real provider/model request. It requires configured
  credentials and may consume quota or incur charges.
- `run` and `tui` may require installed external harness binaries for end-to-end behavior.
- Installed harness contract checks are opt-in so local tools, network state, or
  auto-updaters cannot make the release gate nondeterministic.
- CI runs the release gate on macOS and Linux, the supported platforms.
- The full `test:coverage` script enforces at least 80% whole-source line and
  function coverage; targeted test commands intentionally skip coverage.
  Bun reports only modules loaded in the test process and does not emit branch
  coverage. Core CLI helpers are imported by unit tests; `src/index.ts` behavior
  is covered by hardened-launcher end-to-end tests whose child-process coverage
  is not merged into Bun's report. `scripts/check-source-coverage.ts` closes the
  loaded-module loophole by counting every omitted source file as fully uncovered
  and enforcing 80% on that conservative whole-source result.
