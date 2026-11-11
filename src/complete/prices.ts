/**
 * The dated price table `codemux complete` uses to estimate spend from the
 * token counts a provider reports (docs/complete.md). Prices are US dollars
 * per million tokens at the standard (global, non-batch) tier, as each
 * provider's public price page stated them on PRICES_AS_OF:
 *
 * - Anthropic: https://platform.claude.com/docs/en/about-claude/pricing
 * - OpenAI: https://developers.openai.com/api/docs/pricing
 *
 * They are an estimate for the spend cap, not a bill: check them against
 * the provider's page before a paid campaign, and pass
 * `--input-usd-per-mtok`/`--output-usd-per-mtok` for a model the table does
 * not list or prices differently. A model with no price is refused, never
 * served at an unknown cost, so the cap always has a number to count. The
 * one exception is OpenRouter, which reports its own charge: an unlisted
 * model is served there, and an answer that comes back without a charge
 * stops the server (governor.ts).
 *
 * Left out on purpose, so they are refused unless the flags price them:
 * models the page no longer lists (claude-3-5-haiku, gpt-4.1-nano,
 * o4-mini); OpenAI models with a long-context tier whose long prices the
 * page did not state in a form we could read (gpt-5.4, gpt-5.5, their
 * -pro variants); and OpenAI models that bill cache writes (gpt-5.6-*,
 * gpt-6-*), because the OpenAI usage object codemux reads reports no cache
 * write count to price.
 *
 * Cache pricing follows each provider's rule. Anthropic bills five-minute
 * cache writes at 1.25x the input price and cache reads at 0.1x, except
 * 0.025x on Fable/Mythos 5.1 and 5.2 and 0.05x on Opus 5.5 and Sonnet 5.5.
 * OpenAI bills cached input at the listed cached price. OpenRouter reports
 * its own charge (`usage.cost`), which is used when present instead of
 * this table. Not modeled: Anthropic's 1.1x `inference_geo: "us"` uplift
 * and OpenAI's 10% regional-processing uplift (requests use the default
 * global routing).
 */

export const PRICES_AS_OF = "2026-11-10";

export interface ModelPrice {
  /** USD per million uncached input tokens. */
  input: number;
  /** USD per million output tokens (reasoning tokens included). */
  output: number;
  /** USD per million cache-read input tokens; defaults to `input`. */
  cachedInput?: number;
  /** USD per million cache-write input tokens; defaults to `input`. */
  cacheWrite?: number;
  /** A higher price for a request whose whole prompt (uncached input,
   * cache reads, and cache writes) exceeds `aboveInputTokens`. */
  longContext?: { aboveInputTokens: number; price: ModelPrice };
}

/** An Anthropic price: five-minute cache writes at 1.25x the input price,
 * cache reads at the input price divided by `cacheReadDivisor` (10, so
 * 0.1x, unless the page says otherwise for the model). A divisor, not a
 * ratio, keeps the stored prices exact in binary floating point. */
function anthropic(input: number, output: number, cacheReadDivisor = 10): ModelPrice {
  return { input, output, cachedInput: input / cacheReadDivisor, cacheWrite: (input * 5) / 4 };
}

/** Keyed by the model id without a date suffix (see baseModelId). */
const TABLE: Readonly<Record<string, ModelPrice>> = Object.freeze({
  // Anthropic (platform.claude.com/docs/en/about-claude/pricing).
  "claude-fable-5-2": anthropic(8, 40, 40),
  "claude-mythos-5-2": anthropic(8, 40, 40),
  "claude-fable-5-1": anthropic(10, 50, 40),
  "claude-mythos-5-1": anthropic(10, 50, 40),
  "claude-fable-5": anthropic(10, 50),
  "claude-mythos-5": anthropic(10, 50),
  "claude-opus-5-5": anthropic(4, 20, 20),
  "claude-opus-5": anthropic(5, 25),
  "claude-opus-4-8": anthropic(5, 25),
  "claude-opus-4-7": anthropic(5, 25),
  "claude-opus-4-6": anthropic(5, 25),
  "claude-opus-4-5": anthropic(5, 25),
  "claude-opus-4-1": anthropic(15, 75),
  "claude-opus-4": anthropic(15, 75),
  "claude-sonnet-5-5": anthropic(2, 10, 20),
  "claude-sonnet-5": anthropic(2, 10),
  "claude-sonnet-4-6": anthropic(3, 15),
  "claude-sonnet-4-5": anthropic(3, 15),
  "claude-sonnet-4": anthropic(3, 15),
  "claude-haiku-5-5": {
    ...anthropic(0.1, 0.5),
    longContext: { aboveInputTokens: 100_000, price: anthropic(0.5, 2.5) },
  },
  "claude-haiku-4-5": anthropic(1, 5),
  // OpenAI (developers.openai.com/api/docs/pricing), standard tier.
  "gpt-5.4-mini": { input: 0.75, output: 4.5, cachedInput: 0.075 },
  "gpt-5.4-nano": { input: 0.2, output: 1.25, cachedInput: 0.02 },
  "gpt-5.2": { input: 1.75, output: 14, cachedInput: 0.175 },
  "gpt-5.1": { input: 1.25, output: 10, cachedInput: 0.125 },
  "gpt-5": { input: 1.25, output: 10, cachedInput: 0.125 },
  "gpt-5-mini": { input: 0.25, output: 2, cachedInput: 0.025 },
  "gpt-5-nano": { input: 0.05, output: 0.4, cachedInput: 0.005 },
  "gpt-4.1": { input: 2, output: 8, cachedInput: 0.5 },
  "gpt-4.1-mini": { input: 0.4, output: 1.6, cachedInput: 0.1 },
  "gpt-4o": { input: 2.5, output: 10, cachedInput: 1.25 },
  "gpt-4o-mini": { input: 0.15, output: 0.6, cachedInput: 0.075 },
  "o3": { input: 2, output: 8, cachedInput: 0.5 },
});

/** A model id without, for OpenRouter ids, the vendor prefix
 * (`anthropic/…`) and, for Claude ids only, the snapshot date
 * (`-20250929`) and OpenRouter's dotted version (`claude-sonnet-4.5` →
 * `claude-sonnet-4-5`): Anthropic prices a model, not a snapshot. OpenAI
 * ids keep their date, because OpenAI prices some snapshots apart from
 * their base model (`gpt-4o-2024-05-13` costs more than `gpt-4o`), so a
 * dated OpenAI id the table does not list is refused, not priced as its
 * base. */
export function baseModelId(model: string): string {
  let id = model.trim().toLowerCase();
  const slash = id.lastIndexOf("/");
  if (slash >= 0) id = id.slice(slash + 1);
  if (id.startsWith("claude-")) {
    id = id.replace(/-\d{8}$/, "").replace(/(\d)\.(\d)/g, "$1-$2");
  }
  return id;
}

/** The price for a model: the operator's override when given, else the
 * table entry for its base id, else null (the request is refused). */
export function priceFor(model: string, override: ModelPrice | null): ModelPrice | null {
  if (override !== null) return override;
  const id = baseModelId(model);
  // An own-property lookup: a model named `__proto__` or `toString` is
  // unpriced, never an inherited object.
  return Object.hasOwn(TABLE, id) ? TABLE[id]! : null;
}

/** True when `served` is a dated snapshot of the alias `requested` (the
 * provider resolved `gpt-4o` to `gpt-4o-2024-08-06`): the provider bills
 * the call at the alias's price. */
export function isSnapshotOf(served: string, requested: string): boolean {
  const base = baseModelId(requested);
  const id = baseModelId(served);
  return id === base || (id.startsWith(`${base}-`) && /^\d{4}-\d{2}-\d{2}$/.test(id.slice(base.length + 1)));
}

/** Token counts in the ledger's semantics: `input` is uncached input,
 * `cacheRead` and `cacheWrite` the cached breakdown, `output` output. */
export interface PricedTokens {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
}

/** The estimated cost in USD of one call's tokens at one price. A request
 * whose whole prompt exceeds a long-context threshold pays that tier's
 * price for all its tokens, as the provider bills it. */
export function estimateCost(tokens: PricedTokens, price: ModelPrice): number {
  const prompt = tokens.input + tokens.cacheRead + tokens.cacheWrite;
  const tier = price.longContext !== undefined && prompt > price.longContext.aboveInputTokens
    ? price.longContext.price : price;
  const perToken = (usdPerMtok: number) => usdPerMtok / 1_000_000;
  return (
    tokens.input * perToken(tier.input) +
    tokens.cacheRead * perToken(tier.cachedInput ?? tier.input) +
    tokens.cacheWrite * perToken(tier.cacheWrite ?? tier.input) +
    tokens.output * perToken(tier.output)
  );
}
