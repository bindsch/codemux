import type { CopilotExperimentDelivery } from "./copilot-experiment-evidence.js";
import type { JsonObject } from "./experiment-server.js";

/** A transport-level 200 does not prove that the model accepted the
 * request. Recognize a complete native response in the same API family
 * as its validated request. Failed or incomplete attempts earn no credit. */
export function copilotModelResponseSucceeded(delivery: CopilotExperimentDelivery, bytes: Uint8Array): boolean {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (!text.trimStart().startsWith("data:") && !text.trimStart().startsWith("event:") && !text.trimStart().startsWith(":")) {
      const response = JSON.parse(text) as JsonObject;
      if (!response || response.error || typeof response.id !== "string") return false;
      if (delivery.wireApi === "chat") return Array.isArray(response.choices) && response.choices.some((choice: JsonObject) =>
        choice.index === 0 && typeof choice.finish_reason === "string" && choice.message && typeof choice.message === "object");
      if (delivery.wireApi === "responses") return response.status === "completed" && Array.isArray(response.output);
      return response.type === "message" && typeof response.stop_reason === "string" && Array.isArray(response.content);
    }
    if (!text.endsWith("\n\n") && !text.endsWith("\r\n\r\n")) return false;
    let identity: string | undefined, ended = false, stopped = false, done = false;
    for (const frame of text.split(/\r?\n\r?\n/)) {
      const data = frame.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
      if (!data) continue;
      if (data === "[DONE]") { done = true; continue; }
      const value = JSON.parse(data) as JsonObject;
      if (!value || value.error || ["error", "response.failed", "response.incomplete"].includes(value.type)) return false;
      if (delivery.wireApi === "chat") {
        if (typeof value.id === "string") {
          if (identity !== undefined && identity !== value.id) return false;
          identity = value.id;
        }
        if (Array.isArray(value.choices) && value.choices.some((choice: JsonObject) => choice.index === 0 && typeof choice.finish_reason === "string")) stopped = true;
      } else if (delivery.wireApi === "responses") {
        if (value.type === "response.created") {
          if (identity !== undefined || typeof value.response?.id !== "string") return false;
          identity = value.response.id;
        }
        if (value.type === "response.completed") {
          if (!identity || value.response?.id !== identity || value.response.status !== "completed" || value.response.error) return false;
          ended = true;
        }
      } else {
        if (value.type === "message_start") {
          if (identity !== undefined || typeof value.message?.id !== "string") return false;
          identity = value.message.id;
        }
        if (value.type === "message_delta" && typeof value.delta?.stop_reason === "string") stopped = true;
        if (value.type === "message_stop") ended = true;
      }
    }
    return Boolean(identity) && (delivery.wireApi === "chat" ? stopped && done : delivery.wireApi === "responses" ? ended : ended && stopped);
  } catch { return false; }
}
