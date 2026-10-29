import { describe, expect, test } from "bun:test";
import { CodexRolloutParser } from "../src/experiment-codex-parser.js";
import { ExperimentInventory } from "../src/experiment-inventory.js";
import type { JsonObject } from "../src/experiment-server.js";

const TIME = "2026-10-29T00:00:00Z";
const USAGE = { input_tokens: 10, cached_input_tokens: 0, output_tokens: 2, total_tokens: 12 };
const TOTALS = { ...USAGE, input_tokens: 20, output_tokens: 4, total_tokens: 24 };
const TOOL = { name: "lookup", description: "Find a record.", inputSchema: {
  type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false,
} };
function line(type: string, payload: JsonObject): JsonObject { return { timestamp: TIME, type, payload }; }
function message(id: string): JsonObject {
  return line("response_item", { type: "message", role: "assistant", id, content: [] });
}
function response(id: string, usage: JsonObject = USAGE): JsonObject {
  return line("token_usage_record", { thread_id: "thread", response_id: id, usage });
}
function count(total: JsonObject = USAGE, usage: JsonObject = USAGE): JsonObject {
  return line("event_msg", { type: "token_count", info: { last_token_usage: usage, total_token_usage: total } });
}
function declaration(extra: JsonObject = {}): JsonObject {
  return { type: "function", name: "lookup", description: TOOL.description, strict: false,
    parameters: structuredClone(TOOL.inputSchema), ...extra };
}
function catalog(tool = declaration(), namespace: string | null = "mcp__experiment"): JsonObject {
  return line("response_item", { type: "additional_tools", tools: namespace
    ? [{ type: "namespace", name: namespace, tools: [tool] }] : [tool] });
}
function fixture(definitions: readonly JsonObject[] | undefined = [TOOL]) {
  const records: JsonObject[] = [];
  const parser = new CodexRolloutParser("thread", "experiment", () => new Set(["lookup"]),
    (kind, fields) => records.push({ kind, ...fields }), () => definitions);
  return { parser, records };
}
function accept(parser: CodexRolloutParser, entries: JsonObject[]): void {
  for (const entry of entries) parser.accept(entry);
}
function inventoryFailure(parser: CodexRolloutParser, item: JsonObject): void {
  expect(() => parser.accept(item)).toThrow(expect.objectContaining({ code: "inventory_mismatch" }));
}

describe("Codex equal usage counters identify responses", () => {
  test.each([false, true])("completes a distinct response with equal counters; totals=%s", (totals) => {
    const { parser, records } = fixture();
    accept(parser, [message("A"), response("response-A"), count(), message("B"), response("response-B"),
      count(totals ? TOTALS : USAGE)]);
    expect(() => parser.finish()).not.toThrow();
    expect(records.filter((record) => record.kind === "turn_usage").map((record) => record.usage.output)).toEqual([2, 2]);
    expect(records.filter((record) => record.kind === "harness_retry")).toHaveLength(0);
  });

  test("advanced cumulative totals complete equal counters before a response identity is available", () => {
    const { parser, records } = fixture();
    accept(parser, [message("A"), response("response-A"), count(), message("B"), count(TOTALS)]);
    expect(() => parser.finish()).not.toThrow();
    expect(records.filter((record) => record.kind === "turn_usage")).toHaveLength(2);
    expect(records.filter((record) => record.kind === "harness_retry")).toHaveLength(0);
  });

  test.each([false, true])("preserves a waiting response across an unchanged snapshot; response-known=%s", (known) => {
    const { parser, records } = fixture();
    const next = { ...USAGE, output_tokens: 4, total_tokens: 14 };
    accept(parser, [message("A"), response("response-A"), count(), message("B")]);
    if (known) parser.accept(response("response-B", next));
    parser.accept(count());
    expect(records.filter((record) => record.kind === "harness_retry")).toMatchObject([{ response_id: "response-A" }]);
    expect(records.filter((record) => record.kind === "turn_usage")).toHaveLength(1);
    expect(() => parser.finish()).toThrow("following token_count");
    if (!known) parser.accept(response("response-B", next));
    parser.accept(count({ ...TOTALS, output_tokens: 6, total_tokens: 26 }, next));
    expect(() => parser.finish()).not.toThrow();
    expect(records.filter((record) => record.kind === "turn_usage").map((record) => record.usage.output)).toEqual([2, 4]);
  });

  test("does not classify advanced cumulative totals without a pending turn as a retry", () => {
    const { parser, records } = fixture();
    accept(parser, [message("A"), response("response-A"), count()]);
    expect(() => parser.accept(count(TOTALS))).toThrow(expect.objectContaining({ code: "harness_log_missing" }));
    expect(records.filter((record) => record.kind === "harness_retry")).toHaveLength(0);
  });

  test.each([
    { ...USAGE, total_tokens: 11 },
    { ...TOTALS, output_tokens: 1 },
    {},
  ])("does not complete equal counters from conflicting cumulative totals: %j", (totals) => {
    const { parser, records } = fixture();
    accept(parser, [message("A"), response("response-A"), count(), message("B")]);
    expect(() => parser.accept(count(totals))).toThrow(expect.objectContaining({ code: "harness_log_missing" }));
    expect(records.filter((record) => record.kind === "turn_usage")).toHaveLength(1);
    expect(records.filter((record) => record.kind === "harness_retry")).toHaveLength(0);
  });
});

describe("Codex model-facing experiment definitions", () => {
  test.each([
    { description: "Changed description." },
    { description: undefined },
    { parameters: { ...TOOL.inputSchema, properties: { query: { type: "integer" } } } },
    { parameters: { ...TOOL.inputSchema, required: [] } },
    { parameters: { ...TOOL.inputSchema, additionalProperties: true } },
    { parameters: undefined },
  ])("rejects changed descriptions or schemas: %j", (change) => {
    const { parser, records } = fixture();
    inventoryFailure(parser, catalog(declaration(change)));
    expect(records[0]).toMatchObject({ kind: "harness_tool_catalog", item: { type: "additional_tools" } });
    expect(parser.calls).toHaveLength(0);
  });

  test.each([undefined, [], [{ ...TOOL, name: "another" }]].map((definitions) => ({ definitions })))
    ("rejects missing validated definitions: %j", ({ definitions }) => {
    const missing = new CodexRolloutParser("thread", "experiment", () => new Set(["lookup"]), () => {}, () => definitions);
    inventoryFailure(missing, catalog());
    expect(missing.calls).toHaveLength(0);
  });

  test.each(["mcp__experiment", "functions", null])("accepts matching metadata in supported declaration form %s", (namespace) => {
    const { parser } = fixture();
    const tool = declaration({ name: namespace === "mcp__experiment" ? "lookup" : "mcp__experiment__lookup" });
    expect(() => parser.accept(catalog(tool, namespace))).not.toThrow();
  });

  test("compares against the relay's validated inventory rather than a changed model declaration", async () => {
    const inventory = new ExperimentInventory("experiment", async () => { throw new Error("unexpected page"); },
      () => {}, (error) => { throw error; }, () => true);
    const reply = { result: { tools: [structuredClone(TOOL)] } };
    await inventory.accept(reply, null);
    const { parser } = fixture(inventory.definitions);
    inventoryFailure(parser, catalog(declaration({ description: "Changed model definition." })));
    expect(reply.result.tools).toEqual([TOOL]);
  });

  test("checks definitions on later catalogs as well", () => {
    const { parser } = fixture();
    parser.accept(catalog());
    inventoryFailure(parser, catalog(declaration({ parameters: { type: "object", properties: {} } })));
  });

  test("renders absent descriptions and missing schema properties as Codex does", () => {
    const { parser } = fixture([{ name: "lookup", inputSchema: { type: "object" } }]);
    expect(() => parser.accept(catalog(declaration({ description: "", parameters: { type: "object", properties: {} } })))).not.toThrow();
  });

  test("renders supported nested schema lowering without mutating relay definitions", () => {
    const definition = { name: "lookup", description: "", inputSchema: { type: "object", properties: {
      mode: { const: "exact", title: "Dropped by Codex" },
      entries: { type: ["array", "null"] },
      flag: true,
      loose: { description: "No schema hints" },
      nested: { type: "object" },
    } } };
    const saved = structuredClone(definition);
    const { parser } = fixture([definition]);
    const parameters = { type: "object", properties: {
      mode: { type: "string", enum: ["exact"] }, entries: { type: ["array", "null"], items: { type: "string" } },
      flag: { type: "string" }, loose: {}, nested: { type: "object", properties: {} },
    } };
    expect(() => parser.accept(catalog(declaration({ description: "", parameters })))).not.toThrow();
    expect(definition).toEqual(saved);
  });

  test("preserves reachable local definitions and drops unused definitions", () => {
    const definition = { name: "lookup", description: "", inputSchema: { type: "object", properties: {
      query: { $ref: "#/$defs/Query" },
    }, $defs: { Query: { type: "object", properties: { value: { $ref: "#/definitions/Text" } } },
      Unused: { type: "integer" } }, definitions: { Text: { type: "string" }, Unused: { type: "boolean" } } } };
    const { parser } = fixture([definition]);
    const parameters = { type: "object", properties: { query: { $ref: "#/$defs/Query" } },
      $defs: { Query: { type: "object", properties: { value: { $ref: "#/definitions/Text" } } } },
      definitions: { Text: { type: "string" } } };
    expect(() => parser.accept(catalog(declaration({ description: "", parameters })))).not.toThrow();
    inventoryFailure(parser, catalog(declaration({ description: "", parameters: {
      ...parameters, definitions: { Text: { type: "integer" } },
    } })));
  });

  test("uses Codex's default schema budget to remove long nested descriptions", () => {
    const definition = { ...TOOL, inputSchema: { type: "object", properties: {
      query: { type: "string", description: "x".repeat(6000) },
    } } };
    const { parser } = fixture([definition]);
    const parameters = { type: "object", properties: { query: { type: "string" } } };
    expect(() => parser.accept(catalog(declaration({ parameters })))).not.toThrow();
    inventoryFailure(parser, catalog(declaration({ parameters: { type: "object", properties: { query: { type: "integer" } } } })));
  });

  test.each([
    { enum: "invalid" }, { minItems: -1 }, { minItems: 1.5 }, { required: [42] },
    { description: 42 }, { encrypted: "true" }, { $ref: 42 },
  ])("rejects schemas that Codex cannot deserialize even when the model declaration matches: %j", (invalid) => {
    const parameters = { type: "object", properties: {}, ...invalid };
    const { parser } = fixture([{ ...TOOL, inputSchema: parameters }]);
    inventoryFailure(parser, catalog(declaration({ parameters })));
  });

  test("preserves repeated valid types while removing unrecognized type names", () => {
    const { parser } = fixture([{ ...TOOL, inputSchema: { type: "object", properties: {
      query: { type: ["string", "invalid", "string"] },
    } } }]);
    expect(() => parser.accept(catalog(declaration({ parameters: { type: "object", properties: {
      query: { type: ["string", "string"] },
    } } })))).not.toThrow();
  });
});
