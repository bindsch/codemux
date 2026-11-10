/** Goose's structured outputs read as a transcript (lane AN1). Every run
 * now launches with `run --output-format stream-json` (goose 1.50.1 `run
 * --help`: "Output format (text, json, stream-json)"), whose writer prints
 * one tagged event per line — `{"type":"message","message":{…}}` for
 * every agent message (streamed chunks of one reply share the message
 * `id`), `{"type":"notification","extension_id":…}` for extension logs
 * and progress, `{"type":"error","error":…}`, and a closing
 * `{"type":"complete","total_tokens":…}`. Evidence: the goose_cli
 * session module's serialized names in the installed 1.50.1 binary
 * (`notification extension_id log total`, the JsonOutput serializer
 * symbol `goose_cli..session..JsonOutput`), read 2026-11-10; the Message
 * struct's five fields (`id created content` beside `role`) and its
 * MessageMetadata (`userVisible agentVisible inference
 * outputTokenLimitReached steer turnContext usage operations`) from the
 * same binary's strings. `outputTokenLimitReached` on the last assistant
 * message is the truncation flag.
 *
 * The `--output-format json` shape — a `{messages, metadata}` object, or
 * the single message object the earlier parser was written for — is read
 * through the same message walk, so sessions (which still launch with
 * json) and older captures keep parsing. */
import { AnswerCollector, completeAnswer, type AnswerTranscript } from "./answer-complete.js";
import { AnswerStreamFold } from "./answer-stream-fold.js";

export interface GooseTranscript {
  /** The assistant messages after the last user text message. */
  transcript: AnswerTranscript;
  /** The complete answer, or null when no assistant text arrived. */
  answer: string | null;
  /** The last assistant message's text alone. */
  finalText: string | null;
  /** Every assistant message object, in order (usage and model metadata). */
  messages: Record<string, unknown>[];
  /** The stream's `complete` event, when one arrived. */
  complete: Record<string, unknown> | null;
  /** The first `error` event's text. */
  errorMessage: string | null;
}

const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;

/** A message's text parts, in order (a plain string content is its text). */
export function gooseMessageText(message: Record<string, unknown>): string | null {
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const part of content) {
    const typed = record(part);
    if (typed !== null && (typed.type === undefined || typed.type === "text") && typeof typed.text === "string") {
      parts.push(typed.text);
    }
  }
  return parts.length > 0 ? parts.join("") : null;
}

function walk(messages: Record<string, unknown>[], complete: Record<string, unknown> | null,
  errorMessage: string | null): GooseTranscript {
  const collector = new AnswerCollector();
  const assistants: Record<string, unknown>[] = [];
  let finalText: string | null = null;
  let finalId: unknown;
  for (const message of messages) {
    const text = gooseMessageText(message);
    if (message.role === "user") {
      if (text !== null && text.trim() !== "") collector.userTurn();
      continue;
    }
    if (message.role !== "assistant") continue;
    const id = typeof message.id === "string" ? message.id : undefined;
    // Chunks of one streamed reply share an id and join without a
    // separator; a message without an id is a whole message.
    if (id === undefined) collector.message(text ?? "");
    else collector.text(text ?? "", id);
    if (id === undefined || id !== finalId) finalText = text ?? "";
    else finalText = (finalText ?? "") + (text ?? "");
    finalId = id;
    const metadata = record(message.metadata);
    collector.stop(metadata?.outputTokenLimitReached === true ? "max_tokens" : undefined);
    assistants.push(message);
  }
  const transcript = collector.transcript();
  return { transcript, answer: completeAnswer(transcript, finalText), finalText, messages: assistants, complete, errorMessage };
}

/** Reads goose stdout as a transcript, or null when it carries neither
 * stream events nor a `{messages}` object (the caller's legacy
 * single-message path then applies). */
export function parseGooseTranscript(stdout: string): GooseTranscript | null {
  const whole = (() => { try { return record(JSON.parse(stdout)); } catch { return null; } })();
  if (whole !== null && Array.isArray(whole.messages)) {
    return walk(whole.messages.map(record).filter((m): m is Record<string, unknown> => m !== null), null, null);
  }
  const messages: Record<string, unknown>[] = [];
  let complete: Record<string, unknown> | null = null;
  let errorMessage: string | null = null;
  let sawStream = false;
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    let event: Record<string, unknown> | null;
    try { event = record(JSON.parse(trimmed)); } catch { continue; }
    if (event === null) continue;
    if (event.type === "message" && record(event.message) !== null) {
      sawStream = true;
      messages.push(record(event.message)!);
    } else if (event.type === "complete") {
      sawStream = true;
      complete = event;
    } else if (event.type === "error") {
      sawStream = true;
      errorMessage ??= typeof event.error === "string" ? event.error : JSON.stringify(event.error ?? null);
    } else if (event.type === "notification" || event.type === "model_change") {
      sawStream = true;
    }
  }
  return sawStream ? walk(messages, complete, errorMessage) : null;
}

/** Goose stream lines the answer never reads: extension notifications and
 * user-role messages (tool responses ride user messages; a user text turn
 * only resets an answer that is empty at that point in a one-prompt run).
 * No live capture pins the message's field order, so the rule does not
 * assume one: a message line is a user line when `"role":"user"` appears
 * in its opening before any `"content":` key. JSON escapes the quotes of
 * every string value, so that text is a real key and value; requiring it
 * before `content` keeps a nested role inside an assistant's tool
 * arguments from shedding the assistant's line. A line whose role is not
 * in view is kept. */
const SHED_NOTIFICATION = /^\{"type":"notification"/u;
const MESSAGE_OPENING = '{"type":"message","message":{';

/** Whether a goose message line's opening names the user role. */
export function isGooseUserMessageHead(trimmed: string): boolean {
  if (!trimmed.startsWith(MESSAGE_OPENING)) return false;
  const role = trimmed.indexOf('"role":"user"');
  if (role === -1) return false;
  const content = trimmed.indexOf('"content":');
  return content === -1 || role < content;
}

export function gooseStreamFold(): AnswerStreamFold {
  return new AnswerStreamFold((head) => {
    const trimmed = head.trimStart();
    return SHED_NOTIFICATION.test(trimmed) || isGooseUserMessageHead(trimmed) ? "drop" : "keep";
  });
}
