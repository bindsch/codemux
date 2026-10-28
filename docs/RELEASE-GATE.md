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

## Live harness gate

The owner must run this gate on the release machine before tagging:

```sh
make live-gate
```

By default, the gate runs `<repo>/bin/codemux`. Use `--codemux <path>` to
test another binary. The path must be an existing executable file. Invalid
paths exit 2 before any probes run. Relative paths resolve from the current
working directory. The report's first line and totals name the binary used.

This opt-in gate sends real prompts and spends quota. It is separate from
the automated gate. It tests every installed harness with two probes under
the default sandbox:

| Probe | Autonomy | Required behavior |
| --- | --- | --- |
| A | `read-only` | Reply with exactly `OK`. |
| B | `medium` | In a fresh `--cwd`, execute `sh probe.sh` and return only its exact stdout. |

For Probe B, the gate writes a fresh random 12-hex nonce to `.nonce` with
mode `0600` and writes `probe.sh` with mode `0700`. The script runs
`printf %s "$(cat .nonce)" | shasum -a 256 | cut -c1-16`.
It uses `sha256sum` when `shasum` is absent.
The prompt asks the harness to run `sh probe.sh`; it does not contain the
nonce or its hash. The gate computes the expected SHA-256 with `node:crypto`.
Trimmed stdout must equal the first 16 hex characters of that hash.
The hash is never written to a probe file. Reading or copying the nonce with
file tools cannot produce the required output. Matching stdout proves a
command ran in the working directory and returned its output.

Both probes must exit 0 and return the required output after trimming
surrounding whitespace. An exit of 0 alone does not pass a probe. Each probe
defaults to a 180-second harness timeout. The gate's outer deadline adds
30 seconds to that timeout. At most four probes run concurrently. Use the
script's `--timeout` (seconds) and `--jobs` (1–4) options to change those
limits:

```sh
bun run scripts/live-gate.ts --timeout 240 --jobs 2
```

A terminal `SIGHUP` stops active probe process groups and makes the gate
exit 129. Use `--pass-env <names>` to forward a comma-separated environment
list verbatim as `--pass-env <names>` to every probe. The operator must name
each pass-through explicitly. An ambient `CODEMUX_CURSOR_ENTRY` never adds
one automatically. To select Cursor's alternate entry, set
`CODEMUX_CURSOR_ENTRY=cursor` in the environment and run:

```sh
make live-gate LIVE_GATE_ARGS="--pass-env CODEMUX_CURSOR_ENTRY"
```

The Makefile forwards `LIVE_GATE_ARGS` to the script. It also accepts the
option directly:

```sh
bun run scripts/live-gate.ts --pass-env CODEMUX_CURSOR_ENTRY
```

Only installed harnesses appear in the table. For harnesses without
credentials, request an explicit skip with a comma-separated list:

```sh
LIVE_GATE_SKIP=gemini,qwen,goose make live-gate
bun run scripts/live-gate.ts --skip gemini,qwen,goose
```

Explicit skips report `SKIP (no credentials; operator requested)`. A skip is
not a passing probe. Do not skip an installed harness that has credentials
to hide a failure. The gate exits 1 when no probes run, including when no
harnesses are installed or `--only` selects none of the installed harnesses.
It prints `live-gate: nothing was probed` after the table and totals. If every
listed harness was explicitly skipped, the message is
`live-gate: nothing was probed (all skipped)` and the exit code is still 1.

Refuse the release if any installed, credentialed harness fails either
probe, or if a feature behaves differently across harnesses without a
documented unsupported entry. `MEDIUM_UNSUPPORTED` records documented
exceptions to Probe B. An entry still runs Probe A and is reported as
`UNSUPPORTED (documented)` for Probe B; it must cite the
[autonomy matrix](autonomy-and-sandboxing.md#native-mappings) note that
explains why the harness cannot run a shell command headless at medium.
Kimi's headless reliance on scode does not justify an entry.

| MEDIUM_UNSUPPORTED harness | Unsupported behavior and evidence |
| --- | --- |
| gemini | `--approval-mode auto_edit` auto-approves edits but needs interactive approval for shell commands, which a headless run denies; the adapter has no grant mechanism (matrix note, Gemini 0.60.0). |

- [ ] Owner ran `make live-gate` on the release machine for the candidate.
- [ ] After reinstalling the Homebrew bottle, run `make live-gate LIVE_GATE_ARGS="--codemux $(brew --prefix)/bin/codemux"` to test the installed binary.
- [ ] Every installed, credentialed harness passed both probes with exit 0
  and the exact required output, except a `MEDIUM_UNSUPPORTED` entry, which
  passed Probe A and was reported as unsupported for Probe B.
- [ ] Record the result table, timeout and job limits, and every skip reason.
- [ ] No feature differs across harnesses without a documented unsupported
  entry; `MEDIUM_UNSUPPORTED` still matches the autonomy matrix.

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
