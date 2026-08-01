# Contributing to codemux

Thanks for helping improve `codemux`.

## Before opening a change

1. Check existing issues and pull requests for overlapping work.
2. Keep changes focused and preserve the normalized autonomy and sandbox
   invariants documented in `README.md`.
3. Add a regression test for bug fixes when practical.
4. Update user-facing documentation and `CHANGELOG.md` when behavior changes.

## Development setup

Install Bun 1.3.14, then run:

```bash
bun install --frozen-lockfile
make check
make release-gate
```

The default suite is hermetic. If supported agent CLIs are installed locally,
their current help surfaces can be checked separately:

```bash
bun run test:contracts
```

See `docs/TESTING.md` for targeted commands and coverage details.

## Pull requests

- Use clear, conventional commit subjects (`feat:`, `fix:`, `docs:`, and so on).
- Keep source files focused and preferably below 500 lines.
- Explain user-visible and security-relevant behavior changes.
- Confirm type checking, tests, coverage, dependency audit, and smoke checks
  pass before requesting review.

## Security

Do not open public issues for suspected vulnerabilities. Follow the private
reporting instructions in `SECURITY.md`.
