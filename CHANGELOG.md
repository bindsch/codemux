# Changelog

User-visible changes by release. Dates below are the original development
cutoff dates, not GitHub publication dates. For example, 0.12.0 was published
October 13 after its October 12 cutoff; 0.11.0, 0.7.1, 0.6.0, and 0.5.0 were
published one day after their listed dates, and 0.3.0 on August 12.
Version 0.1.0 is an untagged initial version.

Released sections are consolidated without changing their release scope.
**Correction** labels identify inaccurate earlier wording. The dated
[release-note archive](https://github.com/bindsch/codemux/blob/main/docs/archive/release-notes.md) links the complete
immutable notes and engineering evidence.

## [Unreleased]

## [0.13.5] - 2026-10-15

### Fixed

- The claude provider override accepts a base URL ending in `/v1`: Claude
  Code appends `/v1/messages` itself, so that form produced
  `/v1/v1/messages`, a 404 the binary reported as `model_not_found` before
  any operator-visible request. One trailing `/v1` is now stripped; host
  roots and gateway paths are kept as given (`docs/provider-overrides.md`).
- Documented the output-token cap a small-context endpoint needs under the
  claude override (`CODEMUX_CLAUDE_PROVIDER_MAX_OUTPUT_TOKENS`), with the
  vLLM error that signals it.
- Documented that Claude Code 2.1.280's full-tools prompt is at least
  31,745 input tokens, so a 32k endpoint needs `--hermetic --tools none`
  or a larger window; the symptom is a timeout, because Claude Code retries
  the endpoint's 500 until the run's deadline.

## [0.13.4] - 2026-10-13

### Documentation and verification

- Replace the versioned README banner and long duplicated reference sections
  with installation, first-run/session examples, essential limits, and command
  navigation. Use repository links that work from Homebrew's README location.
- Add one current documentation index and references for CLI options,
  configuration, harness capabilities/version evidence, autonomy, isolation,
  authentication, provider routing, results/usage, sessions/protocol, experiment
  MCP, troubleshooting, and architecture.
- Correct hermetic, tools-none, persistence, Agy prompt/configuration/recovery,
  session transport/resume, timeout, usage-scope, output-limit, and ledger
  selection claims. Describe incomplete historical evidence explicitly.
- Freeze designs, panels, and task reports as dated historical summaries with
  immutable source links and current-reference dispositions. Consolidate release
  histories, mark false-statement corrections, and define the date convention.
- Correct run/check/session/calls help to describe actual timeout phases,
  normalization, paid probes, capabilities, parser behavior, and mixed output.
- Make `bun run check` invoke `make check`, including shell syntax validation.
  Fix the shell target to check both scripts separately; the old second path
  was only an argument to the first script. Make `bun run smoke` delegate to
  `make smoke` and cover every command help path.
- Unify testing/releasing instructions around `make release-gate`; require
  curated release notes and source/Homebrew version, checksum, license, and
  documentation-layout checks.
- Replace historical prose pins with public-contract documentation checks and
  retain behavioral output-boundary coverage. Check current examples, command
  coverage, source/distribution links, metadata, and spelling.

## [0.13.3] - 2026-10-13

### Fixed

- Report canonicalization errors for owned Antigravity Keychain mirrors and templates during recovery and cleanup. Preserve inaccessible unrelated search-list entries.
- Support symlinked Gemini configuration directories in ordinary and sandboxed Antigravity runs, including before any probe root exists. Continue rejecting symlinked or foreign-owned probe roots.

## [0.13.2] - 2026-10-13

### Fixed

- Accept and record documented Claude control-protocol notifications, including compaction boundaries and tool-progress heartbeats, while rejecting unknown frame types.
- Suppress the Codex Plan fallback after a protocol failure, including a top-level error after turn completion.
- Share Antigravity configuration entries individually so API-key runs never link the unused OAuth token into their private homes.
- Recover stale private homes and Keychain mirrors from both validated, user-owned login and injected HOME probe roots.
- Reject symlinked probe roots before Keychain recovery and restrict mirror ownership to the exact private run-directory layout.
- Preserve inaccessible unrelated Keychain search-list entries without blocking recovery.
- Bound asynchronous adapter cleanup on signals by the existing grace period and report incomplete cleanup before exiting.
- Reject relative and empty injected HOME values in the shared adapter constructor, before credential preparation.

## [0.13.1] - 2026-10-13

### Fixed

- Skip all file-token inspection and copying when an Antigravity API key survives sandbox environment filtering.
- Preserve completed child results, including exit codes and captured output, when protocol or adapter cleanup fails. Append the cleanup diagnostic to stderr.
- Validate absolute, user-owned HOME directories before stale-home sweeping. Sweep only marked, user-owned entries under the real user's probe root.
- Restrict Keychain recovery to the canonical template path and real user's probe root. Preserve and report unrelated lookalikes.
- Stop parsing a Claude control chunk synchronously after a rejected request, before a later tool call can reach the experiment server.
- Require boolean experiment error flags when present on both server and model results.
- Reject unknown, missing, and non-string experiment frame types.
- Use synchronous exit cleanup for private homes, Keychain restoration, and experiment recording finalization. Await asynchronous cleanup before known exits.
- Cancel Aider and OpenCode shutdown waits on fatal errors while retaining the raw child exit contract.
- Treat a Kimi spawn rejection with a null value as a fatal spawn failure.
- Prepare Claude's credential mirror under the same HOME supplied to the child.
- Retain a completed Codex Plan reply when the child subsequently exits nonzero.
- Bound cumulative human-mode Codex output before appending each line.
- Reject Codex warning items after a failed turn as trailing stream drift.

## [0.13.0] - 2026-10-13

- Add Claude experiment MCP through its SDK control bridge. It requires
  hermetic mode, no built-in tools, and read-only scode. The experiment server
  runs outside scode with named environment variables. Record server bytes,
  model-bound tool results, inventory comparisons, and the recording path.
- Refuse experiment MCP for Codex because it adds a result header; other
  adapters also lack a verified mechanism. Fail JSON-RPC errors, changed
  inventories/results, protocol aborts, and incomplete server cleanup.
- Enable Antigravity hermetic and tools-none paths with the recorded
  Antigravity 1.3.3/scode 0.6.0 evidence. Use private homes, policy restrictions,
  a template Keychain mirror, and bounded cleanup.
- **Correction:** the retained live checks identify an internal tested tree,
  not an immutable commit. Subsequent hardening has synthetic regression
  evidence; no later live verification is implied.

## [0.12.0] - 2026-10-12

### Upgrade notes

- Plain Codex launches now use `--json`, reduce the stream, and record full
  usage. Preserve human-mode reply bytes, including the appended newline.
  A completed reply survives a later nonzero child exit; protocol failures
  suppress it. Plan-only replies use a bounded last-message fallback where
  writable. Missing or unreadable named fallback files fail.
- **Correction:** output limits apply while a line accumulates and when it
  completes. Discarded aggregate tool output does not consume retained capture,
  but one oversized line, retained reply, or stderr can still fail at exit 125.
  Earlier claims that only completed lines counted or that no tool-output
  volume could fail a run were false.
- Scrubbed provider credentials require scode's `--keep-env` support, including
  untrusted presets that imply scrubbing. Run, TUI, and session paths share the
  rule. Hidden scode configuration that enables scrubbing remains the operator's
  responsibility.
- Claude overrides add inline model-picker settings on run/TUI/session launches.
  Refuse nonempty `CODEMUX_CODEX_PROVIDER_STORE`: supported Codex releases have
  no matching setting and already request `store: false`.

### Added and fixed

- Add Kimi sessions over a per-turn stream-json process and native session
  store. Preserve deferred identity, registry ownership, provider identity,
  prompt bounds, and shutdown/spawn ordering.
- **Correction:** Kimi's leading `!` is model text on the audited headless
  path. Codemux refuses that shape and the word-bounded `/goal` name as policy;
  only `/goal creates` invokes the audited goal flow.
- Report raw child exits, summary exits, and caller shutdown intent separately.
  Nonzero or signaled child exits fail sessions even during requested shutdown.
  Retain terminal-event capacity and fail incomplete final output.
- Add Z.AI effort support; update Droid's gemini-flash alias to 3.6; prefer
  `cursor-agent` over `agent`, keeping desktop Cursor opt-in.
- Preserve recovered Codex error diagnostics, order fresh Kimi identity events,
  fail rejected interrupt delivery, validate exact KIMI_CODE_HOME values, and
  maintain process-tree cleanup and output-limit behavior under varied chunking.

## [0.11.0] - 2026-10-08

- Add the local call ledger and `calls` command with agent/time/limit filters,
  JSONL output, and per-field totals. Record run/check, turn, and closing
  session usage without prompts, credentials, or environment values.
- Store HOME-derived state with restrictive permissions. Allow
  `CODEMUX_CALL_LOG` relocation or disabling. Append failures warn without
  failing a completed run; reject unsafe files and bound reads to the newest
  16 MiB.
- Plain Claude/Z.AI/Agy/OpenCode runs now use structured harness output and
  unwrap replies. OpenCode discards tool events while retaining reply/usage.
  Codex's plain structured path follows in 0.12.0.
- **Correction:** closing token counters cover the driver invocation, not
  every resumed lifetime. Claude/Z.AI closing cost adopts lifetime cost.
  The newest-summary fold can omit older invocation usage if turns are absent.
- **Correction:** `--since` accepts JavaScript Date parsing as well as
  durations. `--json --sum` appends human-readable totals. A selected turn
  can include a lifetime cost summary; totals are not interval attribution.

## [0.10.0] - 2026-10-08

### Upgrade notes

The registry gains `provider_base_url`. Version 0.10.0 reads older records;
0.9.0 treats the expanded registry as corrupt and refuses resume. Upgrade every
binary sharing a home before mixing versions. Downgrading requires removing
the registry and losing recorded resume history.

### Added and fixed

- Add OpenCode and Aider sessions with native-store and owned-history resume,
  respectively. Both honestly report unsupported steer/interrupt/permission/
  delta/file-change capabilities.
- Carry provider overrides and caps into supported session spawns. Reject
  provider mismatches on resume. Codex override homes are keyed per session,
  never shared across sessions.
- Harden session-home and Aider-history ownership, symlink, bounds, race,
  and cleanup checks. Consult registry liveness before sweeping; unknown
  liveness preserves state. Sweep only sufficiently old eligible homes.
- Fix shutdown/drain behavior, pending spawns, usage folding, history parsing,
  late child cleanup, registry release ordering, and unsupported prompt commands.

## [0.9.0] - 2026-10-07

- Add `session` for Claude, Z.AI, Codex, and Agy with JSONL input,
  acknowledged inputs, versioned event envelopes, author labels, capabilities,
  timeouts, permissions, shutdown, and guarded resume.
- Enforce autonomy ceilings on caller approvals, including rewritten input,
  canonical paths, symlinks, executable configuration, and Unicode/case aliases.
- Serialize registry updates and claim resumes before spawning. Preserve
  trustworthy state, release claims on every end path, and fail unsafe registry
  contents. Handle deferred identity and incomplete persistence explicitly.
- Bound queues, frames, output flushing, and process-tree shutdown. Pair opened
  turns with completion, retain diagnostics/unknown events, fail protocol drift,
  and report failed startup/resume launches.
- Adopt Claude-family lifetime cost without adding it per turn. Normalize
  mid-turn Claude input as injection, not a new queued turn.
- Refuse provider overrides in this release; support arrives in 0.10.0.
  Correct platform-specific registry tests.

## [0.8.0] - 2026-10-07

- Add provider overrides for Claude, Codex, and OpenHands, plus supported output
  and context caps. Claude requires Messages API compatibility; Codex requires
  Responses API compatibility and uses private per-run configuration.
- Add Codex multi-agent override control and keep provider keys out of spawned
  shell tools. Refuse unsupported caps and unsupported TUI override paths.
- Separate override credentials from operator login and credential-mirror
  synchronization. Restore OpenHands overrides behind `--override-with-envs`.

## [0.7.1] - 2026-10-05

- Remove refresh tokens from sandboxed Claude credential mirrors while retaining
  access tokens and descriptive fields. Keychain tokens are authoritative when
  they differ. Existing mirrors are backed up before atomic scrubbing.
- Expired/revoked access tokens fail authentication; a sandboxed mirror cannot
  refresh. Refuse a known mirror that cannot be safely scrubbed.
- Preserve file-only logins, unreadable Keychain state, explicit profiles, and
  `CODEMUX_NO_KEYCHAIN_SYNC` escape-hatch behavior with diagnostics. Keep
  backups private and prune older completed backups.

## [0.7.0] - 2026-10-04

- Add provider overrides for the retained supported adapters, including Droid
  custom-model settings, Kimi environment routing, Goose environment routing,
  Pi private provider configuration, OpenCode configuration, and Aider routing.
  Reject partial, unsupported, or template-expanding values.
- Add verified tools-none mappings for Droid, Kimi, Goose, and Pi. Withdraw
  Aider hermetic support after config injection; keep unsupported hermetic
  capabilities refused.
- Refuse OpenCode tools-none without hermetic mode and refuse hermetic mode
  when login state can load remote configuration.
- Remove unverified override/isolation machinery for Copilot, Gemini, Cline,
  OpenHands, and Qwen. OpenHands override support returns in 0.8.0.
- Harden private-artifact sweeps, bounded/no-follow reads, FIFO handling,
  environment-prefix validation, per-adapter environment propagation,
  model naming, reasoning settings, and Aider reply extraction.
- Use Bun SQLite for OpenCode state inspection. Keep canary tool selection
  constant between the isolation probe and its positive control.

## [0.6.1] - 2026-10-04

- Add Antigravity CLI (Agy), audited at 1.2.14, with equals-form flags and
  argv prompt transport.
- Keep standalone Cursor entries as the default; require explicit
  `CODEMUX_CURSOR_ENTRY=cursor` pass-through for the desktop wrapper.
  The then-current entry order was `agent`, then `cursor-agent`; 0.12.0
  reverses it.

## [0.6.0] - 2026-10-03

- Add stdin prompt input (`-f -`) with UTF-8, size, and collection-time bounds.
  Validate independent launch restrictions before reading a potentially stalled
  pipe. Input collection and child execution receive separate timeout budgets.
- Add structured results for Claude, Z.AI, and Codex with normalized usage;
  Codex uses a constructed envelope and a bounded Plan-only fallback.
  **Correction:** the envelope is not always the harness's own JSON object.
- Add scode accounting file and correlation-ID options on run/TUI.
- Isolate overlapping Codex launch state; apply exec approval config correctly;
  attribute model reroutes; protect fallback reads and cleanup.
- Fix Copilot reasoning flags and unknown-version refusal, probe redirected
  OpenCode binaries, sanitize version-probe environments, and use one validated
  environment pass-through list.
- Require absolute, unpadded Claude profile redirects.

## [0.5.2] - 2026-09-17

- Add hermetic runs and tool selection for Claude/Z.AI/Codex, plus paired
  customization canaries. Forward Codex API-key credentials where supported.
- **Correction:** hermetic mode suppresses specified automatic customization
  channels; it does not provide prompt-only reproducibility. Codex tools-none
  retains native planning/patch capabilities constrained by read-only scode.
  Canaries test planted channels against controls, not universal absence.
- Share the run/check launch path, forward termination to the process tree,
  validate env-prefixed executables, and allow the intentional empty tools flag
  in wiring checks. Update harness and sandbox-default documentation.

## [0.5.1] - 2026-09-15

- Restore sandboxed Claude/Z.AI write behavior through scoped grants at medium
  autonomy and correct Claude credential-stub synchronization.
- Terminate detached descendants of timed-out runs and harden bounded cleanup.
- Run static wiring checks in neutral directories isolated from ancestor
  customization files.
- Upgrade js-yaml to 4.3.2 for GHSA-2883-xcg3-v3hh.

## [0.5.0] - 2026-08-21

- Add sandboxed Claude Keychain-to-file credential synchronization, including
  ownership/symlink checks, atomic writes, profile opt-outs, and
  `CODEMUX_NO_KEYCHAIN_SYNC`. Later security behavior is documented in 0.7.1.
- Add OpenHands 1.16.0 with environment-based model selection and project
  execution-configuration refusals. Headless autonomy depends on scode.
- Run static wiring checks in a neutral directory.

## [0.4.0] - 2026-08-15

- Enable sandboxing by default and require scode below high autonomy. Keep
  native harness controls as additional enforcement.
- **Correction:** scode protects its filesystem/network boundary, not every
  version-sensitive native tool, customization, or protocol guarantee.
- Add Kimi with TUI autonomy mappings and headless scode enforcement.
- Add version floors, audited ceilings, known-break rules, explicit untested
  override, and executable-identity checks around version probes.

## [0.3.1] - 2026-08-13

- Escape provider usage strings for terminal display and report oversized usage
  responses accurately. Isolate absent-tool tests from local Bun directories.

## [0.3.0] - 2026-08-04

- Add optional usagemux subscription reporting with validated JSON, quota,
  credits, subscription timestamps, and doctor discovery.
- Upgrade js-yaml to 4.3.1 for GHSA-5p4m-2wfm-xmqj.

## [0.2.1] - 2026-08-02

- Treat the pinned Bun package-manager version as a minimum.
- Add Homebrew installation with scode dependency.

## [0.2.0] - 2026-08-02

- Add testing/release/contribution/security documentation, MIT licensing,
  repository metadata, shell aliases, and macOS/Linux release CI.
- Add Aider, Cline, Copilot, and Cursor adapters; sandbox previews and policy
  overrides; model aliases and expanded effort mappings.
- Harden autonomy, project execution-configuration checks, interpreter and
  executable trust, environment filtering, Z.AI credentials, prompt validation,
  pipe handling, process-tree timeouts, and local opt-in Playwright MCP.
- Require scode 0.2.0, add installed-contract checks, and enforce 80% line and
  function coverage. Correct harness flags, pure/safe-mode configuration,
  and native state isolation.

## [0.1.0] - 2026-02-24

Untagged initial version; no corresponding published repository release.

- Add the adapter architecture for Claude, Codex, Droid, Goose, Gemini,
  OpenCode, Pi, Qwen, and Z.AI; normalized autonomy/effort; scode integration;
  diagnostics; and Bun/TypeScript tests.
