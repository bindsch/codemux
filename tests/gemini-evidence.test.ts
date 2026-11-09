import { describe, expect, test } from "bun:test";
import { GeminiAdapter } from "../src/adapters/gemini.js";
import { geminiResult, geminiUsageFromStats } from "../src/result-envelope/gemini.js";

describe("Gemini native reporting limits", () => {
  test("stats model keys do not become authoritative provider identity", () => {
    const result = geminiResult({
      stdout: JSON.stringify({ response: "answer", stats: {
        input_tokens: 3, cached: 0, output_tokens: 1,
        models: { "gateway-alias": { input_tokens: 3, cached: 0, output_tokens: 1 } },
      } }),
      stderr: "", exitCode: 0, success: true,
    }, { agent: "gemini", prompt: "p", model: "requested", resultJson: true });
    expect(result.servedModel).toBeNull();
    expect(JSON.parse(result.stdout).codemux).toMatchObject({ model: "requested", served_model: null });
  });

  test("native token counts do not imply a dollar cost", () => {
    expect(geminiUsageFromStats({ input_tokens: 5, cached: 1, output_tokens: 2 })).toEqual({
      input_tokens: 4, cached_input_tokens: 1, output_tokens: 2, total_tokens: 7, cost_usd: null,
    });
  });

  test("a requested dollar budget refuses before launch", () => {
    expect(() => new GeminiAdapter({}).validateRunRequest({ agent: "gemini", prompt: "p", maxBudgetUsd: 1 }))
      .toThrow(/gemini has no spend limit flag/);
  });
});
