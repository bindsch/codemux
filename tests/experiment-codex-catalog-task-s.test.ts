import { describe, expect, test } from "bun:test";
import { CodexRolloutParser } from "../src/experiment-codex-parser.js";
import type { JsonObject } from "../src/experiment-server.js";

function fixture(inputSchema: JsonObject) {
  const records: JsonObject[] = [];
  const parser = new CodexRolloutParser("thread", "experiment", () => new Set(["lookup"]),
    (kind, fields) => records.push({ kind, ...fields }),
    () => [{ name: "lookup", description: "Find a record.", inputSchema }]);
  const accept = (parameters: unknown = inputSchema, extra: JsonObject = {}) => parser.accept({
    timestamp: "2026-10-29T00:00:00Z", type: "response_item", payload: {
      type: "additional_tools", tools: [{ type: "namespace", name: "mcp__experiment", tools: [{
        type: "function", name: "lookup", description: "Find a record.", strict: false, parameters, ...extra,
      }] }],
    },
  });
  return { accept, records };
}

describe("Codex catalog subsets", () => {
  test("retains definitions referenced inside enum instance values", () => {
    const schema = { type: "object", properties: { query: { $ref: "#/$defs/Query" } }, $defs: {
      Query: { type: "string", enum: [{ $ref: "#/$defs/Other", type: "instance data" }] },
      Other: { type: "integer" },
    } };
    const { accept, records } = fixture(schema);
    expect(() => accept()).not.toThrow();
    expect(records[0]!.declarations[0].catalog_pruned_paths).toEqual([]);
  });

  test("retains a definition after Codex removes the not keyword containing its reference", () => {
    const schema = { type: "object", properties: { query: { $ref: "#/$defs/Query" } }, $defs: {
      Query: { type: "string", not: { $ref: "#/$defs/Other" } }, Other: { type: "integer" },
    } };
    const { accept, records } = fixture(schema);
    expect(() => accept({ ...schema, $defs: { Query: { type: "string" }, Other: schema.$defs.Other } })).not.toThrow();
    expect(records[0]!.declarations[0].catalog_pruned_paths).toEqual(["/$defs/Query/not"]);
  });

  test("does not use JavaScript float serialization to predict Codex's schema budget", () => {
    const schema = { type: "object", properties: { query: { type: "number", enum: [0.000001], description: "" } } };
    schema.properties.query.description = "x".repeat(5001 - Buffer.byteLength(JSON.stringify(schema)));
    expect(Buffer.byteLength(JSON.stringify(schema))).toBe(5001);
    expect(Buffer.byteLength(JSON.stringify(schema).replace("0.000001", "1e-6"))).toBe(4997);
    const { accept } = fixture(schema);
    expect(() => accept()).not.toThrow();
  });

  test("records nested removals and array suffix removals with escaped JSON Pointer paths", () => {
    const schema = { type: "object", title: "Original", properties: {
      "a/b~c": { type: "string", description: "Original", enum: [{ label: "keep", removed: true }, "tail"] },
    }, required: ["a/b~c", "tail"] };
    const saved = structuredClone(schema);
    const { accept, records } = fixture(schema);
    expect(() => accept({ type: "object", properties: { "a/b~c": { type: "string", enum: [{ label: "keep" }] } },
      required: ["a/b~c"] })).not.toThrow();
    expect(records[0]!.declarations[0].catalog_pruned_paths).toEqual([
      "/title", "/properties/a~1b~0c/description", "/properties/a~1b~0c/enum/0/removed",
      "/properties/a~1b~0c/enum/1", "/required/1",
    ]);
    expect(schema).toEqual(saved);
  });

  test.each<JsonObject>([
    { type: "object", properties: {}, added: true },
    { type: "object", properties: { added: { type: "string" } } },
    { type: "object", properties: {}, required: ["query", "added"] },
    { type: "object", properties: {}, constructor: {} },
  ])("rejects added schema keys or indices: %j", (parameters) => {
    const { accept } = fixture({ type: "object", properties: {}, required: ["query"] });
    expect(() => accept(parameters)).toThrow(expect.objectContaining({ code: "inventory_mismatch" }));
  });

  test.each([
    { type: "array", properties: {} },
    { type: "object", properties: {}, required: ["other"] },
    { type: "object", properties: {}, required: {} },
    { type: "object", properties: { query: { type: "integer" } } },
  ])("rejects changed values or container types: %j", (parameters) => {
    const { accept } = fixture({ type: "object", properties: { query: { type: "string" } }, required: ["query"] });
    expect(() => accept(parameters)).toThrow(expect.objectContaining({ code: "inventory_mismatch" }));
  });

  test.each([true, undefined, null])("requires the rendered strict false field, got %j", (strict) => {
    const { accept } = fixture({ type: "object", properties: {} });
    expect(() => accept(undefined, { strict })).toThrow(expect.objectContaining({ code: "inventory_mismatch" }));
  });

  test.each(["invalid", ["invalid"], ["string", "invalid"], 42].map((type) => ({ type })))
    ("validates type beside a reference: %j", ({ type }) => {
    const schema = { type: "object", properties: { query: { $ref: "#/$defs/Query", type } },
      $defs: { Query: { type: "string" } } };
    const { accept } = fixture(schema);
    expect(() => accept()).toThrow(expect.objectContaining({ code: "inventory_mismatch" }));
  });
});
