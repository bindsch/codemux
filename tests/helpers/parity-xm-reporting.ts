import { expect } from "bun:test";
import { PARITY, type ParityFeature } from "../../src/parity/index.js";
import { agyResult } from "../../src/result-envelope/agy.js";
import { openhandsResult } from "../../src/result-envelope/openhands.js";
import { parseQwenResultEnvelope } from "../../src/result-envelope/qwen.js";
import { openhandsSessionCapabilities, parseOpenhandsSessionTurn } from "../../src/session/openhands-session.js";
import { qwenSessionCapabilities, parseQwenSessionTurn } from "../../src/session/qwen-session.js";
import type { AgentId, ResultUsageBlock } from "../../src/types.js";

export const xmSessionCaps = { openhands: openhandsSessionCapabilities, qwen: qwenSessionCapabilities };
const absentUsage = { input_tokens: null, output_tokens: null, cached_input_tokens: null, total_tokens: null, cost_usd: null };
// Qwen reports cache reads but no cache writes, so neither the combined
// cache count nor the total can be inferred from its native wire.
const qwenUsage = { input_tokens: 10, output_tokens: 2, cached_input_tokens: null, total_tokens: null, cost_usd: null };
const openhandsWire = JSON.stringify({ kind: "MessageEvent", source: "agent", llm_message: { content: [{ type: "text", text: "parity" }] } });

function qwenWire(sessionId: string): string {
  return JSON.stringify([
    { type: "assistant", model: "parity-served", session_id: sessionId, message: { content: [{ type: "text", text: "parity" }] } },
    { type: "result", subtype: "success", is_error: false, result: "parity", session_id: sessionId,
      usage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 3, total_tokens: 15 } },
  ]);
}

export function xmReporting(agent: AgentId, sessionId: string): { usage: ResultUsageBlock; servedModel?: string | null } | undefined {
  if (agent === "qwen") return parseQwenResultEnvelope(qwenWire(sessionId)) ?? undefined;
  if (agent !== "agy" && agent !== "openhands") return undefined;
  const stdout = agent === "agy" ? JSON.stringify({ status: "SUCCESS", response: "parity",
    usage: { input_tokens: 13, output_tokens: 2, cache_read_tokens: 3, total_tokens: 15 } }) : openhandsWire;
  const result = (agent === "agy" ? agyResult : openhandsResult)(
    { stdout, stderr: "", exitCode: 0, success: true }, { agent, prompt: "parity", model: "requested", resultJson: true });
  expect(result.success, agent).toBe(true);
  expect(result.exitCode, agent).toBe(0);
  expect(JSON.parse(result.stdout).codemux.served_model, agent).toBeNull();
  expect(JSON.parse(result.stdout).codemux.usage, agent).toEqual(result.usage);
  expect(result.usage, agent).toBeDefined();
  return { usage: result.usage!, servedModel: result.servedModel };
}

function pinnedLimitation(agent: AgentId, feature: ParityFeature, refusal: string): void {
  const state = PARITY[agent][feature];
  expect(state.state, `${agent} ${feature}`).toBe("harness-limitation");
  if (state.state !== "harness-limitation") throw new Error(`${agent} ${feature} must declare its absent native metric`);
  expect(state.reason).not.toContain("OPEN:");
  expect(state.evidence).toContain(agent === "agy" ? "1.5.3" : agent === "qwen" ? "0.24.0" : "1.16.0");
  expect(state.refusal).toBe(refusal);
}

export function xmReportingOutcome(agent: AgentId, feature: ParityFeature, sessionId: string) {
  if (agent !== "agy" && agent !== "openhands" && agent !== "qwen") return undefined;
  if ((feature === "run.served-model-evidence" && agent !== "qwen") ||
      (feature === "check.provider-override.served-model" && agent === "openhands")) {
    pinnedLimitation(agent, feature, "served_model: null");
    expect(xmReporting(agent, sessionId)?.servedModel, agent).toBeNull();
    return { message: null, code: null, observedAbsence: true as const };
  }
  if (feature === "run.cost") {
    pinnedLimitation(agent, feature, "cost_usd: null");
    expect(xmReporting(agent, sessionId)?.usage.cost_usd, agent).toBeNull();
    return { message: null, code: null, omittedMetric: true as const };
  }
  if (feature === "run.usage" && agent === "openhands") {
    pinnedLimitation(agent, feature, "usage: omitted (OpenHands reports no tokens on the local wire)");
    expect(xmReporting(agent, sessionId)?.usage).toEqual(absentUsage);
    return { message: null, code: null, omittedMetric: true as const };
  }
  if (feature === "run.usage" && agent === "qwen") {
    expect(xmReporting(agent, sessionId)?.usage).toEqual(qwenUsage);
    return { message: null, code: null };
  }
  return undefined;
}

export function xmSessionUsageOutcome(agent: AgentId, sessionId: string) {
  if (agent === "qwen") {
    const parsed = parseQwenSessionTurn(qwenWire(sessionId), { knownSessionId: sessionId });
    expect(parsed).toMatchObject({ answer: "parity", sessionId, noSessionId: false, wrongSession: false, noWire: false, isError: false });
    expect(parsed.usage).toEqual(qwenUsage);
    return { message: null, code: null };
  }
  if (agent !== "openhands") return undefined;
  pinnedLimitation(agent, "session.usage", "usage: omitted (OpenHands reports no tokens on the local wire)");
  const parsed = parseOpenhandsSessionTurn(`${openhandsWire}\nConversation ID: ${sessionId.replaceAll("-", "")}\n`, { knownConversationId: sessionId });
  expect(parsed).toMatchObject({ answer: "parity", conversationId: sessionId, noConversationId: false, wrongConversation: false, noWire: false, failed: false });
  expect(parsed.usage).toEqual(absentUsage);
  return { message: null, code: null, omittedMetric: true as const };
}
