/**
 * Regression tests for review round 4 on `codemux complete` (2026-11-10):
 * every way an answer's cost can stay unknown stops the cap (a reset after
 * sending, a usage object without counts, an OpenAI stream cut before
 * [DONE], a reroute to an unpriced model, a non-finite estimate), the price
 * table never answers for an inherited property, the Anthropic translation
 * refuses message fields and arguments it would otherwise drop or change,
 * and the SSE bound holds for a whole event.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { createServer } from "node:net";
import { toAnthropicRequest } from "../src/complete/anthropic-request.js";
import { CompleteError } from "../src/complete/errors.js";
import { isSnapshotOf, priceFor } from "../src/complete/prices.js";
import { CompleteServer } from "../src/complete/server.js";
import { MAX_SSE_EVENT_BYTES, readSse } from "../src/complete/sse.js";
import { governorFor, json, ledgerScratch, OPENAI_ANSWER, startFake, upstreamFor, type FakeUpstream } from "./helpers/complete-fakes.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

const REQUEST = { model: "gpt-4o", max_tokens: 64, messages: [{ role: "user", content: "Archive the inbox." }] };

async function serveAt(baseUrl: string, stop: () => void) {
  const scratch = ledgerScratch();
  const governor = governorFor(scratch.environment, { host: new URL(baseUrl).host });
  const fake = { baseUrl } as FakeUpstream;
  const server = new CompleteServer({ upstream: upstreamFor(fake, "openai"), governor, timeoutMs: 5000, port: 0 });
  const url = await server.start();
  cleanups.push(() => {
    server.stop("signal");
    stop();
    scratch.cleanup();
  });
  const post = (body: unknown) => fetch(`${url}/v1/chat/completions`, {
    method: "POST", headers: { authorization: `Bearer ${server.token}` }, body: JSON.stringify(body),
  });
  return { server, governor, post };
}

const serve = (fake: FakeUpstream) => serveAt(fake.baseUrl, fake.stop);

describe("unknown costs stop the cap", () => {
  test("a connection reset after the request was sent counts as possibly billed", async () => {
    const upstream = createServer((socket) => socket.on("data", () => socket.destroy())).listen(0, "127.0.0.1");
    await new Promise((resolve) => upstream.once("listening", resolve));
    const port = (upstream.address() as { port: number }).port;
    const run = await serveAt(`http://127.0.0.1:${port}/v1`, () => upstream.close());
    expect((await run.post(REQUEST)).status).toBe(502);
    expect((await run.server.done).capReason).toBe("cost_unknown");
  });

  test("a usage object without both counts is unknown, not zero", async () => {
    const run = await serve(startFake(() => json({ ...OPENAI_ANSWER, usage: {} })));
    expect((await run.post(REQUEST)).status).toBe(200);
    expect((await run.server.done).capReason).toBe("cost_unknown");
  });

  test("an OpenAI-wire stream that ends before [DONE] gets an error event and stops the cap", async () => {
    const chunk = { id: "c", object: "chat.completion.chunk", model: "gpt-4o", choices: [{ index: 0, delta: { content: "Hi" }, finish_reason: null }],
      usage: { prompt_tokens: 5, completion_tokens: 1 } };
    const run = await serve(startFake(() => new Response(`data: ${JSON.stringify(chunk)}\n\n`, { headers: { "content-type": "text/event-stream" } })));
    const text = await (await run.post({ ...REQUEST, stream: true, stream_options: { include_usage: true } })).text();
    expect(text).toContain("ended before [DONE]");
    expect((await run.server.done).capReason).toBe("cost_unknown");
  });

  test("an answer from an unpriced model other than the requested alias's snapshot stops the cap", async () => {
    const rerouted = await serve(startFake(() => json({ ...OPENAI_ANSWER, model: "gpt-4o-2024-05-13-preview" })));
    expect((await rerouted.post(REQUEST)).status).toBe(200);
    expect((await rerouted.server.done).capReason).toBe("cost_unknown");
    // The alias's own dated snapshot is billed at the alias's price.
    const snapshot = await serve(startFake(() => json({ ...OPENAI_ANSWER, model: "gpt-4o-2024-08-06" })));
    expect((await snapshot.post(REQUEST)).status).toBe(200);
    expect(snapshot.governor.exhausted).toBe(false);
    expect(snapshot.governor.spentUsd).toBeGreaterThan(0);
    expect(isSnapshotOf("gpt-4o-2024-08-06", "gpt-4o")).toBe(true);
    expect(isSnapshotOf("gpt-4o-mini", "gpt-4o")).toBe(false);
  });

  test("an inherited property is never a price, and a non-finite estimate stops the cap", () => {
    for (const model of ["__proto__", "toString", "constructor", "hasOwnProperty"]) expect(priceFor(model, null)).toBeNull();
    const scratch = ledgerScratch();
    cleanups.push(() => scratch.cleanup());
    const governor = governorFor(scratch.environment, { priceOverride: { input: Number.POSITIVE_INFINITY, output: 1 } });
    governor.settle(governor.admit("anything"), {
      usage: { input: 10, cacheRead: 0, cacheWrite: 0, output: 1, reportedCostUsd: null }, servedModel: null, finish: "stop", billable: true, costKnown: true,
    });
    expect(Number.isFinite(governor.spentUsd)).toBe(true);
    expect(governor.stopReason).toBe("cost_unknown");
  });
});

describe("the Anthropic translation refuses what it would drop or change", () => {
  const base = { model: "claude-sonnet-4-5", max_tokens: 64 };
  test("a message field the role does not carry is refused", () => {
    const request = { ...base, messages: [{ role: "user", content: "hi" }, { role: "assistant", content: "ok", audio: { id: "audio_123" } }, { role: "user", content: "go" }] };
    expect(() => toAnthropicRequest(request)).toThrow(CompleteError);
    expect(() => toAnthropicRequest(request)).toThrow("messages[1].audio has no Anthropic equivalent");
  });

  test("non-string tool arguments are refused, not emptied", () => {
    const request = { ...base, messages: [
      { role: "user", content: "go" },
      { role: "assistant", tool_calls: [{ id: "t", type: "function", function: { name: "read_mail", arguments: { folder: "inbox" } } }] },
      { role: "tool", tool_call_id: "t", content: "3" },
    ] };
    expect(() => toAnthropicRequest(request)).toThrow("must be a JSON object string");
  });
});

describe("the SSE bound", () => {
  test("a whole event over the bound is refused even when it arrives in one chunk", async () => {
    const big = `data: ${"x".repeat(MAX_SSE_EVENT_BYTES)}\n\n`;
    const body = new Response(big).body!;
    const read = async () => {
      for await (const _event of readSse(body)) { /* drain */ }
    };
    await expect(read()).rejects.toThrow("exceeded");
  });
});
