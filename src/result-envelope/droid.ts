import type { CodemuxResultBlock, RunRequest, RunResult } from "../types.js";
import {
  appendDiagnostic,
  boundResultEnvelope,
  normalizeClaudeUsage,
} from "./common.js";
import { AnswerCollector, answerBlockFields, completeAnswer, withTruncationNotice, type AnswerTranscript } from "../answer-complete.js";
import { AnswerStreamFold, opensWith } from "../answer-stream-fold.js";

/**
 * Parses droid's exec wire. Every run launches with `exec -o stream-json`
 * (lane AN1): droid 0.221.0's exec writer prints one JSON line per event —
 * `{type:"system",subtype:"init",…}`, `{type:"message",role:"user"|
 * "assistant",id,text,…}` (one per non-empty text block), `tool_call`,
 * `tool_result`, `reasoning`, and on success a closing
 * `{type:"completion",finalText,numTurns,durationMs,session_id,usage}`;
 * a failed run prints `{type:"error",source,message,…}` and exits nonzero.
 * `finalText` is the LAST non-empty assistant text block only (function
 * `j` over the session's message events), and text mode prints just that,
 * so a reply written before the last tool call was lost: the answer is
 * assembled from every assistant message event instead. Evidence: the
 * droid 0.221.0 binary's exec dispatcher `Ne` (`if(s==="stream-json"||
 * s==="debug"){let c={type:"completion",finalText:t.finalText,…}`), the
 * stream callbacks (`"assistant-message":…le(y,D,X)` emitting
 * `{type:"message",role:"assistant",id:t.id,text:c.text,…}`), and the
 * error writer `Je` (`{type:"error",source:"cli",message,…}`), read
 * 2026-11-10. The stream names no stop reason, so `truncated` stays false.
 *
 * The single `-o json` result object (`{type:"result",subtype,is_error,
 * result,session_id,usage}`) is still accepted, for sessions and older
 * captures. The usage object is the claude-family shape plus droid-only
 * extras, so normalizeClaudeUsage maps the shared keys. No line carries a
 * model name, so served_model stays null.
 */
/** The field droid's --result-json envelope spells its answer text with;
 * the harness's own result object names it `result`. */
export const DROID_ANSWER_FIELD = "result";

export interface DroidEnvelopeInfo {
  /** The complete answer: every assistant message, or the result text. */
  answer: string | null;
  usage: ReturnType<typeof normalizeClaudeUsage>;
  sessionId: string | null;
  /** The result line's subtype, when a line arrived. */
  subtype: string | null;
  isError: boolean;
  /** The assistant messages the stream carried (null for a result object). */
  transcript: AnswerTranscript | null;
  /** The harness's own final text (`finalText` or `result`). */
  finalText: string | null;
  /** An error event's message, when the stream reported one. */
  errorMessage: string | null;
}

export function parseDroidResultEnvelope(stdout: string): DroidEnvelopeInfo | null {
  let last: Record<string, unknown> | null = null;
  let completion: Record<string, unknown> | null = null;
  let errorMessage: string | null = null;
  let sawStream = false;
  let sessionId: string | null = null;
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
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) continue;
    const event = parsed as Record<string, unknown>;
    if (typeof event.session_id === "string") sessionId ??= event.session_id;
    switch (event.type) {
      case "result": last = event; break;
      case "completion": sawStream = true; completion = event; break;
      case "error":
        sawStream = true;
        errorMessage ??= typeof event.message === "string" ? event.message : "unknown error";
        break;
      case "message":
        sawStream = true;
        if (event.role === "user") collector.userTurn();
        else if (event.role === "assistant" && typeof event.text === "string") collector.message(event.text);
        break;
      case "system": case "tool_call": case "tool_result": case "reasoning":
        sawStream = true;
        break;
      default: break;
    }
  }
  // A result object is the -o json wire (stream-json never prints one).
  if (last !== null) {
    const result = typeof last.result === "string" ? last.result : null;
    return {
      answer: result,
      usage: normalizeClaudeUsage(last.usage, undefined),
      sessionId: typeof last.session_id === "string" ? last.session_id : null,
      subtype: typeof last.subtype === "string" ? last.subtype : null,
      isError: last.is_error === true,
      transcript: null,
      finalText: result,
      errorMessage: null,
    };
  }
  if (!sawStream) return null;
  const transcript = collector.transcript();
  const finalText = completion !== null && typeof completion.finalText === "string" ? completion.finalText : null;
  return {
    answer: completeAnswer(transcript, finalText),
    usage: normalizeClaudeUsage(completion?.usage, undefined),
    sessionId: completion !== null && typeof completion.session_id === "string" ? completion.session_id : sessionId,
    subtype: completion !== null ? "success" : null,
    isError: errorMessage !== null || completion === null,
    transcript,
    finalText,
    errorMessage,
  };
}

/** Droid's stream lines the answer never reads: tool payloads and
 * reasoning (JSON.stringify writes `type` first). The fold sheds them. */
const DROID_SHED_PREFIXES = ['{"type":"tool_result"', '{"type":"tool_call"', '{"type":"reasoning"'] as const;

/** The streaming fold a droid run's stdout passes through. */
export function droidStreamFold(): AnswerStreamFold {
  return new AnswerStreamFold((head) => opensWith(head, DROID_SHED_PREFIXES) ? "drop" : "keep");
}

/** A plain droid run: the stream folded to the complete answer. Stdout
 * that carries no droid event passes through unchanged (the escape hatch
 * for a binary that ignored the format flag); a stream with an error
 * event or no completion fails the run with the reason on stderr. */
const plainText = (text: string): string => text === "" || text.endsWith("\n") ? text : `${text}\n`;

export function droidPlainResult(result: RunResult): RunResult {
  const parsed = parseDroidResultEnvelope(result.stdout);
  if (parsed === null) return result;
  const usage = parsed.usage;
  if (parsed.isError || parsed.subtype !== "success") {
    const reason = parsed.errorMessage ?? (parsed.subtype === null ? "no completion event" : `a ${parsed.subtype} result`);
    return {
      ...result,
      stdout: parsed.answer === null || parsed.answer.trim() === "" ? "" : plainText(parsed.answer),
      stderr: appendDiagnostic(result.stderr,
        `codemux: droid reported ${reason}, so this run fails even though the harness exited ${result.exitCode}`),
      exitCode: result.exitCode === 0 ? 1 : result.exitCode,
      success: false,
      usage,
      servedModel: null,
    };
  }
  return withTruncationNotice({ ...result, stdout: plainText(parsed.answer ?? ""), usage, servedModel: null },
    "droid", parsed.transcript);
}

/**
 * Finishes a `--result-json` run for droid: the envelope re-emits the
 * harness's own result object — the answer under its native `result`
 * field, the usage, the session id — plus the codemux block. Stdout with
 * no result line breaks the contract the launch made (it ran with
 * `-o json`, and droid prints no result line exactly when the run died
 * before its writer ran), so the run fails loudly rather than passing
 * the harness's stderr through as a reply. A result line whose is_error
 * is true or whose subtype is not "success" fails the same way: the
 * structured report is read, not the process exit trusted.
 */
export function droidResult(result: RunResult, request: RunRequest): RunResult {
  const agent = "droid" as const;
  const parsed = parseDroidResultEnvelope(result.stdout);
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
    parsed.errorMessage !== null
      ? `an error (${parsed.errorMessage})`
      : parsed.subtype === null
        ? "no completion event"
      : parsed.isError
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
    ...answerBlockFields(parsed.transcript, parsed.finalText),
  };
  const envelope = `${JSON.stringify({
    [DROID_ANSWER_FIELD]: parsed.answer ?? "",
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
    withTruncationNotice({
      ...result,
      stdout: envelope,
      usage: parsed.usage,
      servedModel: null,
    }, agent, parsed.transcript),
    parsed.usage,
    null
  );
}
