import type { ExperimentRelayCall } from "./experiment-relay.js";
import type { JsonObject } from "./experiment-server.js";

/** The delivery evidence the live gate's experiment probe reads: one
 * model_tool_result and one result_comparison per delivered call. Callers
 * emit these only after their provider-request and stdout checks pass, so
 * a failed verification never records an unchanged result. Calls contain
 * the verified model-facing result: the relay content, or an explicitly
 * accepted native projection (Gemini's untrusted-context wrapper). */
export function recordVerifiedDeliveries(
  source: { record: (kind: string, fields: JsonObject) => void },
  harness: string,
  calls: ReadonlyMap<string, ExperimentRelayCall>,
  deliveries: readonly { id: string; t: number }[],
  evidenceBoundary = "captured-provider-request",
): void {
  for (const { id, t } of deliveries) {
    const result = calls.get(id)!.result!;
    source.record("model_tool_result", { call_id: id, content: result.content,
      // The text blocks only; content keeps every block, images included.
      output: result.content.filter((block: JsonObject) => block.type === "text").map((block: JsonObject) => block.text).join("\n\n"),
      is_error: result.isError === true, evidence_boundary: evidenceBoundary, t });
    source.record("result_comparison", { call_id: id, equal: true, harness, t });
  }
}
