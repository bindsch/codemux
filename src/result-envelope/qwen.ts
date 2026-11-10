import type { CodemuxResultBlock, RunRequest, RunResult } from "../types.js";
import { answerBlockFields, completeAnswer, type AnswerTranscript } from "../answer-complete.js";
import { qwenMessages, qwenTranscript } from "../qwen-stream-answer.js";
import {
  appendDiagnostic,
  boundResultEnvelope,
  normalizeClaudeUsage,
} from "./common.js";

/**
 * Parses qwen's output. Every run launches with `--output-format
 * stream-json` (lane AN1): one message per line, read for the complete
 * answer by src/qwen-stream-answer.ts, closing with the same result
 * message described below. The legacy `--output-format json` wire is still
 * accepted (0.24.0): stdout carries ONE line — `JSON.stringify(messages)`,
 * the whole message array — whose LAST element is the result message the
 * CLI's batch adapter appends before writing
 * (`JsonOutputAdapter.emitResult`: `process.stdout.write(JSON.stringify(
 * this.messages) + "\n")`). That element is
 * `{type:"result",subtype:"success",uuid,session_id,is_error:false,
 * duration_ms,duration_api_ms,num_turns,result:<text>,usage,
 * permission_denials}`; a failed run's element carries `is_error:true`,
 * `subtype:"error_during_execution"` and `error:{message}` instead of
 * `result` — the same array shape, printed even when the failure happens
 * before any turn. Evidence: chunk-ZJBYZN5D.js and buildResultMessage in
 * chunk-6XRR4RYH.js, read 2026-11-09.
 *
 * The usage object is `{input_tokens, output_tokens,
 * cache_read_input_tokens, [total_tokens]}` — the claude-family shape
 * without the cache-creation key, so normalizeClaudeUsage maps it and
 * leaves that one null. The result message carries no model name, but
 * every assistant frame does (`model: this.config.getModel()` on the
 * assistant event, chunk-SMAAYU3F.js, read 2026-11-09), so the LAST
 * assistant frame's `model` is the run's served-model evidence.
 */
/** The field qwen's --result-json envelope spells its answer text with;
 * the harness's own result message names it `result`. */
export const QWEN_ANSWER_FIELD = "result";

export interface QwenEnvelopeInfo {
  /** The complete answer (src/qwen-stream-answer.ts), else the result
   * message's own text. */
  answer: string | null;
  /** The result message's own `result`: the last assistant message. */
  harnessAnswer: string | null;
  transcript: AnswerTranscript;
  usage: ReturnType<typeof normalizeClaudeUsage>;
  sessionId: string | null;
  /** The result message's subtype, when one arrived. */
  subtype: string | null;
  isError: boolean;
  /** The error message a failed result carries. */
  errorMessage: string | null;
  /** The model name the last assistant frame reports, when one arrived. */
  servedModel: string | null;
}

export function parseQwenResultEnvelope(stdout: string): QwenEnvelopeInfo | null {
  // The stream-json wire (one message per line) or the json format's one
  // array line: either way the result message is the last one printed.
  const last = qwenMessages(stdout);
  const resultMessage = [...last].reverse().find((message) => message.type === "result");
  if (resultMessage === undefined) return null;
  const error = resultMessage.error as Record<string, unknown> | undefined;
  const assistantMessage = [...last].reverse().find(
    (message): message is Record<string, unknown> =>
      typeof message === "object" && message !== null &&
      (message as Record<string, unknown>).type === "assistant"
  );
  const harnessAnswer = typeof resultMessage.result === "string" ? resultMessage.result : null;
  const transcript = qwenTranscript(last);
  return {
    answer: completeAnswer(transcript, harnessAnswer),
    harnessAnswer,
    transcript,
    usage: normalizeClaudeUsage(resultMessage.usage, undefined),
    sessionId: typeof resultMessage.session_id === "string" ? resultMessage.session_id : null,
    subtype: typeof resultMessage.subtype === "string" ? resultMessage.subtype : null,
    isError: resultMessage.is_error === true,
    errorMessage:
      error !== undefined && typeof error.message === "string" ? error.message : null,
    servedModel:
      assistantMessage !== undefined && typeof assistantMessage.model === "string"
        ? assistantMessage.model
        : null,
  };
}

/**
 * Finishes a `--result-json` run for qwen: the envelope re-emits the
 * answer under its native `result` field with the usage and the codemux
 * block. Stdout with no result message breaks the contract the launch
 * made (it ran with `--output-format stream-json`, and qwen prints the
 * result message even for a failure that happens before the first turn), so the
 * run fails loudly rather than passing the harness's stderr through as a
 * reply. An is_error result message fails the same way — its error
 * message rides the diagnostic — and so does a success message whose
 * result text is empty: the structured report is read, not the process
 * exit trusted.
 */
export function qwenResult(result: RunResult, request: RunRequest): RunResult {
  const agent = "qwen" as const;
  const parsed = parseQwenResultEnvelope(result.stdout);
  if (parsed === null) {
    return {
      ...result,
      stderr: appendDiagnostic(
        result.stderr,
        `codemux: ${agent} printed no result message, ` +
          "so this --result-json run carries no codemux block"
      ),
      exitCode: result.exitCode === 0 ? 1 : result.exitCode,
      success: false,
    };
  }
  const failure =
    parsed.isError
      ? parsed.errorMessage !== null
        ? `an error result (${parsed.errorMessage})`
        : "an error result (is_error)"
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
    served_model: parsed.servedModel,
    usage: parsed.usage,
    session_id: parsed.sessionId,
    recording: null,
    failure_code: failure !== null ? "harness-error" : null,
    ...answerBlockFields(parsed.transcript, parsed.harnessAnswer),
  };
  const envelope = `${JSON.stringify({
    [QWEN_ANSWER_FIELD]: parsed.answer ?? "",
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

/** A plain qwen run: the same stream, printed as the complete answer with
 * the usage recorded. Stdout with no result message passes through with
 * its exit status (the run path judges an empty one); a result message
 * that reports a failure fails the run with qwen's own error text. */
export function qwenPlainResult(result: RunResult): RunResult {
  const parsed = parseQwenResultEnvelope(result.stdout);
  if (parsed === null) return result;
  const base = { usage: parsed.usage, servedModel: parsed.servedModel };
  if (parsed.isError || (parsed.subtype !== null && parsed.subtype !== "success")) {
    return {
      ...result, ...base,
      stdout: "",
      stderr: appendDiagnostic(result.stderr,
        `codemux: qwen reported ${parsed.errorMessage ?? parsed.subtype ?? "an error result"}, ` +
          `so this run fails even though the harness exited ${result.exitCode}`),
      exitCode: result.exitCode === 0 ? 1 : result.exitCode,
      success: false,
    };
  }
  const answer = parsed.answer ?? "";
  return { ...result, ...base, stdout: answer === "" || answer.endsWith("\n") ? answer : `${answer}\n` };
}
