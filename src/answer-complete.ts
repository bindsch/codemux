/** The complete answer of a run, the same rule on every harness (lane AN1,
 * feature `run.answer-complete`): the answer is ALL assistant text the
 * agent produced after the last user turn, in order, joined with a blank
 * line between messages — never only the final message. An agent that
 * writes its findings, then calls a tool, then closes with one sentence
 * (or with nothing) still answers with the findings: the defects this
 * module closes were a cursor run that printed "\n" after its tool calls
 * and a zai run that returned only the text after its last tool call.
 *
 * Each adapter feeds its structured stream into an AnswerCollector; the
 * plain path prints `assembleAnswer`, the `--result-json` answer field
 * carries it, and the codemux block adds `final_message` (the last
 * message alone, for consumers who want the old field) and `truncated`
 * (the harness reported a max-tokens or length stop on the last message). */
import { appendDiagnostic } from "./result-envelope/common.js";
import type { RunResult } from "./types.js";

/** What one run's stream said about its answer. */
export interface AnswerTranscript {
  /** Every assistant message's text after the last user turn, in order;
   * an empty message (a tool-call-only turn) is kept as "". */
  messages: string[];
  /** True when the harness reported a max-tokens or length stop on the
   * last assistant message. */
  truncated: boolean;
}

/** The codemux block fields this rule adds to every envelope. */
export interface AnswerBlockFields {
  /** The last assistant message alone (the pre-AN1 answer). When the
   * stream carried no assistant message, the harness's own answer field
   * (answerBlockFields' `harnessAnswer`), or null when there is none. */
  final_message: string | null;
  truncated: boolean;
}

const LENGTH_STOPS = new Set([
  "max_tokens", "length", "max_output_tokens", "max_tokens_reached", "output_token_limit",
]);

/** Whether a harness's stop or finish reason names the output-length limit
 * (Anthropic `max_tokens`, OpenAI `length`, Gemini `MAX_TOKENS`, ...). */
export function isLengthStop(reason: unknown): boolean {
  return typeof reason === "string" && LENGTH_STOPS.has(reason.toLowerCase());
}

/** Collects assistant text from a structured stream. A message is either
 * fed whole (`message`) or in pieces (`text` with the message's key, or
 * deltas with no key until `close`). */
export class AnswerCollector {
  private messages: string[] = [];
  private open = false;
  private openKey: string | undefined;
  private lengthStop = false;

  /** A user turn: everything collected so far belongs to an earlier
   * exchange, so the answer restarts. */
  userTurn(): void {
    this.messages = [];
    this.open = false;
    this.openKey = undefined;
    this.lengthStop = false;
  }

  /** Appends text to the open message when the key matches (or neither
   * names one); otherwise opens a new message. */
  text(text: string, key?: string): void {
    const last = this.messages.length - 1;
    if (this.open && key === this.openKey && last >= 0) {
      this.messages[last] += text;
      return;
    }
    this.messages.push(text);
    this.open = true;
    this.openKey = key;
    this.lengthStop = false;
  }

  /** Closes the open message: the next text starts a new one. A tool call
   * between two text runs is such a boundary. */
  close(): void {
    this.open = false;
    this.openKey = undefined;
  }

  /** One whole assistant message (an empty one included: a tool-call-only
   * message is the final message when nothing follows it). */
  message(text: string, stopReason?: unknown): void {
    this.close();
    this.text(text);
    this.close();
    if (stopReason !== undefined) this.stop(stopReason);
  }

  /** The stop reason the harness reported for the latest message. */
  stop(reason: unknown): void {
    this.lengthStop = isLengthStop(reason);
  }

  /** Marks the latest message length-stopped from a run-level report. */
  markTruncated(): void {
    this.lengthStop = true;
  }

  get size(): number {
    return this.messages.length;
  }

  transcript(): AnswerTranscript {
    return { messages: [...this.messages], truncated: this.lengthStop };
  }
}

/** The answer: every non-empty message in order, a blank line between
 * two. A single message is returned verbatim; between messages the
 * earlier one's trailing whitespace and the later one's leading newlines
 * are dropped so exactly one blank line separates them. */
export function assembleAnswer(messages: readonly string[]): string {
  const parts = messages.filter((message) => message.trim() !== "");
  if (parts.length <= 1) return parts[0] ?? "";
  const last = parts.length - 1;
  return parts
    .map((part, index) => {
      const head = index > 0 ? part.replace(/^\n+/u, "") : part;
      return index < last ? head.replace(/\s+$/u, "") : head;
    })
    .join("\n\n");
}

/** The answer a run reports: the assembled transcript when it carries
 * text, else the harness's own answer field (a stream the parser could not
 * attribute, or a fixture that carries only the result object). */
export function completeAnswer(transcript: AnswerTranscript | null, harnessAnswer: string | null): string | null {
  const assembled = transcript === null ? "" : assembleAnswer(transcript.messages);
  return assembled.trim() !== "" ? assembled : harnessAnswer;
}

/** The block fields: the last message (falling back to the harness's own
 * answer field when the stream named no message) and the length flag. */
export function answerBlockFields(transcript: AnswerTranscript | null, harnessAnswer: string | null = null): AnswerBlockFields {
  const messages = transcript?.messages ?? [];
  return {
    final_message: messages.length > 0 ? messages[messages.length - 1]! : harnessAnswer,
    truncated: transcript?.truncated ?? false,
  };
}

/** The one stderr line a length-stopped run prints. */
export function truncationLine(agent: string): string {
  return `codemux: ${agent} reported a max-tokens or length stop on its last message; the answer is likely truncated`;
}

/** Appends the truncation line when the transcript reports a length stop. */
export function withTruncationNotice(result: RunResult, agent: string, transcript: AnswerTranscript | null): RunResult {
  if (transcript?.truncated !== true) return result;
  return { ...result, stderr: appendDiagnostic(result.stderr, truncationLine(agent)) };
}
