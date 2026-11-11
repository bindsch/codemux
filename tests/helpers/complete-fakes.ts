/**
 * Fake upstreams for `codemux complete` tests: loopback HTTP servers that
 * speak the OpenAI chat-completions wire or Anthropic's Messages API with
 * canned answers, recording every request they receive. No test reaches a
 * real provider.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCallLog, type CallRecord } from "../../src/call-log.js";
import { CompleteGovernor, type GovernorOptions } from "../../src/complete/governor.js";
import type { UpstreamConfig } from "../../src/complete/provider.js";

export interface Received {
  path: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

export type Responder = (received: Received) => Response | Promise<Response>;

export interface FakeUpstream {
  baseUrl: string;
  received: Received[];
  respond: Responder;
  stop: () => void;
}

export function startFake(respond: Responder): FakeUpstream {
  const fake: FakeUpstream = { baseUrl: "", received: [], respond, stop: () => undefined };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const headers: Record<string, string> = {};
      request.headers.forEach((value, key) => {
        headers[key] = value;
      });
      const received = { path: new URL(request.url).pathname, headers, body: await request.json() as Record<string, unknown> };
      fake.received.push(received);
      return fake.respond(received);
    },
  });
  fake.baseUrl = `http://127.0.0.1:${server.port}/v1`;
  fake.stop = () => server.stop(true);
  return fake;
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

export function sse(events: unknown[], options: { named?: boolean; done?: boolean; comment?: boolean } = {}): Response {
  const parts: string[] = [];
  if (options.comment) parts.push(": OPENROUTER PROCESSING\n\n");
  for (const event of events) {
    const type = (event as { type?: string }).type;
    parts.push(options.named && type !== undefined ? `event: ${type}\ndata: ${JSON.stringify(event)}\n\n` : `data: ${JSON.stringify(event)}\n\n`);
  }
  if (options.done) parts.push("data: [DONE]\n\n");
  return new Response(parts.join(""), { headers: { "content-type": "text/event-stream" } });
}

export const OPENAI_ANSWER = {
  id: "chatcmpl-1",
  object: "chat.completion",
  created: 1,
  model: "gpt-4o-2024-08-06",
  choices: [{
    index: 0,
    message: {
      role: "assistant",
      content: null,
      tool_calls: [{ id: "call_a", type: "function", function: { name: "read_mail", arguments: "{\"folder\":\"inbox\"}" } }],
    },
    finish_reason: "tool_calls",
  }],
  usage: { prompt_tokens: 1000, completion_tokens: 100, total_tokens: 1100, prompt_tokens_details: { cached_tokens: 200 } },
};

export const ANTHROPIC_ANSWER = {
  id: "msg_1",
  type: "message",
  role: "assistant",
  model: "claude-sonnet-4-5-20250929",
  content: [
    { type: "text", text: "Reading the inbox." },
    { type: "tool_use", id: "toolu_1", name: "read_mail", input: { folder: "inbox" } },
  ],
  stop_reason: "tool_use",
  usage: { input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 200, cache_creation_input_tokens: 0 },
};

export const ANTHROPIC_STREAM = [
  { type: "message_start", message: { id: "msg_2", model: "claude-sonnet-4-5-20250929", usage: { input_tokens: 50, output_tokens: 1 } } },
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "ping" },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hi" } },
  { type: "content_block_stop", index: 0 },
  { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_2", name: "read_mail", input: {} } },
  { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "{\"folder\":" } },
  { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "\"inbox\"}" } },
  { type: "content_block_stop", index: 1 },
  { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 20 } },
  { type: "message_stop" },
];

/** A scratch directory holding a private ledger, with its environment. */
export function ledgerScratch(): { dir: string; environment: NodeJS.ProcessEnv; records: () => CallRecord[]; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "codemux-complete-"));
  const environment = { CODEMUX_CALL_LOG: join(dir, "calls.jsonl") };
  return {
    dir,
    environment,
    records: () => {
      try {
        return readCallLog(environment.CODEMUX_CALL_LOG).entries.flatMap((entry) => entry.record === null ? [] : [entry.record]);
      } catch {
        return [];
      }
    },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

export function upstreamFor(fake: FakeUpstream, wire: "openai" | "anthropic", provider?: UpstreamConfig["provider"]): UpstreamConfig {
  return {
    provider: provider ?? (wire === "anthropic" ? "anthropic" : "openai"),
    wire,
    baseUrl: fake.baseUrl,
    host: new URL(fake.baseUrl).host,
    keyEnv: "TEST_KEY",
    apiKey: "sk-test-not-a-real-key",
  };
}

export function governorFor(environment: NodeJS.ProcessEnv, overrides: Partial<GovernorOptions> = {}): CompleteGovernor {
  return new CompleteGovernor({
    budgetUsd: 100,
    maxRequests: 100,
    priceOverride: null,
    providerReportsCost: false,
    host: "127.0.0.1",
    labels: { study: "eA" },
    cwd: "/repo",
    environment,
    ...overrides,
  });
}
