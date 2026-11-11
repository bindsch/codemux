/** Review round 9: provider compatibility, accounting, and bounded uploads. */
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { connect } from "node:net";
import { forwardCompletion } from "../src/complete/forward.js";
import { CompleteServer } from "../src/complete/server.js";
import { ANTHROPIC_ANSWER, ANTHROPIC_STREAM, OPENAI_ANSWER, governorFor, json, ledgerScratch, sse, startFake, upstreamFor } from "./helpers/complete-fakes.js";

type Json = Record<string, unknown>;
const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length > 0) cleanups.pop()!(); });
const request = { model: "gpt-4o", max_tokens: 64, messages: [{ role: "user", content: "hi" }] };

async function forward(response: Response, wire: "openai" | "anthropic" = "openai", stream = false, fields: Json = {}) {
  const scratch = ledgerScratch();
  cleanups.push(scratch.cleanup);
  const governor = governorFor(scratch.environment);
  const upstream = upstreamFor({ baseUrl: "http://127.0.0.1:1/v1" } as Parameters<typeof upstreamFor>[0], wire);
  let status = 0;
  let body = "";
  let dispatched = 0;
  const fetchImpl = (async () => { dispatched++; return response; }) as unknown as typeof fetch;
  let error: unknown;
  try {
    await forwardCompletion({ ...request, model: wire === "anthropic" ? "claude-sonnet-4-5" : request.model, stream, ...fields }, {
      upstream, governor, timeoutMs: 1000, shutdown: new AbortController().signal, fetchImpl,
    }, {
      closed: new AbortController().signal,
      send(code, _type, text) { status = code; body = text; },
      begin(code) { status = code; }, write(text) { body += text; }, end() {},
    });
  } catch (caught) { error = caught; }
  return { status, body, error, governor, dispatched, records: scratch.records() };
}

describe("published success shapes pass through with their usage", () => {
  for (const toolCalls of [null, [{ id: "c", type: "custom", custom: { name: "python", input: "print(1)" } }]]) {
    test(`whole tool_calls ${JSON.stringify(toolCalls)} passes byte for byte`, async () => {
      const answer = { ...OPENAI_ANSWER, choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "hi", tool_calls: toolCalls } }] };
      const run = await forward(json(answer));
      expect(run.error).toBeUndefined();
      expect(run.status).toBe(200);
      expect(run.body).toBe(JSON.stringify(answer));
      expect(run.records).toHaveLength(1);
      expect(run.records[0]!.usage.cost_usd).toBeGreaterThan(0);
      expect(run.governor.stopReason).toBeNull();
    });
  }
  test("nullable stream roles, tools and arguments survive with final audio expiry", async () => {
    const events = [
      { choices: [{ index: 0, delta: { role: null, tool_calls: null } }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: null, type: null, function: null }] } }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { name: null, arguments: null } }] }, finish_reason: "tool_calls" }] },
      { choices: [{ index: 0, delta: { audio: { expires_at: 42 } } }] },
      { choices: [], usage: null }, { choices: [], usage: OPENAI_ANSWER.usage },
    ];
    const run = await forward(sse(events, { done: true }), "openai", true, { stream_options: { include_usage: true } });
    expect(run.body).toContain("[DONE]");
    expect(run.body).not.toContain("upstream_malformed");
    for (const event of events) expect(run.body).toContain(JSON.stringify(event));
    expect(run.governor.stopReason).toBeNull();
    expect(run.records).toHaveLength(1);
  });
  test("missing and null usage stay structurally valid but stop at unknown cost", async () => {
    for (const usage of [undefined, null]) {
      const run = await forward(json({ ...OPENAI_ANSWER, usage }));
      expect(run.status).toBe(200);
      expect(run.governor.stopReason).toBe("cost_unknown");
      expect(run.records[0]!.usage.cost_usd).toBeNull();
    }
  });
  test("usage combined with moderation is preserved even without include_usage", async () => {
    const event = { choices: [], usage: OPENAI_ANSWER.usage, moderation: {
      input: { type: "error", code: "unavailable", message: "unavailable" },
      output: { type: "moderation_results", model: "moderation", results: [] },
    } };
    const run = await forward(sse([event], { done: true }), "openai", true);
    expect(run.body).toContain(JSON.stringify(event));
    expect(run.body).toContain("[DONE]");
    expect(run.governor.stopReason).toBeNull();
  });
  test("compatible custom tool deltas preserve their input fragments", async () => {
    const events = [
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, type: "custom", id: "c", custom: { name: "python", input: "print(" } }] } }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, custom: { name: null, input: "1)" } }] }, finish_reason: "tool_calls" }], usage: OPENAI_ANSWER.usage },
    ];
    const run = await forward(sse(events, { done: true }), "openai", true);
    expect(run.body).toContain("[DONE]");
    for (const event of events) expect(run.body).toContain(JSON.stringify(event));
    expect(run.governor.stopReason).toBeNull();
  });
  for (const choices of [[], [{ index: 0, delta: {} }], [{ index: 0, delta: {}, finish_reason: null }]]) {
    test(`accounted optional-finish stream ${JSON.stringify(choices)}`, async () => {
      const run = await forward(sse([{ choices, usage: OPENAI_ANSWER.usage }], { done: true }), "openai", true);
      expect(run.body).toContain("[DONE]");
      expect(run.governor.stopReason).toBeNull();
    });
  }
});

describe("malformed cache evidence cannot become a known zero", () => {
  for (const field of ["cache_read_input_tokens", "cache_creation_input_tokens"]) {
    for (const bad of ["1000000", -1, 1.5, true, {}, [], Number.MAX_SAFE_INTEGER + 1]) {
      for (const stream of [false, true]) {
        test(`${field} ${JSON.stringify(bad)} in ${stream ? "stream" : "whole answer"}`, async () => {
          const response = stream ? sse([
            ANTHROPIC_STREAM[0],
            { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5, [field]: bad } },
            { type: "message_stop" },
          ]) : json({ ...ANTHROPIC_ANSWER, usage: { ...ANTHROPIC_ANSWER.usage, [field]: bad } });
          const run = await forward(response, "anthropic", stream);
          expect(run.governor.stopReason).toBe("cost_unknown");
          expect(run.records).toHaveLength(1);
          expect(run.records[0]!.usage.cost_usd).toBeNull();
          expect(run.records[0]!.usage.output_tokens).toBe(stream ? 5 : 100);
        });
      }
    }
  }
  test("malformed OpenAI cached counts also stop unknown", async () => {
    const run = await forward(json({ ...OPENAI_ANSWER, usage: { ...OPENAI_ANSWER.usage, prompt_tokens_details: { cached_tokens: "200" } } }));
    expect(run.records[0]!.usage.cost_usd).toBeNull();
    expect(run.governor.stopReason).toBe("cost_unknown");
  });
  for (const usage of [
    { cache_creation: { ephemeral_1h_input_tokens: 1, ephemeral_5m_input_tokens: 0 } },
    { server_tool_use: { web_search_requests: 1, web_fetch_requests: 0 } },
    { service_tier: "priority" }, { speed: "fast" }, { inference_geo: "us" },
  ]) {
    test(`unpriced Anthropic billing dimensions ${JSON.stringify(usage)}`, async () => {
      const run = await forward(json({ ...ANTHROPIC_ANSWER, usage: { ...ANTHROPIC_ANSWER.usage, ...usage } }), "anthropic");
      expect(run.status).toBe(200);
      expect(run.records[0]!.usage.cost_usd).toBeNull();
      expect(run.governor.stopReason).toBe("cost_unknown");
    });
  }
});

describe("empty Anthropic turns are refused before admission", () => {
  for (const role of ["user", "assistant"]) {
    for (const content of ["", [], [{ type: "text", text: "" }], [{ type: "text", text: "" }, { type: "text", text: "" }]]) {
      test(`${role} ${JSON.stringify(content)}`, async () => {
        const run = await forward(json(ANTHROPIC_ANSWER), "anthropic", false, { messages: [{ role, content }] });
        expect(run.error).toMatchObject({ status: 400, code: "cannot_translate" });
        expect(run.dispatched).toBe(0);
        expect(run.governor.requests).toBe(0);
        expect(run.records).toHaveLength(1);
      });
    }
  }
  test("an image alongside empty text still supplies content", async () => {
    const run = await forward(json(ANTHROPIC_ANSWER), "anthropic", false, { messages: [{ role: "user", content: [
      { type: "text", text: "" }, { type: "image_url", image_url: { url: "https://example.test/image.png" } },
    ] }] });
    expect(run.error).toBeUndefined();
    expect(run.dispatched).toBe(1);
  });
});

describe("split final Anthropic usage is sticky", () => {
  test("native server tools preserve their payload and stop at unpriced cost", async () => {
    const block = { type: "server_tool_use", id: "s", name: "web_search", input: { query: "test" } };
    for (const stream of [false, true]) {
      const answer = { ...ANTHROPIC_ANSWER, content: [block] };
      const response = stream ? sse([
        ANTHROPIC_STREAM[0], { type: "content_block_start", index: 0, content_block: block },
        { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{}" } },
        { type: "message_delta", delta: { stop_reason: "pause_turn" }, usage: { output_tokens: 9 } },
        { type: "message_stop" },
      ]) : json(answer);
      const run = await forward(response, "anthropic", stream);
      expect(run.status).toBe(200);
      expect(run.body).toContain(JSON.stringify(block));
      expect(run.records[0]!.usage.cost_usd).toBeNull();
      expect(run.governor.stopReason).toBe("cost_unknown");
    }
  });
  for (const reverse of [false, true]) {
    test(`usage ${reverse ? "after" : "before"} stop reason settles once`, async () => {
      const deltas = [
        { type: "message_delta", delta: {}, usage: { output_tokens: 9 } },
        { type: "message_delta", delta: { stop_reason: "end_turn" } },
      ];
      if (reverse) deltas.reverse();
      const run = await forward(sse([ANTHROPIC_STREAM[0], ...deltas, { type: "message_stop" }]), "anthropic", true);
      expect(run.body).toContain("[DONE]");
      expect(run.body).not.toContain("upstream_malformed");
      expect(run.records).toHaveLength(1);
      expect(run.records[0]).toMatchObject({ finish: "stop", usage: { input_tokens: 50, output_tokens: 9 } });
      expect(run.records[0]!.usage.cost_usd).toBeGreaterThan(0);
      expect(run.governor.stopReason).toBeNull();
    });
  }
});

describe("upload deadlines bound cap shutdown on both Bun runtimes", () => {
  for (const drop of [false, true]) {
    test(`${drop ? "dropped" : "held"} upload cannot hold a request-cap stop open`, async () => {
      const scratch = ledgerScratch();
      const fake = startFake(() => json(OPENAI_ANSWER));
      const governor = governorFor(scratch.environment, { maxRequests: 1 });
      const server = new CompleteServer({ upstream: upstreamFor(fake, "openai"), governor, port: 0, timeoutMs: 200 });
      const base = await server.start();
      const socket = connect({ host: "127.0.0.1", port: Number(new URL(base).port) });
      socket.on("error", () => {});
      cleanups.push(() => { socket.destroy(); server.stop("signal"); fake.stop(); scratch.cleanup(); });
      await new Promise<void>((resolve) => socket.once("connect", resolve));
      socket.write(`POST /v1/chat/completions HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer ${server.token}\r\nContent-Length: 1000\r\n\r\n{`);
      // The missing-close regression requires dispatch before the drop.
      const deadline = Date.now() + 1000;
      while ((server as unknown as { inFlight: number }).inFlight === 0 && Date.now() < deadline) await Bun.sleep(1);
      expect((server as unknown as { inFlight: number }).inFlight).toBe(1);
      const response = await fetch(`${base}/v1/chat/completions`, {
        method: "POST", headers: { authorization: `Bearer ${server.token}` }, body: JSON.stringify(request),
      });
      expect(response.status).toBe(200);
      await response.text();
      if (drop) socket.destroy();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("cap shutdown hung")), 1500); });
      try {
        expect(await Promise.race([server.done, timeout])).toMatchObject({ reason: "cap", requests: 1, capReason: "request_cap_reached" });
      } finally { clearTimeout(timer); }
      const records = scratch.records();
      expect(records).toHaveLength(2);
      expect(records.filter((row) => row.finish === "refused:bad_request")).toHaveLength(1);
      expect(fake.received).toHaveLength(1);
    });
  }
});

test("README Commands includes complete", () => {
  expect(readFileSync(new URL("../README.md", import.meta.url), "utf8")).toMatch(/^\| `complete` \| Hosted chat completions/m);
});
