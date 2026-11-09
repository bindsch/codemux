import { isDeepStrictEqual } from "node:util";
import { ExperimentFailure, ExperimentFailureCode as Code } from "./experiment-records.js";
import type { ExperimentRelayCall } from "./experiment-relay.js";
import type { JsonObject } from "./experiment-server.js";

export function opencodeEvidenceObject(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ExperimentFailure(Code.Protocol, "OpenCode experiment evidence requires an object");
  }
  return value as JsonObject;
}

export function opencodeExperimentToolName(server: string, tool: string): string {
  // Read 2026-11-09, bin/opencode 1.19.5: xy=(e)=>e.replace(/[^a-zA-Z0-9_-]/g,"_"),
  // Rp=(e,t)=>xy(e)+"_"+xy(t). Evidence script: scratch/fix/opencode-experiment-bundle-evidence.py.
  return `${server}_${tool}`.replace(/[^a-zA-Z0-9_-]/g, "_");
}

/** OpenCode converts text blocks to one string before provider conversion.
 * Refuse media, metadata, and empty errors before native conversion can lose
 * them. Unsupported content is an explicit experiment failure. */
export function assertOpencodeExperimentResult(value: unknown): asserts value is JsonObject {
  const result = opencodeEvidenceObject(value);
  if (!Array.isArray(result.content) || !result.content.length ||
      Object.keys(result).some((key) => !["content", "isError"].includes(key)) ||
      (result.isError !== undefined && typeof result.isError !== "boolean")) {
    throw new ExperimentFailure(Code.UnsupportedResult, "OpenCode experiment requires text content and optional boolean isError only");
  }
  for (const block of result.content) {
    if (block?.type !== "text" || typeof block.text !== "string" ||
        Object.keys(block).some((key) => !["type", "text"].includes(key)) ||
        (result.isError && !block.text.trim())) {
      throw new ExperimentFailure(Code.UnsupportedResult, "OpenCode experiment refuses nontext blocks, annotations, and empty errors");
    }
  }
}

const array = (value: unknown): JsonObject[] => {
  if (!Array.isArray(value)) throw new ExperimentFailure(Code.Protocol, "OpenCode provider payload requires an array");
  return value.map(opencodeEvidenceObject);
};
const same = (actual: unknown, expected: unknown, code: Code, message: string): void => {
  if (!isDeepStrictEqual(actual, expected)) throw new ExperimentFailure(code, message);
};

/** Reads final HTTP JSON, after OpenCode's truncation and provider transforms.
 * Extra tools, rewritten results, unknown APIs and missing call IDs fail closed. */
export function verifyOpencodeProviderPayload(server: string, definitions: readonly JsonObject[],
  value: unknown, calls: ReadonlyMap<string, ExperimentRelayCall>): string[] {
  const payload = opencodeEvidenceObject(value);
  let tools: JsonObject[], results: JsonObject[], declared: JsonObject[], kind: string;
  if (Array.isArray(payload.input)) {
    kind = "responses"; tools = array(payload.tools);
    const input = array(payload.input);
    results = input.filter((item) => item.type === "function_call_output");
    declared = input.filter((item) => item.type === "function_call").map((item) =>
      ({ id: item.call_id, name: item.name, args: JSON.parse(item.arguments) }));
  } else if (Array.isArray(payload.messages)) {
    const messages = array(payload.messages);
    if (array(payload.tools).every((tool) => tool.type === "function" && tool.function)) {
      kind = "chat"; tools = array(payload.tools).map((tool) => opencodeEvidenceObject(tool.function));
      results = messages.filter((message) => message.role === "tool");
      declared = messages.flatMap((message) => (message.tool_calls ?? []).map((call: JsonObject) =>
        ({ id: call.id, name: call.function.name, args: JSON.parse(call.function.arguments) })));
    } else {
      kind = "anthropic"; tools = array(payload.tools);
      const content = messages.flatMap((message) => Array.isArray(message.content) ? array(message.content) : []);
      results = content.filter((part) => part.type === "tool_result");
      declared = content.filter((part) => part.type === "tool_use").map((part) => ({ id: part.id, name: part.name, args: part.input }));
    }
  } else {
    throw new ExperimentFailure(Code.ModelUnavailable, "OpenCode experiment has no verified decoder for this provider request");
  }
  // Native MCP schema projection: mcp/catalog.ts convertTool supplies object,
  // properties, and additionalProperties:false before provider conversion.
  // Any later schema rewrite is detected against the final request below.
  const expected = definitions.map((tool) => ({ name: opencodeExperimentToolName(server, tool.name),
    description: tool.description ?? "", schema: { ...tool.inputSchema, type: "object",
      properties: tool.inputSchema?.properties ?? {}, additionalProperties: false } }));
  const actual = tools.map((tool) => ({ name: tool.name, description: tool.description ?? "",
    schema: tool.input_schema ?? tool.parameters }));
  const sorted = (items: JsonObject[]) => items.toSorted((a, b) => a.name.localeCompare(b.name));
  same(sorted(actual), sorted(expected), Code.InventoryMismatch, "OpenCode provider tool inventory differs from the experiment server");
  if (new Set(actual.map((tool) => tool.name)).size !== expected.length) {
    throw new ExperimentFailure(Code.InventoryMismatch, "OpenCode provider repeats a tool name");
  }
  const native = new Set<string>();
  for (const call of declared) {
    const source = calls.get(call.id);
    if (!source || native.has(call.id) || call.name !== opencodeExperimentToolName(server, source.name) ||
        !isDeepStrictEqual(call.args, source.input)) {
      throw new ExperimentFailure(Code.CallIdUnresolved, "OpenCode provider call identity or arguments changed");
    }
    native.add(call.id);
  }
  const delivered: string[] = [];
  for (const result of results) {
    const id = result.call_id ?? result.tool_call_id ?? result.tool_use_id;
    const call = calls.get(id);
    if (!call?.result || !native.has(id) || delivered.includes(id)) {
      throw new ExperimentFailure(Code.CallIdUnresolved, "OpenCode provider result lacks a unique native call");
    }
    assertOpencodeExperimentResult(call.result);
    const text = call.result.content.map((block: JsonObject) => block.text).join("\n\n");
    let content = kind === "responses" ? result.output : result.content;
    if (Array.isArray(content)) {
      same(content, [{ type: "text", text }], Code.ResultChanged, "OpenCode provider result blocks changed");
      content = text;
    }
    same(content, text, Code.ResultChanged, "OpenCode provider tool result changed or was truncated");
    if (kind === "anthropic") same(result.is_error === true, call.result.isError === true,
      Code.ResultChanged, "OpenCode provider error status changed");
    delivered.push(id);
  }
  if (native.size !== delivered.length) throw new ExperimentFailure(Code.HarnessLogMissing, "OpenCode provider omitted a tool result");
  return delivered;
}
