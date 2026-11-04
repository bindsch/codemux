/**
 * Token counts are whole numbers (review round 59): a fractional report is
 * unknown, never stored, because the ledger reader refuses fractional counts
 * and a stored one would make the call vanish from `codemux calls`. Cost
 * stays a finite non-negative number.
 */

import { expect, test } from "bun:test";
import { normalizeClaudeUsage, reportedCount, reportedTokenCount, safeTokenSum } from "../src/result-envelope/common.js";

test("a fractional token count is unknown; a cost may be fractional", () => {
  expect(reportedTokenCount(1.5)).toBeNull();
  expect(reportedTokenCount(-1)).toBeNull();
  expect(reportedTokenCount(12)).toBe(12);
  expect(reportedCount(0.0123)).toBe(0.0123);
  const usage = normalizeClaudeUsage({ input_tokens: 1.5, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, 0.01);
  expect(usage.input_tokens).toBeNull();
  expect(usage.output_tokens).toBe(2);
  expect(usage.total_tokens).toBeNull();
  expect(usage.cost_usd).toBe(0.01);
});

test("a count past the safe integer range is unknown, and a sum that would leave it is unknown (review round 62)", () => {
  expect(reportedTokenCount(2 ** 53)).toBeNull();
  expect(reportedTokenCount(2 ** 53 - 1)).toBe(2 ** 53 - 1);
  expect(safeTokenSum(2 ** 53 - 1, 1)).toBeNull();
  expect(safeTokenSum(1, 2, 3)).toBe(6);
  const usage = normalizeClaudeUsage({ input_tokens: 2 ** 53 - 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, null);
  expect(usage.input_tokens).toBe(2 ** 53 - 1);
  expect(usage.total_tokens).toBeNull();
});
