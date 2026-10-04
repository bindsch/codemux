# Harness Compatibility Ledger

Last full-pass audit: 2026-08-15. Most recent single-harness audit: 2026-09-21
(Copilot, flag surface only). Most recent verification pass against installed
binaries (not an audit; the audited versions below are unchanged): 2026-10-03 —
see the addendum of that date.

This is the release contract for Codemux's external agent adapters. “Audited”
means the upstream release/changelog and current CLI reference were reviewed,
the latest help surface was inspected, and generated argv/env behavior was
covered by tests. Installed binaries were also exercised where available.

| Harness | Audited upstream | Installed during audit | Primary source | Important contract |
|---------|------------------|------------------------|----------------|--------------------|
| Aider | 0.86.2 | 0.86.2 | [PyPI](https://pypi.org/project/aider-chat/) | packaged empty config/model metadata, null env/history, no Git side effects, negative headless confirmations, common provider credentials allowlisted |
| Claude Code | 2.1.223 | 2.1.223 | [release](https://github.com/anthropics/claude-code/releases/tag/v2.1.220) | `manual` replaces removed public `default`; effort is low through max |
| Cline CLI | 3.0.48 | not installed | [CLI changelog](https://github.com/cline/cline/blob/main/apps/cli/CHANGELOG.md) | `cline -- ...`, explicit plan/auto-approve/thinking, project execution config rejected |
| Codex CLI | 0.147.0 | 0.147.0 | [release](https://github.com/openai/codex/releases/tag/rust-v0.146.0) | stdin prompt, explicit sandbox and approval policy, project config rejected |
| GitHub Copilot CLI | 1.0.85 | 1.0.85 | [releases](https://github.com/github/copilot-cli/releases) — v1.0.4 introduced `--reasoning-effort`, v1.0.10 added the `--effort` alias, and 1.0.85 no longer lists it | explicit `--reasoning-effort none` (canonical since v1.0.4; the `--effort` alias codemux used was added in v1.0.10 and has been dropped. Values unchanged, so no translation, unlike Droid's `none` to `off`), remote/project integrations disabled or rejected. Version-gated since 2026-09-21 |
| Cursor Agent | rolling build 2026.08.11-e8db854 | same | [CLI installation](https://docs.cursor.com/en/cli/installation) | primary `agent`, legacy alias fallback, stdin, trust, Plan/Auto Review/Force, outer sandbox |
| Droid | 0.186.0 | 0.186.0 | [CLI reference](https://docs.factory.ai/reference/cli-reference) | stdin, native auto levels and model-aware reasoning-off values, project execution config rejected |
| Goose | 1.45.0 | not installed | [release](https://github.com/aaif-goose/goose/releases/tag/v1.45.0) | `GOOSE_MODE` chat/approve/smart_approve/auto, project extension config rejected |
| Gemini CLI | 0.53.1 | not installed | [release](https://github.com/google-gemini/gemini-cli/releases/tag/v0.53.1) | current approval modes; local `.env` and nested sandbox disabled; Plan requires an outer read-only boundary |
| Kimi Code | 0.31.1 | 0.31.1 | [docs](https://moonshotai.github.io/kimi-code/) | argv prompt; `--plan`/`--yolo`/`--auto` are interactive only and are rejected with `--prompt`, so headless autonomy rests on scode; project `.kimi-code` agents, skills, and mcp directories rejected |
| OpenHands | CLI 1.16.0 | CLI 1.16.0 | [SDK](https://github.com/OpenHands/software-agent-sdk) | argv task; `--headless` auto-approves so headless autonomy rests on scode; `--llm-approve` never emitted; model only via `--override-with-envs`; project `.openhands` skills, hooks, agents, microagents, plugins, and profiles rejected |
| OpenCode | 1.18.18 | 1.18.18 | [release](https://github.com/anomalyco/opencode/releases/tag/v1.18.10) | pure mode, plan/build/auto, headless `--variant`, all policy-bearing project config rejected |
| Pi | 0.83.0 | not installed | [release](https://github.com/earendil-works/pi/releases/tag/v0.83.0) | new `@earendil-works/pi-coding-agent` package, stdin, no project packages, explicit tools |
| Qwen Code | 0.21.2 | not installed | [release](https://github.com/QwenLM/qwen-code/releases/tag/v0.21.2) | current `qwen`, safe mode, plan/default/auto/yolo; sandbox-only legacy fallback |
| Z.AI | Claude 2.1.220 transport | Claude 2.1.220 | [Z.AI Claude setup](https://docs.z.ai/devpack/tool/claude) | official Anthropic-compatible endpoint/env and Claude permission contract |

The 2026-08-15 pass re-read every installed binary and re-ran the installed
contract suite against all seven of them: Aider, Claude Code, Codex, Cursor
Agent, Droid, Kimi Code, and OpenCode. Cline, Gemini, Goose, Pi, Copilot, and
Qwen were not installed at that time and were not re-audited in that pass; their
rows carry the versions from 2026-08-01. Copilot has since been installed and
re-audited -- see below. Gemini in particular has moved on upstream,
so treat that row as stale rather than current.

**Copilot was re-audited on 2026-09-21** and is installed at 1.0.85; its row is
current. That audit found the flag this document had recorded as `--effort`:
Copilot takes `--reasoning-effort`, so every `codemux run -a copilot --effort`
had been failing on an unknown option.

The gap is not that the check is optional. `make release-gate` runs the
installed-contract suite on every PR, push to main, and tag. The suite **skips a
binary that is not present on the machine**, and no machine in the loop had
copilot: CI runners carry no harness CLIs, and the release machine did not have
it either until this audit. A row that says "not installed" is a row nothing
exercises, on any machine, however often the suite runs.

It was never a rename, and that matters for the version floor. Checked against upstream's releases: `--reasoning-effort`
is the canonical flag and has existed since v1.0.4; `--effort` was added in
v1.0.10 as a shorthand alias and has since been dropped, and 1.0.85's help lists
no `--effort`. Codemux had been emitting the alias rather than the flag. Every
release at or above the 1.0.77 floor accepts what it emits now, so the change
opens no compatibility gap. That floor is also where the version gate sits: it
refuses older releases rather than reporting roughly seventy never-audited ones
as supported, and a refusal can be overridden with
`CODEMUX_ALLOW_UNTESTED_HARNESS` while a false "supported" cannot. A copilot
that reports no version at all is refused the same way: `--binary-version`
arrived in 1.0.3, below the floor, so a silent probe is a below-floor release
(1.0.0 through 1.0.2) rather than an unknown build, and the override covers it
like every refusal.

OpenCode's reported version changed mid-session while it was being updated,
which is what the binary-identity check in `src/harness-compatibility.ts`
reports: the version read during the probe is not guaranteed to be the version
that runs.

Sandbox execution requires scode 0.2.0 or newer. Codemux checks this before
launch so older wrappers cannot silently miss a newly supported harness. The
audit machine has since been upgraded to scode 0.3.0, and the sandbox contract
check passes.

Gemini CLI 0.53.1 remains usable with API-key or enterprise authentication.
Google's individual subscription and free-tier CLI login moved to Antigravity;
see the [official announcement](https://github.com/google-gemini/gemini-cli/discussions/28017).

## 2026-09-04 addendum: Claude Code subprocess-env-scrub hardening

Installed Claude Code 2.1.258 (last audited at 2.1.223 on 2026-08-15) couples
`CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` to a permission hardening: when that
variable is set, permission-mode resolution force-returns `default` and
silently discards `--permission-mode` and `--dangerously-skip-permissions`.
The notification reads: "Permission mode forced to default —
CLAUDE_CODE_SUBPROCESS_ENV_SCRUB is set (allowed_non_write_users hardening).
Declare allowedTools explicitly, or set CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=0 to
opt out." Both claude-family adapters set the variable for subprocess env
scrubbing, so headless medium/high runs lost file-write ability: reads
worked, and every write was denied for lack of an interactive approval path.

The `claude` and `zai` adapters now emit explicit `--allowedTools` grants
alongside the unchanged native flags: an `Edit(//<launch dir>/**)` grant at
medium — anchored to the launch directory, the same paths acceptEdits
would auto-approve, so an approved `cd` cannot widen it — and bare `Edit`,
`Write`, `NotebookEdit`, and `Bash` at high, a subset of the bypass high
always requested. This is the escape hatch the hardening message itself
offers. Keeping the flags and scoping the medium grant to the workspace
means audited versions and any future upstream that decouples the variable
keep their previous headless write behavior exactly. Under the hardening,
high remains weaker than a true bypass: managed deny rules, safety checks,
and ungranted tools still gate. Grants ride only on headless runs; the
TUI keeps the native flags so a human approves, and grants cannot survive
a mode switch because they are never emitted there. Plan mode is
discarded as well, so a hardened read-only TUI prompts instead of
planning; headless read-only denies writes either way, and scode's `--ro`
boundary remains the enforcement. At medium, a launch directory
containing a parenthesis, a backslash, a glob metacharacter, a tab or
line break, or trailing whitespace refuses the launch — the rule grammar
cannot represent any of them.

`maxAudited` for Claude Code stays at 2.1.223: this addendum rests on
help-surface and installed-binary inspection plus adapter unit tests, not on
the full upgrade procedure above. Re-audit against the upstream release
notes and re-run the installed contract suite before bumping.

## 2026-09-17 addendum: hermetic runs

Installed Claude Code 2.1.270 and Codex 0.154.0 (last audited at 2.1.223 and
0.147.0) were exercised for `--hermetic` and `--tools none`; the mechanisms
and the live verification are described in `docs/HERMETIC.md`. Codex's
`--ignore-user-config` (exec) and `--disable <FEATURE>` (global) are now
part of the installed contract; both exist at 0.154.0 and are not known to
exist at 0.146.0, so a hermetic Codex run on an older release may fail on
an unknown flag rather than run non-hermetically. `maxAudited` is unchanged:
this addendum rests on help-surface inspection, adapter unit tests and the
live canary, not on the full upgrade procedure.

## 2026-10-03 addendum: result envelopes

`--result-json` was verified against the installed Claude
Code 2.1.280 and codex-cli 0.159.3 (last audited at 2.1.223 and 0.147.0).

Result envelopes: Claude Code's `--output-format json` envelope is passed
through with one codemux-owned block appended. Codex's event stream from
`codex exec --json` is pinned against codex-rs `exec/src/exec_events.rs` at
rust-v0.159.3: `thread.started` (thread id), `item.completed` with an
`agent_message` item (the final message is the last one), `turn.completed`
(usage). Codex's `input_tokens` includes both cache breakdowns — the cached
reads and the cache writes are parts of that total, not additions to it —
so the normalized block reports uncached input as
`input - cached - cache_write` and folds both counts into
`cached_input_tokens`, matching the Claude mapping (`input_tokens` there
excludes the cache). One blind spot is covered by a second pinned flag: the
JSONL mapper has no `Plan` arm (`map_item_with_id` at rust-v0.159.3), while
`final_message_from_turn_items` falls back to the last `Plan` item — so a
turn that ends with only a Plan leaves the stream with no message even
though codex has a final message. Every stream run therefore also passes
`--output-last-message <file>` (exec_cli.rs `handle_last_message`: the
recorded final message at shutdown; empty with a warning when the turn has
none, and not written for failed turns), and that recorded message is the
result when the last turn completed without an `agent_message`, with a
stderr note. Z.AI shares the claude contract (same binary). No run persists
a session: Claude Code and Z.AI always carry `--no-session-persistence`,
and Codex always `--ephemeral`, so the codemux block's `session_id` is null
(reserved for the planned live-sessions release).

The strict event-stream grammar also dates from
this audit round: exactly one `thread.started` naming a non-empty thread
id (a stream without one — an empty stream included — or with a second is
drift), every `turn.completed`/`turn.failed` matched to an open
`turn.started` (an unmatched terminal event is the shape of a
prefix-truncated stream, refused rather than clamped), and `turn.failed`
is terminal — no later event clears it. One `codex exec` run is one turn,
so a `turn.started` after any `turn.completed` is drift too (2026-10-04).
Items belong inside turns, so an `item.started`, `item.updated`, or
`item.completed` event after the last `turn.completed` — whatever the
item's type — is drift as well (2026-10-04). An all-zero
`turn.completed` usage snapshot is `Usage::default()`, which 0.159.3 emits
when the thread never received a token-usage update; it counts as
unreported, not as a measured zero (2026-10-04).
A passed-through
`CLAUDE_CONFIG_DIR` (claude and zai alike, run and TUI) must be absolute;
a relative one is refused before launch, because Claude Code resolves it
against the run's working directory and the config store would land
wherever `--cwd` points.

Codex approval policy (2026-10-03 review correction): autonomy's approval
half rides on the config override `-c approval_policy="…"` (serde values
`untrusted`/`never`), not on `-a`. Verified against the codex-rs clap
grammar at rust-v0.159.3: `exec` has no `-a` of its own and the root-to-exec
handoff copies only `SharedCliOptions` (`-s`, `-m`), dropping a root `-a`;
and `-a` there accepts only `on-request` and `never`, so it cannot express
`untrusted` at all. The root `-c` is forwarded into `exec` (fresh and
`resume`) and reaches the TUI too, which is why `mapEffort` already used it.

## Version enforcement

`src/harness-compatibility.ts` is the machine-readable half of this ledger and
is checked before every launch. Keep the two in step: the table above records
what was reviewed, the matrix records what the CLI enforces.

Refusing a version requires a determined breaking change, not a version bump.
Upstream ships patches that change nothing, and refusing those would make
Codemux unusable, so anything newer than `maxAudited` runs with a warning.

Since the boundary is scode rather than the harness, a stale matrix costs an
inaccurate warning, not enforcement. That is deliberate: it keeps a missed
upstream release from becoming a security problem.

## Behavioral invariants

- Prompts use stdin whenever the upstream CLI supports it. Aider, Cline,
  Copilot, Gemini, Goose, Kimi, OpenHands, and legacy `qwen-coder` retain
  bounded argv prompts.
- Every autonomy level below `high` is a durable filesystem boundary supplied
  by scode. Harness-native permission controls are defense in depth; Codemux
  does not depend on them to enforce a level.
  This holds for interactive sessions as well as headless runs: there is no
  per-harness TUI exemption.
- Repository-controlled hooks, plugins, MCP servers, and policy overrides are
  disabled by a native safe flag or rejected before launch.
- An outer `scode` boundary is authoritative. Native nested sandboxes are
  bypassed only after Codemux has constructed the outer policy.
- Effort values are advertised per harness. Unsupported values fail before
  process launch rather than silently collapsing to a different level.

## Upgrade procedure

For every harness upgrade:

1. Review releases since the version above and the current CLI reference.
2. Capture `--version`, root `--help`, and the relevant run subcommand help.
3. Compare every emitted flag, accepted enum value, prompt transport, default
   approval behavior, project configuration surface, credential path, model
   identifier, and TUI/headless difference.
4. Update the adapter, autonomy matrix, model aliases, installed contract, and
   this ledger together.
5. Run `bun run test:contracts`, manually exercise available commands through
   Codemux, and finish with `make release-gate` under the pinned Bun version.

The installed-contract suite intentionally skips absent third-party tools. A
release review must therefore compare the installed set with this complete
ledger rather than treating a skipped tool as verified.
