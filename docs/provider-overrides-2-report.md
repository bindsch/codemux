# Provider overrides round 2 — build report

Branch `provider-overrides-2`, 2026-10-07. Adds provider overrides for
Claude Code, Codex, and OpenHands, output/context token caps for every
override-capable harness, and the loud-refusal rules that keep the
capability honest. Worktree `~/Programming/Ops/codemux-overrides`; not
committed (`git add -A` only).

## What shipped

- `CODEMUX_CLAUDE_PROVIDER_{BASE_URL,API_KEY,MODEL}` — Claude Code routed
  through `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` (the mechanism the
  zai adapter already used, generalized into `src/claude-family.ts`; zai
  is unchanged), model via `--model`.
- `CODEMUX_CODEX_PROVIDER_*` — a per-run private `CODEX_HOME` (reusing
  `src/hermetic-home.ts`'s parent/sweep machinery) whose `config.toml`
  carries `model_provider`, `model`, and a synthesized
  `model_providers.codemux` entry (base URL, `env_key`, `wire_api =
  "responses"`); the key rides the environment the `env_key` names, never
  a file or argv. New module `src/codex-provider.ts`.
- `CODEMUX_OPENHANDS_PROVIDER_*` — the 0.7.0-cut override restored behind
  `--override-with-envs` (`LLM_BASE_URL`/`LLM_API_KEY`/`LLM_MODEL`,
  litellm's `openai/` model prefix), the same channel the adapter's model
  selection uses.
- `CODEMUX_<AGENT>_PROVIDER_MAX_OUTPUT_TOKENS` /
  `..._MAX_CONTEXT_TOKENS` for every override-capable harness
  (`src/provider-override.ts`).
- `codemux list` marks supporting harnesses `provider`; `codemux doctor`
  prints a Provider override line; an override exported for a
  non-supporting harness fails the run before launch
  (`assertNoUnsupportedProviderOverride` in both base validators).
- Docs: README's provider-override section (mechanisms, API requirements,
  cap table), docs/HERMETIC.md (claude mirror-sync skip, codex private
  home under override, OpenHands row un-cut), docs/HARNESS-COMPATIBILITY.md
  2026-10-07 addendum (wire_api floor, cap refusals), CHANGELOG under
  `## [0.8.0]` (package.json is 0.8.0; the gate logs quoting 0.7.1 below
  predate the bump).

## Design decisions

1. **The claude login plays no part under the override.**
   `ClaudeAdapter.prepareSandbox` skips the Keychain credential-mirror sync
   entirely — nothing of the operator's login is copied for a run that
   does not use it. The mirror's own guard stays: a mirror that still
   holds a refresh token still refuses the launch, because the sandboxed
   child reads `~/.claude` whatever credential it runs on. The operator's
   `ANTHROPIC_API_KEY` and `CLAUDE_CODE_OAUTH_TOKEN` are omitted from the
   child environment (no second, operator-funded credential path), while
   the sanitizer keeps the adapter-provided gateway variables and
   `--hermetic` still closes every operator channel.
2. **Codex override runs own their whole config.** The operator's
   `config.toml` is never read — by construction, not by flag: the private
   `CODEX_HOME` holds the only config the run can see. That is strictly
   more hermetic than a plain run (MCP servers, profiles, and hooks from
   the operator's config do not load), and it is the documented cost.
   `auth.json` is never linked: the provider key is the credential, so the
   operator's login is neither read nor rotated. `--ignore-user-config`
   is not passed on override runs because the binary's own help text says
   it skips `$CODEX_HOME/config.toml` itself — the file the override
   lives in.
3. **`wire_api = "responses"` unconditionally.** The `WireApi` enum in
   codex-rs has carried only the `Responses` variant from the
   configurable-providers work (0.130) through 0.160; "chat" was never
   selectable in codemux's supported range (floor 0.146.0). A
   Responses-capable endpoint is therefore a hard requirement of the
   override, documented in README and the compatibility addendum.
4. **Caps are honest or loud.** A cap is applied only through a channel
   the harness actually reads; where none exists the run fails before
   launch with the evidence (see "Refusals"). A cap set without an
   override fails too — a cap sizes a provider the override names. Codex's
   model rides the `config.toml`, never `-m`, so the two cannot disagree.
5. **TUI policy.** Codex, Droid, Pi, and OpenCode overrides support
   headless runs only — their per-run config files ride the launch
   lifecycle — and `codemux tui` refuses them. Claude Code, OpenHands,
   Aider, Kimi, and Goose carry the override into the TUI (environment
   delivery only).
6. **No maxAudited bumps.** The ledger still reads claude 2.1.223 / codex
   0.147.0; the runs below exercised the override paths at 2.1.280 /
   0.160.1 but no full adapter contract, and the claude run did not
   complete (gateway limitation, below). The "newer than audited" warning
   stays. Conservative on purpose.
7. **The session seam.** Override resolution stays
   `readProviderOverride(agent, environment)` — a pure function a future
   `codemux session` spawn can call (documented in
   `src/provider-override.ts`'s header). No session machinery was added.

## Live acceptance

Endpoint: the local vLLM 0.12.0 at `http://localhost:8011`
(`/v1/models` → `clawvm-qwen32b-coder`, `max_model_len` 32768). The key is
a synthetic per-run value exported in the environment and never printed;
it appears in no stdout, stderr, or argv capture below (checked with
`grep -c "$KEY"` on every capture: always 0). Every command ran the
worktree CLI: `bun --no-env-file --no-install --config=./bunfig.runtime.toml
run src/index.ts run …` from the worktree root.

| # | Case | Command (key redacted) | Exit | Reply |
|---|------|------------------------|------|-------|
| 1 | claude override | `CODEMUX_CLAUDE_PROVIDER_BASE_URL=http://localhost:8011 CODEMUX_CLAUDE_PROVIDER_API_KEY=<redacted> CODEMUX_CLAUDE_PROVIDER_MODEL=clawvm-qwen32b-coder … run -a claude --auto high -p "Reply with exactly the word OK"` | 1 | `API Error: 400 [{'type': 'literal_error', 'loc': ('body', 'messages', 1, 'role'), 'msg': "Input should be 'user' or 'assistant'", 'input': 'system', …}]` — routed (see note A) |
| 2 | codex override | `CODEMUX_CODEX_PROVIDER_BASE_URL=http://localhost:8011/v1 … run -a codex --auto high -p "Reply with exactly the word OK"` | 1 | stderr: `model: clawvm-qwen32b-coder`, `provider: codemux`, then vLLM's 400 on `tools[4]` `type: 'namespace'` — routed (note B) |
| 3 | codex override + `--hermetic` | same + `--hermetic` | 1 | same 400, from the hermetic private home (`provider: codemux`); both `~/.codex/.codemux-provider` and `~/.codex/.codemux-hermetic` empty after the run |
| 4 | opencode override, uncapped | `CODEMUX_OPENCODE_PROVIDER_BASE_URL=http://localhost:8011/v1 … -p "Reply with exactly the word OK"` | 1 | `'max_tokens' or 'max_completion_tokens' is too large: 32000. This model's maximum context length is 32768 tokens and your request has 773 input tokens` |
| 5 | opencode override + both caps | 4 + `MAX_OUTPUT_TOKENS=4096 MAX_CONTEXT_TOKENS=32768` | **0** | `OK` |
| 6 | opencode, 26k-token prompt via `-f -`, capped | 5 with the prompt file on stdin | **0** | `OK`, zero errors |
| 7 | opencode, same prompt, uncapped | 4 with the prompt file on stdin | 1 | `'max_tokens' … too large: 32000. … your request has 26270 input tokens (32000 > 32768 - 26270)` |
| 8 | aider override (regression) | `CODEMUX_AIDER_PROVIDER_BASE_URL=http://localhost:8011/v1 … run -a aider --auto high --cwd <scratch dir> -p "Reply with exactly the word OK"` | **0** | `OK` — `Model: openai/clawvm-qwen32b-coder`, `Tokens: 2.8k sent, 1 received` |

**Note A (claude).** The routing is proven end to end: the reply is
vLLM's own validation error, surfaced through Claude Code's API-error
path — it could only come from `ANTHROPIC_BASE_URL` pointing at
localhost:8011, which only the override set. The 400 itself is a gateway
limitation: Claude Code 2.1.280 sends `system`-role turns inside the
`messages` list (feature gate `mid-conversation-system-2026-04-07`, with
a `CLAUDE_CODE_FORCE_MID_CONVERSATION_SYSTEM` override and no disable
variant — verified with `strings` on the binary), and vLLM 0.12.0's
Messages shim validates roles to user/assistant. Reproduced directly:

- `POST /v1/messages` with `messages:[{user…},{system…}]` → the same
  `literal_error`.
- The same request with `system` top-level → `OK`.

README documents the requirement accordingly. The completion path is
covered by `tests/provider-override-e2e.test.ts` (fake claude → real
server: `/v1/messages`, model, `max_tokens`, bearer key, key never in
argv).

**Note B (codex).** Same story: `provider: codemux` in codex 0.160.1's
own banner can only come from the override's `config.toml` inside the
private `CODEX_HOME`. The 400 is vLLM's Responses validator rejecting
codex 0.160's default multi-agent tool grouping (`tools[4]` is
`{type: "namespace", name: "multi_agent_v1", tools: […]}`; every error
path is under `tools[4]`, tools 0–3 parse). `features.multi_agent` is
"stable; on by default" in the 0.160 config reference, so codemux
disabling it silently would change run semantics — documented as an
endpoint capability instead ("must accept codex's full default Responses
toolset, including the grouped `namespace` tool"). The one codemux path
that removes it (`--tools none`) requires `--auto read-only`, whose scode
`--ro` profile currently fails to apply on this machine (note D), so no
completing codex configuration existed here today. The completion path is
covered by the e2e test (fake codex reading `$CODEX_HOME/config.toml` →
`/v1/responses`, model + `model_context_window` from the config, key via
`env_key`, home removed after the run, no `-m`).

**Note C (opencode).** Cases 4/6/7 are the cap feature's exact before and
after: opencode's default `max_tokens: 32000` exceeds this model's window
(32768 minus input), so every uncapped run 400s; with the cap the same
26k-input request completes. The one-sided-cap refusal is what forces
case 5 to set both variables.

**Note D (environment, out of branch scope).** `scode --ro` and
`scode --strict` fail with `sandbox-exec: sandbox_apply: Operation not
permitted` on this machine (macOS 27.0.0, scode 0.4.1) while
`--trust standard` applies — so every `--auto read-only` codemux/opencode
run is currently unsandboxable here regardless of the override. Separately,
aider's first attempt crashed before any model call: the operator's pipx
aider venv has a broken scipy native extension
(`dlopen … _spropack.cpython-313-darwin.so … '__DATA/__thread_bss' has a
zero-fill section type`), hit through the repo map's pagerank; the
regression run (case 8) used a cwd outside any git repo, where aider
builds no repo map and the run completes.

## Refusals, with evidence

| Harness | Cap | Refusal evidence (in the thrown error) |
|---------|-----|----------------------------------------|
| claude | context | "Claude Code exposes no context-window environment variable (only `CLAUDE_CODE_MAX_OUTPUT_TOKENS`, verified against the installed 2.1.280 binary)" |
| codex | output | "no release Codemux supports reads a `model_max_output_tokens` key — the 0.160 config reference lists `model_context_window` but no output cap, and the key never existed in the source through 0.160" |
| opencode | one-sided either way | "the config schema's model limit object requires both context and output (opencode.ai/config.json, `additionalProperties` false); also set the other `CODEMUX_OPENCODE_PROVIDER_MAX_*_TOKENS`" |
| aider | both | "aider 0.86.2 has no max-tokens flag (`--max-chat-history-tokens`, `--thinking-tokens` and `--map-tokens` cap other budgets) and codemux writes no aider config" |
| droid | context | "droid's BYOK customModels entries carry no context-window field (docs.factory.ai model-independence/byok documents model, baseUrl, apiKey and maxOutputTokens only)" |
| goose | both | "goose's per-model max_tokens and context_limit exist only in its config file, which the override never writes; its environment surface carries no token limit" |
| openhands | both | "OpenHands' `--override-with-envs` reads exactly LLM_API_KEY, LLM_BASE_URL and LLM_MODEL (LLMEnvOverrides.from_env, agent_store.py at 1.16.0), so no output or context cap can ride it" |
| any harness without override support | — | "`<agent>` does not support a provider override; unset `CODEMUX_<AGENT>_PROVIDER_*` … or route through an agent that does" |
| any harness | cap without override | "… is set but no provider override is; a token cap applies only to a provider override" |

Cap channels that do apply: claude `CLAUDE_CODE_MAX_OUTPUT_TOKENS`;
codex `model_context_window`; opencode `limit.{context,output}`; kimi
`KIMI_MODEL_MAX_COMPLETION_TOKENS`/`KIMI_MODEL_MAX_CONTEXT_SIZE`;
droid `maxOutputTokens`; pi `maxTokens`/`contextWindow`.

## Tests and gate

New/changed tests: `tests/provider-override-e2e.test.ts` (3 e2e cases:
fake claude/codex/openhands binaries calling a real local Bun.serve
recorder through the spawned CLI), `tests/provider-override.test.ts`
(caps parsing/refusals, cap-without-override, unsupported-harness rule),
`tests/provider-override-mappings.test.ts` (claude/codex/openhands
mechanism, sanitizer integration, claude sandbox-sync skip + refresh-token
refusal, kimi/droid/pi caps, goose/aider cap refusals),
`tests/opencode-provider.test.ts` (both caps, one-sided refusal).

`make release-gate`: exit 2, blocked at the `contracts` stage by an
environment denial, not by the branch. Everything before it is green —
runtime floor (Bun 1.4.2 ≥ 1.3.14), `sh -n`, typecheck, and the full
suite with coverage: **873 pass / 6 skip / 0 fail, 879 tests across 37
files** (previous reference point: 869 pass / 6 skip / 1 fail before this
branch's tests; +10 tests and the fail — the aider capabilities snapshot
missing `supportsProviderOverride` — fixed). `contracts` then runs 2 pass
/ 1 fail: `installed binaries expose every adapter-required flag` fails
because `copilot --help` cannot extract its bundled package —
`EPERM: mkdir /Users/example/Library/Caches/copilot/pkg/darwin-arm64`. This
session's whole process tree is denied `~/Library` (a plain `ls
~/Library` and `touch ~/Library/Caches/…` both return Operation not
permitted, even from an unsandboxed shell), so no run launched from here
can pass that probe; no copilot code is touched by this branch. The two
other contract tests pass (93 expect() calls). `sandbox-contract`,
`smoke`, `bun audit`, and the frozen-lockfile dry-run never ran (make
stops at the first failure); each was green at 0.7.1 and nothing in this
branch reaches them — rerun `make release-gate` from an ordinary terminal
to close the gate. Every stage after `contracts` was then run directly
and is green: `sandbox-contract` ("scode sandbox contract passed"),
`smoke` (all eight commands, `codemux --version` → 0.7.1, predating the
0.8.0 bump), `bun audit`
("No vulnerabilities found (checked 9 packages)"),
`bun install --frozen-lockfile --dry-run` exit 0, and the closing
`run --help` / `tui --help` checks.

`check_american.py` over README, the three docs, and every changed
source file: CLEAN (0 hits, exit 0).

## Pass 2 — completing the runs (2026-10-07, same branch and worktree)

Pass 1 proved routing for claude and codex, but neither run completed:
the lab endpoint rejected something each harness sends by default. Pass 2
closes the gap from codemux's side where a knob exists (codex) and
proves the completion path where none can exist (claude) against an
endpoint that implements the Messages API fully.

### What shipped

- `CODEMUX_CODEX_PROVIDER_MULTI_AGENT=on|off` (default: codex's own,
  i.e. on). `off` writes `features.multi_agent = false` into the
  override's private `config.toml` — the persistent form of `--disable
  multi_agent`, which the 0.160 binary's help documents as
  `-c features.<name>=false` — removing the grouped `namespace` tool
  (`multi_agent_v1`) that codex's subagent feature adds to every
  Responses request. `on` and unset write nothing. Any other value fails
  the run before launch, and so does the knob set without an override
  (the same rule as the token caps: the override's config.toml is the
  only channel, and a plain run's operator config is never written).
  (`src/codex-provider.ts`, `src/adapters/codex.ts`.)

### Design decisions

1. **The knob is codex-specific and lives in the codex provider module.**
   `readProviderOverride` stays a pure function of the five generic
   names; the knob rides `readCodexMultiAgent` beside it. The adapter
   validates the two together — `validatedProvider` calls
   `assertMultiAgentKnob`, so every launch path (validateRunRequest
   through modelFor, the TUI refusal, prepareRun's writers) fails loudly
   on a bad value or on a knob without an override, and both the plain
   and hermetic homes carry the setting.
2. **`on` writes nothing.** Codex's own default is on; restating it
   would pin a value a future release could change, and the file's job
   is to carry the override, not codex's defaults.
3. **The semantic change is the feature, and is documented.** `off`
   means the run spawns no codex subagents. That is what lets an
   endpoint without namespace-tool grouping serve codex at all, and an
   operator holding the model fixed across harnesses may want it for the
   comparison's own sake too: a harness that fans out subagents runs a
   different workload than one that cannot, and `off` keeps codex's
   turn comparable to a harness with no subagent feature. README states
   both reasons; docs/HERMETIC.md notes the knob rides the same
   config in the hermetic home; the compatibility addendum records the
   evidence.
4. **Claude cannot be knobbled from codemux, so the proof moved to a
   full Messages implementation.** Claude Code 2.1.280's
   `mid-conversation-system-2026-04-07` gate has a force variable and no
   disable one (pass 1, verified with `strings` on the binary), and
   codemux cannot change what the binary sends. The completing run
   therefore targets Z.AI's Anthropic-compatible endpoint
   (`https://api.z.ai/api/anthropic`, the one the `zai` adapter targets,
   key auto-read from `~/.zai`, model `glm-5.3`). README now states
   exactly what an endpoint must accept — `system`-role entries inside
   `messages`, as sent by Claude Code >= 2.1.2xx — that a proxy in front
   of a vLLM 0.12 Messages shim must fold them into the top-level
   `system` field, and quotes vLLM's exact `literal_error` so the
   symptom is searchable.

### Live acceptance (pass 2)

Same protocol as pass 1: the worktree CLI (`bun --no-env-file
--no-install --config=./bunfig.runtime.toml run src/index.ts run …`),
a synthetic per-run key for the lab endpoint, and `grep -c "$KEY"` over
every capture — always 0. The Z.AI key was read from `~/.zai` into the
environment and never printed (same check, 0 in both captures). Captures
in `scratch/pass2-{codex,claude,opencode,vllm-inside,vllm-top}.{out,err,json}`.

| # | Case | Command (keys redacted) | Exit | Reply |
|---|------|------------------------|------|-------|
| 9 | codex override, `MULTI_AGENT=off` | `CODEMUX_CODEX_PROVIDER_BASE_URL=http://localhost:8011/v1 CODEMUX_CODEX_PROVIDER_API_KEY=<redacted> CODEMUX_CODEX_PROVIDER_MODEL=clawvm-qwen32b-coder CODEMUX_CODEX_PROVIDER_MULTI_AGENT=off … run -a codex --auto high -p "Reply with exactly the word OK"` | **0** | `OK` |
| 10 | claude override → Z.AI gateway | `CODEMUX_CLAUDE_PROVIDER_BASE_URL=https://api.z.ai/api/anthropic CODEMUX_CLAUDE_PROVIDER_API_KEY=<redacted; read from ~/.zai> CODEMUX_CLAUDE_PROVIDER_MODEL=glm-5.3 … run -a claude --auto high -p "Reply with exactly the word OK"` | **0** | `OK` |
| 11 | opencode override + both caps (pass-1 case 5, re-run) | as pass 1 | **0** | `OK` |

**Case 9 evidence.** codex 0.160.1's own banner: `model:
clawvm-qwen32b-coder`, `provider: codemux`, `approval: never`,
`sandbox: danger-full-access`, 5,651 tokens used; `~/.codex/.codemux-provider`
and `~/.codex/.codemux-hermetic` both empty after the run. With the
`namespace` tool gone, no further 400 followed: the rest of codex
0.160.1's default Responses request parses and the model answers on the
first attempt, so no second knob was needed. With the knob unset the
same command 400s exactly as pass-1 case 2 — the config then carries no
`features` line, which the e2e test pins — so the lab endpoint's
acceptance of codex is an explicit per-run opt-in, not a silent default
change.

**Case 10 evidence.** Claude Code 2.1.280's own output names the
override's model (`"glm-5.3" isn't described by this version's model
catalog …`) and reports the gateway credential in force (`claude.ai
connectors are disabled because ANTHROPIC_API_KEY or another auth
source is set and takes precedence over your claude.ai login`). The
reply `OK`, exit 0, key in no capture. This is the same endpoint and
credential the `zai` adapter uses, i.e. a Messages implementation that
accepts Claude Code's full request shape, mid-conversation `system`
entries included.

Direct endpoint probes behind the claude documentation (both $0,
verbatim):

- `POST /v1/messages` with `messages:[{user…},{system…}]` → **400**
  `{'type': 'literal_error', 'loc': ('body', 'messages', 1, 'role'), 'msg': "Input should be 'user' or 'assistant'", 'input': 'system', 'ctx': {'expected': "'user' or 'assistant'"}}`
- the same request with `system` top-level → **200**, `content[0].text`
  `OK` — exactly the fold a proxy in front of this shim must perform.

### Tests and gate (pass 2)

New tests: `tests/provider-override-e2e.test.ts` +3 (the fake codex sees
`features.multi_agent = false` only when the knob is off, and the run
completes; the knob is rejected for a value that is not on/off, before
launch; the knob without an override fails loudly) and
`tests/provider-override-mappings.test.ts` +4 (the config line written
for `off` and not for `on`/unset; the knob rides the hermetic override
home too; the bad-value refusal; the knob-without-override refusal on
the run and TUI paths). Every pass-1 test is unchanged and green.

`make release-gate`: exit 2, stopped at the `contracts` stage by the
same known environment denial as pass 1 — `copilot --help` → `EPERM:
mkdir /Users/example/Library/Caches/copilot/pkg/darwin-arm64`; this
session's process tree is denied `~/Library`, and no copilot code is
touched by this branch. Everything before it is green: runtime floor
(Bun 1.4.2), `sh -n`, typecheck, and the full suite with coverage:
**880 pass / 6 skip / 0 fail, 886 tests across 37 files** (pass 1 in
this worktree: 873 pass / 6 skip / 0 fail, 879 tests; +7 tests, all
green. The brief's 877 pass / 2 skip is the same pass-1 tree with fewer
environment-dependent skips — the skip count varies by host, the pass
and fail counts do not). `contracts` itself: 2 pass / 1 fail (the
copilot probe; 93 expect() calls). Every stage after `contracts` was
run directly and is green: `sandbox-contract` ("scode sandbox contract
passed"), `smoke` (all eight commands, `codemux --version` → 0.7.1,
predating the 0.8.0 bump),
`bun audit` ("No vulnerabilities found (checked 9 packages)"), `bun
install --frozen-lockfile --dry-run` exit 0, and the closing
`run --help` / `tui --help` / `verify` checks.

`check_american.py` over README, CHANGELOG, HERMETIC.md,
HARNESS-COMPATIBILITY.md, and the changed source and test files:
CLEAN (0 hits, exit 0).

## Review fixes, round 1

Findings from `scratch/review-overrides1-findings.md` (contracts, minor;
correctness-2, major), both fixed, plus the same-class audit the brief
asked for.

**Major — the codex envelope reported `model: null` when the model came
from the override variable.** Fixed in `src/adapters/codex.ts`
(`processRunResult`): on an override run the request passed to
`codexResult` now carries `{ ...request, model: this.modelFor(request.model) }`,
the same resolution `prepareRun` wrote into the config.toml — the exact
mirror of the claude fix at `src/adapters/claude.ts:366-371`. Both
symptoms close at once: the envelope's `codemux.model` is the override's
model (or the served model on a reroute), and the reroute note can again
name "not the requested X", because both read the same `request.model`.
Regression test: `tests/provider-override-mappings.test.ts`, "the
envelope reports the override's model when the request named none" —
verified it fails without the fix (`Received: null`, the finding's exact
symptom) and passes with it.

**Same-class audit — every adapter that builds a result envelope.** The
envelope builders are agy, claude, zai (claude-family), aider, and codex;
of those, claude and codex are override-capable. Claude's fix is in this
branch; codex is the one fixed above. Aider's `processRunResult` extracts
a reply from the run's chat history and reports no model (no
`supportsResultJson`), so the class cannot arise. zai and agy have no
provider override (`supportsProviderOverride` unset). The remaining
override-capable adapters (openhands, opencode, kimi, droid, pi, goose)
build no result envelope. No further instances.

**Minor — the `.codemux-provider` sweep comments overstated when cleanup
happens.** Three sites said or implied "swept once its owning process is
gone"; the sweep is age-gated (`STALE_RUN_DIR_MS`, two days) on top of
the dead-pid check, so a crashed run's directory can stay on disk that
long. Corrected: `src/codex-provider.ts`'s header (which now also states
what a stale directory holds — endpoint URL and `env_key` name, never
the key), `src/adapters/codex.ts`'s `prepareRun` comment, and
`src/hermetic-home.ts`'s `sweepStaleRunDirs` doc, whose caller list was
missing `.codemux-provider`. The same overstatement sat in the droid,
opencode, and pi provider headers (pre-existing from round 1; their
sweeps use the same two-day gate) — fixed there too. Comment-only
changes, so no new test: the age-gated behavior the comments now match is
already pinned by `tests/hermetic.test.ts:325` and
`tests/opencode-provider.test.ts:282`.

**Gate.** `make release-gate`: exit 2 at `contracts` — the same known
environment denial as passes 1 and 2 (`copilot --help` → `EPERM: mkdir
/Users/example/Library/Caches/copilot/pkg/darwin-arm64`; this session's
process tree is denied `~/Library`, no copilot code is touched). Every
other stage green: runtime floor (Bun 1.4.2), `sh -n`, typecheck
(`tsc --noEmit`, exit 0), full suite with coverage **881 pass / 6 skip /
0 fail, 887 tests across 37 files** — pass 2's 880/6/0 plus the one new
regression test. Against the brief's 884 pass / 0 fail / 2 skip: same
tree, host with fewer environment-dependent skips (880 + 4 there + 1 new
= 885/0/2 now; 880 + 1 new = 881/0/6 here) — the fail count matches at
0 and the pass count moves by exactly the new test. `contracts` itself:
2 pass / 1 fail (the copilot probe; 93 expect() calls). The stages make
never reached all ran directly and are green: `sandbox-contract` ("scode
sandbox contract passed"), `smoke` (all commands, `codemux --version` →
0.7.1, predating the 0.8.0 bump), `bun audit` ("No vulnerabilities found (checked 9 packages)"),
`bun install --frozen-lockfile --dry-run` exit 0, and the closing
`run --help` / `tui --help` / `usage --help` / `verify` checks exit 0.

`check_american.py` over the seven changed source/test files and this
report: CLEAN (0 hits, exit 0).

## Review fixes, round 5

Findings from `scratch/review-overrides5-findings.md` (security via
claude: one minor, reported only; contracts via zai:glm-5.3: one major
that blocks, two minor), every one fixed, plus the same-class audit the
brief asked for.

**Major — an exported provider override changed `codemux verify`'s
result.** Both mechanisms the finding traces, fixed at the seam:

- The claude, codex, and openhands factories dropped the factory's `env`
  argument; all three forward it now (`src/adapters/index.ts`).
- `assertNoUnsupportedProviderOverride` read `process.env` directly. The
  root-cause fix: `BaseAdapter` now owns the environment view
  (`constructor(protected readonly environment …)`, the same default
  process.env as before), every adapter constructed against a view
  forwards it to `super` (aider, claude, codex, cursor, droid, goose,
  kimi, openhands, opencode, pi, zai), and the base check reads
  `this.environment`. A real launch still sees the operator's shell and
  refuses an unsupported override exactly as before; verify's empty view
  no longer does.
- Same-class catch while fixing it: the **zai** factory also dropped the
  view — absent from the finding's list because zai carries no override,
  but its base refusal read process.env through the constructor default.
  The new empty-view regression test caught it; the factory forwards the
  view like the rest.
- Live proof of the contract the task states: `codemux verify` with
  `CODEMUX_{CLAUDE,CODEX,OPENHANDS,ZAI}_PROVIDER_*` exported prints
  byte-identical output to the clean run (diff empty, both exit 0;
  captures `scratch/verify-{clean,override}.txt`).
- Regression tests, one per mechanism: `tests/adapters.test.ts` "the
  round-2 adapters' factories forward the view" (the empty view hides all
  three overrides — claude env, codex argv, openhands env+argv — while
  the launch view still sees them), `tests/provider-override.test.ts`
  "an explicit environment view hides the refusal (verify's contract)"
  (zai: empty view passes validation, launch view refuses both run and
  TUI), and `tests/verify.test.ts` "exported provider overrides never
  change the static wiring result" (the whole fleet's rows are deep-equal
  with and without the exports, no FAIL).
- The contract itself is unchanged — the design already stated it
  (`src/adapters/index.ts`'s factory comment, `src/verify.ts`'s
  STATIC_WIRING_ENV comment), which is why no doc changes were needed:
  the code now matches what they claimed.

**Same-class audit — the envelope `model` fallback on override runs.**
Every adapter that builds a result envelope: agy, claude, codex, zai
(claude-family), aider. Claude and codex — the only override-capable
envelope builders — resolve `this.modelFor(request.model)` into the
envelope on override runs (claude since this branch,
`src/adapters/claude.ts` processRunResult; codex since round 1,
`src/adapters/codex.ts` processRunResult), so the envelope names the
model the run used even when the request carried none. zai is not
override-capable and resolves only its own default model; aider's
processRunResult reports a reply and a scan surface, no model; agy has
no override. The remaining override-capable adapters (openhands,
opencode, kimi, droid, pi, goose) build no envelope. No further
instances.

**Minor — a test that promised coverage it could not exercise.**
`tests/provider-override.test.ts` "a supporting harness reads the
override instead" exported the trio into process.env but constructed
`new ClaudeAdapter({})`, so the adapter never saw it and the
`.not.toThrow()` passed through the base capability-flag early return.
Fixed: the adapter is constructed against the populated view, and the
test now also asserts `getEnv()` carries `ANTHROPIC_BASE_URL` — deleting
ClaudeAdapter's override implementation would fail it.

**Minor (security) — the OpenHands override key is visible to the
model.** Verified what the auditor could not: OpenHands CLI 1.16.0's
terminal tool builds the shell's environment from the CLI process's own
in both implementations — `subprocess_terminal.py` spawns with
`Popen(env=sanitized_env())` and `tmux_terminal.py` starts the tmux
server with `environment=env` — and `sanitized_env`
(openhands/sdk/utils/command.py) strips only `SESSION_API_KEY`. So the
`LLM_API_KEY` the override delivers reaches any command the model runs,
headless and TUI alike. No exclusion channel exists: the sanitizer's
list is hardcoded, `--override-with-envs` reads only the trio, and no
config extends either — unlike codex (`shell_environment_policy` in the
override's config.toml) or claude
(`CLAUDE_CODE_SUBPROCESS_ENV_SCRUB`). The fix is disclosure at the point
of use: `OpenHandsAdapter.beforeLaunch` prints an unconditional stderr
warning on every launch that carries an override (beforeLaunch fires on
both headless paths and both TUI paths), README and the compatibility
addendum now state the mechanism with this evidence instead of the
hedged sentence, and the adapter's comment records why no scrub exists.
Regression test: `tests/provider-override-mappings.test.ts` "an
override launch warns that LLM_API_KEY is visible to the model" — the
warning fires once with the override and never without it.

**Minor — build report stale against the tree.** The "What shipped" list
now cites the CHANGELOG under `## [0.8.0]` (the entry's actual heading;
package.json is 0.8.0), and the three earlier gate logs quoting
`codemux --version` → 0.7.1 say they predate the bump; this round's
smoke prints 0.8.0.

**Gate.** `make release-gate`: exit 2 at `contracts` — the same known
environment denial as every earlier round (`copilot --help` → `EPERM:
mkdir /Users/example/Library/Caches/copilot/pkg/darwin-arm64`; this
session's process tree is denied `~/Library`, no copilot code is touched
by this branch). Every other stage green: runtime floor (Bun 1.4.2),
`sh -n`, typecheck (`tsc --noEmit`, exit 0), and the full suite with
coverage: **885 pass / 6 skip / 0 fail, 891 tests across 37 files** —
round 1's 881/6/0 plus the four new tests above. Against the brief's 885
pass / 0 fail / 2 skip: the fail count matches at 0, the four new tests
move this host's pass count 881 → 885 (coincidentally equal to the
reference's 885, which round 1 recorded on a host with four fewer
environment-dependent skips), and the skip delta remains the documented
host difference — the reference host would read 889/0/2 on this tree.
`contracts` itself: 2 pass / 1 fail (the copilot probe; 93 expect()
calls). The stages make never reached all ran directly and are green:
`sandbox-contract` ("scode sandbox contract passed"), `smoke` (all
commands, `codemux --version` → 0.8.0), `bun audit` ("No
vulnerabilities found (checked 9 packages)"), `bun install
--frozen-lockfile --dry-run` exit 0, and the closing `run --help` /
`tui --help` / `usage --help` / `verify` (plain and `--show-scode`)
checks exit 0.

`check_american.py` over README, HARNESS-COMPATIBILITY.md, the changed
source and test files, and this report: CLEAN (0 hits, exit 0).
