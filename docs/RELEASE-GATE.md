# Release Gate

Use this checklist before tagging a new `codemux` release.

## 1) Version consistency

- [ ] `package.json` version matches CLI version output target:
  - `package.json` (`version`)
  - `src/index.ts` (`program.version(...)`)
- [ ] README beta/version banner matches release status:
  - `README.md`
- [ ] Changelog has a new release section and keeps `[Unreleased]` at top:
  - `CHANGELOG.md`

## 2) Automated checks

- [ ] Install dependencies:

  ```bash
  bun install
  ```

- [ ] Full gate passes:

  ```bash
  make check
  ```

- [ ] Optional explicit run (same checks via scripts):

  ```bash
  bun run typecheck
  bun test
  ```

## 3) CLI smoke tests

- [ ] Core help/version:

  ```bash
  bun run src/index.ts --help >/dev/null
  bun run src/index.ts --version
  ```

- [ ] Command help surface still renders:

  ```bash
  bun run src/index.ts run --help >/dev/null
  bun run src/index.ts tui --help >/dev/null
  bun run src/index.ts verify --help >/dev/null
  ```

- [ ] Static diagnostics and wiring checks:

  ```bash
  bun run src/index.ts list
  bun run src/index.ts autonomy
  bun run src/index.ts verify
  bun run src/index.ts verify --show-scode
  bun run src/index.ts verify --show-scode --sandbox-trust trusted --sandbox-no-net
  ```

## 4) Sandbox policy verification

- [ ] Conflicting sandbox policy flags fail fast:

  ```bash
  bun run src/index.ts verify --show-scode --sandbox-no-net --sandbox-allow-net && exit 1 || true
  ```

- [ ] Preview-only flags warn without `--show-scode`:

  ```bash
  bun run src/index.ts verify --sandbox-no-net
  ```

## 5) Documentation consistency

- [ ] README options/commands match `--help` output (`run`, `tui`, `verify`).
- [ ] Sandbox trust defaults and override semantics match implementation in:
  - `src/sandbox-policy.ts`
  - `src/sandbox.ts`
- [ ] Release/testing docs remain accurate:
  - `docs/TESTING.md`
  - `docs/RELEASING.md`

## 6) Packaging/install sanity

- [ ] Link and execute installed binary:

  ```bash
  bun link
  codemux --version
  codemux verify --show-scode -a codex
  ```

- [ ] Unlink cleanly after verification:

  ```bash
  bun unlink
  ```

## 7) Release notes

- [ ] Move user-visible items from `## [Unreleased]` into a new version section:
  - `## [X.Y.Z] - YYYY-MM-DD`
- [ ] Keep concrete, user-facing entries (avoid placeholders).
- [ ] Ensure any security/sandbox behavior change is explicitly called out.
