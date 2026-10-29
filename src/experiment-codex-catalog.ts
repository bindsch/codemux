import { isDeepStrictEqual } from "node:util";
import { object } from "./experiment-codex-content.js";
import { ExperimentFailure, ExperimentFailureCode as Code } from "./experiment-records.js";
import type { JsonObject } from "./experiment-server.js";

const SCHEMA_TYPES = new Set(["string", "number", "boolean", "integer", "object", "array", "null"]);
const DEFINITION_KEYS = ["$defs", "definitions"];
const COMPOSITION_KEYS = ["anyOf", "oneOf", "allOf"];
const SCHEMA_FIELDS = ["$ref", "type", "description", "encrypted", "enum", "items", "minItems", "properties",
  "required", "additionalProperties", ...COMPOSITION_KEYS, ...DEFINITION_KEYS];
const SCHEMA_BUDGET_BYTES = 5_000;
const MAX_COMPACT_SCHEMA_DEPTH = 3;

/** Compare the model declaration with the relay definition rendered by Codex. */
export function assertCodexToolDefinition(tool: JsonObject, name: string, definitions: readonly JsonObject[] | undefined): void {
  const definition = definitions?.find((definition) => definition.name === name);
  let parameters: JsonObject | undefined;
  try { parameters = renderParameters(definition?.inputSchema); }
  catch { /* Unsupported relay schemas cannot establish matching model evidence. */ }
  if (!definition || !parameters || typeof tool.description !== "string" || tool.description !== (definition.description ?? "") ||
      !isDeepStrictEqual(tool.parameters, parameters)) {
    throw new ExperimentFailure(Code.InventoryMismatch,
      `Codex additional_tools changed the description or parameter schema for experiment tool ${name}`);
  }
}

// Codex rust-v0.165.0: tools/src/mcp_tool.rs and tools/src/json_schema{,/types,/compaction}.rs.
function renderParameters(input: unknown): JsonObject | undefined {
  const original = object(input);
  if (!original) return undefined;
  const schema = structuredClone(original);
  if (schema.properties == null) schema.properties = {};
  sanitizeSchema(schema);
  pruneDefinitions(schema);
  for (const pass of [stripDescriptions, dropDefinitions,
    (schema: JsonObject) => collapseDeepSchemas(schema, 0), pruneCompositions]) {
    if (Buffer.byteLength(JSON.stringify(projectSchema(schema))) <= SCHEMA_BUDGET_BYTES) break;
    pass(schema);
  }
  const result = projectSchema(schema);
  return result.type === "null" ? undefined : result;
}

function sanitizeSchema(value: unknown): unknown {
  if (typeof value === "boolean") return { type: "string" };
  if (Array.isArray(value)) return value.map(sanitizeSchema);
  const schema = object(value);
  if (!schema) return value;
  for (const [key, child] of Object.entries(object(schema.properties) ?? {})) schema.properties[key] = sanitizeSchema(child);
  for (const key of ["items", "prefixItems", ...COMPOSITION_KEYS]) {
    if (key in schema) schema[key] = sanitizeSchema(schema[key]);
  }
  if ("additionalProperties" in schema && typeof schema.additionalProperties !== "boolean") {
    schema.additionalProperties = sanitizeSchema(schema.additionalProperties);
  }
  for (const key of DEFINITION_KEYS) {
    const definitions = object(schema[key]);
    if (definitions) schema[key] = Object.fromEntries(Object.entries(definitions).map(([name, child]) => [name, sanitizeSchema(child)]));
    else delete schema[key];
  }
  if ("const" in schema) { schema.enum = [schema.const]; delete schema.const; }
  let types = (Array.isArray(schema.type) ? schema.type : [schema.type]).filter((type: unknown) => SCHEMA_TYPES.has(type as string));
  if (!types.length && ("$ref" in schema || COMPOSITION_KEYS.some((key) => key in schema))) return schema;
  if (!types.length) {
    if (["properties", "required", "additionalProperties"].some((key) => key in schema)) types = ["object"];
    else if (["items", "prefixItems"].some((key) => key in schema)) types = ["array"];
    else if (["enum", "format"].some((key) => key in schema)) types = ["string"];
    else if (["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf"].some((key) => key in schema)) types = ["number"];
    else { for (const key of Object.keys(schema)) delete schema[key]; return schema; }
  }
  schema.type = types.length === 1 ? types[0] : types;
  if (types.includes("object") && !("properties" in schema)) schema.properties = {};
  if (types.includes("array") && !("items" in schema)) schema.items = { type: "string" };
  return schema;
}

/** Serialize only the fields in Codex's JsonSchema type. Instance enum values stay unchanged. */
function projectSchema(value: unknown): JsonObject {
  const schema = object(value);
  if (!schema) throw new Error("Invalid MCP schema node");
  const result: JsonObject = {};
  for (const key of SCHEMA_FIELDS) {
    const field = schema[key];
    if (field == null) continue;
    if (((key === "$ref" || key === "description") && typeof field !== "string") ||
        (key === "encrypted" && typeof field !== "boolean") || (key === "enum" && !Array.isArray(field)) ||
        (key === "required" && (!Array.isArray(field) || field.some((entry: unknown) => typeof entry !== "string"))) ||
        (key === "minItems" && (!Number.isSafeInteger(field) || field < 0))) {
      throw new Error(`Invalid MCP schema ${key}`);
    }
    if (["properties", ...DEFINITION_KEYS].includes(key)) {
      const table = object(field);
      if (!table) throw new Error(`Invalid MCP schema ${key}`);
      result[key] = Object.fromEntries(Object.entries(table).map(([name, child]) => [name, projectSchema(child)]));
    } else if (COMPOSITION_KEYS.includes(key)) {
      if (!Array.isArray(field)) throw new Error(`Invalid MCP schema ${key}`);
      result[key] = field.map(projectSchema);
    } else if (key === "items" || (key === "additionalProperties" && typeof field !== "boolean")) {
      result[key] = projectSchema(field);
    } else result[key] = field;
  }
  return result;
}

function children(schema: JsonObject, definitions = false): JsonObject[] {
  const values: unknown[] = Object.values(object(schema.properties) ?? {});
  for (const key of ["items", ...COMPOSITION_KEYS]) {
    if (Array.isArray(schema[key])) values.push(...schema[key]);
    else if (schema[key] !== undefined) values.push(schema[key]);
  }
  if (typeof schema.additionalProperties !== "boolean") values.push(schema.additionalProperties);
  if (definitions) for (const key of DEFINITION_KEYS) values.push(...Object.values(object(schema[key]) ?? {}));
  return values.map(object).filter((value): value is JsonObject => value !== undefined);
}

function localDefinition(ref: unknown): [string, string] | undefined {
  if (typeof ref !== "string" || !ref.startsWith("#")) return undefined;
  try {
    const pointer = decodeURIComponent(ref.slice(1));
    if (!pointer.startsWith("/") || /~(?![01])/u.test(pointer)) return undefined;
    const [table, name] = pointer.slice(1).split("/").map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"));
    return table !== undefined && name !== undefined && DEFINITION_KEYS.includes(table) ? [table, name] : undefined;
  } catch { return undefined; }
}

function pruneDefinitions(schema: JsonObject): void {
  const pending: [string, string][] = [];
  const collect = (node: JsonObject, definitions: boolean): void => {
    const pointer = localDefinition(node.$ref);
    if (pointer) pending.push(pointer);
    for (const child of children(node, definitions)) collect(child, definitions);
  };
  collect(schema, false);
  const reachable = new Set<string>();
  while (pending.length) {
    const [table, name] = pending.pop()!;
    const key = JSON.stringify([table, name]);
    if (reachable.has(key)) continue;
    reachable.add(key);
    const definition = object(object(schema[table])?.[name]);
    if (definition) collect(definition, true);
  }
  for (const table of DEFINITION_KEYS) {
    const definitions = object(schema[table]);
    if (!definitions) continue;
    for (const name of Object.keys(definitions)) if (!reachable.has(JSON.stringify([table, name]))) delete definitions[name];
    if (!Object.keys(definitions).length) delete schema[table];
  }
}

function stripDescriptions(schema: JsonObject): void {
  delete schema.description;
  for (const child of children(schema, true)) stripDescriptions(child);
}

function clearSchema(schema: JsonObject): void { for (const key of Object.keys(schema)) delete schema[key]; }

function dropDefinitions(schema: JsonObject): void {
  const rewrite = (node: JsonObject): void => {
    if (localDefinition(node.$ref)) { clearSchema(node); return; }
    for (const child of children(node)) rewrite(child);
  };
  rewrite(schema);
  for (const key of DEFINITION_KEYS) delete schema[key];
}

function collapseDeepSchemas(schema: JsonObject, depth: number): void {
  if (depth >= MAX_COMPACT_SCHEMA_DEPTH && ["items", ...COMPOSITION_KEYS, "properties", "additionalProperties", "$ref"].some((key) => key in schema)) {
    clearSchema(schema);
    return;
  }
  for (const child of children(schema)) collapseDeepSchemas(child, depth + 1);
}

function pruneCompositions(schema: JsonObject): void {
  if (COMPOSITION_KEYS.some((key) => key in schema)) { clearSchema(schema); return; }
  for (const child of children(schema)) pruneCompositions(child);
}
