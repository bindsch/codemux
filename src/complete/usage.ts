/**
 * One completion's usage in the ledger's terms (docs/results-and-usage.md:
 * `input_tokens` is input not served from cache, `cached_input_tokens` the
 * cache reads and writes), read from either wire.
 */

import type { ResultUsageBlock } from "../types.js";
import type { PricedTokens } from "./prices.js";

export interface CompletionUsage extends PricedTokens {
  /** Missing counts stay null in the ledger, even when a charge arrived. */
  inputKnown?: boolean;
  outputKnown?: boolean;
  /** Supplied billing dimensions that the price table cannot interpret. */
  priceKnown?: boolean;
  /** Supplied usage fields are valid, independent of table coverage. */
  fieldsValid?: boolean;
  /** A charge the provider itself reported (OpenRouter `usage.cost`). */
  reportedCostUsd: number | null;
}

type Json = Record<string, unknown>;

/** Server tools can have charges outside the token table. */
export function hasNativeToolCharge(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const type = (value as Json)["type"];
  return typeof type === "string" && (type === "server_tool_use" || type === "container_upload" || type.endsWith("_tool_result"));
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function count(value: unknown): number {
  return isCount(value) ? value : 0;
}

function optionalCount(value: unknown): boolean {
  return value === undefined || value === null || isCount(value);
}

/** Validate supplied subtotals before using or ignoring them. They may
 * overlap (for example reasoning and text); each must fit its own total. */
function detailsKnown(value: unknown, fields: readonly string[], total: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value !== "object" || Array.isArray(value)) return false;
  return fields.every((field) => {
    const n = (value as Json)[field];
    return optionalCount(n) && (!isCount(n) || !isCount(total) || n <= total);
  });
}

function anthropicCountsKnown(u: Json): boolean {
  const fields = ["input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"];
  if (!fields.every((field) => optionalCount(u[field]))) return false;
  if (!isCount(fields.reduce((sum, field) => sum + count(u[field]), 0))) return false;
  const creation = u["cache_creation"];
  if (!detailsKnown(creation, ["ephemeral_5m_input_tokens", "ephemeral_1h_input_tokens"], count(u["cache_creation_input_tokens"]))) return false;
  if (typeof creation === "object" && creation !== null) {
    const c = creation as Json;
    if (isCount(c["ephemeral_5m_input_tokens"]) && isCount(c["ephemeral_1h_input_tokens"]) &&
      isCount(u["cache_creation_input_tokens"]) &&
      c["ephemeral_5m_input_tokens"] + c["ephemeral_1h_input_tokens"] !== u["cache_creation_input_tokens"]) return false;
  }
  return detailsKnown(u["output_tokens_details"], ["thinking_tokens"], u["output_tokens"]);
}

function noExtraCharge(value: unknown, fields: readonly string[]): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value !== "object" || Array.isArray(value)) return false;
  return fields.every((field) => {
    const n = (value as Json)[field];
    return n === undefined || n === null || n === 0;
  });
}

/** Optional billing dimensions from the pinned Anthropic Usage type below.
 * The table prices standard inference and five-minute cache writes only. */
export function anthropicPriceKnown(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const u = value as Json;
  return anthropicCountsKnown(u) &&
    noExtraCharge(u["cache_creation"], ["ephemeral_1h_input_tokens"]) &&
    noExtraCharge(u["server_tool_use"], ["web_search_requests", "web_fetch_requests"]) &&
    [undefined, null, "standard"].includes(u["service_tier"] as string | null | undefined) &&
    [undefined, null, "standard"].includes(u["speed"] as string | null | undefined) &&
    [undefined, null, "global"].includes(u["inference_geo"] as string | null | undefined);
}

/** OpenAI `usage`: `prompt_tokens` includes the cached part
 * (`prompt_tokens_details.cached_tokens`); `completion_tokens` includes
 * reasoning tokens. Null when the response carried no usage object, or
 * one without any counts or a reported charge. Missing counts are retained
 * as unknown; they never become a zero-cost completion. */
export function usageFromOpenAI(usage: unknown): CompletionUsage | null {
  if (typeof usage !== "object" || usage === null || Array.isArray(usage)) return null;
  const u = usage as Json;
  const details = u["prompt_tokens_details"];
  const validDetails = detailsKnown(details,
    ["cached_tokens", "audio_tokens", "cache_write_tokens", "image_tokens", "text_tokens"], u["prompt_tokens"]);
  const inputKnown = isCount(u["prompt_tokens"]) && validDetails;
  const outputKnown = isCount(u["completion_tokens"]);
  const cost = u["cost"];
  const reportedCostUsd = typeof cost === "number" && Number.isFinite(cost) && cost >= 0 ? cost : null;
  const total = u["total_tokens"];
  const prompt = count(u["prompt_tokens"]);
  const output = count(u["completion_tokens"]);
  const fieldsValid = ["prompt_tokens", "completion_tokens", "total_tokens"].every((field) => optionalCount(u[field])) &&
    (cost === undefined || cost === null || reportedCostUsd !== null) && validDetails &&
    detailsKnown(u["completion_tokens_details"],
      ["accepted_prediction_tokens", "rejected_prediction_tokens", "audio_tokens", "reasoning_tokens", "text_tokens"], u["completion_tokens"]) &&
    (!inputKnown || !outputKnown || (isCount(prompt + output) &&
      (total === undefined || total === null || total === prompt + output))) &&
    (!isCount(total) || ((!isCount(u["prompt_tokens"]) || u["prompt_tokens"] <= total) &&
      (!isCount(u["completion_tokens"]) || u["completion_tokens"] <= total)));
  const priceKnown = fieldsValid &&
    noExtraCharge(details, ["audio_tokens", "cache_write_tokens"]) &&
    noExtraCharge(u["completion_tokens_details"], ["audio_tokens"]);
  if (!inputKnown && !outputKnown && reportedCostUsd === null && priceKnown) return null;
  const cached = inputKnown ? count((details as Json | null | undefined)?.["cached_tokens"]) : 0;
  return {
    ...(!fieldsValid ? { fieldsValid: false } : {}),
    ...(!priceKnown ? { priceKnown: false } : {}),
    ...(!inputKnown ? { inputKnown: false } : {}),
    ...(!outputKnown ? { outputKnown: false } : {}),
    input: inputKnown ? prompt - cached : 0,
    cacheRead: cached,
    cacheWrite: 0,
    output,
    reportedCostUsd,
  };
}

/** Anthropic `usage`: `input_tokens` excludes the cache, which reports
 * `cache_read_input_tokens` and `cache_creation_input_tokens` apart.
 * Both cache fields are Optional[int] = None; malformed supplied counts
 * are not absence. Source: Usage and MessageDeltaUsage at
 * https://github.com/anthropics/anthropic-sdk-python/tree/5139cf2e7d07aa618a6c30b7e0c712f10ccb5ad9/src/anthropic/types
 */
export function usageFromAnthropic(usage: unknown): CompletionUsage {
  const u = (typeof usage === "object" && usage !== null ? usage : {}) as Json;
  return {
    ...(!anthropicPriceKnown(u) ? { priceKnown: false } : {}),
    ...(!isCount(u["input_tokens"]) || !optionalCount(u["cache_read_input_tokens"]) ||
      !optionalCount(u["cache_creation_input_tokens"]) ? { inputKnown: false } : {}),
    ...(!isCount(u["output_tokens"]) ? { outputKnown: false } : {}),
    input: count(u["input_tokens"]),
    cacheRead: count(u["cache_read_input_tokens"]),
    cacheWrite: count(u["cache_creation_input_tokens"]),
    output: count(u["output_tokens"]),
    reportedCostUsd: null,
  };
}

/** The OpenAI `usage` object a translated Anthropic answer carries. */
export function openAIUsage(usage: CompletionUsage): Json {
  const prompt = usage.input + usage.cacheRead + usage.cacheWrite;
  return {
    prompt_tokens: prompt,
    completion_tokens: usage.output,
    total_tokens: prompt + usage.output,
    prompt_tokens_details: { cached_tokens: usage.cacheRead },
  };
}

/** The ledger's usage block, with the cost the governor settled on. */
export function ledgerUsage(usage: CompletionUsage | null, costUsd: number | null): ResultUsageBlock {
  if (usage === null) {
    return { input_tokens: null, output_tokens: null, cached_input_tokens: null, total_tokens: null, cost_usd: costUsd };
  }
  const cached = usage.cacheRead + usage.cacheWrite;
  const total = usage.input + cached + usage.output;
  return {
    input_tokens: usage.inputKnown === false ? null : usage.input,
    output_tokens: usage.outputKnown === false ? null : usage.output,
    cached_input_tokens: usage.inputKnown === false || !isCount(cached) ? null : cached,
    total_tokens: usage.inputKnown === false || usage.outputKnown === false || !isCount(total) ? null : total,
    cost_usd: costUsd,
  };
}
