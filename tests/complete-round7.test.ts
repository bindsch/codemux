/** Regression tests for round 7 and related boundary defects. Fakes only. */
import { afterEach, describe, expect, test } from "bun:test";
import { toAnthropicRequest } from "../src/complete/anthropic-request.js";
import { AnthropicStreamTranslator, finishReason } from "../src/complete/anthropic-response.js";
import { resolveUpstream } from "../src/complete/provider.js";
import { CompleteServer } from "../src/complete/server.js";
import { MAX_SSE_EVENT_BYTES, readSse } from "../src/complete/sse.js";
import { UsageRefusalError } from "../src/validation.js";
import {
  ANTHROPIC_ANSWER, ANTHROPIC_STREAM, governorFor, json, ledgerScratch, OPENAI_ANSWER,
  sse, startFake, upstreamFor, type FakeUpstream,
} from "./helpers/complete-fakes.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

const REQUEST = { model: "gpt-4o", max_tokens: 64, messages: [{ role: "user", content: "Hi" }] };
const CLAUDE = { ...REQUEST, model: "claude-sonnet-4-5" };

async function serve(fake: FakeUpstream, wire: "openai" | "anthropic" = "openai") {
  const scratch = ledgerScratch();
  const governor = governorFor(scratch.environment, { host: new URL(fake.baseUrl).host });
  const server = new CompleteServer({ upstream: upstreamFor(fake, wire), governor, timeoutMs: 3000, port: 0 });
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

describe("ambient proxy settings no longer control upstream selection", () => {
  const env = { TEST_KEY: "synthetic-key", HTTP_PROXY: "http://proxy.example:3128" };
  test.each([
    ["127.0.0.1", "127.0.0.1:1"],
    ["localhost", "localhost:1"],
    ["[::1]", "[::1]:1"],
    ["127.0.0.1", "localhost,127.0.0.1:1"],
  ])("a NO_PROXY port mismatch does not affect %s with %s", (host, noProxy) => {
    expect(resolveUpstream("openai-compatible", `http://${host}:8000/v1`, "TEST_KEY", { ...env, NO_PROXY: noProxy }).host)
      .toBe(`${host}:8000`);
  });

  test("a matching port or a portless entry does not affect the destination", () => {
    for (const host of ["127.0.0.1", "localhost", "[::1]"]) {
      for (const entry of [host, `${host}:8000`, `irrelevant:1, ${host}:8000`, "*"]) {
        expect(resolveUpstream("openai-compatible", `http://${host}:8000/v1`, "TEST_KEY", { ...env, NO_PROXY: entry }).host)
          .toBe(`${host}:8000`);
      }
    }
  });

  test("default URL ports do not depend on lowercase proxy variables", () => {
    const base = { TEST_KEY: "synthetic-key", http_proxy: env.HTTP_PROXY };
    expect(resolveUpstream("openai-compatible", "http://localhost/v1", "TEST_KEY", { ...base, no_proxy: "localhost:80" }).host)
      .toBe("localhost");
    expect(resolveUpstream("openai-compatible", "http://localhost/v1", "TEST_KEY", { ...base, no_proxy: "localhost:8000" }).host)
      .toBe("localhost");
  });

  test("conflicting proxy variable cases do not affect upstream selection", () => {
    const resolve = (overrides: NodeJS.ProcessEnv) => resolveUpstream("openai-compatible", "http://127.0.0.1:8000/v1", "TEST_KEY", {
      ...env, ...overrides,
    });
    expect(resolve({ NO_PROXY: "127.0.0.1", no_proxy: "unrelated" }).host).toBe("127.0.0.1:8000");
    expect(resolve({ HTTP_PROXY: "", http_proxy: env.HTTP_PROXY }).host).toBe("127.0.0.1:8000");
    expect(resolve({ NO_PROXY: "unrelated", no_proxy: "127.0.0.1" }).host).toBe("127.0.0.1:8000");
    expect(resolve({ NO_PROXY: "127.0.0.1", no_proxy: "" }).host).toBe("127.0.0.1:8000");
  });

  test("clearing the fetch environment sends a synthetic key directly for every exclusion", async () => {
    let proxyRequests = 0;
    const direct = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) =>
      new Response(request.headers.get("authorization")) });
    const proxy = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => {
      proxyRequests++;
      return new Response("proxy");
    } });
    cleanups.push(() => { direct.stop(true); proxy.stop(true); });
    const source = `
      import { clearProxyEnvironment, resolveUpstream } from ${JSON.stringify(new URL("../src/complete/provider.ts", import.meta.url).href)};
      try {
        clearProxyEnvironment();
        const config = resolveUpstream("openai-compatible", process.env.TARGET, "TEST_KEY", process.env);
        console.log(await (await fetch(config.baseUrl, { headers: { authorization: config.apiKey } })).text());
      } catch (error) { console.log(error.message); process.exitCode = 64; }
    `;
    const cases: [NodeJS.ProcessEnv, number][] = [
      [{ NO_PROXY: "127.0.0.1:1" }, 0],
      [{ NO_PROXY: `127.0.0.1:${direct.port}` }, 0],
      [{ NO_PROXY: "127.0.0.1" }, 0],
      [{ NO_PROXY: "127.0.0.1", no_proxy: "unrelated" }, 0],
      [{ NO_PROXY: "unrelated", no_proxy: "127.0.0.1" }, 0],
      [{ HTTP_PROXY: "", http_proxy: `http://127.0.0.1:${proxy.port}` }, 0],
    ];
    for (const [overrides, exit] of cases) {
      const child = Bun.spawn([process.execPath, "--no-env-file", "-e", source], {
        env: { TEST_KEY: "synthetic-key", HTTP_PROXY: `http://127.0.0.1:${proxy.port}`,
          TARGET: `http://127.0.0.1:${direct.port}/v1`, ...overrides }, stdout: "pipe", stderr: "pipe",
      });
      const text = (await new Response(child.stdout).text()).trim();
      expect(await child.exited).toBe(exit);
      expect(text).toBe("synthetic-key");
    }
    expect(proxyRequests).toBe(0);
  });
});

describe("error envelopes", () => {
  test("a 200 error with empty choices returns 503 and records the failure", async () => {
    const body = { error: { code: 503 }, choices: [] };
    const run = await serve(startFake(() => json(body)));
    const response = await run.post(REQUEST);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual(body);
    expect(run.scratch.records()[0]!.finish).toBe("upstream_error:503");
    expect(run.governor.stopReason).toBe("cost_unknown");
  });

  test("an error also takes precedence over nonempty OpenAI choices", async () => {
    const run = await serve(startFake(() => json({ ...OPENAI_ANSWER, error: { code: 503 } })));
    expect((await run.post(REQUEST)).status).toBe(503);
    expect(run.scratch.records()[0]!.finish).toBe("upstream_error:503");
    expect(run.scratch.records()[0]!.usage.output_tokens).toBe(100);
  });

  test.each(["503", 200, 600, 503.5, null])("an invalid upstream error code %j falls back to 502", async (code) => {
    const run = await serve(startFake(() => json({ error: { code }, choices: [] })));
    expect((await run.post(REQUEST)).status).toBe(502);
    expect(run.scratch.records()[0]!.finish).toBe("upstream_error:502");
  });

  test("an Anthropic error takes precedence over translatable completion fields", async () => {
    const run = await serve(startFake(() => json({
      ...ANTHROPIC_ANSWER, type: "error", error: { type: "overloaded_error", message: "busy" },
    })), "anthropic");
    const response = await run.post(CLAUDE);
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: { type: "overloaded_error", message: "busy", code: null } });
    expect(run.scratch.records()[0]!.finish).toBe("upstream_error:502");
  });

  test("an Anthropic type:error without an error object cannot become a success", async () => {
    const run = await serve(startFake(() => json({ ...ANTHROPIC_ANSWER, type: "error" })), "anthropic");
    expect((await run.post(CLAUDE)).status).toBe(502);
    expect(run.scratch.records()[0]!.finish).toBe("upstream_error:502");
  });

  test("an error on a nominal Anthropic stream event prevents successful completion", async () => {
    const events = [...ANTHROPIC_STREAM.slice(0, -1), { type: "message_stop", error: { message: "busy" } }];
    const run = await serve(startFake(() => sse(events, { named: true })), "anthropic");
    const text = await (await run.post({ ...CLAUDE, stream: true })).text();
    expect(text).toContain("Anthropic stream error: busy");
    expect(text).not.toContain("[DONE]");
    expect(run.scratch.records()[0]!.finish).toBe("stream_error:upstream_malformed");
    expect(run.governor.stopReason).toBe("cost_unknown");
  });
});

describe("translation and prototype boundaries", () => {
  test.each([[123], [false], [{}], [[]], [null]])("a non-string tool description %j is refused before dispatch", async (description) => {
    const fake = startFake(() => json(ANTHROPIC_ANSWER));
    const run = await serve(fake, "anthropic");
    const response = await run.post({ ...CLAUDE, tools: [{ type: "function", function: { name: "f", description } }] });
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("tools[0].function.description must be a string");
    expect(fake.received).toHaveLength(0);
    expect(run.scratch.records()[0]!.finish).toBe("refused:bad_request");
  });

  test("string tool descriptions, including an empty string, are preserved", () => {
    for (const description of ["", "Find a record"]) {
      const translated = toAnthropicRequest({ ...CLAUDE, tools: [{ type: "function", function: { name: "f", description } }] });
      expect((translated["tools"] as Record<string, unknown>[])[0]!["description"]).toBe(description);
    }
  });

  test("inherited property names cannot be finish reasons in whole or streamed answers", async () => {
    for (const reason of Object.getOwnPropertyNames(Object.prototype)) {
      expect(() => finishReason(reason)).toThrow("has no OpenAI equivalent");
      const translator = new AnthropicStreamTranslator(1, false);
      expect(() => translator.translate({ type: "message_delta", delta: { stop_reason: reason } }))
        .toThrow("has no OpenAI equivalent");
    }
    expect(finishReason("end_turn")).toBe("stop");
    const run = await serve(startFake(() => json({ ...ANTHROPIC_ANSWER, stop_reason: "constructor" })), "anthropic");
    expect((await run.post(CLAUDE)).status).toBe(502);
    expect(run.scratch.records()[0]!.finish).toBe("untranslatable");
  });

  test("a key variable must be an own property of the environment", () => {
    for (const name of ["constructor", "toString", "__proto__"]) {
      const attempt = () => resolveUpstream("openai", undefined, name, {});
      expect(attempt).toThrow(UsageRefusalError);
      expect(attempt).toThrow(`${name} is not set`);
    }
    const inherited = Object.create({ TEST_KEY: "synthetic-key" }) as NodeJS.ProcessEnv;
    expect(() => resolveUpstream("openai", undefined, "TEST_KEY", inherited)).toThrow("TEST_KEY is not set");
    expect(resolveUpstream("openai", undefined, "constructor", { constructor: "synthetic-key" }).apiKey).toBe("synthetic-key");
  });
});

describe("SSE byte limits", () => {
  test.each(["\n\n", ""])("a multibyte event over the limit is refused with terminator %j", async (terminator) => {
    const raw = `data: ${"界".repeat(Math.floor(MAX_SSE_EVENT_BYTES / 3))}`;
    expect(raw.length).toBeLessThan(MAX_SSE_EVENT_BYTES);
    expect(Buffer.byteLength(raw)).toBeGreaterThan(MAX_SSE_EVENT_BYTES);
    let canceled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode(raw + terminator)); },
      cancel() { canceled = true; },
    });
    await expect(readSse(body).next()).rejects.toThrow(`exceeded ${MAX_SSE_EVENT_BYTES} bytes`);
    expect(canceled).toBe(true);
  });

  test("an unterminated multibyte event is bounded across chunks", async () => {
    const half = "界".repeat(Math.floor(MAX_SSE_EVENT_BYTES / 6) + 1);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`data: ${half}`));
        controller.enqueue(new TextEncoder().encode(half));
        controller.close();
      },
    });
    await expect(readSse(body).next()).rejects.toThrow("exceeded");
  });

  test("the exact byte limit applies per event, not to all events in a chunk", async () => {
    const prefix = "data: ";
    const count = Math.floor((MAX_SSE_EVENT_BYTES - prefix.length) / 3);
    const raw = prefix + "界".repeat(count) + "x".repeat(MAX_SSE_EVENT_BYTES - prefix.length - count * 3);
    expect(Buffer.byteLength(raw)).toBe(MAX_SSE_EVENT_BYTES);
    const body = new Response(`${raw}\n\n${raw}\n\n`).body!;
    let events = 0;
    for await (const event of readSse(body)) {
      expect(event.raw).toBe(raw);
      events++;
    }
    expect(events).toBe(2);
  });

  test("UTF-8 characters split across byte chunks decode intact", async () => {
    const bytes = new TextEncoder().encode("data: 界🌍\n\n");
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
        controller.close();
      },
    });
    const events = [];
    for await (const event of readSse(body)) events.push(event.data);
    expect(events).toEqual(["界🌍"]);
  });
});
