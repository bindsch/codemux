import { isDeepStrictEqual } from "node:util";
import { object } from "./experiment-codex-content.js";
import { ExperimentFailure, ExperimentFailureCode as Code } from "./experiment-records.js";
import type { JsonObject } from "./experiment-server.js";

const SCHEMA_TYPES = new Set(["string", "number", "boolean", "integer", "object", "array", "null"]);
const DEFINITION_KEYS = ["$defs", "definitions"];
const COMPOSITION_KEYS = ["anyOf", "oneOf", "allOf"];

export const CODEX_EXPERIMENT_CATALOG_REMOVED = [
  "tool_mode", "experimental_supported_tools.clock", "multi_agent_version", "apply_patch_tool_type",
] as const;

/** Remove model metadata that registers native tools in experiment runs. */
export function codexExperimentCatalogEntry(value: unknown): unknown {
  const entry = object(value);
  if (!entry) return value;
  const rewritten = { ...entry };
  delete rewritten.tool_mode;
  delete rewritten.multi_agent_version;
  if (Array.isArray(rewritten.experimental_supported_tools)) {
    rewritten.experimental_supported_tools = rewritten.experimental_supported_tools.filter((tool) => tool !== "clock");
  }
  rewritten.apply_patch_tool_type = null;
  return rewritten;
}

/** Retained schema values must match the relay. Codex may remove keys or array suffixes. */
export function assertCodexToolDefinition(tool: JsonObject, name: string, definitions: readonly JsonObject[] | undefined): string[] {
  const definition = definitions?.find((definition) => definition.name === name);
  const original = object(definition?.inputSchema);
  const parameters = object(tool.parameters);
  const pruned: string[] = [];
  let validSchema = false;
  try { validateSchema(parameters); validSchema = true; }
  catch { /* Invalid model schemas cannot establish matching catalog evidence. */ }
  // rust-v0.165.0 tools/src/responses_api.rs:164-172 renders MCP tools with strict: false.
  if (!definition || !original || !parameters || !validSchema || tool.strict !== false ||
      typeof tool.description !== "string" || tool.description !== (definition.description ?? "") ||
      !schemaSubset(parameters, original, "", pruned)) {
    throw new ExperimentFailure(Code.InventoryMismatch,
      `Codex additional_tools changed the description, strict field, or parameter schema for experiment tool ${name}`);
  }
  return pruned;
}

/** Validate schema fields without interpreting instance data or rewriting
 * the schema. The rules are the JSON Schema validation vocabulary's own
 * (draft 2020-12), held to what the subset comparison below needs as
 * evidence: an empty `type` array and an empty composition array
 * (`anyOf`, `oneOf`, `allOf`) are invalid — each is a MUST, and each
 * matches no instance, so neither can establish that the model retained
 * the tool's shape (review round 104: a vacuous `every` over an empty
 * array used to accept both). Repeated `type` or `required` entries stay
 * accepted: `type` uniqueness is a MUST in the standard, but the
 * positional subset comparison a repeat must survive already ties every
 * element to the definition's element at that index, so a repeat cannot
 * smuggle in anything (pinned by the repeated-types regression test);
 * `required` has no uniqueness rule at all. An empty `enum` stays
 * accepted: the standard asks for "at least one element" as a SHOULD,
 * not a MUST, so it is not invalid schema data. */
function validateSchema(value: unknown): void {
  const schema = object(value);
  if (!schema) throw new Error("Invalid MCP schema node");
  for (const [key, field] of Object.entries(schema)) {
    if (key === "type" && (!(Array.isArray(field) ? field : [field]).every((type) => SCHEMA_TYPES.has(type)) ||
        (Array.isArray(field) && field.length === 0))) {
      throw new Error("Invalid MCP schema type");
    }
    if (((key === "$ref" || key === "description") && typeof field !== "string") ||
        (key === "encrypted" && typeof field !== "boolean") || (key === "enum" && !Array.isArray(field)) ||
        (key === "required" && (!Array.isArray(field) || field.some((entry: unknown) => typeof entry !== "string"))) ||
        (key === "minItems" && (!Number.isSafeInteger(field) || field < 0))) {
      throw new Error(`Invalid MCP schema ${key}`);
    }
    if (["properties", ...DEFINITION_KEYS].includes(key)) {
      const table = object(field);
      if (!table) throw new Error(`Invalid MCP schema ${key}`);
      for (const child of Object.values(table)) validateSchema(child);
    } else if (COMPOSITION_KEYS.includes(key)) {
      // Non-empty is a MUST ("MUST be a non-empty array"), like the shape.
      if (!Array.isArray(field) || field.length === 0) throw new Error(`Invalid MCP schema ${key}`);
      for (const child of field) validateSchema(child);
    } else if (key === "items" || (key === "additionalProperties" && typeof field !== "boolean")) {
      validateSchema(field);
    }
  }
}

function schemaSubset(catalog: unknown, original: unknown, path: string, pruned: string[]): boolean {
  if (Array.isArray(catalog)) {
    if (!Array.isArray(original) || catalog.length > original.length) return false;
    for (let index = 0; index < original.length; index++) {
      const childPath = `${path}/${index}`;
      if (index >= catalog.length) pruned.push(childPath);
      else if (!schemaSubset(catalog[index], original[index], childPath, pruned)) return false;
    }
    return true;
  }
  const catalogObject = object(catalog);
  if (!catalogObject) return isDeepStrictEqual(catalog, original);
  const originalObject = object(original);
  if (!originalObject || Object.keys(catalogObject).some((key) => !Object.hasOwn(originalObject, key))) return false;
  for (const [key, value] of Object.entries(originalObject)) {
    const childPath = `${path}/${key.replace(/~/g, "~0").replace(/\//g, "~1")}`;
    if (!Object.hasOwn(catalogObject, key)) pruned.push(childPath);
    else if (!schemaSubset(catalogObject[key], value, childPath, pruned)) return false;
  }
  return true;
}
