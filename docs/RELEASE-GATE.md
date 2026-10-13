---
read_when: "Verifying a change or preparing a release candidate."
---
# Release gate

This is the canonical full verification command and release checklist.
[Testing](TESTING.md) explains evidence limits; [releasing](RELEASING.md)
defines publication order. A passing gate is necessary but does not publish
a release or prove an authenticated live run.

## Automated gate

Install dependencies with `bun install --frozen-lockfile`, then run:

```sh
make release-gate
```

This includes the Bun runtime floor, TypeScript checking, POSIX shell syntax,
the unfiltered test suite, conservative whole-source coverage, installed
harness contracts, scode compatibility, every CLI help surface, static smoke
checks, dependency audit, and frozen-lockfile validation. The Makefile and
package scripts define the commands; do not maintain a separate copied gate.
The shell target runs `sh -n` separately for the launcher and alias script.
`bun run check` delegates to `make check`, so both include that validation.

Installed contracts are **enabled by the gate**. Missing harness binaries
skip; available ones are checked. Missing scode also skips its contract.
Record those gaps. No model prompt is part of the gate.

- [ ] Gate exits 0; record the command, pass/fail/skip totals, test-count
  change, coverage, and closing summary.
- [ ] Skipped or absent harnesses and host restrictions are named.
- [ ] CI passes on both macOS and Linux for the exact candidate commit.
- [ ] No selected test run is presented as the full suite.

## CLI and contract coverage

- [ ] Help renders for the root and every command: `run`, `tui`,
  `session`, `list`, `doctor`, `check`, `usage`, `calls`, `autonomy`,
  and `verify`.
- [ ] CLI version matches `package.json`, the single runtime version source.
- [ ] `verify` and scode previews agree with the documented trust and
  autonomy rules. Preview-only flags warn when used without `--show-scode`.
- [ ] Current reference pages match behavior and error contracts.
- [ ] Changed compatibility claims have versioned evidence. Absent local
  tools are not described as installed-contract successes.
- [ ] Any authorized live probe has a separate budget and record. Historical
  canary results are dated; do not renew them through synthetic tests.

## Release content

- [ ] `CHANGELOG.md` retains `[Unreleased]` and has a dated release section.
- [ ] The section states user-visible changes, upgrade constraints, capability
  withdrawals, and security or sandbox changes.
- [ ] Release notes are copied from that curated section. Automatically
  generated commit notes are not a substitute.
- [ ] Historical reports retain their original release and scope, with
  corrections or later-outcome links rather than version churn.
- [ ] `package.json` stays private; npm publication is not configured.
- [ ] [Installation](installation.md) states supported distribution paths.

## Distribution and installed layout

- [ ] Downloaded source archive matches the reviewed tag. Its checksum is
  computed from the actual archive, not copied from a previous release.
- [ ] Homebrew formula version and source URL identify that release. A Git
  source uses its tag and pinned revision; an archive source uses its SHA-256.
  Bottle checksums and supported platforms match the actual bottle artifacts.
- [ ] Formula runtime dependencies satisfy the documented Bun and scode
  requirements, including conditional feature floors.
- [ ] Project MIT license and dependency licenses are present in the installed
  distribution.
- [ ] Installed `bin/codemux` resolves into `libexec/bin`, finds its runtime
  configuration and dependencies, and prints the expected version.
- [ ] Installed guides exist under `libexec/docs`; internal links resolve.
  README links still work when README is installed above `libexec`.
- [ ] Source installation with the frozen lockfile succeeds.
- [ ] Root and command help, static verification, and installed documentation
  are checked from the installed distribution, not only the source checkout.

## Before and after publication

- [ ] Tag the exact reviewed commit only after its branch CI passes.
- [ ] Obtain authorization for tag push, GitHub release, and Homebrew changes.
- [ ] Confirm remote tag, tag-triggered CI, release notes, source archives,
  and any formula/bottle publication after publishing.
