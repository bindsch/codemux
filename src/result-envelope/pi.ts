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
import { AnswerCollector, answerBlockFields, completeAnswer, withTruncationNotice, type AnswerTranscript } from "../answer-complete.js";
import { AnswerStreamFold, opensWith } from "../answer-stream-fold.js";

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
 * The reply is every assistant message_end's text after the last user
 * message_end, in order (lane AN1): text mode prints only the LAST
 * assistant message's text blocks (print-mode.js walks `state.messages`
 * for the last message), so a reply written before a tool call was lost,
 * and every codemux run now launches on the json wire. The last message's
 * text stays available as `finalText`; a `stopReason` of "length" on it
 * marks the answer truncated (pi-ai StopReason). An assistant message whose
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
  /** Every assistant message after the last user message. */
  transcript: AnswerTranscript;
  /** The last assistant message's text alone. */
  finalText: string | null;
}

interface UsageSum {
  input: number | null;
  output: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
  costUsd: number | null;
  complete: boolean;
  seen: boolean;
}

function recordUsage(sums: UsageSum, reported: unknown): void {
  const first = !sums.seen;
  sums.seen = true;
  if (typeof reported !== "object" || reported === null) {
    sums.complete = false;
    return;
  }
  const counts = reported as Record<string, unknown>;
  const input = reportedTokenCount(counts.input);
  const output = reportedTokenCount(counts.output);
  const cacheRead = reportedTokenCount(counts.cacheRead);
  const cacheWrite = reportedTokenCount(counts.cacheWrite);
  const add = (sum: number | null, count: number | null) =>
    sum === null || count === null ? null : safeTokenSum(sum, count);
  sums.input = add(sums.input, input);
  sums.output = add(sums.output, output);
  sums.cacheRead = add(sums.cacheRead, cacheRead);
  sums.cacheWrite = add(sums.cacheWrite, cacheWrite);
  sums.complete =
    sums.complete && input !== null && output !== null && cacheRead !== null && cacheWrite !== null;
  const cost =
    typeof counts.cost === "object" && counts.cost !== null
      ? reportedCount((counts.cost as Record<string, unknown>).total)
      : null;
  // Dollars, not tokens: a plain finite sum, never an integer-only check.
  sums.costUsd = first ? cost : sums.costUsd === null || cost === null ? null : reportedCount(sums.costUsd + cost);
}

function summedUsage(sums: UsageSum): ResultUsageBlock {
  const usage = emptyUsage();
  if (!sums.seen || !sums.complete) return usage;
  usage.input_tokens = sums.input;
  usage.output_tokens = sums.output;
  if (sums.input === null) markOverflowed(usage, ["input_tokens"]);
  if (sums.output === null) markOverflowed(usage, ["output_tokens"]);
  const cached = sums.cacheRead === null || sums.cacheWrite === null ? null : safeTokenSum(sums.cacheRead, sums.cacheWrite);
  if (cached === null) {
    markOverflowed(usage, ["cached_input_tokens"]);
  }
  usage.cached_input_tokens = cached;
  if (usage.input_tokens !== null && cached !== null && usage.output_tokens !== null) {
    usage.total_tokens = safeTokenSum(usage.input_tokens, cached, usage.output_tokens);
  }
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
  const sums: UsageSum = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: null, complete: true, seen: false };
  const collector = new AnswerCollector();
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
    if (typed.role === "user") {
      collector.userTurn();
      answer = stopReason = errorText = null;
    }
    if (typed.role !== "assistant") continue;
    // Every assistant message joins the answer; the last one's text stays
    // the final message, and every one contributes usage and model.
    answer = assistantText(typed);
    collector.message(answer ?? "", typed.stopReason);
    stopReason = typeof typed.stopReason === "string" ? typed.stopReason : null;
    errorText = typeof typed.errorMessage === "string" ? typed.errorMessage : null;
    if (typeof typed.model === "string") models.add(typed.model);
    recordUsage(sums, typed.usage);
  }
  if (!sawWire) return null;
  const transcript = collector.transcript();
  return {
    answer: completeAnswer(transcript, answer),
    transcript,
    finalText: answer,
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
      ? `an ${parsed.stopReason} stop (${parsed.errorText ?? "no error message"})`
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
    ...answerBlockFields(parsed.transcript, parsed.finalText),
  };
  const envelope = `${JSON.stringify({ [PI_ANSWER_FIELD]: parsed.answer ?? "", usage: parsed.usage, codemux: block })}\n`;
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
            `so this ${request.resultJson ? "--result-json run" : "run"} fails even though the harness exited ${result.exitCode}`
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

/** Pi's json lines the answer and the budget check never read: streaming
 * deltas, tool execution, the turn and agent summaries that repeat every
 * message, and a tool result's message_end (JSON.stringify writes `type`
 * first, and pi-agent-core builds a tool result message with `role`
 * first: agent-loop.js `role: "toolResult"`). Every other line is kept,
 * so a message object spelled in another order is read, never lost. */
const PI_SHED_PREFIXES = [
  '{"type":"message_update"', '{"type":"tool_execution_', '{"type":"turn_end"', '{"type":"agent_end"',
  '{"type":"message_start"', '{"type":"message_end","message":{"role":"toolResult"',
] as const;

/** The streaming fold a pi json run's stdout passes through. */
export function piStreamFold(): AnswerStreamFold {
  return new AnswerStreamFold((head) => opensWith(head, PI_SHED_PREFIXES) ? "drop" : "keep");
}

/** A plain pi run on the json wire: the complete answer on stdout. Stdout
 * with no JSON line stays as diagnostics and fails result-empty; the
 * failure rules are the envelope's. */
export function piPlainResult(result: RunResult, request: RunRequest): RunResult {
  if (parsePiResultEnvelope(result.stdout) === null) return { ...result, reply: "" };
  const processed = piResult(result, request);
  try {
    const envelope = JSON.parse(processed.stdout) as Record<string, unknown>;
    const reply = typeof envelope[PI_ANSWER_FIELD] === "string" ? envelope[PI_ANSWER_FIELD] as string : "";
    return { ...processed, stdout: reply === "" || reply.endsWith("\n") ? reply : `${reply}\n` };
  } catch {
    return { ...processed, stdout: "" };
  }
}
