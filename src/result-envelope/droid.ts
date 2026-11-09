import type { CodemuxResultBlock, RunRequest, RunResult } from "../types.js";
import {
  appendDiagnostic,
  boundResultEnvelope,
  normalizeClaudeUsage,
} from "./common.js";

/**
 * Parses the result line droid prints for a run launched with
 * `exec -o json` (0.221.0): stdout carries ONE JSON object — the exec
 * output writer builds `{type:"result",subtype:isError?"failure":
 * "success",is_error,duration_ms,num_turns,result:finalText,session_id,
 * usage}` and hands it to `process.stdout.write(JSON.stringify(e)+"\n")`
 * and nothing else; the error path prints the same shape with
 * subtype:"failure". Evidence: the exec output dispatcher in the droid
 * binary (`if(s==="json"){let c=ae(t,r,a);_(JSON.stringify(c));return}`),
 * read 2026-11-09.
 *
 * The usage object is the claude-family shape
 * `{input_tokens, output_tokens, cache_creation_input_tokens,
 * cache_read_input_tokens}` plus droid-only extras (factory_credits,
 * thinking_tokens, ttft_ms) — so normalizeClaudeUsage maps the shared
 * keys and drops the extras. The result line carries no model name, so
 * served_model stays null.
 */
/** The field droid's --result-json envelope spells its answer text with;
 * the harness's own result object names it `result`. */
export const DROID_ANSWER_FIELD = "result";

export interface DroidEnvelopeInfo {
  answer: string | null;
  usage: ReturnType<typeof normalizeClaudeUsage>;
  sessionId: string | null;
  /** The result line's subtype, when a line arrived. */
  subtype: string | null;
  isError: boolean;
}

export function parseDroidResultEnvelope(stdout: string): DroidEnvelopeInfo | null {
  let last: Record<string, unknown> | null = null;
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
    if (event.type === "result") last = event;
  }
  if (last === null) return null;
  return {
    answer: typeof last.result === "string" ? last.result : null,
    usage: normalizeClaudeUsage(last.usage, undefined),
    sessionId: typeof last.session_id === "string" ? last.session_id : null,
    subtype: typeof last.subtype === "string" ? last.subtype : null,
    isError: last.is_error === true,
  };
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
