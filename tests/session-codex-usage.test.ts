/**
 * Unit tests for the codex app-server token usage normalization
 * (normalizeCodexTokenUsage). Split from the former
 * tests/session-codex.test.ts.
 */

import { describe, expect, test } from "bun:test";
import { normalizeCodexTokenUsage } from "../src/session/codex-session.js";

describe("codex session - usage normalization", () => {
  test("both cache reads and writes fold out of the input count", () => {
    expect(
      normalizeCodexTokenUsage({
        inputTokens: 18974,
        cachedInputTokens: 12288,
        cacheWriteInputTokens: 0,
        outputTokens: 5,
      })
    ).toEqual({
      input_tokens: 6686,
      output_tokens: 5,
      cached_input_tokens: 12288,
      total_tokens: 18979,
      cost_usd: null,
    });
    expect(
      normalizeCodexTokenUsage({
        inputTokens: 100,
        cachedInputTokens: 20,
        cacheWriteInputTokens: 5,
        outputTokens: 10,
      })
    ).toEqual({
      input_tokens: 75,
      output_tokens: 10,
      cached_input_tokens: 25,
      total_tokens: 110,
      cost_usd: null,
    });
  });

  test("unreported fields stay null, never guessed", () => {
    expect(normalizeCodexTokenUsage({ outputTokens: 7 })).toEqual({
      input_tokens: null,
      output_tokens: 7,
      cached_input_tokens: null,
      total_tokens: null,
      cost_usd: null,
    });
    expect(normalizeCodexTokenUsage("junk")).toEqual({
      input_tokens: null,
      output_tokens: null,
      cached_input_tokens: null,
      total_tokens: null,
      cost_usd: null,
    });
  });

  test("negative and non-finite counts are unreported", () => {
    expect(
      normalizeCodexTokenUsage({ inputTokens: -5, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 1 })
        .input_tokens
    ).toBe(null);
    expect(
      normalizeCodexTokenUsage({ inputTokens: Number.POSITIVE_INFINITY, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 1 })
        .input_tokens
    ).toBe(null);
  });
});
