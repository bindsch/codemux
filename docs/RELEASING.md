# Releasing codemux

This document defines the release flow for `codemux`.

## Prerequisites

- Clean working tree for release changes.
- `bun` installed.
- Access to publish/tag in the target remote.

## Release steps

1. Sync and create release branch.
2. Run the full gate:

   ```bash
   make check
   ```

3. Execute release checklist in `docs/RELEASE-GATE.md`.
4. Bump version in:
   - `package.json`
   - `src/index.ts` (`program.version`)
5. Update changelog:
   - Move items from `[Unreleased]` to `## [X.Y.Z] - YYYY-MM-DD`
   - Add concise user-facing notes.
6. Re-run gate and smoke tests:

   ```bash
   make check
   bun run src/index.ts --version
   bun run src/index.ts verify --show-scode
   ```

7. Commit with conventional commit message (usually `chore(release): X.Y.Z`).
8. Tag and push:

   ```bash
   git tag vX.Y.Z
   git push origin <branch>
   git push origin vX.Y.Z
   ```

## Post-release

- Confirm tag exists on remote.
- Confirm release notes/changelog render correctly.
- Start next cycle by ensuring `[Unreleased]` remains at top of `CHANGELOG.md`.
