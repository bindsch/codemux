import type { ExperimentFailure } from "../experiment-records.js";
import type { CodemuxResultBlock, ResultUsageBlock, RunRequest, RunResult } from "../types.js";
import { claudeFamilyResult } from "./claude.js";
import { appendDiagnostic, emptyUsage } from "./common.js";
import { codexResult } from "./codex.js";
import { CodexEventReducer } from "./codex-reducer.js";
import { parseCodexEventStream } from "./codex-stream.js";
import { OUTPUT_LIMIT_EXIT_CODE } from "../process-runner.js";
import { claudeFamilyPlainResult } from "../plain-unwrap.js";

function envelopeObject(stdout: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(stdout);
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown> : null;
  } catch { return null; }
}

/** Recover complete Codex events before a malformed or truncated line. */
function codexCapturedPrefix(stdout: string) {
  const reducer = new CodexEventReducer();
  const events: Record<string, unknown>[] = [];
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    const event = envelopeObject(line);
    if (!event) break;
    reducer.takeEvent(event);
    if (reducer.drift !== null) break;
    events.push(event);
  }
  return { reducer, events };
}

/** Report experiment verification failures even when capture produced no envelope. */
export function experimentFailedResult(
  result: RunResult | undefined,
  request: RunRequest,
  recording: string | null,
  failure: ExperimentFailure,
  foldedUsage?: ResultUsageBlock | null,
  effectiveModel?: string
): RunResult {
  request = { ...request, model: effectiveModel ?? request.model };
  let raw = result ?? { stdout: "", stderr: "", exitCode: 1, success: false };
  if (!request.resultJson && raw.usage === undefined && (request.agent === "claude" || request.agent === "zai")) {
    raw = claudeFamilyPlainResult(raw, request.agent);
  }
  if (request.agent === "kimi" && !(raw.usage !== undefined &&
      (envelopeObject(raw.stdout)?.codemux || raw.reply !== undefined))) {
    throw new Error("internal error: Kimi experiment result must be normalized before failure reporting");
  }
  let stdout = !request.resultJson && request.agent === "kimi" ? raw.reply ?? raw.stdout : raw.stdout;
  let usage = raw.usage ?? foldedUsage ?? emptyUsage();
  let servedModel = raw.servedModel ?? null;
  if (request.resultJson) {
    const prefix = request.agent === "codex" &&
      (raw.exitCode === OUTPUT_LIMIT_EXIT_CODE || parseCodexEventStream(raw.stdout) === null) &&
      !envelopeObject(raw.stdout)?.codemux ? codexCapturedPrefix(raw.stdout) : undefined;
    const partial = prefix?.reducer;
    let normalized = raw;
    if (request.agent === "claude" || request.agent === "zai") {
      normalized = raw.usage !== undefined && envelopeObject(raw.stdout)?.codemux ? raw :
        claudeFamilyResult(raw, request, request.agent, recording);
    } else if (request.agent === "codex") {
      normalized = raw.usage !== undefined && envelopeObject(raw.stdout)?.codemux ? raw :
        codexResult({ ...raw, success: false, exitCode: raw.exitCode || 1 }, request, null, recording);
    }
    const envelope = envelopeObject(normalized.stdout);
    usage = normalized.usage ?? usage;
    servedModel = partial?.servedModel ?? normalized.servedModel ?? servedModel;
    const existing = normalized.usage !== undefined ? envelope?.codemux : undefined;
    const block: CodemuxResultBlock = existing && typeof existing === "object" && !Array.isArray(existing)
      ? { ...existing as CodemuxResultBlock, recording, failure_code: failure.code }
      : { agent: request.agent, model: servedModel ?? request.model ?? null, labels: request.labels ?? null,
          usage, session_id: null, recording, failure_code: failure.code };
    stdout = `${JSON.stringify({ ...(existing ? envelope : { result: null }),
      ...(partial?.sawThreadStarted ? { result: partial.finalMessage, events: prefix!.events } : {}), codemux: block })}\n`;
  }
  const diagnostic = `codemux: experiment failure [${failure.code}]: ${failure.message}`;
  // Replace an intermediate normalization diagnostic with the final cleanup outcome.
  const stderr = raw.stderr.split("\n").filter((line) => !line.startsWith(`codemux: experiment failure [${failure.code}]: `)).join("\n");
  return { ...raw, stdout, usage, servedModel, success: false, exitCode: raw.exitCode || 1,
    stderr: appendDiagnostic(stderr, diagnostic) };
}
