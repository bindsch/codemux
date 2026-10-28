import type { AgentId, CodemuxResultBlock, ResultUsageBlock, RunRequest, RunResult } from "../types.js";
import { appendDiagnostic, normalizeClaudeUsage } from "./common.js";

export interface ClaudeEnvelopeInfo {
  envelope: Record<string, unknown>;
  usage: ResultUsageBlock;
  /** The model that served the run, when the envelope names exactly one. */
  servedModel: string | null;
  /**
   * True when the envelope's `modelUsage` names several models: no one model
   * served the run, so no model may be reported for it.
   */
  multipleModels: boolean;
  /**
   * True when the envelope reports its own failure: `is_error: true`, or a
   * subtype that names one (`error_during_execution`, `error_max_turns`, ...).
   * The harness can fail while exiting 0, and a wrapper can mask the exit
   * code, so the verdict reads the envelope rather than trusting the exit.
   */
  isError: boolean;
  /** The envelope's `subtype` when it names an error, else null. */
  errorSubtype: string | null;
}

/**
 * Parses Claude Code's result object: the single output from
 * `--output-format json`, or the result frame the experiment bridge extracts
 * and validates from `--output-format stream-json`.
 * Returns null when stdout is not that object -- an older binary,
 * a wrapper, JSON that is not the result envelope, or an envelope that
 * reports no outcome at all -- and the caller treats that as the contract
 * violation it is.
 *
 * The envelope's `usage` counts come from the Anthropic Messages API, where
 * `input_tokens` excludes the cache; the cache read and write counts become
 * `cached_input_tokens` so the three fields sum to the whole conversation.
 */
export function parseClaudeResultEnvelope(
  stdout: string
): ClaudeEnvelopeInfo | null {
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
  // `type: "result"` is the envelope's discriminator. `{}` and every other
  // JSON object parse cleanly yet carry no result, so treating any object as
  // the envelope would report unrelated stdout as a successful run.
  if (envelope.type !== "result") {
    return null;
  }
  // The discriminator alone is not a result either: `{"type":"result"}` --
  // a malformed wrapper response -- names neither the `result` text nor a
  // status, so it reports no outcome at all and accepting it would turn
  // an envelope that says nothing into a successful run. A successful
  // envelope owes its `result` text; only a failing one may omit it,
  // because `is_error: true` or an `error_*` subtype names the outcome
  // (a failure) and fails the run downstream. A bare non-error `subtype`
  // is not an outcome: `{"type":"result","subtype":"success"}` satisfied
  // this check while carrying no reply, and any string -- the empty one
  // included -- counted.
  const errorSubtype =
    typeof envelope.subtype === "string" && envelope.subtype.startsWith("error")
      ? envelope.subtype
      : null;
  const isError = envelope.is_error === true || errorSubtype !== null;
  if (typeof envelope.result !== "string" && !isError) {
    return null;
  }

  const usage = normalizeClaudeUsage(envelope.usage, envelope.total_cost_usd);

  let servedModel: string | null = null;
  let multipleModels = false;
  if (
    typeof envelope.modelUsage === "object" &&
    envelope.modelUsage !== null
  ) {
    const models = Object.keys(envelope.modelUsage as Record<string, unknown>);
    if (models.length === 1 && models[0] !== "") servedModel = models[0] ?? null;
    multipleModels = models.length > 1;
  }

  return { envelope, usage, servedModel, multipleModels, isError, errorSubtype };
}

/**
 * Finishes a `--result-json` run for a Claude-family harness: the envelope
 * is re-emitted with every original field untouched plus the codemux block.
 * Stdout must be the `--output-format json` envelope or the validated result
 * frame extracted by the experiment bridge from `--output-format stream-json`.
 * Other stdout breaks that launch contract, so
 * the run fails loudly: the raw stdout stays on stdout, stderr says what is
 * missing, and the exit is non-zero -- a silent success without the block
 * would leave the caller parsing nothing. An envelope that reports its own
 * failure (`is_error`, or an `error_*` subtype) fails the run the same way:
 * the harness can fail while exiting 0, and a wrapper can mask the exit
 * code, so the structured report is read rather than the exit trusted; the
 * envelope is still emitted (its fields are the harness's own record of the
 * failure) and stderr carries the codemux line. An envelope whose result
 * text is empty or whitespace-only fails the run too: a reply of spaces and
 * newlines is no reply (round10 for "", round17 for whitespace-only), so it
 * must not pass as a successful run a caller could record as having no
 * output.
 */
export function claudeFamilyResult(
  result: RunResult,
  request: RunRequest,
  agent: AgentId,
  recording: string | null = null
): RunResult {
  const parsed = parseClaudeResultEnvelope(result.stdout);
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
  // The envelope's reply is absent when it named no result text, the empty
  // one, or a whitespace-only one: a reply of spaces and newlines is no
  // reply -- the same rule prompt validation applies to input -- and the
  // structured path must not turn it into a successful result a caller
  // could record as a run with no output.
  const replyAbsent =
    typeof parsed.envelope.result !== "string" ||
    parsed.envelope.result.trim() === "";
  const block = (): CodemuxResultBlock => ({
    agent,
    labels: request.labels ?? null,
    // The served model when the envelope names it, else the model codemux
    // selected, else null: the harness default, which nothing reported.
    // Several modelUsage entries are a report in the other direction -- the
    // run was served by more than one model -- so the requested model must
    // not stand in; only a run that names no models at all falls back.
    model: parsed.multipleModels
      ? null
      : parsed.servedModel ?? request.model ?? null,
    usage: parsed.usage,
    // Always null in this release: the adapter passes
    // --no-session-persistence, so no run leaves a session a later resume
    // could reach (reserved for the live-sessions release; see types.ts).
    session_id: null,
    // The experiment bridge's JSONL path on an --experiment-mcp run, so the
    // caller can find the recording without scraping stderr; null otherwise.
    recording,
  });
  if (parsed.isError) {
    // The subtype is the specific reason when the envelope names one; the
    // bare flag is the whole reason when it does not.
    const reason =
      parsed.errorSubtype !== null
        ? `subtype "${parsed.errorSubtype}"`
        : "is_error: true";
    return {
      ...result,
      stdout: `${JSON.stringify({ ...parsed.envelope, codemux: block() })}\n`,
      stderr: appendDiagnostic(
        result.stderr,
        `codemux: ${agent} reported an error result ` +
          `(${reason}), so this run fails even though the harness exited ` +
          `${result.exitCode}`
      ),
      exitCode: result.exitCode === 0 ? 1 : result.exitCode,
      success: false,
      // The envelope's numbers are still the harness's own record: the
      // ledger writes what was reported, even on a failed run.
      usage: parsed.usage,
      servedModel: parsed.multipleModels ? null : parsed.servedModel,
    };
  }
  if (replyAbsent) {
    // Fail closed: the envelope still goes out with the block attached (its
    // fields are the harness's own record), but the run reports no result.
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
      servedModel: parsed.multipleModels ? null : parsed.servedModel,
    };
  }
  return {
    ...result,
    stdout: `${JSON.stringify({ ...parsed.envelope, codemux: block() })}\n`,
    usage: parsed.usage,
    servedModel: parsed.multipleModels ? null : parsed.servedModel,
  };
}
