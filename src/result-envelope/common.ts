import type { ResultUsageBlock } from "../types.js";

export function emptyUsage(): ResultUsageBlock {
  return {
    input_tokens: null,
    output_tokens: null,
    cached_input_tokens: null,
    total_tokens: null,
    cost_usd: null,
  };
}

export function reportedCount(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

/**
 * Normalize one claude-family usage report into the codemux block
 * (ResultUsageBlock semantics): `input_tokens` excludes the cache, the
 * read and write counts fold into `cached_input_tokens`, and the total
 * is the sum plus output — computed only when all three are known, so
 * an unreported half stays null rather than guessing zero. Shared by
 * the `--result-json` envelope parser and the session usage events.
 */
export function normalizeClaudeUsage(
  reported: unknown,
  costUsd: unknown
): ResultUsageBlock {
  const usage = emptyUsage();
  if (typeof reported === "object" && reported !== null) {
    const counts = reported as Record<string, unknown>;
    usage.input_tokens = reportedCount(counts.input_tokens);
    usage.output_tokens = reportedCount(counts.output_tokens);
    // A reported zero stays zero: the harness did report the cache count,
    // and null would drop a known number. Both counts must be reported:
    // summing a reported one with an unreported one guesses the missing
    // half as zero, so a one-sided report stays null.
    const cacheRead = reportedCount(counts.cache_read_input_tokens);
    const cacheWrite = reportedCount(counts.cache_creation_input_tokens);
    if (cacheRead !== null && cacheWrite !== null) {
      usage.cached_input_tokens = cacheRead + cacheWrite;
    }
  }
  if (
    usage.input_tokens !== null &&
    usage.cached_input_tokens !== null &&
    usage.output_tokens !== null
  ) {
    usage.total_tokens =
      usage.input_tokens + usage.cached_input_tokens + usage.output_tokens;
  }
  usage.cost_usd = reportedCount(costUsd);
  return usage;
}

/**
 * Appends one codemux diagnostic after the harness's own stderr, separating
 * the two with a newline even when the harness's last line was unterminated:
 * appending straight onto `"boom"` produced `"boomcodemux: ..."`, gluing the
 * codemux line onto the harness's and corrupting the line-oriented
 * diagnostics a caller parses (round10). An empty stderr gains nothing but
 * the line itself.
 */
export function appendDiagnostic(stderr: string, line: string): string {
  const separated =
    stderr === "" || stderr.endsWith("\n") ? stderr : `${stderr}\n`;
  return `${separated}${line}\n`;
}
