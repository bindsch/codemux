# Release Gate

Use this checklist before tagging a new `codemux` release.

## 1) Version consistency

- [ ] `package.json` version matches CLI version output. The CLI reads this value
  at runtime; there is no duplicated source constant.
- [ ] README beta/version banner matches release status:
  - `README.md`
- [ ] Changelog has a new release section and keeps `[Unreleased]` at top:
  - `CHANGELOG.md`

## 2) Automated checks

- [ ] Install dependencies:

  ```bash
  bun install --frozen-lockfile
  ```

- [ ] Full gate passes:

  ```bash
  make release-gate
  ```

- [ ] Shell launchers and aliases pass POSIX syntax validation:

  ```bash
  sh -n bin/codemux scripts/aliases.sh
  ```

- [ ] Optional explicit run (same checks via scripts):

  ```bash
  bun run typecheck
  bun run test:coverage
  bun audit
  bun install --frozen-lockfile --dry-run
  ```

## 3) CLI smoke tests

- [ ] Core help/version:

  ```bash
  ./bin/codemux --help >/dev/null
  ./bin/codemux --version
  ```

- [ ] Command help surface still renders:

  ```bash
  ./bin/codemux run --help >/dev/null
  ./bin/codemux tui --help >/dev/null
  ./bin/codemux verify --help >/dev/null
  ```

- [ ] Static diagnostics and wiring checks:

  ```bash
  ./bin/codemux list
  ./bin/codemux autonomy
  ./bin/codemux verify
  ./bin/codemux verify --show-scode
  ./bin/codemux verify --show-scode --sandbox-trust trusted --sandbox-no-net
  ```

## 4) Sandbox policy verification

- [ ] Preview-only flags warn without `--show-scode`:

  ```bash
  ./bin/codemux verify --sandbox-no-net
  ```

## 5) Documentation consistency

- [ ] README options/commands match `--help` output (`run`, `tui`, `verify`).
- [ ] Sandbox trust defaults and override semantics match implementation in:
  - `src/sandbox-policy.ts`
  - `src/sandbox.ts`
- [ ] The hostile-working-tree launcher regression passes (`tests/cli.test.ts`).
- [ ] Installed harness contract checks (also included by `make release-gate`)
  pass for every target available locally:

  ```bash
  bun run test:contracts
  ```
- [ ] If `scode` is installed, the release gate verifies it is version 0.2.0
  or newer. `codemux doctor` reports the same compatibility status.
- [ ] Every row in `docs/HARNESS-COMPATIBILITY.md` has been checked against the
  current upstream release/changelog; absent local CLIs are not counted as
  verified merely because the installed-contract suite skips them.
- [ ] Release/testing docs remain accurate:
  - `docs/TESTING.md`
  - `docs/RELEASING.md`

## 6) Packaging/launcher sanity

- [ ] Confirm the source-only package remains private and is not configured for
  npm publication.
- [ ] Execute the package launcher directly without mutating global link state:

  ```bash
  ./bin/codemux --version
  ./bin/codemux verify --show-scode -a codex
  ```

## 7) Release notes

- [ ] Move user-visible items from `## [Unreleased]` into a new version section:
  - `## [X.Y.Z] - YYYY-MM-DD`
- [ ] Keep concrete, user-facing entries (avoid placeholders).
- [ ] Ensure any security/sandbox behavior change is explicitly called out.
- [ ] Tag the exact reviewed `main` commit only after branch CI passes.
- [ ] Confirm tag-triggered CI and the GitHub release complete successfully.
