import { describe, expect, test } from "bun:test";
import { baseModelId, estimateCost, priceFor, PRICES_AS_OF } from "../src/complete/prices.js";
import { oauthTokenReason, parseBaseUrl, parseProvider, resolveUpstream, upstreamRequest } from "../src/complete/provider.js";
import { ledgerUsage, openAIUsage, usageFromAnthropic, usageFromOpenAI } from "../src/complete/usage.js";
import { UsageRefusalError } from "../src/validation.js";

const KEY = "sk-test-not-a-real-key";

describe("upstream resolution and the key rules", () => {
  test("each provider reads its own key variable by default and builds its request", () => {
    const anthropic = resolveUpstream("anthropic", undefined, undefined, { ANTHROPIC_API_KEY: KEY });
    expect(anthropic).toMatchObject({ wire: "anthropic", baseUrl: "https://api.anthropic.com/v1", host: "api.anthropic.com", keyEnv: "ANTHROPIC_API_KEY" });
    expect(upstreamRequest(anthropic)).toEqual({
      url: "https://api.anthropic.com/v1/messages",
      headers: { "content-type": "application/json", "x-api-key": KEY, "anthropic-version": "2023-06-01" },
    });
    const openai = resolveUpstream("openai", undefined, undefined, { OPENAI_API_KEY: KEY });
    expect(upstreamRequest(openai).url).toBe("https://api.openai.com/v1/chat/completions");
    expect(upstreamRequest(openai).headers["authorization"]).toBe(`Bearer ${KEY}`);
    expect(resolveUpstream("openrouter", undefined, undefined, { OPENROUTER_API_KEY: KEY }).host).toBe("openrouter.ai");
    const compatible = resolveUpstream("openai-compatible", "http://127.0.0.1:8000/v1/", "VLLM_KEY", { VLLM_KEY: KEY });
    expect(compatible.baseUrl).toBe("http://127.0.0.1:8000/v1");
    expect(parseProvider("openai")).toBe("openai");
  });

  test("refusals: no key, a key on the command line, an OAuth token, a bad base URL", () => {
    const refuse = (fn: () => unknown, needle: string) => {
      expect(fn).toThrow(UsageRefusalError);
      expect(fn).toThrow(needle);
    };
    refuse(() => parseProvider("gemini"), "--provider must be one of");
    refuse(() => resolveUpstream("anthropic", undefined, undefined, {}), "ANTHROPIC_API_KEY is not set");
    refuse(() => resolveUpstream("openai", undefined, "sk-live-123", {}), "NAME of an environment variable");
    refuse(() => resolveUpstream("anthropic", undefined, "CLAUDE_CODE_OAUTH_TOKEN", { CLAUDE_CODE_OAUTH_TOKEN: KEY }), "subscription OAuth token");
    refuse(() => resolveUpstream("anthropic", undefined, undefined, { ANTHROPIC_API_KEY: "sk-ant-oat01-abc" }), "paid per-token API use");
    refuse(() => resolveUpstream("openai", undefined, undefined, { OPENAI_API_KEY: "eyJhbGci.eyJzdWIi.c2ln" }), "JWT");
    refuse(() => resolveUpstream("openai-compatible", undefined, undefined, { OPENAI_API_KEY: KEY }), "requires --base-url");
    refuse(() => parseBaseUrl("not a url"), "absolute http(s)");
    refuse(() => parseBaseUrl("ftp://example.test/v1"), "absolute http(s)");
    refuse(() => parseBaseUrl("https://user:pw@example.test/v1"), "credentials");
    refuse(() => parseBaseUrl("http://example.test/v1"), "cleartext");
    // The refusal never quotes the key itself.
    try {
      resolveUpstream("anthropic", undefined, undefined, { ANTHROPIC_API_KEY: "sk-ant-oat01-secretvalue" });
    } catch (error) {
      expect((error as Error).message).not.toContain("secretvalue");
    }
    expect(oauthTokenReason("sk-ant-api03-x")).toBeNull();
    expect(parseBaseUrl("http://localhost:9/v1").host).toBe("localhost:9");
  });
});

describe("prices and usage", () => {
  test("snapshot dates, vendor prefixes, and dotted versions resolve to one entry", () => {
    expect(PRICES_AS_OF).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(baseModelId("claude-sonnet-4-5-20250929")).toBe("claude-sonnet-4-5");
    expect(baseModelId("anthropic/claude-sonnet-4.5")).toBe("claude-sonnet-4-5");
    // OpenAI ids keep their snapshot date: some snapshots cost more than
    // their base model, so an unlisted one is refused, not priced as gpt-4o.
    expect(baseModelId("gpt-4o-2024-08-06")).toBe("gpt-4o-2024-08-06");
    expect(priceFor("gpt-4o-2024-05-13", null)).toBeNull();
    expect(baseModelId("anthropic/claude-opus-4.1-20250805")).toBe("claude-opus-4-1");
    expect(baseModelId("openai/gpt-4.1")).toBe("gpt-4.1");
    expect(priceFor("claude-sonnet-4-5-20250929", null)).toEqual({ input: 3, output: 15, cachedInput: 0.3, cacheWrite: 3.75 });
    expect(priceFor("unlisted-model", null)).toBeNull();
    expect(priceFor("unlisted-model", { input: 1, output: 2 })).toEqual({ input: 1, output: 2 });
  });

  test("cost follows each provider's cache rule", () => {
    const sonnet = priceFor("claude-sonnet-4-5", null)!;
    // 1M uncached at $3, 1M cache reads at $0.30, 1M writes at $3.75, 1M out at $15.
    expect(estimateCost({ input: 1e6, cacheRead: 1e6, cacheWrite: 1e6, output: 1e6 }, sonnet)).toBeCloseTo(22.05, 10);
    expect(estimateCost({ input: 1e6, cacheRead: 1e6, cacheWrite: 1e6, output: 0 }, { input: 2, output: 8 })).toBeCloseTo(6, 10);
  });

  test("table prices match the provider pages on PRICES_AS_OF (verified 2026-11-10)", () => {
    expect(PRICES_AS_OF).toBe("2026-11-10");
    // Per-model Anthropic cache-read ratios: 0.05x on Opus 5.5 and Sonnet 5.5,
    // 0.025x on Fable 5.1/5.2, 0.1x elsewhere; writes 1.25x everywhere.
    expect(priceFor("claude-opus-5-5", null)).toEqual({ input: 4, output: 20, cachedInput: 0.2, cacheWrite: 5 });
    expect(priceFor("anthropic/claude-sonnet-5.5", null)).toEqual({ input: 2, output: 10, cachedInput: 0.1, cacheWrite: 2.5 });
    expect(priceFor("claude-fable-5-1", null)).toEqual({ input: 10, output: 50, cachedInput: 0.25, cacheWrite: 12.5 });
    expect(priceFor("claude-fable-5", null)).toEqual({ input: 10, output: 50, cachedInput: 1, cacheWrite: 12.5 });
    expect(priceFor("claude-opus-4-6", null)).toEqual({ input: 5, output: 25, cachedInput: 0.5, cacheWrite: 6.25 });
    expect(priceFor("gpt-5.2", null)).toEqual({ input: 1.75, output: 14, cachedInput: 0.175 });
    expect(priceFor("openai/gpt-5.4-mini", null)).toEqual({ input: 0.75, output: 4.5, cachedInput: 0.075 });
    // Unlisted on the pages, or not priceable from the usage codemux reads: refused.
    for (const model of ["claude-3-5-haiku-20241022", "gpt-4.1-nano", "o4-mini", "gpt-5.5", "gpt-5.4", "gpt-6-sol", "gpt-5.6-sol"]) {
      expect(priceFor(model, null)).toBeNull();
    }
  });

  test("a prompt over a long-context threshold pays that tier for all its tokens (Haiku 5.5 above 100K)", () => {
    const haiku = priceFor("claude-haiku-5-5", null)!;
    // 100K prompt exactly: the short tier, $0.10 in and $0.50 out per MTok.
    expect(estimateCost({ input: 100_000, cacheRead: 0, cacheWrite: 0, output: 1e6 }, haiku)).toBeCloseTo(0.51, 10);
    // 100,001 prompt tokens counting cache reads: the long tier, $0.50 in,
    // $0.05 cache reads, $2.50 out.
    expect(estimateCost({ input: 1, cacheRead: 100_000, cacheWrite: 0, output: 1e6 }, haiku)).toBeCloseTo(0.0000005 + 0.005 + 2.5, 10);
  });

  test("usage reads both wires into the ledger's semantics", () => {
    const openai = usageFromOpenAI({ prompt_tokens: 1000, completion_tokens: 100, prompt_tokens_details: { cached_tokens: 200 }, cost: 0.5 })!;
    expect(openai).toEqual({ input: 800, cacheRead: 200, cacheWrite: 0, output: 100, reportedCostUsd: 0.5 });
    expect(usageFromOpenAI(null)).toBeNull();
    // Counts that are missing or invalid leave the usage unknown, never zero.
    expect(usageFromOpenAI({ prompt_tokens: -1, completion_tokens: "x", cost: -2 })).toMatchObject({
      inputKnown: false, outputKnown: false, priceKnown: false, reportedCostUsd: null,
    });
    expect(usageFromOpenAI({})).toBeNull();
    expect(ledgerUsage(usageFromOpenAI({ prompt_tokens: 10 }), null)).toEqual({
      input_tokens: 10, cached_input_tokens: 0, output_tokens: null, total_tokens: null, cost_usd: null,
    });
    expect(usageFromOpenAI({ prompt_tokens: 10, completion_tokens: 2, cost: -2 })!.reportedCostUsd).toBeNull();
    const anthropic = usageFromAnthropic({ input_tokens: 10, cache_read_input_tokens: 5, cache_creation_input_tokens: 3, output_tokens: 7 });
    expect(openAIUsage(anthropic)).toEqual({ prompt_tokens: 18, completion_tokens: 7, total_tokens: 25, prompt_tokens_details: { cached_tokens: 5 } });
    expect(ledgerUsage(anthropic, 0.1)).toEqual({ input_tokens: 10, cached_input_tokens: 8, output_tokens: 7, total_tokens: 25, cost_usd: 0.1 });
    expect(ledgerUsage(null, null)).toEqual({ input_tokens: null, cached_input_tokens: null, output_tokens: null, total_tokens: null, cost_usd: null });
    expect(usageFromAnthropic(undefined).input).toBe(0);
  });
});
