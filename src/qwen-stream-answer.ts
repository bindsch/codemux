/** Qwen's complete answer (lane AN1, src/answer-complete.ts). Every qwen
 * run launches with `--output-format stream-json`: one message per line,
 * `{"type":...}` first (StreamJsonOutputAdapter.emitMessageImpl, qwen-code
 * 0.24.0 chunks/chunk-6XRR4RYH.js:1090, read 2026-11-10). The result
 * message's `result` is only the LAST assistant message's text
 * (buildResultMessage: `extractTextFromBlocks(lastAssistantMessage...)`,
 * :890), so the answer is rebuilt from the assistant messages:
 *
 * - an assistant message holds one block type only (buildMessage, :131),
 *   so text and tool calls arrive as separate messages keyed by
 *   `message.id`; a tool_use message closes the open text message;
 * - `stop_reason` is only ever "tool_use" or null (:144): the wire names
 *   no length stop, so `truncated` stays false;
 * - `parent_tool_use_id` non-null marks a subagent's message, which is
 *   not the run's answer;
 * - a user message whose content carries text (or is a string) is a user
 *   turn; tool results ride user messages of tool_result blocks only.
 *
 * A capture may also be the json format's single array line (older
 * launches and fixtures): its elements are read the same way. */
import { AnswerCollector, type AnswerTranscript } from "./answer-complete.js";
import { StreamDropFold } from "./stream-drop-fold.js";

type Message = Record<string, unknown>;

/** Every message object in a capture: stream lines and array lines alike. */
export function qwenMessages(stdout: string): Message[] {
  const messages: Message[] = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    let parsed: unknown;
    try { parsed = JSON.parse(trimmed); } catch { continue; }
    for (const item of Array.isArray(parsed) ? parsed : [parsed]) {
      if (item !== null && typeof item === "object" && !Array.isArray(item)) messages.push(item as Message);
    }
  }
  return messages;
}

function blocks(message: Message): unknown[] | string | null {
  const content = (message.message as { content?: unknown } | undefined)?.content;
  return typeof content === "string" || Array.isArray(content) ? content : null;
}

const isBlock = (block: unknown, type: string): block is Record<string, unknown> =>
  block !== null && typeof block === "object" && (block as Message).type === type;

export function qwenUserTurn(message: Message): boolean {
  if (message.type !== "user" || message.parent_tool_use_id != null) return false;
  const content = blocks(message);
  return typeof content === "string" || (Array.isArray(content) && content.some((block) => isBlock(block, "text")));
}

export function qwenTranscript(messages: readonly Message[]): AnswerTranscript {
  const collector = new AnswerCollector();
  for (const message of messages) {
    if (message.parent_tool_use_id !== null && message.parent_tool_use_id !== undefined) continue;
    const content = blocks(message);
    if (message.type === "user") {
      if (qwenUserTurn(message)) collector.userTurn();
      continue;
    }
    if (message.type !== "assistant" || !Array.isArray(content)) continue;
    const rawId = (message.message as { id?: unknown }).id;
    const id = typeof rawId === "string" ? rawId : undefined;
    const texts = content.filter((block): block is Record<string, unknown> & { text: string } =>
      isBlock(block, "text") && typeof block.text === "string");
    // A message without text (tool calls only, or empty) is still a
    // message: the final one, when the run ends on it.
    if (texts.length === 0) { collector.close(); collector.text("", id); collector.close(); }
    for (const block of texts) collector.text(block.text, id);
  }
  return collector.transcript();
}

/** A tool-call-only assistant line, reduced to what the parser reads. */
function shrinkToolCalls(line: string): string {
  if (!line.startsWith('{"type":"assistant"')) return line;
  try {
    const message = JSON.parse(line) as Message;
    const content = blocks(message);
    if (!Array.isArray(content) || content.length === 0 || !content.every((block) => isBlock(block, "tool_use"))) return line;
    const inner = message.message as Message;
    return JSON.stringify({ type: "assistant", parent_tool_use_id: message.parent_tool_use_id ?? null,
      message: { id: inner.id, model: inner.model, content: [{ type: "tool_use" }], stop_reason: inner.stop_reason } });
  } catch {
    return line;
  }
}

/** The qwen run fold: user lines (the prompt echo and every tool result)
 * are shed as they stream; a run has one user turn, delivered before any
 * assistant text, so no reset is lost. Tool-call messages keep only their
 * boundary. */
export function qwenStreamFold(): StreamDropFold {
  return new StreamDropFold([{ opening: '{"type":"user"', marker: null }], shrinkToolCalls);
}
