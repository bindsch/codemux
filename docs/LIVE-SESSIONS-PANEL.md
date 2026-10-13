# Live-session panel disposition

> Historical review: approved design dated 2026-10-04; consolidation and probe
> updates preserved in release 0.9.0, commit `299066b` (2026-10-07).
> Disposition: design amended and implementation shipped.
> Current references: [sessions](sessions.md), [protocol](session-protocol.md),
> and [architecture](architecture.md).

## Corrections to the review record

**Claude's claim that no Antigravity adapter existed was false.** It reviewed
a stale checkout. The run adapter, registry entry, compatibility pin, and
tests already existed; [the adapter report](agy-cursor-report.md) records
that work. The remaining implementation work was a session driver.

The consolidation cited a local OpenClaw production client at
`~/Programming/OSS/openclaw/extensions/codex/src/app-server/`.
**Its reviewed revision is unavailable.** No immutable OpenClaw commit was
recorded, so that citation is not a reproducible upstream source pin.
The later [Codex recording](../tests/fixtures/live/codex-app-server.ndjson)
and [fixture provenance](../tests/fixtures/live/README.md) retain direct
evidence from installed Codex 0.159.3.

The implementation did not run every planned probe. **Probe 6, the
scode-wrapped bidirectional session, was not run** because nested sandbox
setup failed. Antigravity's full two-turn exchange was also blocked by
authentication. Fake-peer coverage did not remove those live evidence gaps.

## Review outcomes

| Reviewer | Original verdict | Main concerns |
| --- | --- | --- |
| [Codex](panel/panel-codex.md) | NOT READY | Native permission bypasses, framing, ownership, registry before public resume |
| [Claude](panel/panel-claude.md) | READY WITH CHANGES | Permission carriers, version floors, control requests, queue semantics; incorrect missing-adapter finding |
| [Z.AI](panel/panel-zai.md) | READY WITH CHANGES | Validated spawn seams, per-session state, scode parameters, probe order |

The amended plan separated transport, protocol, ceiling, registry, and
harness drivers. It distinguished unknown archival traffic from fatal
protocol failures, bounded framing and queues, and preserved trusted command
resolution and environment validation.

Usage aggregation retained reported fields except the derived `total_tokens`,
which could become null if a later turn omitted a component. Capability
flags described verified behavior, not inferred similarities between CLIs.
The Claude-family mid-turn recording was initially read as next-turn
queueing; later review corrected it to active-turn consumption.

The [implementation report](live-sessions-report.md) records the delivered
scope and observations. The [0.12 report](align-0.12-report.md) records later
exit-contract changes; old panel recommendations are not current requirements.

The [complete consolidation](https://github.com/bindsch/codemux/blob/194151e32f50fd1a2e510f535668f42135f57826/docs/LIVE-SESSIONS-PANEL.md)
preserves each historical finding and disposition. Local Prompt B material
and ignored scratch probes are unavailable here.
