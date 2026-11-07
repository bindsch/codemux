/** The claude/zai plain-run unwrap: the `--output-format json` result
 * envelope turned back into the plain reply. src/plain-unwrap.ts owns the
 * public surface and the module overview. */
import { parseClaudeResultEnvelope } from "../result-envelope.js";
import type { AgentId, RunResult } from "../types.js";
import { diagnosticExcerpt, failed, jsonShapedStdout, plainText } from "./common.js";

/**
 * claude/zai: stdout should be the single JSON result envelope
 * `--output-format json` prints. Stdout no binary asked for that format
 * would print — plain text that is not JSON — passes through verbatim,
 * except empty stdout: a zero-exit run that printed nothing produced
 * neither the envelope nor a reply, and an empty success is a failed run
 * (round 259; kimi's stream-json rule, review round 46). JSON that is
 * not a parseable envelope never does: any complete JSON value that is
 * not it (an array, a scalar, an unrecognized object), and an object a
 * kill or the capture cap cut mid-write, both fail the run with the
 * break on stderr and nothing on stdout — the wire is never the reply
 * (reviews ul3, ul7).
 */
export function claudeFamilyPlainResult(result: RunResult, agent: AgentId): RunResult {
  const parsed = parseClaudeResultEnvelope(result.stdout);
  if (parsed === null) {
    if (result.success && result.stdout.trim() === "") {
      return failed(
        result,
        `codemux: ${agent} produced no output: a --output-format json run ` +
          "prints its result envelope, so an empty success is not a plain reply",
        ""
      );
    }
    if (!jsonShapedStdout(result.stdout)) return result;
    return failed(
      result,
      `codemux: ${agent} printed JSON-shaped stdout that is not a result ` +
        `envelope (truncated or unrecognized), so this run fails rather than ` +
        `pass it through as the reply: ${diagnosticExcerpt(result.stdout)}`,
      ""
    );
  }
  const base = {
    usage: parsed.usage,
    servedModel: parsed.multipleModels ? null : parsed.servedModel,
  };
  if (parsed.isError) {
    const reason =
      parsed.errorSubtype !== null
        ? `subtype "${parsed.errorSubtype}"`
        : "is_error: true";
    // An error envelope still carries its `result` text — the error text
    // plain mode would have printed — so stdout shows that, never the
    // JSON wire the structured launch produced (review ul2).
    const errorText =
      typeof parsed.envelope.result === "string" && parsed.envelope.result.trim() !== ""
        ? parsed.envelope.result
        : "";
    return {
      ...failed(
        result,
        `codemux: ${agent} reported an error result (${reason}), ` +
          `so this run fails even though the harness exited ${result.exitCode}`,
        plainText(errorText)
      ),
      ...base,
    };
  }
  if (typeof parsed.envelope.result !== "string" || parsed.envelope.result.trim() === "") {
    return {
      ...failed(
        result,
        `codemux: ${agent} printed an envelope with no result text, ` +
          "so this run reports no result",
        ""
      ),
      ...base,
    };
  }
  return { ...result, stdout: plainText(parsed.envelope.result), ...base };
}
