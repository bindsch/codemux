import { emptyUsage } from "../result-envelope.js";
import { normalizeClineUsage } from "../result-envelope/cline.js";
import type { ResultUsageBlock } from "../types.js";

export const CLINE_HISTORY_LIMIT = 2000;
export const CLINE_HISTORY_MAX_BYTES = 16 * 1024 * 1024;
export type ClineHistoryRead = (sessionId: string) => Promise<ResultUsageBlock | null>;

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** ACP drops usage events. history --json exposes persisted cumulative
 * metadata. Match exactly one root session in the expected cwd; never infer
 * usage or served-model identity from another row or a configured model.
 * https://github.com/cline/cline/blob/cli-v3.0.74/apps/cli/src/commands/history.ts#L140-L167
 * https://github.com/cline/cline/blob/cli-v3.0.74/sdk/packages/core/src/runtime/host/local-runtime-host.ts#L2227-L2259 */
export function parseClineHistoryUsage(stdout: string, sessionId: string, cwd: string): ResultUsageBlock | null {
  if (Buffer.byteLength(stdout) > CLINE_HISTORY_MAX_BYTES) return null;
  try {
    const rows: unknown = JSON.parse(stdout);
    if (!Array.isArray(rows) || rows.length > CLINE_HISTORY_LIMIT) return null;
    const matching = rows.filter((row) => object(row) && row.sessionId === sessionId);
    if (matching.length !== 1) return null;
    const row = matching[0] as Record<string, unknown>;
    if (row.cwd !== cwd || row.isSubagent === true || !object(row.metadata)) return null;
    const wire = row.metadata.aggregateUsage ?? row.metadata.usage;
    return object(wire) ? normalizeClineUsage(wire) : null;
  } catch { return null; }
}

/** Compare the same cumulative stream on both sides of a turn. A missing
 * baseline on a resumed session is unknown, not zero. Fresh sessions use an
 * explicit zero baseline, before they have a persisted history row. */
export function clineTurnUsage(before: ResultUsageBlock | null, after: ResultUsageBlock | null): ResultUsageBlock {
  const usage = emptyUsage();
  if (before === null || after === null) return usage;
  for (const field of Object.keys(usage) as (keyof ResultUsageBlock)[]) {
    const prior = before[field], current = after[field];
    if (prior !== null && current !== null && current >= prior) usage[field] = current - prior;
  }
  return usage;
}

export function freshClineUsage(): ResultUsageBlock {
  return { input_tokens: 0, output_tokens: 0, cached_input_tokens: 0, total_tokens: 0, cost_usd: 0 };
}
