/**
 * Regression tests for review round 3 on `codemux complete` (2026-11-10):
 * a streamed tool call without arguments can be sent back, service tiers
 * are judged only on OpenAI itself, a cost_unknown stop names its own code,
 * an upstream error body is read to a byte bound, and the docs state the
 * ledger rules, the after-cap behavior, and the refusal codes.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { toAnthropicRequest } from "../src/complete/anthropic-request.js";
import { AnthropicStreamTranslator } from "../src/complete/anthropic-response.js";
import { CompleteServer } from "../src/complete/server.js";
import { governorFor, json, ledgerScratch, OPENAI_ANSWER, startFake, upstreamFor, type FakeUpstream } from "./helpers/complete-fakes.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

const REQUEST = { model: "gpt-4o", max_tokens: 64, messages: [{ role: "user", content: "Archive the inbox." }] };

async function serve(fake: FakeUpstream, provider: "openai" | "openai-compatible") {
  const scratch = ledgerScratch();
  const governor = governorFor(scratch.environment, { host: new URL(fake.baseUrl).host });
  const server = new CompleteServer({ upstream: upstreamFor(fake, "openai", provider), governor, timeoutMs: 5000, port: 0 });
  const url = await server.start();
  cleanups.push(() => {
    server.stop("signal");
    fake.stop();
    scratch.cleanup();
  });
  const post = (body: unknown) => fetch(`${url}/v1/chat/completions`, {
    method: "POST", headers: { authorization: `Bearer ${server.token}` }, body: JSON.stringify(body),
  });
  return { server, governor, post };
}

describe("tool calls without arguments", () => {
  test("a streamed tool_use block with no input closes with arguments \"{}\"", () => {
    const translator = new AnthropicStreamTranslator(1, false);
    translator.translate({ type: "message_start", message: { id: "m", model: "claude-sonnet-4-5", usage: { input_tokens: 5, output_tokens: 1 } } });
    translator.translate({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "t", name: "list_folders", input: {} } });
    const fragment = translator.translate({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "" } });
    const closing = translator.translate({ type: "content_block_stop", index: 0 });
    const args = [...fragment, ...closing].map((chunk) =>
      ((chunk["choices"] as { delta: { tool_calls: { function: { arguments: string } }[] } }[])[0]!.delta.tool_calls[0]!.function.arguments)).join("");
    expect(args).toBe("{}");
    // A block that streamed its arguments gets nothing more at its stop.
    translator.translate({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "u", name: "read_mail", input: {} } });
    translator.translate({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "{\"folder\":\"inbox\"}" } });
    expect(translator.translate({ type: "content_block_stop", index: 1 })[0]!["choices"]).toEqual([]);
    expect(translator.translate({ type: "content_block_stop", index: 2 })[0]!["choices"]).toEqual([]);
  });

  test("a call sent back with empty arguments translates as an empty input", () => {
    const out = toAnthropicRequest({
      model: "claude-sonnet-4-5", max_tokens: 64,
      messages: [
        { role: "user", content: "go" },
        { role: "assistant", tool_calls: [{ id: "t", type: "function", function: { name: "list_folders", arguments: "" } }] },
        { role: "tool", tool_call_id: "t", content: "inbox" },
      ],
    });
    expect((out["messages"] as { content: unknown[] }[])[1]!.content).toEqual([{ type: "tool_use", id: "t", name: "list_folders", input: {} }]);
  });
});

describe("service tiers and cap codes", () => {
  test("an openai-compatible upstream's own tier names are not judged", async () => {
    const fake = startFake(() => json({ ...OPENAI_ANSWER, service_tier: "on_demand" }));
    const run = await serve(fake, "openai-compatible");
    expect((await run.post({ ...REQUEST, service_tier: "on_demand" })).status).toBe(200);
    expect(run.governor.exhausted).toBe(false);
  });

  test("a request after a cost_unknown stop is refused with code cost_unknown", async () => {
    const scratch = ledgerScratch();
    cleanups.push(() => scratch.cleanup());
    const governor = governorFor(scratch.environment);
    governor.settle(governor.admit("gpt-4o"), { usage: null, servedModel: null, finish: "stop", billable: true, costKnown: false });
    expect(() => governor.admit("gpt-4o")).toThrow(expect.objectContaining({ status: 429, code: "cost_unknown" }));
  });
});

describe("upstream error bodies", () => {
  test("an error body is read to 1 MiB at most", async () => {
    const huge = "x".repeat(3 * 1024 * 1024);
    const run = await serve(startFake(() => new Response(huge, { status: 500 })), "openai");
    const response = await run.post(REQUEST);
    expect(response.status).toBe(502);
    expect(await response.text()).toContain("upstream error body was unreadable or exceeded its size limit");
    expect((await run.server.done).capReason).toBe("cost_unknown");
  });
});

describe("docs", () => {
  test("the docs state the ledger rules, the after-cap behavior, the refusal codes, and agent null", () => {
    const root = join(import.meta.dir, "..");
    const complete = readFileSync(join(root, "docs", "complete.md"), "utf8");
    expect(complete).toContain("`CODEMUX_CALL_LOG=off` turns them off");
    expect(complete).toContain("finds the port closed");
    expect(complete).toContain("`bad_request` when its value is");
    expect(complete).toContain("`service_tier: \"standard_only\"`");
    expect(complete).toContain("`gpt-4o-2024-05-13`");
    const ledger = readFileSync(join(root, "docs", "results-and-usage.md"), "utf8");
    expect(ledger).toContain("`agent`, which is null on a `complete` row");
  });
});
