/** The kimi plain fold's per-line classification: which streamed lines are
 * the stream-json wire, and which of those the plain verdict never reads.
 * The fold itself (KimiPlainFold, kimi-fold.ts) owns the capture state;
 * these pure functions decide a line's fate from its bytes alone.
 * src/plain-unwrap.ts owns the public surface and the module overview. */
import { kimiWireShapedLine, parseKimiStreamLine } from "../session/kimi-session.js";

/** Whether a line opens like the stream-json wire the launch asked for —
 * the same rule kimiPlainResult's hatch applies to the first non-empty
 * line (kimiWireShapedLine, src/session/kimi-session.ts): a line that
 * parses as a JSON object with a recognized role, or the error event's
 * type. Text, any other JSON value, and a `{`-shaped line that does not
 * parse alone (one line of an indented object) keep the plain hatch
 * (lane C30, item 3). */
export function wireShapedLine(line: string): boolean {
  return kimiWireShapedLine(line);
}

/** The openings of the two event kinds the plain path never reads, in the
 * pinned writer's own spelling (PromptJsonWriter, kimi 0.31.1, stringifies
 * with `role` first and `content` — when present — before `tool_calls`):
 * every tool result's output rides `{"role":"tool",…}` and every tool
 * call's input rides an assistant object with no content,
 * `{"role":"assistant","tool_calls":…}`. A line that opens with either
 * stays a tool payload however long it grows, so the fold can shed it
 * from its prefix alone, without ever holding the whole line. Any other
 * opening — an assistant line with content, a meta line, an unrecognized
 * role, text — stays subject to the whole-line capture bound: a wrong
 * guess here would discard a line the plain verdict reads. */
const DROPPED_LINE_OPENINGS = [
  '{"role":"tool"',
  '{"role":"assistant","tool_calls":',
] as const;

/** Whether a streamed prefix opens one of the two droppable shapes. */
export function payloadOpening(prefix: string): boolean {
  return DROPPED_LINE_OPENINGS.some((opening) => prefix.startsWith(opening));
}

/** Whether one completed wire line is a tool payload the plain path never
 * reads: a valid `tool` event (every tool result's output rides these), or
 * a valid assistant event with no text (tool calls only — their inputs ride
 * these). The classification runs the same two checks kimiResult's parser
 * runs on the whole capture (a recognized role, then the line grammar), so
 * a line that would FAIL that parser downstream is kept verbatim and fails
 * there exactly as the whole-capture path does; only lines the parser would
 * accept and the plain verdict would ignore are dropped. `sessionId` is the
 * resume-hint state threaded across lines, as the parser threads it.
 *
 * A line carrying BOTH text and tool calls is kept with its `tool_calls`
 * field dropped (`keptLine`): the plain verdict reads only the text, and
 * the calls' arguments are exactly the volume this fold exists to shed —
 * kept verbatim, one such line's megabyte argument would ride the capture
 * to the bound (review round 11, edges 5). Whatever is shed — a dropped
 * line whole, or a kept line's `tool_calls` field — is answered as
 * `droppedText` so the fold can scan it for planted canary markers
 * (scanDroppedPayload): the bytes leave the capture, but a leak they
 * carry must still reach the canary verdict (review round 17,
 * contracts-2 1). */
export function toolPayloadLine(
  line: string,
  sessionId: string | null
): { drop: boolean; sessionId: string | null; keptLine?: string; droppedText?: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return { drop: false, sessionId };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { drop: false, sessionId };
  }
  const record = parsed as Record<string, unknown>;
  // A role that is not a string is not a wire role: `String()` on an object
  // with a null toString throws (review round 55), so the line stays plain.
  const role = typeof record.role === "string" ? record.role : null;
  const recognized = (role !== null && ["assistant", "tool", "meta"].includes(role)) || record.type === "error";
  if (!recognized) return { drop: false, sessionId };
  const parse = parseKimiStreamLine(line, { knownSessionId: sessionId });
  if (parse.kind === "grammar_error") return { drop: false, sessionId };
  if (parse.kind === "resume_hint") sessionId = parse.sessionId;
  if (role === "tool") return { drop: true, sessionId, droppedText: line };
  if (role === "assistant" && parse.kind === "assistant") {
    if (parse.text === null) return { drop: true, sessionId, droppedText: line };
    if (record["tool_calls"] !== undefined) {
      const { ["tool_calls"]: dropped, ...textOnly } = record;
      return {
        drop: false,
        sessionId,
        keptLine: JSON.stringify(textOnly),
        droppedText: JSON.stringify(dropped),
      };
    }
  }
  return { drop: false, sessionId };
}
