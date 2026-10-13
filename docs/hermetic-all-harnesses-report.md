# All-harness isolation investigation

> Historical investigation: 2026-09-17, based on 0.5.2; report commit `6dd0c84`.
> Disposition: several initial claims and provider overrides were withdrawn
> before 0.7.0. Current policy: [isolation](HERMETIC.md) and
> [compatibility](HARNESS-COMPATIBILITY.md).

## Scope and evidence

This was a set of attempts, source inspections, help probes, and model
requests. It was not a successful authenticated run for every harness.
Cursor had no login and no successful model exchange. Failures and refused
capabilities are evidence of those outcomes, not successful verification.

Model requests that ran used Z.AI's OpenAI-compatible endpoint and
`glm-5.3`, through the worktree's codemux launcher. The endpoint and
credentials were test conditions, not a guarantee of arbitrary provider
compatibility. Ignored raw scratch captures are unavailable in this checkout.

## Original findings and final 0.7 disposition

| Harness and investigated version | Initial observation | Final 0.7 disposition |
| --- | --- | --- |
| Aider 0.86.2 | Initial canary appeared clean | Hermetic claim withdrawn: its own configuration leaked; tools none refused |
| OpenCode 1.18.18 | Isolation and tool-removal probes passed | Hermetic support conditional on no remote-config login; tools none only for hermetic runs |
| Kimi 0.31.1 | Tools-none capability probes passed | Tools none supported; hermetic refused |
| Droid 0.221.0 | Tools-none capability probes passed | Tools none supported; hermetic refused |
| Pi 0.85.1 | Tools-none capability probes passed | Tools none supported; hermetic refused |
| Goose 1.50.1 | Tools-none capability probes passed | Tools none supported; hermetic refused |
| Gemini 0.60.0 | Proposed settings mapping was not claimable | Both refused; mapping removed |
| OpenHands 1.16.0 | Isolation leak observed | Both refused; original override removed |
| Qwen 0.24.0 | Plain behavior could not supply the required leaking control | Both refused; original override removed |
| Cline 3.0.62 | Isolation leaks observed | Both refused; original override removed |
| Copilot 1.0.85 | Control did not leak; empty tool allowlist did not disarm tools | Both refused; original override removed |
| Cursor 2026.08.11 | No mechanism and no login on the host | Both refused; no successful authenticated probe |

The final column is the outcome of the
[0.7 merge review](hermetic-all-0.7-merge-report.md), not the original probe
verdict. OpenHands overrides returned separately in 0.8.0.
Antigravity support changed separately in 0.13.0. Consult current references
before applying any historical support row.

The two-probe isolation method required a clean hermetic answer and a leaking
plain control. The merge review tightened it so both probes use the same
tool selection. This withdrew OpenCode's combined
`check --hermetic --tools none`: its plain tools-none control is refused.

## Preserved evidence

The [complete original report and quoted outputs](https://github.com/bindsch/codemux/blob/194151e32f50fd1a2e510f535668f42135f57826/docs/hermetic-all-harnesses-report.md)
remain available at an immutable codemux commit. Its superseded positive
claims require the corrections above. Raw ignored files were never committed.
The final merge's test and gate counts belong to the merge report; they must
not be presented as evidence that all initial model attempts succeeded.
