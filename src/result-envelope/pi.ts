import type { CodemuxResultBlock, ResultUsageBlock, RunRequest, RunResult } from "../types.js";
import {
  appendDiagnostic,
  boundResultEnvelope,
  emptyUsage,
  reportedCount,
  reportedTokenCount,
  safeTokenSum,
} from "./common.js";
import { markOverflowed } from "../usage-overflow.js";

/**
 * Parses the newline-separated event wire pi prints for a run launched
 * with `--print --mode json` (0.85.1): an optional `{type:"session",…}`
 * header line first (absent under `--no-session`, which every codemux run
 * passes), then one JSON line per session event. The events that carry
 * messages are `{type:"message_start"|"message_end", message}` — for the
 * user's own prompt as well, so only `message.role === "assistant"`
 * messages count. Evidence: chunk-JVUZSMYM.js, runPrintMode writes
 * `writeRawStdout(JSON.stringify(toJsonEvent(event)) + "\n")` per event
 * and `getHeader()` first; read 2026-11-09.
 *
 * The reply is the LAST assistant message_end's text content blocks,
 * concatenated in order — the same message text mode prints (its tail
 * walks `state.messages` for the last assistant message and writes each
 * `content.type === "text"` block). An assistant message whose
 * `stopReason` is "error" or "aborted" failed: text mode prints
 * `errorMessage` to stderr and exits 1, and the envelope fails the same
 * way. Usage is summed over every assistant message_end — each assistant
 * message is one completed model response whose `usage` reports
 * `{input, output, cacheRead, cacheWrite, totalTokens, cost:{…,total}}`
 * in camelCase, where `input` already excludes the cache (the faux
 * provider computes `input = promptTokens - cacheRead`). The assistant
 * message also carries `model`, the provider's own name for what served
 * it: one distinct value across messages becomes served_model.
 */
/** The field pi's --result-json envelope spells its answer text with; pi's
 * wire is event lines with no single native result field, so the envelope
 * uses the family name (kimi and opencode spell it the same way). */
export const PI_ANSWER_FIELD = "reply";

export interface PiEnvelopeInfo {
  answer: string | null;
  usage: ResultUsageBlock;
  servedModel: string | null;
  /** The last assistant message's stopReason, when it names a failure. */
  stopReason: string | null;
  errorText: string | null;
}

interface UsageSum {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  costUsd: number | null;
  complete: boolean;
}

function recordUsage(sums: UsageSum, reported: unknown): void {
  if (typeof reported !== "object" || reported === null) {
    sums.complete = false;
    return;
  }
  const counts = reported as Record<string, unknown>;
  const input = reportedTokenCount(counts.input);
  const output = reportedTokenCount(counts.output);
  const cacheRead = reportedTokenCount(counts.cacheRead);
  const cacheWrite = reportedTokenCount(counts.cacheWrite);
  if (input !== null) sums.input += input;
  if (output !== null) sums.output += output;
  if (cacheRead !== null) sums.cacheRead += cacheRead;
  if (cacheWrite !== null) sums.cacheWrite += cacheWrite;
  sums.complete =
    sums.complete && input !== null && output !== null && cacheRead !== null && cacheWrite !== null;
  const cost =
    typeof counts.cost === "object" && counts.cost !== null
      ? reportedCount((counts.cost as Record<string, unknown>).total)
      : null;
  // Dollars, not tokens: a plain finite sum, never an integer-only check.
  if (cost !== null) sums.costUsd = (sums.costUsd ?? 0) + cost;
}

function summedUsage(sums: UsageSum): ResultUsageBlock {
  const usage = emptyUsage();
  if (!sums.complete) return usage;
  usage.input_tokens = sums.input;
  usage.output_tokens = sums.output;
  const cached = safeTokenSum(sums.cacheRead, sums.cacheWrite);
  if (cached === null) {
    markOverflowed(usage, ["cached_input_tokens"]);
    return usage;
  }
  usage.cached_input_tokens = cached;
  usage.total_tokens = safeTokenSum(usage.input_tokens, cached, usage.output_tokens);
  usage.cost_usd = sums.costUsd;
  return usage;
}

function assistantText(message: Record<string, unknown>): string | null {
  if (!Array.isArray(message.content)) return null;
  const parts: string[] = [];
  for (const block of message.content) {
    if (typeof block === "object" && block !== null) {
      const typed = block as Record<string, unknown>;
      if (typed.type === "text" && typeof typed.text === "string") parts.push(typed.text);
    }
  }
  return parts.length > 0 ? parts.join("\n") : null;
}

export function parsePiResultEnvelope(stdout: string): PiEnvelopeInfo | null {
  let sawWire = false;
  let answer: string | null = null;
  let stopReason: string | null = null;
  let errorText: string | null = null;
  const models = new Set<string>();
  const sums: UsageSum = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: null, complete: true };
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
    sawWire = true;
    if (event.type !== "message_end") continue;
    const message = event.message;
    if (typeof message !== "object" || message === null) continue;
    const typed = message as Record<string, unknown>;
    if (typed.role !== "assistant") continue;
    // Only the LAST assistant message becomes the reply; earlier ones
    // (tool-use rounds) still contribute their usage and model.
    answer = assistantText(typed);
    stopReason = typeof typed.stopReason === "string" ? typed.stopReason : null;
    errorText = typeof typed.errorMessage === "string" ? typed.errorMessage : null;
    if (typeof typed.model === "string") models.add(typed.model);
    recordUsage(sums, typed.usage);
  }
  if (!sawWire) return null;
  return {
    answer,
    usage: summedUsage(sums),
    servedModel: models.size === 1 ? [...models][0]! : null,
    stopReason,
    errorText,
  };
}

/**
 * Finishes a `--result-json` run for pi: the envelope is codemux's own —
 * the event lines are a transcript, not a result object, so the envelope
 * carries the folded reply, the summed usage, and the codemux block (the
 * kimi/opencode/copilot shape; the raw events are never re-emitted, so no
 * volume of tool output reaches the capture bound). Stdout with no JSON
 * lines at all breaks the contract the launch made (it ran with
 * `--mode json`), so the run fails loudly. A wire with no assistant
 * message fails too — the harness exited without a reply — and so does a
 * final assistant message whose stopReason names a failure ("error",
 * "aborted"): the structured report is read, not the process exit trusted.
 */
export function piResult(result: RunResult, request: RunRequest): RunResult {
  const agent = "pi" as const;
  const parsed = parsePiResultEnvelope(result.stdout);
  if (parsed === null) {
    return {
      ...result,
      stderr: appendDiagnostic(
        result.stderr,
        `codemux: ${agent} printed no wire events, ` +
          "so this --result-json run carries no codemux block"
      ),
      exitCode: result.exitCode === 0 ? 1 : result.exitCode,
      success: false,
    };
  }
  const failure =
    parsed.stopReason === "error" || parsed.stopReason === "aborted"
      ? `a ${parsed.stopReason} stop (${parsed.errorText ?? "no error message"})`
      : parsed.answer === null || parsed.answer.trim() === ""
        ? "no assistant message"
        : null;
  const block: CodemuxResultBlock = {
    agent,
    labels: request.labels ?? null,
    model_alias: request.modelAlias ?? null,
    model: request.model ?? null,
    served_model: parsed.servedModel,
    usage: parsed.usage,
    session_id: null,
    recording: null,
    failure_code: failure !== null ? "harness-error" : null,
  };
  const envelope = `${JSON.stringify({ [PI_ANSWER_FIELD]: parsed.answer ?? "", usage: parsed.usage, codemux: block })}\n`;
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
        servedModel: parsed.servedModel,
      },
      parsed.usage,
      parsed.servedModel
    );
  }
  return boundResultEnvelope(
    agent,
    {
      ...result,
      stdout: envelope,
      usage: parsed.usage,
      servedModel: parsed.servedModel,
    },
    parsed.usage,
    parsed.servedModel
  );
}
