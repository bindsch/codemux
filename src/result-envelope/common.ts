import { MAX_CAPTURE_BYTES, OUTPUT_LIMIT_EXIT_CODE } from "../process-runner.js";
import type { ResultUsageBlock, RunResult } from "../types.js";
import { markOverflowed } from "../usage-overflow.js";

// Re-exported for the per-agent envelope builders (the copilot and pi
// builders mark an overflowed cache sum through it).
export { markOverflowed };

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

/** A token count: a whole, non-negative number. A fractional report is
 * unknown (null), never stored: the ledger reader refuses fractional counts
 * and the call would vanish from `codemux calls` (review round 59). */
export function reportedTokenCount(value: unknown): number | null {
  // Safe integers only: past 2^53 a sum silently loses tokens (round 62).
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** A sum of token counts, or null when it would leave the safe range. */
export function safeTokenSum(...counts: number[]): number | null {
  const total = counts.reduce((sum, count) => sum + count, 0);
  return Number.isSafeInteger(total) ? total : null;
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
    usage.input_tokens = reportedTokenCount(counts.input_tokens);
    usage.output_tokens = reportedTokenCount(counts.output_tokens);
    // A reported zero stays zero: the harness did report the cache count,
    // and null would drop a known number. Both counts must be reported:
    // summing a reported one with an unreported one guesses the missing
    // half as zero, so a one-sided report stays null.
    const cacheRead = reportedTokenCount(counts.cache_read_input_tokens);
    const cacheWrite = reportedTokenCount(counts.cache_creation_input_tokens);
    if (cacheRead !== null && cacheWrite !== null) {
      usage.cached_input_tokens = safeTokenSum(cacheRead, cacheWrite);
      // An overflowed cache sum is not an unreported field: marked, so a
      // session fold never revives it with a later count (round 85).
      if (usage.cached_input_tokens === null) markOverflowed(usage, ["cached_input_tokens"]);
    }
  }
  if (
    usage.input_tokens !== null &&
    usage.cached_input_tokens !== null &&
    usage.output_tokens !== null
  ) {
    usage.total_tokens = safeTokenSum(usage.input_tokens, usage.cached_input_tokens, usage.output_tokens);
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

/** Whether the FINAL serialized envelope — the exact stdout this result
 * would carry, newline included, after every addition (the codemux block
 * included) — is past the capture bound. Measured in bytes
 * (`Buffer.byteLength`), never string length: JSON escaping can carry an
 * envelope past the bound whose raw parts all fit. */
export function envelopePastCaptureBound(serialized: string): boolean {
  return Buffer.byteLength(serialized) > MAX_CAPTURE_BYTES;
}

/** The one refusal line every `--result-json` envelope path shares: it
 * names the agent, the byte bound, and that the result is dropped — the
 * opencode path's own wording (review round 47), so every agent spells
 * the refusal identically. */
export function envelopeBoundLine(agent: string): string {
  return `${agent} result envelope exceeds the ${MAX_CAPTURE_BYTES}-byte capture bound once JSON-escaped; the reply is dropped`;
}

/** Whether a result is this bound's refusal: no envelope on stdout, the
 * output-limit exit, and the refusal line for the agent on stderr. The
 * line is what separates it from a capture that overflowed while the
 * harness was still writing, which also exits with the output limit. */
export function envelopeRefused(agent: string, result: RunResult): boolean {
  return result.stdout === "" && result.exitCode === OUTPUT_LIMIT_EXIT_CODE &&
    result.stderr.includes(envelopeBoundLine(agent));
}

/**
 * The bound every `--result-json` envelope path enforces on its FINAL
 * serialization (the opencode rule of review round 47, shared since
 * review round 127 so the Claude-family, agy, and experiment envelopes
 * cannot drift past it by adding the codemux block): a caller must never
 * read a success it cannot hold. `result.stdout` is the complete
 * serialized envelope this path built, newline included; when it is past
 * the bound the run fails with the output-limit exit, stdout carries no
 * oversized envelope, stderr gains the refusal line, and the usage and
 * served model the path computed are still reported — the tokens were
 * spent. Within the bound the result passes through unchanged.
 */
export function boundResultEnvelope(
  agent: string,
  result: RunResult,
  usage: ResultUsageBlock,
  servedModel: string | null
): RunResult {
  if (!envelopePastCaptureBound(result.stdout)) return result;
  return {
    ...result,
    success: false,
    exitCode: OUTPUT_LIMIT_EXIT_CODE,
    usage,
    servedModel,
    stdout: "",
    stderr: appendDiagnostic(result.stderr, envelopeBoundLine(agent)),
  };
}
