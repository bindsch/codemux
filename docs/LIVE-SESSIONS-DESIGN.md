# Live sessions: historical design summary

Historical scope: design and implementation work begun on 2026-10-04,
amended on 2026-10-05, with later corrections through the 0.9–0.13 series.
Summary prepared 2026-10-13 for the shipped v0.13.3 documentation.

This page preserves the design's purpose and evidence limits. It is not the
current contract. Use [sessions](sessions.md), [the protocol specification](session-protocol.md),
and [architecture](architecture.md) for current behavior.

## Purpose and decisions

The original proposal added persistent, bidirectional sessions for a broker
that needed attributed user input, streamed results, permission decisions,
interrupts, and resume. One-shot `run` remained a separate interface.
Early implementations supported Claude, ZAI, Codex, and Agy. OpenCode,
Aider, and Kimi were added later; the shipped interface supports all seven.

The design established a common JSONL envelope with original harness
lines preserved, explicit capability reporting, bounded process streams,
and launcher-owned driver state. It added a registry for session identity,
live ownership, and resume policy. The registry checks accidental changes
in agent, account, provider, working directory, containment, and autonomy;
it does not protect against other processes running as the same user.

Several early assumptions were corrected during implementation:

- Claude-family mid-turn input has no reliable one-message/one-result
  attribution. Current drivers reject it as busy instead of queueing it.
- Sessions use supported per-harness permission carriers. A request's
  caller decision cannot exceed the launch ceiling.
- OpenCode, Aider, and Kimi retain session state across separate turn
  processes. They do not expose the Codex control channel.
- Provider overrides now reach supported session drivers. Earlier blanket
  refusal text is obsolete.
- Usage tokens aggregate a driver instance. Claude-family cost adopts a
  reported lifetime value; it is not summed as per-turn cost.
- A requested shutdown does not excuse a failed child. The current final
  event records both the shutdown request and the raw child outcome.
- Hermetic sessions and tool-selection flags remain refused.

Old source comments that cite “design §4.x” refer to the former document's
numbering. Their current subjects are covered in the protocol and guide
linked above; those section numbers are not a separate specification.

## Evidence and limits

The original implementation report records probes on 2026-10-04/05 and
follow-up corrections. Sanitized fixtures remain in
[tests/fixtures/live](../tests/fixtures/live/README.md). Fake-harness tests
exercise the driver contract without spending provider quota.

The scode-wrapped bidirectional end-to-end probe, numbered **probe 6** in
that report, was **not run**: nesting scode in the implementing sandbox
failed with `sandbox-exec: sandbox_apply: Operation not permitted`.
Fake-harness framing tests are not a substitute for that live observation.
The initial Agy two-turn probe was also not run because login had expired;
an authentication-failure frame was retained.

References to raw drivers and transcripts in ignored `scratch/probes/`
describe the original workspace. Those scratch files are unavailable in
this checkout. Retained fixtures are inspectable evidence; unavailable
scratch is not a reproducible artifact. This documentation rewrite makes
no claim of fresh live-provider or bidirectional scode verification.

Historical records:

- [Initial implementation report](live-sessions-report.md).
- [Later implementation report](live-sessions-d-report.md).
- [Design review summary](LIVE-SESSIONS-PANEL.md).
- [Harness compatibility](HARNESS-COMPATIBILITY.md).

The reports describe observations at their stated dates. Current behavior
comes from the shipped code and the current reference pages.
