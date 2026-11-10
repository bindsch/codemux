/** The claude-family run result, shared by the claude and zai adapters
 * (the same binary): the launch flags that ask for the stream, the stdout
 * fold, and processRunResult. The answer rule is lane AN1's
 * (src/answer-complete.ts); the stream reader is src/claude-stream-answer.ts. */
import type { RunContext } from "./adapters/base.js";
import { answerBlockFields, completeAnswer, withTruncationNotice } from "./answer-complete.js";
import { claudeStreamAnswer, ClaudeStreamFold } from "./claude-stream-answer.js";
import { claudeFamilyPlainResult } from "./plain-unwrap.js";
import { appendDiagnostic, claudeFamilyResult } from "./result-envelope.js";
import { withStreamScanSurface } from "./stream-marker-scan.js";
import type { AgentId, RunRequest, RunResult } from "./types.js";

/** The stdout fold of an ordinary (non-experiment) run: every run reads
 * the stream-json wire, because the `json` format's `result` is the final
 * message alone. */
export function claudeFamilyStdoutSink(): ClaudeStreamFold {
  return new ClaudeStreamFold();
}

/**
 * Finishes a claude-family run. The result object's `result` (the final
 * message) is replaced by the complete answer — every assistant message
 * after the prompt, a blank line between two — before the existing plain
 * unwrap or `--result-json` envelope runs, so their failure rules apply to
 * the answer unchanged. An error result keeps its own text. The envelope's
 * codemux block carries the final message alone and the length flag; a
 * length-stopped run prints one stderr line.
 */
export function claudeFamilyRunResult(
  result: RunResult,
  request: RunRequest,
  agent: AgentId,
  context: RunContext | undefined,
  model: string | undefined
): RunResult {
  const bridge = context?.experimentBridge;
  // The fold shed every user (tool result) and system frame and the tool
  // inputs of assistant frames; the hermetic check scans its marker
  // evidence beside the capture (stream-marker-scan.ts). An experiment
  // run's scanSurface is the bridge's whole trace, set below.
  const captured = result.stdout;
  if (bridge) {
    if (result.exitCode === 0 && !result.stdout) throw new Error("Claude returned no experiment result envelope");
    result = { ...result, scanSurface: bridge.scanSurface() };
  }
  // An experiment run's stdout is the bridge's result object; its trace
  // holds the stream the messages ride.
  const stream = claudeStreamAnswer(bridge ? bridge.scanSurface() : result.stdout);
  const frame = stream.resultFrame;
  let fields = null;
  if (frame !== null) {
    const harnessAnswer = typeof frame.result === "string" ? frame.result : null;
    fields = answerBlockFields(stream.transcript, harnessAnswer);
    const failed = frame.is_error === true ||
      (typeof frame.subtype === "string" && frame.subtype.startsWith("error"));
    const answer = failed ? harnessAnswer : completeAnswer(stream.transcript, harnessAnswer);
    result = { ...result, stdout: JSON.stringify(answer === harnessAnswer ? frame : { ...frame, result: answer }) };
  }
  const notice = fields?.truncated === true ? stream.transcript : null;
  if (request.resultJson) {
    return withStreamScanSurface(withTruncationNotice(
      claudeFamilyResult(result, { ...request, model }, agent, context?.experimentRecording ?? null, fields),
      agent, notice), captured, context?.stdoutSink);
  }
  const plain = withStreamScanSurface(
    withTruncationNotice(claudeFamilyPlainResult(result, agent), agent, notice), captured, context?.stdoutSink);
  // A plain run has no codemux block to carry the recording path, so the
  // run's stderr summary names it instead.
  return bridge
    ? { ...plain, stderr: appendDiagnostic(plain.stderr, `codemux: experiment MCP recording: ${bridge.recordingPath}`) }
    : plain;
}
