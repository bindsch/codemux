/** The agy plain-run unwrap: the `--output-format=json` result object
 * turned back into the plain reply. src/plain-unwrap.ts owns the public
 * surface and the module overview. */
import { parseAgyResultEnvelope } from "../result-envelope.js";
import type { RunResult } from "../types.js";
import { diagnosticExcerpt, failed, jsonShapedStdout, plainText } from "./common.js";

/**
 * agy: stdout should be the `--output-format=json` result object. Anything
 * that is not JSON passes through verbatim — except empty stdout, which
 * fails like the claude family's empty success (round 259), and except
 * JSON that is not the envelope: the envelope is one JSON object, so a
 * JSON value the parser cannot take (an array or a scalar, a complete but
 * unrecognized object, or an object a kill or the capture cap cut
 * mid-write) is a structured result that broke, not a plain reply, and
 * fails the run with nothing on stdout — the claude family's rule
 * (reviews ul4, ul7).
 */
export function agyPlainResult(result: RunResult): RunResult {
  const parsed = parseAgyResultEnvelope(result.stdout);
  if (parsed === null) {
    if (result.success && result.stdout.trim() === "") {
      return failed(
        result,
        "codemux: agy produced no output: an --output-format=json run " +
          "prints its result object, so an empty success is not a plain reply",
        ""
      );
    }
    if (!jsonShapedStdout(result.stdout)) return result;
    return failed(
      result,
      `codemux: agy printed JSON-shaped stdout that is not a result ` +
        `envelope (truncated or unrecognized), so this run fails rather than ` +
        `pass it through as the reply: ${diagnosticExcerpt(result.stdout)}`,
      ""
    );
  }
  const base = { usage: parsed.usage, servedModel: null };
  if (parsed.isError) {
    const reason =
      parsed.errorText !== null
        ? `status "${parsed.status}": ${parsed.errorText}`
        : `status "${parsed.status}"`;
    // The response text is what plain mode would have printed; an error
    // envelope that carries none prints nothing. The wire never leaks
    // (review ul2).
    const errorText =
      typeof parsed.envelope.response === "string" && parsed.envelope.response.trim() !== ""
        ? parsed.envelope.response
        : "";
    return {
      ...failed(
        result,
        `codemux: agy reported an error result (${reason}), ` +
          `so this run fails even though the harness exited ${result.exitCode}`,
        plainText(errorText)
      ),
      ...base,
    };
  }
  const response =
    typeof parsed.envelope.response === "string" ? parsed.envelope.response : "";
  if (response.trim() === "") {
    return {
      ...failed(
        result,
        "codemux: agy printed an envelope with no result text, " +
          "so this run reports no result",
        ""
      ),
      ...base,
    };
  }
  return { ...result, stdout: plainText(response), ...base };
}
