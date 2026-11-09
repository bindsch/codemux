import { join } from "node:path";
import { createCopilotHermeticHome } from "./copilot-hermetic.js";
import { readUtf8FileBounded } from "./file-io.js";
import { emptyUsage, reportedTokenCount, safeTokenSum } from "./result-envelope/common.js";
import type { ResultUsageBlock } from "./types.js";
import type { RunContext } from "./run-context.js";
import type { CopilotProviderFile } from "./copilot-provider.js";
import type { CopilotExperimentRun } from "./copilot-experiment-run.js";
import type { CopilotModelRun } from "./copilot-model-run.js";

/** Installed 1.0.103 cli-main.js ERe/Ubn (read 2026-11-09) writes UsageGetMetricsResult to
 * --usage-output-file. Its modelMetrics values use the token fields in
 * copilot-sdk/generated/session-events.d.ts UsageMetricsModelMetricUsage.
 * requests.cost is a premium-request multiplier; it is never USD. */
export interface CopilotUsageFile {
  path: string;
  finalize(): void;
}

export interface CopilotRunContext extends RunContext {
  copilotUsageFile?: CopilotUsageFile;
  copilotProviderFile?: CopilotProviderFile;
  experimentCopilot?: CopilotExperimentRun;
  copilotExperimentArgv?: string[];
  copilotModelRun?: CopilotModelRun;
  copilotModelArgv?: string[];
}

export function createCopilotUsageFile(configDir: string): CopilotUsageFile {
  const scratch = createCopilotHermeticHome(configDir, { printOnly: true });
  return { path: join(scratch.home, "usage.json"), finalize: scratch.finalize };
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

/** No missing count becomes zero. inputTokens includes cached input in
 * installed 1.0.103 cli-main.js XAo (read 2026-11-09); codemux reports
 * that cache separately. */
export function parseCopilotUsageMetrics(value: unknown): ResultUsageBlock {
  const metrics = record(record(value)?.modelMetrics);
  if (metrics === null || Object.keys(metrics).length === 0) {
    throw new Error("copilot usage output has no model metrics");
  }
  let input = 0;
  let output = 0;
  let cached = 0;
  for (const metric of Object.values(metrics)) {
    const usage = record(record(metric)?.usage);
    const incoming = reportedTokenCount(usage?.inputTokens);
    const outgoing = reportedTokenCount(usage?.outputTokens);
    const read = reportedTokenCount(usage?.cacheReadTokens);
    const write = reportedTokenCount(usage?.cacheWriteTokens);
    if (incoming === null || outgoing === null || read === null || write === null) {
      throw new Error("copilot usage output has missing or invalid token counts");
    }
    const cache = safeTokenSum(read, write);
    if (cache === null || cache > incoming) {
      throw new Error("copilot usage output has inconsistent cached token counts");
    }
    input += incoming - cache;
    output += outgoing;
    cached += cache;
  }
  const total = safeTokenSum(input, output, cached);
  if (total === null) throw new Error("copilot usage token sum exceeds the safe integer range");
  return {
    ...emptyUsage(), input_tokens: input, output_tokens: output,
    cached_input_tokens: cached, total_tokens: total,
  };
}

export function readCopilotUsageFile(file: CopilotUsageFile): ResultUsageBlock {
  return parseCopilotUsageMetrics(JSON.parse(readUtf8FileBounded(file.path, {
    label: "copilot usage output", maxBytes: 1024 * 1024, noFollow: true,
  })));
}
