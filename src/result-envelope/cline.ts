import type { CodemuxResultBlock, RunRequest, RunResult } from "../types.js";
import {
  appendDiagnostic, boundResultEnvelope, emptyUsage, reportedCount, reportedTokenCount, safeTokenSum,
} from "./common.js";
import { AnswerCollector, answerBlockFields, completeAnswer, withTruncationNotice } from "../answer-complete.js";

// Cline cli-v3.0.74, read 2026-11-09:
// https://github.com/cline/cline/blob/cli-v3.0.74/apps/cli/src/runtime/run-agent.ts#L369-L379
// run_result carries finishReason, usage, aggregateUsage, text, and model.
// run_start at L53-L62 carries the sessionId; modelId there is only configuration.
export const CLINE_ANSWER_FIELD = "text";

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

export function normalizeClineUsage(value: unknown) {
  const wire = record(value);
  const usage = emptyUsage();
  if (wire !== null) {
    // Cline inputTokens includes cache; subtract it only when both counts exist.
    // cli-v3.0.74 (read 2026-11-09), pricing uses the same subtraction:
    // https://github.com/cline/cline/blob/cli-v3.0.74/sdk/packages/llms/src/providers/ai-sdk.ts#L1156-L1184
    const input = reportedTokenCount(wire.inputTokens);
    const read = reportedTokenCount(wire.cacheReadTokens);
    const write = reportedTokenCount(wire.cacheWriteTokens);
    usage.output_tokens = reportedTokenCount(wire.outputTokens);
    usage.cost_usd = reportedCount(wire.totalCost);
    if (read !== null && write !== null) usage.cached_input_tokens = safeTokenSum(read, write);
    if (input !== null && usage.cached_input_tokens !== null && input >= usage.cached_input_tokens) {
      usage.input_tokens = input - usage.cached_input_tokens;
    }
    if (input !== null && usage.output_tokens !== null) usage.total_tokens = safeTokenSum(input, usage.output_tokens);
  }
  return usage;
}

/** One top-level `agent_event` line's part of the answer (lane AN1).
 * cli-v3.0.74 json mode prints every AgentEvent as
 * `{type:"agent_event",event}` (apps/cli/src/utils/events.ts handleEvent),
 * and the runtime adapter turns each assistant message into one
 * `content_end {contentType:"text", text}` carrying the message's whole
 * text (sdk/packages/core/src/runtime/orchestration/runtime-event-adapter.ts
 * translateAssistantMessage). A turn that ends without one (tool calls
 * only) is an empty message. No event carries a per-message stop reason,
 * so `truncated` stays false. */
function collectClineEvent(collector: AnswerCollector, event: Record<string, unknown>, turn: { text: boolean }): void {
  const inner = record(event.event);
  if (inner === null) return;
  if (inner.type === "iteration_start") turn.text = false;
  else if (inner.type === "content_end" && inner.contentType === "text" && typeof inner.text === "string") {
    collector.message(inner.text);
    turn.text = true;
  } else if (inner.type === "iteration_end" && !turn.text) collector.message("");
}

export function parseClineResultEnvelope(stdout: string) {
  let result: Record<string, unknown> | null = null;
  let sessionId: string | null = null;
  const collector = new AnswerCollector();
  const turn = { text: false };
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event: Record<string, unknown> | null;
    try { event = record(JSON.parse(line)); } catch { return null; }
    if (!event || typeof event.type !== "string") return null;
    // A signal can arrive after the model completed. Native run-agent emits
    // run_aborted after run_result without changing that result's reason.
    // https://github.com/cline/cline/blob/cli-v3.0.74/apps/cli/src/runtime/run-agent.ts#L382-L399
    if (event.type === "run_aborted" || event.type === "run_abort_requested") return null;
    if (event.type === "run_start" && typeof event.sessionId === "string") {
      if (sessionId !== null && sessionId !== event.sessionId) return null;
      sessionId = event.sessionId;
    }
    if (event.type === "agent_event") collectClineEvent(collector, event, turn);
    if (event.type === "run_result") {
      if (result !== null) return null;
      result = event;
    }
  }
  if (result === null) return null;
  const wire = record(result.aggregateUsage) ?? record(result.usage);
  const usage = normalizeClineUsage(wire);
  const transcript = collector.transcript();
  const harnessText = typeof result.text === "string" ? result.text : null;
  return {
    answer: completeAnswer(transcript, harnessText),
    transcript,
    harnessText,
    usage,
    sessionId,
    // cli-v3.0.74 constructs model.id from this.config.modelId, not the response:
    // https://github.com/cline/cline/blob/cli-v3.0.74/sdk/packages/core/src/runtime/orchestration/session-runtime-orchestrator.ts#L1630-L1632
    servedModel: null as string | null,
    finishReason: typeof result.finishReason === "string" ? result.finishReason : null,
  };
}

export function clineResult(result: RunResult, request: RunRequest, recording: string | null = null, scanSurface?: string): RunResult {
  const parsed = parseClineResultEnvelope(result.stdout);
  const failure = parsed === null ? "invalid or missing run_result"
    : parsed.finishReason !== "completed" ? `finishReason ${parsed.finishReason ?? "missing"}`
    : !parsed.answer?.trim() ? "empty answer" : null;
  const usage = parsed?.usage ?? emptyUsage();
  const block: CodemuxResultBlock = {
    agent: "cline", labels: request.labels ?? null, model: request.model ?? null,
    model_alias: request.modelAlias ?? null, served_model: parsed?.servedModel ?? null,
    usage, session_id: parsed?.sessionId ?? null, recording,
    failure_code: failure === null ? null : "harness-error",
    ...answerBlockFields(parsed?.transcript ?? null, parsed?.harnessText ?? null),
  };
  const normalized = {
    ...result, usage, servedModel: block.served_model,
    ...(scanSurface === undefined ? {} : { scanSurface }),
    stdout: request.resultJson
      ? JSON.stringify({ text: parsed?.answer ?? "", codemux: block }) + "\n"
      : parsed?.answer ?? "",
    ...(failure === null ? {} : {
      success: false, exitCode: result.exitCode || 1,
      stderr: appendDiagnostic(result.stderr, `codemux: cline reported ${failure}`),
    }),
  };
  return boundResultEnvelope("cline", withTruncationNotice(normalized, "cline", parsed?.transcript ?? null),
    usage, block.served_model);
}
