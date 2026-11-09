import {
  readProviderOverride,
  requireProviderOverride,
  type ProviderOverride,
} from "./provider-override.js";
import { UsageRefusalError } from "./validation.js";

/**
 * The kimi arm of the provider override: kimi's only env-driven custom
 * provider is the `KIMI_MODEL_*` synthesis, which needs a base URL and a
 * key (setting `KIMI_MODEL_NAME` makes the CLI synthesize a temporary
 * provider in memory, with the key, base URL and protocol from the sibling
 * variables — kimi-code docs, "Define a model from environment
 * variables"). Read 2026-11-09 from kimi-code 2.5.2 bin/kimi: KIMI_MODEL_NAME
 * at byte 98837975, KIMI_MODEL_PROVIDER_TYPE at 97380610, and the completion
 * and context cap keys at 98838304 and 98838780. The variables are read from the real process environment,
 * so the override needs no file and works in every run kind.
 */

/** The override, validated: null when no override is active. */
export function kimiValidatedProvider(
  environment: NodeJS.ProcessEnv
): (ProviderOverride & { baseUrl: string; apiKey: string }) | null {
  const override = readProviderOverride("kimi", environment);
  if (override === null) return null;
  return requireProviderOverride("kimi", override, [
    "baseUrl",
    "apiKey",
  ]) as ProviderOverride & { baseUrl: string; apiKey: string };
}

/** The model id the synthesized provider sends: the request's, else the
 * override's. An override with neither is a usage refusal (exit 64), so
 * the operator's own login and default model cannot silently answer. */
export function kimiProviderModelFor(
  environment: NodeJS.ProcessEnv,
  model: string | undefined
): string | undefined {
  const override = kimiValidatedProvider(environment);
  const resolved = model ?? override?.model;
  if (resolved === undefined && override !== null) {
    throw new UsageRefusalError(
      "kimi needs a model for the provider override; pass --model or set CODEMUX_KIMI_PROVIDER_MODEL"
    );
  }
  return resolved;
}

/** The `KIMI_MODEL_*` environment for an active override, else nothing.
 * The model id is resolved with the same refusal as modelFor, so a
 * half-configured override never launches. */
export function kimiProviderEnv(
  environment: NodeJS.ProcessEnv,
  model: string | undefined
): Record<string, string> {
  const override = kimiValidatedProvider(environment);
  if (override === null) return {};
  return {
    KIMI_MODEL_NAME: kimiProviderModelFor(environment, model)!,
    KIMI_MODEL_API_KEY: override.apiKey,
    KIMI_MODEL_BASE_URL: override.baseUrl,
    // The Z.AI-style endpoints the override targets speak the OpenAI
    // chat-completions protocol; kimi's own protocol is the default.
    KIMI_MODEL_PROVIDER_TYPE: "openai",
    // The caps ride the sibling variables the synthesis reads:
    // KIMI_MODEL_MAX_COMPLETION_TOKENS is the reply budget's hard cap and
    // KIMI_MODEL_MAX_CONTEXT_SIZE the context window. The names differ by
    // one word and are not interchangeable — MAX_OUTPUT_SIZE is a knob of
    // a different unit, deliberately unused.
    ...(override.maxOutputTokens !== undefined
      ? { KIMI_MODEL_MAX_COMPLETION_TOKENS: String(override.maxOutputTokens) }
      : {}),
    ...(override.maxContextTokens !== undefined
      ? { KIMI_MODEL_MAX_CONTEXT_SIZE: String(override.maxContextTokens) }
      : {}),
  };
}
