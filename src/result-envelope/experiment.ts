import type { ExperimentFailure } from "../experiment-records.js";
import type { CodemuxResultBlock, ResultUsageBlock, RunRequest, RunResult } from "../types.js";
import { claudeFamilyResult } from "./claude.js";
import { appendDiagnostic, emptyUsage } from "./common.js";
import { codexResult } from "./codex.js";
import { CodexEventReducer } from "./codex-reducer.js";
import { parseCodexEventStream } from "./codex-stream.js";
import { MAX_CAPTURE_BYTES, OUTPUT_LIMIT_EXIT_CODE } from "../process-runner.js";
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
  let finalMessageIndex = -1;
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    const event = envelopeObject(line);
    if (!event) break;
    reducer.takeEvent(event);
    if (reducer.drift !== null) break;
    const item = event.item as Record<string, unknown> | undefined;
    if (reducer.finalMessage === null) finalMessageIndex = -1;
    else if (event.type === "item.completed" && item?.type === "agent_message") finalMessageIndex = events.length;
    events.push(event);
  }
  return { reducer, events: events.filter((_, index) => index !== finalMessageIndex) };
}

const TRUNCATION_NOTE = "\n[truncated by codemux]";

/** Bound the serialized envelope, including JSON escapes and the final newline. */
function boundedCodexEnvelope(envelope: Record<string, unknown>): { stdout: string; truncated: boolean } {
  const serialize = () => JSON.stringify(envelope) + "\n";
  let stdout = serialize();
  if (Buffer.byteLength(stdout) <= MAX_CAPTURE_BYTES) return { stdout, truncated: false };
  delete envelope.events;
  stdout = serialize();
  if (Buffer.byteLength(stdout) <= MAX_CAPTURE_BYTES) return { stdout, truncated: false };
  const originalResult = envelope.result;
  envelope.result = typeof originalResult === "string" ? TRUNCATION_NOTE : originalResult;
  const block = envelope.codemux as CodemuxResultBlock;
  // A reroute event can put nearly the entire captured prefix in model metadata.
  if (Buffer.byteLength(serialize()) > MAX_CAPTURE_BYTES) block.model = null;
  envelope.result = originalResult;
  stdout = serialize();
  if (Buffer.byteLength(stdout) <= MAX_CAPTURE_BYTES) return { stdout, truncated: true };
  const text = typeof envelope.result === "string" ? envelope.result : "";
  let low = 0;
  let high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    envelope.result = text.slice(0, middle) + TRUNCATION_NOTE;
    if (Buffer.byteLength(serialize()) <= MAX_CAPTURE_BYTES) low = middle;
    else high = middle - 1;
  }
  // Avoid cutting a UTF-16 surrogate pair in the retained reply.
  if (low > 0 && /[\uD800-\uDBFF]/.test(text[low - 1]!)) low--;
  envelope.result = typeof originalResult === "string" ? text.slice(0, low) + TRUNCATION_NOTE : originalResult;
  stdout = serialize();
  // Keep even oversized caller metadata from defeating the failure-output bound.
  if (Buffer.byteLength(stdout) > MAX_CAPTURE_BYTES) stdout = JSON.stringify({ result: null,
    codemux: { agent: "codex", failure_code: block.failure_code, recording: null } }) + "\n";
  return { stdout, truncated: true };
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
  let truncated = false;
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
    const output = { ...(existing ? envelope : { result: null }),
      ...(partial?.sawThreadStarted ? { result: partial.finalMessage, events: prefix!.events } : {}), codemux: block };
    ({ stdout, truncated } = request.agent === "codex" ? boundedCodexEnvelope(output) :
      { stdout: JSON.stringify(output) + "\n", truncated: false });
    if (block.model === null) servedModel = null;
  }
  const diagnostic = `codemux: experiment failure [${failure.code}]: ${failure.message}`;
  // Replace an intermediate normalization diagnostic with the final cleanup outcome.
  let stderr = raw.stderr.split("\n").filter((line) => !line.startsWith(`codemux: experiment failure [${failure.code}]: `)).join("\n");
  if (truncated) stderr = appendDiagnostic(stderr, "codemux: result truncated to the 16 MiB capture limit");
  return { ...raw, stdout, usage, servedModel, success: false, exitCode: raw.exitCode || 1,
    stderr: appendDiagnostic(stderr, diagnostic) };
}
