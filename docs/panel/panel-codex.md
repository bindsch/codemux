# Codex session-design review

> Historical review of the design approved 2026-10-04.
> Preserved in codemux commit `299066b` (2026-10-07, release 0.9.0).
> Disposition: amended through the [panel consolidation](../LIVE-SESSIONS-PANEL.md).
> Current contract: [session protocol](../session-protocol.md).

The original verdict was NOT READY. The blocking concerns were native
permission paths bypassing the host ceiling and ambiguity between unknown
event passthrough and fail-closed protocol handling. Other concerns covered
usage snapshots, identity validation, bounded framing, shutdown descendants,
trusted registry ancestry, and exclusive ownership before public resume.

The panel recommended recording installed-harness exchanges before writing
parsers and reusing validated launch seams. Later
[committed fixtures](../../tests/fixtures/live/README.md) retain part of that
evidence. The scode-wrapped session probe and successful Antigravity exchange
were not completed in the initial implementation investigation.

No immutable hash of the exact reviewed checkout was recorded. The
preservation commit above identifies the review document. The consolidation's
local OpenClaw source reference has no recorded upstream revision and cannot
supply an immutable review target.

The [complete original review](https://github.com/bindsch/codemux/blob/194151e32f50fd1a2e510f535668f42135f57826/docs/panel/panel-codex.md)
retains the historical recommendations and line references. Current protocol
and implementation references supersede them.
