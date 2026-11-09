import { codexNativeCostUsd, withCodexNativeCost } from "../../src/codex-native-cost.js";
import { parseCodexEventStream } from "../../src/result-envelope.js";
import type { RunContext } from "../../src/run-context.js";
import type { RunResult } from "../../src/types.js";

/** Codex's exec stream carries tokens; the native dollar figure comes from
 * the thread-accounting read (src/codex-native-cost.ts), folded in as the
 * adapter does after a successful run. */
export function codexReporting(sessionId: string) {
  const parsed = parseCodexEventStream([
    { type: "thread.started", thread_id: sessionId }, { type: "turn.started" },
    { type: "item.completed", item: { id: "message", type: "agent_message", text: "parity" } },
    { type: "turn.completed", usage: { input_tokens: 13, cached_input_tokens: 3, cache_write_input_tokens: 0, output_tokens: 2 } },
  ].map((frame) => JSON.stringify(frame)).join("\n"));
  if (parsed === null) return undefined;
  const cost = codexNativeCostUsd({ threadUsage: { threadId: sessionId, nativeUsageUsdMicros: 250_000 } }, sessionId);
  const context = { codexNativeCostUsd: cost } as RunContext;
  const result = { success: true, exitCode: 0, stdout: "", stderr: "", usage: parsed.usage } as RunResult;
  return { ...parsed, usage: withCodexNativeCost(result, { agent: "codex", prompt: "parity" }, context).usage! };
}
