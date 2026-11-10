/** The aider session turn's complete answer (lane AN1): every reply the
 * model wrote after the turn's user header, in order, a blank line
 * between two. Aider records each reply with `io.ai_output` and the tool
 * chatter around it (applied edits, lint and test output) as `> ` lines;
 * a lint or test failure makes aider reflect (base_coder.run_one at
 * 0.86.2 sends `reflected_message` without writing a `#### ` header), so
 * one caller turn can hold several replies separated by chatter. The
 * single-reply extraction (aiderReplyAfterHeader) stops at the first
 * chatter line after the answer and kept only the first reply; this
 * splits the text at every chatter block and runs that same extraction
 * on each part, so the per-reply rules (reasoning stripped, blank lines
 * inside a reply kept) stay one implementation. */
import { assembleAnswer } from "../answer-complete.js";
import { aiderReplyAfterHeader } from "../aider-history-text.js";

/** The complete answer in the history text AFTER the turn's header. */
export function aiderTurnAnswer(afterHeader: string): string {
  const parts: string[][] = [[]];
  for (const raw of afterHeader.split("\n")) {
    // Aider's own mark is `> `-with-space (aiderReplyAfterHeader's rule).
    if (raw.startsWith("> ")) {
      if (parts[parts.length - 1]!.length > 0) parts.push([]);
      continue;
    }
    parts[parts.length - 1]!.push(raw);
  }
  return assembleAnswer(parts.map((lines) => aiderReplyAfterHeader(lines.join("\n"))));
}

/** The loose-anchor fallback (extractAiderReply's rule): the first `#### `
 * line is the turn's header when the exact block was not found. */
export function aiderTurnAnswerLoose(history: string): string {
  const header = history.indexOf("#### ");
  if (header === -1) return "";
  const afterHeader = history.indexOf("\n", header);
  if (afterHeader === -1) return "";
  return aiderTurnAnswer(history.slice(afterHeader + 1));
}
