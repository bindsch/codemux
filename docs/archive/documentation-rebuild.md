# Documentation rebuild verification

Historical task report dated 2026-10-13. Base: codemux v0.13.3,
commit `194151e32f50fd1a2e510f535668f42135f57826`.
The reconstruction was performed in the `docs-rebuild` worktree without
committing, publishing, bumping the version, or making live model requests.
Current documentation starts at the [index](../index.md).

## Disposition

| Work | Outcome |
|---|---|
| Entry point and navigation | Short README; task-oriented index and separate current references |
| CLI/parser contracts | All command options covered; timeout phases, paid probes, refusals, argv prompt exposure, and exit-code distinctions corrected |
| Isolation/authentication | Scoped guarantee, residual inputs, persistence table, credential mirrors, Agy state sharing and two-root recovery |
| Compatibility | Capabilities bound to adapter declarations; floors, audited ceilings, installed observations, and live evidence separated |
| Sessions | Operational guide, full versioned input/event reference, architecture, and accurate transport/resume limitations |
| Results and ledger | Individual-line/retained-output limits, driver-invocation tokens, lifetime-cost exceptions, selection ordering, and incomplete-history limitations |
| Experiments | Complete spec validation and reproducible example using a committed fixture |
| Historical reports | Dated summaries, immutable original-document links, corrections, and explicit unavailable evidence |
| Release history | User-visible summaries, marked corrections, cutoff-date convention, and untagged initial version |
| Metadata/licenses | Existing MIT license and package version retained; 21 tags match package/changelog versions |
| Gate | Package check delegates to Make; each shell script checked separately; all command help paths covered |
| Distributions | Source and relocated Homebrew link layouts covered by regression tests |

## Bounded fix

The old command `sh -n bin/codemux scripts/aliases.sh` checked the launcher
only; the second filename became a script argument. The Makefile now runs
`sh -n` separately for both files. A regression checks the dry-run commands.
CLI source changes otherwise update help, diagnostics, and explanatory comments.

## Deferred code changes

Exact usage aggregation across partial resumed histories needs invocation
identity and field-scope/baseline information that existing ledger records
lack. The current newest-closing rule can omit previous invocation tokens
without their turns, and selected Claude lifetime cost can predate the cutoff.
The current [usage reference](../results-and-usage.md#ledger-selection-and-totals)
states both limitations. A schema/migration redesign exceeds a few-line fix.

## Verification

The first development full-suite run had 2306 pass, 6 skip, and 16 fail
(2328 tests). Its failures were old session documentation assertions during
the rewrite. Contract-based replacements deliberately reduce those prose pins;
behavioral session/output boundary suites remain.

The targeted documentation/call suite subsequently had 146 pass, 0 fail
(146 tests across six files), exit 0. American-English verification found
zero British spellings. Candidate and pinned-revision links were checked
separately; new main-branch URLs are validated against candidate files because
the requested work is not published.

`make release-gate` exited 0. The unfiltered suite had **2282 pass, 6 skip,
0 fail**, 2288 tests across 87 files. That is 40 fewer tests than the first
development run, from consolidating historical prose assertions and adding
public-contract checks. Whole-source conservative coverage was **87.87% lines**
and **93.08% functions**.

Four process-table/descendant tests skipped because process enumeration was
unavailable on this host. Two opt-in installed-contract tests skipped in the
default suite and then passed in the gate's separate installed-contract run.

Installed contracts had **3 pass, 0 fail** and exercised 14 harness binaries.
Cline was absent. Cursor's model-alias checks were skipped because this host
had no Cursor login. Scode compatibility passed. Dependency audit found no
vulnerabilities in nine packages. Runtime, typecheck, both shell checks,
smoke/help paths, and frozen-lockfile validation passed.

Exact closing summary:

```text
Release gate passed. Review docs/RELEASE-GATE.md before tagging.
```

The released Homebrew v0.13.3 bottle matched its formula checksum:
`ca1c8f261e37e8c2bf2e3979abe4ef854e958a048aea6d2d301d78c8532c6782`.
Its package metadata matched source. The project LICENSE and dependency
licenses for commander, js-yaml, and argparse were present. Its root-level
README/CHANGELOG/LICENSE relocation informed the candidate-layout test.
No replacement bottle was published or claimed to be installed.

## Files changed

```text
CHANGELOG.md
CONTRIBUTING.md
Makefile
README.md
docs/HARNESS-COMPATIBILITY.md
docs/HERMETIC.md
docs/HISTORICAL-DESIGN.md
docs/LIVE-SESSIONS-DESIGN.md
docs/LIVE-SESSIONS-PANEL.md
docs/RELEASE-GATE.md
docs/RELEASING.md
docs/TESTING.md
docs/agy-cursor-report.md
docs/align-0.12-report.md
docs/architecture.md
docs/archive/documentation-rebuild.md
docs/archive/index.md
docs/archive/isolation-verification.md
docs/archive/release-notes.md
docs/authentication.md
docs/autonomy-and-sandboxing.md
docs/cli.md
docs/configuration.md
docs/experiment-mcp-report.md
docs/experiment-mcp.md
docs/harnesses.md
docs/hermetic-all-0.7-merge-report.md
docs/hermetic-all-harnesses-report.md
docs/index.md
docs/installation.md
docs/isolation.md
docs/lab-service-features-report.md
docs/live-sessions-d-report.md
docs/live-sessions-report.md
docs/panel/panel-claude.md
docs/panel/panel-codex.md
docs/panel/panel-zai.md
docs/provider-overrides-2-report.md
docs/provider-overrides.md
docs/results-and-usage.md
docs/session-protocol.md
docs/sessions.md
docs/troubleshooting.md
docs/usage-ledger-report.md
package.json
src/calls-command.ts
src/check-command.ts
src/index.ts
src/session/cli.ts
tests/agy-canary.test.ts
tests/calls-command.test.ts
tests/documentation.test.ts
tests/harness-compatibility.test.ts
tests/session-docs.test.ts
tests/usage-ledger-docs.test.ts
```
