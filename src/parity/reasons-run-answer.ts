import type { AgentId } from "../types.js";
import { limitation, supported, type FeatureState } from "./features.js";

/** `run.answer-complete` (lane AN1): a run's answer is every assistant
 * message after the last user turn, joined with a blank line; the codemux
 * block keeps the last message as `final_message` and flags a reported
 * length stop as `truncated` (src/answer-complete.ts). */
export const ANSWER_COMPLETE: Readonly<Record<AgentId, FeatureState>> = {
  claude: supported("tests/answer-complete-claude.test.ts",
    "Every run reads --output-format stream-json --verbose; the agent's own assistant messages (no subagent or hook frames) form the answer. A max_tokens stop reason sets truncated."),
  zai: supported("tests/answer-complete-claude.test.ts",
    "Same binary and stream as claude; the zai report of 2026-11-10 (answer started at finding 20) is the regression fixture."),
  codex: supported("tests/answer-complete-codex.test.ts",
    "Codex exec --json carries every agent_message item of the turn. The wire has no per-message stop reason; a max_output_tokens incomplete response fails the turn and sets truncated."),
  cursor: supported("tests/answer-complete-g2.test.ts",
    "Every run reads stream-json; assistant text events split at tool_call events, because the result line glues all segments with no separator. The wire names no stop reason."),
  gemini: supported("tests/answer-complete-g2.test.ts",
    "Every run reads stream-json: the json format resets its response text on every tool request (Gemini CLI 0.60.0). A MAX_TOKENS error event sets truncated."),
  qwen: supported("tests/answer-complete-g2.test.ts",
    "Every run reads stream-json: the result message carries only the last assistant message (qwen-code 0.24.0 buildResultMessage). stop_reason is only tool_use or null."),
  copilot: supported("tests/answer-complete-g2.test.ts",
    "Every run reads the JSONL wire (--output-format json): one assistant.message per model call. No stop reason is recorded."),
  droid: supported("tests/answer-complete-g3.test.ts",
    "Every run uses exec -o stream-json: the json format's finalText is the last text block alone. The fold keeps a stub for each shed tool call, so a run that ends on one reports final_message \"\". The stream names no stop reason."),
  goose: supported("tests/answer-complete-g3.test.ts",
    "Every run uses run --output-format stream-json; chunks of one message id join, messages join with a blank line; outputTokenLimitReached on the last message sets truncated."),
  opencode: supported("tests/answer-complete-g3.test.ts",
    "The --format json fold keeps every text part; a blank line separates steps; a step_finish reason of length on the last step sets truncated."),
  pi: supported("tests/answer-complete-g3.test.ts",
    "Every print run uses --mode json: text mode prints only the last assistant message. stopReason length on the last message sets truncated."),
  kimi: supported("tests/answer-complete-g4.test.ts",
    "Every stream-json assistant line joins into the reply; the plain fold keeps every text line. The stream carries no stop reason."),
  openhands: supported("tests/answer-complete-g4.test.ts",
    "Plain and --result-json runs ride --json; thoughts before tool calls, agent messages, and finish-tool messages after the last user message form the answer."),
  cline: supported("tests/answer-complete-g4.test.ts",
    "Every --json agent_event text block (one per assistant message) forms the answer; run_result.text is the fallback."),
  aider: supported("tests/answer-complete-g4.test.ts",
    "Aider 0.86.2 has no structured stream; its plain stdout is the whole transcript with every assistant response in order. A token-limit report sets the truncation line."),
  agy: limitation(
    "Agy 1.5.3 stream-json step_update events carry no text: the payload names only type_name, step_type, tool_name, and tool_info. The result event's response is built from the last response-bearing step (printmode.LastResponseBearingStepIndex), so text the agent wrote before a later tool call is not on the wire. Codemux reports the response as both the answer and codemux.final_message.",
    "2026-11-10: installed ~/.local/bin/agy 1.5.3; the step_update JSON tags json:\"type_name,omitempty\" (byte 160411241) through json:\"tool_info,omitempty\" (byte 160411352) with step_type and tool_name between them and no text field; Go symbols printmode.isResponseBearingStep and printmode.LastResponseBearingStepIndex; the stream-json changelog entry lists init, step_update, and result events only.",
    "final_message equals the answer", "tests/answer-complete-g4.test.ts"),
};
