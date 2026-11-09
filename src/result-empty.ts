import { appendDiagnostic, boundResultEnvelope, emptyUsage, envelopeRefused } from "./result-envelope/common.js";
import { RESULT_ANSWER_FIELD } from "./result-envelope/index.js";
import type { RunRequest, RunResult } from "./types.js";

/** A completed process without an answer is a protocol failure. */
export const EMPTY_ANSWER_EXIT_CODE = 1;
export const EMPTY_ANSWER_FINISH = "empty-answer";

interface EmptyAnswerResult extends RunResult {
  emptyAnswer?: true;
}

export function isEmptyAnswer(text: string): boolean {
  return text.trim().length === 0;
}

/** The receipt reads trusted result metadata, never a harness diagnostic. */
export function emptyAnswerFinish(result: RunResult): typeof EMPTY_ANSWER_FINISH | null {
  return (result as EmptyAnswerResult).emptyAnswer ? EMPTY_ANSWER_FINISH : null;
}

function resultObject(stdout: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(stdout);
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

/** Apply after processRunResult and before recording the launch. The raw
 * process exit is separate: adapters may already reject an empty answer,
 * but every such exit-0 process owes the same metadata and ledger finish.
 * Existing child, timeout, and capture failures keep their verdicts. */
export function enforceNonEmptyResult(
  result: RunResult,
  request: RunRequest,
  processExitCode: number
): RunResult {
  if (processExitCode !== 0 || result.timedOut || result.captureLimitExceeded ||
      envelopeRefused(request.agent, result)) return result;
  const field = request.resultJson ? RESULT_ANSWER_FIELD[request.agent] : undefined;
  const envelope = request.resultJson ? resultObject(result.stdout) : null;
  const answer = request.resultJson ? (field === undefined ? undefined : envelope?.[field]) : result.stdout;
  if (typeof answer === "string" && !isEmptyAnswer(answer)) return result;
  // A malformed nonempty envelope already has its parser failure. Do not
  // replace that evidence with an empty-answer classification.
  if (request.resultJson && envelope === null && !isEmptyAnswer(result.stdout) && result.exitCode !== 0) return result;
  if (emptyAnswerFinish(result)) return result;

  const failed: EmptyAnswerResult = {
    ...result,
    emptyAnswer: true,
    exitCode: EMPTY_ANSWER_EXIT_CODE,
    success: false,
    stderr: appendDiagnostic(result.stderr, `Error: ${request.agent} exited 0 with an empty answer`),
  };
  if (!request.resultJson) return failed;

  const usage = result.usage ?? emptyUsage();
  const block = envelope?.codemux;
  failed.stdout = JSON.stringify({
    ...envelope,
    ...(field === undefined ? {} : { [field]: typeof answer === "string" ? answer : "" }),
    codemux: {
      agent: request.agent, model: request.model ?? null, served_model: result.servedModel ?? null,
      model_alias: request.modelAlias ?? null, labels: request.labels ?? null, usage,
      session_id: null, recording: null, failure_code: null,
      ...(block !== null && typeof block === "object" && !Array.isArray(block) ? block : {}),
      // An experiment's recording carries the same code in run_end (launch/experiment-arms.ts).
      ...(request.experimentMcp ? { failure_code: "empty_answer" } : {}),
      empty_answer: true,
      finish: EMPTY_ANSWER_FINISH,
    },
  }) + "\n";
  return boundResultEnvelope(request.agent, failed, usage, result.servedModel ?? null);
}
