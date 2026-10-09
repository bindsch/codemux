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
(`codemux session` is the live-sessions surface that carries one).

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

## 2026-10-05 addendum: live sessions

`codemux session` (the live-sessions design, docs/LIVE-SESSIONS-DESIGN.md)
drives four harnesses through one JSONL protocol: Claude Code, Z.AI,
Codex, Antigravity. Session floors sit at or above the run floors
because the contracts only sessions exercise are only audited down to
these builds: Claude Code and Z.AI 2.1.280, above the run floor (the
audited `--permission-prompt-tool` build; the run contract's 2.1.220
admits pre-hardening builds), Codex 0.159.3, above the run floor (the
build the app-server method table below was recorded against), and
Antigravity 1.2.14, equal to the run floor (the audited release; no
earlier one exists). An unreadable version is refused on the session path like a
below-floor build (review live9): a session holds a resumable process
open behind a floor the design calls the pre-hardening boundary, so a
wrapper whose `--version` prints nothing parseable cannot slide past it
with a warning — `CODEMUX_ALLOW_UNTESTED_HARNESS=1` overrides, as
everywhere. A floor is itself an audited build, so it raises the audited
ceiling with it (review live10): a version at or below the floor never
warns `unaudited`, and the warning starts only above it — before this
correction every valid claude-family session printed a false
`unaudited` warning, because the floor 2.1.280 sat above the run
contract's audited ceiling (2.1.223) while being precisely the audited
session build. The floor can never lower either boundary. Wire facts
are pinned by the step-0 fixtures
(tests/fixtures/live/, recorded 2026-10-04/05), and the e2e suites drive
fakes generated from those same shapes so the parsers cannot drift from
the recorded reality.

The session capability matrix, honestly false where a harness lacks a
channel (a false flag means the input is rejected by name, never
accepted and ignored):

| Capability | Claude 2.1.280 | Z.AI (same binary) | Codex 0.159.3 | Antigravity 1.2.14 |
|------------|----------------|--------------------|---------------|--------------------|
| `live_input` | true | true | true | true |
| `user_during_turn` | false (rejected `busy`; print mode folds a mid-turn message into the running turn or runs it as its own, by the turn's shape) | false (same) | `queue` | false (rejected `busy`) |
| `steer` | false (no on-demand carrier) | false (same) | true (`turn/steer`) | false |
| `interrupt` | true (control request) | true | true (`turn/interrupt`) | false (`--turn-timeout` refused) |
| `permissions` | true (stdio control round-trip) | true | true (server requests) | false |
| `deltas` | true (`stream_event`) | true | true (`item/agentMessage/delta`) | false |
| `file_changes` | derived from tool calls | derived | `native` item type | false |
| `usage_stream` | false (usage only in the turn's `result`) | false (same) | true (`thread/tokenUsage/updated`) | false (usage only in the result) |
| `resume` | true (`--resume <uuid>`) | true | true (`thread/resume`) | true (`--conversation=<id>`) |

**Codex app-server, pinned at 0.159.3.** One dedicated `codex
app-server` process per session, never the shared daemon — a singleton
escapes per-session sandbox and account boundaries. The method
allowlist codemux sends is exactly `initialize`, `notifications/
initialized`, `thread/start`, `thread/resume`, `turn/start`,
`turn/steer`, `turn/interrupt`; never `fs/*`, `remoteControl/*`,
`thread/realtime/*`, `thread/queue/*`, `turn/settings/update`,
`command/*`, `process/*`, or `review/start`. Requests carry `jsonrpc`
while responses omit it; `thread/started` arrives exactly once after
the thread/start response (whose result also carries the thread
object) — but NOT after `thread/resume`: the resumed thread is
announced through the response's own thread object and no
`thread/started` follows (live-proven 2026-10-05 on 0.159.3, review
live11 — the notification stream after a resume is
`remoteControl/status/changed`, a deprecation notice,
`account/updated`, mcp startup statuses, and `thread/status/changed`
idle, plus a cumulative `thread/tokenUsage/updated`; no
`thread/started`), so codemux adopts the id from the response — checking
that it echoes the requested id, with a mismatch failing closed (one
fatal naming both ids, review live12). A late `thread/started` passes
through as tier-1 unknown only when it is the first one this session
has seen and names the adopted thread; a second one, or one naming a
different thread, is a tier-2 fatal (the exactly-once rule, review
live19);
`turn/started` follows the turn/start response and its turn
object's id must match; usage arrives only through
`thread/tokenUsage/updated` with `total` (cumulative) and `last`
(per-turn delta) — `turn/completed` carries none, and the update can
arrive after it, even after the next turn's turn/start response; such a
straggler (or a late item or delta naming the closed turn) is accepted
with a null `turn_id` and its usage counts toward the session only
(review live20); items are
userMessage/agentMessage/delta. Every thread start and every turn
start carries the explicit sandbox/approval policy pair (`thread/start`
takes strings, `turn/start` a sandbox-policy object), so a resumed
thread cannot run under a stale policy, and a scode-wrapped session
passes the bypass pair at every level because scode is the boundary.
Approval requests arrive as server requests and are answered `{decision:
…}` or `{permissions, scope}`. Thread ids codemux resumes must match
`/^[A-Za-z0-9_-]{8,128}$/` — the fixture's ids are UUIDv7-shaped. The
thread-level `config` object carries only the project-doc overrides
(`project_doc_max_bytes: 0`, empty fallback filenames) that skip AGENTS.md
discovery — it is not the app-server equivalent of `exec`'s `--ignore-rules`
flag: execpolicy rules (`~/.codex/rules`) have no verified carrier, so a
codex session still loads them where a run does not (known parity gap,
review live3; unreachable through any launchable session today — every
one runs `approvalPolicy: "never"` inside scode — but recorded here
because `run`'s boundary flag does not carry over).

**Claude Code stream-json, pinned at 2.1.280** (frames recorded
through the Z.AI endpoint — same binary, same wire format; only the
billing changes). The spawn is `-p --input-format stream-json
--output-format stream-json --verbose --include-partial-messages
--permission-prompt-tool stdio --replay-user-messages` plus
`--session-id <uuid>` (fresh; codemux mints the id so the registry
knows it before the wire does) or `--resume <uuid>` (first, before
every autonomy-derived flag, so a session created at high and resumed
at read-only emits exactly read-only's flags). `--verbose` is required
for stream-json output. `system/init` arrives once per turn with the
same `session_id`; a resumed session reports the same id with no
`resume` marker on the wire, which is why resume trust comes from the
registry, not the stream. The first init is emitted only once stdin
input arrives — a caller that waits for `session_started` before
submitting its first line deadlocks (verified live 2026-10-05: an idle
stream-json child emits nothing for minutes, and the frame after the
first user line is init itself, preceding the replay echo). Permissions round-trip through the stdio
carrier: a `control_request` with `request.subtype:"can_use_tool"`
carrying `tool_name`, `input`, `permission_suggestions`,
`decision_reason`, answered on stdin with a `control_response`
(`behavior:"allow"` or `"deny"`). Every allow carries `updatedInput`:
the caller's substitute when it sent one, else the request's own
`input`, because the harness runs the tool with that object (review
live18). Without the
carrier a write outside the allowed directories is auto-denied and
surfaces as `system/permission_denied` with no request at all.
Interrupt is a control request with `request.subtype:"interrupt"`; an
error result arriving with an interrupt outstanding is an interrupted
turn, not a failed one. A clean result that races the interrupt
completes its turn with `finish: "end"`, and the interrupt is spent:
the harness reads it idle and drops it, so the next turn is never
relabeled by it (review live21 removed the live12/live20 roll, which
assumed a forwarded mid-turn line was waiting harness-side).
`--replay-user-messages` makes the harness echo the user frames codemux
submits (`isReplay: true`, the round trip the protocol's echo is pinned
against). The echo also shows when print mode consumed a mid-turn line:
at the running turn's next model request, folded into that turn's
result, or after the result as a turn of its own when no further
request comes (fixture `zai-session-a.ndjson`, lines 34/59/74; live21
probes). Since codemux cannot tell in advance which, a mid-turn `user`
line is rejected `busy`. Session high autonomy never passes
`--dangerously-skip-permissions`: it is `--permission-mode default`
plus an explicit grant list, so the resume ladder's low→high move
narrows reach on every build the floor admits.

**Z.AI sessions** run the same binary against the Z.AI endpoint
through the adapter's environment (`ANTHROPIC_AUTH_TOKEN`/
`ANTHROPIC_BASE_URL`), so the floor, parser, and argv are the claude
ones verbatim. Transcripts live under the same `~/.claude` (or
`CLAUDE_CONFIG_DIR`) a claude session uses; the replay hazard that
creates (a claude-home session resumed through zai replays the
transcript to the Z.AI endpoint) is closed by the registry's agent
match at resume, not by splitting the home.

**Antigravity at 1.2.14 is documented, not live-verified.** The audit
machine's agy login is expired and re-login is interactive, so the
only live frame ever recorded is the auth-failure result
(`conversation_id` empty, `status "ERROR"`). The contract below rests
on that fixture, the 1.2.14 help text, and the official headless
documentation, and the e2e suite drives a fake built from the same
shapes — marked as such in the tests. The session loop is
`--disable-slash-commands --input-format=stream-json
--output-format=stream-json` with the `=`-form enum flags the 1.2.14
parser requires, autonomy mapped exactly as the run path maps it, and
`--conversation=<id>` riding last on resume. There is no init frame:
a fresh session names its conversation only in the first result
envelope, so `session_started` waits for that result and events before
it carry an empty session id; a first result that names no usable id
ends the session (an untracked live session must not run). Because that
first turn runs before the record can exist, the CLI checks that the
registry can be written before it spawns agy (review live22). Input lines
are claude-style user frames; output is the `{"event":"result",
"result":{…}}` envelope parsed by the run path's own envelope parser,
so run and session cannot disagree about what a result is — and that
parser's rule that any present `error` string, empty included, marks
failure is part of the contract. The conversation-id pattern is
deliberately permissive (`/^\S{1,128}$/`): no live id was ever
observed, and the registry's agent/home/autonomy match is what vouches
for a resume, not the id's shape. The resume-autonomy ladder is strict
for agy — `read-only < low < medium < high`, nothing above creation
(review live9): agy has no permission channel, so low's caller approves
nothing and passes no mode flag, which makes low the least reach where
the claude-family order puts it first.

## 2026-10-07 addendum: OpenCode and Aider sessions; overrides in sessions

`codemux session` grew two turn-per-process harnesses — OpenCode and
Aider — and provider overrides now reach every session-capable harness's
spawn. Session floors: OpenCode 1.18.18 and Aider 0.86.2, both equal to
the run floors (the audited releases; the session contracts rest on the
same builds the run contracts do, so no earlier build is admitted). Both
follow the unreadable-version rule above: a wrapper whose `--version`
prints nothing parseable is refused like a below-floor build.

**OpenCode, pinned at 1.18.18.** One `opencode --pure run --format
json` process per caller input: the run wire is a one-shot JSON-line
stream (one object per line: `{type, timestamp, sessionID, …}`), the
prompt is the whole stdin read to EOF, and the process exit ends the
turn. The harness owns session identity: a fresh session's id (`ses_` +
8–64 alphanumerics) is minted in the first output line of the first
turn, so codemux adopts the id from any output line — `session_started`
waits for it and events before it carry an empty session id; a first
turn that exits naming no id ends the session (an untracked live session
must not run). Because that first turn runs before the record can exist,
the CLI checks the registry can be written before it spawns the first
turn (the agy rule). Later turns pass `--session <id>`, and every line
naming a different id is a tier-2 grammar violation (raw mirrored, then
fatal). The turn verdict is the exit code; a resumed-but-never-confirmed
session with a clean end is still resumable (the claimed record stands),
while a crash end without confirmation is not. Usage arrives only in
`step_finish` parts — the tokens and the dollar `cost` ride inside the
`part` object of the line (`{type, timestamp, sessionID, part}`), never
at the line's top level — and each part's cost is that step's own: the
binary runs `assistantMessage.cost += step.cost`, so codemux sums step
costs into the turn and turn costs into the session cumulative, never
adopting a latest value (review D2, contracts). A wrapper that re-exits
the shutdown SIGTERM as code 143 is the
signal's coded spelling, not a failure (the drain rule the other
drivers follow; live-proven against the fakes' `exit143` mode). A
graceful end (stdin close, `shutdown`) that begins while the turn's
process is still spawning delivers the prompt itself and drains the
turn to completion; only a signal, timeout, or crash end stops a late
child on arrival (review D11).

**Aider, pinned at 0.86.2.** No event protocol exists headlessly, so the
session is a turn-per-process loop over aider's own chat history: each
turn spawns one `aider --message=<prompt> --restore-chat-history
--chat-history-file <path>` process (with canned `n` confirmations on
stdin), and the state that carries across turns is exactly the history
file plus aider's own summarization on top of it. Codemux mints the
identity — a UUID — and owns a private per-session directory
(`~/.aider/.codemux/sessions/<id>/history.md`), created before the
harness ever runs, with every path component from `.codemux` down
lstat-checked first — `~/.aider` is writable by the sandboxed child,
so a planted symlink at an intermediate must never aim the creation,
the sweep, or the record-failure removal (review D4); a resume finds
the file gone fails before any turn
(`the resumed conversation is not recoverable`). The check also runs
before EVERY turn spawn — the chain plus an lstat of the file itself
(regular, not a link, owned by the invoking user, mode 0600), because
the creation-time check and the post-turn `O_NOFOLLOW` read left the
between-turns window where a swapped symlink would be followed by the
next turn's aider itself; a trip fails the turn, never the session
(review D7). Every stdout line is a
human transcript, so all of it is tier-1 passthrough and the turn
verdict is computed from the exit code plus the history delta: the
reply is the text aider appended after this turn's `#### <prompt>`
header (multi-line prompts anchor correctly — every prompt line carries
its own `#### `, split exactly as Python's `str.splitlines` splits,
trailing empty element dropped, so a prompt ending in a line break
anchors the same block as one without it; earlier code leaked the
continuation lines), a clean exit with no new exchange fails the turn
(the session survives), and a history file that shrank below what
codemux consumed ends the session — the state is unreliable, so the
session cannot continue. The read-back is bounded per TURN, not per
file: the driver reads only the delta past a byte offset that advances
with each turn, so a session's history — which accumulates every
exchange — has no size limit from codemux's side (aider's own
`--max-chat-history-tokens` compaction governs it), while a single
turn's delta larger than one run's whole history fails closed (review
D8: the run read's whole-file bound once refused every session past
it). A prompt whose first non-whitespace character is `/` or `!` is
refused on both surfaces — the run path at validation (exit 64, a
usage refusal), the session path before the ack (`input_rejected`,
`unsupported`) — because aider's `preproc_user_input` dispatches those
as its own commands before any model turn, and `!` (the `/run` alias)
executes the shell immediately, ungated by `--dry-run` (review D10).
A turn killed partway leaves the history half-written — aider writes
the `#### ` user block at the turn's start (io.user_input) and the
reply only at the turn's end — so that session's end is not resumable:
a resume would replay the unanswered prompt (review D10). The
opencode late-child rule is aider's too: a graceful end that begins
while the turn's process is still spawning writes the canned negatives
itself and drains the turn to completion, so the history records the
full exchange and the end stays resumable; only a signal, timeout, or
crash end stops a late child on arrival (review D11). Aider reports
no usage headlessly: the session
totals stay null. An override maps to litellm's `openai/` prefix with
the weak model on the same endpoint (aider's ChatSummary runs through
it), and a token cap on a session is refused before spawn with the run
path's own message — aider 0.86.2 has no carrier for either cap.

**Overrides in sessions.** Every session-capable harness routes its
session spawns through the same adapter seams `run` uses
(`prepareRun`/`getRunEnv`/`wireModelFor`), so `CODEMUX_<AGENT>_
PROVIDER_*` (caps and codex's `MULTI_AGENT` knob included) applies to a
session's turns identically. OpenCode's session keeps the real data
directory (the override swaps the provider, never the store a
`--resume` reads) and carries the wire model as `codemux/<model>`; the
per-turn provider config is written fresh before every turn (one file
per turn process, the run path's own rule — the file lives in the
child-writable data directory, so a config cached at the first turn let
one turn's child rewrite what the next ran with; review D3), after
every startup refusal. Codex's override session owns a home keyed per
session
(`~/.codex/.codemux-provider/session-home-<sha256 of the base URL, first
12 hex>-<thread id>`) whose config.toml is rewritten atomically at every
session start — the sandboxed child can write the parent, so the write
never follows a planted symlink, and the write re-asserts the home
directory itself (a resumed home's open-time check can go stale across
the registry claim; review D7) — and never shared with another session,
with model selection owned by the config (thread/start carries no
model) — a run's per-run home would orphan a session's threads at every
turn. A resumable end keeps the home (it is the resume state) and
settles it onto its key BEFORE the registry record is released — the
release is what a `--resume` in another process waits on, and a record
released ahead of the rename was refused "missing or untrusted" in the
window between them (review D7); any other
end of a FRESH session removes it; a resumed session's home is never
removed at settlement (its state predates the resuming process, so a
failed or interrupted resume must not delete the earlier turns with it —
review D3), and a codemux that dies mid-session leaves it to a 28-day
sweep that never takes a home the session registry holds live — the
sweep fires from any codemux codex run, and age alone would delete a
resumed session's home out from under its running app-server (review
D4) — and that spares every home when the registry cannot be read: a
deletion needs a positive free answer, never an unreadable registry's
silence read as "not held" (review D5). The sweep's freshness walk is
bounded: a run-shaped entry's pid gate comes from its name (no walk for
a live run), the walk carries an entry cap, and an over-budget tree —
`~/.codex` is child-writable, so a child can plant a huge one — is
spared rather than walked (review D7), except a run directory past its
pid gate, which falls back to the directory's own mtime so a dead
run's huge tree is reclaimed by age instead of leaking (review D9), and
so does a session home the registry has POSITIVELY freed (the ownership
proof the pid gate provides), while every other over-budget home keeps
the D7 spare — and a home young by its own mtime, or under a held or
unknown id, is spared before any walk at all (review D10). A resume's
own open spares its keyed entry from that sweep: the registry answers
`free` for an ended record — the removal condition — so the sweep
inside the open once deleted the home the resume had just been granted
past every guard (review D10).
Every session record carries its provider identity — the
override's base URL in its identity form (query and fragment stripped,
so a rotated query key neither forks the identity nor writes the key to
the record; review D10), or operator login when none — and `--resume`
refuses a mismatch with exit 78: a transcript recorded on one endpoint
never replays on another.

## 2026-10-08 addendum: the per-call usage ledger

Every completed call now writes one JSON line to a per-call ledger
(`src/call-log.ts`; `codemux calls` reads it back — README "The call
ledger"). The structured-output flags the envelope path already pinned are
now on every plain run of the harnesses that support one, so the unwrap
(not the caller's flags) is what turns structured stdout back into the
plain reply: Claude Code and Z.AI `--output-format json`, Antigravity
`--output-format=json`, OpenCode `--format json` (the run wire the session
driver parses at 1.18.18; `parseOpenCodeRunLine`). OpenCode's reply is
spelled as its run command's plain mode prints it (upstream v1.18.18:
each completed text part trimmed on its own line, empty parts skipped,
everything else on stderr), and its event stream is never captured whole:
the stream carries every tool's output on the tool parts (the same volume
that keeps codex off `--json`), so the launcher feeds it through a
streaming fold (`OpenCodePlainFold`) that keeps the reply text and folded
usage alone — tool parts dropped as they arrive — and the output bound
measures that residue, not the stream. Codex plain runs are the exception:
the
`--json` event stream carries every event with all tool output, so an
agentic run's stream passes the 16 MiB output bound and dies with the
reply lost — plain codex runs keep human mode and their usage is the
blended `tokens used` figure on stderr (`print_final_output` in codex-rs's
human event processor; `total_tokens` alone, the figure is
(input − cached) + output). Stdout that carries no line of the structured
wire passes through verbatim — the escape hatch for older binaries and
wrappers — and the ledger then records null usage rather than a guess; a
structured stream that arrives broken (an unparseable or cut-off line
among opencode's wire lines, a claude-family or Antigravity stdout that
is JSON but not a parseable envelope — any JSON value, an array
included, or an object cut mid-write) never passes through — the text
and usage folded so
far stay and the break becomes a stderr diagnostic.

What each harness's records can carry:

| Harness | Usage the ledger sees | Cost | Effective model |
|---------|----------------------|------|-----------------|
| Claude Code, Z.AI | envelope block (input, output, cached, computed total) | `total_cost_usd`; session turns keep null and the closing session record adopts the final figure (the claude-family session rule), which `calls --sum` folds in per field — a resumed session's several closings fold to the newest one | `modelUsage` on single-model runs |
| Codex | `--result-json` runs: event-stream block (uncached input excludes both cache breakdowns, per the 2026-10-03 pin). Plain runs: the stderr `tokens used` figure, `total_tokens` alone | null | only a mid-run reroute item (`--result-json` runs) |
| Antigravity | envelope block (raw input includes cache reads; the parser splits them) | null | null |
| OpenCode | `step_finish` tokens and cost, summed within the run or turn (streamed: the plain-run fold keeps the reply text and usage alone, so what the tool events carried is not kept anywhere) | the cost the endpoint reports; the local vLLM override gateway in the 2026-10-08 live run reported real token counts and a zero cost (a reported zero, not a missing figure) | null |
| Aider | nulls — the headless `--message` wire prints no usage | null | null |
| all others | nulls — plain-text stdout, no structured mode | null | null |

The ledger's `provider` field names an override by its base URL host
only, never its key; the record set is fixed (`ts`, `kind`, `agent`,
`model`, `model_effective`, `provider`, `session_id`, `turn_id`,
`autonomy`, `hermetic`, `sandboxed`, `exit_code`, `finish`,
`duration_ms`, `cwd`, `usage`) so no prompt text can ride along.

## Version enforcement

`src/harness-compatibility.ts` is the machine-readable half of this ledger and
is checked before every launch. Keep the two in step: the table above records
what was reviewed, the matrix records what the CLI enforces.

Refusing a version requires a determined breaking change, not a version bump.
Upstream ships patches that change nothing, and refusing those would make
Codemux unusable, so anything newer than `maxAudited` runs with a warning.
Sessions carry their own floors above the run contracts, and a session
floor counts as an audited build: the `unaudited` warning starts above
the floor, never at it, and the floor cannot lower the refusal point or
the ceiling (review live10).
An unreadable version warns and continues on the run path (wrapper scripts
and vendored builds are real) but is refused on the session path, where the
floor is the contract being enforced (review live9); copilot's
`unknownVersion: "refuse"` pins the same refusal for runs, because every
copilot release at or above its floor answers its probe.

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
