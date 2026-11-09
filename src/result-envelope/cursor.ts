import type { CodemuxResultBlock, ResultUsageBlock, RunRequest, RunResult } from "../types.js";
import {
  appendDiagnostic,
  boundResultEnvelope,
  emptyUsage,
  reportedTokenCount,
  safeTokenSum,
} from "./common.js";

/**
 * Parses the stream-json wire every cursor run launches with
 * (`cursor-agent --print --output-format stream-json`, 2026.11.05, read
 * 2026-11-09 against versions/2026.11.05-86047df/1706.index.js):
 *
 * - The format gates are `B="stream-json"===N.outputFormat`,
 *   `q="json"===N.outputFormat`, `W="text"===N.outputFormat` (offsets
 *   570928–570980). All three result-writer branches (≈584026) print
 *   `{type:"result",subtype:"success",duration_ms,duration_api_ms,
 *   is_error:!1,result:K||"",session_id,request_id,...ce?{usage:ce}:{}}`,
 *   where K is the FULL accumulated reply text (every textDelta appends to
 *   it, offset 571017 area) — so a tool-using run's reply, the segments
 *   before the tool calls included, rides `result` verbatim. The text
 *   branch (W) instead prints only `de`, the buffer after the last tool
 *   call: a tool-using run that ended without trailing prose exited 0 with
 *   stdout "\n" — the defect this wire exists to close. A failed run
 *   prints NO result line: the error goes to stderr and the process exits
 *   1.
 * - Per model call, stream-json also prints
 *   `{type:"usage",subtype:"model_call",model_call_id,usage:$(…),session_id,
 *   timestamp_ms}` (modelCallCompleted writer, ≈576275). The mapper `$`
 *   (offset 570487) is `{...e,inputTokens:Math.max(e.inputTokens-
 *   e.cacheReadTokens-e.cacheWriteTokens,0)}` — camelCase keys, and the
 *   inputTokens count is NET of both cache counters. The result line's own
 *   `usage` is `ce`, the LAST call's mapped object (`r&&(ce=r)` at ≈584026
 *   — an overwrite, not a sum), so a multi-call run under-reports through
 *   the result line alone; the honest ledger sums the model_call events
 *   and falls back to the result line only when the stream carried none.
 * - Assistant text arrives as delta events
 *   `{type:"assistant",message:{role:"assistant",content:[{type:"text",
 *   text:<delta>}]},session_id}`; the result line's `result` already folds
 *   them, so the parser reads it instead of re-joining deltas.
 * - No event carries a model name (the model_call usage event and the
 *   result line both omit it), so served_model stays null.
 */
/** The field cursor's --result-json envelope spells its answer text with;
 * the harness's own result object names it `result`. */
export const CURSOR_ANSWER_FIELD = "result";

export interface CursorEnvelopeInfo {
  answer: string | null;
  usage: ResultUsageBlock;
  sessionId: string | null;
  /** The result line's subtype, when a line arrived. */
  subtype: string | null;
  isError: boolean;
}

/** One model_call usage event's wire object: the mapper `$`'s output —
 * camelCase, inputTokens NET of the cache counters. */
function cursorUsageEvent(usage: unknown): ResultUsageBlock | null {
  if (typeof usage !== "object" || usage === null) return null;
  const wire = usage as Record<string, unknown>;
  if (
    reportedTokenCount(wire.inputTokens) === null &&
    reportedTokenCount(wire.outputTokens) === null &&
    reportedTokenCount(wire.cacheReadTokens) === null &&
    reportedTokenCount(wire.cacheWriteTokens) === null
  ) {
    return null;
  }
  return normalizeCursorUsage(wire);
}

/** Maps one cursor usage object (result line or model_call event) onto the
 * ledger block: input is the wire's NET inputTokens, cached is the sum of
 * the two cache counters, total folds all three. */
export function normalizeCursorUsage(wire: Record<string, unknown>): ResultUsageBlock {
  const usage = emptyUsage();
  const input = reportedTokenCount(wire.inputTokens);
  const output = reportedTokenCount(wire.outputTokens);
  const cacheCounts = [reportedTokenCount(wire.cacheReadTokens), reportedTokenCount(wire.cacheWriteTokens)]
    .filter((count): count is number => count !== null);
  usage.input_tokens = input;
  usage.output_tokens = output;
  usage.cached_input_tokens = safeTokenSum(...cacheCounts);
  usage.total_tokens = safeTokenSum(
    ...[input, output, usage.cached_input_tokens]
      .filter((count): count is number => count !== null)
  );
  return usage;
}

/** Sums a field across the run's model_call events: the result line's
 * usage is the LAST call's object, so multi-call runs need the event sum. */
function sumUsages(events: ResultUsageBlock[]): ResultUsageBlock {
  const usage = emptyUsage();
  const field = (pick: (block: ResultUsageBlock) => number | null): number | null =>
    safeTokenSum(
      ...events.map(pick).filter((count): count is number => count !== null)
    );
  usage.input_tokens = field((block) => block.input_tokens);
  usage.output_tokens = field((block) => block.output_tokens);
  usage.cached_input_tokens = field((block) => block.cached_input_tokens);
  usage.total_tokens = field((block) => block.total_tokens);
  return usage;
}

export function parseCursorResultEnvelope(stdout: string): CursorEnvelopeInfo | null {
  let last: Record<string, unknown> | null = null;
  let sessionId: string | null = null;
  const usageEvents: ResultUsageBlock[] = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (typeof parsed !== "object" || parsed === null) continue;
    const event = parsed as Record<string, unknown>;
    if (sessionId === null && typeof event.session_id === "string") {
      sessionId = event.session_id;
    }
    if (event.type === "usage" && event.subtype === "model_call") {
      const mapped = cursorUsageEvent(event.usage);
      if (mapped !== null) usageEvents.push(mapped);
    }
    if (event.type === "result") {
      last = event;
      if (typeof event.session_id === "string") sessionId = event.session_id;
    }
  }
  if (last === null) return null;
  const usage = usageEvents.length > 0
    ? sumUsages(usageEvents)
    : typeof last.usage === "object" && last.usage !== null
      ? normalizeCursorUsage(last.usage as Record<string, unknown>)
      : emptyUsage();
  return {
    answer: typeof last.result === "string" ? last.result : null,
    usage,
    sessionId,
    subtype: typeof last.subtype === "string" ? last.subtype : null,
    isError: last.is_error === true,
  };
}

/**
 * Finishes a `--result-json` run for cursor: the envelope re-emits the
 * harness's own result object — the answer under its native `result`
 * field, the usage, the session id — plus the codemux block. Stdout with
 * no result line breaks the contract the launch made (it ran with the
 * stream-json wire, and cursor prints no result line exactly when the run
 * failed), so the run fails loudly rather than passing the harness's
 * stderr through as a reply. A result line whose is_error is true or whose
 * subtype is not "success" fails the same way: the structured report is
 * read, not the process exit trusted.
 */
export function cursorResult(result: RunResult, request: RunRequest): RunResult {
  const agent = "cursor" as const;
  const parsed = parseCursorResultEnvelope(result.stdout);
  if (parsed === null) {
    return {
      ...result,
      stderr: appendDiagnostic(
        result.stderr,
        `codemux: ${agent} printed no result line, ` +
          "so this --result-json run carries no codemux block"
      ),
      exitCode: result.exitCode === 0 ? 1 : result.exitCode,
      success: false,
    };
  }
  const failure =
    parsed.isError
      ? `an error result (is_error)`
      : parsed.subtype !== null && parsed.subtype !== "success"
        ? `a ${parsed.subtype} result`
        : parsed.answer === null || parsed.answer.trim() === ""
          ? "no result text"
          : null;
  const block: CodemuxResultBlock = {
    agent,
    labels: request.labels ?? null,
    model_alias: request.modelAlias ?? null,
    model: request.model ?? null,
    served_model: null,
    usage: parsed.usage,
    session_id: parsed.sessionId,
    recording: null,
    failure_code: failure !== null ? "harness-error" : null,
  };
  const envelope = `${JSON.stringify({
    [CURSOR_ANSWER_FIELD]: parsed.answer ?? "",
    usage: parsed.usage,
    codemux: block,
  })}\n`;
  if (failure !== null) {
    return boundResultEnvelope(
      agent,
      {
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
        servedModel: null,
      },
      parsed.usage,
      null
    );
  }
  return boundResultEnvelope(
    agent,
    {
      ...result,
      stdout: envelope,
      usage: parsed.usage,
      servedModel: null,
    },
    parsed.usage,
    null
  );
}
