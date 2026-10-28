---
read_when: "Checking harness versions, compatibility warnings, or TUI restrictions."
---
# Harnesses

Codemux 0.13.3 supports the adapters below. The documented source baseline is revision `194151e`. An adapter's minimum version and audited ceiling are code-enforced declarations. An installed version or successful live probe is separate evidence; neither silently changes that declaration.

## Headless capabilities

This matrix describes `codemux run`. “Yes” means the adapter implements the option; it does not mean every model or installed upstream version supports every value. Every adapter accepts the four autonomy levels, with scode required below high. An unsupported hermetic, tools-none, result-json, or provider-override request is refused before launch.

| Agent | Model | Autonomy | Effort values | Hermetic | Tools none | Result JSON | Provider override |
| --- | --- | --- | --- | --- | --- | --- | --- |
| agy | yes | all four | low, medium, high, xhigh, max | yes, clean cwd and read-only scode | yes, denial/attempt detection | yes | no |
| aider | yes | all four | none, minimal, low, medium, high, xhigh, max | no | no | no | yes |
| claude | yes | all four | low, medium, high, xhigh, max | yes | yes | yes | yes |
| cline | yes | all four | none, low, medium, high, xhigh | no | no | no | no |
| codex | yes | all four | none, minimal, low, medium, high, xhigh, max, ultra | yes | read-only only; two tools remain | yes | yes |
| copilot | yes | all four | none, minimal, low, medium, high, xhigh, max | no | no | no | no |
| cursor | yes | all four | unsupported | no | no | no | no |
| droid | yes | all four | none, minimal, low, medium, high, xhigh, max | no | yes; ToolSearch remains | no | yes |
| goose | yes | all four | unsupported | no | yes | no | yes |
| gemini | yes | all four | unsupported | no | no | no | no |
| kimi | yes | all four | unsupported | no | yes | no | yes |
| openhands | yes | all four | unsupported | no | no | no | yes |
| opencode | yes | all four | low, medium, high | yes | hermetic only | no | yes |
| pi | yes | all four | none, minimal, low, medium, high, xhigh, max | no | yes | no | yes |
| qwen | current binary only | all four | unsupported | no | no | no | no |
| zai | yes | all four | none, low, medium, high, xhigh, max | yes | yes | yes | no |

For a headless adapter with no effort support, `--effort none` is accepted as no request; other values are refused. Supported adapters reject values outside their row. Qwen's legacy `qwen-coder` fallback has no model selection and requires scode even at high autonomy. [Isolation](isolation.md) defines the tool exceptions and clean-directory requirements. [Result envelopes](results-and-usage.md) describe the four structured adapters. [Provider overrides](provider-overrides.md) cover endpoint and token-limit constraints.

## Version contracts

| Harness | Agent ID | Minimum | Audited ceiling | Dated installed evidence | Live evidence |
| --- | --- | --- | --- | --- | --- |
| Antigravity CLI | agy | 1.2.14 | 1.2.14 | 1.3.3, 2026-10-13 | Plain login and isolation checks passed on the recorded Round 11 tree. Later hardening was not live-retested. |
| Aider | aider | 0.86.0 | 0.86.2 | 0.86.2, 2026-09-17 | Config injection reproduced 2026-10-04; earlier hermetic approval withdrawn. |
| Claude Code | claude | 2.1.220 | 2.1.223 | 2.1.280, 2026-10-10 | 2.1.270 isolation on 2026-09-17; 2.1.280 experiment MCP and override evidence retained. |
| Cline CLI | cline | none | none | 3.0.62, 2026-09-17 | Workspace instruction leak; isolation refused. |
| Codex CLI | codex | 0.146.0 | 0.147.0 | 0.160.1, 2026-10-10 | 0.154.0 isolation on 2026-09-17; 0.159.3 session wire evidence. |
| GitHub Copilot CLI | copilot | 1.0.77 | 1.0.85 | 1.0.85, 2026-09-21 | 2026-09-17 tool and instruction probes; 2026-09-21 flag audit. |
| Cursor Agent | cursor | 2026.07.23 | 2026.08.11 | 2026.08.11-e8db854, 2026-10-10 | Launch/flag checks only; no authenticated model completion. |
| Droid | droid | 0.186.0 | 0.186.0 | 0.221.0, 2026-09-17 | Tools-none read probe passed; ordinary shell probe blocked by nested sandbox. |
| Goose | goose | none | none | 1.50.1, 2026-09-17 | Tools-none capability probes; instruction leak. |
| Gemini CLI | gemini | none | none | 0.60.0, 2026-09-17 | Instruction leak; tool-removal claim later withdrawn. |
| Kimi Code | kimi | 0.31.0 | 0.31.1 | 2.3.2, 2026-10-28 | Tools-none on 2026-09-17; session behavior recorded in October; 2.3.2 headless bullet replies observed on 2026-10-28. |
| OpenHands | openhands | 1.16.0 | 1.16.0 | 1.16.0, 2026-10-07 | Project instruction leak and provider routing. |
| OpenCode | opencode | 1.18.10 | 1.18.18 | 1.18.18, 2026-09-17 | Hermetic/tools-none probes, with later remote-config refusal corrections. |
| Pi | pi | none | none | 0.85.1, 2026-09-17 | Tools-none capability probes; instruction leak. |
| Qwen Code | qwen | none | none | 0.24.0, 2026-09-17 | Safe-mode control stayed clean; isolation canary cannot verify an additional flag. |
| Z.AI | zai | 2.1.220 | 2.1.223 | Claude 2.1.280, 2026-10-10 | Uses the same Claude binary; gateway/environment checks retained. |

“None” means no entry in `HARNESS_CONTRACTS`; codemux does not apply a version floor or audited ceiling for that adapter. It does not mean all upstream releases are verified. Installed evidence is historical, not a fresh inventory of this checkout's host.

The [dated evidence report](archive/isolation-verification.md) names retained sources and limits. The live-tested codemux revision is not recorded for several checks. Do not substitute `194151e`, a release tag, or the current documentation branch for an unknown tested revision.

## Version enforcement

Before launch, codemux resolves and trust-checks the executable, probes its version with a sanitized environment, and checks its file identity to detect replacement between probe and launch.

- Below minimum: refuse.
- Minimum through audited ceiling: proceed without a version warning.
- Above audited ceiling: warn and proceed unless a known incompatible change applies.
- Unknown version: warn for ordinary contracts; Copilot refuses because its contract requires `--binary-version`.
- No contract entry: no version check for that harness.
- `CODEMUX_ALLOW_UNTESTED_HARNESS=1`: explicitly downgrade version refusals to warnings. It does not provide missing enforcement.

OpenCode 1.18.18 and later have a recorded permission change: `--agent build` alone no longer gates writes or execution. Low/medium unsandboxed launches are refused by the compatibility rule; scode mitigates that filesystem boundary. Session transports can require higher floors than one-shot runs; see [sessions](sessions.md).

Version checks matter beyond scode. Scode controls filesystem/network access, while native policies control tool exposure, approval, prompt discovery, transport framing, and result interpretation. A working sandbox does not verify those semantics.

## Harness selection and prompt transport

Use `codemux list` for discovery, `codemux doctor` for local configuration diagnostics, and `codemux verify --show-scode` for static command previews. A preview does not authenticate or prove model behavior. `codemux check` sends a real request and spends quota.

Cursor resolves the explicit `CODEMUX_CURSOR_ENTRY=cursor` opt-in first, then `cursor-agent`, then `agent`. Pass the opt-in with `--pass-env CODEMUX_CURSOR_ENTRY`. The desktop wrapper can install or update the standalone agent; codemux does not invoke it automatically. Its version probe is `cursor agent --version`, not the desktop app's version.

Antigravity binds its prompt as `--print=<prompt>` and uses equals forms for enum flags. **The prompt reaches process argv even when codemux reads it from `-f` or stdin.** Kimi and OpenHands also use argv prompt transport. Codemux avoids printing those prompts, but input-file or stdin selection cannot hide them from process inspection when the upstream interface requires argv.

## Headless reply output

Kimi's headless bullet format was observed on 2.3.2: each reply block starts with a `• ` prefix, and continuation lines use two spaces. When the installed version probe reports major version 2 or higher and all stdout follows this format, codemux removes those prefixes and indents, joins blocks with one blank line, and ends the reply with one newline. For example, `• A\n  B\n\n` becomes `A\nB\n`. Versions 0.x and 1.x and unknown versions keep their output unchanged. Plain replies and other output stay unchanged. Stderr stays unchanged.

## TUI restrictions

All adapters provide an interactive entry point, but headless options do not automatically apply there. Hermetic mode, tools selection, result envelopes, and experiment MCP injection are not TUI options.

| Harness | TUI restriction |
| --- | --- |
| Codex, Droid, Pi, OpenCode | Provider overrides refused: their generated configuration needs the headless lifecycle. |
| Droid | Explicit model refused. Requested effort is ignored with a warning because the interactive entry has no supported carrier. |
| OpenCode | Requested effort is ignored with a warning; `--variant` belongs to headless run. |
| Claude, Z.AI, Codex, Antigravity, Aider, Copilot, Cline, Pi | Supported effort values follow the adapter's advertised set, with any restrictions above. |
| Cursor, Gemini, Kimi, OpenHands, Goose, Qwen | Requested effort is ignored with a warning because these adapters have no TUI effort support. |
| Claude | Provider override uses environment plus inline `--settings` model-picker JSON in TUI, as in run/session. |
| Aider, Kimi, Goose, OpenHands | Supported provider overrides use their environment mappings in TUI. |

`codemux tui` defaults to read-only autonomy under scode, as headless run does. Every level below high requires scode. Use `--no-sandbox --auto high` only when explicitly choosing native unrestricted execution. See [autonomy and sandboxing](autonomy-and-sandboxing.md), [isolation](isolation.md), and [provider overrides](provider-overrides.md).

Sources: [version contracts](../src/harness-compatibility.ts), [adapter implementations](../src/adapters/), [CLI launch](../src/index.ts).
