# Releasing codemux

This document defines the source-only GitHub release flow for `codemux`.
`package.json` is intentionally private; do not publish this package to npm.

## Prerequisites

- Clean working tree for release changes.
- Bun 1.3.14 installed.
- Access to merge, tag, and create releases in the target GitHub repository.

## Release steps

1. Sync `main` and create a release branch.
2. Run the full gate:

   ```bash
   make release-gate
   ```

3. Execute release checklist in `docs/RELEASE-GATE.md`.
4. Bump `package.json` version. The CLI reads it directly.
5. Update changelog:
   - Move items from `[Unreleased]` to `## [X.Y.Z] - YYYY-MM-DD`
   - Add concise user-facing notes.
6. Re-run gate and smoke tests:

   ```bash
   make release-gate
   ./bin/codemux --version
   ./bin/codemux verify --show-scode
   ```

7. Commit with a conventional commit message (usually
   `chore(release): X.Y.Z`), open a pull request, and merge it to `main`.
8. Wait for CI to pass on the exact `main` commit that will be tagged.
9. Tag that commit and push the tag:

   ```bash
   git switch main
   git pull --ff-only
   git tag -a vX.Y.Z -m "codemux X.Y.Z"
   git push origin vX.Y.Z
   ```

10. Create a GitHub release from the annotated tag:

    ```bash
    gh release create vX.Y.Z --verify-tag --generate-notes
    ```

## Post-release

- Confirm tag exists on remote.
- Confirm tag-triggered CI passes on macOS and Linux.
- Confirm the GitHub source archives install with the frozen lockfile.
- Confirm release notes/changelog render correctly.
- Start next cycle by ensuring `[Unreleased]` remains at top of `CHANGELOG.md`.
