/** Published Messages ContentBlock and RawContentBlockDelta unions:
 * https://github.com/anthropics/anthropic-sdk-python/tree/5139cf2e7d07aa618a6c30b7e0c712f10ccb5ad9/src/anthropic/types
 * Validate fields used by the translation. Preserve native payloads,
 * including nested result variants, in the response's anthropic extension.
 */
import { CompleteError } from "./errors.js";
import { isObject } from "./response-accounting.js";

type Json = Record<string, unknown>;
const RESULTS = new Set([
  "web_search_tool_result", "web_fetch_tool_result", "code_execution_tool_result",
  "bash_code_execution_tool_result", "text_editor_code_execution_tool_result", "tool_search_tool_result",
]);

export function nativeBlock(block: Json): boolean {
  const type = block["type"];
  if (type === "thinking") return typeof block["thinking"] === "string" && typeof block["signature"] === "string";
  if (type === "redacted_thinking") return typeof block["data"] === "string";
  if (type === "container_upload") return typeof block["file_id"] === "string";
  if (type === "server_tool_use") return typeof block["id"] === "string" && typeof block["name"] === "string" && isObject(block["input"]);
  return typeof type === "string" && RESULTS.has(type) && typeof block["tool_use_id"] === "string" &&
    (isObject(block["content"]) || Array.isArray(block["content"]));
}

export function nativeDelta(delta: Json): boolean {
  return (delta["type"] === "thinking_delta" && typeof delta["thinking"] === "string") ||
    (delta["type"] === "signature_delta" && typeof delta["signature"] === "string") ||
    (delta["type"] === "citations_delta" && isObject(delta["citation"]));
}

export function blockObject(value: unknown): Json {
  if (!isObject(value)) throw new CompleteError(502, "upstream_malformed", "Anthropic content block is not an object");
  return value;
}
