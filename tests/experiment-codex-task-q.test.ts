import { describe, expect, test } from "bun:test";
import { CodexRolloutParser } from "../src/experiment-codex-parser.js";
import type { JsonObject } from "../src/experiment-server.js";
import { codexDefinitions } from "./fixtures/experiment-codex.js";

const TIME = "2026-10-29T00:00:00Z";
const USAGE = { input_tokens: 10, cached_input_tokens: 0, output_tokens: 2 };
const NEXT_USAGE = { ...USAGE, output_tokens: 4 };

function line(type: string, payload: JsonObject): JsonObject { return { timestamp: TIME, type, payload }; }
function message(id: string): JsonObject {
  return line("response_item", { type: "message", role: "assistant", id, content: [] });
}
function response(id: string, usage: JsonObject): JsonObject {
  return line("token_usage_record", { thread_id: "thread", response_id: id, usage });
}
function count(usage: JsonObject): JsonObject {
  return line("event_msg", { type: "token_count", info: { last_token_usage: usage } });
}
function fn(name: string): JsonObject { return { type: "function", name, description: "", strict: false, parameters: { type: "object", properties: {} } }; }
function namespace(name: string, tools: JsonObject[]): JsonObject { return { type: "namespace", name, tools }; }
function catalog(tools: JsonObject[]): JsonObject { return line("response_item", { type: "additional_tools", tools }); }
function call(): JsonObject {
  return line("response_item", { type: "function_call", namespace: "mcp__experiment", name: "lookup",
    id: "function", call_id: "call", arguments: "{}" });
}
function fixture(names = ["lookup", "search"]) {
  const records: JsonObject[] = [];
  let beforeCalls = 0;
  const parser = new CodexRolloutParser("thread", "experiment", () => new Set(names),
    (kind, fields) => records.push({ kind, ...fields }), () => codexDefinitions(names), () => { beforeCalls++; });
  return { parser, records, beforeCalls: () => beforeCalls };
}
function accept(parser: CodexRolloutParser, entries: JsonObject[]): void {
  for (const entry of entries) parser.accept(entry);
}
function inventoryFailure(action: () => void): void {
  let failure: unknown;
  try { action(); } catch (error) { failure = error; }
  expect(failure).toMatchObject({ code: "inventory_mismatch" });
}

describe("Codex retries with a pending response", () => {
  test.each([false, true])("retains pending response when completed counters replay; response-known=%s", (known) => {
    const { parser, records } = fixture();
    accept(parser, [message("message-A"), response("response-A", USAGE), count(USAGE), message("message-B")]);
    if (known) parser.accept(response("response-B", NEXT_USAGE));
    parser.accept(count({ ...USAGE }));
    expect(records.filter((record) => record.kind === "turn_usage").map((record) => record.usage.output)).toEqual([2]);
    expect(records.filter((record) => record.kind === "harness_retry").map((record) => record.response_id)).toEqual(["response-A"]);
    parser.accept(message("retried-message-B"));
    if (!known) parser.accept(response("response-B", NEXT_USAGE));
    parser.accept(count(NEXT_USAGE));
    parser.finish();
    expect(records.filter((record) => record.kind === "turn_usage").map((record) => record.usage.output)).toEqual([2, 4]);
    expect(records.filter((record) => record.kind === "turn").map((record) => record.message_id))
      .toEqual(["message-A", "message-B"]);
  });

  test("does not complete pending response from a retry snapshot alone", () => {
    const { parser, records } = fixture();
    accept(parser, [message("message-A"), response("response-A", USAGE), count(USAGE),
      message("message-B"), count(USAGE)]);
    expect(() => parser.finish()).toThrow("following token_count");
    expect(records.filter((record) => record.kind === "turn_usage")).toHaveLength(1);
  });
});

describe("Codex complete native tool inventory", () => {
  test("requires native catalog before dispatching the first function call", () => {
    const { parser, records, beforeCalls } = fixture();
    inventoryFailure(() => parser.accept(call()));
    expect(parser.calls).toHaveLength(0);
    expect(beforeCalls()).toBe(0);
    expect(records.some((record) => record.kind === "harness_tool_call")).toBe(false);
  });

  test.each([
    [],
    [namespace("mcp__experiment", [fn("lookup")])],
    [namespace("clock", [fn("curr_time")])],
    [namespace("mcp__experiment", [fn("lookup"), fn("search"), fn("lookup")])],
    [namespace("mcp__experiment", [fn("lookup"), fn("search")]), fn("mcp__experiment__lookup")],
    [namespace("mcp__experiment", [fn("lookup"), fn("search")]),
      namespace("clock", [fn("curr_time"), fn("curr_time")])],
  ])("rejects empty, incomplete, or duplicate declarations: %j", (...tools) => {
    const { parser, records } = fixture();
    inventoryFailure(() => parser.accept(catalog(tools)));
    expect(records[0]).toMatchObject({ kind: "harness_tool_catalog", tools });
    expect(parser.calls).toHaveLength(0);
  });

  test("accepts exactly one declaration per experiment tool plus allowed built-ins", () => {
    const { parser, records, beforeCalls } = fixture();
    parser.accept(catalog([namespace("mcp__experiment", [fn("lookup"), fn("search")]),
      namespace("clock", [fn("curr_time")])]));
    parser.accept(call());
    parser.accept(count(USAGE));
    parser.finish();
    expect(parser.calls).toHaveLength(1);
    expect(beforeCalls()).toBe(1);
    expect(records[0]?.declarations.map((entry: JsonObject) => entry.classification))
      .toEqual(["experiment", "experiment", "builtin"]);
  });
});
