/** Round 8 regressions: capture billing evidence before deciding the outcome. */
import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { runOnce, STOP_SIGNALS, type CompleteDeps } from "../src/complete/command.js";
import { forwardCompletion } from "../src/complete/forward.js";
import type { GovernorOptions } from "../src/complete/governor.js";
import type { UpstreamConfig } from "../src/complete/provider.js";
import { CompleteServer } from "../src/complete/server.js";
import {
  ANTHROPIC_ANSWER, ANTHROPIC_STREAM, OPENAI_ANSWER, governorFor, json, ledgerScratch, sse, startFake, upstreamFor,
} from "./helpers/complete-fakes.js";

const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length > 0) cleanups.pop()!(); });
const REQUEST = { model: "gpt-4o", max_tokens: 64, messages: [{ role: "user", content: "hi" }] };
const USAGE = { prompt_tokens: 1000, completion_tokens: 100 };
const CHUNK = { model: "gpt-4o", choices: [{ index: 0, delta: { content: "Hi" }, finish_reason: "stop" }] };

async function serve(response: () => Response, provider: UpstreamConfig["provider"] = "openai", overrides: Partial<GovernorOptions> = {}) {
  const fake = startFake(response);
  const scratch = ledgerScratch();
  const wire = provider === "anthropic" ? "anthropic" : "openai";
  const governor = governorFor(scratch.environment, { providerReportsCost: provider === "openrouter", ...overrides });
  const server = new CompleteServer({ upstream: upstreamFor(fake, wire, provider), governor, timeoutMs: 2000, port: 0 });
  const url = await server.start();
  cleanups.push(() => { server.stop("signal"); fake.stop(); scratch.cleanup(); });
  const post = (stream = false) => fetch(`${url}/v1/chat/completions`, {
    method: "POST", headers: { authorization: `Bearer ${server.token}` },
    body: JSON.stringify({ ...REQUEST, model: wire === "anthropic" ? "claude-sonnet-4-5" : REQUEST.model, stream }),
  });
  return { post, governor, server, records: scratch.records };
}

describe("whole-response accounting is independent of success", () => {
  for (const status of [200, 503]) {
    test(`HTTP ${status} error at a premium tier stops with unknown cost`, async () => {
      const run = await serve(() => json({ error: { code: 503 }, model: "gpt-4o", service_tier: "priority", usage: USAGE }, status));
      expect((await run.post()).status).toBe(503);
      expect((await run.server.done).capReason).toBe("cost_unknown");
      expect(run.records()).toHaveLength(1);
      expect(run.records()[0]).toMatchObject({ model_effective: "gpt-4o", finish: "upstream_error:503", usage: { input_tokens: 1000, cost_usd: null } });
    });
    test(`HTTP ${status} error served by an unpriced model stops`, async () => {
      const run = await serve(() => json({ error: { code: 503 }, model: "unpriced-reroute", usage: USAGE }, status));
      expect((await run.post()).status).toBe(503);
      expect((await run.server.done).capReason).toBe("cost_unknown");
      expect(run.records()[0]).toMatchObject({ model_effective: "unpriced-reroute", usage: { cost_usd: null } });
    });
    test(`HTTP ${status} error uses the served model price and budget`, async () => {
      const run = await serve(() => json({ error: { code: 503 }, model: "gpt-4o-mini", usage: USAGE }, status), "openai", { budgetUsd: 0.0002 });
      expect((await run.post()).status).toBe(503);
      expect((await run.server.done).capReason).toBe("budget_exhausted");
      expect(run.governor.spentUsd).toBeCloseTo(0.00021, 8);
      expect(run.records()[0]!.usage.cost_usd).toBeCloseTo(0.00021, 8);
    });
    test(`HTTP ${status} OpenRouter error records its charge and enforces the cap`, async () => {
      const run = await serve(() => json({ error: { code: 503 }, model: "vendor/other", usage: { ...USAGE, cost: 0.25 } }, status), "openrouter", { budgetUsd: 0.1 });
      expect((await run.post()).status).toBe(503);
      expect((await run.server.done).capReason).toBe("budget_exhausted");
      expect(run.records()[0]).toMatchObject({ cost_source: "billed", model_effective: "vendor/other", usage: { cost_usd: 0.25 } });
    });
    test(`HTTP ${status} Anthropic error retains served model and usage`, async () => {
      const run = await serve(() => json({ type: "error", error: { code: 503 }, model: "unknown-claude", usage: ANTHROPIC_ANSWER.usage }, status), "anthropic");
      expect((await run.post()).status).toBe(503);
      expect((await run.server.done).capReason).toBe("cost_unknown");
      expect(run.records()[0]).toMatchObject({ model_effective: "unknown-claude", usage: { input_tokens: 1000, output_tokens: 100, cost_usd: null } });
    });
  }
  test("a non-2xx error without billing evidence remains an unbilled refusal", async () => {
    const run = await serve(() => json({ error: { message: "rate limit" } }, 429));
    expect((await run.post()).status).toBe(429);
    expect(run.records()).toHaveLength(1);
    expect(run.records()[0]!.usage.cost_usd).toBeNull();
    expect(run.governor.exhausted).toBe(false);
  });
  test("a truncated non-2xx body cannot prove its cost is zero", async () => {
    const run = await serve(() => new Response("x".repeat(1024 * 1024 + 1), { status: 503 }));
    const response = await run.post();
    expect(response.status).toBe(502);
    expect(await response.text()).toContain("upstream_malformed");
    expect((await run.server.done).capReason).toBe("cost_unknown");
    expect(run.records()).toHaveLength(1);
  });
});

describe("whole-answer validation retains billing evidence", () => {
  const malformed = [
    {}, { choices: null }, { choices: {} }, { choices: [null] }, { choices: [{}] },
    { choices: [{ index: 0, message: null }] },
    { choices: [{ index: 0, message: { role: "user", content: "wrong" } }] },
    { choices: [{ index: 0, message: { role: "assistant", content: 42 } }] },
    { choices: [{ index: 0, message: { role: null } }] },
    { choices: [{ index: 0, message: { role: "assistant", tool_calls: [{}] } }] },
    { choices: [{ index: 0, message: { role: "assistant", function_call: 7 } }] },
    { choices: [{ index: 0, message: { role: "assistant", refusal: {} } }] },
    { choices: [{ index: 0, message: { role: "assistant", audio: "bad" } }] },
    { ...OPENAI_ANSWER, error: "bad" },
    { choices: [...OPENAI_ANSWER.choices, null] },
  ];
  for (const [index, answer] of malformed.entries()) {
    test(`malformed answer ${index} returns 502 and still counts its usage`, async () => {
      const run = await serve(() => json({ ...answer, model: "gpt-4o", usage: USAGE }), "openai", { budgetUsd: 0.001 });
      const response = await run.post();
      expect(response.status).toBe(502);
      expect(await response.text()).toContain("upstream_malformed");
      expect((await run.server.done).capReason).toBe("budget_exhausted");
      expect(run.records()).toHaveLength(1);
      expect(run.records()[0]).toMatchObject({ finish: "upstream_malformed", usage: { input_tokens: 1000, output_tokens: 100 } });
    });
  }
  test("an empty object without usage is a 502 with unknown cost", async () => {
    const run = await serve(() => json({}));
    expect((await run.post()).status).toBe(502);
    expect((await run.server.done).capReason).toBe("cost_unknown");
  });
  test("an invalid Anthropic tool records full usage before translation fails", async () => {
    const run = await serve(() => json({ ...ANTHROPIC_ANSWER, content: [{ type: "tool_use", input: {} }] }), "anthropic");
    expect((await run.post()).status).toBe(502);
    expect(run.records()[0]).toMatchObject({ finish: "untranslatable", usage: { input_tokens: 1000, output_tokens: 100 } });
    expect(run.governor.spentUsd).toBeGreaterThan(0);
  });
  test("an Anthropic body of the wrong message type is not a success", async () => {
    const run = await serve(() => json({ ...ANTHROPIC_ANSWER, type: "wrong" }), "anthropic");
    expect((await run.post()).status).toBe(502);
    expect(run.records()[0]!.usage.input_tokens).toBe(1000);
  });
});

describe("stream failures retain all billing evidence", () => {
  test("an OpenRouter error event records its tokens and charge before stopping", async () => {
    const run = await serve(() => sse([{ error: { message: "failed" }, model: "vendor/other", usage: { ...USAGE, cost: 0.25 } }], { done: true }), "openrouter");
    const text = await (await run.post(true)).text();
    expect(text).toContain("reported an error");
    expect(text).not.toContain("[DONE]");
    expect((await run.server.done).capReason).toBe("cost_unknown");
    expect(run.governor.spentUsd).toBe(0.25);
    expect(run.records()).toHaveLength(1);
    expect(run.records()[0]).toMatchObject({ model_effective: "vendor/other", cost_source: "billed", usage: { input_tokens: 1000, output_tokens: 100, cost_usd: 0.25 } });
  });
  test("a premium tier on an error event prevents a standard-tier estimate", async () => {
    const run = await serve(() => sse([{ error: {}, model: "gpt-4o", service_tier: "priority", usage: USAGE }]));
    await (await run.post(true)).text();
    expect((await run.server.done).capReason).toBe("cost_unknown");
    expect(run.records()[0]!.usage.cost_usd).toBeNull();
  });
  for (const event of [
    { type: "error", error: { message: "failed" }, usage: { output_tokens: 77 } },
    { type: "message_delta", error: { message: "failed" }, usage: { output_tokens: 77 } },
    { type: "message_stop", error: { message: "failed" }, usage: { output_tokens: 77 } },
    { type: "unknown", usage: { output_tokens: 77 } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: null }, usage: { output_tokens: 77 } },
  ]) {
    test(`Anthropic ${event.type} captures usage before rejecting the event`, async () => {
      const run = await serve(() => sse([ANTHROPIC_STREAM[0], event]), "anthropic");
      const text = await (await run.post(true)).text();
      expect(text).toContain("upstream_malformed");
      expect(text).not.toContain("[DONE]");
      expect((await run.server.done).capReason).toBe("cost_unknown");
      expect(run.records()[0]).toMatchObject({ usage: { input_tokens: 50, output_tokens: 77 } });
    });
  }
  test("an errored message_start captures nested usage and served model", async () => {
    const run = await serve(() => sse([{ ...ANTHROPIC_STREAM[0], error: { message: "failed" } }]), "anthropic");
    await (await run.post(true)).text();
    expect((await run.server.done).capReason).toBe("cost_unknown");
    expect(run.records()[0]).toMatchObject({ model_effective: "claude-sonnet-4-5-20250929", usage: { input_tokens: 50 } });
  });
  test("invalid Anthropic error counts cannot erase earlier valid counts", async () => {
    const run = await serve(() => sse([ANTHROPIC_STREAM[0], {
      type: "error", error: {}, usage: { input_tokens: "bad", output_tokens: -1 },
    }]), "anthropic");
    await (await run.post(true)).text();
    expect((await run.server.done).capReason).toBe("cost_unknown");
    expect(run.records()[0]).toMatchObject({ usage: { input_tokens: 50, output_tokens: 1, cost_usd: null } });
  });
  for (const [name, events] of [
    ["empty", []], ["object without choices", [{ usage: USAGE }]],
    ["null choice", [{ choices: [null], usage: USAGE }]],
    ["null choices", [{ choices: null, usage: USAGE }]],
    ["missing delta", [{ ...CHUNK, choices: [{ index: 0, finish_reason: null }], usage: USAGE }]],
    ["invalid second delta", [{ ...CHUNK, choices: [...CHUNK.choices, { index: 1, delta: null }], usage: USAGE }]],
  ] as const) {
    test(`${name} stream cannot finish successfully at DONE`, async () => {
      const run = await serve(() => sse([...events], { done: true }));
      const text = await (await run.post(true)).text();
      expect(text).toContain("upstream_malformed");
      expect(text).not.toContain("[DONE]");
      expect((await run.server.done).capReason).toBe("cost_unknown");
      expect(run.records()).toHaveLength(1);
      if (events.length > 0) expect(run.records()[0]!.usage.input_tokens).toBe(1000);
    });
  }
  test("a charge-only error retains earlier counts and stops at unknown cost", async () => {
    const run = await serve(() => sse([{ ...CHUNK, usage: USAGE }, { error: {}, usage: { cost: 0.25 } }]), "openrouter");
    await (await run.post(true)).text();
    expect((await run.server.done).capReason).toBe("cost_unknown");
    expect(run.records()[0]).toMatchObject({ usage: { input_tokens: 1000, output_tokens: 100, cost_usd: 0.25 } });
  });
  test("an empty usage event cannot erase earlier tokens or charges", async () => {
    const run = await serve(() => sse([{ ...CHUNK, usage: { ...USAGE, cost: 0.25 } }, { error: {}, usage: {} }]), "openrouter");
    await (await run.post(true)).text();
    expect((await run.server.done).capReason).toBe("cost_unknown");
    expect(run.records()[0]!.usage.cost_usd).toBe(0.25);
  });
  test("a later count-only event cannot erase a previously reported charge", async () => {
    const run = await serve(() => sse([{ ...CHUNK, usage: { ...USAGE, cost: 0.25 } }, { choices: [], usage: USAGE }], { done: true }), "openrouter");
    await (await run.post(true)).text();
    expect((await run.server.done).capReason).toBe("cost_unknown");
    expect(run.records()[0]!.usage.cost_usd).toBe(0.25);
  });
  test("a premium tier cannot be erased by a later standard-tier chunk", async () => {
    const run = await serve(() => sse([{ ...CHUNK, service_tier: "priority" }, { choices: [], usage: USAGE, service_tier: "default" }], { done: true }));
    await (await run.post(true)).text();
    expect((await run.server.done).capReason).toBe("cost_unknown");
    expect(run.records()[0]!.usage.cost_usd).toBeNull();
  });
  test("a model change cannot hide an earlier unpriced model", async () => {
    const run = await serve(() => sse([{ ...CHUNK, model: "unpriced" }, { choices: [], model: "gpt-4o", usage: USAGE }], { done: true }));
    await (await run.post(true)).text();
    expect((await run.server.done).capReason).toBe("cost_unknown");
    expect(run.records()[0]!.usage.cost_usd).toBeNull();
  });
  test("an Anthropic block with an invalid index retains its usage", async () => {
    const run = await serve(() => sse([ANTHROPIC_STREAM[0], {
      type: "content_block_start", content_block: { type: "text", text: "Hi" }, usage: { output_tokens: 77 },
    }]), "anthropic");
    expect(await (await run.post(true)).text()).toContain("invalid index");
    expect((await run.server.done).capReason).toBe("cost_unknown");
    expect(run.records()[0]!.usage.output_tokens).toBe(77);
  });
});

describe("partial counts and charges", () => {
  test("a non-2xx usage object without counts cannot claim an unbilled refusal", async () => {
    const run = await serve(() => json({ error: {}, usage: {} }, 503));
    expect((await run.post()).status).toBe(503);
    expect((await run.server.done).capReason).toBe("cost_unknown");
    expect(run.records()[0]!.usage.cost_usd).toBeNull();
  });
  test("charge-only whole errors count dollars without inventing token counts", async () => {
    const run = await serve(() => json({ error: {}, usage: { cost: 0.25 } }, 503), "openrouter");
    expect((await run.post()).status).toBe(503);
    expect((await run.server.done).capReason).toBe("cost_unknown");
    expect(run.governor.spentUsd).toBe(0.25);
    expect(run.records()[0]).toMatchObject({ usage: { input_tokens: null, output_tokens: null, total_tokens: null, cost_usd: 0.25 } });
  });
  test("partial token counts remain visible without a fabricated zero cost", async () => {
    const run = await serve(() => json({ ...OPENAI_ANSWER, usage: { prompt_tokens: 1000 } }));
    expect((await run.post()).status).toBe(200);
    expect((await run.server.done).capReason).toBe("cost_unknown");
    expect(run.records()[0]).toMatchObject({ usage: { input_tokens: 1000, output_tokens: null, total_tokens: null, cost_usd: null } });
  });
});

describe("delivery failures settle exactly once", () => {
  for (const stream of [false, true]) {
    test(`${stream ? "stream headers" : "whole answer"} delivery failure writes one row`, async () => {
      const scratch = ledgerScratch();
      cleanups.push(scratch.cleanup);
      const governor = governorFor(scratch.environment);
      const upstream = upstreamFor({ baseUrl: "http://127.0.0.1:1/v1" } as Parameters<typeof upstreamFor>[0], "anthropic");
      const fetchImpl = (async () => stream ? sse(ANTHROPIC_STREAM) : json(ANTHROPIC_ANSWER)) as unknown as typeof fetch;
      const fail = () => { throw new Error("delivery failed"); };
      const pending = forwardCompletion({ ...REQUEST, model: "claude-sonnet-4-5", stream }, {
        upstream, governor, shutdown: new AbortController().signal, timeoutMs: 2000, fetchImpl,
      }, { closed: new AbortController().signal, send: fail, begin: fail, write: fail, end() {} });
      await expect(pending).rejects.toThrow("delivery failed");
      expect(scratch.records()).toHaveLength(1);
      if (stream) expect(governor.stopReason).toBe("cost_unknown");
      else expect(governor.spentUsd).toBeGreaterThan(0);
    });
  }
});

describe("once signals await settlement", () => {
  test("a real once process settles before exiting on SIGTERM", async () => {
    const scratch = ledgerScratch();
    const file = join(scratch.dir, "request.json");
    writeFileSync(file, JSON.stringify(REQUEST));
    let accepted!: () => void;
    const acceptance = new Promise<void>((resolve) => { accepted = resolve; });
    let release!: () => void;
    const fake = startFake(() => { accepted(); return new Promise<Response>((resolve) => { release = () => resolve(json(OPENAI_ANSWER)); }); });
    const child = Bun.spawn([process.execPath, "src/index.ts", "complete", "once", "--provider", "openai", "--base-url", fake.baseUrl,
      "--key-env", "TEST_KEY", "--timeout", "2", "-f", file], {
      env: { PATH: process.env.PATH, ...scratch.environment, TEST_KEY: "fake-key" }, stdout: "pipe", stderr: "pipe",
    });
    cleanups.push(() => { if (child.exitCode === null) child.kill(); release?.(); fake.stop(); scratch.cleanup(); });
    await Promise.race([acceptance, child.exited.then((code) => { throw new Error(`once exited before acceptance: ${code}`); })]);
    child.kill("SIGTERM");
    expect(await child.exited).toBe(143);
    expect(await new Response(child.stdout).text()).toBe("");
    expect(scratch.records()).toHaveLength(1);
    expect(scratch.records()[0]).toMatchObject({ finish: "interrupted", usage: { cost_usd: null } });
  });
  for (const signal of STOP_SIGNALS) {
    test(`${signal} after upstream acceptance writes one interrupted row and exits 143`, async () => {
      const scratch = ledgerScratch();
      const file = join(scratch.dir, "request.json");
      writeFileSync(file, JSON.stringify(REQUEST));
      let accepted!: () => void;
      const acceptance = new Promise<void>((resolve) => { accepted = resolve; });
      let release!: () => void;
      const fake = startFake(() => { accepted(); return new Promise<Response>((resolve) => { release = () => resolve(json(OPENAI_ANSWER)); }); });
      const out: string[] = [];
      const err: string[] = [];
      let stopped!: () => void;
      let unregistered = 0;
      const deps: CompleteDeps = {
        environment: { ...scratch.environment, TEST_KEY: "fake-key" }, cwd: "/repo",
        stdout: (text) => out.push(text), stderr: (text) => err.push(text),
        onSignal: (handler) => {
          stopped = handler;
          process.on(signal, handler);
          return () => { process.off(signal, handler); unregistered++; };
        },
      };
      cleanups.push(() => { process.off(signal, stopped); release?.(); fake.stop(); scratch.cleanup(); });
      const pending = runOnce({ provider: "openai", baseUrl: fake.baseUrl, keyEnv: "TEST_KEY", timeout: "2", label: [], file }, deps);
      await acceptance;
      process.emit(signal);
      expect(await pending).toBe(143);
      expect(unregistered).toBe(1);
      expect(out).toEqual([]);
      expect(scratch.records()).toHaveLength(1);
      expect(scratch.records()[0]).toMatchObject({ finish: "interrupted", usage: { cost_usd: null } });
    });
  }
  test("a body-read abort settles once even after response headers arrived", async () => {
    const scratch = ledgerScratch();
    cleanups.push(scratch.cleanup);
    const governor = governorFor(scratch.environment);
    const shutdown = new AbortController();
    const upstream = upstreamFor({ baseUrl: "http://127.0.0.1:1/v1" } as Parameters<typeof upstreamFor>[0], "openai");
    const fetchImpl = (async () => new Response(new ReadableStream({
      start(controller) { shutdown.signal.addEventListener("abort", () => controller.error(new Error("aborted"))); },
    }))) as unknown as typeof fetch;
    const pending = forwardCompletion(REQUEST, { upstream, governor, shutdown: shutdown.signal, timeoutMs: 2000, fetchImpl }, {
      closed: new AbortController().signal, send() {}, begin() {}, write() {}, end() {},
    });
    await Bun.sleep(1);
    shutdown.abort();
    await expect(pending).rejects.toThrow("upstream answer");
    expect(scratch.records()).toHaveLength(1);
    expect(scratch.records()[0]!.finish).toBe("interrupted");
    expect(governor.stopReason).toBe("cost_unknown");
  });
});
