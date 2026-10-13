# Z.AI session-design review

> Historical review of the design approved 2026-10-04.
> Preserved in codemux commit `299066b` (2026-10-07, release 0.9.0).
> Disposition: amended through the [panel consolidation](../LIVE-SESSIONS-PANEL.md).
> Current contract: [session protocol](../session-protocol.md).

The original verdict was READY WITH CHANGES. Main concerns were contradictory
Codex sandbox parameters, missing validated spawn seams, per-session state
ownership, unknown output handling, pending permissions at shutdown,
concurrent resume, raw-event fidelity, and bounded framing.

The reviewer recommended running the scode transport probe before building
on it and moving registry guards before public resume. That transport probe
was later blocked by nested sandbox restrictions. The implementation's
fake-peer tests did not prove it had run successfully.

The reviewer could not read the external Prompt B brief. No immutable hash
of the exact reviewed checkout was recorded. The preservation commit above
identifies the document, not an invented source target. The consolidation's
local OpenClaw citation likewise has no available revision.
[Committed fixture provenance](../../tests/fixtures/live/README.md) records
the direct installed-harness evidence retained in this repository.

The [complete original review](https://github.com/bindsch/codemux/blob/194151e32f50fd1a2e510f535668f42135f57826/docs/panel/panel-zai.md)
preserves the full finding list and historical line references.
