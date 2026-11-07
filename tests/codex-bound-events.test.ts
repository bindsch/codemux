/**
 * The bounded codex envelope reports truncation whenever it dropped
 * something to fit the capture limit (review round 322): dropping the
 * events array used to answer truncated: false, so the caller omitted the
 * truncation line and presented an incomplete envelope as complete.
 */
import { expect, test } from "bun:test";
import { boundedCodexEnvelope } from "../src/result-envelope/codex-bound.js";
import { MAX_CAPTURE_BYTES } from "../src/process-runner.js";

test("dropping the events to fit the capture limit is a truncation", () => {
  const envelope: Record<string, unknown> = {
    result: "OK",
    events: ["x".repeat(MAX_CAPTURE_BYTES)],
    codemux: { agent: "codex", model: "m", served_model: null, labels: null, usage: {}, session_id: null, recording: null, failure_code: null },
  };
  const bounded = boundedCodexEnvelope(envelope);
  expect(bounded.truncated).toBe(true);
  expect(Buffer.byteLength(bounded.stdout)).toBeLessThanOrEqual(MAX_CAPTURE_BYTES);
  expect("events" in envelope).toBe(false);
  // An envelope that fits is not truncated.
  expect(boundedCodexEnvelope({ result: "OK", events: [], codemux: {} }).truncated).toBe(false);
});
