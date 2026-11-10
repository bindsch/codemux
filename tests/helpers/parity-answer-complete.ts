import { expect } from "bun:test";
import { PARITY } from "../../src/parity/index.js";
import { agyResult } from "../../src/result-envelope.js";
import type { AgentId } from "../../src/types.js";
import { AGY_SUCCESS_ENVELOPE } from "./result-envelope.js";

/** The parity-refusals check of run.answer-complete. Supported agents prove
 * the rule in their cited tests; agy's wire carries only the result
 * response, which is then the answer and the final message at once
 * (src/parity/reasons-run-answer.ts). */
export function answerCompleteOutcome(agent: AgentId): { message: null; code: null; omittedMetric?: true } {
  if (PARITY[agent]["run.answer-complete"].state === "supported") return { message: null, code: null };
  const envelope = JSON.parse(agyResult({ stdout: AGY_SUCCESS_ENVELOPE, stderr: "", exitCode: 0, success: true },
    { agent, prompt: "parity", resultJson: true }).stdout);
  expect(envelope.codemux.final_message).toBe(envelope.response);
  return { message: null, code: null, omittedMetric: true };
}
