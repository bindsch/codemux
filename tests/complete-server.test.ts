import { afterEach, describe, expect, test } from "bun:test";
import { CompleteServer, LOOPBACK_HOST } from "../src/complete/server.js";
import {
  ANTHROPIC_ANSWER, ANTHROPIC_STREAM, governorFor, json, ledgerScratch, OPENAI_ANSWER, sse, startFake,
  upstreamFor, type FakeUpstream,
} from "./helpers/complete-fakes.js";
import type { CompleteGovernor } from "../src/complete/governor.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

interface Running {
  server: CompleteServer;
  url: string;
  governor: CompleteGovernor;
  scratch: ReturnType<typeof ledgerScratch>;
  post: (body: unknown, token?: string | null) => Promise<Response>;
}

async function serve(fake: FakeUpstream, wire: "openai" | "anthropic", governorOptions = {}, provider?: "openrouter"): Promise<Running> {
  const scratch = ledgerScratch();
  const governor = governorFor(scratch.environment, { host: new URL(fake.baseUrl).host, ...governorOptions });
  const server = new CompleteServer({ upstream: upstreamFor(fake, wire, provider), governor, timeoutMs: 5000, port: 0 });
  const url = await server.start();
  cleanups.push(() => {
    server.stop("signal");
    fake.stop();
    scratch.cleanup();
  });
  const post = (body: unknown, token: string | null = server.token) => fetch(`${url}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token === null ? {} : { authorization: `Bearer ${token}` }) },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return { server, url, governor, scratch, post };
}

const REQUEST = {
  model: "gpt-4o",
  max_tokens: 64,
  messages: [{ role: "user", content: "Archive the inbox." }],
  tools: [{ type: "function", function: { name: "read_mail", parameters: { type: "object", properties: {} } } }],
};

async function readStream(response: Response): Promise<string[]> {
  const text = await response.text();
  return text.split("\n\n").filter((part) => part !== "");
}

describe("codemux complete serve: wire and governance", () => {
  test("binds 127.0.0.1 only and refuses a request without the bearer token, writing no ledger row", async () => {
    const fake = startFake(() => json(OPENAI_ANSWER));
    const run = await serve(fake, "openai");
    expect(new URL(run.url).hostname).toBe(LOOPBACK_HOST);
    for (const token of [null, "wrong"]) {
      const response = await run.post(REQUEST, token);
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: { message: "missing or wrong bearer token", type: "codemux_error", code: "unauthorized" } });
    }
    const other = await fetch(`${run.url}/v1/models`, { headers: { authorization: `Bearer ${run.server.token}` } });
    expect(other.status).toBe(404);
    const get = await fetch(`${run.url}/v1/chat/completions`, { headers: { authorization: `Bearer ${run.server.token}` } });
    expect(get.status).toBe(405);
    expect(fake.received).toHaveLength(0);
    expect(run.scratch.records()).toHaveLength(0);
  });

  test("an OpenAI upstream gets the request unchanged and the answer comes back byte for byte", async () => {
    const fake = startFake(() => json(OPENAI_ANSWER));
    const run = await serve(fake, "openai");
    const response = await run.post(REQUEST);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(JSON.stringify(OPENAI_ANSWER));
    expect(fake.received[0]!.path).toBe("/v1/chat/completions");
    expect(fake.received[0]!.body).toEqual(REQUEST);
    expect(fake.received[0]!.headers["authorization"]).toBe("Bearer sk-test-not-a-real-key");
    const [row] = run.scratch.records();
    // gpt-4o: 800 uncached at $2.50/M, 200 cached at $1.25/M, 100 out at $10/M.
    expect(row).toMatchObject({
      kind: "complete", agent: null, model: "gpt-4o", model_effective: "gpt-4o-2024-08-06",
      provider: new URL(fake.baseUrl).host, finish: "tool_calls", labels: { study: "eA" }, cost_source: "price-table",
      usage: { input_tokens: 800, cached_input_tokens: 200, output_tokens: 100, total_tokens: 1100 },
    });
    expect(row!.usage.cost_usd).toBeCloseTo(0.00325, 10);
    // Neither the prompt text nor the key reaches the ledger.
    const line = JSON.stringify(row);
    expect(line).not.toContain("Archive the inbox");
    expect(line).not.toContain("sk-test");
  });

  test("an OpenAI stream passes through; the usage chunk codemux asked for is withheld unless the client asked", async () => {
    const chunks = [
      { id: "c", object: "chat.completion.chunk", model: "gpt-4o-2024-08-06", choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "call_a", type: "function", function: { name: "read_mail", arguments: "" } }] }, finish_reason: null }] },
      { id: "c", object: "chat.completion.chunk", model: "gpt-4o-2024-08-06", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
      { id: "c", object: "chat.completion.chunk", model: "gpt-4o-2024-08-06", choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
    ];
    const fake = startFake(() => sse(chunks, { done: true, comment: true }));
    const run = await serve(fake, "openai");
    const quiet = await readStream(await run.post({ ...REQUEST, stream: true }));
    expect(fake.received[0]!.body["stream_options"]).toEqual({ include_usage: true });
    expect(quiet).toEqual([": OPENROUTER PROCESSING", `data: ${JSON.stringify(chunks[0])}`, `data: ${JSON.stringify(chunks[1])}`, "data: [DONE]"]);
    const loud = await readStream(await run.post({ ...REQUEST, stream: true, stream_options: { include_usage: true } }));
    expect(loud).toContain(`data: ${JSON.stringify(chunks[2])}`);
    const rows = run.scratch.records();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ finish: "tool_calls", model_effective: "gpt-4o-2024-08-06", usage: { input_tokens: 10, output_tokens: 5 } });
  });

  test("an Anthropic upstream is translated both ways, whole and streamed", async () => {
    const fake = startFake((received) => received.body["stream"] === true
      ? sse(ANTHROPIC_STREAM, { named: true })
      : json(ANTHROPIC_ANSWER));
    const run = await serve(fake, "anthropic");
    const request = { ...REQUEST, model: "claude-sonnet-4-5" };
    const whole = await (await run.post(request)).json() as Record<string, unknown>;
    expect(fake.received[0]!.path).toBe("/v1/messages");
    expect(fake.received[0]!.headers["x-api-key"]).toBe("sk-test-not-a-real-key");
    expect(fake.received[0]!.body).toEqual({
      model: "claude-sonnet-4-5", max_tokens: 64,
      messages: [{ role: "user", content: [{ type: "text", text: "Archive the inbox." }] }],
      tools: [{ name: "read_mail", input_schema: { type: "object", properties: {} } }],
      service_tier: "standard_only",
    });
    expect((whole["choices"] as { message: { tool_calls: unknown } }[])[0]!.message.tool_calls)
      .toEqual([{ id: "toolu_1", type: "function", function: { name: "read_mail", arguments: "{\"folder\":\"inbox\"}" } }]);
    const streamed = await readStream(await run.post({ ...request, stream: true, stream_options: { include_usage: true } }));
    expect(streamed[streamed.length - 1]).toBe("data: [DONE]");
    const usageChunk = JSON.parse(streamed[streamed.length - 2]!.slice(6)) as Record<string, unknown>;
    expect(usageChunk["usage"]).toEqual({ prompt_tokens: 50, completion_tokens: 20, total_tokens: 70, prompt_tokens_details: { cached_tokens: 0 } });
    const rows = run.scratch.records();
    // Sonnet 4.5: 1000 in at $3/M, 200 cache reads at $0.30/M, 100 out at $15/M.
    expect(rows[0]!.usage.cost_usd).toBeCloseTo(0.00456, 10);
    expect(rows[1]).toMatchObject({ finish: "tool_calls", usage: { input_tokens: 50, output_tokens: 20 } });
  });

  test("a request that cannot translate is a 400 with a refusal row, and does not count against the cap", async () => {
    const fake = startFake(() => json(ANTHROPIC_ANSWER));
    const run = await serve(fake, "anthropic", { maxRequests: 1 });
    const response = await run.post({ ...REQUEST, model: "claude-sonnet-4-5", seed: 3 });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("cannot_translate");
    const garbage = await run.post("{not json");
    expect(garbage.status).toBe(400);
    expect(fake.received).toHaveLength(0);
    expect(run.governor.requests).toBe(0);
    expect(run.scratch.records().map((row) => row.finish)).toEqual(["refused:cannot_translate", "refused:bad_request"]);
  });

  test("the request cap stops the server; a later request finds the port closed", async () => {
    const fake = startFake(() => json(OPENAI_ANSWER));
    const run = await serve(fake, "openai", { maxRequests: 1 });
    expect((await run.post(REQUEST)).status).toBe(200);
    const summary = await run.server.done;
    expect(summary).toMatchObject({ reason: "cap", requests: 1, capReason: "request_cap_reached" });
    await expect(run.post(REQUEST)).rejects.toThrow();
  });

  test("the budget cap refuses the next request with 429 and a ledger row", async () => {
    const fake = startFake(() => json(OPENAI_ANSWER));
    const scratch = ledgerScratch();
    cleanups.push(() => {
      fake.stop();
      scratch.cleanup();
    });
    const governor = governorFor(scratch.environment, { budgetUsd: 0.001 });
    governor.settle(governor.admit("gpt-4o"), { usage: { input: 1000, cacheRead: 0, cacheWrite: 0, output: 0, reportedCostUsd: null }, servedModel: null, finish: "stop", billable: true, costKnown: true });
    expect(governor.exhausted).toBe(true);
    expect(() => governor.admit("gpt-4o")).toThrow("budget of $0.001 is spent");
    expect(scratch.records().map((row) => row.finish)).toEqual(["stop", "refused:budget_exhausted"]);
    // A 429 over the wire too, before the server notices it is spent.
    const server = new CompleteServer({ upstream: upstreamFor(fake, "openai"), governor, timeoutMs: 5000, port: 0 });
    const url = await server.start();
    const response = await fetch(`${url}/v1/chat/completions`, {
      method: "POST", headers: { authorization: `Bearer ${server.token}` }, body: JSON.stringify(REQUEST),
    });
    expect(response.status).toBe(429);
    expect(((await response.json()) as { error: { type: string; code: string } }).error).toMatchObject({ type: "codemux_error", code: "budget_exhausted" });
    expect((await server.done).capReason).toBe("budget_exhausted");
    expect(fake.received).toHaveLength(0);
  });

  test("an unpriced model is refused unless the provider reports its charge", async () => {
    const fake = startFake(() => json({ ...OPENAI_ANSWER, model: "vendor/odd", usage: { prompt_tokens: 10, completion_tokens: 1, cost: 0.25 } }));
    const run = await serve(fake, "openai");
    const refused = await run.post({ ...REQUEST, model: "vendor/odd" });
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe("model_not_priced");
    const routed = await serve(startFake(fake.respond), "openai", { providerReportsCost: true }, "openrouter");
    expect((await routed.post({ ...REQUEST, model: "vendor/odd" })).status).toBe(200);
    const [row] = routed.scratch.records();
    expect(row).toMatchObject({ cost_source: "billed", usage: { cost_usd: 0.25 } });
    expect(routed.governor.spentUsd).toBe(0.25);
  });

  test("an OpenRouter answer without a charge for an unpriced model stops the server (cost unknown)", async () => {
    const fake = startFake(() => json({ ...OPENAI_ANSWER, model: "vendor/odd", usage: { prompt_tokens: 10, completion_tokens: 1 } }));
    const run = await serve(fake, "openai", { providerReportsCost: true }, "openrouter");
    expect((await run.post({ ...REQUEST, model: "vendor/odd" })).status).toBe(200);
    expect(fake.received[0]!.body["usage"]).toEqual({ include: true });
    expect((await run.server.done).capReason).toBe("cost_unknown");
  });

  test("upstream errors pass through in the OpenAI error shape and are recorded", async () => {
    let status = 529;
    const fake = startFake(() => new Response(JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }), { status }));
    const run = await serve(fake, "anthropic");
    const response = await run.post({ ...REQUEST, model: "claude-sonnet-4-5" });
    expect(response.status).toBe(529);
    expect(await response.json()).toEqual({ error: { message: "Overloaded", type: "overloaded_error", code: null } });
    fake.respond = () => new Response("plain failure", { status: 500 });
    status = 500;
    const plain = await run.post({ ...REQUEST, model: "claude-sonnet-4-5" });
    expect(await plain.json()).toEqual({ error: { message: "plain failure", type: "upstream_error", code: null } });
    // An HTTP error is not billed, so the server keeps serving. A 200 that
    // cannot be read may be billed at an unknown cost: the server stops.
    fake.respond = () => new Response("not json", { status: 200 });
    expect((await run.post({ ...REQUEST, model: "claude-sonnet-4-5" })).status).toBe(502);
    expect(run.scratch.records().map((row) => row.finish)).toEqual(["upstream_error:529", "upstream_error:500", "upstream_malformed"]);
    expect((await run.server.done).capReason).toBe("cost_unknown");
    const pausing = startFake(() => json({ ...ANTHROPIC_ANSWER, stop_reason: "unknown_reason" }));
    const second = await serve(pausing, "anthropic");
    expect((await second.post({ ...REQUEST, model: "claude-sonnet-4-5" })).status).toBe(502);
    // The untranslatable answer still cost money, is priced, and keeps the cap.
    expect(second.scratch.records()[0]!.finish).toBe("untranslatable");
    expect(second.scratch.records()[0]!.usage.cost_usd).toBeGreaterThan(0);
    expect(second.governor.exhausted).toBe(false);
  });

  test("an unreachable upstream is a 502; a broken stream ends with an error event", async () => {
    const fake = startFake(() => json(OPENAI_ANSWER));
    const run = await serve(fake, "openai");
    fake.stop();
    const response = await run.post(REQUEST);
    expect(response.status).toBe(502);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("upstream_unreachable");
    const broken = startFake(() => new Response("data: {broken\n\n", { headers: { "content-type": "text/event-stream" } }));
    const second = await serve(broken, "openai");
    const parts = await readStream(await second.post({ ...REQUEST, stream: true }));
    expect(parts[parts.length - 1]).toContain("\"type\":\"codemux_error\"");
    expect(second.scratch.records()[0]!.finish).toBe("stream_error:upstream_malformed");
    const anthropicError = startFake(() => sse([ANTHROPIC_STREAM[0], { type: "error", error: { message: "overloaded" } }], { named: true }));
    const third = await serve(anthropicError, "anthropic");
    const errored = await readStream(await third.post({ ...REQUEST, model: "claude-sonnet-4-5", stream: true }));
    expect(errored[errored.length - 1]).toContain("overloaded");
    expect(third.scratch.records()[0]!.usage.input_tokens).toBe(50);
  });

  test("a signal stops the server, aborting the request in flight, which is recorded as interrupted", async () => {
    let release: () => void = () => undefined;
    const fake = startFake(() => new Promise<Response>((resolve) => {
      release = () => resolve(json(OPENAI_ANSWER));
    }));
    const run = await serve(fake, "openai");
    const pending = run.post(REQUEST).catch((error: unknown) => error);
    while (fake.received.length === 0) await Bun.sleep(5);
    run.server.stop("signal");
    const summary = await run.server.done;
    release();
    expect(summary).toMatchObject({ reason: "signal", requests: 1 });
    await pending;
    expect(run.scratch.records()[0]!.finish).toBe("interrupted");
    // A straggler on a kept-alive connection gets the 503 shutting_down; a
    // new connection is refused. Either way nothing more is forwarded.
    const straggler = await run.post(REQUEST).then((response) => response.status, () => "refused");
    expect([503, "refused"]).toContain(straggler);
    expect(fake.received).toHaveLength(1);
  });

  test("a body over the size bound is refused with 413", async () => {
    const fake = startFake(() => json(OPENAI_ANSWER));
    const run = await serve(fake, "openai");
    const response = await run.post(`{"model":"gpt-4o","pad":"${"x".repeat(33 * 1024 * 1024)}"}`);
    expect(response.status).toBe(413);
    expect(fake.received).toHaveLength(0);
    expect(run.scratch.records().map((row) => row.finish)).toEqual(["refused:payload_too_large"]);
  });
});
