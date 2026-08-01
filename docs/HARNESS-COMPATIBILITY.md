# Harness Compatibility Ledger

Last audited: 2026-08-01.

This is the release contract for Codemux's external agent adapters. “Audited”
means the upstream release/changelog and current CLI reference were reviewed,
the latest help surface was inspected, and generated argv/env behavior was
covered by tests. Installed binaries were also exercised where available.

| Harness | Audited upstream | Installed during audit | Primary source | Important contract |
|---------|------------------|------------------------|----------------|--------------------|
| Aider | 0.86.2 | 0.86.2 | [PyPI](https://pypi.org/project/aider-chat/) | packaged empty config/model metadata, null env/history, no Git side effects, negative headless confirmations, common provider credentials allowlisted |
| Claude Code | 2.1.220 | 2.1.220 | [release](https://github.com/anthropics/claude-code/releases/tag/v2.1.220) | `manual` replaces removed public `default`; effort is low through max |
| Cline CLI | 3.0.48 | not installed | [CLI changelog](https://github.com/cline/cline/blob/main/apps/cli/CHANGELOG.md) | `cline -- ...`, explicit plan/auto-approve/thinking, project execution config rejected |
| Codex CLI | 0.146.0 | 0.145.0 | [release](https://github.com/openai/codex/releases/tag/rust-v0.146.0) | stdin prompt, explicit sandbox and approval policy, project config rejected |
| GitHub Copilot CLI | 1.0.77 | not installed | [release](https://github.com/github/copilot-cli/releases/tag/v1.0.77) | explicit `--effort none`, remote/project integrations disabled or rejected |
| Cursor Agent | rolling build 2026.07.23-e383d2b | same | [CLI installation](https://docs.cursor.com/en/cli/installation) | primary `agent`, legacy alias fallback, stdin, trust, Plan/Auto Review/Force, outer sandbox |
| Droid | 0.186.0 | 0.186.0 | [CLI reference](https://docs.factory.ai/reference/cli-reference) | stdin, native auto levels and model-aware reasoning-off values, project execution config rejected |
| Goose | 1.45.0 | not installed | [release](https://github.com/aaif-goose/goose/releases/tag/v1.45.0) | `GOOSE_MODE` chat/approve/smart_approve/auto, project extension config rejected |
| Gemini CLI | 0.53.1 | not installed | [release](https://github.com/google-gemini/gemini-cli/releases/tag/v0.53.1) | current approval modes; local `.env` and nested sandbox disabled; Plan requires an outer read-only boundary |
| OpenCode | 1.18.10 | 1.18.10 | [release](https://github.com/anomalyco/opencode/releases/tag/v1.18.10) | pure mode, plan/build/auto, headless `--variant`, all policy-bearing project config rejected |
| Pi | 0.83.0 | not installed | [release](https://github.com/earendil-works/pi/releases/tag/v0.83.0) | new `@earendil-works/pi-coding-agent` package, stdin, no project packages, explicit tools |
| Qwen Code | 0.21.2 | not installed | [release](https://github.com/QwenLM/qwen-code/releases/tag/v0.21.2) | current `qwen`, safe mode, plan/default/auto/yolo; sandbox-only legacy fallback |
| Z.AI | Claude 2.1.220 transport | Claude 2.1.220 | [Z.AI Claude setup](https://docs.z.ai/devpack/tool/claude) | official Anthropic-compatible endpoint/env and Claude permission contract |

The local Codex installation was behind the audited upstream version. Its
latest distribution was inspected separately; Codemux does not silently mutate
user-installed tools. Droid updated itself to the audited release during its
manual CLI inspection.

Sandbox execution requires scode 0.2.0 or newer. Codemux checks this before
launch so older wrappers cannot silently miss a newly supported harness. The
installed audit version was 0.1.0, so this machine's sandbox launches are
intentionally blocked until scode is upgraded.

Gemini CLI 0.53.1 remains usable with API-key or enterprise authentication.
Google's individual subscription and free-tier CLI login moved to Antigravity;
see the [official announcement](https://github.com/google-gemini/gemini-cli/discussions/28017).

## Behavioral invariants

- Prompts use stdin whenever the upstream CLI supports it. Aider, Cline,
  Copilot, Gemini, Goose, and legacy `qwen-coder` retain bounded argv prompts.
- `read-only` is a durable filesystem boundary. Cursor, Gemini, and OpenCode
  Plan modes still require `scode --ro` where upstream can transition or write
  artifacts.
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
