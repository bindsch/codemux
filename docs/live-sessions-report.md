# Initial live-session implementation report

> Historical report: probes 2026-10-04/05; release 0.9.0, commit `299066b`
> on 2026-10-07. Disposition: shipped, then extended and corrected.
> Current contract: [sessions](sessions.md).
> Later work: [0.10 sessions](live-sessions-d-report.md) and
> [0.12 alignment](align-0.12-report.md).

## Delivered scope

The first release added the JSONL session protocol, bounded process and
protocol handling, permission decisions, registry ownership and resume guards,
and drivers for Claude, Z.AI, Codex, and Antigravity. Harness wire facts were
recorded separately from fake-harness regression coverage.

## Dated observations and limits

| Probe | Observation |
| --- | --- |
| Claude-family output | Stream JSON required `--verbose`; init arrived once per turn |
| Permission channel | `--permission-prompt-tool stdio` carried the recorded request/response; the earlier proposed host carrier did not |
| Mid-turn input | The recorded Z.AI input was folded into the active turn; the initial next-turn interpretation was wrong |
| Interrupt | Control request/response preceded an interrupted result and exit 1 |
| Resume | Claude-family init reported the same session ID |
| Codex app-server | Two turns; responses omitted `jsonrpc`; identity appeared in the thread object |
| Codex usage | `thread/tokenUsage/updated.last` was per-turn and `total` cumulative; `turn/completed` carried no usage |
| Antigravity | Authentication failure only; no successful two-turn exchange |
| **Probe 6: scode-wrapped session** | **Not run.** Nested sandbox setup failed with `sandbox-exec: sandbox_apply: Operation not permitted` |

The scode limitation was not resolved by fake end-to-end tests. Those tests
cover framing and lifecycle using controlled peers, not a successful installed
scode session. The audit recorded nine Claude-family exchanges through the
Z.AI endpoint and two Codex turns. The Antigravity attempt failed before a
model call.

## Corrections retained

The mid-turn fixture does not prove reliable next-turn queueing or injection.
The later implementation reports `user_during_turn: false` for that
Claude-family path. Unknown noncritical traffic and fatal protocol errors
have distinct handling. Permission answers cannot widen the host ceiling,
and the sandbox remains the filesystem/process boundary.

Later alignment review replaced earlier shutdown-signal attribution rules
with a raw child-exit contract. This report's old review rounds do not
override that current contract.

## Evidence availability

[Committed recordings and their provenance](../tests/fixtures/live/README.md)
retain the sanitized Claude-family, Codex, and Antigravity auth-failure frames.
The `.ts` fixtures in that directory are executable fakes, not recordings.
Original probe scripts and raw recordings under ignored `scratch/probes/`
are unavailable in this checkout.

The [complete historical report](https://github.com/bindsch/codemux/blob/194151e32f50fd1a2e510f535668f42135f57826/docs/live-sessions-report.md)
preserves implementation rounds and gate logs. Its per-round counts describe
different intermediate trees; no single count is promoted here as a fresh
validation of current code.
