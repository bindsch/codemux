import { isDeepStrictEqual } from "node:util";
import { object } from "./experiment-codex-content.js";
import type { CodexNativeCall } from "./experiment-codex-parser.js";
import type { JsonObject } from "./experiment-server.js";

/** Resource operations emit MCP exec completions without native call IDs. */
export function matchesCodexResourceResult(call: CodexNativeCall, item: JsonObject): boolean {
  const input = object(call.input);
  const argumentsValue = typeof call.input === "string" && !call.input.trim() ? null : call.input;
  const server = typeof input?.server === "string" && input.server.trim() ? input.server.trim() : "codex";
  const id = item.call_id ?? item.callId;
  if (!call.output || item.tool !== call.name.replace(/^functions\./u, "") || item.server !== server ||
      !isDeepStrictEqual(item.arguments, argumentsValue) || (id !== undefined && id !== call.callId)) return false;
  const value = call.output.value;
  const output = typeof value === "string" ? value : Array.isArray(value) && value.every((part) =>
    object(part)?.type === "input_text" && typeof object(part)?.text === "string")
    ? value.map((part) => part.text).join("") : undefined;
  if (output === undefined) return false;
  if (item.status === "failed" && item.result == null) {
    const error = typeof item.error === "string" ? item.error : object(item.error)?.message;
    return error === output;
  }
  const result = object(item.result);
  return item.status === "completed" && item.error == null && result !== undefined &&
    result.structured_content == null && !["structuredContent", "_meta"].some((key) => key in result) &&
    isDeepStrictEqual(result.content, [{ type: "text", text: output }]);
}
