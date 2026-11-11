import type { CodemuxResultBlock, ResultUsageBlock, RunRequest, RunResult } from "../types.js";
import {
  appendDiagnostic,
  boundResultEnvelope,
  emptyUsage,
  reportedCount,
  reportedTokenCount,
  safeTokenSum,
} from "./common.js";
import { answerBlockFields, withTruncationNotice, type AnswerTranscript } from "../answer-complete.js";
import { parseGooseTranscript, type GooseTranscript } from "../goose-answer.js";

/**
 * Parses goose's output. Every run launches with `--output-format
 * stream-json` (1.50.1 `run --output-format <text|json|stream-json>`; lane
 * AN1), read by src/goose-answer.ts. Native JSON is `{messages, metadata}`;
 * the startup banner supplies the session ID. Legacy single-message
 * captures remain accepted. For message usage, the exact
 * field order is not recoverable from the compiled binary, so the parser
 * reads the names the binary itself carries (read from `strings` on the
 * installed 1.50.1 binary, 2026-11-09): the MessageUsage struct's
 * camelCase serde keys `inputTokens, outputTokens, totalTokens,
 * cacheReadTokens, cacheWriteTokens` under a `usage` object, and the
 * message's own `content` field for the text (both a plain string and the
 * common {type:"text",text} part list are accepted; the binary carries
 * both shapes for message content). The session ledger's snake_case column
 * names (`total_tokens`, `input_tokens`, `output_tokens`,
 * `cache_read_tokens`, `cache_write_tokens`) are accepted as aliases: the
 * same binary serializes both spellings depending on the surface.
 *
 * `inputTokens` is the provider's prompt count, which includes the
 * cache-read tokens (the OpenAI-compatible usage semantics goose's
 * providers report), so the uncached input is the raw value minus the
 * cache reads — the agy rule.
 *
 * The full MessageUsage struct carries ten fields (1.50.1 embedded
 * strings, read 2026-11-09): inputTokens, outputTokens, totalTokens,
 * cacheReadTokens, cacheWriteTokens, cost, costSource, elapsedMs,
 * timeToFirstTokenMs, isCompaction. The `cost` value rides the ledger's
 * cost_usd when the report carries one; `costSource` names its provenance
 * (the CostSource enum's two values, provider_reported and estimated).
 *
 * The served model rides the message's metadata: MessageMetadata carries
 * an `inference` object of the InferenceMetadata struct's four fields —
 * provider, requestedModel, resolvedModel, providerSessionId (1.50.1
 * embedded strings, read 2026-11-09) — and resolvedModel is the id the
 * provider answered under, so it is the served-model evidence.
 */
/** The field goose's --result-json envelope spells its answer text with;
 * the harness's own message struct names its text `content`. The release
 * gate's probe C verifies this exact field per agent, so the parser and
 * the gate share one name (review round 16, edges 3). */
export const GOOSE_ANSWER_FIELD = "content";

export interface GooseEnvelopeInfo {
  envelope: Record<string, unknown>;
  answer: string | null;
  usage: ResultUsageBlock;
  /** metadata.inference.resolvedModel, when the message carried it. */
  servedModel: string | null;
  sessionId: string | null;
  /** The assistant messages a stream or `{messages}` object carried; null
   * for the single-message object. */
  transcript: AnswerTranscript | null;
  /** The last assistant message's text alone. */
  finalText: string | null;
  /** A stream `error` event's text. */
  errorMessage: string | null;
}

/** Reads metadata.inference.resolvedModel — the InferenceMetadata field
 * the provider's answer resolved under; any other shape is no evidence. */
function gooseServedModel(envelope: Record<string, unknown>): string | null {
  if (typeof envelope.metadata !== "object" || envelope.metadata === null) return null;
  const metadata = envelope.metadata as Record<string, unknown>;
  if (typeof metadata.inference !== "object" || metadata.inference === null) return null;
  const inference = metadata.inference as Record<string, unknown>;
  return typeof inference.resolvedModel === "string" ? inference.resolvedModel : null;
}

function readCount(record: Record<string, unknown>, camel: string, snake: string): number | null {
  const camelValue = reportedTokenCount(record[camel]);
  if (camelValue !== null) return camelValue;
  return reportedTokenCount(record[snake]);
}

function normalizeGooseUsage(reported: Record<string, unknown>): ResultUsageBlock {
  const usage = emptyUsage();
  const input = readCount(reported, "inputTokens", "input_tokens");
  const output = readCount(reported, "outputTokens", "output_tokens");
  const cacheRead = readCount(reported, "cacheReadTokens", "cache_read_tokens");
  const cacheWrite = readCount(reported, "cacheWriteTokens", "cache_write_tokens");
  // The raw input includes the cache reads (the provider's prompt count);
  // one-sided reports stay null rather than guessing the missing half, and
  // a cache count above the input is an inconsistent snapshot (round 104).
  if (input !== null && cacheRead !== null && input >= cacheRead) {
    usage.input_tokens = input - cacheRead;
  }
  usage.output_tokens = output;
  if (cacheRead !== null && cacheWrite !== null) {
    usage.cached_input_tokens = safeTokenSum(cacheRead, cacheWrite);
  }
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
  // MessageUsage's `cost` field (its costSource names the provenance:
  // provider_reported or estimated); absent stays null, never zero.
  usage.cost_usd = reportedCount(reported.cost) ?? reportedCount(reported.cost_usd);
  return usage;
}

/** Extracts the answer text from a goose message's `content`: a plain
 * string, or a list of parts whose text fields are joined. Any other
 * shape is no answer. */
function gooseAnswer(envelope: Record<string, unknown>): string | null {
  const content = envelope[GOOSE_ANSWER_FIELD];
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const part of content) {
      if (typeof part === "object" && part !== null && typeof (part as Record<string, unknown>).text === "string") {
        parts.push((part as Record<string, unknown>).text as string);
      }
    }
    if (parts.length > 0) return parts.join("");
  }
  return null;
}

/** The last JSON object line of stdout: goose prints its progress lines
 * around the final object in every mode, so the LAST parseable object
 * line is the result. Lines that do not parse are skipped, not fatal —
 * the binary prints human-readable status around the object. */
/** The envelope info of a transcript: usage summed over the assistant
 * messages (the last report per message id, since streamed chunks of one
 * reply share it), the stream's `complete` total as a fallback, and the
 * last message's resolved model. */
function transcriptInfo(read: GooseTranscript): GooseEnvelopeInfo {
  const perMessage = new Map<unknown, Record<string, unknown>>();
  let sawUsage = false;
  read.messages.forEach((message, index) => {
    const metadata = typeof message.metadata === "object" && message.metadata !== null
      ? message.metadata as Record<string, unknown> : null;
    const reported = metadata?.usage ?? message.usage;
    const key = typeof message.id === "string" ? message.id : index;
    if (typeof reported === "object" && reported !== null) {
      sawUsage = true;
      perMessage.set(key, reported as Record<string, unknown>);
    } else if (!perMessage.has(key)) {
      perMessage.set(key, {});
    }
  });
  let usage: ResultUsageBlock | null = null;
  for (const reported of perMessage.values()) {
    const next = normalizeGooseUsage(reported);
    usage = usage === null ? next : sumGooseUsage(usage, next);
  }
  usage ??= emptyUsage();
  if (!sawUsage && read.complete !== null) {
    usage = normalizeGooseUsage({ ...read.complete,
      cache_read_tokens: read.complete.cache_read_input_tokens,
      cache_write_tokens: read.complete.cache_write_input_tokens });
    usage.total_tokens = reportedTokenCount(read.complete.total_tokens) ?? usage.total_tokens;
  }
  const last = read.messages[read.messages.length - 1];
  return {
    envelope: last ?? {},
    answer: read.answer,
    usage,
    servedModel: last === undefined ? null : gooseServedModel(last),
    sessionId: read.sessionId ?? (last !== undefined && typeof last.session_id === "string" ? last.session_id : null),
    transcript: read.transcript,
    finalText: read.finalText,
    errorMessage: read.errorMessage,
  };
}

function sumGooseUsage(a: ResultUsageBlock, b: ResultUsageBlock): ResultUsageBlock {
  const add = (x: number | null, y: number | null): number | null => x === null || y === null ? null : safeTokenSum(x, y);
  return {
    input_tokens: add(a.input_tokens, b.input_tokens),
    output_tokens: add(a.output_tokens, b.output_tokens),
    cached_input_tokens: add(a.cached_input_tokens, b.cached_input_tokens),
    total_tokens: add(a.total_tokens, b.total_tokens),
    cost_usd: a.cost_usd === null || b.cost_usd === null ? null : reportedCount(a.cost_usd + b.cost_usd),
  };
}

export function parseGooseResultEnvelope(stdout: string): GooseEnvelopeInfo | null {
  const read = parseGooseTranscript(stdout);
  if (read !== null) return transcriptInfo(read);
  let envelope: Record<string, unknown> | null = null;
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      envelope = parsed as Record<string, unknown>;
    }
  }
  if (envelope === null) return null;
  const usageSource =
    typeof envelope.usage === "object" && envelope.usage !== null
      ? (envelope.usage as Record<string, unknown>)
      : envelope;
  const answer = gooseAnswer(envelope);
  return {
    envelope,
    answer,
    usage: normalizeGooseUsage(usageSource),
    servedModel: gooseServedModel(envelope),
    sessionId: typeof envelope.session_id === "string" ? envelope.session_id : null,
    transcript: null,
    finalText: answer,
    errorMessage: null,
  };
}

/**
 * Finishes a `--result-json` run for goose: the envelope is codemux's own —
 * the folded answer text, the usage off the message's usage report, and
 * the codemux block (the raw lines are not re-emitted; their field set is
 * not pinned by any live capture). Stdout with no stream event or message
 * object breaks the contract the launch made (it ran with
 * `--output-format stream-json`), so the run fails loudly. An object with no answer text fails too: the
 * harness exited without a reply.
 */
/** `recording` is the experiment run's JSONL path (null outside an
 * experiment run), the field every experiment harness's envelope carries. */
export function gooseResult(result: RunResult, request: RunRequest, recording: string | null = null): RunResult {
  const agent = "goose" as const;
  const parsed = parseGooseResultEnvelope(result.stdout);
  if (parsed === null) {
    return {
      ...result,
      stderr: appendDiagnostic(
        result.stderr,
        `codemux: ${agent} printed no result object, ` +
          "so this --result-json run carries no codemux block"
      ),
      exitCode: result.exitCode === 0 ? 1 : result.exitCode,
      success: false,
    };
  }
  const failure = parsed.errorMessage !== null
    ? `an error (${parsed.errorMessage})`
    : parsed.answer === null || parsed.answer.trim() === "" ? "no message content" : null;
  // The message's metadata.inference.resolvedModel is the served-model
  // evidence; when the message carried none, the block reports the model
  // codemux selected and served_model stays null.
  const block: CodemuxResultBlock = {
    agent,
    labels: request.labels ?? null,
    model_alias: request.modelAlias ?? null,
    model: request.model ?? null,
    served_model: parsed.servedModel,
    usage: parsed.usage,
    session_id: parsed.sessionId,
    recording,
    failure_code: failure !== null ? "harness-error" : null,
    ...answerBlockFields(parsed.transcript, parsed.finalText),
  };
  const envelope = `${JSON.stringify({ [GOOSE_ANSWER_FIELD]: parsed.answer ?? "", usage: parsed.usage, codemux: block })}\n`;
  if (failure !== null) {
    // A failed run still prints the length-stop line the block reports.
    return boundResultEnvelope(
      agent,
      withTruncationNotice({
        ...result,
        stdout: envelope,
        stderr: appendDiagnostic(
          result.stderr,
          `codemux: ${agent} reported ${failure}, ` +
            `so this --result-json run fails even though the harness exited ${result.exitCode}`
        ),
        exitCode: result.exitCode === 0 ? 1 : result.exitCode,
        success: false,
        usage: parsed.usage,
        servedModel: parsed.servedModel,
      }, agent, parsed.transcript),
      parsed.usage,
      parsed.servedModel
    );
  }
  return boundResultEnvelope(
    agent,
    withTruncationNotice({
      ...result,
      stdout: envelope,
      usage: parsed.usage,
      servedModel: parsed.servedModel,
    }, agent, parsed.transcript),
    parsed.usage,
    parsed.servedModel
  );
}

/** A plain goose run on the stream-json wire: the complete answer on
 * stdout, at the end. Stdout that carries no stream event or message
 * object stays as diagnostics and fails result-empty because it proves
 * no assistant answer; a stream error fails the run with its reason. */
export function goosePlainResult(result: RunResult): RunResult {
  const read = parseGooseTranscript(result.stdout);
  if (read === null) return { ...result, reply: "" };
  const info = transcriptInfo(read);
  const answer = info.answer ?? "";
  const stdout = answer === "" || answer.endsWith("\n") ? answer : `${answer}\n`;
  if (info.errorMessage !== null) {
    return withTruncationNotice({
      ...result,
      stdout,
      stderr: appendDiagnostic(result.stderr,
        `codemux: goose reported an error (${info.errorMessage}), so this run fails even though the harness exited ${result.exitCode}`),
      exitCode: result.exitCode === 0 ? 1 : result.exitCode,
      success: false,
      usage: info.usage,
      servedModel: info.servedModel,
    }, "goose", info.transcript);
  }
  return withTruncationNotice({ ...result, stdout, usage: info.usage, servedModel: info.servedModel }, "goose", info.transcript);
}
