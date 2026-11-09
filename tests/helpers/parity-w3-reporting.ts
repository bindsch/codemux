import { mkdtempSync, writeFileSync, unlinkSync, rmdirSync } from "node:fs";
import { join } from "node:path";
import type { AgentId } from "../../src/types.js";
import { parseGeminiResultEnvelope } from "../../src/result-envelope/gemini.js";
import { geminiTelemetryServedModel } from "../../src/gemini-telemetry.js";
import { parseCopilotResultEnvelope } from "../../src/result-envelope/copilot.js";
import { parseCopilotUsageMetrics } from "../../src/copilot-usage.js";
import { CopilotModelEvidence } from "../../src/copilot-model-evidence.js";
import { piSessionCapabilities, parsePiSessionTurn } from "../../src/session/pi-session.js";
import { geminiSessionCapabilities, parseGeminiStreamLine } from "../../src/session/gemini-session.js";
import { copilotSessionCapabilities } from "../../src/session/copilot-session.js";

export const w3SessionCaps = { pi: piSessionCapabilities, gemini: geminiSessionCapabilities, copilot: copilotSessionCapabilities };

export function w3Reporting(agent: AgentId, sessionId: string) {
  if (agent === "copilot") {
    // A --result-json run's served model is read from the provider response
    // bytes the observed RPC session relays (src/copilot-model-evidence.ts).
    const evidence = new CopilotModelEvidence();
    const delivery = evidence.request(new TextEncoder().encode('{"model":"requested-model","messages":[]}'),
      { interactionType: "conversation-agent", url: "https://synthetic.invalid/chat/completions" });
    evidence.commit(delivery, new TextEncoder().encode(JSON.stringify({ id: "parity", model: "parity-served",
      choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "parity" } }] })));
    return { ...copilotJsonlReporting(sessionId), servedModel: evidence.servedModel };
  }
  if (agent !== "gemini") return undefined;
  return geminiReporting(sessionId);
}

function copilotJsonlReporting(sessionId: string) {
  return {
    ...parseCopilotResultEnvelope([
      { type: "assistant.message", data: { content: "parity", model: "configured-model" } },
      { type: "result", sessionId, exitCode: 0 },
    ].map((frame) => JSON.stringify(frame)).join("\n"))!,
    usage: parseCopilotUsageMetrics({ modelMetrics: { "configured-model": {
      usage: { inputTokens: 13, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 0 },
    } } }),
  };
}

function geminiReporting(sessionId: string) {
  const home = mkdtempSync(join(process.cwd(), "scratch/fix/parity-gemini-"));
  const path = join(home, "telemetry.json");
  try {
    writeFileSync(path, [
      { _spanContext: { traceId: "trace", spanId: "main" }, status: { code: 1 }, attributes: {
        "gen_ai.tool.definitions": "[]", "gen_ai.conversation.id": sessionId, "gen_ai.prompt.name": "prompt" } },
      { spanContext: { traceId: "trace", spanId: "main" }, attributes: { "event.name": "gemini_cli.api_request", role: "main" } },
      { spanContext: { traceId: "trace", spanId: "main" }, attributes: { "event.name": "gemini_cli.api_response",
        role: "main", status_code: 200, prompt_id: "prompt", response_text: '{"modelVersion":"parity-served"}' } },
    ].map((frame) => JSON.stringify(frame)).join("\n"), { mode: 0o600 });
    return { ...parseGeminiResultEnvelope(JSON.stringify({ session_id: sessionId, response: "parity",
      stats: { input_tokens: 13, output_tokens: 2, cached: 3 } }))!,
      servedModel: geminiTelemetryServedModel(path, sessionId) };
  } finally { unlinkSync(path); rmdirSync(home); }
}

export function w3SessionUsage(agent: AgentId, sessionId: string) {
  if (agent === "copilot") return parseCopilotUsageMetrics({ modelMetrics: { "configured-model": {
    usage: { inputTokens: 13, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 0 },
  } } });
  if (agent === "gemini") {
    const frame = parseGeminiStreamLine(JSON.stringify({ type: "result", status: "success",
      stats: { input_tokens: 13, output_tokens: 2, cached: 3 } }), { knownSessionId: sessionId });
    return "usage" in frame ? frame.usage : undefined;
  }
  if (agent !== "pi") return undefined;
  return parsePiSessionTurn([
    { type: "session", version: 3, id: sessionId, timestamp: "synthetic", cwd: "/synthetic" },
    { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "parity" }],
      model: "parity-served", stopReason: "stop", usage: { input: 10, output: 2, cacheRead: 3,
        cacheWrite: 0, cost: { total: 0.25 } } } },
  ].map((frame) => JSON.stringify(frame)).join("\n"), { knownSessionId: sessionId }).usage;
}
