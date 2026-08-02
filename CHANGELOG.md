# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- The Bun version check treats `packageManager` as a minimum rather than an
  exact match. CI still provisions the pinned version, but a newer local Bun no
  longer fails `make runtime`.

### Added

- Homebrew installation via `brew install bindsch/tap/codemux`, which pulls in
  `scode` as a dependency.

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
