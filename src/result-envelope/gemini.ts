import type { CodemuxResultBlock, ResultUsageBlock, RunRequest, RunResult } from "../types.js";
import { geminiTelemetryServedModel } from "../gemini-telemetry.js";
import {
  appendDiagnostic,
  boundResultEnvelope,
  emptyUsage,
  reportedTokenCount,
  safeTokenSum,
} from "./common.js";

/**
 * Parses the single JSON object gemini prints for a run launched with
 * `--output-format json` (0.60.0): the final JsonFormatter output
 * `{session_id?, response?, stats?, error?, warnings?}` — one object on
 * stdout, with the streaming events forced to stderr. Evidence: the
 * installed bundle's JsonFormatter.format(sessionId, response, stats,
 * error, warnings) at 0.60.0
 * (@google/gemini-cli/bundle/chunk-M6NSK26M.js:380509, read
 * 2026-11-09). `stats` is `{total_tokens, input_tokens, output_tokens,
 * cached, input, duration_ms, tool_calls, models: {<model>: {...}}}`
 * (bundle/chunk-M6NSK26M.js:380563 convertToStreamStats), where `input_tokens`
 * accumulates the API's promptTokenCount — which INCLUDES the
 * cachedContentTokenCount — and `cached` accumulates that same count, so
 * the raw input minus the cache reads is the uncached input (the agy rule).
 * `stats.input` is a second accumulator of unstated semantics and is
 * deliberately unused. Returns null when stdout is not that object, and the
 * caller treats that as the contract violation it is.
 */
/** The field gemini's --result-json envelope spells its answer text with;
 * the envelope is the harness's own, re-emitted verbatim with the codemux
 * block. The release gate's probe C verifies this exact field per agent,
 * so the parser and the gate share one name (review round 16, edges 3). */
export const GEMINI_ANSWER_FIELD = "response";

/** Experiments need stream-json identities while ordinary runs use json.
 * Verification precedes this conversion; never infer a served model from
 * init.model, which is only the configured model. */
export function geminiExperimentResult(result: RunResult, request: RunRequest, recording?: string, telemetryPath?: string): RunResult {
  try {
    const events = result.stdout.split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line));
    const initial = events.find((event) => event.type === "init");
    const final = events.findLast((event) => event.type === "result");
    const response = events.filter((event) => event.type === "message" && event.role === "assistant" && typeof event.content === "string")
      .map((event) => event.content).join("");
    const envelope = { session_id: initial?.session_id, response, stats: final?.stats,
      ...(final?.status !== "success" ? { error: final?.error ?? "Gemini experiment has no successful terminal result" } : {}) };
    const converted = geminiResult({ ...result, stdout: JSON.stringify(envelope) }, request, telemetryPath);
    if (!request.resultJson) return { ...converted, stdout: response };
    const output = JSON.parse(converted.stdout);
    output.codemux.recording = recording ?? null;
    return { ...converted, stdout: `${JSON.stringify(output)}\n` };
  } catch {
    return { ...result, success: false, exitCode: result.exitCode || 1,
      stderr: appendDiagnostic(result.stderr, "codemux: Gemini experiment stdout is malformed") };
  }
}

export interface GeminiEnvelopeInfo {
  envelope: Record<string, unknown>;
  usage: ResultUsageBlock;
  /** The envelope's `error` object when it names one. */
  errorText: string | null;
  /** The envelope's session id, when it reports one. */
  sessionId: string | null;
}

export function parseGeminiResultEnvelope(stdout: string): GeminiEnvelopeInfo | null {
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
  // The discriminator: an envelope owes its answer text or its error.
  // `{"session_id": "..."}` alone says nothing about the run's outcome.
  if (typeof envelope.response !== "string" && envelope.error === undefined) {
    return null;
  }
  const errorText =
    typeof envelope.error === "string"
      ? envelope.error
      : envelope.error !== null && typeof envelope.error === "object" &&
          typeof (envelope.error as Record<string, unknown>).message === "string"
        ? String((envelope.error as Record<string, unknown>).message)
        : null;
  const sessionId = typeof envelope.session_id === "string" ? envelope.session_id : null;

  const usage =
    typeof envelope.stats === "object" && envelope.stats !== null
      ? geminiUsageFromStats(envelope.stats as Record<string, unknown>)
      : emptyUsage();

  return { envelope, usage, errorText, sessionId };
}

/** The stats object's token arithmetic, shared by the run envelope and the
 * session stream's result event (the same convertToStreamStats object):
 * `input_tokens` is the API's prompt count INCLUDING the cache reads, so
 * the uncached input is the raw value minus `cached` — a cache count above
 * the input is an inconsistent snapshot, so the uncached input is unknown
 * (null) rather than clamped, and with it the total (the agy rule, round
 * 104). One function, so the two surfaces cannot disagree. */
export function geminiUsageFromStats(stats: Record<string, unknown>): ResultUsageBlock {
  const usage = emptyUsage();
  const input = reportedTokenCount(stats.input_tokens);
  const output = reportedTokenCount(stats.output_tokens);
  const cached = reportedTokenCount(stats.cached);
  if (input !== null && cached !== null && input >= cached) {
    usage.input_tokens = input - cached;
  }
  usage.output_tokens = output;
  usage.cached_input_tokens = cached;
  if (
    usage.input_tokens !== null &&
    usage.cached_input_tokens !== null &&
    usage.output_tokens !== null
  ) {
    usage.total_tokens = safeTokenSum(
      usage.input_tokens,
      usage.cached_input_tokens,
      usage.output_tokens
    );
  }
  return usage;
}

/**
 * Finishes a `--result-json` run for gemini: the envelope is re-emitted
 * with every original field untouched plus the codemux block. Stdout that
 * is not the envelope breaks the contract the launch made (it ran with
 * `--output-format json`), so the run fails loudly — the raw stdout stays,
 * stderr says what is missing, and the exit is non-zero. An envelope with
 * an `error` fails the run the same way: the harness can fail while exiting
 * 0, and the structured report is read rather than the exit trusted. An
 * envelope whose response text is empty or whitespace-only fails too: a
 * reply of spaces and newlines is no reply. `session_id` is reported in the
 * codemux block when the envelope carries one: gemini's `--resume` accepts
 * exactly that id, so a caller can hand it back.
 */
export function geminiResult(result: RunResult, request: RunRequest, telemetryPath?: string): RunResult {
  const agent = "gemini" as const;
  const parsed = parseGeminiResultEnvelope(result.stdout);
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
  // The envelope's model keys have fallback semantics. Only the separate
  // raw-response telemetry can establish a provider-reported model.
  const servedModel = geminiTelemetryServedModel(telemetryPath, parsed.sessionId);
  const block = (): CodemuxResultBlock => ({
    agent,
    labels: request.labels ?? null,
    model_alias: request.modelAlias ?? null,
    model: request.model ?? null,
    served_model: servedModel,
    usage: parsed.usage,
    session_id: parsed.sessionId,
    recording: null,
    failure_code: null,
  });
  const serialized = `${JSON.stringify({ ...parsed.envelope, codemux: block() })}\n`;
  if (parsed.errorText !== null) {
    return boundResultEnvelope(
      agent,
      {
        ...result,
        stdout: serialized,
        stderr: appendDiagnostic(
          result.stderr,
          `codemux: ${agent} reported an error result (${parsed.errorText}), ` +
            `so this run fails even though the harness exited ${result.exitCode}`
        ),
        exitCode: result.exitCode === 0 ? 1 : result.exitCode,
        success: false,
        usage: parsed.usage,
        servedModel,
      },
      parsed.usage,
      servedModel
    );
  }
  const response =
    typeof parsed.envelope[GEMINI_ANSWER_FIELD] === "string"
      ? (parsed.envelope[GEMINI_ANSWER_FIELD] as string)
      : "";
  if (response.trim() === "") {
    return boundResultEnvelope(
      agent,
      {
        ...result,
        stdout: serialized,
        stderr: appendDiagnostic(
          result.stderr,
          `codemux: ${agent} printed an envelope with no ` +
            "result text, so this --result-json run reports no result"
        ),
        exitCode: result.exitCode === 0 ? 1 : result.exitCode,
        success: false,
        usage: parsed.usage,
        servedModel,
      },
      parsed.usage,
      servedModel
    );
  }
  return boundResultEnvelope(
    agent,
    {
      ...result,
      stdout: serialized,
      usage: parsed.usage,
      servedModel,
    },
    parsed.usage,
    servedModel
  );
}
