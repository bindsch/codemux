/**
 * Regression tests for the review findings on `codemux complete` (review
 * round 1, 2026-11-10): the cap counts answers whose usage never arrived,
 * OpenRouter's charge is always requested, upstream redirects are refused,
 * a cut stream cancels the upstream, a signal after a cap still reads as a
 * signal, an oversized body gets a real 413 on the wire, and the docs list
 * what the code writes and refuses.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { CompleteServer } from "../src/complete/server.js";
import type { CompleteGovernor } from "../src/complete/governor.js";
import {
  ANTHROPIC_STREAM, governorFor, json, ledgerScratch, OPENAI_ANSWER, sse, startFake, upstreamFor, type FakeUpstream,
} from "./helpers/complete-fakes.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

const REQUEST = { model: "gpt-4o", max_tokens: 64, messages: [{ role: "user", content: "Archive the inbox." }] };

async function serve(fake: FakeUpstream, wire: "openai" | "anthropic", options: { provider?: "openrouter"; maxRequests?: number } = {}) {
  const scratch = ledgerScratch();
  const governor: CompleteGovernor = governorFor(scratch.environment, {
    host: new URL(fake.baseUrl).host, providerReportsCost: options.provider === "openrouter", maxRequests: options.maxRequests ?? 100,
  });
  const server = new CompleteServer({ upstream: upstreamFor(fake, wire, options.provider), governor, timeoutMs: 5000, port: 0 });
  const url = await server.start();
  cleanups.push(() => {
    server.stop("signal");
    fake.stop();
    scratch.cleanup();
  });
  const post = (body: unknown) => fetch(`${url}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${server.token}` },
    body: JSON.stringify(body),
  });
  return { server, url, governor, scratch, post };
}

describe("codemux complete: answers without their full usage stop the cap", () => {
  test("a 200 answer without a usage object stops the server with cost_unknown", async () => {
    const { usage: _dropped, ...noUsage } = OPENAI_ANSWER;
    const run = await serve(startFake(() => json(noUsage)), "openai");
    expect((await run.post(REQUEST)).status).toBe(200);
    expect((await run.server.done).capReason).toBe("cost_unknown");
    expect(run.scratch.records()[0]!.usage.cost_usd).toBeNull();
  });

  test("a stream that ends without its usage chunk stops the server with cost_unknown", async () => {
    const chunk = { id: "c", object: "chat.completion.chunk", model: "gpt-4o", choices: [{ index: 0, delta: { content: "Hi" }, finish_reason: "stop" }] };
    const run = await serve(startFake(() => sse([chunk], { done: true })), "openai");
    expect((await (await run.post({ ...REQUEST, stream: true })).text())).toContain("[DONE]");
    expect((await run.server.done).capReason).toBe("cost_unknown");
  });

  test("an upstream HTTP error is not billed and keeps the server serving", async () => {
    const run = await serve(startFake(() => json({ error: { message: "bad" } }, 400)), "openai");
    expect((await run.post(REQUEST)).status).toBe(400);
    expect(run.governor.exhausted).toBe(false);
  });

  test("OpenRouter's usage.include is forced to true over a client's false", async () => {
    const fake = startFake(() => json({ ...OPENAI_ANSWER, usage: { ...OPENAI_ANSWER.usage, cost: 0.01 } }));
    const run = await serve(fake, "openai", { provider: "openrouter" });
    expect((await run.post({ ...REQUEST, usage: { include: false } })).status).toBe(200);
    expect(fake.received[0]!.body["usage"]).toEqual({ include: true });
    expect(run.governor.exhausted).toBe(false);
  });
});

describe("codemux complete: the upstream connection", () => {
  test("an upstream redirect is refused, so the key never reaches the other host", async () => {
    const elsewhere = startFake(() => json(OPENAI_ANSWER));
    cleanups.push(() => elsewhere.stop());
    const redirecting = startFake(() => new Response(null, { status: 307, headers: { location: `${elsewhere.baseUrl}/chat/completions` } }));
    const run = await serve(redirecting, "anthropic");
    const response = await run.post({ ...REQUEST, model: "claude-sonnet-4-5" });
    expect(response.status).toBe(502);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("upstream_unreachable");
    expect(elsewhere.received).toHaveLength(0);
    expect(run.governor.exhausted).toBe(false);
  });

  test("a stream that fails translation cancels the upstream body and stops the cap", async () => {
    let canceled = false;
    const encoder = new TextEncoder();
    const fake = startFake(() => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(`event: message_start\ndata: ${JSON.stringify(ANTHROPIC_STREAM[0])}\n\n`));
        controller.enqueue(encoder.encode(`event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "unknown_block", id: "s", name: "web_search", input: {} } })}\n\n`));
        // The upstream keeps the stream open, as a provider still generating would.
      },
      cancel() {
        canceled = true;
      },
    }), { headers: { "content-type": "text/event-stream" } }));
    const run = await serve(fake, "anthropic");
    const text = await (await run.post({ ...REQUEST, model: "claude-sonnet-4-5", stream: true })).text();
    expect(text).toContain("has no OpenAI equivalent");
    for (let i = 0; i < 100 && !canceled; i++) await Bun.sleep(10);
    expect(canceled).toBe(true);
    expect(run.scratch.records()[0]!.usage.input_tokens).toBe(50);
    expect((await run.server.done).capReason).toBe("cost_unknown");
  });
});

describe("codemux complete: stops and refusals on the wire", () => {
  test("a signal after a cap still stops the server as a signal", async () => {
    let release: () => void = () => undefined;
    const fake = startFake(() => new Promise<Response>((resolve) => {
      release = () => resolve(json(OPENAI_ANSWER));
    }));
    const run = await serve(fake, "openai", { maxRequests: 1 });
    const pending = run.post(REQUEST).catch((error: unknown) => error);
    while (fake.received.length === 0) await Bun.sleep(5);
    run.server.stop("cap");
    run.server.stop("signal");
    const summary = await run.server.done;
    release();
    await pending;
    expect(summary.reason).toBe("signal");
    expect(run.scratch.records()[0]!.finish).toBe("interrupted");
  });

  test("an oversized body gets a 413 status line on the raw socket", async () => {
    const run = await serve(startFake(() => json(OPENAI_ANSWER)), "openai");
    const { port } = new URL(run.url);
    const body = Buffer.alloc(33 * 1024 * 1024, "x");
    const statusLine = await new Promise<string>((resolve, reject) => {
      let received = "";
      const socket = connect(Number(port), "127.0.0.1", () => {
        socket.write(`POST /v1/chat/completions HTTP/1.1\r\nhost: 127.0.0.1\r\nauthorization: Bearer ${run.server.token}\r\n` +
          `content-type: application/json\r\ncontent-length: ${body.length}\r\n\r\n`);
        // No half-close: bun 1.3 drops a request whose client ends its side.
        socket.write(body);
      });
      socket.on("data", (data) => {
        received += data.toString("latin1");
        if (received.includes("\r\n")) {
          socket.destroy();
          resolve(received.split("\r\n")[0]!);
        }
      });
      socket.on("error", reject);
    });
    expect(statusLine).toBe("HTTP/1.1 413 Payload Too Large");
    expect(run.scratch.records().map((row) => row.finish)).toEqual(["refused:payload_too_large"]);
  });

  test("the docs list every finish value and refused OAuth variable the code writes or refuses", () => {
    const root = join(import.meta.dir, "..");
    const complete = readFileSync(join(root, "docs", "complete.md"), "utf8");
    const provider = readFileSync(join(root, "src", "complete", "provider.ts"), "utf8");
    const oauthNames = [...provider.matchAll(/"([A-Z_]+_TOKEN)"/g)].map((match) => match[1]!);
    expect(oauthNames).toContain("CODEX_OAUTH_TOKEN");
    for (const name of oauthNames) expect(complete).toContain(`\`${name}\``);
    for (const finish of ["unknown", "incomplete", "client_closed", "interrupted", "untranslatable"]) {
      expect(complete).toContain(`\`${finish}\``);
    }
    const ledgerDoc = readFileSync(join(root, "docs", "results-and-usage.md"), "utf8");
    expect(ledgerDoc).toContain("except on a `complete` row");
  });
});
