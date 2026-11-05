import { describe, expect, test } from "bun:test";
import { assertCodexToolDefinition } from "../src/experiment-codex-catalog.js";
import { ExperimentFailure } from "../src/experiment-records.js";
import type { JsonObject } from "../src/experiment-server.js";

// Review round 104: the schema validator's `every` over a possibly-empty
// array accepted `{type: []}` and `{anyOf: []}`, so a malformed model
// schema could pass as catalog evidence. Both are now refused — each is a
// MUST in JSON Schema draft 2020-12 and each matches no instance. Repeated
// `type` entries stay accepted: the positional subset comparison a repeat
// must survive ties every element to the definition's element at that
// index, so a repeat cannot smuggle in anything. An empty `enum` also
// stays accepted — the standard asks for "at least one element" as a
// SHOULD, not a MUST, so it is not invalid schema data.

const DEFINITION = (inputSchema: JsonObject): readonly JsonObject[] => [
  { name: "lookup", description: "Find a record.", inputSchema },
];

const tool = (parameters: JsonObject): JsonObject => ({
  type: "function",
  name: "lookup",
  description: "Find a record.",
  strict: false,
  parameters,
});

const assert = (parameters: JsonObject): void => {
  assertCodexToolDefinition(tool(parameters), "lookup", DEFINITION(parameters));
};

describe("catalog schema validation (round 104)", () => {
  test("empty type and composition arrays are invalid, never catalog evidence", () => {
    for (const parameters of [{ type: [] }, { anyOf: [] }, { oneOf: [] }, { allOf: [] }]) {
      // The validator's refusal surfaces as the inventory mismatch: an
      // invalid schema cannot establish matching catalog evidence.
      expect(() => assert(parameters)).toThrow(ExperimentFailure);
    }
  });

  test("duplicate type entries stay accepted: the subset comparison ties each element to the definition", () => {
    expect(() => assert({ type: ["string", "string"] })).not.toThrow();
  });

  test("one-element and multi-element arrays pass with matching definitions", () => {
    expect(() => assert({ anyOf: [{ type: "string" }] })).not.toThrow();
    expect(() => assert({ type: ["string", "null"] })).not.toThrow();
    expect(() => assert({ type: "object", required: ["a", "b"] })).not.toThrow();
  });

  test("an empty enum stays accepted: non-emptiness there is a SHOULD", () => {
    expect(() => assert({ type: "string", enum: [] })).not.toThrow();
  });
});
