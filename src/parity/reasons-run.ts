import { limitation, supported } from "./features.js";

export const RUN_REASONS = {
  opencodeServed: limitation(
    "OpenCode 1.19.5 pure mode excludes every external plugin, including an owned private-home observer, with no allowlist. Run JSON omits the served model, and telemetry substitutes the requested model when response metadata omits it.",
    "2026-11-09: installed bin/opencode 1.19.5, UTF-16LE server plugin gate at byte 102534694: let T=n.pure?[]:y.plugin_origins??[]; telemetry initializes modelId:ct.modelId at byte 101170148 and retains it through modelId:(Rt=j.modelId)!=null?Rt:Be.modelId at byte 101171242. Private plugin paths have no exception.",
    "served_model: null", "tests/opencode-served-model-limit.test.ts"),
  opencodeBudget: limitation(
    "OpenCode 1.19.5 has no monetary spend cap in its run arguments, config schema, or runtime flags; step_finish cost is accounting only.",
    "2026-11-09: installed opencode bundle embeds Oe=1.19.5; run option table and Config schema expose no spend cap; maxBudget, max_budget, budget_usd, and spend_limit strings are absent. Matching source: cli/cmd/run.ts and core/v1/config/config.ts.",
    "opencode has no spend limit flag; --max-budget-usd is unsupported", "tests/opencode-run-parity.test.ts"),
  cursorEffort: limitation(
    "Cursor 2026.11.05 silently drops unsupported model parameter combinations, so bracket parameters cannot deliver a verified effort tier.",
    "2026-11-09: src/adapters/cursor.ts; Cursor 2026.11.05 483.index.js sanitizeParametersForModelChange",
    "cursor does not support reasoning effort", "tests/cli-run-refusals.test.ts"),
  geminiEffort: limitation(
    "Gemini CLI 0.60.0 exposes no effort flag, environment variable, or settings key; ThinkingLevel is assigned only by internal presets.",
    "2026-11-09: src/adapters/gemini.ts; Gemini 0.60.0 gemini-LUNNHKPJ.js flags and chunk-M6NSK26M.js ThinkingLevel assignments",
    "gemini does not support reasoning effort", "tests/cli-run-refusals.test.ts"),
  openhandsEffort: limitation(
    "OpenHands 1.16.0 exposes no effort argument, and LLMEnvOverrides.from_env reads only the API key, base URL, and model.",
    "2026-11-09: src/adapters/openhands.ts; OpenHands 1.16.0 openhands_cli/argparsers/main_parser.py and agent_store.py LLMEnvOverrides.from_env",
    "openhands does not support reasoning effort", "tests/cli-run-refusals.test.ts"),
  claudeNoneEffort: limitation(
    "Claude Code 2.1.317 has no fail-closed thinking disable. It accepts --thinking disabled and silently promotes it to adaptive thinking on always-on models, which include the 5.5 models the default opus, sonnet, and haiku aliases resolve to. Settings modelOverrides can remap an accepted model id before that check, and no flag makes the binary fail instead of promoting. Codemux cannot guarantee disable-or-refuse, so the CLI's none sends no effort flag (the shared rule in docs/cli.md) and a direct request for native none is refused.",
    "2026-11-09: /opt/homebrew/lib/node_modules/@anthropic-ai/claude-code 2.1.317 bin/claude.exe byte 256465535 `function KMi(e,n){if(!n||e.type!==\"disabled\"||e.mechanical===!0)return e;return{type:\"adaptive\"`; byte 265265938 `KMi(r,Xt.thinking.alwaysOn||...)` on the request path; byte 256445126 `function Qe(e,n){let r=Ok(e,n)` resolving modelOverrides (`overridesMap??Ju()`) first; byte 273382200 `--thinking <mode>` choices enabled, adaptive, disabled with no fail mode. scratch/fix/w1-claude-none-audit.md lists the catalog rows marked rejects_disabled_thinking.",
    "claude does not support reasoning effort 'none'", "tests/claude-effort.test.ts"),
  zaiNoneEffort: limitation(
    "Claude Code 2.1.317 has no fail-closed thinking disable. It accepts --thinking disabled and silently promotes it to adaptive thinking on always-on models, which include the 5.5 models the default opus, sonnet, and haiku aliases resolve to. Settings modelOverrides can remap an accepted model id before that check, and no flag makes the binary fail instead of promoting. Codemux cannot guarantee disable-or-refuse, so the CLI's none sends no effort flag (the shared rule in docs/cli.md) and a direct request for native none is refused. Zai runs the same binary.",
    "2026-11-09: /opt/homebrew/lib/node_modules/@anthropic-ai/claude-code 2.1.317 bin/claude.exe byte 256465535 `function KMi(e,n){if(!n||e.type!==\"disabled\"||e.mechanical===!0)return e;return{type:\"adaptive\"`; byte 265265938 `KMi(r,Xt.thinking.alwaysOn||...)` on the request path; byte 256445126 `function Qe(e,n){let r=Ok(e,n)` resolving modelOverrides (`overridesMap??Ju()`) first; byte 273382200 `--thinking <mode>` choices enabled, adaptive, disabled with no fail mode. scratch/fix/w1-claude-none-audit.md lists the catalog rows marked rejects_disabled_thinking.",
    "zai does not support reasoning effort 'none'", "tests/claude-effort.test.ts"),
  codexNoneEffort: supported("tests/session-codex-catalog.test.ts",
    "Codex rust-v0.166.0 ReasoningEffort::None serializes to none; run/TUI config and session turn/start preserve it."),
  codexServed: limitation(
    "Codex 0.166.0 exec reports a served model only when it differs from the request. The Responses OpenAI-Model header reaches maybe_warn_on_server_model_mismatch, whose only exec --json output is the `model rerouted: <from> -> <to>` notice that codemux parses. The OTEL session telemetry logs server_model only as a codex.sse_event event.kind label with no value attribute, and the priced cost.model comes from the app-server turn-cost worker, which exec never runs. A run without a reroute therefore has no served-model evidence, and served_model stays null.",
    "2026-11-09: installed codex 0.166.0 (/opt/homebrew/Caskroom/codex/0.166.0/bin/codex) byte 203498027 `model rerouted: ` (the exec json notice); byte 264367117 symbol Session::maybe_warn_on_server_model_mismatch; byte 208133380 the codex.sse_event event.kind names `server_model model_verifications ...` beside attributes event.kind, error.message, and token counts only (otel/src/events/session_telemetry.rs:927,1092); rust-v0.166.0 app-server/src/turn_cost_worker.rs:466-501 record_turn_cost. No codemux option enables the exporter, so no live run was made (scratch/fix/report-f47.md).",
    "served_model: null", "tests/result-envelope-codex.test.ts"),
  codexCost: supported("tests/codex-native-cost.test.ts",
    "Codex >=0.166.0 can report threadUsage.nativeUsageUsdMicros through one bounded read-only account/usage/read after exec. The same executable pin, environment, private home, and sandbox policy are retained. Estimates, unavailable API-key/custom-provider pricing, and network-denied reads remain null."),
  codexBudget: limitation(
    "Codex 0.166.0 exposes token budgets, not a per-run USD limit. rollout_budget enforces weighted input/output tokens and accepts provider rollout-budget units; goals use max_goal_token_budget. Converting either into dollars would require wrapper pricing and would not enforce provider-reported spend.",
    "2026-11-09: rust-v0.166.0 core/config.schema.json RolloutBudgetConfigToml (enabled, enforce_limit, limit_tokens, prefill_token_weight, sampling_token_weight, reminder_at_remaining_tokens) and GoalsToml; core/src/rollout_budget.rs compares weighted_tokens_used to limit_tokens. No USD setting appears in the schema or ResponsesApiRequest.",
    "codex has no spend limit flag; --max-budget-usd is unsupported", "tests/cli-run-budget.test.ts"),
  kimiServed: limitation(
    "Kimi's print wire omits the served model. Its durable usage.record does carry model, but that value is the requested model alias, not provider response evidence, so served_model remains null.",
    "2026-11-09: kimi-code 2.5.2 bin/kimi usageRecordSchema at byte 102419348 includes model; requester code at byte 104184768 calls usage.record with request.modelAlias and returns model: request.modelAlias. PromptJsonWriter omits model. src/result-envelope/kimi.ts reports served_model: null.",
    "served_model: null", "tests/kimi-result-json.test.ts"),
  kimiCost: limitation(
    "Kimi's usage.record counts tokens only. Neither the print wire nor the durable usage record reports a monetary cost, so cost_usd remains null.",
    "2026-11-09: kimi-code 2.5.2 bin/kimi usage.record usage contains inputOther, output, inputCacheCreation, inputCacheRead. The separate session protocol total_cost_usd field at bytes 109341698 and 109342279 is initialized to zero and declared optional; it is not emitted by PromptJsonWriter or populated by usage.record. src/kimi-wire-log.ts returns cost_usd null.",
    "cost_usd is null; kimi reports no cost", "tests/kimi-result-json.test.ts"),
  kimiBudget: limitation(
    "Kimi has no spend cap: the root option table and configuration expose no monetary limit, so a per-run USD ceiling has no carrier.",
    "2026-11-09: kimi-code 2.5.2 bin/kimi root option table at bytes 111493000-111497700 has no monetary cap. Config sections contain no monetary limit; max_budget and spend_limit strings are absent. Other budget strings concern prompt/plugin size, not USD spend.",
    "kimi has no spend limit flag; --max-budget-usd is unsupported", "tests/cli-run-budget.test.ts"),
  kimiPlaywright: limitation(
    "OPEN: Kimi's private mcp.json Playwright carrier is implemented and tested, but shared run/session/TUI activation still needs distinct lifecycle handling. This is codemux work, not a harness limitation.",
    "2026-11-09: kimi-code 2.5.2 bin/kimi mcp/config.ts byte 93510784 resolves user servers from KIMI_CODE_HOME/mcp.json. src/kimi-run-policy.ts preserves existing servers and records the trusted executable. src/mcp.ts still omits kimi to prevent session/TUI launches silently dropping the option.",
    "--enable-playwright-mcp is supported only by", "tests/kimi-run-policy.test.ts"),
  kimiStdin: limitation(
    "Kimi's only print-mode prompt carrier is --prompt in argv, so an oversized prompt cannot switch to stdin and is refused at the argv limit.",
    "2026-11-09: kimi-code 2.5.2 bin/kimi runV2Print at byte 114036510 passes opts.prompt to runNativeTurn; root options at bytes 111493000-111497700 expose no stdin transport. src/adapters/kimi.ts getStdinInput returns null; src/adapters/base-validate.ts enforces the argv-prompt bound.",
    "kimi passes prompts in argv", "tests/kimi.test.ts"),
  cursorHermetic: limitation(
    "Cursor loads instructions and servers from the account root under the real home (.cursor/rules, .cursor/commands, mcp.json) with no channel suppression flag; its dataDir setting relocates only data state, so no verified isolation carrier exists.",
    "2026-11-09: src/adapters/cursor.ts capabilities; installed cursor-agent 2026.11.05-86047df 1706.index.js offsets 178180 and 178445 read join(homedir(), \".cursor\", \"rules\"/\"commands\"), 240051 resolves mcp.json under homedir(), 24043 maps the dataDir setting to CURSOR_DATA_DIR for data state only",
    "cursor has no verified hermetic mode", "tests/hermetic.test.ts"),
  aiderJson: limitation(
    "Aider 0.86.2 has no JSON output mode in its argparse surface.",
    "2026-11-09: src/adapters/aider.ts capabilities records the aider 0.86.2 argparse inspection; aider/args.py",
    "aider cannot return a structured result envelope", "tests/cli-run-refusals.test.ts"),
  opencodePlainTools: limitation(
    "OpenCode's operator configuration can override the permission deny per agent, so tool removal requires a hermetic run.",
    "2026-09-17: src/adapters/opencode.ts capabilities; src/adapters/opencode-env.ts OPENCODE_NO_TOOLS_PERMISSION",
    "opencode --tools none requires --hermetic", "tests/hermetic-harness-mappings-opencode.test.ts"),
  geminiPlainTools: limitation(
    "OPEN: Gemini tool removal uses a private settings file only in hermetic mode; this implementation choice does not exclude another plain-run carrier.",
    "2026-11-09: src/adapters/gemini.ts validateRunRequest; Gemini 0.60.0 chunk-VCAJDPDX.js tools.exclude",
    "gemini --tools none is delivered through the hermetic private home's settings.json", "tests/adapters-gemini.test.ts"),
  geminiCaps: limitation(
    "OPEN: Gemini provider token caps are parsed but neither delivered nor refused by its provider environment builder.",
    "2026-11-09: src/adapters/gemini.ts validatedProvider and providerEnv; src/provider-override.ts",
    "", "tests/adapters-gemini.test.ts"),
} as const;
