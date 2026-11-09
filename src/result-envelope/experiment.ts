import type { ExperimentFailure } from "../experiment-records.js";
import type { CodemuxResultBlock, ResultUsageBlock, RunRequest, RunResult } from "../types.js";
import { claudeFamilyResult } from "./claude.js";
import { appendDiagnostic, boundResultEnvelope, emptyUsage, envelopeBoundLine, envelopeRefused } from "./common.js";
import { codexResult } from "./codex.js";
import { CODEX_TRUNCATED_LINE, boundedCodexEnvelope } from "./codex-bound.js";
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
  let refused = false;
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
        codexResult({ ...raw, success: false, exitCode: raw.exitCode || 1 }, request, null, recording, "leave");
    }
    // An envelope refused for the capture bound stays refused: the run
    // keeps the output-limit exit and the line naming the bound, and
    // stdout carries no envelope, exactly as when the bound is passed at
    // the tail below. Rebuilding a small envelope here turned the refusal
    // into an ordinary failure. The refusal can arrive two ways: the
    // result was refused before it got here (the launch normalizes before
    // cleanup, review round 131), or the normalization above refused it
    // (review round 130). The experiment failure itself is still named on
    // stderr.
    if (envelopeRefused(request.agent, raw)) {
      refused = true;
    } else if (normalized !== raw && envelopeRefused(request.agent, normalized)) {
      refused = true;
      raw = { ...raw, exitCode: OUTPUT_LIMIT_EXIT_CODE,
        stderr: appendDiagnostic(raw.stderr, envelopeBoundLine(request.agent)) };
    }
    const envelope = envelopeObject(normalized.stdout);
    usage = normalized.usage ?? usage;
    // A deliberate null must survive this chain: the captured prefix's
    // no-attribution verdict and claude's multipleModels null are answers,
    // not absences, but `??` read them as absent and let an earlier raw
    // value resurface (round 361, item 15). Only an undefined — this arm
    // made no attribution at all — falls through.
    servedModel = partial !== undefined
      ? partial.servedModel
      : normalized.servedModel !== undefined
        ? normalized.servedModel
        : servedModel;
    const existing = normalized.usage !== undefined ? envelope?.codemux : undefined;
    const block: CodemuxResultBlock = existing && typeof existing === "object" && !Array.isArray(existing)
      ? { ...existing as CodemuxResultBlock, recording, failure_code: failure.code }
      : { agent: request.agent, model: servedModel ?? request.model ?? null, served_model: servedModel ?? null,
          model_alias: request.modelAlias ?? null,
          labels: request.labels ?? null,
          usage, session_id: null, recording, failure_code: failure.code };
    const output = { ...(existing ? envelope : { result: null }),
      ...(partial?.sawThreadStarted ? { result: partial.finalMessage, events: prefix!.events } : {}), codemux: block };
    if (request.agent === "codex") {
      ({ stdout, truncated } = boundedCodexEnvelope(output));
    } else {
      // The final envelope this failure result would carry, serialized
      // once with its newline: rewriting the block can carry an envelope
      // that fit before past the bound. The codex arm bounds itself above
      // (boundedCodexEnvelope truncates toward the bound); every other
      // agent runs the shared bound at the tail instead, which refuses
      // the envelope when these bytes are past it (review round 127) --
      // the stdout below must be the complete final serialization, the
      // exact bytes a caller would hold, or the tail would measure the
      // wrong string.
      stdout = JSON.stringify(output) + "\n";
    }
    if (block.model === null) servedModel = null;
    if (refused) stdout = "";
  }
  const diagnosticPrefix = `codemux: experiment failure [${failure.code}]: `;
  const diagnostic = `${diagnosticPrefix}${failure.message}`;
  // Replace an intermediate normalization diagnostic with the final
  // cleanup outcome. An earlier diagnostic of this failure starts with
  // the same prefix; the final one repeats its message, extended by a
  // cleanup note at most. The whole earlier block goes: its first line,
  // then every continuation line that equals the final diagnostic's line
  // at that position or is a leading part of it, stopping at a blank line
  // (a blank separator is never part of a diagnostic; a message with an
  // interior blank line leaves the lines past it, the stated residual). A
  // message containing a newline made the old first-line filter leave the
  // continuation lines behind, so the appended diagnostic duplicated the
  // tail (review round 401, item 7).
  const diagnosticLines = diagnostic.split("\n");
  const dropDiagnosticBlocks = (text: string): string => {
    const lines = text.split("\n");
    const kept: string[] = [];
    for (let i = 0; i < lines.length; ) {
      if (!lines[i]!.startsWith(diagnosticPrefix)) {
        kept.push(lines[i]!);
        i += 1;
        continue;
      }
      let length = 1;
      while (length < diagnosticLines.length && i + length < lines.length) {
        const line = lines[i + length]!;
        if (line === "" || !diagnosticLines[length]!.startsWith(line)) break;
        length += 1;
      }
      i += length;
    }
    return kept.join("\n");
  };
  let stderr = dropDiagnosticBlocks(raw.stderr);
  if (truncated) stderr = appendDiagnostic(stderr, CODEX_TRUNCATED_LINE);
  const settled: RunResult = { ...raw, stdout, usage, servedModel, success: false, exitCode: raw.exitCode || 1,
    stderr: appendDiagnostic(stderr, diagnostic) };
  // Within the bound this passes settled through unchanged; past it the
  // refusal keeps the failure verdict and the spent usage, drops the
  // envelope from stdout, and names the agent and the bound.
  return boundResultEnvelope(request.agent, settled, usage, servedModel);
}
