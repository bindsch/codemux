import { copilotRpcBodyLimit } from "./copilot-rpc-framing.js";
import { MAX_GEMINI_ACP_LINE_BYTES } from "./gemini-acp.js";
import { harnessLineDeliverable } from "./process.js";

// Fresh native sessions use UUIDs. Reserve the largest numeric request ID
// before initialization, so acceptance never depends on transport timing.
const UUID_WIDTH = "0".repeat(36);
const REQUEST_ID = Number.MAX_SAFE_INTEGER;

export function rpcPromptDeliverable(agent: "gemini" | "copilot" | "pi", text: string, sessionId: string | null): boolean {
  if (agent === "pi") {
    return harnessLineDeliverable(`${JSON.stringify({ id: "state", type: "get_state" })}\n` +
      `${JSON.stringify({ id: "prompt", type: "prompt", message: text })}\n`);
  }
  const frame = agent === "gemini"
    ? { jsonrpc: "2.0", id: REQUEST_ID, method: "session/prompt",
      params: { sessionId: sessionId ?? UUID_WIDTH, prompt: [{ type: "text", text }] } }
    : { jsonrpc: "2.0", id: REQUEST_ID, method: "session.send",
      params: { sessionId: sessionId ?? UUID_WIDTH, prompt: text } };
  return Buffer.byteLength(JSON.stringify(frame)) + (agent === "gemini" ? 1 : 0) <=
    (agent === "gemini" ? MAX_GEMINI_ACP_LINE_BYTES : copilotRpcBodyLimit);
}
