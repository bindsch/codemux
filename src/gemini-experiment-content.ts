import { isDeepStrictEqual } from "node:util";
import { ExperimentFailure, ExperimentFailureCode as Code } from "./experiment-records.js";
import type { JsonObject } from "./experiment-server.js";

export const GEMINI_EXPERIMENT_PREFIX = "gemini-untrusted-context";
export const GEMINI_EXPERIMENT_SCHEMA = "gemini-wait-for-previous";
const GEMINI_WAIT_DESCRIPTION = "Set to true to wait for all previously requested tools in this turn to complete before starting. Set to false (or omit) to run in parallel. Use true when this tool depends on the output of previous tools.";

export function geminiExperimentObject(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ExperimentFailure(Code.Protocol, "Gemini evidence requires an object");
  return value as JsonObject;
}

/** Gemini 0.60.0 generateValidName, chunk-M6NSK26M.js, 2026-11-09. */
export function geminiExperimentToolName(server: string, tool: string): string {
  const raw = `${server}_${tool}`;
  const name = (raw.startsWith("mcp_") ? raw : `mcp_${raw}`).replace(/[^a-zA-Z0-9_\-.:]/g, "_");
  return name.length > 63 ? `${name.slice(0, 30)}...${name.slice(-30)}` : name;
}

/** Installed Gemini 0.60.0, bundle/chunk-M6NSK26M.js:274066 getSchema
 * unconditionally calls addWaitForPreviousParameter; :274084-274106 adds
 * this property only for object schemas with object-valued properties.
 * Read 2026-11-09. No setting controls it. A separate schema opt-in is
 * required by the host. Refuse a server-owned property with that name. */
export function geminiExperimentDefinitions(server: string, definitions: readonly JsonObject[]): JsonObject[] {
  const names = new Set<string>();
  return definitions.map((tool) => {
    if (typeof tool.name !== "string") throw new ExperimentFailure(Code.InventoryMismatch, "Gemini server tool has no name");
    const name = geminiExperimentToolName(server, tool.name);
    if (names.has(name)) throw new ExperimentFailure(Code.InventoryMismatch, "Gemini native tool names collide");
    names.add(name);
    let schema = geminiExperimentObject(tool.inputSchema ?? { type: "object", properties: {} });
    if (schema.type === "object") {
      const properties = schema.properties === undefined ? {} : geminiExperimentObject(schema.properties);
      if (Object.hasOwn(properties, "wait_for_previous")) throw new ExperimentFailure(Code.InventoryMismatch, "Gemini reserves wait_for_previous in tool schemas");
      schema = { ...schema, properties: { ...properties, wait_for_previous: { type: "boolean", description: GEMINI_WAIT_DESCRIPTION } } };
    }
    return { name, description: tool.description ?? "", parametersJsonSchema: schema };
  });
}

/** Installed Gemini 0.60.0, bundle/chunk-M6NSK26M.js:274414 wrapUntrusted
 * escapes closing tags; :274673 transformTextBlock applies the wrapper;
 * :289149 convertToFunctionResponse joins text with newlines. Read
 * 2026-11-09. Error/media/resource results are transformed, so fail before
 * delivery. The host requires explicit wrapper acceptance. */
export function assertGeminiExperimentResult(result: JsonObject): void {
  if (Object.keys(result).some((key) => key !== "content" && key !== "isError") ||
      (result.isError !== undefined && result.isError !== false) || !Array.isArray(result.content) || !result.content.length ||
      result.content.some((part: unknown) => !part || typeof part !== "object" || Array.isArray(part) ||
        Object.keys(part).some((key) => key !== "type" && key !== "text") ||
        (part as JsonObject).type !== "text" || typeof (part as JsonObject).text !== "string" ||
        (part as JsonObject).text.includes("</untrusted_context>"))) {
    throw new ExperimentFailure(Code.UnsupportedResult, "Gemini experiments require nonerror plain text without a closing untrusted_context tag");
  }
}

export function geminiExperimentOutput(result: JsonObject): string {
  assertGeminiExperimentResult(result);
  return result.content.map((part: JsonObject) => `<untrusted_context>\n${part.text}\n</untrusted_context>`).join("\n");
}

export function geminiExperimentArguments(native: unknown, input: unknown): boolean {
  const args = geminiExperimentObject(native);
  return isDeepStrictEqual(args, input);
}

/** Gemini 0.60.0 bundle/chunk-M6NSK26M.js:284893 FileExporter.serialize
 * uses safeJsonStringify(data, 2), read 2026-11-09: consecutive pretty JSON,
 * not JSONL.
 * The caller bounds bytes; this parser also bounds nesting and record count. */
export function parseGeminiExperimentTelemetry(text: string): JsonObject[] {
  const records: JsonObject[] = [];
  let start = -1, depth = 0, quoted = false, escape = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (start < 0) {
      if (/\s/.test(char)) continue;
      if (char !== "{") throw new ExperimentFailure(Code.HarnessLogMissing, "Gemini telemetry contains non-object data");
      start = i;
    }
    if (quoted) {
      if (escape) escape = false;
      else if (char === "\\") escape = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === "{" || char === "[") {
      if (++depth > 128) throw new ExperimentFailure(Code.HarnessLogMissing, "Gemini telemetry nesting exceeds 128");
    } else if (char === "}" || char === "]") {
      if (--depth === 0) {
        records.push(geminiExperimentObject(JSON.parse(text.slice(start, i + 1))));
        if (records.length > 10000) throw new ExperimentFailure(Code.HarnessLogMissing, "Gemini telemetry exceeds 10000 records");
        start = -1;
      }
    }
  }
  if (start >= 0) throw new ExperimentFailure(Code.HarnessLogMissing, "Gemini telemetry is truncated");
  return records;
}
