---
read_when: "Checking harness versions, compatibility warnings, or TUI restrictions."
---
# Harnesses

Codemux supports the adapters below; run `codemux --version` to identify an installed release. An adapter's minimum version and audited ceiling are code-enforced declarations. An installed version or successful live probe is separate evidence; neither silently changes that declaration.

## Headless capabilities

This matrix describes `codemux run`. “Yes” means the adapter implements the option; it does not mean every model or installed upstream version supports every value. Every adapter accepts the four autonomy levels, with scode required below high. An unsupported hermetic, tools-none, result-json, or provider-override request is refused before launch.

| Agent | Model | Autonomy | Effort values | Hermetic | Tools none | Result JSON | Provider override |
| --- | --- | --- | --- | --- | --- | --- | --- |
| agy | yes | all four | low, medium, high, xhigh, max | yes, clean cwd and read-only scode | yes, denial/attempt detection | yes | no |
| aider | yes | all four | none, minimal, low, medium, high, xhigh, max | no | no | no | yes |
| claude | yes | all four | low, medium, high, xhigh, max | yes | yes | yes | yes |
| cline | yes | all four | none, low, medium, high, xhigh | no | no | no | no |
| codex | yes | all four | minimal, low, medium, high, xhigh, max, ultra | yes | read-only only; two tools remain | yes | yes |
| copilot | yes | all four | none, minimal, low, medium, high, xhigh, max | no | no | no | no |
| cursor | yes | all four | unsupported | no | no | no | no |
| droid | yes | all four | none, minimal, low, medium, high, xhigh, max | no | yes; ToolSearch remains | no | yes |
| goose | yes | all four | unsupported | no | yes | no | yes |
| gemini | yes | all four | unsupported | no | no | no | no |
| kimi | yes | all four | unsupported | yes | yes | yes | yes |
| openhands | yes | all four | unsupported | no | no | no | yes |
| opencode | yes | all four | low, medium, high | yes | hermetic only | yes | yes |
| pi | yes | all four | none, minimal, low, medium, high, xhigh, max | no | yes | no | yes |
| qwen | current binary only | all four | unsupported | no | no | no | no |
| zai | yes; non-catalog ids ride picker settings | all four | none, low, medium, high, xhigh, max | yes | yes | yes | no |

`--effort none` is the CLI's "send no effort flag" spelling on every adapter: a harness whose effort list has no native `none` launches with no effort flag, and the adapters that carry a native `none` (aider, cline, copilot, droid, pi, zai) send their own mapping of it. Other values outside a row are refused. Qwen's legacy `qwen-coder` fallback has no model selection and requires scode even at high autonomy. [Isolation](isolation.md) defines the tool exceptions and clean-directory requirements. [Result envelopes](results-and-usage.md) describe the six structured adapters. [Provider overrides](provider-overrides.md) cover endpoint and token-limit constraints.

Codex sessions carry one recorded parity gap with hermetic runs. A hermetic run ignores execpolicy rules (`~/.codex/rules`), but the app-server thread config has no verified carrier for that setting, so a codex session still loads them. The thread config skips only AGENTS.md discovery (`project_doc_max_bytes: 0` and an empty fallback list); it is not the session equivalent of run's `--ignore-rules`. A pinned test (tests/session-codex-wire.test.ts) asserts the config carries exactly those two keys, so the gap stays visible.

## Version contracts

| Harness | Agent ID | Minimum | Audited ceiling | Installed on the release machine | Dated installed evidence | Live evidence |
| --- | --- | --- | --- | --- | --- | --- |
| Antigravity CLI | agy | 1.2.14 | 1.5.2 | 1.5.2 (2026-11-06) | 1.5.2, 2026-11-06 | 2026-11-06 live gate (2.0.0 candidate): read-only reply, medium shell, result JSON, hermetic check, one session turn, and the sandbox policy and print probes passed on 1.5.2 with scode 0.6.2. agy updated itself from 1.4.12 during the first run, so the model-backed probes were rerun on 1.5.2. |
| Aider | aider | 0.86.0 | 0.86.2 | 0.86.2 | 0.86.2, 2026-09-17 | Config injection reproduced 2026-10-04; earlier hermetic approval withdrawn. |
| Claude Code | claude | 2.1.220 | 2.1.317 | 2.1.317 (2026-11-06) | 2.1.317, 2026-11-06 | 2026-11-06 live gate (2.0.0 candidate): read-only reply, medium shell, result JSON, hermetic check, one session turn, the experiment MCP run, the loopback override, the alias and effort run, and the sandbox policy and print probes passed on 2.1.317. 2.1.280 override evidence retained. |
| Cline CLI | cline | none | none | not installed | 3.0.62, 2026-09-17 | Workspace instruction leak; isolation refused. |
| Codex CLI | codex | 0.146.0 | 0.165.0 | 0.166.0 (2026-11-06) | 0.165.0, 2026-11-02 | 2026-11-02 live gate (2.0.0 candidate): read-only reply, medium shell, result JSON, hermetic check, one session turn, and the experiment MCP run passed on 0.165.0; 0.159.3 session wire evidence retained. |
| GitHub Copilot CLI | copilot | 1.0.77 | 1.0.85 | 1.0.85 | 1.0.85, 2026-09-21 | 2026-09-17 tool and instruction probes; 2026-09-21 flag audit. |
| Cursor Agent | cursor | 2026.07.23 | 2026.11.05 | 2026.11.05 (2026-11-06) | 2026.11.05, 2026-11-06 | 2026-11-06 live gate (2.0.0 candidate): the probes the contract supports passed on 2026.11.05: the read-only reply and the medium shell run, both answered by the model, and the sandbox policy and print probes. cursor updated itself from 2026.10.22 during the first run, so the two model-backed probes were rerun on 2026.11.05. |
| Droid | droid | 0.186.0 | 0.186.0 | 0.221.0 | 0.221.0, 2026-09-17 | Tools-none read probe passed; ordinary shell probe blocked by nested sandbox. No credentials on the release machine on 2026-11-02, so the ceiling stays. |
| Goose | goose | none | none | 1.50.1 | 1.50.1, 2026-09-17 | Tools-none capability probes; instruction leak. |
| Gemini CLI | gemini | none | none | 0.60.0 | 0.60.0, 2026-09-17 | Instruction leak; tool-removal claim later withdrawn. |
| Kimi Code | kimi | 0.31.0 | 2.5.0 | 2.5.0 (2026-11-06) | 2.5.0, 2026-11-06 | 2026-11-06 live gate (2.0.0 candidate): read-only reply, medium shell, result JSON, hermetic check, one session turn, the experiment MCP run, the loopback override, and the sandbox policy and print probes passed on 2.5.0. The experiment run first failed on 2.5.0's usage record, which leaves out `inputCacheRead` when nothing was read from cache; codemux now counts the absent field as zero. The 400 s held tool call returned over SSE on 2.4.0 (2026-11-02). |
| OpenHands | openhands | 1.16.0 | 1.16.0 | not recorded | 1.16.0, 2026-10-07 | Project instruction leak and provider routing. |
| OpenCode | opencode | 1.18.10 | 1.19.5 | 1.19.5 (2026-11-06) | 1.19.5, 2026-11-06 | 2026-11-06 live gate (2.0.0 candidate): read-only reply, medium shell, result JSON, hermetic check, tools-none under hermetic, one session turn, the loopback override, and the sandbox policy and print probes passed on 1.19.5 under the sandbox. The break recorded from 1.18.18 at low and medium autonomy stands; the sandbox mitigates it. |
| Pi | pi | none | none | 0.85.1 | 0.85.1, 2026-09-17 | Tools-none capability probes; instruction leak. |
| Qwen Code | qwen | none | none | 0.24.0 | 0.24.0, 2026-09-17 | Safe-mode control stayed clean; isolation canary cannot verify an additional flag. |
| Z.AI | zai | 2.1.220 | 2.1.317 | Claude 2.1.317 (2026-11-06) | Claude 2.1.317, 2026-11-06 | Uses the same Claude binary; 2026-11-06 live gate (2.0.0 candidate): read-only reply, medium shell, result JSON, hermetic check, one session turn, the experiment MCP run, the alias and effort run, and the sandbox policy and print probes passed. |

“None” means no entry in `HARNESS_CONTRACTS`; codemux does not apply a version floor or audited ceiling for that adapter. It does not mean all upstream releases are verified. Installed evidence is historical, not a fresh inventory of this checkout's host. The installed column records the binaries on the release machine on 2026-11-02, or on 2026-11-06 where the cell carries that date (scode 0.6.2 with them). Two harnesses sit above their audited ceilings and warn on launch until a live gate covers them: droid has no credentials on the release machine, and codex's login had expired on 2026-11-06. A ceiling or floor moves only together with recorded live-gate evidence; see the [release gate](RELEASE-GATE.md).

Last live-verified, per row: agy, claude, cursor, kimi, opencode, and zai 2026-11-06, and codex 2026-11-02 (both the 2.0.0 candidate gate); aider, copilot, droid, gemini, goose, openhands, pi, and qwen September or October 2026 at the latest, with no credentials on the release machine for 2.0.0; cline not installed, its last probes refused isolation. Those nine rows are static contracts for 2.0.0 — code-enforced declarations, not freshly probed behavior — until a credentialed machine live-gates them.

The [dated evidence report](archive/isolation-verification.md) names retained sources and limits. The live-tested codemux revision is not recorded for several checks. Do not substitute a release tag or the current documentation branch for an unknown tested revision.

## Version enforcement

Before launch, codemux resolves and trust-checks the executable, probes its version with a sanitized environment, and checks its file identity to detect replacement between probe and launch.

- Below minimum: refuse.
- Minimum through audited ceiling: proceed without a version warning.
- Above audited ceiling: warn and proceed unless a known incompatible change applies.
- Unknown version: warn for ordinary contracts; Copilot refuses because its contract requires `--binary-version`.
- No contract entry: no version check for that harness.
- `CODEMUX_ALLOW_UNTESTED_HARNESS=1`: explicitly downgrade version refusals to warnings. It does not provide missing enforcement.

OpenCode 1.18.18 and later have a recorded permission change: `--agent build` alone no longer gates writes or execution. Low/medium unsandboxed launches are refused by the compatibility rule; scode mitigates that filesystem boundary. Session transports can require higher floors than one-shot runs; see [sessions](sessions.md).

Experiment MCP has a separate version floor: Claude/Z.AI require Claude Code 2.1.280 or later, Codex requires CLI 0.165.0 or later, and Kimi requires Code 2.3.2 or later. Codex requires the spec's `codex-wall-time` opt-in, explicit `-m`, and a populated real model cache matching the detected client version. Every Codex experiment serves a sanitized catalog, including direct, omitted, and null tool modes: for every served model, Codemux deletes `tool_mode` and `multi_agent_version`, removes only `clock` from `experimental_supported_tools`, and sets `apply_patch_tool_type` to null. The preserved `gpt-6-astra` run at 02:13 on October 29, 2026 verified backend acceptance and direct tool delivery. See the [catalog evidence](experiment-codex-catalog.md#rollout-evidence-and-correlation). Experiment flags still disable `code_mode` and `code_mode_host`, and foreign function or custom `exec` calls fail with `unknown_tool`. Kimi requires `kimi-wall-time`; Codemux reconstructs its provider content from wire records using the 2.3.2 renderer. Codex and Kimi use an authenticated loopback MCP relay. Kimi's tools-none experiment profile permits only the experiment MCP namespace. Live probes on October 29, 2026 confirmed Kimi's projected header and Codex's `exec` code-mode call. These experiment floors do not change the ordinary-run declarations above. See [experiment MCP](experiment-mcp.md).

Version checks matter beyond scode. Scode controls filesystem/network access, while native policies control tool exposure, approval, prompt discovery, transport framing, and result interpretation. A working sandbox does not verify those semantics.

## Harness selection and prompt transport

Use `codemux list` for discovery, `codemux doctor` for local configuration diagnostics, and `codemux verify --show-scode` for static command previews. `list` marks each agent with its capability labels (`model`, `autonomy`, `effort`, `hermetic`, `tools`, `provider`, `result-json`, `sessions`); `doctor` prints the same capabilities per installed harness plus a version-contract verdict — ok, above the audited ceiling, below the minimum, a known break at named autonomy levels from a recorded version, no contract, `untrusted binary (<reason>)` (the probe refused a binary that fails the launch trust check), or unreadable (possibly timed out) — from the same local version probe the launch gate uses, with no model request. A preview does not authenticate or prove model behavior. `codemux check` sends a real request and spends quota.

Cursor resolves the explicit `CODEMUX_CURSOR_ENTRY=cursor` opt-in first, then `cursor-agent`, then `agent`. Pass the opt-in with `--pass-env CODEMUX_CURSOR_ENTRY`. The desktop wrapper can install or update the standalone agent; codemux does not invoke it automatically. Its version probe is `cursor agent --version`, not the desktop app's version.

Antigravity binds its prompt as `--print=<prompt>` and uses equals forms for enum flags. **The prompt reaches process argv even when codemux reads it from `-f` or stdin.** Kimi and OpenHands also use argv prompt transport. Codemux avoids printing those prompts, but input-file or stdin selection cannot hide them from process inspection when the upstream interface requires argv.

## Headless reply output

Kimi's headless bullet format was observed on 2.3.2: each reply block starts with a `• ` prefix, and continuation lines use two spaces. When the installed version probe reports major version 2 or higher and all stdout follows this format, codemux removes those prefixes and indents, joins blocks with one blank line, and ends the reply with one newline. For example, `• A\n  B\n\n` becomes `A\nB\n`. Versions 0.x and 1.x and unknown versions keep their output unchanged. Plain replies and other output stay unchanged. Stderr stays unchanged.

Kimi hermetic runs use private HOME/KIMI_CODE_HOME directories, a filtered config, an empty skill directory, and an explicit agent file. Project customization paths are refused; see [isolation](isolation.md). Result-json runs use stream JSON plus the session wire log for usage; see [results](results-and-usage.md). These mechanisms are grounded in 2.3.2 source and verified with synthetic fixtures. No new live check is claimed.

An October 29, 2026 comparison against Kimi 2.4.0 retains the experiment floor at 2.3.2: the reproduced result rendering and wire evidence remain equivalent. `run-v2-print.ts` changes telemetry, Plan mode, and workspace leases; `loopService.ts` adds logging and a warning watchdog. The MCP connection manager adds liveness probing and reconnect handling. Codemux's relay answers pings locally and replays the cached successful initialize result without clearing held tool calls. Every recording now includes `t`; existing event timestamps are preserved. See [the source line ranges](experiment-mcp.md#kimi-configuration-and-delivery-evidence) and [recording schema](experiment-mcp.md#normalized-records). The fresh live 2.4.0 `hold:400000` probe with these fixes remains pending.

## TUI restrictions

All adapters provide an interactive entry point, but headless options do not automatically apply there. Hermetic mode, tools selection, result envelopes, and experiment MCP injection are not TUI options. The one hermetic carry-over is structural: every Claude and Z.AI TUI launch passes `--safe-mode`, the customization-off baseline of a hermetic run (first row below).

| Harness | TUI restriction |
| --- | --- |
| Claude, Z.AI | The TUI launches with `--safe-mode`: every customization source (user and project memory, skills, plugins, hooks, MCP servers) starts disabled, the same baseline a hermetic run uses. `--bare` is not used because it never reads the OAuth login, so a subscription run would silently bill an API key. The Playwright MCP option is the one launch that keeps the user settings source instead. |
| Codex, Droid, Pi, OpenCode | Provider overrides refused: their generated configuration needs the headless lifecycle. |
| Droid | Explicit model refused. `--effort` with a level is refused (exit 64): the interactive entry has no supported carrier; `--effort none` (no flag) is accepted. |
| OpenCode | `--effort` with a level is refused (exit 64) in TUI mode; `--effort none` (no flag) is accepted. `--variant` belongs to headless run. |
| Claude, Z.AI, Codex, Antigravity, Aider, Copilot, Cline, Pi | Supported effort values follow the adapter's advertised set, with any restrictions above. |
| Cursor, Gemini, Kimi, OpenHands, Goose, Qwen | Effort values are refused (exit 64) as on run; `--effort none` (no flag) is accepted. |
| Claude | Provider override uses environment plus inline `--settings` model-picker JSON in TUI, as in run/session. |
| Aider, Kimi, Goose, OpenHands | Supported provider overrides use their environment mappings in TUI. |

`codemux tui` defaults to read-only autonomy under scode, as headless run does. Every level below high requires scode. Use `--no-sandbox --auto high` only when explicitly choosing native unrestricted execution. See [autonomy and sandboxing](autonomy-and-sandboxing.md), [isolation](isolation.md), and [provider overrides](provider-overrides.md).

Sources: [version contracts](../src/harness-compatibility.ts), [adapter implementations](../src/adapters/), [CLI launch](../src/index.ts).
