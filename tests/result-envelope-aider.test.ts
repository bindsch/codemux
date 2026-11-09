import { describe, expect, test } from "bun:test";
import { parseAiderAnalytics } from "../src/result-envelope/aider.js";
import { AIDER_RUN_LIMITATIONS, AIDER_USAGE_EVIDENCE } from "../src/parity/reasons-run-aider.js";
import { overflowedFields } from "../src/usage-overflow.js";

const record = (completion_tokens: unknown, total_cost: unknown) => JSON.stringify({
  event: "message_send", properties: {
    main_model: "openai/REDACTED", prompt_tokens: 1500, completion_tokens, total_cost,
  },
});

describe("Aider native local analytics", () => {
  test("sums output tokens and uses the cumulative cost once", () => {
    const result = parseAiderAnalytics([record(2, 0.1), record(3, 0.25)].join("\n"));
    expect(result).toEqual({ servedModel: null, usage: {
      input_tokens: null, cached_input_tokens: null, output_tokens: 5, total_tokens: null, cost_usd: 0.25,
    } });
  });

  test("absent cache categories and configured model names remain unknown", () => {
    const result = parseAiderAnalytics(record(2, 0));
    expect(result.servedModel).toBeNull();
    expect(result.usage.input_tokens).toBeNull();
    expect(result.usage.cached_input_tokens).toBeNull();
    expect(result.usage.total_tokens).toBeNull();
    expect(result.usage.cost_usd).toBeNull();
    const served = AIDER_RUN_LIMITATIONS.served;
    if (served.state === "harness-limitation") expect(served.reason).not.toContain("OPEN");
    expect(AIDER_USAGE_EVIDENCE).toContain("without cache fields");
  });

  test("empty, unrelated, malformed, and inconsistent logs cannot invent usage", () => {
    for (const text of ["", "\nnull\n[]\n1\n{}", '{"event":"exit"}', "broken",
      '{"event":"message_send","properties":[]}',
      '{"event":"message_send"}', record(2, -1), record(2, "0.25"),
      `${record(2, 0.25)}\n${record(3, 0.1)}`]) {
      expect(parseAiderAnalytics(text).usage.cost_usd).toBeNull();
    }
  });

  test("bad counts and integer overflow stay unknown through later events", () => {
    for (const first of [1.5, -1, "2", null, Number.MAX_SAFE_INTEGER]) {
      const result = parseAiderAnalytics(`${record(first, 0.1)}\n${record(2, 0.25)}\n${record(3, 0.3)}`);
      expect(result.usage.output_tokens).toBeNull();
      expect(result.usage.cost_usd).toBe(0.3);
      if (first === Number.MAX_SAFE_INTEGER) expect(overflowedFields(result.usage)).toContain("output_tokens");
    }
  });
});
