import { claudeProviderPickerSettings } from "./claude-family.js";
import type { ReasoningEffort } from "./types.js";
import { UsageRefusalError } from "./validation.js";

/** Claude Code 2.1.317, audited 2026-11-09: bin/claude.exe byte 256464926
 * explicitly permits disabled thinking for these IDs. Always-on models are
 * silently promoted to adaptive at byte 265265938, so aliases cannot pass. */
export const CLAUDE_NONE_MODELS = [
  "claude-opus-4-0", "claude-opus-4-1", "claude-opus-4-5", "claude-opus-4-6",
  "claude-opus-4-7", "claude-opus-4-8", "claude-opus-5",
  "claude-sonnet-4-0", "claude-sonnet-4-5", "claude-sonnet-4-6", "claude-sonnet-5",
  "claude-haiku-4-5",
] as const;

const NONE_MODELS: ReadonlySet<string> = new Set(CLAUDE_NONE_MODELS);
const MODEL_ALIASES = /^(?:opus|sonnet|haiku|fable|mythos|default|auto)(?:\[.*\])?$/i;
const NONE_ENV_CONFLICTS = new Set([
  "CLAUDE_CODE_EXTRA_BODY", "CLAUDE_CODE_MODEL_CATALOG", "CLAUDE_CODE_DISABLE_THINKING",
]);

export interface ClaudeEffortRequest {
  agent: "claude" | "zai";
  effort?: ReasoningEffort;
  model?: string;
  /** Exact owned picker payload that will be emitted with this model. */
  providerSettings?: string;
  passthroughEnv?: readonly string[];
}

/** Validate before any launch work, including direct command-builder calls. */
export function validateClaudeEffort(request: ClaudeEffortRequest): void {
  if (request.effort !== "none") return;
  const conflict = request.passthroughEnv?.find((name) =>
    NONE_ENV_CONFLICTS.has(name) || name.startsWith("CLAUDE_CODE_USE_"));
  if (conflict !== undefined) {
    throw new UsageRefusalError(`${request.agent} --effort none cannot be combined with --pass-env ${conflict}`);
  }
  const model = request.model;
  const native = model !== undefined && NONE_MODELS.has(model);
  const ownedPicker = model !== undefined && !MODEL_ALIASES.test(model) &&
    !model.toLowerCase().startsWith("claude-") &&
    request.providerSettings === claudeProviderPickerSettings(model);
  if (!native && !ownedPicker) {
    throw new UsageRefusalError(
      `${request.agent} --effort none requires a verified thinking-disable model ` +
      "(for example claude-sonnet-5) or an owned provider picker; " +
      `model '${model ?? "default"}' may require thinking or resolve to an always-on model`);
  }
}

/** Native mode at byte 273382200; it takes precedence over token budgets. */
export function claudeEffortFlags(effort: ReasoningEffort): string[] {
  return effort === "none" ? ["--thinking", "disabled"] : ["--effort", effort];
}
