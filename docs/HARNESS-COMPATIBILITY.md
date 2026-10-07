# Harness Compatibility Ledger

Last full-pass audit: 2026-08-15. Most recent single-harness audit: 2026-10-04
(Antigravity, flag surface only; no login on the audit machine). Most recent
harness additions: 2026-10-04 (Antigravity 1.2.14; the opt-in `cursor agent`
entry point) — see the addendum of that date. Most recent verification pass
against installed binaries (not an audit; the audited versions below are
unchanged): 2026-10-03.

This is the release contract for Codemux's external agent adapters. “Audited”
means the upstream release/changelog and current CLI reference were reviewed,
the latest help surface was inspected, and generated argv/env behavior was
covered by tests. Installed binaries were also exercised where available.

| Harness | Audited upstream | Installed during audit | Primary source | Important contract |
|---------|------------------|------------------------|----------------|--------------------|
| Antigravity CLI | 1.2.14 | 1.2.14 at audit, self-updated to 1.2.16 mid-audit (see the 2026-10-04 addendum; no login on the audit machine) | [headless docs](https://antigravity.google/docs/cli/headless) | argv prompt bound inside `--print=`, enum flags emitted `--flag=value` (required at 1.2.14), five effort levels, `--mode` plan/accept-edits plus `--dangerously-skip-permissions`, JSON envelope for `--result-json`, `--disable-slash-commands`, project `.agents`/`.gemini` config rejected, no verified hermetic mode (docs/HERMETIC.md) |
| Aider | 0.86.2 | 0.86.2 | [PyPI](https://pypi.org/project/aider-chat/) | packaged empty config/model metadata, null env/history, no Git side effects, negative headless confirmations, common provider credentials allowlisted |
| Claude Code | 2.1.223 | 2.1.223 | [release](https://github.com/anthropics/claude-code/releases/tag/v2.1.220) | `manual` replaces removed public `default`; effort is low through max |
| Cline CLI | 3.0.48 | not installed | [CLI changelog](https://github.com/cline/cline/blob/main/apps/cli/CHANGELOG.md) | `cline -- ...`, explicit plan/auto-approve/thinking, project execution config rejected |
| Codex CLI | 0.147.0 | 0.147.0 | [release](https://github.com/openai/codex/releases/tag/rust-v0.146.0) | stdin prompt, explicit sandbox and approval policy, project config rejected |
| GitHub Copilot CLI | 1.0.85 | 1.0.85 | [releases](https://github.com/github/copilot-cli/releases) — v1.0.4 introduced `--reasoning-effort`, v1.0.10 added the `--effort` alias, and 1.0.85 no longer lists it | explicit `--reasoning-effort none` (canonical since v1.0.4; the `--effort` alias codemux used was added in v1.0.10 and has been dropped. Values unchanged, so no translation, unlike Droid's `none` to `off`), remote/project integrations disabled or rejected. Version-gated since 2026-09-21 |
| Cursor Agent | rolling build 2026.08.11-e8db854 | same | [CLI installation](https://docs.cursor.com/en/cli/installation) | primary standalone `agent`, then the legacy `cursor-agent` alias; `cursor agent` (the desktop CLI's subcommand) runs only behind the explicit `CODEMUX_CURSOR_ENTRY=cursor` opt-in passed through `--pass-env` — the desktop wrapper may install or update `~/.local/bin/cursor-agent` on first use, so nothing executes it on Codemux's own initiative, and under the opt-in the trust check and the `cursor agent --version` probe both sit in the launch path, the probe after the check; stdin, trust, Plan/Auto Review/Force, outer sandbox; the version probe keys on the resolved entry's name (not the executable's basename; the Homebrew `cursor` symlink resolves into the app bundle as `code`) because `cursor --version` reports the desktop app's semver, not the agent build |
| Droid | 0.186.0 | 0.186.0 | [CLI reference](https://docs.factory.ai/reference/cli-reference) | stdin, native auto levels and model-aware reasoning-off values, project execution config rejected |
| Goose | 1.45.0 | not installed | [release](https://github.com/aaif-goose/goose/releases/tag/v1.45.0) | `GOOSE_MODE` chat/approve/smart_approve/auto, project extension config rejected |
| Gemini CLI | 0.53.1 | not installed | [release](https://github.com/google-gemini/gemini-cli/releases/tag/v0.53.1) | current approval modes; local `.env` and nested sandbox disabled; Plan requires an outer read-only boundary |
| Kimi Code | 0.31.1 | 0.31.1 | [docs](https://moonshotai.github.io/kimi-code/) | argv prompt; `--plan`/`--yolo`/`--auto` are interactive only and are rejected with `--prompt`, so headless autonomy rests on scode; project `.kimi-code` agents, skills, and mcp directories rejected |
| OpenHands | CLI 1.16.0 | CLI 1.16.0 | [SDK](https://github.com/OpenHands/software-agent-sdk) | argv task; `--headless` auto-approves so headless autonomy rests on scode; `--llm-approve` never emitted; model only via `--override-with-envs` (`LLM_BASE_URL`/`LLM_API_KEY`/`LLM_MODEL` exercised live 2026-09-17 through a Z.AI override); project `.openhands` skills, hooks, agents, microagents, plugins, and profiles rejected |
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

## 2026-09-17 addendum: hermetic across the remaining harnesses

The mechanisms (or refusals) for every harness beyond Claude Code, Z.AI and
Codex are grounded as follows, all detailed in `docs/HERMETIC.md`. None of
this moves `maxAudited`: the implemented mappings keep their capabilities
off until a live check runs.

The model-level probes for every harness described below ran live on
2026-09-17 through codemux, each through its provider override where one
exists. The one gap is Cursor Agent, which has neither a login on this
machine nor a mechanism to check:

| Harness | Checked at | Last audited | Probe pending |
|---------|-----------|--------------|---------------|
| Cursor Agent | 2026.08.11 build | same | no Cursor login on this machine; no mechanism exists to check |

Droid 0.221.0 (last audited 0.186.0) was exercised live on 2026-09-17
through the provider override: a per-run BYOK `--settings` file routed
GLM-5.3 via Z.AI with no Factory login (the override's own key
authenticates), and the `--tools none` capability probes and the
non-hermetic control probe ran against the model (docs/HERMETIC.md). The
tool flags are unchanged between 0.186.0 and 0.221.0; the BYOK settings
surface (`customModels`, `--settings`) is now part of the exercised
contract. `maxAudited` is unchanged: this rests on help-surface
inspection, adapter unit tests and the live probes, not on the full
upgrade procedure.

Gemini CLI 0.60.0 (last audited 0.53.1) was installed here (`npm install
-g @google/gemini-cli`; `npm uninstall -g @google/gemini-cli` removes it)
and exercised live on 2026-09-17 through codemux `check` and probe runs
with a private `GEMINI_CLI_HOME`. The approval-mode flags behind the
autonomy mapping are unchanged between 0.53.1 and 0.60.0. The exercise
surfaced two findings, detailed in docs/HERMETIC.md. First, the packaged
system-settings file (`resources/gemini-system-settings.json`, whose one
pin is `advanced.ignoreLocalEnv` — generic project `.env` loading
disabled) is silently skipped on a user-owned prefix — the
system-settings security walk requires the file and every ancestor
directory to be root-owned (uid 0), a rule present identically at the
audited 0.53.1 — so that one pin has never applied under Homebrew or a
source checkout; the other two protections (`.gemini` project controls
rejected, nested sandbox disabled) are launch-boundary mechanisms — the
project-config assertion and `--sandbox=false` in argv — and apply on
every prefix. Second, no custom-provider override exists at 0.60.0:
`GOOGLE_GEMINI_BASE_URL` maps to a "gateway" auth type the CLI's own
validator rejects, and with API-key auth pinned the request still reached
Google. `maxAudited` is unchanged: this rests on help-surface inspection,
package-source reading and the live runs, not on the full upgrade
procedure.

Pi 0.85.1 (last audited 0.83.0) was installed here (`npm install -g
@earendil-works/pi-coding-agent`; `npm uninstall -g
@earendil-works/pi-coding-agent` removes it) and exercised live on
2026-09-17 through a provider override: a private agent directory behind
`PI_CODING_AGENT_DIR` carrying a one-provider `models.json` routed
GLM-5.3 via Z.AI with no stored login, and the `--tools none`
capability probes and the non-hermetic control probe ran against the
model (docs/HERMETIC.md). The tool flags behind the mappings
(`--no-tools`, `--tools`, `--no-approve`) are unchanged between 0.83.0
and 0.85.1 in the package help surface, and the `models.json` provider
schema with `$VAR` apiKey templates is now part of the exercised
contract. `maxAudited` is unchanged: this rests on help-surface
inspection, adapter unit tests and the live probes, not on the full
upgrade procedure.

Goose 1.50.1 (last audited 1.45.0) was installed here (the official
`download_cli.sh` from the README with `CONFIGURE=false`, which installs
to `~/.local/bin/goose`; delete that file to remove it — Homebrew cannot
install it inside this machine's sandboxed sessions) and exercised live
on 2026-09-17 through a provider override: the environment group
`GOOSE_PROVIDER`/`OPENAI_HOST`/`OPENAI_BASE_PATH`/`OPENAI_API_KEY`/`GOOSE_MODEL`
routed GLM-5.3 via Z.AI with no goose login — every value rides goose's
env-first lookup (`get_param`, `crates/goose/src/config/base.rs` at
1.50.1), so no operator file is touched. The `--tools none` capability
probes and the non-hermetic control probe ran against the model
(docs/HERMETIC.md). The flags behind the mappings (`--no-profile`,
`GOOSE_MODE`) and the OpenAI custom-endpoint surface are unchanged
between 1.45.0 and 1.50.1 in the source and help surface, and the
`OPENAI_HOST`/`OPENAI_BASE_PATH` endpoint split with goose's
`derive_base_path` semantics is now part of the exercised contract.
`maxAudited` is unchanged: this rests on help-surface inspection,
adapter unit tests and the live probes, not on the full upgrade
procedure.

Qwen Code 0.24.0 (last audited 0.21.2) was installed here (`npm install
-g @qwen-code/qwen-code`; `npm uninstall -g @qwen-code/qwen-code` removes
it) and exercised live on 2026-09-17 through a provider override: the
`OPENAI_API_KEY`/`OPENAI_BASE_URL`/`OPENAI_MODEL` group qwen documents
for headless setups routed GLM-5.3 via Z.AI, and the non-hermetic
control probe plus plain capability probes ran against the model
(docs/HERMETIC.md). The `--safe-mode` and `--approval-mode` flags behind
the mappings are unchanged between 0.21.2 and 0.24.0 in the package help
surface, and the OpenAI-compatible environment group is now part of the
exercised contract. Both capabilities stay refused, now live-grounded:
the control probe stayed clean because every codemux qwen run already
carries `--safe-mode` (docs/HERMETIC.md). `maxAudited` is unchanged:
this rests on help-surface inspection, adapter unit tests and the live
probes, not on the full upgrade procedure.

Cline CLI 3.0.62 (last audited 3.0.48) was installed here (`npm install
-g cline`; `npm uninstall -g cline` removes it) and exercised live on
2026-09-17 through a provider override: a private data directory behind
`--data-dir` carrying a one-provider `settings/providers.json` routed
GLM-5.3 via Z.AI with no cline login, and the non-hermetic control probe
plus plain capability probes ran against the model (docs/HERMETIC.md).
The `--data-dir` flag matters beyond relocation: a plain one-shot run
delegates its session to cline's long-lived hub daemon, whose provider
resolution drops the settings file's base URL (the session config
carries the key but not the endpoint — observed live when every run
after the first sent the override's key to api.openai.com), while
`--data-dir` sets `CLINE_SANDBOX=1` and forces the in-process backend
that reads the file (`forceLocalBackend: isYoloMode ||
config.sandbox === true`, apps/cli/src/runtime/run-agent.ts at 3.0.62).
The `--plan`/`--auto-approve`/`--thinking` flags behind the mappings are
unchanged between 3.0.48 and 3.0.62 in the help surface, and the
`providers.json` settings shape plus the `--data-dir` isolated-state
surface are now part of the exercised contract. Both capabilities stay
refused, live-grounded: the control probe leaked the planted code word
through the workspace channel and named the operator from the global
`~/.agents/AGENTS.md` channel (docs/HERMETIC.md). `maxAudited` is
unchanged: this rests on help-surface inspection, adapter unit tests
and the live probes, not on the full upgrade procedure.

Copilot CLI 1.0.85 (last audited 1.0.77) was installed here (`npm install
-g @github/copilot`; `npm uninstall -g @github/copilot` removes it) and
exercised live on 2026-09-17 through a provider override: the documented
BYOK environment group (`COPILOT_PROVIDER_BASE_URL` /
`COPILOT_PROVIDER_TYPE` / `COPILOT_PROVIDER_API_KEY` plus `COPILOT_MODEL`,
docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/use-byok-models)
routed GLM-5.3 via Z.AI with no Copilot login — BYOK activates before
GitHub authentication at 1.0.85 — and the `--tools none` refutation
probes and the non-hermetic control probe ran against the model
(docs/HERMETIC.md). One environment note from the exercise: the loader's
first-run self-extraction writes about 132 MB under
`~/Library/Caches/copilot/pkg` (the darwin cache directory; the loader
does not consult `XDG_CACHE_HOME` on darwin), which a sandboxed session
cannot create — `COPILOT_PKG_CACHE_HOME`, checked ahead of that default
by the loader's cache resolution, redirects it, and in-session runs pass
it through with `--pass-env COPILOT_PKG_CACHE_HOME`. The flags behind
the mappings are unchanged between 1.0.77 and 1.0.85 in the help
surface, and the BYOK environment group is now part of the exercised
contract. One flag did change between 1.0.77 and 1.0.85: the effort
flag was renamed from `--effort` to `--reasoning-effort` (same value
set, none through max), caught by the installed-contract suite on the
exercised binary, and the adapter now emits the new name. Both
capabilities stay refused, live-grounded: no argv
spelling of an empty `--available-tools` allowlist disarms the tools,
and the check's control probe cannot leak the planted code word because
`--no-custom-instructions` rides every codemux copilot run
(docs/HERMETIC.md). `maxAudited` is unchanged: this rests on
help-surface inspection, bundle reading and the live probes, not on the
full upgrade procedure.

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

## 2026-10-04 addendum: Antigravity, and re-ordering Cursor's entry points

**Antigravity (`agy`) was added at 1.2.14.** The audit machine has the
binary installed but no Antigravity login, so the audit is a flag-surface
audit — `agy --help`, `--version`, direct flag-form probes against the
binary, its embedded JSON tags, and the official headless documentation —
and not a live exercise. No hermetic claim was made for the same reason
plus the mechanism gap named in `docs/HERMETIC.md`.

The binary self-updated to 1.2.16 mid-audit, the same mid-session drift
the OpenCode note above records. The version gate warned on the next
launch exactly as designed ("newer than the 1.2.14 this Codemux
audited"), the installed contract's agy entry still passes at 1.2.16 —
every required flag is present — and the `=`-form the adapter emits is
valid on both releases, so nothing breaks. One probe no longer
reproduces at 1.2.16: `--effort high --print=…` (space form) exited 2 at
1.2.14 before any network contact and now parses, reaching the
authentication flow. The addendum below keeps describing 1.2.14, the
audited release.

Three points where the documentation and the 1.2.14 binary disagree; the
binary won each time:

- The docs' effort table lists low, medium, or high. The binary accepts
  five values — `low|medium|high|xhigh|max` — rejecting others with that
  list in the error, and the adapter maps all five.
- The docs' examples write the enum flags with a space (`--effort high`,
  `--output-format json`). The binary requires the single-token
  `--flag=value` form for `--effort`, `--mode`, `--input-format`, and
  `--output-format`; the space form exits 2. The adapter therefore binds
  the prompt inside `--print=<prompt>`, which also keeps a leading-dash
  prompt off the flag parser. An unrecognized `--mode` value warns and
  continues (fail-open), so the adapter never relies on `--mode` parsing
  as a safety boundary — the scode sandbox stays the enforcement for
  every level below high, as everywhere else.
- The docs' streaming examples emit `{"event":"result","result":{...}}`,
  a wrapper with no top-level `status`. That wrapper is not the
  print-mode envelope; the envelope parser rejects it (negative fixture
  in `tests/result-envelope.test.ts`).

The `--result-json` envelope is pinned against the documented schema and
the binary's own JSON tags, and is marked as such in the tests: agy was
not logged in, so no live envelope could be recorded. Usage arithmetic
follows every documented example: `total_tokens` is
`input_tokens + output_tokens` with `input_tokens` including the
cache-read count and `thinking_tokens` outside the total entirely, so the
normalized block reports uncached input as `input - cache_read`, keeps
the read count as `cached_input_tokens`, and takes the total as reported
— the three normalized fields sum to the total agy itself reports. The
version floor is 1.2.14 with `maxAudited` 1.2.14: there is no earlier
audited release, so anything older is refused rather than assumed.

**Cursor's entry points, and the desktop opt-in.** The desktop `cursor`
CLI ships the agent as a subcommand (Cursor 3.23.12 here; `cursor agent
--help` is byte-identical to `agent --help` apart from the usage line),
but the adapter's default is exactly 0.6.0's: resolve the standalone
`agent` first, then the legacy `cursor-agent` alias; neither found means
"not installed", and the desktop `cursor` is not consulted at all. The
desktop wrapper's `agent` subcommand is not a pure forward: the
Cursor.app 3.23.12 launcher downloads and runs
`https://cursor.com/install` when `~/.local/bin/cursor-agent` is
absent and runs `cursor-agent update` when the installed build is older
than it wants, before exec-ing that same `~/.local/bin/cursor-agent`.
An earlier draft of this addendum ranked the desktop first by probing
`cursor agent --help`; the round-2 review flagged that probe twice —
`list`, `doctor`, and `verify` could download and execute an installer,
and a repository-local `cursor` on PATH executed outside the sandbox
during discovery, before the launch's trust check (which knows the run's
`--cwd`) could refuse it. Round 2 demoted the desktop entry to last
resort; the round-3 review found the residue: even last-resort status
let the version gate and the installed-contract suite execute the
wrapper on a desktop-only machine, still outside any sandbox and still
without the operator asking. The desktop entry is therefore opt-in only:
`CODEMUX_CURSOR_ENTRY=cursor` set and the name passed through
(`--pass-env CODEMUX_CURSOR_ENTRY`), with this ledger and the README
carrying the warning that the wrapper may install or update the agent on
first use. The passthrough is the authorization — argv the operator
typed, which neither a repository nor a shell profile can inject — and a
launch that selects the desktop entry without it is refused before the
version gate could execute anything. Under the opt-in, the trust check
applies to the `cursor` binary resolved against the requested working
directory, and the gate probes `cursor agent --version` only after that
check, only inside the launch path; `isAvailable`, `list`, `doctor`,
`verify`, and the installed-contract suite never execute the desktop
entry either way. Verify additionally constructs its adapters against an
explicitly empty environment view (the registry's `getAdapter` takes the
view; see STATIC_WIRING_ENV in src/verify.ts), so an exported
`CODEMUX_CURSOR_ENTRY` does not even select the desktop entry there — a
static wiring result never depends on the operator's shell.

`cursor --version` reports the desktop app's semver (3.23.12) rather
than the agent build (2026.08.11-e8db854), so the cursor contract picks
its version-probe arguments per resolved entry — by entry name, never by
the executable's basename, because the gate probes the canonical path
and the standard Homebrew `cursor` symlink resolves into the app bundle
as `code`; a basename-keyed selector probed the desktop semver, missed
the calendar pattern, and warned past the floor even for a below-floor
agent build (`cursor agent --version` through the desktop, plain
`--version` for the standalone entries).

## 2026-10-04 addendum: 0.7.0 dead-surface cut

The harnesses whose `--hermetic` and `--tools none` are both refused —
Copilot, Gemini CLI, Cline, OpenHands, Qwen (Cursor never had
machinery) — keep only their refusals. The override and hermetic
machinery the branch had built behind those refusals is removed from
the tree: no provider-override env group is read for the five, no
per-run data directories, BYOK settings files or system-settings files
are written for them, and their plain-run commands are unchanged
(OpenHands still selects a model through `--override-with-envs` +
`LLM_MODEL`; copilot still carries `--no-custom-instructions` always
and `--disable-builtin-mcps` below high autonomy).

The entries this ledger keeps for those harnesses remain valid as the
refusals' evidence: the 2026-09-17 live checks rode the now-removed
overrides, and the source findings they recorded — cline's hub daemon
dropping a settings file's base URL, copilot's BYOK group activating
before GitHub authentication, gemini's root-ownership walk over the
system-settings layer, qwen's safe mode zeroing `--core-tools` — are
upstream behavior, not codemux machinery. `maxAudited` is unchanged and
the installed-contract entries are unchanged from 0.6.1.

Two harness-behavior notes from the same round: OpenCode's login-state
inspection reads `opencode.db` through `bun:sqlite` (the pinned runtime
floor, Bun 1.3.14, has no `node:sqlite`) with the same fail-closed
refusal, and the 1.18 docs corroborate the design — remote config is
"fetched automatically when you authenticate with a provider that
supports it", first in the precedence order, with no documented switch
gating either fetch (opencode.ai/docs/config). Pi's provider-override
model entry declares `reasoning: true`: pi 0.85.1 defaults a custom
model's reasoning to false, which clamps the `--thinking` flag
`--effort` maps to off.

## 2026-10-07 addendum: provider overrides for Claude Code, Codex, and OpenHands; token caps

Three harnesses gain a provider override (`CODEMUX_<AGENT>_PROVIDER_{
BASE_URL,API_KEY,MODEL}`, the same shape every supporting harness reads),
and with it two optional caps,
`CODEMUX_<AGENT>_PROVIDER_MAX_OUTPUT_TOKENS` and
`CODEMUX_<AGENT>_PROVIDER_MAX_CONTEXT_TOKENS`. The OpenHands override is
the 0.7.0 cut restored: its `--override-with-envs` channel now has a
non-refusal purpose (model selection), so the override rides the same
mechanism — `LLM_BASE_URL`/`LLM_API_KEY`/`LLM_MODEL`, read by
`LLMEnvOverrides.from_env` (`agent_store.py` at 1.16.0) with litellm's
`openai/` model prefix; that trio is the entire surface the flag reads, so
both caps are refused for OpenHands. The channel that delivers the key also
exposes it: OpenHands' terminal tool (both the subprocess and the tmux
implementation) builds the shell's environment from the CLI process's own,
and the sanitizer in between strips only `SESSION_API_KEY` (`sanitized_env`
in openhands.sdk at CLI 1.16.0, verified 2026-10-07), so `LLM_API_KEY` is
visible to any command the model runs — codemux warns at launch, and the
key should be scoped and revocable (README). An override exported for a harness
without support (Z.AI, Antigravity, Cursor, the four cut ones) now fails
the run before launch instead of being ignored.

**Codex and the `wire_api` floor.** The override's config.toml always
writes `wire_api = "responses"` under a synthesized
`model_providers.codemux` entry: the `WireApi` enum in codex-rs
(`model_provider_info.rs`) has carried only the `Responses` variant from
the configurable-providers work (0.130) through 0.160 — "chat" was never a
selectable value on any release in codemux's supported range (floor
0.146.0) — so a Responses-capable endpoint is a hard requirement of the
override. Two cap findings from the same source: `model_context_window`
is the context cap and rides the override's config, and no
output-token cap key has ever existed — `model_max_output_tokens` appears
nowhere in the config reference or the source through 0.160 (the keys the
reference lists around it are `model_context_window`, `model_reasoning_effort`,
`model_verbosity`), so `MAX_OUTPUT_TOKENS` is refused for Codex with that
evidence. `--ignore-user-config` is never passed on an override run: the
0.160 binary's own help text says it skips `$CODEX_HOME/config.toml`
itself — the file the override lives in ("auth still uses CODEX_HOME", so
the skip was never needed to keep the key out). The run owns a private
per-run `CODEX_HOME` holding the config (0600) and no `auth.json`; the key
rides `env_key`-named environment codemux provides. One more codex key is
written conditionally: `CODEMUX_CODEX_PROVIDER_MULTI_AGENT=off` adds
`features.multi_agent = false` (the persistent form of `--disable
multi_agent`, which the binary's help documents as
`-c features.<name>=false`), because codex 0.160's subagent feature is on
by default and puts a grouped `namespace` tool (`multi_agent_v1`) in every
Responses request — an endpoint whose Responses validator does not
implement namespace tool grouping (vLLM 0.12's, verified 2026-10-07)
rejects the tool with a 400, and the opt-out is what lets such an endpoint
serve codex; `on` and unset write nothing, leaving codex's own default in
force, and the knob fails the run when set without an override. See
docs/HERMETIC.md's private-home section for the home lifecycle.

**Claude Code.** The override routes through the gateway variables the Z.AI
endpoint already uses — `ANTHROPIC_BASE_URL` plus `ANTHROPIC_AUTH_TOKEN`
(generalized into `src/claude-family.ts`; the Z.AI adapter is unchanged in
behavior) — with the model on `--model`, so the endpoint must serve the
Anthropic Messages API (`/v1/messages`), not only OpenAI-compatible chat
completions. The operator's login plays no part: the sandboxed Keychain
credential-mirror sync is skipped, `ANTHROPIC_API_KEY` and
`CLAUDE_CODE_OAUTH_TOKEN` are kept out of the child environment, and a
mirror still holding a refresh token still refuses the launch (the child
reads `~/.claude` whatever credential it runs on). The output cap rides
`CLAUDE_CODE_MAX_OUTPUT_TOKENS`; Claude Code exposes no context-window
variable (only that one, verified against the installed 2.1.280 binary),
so `MAX_CONTEXT_TOKENS` is refused with that evidence.

Per-harness cap channels, for the record: OpenCode `limit.output`/
`limit.context` on the override's model entry (the schema's limit object
requires both, `additionalProperties` false, so a one-sided cap is refused
rather than half-written); Kimi `KIMI_MODEL_MAX_COMPLETION_TOKENS`/
`KIMI_MODEL_MAX_CONTEXT_SIZE` (`KIMI_MODEL_MAX_OUTPUT_SIZE` is a different
unit — bytes of output — and is deliberately unused); Droid
`maxOutputTokens` on the BYOK entry (no context field exists in the BYOK
schema, docs.factory.ai/model-independence/byok, so the context cap is
refused); Pi `maxTokens`/`contextWindow` on the model entry; Aider and
Goose refuse both (aider 0.86.2 has no max-tokens flag —
`--max-chat-history-tokens`, `--thinking-tokens` and `--map-tokens` cap
other budgets — and goose's per-model `max_tokens`/`context_limit` live
only in the config file the override never writes).

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
