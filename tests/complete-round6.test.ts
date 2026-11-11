/**
 * Regression tests for review round 6 on `codemux complete` (2026-11-10):
 * an OpenAI-wire error reported as HTTP 200 or as a stream event is not a
 * success, a stream is finished at its terminal event even if the upstream
 * keeps the connection open, a plain-http upstream is never sent through
 * an HTTP proxy, and a named tool_choice refuses fields it would drop.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { toAnthropicRequest } from "../src/complete/anthropic-request.js";
import { resolveUpstream } from "../src/complete/provider.js";
import { CompleteServer } from "../src/complete/server.js";
import { UsageRefusalError } from "../src/validation.js";
import {
  ANTHROPIC_STREAM, governorFor, json, ledgerScratch, startFake, upstreamFor, type FakeUpstream,
} from "./helpers/complete-fakes.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

const REQUEST = { model: "gpt-4o", max_tokens: 64, messages: [{ role: "user", content: "Archive the inbox." }] };

async function serve(fake: FakeUpstream, wire: "openai" | "anthropic", provider?: "openrouter") {
  const scratch = ledgerScratch();
  const governor = governorFor(scratch.environment, { host: new URL(fake.baseUrl).host, providerReportsCost: provider === "openrouter" });
  const server = new CompleteServer({ upstream: upstreamFor(fake, wire, provider), governor, timeoutMs: 3000, port: 0 });
  const url = await server.start();
  cleanups.push(() => {
    server.stop("signal");
    fake.stop();
    scratch.cleanup();
  });
  const post = (body: unknown) => fetch(`${url}/v1/chat/completions`, {
    method: "POST", headers: { authorization: `Bearer ${server.token}` }, body: JSON.stringify(body),
  });
  return { server, governor, scratch, post };
}

/** A stream that sends `text` and then keeps its connection open. */
function openStream(text: string): Response {
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
    },
  }), { headers: { "content-type": "text/event-stream" } });
}

describe("errors on the OpenAI wire", () => {
  test("a 200 answer with an error object and no choices is answered as that error", async () => {
    const run = await serve(startFake(() => json({ error: { code: 502, message: "Provider disconnected" } })), "openai", "openrouter");
    const response = await run.post(REQUEST);
    expect(response.status).toBe(502);
    expect(run.scratch.records()[0]!.finish).toBe("upstream_error:502");
  });

  test("an error event inside a stream ends it as a failure and stops the cap", async () => {
    const usage = { id: "c", object: "chat.completion.chunk", model: "gpt-4o", choices: [], usage: { prompt_tokens: 5, completion_tokens: 1 } };
    const body = `data: ${JSON.stringify(usage)}\n\ndata: ${JSON.stringify({ error: { message: "boom" } })}\n\ndata: [DONE]\n\n`;
    const run = await serve(startFake(() => new Response(body, { headers: { "content-type": "text/event-stream" } })), "openai");
    const text = await (await run.post({ ...REQUEST, stream: true })).text();
    expect(text).toContain("reported an error: boom");
    expect((await run.server.done).capReason).toBe("cost_unknown");
  });
});

describe("terminal events finish a stream", () => {
  test("[DONE] finishes an OpenAI-wire stream whose connection stays open", async () => {
    const chunk = { id: "c", object: "chat.completion.chunk", model: "gpt-4o", choices: [{ index: 0, delta: { content: "Hi" }, finish_reason: "stop" }] };
    const usage = { id: "c", object: "chat.completion.chunk", model: "gpt-4o", choices: [], usage: { prompt_tokens: 5, completion_tokens: 1 } };
    const run = await serve(startFake(() => openStream(`data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify(usage)}\n\ndata: [DONE]\n\n`)), "openai");
    const started = Date.now();
    expect(await (await run.post({ ...REQUEST, stream: true })).text()).toContain("[DONE]");
    expect(Date.now() - started).toBeLessThan(2000);
    expect(run.governor.exhausted).toBe(false);
  });

  test("message_stop finishes an Anthropic stream whose connection stays open", async () => {
    const text = ANTHROPIC_STREAM.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
    const run = await serve(startFake(() => openStream(text)), "anthropic");
    const started = Date.now();
    expect(await (await run.post({ ...REQUEST, model: "claude-sonnet-4-5", stream: true })).text()).toContain("[DONE]");
    expect(Date.now() - started).toBeLessThan(2000);
    expect(run.governor.exhausted).toBe(false);
  });
});

describe("proxies and tool_choice", () => {
  test("a plain-http upstream refuses an explicit proxy regardless of exclusions", () => {
    const env = { OPENAI_API_KEY: "sk-test-not-a-real-key", HTTP_PROXY: "http://proxy.example:3128" };
    const attempt = () => resolveUpstream("openai-compatible", "http://127.0.0.1:8000/v1", "OPENAI_API_KEY", env, env.HTTP_PROXY);
    expect(attempt).toThrow(UsageRefusalError);
    expect(attempt).toThrow("--proxy");
    for (const noProxy of ["127.0.0.1", "localhost,127.0.0.1", "*"]) {
      expect(resolveUpstream("openai-compatible", "http://127.0.0.1:8000/v1", "OPENAI_API_KEY", { ...env, NO_PROXY: noProxy }).host).toBe("127.0.0.1:8000");
      expect(() => resolveUpstream("openai-compatible", "http://127.0.0.1:8000/v1", "OPENAI_API_KEY", { ...env, NO_PROXY: noProxy }, env.HTTP_PROXY))
        .toThrow("--proxy");
    }
    // https tunnels through a proxy encrypted, so it is not refused.
    expect(resolveUpstream("openai", undefined, undefined, env, env.HTTP_PROXY).proxy).toBe("http://proxy.example:3128/");
  });

  test("a named tool_choice refuses fields it would drop", () => {
    const request = {
      model: "claude-sonnet-4-5", max_tokens: 64, messages: [{ role: "user", content: "hi" }],
      tools: [{ type: "function", function: { name: "f", parameters: { type: "object", properties: {} } } }],
      tool_choice: { type: "function", function: { name: "f", extra: "lost" } },
    };
    expect(() => toAnthropicRequest(request)).toThrow("tool_choice.function.extra");
  });
});
