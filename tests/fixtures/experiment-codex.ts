import { sanitizeCodexToolName } from "../../src/experiment-tool-names.js";
import type { JsonObject } from "../../src/experiment-server.js";

export function codexDefinitions(names: readonly string[]): JsonObject[] {
  return names.map((name) => ({ name, description: "", inputSchema: { type: "object", properties: {} } }));
}

export function codexWorldState(names: readonly string[], server = "experiment", timestamp = "2026-10-29T00:00:00Z"): JsonObject {
  const sanitized = sanitizeCodexToolName(server);
  const namespace = sanitized.startsWith("mcp__") ? sanitized : `mcp__${sanitized}`;
  const tools = Object.fromEntries([namespace, ...names.map((name) => `${namespace}.${sanitizeCodexToolName(name)}`)]
    .map((name) => [name, "fixture-hash"]));
  return { timestamp, type: "world_state", payload: { full: true, state: { top_level_tools: tools } } };
}

export function codexCatalog(tools: readonly string[] | readonly JsonObject[], server = "experiment", timestamp = "2026-10-29T00:00:00Z"): JsonObject {
  const definitions = typeof tools[0] === "string" ? codexDefinitions(tools as string[]) : tools as readonly JsonObject[];
  const sanitized = sanitizeCodexToolName(server);
  const namespace = sanitized.startsWith("mcp__") ? sanitized : `mcp__${sanitized}`;
  return { timestamp, type: "response_item", payload: { type: "additional_tools", tools: [
    { type: "namespace", name: namespace, tools: definitions.map((tool) => ({ type: "function", name: sanitizeCodexToolName(tool.name),
      description: tool.description ?? "", strict: false, parameters: tool.inputSchema })) },
  ] } };
}
