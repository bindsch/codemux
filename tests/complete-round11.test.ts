/** Round 11: malformed usage must invalidate cumulative pricing evidence. */
import { afterEach, describe, expect, test } from "bun:test";
import { AnthropicStreamTranslator } from "../src/complete/anthropic-response.js";
import { forwardCompletion } from "../src/complete/forward.js";
import { ANTHROPIC_ANSWER, ANTHROPIC_STREAM, OPENAI_ANSWER, governorFor, json, ledgerScratch, sse, upstreamFor } from "./helpers/complete-fakes.js";

type Json = Record<string, unknown>;
const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });
const invalid = [[], [1], "", "invalid", false, true, 0, 12];
const request = { model: "gpt-4o", max_tokens: 64, messages: [{ role: "user", content: "hi" }] };

async function forward(response: Response, provider: "openai" | "anthropic" | "openrouter", stream = false) {
  const scratch = ledgerScratch();
  cleanups.push(scratch.cleanup);
  const wire = provider === "anthropic" ? "anthropic" : "openai";
  const upstream = upstreamFor({ baseUrl: "http://127.0.0.1:1/v1" } as Parameters<typeof upstreamFor>[0], wire, provider);
  const governor = governorFor(scratch.environment, { providerReportsCost: provider === "openrouter" });
  let body = "";
  await forwardCompletion({ ...request, model: wire === "anthropic" ? "claude-sonnet-4-5" : request.model, stream }, {
    upstream, governor, timeoutMs: 1000, shutdown: new AbortController().signal,
    fetchImpl: (async () => response) as unknown as typeof fetch,
  }, {
    closed: new AbortController().signal, send(_code, _type, text) { body = text; },
    begin() {}, write(text) { body += text; }, end() {},
  });
  return { body, governor, records: scratch.records() };
}

describe("malformed usage cannot leave earlier counts trusted", () => {
  for (const provider of ["openai", "anthropic", "openrouter"] as const) {
    for (const position of ["before", "after", "between"] as const) {
      test.each(invalid.map((usage) => [usage]))(`${provider}: malformed %j ${position} valid usage stops spending`, async (usage) => {
        const valid: Json[] = provider === "anthropic" ? ANTHROPIC_STREAM.slice(0, -1) : [
          { choices: [{ index: 0, delta: { content: "Hi" }, finish_reason: "stop" }], usage: {
            ...OPENAI_ANSWER.usage, ...(provider === "openrouter" ? { cost: 0.25 } : {}),
          } },
        ];
        const bad = provider === "anthropic" ? { type: "message_delta", delta: {}, usage } : { choices: [], usage };
        const recovery = provider === "anthropic" ? { type: "message_delta", delta: {}, usage: { output_tokens: 20 } } : valid[0]!;
        const events = position === "before" ? [bad, ...valid] : [...valid, bad, ...(position === "between" ? [recovery] : [])];
        // Anthropic requires message_start first; place bad evidence on its root.
        if (provider === "anthropic" && position === "before") events.splice(0, 2, { ...valid[0], usage });
        if (provider === "anthropic") events.push({ type: "message_stop" });
        const run = await forward(sse(events, { done: provider !== "anthropic" }), provider, true);
        expect(run.body).toContain("[DONE]");
        expect(run.records).toHaveLength(1);
        expect(run.records[0]!.usage.output_tokens).toBe(provider === "anthropic" ? 20 : 100);
        expect(run.records[0]!.usage.cost_usd).toBe(provider === "openrouter" ? 0.25 : null);
        expect(run.governor.spentUsd).toBe(provider === "openrouter" ? 0.25 : 0);
        expect(run.governor.capReached()).toBe("cost_unknown");
        expect(() => run.governor.admit(request.model)).toThrow("cost");
      });
    }
    for (const usage of [undefined, null]) {
      test(`${provider}: ${String(usage)} usage after valid counts is not malformed`, async () => {
        const events: Json[] = provider === "anthropic" ? [
          ...ANTHROPIC_STREAM.slice(0, -1), { type: "message_delta", delta: {}, usage }, { type: "message_stop" },
        ] : [{ choices: [], usage: OPENAI_ANSWER.usage }, { choices: [], usage }];
        const run = await forward(sse(events, { done: provider !== "anthropic" }), provider, true);
        expect(run.body).toContain("[DONE]");
        expect(run.governor.capReached()).toBeNull();
        expect(run.records[0]!.usage.cost_usd).toBeGreaterThan(0);
      });
    }
  }

  test.each(invalid.map((usage) => [usage]))("nested Anthropic usage %j and terminal evidence cannot be ignored", async (usage) => {
    for (const event of [{ type: "message_delta", delta: {}, message: { usage } }, { type: "message_stop", usage }]) {
      const run = await forward(sse([...ANTHROPIC_STREAM.slice(0, -1), event, { type: "message_stop" }]), "anthropic", true);
      expect(run.governor.capReached()).toBe("cost_unknown");
      expect(run.records[0]!.usage.cost_usd).toBeNull();
      expect(run.records[0]!.usage.output_tokens).toBe(20);
    }
  });
});

describe("malformed whole usage is billing evidence on successes and errors", () => {
  for (const provider of ["openai", "anthropic"] as const) {
    for (const status of [200, 503]) {
      test.each(invalid.map((usage) => [usage]))(`${provider} HTTP ${status} usage %j stops the governor`, async (usage) => {
        const answer = provider === "anthropic" ? ANTHROPIC_ANSWER : OPENAI_ANSWER;
        const run = await forward(json({ ...answer, usage }, status), provider);
        expect(run.governor.capReached()).toBe("cost_unknown");
        expect(run.records).toHaveLength(1);
        expect(run.records[0]!.usage.cost_usd).toBeNull();
        expect(run.governor.spentUsd).toBe(0);
      });
    }
  }
});

test("Anthropic preserves non-ping events without OpenAI deltas or requested usage", () => {
  for (const includeUsage of [false, true]) {
    const translator = new AnthropicStreamTranslator(1, includeUsage);
    const chunks = ANTHROPIC_STREAM.flatMap((event) => translator.translate(event));
    for (const event of ANTHROPIC_STREAM.filter((item) => item.type === "content_block_stop")) {
      expect(chunks.find((chunk) => chunk["anthropic"] === event)).toMatchObject({ choices: [], anthropic: event });
    }
    expect(chunks.some((chunk) => (chunk["anthropic"] as Json)["type"] === "ping")).toBe(false);
    expect(chunks.at(-1)).toMatchObject({ choices: [], anthropic: { type: "message_stop" } });
    expect("usage" in chunks.at(-1)!).toBe(includeUsage);
  }
});
