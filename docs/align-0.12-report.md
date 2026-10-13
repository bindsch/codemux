# Alignment release report

> Historical report: 2026-10-10 through 2026-10-13, release 0.12.0,
> commit `719a980`. Disposition: shipped; the final review outcome below
> supersedes earlier rounds. Current references: [sessions](sessions.md),
> [protocol](session-protocol.md), [results and usage](results-and-usage.md),
> and [configuration](configuration.md).

## Released outcome

The release added Kimi sessions, bringing session support to seven harnesses.
It aligned structured plain-output reduction, provider settings, scode
keep-env handling, and session lifecycle behavior. Cursor's standalone entry
order changed to `cursor-agent` before `agent`. Codex provider response
storage had no supported knob and was refused; Claude's model catalog
handling used a verified native settings carrier.

## Final exit contract: review al41

The final review, al41, removed signal attribution. The child outcome is
reported without reclassifying a signal as successful cleanup.
`session_ended` carries raw `harness_exit`, summary `exit_code`, and
independent `shutdown_requested`. A nonzero child code or signal yields
`harness_failed`, even after a requested shutdown. For example, a child
exiting 143 remains failed when `shutdown_requested` is true.

Drivers request graceful completion, close input, wait, and then signal
noncomplying children. Those cleanup actions do not change the exit verdict.
Earlier timestamp, delivery-attribution, and process-group experiments were
superseded. They are not current rules.

Kimi emits a pending resume hint only after successful registry recording
and session announcement. Recording failure discards the hint. Recovered
Codex errors remain visible as diagnostics while a valid recovery can clear
failure status.

## Kimi prompt correction

The earlier claim that Kimi 0.31.1 dispatches `!` as a headless shell command
was false. Inspection and a live `! echo hi` probe showed model text; the
model subsequently chose a tool call. Interactive shell dispatch is separate.

Codemux nevertheless conservatively refused leading `!` and the
word-bounded `/goal` command family. Kimi's headless goal-create parser
does consume some `/goal` forms before a model turn. Paths such as
`/tmp/notes.md please summarize`, other slash commands, and `/goalfoo`
remained valid model text. Both run and session paths used the shared rule.

## Final recorded validation

Four preceding full gates failed: first 17 assertions, then isolated ledger,
late-spawn, and orphan-pipe timing failures. Assertions were updated for the
new exit contract. Positive late-spawn tests gained a five-second completion
allowance; the orphan-pipe test waited for its intended process topology.

The final command was:

```sh
env -u NODE_OPTIONS COPILOT_PKG_CACHE_HOME="$PWD/scratch/copilot-cache-al41" make release-gate
```

It exited 0: **2053 pass / 6 skip / 0 fail**, 2059 tests across 72 files.
The previous verified result had 2054 total tests, so five were added.
Four process-table-dependent tests skipped due to EPERM; two installed
contract cases ran in the separate stage, which passed **3/0**.
The closing line was:
`Release gate passed. Review docs/RELEASE-GATE.md before tagging.`

## Evidence availability

The [complete report at an immutable commit](https://github.com/bindsch/codemux/blob/194151e32f50fd1a2e510f535668f42135f57826/docs/align-0.12-report.md)
preserves all rounds. Ignored raw probes and
`scratch/al41-gate-verified-final.log` are unavailable in this checkout.
Retained [Kimi recording](../tests/fixtures/live/kimi-session.ndjson),
[exit-contract regressions](../tests/session-exit-contract.test.ts), and
[plain-output regressions](../tests/plain-unwrap.test.ts) document the
observations and corrected contracts. No fresh live claim is made here.
