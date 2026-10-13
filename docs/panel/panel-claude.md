# Claude session-design review

> Historical review of the design approved 2026-10-04.
> Preserved in codemux commit `299066b` (2026-10-07, release 0.9.0).
> Disposition: amended through the [panel consolidation](../LIVE-SESSIONS-PANEL.md).
> Current contract: [session protocol](../session-protocol.md).

**Correction: the review's claim that no Antigravity adapter existed was
false.** The reviewer used a stale checkout. The adapter and its compatibility
entry were already present; see the [adapter report](../agy-cursor-report.md).
Do not use that finding as evidence about the released tree.

The original verdict was READY WITH CHANGES. Substantive concerns included
the assumed knowledge of scode writable roots, native pre-approval bypasses,
session-specific version floors, unknown control requests, cumulative usage,
bounded input/output, concurrent resume ownership, and implementing registry
guards before exposing resume.

The reviewer could not read the external Prompt B brief. The original review
did not record an immutable hash of its actual checkout. The preservation
commit above identifies this document, not the exact reviewed source tree.
OpenClaw evidence later cited by the consolidation also has no recorded
upstream revision. Retained direct evidence is indexed in the
[fixture README](../../tests/fixtures/live/README.md).

The [complete original review](https://github.com/bindsch/codemux/blob/194151e32f50fd1a2e510f535668f42135f57826/docs/panel/panel-claude.md)
is preserved for traceability. Its line numbers and recommendations describe
that historical design, not current implementation requirements.
