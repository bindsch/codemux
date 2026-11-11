/** Review round 10: accounting contradictions and stream integration. */
import { afterEach, describe, expect, test } from "bun:test";
import { forwardCompletion } from "../src/complete/forward.js";
import { ResponseAccounting } from "../src/complete/response-accounting.js";
import { AnthropicStreamTranslator } from "../src/complete/anthropic-response.js";
import { usageFromAnthropic, usageFromOpenAI } from "../src/complete/usage.js";
import { ANTHROPIC_ANSWER, ANTHROPIC_STREAM, OPENAI_ANSWER, governorFor, json, ledgerScratch, sse, upstreamFor } from "./helpers/complete-fakes.js";

type Json = Record<string, unknown>;
const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });
const request = { model: "gpt-4o", max_tokens: 64, messages: [{ role: "user", content: "hi" }] };
const upstream = (wire: "openai" | "anthropic" = "openai") => upstreamFor({ baseUrl: "http://127.0.0.1:1/v1" } as Parameters<typeof upstreamFor>[0], wire);

async function forward(response: Response, wire: "openai" | "anthropic" = "openai", fields: Json = {}) {
  const scratch = ledgerScratch();
  cleanups.push(scratch.cleanup);
  const governor = governorFor(scratch.environment);
  let body = "";
  await forwardCompletion({ ...request, model: wire === "anthropic" ? "claude-sonnet-4-5" : request.model, ...fields }, {
    upstream: upstream(wire), governor, timeoutMs: 1000, shutdown: new AbortController().signal,
    fetchImpl: (async () => response) as unknown as typeof fetch,
  }, {
    closed: new AbortController().signal, send(_code, _type, text) { body = text; },
    begin() {}, write(text) { body += text; }, end() {},
  });
  return { body, governor, records: scratch.records() };
}

describe("SSE completion integration", () => {
  for (const ending of ["\r", "\n", "\r\n"]) {
    for (const wire of ["openai", "anthropic"] as const) {
      test(`${wire} completes with ${JSON.stringify(ending)} lines split byte by byte`, async () => {
        const events = wire === "anthropic" ? ANTHROPIC_STREAM : [{ choices: [], usage: OPENAI_ANSWER.usage }];
        const source = "\uFEFF: keepalive" + ending + ending + events.map((event) => `data: ${JSON.stringify(event)}${ending}${ending}`).join("") +
          (wire === "openai" ? `data: [DONE]${ending}${ending}` : "");
        const response = new Response(new ReadableStream({ start(controller) {
          for (const byte of new TextEncoder().encode(source)) controller.enqueue(Uint8Array.of(byte));
          controller.close();
        } }));
        const run = await forward(response, wire, { stream: true });
        expect(run.body).toContain("[DONE]");
        expect(run.body).not.toContain("upstream_malformed");
        expect(run.governor.stopReason).toBeNull();
        expect(run.records).toHaveLength(1);
        expect(run.records[0]!.usage.cost_usd).toBeGreaterThan(0);
      });
    }
  }
  test("an unterminated DONE cannot complete the answer", async () => {
    const run = await forward(new Response(`data: ${JSON.stringify({ choices: [], usage: OPENAI_ANSWER.usage })}\n\ndata: [DONE]`), "openai", { stream: true });
    expect(run.body).not.toContain("data: [DONE]");
    expect(run.body).toContain("upstream_malformed");
    expect(run.governor.stopReason).toBe("cost_unknown");
  });
  for (const include of [false, true]) {
    test(`gateway usage metadata respects include_usage=${include}`, async () => {
      const event = { choices: [], usage: OPENAI_ANSWER.usage, provider_name: "gateway", future_metadata: { trace: "x" } };
      const run = await forward(sse([event], { done: true }), "openai", { stream: true, stream_options: { include_usage: include } });
      expect(run.body.includes(JSON.stringify(event))).toBe(include);
      expect(run.body).toContain("[DONE]");
      expect(run.governor.stopReason).toBeNull();
      expect(run.records[0]!.usage.cost_usd).toBeGreaterThan(0);
    });
  }
});

const invalid = [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "2", true, {}, []];
const openAIFields: [string, (v: unknown) => Json][] = [
  ...["prompt_tokens", "completion_tokens", "total_tokens"].map((field): [string, (v: unknown) => Json] => [field, (v) => ({ [field]: v })]),
  ...["cached_tokens", "audio_tokens", "cache_write_tokens", "image_tokens", "text_tokens"].map((field): [string, (v: unknown) => Json] =>
    [`prompt_tokens_details.${field}`, (v) => ({ prompt_tokens_details: { [field]: v } })]),
  ...["accepted_prediction_tokens", "rejected_prediction_tokens", "audio_tokens", "reasoning_tokens", "text_tokens"].map((field): [string, (v: unknown) => Json] =>
    [`completion_tokens_details.${field}`, (v) => ({ completion_tokens_details: { [field]: v } })]),
];
const anthropicFields: [string, (v: unknown) => Json][] = [
  ...["input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"].map((field): [string, (v: unknown) => Json] => [field, (v) => ({ [field]: v })]),
  ...["ephemeral_5m_input_tokens", "ephemeral_1h_input_tokens"].map((field): [string, (v: unknown) => Json] =>
    [`cache_creation.${field}`, (v) => ({ cache_creation: { [field]: v } })]),
  ...["web_search_requests", "web_fetch_requests"].map((field): [string, (v: unknown) => Json] =>
    [`server_tool_use.${field}`, (v) => ({ server_tool_use: { [field]: v } })]),
  ["output_tokens_details.thinking_tokens", (v) => ({ output_tokens_details: { thinking_tokens: v } })],
];

describe("provider numbers never silently normalize into known cost", () => {
  for (const [wire, fields, base] of [["openai", openAIFields, OPENAI_ANSWER.usage], ["anthropic", anthropicFields, ANTHROPIC_ANSWER.usage]] as const) {
    for (const [name, make] of fields) {
      test(`${wire} ${name}: malformed counts remain unknown after valid later usage`, () => {
        for (const value of invalid) {
          const usage = { ...base, ...make(value) };
          const accounting = new ResponseAccounting(upstream(wire));
          accounting.observe({ usage });
          expect(accounting.settlement("stop").priceKnown).toBe(false);
          accounting.observe({ usage: base });
          expect(accounting.settlement("stop").costKnown).toBe(false);
          if (wire === "anthropic") {
            const translator = new AnthropicStreamTranslator(1, false);
            translator.translate(ANTHROPIC_STREAM[0]!);
            translator.translate({ type: "message_delta", usage, delta: {} });
            translator.translate({ type: "message_delta", usage: base, delta: { stop_reason: "end_turn" } });
            translator.translate({ type: "message_stop" });
            expect(translator.priceKnown).toBe(false);
          }
        }
      });
    }
  }
  test("invalid reported costs never fall back to a token estimate", () => {
    for (const value of invalid.filter((n) => n !== 0.5 && n !== Number.MAX_SAFE_INTEGER + 1)) {
      const accounting = new ResponseAccounting(upstream());
      accounting.observe({ usage: { ...OPENAI_ANSWER.usage, cost: value } });
      expect(accounting.usage?.reportedCostUsd).toBeNull();
      expect(accounting.settlement("stop").costKnown).toBe(false);
      accounting.observe({ usage: OPENAI_ANSWER.usage });
      expect(accounting.settlement("stop").priceKnown).toBe(false);
    }
    expect(usageFromOpenAI({ ...OPENAI_ANSWER.usage, cost: 0.5 })?.reportedCostUsd).toBe(0.5);
  });
  const contradictions: [string, "openai" | "anthropic", Json][] = [
    ["cached exceeds prompt", "openai", { prompt_tokens_details: { cached_tokens: 2000 } }],
    ["total mismatch", "openai", { total_tokens: 1000 }],
    ["total larger than sum", "openai", { total_tokens: 1200 }],
    ["unsafe sum", "openai", { prompt_tokens: Number.MAX_SAFE_INTEGER, total_tokens: undefined }],
    ["reasoning exceeds output", "openai", { completion_tokens_details: { reasoning_tokens: 101 } }],
    ["cache TTL exceeds total", "anthropic", { cache_creation: { ephemeral_5m_input_tokens: 1 } }],
    ["cache TTL contradicts omitted total", "anthropic", { cache_creation_input_tokens: undefined, cache_creation: { ephemeral_5m_input_tokens: 1 } }],
    ["cache TTL sum mismatch", "anthropic", { cache_creation_input_tokens: 3, cache_creation: { ephemeral_5m_input_tokens: 1, ephemeral_1h_input_tokens: 0 } }],
    ["thinking exceeds output", "anthropic", { output_tokens_details: { thinking_tokens: 101 } }],
    ["unsafe sum", "anthropic", { input_tokens: Number.MAX_SAFE_INTEGER }],
    ["invalid charge", "openai", { cost: -1 }],
  ];
  for (const [name, wire, changes] of contradictions) {
    for (const stream of [false, true]) {
      test(`${wire} ${name} stops ${stream ? "stream" : "whole answer"} with unknown cost`, async () => {
        const answer = wire === "anthropic" ? ANTHROPIC_ANSWER : OPENAI_ANSWER;
        const usage = { ...answer.usage, ...changes };
        const events = wire === "anthropic"
          ? [ANTHROPIC_STREAM[0], { type: "message_delta", delta: { stop_reason: "end_turn" }, usage }, { type: "message_stop" }]
          : [{ choices: [], usage }];
        const run = await forward(stream ? sse(events, { done: wire === "openai" }) : json({ ...answer, usage }), wire, { stream });
        expect(run.governor.stopReason).toBe("cost_unknown");
        expect(run.governor.spentUsd).toBe(0);
        expect(run.records).toHaveLength(1);
        expect(run.records[0]!.usage.cost_usd).toBeNull();
        expect(() => run.governor.admit(request.model)).toThrow("cost could not be determined");
      });
    }
  }
  test("valid cache boundaries and optional absence remain priceable", () => {
    for (const cached of [undefined, null, 0, 1000]) {
      expect(usageFromOpenAI({ ...OPENAI_ANSWER.usage, prompt_tokens_details: { cached_tokens: cached } })?.priceKnown).not.toBe(false);
    }
    expect(usageFromAnthropic({ ...ANTHROPIC_ANSWER.usage, cache_creation_input_tokens: 3,
      cache_creation: { ephemeral_5m_input_tokens: 3, ephemeral_1h_input_tokens: 0 }, output_tokens_details: { thinking_tokens: 100 },
    }).priceKnown).not.toBe(false);
    const translator = new AnthropicStreamTranslator(1, false);
    translator.translate({ type: "message_start", message: {
      ...ANTHROPIC_ANSWER, usage: { ...ANTHROPIC_ANSWER.usage, cache_creation_input_tokens: 3 },
    } });
    translator.translate({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: {
      output_tokens: 100, cache_creation: { ephemeral_5m_input_tokens: 3, ephemeral_1h_input_tokens: 0 },
    } });
    translator.translate({ type: "message_stop" });
    expect(translator.priceKnown).toBe(true);
    expect(translator.usage.cacheWrite).toBe(3);
  });
});
