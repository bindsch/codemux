/** Gemini's complete answer (lane AN1, src/answer-complete.ts). Every
 * gemini run launches with `--output-format stream-json`: the json format
 * keeps only the text after the last tool request (`preToolResponseText =
 * responseText || ...; responseText = ""` on every tool_request, Gemini CLI
 * 0.60.0 bundle/gemini-LUNNHKPJ.js:11494, read 2026-11-10), so a run that
 * wrote its findings before a tool call lost them. The stream wire carries
 * every piece:
 *
 * - `{type:"init",session_id,model}` first (:11300);
 * - `{type:"message",role:"user",content}` for the prompt (:11336);
 * - `{type:"message",role:"assistant",content,delta:true}` per text chunk
 *   (:11470, :11872);
 * - `{type:"tool_use",tool_name,tool_id,parameters}` per tool request
 *   (:11498) and `{type:"tool_result",tool_id,status,output}` per reply;
 * - `{type:"error",severity,message}`, where a MAX_TOKENS stop with no text
 *   carries MAX_TOKENS_EXCEEDED_SUGGESTION (:11565);
 * - `{type:"result",status,stats,error?}` last (:11376, :11007).
 *
 * The fold below drops tool payloads as they stream so a long tool-using
 * run stays inside the capture bound; the json and text formats never put
 * them on stdout either. */
import { AnswerCollector, completeAnswer, type AnswerTranscript } from "./answer-complete.js";
import { StreamDropFold } from "./stream-drop-fold.js";

/** The text gemini prints when the model stopped at its output-token limit
 * (chunk-M6NSK26M.js:253638). */
const MAX_TOKENS_TEXT = "exceeded the token limit";

export interface GeminiStream {
  /** The json-format envelope rebuilt from the stream: session_id,
   * response (the complete answer), stats, and error when the run failed. */
  envelope: Record<string, unknown>;
  transcript: AnswerTranscript;
}

/** Parses a stream-json capture; null when no line is a JSON object (stdout
 * no stream-json launch would print). Throws nothing. */
export function parseGeminiStream(stdout: string): GeminiStream | null {
  const collector = new AnswerCollector();
  let sessionId: unknown;
  let final: Record<string, unknown> | undefined;
  let sawEvent = false;
  for (const line of stdout.split("\n")) {
    if (line.trim() === "") continue;
    let event: unknown;
    try { event = JSON.parse(line); } catch { continue; }
    if (event === null || typeof event !== "object" || Array.isArray(event)) continue;
    const frame = event as Record<string, unknown>;
    sawEvent = true;
    if (frame.type === "init") sessionId ??= frame.session_id;
    else if (frame.type === "message" && frame.role === "user") collector.userTurn();
    else if (frame.type === "message" && frame.role === "assistant" && typeof frame.content === "string") collector.text(frame.content);
    // A tool call ends the open message; the text after it (none, when the
    // run ended on the call) is the next message.
    else if (frame.type === "tool_use") { collector.close(); collector.text(""); }
    else if (frame.type === "error" && typeof frame.message === "string" && frame.message.includes(MAX_TOKENS_TEXT)) collector.markTruncated();
    else if (frame.type === "result") final = frame;
  }
  if (!sawEvent) return null;
  const transcript = collector.transcript();
  const response = completeAnswer(transcript, null) ?? "";
  const envelope: Record<string, unknown> = {
    ...(typeof sessionId === "string" ? { session_id: sessionId } : {}),
    response,
    ...(final?.stats !== undefined ? { stats: final.stats } : {}),
    ...(final?.status !== "success" ? { error: final?.error ?? "Gemini stream has no successful terminal result" } : {}),
  };
  return { envelope, transcript };
}

/** The gemini run fold: a `tool_use` line shrinks to its type (the message
 * boundary the parser reads), a `tool_result` line goes (both open with
 * `{"type":...`, StreamJsonFormatter.emitEvent's JSON.stringify order). */
export function geminiStreamFold(): StreamDropFold {
  return new StreamDropFold([
    { opening: '{"type":"tool_result"', marker: null },
    { opening: '{"type":"tool_use"', marker: '{"type":"tool_use"}' },
  ]);
}
