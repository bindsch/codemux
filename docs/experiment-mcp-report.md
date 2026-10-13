# Experiment MCP and Antigravity isolation report

> Historical report: 2026-10-12/13, releases 0.13.0 through 0.13.3.
> Release commits: `a5af184`, `a88329d`, `6ae1da4`, and `194151e`.
> Disposition: shipped with the corrections below.
> Current instructions: [experiment MCP](experiment-mcp.md) and
> [isolation](HERMETIC.md).

## Outcome

Claude's experiment mechanism was VERIFIED on Claude Code 2.1.280 by an
operator-run marker probe and an extended hermetic canary. The probe recorded
matching server and model-bound results; the canary had a leaking control.

Codex refused `--experiment-mcp` because its `Wall time:` header changed
tool output. No stripping or replacement authentication was added.

Antigravity's hermetic and tools-none mechanisms were VERIFIED on the
operator's Round 11 tree with scode 0.6.0 and agy 1.3.3. Later corrections
had synthetic regression and gate coverage. They were not included in that
live run. Earlier candidate verdicts are superseded.

## Mechanism and evidence boundary

Claude registered a single SDK MCP server while safe mode suppressed
operator configuration. A bridge relayed bounded JSON-RPC traffic and
correlated native tool calls with server and model-bound results. Recordings
captured raw control/server traffic and comparisons. They did not capture
the final provider HTTP request.

The harness ran under read-only scode with no built-in tools. The experiment
server ran outside that sandbox; the experiment owner was responsible for
its containment. Arbitrary server capabilities were not made safe by changing
its working directory.

Antigravity used a private home, isolated configuration, native tool policy,
and a per-run Keychain mirror. The operator login keychain was not copied
wholesale. Authentication precedence, template handling, recovery ownership,
and cleanup changed over the review; only the final released rules belong in
operator instructions.

The old `scratch/experiment-mcp.json` example and raw recordings are
**unavailable**: they were ignored local files. The displayed old home-path
example was illustrative, not executable after tilde substitution.
Use the current [specification and example](experiment-mcp.md).
The committed [MCP peer fixture](../tests/fixtures/experiment-mcp.ts) is an
executable test fixture, not the ignored operator spec or a live recording.

## Final live verification on the Round 11 tree

Run by the operator on 2026-10-13 at 07:41 CEST with installed
scode 0.6.0 and agy 1.3.3. The operator verified the Round 11 gate:
**1931 pass, 2 skip, 0 fail**, exit 0. The user search list held
only the login keychain before and after. The plain run answered
`OK` (exit 0). The public check reported `HERMETIC agy: OK` and
`TOOLS agy: OK` (exit 0). No private home remained.

This attests the Round 11 tree only. Subsequent fixes did not receive a new
live Antigravity request in this report.

## Final 0.13.2 corrections

Release 0.13.2 (`6ae1da4`, 2026-10-13) corrected:

- Valid Claude SDK/control notifications, including compaction and heartbeat
  traffic, remained in recordings instead of aborting. Missing or unknown
  frame types still failed. The compaction fixture was synthetic and based
  on a documented shape; it was not a captured live sample.
- Codex stopped consulting its Plan fallback after a protocol failure.
  A later nonzero process exit alone could still retain a completed reply.
- Antigravity API-key runs excluded the unused file token from shared
  configuration. Recovery inspected both login and injected home roots.
- Recovery validated probe roots and exact mirror ownership, preserving
  unrelated Keychain entries even when those unrelated entries were
  inaccessible.
- Asynchronous signal cleanup was bounded by the existing two-second grace,
  with an explicit incomplete-cleanup diagnostic.
- Empty or relative homes were refused before adapter preparation.

Final `make release-gate`: exit 0, **2320 pass / 6 skip / 0 fail**,
2326 tests across 85 files. The 0.13.1 baseline had 2317 tests: nine were
added. Four process-table tests skipped due to host restrictions; two
installed-contract cases were covered by the separate stage, **3/0**.
Conservative coverage was 87.82% lines / 93.00% functions.
The log `scratch/0132-release-gate.log` is unavailable.

## 0.13.3 follow-up

Release 0.13.3 (`194151e`, 2026-10-13) distinguished inaccessible owned
mirrors from unrelated inaccessible entries. Errors for an owned mirror
propagated through recovery, verification, and repeated cleanup.
Canonicalizing the configuration parent also allowed a symlinked Gemini
configuration directory while still refusing a symlinked or foreign-owned
probe root.

Both new regressions failed before the fixes (**0 pass / 2 fail**).
The focused suite then passed **100/0**. Final `make release-gate` exited 0:
**2322 pass / 6 skip / 0 fail**, 2328 tests across 86 files, two more than
0.13.2. Installed contracts passed **3/0**. Conservative coverage was
87.87% lines / 93.08% functions. The four process-table skips remained.
The log `scratch/0133-release-gate.log` is unavailable.

## Preserved evidence

The [full pre-rebuild report](https://github.com/bindsch/codemux/blob/194151e32f50fd1a2e510f535668f42135f57826/docs/experiment-mcp-report.md)
retains earlier investigations and quoted operator outcomes.
[0.13.2 regressions](../tests/release-0132.test.ts),
[0.13.3 regressions](../tests/release-0133.test.ts), and
[experiment protocol tests](../tests/experiment-protocol.test.ts) are
retained. Historical suite counts and live attestations are separate evidence.
