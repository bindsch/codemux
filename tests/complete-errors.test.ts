/** Execute the public error table and the Anthropic malformed-value contract. */
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { toAnthropicRequest } from "../src/complete/anthropic-request.js";
import { CompleteError } from "../src/complete/errors.js";
import { forwardCompletion } from "../src/complete/forward.js";
import { CompleteServer } from "../src/complete/server.js";
import { OPENAI_ANSWER, governorFor, json, ledgerScratch, startFake, upstreamFor } from "./helpers/complete-fakes.js";

type Json = Record<string, unknown>;
const request = { model: "gpt-4o", max_tokens: 64, messages: [{ role: "user", content: "hi" }] };
const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });
const docs = readFileSync(new URL("../docs/complete.md", import.meta.url), "utf8");
const rows = docs.split("| Error code | HTTP status | Condition |\n")[1]!.split("\n\n")[0]!.split("\n")
  .flatMap((line) => {
    const match = /^\| `([^`]+)` \| (\d+) \|/.exec(line);
    return match ? [[match[1]!, Number(match[2])] as const] : [];
  });

async function exercise(code: string): Promise<{ status: number; body: Json }> {
  const scratch = ledgerScratch();
  cleanups.push(scratch.cleanup);
  const governor = governorFor(scratch.environment, { maxRequests: 1, budgetUsd: 1 });
  const fake = startFake(() => json(OPENAI_ANSWER));
  cleanups.push(fake.stop);
  const upstream = upstreamFor(fake, code === "cannot_translate" ? "anthropic" : "openai");
  if (["unauthorized", "not_found", "method_not_allowed", "payload_too_large", "bad_request"].includes(code)) {
    const server = new CompleteServer({ upstream, governor, timeoutMs: 1000, port: 0 });
    const url = await server.start();
    cleanups.push(() => server.stop("signal"));
    const response = await fetch(url + (code === "not_found" ? "/missing" : "/v1/chat/completions"), {
      method: code === "method_not_allowed" ? "GET" : "POST",
      headers: code === "unauthorized" ? {} : { authorization: `Bearer ${server.token}` },
      body: code === "method_not_allowed" ? undefined : code === "payload_too_large" ? "x".repeat(32 * 1024 * 1024 + 1)
        : code === "bad_request" ? "{" : JSON.stringify(request),
    });
    return { status: response.status, body: await response.json() as Json };
  }
  const shutdown = new AbortController();
  let input: Json = request;
  let response = json(OPENAI_ANSWER);
  switch (code) {
    case "cannot_translate": input = { ...request, model: "claude-sonnet-4-5", seed: 7 }; break;
    case "model_not_priced": input = { ...request, model: "unpriced" }; break;
    case "budget_exhausted": governor.spentUsd = 1; break;
    case "request_cap_reached": governor.admit(request.model); break;
    case "cost_unknown": governor.settle(governor.admit(request.model), {
      usage: null, servedModel: null, finish: "stop", billable: true, costKnown: false,
    }); break;
    case "shutting_down": shutdown.abort(); break;
    case "upstream_unreachable": fake.respond = () => new Response(null, { status: 302, headers: { location: "https://example.test" } }); break;
    case "upstream_malformed": response = json({}); break;
    default: throw new Error(`No executable fixture for documented error ${code}`);
  }
  let status = 0;
  let body: Json = {};
  try {
    await forwardCompletion(input, {
      upstream, governor, timeoutMs: 1000, shutdown: shutdown.signal,
      fetchImpl: code === "upstream_unreachable" ? fetch : (async () => response) as unknown as typeof fetch,
    }, {
      closed: new AbortController().signal,
      send(s, _type, text) { status = s; body = JSON.parse(text); }, begin() {}, write() {}, end() {},
    });
  } catch (error) {
    if (!(error instanceof CompleteError)) throw error;
    status = error.status;
    body = { error: { type: "codemux_error", code: error.code } };
  }
  return { status, body };
}

describe("documented error table", () => {
  test("the table covers the complete public error-code union", () => {
    const source = readFileSync(new URL("../src/complete/errors.ts", import.meta.url), "utf8");
    const codes = [...source.matchAll(/^  \| "([^"]+)"/gm)].map((match) => match[1]!);
    expect(rows.map(([code]) => code).sort()).toEqual(codes.sort());
  });
  for (const [code, status] of rows) {
    test(`${code}: HTTP ${status}`, async () => {
      const actual = await exercise(code);
      expect(actual.status).toBe(status);
      expect(actual.body).toMatchObject({ error: { code, type: "codemux_error" } });
    });
  }
});

describe("Anthropic mapped values distinguish malformed input from unsupported features", () => {
  for (const parameters of [undefined, null, {}, { type: "object", properties: { folder: { type: "string" } } }]) {
    test(`documented parameter default: ${JSON.stringify(parameters)}`, () => {
      expect(docs).toContain("an empty object schema when absent or null; any other non-object is refused");
      const fn = { name: "f", ...(parameters === undefined ? {} : { parameters }) };
      const mapped = toAnthropicRequest({ ...request, tools: [{ type: "function", function: fn }] });
      expect(mapped["tools"]).toEqual([{ name: "f", input_schema: parameters ?? { type: "object", properties: {} } }]);
    });
  }
  for (const args of ["", " ", "\t\r\n ", "{}", " {\"folder\":\"inbox\"} "]) {
    test(`documented blank arguments: ${JSON.stringify(args)}`, () => {
      expect(docs).toContain("empty or whitespace-only strings become `{}`");
      const mapped = toAnthropicRequest({ ...request, messages: [{ role: "assistant", tool_calls: [
        { id: "a", type: "function", function: { name: "f", arguments: args } },
      ] }] });
      expect(mapped["messages"]).toEqual([{ role: "assistant", content: [
        { type: "tool_use", id: "a", name: "f", input: args.trim() === "" ? {} : JSON.parse(args) },
      ] }]);
    });
  }
  const bad: [string, Json][] = [
    ...[0, -1, 1.5, "64", NaN, Infinity].flatMap((value): [string, Json][] => [
      [`max_tokens ${String(value)}`, { max_tokens: value }],
      [`max_completion_tokens ${String(value)}`, { max_tokens: undefined, max_completion_tokens: value }],
    ]),
    ["disagreeing caps", { max_completion_tokens: 65 }],
    ...["hot", -1, 3, NaN, Infinity].map((v): [string, Json] => [`temperature ${String(v)}`, { temperature: v }]),
    ...["high", -1, 2, NaN, Infinity].map((v): [string, Json] => [`top_p ${String(v)}`, { top_p: v }]),
    ["stop", { stop: [1] }], ["n", { n: 0 }], ["store", { store: "yes" }],
    ["seed", { seed: 1.5 }], ["logprobs", { logprobs: "yes" }],
    ["penalty", { frequency_penalty: "high" }], ["presence penalty", { presence_penalty: 3 }],
    ["user", { user: 1 }], ["stream options", { stream_options: false }],
    ["include_usage", { stream_options: { include_usage: "yes" } }],
    ["response_format", { response_format: false }], ["tool_choice", { tool_choice: "sometimes" }],
    ["tools", { tools: [null] }], ["function", { tools: [{ type: "function", function: false }] }],
    ["strict", { tools: [{ type: "function", function: { name: "f", strict: "yes" } }] }],
    ["description", { tools: [{ type: "function", function: { name: "f", description: 1 } }] }],
    ...[1, false, "", [], "null"].map((parameters): [string, Json] => ["parameters " + JSON.stringify(parameters), {
      tools: [{ type: "function", function: { name: "f", parameters } }],
    }]),
    ["text", { messages: [{ role: "user", content: [{ type: "text", text: 1 }] }] }],
    ["image", { messages: [{ role: "user", content: [{ type: "image_url", image_url: 1 }] }] }],
    ["image detail", { messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "https://example.test", detail: 1 } }] }] }],
    ...[1, null, false, [], {}, "{"].map((argumentsValue): [string, Json] => ["arguments " + JSON.stringify(argumentsValue), {
      messages: [{ role: "assistant", tool_calls: [{ id: "a", type: "function", function: { name: "f", arguments: argumentsValue } }] }],
    }]),
  ];
  for (const [name, fields] of bad) {
    test(`bad_request: ${name}`, () => {
      try {
        toAnthropicRequest({ ...request, ...fields });
        throw new Error("accepted malformed value");
      } catch (error) {
        expect(error).toBeInstanceOf(CompleteError);
        expect(error).toMatchObject({ status: 400, code: "bad_request" });
      }
    });
  }
  for (const fields of [{ max_tokens: undefined }, { temperature: 1.5 }, { seed: 7 }, { n: 2 }, { store: true },
    { frequency_penalty: 0.5 }, { logprobs: true }, { response_format: { type: "json_object" } },
    ...["null", "[]", "1", "false", "\"\""].map((args) => ({ messages: [{ role: "assistant", tool_calls: [
      { id: "a", type: "function", function: { name: "f", arguments: args } },
    ] }] }))]) {
    test(`cannot_translate: ${JSON.stringify(fields)}`, () => {
      try {
        toAnthropicRequest({ ...request, ...fields });
        throw new Error("accepted unsupported feature");
      } catch (error) {
        expect(error).toMatchObject({ status: 400, code: "cannot_translate" });
      }
    });
  }
});
