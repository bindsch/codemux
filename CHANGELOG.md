# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Provider overrides: point one harness at a different model provider
  through `CODEMUX_<AGENT>_PROVIDER_{BASE_URL,API_KEY,MODEL}` (blank values
  count as unset; a half-configured override refuses the launch). The key is
  delivered through the environment codemux itself provides or through a
  private per-run file, never through an operator configuration file, so an
  override survives `--hermetic`. Aider is the first consumer: the override
  rides `OPENAI_API_BASE`/`OPENAI_API_KEY` with litellm's `openai/` model
  prefix. OpenHands follows the same mechanism through
  `LLM_BASE_URL`/`LLM_API_KEY`/`LLM_MODEL` behind `--override-with-envs`
  (exercised live 2026-09-17 against GLM-5.3 via Z.AI: the plain control
  probe leaked the planted code word, confirming both the override and the
  hermetic refusal's grounding). Documented in the README ("Provider
  overrides").
- Aider claims `--hermetic`, verified live on 2026-09-17 through the
  provider override (GLM-5.3 via Z.AI): the two-probe check passed with the
  planted code word reaching the control probe. The check's answer now comes
  from a per-run chat-history file under `~/.aider/.codemux/` (aider's
  stdout is a transcript; the history holds the bare reply and the model's
  reasoning), with the code-word scan covering stdout plus the full history.
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
  at 0.24.0 (installed via npm) through a provider override (GLM-5.3 via
  Z.AI): the override rides the `OPENAI_API_KEY`/`OPENAI_BASE_URL`/
  `OPENAI_MODEL` group qwen documents for headless setups, so the key
  never touches argv or an operator file. The non-hermetic control probe
  stayed clean — every codemux qwen run already carries `--safe-mode`,
  which closes every operator channel, so the check's control can never
  leak and `--hermetic` can never pass by design — while the plain read
  and shell probes produced the planted secret and its transform, so the
  harness demonstrably ran against Z.AI with its tools intact;
  `--tools none` stays refused because no tool-removal flag survives
  safe mode.
- Cline keeps refusing both capabilities, now verified live on
  2026-09-17 at 3.0.62 (installed via npm) through a provider override
  (GLM-5.3 via Z.AI): `CODEMUX_CLINE_PROVIDER_{BASE_URL,API_KEY,MODEL}`
  writes a private per-run data directory passed as `--data-dir`, whose
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
- Gemini's `--tools none` mechanism is implemented but cannot be claimed on
  a user-owned prefix: gemini 0.60.0 was installed and exercised live on
  2026-09-17, and its system-settings layer requires the settings file and
  every ancestor directory up to `/` to be owned by root (uid 0) — a rule
  present identically at the audited 0.53.1 — or the file is skipped with a
  warning and the run starts with its tools restored. The private per-run
  file under `~/.gemini/.codemux/` that `--tools none` writes is therefore
  always skipped on such a machine (observed live through the identical
  warning on the packaged file). The same warning shows the packaged
  system-settings pins every plain gemini run points at
  (`resources/gemini-system-settings.json`: generic project `.env` loading
  disabled, `.gemini` project controls rejected, nested sandbox disabled)
  have never loaded on a user-owned prefix either — a documented contract
  gap, not a regression. Gemini keeps refusing `--hermetic`: no switch
  closes the workspace channels, gemini loads only `GEMINI.md` — never the
  `AGENTS.md` or `CLAUDE.md` the check plants, so a leaking control probe is
  impossible — and the live pass found no custom-provider path to verify
  against either: `GOOGLE_GEMINI_BASE_URL` resolves to the "gateway" auth
  type the CLI's own validator rejects, pinning API-key auth still landed
  the request on Google, and Z.AI serves no Gemini-protocol endpoint (only
  Anthropic and OpenAI protocols, docs.z.ai/devpack/tool/others).
- Copilot's hermetic and tool-selection mechanisms are implemented but not
  yet claimed: `--hermetic` points `COPILOT_HOME` at a private, empty config
  directory (relocating the user settings, hooks, instructions, skills,
  agents, plugins, MCP config and memories, and stopping `~/.agents/skills`
  loading) while `--no-custom-instructions`, the prompt-mode trust gates and
  the pre-launch rejection of repository executables close the repo channels,
  and the keychain login, keyed by service name rather than path, keeps
  working. `--tools none` maps onto a bare `--available-tools`, whose empty
  allowlist the native tool filter resolves to no enabled tool. Copilot is
  not installed on the release machine, so both stay unclaimed until the
  live check and the capability probe run there.
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
