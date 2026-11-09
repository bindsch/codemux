import { parseClineResultEnvelope } from "../../src/result-envelope/cline.js";
import { parseClineHistoryUsage } from "../../src/session/cline-usage.js";
import type { AgentId } from "../../src/types.js";
export { clineSessionCapabilities } from "../../src/session/cline-session.js";

const usage = { inputTokens: 13, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 0, totalCost: 0.25 };

export function clineReporting(agent: AgentId) {
  return agent === "cline" ? parseClineResultEnvelope(JSON.stringify({
    type: "run_result", finishReason: "completed", text: "parity", usage,
  })) ?? undefined : undefined;
}

export function clineSessionUsage(agent: AgentId, sessionId: string, cwd: string) {
  return agent === "cline" ? parseClineHistoryUsage(JSON.stringify([
    { sessionId, cwd, metadata: { aggregateUsage: usage } },
  ]), sessionId, cwd) : undefined;
}
