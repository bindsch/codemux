import type { CodemuxResultBlock, RunRequest, RunResult } from "../types.js";
import { appendDiagnostic, boundResultEnvelope, emptyUsage } from "./common.js";
import { opencodeVerdict, type OpenCodeResultData } from "../plain-unwrap.js";

/**
 * Finishes a `--result-json` run for OpenCode. The launch already runs
 * `--format json` on every run (plain ones fold the same wire), so the
 * envelope is built over the fold's finished outcome rather than a second
 * capture: `reply` is the folded text — the plain run's stdout, verbatim —
 * and `usage` is the folded `step_finish` count. The raw event lines are
 * never in the envelope: the streaming fold drops tool parts as they
 * arrive so no volume of tool output can reach the capture bound
 * (plain-unwrap.ts, review ul4), and re-capturing them for the envelope
 * would reintroduce that bound. `session_id` is absent because a run is
 * not registered for resume. The fold retains the first session ID only
 * to reject events from another session.
 *
 * Failure semantics mirror the plain verdict's (opencodeVerdict): an
 * `error` event or a stream with no assistant text fails the run after a
 * zero exit, with the envelope still emitted and the tokens kept — they
 * were spent. Stdout that never used the wire's grammar — a binary that
 * ignored `--format json` — breaks the launch contract a `--result-json`
 * run makes explicit, so the run fails loudly with the raw stdout kept,
 * the claude/agy/kimi rule for a missing envelope. A stream that latched
 * the capture bound arrives here as the runner's failure result (exit 125,
 * captureLimitExceeded); the spread below keeps that verdict, so the
 * envelope never upgrades a cut capture to a success.
 */
/** The field opencode's --result-json envelope spells its answer text
 * with. The release gate's probe C verifies this exact field per agent,
 * so the builder and the gate share one name (review round 16, edges 3). */
export const OPENCODE_ANSWER_FIELD = "reply";

export function opencodeResult(
  result: RunResult,
  request: RunRequest,
  data: OpenCodeResultData,
  /** The model the adapter selected for this run: the request's, else the
   * override's. Falls back to the request's model when no context carried
   * the selection. */
  selectedModel: string | null = request.model ?? null,
  recording: string | null = null,
  servedModel: string | null = null
): RunResult {
  if (!data.sawWire) {
    return {
      ...result,
      stderr: appendDiagnostic(
        result.stderr,
        "codemux: opencode printed no wire events, " +
          "so this --result-json run carries no codemux block"
      ),
      exitCode: result.exitCode === 0 ? 1 : result.exitCode,
      success: false,
    };
  }
  const verdict = opencodeVerdict(result, data);
  const usage = verdict.usage ?? emptyUsage();
  // Native stdout has no response model. Only the experiment observer's
  // verified final provider responses can supply servedModel; ordinary
  // runs retain unknown identity and report their selected model separately.
  const block: CodemuxResultBlock = {
    agent: "opencode",
    labels: request.labels ?? null,
    model_alias: request.modelAlias ?? null,
    model: servedModel ?? selectedModel,
    served_model: servedModel,
    usage,
    session_id: null,
    recording,
    failure_code: null,
    // The reply already joins every step's text (lane AN1); the last
    // step's text alone is the final message.
    final_message: data.finalMessage,
    truncated: data.truncated,
  };
  const envelope = `${JSON.stringify({ [OPENCODE_ANSWER_FIELD]: verdict.stdout, usage, codemux: block })}\n`;
  // The fold bounds the reply's raw bytes; the JSON escaping of many
  // quotes or newlines can still carry the envelope past the capture
  // bound, and a caller must never read a success it cannot hold
  // (review round 47). The check is the shared bound helper every
  // --result-json path enforces since review round 127; this path's own
  // wording and exit code are the ones the helper spells.
  return boundResultEnvelope(
    "opencode",
    { ...verdict, usage, servedModel, stdout: envelope },
    usage,
    servedModel
  );
}
