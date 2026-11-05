import { isDeepStrictEqual } from "node:util";
import { object } from "./experiment-codex-content.js";
import type { CodexNativeCall } from "./experiment-codex-parser.js";
import type { JsonObject } from "./experiment-server.js";

/** The rollout output's text, when the harness answered in text (a
 * string, or input_text content parts). */
function outputText(call: CodexNativeCall): string | undefined {
  const value = call.output?.value;
  return typeof value === "string" ? value : Array.isArray(value) && value.every((part) =>
    object(part)?.type === "input_text" && typeof object(part)?.text === "string")
    ? value.map((part) => part.text).join("") : undefined;
}

/** Resource operations emit MCP exec completions without native call IDs. */
export function matchesCodexResourceResult(call: CodexNativeCall, item: JsonObject): boolean {
  const input = object(call.input);
  const argumentsValue = typeof call.input === "string" && !call.input.trim() ? null : call.input;
  const server = typeof input?.server === "string" && input.server.trim() ? input.server.trim() : "codex";
  const id = item.call_id ?? item.callId;
  if (!call.output || item.tool !== call.name.replace(/^functions\./u, "") || item.server !== server ||
      !isDeepStrictEqual(item.arguments, argumentsValue) || (id !== undefined && id !== call.callId)) return false;
  const output = outputText(call);
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

/** The name Codex prints for a call it refuses: its ToolName display drops
 * the default `functions` namespace and concatenates any other namespace
 * with the name. One rule for the parser's model-error check and the
 * resource refusal below. */
export function codexNativeToolName(item: JsonObject): string {
  const namespace = item.namespace;
  return namespace && namespace !== "functions" ? namespace + item.name : item.name;
}

/** A resource builtin the harness itself refused: the unsupported-call
 * error text as the call's whole output (the saved-rollout shape —
 * nothing executed, so no exec completion can exist for it). The text is
 * pinned exactly, never prefix-matched: any other output left over is
 * missing exec evidence. Two exact spellings count. The first is the
 * native one, the name as Codex displays it (review round 112: the
 * bookkeeping name alone missed it, so a real refusal failed
 * verification). The second is the qualified bookkeeping name
 * `functions.<name>`, the spelling the recorded resource fixtures carry. */
export function isCodexResourceRefusal(call: CodexNativeCall): boolean {
  const prefix = call.item.type === "custom_tool_call"
    ? "unsupported custom tool call: "
    : "unsupported call: ";
  const output = outputText(call);
  return output === prefix + codexNativeToolName(call.item) || output === prefix + call.name;
}
