import type { CodemuxResultBlock, ResultUsageBlock, RunRequest, RunResult } from "../types.js";
import { appendDiagnostic, emptyUsage, reportedCount } from "./common.js";

export interface AgyEnvelopeInfo {
  envelope: Record<string, unknown>;
  usage: ResultUsageBlock;
  /** The envelope's `status` string; "SUCCESS" on success. */
  status: string;
  /** The envelope's `error` text when it names one as a string. */
  errorText: string | null;
  /**
   * True when the envelope reports its own failure: any status other than
   * "SUCCESS" (ERROR, CANCELED, INTERRUPTED, INVALID, WAITING, RUNNING) or
   * a non-null `error`. The harness can fail while exiting 0, and a
   * wrapper can mask the exit code, so the verdict reads the envelope
   * rather than trusting the exit.
   */
  isError: boolean;
}

/**
 * Parses the single JSON result object Antigravity CLI prints for print
 * mode launched with `--output-format=json` (the `=` form the pinned
 * 1.2.14 requires). The shape is pinned against
 * 1.2.14 by the official headless documentation and the binary's own JSON
 * tags (no login was available to record a live envelope; the pin is
 * documented, not live-verified): `status`, `response`, `error`,
 * `usage{input_tokens, output_tokens, thinking_tokens, cache_read_tokens,
 * total_tokens}`. Returns null when stdout is not that object, and the
 * caller treats that as the contract violation it is.
 *
 * Usage arithmetic, from every documented example: `total_tokens` is
 * `input_tokens + output_tokens`, where `input_tokens` INCLUDES the
 * cache-read count and `thinking_tokens` sits outside the total entirely.
 * The normalized block therefore reports `input_tokens` (the raw value)
 * minus `cache_read_tokens` as uncached input, keeps `cache_read_tokens`
 * as `cached_input_tokens`, and computes `total_tokens` as the sum of
 * those three -- the cross-harness rule (README: "only when every
 * component was reported"). The sum reproduces the total agy itself
 * reports whenever every component was reported (the subtraction gives
 * the cache reads back), and a reported total over missing components is
 * not echoed: it would publish a number whose own addends are null.
 * `thinking_tokens` has no normalized counterpart and stays unmapped, and
 * `cost_usd` is null because the envelope carries no cost.
 */
export function parseAgyResultEnvelope(
  stdout: string
): AgyEnvelopeInfo | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const envelope = parsed as Record<string, unknown>;
  // `status` is the envelope's discriminator: `{}` and every other JSON
  // object parse cleanly yet carry no outcome, so accepting them would
  // report unrelated stdout as a successful run.
  if (typeof envelope.status !== "string" || envelope.status === "") {
    return null;
  }
  const errorText =
    typeof envelope.error === "string" ? envelope.error : null;
  const isError = envelope.status !== "SUCCESS" || envelope.error != null;
  // The discriminator alone is not a result either: an envelope owes its
  // `response` text, and only a failing one -- a non-SUCCESS status or a
  // named error -- may omit it, because that names the outcome (a
  // failure) and fails the run downstream. `{"status":"SUCCESS"}` says
  // nothing at all.
  if (typeof envelope.response !== "string" && !isError) {
    return null;
  }

  const usage = emptyUsage();
  if (typeof envelope.usage === "object" && envelope.usage !== null) {
    const reported = envelope.usage as Record<string, unknown>;
    const input = reportedCount(reported.input_tokens);
    const output = reportedCount(reported.output_tokens);
    // A reported zero stays zero: the harness did report the count, and
    // null would drop a known number. The raw input includes the cache
    // reads, so uncached input is their difference and needs both counts:
    // one-sided reports stay null rather than guessing the missing half.
    const cacheRead = reportedCount(reported.cache_read_tokens);
    if (input !== null && cacheRead !== null) {
      usage.input_tokens = Math.max(0, input - cacheRead);
    }
    usage.output_tokens = output;
    usage.cached_input_tokens = cacheRead;
    // The total is computed, never echoed: the sum of the three normalized
    // components, and only when all are known -- which reproduces agy's own
    // total (the subtracted cache reads are added back), while a reported
    // total over missing components would publish a number whose own
    // addends are null (the claude and codex parsers' rule, round 5).
    if (
      usage.input_tokens !== null &&
      usage.cached_input_tokens !== null &&
      usage.output_tokens !== null
    ) {
      usage.total_tokens =
        usage.input_tokens + usage.cached_input_tokens + usage.output_tokens;
    }
  }

  return { envelope, usage, status: envelope.status, errorText, isError };
}

/**
 * Finishes a `--result-json` run for Antigravity: the envelope is re-emitted
 * with every original field untouched plus the codemux block. Stdout that is
 * not the envelope breaks the contract the launch made (it ran with
 * `--output-format=json`), so the run fails loudly -- the raw stdout stays,
 * stderr says what is missing, and the exit is non-zero. An envelope with a
 * non-SUCCESS status or an `error` fails the run the same way: the harness
 * can fail while exiting 0, and the structured report is read rather than
 * the exit trusted. An envelope whose response text is empty or
 * whitespace-only fails too: a reply of spaces and newlines is no reply.
 */
export function agyResult(result: RunResult, request: RunRequest): RunResult {
  const agent = "agy" as const;
  const parsed = parseAgyResultEnvelope(result.stdout);
  if (parsed === null) {
    return {
      ...result,
      stderr: appendDiagnostic(
        result.stderr,
        `codemux: ${agent} printed no result envelope, ` +
          "so this --result-json run carries no codemux block"
      ),
      exitCode: result.exitCode === 0 ? 1 : result.exitCode,
      success: false,
    };
  }
  // The envelope carries no model field, so the codemux block reports the
  // model codemux selected, else null: the harness default, which nothing
  // reported. `conversation_id` is agy's own and no codemux run can resume
  // it, so session_id stays null like every harness in this release.
  const block = (): CodemuxResultBlock => ({
    agent,
    labels: request.labels ?? null,
    model: request.model ?? null,
    usage: parsed.usage,
    session_id: null,
    recording: null,
  });
  if (parsed.isError) {
    const reason =
      parsed.errorText !== null
        ? `status "${parsed.status}": ${parsed.errorText}`
        : `status "${parsed.status}"`;
    return {
      ...result,
      stdout: `${JSON.stringify({ ...parsed.envelope, codemux: block() })}\n`,
      stderr: appendDiagnostic(
        result.stderr,
        `codemux: ${agent} reported an error result (${reason}), ` +
          `so this run fails even though the harness exited ${result.exitCode}`
      ),
      exitCode: result.exitCode === 0 ? 1 : result.exitCode,
      success: false,
      usage: parsed.usage,
      servedModel: null,
    };
  }
  // The parser guarantees a string response on a non-error envelope; the
  // belt check keeps the guarantee local rather than trusting the caller's
  // reading of it.
  const response =
    typeof parsed.envelope.response === "string"
      ? parsed.envelope.response
      : "";
  if (response.trim() === "") {
    return {
      ...result,
      stdout: `${JSON.stringify({ ...parsed.envelope, codemux: block() })}\n`,
      stderr: appendDiagnostic(
        result.stderr,
        `codemux: ${agent} printed an envelope with no ` +
          "result text, so this --result-json run reports no result"
      ),
      exitCode: result.exitCode === 0 ? 1 : result.exitCode,
      success: false,
      usage: parsed.usage,
      servedModel: null,
    };
  }
  return {
    ...result,
    stdout: `${JSON.stringify({ ...parsed.envelope, codemux: block() })}\n`,
    usage: parsed.usage,
    servedModel: null,
  };
}
