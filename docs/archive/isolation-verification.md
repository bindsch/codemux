---
read_when: "Tracing historical isolation or authentication claims to retained evidence."
---
# Isolation verification evidence

This is a historical evidence report dated 2026-10-13, not the current contract.
The current pages are [isolation](../isolation.md), [authentication](../authentication.md),
[harnesses](../harnesses.md), and [provider overrides](../provider-overrides.md).

The documentation reconstruction used codemux 0.13.3 source at `194151e`. That identifies the documentation baseline, **not** the revision exercised by every recorded live test. No new model requests, provider probes, or live login checks were run for this reconstruction.

## Retained records

| Date | Harness/version | Retained evidence | Scope and revision limits |
| --- | --- | --- | --- |
| 2026-09-17 | Claude 2.1.270; Codex 0.154.0 | [Original hermetic document at 194151e](https://github.com/bindsch/codemux/blob/194151e/docs/HERMETIC.md) | Paired instruction canaries and tool capability probes, through scode. Live-tested codemux revision not recorded there. |
| 2026-09-17 | OpenCode 1.18.18; Kimi 0.31.1; Droid 0.221.0; Pi 0.85.1; Goose 1.50.1 | [All-harness report at 194151e](https://github.com/bindsch/codemux/blob/194151e/docs/hermetic-all-harnesses-report.md) | Report retains probe outputs and implementation commit labels. Those labels are not independently established as every probe's tested revision. OpenCode ran through a provider override without scode at high autonomy. |
| 2026-09-17 | Aider 0.86.2; OpenHands 1.16.0; Gemini 0.60.0; Qwen 0.24.0; Cline 3.0.62; Copilot 1.0.85 | [All-harness report at 194151e](https://github.com/bindsch/codemux/blob/194151e/docs/hermetic-all-harnesses-report.md) | Supports refusal analysis and later corrections. Several temporary provider mechanisms used for probing were removed and are unavailable now. |
| 2026-10-04 | Aider 0.86.2; OpenCode 1.18.18 | [Original hermetic document at 194151e](https://github.com/bindsch/codemux/blob/194151e/docs/HERMETIC.md) | Aider's earlier hermetic success withdrawn after config-file injection. OpenCode restricted to reject login-carried remote config and require hermetic for tools-none. |
| 2026-10-10 | Claude 2.1.280; Codex 0.160.1; Cursor 2026.08.11-e8db854 | [Original compatibility ledger at 194151e](https://github.com/bindsch/codemux/blob/194151e/docs/HARNESS-COMPATIBILITY.md) | Installed observations and specific transport/provider checks; code-declared audited ceilings were not raised. Cursor had no authenticated model completion. |
| 2026-10-11 | scode 0.6.0 | [Compatibility ledger's live exemption record](https://github.com/bindsch/codemux/blob/194151e/docs/HARNESS-COMPATIBILITY.md#2026-10-11-addendum-scode-060-live--the-keep-env-exemption-exercised) | Credential exemption exercised through OpenCode/Z.AI. Other nested-sandbox attempts hit a host restriction; not evidence of successful calls. |
| Report dated 2026-10-12; exact timestamp not stated for the marker pair | Claude 2.1.280 | [Experiment report at 194151e](https://github.com/bindsch/codemux/blob/194151e/docs/experiment-mcp-report.md) | Marker probe exit 0; 46 JSONL records; matching result text; paired hermetic/control success. The report names baseline 2492b127 with uncommitted changes; no immutable live-tested revision is supplied. |
| 2026-10-13, 07:41 CEST | Antigravity 1.3.3; scode 0.6.0 | [Final live verification on the Round 11 tree](https://github.com/bindsch/codemux/blob/194151e/docs/experiment-mcp-report.md#final-live-verification-on-the-round-11-tree) | Operator-supplied record below. “Round 11” names a report revision, not an immutable Git commit. No live-tested commit was supplied. |

## Antigravity record and later hardening

The operator reported the Round 11 test gate as **1931 pass, 2 skip, 0 fail**, exit 0. The user Keychain search list held only the login keychain before and after. The plain run answered `OK`, exit 0. The public check reported `HERMETIC agy: OK` and `TOOLS agy: OK`, exit 0. No private home remained.

That record covers the Round 11 authentication precedence, template mirror, and recovery mechanism on agy 1.3.3 with installed scode 0.6.0. It does not live-test the subsequent Round 12 ordering, cancellation, and cleanup hardening or the later merge. Those changes have automated regression evidence in the retained report.

The current code still declares Antigravity minimum and audited ceiling 1.2.14. The 1.3.3 live record is stronger evidence for the specific exercised behavior but does not change that declaration or prove every 1.3.3 feature.

## Missing raw artifacts

The reports mention ignored scratch logs, temporary fixture output, and operator session captures. Those references are provenance notes, not promised checkout files. Raw artifacts not retained in Git are **unavailable in this repository**; do not claim to have inspected them during this reconstruction. Quoted records in retained reports remain secondary evidence where original bytes are unavailable.

The source tests use synthetic streams, mock commands, and retained fixtures. Passing them verifies codemux's current translation and parsing logic against those inputs; it does not certify an untested upstream binary, reproduce credentials, or close an unrecorded live revision.
