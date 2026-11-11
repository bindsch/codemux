/**
 * Regression tests for review round 5 on `codemux complete` (2026-11-10):
 * a key that cannot be a header is refused unquoted and a transport error
 * never echoes the key, a partial provider charge still stops the cap, an
 * Anthropic answer without usage records no cost, the usage read from a
 * failing event is kept, a usage-only message_delta does not end the
 * stream, nested request fields are refused rather than dropped, and a
 * whole answer is read to a byte bound.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { toAnthropicRequest } from "../src/complete/anthropic-request.js";
import { AnthropicStreamTranslator } from "../src/complete/anthropic-response.js";
import { forwardCompletion } from "../src/complete/forward.js";
import { resolveUpstream } from "../src/complete/provider.js";
import { CompleteServer } from "../src/complete/server.js";
import {
  ANTHROPIC_ANSWER, ANTHROPIC_STREAM, governorFor, json, ledgerScratch, OPENAI_ANSWER, sse, startFake, upstreamFor, type FakeUpstream,
} from "./helpers/complete-fakes.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

const REQUEST = { model: "gpt-4o", max_tokens: 64, messages: [{ role: "user", content: "Archive the inbox." }] };
const CLAUDE = { ...REQUEST, model: "claude-sonnet-4-5" };

async function serve(fake: FakeUpstream, wire: "openai" | "anthropic", provider?: "openrouter") {
  const scratch = ledgerScratch();
  const governor = governorFor(scratch.environment, { host: new URL(fake.baseUrl).host, providerReportsCost: provider === "openrouter" });
  const server = new CompleteServer({ upstream: upstreamFor(fake, wire, provider), governor, timeoutMs: 5000, port: 0 });
  const url = await server.start();
  cleanups.push(() => {
    server.stop("signal");
    fake.stop();
    scratch.cleanup();
  });
  const post = (body: unknown, signal?: AbortSignal) => fetch(`${url}/v1/chat/completions`, {
    method: "POST", headers: { authorization: `Bearer ${server.token}` }, body: JSON.stringify(body), signal,
  });
  return { server, governor, scratch, post };
}

const noopSink = () => ({ closed: new AbortController().signal, send: () => undefined, begin: () => undefined, write: () => undefined, end: () => undefined });

describe("the key", () => {
  test("a key with a newline or space is refused at start, without quoting it", () => {
    for (const value of ["sk-dummy-secret\naccidental", "sk-dummy secret"]) {
      const attempt = () => resolveUpstream("openai", undefined, undefined, { OPENAI_API_KEY: value });
      expect(attempt).toThrow("cannot be an API key header");
      try {
        attempt();
      } catch (error) {
        expect(String(error)).not.toContain("dummy");
      }
    }
  });

  test("a transport error that quotes the key reaches the client redacted", async () => {
    const scratch = ledgerScratch();
    cleanups.push(() => scratch.cleanup());
    const fake = { baseUrl: "http://127.0.0.1:9/v1" } as FakeUpstream;
    const upstream = upstreamFor(fake, "openai");
    const failing = (() => Promise.reject(new Error(`bad header value: Bearer ${upstream.apiKey}`))) as unknown as typeof fetch;
    const attempt = forwardCompletion(REQUEST, {
      upstream, governor: governorFor(scratch.environment), timeoutMs: 5000, shutdown: new AbortController().signal, fetchImpl: failing,
    }, noopSink());
    const error = (await attempt.catch((caught: unknown) => caught)) as Error;
    expect(error.message).toContain("[redacted]");
    expect(error.message).not.toContain(upstream.apiKey);
  });
});

describe("costs", () => {
  test("a partial OpenRouter charge from a stream cut before [DONE] still stops the cap", async () => {
    const chunk = { id: "c", object: "chat.completion.chunk", model: "openai/gpt-4o", choices: [{ index: 0, delta: { content: "Hi" }, finish_reason: null }],
      usage: { prompt_tokens: 5, completion_tokens: 1, cost: 0.001 } };
    const run = await serve(startFake(() => new Response(`data: ${JSON.stringify(chunk)}\n\n`, { headers: { "content-type": "text/event-stream" } })), "openai", "openrouter");
    await (await run.post({ ...REQUEST, stream: true })).text();
    expect((await run.server.done).capReason).toBe("cost_unknown");
    expect(run.scratch.records()[0]!.usage.cost_usd).toBe(0.001);
  });

  test("an Anthropic answer without usage records no cost, not $0", async () => {
    const { usage: _dropped, ...noUsage } = ANTHROPIC_ANSWER;
    const run = await serve(startFake(() => json(noUsage)), "anthropic");
    expect((await run.post(CLAUDE)).status).toBe(200);
    const row = run.scratch.records()[0]!;
    expect(row.usage.cost_usd).toBeNull();
    expect(row.cost_source).toBeNull();
  });

  test("the usage read from an event that fails translation is recorded", async () => {
    const failing = [ANTHROPIC_STREAM[0], { type: "message_delta", delta: { stop_reason: "unknown_reason" }, usage: { output_tokens: 500 } }];
    const run = await serve(startFake(() => sse(failing, { named: true })), "anthropic");
    await (await run.post({ ...CLAUDE, stream: true })).text();
    expect(run.scratch.records()[0]!.usage.output_tokens).toBe(500);
  });

  test("a whole answer over the byte bound is a 502 at an unknown cost", async () => {
    const huge = JSON.stringify({ ...OPENAI_ANSWER, pad: "x".repeat(65 * 1024 * 1024) });
    const run = await serve(startFake(() => new Response(huge, { headers: { "content-type": "application/json" } })), "openai");
    expect((await run.post(REQUEST)).status).toBe(502);
    expect((await run.server.done).capReason).toBe("cost_unknown");
  });
});

describe("translation", () => {
  test("a usage-only message_delta updates the count without ending the stream", () => {
    const translator = new AnthropicStreamTranslator(1, false);
    translator.translate(ANTHROPIC_STREAM[0] as Record<string, unknown>);
    expect(translator.translate({ type: "message_delta", delta: {}, usage: { output_tokens: 7 } })[0]!["choices"]).toEqual([]);
    expect(translator.usage.output).toBe(7);
    expect(translator.finish).toBeNull();
    translator.translate({ type: "message_stop" });
    expect(translator.complete).toBe(true);
  });

  test("nested fields the translation would drop are refused", () => {
    const base = { model: "claude-sonnet-4-5", max_tokens: 64 };
    const cases: [Record<string, unknown>, string][] = [
      [{ messages: [{ role: "user", content: [{ type: "text", text: "hi", cache_control: { type: "ephemeral" } }] }] }, "content[0].cache_control"],
      [{ messages: [{ role: "user", content: "hi" }], tools: [{ type: "function", function: { name: "f", parameters: {}, extra: 1 } }] }, "function.extra"],
      [{ messages: [{ role: "user", content: "hi" }], stream_options: { include_usage: true, chunk_size: 3 } }, "stream_options.chunk_size"],
      [{ messages: [{ role: "user", content: "hi" }], stream_options: "garbage" }, "stream_options must be an object"],
      [{ messages: [{ role: "user", content: "hi" }], parallel_tool_calls: false }, "only allowed when tools are given"],
    ];
    for (const [request, needle] of cases) expect(() => toAnthropicRequest({ ...base, ...request })).toThrow(needle);
  });
});

describe("a client that drops its connection", () => {
  // Native Bun request signals report the drop on both supported runtimes.
  test("cancels the upstream, records client_closed, and stops the cap", async () => {
    let canceled = false;
    const encoder = new TextEncoder();
    const chunk = { id: "c", object: "chat.completion.chunk", model: "gpt-4o", choices: [{ index: 0, delta: { content: "Hi" }, finish_reason: null }] };
    const fake = startFake(() => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
      },
      cancel() {
        canceled = true;
      },
    }), { headers: { "content-type": "text/event-stream" } }));
    const run = await serve(fake, "openai");
    const client = new AbortController();
    const response = await run.post({ ...REQUEST, stream: true }, client.signal);
    await response.body!.getReader().read();
    client.abort();
    for (let i = 0; i < 200 && !canceled; i++) await Bun.sleep(10);
    expect(canceled).toBe(true);
    for (let i = 0; i < 200 && run.scratch.records().length === 0; i++) await Bun.sleep(10);
    expect(run.scratch.records()[0]!.finish).toBe("client_closed");
    expect((await run.server.done).capReason).toBe("cost_unknown");
  });
});
