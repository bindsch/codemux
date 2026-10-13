# Hermetic support merge report

> Historical report: 2026-10-04, release 0.7.0, commit `cfaecec`.
> Disposition: shipped with withdrawals listed below.
> Current references: [isolation](HERMETIC.md), [configuration](configuration.md),
> and [compatibility](HARNESS-COMPATIBILITY.md).

## Shipped outcome

The September branch was reconciled with launcher-owned `RunContext`.
Temporary homes, provider files, and reply-history artifacts became per-run
resources with cleanup on the launcher's exit path. Adapter instances did
not retain mutable launch state.

The final release retained provider overrides for **Aider, OpenCode, Droid,
Kimi, Pi, and Goose**. The branch originally carried more overrides.
Copilot, Gemini, Cline, OpenHands, and Qwen override or no-tools machinery was
removed during review. That original branch inventory did not ship intact.
OpenHands overrides returned in [0.8.0](provider-overrides-2-report.md).

## Capability corrections

- Aider's initial hermetic pass was withdrawn after a live leak through
  `.aider.conf.yml`. Its own configuration layers were not closed.
- OpenCode's tools-none support was restricted to hermetic runs. Hermetic
  launches refused logins carrying remote configuration.
- Both halves of a hermetic check now keep the same tool selection.
  OpenCode's combined `check --hermetic --tools none` was refused before
  spending quota because the plain tools-none control was itself refused.
- Claude, Z.AI, and Codex retained their earlier hermetic claims. OpenCode
  retained its conditional claim. Droid, Kimi, Pi, and Goose retained
  tools-none claims. The other investigated rows were refusals.

These were 0.7 decisions. The current support matrix has later changes.

## Live observations and verification

The closing OpenCode hermetic check, without a tools override, returned
`HERMETIC opencode: OK` and a leaking control, exit 0. The combined
tools-none check refused before a request. Z.AI's check with tools none
returned `HERMETIC zai: OK` with a leaking same-tools control, exit 0.
Provider requests used Z.AI's coding endpoint and `glm-5.3`.

Final `make release-gate`: exit 0. The suite had **809 pass / 6 skip /
0 fail**, 815 tests across 36 files, compared with the preceding 814 tests.
Installed contracts had **3 pass / 0 fail**. Conservative coverage was
84.13% lines and 92.01% functions. Copilot's cache was redirected to a
writable scratch path because the normal cache was denied on that host.

## Evidence availability

The [full merge report](https://github.com/bindsch/codemux/blob/194151e32f50fd1a2e510f535668f42135f57826/docs/hermetic-all-0.7-merge-report.md)
preserves quoted live output and all review rounds. Ignored scratch captures
are unavailable here. Retained [hermetic tests](../tests/hermetic.test.ts)
and [provider mapping tests](../tests/provider-override-mappings.test.ts)
cover mechanisms and refusals; they do not renew the dated live claims.
