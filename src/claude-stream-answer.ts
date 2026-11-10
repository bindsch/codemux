/** The claude-family complete answer (lane AN1, claude and zai run the same
 * binary). Ordinary runs launch with `--output-format stream-json
 * --verbose`: the `json` format's `result` and the text format carry only
 * the final assistant message, so findings written before a tool call were
 * lost (the zai report of 2026-11-10: the reply started mid-sentence in
 * finding 20). The stream carries every assistant message; this module
 * folds it to what the answer needs and reads the answer back.
 *
 * Wire (Claude Code 2.1.317, bin/claude.exe, read 2026-11-10): each frame
 * is one JSON line opening `{"type":"assistant","message":{...` or
 * `{"type":"user","message":{...`; an assistant frame carries one message
 * (`message.id`, `message.content` blocks, `message.stop_reason`) and
 * `parent_tool_use_id` (non-null for a subagent's own messages, which are
 * not the agent's answer); hook messages carry `is_meta: true`. The last
 * frame is the result object (`type:"result"`, `result` = the final
 * message's text, `stop_reason`). A run has one user turn, its prompt,
 * which precedes every frame: later user frames are tool results and
 * harness injections, so they never restart the answer. */
import { AnswerCollector, type AnswerTranscript } from "./answer-complete.js";
import type { StdoutSink } from "./process-runner.js";
import { StreamMarkerScan } from "./stream-marker-scan.js";

/** What a claude-family stream says: the result object (null when the
 * stream carried none) and the transcript of the agent's own messages. */
export interface ClaudeStreamAnswer {
  resultFrame: Record<string, unknown> | null;
  transcript: AnswerTranscript;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function parseLine(line: string): Record<string, unknown> | null {
  const trimmed = line.trim();
  if (trimmed === "") return null;
  try {
    return record(JSON.parse(trimmed));
  } catch {
    return null;
  }
}

/** Whether an assistant frame is the agent's own message: not a
 * subagent's (parent_tool_use_id set) and not a hook's (is_meta). */
function ownAssistant(frame: Record<string, unknown>): Record<string, unknown> | null {
  if (frame.type !== "assistant") return null;
  if (frame.parent_tool_use_id !== undefined && frame.parent_tool_use_id !== null) return null;
  if (frame.is_meta === true || frame.isMeta === true) return null;
  return record(frame.message);
}

/** The text blocks of one assistant message, in order. */
function textBlocks(message: Record<string, unknown>): string[] {
  const content = message.content;
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];
  return content.flatMap((block) => {
    const entry = record(block);
    return entry?.type === "text" && typeof entry.text === "string" ? [entry.text] : [];
  });
}

/** Reads the answer from a claude-family stdout: the stream-json wire, the
 * folded form ClaudeStreamFold keeps, or a single `json` result object
 * (no messages: the caller falls back to its `result`). */
export function claudeStreamAnswer(stdout: string): ClaudeStreamAnswer {
  const collector = new AnswerCollector();
  let resultFrame: Record<string, unknown> | null = null;
  // A message's blocks arrive as separate frames sharing message.id; a
  // second text block of the same message is separated by a blank line.
  const textIds = new Set<string>();
  let anonymous = 0;
  for (const line of stdout.split("\n")) {
    const frame = parseLine(line);
    if (frame === null) continue;
    if (frame.type === "result") {
      resultFrame = frame;
      continue;
    }
    const message = ownAssistant(frame);
    if (message === null) continue;
    const id = typeof message.id === "string" && message.id !== "" ? message.id : `anonymous-${anonymous++}`;
    const texts = textBlocks(message);
    if (texts.length === 0) collector.text("", id);
    for (const text of texts) {
      collector.text(textIds.has(id) && text !== "" ? `\n\n${text}` : text, id);
      if (text !== "") textIds.add(id);
    }
    if (message.stop_reason !== undefined && message.stop_reason !== null) collector.stop(message.stop_reason);
  }
  if (resultFrame?.stop_reason === "max_tokens") collector.markTruncated();
  return { resultFrame, transcript: collector.transcript() };
}

/** The bytes a pending line may hold before a droppable frame (a user
 * frame, which carries tool results; a partial stream event) is shed. */
const PENDING_LINE_BOUND = 1024 * 1024;
const DROPPABLE_OPENINGS = ['{"type":"user"', '{"type":"stream_event"', '{"type":"system"'];

/** Folds the stream-json wire to the lines the answer needs: the agent's
 * own assistant messages reduced to their text and stop reason, and the
 * result object verbatim. Tool results, tool inputs, and system frames are
 * shed, so a long run that reads many files stays inside the capture bound
 * the `json` format never approached. A line that is not JSON is kept
 * verbatim: plain stdout from a binary codemux did not structure keeps the
 * unwrap's pass-through rule. */
export class ClaudeStreamFold implements StdoutSink {
  /** Sees every chunk before a frame is shed (src/stream-marker-scan.ts). */
  private readonly markers = new StreamMarkerScan();
  private pending = "";
  private skipping = false;
  private kept: string[] = [];
  private keptSize = 0;

  push(chunk: string): void {
    this.markers.push(chunk);
    let rest = chunk;
    while (rest !== "") {
      const newline = rest.indexOf("\n");
      if (newline === -1) {
        if (!this.skipping) {
          this.pending += rest;
          if (this.pending.length > PENDING_LINE_BOUND &&
              DROPPABLE_OPENINGS.some((opening) => this.pending.startsWith(opening))) {
            this.pending = "";
            this.skipping = true;
          }
        }
        return;
      }
      if (!this.skipping) this.line(this.pending + rest.slice(0, newline), true);
      this.pending = "";
      this.skipping = false;
      rest = rest.slice(newline + 1);
    }
  }

  /** Keeps a line's folded form; text that is not JSON keeps its own
   * bytes, an unterminated last line included, so a plain reply from a
   * binary codemux did not structure passes through unchanged. */
  private line(line: string, terminated: boolean): void {
    const kept = foldLine(line);
    if (kept === null) return;
    const spelled = kept === line && !terminated ? kept : `${kept}\n`;
    this.kept.push(spelled);
    this.keptSize += Buffer.byteLength(spelled);
  }

  finish(): string {
    if (!this.skipping && this.pending !== "") this.line(this.pending, false);
    this.pending = "";
    return this.kept.join("");
  }

  keptBytes(): number {
    return this.keptSize + Buffer.byteLength(this.pending);
  }

  /** Canary marker matches anywhere in the stream, shed frames included. */
  droppedMarkerEvidence(): string {
    return this.markers.evidence();
  }
}

/** One wire line's folded form, or null when the answer never reads it. */
export function foldLine(line: string): string | null {
  if (line.trim() === "") return line;
  const frame = parseLine(line);
  if (frame === null) return line;
  if (frame.type === "result") return line.trim();
  const message = ownAssistant(frame);
  // Every other typed frame (user, system, stream_event, a subagent's or a
  // hook's message, the SDK notifications) is shed; a JSON object with no
  // type is kept, so the unwrap still fails it as JSON that is no envelope.
  if (message === null) return typeof frame.type === "string" ? null : line.trim();
  return JSON.stringify({
    type: "assistant",
    message: {
      id: message.id ?? null,
      stop_reason: message.stop_reason ?? null,
      content: textBlocks(message).map((text) => ({ type: "text", text })),
    },
  });
}
