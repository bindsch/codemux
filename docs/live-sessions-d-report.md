# OpenCode and Aider session report

> Historical report: 2026-10-07/08, release 0.10.0, commit `5cc9166`.
> Disposition: six-harness scope shipped in 0.10.0; later releases added Kimi
> and changed exit handling. This report remains frozen to its original scope.
> Current references: [sessions](sessions.md) and [protocol](session-protocol.md).

## Released scope

Release 0.10.0 supported six session harnesses: Claude, Z.AI, Codex,
Antigravity, OpenCode, and Aider. OpenCode and Aider gained one process per
turn. Provider overrides reached supported session spawns through the same
preparation as one-shot runs.

OpenCode reopened its native session store by `ses_` identity. Aider used a
codemux-owned history file and Aider's own summarization. Neither mechanism
was a separate codemux conversation store. Codex provider homes became keyed
per session; they were not shared per endpoint.

## Live observations

The local gateway was `http://localhost:8011/v1`, model
`clawvm-qwen32b-coder`. Recorded runs used `--no-sandbox --auto high`
with an isolated home because nested scode and the normal registry directory
were inaccessible on the host.

| Run | Result |
| --- | --- |
| OpenCode, three turns | Exit 0; final recall exactly `zephyr-mango-42`; model named `codemux/clawvm-qwen32b-coder` |
| Aider, three turns | Exit 0; same final recall |
| Aider, twelve turns | Exit 0; recall survived ten arithmetic filler turns and the compaction check |

OpenCode used output/context caps 4096/32768. Aider refused those cap variables,
so its successful runs used only the provider base URL, key, and model.
These runs did not verify a sandboxed installed-harness session.

The [fixture provenance](../tests/fixtures/live/README.md) distinguishes
recorded exchanges from executable fake peers.
[OpenCode](../tests/fixtures/live/opencode-session.ndjson) and
[Aider](../tests/fixtures/live/aider-session.ndjson) three-turn recordings
are retained. No `step_finish` arrived in the OpenCode recording, so it does
not prove usage reporting. Later gateway observations are in the
[usage-ledger report](usage-ledger-report.md).

## Validation and unavailable evidence

The initial gate exited 0 with **1492 pass / 6 skip / 0 fail**, 1498 tests,
and installed contracts **3 pass / 0 fail**. This is the initial measurement,
not the final reviewed tree's result.

A later audit measured **1583 pass / 6 skip / 0 fail**, 1589 tests, before
the final five regression changes. The final round's gate paragraph was
left as a placeholder. Its final full-gate result is **unavailable**; it must
not be inferred from a previous round or test-count arithmetic. Original
raw recordings, the twelve-turn capture, and scratch gate logs are ignored
and unavailable in this checkout.

The [complete pre-rebuild report](https://github.com/bindsch/codemux/blob/194151e32f50fd1a2e510f535668f42135f57826/docs/live-sessions-d-report.md)
preserves those gaps and intermediate review records.
[0.12 alignment](align-0.12-report.md) records later seven-harness behavior
and the final raw-exit rule.
