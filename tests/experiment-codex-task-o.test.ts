import { describe, expect, test } from "bun:test";
import { CodexRolloutParser } from "../src/experiment-codex-parser.js";
import type { JsonObject } from "../src/experiment-server.js";
import { codexDefinitions } from "./fixtures/experiment-codex.js";

const TIME = "2026-10-29T00:00:00Z";
const USAGE = { input_tokens: 4, cached_input_tokens: 1, output_tokens: 2 };
const BUILTINS = [
  ["functions", "function", "list_mcp_resources"],
  ["functions", "function", "list_mcp_resource_templates"],
  ["functions", "function", "read_mcp_resource"],
  ["functions", "function", "request_user_input"],
  ["functions", "function", "request_user_input_async"],
  ["functions", "custom", "apply_patch"],
  ["clock", "function", "curr_time"],
  ["clock", "function", "sleep"],
  ["collaboration", "function", "followup_task"],
  ["collaboration", "function", "interrupt_agent"],
  ["collaboration", "function", "list_agents"],
  ["collaboration", "function", "send_message"],
  ["collaboration", "function", "spawn_agent"],
  ["collaboration", "function", "wait_agent"],
] as const;

function line(type: string, payload: JsonObject): JsonObject { return { timestamp: TIME, type, payload }; }
function message(id: string): JsonObject {
  return line("response_item", { type: "message", role: "assistant", id, content: [] });
}
function response(id: string, usage = USAGE): JsonObject {
  return line("token_usage_record", { thread_id: "thread", response_id: id, usage });
}
function count(usage = USAGE): JsonObject {
  return line("event_msg", { type: "token_count", info: { last_token_usage: usage } });
}
function fixture() {
  const records: JsonObject[] = [];
  const parser = new CodexRolloutParser("thread", "experiment", () => new Set(["lookup"]),
    (kind, fields) => records.push({ kind, ...fields }), () => codexDefinitions(["lookup"]));
  return { parser, records };
}
function rejectsUsage(entries: JsonObject[]): void {
  const { parser } = fixture();
  let failure: unknown;
  try { for (const entry of entries) parser.accept(entry); parser.finish(); }
  catch (error) { failure = error; }
  expect(failure).toMatchObject({ code: "harness_log_missing" });
}

describe("Codex observed built-in catalog declarations", () => {
  test.each(BUILTINS)("accepts declaration but rejects call of %s.%s:%s", (namespace, type, name) => {
    const { parser, records } = fixture();
    const payload = { type: "additional_tools", tools: [{ type: "namespace", name: namespace,
      tools: [{ type, name }] }, { type: "namespace", name: "mcp__experiment", tools: [{ type: "function", name: "lookup",
        description: "", parameters: { type: "object", properties: {} } }] }] };
    expect(() => parser.accept(line("response_item", payload))).not.toThrow();
    expect(records).toEqual([{ kind: "harness_tool_catalog", tools: payload.tools, item: payload,
      declarations: [{ namespace, type, name, classification: "builtin" },
        { namespace: "mcp__experiment", type: "function", name: "lookup", classification: "experiment" }] }]);
    let failure: unknown;
    try { parser.accept(line("response_item", { type: type === "custom" ? "custom_tool_call" : "function_call",
      namespace, name, id: "function", call_id: "call", arguments: "{}", input: "patch" })); }
    catch (error) { failure = error; }
    expect(failure).toMatchObject({ code: "unknown_tool" });
    expect(records.at(-1)).toMatchObject({ kind: "tool_call", namespace, name, allowed: false });
    expect(parser.calls).toHaveLength(0);
  });

  test.each([
    ["functions", "function", "update_plan"], ["clock", "function", "foreign"],
    ["collaboration", "function", "foreign"], ["foreign", "function", "curr_time"],
    ["functions", "function", "apply_patch"], ["functions", "custom", "read_mcp_resource"],
  ])("rejects declarations beyond the exact observed set: %s.%s:%s", (namespace, type, name) => {
    const { parser, records } = fixture();
    let failure: unknown;
    try { parser.accept(line("response_item", { type: "additional_tools", tools: [
      { type: "namespace", name: namespace, tools: [{ type, name }] },
    ] })); } catch (error) { failure = error; }
    expect(failure).toMatchObject({ code: "inventory_mismatch" });
    expect(records[0]?.kind).toBe("harness_tool_catalog");
    expect(records[0]?.declarations).toEqual([{ namespace, type, name, classification: "foreign" }]);
  });
});

describe("Codex response usage identity", () => {
  test.each([false, true])("rejects overlapping distinct responses; message-first=%s", (messageFirst) => {
    rejectsUsage([...(messageFirst ? [message("message")] : []), response("response-A"),
      response("response-B"), ...(!messageFirst ? [message("message")] : []), count()]);
  });

  test.each([false, true])("rejects repeated response identity before completion; conflicting=%s", (conflicting) => {
    rejectsUsage([message("message"), response("response"),
      response("response", conflicting ? { ...USAGE, output_tokens: 9 } : USAGE), count()]);
  });

  test.each([false, true])("rejects repeated completed response identity; conflicting=%s", (conflicting) => {
    rejectsUsage([message("message"), response("response"), count(),
      response("response", conflicting ? { ...USAGE, output_tokens: 9 } : USAGE), count()]);
  });

  test("rejects conflicting second token_count usage", () => {
    rejectsUsage([message("message"), response("response"), count(),
      count({ ...USAGE, output_tokens: 9 })]);
  });

  test("rejects token_count counters that conflict with its response record", () => {
    rejectsUsage([message("message"), response("response"), count({ ...USAGE, output_tokens: 9 })]);
  });

  test("keeps distinct well-formed responses as separate turns", () => {
    const { parser, records } = fixture();
    const nextUsage = { ...USAGE, output_tokens: 9 };
    for (const entry of [response("response-A"), message("message-A"), count(),
      message("message-B"), response("response-B", nextUsage), count(nextUsage)]) parser.accept(entry);
    parser.finish();
    expect(records.filter((record) => record.kind === "turn").map((record) => record.message_id))
      .toEqual(["message-A", "message-B"]);
    expect(records.filter((record) => record.kind === "turn_usage").map((record) => record.usage.output))
      .toEqual([2, 9]);
  });

  test("ignores rate-limit-only token_count events without usage", () => {
    const { parser, records } = fixture();
    const limits = line("event_msg", { type: "token_count", info: null, rate_limits: { limit_id: "codex" } });
    for (const entry of [limits, message("message"), response("response"), count(), limits]) parser.accept(entry);
    parser.finish();
    expect(records.filter((record) => record.kind === "turn_usage")).toHaveLength(1);
  });
});
