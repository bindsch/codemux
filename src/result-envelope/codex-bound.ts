import type { CodemuxResultBlock } from "../types.js";
import { emptyUsage } from "./common.js";
import { MAX_CAPTURE_BYTES } from "../process-runner.js";

/** The stderr line a truncated codex envelope adds. */
export const CODEX_TRUNCATED_LINE = "codemux: result truncated to the 16 MiB capture limit";

const TRUNCATION_NOTE = "\n[truncated by codemux]";

/** Bound the serialized envelope, including JSON escapes and the final newline. */
export function boundedCodexEnvelope(envelope: Record<string, unknown>): { stdout: string; truncated: boolean } {
  const serialize = () => JSON.stringify(envelope) + "\n";
  let stdout = serialize();
  if (Buffer.byteLength(stdout) <= MAX_CAPTURE_BYTES) return { stdout, truncated: false };
  // Dropping the events is a truncation too: the caller must say so
  // instead of presenting the envelope as complete (review round 322).
  delete envelope.events;
  stdout = serialize();
  if (Buffer.byteLength(stdout) <= MAX_CAPTURE_BYTES) return { stdout, truncated: true };
  const block = envelope.codemux as CodemuxResultBlock;
  // The closing message repeats the tail of `result` (lane AN1), so it is
  // the next copy to go: null, never a cut message posing as the whole.
  if (block !== undefined && block !== null && block.final_message !== null) {
    block.final_message = null;
    stdout = serialize();
    if (Buffer.byteLength(stdout) <= MAX_CAPTURE_BYTES) return { stdout, truncated: true };
  }
  const originalResult = envelope.result;
  envelope.result = typeof originalResult === "string" ? TRUNCATION_NOTE : originalResult;
  // A reroute event can put nearly the entire captured prefix in model
  // metadata, and served_model carries the same reroute string, so both
  // are dropped together (review round 14, edges 7 symmetric case).
  if (Buffer.byteLength(serialize()) > MAX_CAPTURE_BYTES) {
    block.model = null;
    block.served_model = null;
  }
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
  // The emergency envelope keeps every documented CodemuxResultBlock key
  // (round 29, edges 5): a consumer reading `--result-json` gets the schema
  // it was promised, with nulls where the oversized metadata is dropped.
  if (Buffer.byteLength(stdout) > MAX_CAPTURE_BYTES) stdout = JSON.stringify({ result: null,
    codemux: { agent: "codex", model: null, served_model: null, labels: null, usage: emptyUsage(),
      session_id: null, recording: null, failure_code: block.failure_code,
      final_message: null, truncated: block.truncated } }) + "\n";
  return { stdout, truncated: true };
}
