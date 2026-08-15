# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

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
