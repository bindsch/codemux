# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Provider overrides: point one harness at a different model provider
  through `CODEMUX_<AGENT>_PROVIDER_{BASE_URL,API_KEY,MODEL}` (blank values
  count as unset; a half-configured override refuses the launch; a base
  URL or model name containing `{` or `}` is refused — OpenCode substitutes
  `{env:…}`/`{file:…}` and Droid and Pi expand `${VAR}` templates in the
  config files an override writes). The key is
  delivered through the environment codemux itself provides or through a
  private per-run file, never through an operator configuration file, so an
  override survives `--hermetic`. Consumers: Aider (litellm's `openai/`
  model prefix with `OPENAI_API_BASE`/`OPENAI_API_KEY`), OpenCode (a
  private `OPENCODE_CONFIG` provider file plus a key environment it
  references), Kimi Code (the `KIMI_MODEL_*` group that synthesizes a
  provider in memory), Droid (a per-run BYOK `customModels` entry inside a
  private `--settings` file), Pi (a private agent directory behind
  `PI_CODING_AGENT_DIR`), and Goose (the pure-environment
  `GOOSE_PROVIDER`/`OPENAI_HOST`/`OPENAI_BASE_PATH`/`OPENAI_API_KEY`/`GOOSE_MODEL`
  group). Documented in the README ("Provider overrides").
- Aider's `--hermetic` claim is withdrawn and the flag refused again. The
  2026-09-17 two-probe check passed, but its canary plants `AGENTS.md` and
  `CLAUDE.md` — a channel the control probe already exercises through
  `--read` — and never rode aider's own config layers, which no flag
  closes: `.aider.conf.yml`, `.env` and `.aider.model.settings.yml` load
  from the working directory, the git root and the home alongside every
  pinned file, inside the aider process where the `AIDER_*` sanitizer block
  cannot see them (`main.py` at 0.86.2). Confirmed live on 2026-10-04: a
  plain run whose working directory held only a `.aider.conf.yml` naming a
  canary note answered with the note's code word, every pinned flag in
  place (docs/HERMETIC.md). The answer machinery stays for the day aider
  grows a switch: a per-run chat-history file under `~/.aider/.codemux/`
  (aider's stdout is a transcript; the history holds the bare reply and
  the model's reasoning), with the code-word scan covering stdout plus the
  full history. Only a hermetic run creates the file; plain runs keep
  `--chat-history-file /dev/null`, so no run today writes its conversation
  to disk (h6 review).
- OpenCode claims `--hermetic` and `--tools none`, verified live on
  2026-09-17 through the provider override (GLM-5.3 via Z.AI): the override
  rides a private `OPENCODE_CONFIG` file codemux writes per run and removes
  at exit, with the key delivered as `{env:…}` interpolation and headless
  runs only. Hermetic runs now REMOVE `OPENCODE_CONFIG`,
  `OPENCODE_CONFIG_DIR` and `OPENCODE_CONFIG_CONTENT` through `env -u`
  instead of blanking them: OpenCode's global config path reads
  `OPENCODE_CONFIG_DIR ?? …`, an empty string survives the `??`, and the
  resulting empty global path turned the global `AGENTS.md` lookup into a
  project-relative one — a live leak of the check's planted code word at
  1.18.18, traced by pointing the override at a tee proxy and reading the
  request body. The hermetic check's probe prompt now forbids tool use: a
  tool-armed model (GLM-5.3 under `--auto`) answered the question by
  reading the planted `CLAUDE.md` itself while its request was clean, which
  is the model's own discovery, not a configuration leak.
- The `env` prefix validator accepts `-u NAME` pairs (plain identifier
  names only); every other option (`-i`, `-S`) is still refused.
- Droid claims `--tools none`, verified live on 2026-09-17 through a
  provider override (GLM-5.3 via Z.AI): the override writes one BYOK
  `customModels` entry into a private per-run settings file passed as the
  root-level `--settings <path>` (merged for that process only), with the
  key referenced as `${CODEMUX_DROID_PROVIDER_API_KEY}` and delivered
  through the environment codemux provides — never argv, never an operator
  file, and no Factory login needed, which is what unblocked the probe
  (droid's self-update had left no stored login). Droid selects a custom
  model by the entry's `id` (here `custom:codemux:<model>-0`, the shape of
  the operator's own working entries), not its `model` name; a `-m` naming
  only the API model id falls through to Factory inference and fails
  authentication. Under `--tools none` (`--only-tools ToolSearch`) the
  session transcripts contain no tool call at all and neither capability
  probe could produce its secret (the shell probe returned fabricated
  output, distinguishable because the probe asks for a transform of
  planted content), while a plain run's model read the file and produced
  it; the non-hermetic control probe leaked the planted code word, which
  grounds the hermetic refusal (instruction files load from the working
  directory up to the git root with no switch).
- Kimi Code claims `--tools none`, verified live on 2026-09-17 through a
  provider override (GLM-5.3 via Z.AI): the override rides the
  `KIMI_MODEL_*` environment group (a temporary provider synthesized in
  memory, so nothing touches config.toml), suppressing the `-m` flag
  because a config alias would outrank the synthesized model. Under
  `--tools none` the read and shell capability probes produced neither
  secret while a plain run produced both; the non-hermetic control probe
  quoted the planted code word and `~/.agents/AGENTS.md`'s owner, which
  grounds the hermetic refusal (the AGENTS.md merger has no switch).

- Goose claims `--tools none`, verified live on 2026-09-17 at 1.50.1
  (installed via the official `download_cli.sh`) through a provider
  override (GLM-5.3 via Z.AI): the override rides pure environment —
  `CODEMUX_GOOSE_PROVIDER_{BASE_URL,API_KEY,MODEL}` become the
  `GOOSE_PROVIDER`/`OPENAI_HOST`/`OPENAI_BASE_PATH`/`OPENAI_API_KEY`/`GOOSE_MODEL`
  group, every one of which goose reads before any config file or keyring,
  so the key never touches argv or an operator file. The base URL splits
  into the host/path pair with goose's own `derive_base_path` semantics, so
  `https://api.z.ai/api/coding/paas/v4` becomes
  `OPENAI_HOST=https://api.z.ai` with
  `OPENAI_BASE_PATH=api/coding/paas/v4/chat/completions`, and a
  chat-completions path forces the chat-completions protocol; a base URL
  with a query string is rejected because the pair cannot carry one. Under
  `--tools none` (`--no-profile`, under which the session instantiates no
  extension at all — every tool, the developer, skills and memory platform
  extensions included, reaches the model only through an extension) the
  read probe produced no output at all and the shell probe produced a
  fabricated quip rather than the real transform of the planted token,
  while plain runs produced both the secret and its transform; the
  non-hermetic control probe leaked the planted code word, which grounds
  the hermetic refusal (`GOOSE_SYSTEM_PROMPT_FILE_PATH` replaces the whole
  system prompt from the operator's config file on every session with no
  switch, and `GOOSE_PATH_ROOT` — the wholesale relocation — strands the
  provider and model selection living in the same file while the global
  skill directories under the real home escape it).
- Qwen keeps refusing both capabilities, now verified live on 2026-09-17
  at 0.24.0 (installed via npm) through a provider override that no longer
  ships (GLM-5.3 via
  Z.AI): the probe rode the `OPENAI_API_KEY`/`OPENAI_BASE_URL`/
  `OPENAI_MODEL` group qwen documents for headless setups, so the key
  never touched argv or an operator file. The non-hermetic control probe
  stayed clean — every codemux qwen run already carries `--safe-mode`,
  which closes every operator channel, so the check's control can never
  leak and `--hermetic` can never pass by design — while the plain read
  and shell probes produced the planted secret and its transform, so the
  harness demonstrably ran against Z.AI with its tools intact;
  `--tools none` stays refused because no tool-removal flag survives
  safe mode.
- Cline keeps refusing both capabilities, now verified live on
  2026-09-17 at 3.0.62 (installed via npm) through a provider override
  that no longer ships
  (GLM-5.3 via Z.AI): the probe's `CODEMUX_CLINE_PROVIDER_{BASE_URL,API_KEY,MODEL}`
  wrote a private per-run data directory passed as `--data-dir`, whose
  `settings/providers.json` carries one `openai-compatible` entry — the
  key rides that 0600 file (cline's runtime reads provider keys from
  providers.json only; `apiKeyEnv` is a configure-UI hint and `-k/--key`
  would put it in argv), never argv or an operator file. `--data-dir`
  is also what makes the override work at all: a plain one-shot run
  delegates its session to cline's long-lived hub daemon
  (`forceLocalBackend: isYoloMode || config.sandbox === true` in
  apps/cli/src/runtime/run-agent.ts), and the session config sent to the
  daemon carries the key but not the settings file's base URL — observed
  live when every run after the first sent the override's key to
  api.openai.com — while `--data-dir` sets `CLINE_SANDBOX=1` and forces
  the in-process backend that reads the file. The non-hermetic control
  probe leaked the planted code word through the workspace AGENTS.md
  channel and the model's reasoning also named the operator from the
  global `~/.agents/AGENTS.md` channel, so both refusals stand on live
  leaks; the plain read and shell probes produced the planted secret
  and its transform, so the harness demonstrably ran against Z.AI.
- Pi claims `--tools none`, verified live on 2026-09-17 through a
  provider override (GLM-5.3 via Z.AI): the override writes a private
  agent directory behind `PI_CODING_AGENT_DIR` — the only knob that
  relocates the `models.json` pi reads custom providers from — holding a
  one-provider entry whose `apiKey` is the
  `${CODEMUX_PI_PROVIDER_API_KEY}` reference; pi expands `$VAR`/`${VAR}`
  config templates from the environment at auth time, so the value never
  touches disk, argv, or an operator file, and the run needs no stored
  login. Under `--tools none` (`--no-tools`, with the autonomy mapping's
  `--tools` allowlist suppressed because pi resolves it over `--no-tools`)
  the read probe answered that it had no tools to read the file and the
  shell probe produced no output at all, while plain runs produced the
  planted secret and its transform; the non-hermetic control probe
  leaked the planted code word, which grounds the hermetic refusal (the
  working-directory context-file channel is not trust-gated, and the
  global `~/.pi/SYSTEM.md`/`APPEND_SYSTEM.md` system-prompt override has
  no switch).
- Gemini's `--tools none` mapping cannot be claimed on
  a user-owned prefix, so both capabilities stay refused and the mapping is
  removed in 0.7.0 as dead surface: gemini 0.60.0 was installed and
  exercised live on
  2026-09-17, and its system-settings layer requires the settings file and
  every ancestor directory up to `/` to be owned by root (uid 0) — a rule
  present identically at the audited 0.53.1 — or the file is skipped with a
  warning and the run starts with its tools restored. The private per-run
  file under `~/.gemini/.codemux/` that the mapping wrote was therefore
  always skipped on such a machine (observed live through the identical
  warning on the packaged file). The same warning shows the packaged
  system-settings file every plain gemini run points at
  (`resources/gemini-system-settings.json`, whose one pin disables generic
  project `.env` loading) has never loaded on a user-owned prefix either —
  a documented contract gap, not a regression; the other two protections
  (`.gemini` project controls rejected, nested sandbox disabled) are
  launch-boundary mechanisms and apply everywhere. Gemini keeps refusing `--hermetic`: no switch
  closes the workspace channels, gemini loads only `GEMINI.md` — never the
  `AGENTS.md` or `CLAUDE.md` the check plants, so a leaking control probe is
  impossible — and the live pass found no custom-provider path to verify
  against either: `GOOGLE_GEMINI_BASE_URL` resolves to the "gateway" auth
  type the CLI's own validator rejects, pinning API-key auth still landed
  the request on Google, and Z.AI serves no Gemini-protocol endpoint (only
  Anthropic and OpenAI protocols, docs.z.ai/devpack/tool/others).
- Copilot keeps refusing both capabilities,
  now verified live on 2026-09-17 at 1.0.85 (installed via npm) through
  an override that no longer ships (GLM-5.3 via Z.AI): the probe's
  `CODEMUX_COPILOT_PROVIDER_{BASE_URL,
  API_KEY,MODEL}` rode the documented BYOK environment group —
  `COPILOT_PROVIDER_BASE_URL` / `COPILOT_PROVIDER_TYPE=openai` /
  `COPILOT_PROVIDER_API_KEY` plus `COPILOT_MODEL` (docs.github.com, "Use
  bring-your-own-key models with Copilot CLI") — which activates before any
  GitHub authentication at 1.0.85, so the runs needed no Copilot login; the
  key rides the environment codemux provides, never argv. The plain probes
  ran against the model: the read probe produced the planted secret and the
  shell probes demonstrably executed (`cat notes.txt | wc -c` answered the
  file's true byte count). `--tools none` lost its mapping: the previous
  bare `--available-tools` mapping is removed because no argv spelling of
  an empty allowlist disarms the tools — a bare flag, `--available-tools=`,
  and `--available-tools ""` all left the read and shell tools armed in
  live probes at `--auto high` (the optional-variadic flag parses every
  empty spelling into an absent filter), so the capability stays refused on
  live evidence rather than an unverified mapping. `--hermetic`'s mechanism
  (the private `COPILOT_HOME`) is removed in 0.7.0 as dead surface,
  unclaimable for the same reason: the check's control probe cannot leak the
  planted code word because `--no-custom-instructions` rides every codemux
  run — verified live when the control answered `Peter`, the name inside
  the user-installed skill `~/.agents/skills/domain-dns-ops/SKILL.md` (a
  real leak of the user-skill channel the private home closes) while the
  planted code word never appeared; dropping the flag from plain runs to
  make the control leak would un-harden every run. In-session (sandboxed)
  exercise needs `COPILOT_PKG_CACHE_HOME` passed with `--pass-env`: the
  loader's first-run self-extraction cannot mkdir under
  `~/Library/Caches` from inside a sandboxed session
  (docs/HARNESS-COMPATIBILITY.md).

### Fixed

- OpenCode provider overrides whose model carries the provider prefix
  (`--model codemux/glm-5.3`, or the same value in
  `CODEMUX_OPENCODE_PROVIDER_MODEL`) generated a config the run's own
  selector could not resolve: the models entry was keyed by the prefixed
  name while OpenCode splits a selector on its first `/`. The prefix is
  now normalized away before the entry is written.
- Droid's effort mapping resolves the session's model — the request's,
  else the override's — before choosing the no-reasoning value, so an
  override model in the gpt-5.6 family gets that family's `none` instead
  of the generic `off` droid rejects for it.
- The `env` prefix trust check no longer honors `-u NAME`/`--unset NAME`
  after a `NAME=value` assignment. Past an assignment, options must not
  be honored: env would treat the option as the program to run (BSD env,
  and POSIX env generally), so the check now refuses the prefix instead
  of validating the wrong binary.
- Aider's answer extraction anchors on the run's user header instead of
  the last `#### ` header, so a reply containing its own header (for
  example `Laurent` followed by `#### Note` and `OK`) no longer extracts
  as exactly `OK`.
- The adapter factories forward the environment view `getAdapter` is
  handed. They used to construct every adapter against `process.env`
  regardless, so an exported `CODEMUX_*_PROVIDER_*` override leaked into
  `verify`'s deliberately empty view: a configured cline then threw from
  `buildRunCommand` and `verify` reported broken static wiring for a
  working setup (found by the h2 review).
- The OpenCode provider override refuses a model containing `{` or `}`:
  OpenCode substitutes `{env:…}` and `{file:…}` in config text before
  parsing, so such a model id would splice an environment variable's
  value or an arbitrary file's content into the config codemux writes
  (found by the h3 review).
- Aider's post-run history read follows no symlink and stops at a bound
  (32 MiB — the largest legal prompt plus the reply and reasoning around
  it). The sandboxed harness can write `~/.aider/.codemux/`, so the old
  bare `readFileSync` would have followed a harness-planted link to a
  file outside the sandbox — read by codemux, which runs outside it —
  and read a harness-grown file without bound. Both refusals fail closed
  on stdout (h3 review).
- The OpenCode login-state inspection reads its SQLite store through
  `bun:sqlite` instead of `node:sqlite` (h4 review): the pinned runtime
  floor (Bun 1.3.14) has no `node:sqlite`, and the module loads with the
  adapter registry, so the import broke every CLI command on the floor —
  `./bin/codemux --help` printed "error: No such built-in module:
  node:sqlite" and still exited 0. Same fail-closed semantics, same
  refusal design, no new dependency; the docs agree there is no switch to
  close the channel (opencode.ai/docs/config at 1.18: remote config is
  "fetched automatically when you authenticate with a provider that
  supports it", first in the precedence order, and the documented
  config and env surface gates neither fetch).
- A provider-override base URL containing `{` or `}` is refused (h4
  review): OpenCode substitutes `{env:…}`/`{file:…}` and Droid and Pi
  expand `${VAR}` templates in the config files an override writes, so a
  brace could splice an environment variable's value or a file's content
  into a config codemux writes. One rule covers both template shapes.
- Pi's provider override declares `reasoning: true` on the generated
  model entry (h4 review): pi 0.85.1 defaults a custom model's reasoning
  to false, which clamps the `--thinking` flag `--effort` maps to "off",
  so the bare entry silently disabled reasoning (observed at the
  composer as `{"reasoning":false,"requested":"high","effective":"off"}`).
- One bad stale artifact no longer blocks every later run (h4 review):
  the sweeps for aider's chat-history files, kimi's no-tools agent
  files, opencode's provider-config directories, droid's
  provider-settings directories and pi's agent directories let a single
  unremovable entry — a directory named like the file pattern, `EISDIR`
  on a non-recursive rm — throw out of the sweep and fail every
  subsequent launch. Each removal now warns on stderr and moves on.
- Aider's post-run history read opens the file without blocking (h5
  review): a harness that replaced its writable history file with a FIFO
  and exited parked `openSync(O_RDONLY)` before the type check could
  reject it, and the read runs after the subprocess timeout is cleared,
  so `--timeout` could not stop the hang — an isolated reproduction
  blocked until SIGKILL. The open now carries `O_NONBLOCK` (the pattern
  the bounded file reads in `src/file-io.ts` already use), the
  descriptor check rejects the FIFO, and the read fails closed on stdout
  as every other refusal does.
- The OpenCode login-state inspection reads `auth.json` through the
  bounded, nonblocking, no-final-symlink reader instead of a bare
  `readFileSync` (h6 review): the read runs during validation, before
  the subprocess timeout starts, so a harness that replaced the store
  with a FIFO hung codemux until SIGKILL — the same class as the h5
  finding, in the one raw read the h3/h5 conversions had left. Any
  store that exists but cannot be read — symlinked (OpenCode follows
  symlinks codemux refuses, so skipping the inspection would miss a
  real carrier), oversized, unparsable, or a FIFO — now fails closed
  naming the file, and `opencode.db` is lstat'd to a regular file
  before SQLite opens it, its own open having the same two shapes.
- A provider-override model containing `{` or `}` is refused on Droid
  and Pi (h6 review): the h4 brace refusal covered the base URL, but
  the model lands in the same template-expanded files — droid's
  settings entry and pi's models.json — so a crafted model name could
  splice an environment variable's value into the config codemux
  writes. Refused at validation and again before anything is created.
- Aider writes the per-run chat-history file only on hermetic runs (h6
  review): the file rode every headless run, so plain runs — whose
  history nothing reads, the hermetic check being refused — persisted
  the whole conversation under `~/.aider/.codemux/` where the run used
  to write `/dev/null`. Plain runs go back to `/dev/null` and create
  nothing.
- The OpenCode hermetic-home sweep warns and moves on when one stale
  home cannot be removed (h6 review): the h4 sweep hardening covered
  five sweeps and missed this sixth, so an unremovable stale home threw
  out of it and failed every later hermetic launch.
- Aider's installed-contract pins carry only flags a reachable run
  sends (h6 review): `--map-tokens` rides only the `--hermetic`
  branch, which aider refuses, and `--read` rides instruction
  directories, which only the hermetic check sets on its refused
  probe — both were pinned though no reachable request emits them,
  which would fail the gate on an upstream removal codemux is
  indifferent to (the rule the copilot `--available-tools` comment
  states). An always-on test now builds every reachable aider command
  shape and fails on any pin none of them sends.
- The `check --hermetic` control probe repeats the hermetic probe's
  `--tools` selection unchanged, so `--hermetic` is the only difference
  between the two requests (h7 review). It used to fall back to the
  default tools for a harness that scopes `--tools none` to hermetic
  runs, which varied two things at once: the control's leak could have
  come through a tool, and the hermetic probe's clean `OK` could have
  meant tool removal rather than isolation. OpenCode — the one harness
  so scoped — now refuses the combination before any request is spent,
  because its control would be a plain `--tools none` run the adapter
  itself refuses; its isolation claim is checked with `--hermetic`
  alone and its `--tools none` claim keeps the read and shell probes of
  the live pass. The h6 review's documented residual (the armed
  default-tools control) is gone with the substitution.

### Changed

- OpenCode's `--tools none` requires `--hermetic`. The
  `OPENCODE_PERMISSION={"*":"deny"}` deny merges into the top-level
  permission only; the operator's opencode config can append per-agent
  permission rules after it, and the last matching rule wins — proven
  live at 1.18.18 through codemux's own plain-run path, where
  `"agent": {"build": {"permission": {"bash": "allow"}}}` in the
  operator's config put the bash tool into the model's request under the
  deny (h2 review; docs/HERMETIC.md). No environment variable spells
  per-agent or mode permissions, so a plain run cannot guarantee the
  deny and refuses the capability instead. The check's control probe
  runs with the default tools for such a harness — it varies `--hermetic`
  alone, and a plain `--tools none` run is now refused.
- OpenCode's `--hermetic` (and with it `--tools none`) refuses a login
  that carries remote configuration. OpenCode's config load fetches a
  well-known login's `.well-known/opencode` document and an active
  organization's `/api/config` from `opencode.db`, merging both as
  global config — custom prompts, plugins and agent permissions
  included, which append after the `--tools none` deny exactly like the
  operator's per-agent rules — unconditionally and behind no flag
  (`config.ts` at 1.18.18; the private hermetic home changes nothing,
  the login's data directory stays real; found by the h3 review, then
  proven live through the exact hermetic launch path against a local
  mock: with a well-known entry as the auth store's only content the
  run fetched the login's `.well-known/opencode` and the model's
  request carried the bash tool under the deny, while the identical
  launch with an empty auth store fetched nothing and sent no tools). A
  hermetic run now inspects the login state before launch and refuses
  while either carrier exists — a well-known entry in the auth store or
  an account with an active organization — naming the remedy; an account
  store that exists but cannot be read fails closed the same way. The
  hermetic env prefix also removes `OPENCODE_AUTH_CONTENT`, which
  `Auth.all` reads before the auth.json file and which could carry the
  same well-known login through an explicit `--pass-env`
  (docs/HERMETIC.md).

### Removed

- Dead surface behind the both-refused harnesses (the h4 review's cut):
  the provider overrides and hermetic/no-tools machinery for Copilot,
  Gemini CLI, Cline, OpenHands and Qwen — every harness whose
  `--hermetic` and `--tools none` are both refused. The refusals and
  their live grounding stay in docs/HERMETIC.md; the modules
  (`src/copilot-hermetic.ts`, `src/cline-provider.ts`,
  `src/gemini-no-tools.ts`), their flags, tests and README enumeration
  are gone. The machinery existed to ground the refusals' live checks
  and could never be claimed as a capability, so it shipped per-run
  files, config writing and env prefixes with no capability behind
  them. Plain-run commands for the five are unchanged (OpenHands keeps
  `--override-with-envs` model selection; copilot keeps
  `--disable-builtin-mcps` below high autonomy), and the
  installed-contract entries are unchanged from 0.6.1. Provider
  overrides remain for aider, opencode, kimi, droid, pi and goose.

## [0.6.1] - 2026-10-04

### Added

- `agy` (Google Antigravity CLI) as a harness, pinned against 1.2.14. The
  prompt rides in argv as `--print=<prompt>`, and every value flag
  (`--model`, `--effort`, `--mode`, `--output-format`) is emitted in the
  single-token `--flag=value` form — the space form of the pre-parsed
  flags exits 2 at the pinned release, and `--model`'s space form was
  never exercised there. Effort
  maps all five levels the binary accepts (low/medium/high/xhigh/max; the
  docs' table names only three). Autonomy maps `read-only` to
  `--mode=plan`, `medium` to `--mode=accept-edits`, `high` to
  `--dangerously-skip-permissions`, and `low` to default prompting — an
  unrecognized `--mode` value only warns and continues upstream, so scode
  stays the enforcement below `high`, as everywhere. `--result-json` maps
  to `--output-format=json` and passes the envelope through with the
  codemux block appended, the usage normalized to the same meaning every
  harness reports (agy's `input_tokens` includes the cache-read count and
  `thinking_tokens` sits outside the total; `total_tokens` is computed
  from the normalized components, null when one is missing, never echoed
  from the envelope). Runs reject project-controlled
  Antigravity config — the `.agents/{skills,rules,plugins,agents}.json`
  manifests, `.agents/hooks.json`, the `.agents/{skills,rules,plugins,
  agents,workflows}/` directories, and `.gemini/{.env,config/}` — between
  the working directory and its Git root, matching the config roots the
  binary's own strings name. Launches forward only the credentials the
  binary reads (`GEMINI_API_KEY`, `GOOGLE_API_KEY`); in particular
  `GOOGLE_APPLICATION_CREDENTIALS` is stripped, because setting it to a
  missing or valid-shaped service-account file leaves the headless auth
  path at the identical OAuth wall — it has no reader. Audited from the
  binary's flag surface and the official
  headless docs, not live: this machine has no Antigravity login. The
  adapter's exact argv was exercised live to the authentication wall, and
  the envelope's JSON tags were observed live in an ERROR envelope; a
  success envelope with nonzero usage remains docs-pinned. No
  hermetic or `--tools none` claim (see docs/HERMETIC.md). Version floor
  1.2.14, the only audited release.

### Changed

- Cursor launches run the standalone `agent` entry, then the legacy
  `cursor-agent` alias — exactly 0.6.0's default — and report cursor as
  not installed when neither resolves. The desktop CLI's `cursor agent`
  subcommand is now strictly opt-in: set `CODEMUX_CURSOR_ENTRY=cursor`
  and pass the name through (`--pass-env CODEMUX_CURSOR_ENTRY`). The
  desktop wrapper is not a pure forward: the Cursor.app launcher
  downloads and runs `https://cursor.com/install` when
  `~/.local/bin/cursor-agent` is absent and runs `cursor-agent update`
  when the installed build is old, before exec-ing that same binary —
  the entry may install or update the agent on first use, so codemux
  never executes it on its own initiative (not discovery, not the
  version gate by default, not the installed-contract suite). The
  passthrough is the authorization — argv the operator typed, which
  neither a repository nor a shell profile can inject — and a launch
  that selects the desktop entry without it is refused before the
  version gate could execute anything. Under the opt-in, the
  trusted-executable check applies to the `cursor` binary resolved
  against the requested working directory and the version probe sends
  `cursor agent --version` only after that check, only inside the launch
  path (`cursor --version` reports the desktop app's semver rather than
  the agent build; the probe arguments key on the resolved entry's name,
  not the canonical path's basename — the standard Homebrew `cursor`
  symlink resolves into the Cursor.app bundle as `code`, and a basename
  test probed the desktop semver, missed the calendar pattern, and
  warned past the floor). `codemux verify` builds its commands against an
  explicitly empty environment view, so an exported
  `CODEMUX_CURSOR_ENTRY` never selects the desktop entry there and cannot
  fail its wiring check — the static result is the same whatever the
  operator's shell exports.

## [0.6.0] - 2026-10-03

### Fixed

- Overlapping codex runs no longer share per-run state. The private
  hermetic home lived in plain fields on the singleton adapter, so run
  B's launch replaced run A's home before A's command was built, and one
  run's teardown finalized every home the adapter had ever made,
  including another run's in-flight one. Every piece of per-run state —
  the hermetic home, the `--output-last-message` fallback path this
  release adds — now lives on a per-launch `RunContext` the launcher
  owns and threads from `prepareRun` through `processRunResult`, so every
  launch, even two through one request object, touches only its own.

- Codex autonomy's approval policy is passed as the config override
  `-c approval_policy="…"`, so it reaches the run. It had been `-a <policy>`
  at the top level, before `exec`, where codex's root-to-exec handoff drops
  it (the handoff copies only the shared options like `-s` and `-m`, and
  `exec` has no `-a` of its own) — so an exec run's approval policy was
  silently whatever codex configured. At codex-cli 0.159.x, `-a` accepts
  only `on-request` and `never`, so `low`'s `untrusted` was an invalid value
  there. The config override is the one channel that reaches `exec`, `exec
  resume`, and the TUI alike, which is how effort already passed. Verified
  against the codex-rs clap grammar at rust-v0.159.3 (see
  docs/HARNESS-COMPATIBILITY.md).

- `copilot`'s reasoning effort is passed as `--reasoning-effort`, the flag the
  CLI actually takes. It had been `--effort`, which upstream added in v1.0.10 as
  a shorthand alias and has since dropped, so every
  `codemux run -a copilot --effort <level>` failed on an unknown option.
  `--reasoning-effort` has been the canonical flag since v1.0.4, so no release at
  or above the version floor is affected by the switch. The
  accepted values are unchanged, so no translation is needed, unlike Droid's
  `none` to `off`. The installed-contract suite pins the real name and
  `make release-gate` runs it on every PR; it caught nothing because it skips a
  binary absent from the machine, and no machine in the loop had copilot
  installed. Copilot also gains a `HARNESS_CONTRACTS` entry: without one
  `assertSupportedHarnessVersion` returns immediately -- a silent pass, not a
  warning -- and copilot is the harness that renamed a flag between patch
  releases, so an unpinned version there was the least safe default in the
  table, with a floor of 1.0.77, the version the ledger recorded before this
  audit. A lower floor would report roughly seventy never-audited releases as
  supported, since everything between the floor and the audited version runs
  silently. A refusal is visible and overridable with
  `CODEMUX_ALLOW_UNTESTED_HARNESS`; a false "supported" is not. The
  version is read with `--binary-version`, not `--version`: the latter starts the
  packaged application and needs a writable extraction cache, so under a
  restricted filesystem it fails and the gate silently stops enforcing. A test
  now fails if any harness the ledger records as installed has no version
  contract, and an unrecognized ledger row fails rather than being skipped.

- A copilot that reports no version is refused rather than warned through.
  `--binary-version` arrived in 1.0.3, below the 1.0.77 floor, so a silent
  probe is a below-floor release (1.0.0 through 1.0.2) rather than an unknown
  build, and the tier the floor exists to refuse was running with only a
  warning. The refusal is per contract (`unknownVersion`), keeps the warn
  default for harnesses whose probes a supported release can fail to answer,
  and is downgraded by `CODEMUX_ALLOW_UNTESTED_HARNESS` like every refusal.

- With `OPENCODE_BIN_PATH` passed through, the compatibility verdict now comes
  from the redirected executable rather than the unrelated PATH-resolved one.
  The gate resolves the redirect to a trusted executable — the same validation
  the PATH binary gets, which is what makes probing it outside the sandbox
  acceptable — and reads the version from it, so a below-floor redirect no
  longer hides behind a supported launcher and a supported redirect is no
  longer blocked by an old one. A redirect codemux cannot so resolve keeps the
  "cannot confirm" warning and still gates the PATH binary below the floor.

- Codex's per-run `--output-last-message` directory is removed only after its
  `.codemux-scratch` parent passes the trust check the result reader already
  applied. A run with write access to `~/.codex` could replace that parent
  with a symlink, and the recursive cleanup — unlike the read — followed it,
  deleting a matching run directory outside codemux's scratch tree even on a
  launch whose result read had already refused the swap. The parent is
  lstat-checked first; a parent that fails keeps its directory and reports the
  refusal.

- A rerouted codex run is attributed to the model that served it. Codex 0.159.3
  reports a reroute in the `--json` event stream as a completed error item
  (`model rerouted: <from> -> <to> (<reason>)`); the parser now records it and
  the `--result-json` envelope's `model` field carries the served model — with
  a stderr note naming it — instead of the requested one, which the harness
  may have substituted away mid-run.

- The harness version probe runs with an allowlisted environment rather than
  the caller's. It executes before any sandbox exists, so a variable that
  redirects code loading reaches it that a launch would have stripped:
  copilot's `COPILOT_CLI_DIST_DIR` makes even `--version` run a chosen
  directory's JavaScript, and against copilot 1.0.85 an unscrubbed probe read
  a fabricated 0.0.1 from a fixture directory. The probe now keeps only what
  lets the binary be found and produce readable output, so no credential for
  any agent reaches it either; the kept locale names follow the launch
  environment's own prefix rule, so the `--version` exec and the run resolve
  their locales the same way. A passed-through name that redirects the
  executable still cannot be honored — resolving it would run an unvalidated
  binary outside the sandbox — so the probe reports the version as
  unconfirmed while still probing the PATH-resolved default binary and still
  refusing it below the version floor; `CODEMUX_ALLOW_UNTESTED_HARNESS`
  covers a deliberate redirect there as anywhere else.

- The launch path validates and builds from one `passthroughEnv` list. The
  launcher validated `request.passthroughEnv` but built the sandbox
  environment from a second list on the launch options, so a programmatic
  caller could put a name on the options that validation never saw and the
  child still received. The options field is gone; the request's list is the
  single source.

### Added

- `-f -` reads the prompt from stdin, the same way a prompt file is read,
  so a caller can pipe a prompt without staging a file (`printf '…' |
  codemux run -a codex -f -`). Stdin is not argv: the read is bounded at
  16 MiB (the prompt-file limit) rather than the 32 KiB argv cap, though
  the argv rule still applies to the prompt's content for harnesses that
  pass it as an argument. An empty or whitespace-only stdin prompt is
  refused, and so is a terminal stdin — a non-interactive command reading
  a TTY would hang until the run's timeout; pipe the prompt instead. The
  read itself is bounded by `--timeout` like the run, so a prompt producer
  that stalls with the pipe open fails the run rather than hanging it;
  stdin is decoded with the same fatal UTF-8 decoder as a prompt file, so
  malformed bytes are an error (`-f - prompt must contain valid UTF-8`)
  rather than replacement characters that silently change the prompt text
  between the two advertised-equivalent input paths; and every
  prompt-independent check (agent capabilities, availability, hermetic,
  tools) runs before anything reads stdin, so an unsupported combination
  (`-a droid --hermetic -f -`) rejects at once instead of blocking on the
  read — a malformed command (`-p` with `-f`, a missing prompt, an
  unreadable prompt file) still fails before the availability checks.

- `--result-json` now works for Codex and Z.AI, and every envelope carries one
  codemux-owned block. Codex is asked for its JSONL event stream
  (`codex exec --json`, pinned against `codex-rs/exec/src/exec_events.rs` at
  rust-v0.159.3, the installed codex-cli 0.159.3): the stream names the
  thread, the final assistant message, and the thread's cumulative token
  usage as of the last completed turn, none of
  which the human-mode stderr summary carries (it prints one blended total
  that discounts cached input). That usage figure is a snapshot of the
  running thread counter, and every codemux run launches with `--ephemeral`,
  so the thread this run started makes the last snapshot exactly this run's
  usage. codemux reduces the stream to an envelope
  whose `result` is the final assistant message as plain text. A turn that
  ends with only a `Plan` item succeeds too: codex 0.159.3 treats the last
  `Plan` of a turn as its final message, but the JSONL event-stream mapper
  drops the item, so the launch also passes `--output-last-message <file>`
  (in a per-run directory under `.codemux-scratch/` inside the real
  CODEX_HOME — harness state, which every scode platform keeps writable
  and none shadows; inside the private home for `--hermetic` runs; no
  file at all under `--sandbox-trust untrusted` on a non-hermetic run,
  which denies harness state, so the event stream is the result's only
  source and a Plan-only turn there reports `result: null`; a hermetic
  run names its file whatever the trust, and `untrusted` denies the
  private home itself, so the child cannot write it — same outcome,
  different mechanism) and the message codex itself
  recorded — the Plan included — is the result when the stream's last
  turn completed without an `agent_message`, with a stderr note saying
  where it came from. The fallback supplements rather than bypasses: a turn with no
  message anywhere still fails, a failed turn cannot be rescued by a file,
  and a stream that carries its own `agent_message` stands. The file never
  outlives the run — removed once read, and disposed on every exit path
  (rejection, signal, and timeout alike) through the per-run context the
  launcher owns (see Fixed on overlapping runs) — and a cleanup failure
  says so on stderr without failing a finished run. The reader also
  refuses a fallback whose per-run directory — or its
  `.codemux-scratch`/`.codemux-hermetic` parent — is not a real
  user-owned directory, because O_NOFOLLOW guards only the file's own
  name and an intermediate symlink would point the read, and the delete
  that follows it, at a `last-message` outside the run: a run that loses
  the fallback this way fails closed (`result: null`) with a warning
  instead. Z.AI shares
  Claude Code's `--output-format json` envelope. Claude-family envelopes keep
  every harness field unchanged with the block appended:
  `"codemux": {"agent", "model", "usage": {"input_tokens", "output_tokens",
  "cached_input_tokens", "total_tokens", "cost_usd"}, "session_id"}`. Fields
  the harness does not report are null, never guessed; usage means the same
  thing per harness (uncached input, cache traffic, output, their sum), so
  Codex's `input_tokens`, which includes both cached reads and cache writes
  upstream (each a breakdown of the total, not an addition to it), is
  normalized — both subtracted from the input, both joined into
  `cached_input_tokens` — before it lands in the block. `session_id` is
  always null in this release —
  no run persists a session (Claude and Z.AI launch with
  `--no-session-persistence`, Codex with `--ephemeral`) — and the field is
  reserved for the planned live-sessions release. A failed run is
  failed on every channel: the exit is non-zero even when the harness's own
  was not, and the diagnostic from the `error` or
  `turn.failed` event rides on stderr — the JSONL processor prints those on
  stdout, where a reduction that ignored them lost the only record of why a
  run died; codemux's own stderr lines separate themselves from the
  harness's last (possibly unterminated) line, so diagnostics a caller
  parses line by line never fuse. In codex-built envelopes `result` is
  null on failure (a partial message from an earlier completed item never
  poses as the final one, matching codex, which discards its own final
  message on a failed turn), and the usage fields are null too: a figure
  from a run whose end the harness itself called failed is at best
  incomplete, and an exact-looking total that understates it is worse
  than none. A
  Claude-family envelope keeps the harness's own fields verbatim, failure
  included. A run the envelope
  says was served by several models (`modelUsage` with several entries)
  reports `model: null`, not the requested model; a Z.AI envelope without
  `modelUsage` reports the model codemux selected (`opus`, which every
  such run passes) rather than null. Stdout that breaks the JSON promise
  fails loudly (non-zero exit, the raw stdout kept, a stderr line saying
  what is missing), never a silent success: Claude-family plain text on
  exit 0; JSON that is not the result envelope — the envelope is
  `type: "result"` naming an outcome, so a bare `{}` (which parses), a
  bare discriminator, or a subtype-only "success" is refused like plain
  text, while an envelope reporting its own failure (`is_error: true`, an
  `error_*` subtype such as `error_during_execution`) fails the run even
  when the harness exited 0, so a wrapper that masks the exit code cannot
  mask the structured failure too; an empty codex stream; or a codex
  stream codemux cannot parse. An empty or whitespace-only reply is no
  reply on either path: a Claude envelope whose `result` is `""` or
  `" \n"` and a codex turn whose only `agent_message` carries empty or
  whitespace text fail the run, with the harness's own fields kept as it
  reported them. A computed `total_tokens` needs every component
  reported, so `{output_tokens: 5}` stays `total_tokens: null` instead of
  guessing the rest as zero; a codex turn whose `turn.completed` reports
  no usage leaves null fields rather than inheriting an earlier turn's
  stale totals; and the all-zero snapshot codex 0.159.3 emits when the
  thread never received a token-usage update (`Usage::default()`) counts
  as unreported the same way, not as a measured zero. Codex runs share
  one success verdict: a `turn.failed` or
  `error` event, a stream that ends
  without a final assistant message, a stream whose last turn never ended
  with `turn.completed`, or codex's own non-zero exit fails the run on every
  channel — and a stream that
  breaks the event grammar — no single `thread.started` announcement
  opening the stream, a terminal event no `turn.started` opened, a second
  turn after a completed one, or an item event (`item.started`,
  `item.updated`, or `item.completed`, whatever the item's type) after
  the last `turn.completed` — fails as unparseable before the verdict,
  the raw stdout kept; so does a recognized `agent_message` whose `text`
  is not a string: drift is refused, not skipped over.

- `--result-json` on `run` asks the harness for its own structured result
  envelope on stdout rather than plain text, so a caller can account for what
  a run consumed. A headless run previously reported nothing about its token
  use, and nothing could be recovered afterward either, because these runs pass
  `--no-session-persistence` and leave no session file. Claude Code supplies
  the envelope through `--output-format json`: the reply plus `usage`,
  `modelUsage` and `total_cost_usd`. codemux asks for it and re-emits it with
  every harness field unchanged plus the codemux block (above); the rest of
  the shape belongs to the harness. Harnesses without the capability
  refuse the flag instead of returning plain text, so a caller that asked for
  usage and got none cannot record the run as having cost nothing.

- `--sandbox-account <file>` / `--sandbox-account-id <id>` on `run` and
  `tui` forward scode's per-run scratch accounting: when set, scode appends
  one JSON line per sandboxed run describing the private scratch directory
  it created and tore down (`scratch_kib`, duration, exit code), tagged with
  the correlation id. The variables are applied through the sandbox
  environment, which is the one place codemux sets `SCODE_*` names itself;
  scode still unsets both before the harness runs, so the agent never sees
  them. codemux requires an absolute `--sandbox-account` path and refuses
  the flags with a clear error when the installed scode predates scratch
  accounting (probed from `--help`, since scode versions do not track the
  feature; a probe that does not exit cleanly refuses rather than guessing).
  The id is validated against the set scode records (`[A-Za-z0-9._:-]`, 1-128
  chars — anything else would be silently nulled and break correlation), and
  an id without a sink is refused as the misconfiguration it is. When the
  sink resolves inside the sandbox working directory — with symlinks
  resolved on both sides, so alias paths (/var/folders vs /private/var/folders)
  do not dodge the check — codemux warns that the records are
  confidentiality, not integrity, and proceeds: some callers, crew among
  them, place the sink there on purpose. This is the forwarding
  half of fleet workspace-storage measurement (scode records; the
  orchestrator correlates).

### Changed

- A passed-through `CLAUDE_CONFIG_DIR` must be an absolute path (claude
  and zai, `run` and `tui` alike). Claude Code resolves a relative one
  against the run's working directory, so the config store the harness
  home owns would land wherever `--cwd` happens to point; the launch is
  refused with a clear message instead. The check reads the exact value
  the child receives, because the harness reads the variable without
  trimming: a whitespace-padded value — `" /var/claude-profile"`, where
  the padding hides a relative path, or `"/var/claude "`, where a
  directory name would keep the padding — is refused too, and only the
  literal empty string counts as no redirect. Z.AI keeps reading and writing
  the same Claude Code home it
  always did — codemux pins no directory of its own — so
  `--setting-sources user` loads the
  operator's own `~/.claude/settings.json`, exactly as before 0.6.0.

## [0.5.2] - 2026-09-17

### Added

- `codemux run --hermetic` runs a harness with none of the operator's
  customizations: no user or project instruction files, skills, plugins,
  hooks, MCP servers, memories, or account-level integrations. The model
  sees the prompt and the harness's own base instructions, and the login
  still works. Claude Code and Z.AI use `--safe-mode`. Codex gets a private
  `HOME` and `CODEX_HOME` per run under `~/.codex/.codemux-hermetic/`,
  holding only a hard link to the real `auth.json` (Codex rewrites that
  file in place, so token rotations reach the real login; nothing is ever
  written back over it), handed to Codex through `env` so scode keeps the
  real home for its deny rules, plus
  `--ignore-user-config`, a zero AGENTS.md budget, and disabled apps,
  plugins, hooks, memories, goals and shell snapshot; repositories shipping
  `.agents/skills` or `.codex/skills` are refused. Every other harness
  refuses the flag until it has a verified mechanism. See
  `docs/HERMETIC.md` for the per-harness status and what each one lacks.
- `codemux run --tools <default|none>` selects the built-in tools a
  headless run exposes, independently of `--hermetic`. `none` maps to
  `--tools ""` for Claude Code and Z.AI and to disabled shell, exec,
  image, browser, computer-use, multi-agent and web-search features for
  Codex; Codex cannot drop `apply_patch`, so it takes `none` only with
  `--auto read-only`. Harnesses that cannot remove their tools refuse
  `none`, and `none` cannot be combined with `--enable-playwright-mcp`.
- `codemux check --hermetic` proves the mechanism with two real requests:
  a hermetic probe in a scratch directory carrying planted `AGENTS.md` and
  `CLAUDE.md` files with a random code word must answer `OK` without the
  code word, and a control probe without `--hermetic` must show the
  planted code word reaching the model; a control that answers anything
  else, stays clean, or fails also fails the check.
  `codemux verify` builds the hermetic command statically, and
  `codemux list` and `doctor` show which harnesses support `hermetic` and
  `tools`.

### Fixed

- `CODEX_API_KEY`, the variable Codex 0.154 actually reads for API-key
  authentication, is now forwarded to Codex runs alongside the older
  `OPENAI_API_KEY`. A hermetic Codex run authenticates with an API key
  only when that variable is set, so it never switches an operator with a
  stray `OPENAI_API_KEY` away from the account login a plain run uses.
- README and the compatibility ledger now list Kimi and OpenHands, name
  them among the argv-prompt harnesses, and describe the sandbox as on by
  default with `--no-sandbox` as the opt-out; SECURITY.md gives the same
  advice.

### Changed

- `check` moved into its own module and shares one launch path with `run`.
- A SIGINT, SIGTERM or SIGHUP to a headless `codemux run` is forwarded to
  the agent's whole process tree, which then gets the usual grace period
  before SIGKILL, and codemux stops with exit 143 instead of leaving the
  agent running after it is gone (or, when the signal lands during the
  harness version probe, launching the run anyway).
- Executable validation now covers a command's `env NAME=value` prefix and
  the program it launches, not only the first token.
- `verify` accepts an empty argument only as the value of `--tools`
  (`--tools ""` removes Claude's tools); any other empty argument still
  fails the wiring check.

## [0.5.1] - 2026-09-15

### Fixed

- `codemux verify` (and its tests) no longer reports Copilot's wiring as
  broken when the user's own temp root holds harness configuration, such as
  the `.claude/settings.local.json` a Claude Code session started in `$TMPDIR`
  leaves behind. The adapters' project-configuration walker climbs from the
  working directory to the nearest `.git`, so the neutral scratch directory
  `verify` builds commands in now carries an empty `.git` marker that ends the
  walk there; its ancestors are no longer inspected.

- Headless `claude` and `zai` runs could not write files. Both adapters set
  `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1` for subprocess env hygiene, and
  Claude Code 2.1.25x couples that variable to a permission hardening that
  force-resets the requested permission mode to `default`, where writes need
  the interactive approval a headless run cannot provide. Medium autonomy
  now also emits an `--allowedTools Edit(//<launch dir>/**)` grant (the
  hardening's documented escape hatch, anchored to the launch directory —
  the same paths acceptEdits would auto-approve, and immovable by an
  approved `cd`) beside the unchanged native flags, and high adds bare
  Edit, Write, NotebookEdit, and Bash grants, a subset of the bypass it
  always requested. Hardened versions write again, audited versions keep
  their previous headless behavior, and `high` under the hardening stays
  weaker than a true bypass. The hardening discards plan mode too, so a
  hardened read-only TUI prompts instead of planning — scode's read-only
  boundary still enforces the level. At medium, a launch directory
  containing a parenthesis, a backslash, a glob metacharacter, a tab or
  line break, or trailing whitespace refuses the launch — the rule
  grammar cannot represent any of them. Grants ride only on headless
  runs; the TUI keeps the native flags so a human approves;
  docs/HARNESS-COMPATIBILITY.md has the details.

- Timed-out runs now terminate their whole process tree. The runner killed
  the agent's process group, but Codex starts each tool command in a fresh
  process group, so a shell loop left behind by a timed-out agent kept
  running (one such loop opened `gtk3-demo-application` on the desktop
  minutes after its run had ended). The runner now also walks the process
  table by parent pid, remembers descendants together with their start
  times across the SIGTERM grace period so orphans reparented to init or
  to a subreaper are still reached by the SIGKILL escalation, and signals
  a remembered pid only while its start time is unchanged, so a pid reused
  by an unrelated process is not signaled (the one exception is a process
  table that cannot be read mid-escalation, where remembered pids are
  signaled unverified). Interactive runs keep SIGTERM
  child-only, so the
  agent can shut down its own children, but the SIGKILL escalation now
  covers the tree as well, including when the agent exits on SIGTERM before
  the grace period ends: its descendants get the rest of that period, then
  the SIGKILL, in both modes. Known limitation (accepted): the first snapshot
  is taken when the first termination signal fires, so a descendant whose
  chain of parents back to the agent had already broken by then, or that
  forks a new process and exits between two snapshots, escapes any
  pid-tree walk; closing that needs kernel help, which is what the scode
  boundary is for. Such a process holding the captured output open no
  longer makes the run hang: the runner stops reading one second after
  its SIGKILL escalation, returns the timeout, and notes it on stderr. The table comes from `/proc` on Linux and from `/bin/ps`
  by absolute path on macOS, never via PATH, so an agent that can write to
  a PATH entry from inside the sandbox cannot plant the binary the runner
  executes outside it. A host that denies process enumeration (codemux
  nested inside another sandbox) gets a warning on stderr and the 0.5.0
  immediate group-only kill, instead of a silent degrade.
- Sandboxed `claude` runs authenticate again with Claude Code 2.1.25x. That
  version keeps the on-disk credential mirror as a stub with emptied tokens
  and a zero expiry once the Keychain owns the credential. The 0.5.0 sync
  classified that stub as a foreign file and silently left it alone, so
  every sandboxed run failed with "OAuth session expired". The file side of
  the sync now also recognizes that stub (string `accessToken` and
  `refreshToken`, a numeric `expiresAt`, a `scopes` array, and no key this
  codemux does not know) as a stale mirror to refresh; the same stub with an
  unknown key is left untouched and reported on stderr, so a newer Claude
  Code format fails loudly rather than silently. It is refreshed
  alongside any file with a usable token as before; a value of any other
  shape stays foreign, and the Keychain side still demands a usable token
  before anything is written. Deliberate trade-off: the live token rests
  on disk again (mode 0600) where 2.1.25x had moved it Keychain-only;
  CODEMUX_NO_KEYCHAIN_SYNC=1 opts out entirely.

### Security

- `js-yaml` upgraded to 4.3.2 (GHSA-2883-xcg3-v3hh: unbounded CPU use on
  empty merge-key sources). Codemux only parses its own config files with it,
  so the exposure was to a hostile local config, not to agent output.

## [0.5.0] - 2026-08-21

### Fixed

- Static wiring verification (`codemux verify` and its tests) builds commands
  against a neutral scratch working directory instead of the checker's own
  cwd. An adapter that correctly refuses repository-local executable
  configuration (Copilot) no longer reports its wiring as broken when the
  checker itself runs inside such a repository — including this one, whose
  hook shim lives in `.claude/settings.json`.

### Added

- Sandboxed `claude` runs stay authenticated. Claude Code keeps an on-disk
  mirror of its Keychain credential at `~/.claude/.credentials.json`; the
  scode sandbox cannot reach the Keychain, so a sandboxed Claude reads only
  that file, and a rotated Keychain token leaves it stale — every sandboxed
  run then 401s. A new `prepareSandbox` adapter hook, on sandboxed
  (non-untrusted) launches, refreshes it. Scoped deliberately narrow: it only
  refreshes a file that already exists (never fabricates one; a file that is
  not a Claude credential mirror is reported foreign and left untouched);
  only the `claudeAiOauth` field is read or written, so co-stored `mcpOAuth`
  state is preserved; the Keychain replaces the file only when strictly newer
  (or, when an expiry is unorderable, when the tokens differ); and a final
  re-check re-reads the whole file before the atomic rename, backing off if it
  changed or was deleted at all. A symlinked target or parent is refused, and
  the sync is skipped when `CLAUDE_CONFIG_DIR` / `CLAUDE_SECURESTORAGE_CONFIG_DIR`
  is passed through (the child then reads a mirror it owns).
  `CODEMUX_NO_KEYCHAIN_SYNC=1` disables it. Known limitation (accepted):
  the refresh is lock-free, matching Claude Code's own handling of this
  file, so a token rotated by a concurrent sandboxed Claude in a microsecond
  window can be overwritten and lost for one launch (self-heals thereafter).
- OpenHands CLI adapter (`openhands`), audited against CLI 1.16.0. `--headless`
  auto-approves by design, so headless runs carry no native approval gate and
  depend on the scode boundary. `--llm-approve` is never emitted: it confirms
  only what an LLM predicts is high-risk, which is a different mechanism from
  graded human approval rather than a weaker form of it. Model selection goes
  through `--override-with-envs`, since 1.16.0 has no model flag. Project-local
  `.openhands` skills, hooks, agents, microagents, plugins, and profiles are
  rejected before launch.

## [0.4.0] - 2026-08-15

### Changed

- **The sandbox is the boundary, not the harness.** Every autonomy level below
  `high` now requires scode, and `--sandbox` is on by default for `run`, `tui`,
  and `check` (opt out with `--no-sandbox`). Harness-native permission controls
  are treated as defense in depth. Upstream can restructure them without
  removing the flags Codemux passes -- OpenCode 1.18.18 turned its deny map into
  a rules list resolving to allow-all, and `--agent build` kept working while
  silently losing its gate. Anchoring enforcement in scode means such a change
  costs a warning instead of a silent downgrade, and removes the need to track
  every harness's permission semantics. Gemini's interactive TUI carried an
  undocumented exemption from this rule and no longer does.

### Added

- Kimi Code CLI adapter (`kimi`), audited against 0.31.1. Interactive sessions
  map autonomy onto `--plan`, `--yolo`, and `--auto`; headless runs carry none
  of them, because 0.31.1 rejects all three alongside `--prompt`. Project-local
  `.kimi-code` agent, skill, and mcp directories are rejected before launch.
- A declared compatibility matrix (`src/harness-compatibility.ts`) checked
  before launch. Three tiers, because newer is not the same as broken: below
  `min` refuses, through `maxAudited` runs silently, and anything newer runs
  with a warning. Refusal above `maxAudited` requires an explicit `breaks`
  entry describing a determined change, scoped to the autonomy levels it
  actually removes enforcement from. `CODEMUX_ALLOW_UNTESTED_HARNESS=1`
  downgrades a refusal to a warning.
- The harness binary's identity (inode, size, mtime) is compared across the
  version probe, and a mismatch warns. The reported version was observed
  changing between invocations on the same machine, so the value read is not
  guaranteed to be the value that runs.

## [0.3.1] - 2026-08-13

### Fixed

- Provider-supplied strings relayed by usagemux (`plan`, `account`, `provider`,
  `message`, window `kind`, and credit `unit`) are escaped before reaching a
  terminal, so a hostile or compromised upstream response cannot emit ANSI/OSC
  sequences. `--json` was never affected: `JSON.stringify` escapes them.
- An oversized usagemux response now reports that its output was truncated
  instead of surfacing as "invalid JSON".
- `minimalPath()` in the test helpers no longer exposes the real directory
  holding `bun`. Once `bun` and `usagemux` shared a Homebrew prefix, the
  "usagemux is absent" tests passed or failed depending on the machine.

## [0.3.0] - 2026-08-04

### Added

- Optional `codemux usage` integration with the standalone `usagemux` CLI,
  including strict versioned JSON validation, quota and subscription-renewal
  metadata, human and JSON output, and non-failing discovery in `doctor`.

### Fixed

- Updated `js-yaml` to 4.3.1, clearing GHSA-5p4m-2wfm-xmqj (quadratic CPU
  consumption resolving `!!omap`).

## [0.2.1] - 2026-08-02

### Changed

- The Bun version check treats `packageManager` as a minimum rather than an
  exact match. CI still provisions the pinned version, but a newer local Bun no
  longer fails `make runtime`.

### Added

- Homebrew installation via `brew install bindsch/tap/codemux`, which pulls in
  `scode` as a dependency.

## [0.2.0] - 2026-08-02

### Added

- Structured release and testing documentation (`docs/RELEASE-GATE.md`, `docs/RELEASING.md`, `docs/TESTING.md`).
- Public contribution and private vulnerability-reporting guidance.
- `verify --show-scode` preview flow for effective sandbox command rendering.
- Per-harness sandbox policy defaults with explicit override flags.
- Adapters for Aider, Cline CLI, GitHub Copilot CLI, and Cursor Agent CLI.
- A dated compatibility ledger covering all 13 harnesses and their audited upstream versions.

### Changed

- Hardened autonomy mappings, sandbox defaults, configuration validation, Z.AI credentials, and process lifecycle handling.
- Coverage is enforced at 80% for lines and functions; release checks now include dependency audit and frozen-install validation.
- README rewritten into production-oriented structure with command/option references.
- Project gate workflow standardized via `Makefile` and `make check`.
- CI now runs the release gate on macOS and Linux with pinned actions and Bun.
- Standardized the project under the MIT license.
- Historical design notes moved under `docs/`; package metadata now points to
  the canonical GitHub repository.
- Shell aliases moved under `scripts/` with the other repository utilities.
- Refreshed built-in model aliases and split process execution from adapter
  validation to keep the runtime modules focused.
- Added Cursor's primary `agent` binary, stdin prompts, native Plan/Auto Review
  modes, workspace trust, and deterministic outer-sandbox integration.
- Expanded normalized reasoning effort through `minimal`, `xhigh`, `max`, and `ultra`
  where each harness supports those values.
- Require scode 0.2.0 or newer for sandbox launches and surface incompatible
  installations in `doctor` and the release gate.

### Fixed

- Prevented read-only modes from silently enabling writes in Claude, Z.AI, Cursor, Qwen fallback, and OpenCode.
- Fixed sandbox relative working directories, output truncation, pipe deadlocks, environment-test races, and invalid Droid/OpenCode flags.
- Removed implicit mutable `@latest` MCP execution; Playwright MCP is now local and opt-in.
- Validated TUI Playwright MCP binaries against the effective `--cwd`, closing
  a repository-local executable bypass.
- Prevented hostile working trees from injecting Bun preloads, dotenv settings,
  shell loaders, runtime search paths, or repository-authorized secret passthrough.
- Enforced durable read-only boundaries, process-tree timeouts,
  valid Gemini argv ordering, restricted Pi/Qwen startup behavior, and explicit
  errors for unsupported effort levels.
- Added installed third-party CLI contract checks to the release gate while
  keeping the hermetic default test suite independent of absent tools.
- Enabled Qwen's current `--safe-mode` and retained the outer read-only sandbox
  requirement for headless Gemini Plan Mode.
- Rejected repository-controlled executables, sandbox policy files, and
  Copilot hook/MCP/agent configuration across headless and TUI launch boundaries.
- Prevented OpenCode project plugins, dependency installation, custom tools,
  and configuration from executing before autonomy enforcement; all OpenCode
  launches now use pure mode.
- Updated Claude/Z.AI, Codex, OpenCode, Qwen, Copilot, Pi, Aider, and model-alias
  contracts for their current upstream CLIs; hardened project execution config
  checks across every applicable harness.
- Isolated Aider model metadata, Codex exec rules, Factory hooks/custom droids,
  Gemini local environment/native sandbox inputs, and OpenCode singular policy
  directories; Claude/Z.AI TUI sessions now disable repository customizations.

## [0.1.0] - 2026-02-24

### Added

- Initial unified CLI for multi-agent coding harnesses.
- Adapter architecture for `claude`, `codex`, `droid`, `goose`, `gemini`, `opencode`, `pi`, `qwen`, and `zai`.
- Normalized autonomy and reasoning-effort controls with per-adapter translation.
- Sandbox integration through `scode` for a single external sandbox boundary.
- Diagnostics commands: `list`, `doctor`, `check`, `autonomy`, and `verify`.
- Automated Bun test suite and TypeScript typecheck gate.
