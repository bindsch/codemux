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
checks, dependency audit, frozen-lockfile validation, and the installed
layout (`make installed-layout`: the keg a release installs matches the
repository's bin, libexec, and docs trees). The Makefile and
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

The free [machine check](machine-check.md) (`make machine-check`) verifies
the machine itself — installation, configuration, scode, per-harness
version contracts and login state — without spending quota. Run it first;
this gate below is what spends.
By default, the gate runs `<repo>/bin/codemux`. Use `--codemux <path>` to
test another binary — a candidate build. The path must be an existing
executable file. Invalid paths exit 2 before any probes run. Relative paths
resolve from the current working directory. The report's first line and
totals name the binary used. For a candidate, the gate also changes what it
asks: the candidate must answer `<candidate> --version` with this
checkout's own version (a gate from a different checkout reads a different
contract table; pass `--allow-version-mismatch` to test one anyway), and
discovery plus capabilities come from the candidate's own
`<candidate> list --json` (schema `codemux-list-1`), never from this
checkout's adapter registry — including the experiment-MCP and
served-model facts (`experimentMcp`, `experimentPrefix`,
`servedModelEvidence` per agent entry) that decide the G and H probe sets,
so a candidate that changed either mechanism is probed against its own
facts. A listing without those fields is refused: it is from an older
build, and guessing this checkout's facts is what the listing exists to
prevent. The report carries a NOTE line naming the
candidate as the source of the probe matrix. The version-contract column
probes every id the candidate lists as available, resolving each binary
through the candidate's own listing (`binary` in each agent entry); a
harness this checkout cannot resolve gets an `UNREADABLE` row saying so
instead of no row, and a candidate-available harness left without a row
fails the gate.

This opt-in gate sends real prompts and spends quota. It is separate from
the automated gate. Under the default sandbox it runs one probe per installed
harness for every probe that harness supports:

| Probe | Autonomy | Required behavior |
| --- | --- | --- |
| 0 | — | Zero quota. Version-contract column: every installed harness's `--version` verdict (`SUPPORTED`, `CONTRACT-STALE`, `KNOWN-BREAK`, `UNREADABLE`, `UNTRUSTED`, `NO-CONTRACT`) plus `codemux usage --json` when usagemux is installed — a usagemux below 1.0.0 fails the check before any snapshot runs, because it predates the validated snapshot shape the check parses. `UNTRUSTED` means the harness binary failed codemux's trust check, was never executed, and its row says why. `UNREADABLE` and `UNTRUSTED` rows fail the gate like `CONTRACT-STALE` (a harness whose contract could not be established is not released on its probes alone); `--allow-stale-contracts` lifts those three. A `KNOWN-BREAK` verdict fails the gate under its own switch — `--allow-known-breaks` — unless the record is sandbox-mitigated, in which case it never fails and its cell prints `KNOWN-BREAK (mitigated)`. `NO-CONTRACT` is the documented state of a harness without a contract and does not fail. |
| A | `read-only` | Reply with exactly `OK`. |
| B | `medium` | In a fresh `--cwd`, execute `sh probe.sh` and return only its exact stdout. |
| C | `read-only` | `--result-json` exits 0 and the envelope parses as the documented schema for the probed agent: the reply (or result) field the harness's shape promises is the requested `OK` answer (trimmed, the same padding the run probes accept), `codemux.agent` equals the probed agent, every documented `codemux` block key is present (`model`, `served_model`, `labels`, `session_id`, `recording`, `failure_code`), and `codemux.usage` carries its five documented fields (`input_tokens`, `output_tokens`, `cached_input_tokens`, `total_tokens`, `cost_usd`). A cross-wired or truncated envelope builder fails instead of passing on a bare agent string, and a well-formed envelope whose answer is not `OK` fails too. Runs only on adapters that declare the result-JSON capability. |
| D | — | `codemux check -a <harness> --hermetic` exits 0: the hermetic probe and its control. Runs only on hermetic-capable adapters. The probe's outer deadline is `2 × --timeout + 30` seconds — the check performs two sequential launches (the probe, then the control), each with the full `--timeout`; every single-launch probe gets `--timeout + 30`. |
| E | `read-only` | `--tools none` under `--hermetic` returns `OK`. Runs only on harnesses whose plain `--tools none` control is refused (opencode). |
| F | `read-only` | One session turn over the session protocol's JSONL stdin grammar: the gate writes one user frame naming a fresh nonce, keeps stdin open while the turn runs — closing stdin at once is EOF, which a session driver answers by draining the session instead of running the turn — and writes the `shutdown` frame only after the turn's `turn_completed` event, then ends stdin. A `turn_completed` event with `finish: "end"` for the turn that carried it and an `assistant_message` carrying the nonce must appear on stdout, and the session must end with a `session_ended` event whose `reason` is `shutdown` and whose `exit_code` is 0 — a session that exits 0 without a completed turn fails, and so does a turn that completed `failed` or `interrupted`, a session ended by stdin EOF, signal, or crash, or one whose drain grace expired before the child stopped — and the live-session registry entry must be removed or marked ended. |
| G | `read-only` | One hermetic experiment-MCP run against the repository's echo fixture server. The reply must carry the fixture's marker — the bare marker passes for every experiment harness, and codex and kimi may also echo their own wall-time header under its production boundary (codex: four-decimal `Wall time: <seconds> seconds\nOutput:` then one newline and the marker; kimi: three-decimal `Wall time: <seconds> seconds\n` glued directly to the marker). Models drop that header when they echo, so the reply alone proves nothing about delivery; the proof is the recording the probe's spec writes into its run directory. The gate reads it and requires exactly one `model_tool_result` record holding the result as delivered to the model — for codex and kimi opening with that harness's own header (parsed with the harness's own content module) followed by the marker, for claude and zai the bare marker — plus one `result_comparison` record with `equal: true`. A missing, unreadable, or unparseable recording fails the probe naming its path. The codex probe carries `-m worker` by default, because a codex experiment refuses a request without an explicit model; `worker` is the operator's model alias (`models.codex.worker` in the codemux config), and `--codex-model <name>` names another alias or model for a machine without that alias. |
| H | `read-only` | Provider override through `CODEMUX_<AGENT>_PROVIDER_*` environment variables, run with `--result-json`: the envelope's `codemux.served_model` — the model the provider reported serving the run, not codemux's own `codemux.model` selection — must be the model the override selected, so a harness answering from default credentials, or one the override silently ignored, fails. Opt-in only: `--probe provider-override` with `LIVE_GATE_PROVIDER_OVERRIDE=1`. Runs only on adapters that can both take a provider override and carry real provider-reported evidence in their result envelope — today claude. Codex names a served model only in a reroute notice, so a run the override served without rerouting reports `served_model: null`; its cell prints UNSUPPORTED rather than assert an override on evidence that arrives only sometimes. Z.AI's wire reports the served model but its adapter declares no provider override, so its cell prints UNSUPPORTED for the missing capability; opencode's and kimi's wires expose no served-model field, so their cells print UNSUPPORTED rather than assert an override on evidence that cannot exist. Before any probe runs, a preflight refuses the opt-in unless every harness that will run H exports all three of its `CODEMUX_<AGENT>_PROVIDER_{BASE_URL,API_KEY,MODEL}` variables nonempty — a missing one would probe the operator's default credentials instead of the override. |
| H2 | `read-only` | The loopback twin of probe H: no real provider is in play when the candidate honors the override, and then no provider quota is spent. The launch carries `--sandbox-scrub-env`, so the operator's real credentials never reach the child's environment and a candidate that ignored the override could spend nothing from them; credential files inside the harness state directories remain the residual (the sandbox allows that state), so a run that ignored the override fails the log check after at most one real request. The gate serves a fake provider on loopback, generates a throwaway override key and model, and points the run's `CODEMUX_<AGENT>_PROVIDER_{BASE_URL,API_KEY,MODEL}` variables at it; the three names also ride `--pass-env`, so a scrubbed sandbox still passes them to the harness. The fake refuses every request that does not carry the override key. The proof is the fake's request log, never the envelope or the exit code — the run may fail on the fake's minimal answer and the probe still pass: at least one request must reach the fake (no request means the override did not route the run), every request must carry the override key (a request with another credential means the run spent the operator's own account; a request with none means the key never reached the provider), and at least one request must name the override model. Costs no provider quota. The login pre-check never skips H2, because its credentials are the loopback override, not the operator's store. Runs only on adapters that declare the provider-override capability. |
| I | `read-only` | The model-alias and effort wiring. The launch carries `-m <alias> --effort low`, where the alias resolves through the same effective model config the launched run reads: `worker`, `clerk`, or `judge` when a tier names the harness, otherwise the first alias that maps it; no alias mapping the harness at all is a SKIP naming the harness, never a `-m` on a name nobody resolves. Where the harness reports result JSON (probe C's set), the envelope must pass probe C's checks and its `codemux.model` must name the alias's target — an alias that resolves to a different model on the way in fails. Runs only on adapters that declare both the model and effort capabilities. |
| J | `medium` | The sandbox policy flags as the release contract runs them — together on one launch: `--sandbox-no-net --sandbox-scrub-env --sandbox-trust standard` at `medium` autonomy. The run executes a script that curls a port the gate itself serves on loopback, so the address is provably reachable before the launch; the script must print `BLOCKED`. `OPEN` means the no-network policy did not hold. A machine without curl prints `NO-CURL` and fails the probe; install curl or exclude J there. Runs on every harness — it probes codemux's own sandbox flags, not a harness capability. |
| P | `read-only` | `run --print-sandbox`: the launch prints the scode argv, one argument per line, and exits 0 without a child. The printed argv must name scode and the harness binary. Zero quota and no credential: a print-only launch prepares paths, never a login, a token copy, or a Keychain (agy). Runs on every installed harness, credentials or not. |

The whole probe pool is wrapped in a Keychain hygiene check on macOS: the
gate snapshots `security list-keychains -d user` and `security
default-keychain -d user` before the first probe and after the last, and a
gate whose snapshots differ fails with both printed, whatever the harnesses
answered (probes run concurrently, so the check is one per gate, not one
per probe). A
sandboxed agy run gives its private HOME a private Keychain and must leave
the operator's search list and default exactly as it found them; a mirror
left behind is what produces the macOS prompt "a keychain cannot be found to
store antigravity" the next time any process stores a credential
(2026-11-03). The machine check reports a user default keychain that names a
missing file as broken, with the `security default-keychain -d user -s`
remedy.

Every model-backed probe is one agent turn, except D (a hermetic check is the
isolated probe plus its plain control: two requests). On a machine with the
full harness set, a default gate costs about 90 round trips — eleven per
harness with every capability (the result-JSON, hermetic, tools, session,
experiment, loopback, alias, and sandbox probes; the hermetic check launches
twice), three per harness with only the base probes and the sandbox probe.
Scope the spend with `--only` and `--skip`. Probe 0 spends nothing; H2 spends
no provider quota; J's script reaches only the gate's own loopback listener.
The codex G probe runs its code-mode
model for six to eight minutes on the release machine (395 s and 495 s on
2026-11-02), which is why the per-probe timeout defaults to 600 seconds:
the canonical `make live-gate` must be able to run every probe it requires.

For Probe B, the gate writes a fresh random 12-hex nonce to `nonce.txt` with
mode `0600` and writes `probe.sh` with mode `0700`. The script runs
`printf %s "$(cat nonce.txt)" | shasum -a 256 | cut -c1-16`.
It uses `sha256sum` when `shasum` is absent.
The prompt asks the harness to run `sh probe.sh`; it does not contain the
nonce or its hash. The gate computes the expected SHA-256 with `node:crypto`.
Trimmed stdout must equal the first 16 hex characters of that hash.
The hash is never written to a probe file. Reading or copying the nonce with
file tools cannot produce the required output. Matching stdout proves a
command ran in the working directory and returned its output.

Every probe must exit 0 and return the required output after trimming
surrounding whitespace. An exit of 0 alone does not pass a probe. The report
prints one row per harness × probe. A row is `PASS`, `FAIL`, `SKIP`, or
`UNSUPPORTED`:

- `UNSUPPORTED` means the adapter declares no capability for that probe.
  It is documented behavior (the [harness matrix](harnesses.md) lists each
  capability), never a pass, and the row quotes the absent capability.
- `SKIP` is an operator request or a login pre-check refusal. A skip is not
  a passing probe. Do not skip an installed harness that has credentials to
  hide a failure.
- Harness `Warning:` stderr lines are kept in the row's note. A stale-version
  warning can no longer hide behind a `PASS`.

Before any probe runs, the gate reads each installed harness's login state.
A harness whose credential store is absent gets `SKIP` rows for the probes
it supports — the note reads `no credentials detected: <store>` and names
the store the adapter looked in — instead of spending the probe on a login
refusal. Probe H2 is exempt: its credentials are the loopback override the
gate generated, not the operator's store. `--probe-anyway <agents>` runs
named harnesses anyway, for an operator who knows the store detection is
wrong for a harness.

A `CONTRACT-STALE` contract (installed version above the audited ceiling or
below the enforced minimum) fails the gate, and so do `UNREADABLE` and
`UNTRUSTED` contract rows; `--allow-stale-contracts` reports those three
without failing. A `KNOWN-BREAK` contract (a recorded break removes
enforcement at named autonomy levels) fails under its own switch:
`--allow-known-breaks` reports it without failing, because allowing a stale
table and allowing a known enforcement gap are different decisions. A break
the sandbox mitigates never fails, flag or no flag — the gate's probes run
sandboxed, so they already close the gap the record names, and its cell
prints `KNOWN-BREAK (mitigated)`. Any failed usage check — `usage --json`
could not run, exited nonzero, its output did not parse, or the installed
usagemux is below 1.0.0 — fails the gate. The
report header stamps the exact `codemux --version` of the binary under test,
so a saved report names the build that produced it.

Each probe defaults to a 600-second harness timeout. The gate's outer deadline
adds 30 seconds to that timeout. At most four probes run concurrently. Use the
script's `--timeout` (seconds) and `--jobs` (1–4) options to change those
limits, and `--probe` / `--skip-probe` (letters or names) to select probes:

```sh
bun run scripts/live-gate.ts --timeout 240 --jobs 2 --probe A,B
bun run scripts/live-gate.ts --skip-probe F,G
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

Only installed harnesses appear in the table. Restrict them with `--only` or
skip credential-less ones with a comma-separated list:

```sh
LIVE_GATE_SKIP=gemini,qwen,goose make live-gate
bun run scripts/live-gate.ts --skip gemini,qwen,goose --only claude,codex
```

Explicit skips report `SKIP (no credentials; operator requested)` for the probes the harness supports; a probe the adapter declares no capability for prints UNSUPPORTED even when the harness is skipped (capability is judged before the skip list). The gate
exits 1 when no probes run, including when no harnesses are installed or
`--only` selects none of the installed harnesses. It prints
`live-gate: nothing was probed` after the table and totals. If every listed
harness was explicitly skipped, the message is
`live-gate: nothing was probed (all skipped)` and the exit code is still 1.

Refuse the release if any installed, credentialed harness fails any probe it
supports. Every supported probe must pass; `UNSUPPORTED` cells must match the
documented capability matrix, not a regression.

- [ ] Owner ran `make live-gate` on the release machine for the candidate.
- [ ] After reinstalling the Homebrew bottle, run `make live-gate LIVE_GATE_ARGS="--codemux $(brew --prefix)/bin/codemux"` to test the installed binary.
- [ ] Every installed, credentialed harness passed every probe it supports
  with exit 0 and the exact required output.
- [ ] The version-contract column shows no `CONTRACT-STALE` or unmitigated
  `KNOWN-BREAK` entry, or each one is explained and allowed with its own
  flag (`--allow-stale-contracts`, `--allow-known-breaks`); a
  `KNOWN-BREAK (mitigated)` cell needs no allowance.
- [ ] `codemux usage --json` passed (or usagemux's absence is recorded);
  a usagemux below 1.0.0 is a failure, not a skip.
- [ ] Record the result table, the contract column, timeout and job limits,
  and every skip reason.

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

The synthetic keg `make installed-layout` builds links the checkout's
`node_modules` into its libexec: the check verifies the launcher, the
formula's pin transformation, and the keg's own layout, not dependency
packaging. Whether `bun install --production` inside a real keg leaves every
runtime dependency in place is proven by CI's install from the formula, not
by this check.

Run `make installed-layout` (also part of `make release-gate`): it builds a
temporary tree in the formula's shape — `prefix/Cellar/codemux/<version>` with
the whole non-hidden checkout under `libexec`, the keg's
`bin/codemux → ../libexec/bin/codemux`, and `prefix/bin/codemux` chained
through it — then runs `--version`, `list`, and `--help` through the prefix
link and verifies every relative link in the installed docs resolves inside
the keg. On failure it keeps the tree and prints its path.

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
- [ ] `make installed-layout` passed for the candidate commit.
- [ ] Root and command help, static verification, and installed documentation
  are checked from the installed distribution, not only the source checkout.

## Before and after publication

- [ ] Tag the exact reviewed commit only after its branch CI passes.
- [ ] Obtain authorization for tag push, GitHub release, and Homebrew changes.
- [ ] Confirm remote tag, tag-triggered CI, release notes, source archives,
  and any formula/bottle publication after publishing.
