import type { ResultUsageBlock } from "../types.js";
import { emptyUsage, markOverflowed, reportedCount, reportedTokenCount, safeTokenSum } from "./common.js";

/** Aider 0.86.2 analytics.py writes local JSONL even with --no-analytics.
 * message_send carries native output counts under --no-stream and a running
 * total_cost. Cache counts and the provider response model are omitted.
 * A zero cost can mean absent pricing in base_coder.py, so it stays unknown.
 * If a provider omits usage, Aider estimates counts without marking them. */
export function parseAiderAnalytics(text: string): {
  usage: ResultUsageBlock;
  servedModel: null;
} {
  const usage = emptyUsage();
  let output: number | null = 0;
  let sawMessage = false;
  let previousCost = 0;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let event: unknown;
    try { event = JSON.parse(line); } catch { return { usage: emptyUsage(), servedModel: null }; }
    if (typeof event !== "object" || event === null || Array.isArray(event)) continue;
    const frame = event as Record<string, unknown>;
    if (frame.event !== "message_send") continue;
    if (typeof frame.properties !== "object" || frame.properties === null || Array.isArray(frame.properties)) {
      return { usage: emptyUsage(), servedModel: null };
    }
    sawMessage = true;
    const values = frame.properties as Record<string, unknown>;
    const count = reportedTokenCount(values.completion_tokens);
    if (output === null || count === null) output = null;
    else {
      output = safeTokenSum(output, count);
      if (output === null) markOverflowed(usage, ["output_tokens"]);
    }
    const cost = reportedCount(values.total_cost);
    if (cost === null || cost < previousCost) return { usage: emptyUsage(), servedModel: null };
    previousCost = cost;
    usage.cost_usd = cost > 0 ? cost : null;
  }
  if (sawMessage) usage.output_tokens = output;
  return { usage, servedModel: null };
}

/** Whether aider reported an output-length stop (lane AN1). Aider 0.86.2
 * has no structured stream: its plain stdout is the whole transcript, every
 * assistant response in order, which already is the complete answer. A
 * length stop raises FinishReasonLength (base_coder.py:1898, 1911); without
 * prefill support the run ends in show_exhausted_error, whose report line
 * is `Model <name> has hit a token limit!` (base_coder.py:1654). */
export function aiderReportedLengthStop(text: string): boolean {
  return /^Model .+ has hit a token limit!$/mu.test(text);
}
