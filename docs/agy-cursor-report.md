# Antigravity and Cursor adapter report

> Historical report: 2026-10-04, release 0.6.1, commit `d9427ac`.
> Disposition: shipped; later entry ordering and Antigravity isolation changed.
> Current references: [compatibility](HARNESS-COMPATIBILITY.md),
> [isolation](HERMETIC.md), and [CLI](cli.md).

## Observations

Antigravity's run adapter was added at the audited 1.2.14 floor. The installed
binary self-updated to 1.2.16 during the investigation. Help and flag parsing
were observed, but authentication blocked model requests. No successful
Antigravity model run or live result envelope was captured in this audit.
The result-envelope parser was pinned to documented examples and embedded
JSON field names instead.

The binary accepted equals-form values such as `--effort=high`; the space
form failed. An invalid mode warned and continued. The mode flag therefore
did not establish an isolation boundary. Hermetic and tools-none claims were
refused at this release. Later verified support is recorded in the
[experiment report](experiment-mcp-report.md).

Cursor 3.23.12 / agent build 2026.08.11-e8db854 was checked for entry points.
Release 0.6.1 preferred standalone `agent`, then `cursor-agent`.
The desktop `cursor agent` entry required explicit authorization because it
could install or update the agent. Release 0.12 changed the standalone order;
the old order here is evidence about 0.6.1 only.

## Final corrections and validation

Static verification used an empty environment view, so an exported desktop
entry selector could not change its wiring verdict. Antigravity token totals
became a sum of reported components; missing components produced null.
Regression tests reproduced both defects before their fixes.

The final recorded `make check` run had **674 pass / 6 skip / 0 fail**,
680 tests, up from 678 tests in the preceding round. `make release-gate`
failed at installed contracts because Copilot could not create its cache:
`EPERM: mkdir ~/Library/Caches/copilot/pkg/darwin-arm64`. Contracts had
1 pass / 1 fail. Other gate stages were run separately and passed. This was
not a successful full release gate.

## Evidence availability

Raw help and authentication captures were kept in ignored `scratch/`;
they are unavailable in this checkout. The
[full report at the pre-rebuild commit](https://github.com/bindsch/codemux/blob/194151e32f50fd1a2e510f535668f42135f57826/docs/agy-cursor-report.md)
preserves quoted captures and review details. Retained regression coverage
includes [adapter tests](../tests/new-adapters.test.ts),
[result envelopes](../tests/result-envelope.test.ts), and
[static verification](../tests/verify.test.ts). Tests are not a substitute
for the authenticated live run that did not occur.
