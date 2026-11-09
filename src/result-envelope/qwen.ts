import type { CodemuxResultBlock, RunRequest, RunResult } from "../types.js";
import {
  appendDiagnostic,
  boundResultEnvelope,
  normalizeClaudeUsage,
} from "./common.js";

/**
 * Parses the wire qwen prints for a run launched with `--output-format
 * json` (0.24.0): stdout carries ONE line — `JSON.stringify(messages)`,
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
  answer: string | null;
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
  // The array is one line, but the contract is "the last thing printed";
  // a warning line an earlier build let through must not hide it.
  let last: unknown = null;
  for (const line of stdout.split("\n").reverse()) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    try {
      last = JSON.parse(trimmed);
    } catch {
      last = null;
    }
    break;
  }
  if (!Array.isArray(last)) return null;
  const resultMessage = [...last].reverse().find(
    (message): message is Record<string, unknown> =>
      typeof message === "object" && message !== null &&
      (message as Record<string, unknown>).type === "result"
  );
  if (resultMessage === undefined) return null;
  const error = resultMessage.error as Record<string, unknown> | undefined;
  const assistantMessage = [...last].reverse().find(
    (message): message is Record<string, unknown> =>
      typeof message === "object" && message !== null &&
      (message as Record<string, unknown>).type === "assistant"
  );
  return {
    answer: typeof resultMessage.result === "string" ? resultMessage.result : null,
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
 * made (it ran with `--output-format json`, and qwen prints the result
 * array even for a failure that happens before the first turn), so the
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
