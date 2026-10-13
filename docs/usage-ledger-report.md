# Usage ledger implementation report

> Historical report: 2026-10-08/09, release 0.11.0, commit `8a43e87`.
> Disposition: shipped; later alignment changed Codex plain-output handling.
> Current contract: [results and usage](results-and-usage.md).

## Delivered behavior

The release added append-only call records and `codemux calls`. Completed
runs, checks, session turns, and closing session summaries produced records.
Missing usage stayed null. Logging failure warned without changing the
harness result. The default path was derived from `$HOME` alone, never
`$XDG_STATE_HOME`; a relocated ledger did not tighten its containing directory.

Aggregation folded session summaries per field and used the newest closing
summary after resume, avoiding duplicate Claude-family lifetime cost.
Token counters cover each driver invocation, so this rule can omit earlier
invocation tokens when their turn records are absent. The
`CODEMUX_TEST_LEDGER` preload kept test receipts out of the operator ledger;
`NODE_ENV=test` was not a redirect mechanism.

## Recorded live observations

| Run | Observed receipt |
| --- | --- |
| Z.AI plain reply `OK`, exit 0 | 26,410 input, 3 output, cost 0.1057; served model `claude-opus-5-5` |
| Z.AI two-turn plant/recall | Two turn records and one closing record; closing usage 40,020 input, 768 cached, 24 output, cost 0.1607136 |
| OpenCode provider override | `localhost:8011`; 24,709 input, 2 output, 0 cached, cost 0 |
| Inaccessible default ledger | One append warning; successful reply and exit code unchanged |

Those runs used `--no-sandbox --auto high` because nested scode failed.
The sandboxed attempt recorded exit 71 with null usage. A relocated writable
ledger and session home avoided the host's denied state directory. Raw
receipts and probe scripts were ignored scratch files and are unavailable.

At this release, Codex plain runs retained human output and only its blended
stderr token figure. That statement was superseded by the
[0.12 alignment](align-0.12-report.md), which changed structured reduction.
It is not the current Codex usage contract.

## Final recorded gate

`make release-gate` exited 0 under the documented neutral-home/cache setup.
The suite had **1722 pass / 6 skip / 0 fail**, 1728 tests across 67 files.
The remeasured 0.10 baseline had 1594 tests: the change added 134 net tests.
Installed contracts passed **3/0**; conservative line coverage was 85.99%.

The [complete report](https://github.com/bindsch/codemux/blob/194151e32f50fd1a2e510f535668f42135f57826/docs/usage-ledger-report.md)
preserves review history, measurements, and environment qualifications.
Retained tests include [call logging](../tests/call-log.test.ts),
[aggregation](../tests/calls-command.test.ts), and
[end-to-end ledger behavior](../tests/call-ledger-e2e.test.ts).
