import { sanitizeCodexToolName } from "../../src/experiment-tool-names.js";
import type { JsonObject } from "../../src/experiment-server.js";

export function codexCatalog(names: string[], server = "experiment", timestamp = "2026-10-29T00:00:00Z"): JsonObject {
  const sanitized = sanitizeCodexToolName(server);
  const namespace = sanitized.startsWith("mcp__") ? sanitized : `mcp__${sanitized}`;
  return { timestamp, type: "response_item", payload: { type: "additional_tools", tools: [
    { type: "namespace", name: namespace, tools: names.map((name) => ({ type: "function", name: sanitizeCodexToolName(name) })) },
  ] } };
}
