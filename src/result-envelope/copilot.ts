import type { CodemuxResultBlock, ResultUsageBlock, RunRequest, RunResult } from "../types.js";
import { appendDiagnostic, boundResultEnvelope, emptyUsage } from "./common.js";
import { AnswerCollector, answerBlockFields, completeAnswer, type AnswerTranscript } from "../answer-complete.js";

/**
 * Parses the JSONL stream copilot prints for a run launched with
 * `--output-format json` ("Output format: 'text' (default) or 'json' (JSONL,
 * one JSON object per line)", the flag's own help). Evidence: installed
 * @github/copilot 1.0.85 app.js and 1.0.103 copilot.tgz/package/cli-main.js,
 * read 2026-11-09:
 *
 * - The event writer suppresses `assistant.usage`, so the stdout
 *   stream carries NO token usage lines at all. The final result line's
 *   `usage` object holds premiumRequests, totalApiDurationMs,
 *   sessionDurationMs, and codeChanges, with no token counts. The adapter
 *   reads token counts from --usage-output-file after process exit.
 * - Every model call ends in one `assistant.message` event: `data.content`
 *   (empty on a tool-call-only message) beside `data.toolRequests`. The
 *   answer is every main-agent message's content after the last
 *   `user.message`, a blank line between two (lane AN1,
 *   src/answer-complete.ts); the last message alone is `final_message`.
 *   The event names no stop or finish reason (a recorded 1.0.85 session,
 *   ~/.copilot/session-state/<id>/events.jsonl, read 2026-11-10), so
 *   `truncated` stays false. The last message's data.model is preserved
 *   as native metadata. The generated schema
 *   calls it produced-model data, but installed JS delegates normal event
 *   creation to runtime.node; its response-versus-request assignment is
 *   unavailable here. Transcript import uses `...a.model?{model:a.model}:{}`
 *   (1.0.85 app.js, read 2026-11-09). This does not prove served identity.
 * - The result line is `{type:"result", timestamp, sessionId, exitCode,
 *   usage:{...}}`.
 * - `session.error` events carry `data.message`.
 */
/** The field copilot's --result-json envelope spells its answer text with;
 * the harness's own wire names the assistant message's text `content`.
 * The release gate's probe C verifies this exact field per agent, so the
 * parser and the gate share one name (review round 16, edges 3). */
export const COPILOT_ANSWER_FIELD = "content";

export interface CopilotEnvelopeInfo {
  /** The complete answer, or null when no main-agent message arrived. */
  answer: string | null;
  /** The last main-agent message's content. */
  finalMessage: string | null;
  transcript: AnswerTranscript;
  usage: ResultUsageBlock;
  nativeModel: string | null;
  sessionId: string | null;
  /** The final result line's exitCode, when the line arrived. */
  reportedExitCode: number | null;
  errorText: string | null;
}

export function parseCopilotResultEnvelope(stdout: string): CopilotEnvelopeInfo | null {
  let sawWire = false;
  let answer: string | null = null;
  let sessionId: string | null = null;
  let reportedExitCode: number | null = null;
  let errorText: string | null = null;
  let nativeModel: string | null = null;
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
    if (event.type === "assistant.message") {
      const data =
        typeof event.data === "object" && event.data !== null
          ? (event.data as Record<string, unknown>)
          : {};
      if (event.agentId !== undefined && event.agentId !== "main") continue;
      if (typeof data.content === "string") {
        answer = data.content;
        collector.message(data.content);
        nativeModel = typeof data.model === "string" && data.model.trim() !== ""
          ? data.model : null;
      }
    } else if (event.type === "user.message") {
      if (event.agentId === undefined || event.agentId === "main") {
        collector.userTurn();
        answer = nativeModel = null;
        reportedExitCode = null;
      }
    } else if (event.type === "result") {
      if (typeof event.sessionId === "string") sessionId = event.sessionId;
      if (typeof event.exitCode === "number" && Number.isSafeInteger(event.exitCode)) {
        reportedExitCode = event.exitCode;
      }
    } else if (event.type === "session.error") {
      const data =
        typeof event.data === "object" && event.data !== null
          ? (event.data as Record<string, unknown>)
          : {};
      errorText = typeof data.message === "string" ? data.message : "session error without a diagnostic";
    }
  }
  if (!sawWire) return null;
  const transcript = collector.transcript();
  return { answer: answer === null ? null : completeAnswer(transcript, answer), finalMessage: answer, transcript,
    usage: emptyUsage(), nativeModel, sessionId, reportedExitCode, errorText };
}

/**
 * Finishes a `--result-json` run for copilot: the envelope is codemux's own
 * — the folded answer text, usage from the native metrics artifact, and
 * the codemux block (the opencode shape: the raw event lines are never
 * re-emitted, so no volume of tool output reaches the capture bound). Stdout
 * with no JSON lines at all breaks the contract the launch made (it ran with
 * `--output-format json`), so the run fails loudly. A stream with no
 * assistant text fails too — the harness exited without a reply — and so
 * does a session.error event or a final result line whose exitCode is
 * nonzero: the structured report is read, not the process exit trusted.
 */
export function copilotResult(
  result: RunResult,
  request: RunRequest,
  metrics?: { usage: ResultUsageBlock; servedModel?: string | null } | { error: string }
): RunResult {
  const agent = "copilot" as const;
  const parsed = parseCopilotResultEnvelope(result.stdout);
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
  if (metrics !== undefined && "usage" in metrics) parsed.usage = metrics.usage;
  const failure =
    parsed.errorText !== null
      ? `session error (${parsed.errorText})`
      : parsed.reportedExitCode !== null && parsed.reportedExitCode !== 0
        ? `result exitCode ${parsed.reportedExitCode}`
        : metrics !== undefined && "error" in metrics ? metrics.error
        : parsed.answer === null || parsed.answer.trim() === ""
          ? "no assistant message"
          : null;
  // Only the RPC observer supplies provider-response provenance.
  const servedModel = metrics && "usage" in metrics ? metrics.servedModel ?? null : null;
  const block: CodemuxResultBlock = {
    agent,
    labels: request.labels ?? null,
    model_alias: request.modelAlias ?? null,
    model: request.model ?? null,
    served_model: servedModel,
    usage: parsed.usage,
    session_id: parsed.sessionId,
    recording: null,
    failure_code: failure !== null ? "harness-error" : null,
    ...answerBlockFields(parsed.transcript, parsed.finalMessage),
  };
  const envelope = request.resultJson !== false
    ? `${JSON.stringify({ [COPILOT_ANSWER_FIELD]: parsed.answer ?? "", model: parsed.nativeModel, usage: parsed.usage, codemux: block })}\n`
    : failure !== null || !result.success ? "" : (parsed.answer ?? "").replace(/\n?$/, "\n");
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
      stdout: envelope,
      usage: parsed.usage,
      servedModel,
    },
    parsed.usage,
    servedModel
  );
}

/** A plain copilot run: the same JSONL wire, printed as the complete
 * answer. Stdout with no wire events (a binary that ignored the format)
 * stays as diagnostics and fails result-empty; a session error or a nonzero
 * result exitCode fails the run with nothing on stdout. */
export function copilotPlainResult(result: RunResult): RunResult {
  const parsed = parseCopilotResultEnvelope(result.stdout);
  if (parsed === null) return { ...result, reply: "" };
  const failure = parsed.errorText !== null ? `session error (${parsed.errorText})`
    : parsed.reportedExitCode !== null && parsed.reportedExitCode !== 0 ? `result exitCode ${parsed.reportedExitCode}` : null;
  if (failure !== null) {
    return { ...result, stdout: "", exitCode: result.exitCode === 0 ? 1 : result.exitCode, success: false,
      stderr: appendDiagnostic(result.stderr, `codemux: copilot reported ${failure}, so this run fails even though the harness exited ${result.exitCode}`) };
  }
  const answer = parsed.answer ?? "";
  return { ...result, stdout: answer === "" || answer.endsWith("\n") ? answer : `${answer}\n` };
}
