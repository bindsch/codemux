---
read_when: "Finding dated implementation reports and their evidence limits."
---
# Historical reports

These documents preserve dated observations and decisions. They are not
current command or capability references. Start with the
[documentation index](../index.md) for current behavior.

Each report identifies its release or a commit that preserves the document,
separates observations from later corrections, and names unavailable evidence.
A preservation commit is not necessarily the exact reviewed checkout.
Full pre-rebuild reports remain linked at immutable codemux commit
`194151e32f50fd1a2e510f535668f42135f57826` (0.13.3, 2026-10-13).
Ignored scratch logs and unrecorded external revisions are not recoverable
from those links.

| Date / release | Record | Disposition |
| --- | --- | --- |
| 2026-09-17 through 2026-10-13 | [Isolation verification](isolation-verification.md) | Dated per-harness evidence; live revisions and raw captures may be unavailable |
| 2026-10-13 | [Release-note consolidation](release-notes.md) | Original released notes retained through immutable links; corrections marked in current changelog |
| 2026-10-13 | [Documentation rebuild verification](documentation-rebuild.md) | Audit dispositions, verification, changed files, and deferred usage-accounting work |
| 2026-10-04 through 2026-10-13 | [Session design](../LIVE-SESSIONS-DESIGN.md) | Historical proposal; current session guide and protocol supersede it |
| Preserved 2026-08-02 | [Original design](../HISTORICAL-DESIGN.md) | Proposal; illustrative commands and plugins are not contracts |
| 2026-09-17 | [All-harness isolation attempts](../hermetic-all-harnesses-report.md) | Several initial claims withdrawn in 0.7 |
| 2026-10-04 / 0.6.0 | [Lab-service results and stdin](../lab-service-features-report.md) | Shipped; proposed `run --session` withdrawn |
| 2026-10-04 / 0.6.1 | [Antigravity and Cursor](../agy-cursor-report.md) | Adapter shipped; Antigravity model probes blocked by login |
| 2026-10-04 / 0.7.0 | [Hermetic merge](../hermetic-all-0.7-merge-report.md) | Shipped with explicit capability and override withdrawals |
| 2026-10-04 design | [Session panel consolidation](../LIVE-SESSIONS-PANEL.md) | Design amended; missing-adapter claim corrected |
| 2026-10-04 design | [Claude panel](../panel/panel-claude.md), [Codex panel](../panel/panel-codex.md), [Z.AI panel](../panel/panel-zai.md) | Historical findings, reviewed checkout not pinned |
| 2026-10-07 / 0.8.0 | [Provider overrides](../provider-overrides-2-report.md) | Shipped with endpoint limits and cap refusals |
| 2026-10-07 / 0.9.0 | [Initial sessions](../live-sessions-report.md) | Shipped; scode probe 6 not run, Antigravity exchange blocked |
| 2026-10-08 / 0.10.0 | [OpenCode and Aider sessions](../live-sessions-d-report.md) | Original six-harness scope; final round gate unavailable |
| 2026-10-08/09 / 0.11.0 | [Usage ledger](../usage-ledger-report.md) | Shipped; later Codex reduction supersedes old plain-output rule |
| 2026-10-13 / 0.12.0 | [Alignment](../align-0.12-report.md) | Final al41 raw-exit rule supersedes earlier signal attribution |
| 2026-10-13 / 0.13.0–0.13.3 | [Experiment MCP and Antigravity isolation](../experiment-mcp-report.md) | Shipped; dated live evidence separate from later regression gates |

For fixture provenance, see [live recordings](../../tests/fixtures/live/README.md).
Executable fake peers and synthetic schema cases are labeled separately
from recorded installed-harness exchanges.
