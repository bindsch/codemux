/**
 * Regression tests for review round 2 on `codemux complete` (2026-11-10):
 * a cut or usage-less Anthropic answer stops the cap, a premium service
 * tier cannot slip past the price table, a signal never waits on a stalled
 * client, a request seen after shutdown is not counted as billed, a
 * provider key is never sent to another host by default, and the Anthropic
 * translation refuses locally what the Messages API would refuse.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { connect } from "node:net";
import { toAnthropicRequest } from "../src/complete/anthropic-request.js";
import { fromAnthropicAnswer } from "../src/complete/anthropic-response.js";
import { CompleteError } from "../src/complete/errors.js";
import { forwardCompletion } from "../src/complete/forward.js";
import { resolveUpstream } from "../src/complete/provider.js";
import { CompleteServer } from "../src/complete/server.js";
import { UsageRefusalError } from "../src/validation.js";
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
  const post = (body: unknown) => fetch(`${url}/v1/chat/completions`, {
    method: "POST", headers: { authorization: `Bearer ${server.token}` }, body: JSON.stringify(body),
  });
  return { server, url, governor, scratch, post };
}

describe("an Anthropic answer without its final usage stops the cap", () => {
  test("a stream that ends cleanly before message_delta gets an error event, not [DONE]", async () => {
    const cut = [ANTHROPIC_STREAM[0], ANTHROPIC_STREAM[1], ANTHROPIC_STREAM[3]];
    const run = await serve(startFake(() => sse(cut, { named: true })), "anthropic");
    const text = await (await run.post({ ...CLAUDE, stream: true })).text();
    expect(text).not.toContain("[DONE]");
    expect(text).toContain("ended before its final usage");
    expect((await run.server.done).capReason).toBe("cost_unknown");
  });

  test("a whole answer without a usage object stops the server", async () => {
    const { usage: _dropped, ...noUsage } = ANTHROPIC_ANSWER;
    const run = await serve(startFake(() => json(noUsage)), "anthropic");
    expect((await run.post(CLAUDE)).status).toBe(200);
    expect((await run.server.done).capReason).toBe("cost_unknown");
  });

  test("a complete stream keeps the server serving", async () => {
    const run = await serve(startFake(() => sse(ANTHROPIC_STREAM, { named: true })), "anthropic");
    expect(await (await run.post({ ...CLAUDE, stream: true })).text()).toContain("[DONE]");
    expect(run.governor.exhausted).toBe(false);
  });
});

describe("service tiers", () => {
  test("a premium service_tier is refused before it is forwarded", async () => {
    const fake = startFake(() => json(OPENAI_ANSWER));
    const run = await serve(fake, "openai");
    const response = await run.post({ ...REQUEST, service_tier: "priority" });
    expect(response.status).toBe(400);
    expect(fake.received).toHaveLength(0);
    expect(run.scratch.records()[0]!.finish).toBe("refused:bad_request");
    expect((await run.post({ ...REQUEST, service_tier: "flex" })).status).toBe(200);
  });

  test("an answer served at a premium tier stops the server; OpenRouter's own charge is exempt", async () => {
    const run = await serve(startFake(() => json({ ...OPENAI_ANSWER, service_tier: "priority" })), "openai");
    expect((await run.post(REQUEST)).status).toBe(200);
    expect((await run.server.done).capReason).toBe("cost_unknown");
    const charged = { ...OPENAI_ANSWER, service_tier: "priority", usage: { ...OPENAI_ANSWER.usage, cost: 0.02 } };
    const router = await serve(startFake(() => json(charged)), "openai", "openrouter");
    expect((await router.post({ ...REQUEST, service_tier: "priority" })).status).toBe(200);
    expect(router.governor.exhausted).toBe(false);
  });
});

describe("stops and unread bodies", () => {
  test("a signal stops at once while a client is still sending its body, and the request gets a row", async () => {
    const run = await serve(startFake(() => json(OPENAI_ANSWER)), "openai");
    const socket = connect(Number(new URL(run.url).port), "127.0.0.1", () => {
      socket.write(`POST /v1/chat/completions HTTP/1.1\r\nhost: x\r\nauthorization: Bearer ${run.server.token}\r\n` +
        "content-length: 1000\r\n\r\n{\"model\":");
    });
    socket.on("error", () => undefined);
    cleanups.push(() => socket.destroy());
    // Let the partial body reach the server before the signal.
    await Bun.sleep(100);
    run.server.stop("signal");
    const summary = await Promise.race([run.server.done, Bun.sleep(2000).then(() => null)]);
    expect(summary).not.toBeNull();
    expect(summary!.reason).toBe("signal");
    // The supervisor's stop cut the upload: interrupted, not the client's fault.
    expect(run.scratch.records().map((row) => row.finish)).toEqual(["interrupted"]);
  });

  test("a request read after shutdown is refused, not counted as possibly billed", async () => {
    const fake = startFake(() => json(OPENAI_ANSWER));
    const scratch = ledgerScratch();
    cleanups.push(() => {
      fake.stop();
      scratch.cleanup();
    });
    const governor = governorFor(scratch.environment);
    const shutdown = new AbortController();
    shutdown.abort();
    const sink = { closed: new AbortController().signal, send: () => undefined, begin: () => undefined, write: () => undefined, end: () => undefined };
    const attempt = forwardCompletion(REQUEST, { upstream: upstreamFor(fake, "openai"), governor, timeoutMs: 5000, shutdown: shutdown.signal }, sink);
    await expect(attempt).rejects.toMatchObject({ status: 503, code: "shutting_down" });
    expect(fake.received).toHaveLength(0);
    expect(governor.requests).toBe(0);
    expect(governor.stopReason).toBeNull();
    expect(scratch.records()[0]!.finish).toBe("refused:shutting_down");
  });
});

describe("keys and translation", () => {
  test("a provider key is never sent to another host by default", () => {
    const env = { OPENAI_API_KEY: "sk-test-not-a-real-key", ANTHROPIC_API_KEY: "sk-ant-api03-test" };
    expect(() => resolveUpstream("openai-compatible", "https://api.together.xyz/v1", undefined, env)).toThrow(UsageRefusalError);
    expect(() => resolveUpstream("openai-compatible", "https://api.together.xyz/v1", undefined, env)).toThrow("--key-env");
    expect(() => resolveUpstream("anthropic", "https://gateway.example/v1", undefined, env)).toThrow("not anthropic's own host");
    expect(resolveUpstream("openai", "https://api.openai.com/v1", undefined, env).keyEnv).toBe("OPENAI_API_KEY");
    expect(resolveUpstream("openai-compatible", "https://api.together.xyz/v1", "OPENAI_API_KEY", env).host).toBe("api.together.xyz");
  });

  test("the translation refuses locally what the Messages API would refuse", () => {
    const refused = (request: Record<string, unknown>, needle: string) => {
      expect(() => toAnthropicRequest({ ...CLAUDE, ...request })).toThrow(CompleteError);
      expect(() => toAnthropicRequest({ ...CLAUDE, ...request })).toThrow(needle);
    };
    refused({ messages: [{ role: "user", content: "" }] }, "empty user turn");
    refused({
      messages: [
        { role: "user", content: "go" },
        { role: "assistant", tool_calls: [{ id: "c1", type: "function", function: { name: "f", arguments: "{}" } }] },
        { role: "user", content: "also this" },
        { role: "tool", tool_call_id: "c1", content: "done" },
      ],
    }, "tool result after a user message");
    refused({ tools: [{ type: "function", function: { name: "f", parameters: "bogus" } }] }, "parameters must be a JSON Schema object");
    refused({ top_p: "high" }, "top_p must be a number");
    refused({ top_p: 1.5 }, "top_p must be a number");
    expect(toAnthropicRequest({ ...CLAUDE, top_p: 0.9 })["top_p"]).toBe(0.9);
  });

  test("a content block that is not an object is a 502 upstream_malformed, not a 500", async () => {
    expect(() => fromAnthropicAnswer({ ...ANTHROPIC_ANSWER, content: [null] }, 1)).toThrow("not an object");
    const run = await serve(startFake(() => json({ ...ANTHROPIC_ANSWER, content: [null] })), "anthropic");
    const response = await run.post(CLAUDE);
    expect(response.status).toBe(502);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("upstream_malformed");
  });
});
