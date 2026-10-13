# Lab-service feature report

> Historical report: investigation through 2026-10-04, release 0.6.0,
> commit `e80bfe8`. Disposition: result envelopes and stdin prompts shipped;
> the proposed one-shot session interface was withdrawn.
> Current references: [results](results-and-usage.md), [CLI](cli.md), and
> [sessions](sessions.md).

## Shipped work

`run --result-json` added normalized usage and session identity to supported
harness result envelopes. Codex's JSONL stream supplied the final answer,
thread identity, and token components. Claude and Z.AI retained their native
envelope with a codemux-owned block. Missing usage fields stayed null.
`run -f -` added prompt input from stdin.

A Codex 0.159.3 live run on 2026-10-03 returned `OK` with 10,997 uncached
input tokens, 13,184 cached input tokens, and 5 output tokens: total 24,186.
A Claude run returned a native envelope with the added block and reported
cost 0.0301436. These are dated observations, not current usage guarantees.

## Withdrawn proposal: run --session

**The proposed `run --session none|new|resume:<id>` interface did not ship.**
The early report described a prospective feature and prospective commit.
Review removed that interface and its incomplete persistence/resume guards.
A session ID in a result envelope did not make that abandoned CLI available.

Persistent multi-turn work subsequently shipped as the separate
`codemux session` command in 0.9.0. Its protocol, registry, resume constraints,
and lifecycle are documented in the current session reference.

## Final recorded checks

The final coverage suite had **635 pass / 6 skip / 0 fail**, 641 tests
across 29 files, up from 634 tests in the preceding recorded round.
Type checking exited 0. Conservative coverage was 82.76% lines and
89.44% functions.

`make release-gate` exited 2 at installed contracts: Copilot could not write
`~/Library/Caches/copilot/pkg/darwin-arm64` (EPERM). A separate contract
rerun under a writable home passed 2/0. Remaining gate stages were run
individually and exited 0. This does not establish a successful full gate
under the original environment.

## Evidence availability

The [full pre-rebuild report](https://github.com/bindsch/codemux/blob/194151e32f50fd1a2e510f535668f42135f57826/docs/lab-service-features-report.md)
preserves review history and the withdrawn proposal. Ignored scratch files
are unavailable. Retained evidence includes
[result-envelope tests](../tests/result-envelope.test.ts) and
[CLI result tests](../tests/cli-result-json.test.ts).
