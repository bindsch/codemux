/**
 * The codemux live-session protocol core (design §4.1, §4.2, §4.4):
 * validation of every caller input line, the output envelope's fixed
 * shape, and the shared event builders. Pure functions and small classes
 * only — no process, no clock beyond the timestamp the envelope carries,
 * no harness knowledge. The session layer (drivers) supplies state
 * through `InputContext`; the ceiling (§4.1) is src/session/ceiling.ts.
 *
 * Every non-blank input line is answered `input_accepted` or
 * `input_rejected` with the codemux-assigned `input_seq` (the CLI skips
 * blank lines and strips a trailing CR before they reach this layer); a
 * rejected line never stops the stream. Validation is strict and total: unknown types, unknown fields,
 * and bound violations are rejections, never silent drops.
 */

/** `text` bound (§4.1). This is not the deliverability bound: the harness
 * frame adds a JSON wrapper, an author prefix, and JSON-escaping of the
 * text (quotes double), so a text at this cap can serialize past the
 * 17 MiB harness write cap. The drivers pre-validate the frame they are
 * about to build (`harnessLineDeliverable` / `harnessTextDeliverable`,
 * src/session/process.ts) and reject with `text_too_long` before acking. */
export const MAX_INPUT_TEXT_BYTES = 16 * 1024 * 1024;
/** `author` bound: at most 64 code points (§4.4). */
export const MAX_AUTHOR_CODEPOINTS = 64;
/** Diagnostic string fields (`interrupt.reason`) bound. */
export const MAX_REASON_CHARS = 4096;
/** Harness-issued ids (`request_id`) bound. */
export const MAX_ID_CHARS = 128;

export type UserDuringTurn = "inject" | "queue" | false;

/** Capability flags exactly as `session_started` reports them (§4.3). */
export interface SessionCapabilities {
  live_input: boolean;
  user_during_turn: UserDuringTurn;
  steer: boolean;
  interrupt: boolean;
  permissions: boolean;
  deltas: boolean;
  file_changes: "native" | "derived" | false;
  usage_stream: boolean;
  resume: boolean;
}

export type InputMessage =
  | { type: "user"; text: string; author?: string }
  | { type: "steer"; text: string; author?: string }
  | { type: "interrupt"; reason?: string }
  | {
      type: "permission_decision";
      request_id: string;
      decision: "allow" | "deny";
      updated_input?: Record<string, unknown>;
    }
  | { type: "shutdown" };

export type InputRejectionReason =
  | "malformed"
  | "unknown_type"
  | "invalid_author"
  | "text_too_long"
  | "text_nul"
  | "reason_too_long"
  | "unsupported"
  | "busy"
  | "no_active_turn"
  | "unknown_request"
  | "autonomy_escalation"
  | "shutting_down";

/** The session state the parser needs to judge one input line. */
export interface InputContext {
  capabilities: SessionCapabilities;
  /** An active turn makes `user` follow `user_during_turn` and `steer`
   * live (or not). */
  hasActiveTurn: boolean;
  /** Pending permission-request ids; `permission_decision` must name one. */
  pendingRequestIds: ReadonlySet<string>;
  /** True once the shutdown path has started; everything but `shutdown`
   * is rejected. */
  shuttingDown: boolean;
}

export type ParsedInput =
  | { ok: true; message: InputMessage }
  | { ok: false; reason: InputRejectionReason };

const FORBIDDEN_AUTHOR_CATEGORY = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

/**
 * Validate one author label (§4.4): 1..64 code points, no Cc/Cf/Zl/Zp
 * category (NUL, ESC, NEL, bidi overrides, every Unicode line break), no
 * `[` or `]`, no unpaired surrogate. A bad author is rejected before
 * anything reaches the harness — an author containing `]` or a line break
 * could forge a second attributed line in the transcript.
 */
export function validateAuthor(author: string): boolean {
  let codePoints = 0;
  for (const character of author) {
    const code = character.codePointAt(0) as number;
    // A lone surrogate surfaces here as itself; a paired one never does
    // (the iterator yields the combined character).
    if (code >= 0xd800 && code <= 0xdfff) return false;
    if (character === "[" || character === "]") return false;
    if (FORBIDDEN_AUTHOR_CATEGORY.test(character)) return false;
    codePoints += 1;
  }
  return codePoints >= 1 && codePoints <= MAX_AUTHOR_CODEPOINTS;
}

function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

function boundedText(value: unknown): { text?: string; reason?: InputRejectionReason } {
  if (typeof value !== "string") return { reason: "malformed" };
  if (value.includes("\0")) return { reason: "text_nul" };
  if (utf8ByteLength(value) > MAX_INPUT_TEXT_BYTES) return { reason: "text_too_long" };
  return { text: value };
}

/**
 * Parse and judge one caller input line. Never throws: every failure is a
 * rejection the stream survives (§4.1). Capability-false inputs are
 * rejected, never silently ignored.
 */
export function parseInputLine(
  line: string,
  context: InputContext
): ParsedInput {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: "malformed" };
  }
  const record = parsed as Record<string, unknown>;
  const type = record["type"];
  if (typeof type !== "string") return { ok: false, reason: "malformed" };
  const keys = Object.keys(record);

  if (context.shuttingDown && type !== "shutdown") {
    return { ok: false, reason: "shutting_down" };
  }

  switch (type) {
    case "user":
    case "steer": {
      if (type === "steer" && !context.capabilities.steer) {
        return { ok: false, reason: "unsupported" };
      }
      if (!context.capabilities.live_input) {
        return { ok: false, reason: "unsupported" };
      }
      if (
        type === "user" &&
        context.hasActiveTurn &&
        context.capabilities.user_during_turn === false
      ) {
        return { ok: false, reason: "busy" };
      }
      if (type === "steer" && !context.hasActiveTurn) {
        return { ok: false, reason: "no_active_turn" };
      }
      const allowed = ["type", "text", "author"];
      if (keys.some((key) => !allowed.includes(key))) {
        return { ok: false, reason: "malformed" };
      }
      const { text, reason } = boundedText(record["text"]);
      if (text === undefined) return { ok: false, reason: reason ?? "malformed" };
      if (record["author"] !== undefined) {
        if (typeof record["author"] !== "string" || !validateAuthor(record["author"])) {
          return { ok: false, reason: "invalid_author" };
        }
        return { ok: true, message: { type, text, author: record["author"] } };
      }
      return { ok: true, message: { type, text } };
    }
    case "interrupt": {
      if (!context.capabilities.interrupt) {
        return { ok: false, reason: "unsupported" };
      }
      if (keys.some((key) => key !== "type" && key !== "reason")) {
        return { ok: false, reason: "malformed" };
      }
      if (record["reason"] !== undefined) {
        if (typeof record["reason"] !== "string" || record["reason"].includes("\0")) {
          return { ok: false, reason: "malformed" };
        }
        if (record["reason"].length > MAX_REASON_CHARS) {
          return { ok: false, reason: "reason_too_long" };
        }
        return { ok: true, message: { type, reason: record["reason"] } };
      }
      // The line is valid with or without a `reason`; whether an
      // interrupt with no active turn is a no-op is each driver's call
      // (it owns the turn state), not this parser's — every driver
      // acks and no-ops it (§4.1).
      return { ok: true, message: { type } };
    }
    case "permission_decision": {
      if (!context.capabilities.permissions) {
        return { ok: false, reason: "unsupported" };
      }
      if (
        keys.some(
          (key) => key !== "type" && key !== "request_id" && key !== "decision" && key !== "updated_input"
        )
      ) {
        return { ok: false, reason: "malformed" };
      }
      const requestId = record["request_id"];
      if (
        typeof requestId !== "string" ||
        requestId.length === 0 ||
        requestId.length > MAX_ID_CHARS ||
        requestId.includes("\0")
      ) {
        return { ok: false, reason: "malformed" };
      }
      if (!context.pendingRequestIds.has(requestId)) {
        return { ok: false, reason: "unknown_request" };
      }
      const decision = record["decision"];
      if (decision !== "allow" && decision !== "deny") {
        return { ok: false, reason: "malformed" };
      }
      const updatedInput = record["updated_input"];
      if (
        updatedInput !== undefined &&
        (typeof updatedInput !== "object" ||
          updatedInput === null ||
          Array.isArray(updatedInput))
      ) {
        return { ok: false, reason: "malformed" };
      }
      return {
        ok: true,
        message: updatedInput === undefined
          ? { type, request_id: requestId, decision }
          : { type, request_id: requestId, decision, updated_input: updatedInput as Record<string, unknown> },
      };
    }
    case "shutdown":
      if (keys.length !== 1) {
        return { ok: false, reason: "malformed" };
      }
      return { ok: true, message: { type } };
    default:
      return { ok: false, reason: "unknown_type" };
  }
}

/** The `[<author>] ` transcript prefix (§4.4); a display aid, never the
 * attribution record — the echoed `user_message` event is. */
export function applyAuthorPrefix(
  text: string,
  author: string | undefined,
  enabled: boolean
): string {
  if (!enabled || author === undefined) return text;
  return `[${author}] ${text}`;
}

export type EventName =
  | "session_started"
  | "input_accepted"
  | "input_rejected"
  | "user_message"
  | "permission_request"
  | "permission_resolved"
  | "unknown"
  | "turn_started"
  | "assistant_delta"
  | "assistant_message"
  | "tool_call"
  | "tool_result"
  | "file_change"
  | "usage"
  | "turn_completed"
  | "error"
  | "session_ended";

/**
 * Build one output event line. Key order is fixed — `seq`, `ts`,
 * `session_id`, `type`, `raw`, then the payload — and `raw` carries the
 * harness's original line verbatim for every harness-mirrored event and
 * `null` on codemux-originated ones (§4.2). Serialization happens here so
 * every event the caller ever sees has one shape.
 */
export function buildEvent(
  seq: number,
  sessionId: string,
  type: EventName,
  raw: string | null,
  fields: Record<string, unknown> = {}
): string {
  const envelope: Record<string, unknown> = {
    seq,
    ts: new Date().toISOString(),
    session_id: sessionId,
    type,
    raw,
  };
  for (const [key, value] of Object.entries(fields)) {
    envelope[key] = value;
  }
  return JSON.stringify(envelope);
}

/** The `input_accepted`/`input_rejected` ack for one input line. */
export function buildInputAck(
  seq: number,
  sessionId: string,
  inputSeq: number,
  accepted: boolean,
  reason?: InputRejectionReason
): string {
  return accepted
    ? buildEvent(seq, sessionId, "input_accepted", null, { input_seq: inputSeq })
    : buildEvent(seq, sessionId, "input_rejected", null, {
        input_seq: inputSeq,
        reason: reason ?? "malformed",
      });
}

/** The `user_message` echo — the authoritative attribution record. */
export function buildUserMessage(
  seq: number,
  sessionId: string,
  inputSeq: number,
  text: string,
  author: string | undefined,
  turnId: string | null
): string {
  return buildEvent(seq, sessionId, "user_message", null, {
    input_seq: inputSeq,
    text,
    ...(author !== undefined ? { author } : {}),
    ...(turnId !== null ? { turn_id: turnId } : {}),
  });
}

/** `permission_resolved` when a request leaves the pending set for any
 * reason (§4.2): allow, deny, timeout, superseded. */
export function buildPermissionResolved(
  seq: number,
  sessionId: string,
  requestId: string,
  resolution: "allow" | "deny" | "timeout" | "superseded"
): string {
  return buildEvent(seq, sessionId, "permission_resolved", null, {
    request_id: requestId,
    resolution,
  });
}

/** The tier-1 `unknown` event: a valid harness event codemux does not
 * map, raw preserved, session continuing. */
export function buildUnknownEvent(
  seq: number,
  sessionId: string,
  raw: string
): string {
  return buildEvent(seq, sessionId, "unknown", raw);
}
