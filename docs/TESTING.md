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
bun test
```

## Targeted test runs

```bash
# CLI-focused tests
bun test tests/cli.test.ts

# Sandbox and policy tests
bun test tests/sandbox.test.ts tests/sandbox-policy.test.ts

# Adapter command construction tests
bun test tests/adapters.test.ts
```

## CLI smoke checks

These are lightweight runtime checks that do not require network/model calls.

```bash
bun run src/index.ts --help
bun run src/index.ts list
bun run src/index.ts autonomy
bun run src/index.ts verify
bun run src/index.ts verify --show-scode
```

## Sandbox behavior checks

```bash
# conflict detection should fail
bun run src/index.ts verify --show-scode --sandbox-no-net --sandbox-allow-net && exit 1 || true

# preview policy overrides
bun run src/index.ts verify --show-scode -a codex --sandbox-trust trusted --sandbox-scrub-env
```

## Notes

- `verify` is static wiring validation and does not execute model/network calls.
- `run` and `tui` may require installed external harness binaries for end-to-end behavior.
