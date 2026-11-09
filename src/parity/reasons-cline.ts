import { limitation } from "./features.js";

export const clineAnyCwd = limitation(
  "Cline loads project AGENTS.md, rules, skills, hooks and plugins unconditionally; its CLI has no project-discovery suppression flag, so hermetic runs require a clean explicit working directory.",
  "2026-11-09: Cline cli-v3.0.74 https://github.com/cline/cline/blob/cli-v3.0.74/apps/cli/src/commands/program.ts#L22-L103 (complete options); https://github.com/cline/cline/blob/cli-v3.0.74/sdk/packages/shared/src/storage/paths.ts#L495-L639 (workspace discovery).",
  "cline --hermetic requires a clean working directory", "tests/cline-run-parity.test.ts");

export const clineServed = limitation(
  "Cline run_result.model reports the configured model and provider, not the provider response identity; served_model remains null.",
  "2026-11-09: Cline cli-v3.0.74 https://github.com/cline/cline/blob/cli-v3.0.74/sdk/packages/core/src/runtime/orchestration/session-runtime-orchestrator.ts#L1587-L1637 assigns model.id=this.config.modelId and model.provider=this.config.providerId; https://github.com/cline/cline/blob/cli-v3.0.74/apps/cli/src/runtime/run-agent.ts#L369-L379 emits result.model.",
  "served_model: null", "tests/result-envelope-cline.test.ts");

export const clineBudget = limitation(
  "Cline exposes no native dollar spend cap. Plugins can request a stop, but the CLI ignores plugin setup and hook failures and exposes no fail-closed hook-error mode, so a plugin cannot guarantee a budget before spending occurs.",
  "2026-11-09: Cline cli-v3.0.74 https://github.com/cline/cline/blob/cli-v3.0.74/apps/cli/src/commands/program.ts#L22-L103 lists every CLI flag without a budget or hookErrorMode; https://github.com/cline/cline/blob/cli-v3.0.74/sdk/packages/core/src/extensions/plugin/plugin-registry.ts#L920-L984 catches setup/hook failures unless SDK-only hookErrorMode is throw; https://github.com/cline/cline/blob/cli-v3.0.74/sdk/packages/shared/src/session/runtime-config.ts#L49-L71 has no monetary limit.",
  "cline has no spend limit flag; --max-budget-usd is unsupported", "tests/cline-run-parity.test.ts");

