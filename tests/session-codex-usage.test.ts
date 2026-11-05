/**
 * Unit tests for the codex app-server token usage normalization
 * (normalizeCodexTokenUsage). Split from the former
 * tests/session-codex.test.ts.
 */

import { describe, expect, test } from "bun:test";
import { overflowedFields } from "../src/session/usage.js";
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

  test("counts past the safe range and sums that leave it are unknown (round 80)", () => {
    // The finding's example: input at the ceiling plus two output tokens
    // summed to 9007199254740992 — a rounded number, not the mathematical
    // 9007199254740993. The envelope's rule (reportedTokenCount,
    // safeTokenSum) applies here too: the parts that stay inside the range
    // keep their values, the total that leaves it is null.
    const usage = normalizeCodexTokenUsage({
      inputTokens: Number.MAX_SAFE_INTEGER,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      outputTokens: 2,
    });
    expect(usage.input_tokens).toBe(Number.MAX_SAFE_INTEGER);
    expect(usage.output_tokens).toBe(2);
    expect(usage.total_tokens).toBe(null);
    // 2^53 itself is an integer but not a safe one: unreported, never
    // stored as a count.
    expect(normalizeCodexTokenUsage({ inputTokens: 2 ** 53 }).input_tokens).toBe(null);
    // A cache pair whose sum leaves the range is unknown too, and marked
    // as an overflow so no later fold revives it (round 84).
    const cacheOverflow = normalizeCodexTokenUsage({
      cachedInputTokens: Number.MAX_SAFE_INTEGER,
      cacheWriteInputTokens: 2,
    });
    expect(cacheOverflow.cached_input_tokens).toBe(null);
    expect(overflowedFields(cacheOverflow)).toEqual(["cached_input_tokens"]);
    expect(overflowedFields(normalizeCodexTokenUsage({ cachedInputTokens: 1, cacheWriteInputTokens: 2 }))).toEqual([]);
  });

  test("cached plus cache-write above the input is an inconsistent snapshot, not a clamp (round 104)", () => {
    // Reads and writes are each a breakdown of the input count, so a pair
    // that exceeds it is a harness reporting inconsistent counts. The old
    // clamp published input_tokens 0 and a total the components cannot sum
    // to; the derived fields go null and the reported counts stay.
    const usage = normalizeCodexTokenUsage({
      inputTokens: 100,
      cachedInputTokens: 90,
      cacheWriteInputTokens: 20,
      outputTokens: 5,
    });
    expect(usage.input_tokens).toBe(null);
    expect(usage.output_tokens).toBe(5);
    expect(usage.cached_input_tokens).toBe(110);
    expect(usage.total_tokens).toBe(null);
    // A consistent snapshot at the same seam still normalizes fully, and an
    // exact-sum pair (input == cached + write) is consistent: the uncached
    // input is a real zero.
    expect(
      normalizeCodexTokenUsage({
        inputTokens: 110,
        cachedInputTokens: 90,
        cacheWriteInputTokens: 20,
        outputTokens: 5,
      })
    ).toEqual({
      input_tokens: 0,
      output_tokens: 5,
      cached_input_tokens: 110,
      total_tokens: 115,
      cost_usd: null,
    });
  });
});
