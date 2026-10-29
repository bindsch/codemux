import { describe, expect, test } from "bun:test";
import { CodexRolloutParser } from "../src/experiment-codex-parser.js";
import type { JsonObject } from "../src/experiment-server.js";

const TIME = "2026-10-29T00:00:00Z";
const USAGE = { input_tokens: 4, cached_input_tokens: 0, output_tokens: 2 };
type Entry = JsonObject & { kind: string };

function fixture(server = "experiment", names = ["lookup"]) {
  const records: Entry[] = [];
  const parser = new CodexRolloutParser("thread", server, () => new Set(names),
    (kind, fields) => records.push({ kind, ...fields }));
  return { parser, records };
}

function line(payload: JsonObject, timestamp = TIME): JsonObject {
  return { type: "response_item", payload, timestamp };
}

function catalog(tools: unknown): JsonObject {
  return line({ type: "additional_tools", id: "at_catalog", role: "developer", tools });
}

function fn(name: string): JsonObject {
  return { type: "function", name, description: "Lookup", strict: false,
    parameters: { type: "object", properties: {}, additionalProperties: false } };
}

function namespace(name: string, tools: unknown[]): JsonObject {
  return { type: "namespace", name, description: "", tools };
}

function call(callId: string, timestamp: string, extra: JsonObject = {}): JsonObject {
  return line({ type: "function_call", call_id: callId, namespace: "mcp__experiment",
    name: "lookup", arguments: "{}", ...extra }, timestamp);
}

function complete(parser: CodexRolloutParser): void {
  parser.accept({ type: "event_msg", timestamp: "2026-10-29T00:00:10Z",
    payload: { type: "token_count", info: { last_token_usage: USAGE } } });
  parser.finish();
}

function rejectsInventory(action: () => void): void {
  let failure: unknown;
  try { action(); } catch (error) { failure = error; }
  expect(failure).toMatchObject({ code: "inventory_mismatch" });
}

describe("Codex additional_tools catalogs", () => {
  test("records and accepts the built-in declarations in the captured rollout shape", () => {
    // Captured rollout c008786c-0ec2-4909-a1df-37e6b51eec44, line 3.
    const item = catalog([
      namespace("functions", [fn("list_mcp_resources"), fn("list_mcp_resource_templates"),
        fn("read_mcp_resource"), fn("request_user_input"), fn("request_user_input_async"),
        { type: "custom", name: "apply_patch", format: { type: "grammar", syntax: "lark", definition: "start: value" } }]),
      namespace("clock", [fn("curr_time"), fn("sleep")]),
      namespace("collaboration", [fn("followup_task"), fn("interrupt_agent"), fn("list_agents"),
        fn("send_message"), fn("spawn_agent"), fn("wait_agent")]),
      namespace("mcp__experiment", [fn("lookup")]),
    ]);
    const { parser, records } = fixture();
    expect(() => parser.accept(item)).not.toThrow();
    const declarations = item.payload.tools.flatMap((group: JsonObject) => group.tools.map((tool: JsonObject) => ({
      namespace: group.name, name: tool.name, type: tool.type,
      classification: group.name === "mcp__experiment" ? "experiment" : "builtin",
    })));
    expect(records).toEqual([{ kind: "harness_tool_catalog", tools: item.payload.tools, item: item.payload, declarations }]);
    expect(records[0]?.declarations.filter((tool: JsonObject) => tool.classification === "builtin")).toHaveLength(14);
    expect(records[0]?.declarations.filter((tool: JsonObject) => tool.classification === "experiment"))
      .toEqual([{ namespace: "mcp__experiment", name: "lookup", type: "function", classification: "experiment" }]);
    expect(parser.calls).toHaveLength(0);
  });

  test.each([
    [namespace("mcp__experiment", [fn("lookup")])],
    [fn("mcp__experiment__lookup")],
    [namespace("functions", [fn("mcp__experiment__lookup")])],
  ])("accepts experiment-only catalogs: %j", (...tools) => {
    const { parser, records } = fixture();
    const item = catalog(tools);
    parser.accept(item);
    parser.accept(call("call", TIME, { id: "function" }));
    complete(parser);
    const entries = records.filter((entry) => entry.kind === "harness_tool_catalog");
    expect(entries).toMatchObject([{ kind: "harness_tool_catalog", tools, item: item.payload }]);
    expect(entries[0]?.declarations).toHaveLength(1);
    expect(entries[0]?.declarations[0]?.classification).toBe("experiment");
  });

  test.each([
    [fn("exec")],
    [fn("tool_search")],
    [namespace("mcp__other", [fn("lookup")])],
    [namespace("mcp__experiment", [fn("lookup"), fn("foreign")])],
    [namespace("functions", [fn("lookup")])],
    [{ type: "custom", name: "mcp__experiment__lookup" }],
    [{ type: "web_search" }],
    [{ type: "namespace", name: "mcp__experiment", tools: "invalid" }],
    [null],
  ])("rejects foreign or unrecognized declarations: %j", (...tools) => {
    const { parser, records } = fixture();
    rejectsInventory(() => parser.accept(catalog(tools)));
    expect(records[0]).toMatchObject({ kind: "harness_tool_catalog", tools });
  });

  test.each([undefined, null, {}, "invalid"])("rejects a malformed tools array: %j", (tools) => {
    const { parser, records } = fixture();
    rejectsInventory(() => parser.accept(catalog(tools)));
    expect(records[0]?.kind).toBe("harness_tool_catalog");
  });

  test("checks later catalog additions after an allowed catalog", () => {
    const { parser, records } = fixture();
    parser.accept(catalog([namespace("mcp__experiment", [fn("lookup")])]));
    rejectsInventory(() => parser.accept(catalog([namespace("functions", [fn("exec")])])));
    expect(records.filter((entry) => entry.kind === "harness_tool_catalog")).toHaveLength(2);
  });

  test("preserves the existing prefix and sanitizer rules in catalogs", () => {
    const { parser, records } = fixture("mcp__qa-dev", ["look-up"]);
    parser.accept(catalog([namespace("mcp__qa_dev", [fn("look_up")])]));
    expect(records[0]?.kind).toBe("harness_tool_catalog");
  });
});

describe("Codex deferred turn call timestamps", () => {
  test("keeps every call time when a later assistant message supplies the native turn ID", () => {
    const { parser, records } = fixture();
    parser.accept(catalog([namespace("mcp__experiment", [fn("lookup")])]));
    parser.accept(call("first", "2026-10-29T00:00:01Z"));
    parser.accept(call("second", "2026-10-29T00:00:04Z"));
    expect(records.filter((entry) => entry.kind === "turn_call")).toHaveLength(0);
    parser.accept(line({ type: "message", role: "assistant", id: "message", content: [] }, "2026-10-29T00:00:09Z"));
    parser.accept(call("third", "2026-10-29T00:00:09.500Z"));
    complete(parser);
    expect(records.filter((entry) => entry.kind === "turn_call")).toEqual([
      { kind: "turn_call", message_id: "message", call_id: "first", name: "lookup", t: Date.parse("2026-10-29T00:00:01Z") / 1000 },
      { kind: "turn_call", message_id: "message", call_id: "second", name: "lookup", t: Date.parse("2026-10-29T00:00:04Z") / 1000 },
      { kind: "turn_call", message_id: "message", call_id: "third", name: "lookup", t: Date.parse("2026-10-29T00:00:09.500Z") / 1000 },
    ]);
  });
});
