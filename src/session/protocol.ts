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

import type { AutonomyLevel } from "../types.js";

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
/** Harness-issued ids bound (the raw id a harness assigns). */
export const MAX_ID_CHARS = 128;
/** A caller-facing `request_id` is the harness id's JSON spelling (codex:
 * string ids keep their quotes, every character may be escaped as
 * \uXXXX), so the decision's bound is that spelling's longest form
 * (review round 74). */
export const MAX_REQUEST_ID_CHARS = MAX_ID_CHARS * 6 + 2;
/** `permission_decision.message` bound, in UTF-16 code units. */
export const MAX_DECISION_MESSAGE_UNITS = 2000;

/** A `request_id` the caller protocol can answer: a non-empty string within
 * `MAX_REQUEST_ID_CHARS` and free of NUL. ONE predicate for both sides of
 * the permission channel (review round 104): the decision parser rejects an
 * id that fails it as `malformed`, so a driver that emits such an id as a
 * `permission_request` would register a pending request no decision can
 * ever resolve — the harness then waits until the turn timeout. The
 * claude-family parser therefore routes a `can_use_tool` whose id fails
 * this predicate to its own answer instead of a permission request
 * (src/session/claude-session/parser.ts). */
export function isAnswerableRequestId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_REQUEST_ID_CHARS &&
    !value.includes("\0")
  );
}

export type UserDuringTurn = "inject" | "queue" | false;

/** The served-model fields every `session_started` and `turn_completed`
 * carries (design P5): the model a wire line named, which side named it
 * (`provider`: the provider's own report, claude `message.model`/
 * `modelUsage` or codex `model/rerouted`; `harness`: the configured
 * model, claude init or the codex thread response), and the `-m` alias
 * as typed. A wire that names no model reports null: a declared
 * limitation, never a missing field (docs/session-protocol). */
export interface SessionModelFields {
  model_served: string | null;
  model_served_source: "provider" | "harness" | null;
  /** The `-m` value as typed when it resolved through config.models, else null. */
  model_alias: string | null;
}

/** The payload every driver's `session_started` carries beside its own
 * extra keys (agy adds `hermetic`): one interface, one builder, so the
 * field set cannot drift per driver. `sandbox_trust` serializes as the
 * trust string the driver recorded. */
export interface SessionStartedFields extends SessionModelFields {
  agent: string;
  model: string | null;
  autonomy: AutonomyLevel;
  cwd: string;
  sandboxed: boolean;
  sandbox_trust: string;
  capabilities: SessionCapabilities;
  protocol: string;
  private_home: string | null;
}

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
      /** The denial text the harness shows the model; a deny may carry
       * one, an allow never does. */
      message?: string;
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

/** A `permission_decision` denial message: 1..2000 UTF-16 code units,
 * no NUL, no control character other than newline (the author rule's Cc
 * set minus LF — the one break a rejection text may need). */
function validDenialMessage(message: string): boolean {
  if (message.length < 1 || message.length > MAX_DECISION_MESSAGE_UNITS) {
    return false;
  }
  for (let index = 0; index < message.length; index += 1) {
    const code = message.charCodeAt(index);
    if (code === 0x0a) continue;
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return false;
  }
  return true;
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
      const duringTurn = type === "user" && context.hasActiveTurn;
      if (duringTurn && context.capabilities.user_during_turn === false) {
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
    case "permission_response":
    case "permission_decision": {
      if (!context.capabilities.permissions) {
        return { ok: false, reason: "unsupported" };
      }
      const allowedDecisionKeys = ["type", "request_id", "decision", "updated_input", "message"];
      if (keys.some((key) => !allowedDecisionKeys.includes(key))) {
        return { ok: false, reason: "malformed" };
      }
      const requestId = record["request_id"];
      if (!isAnswerableRequestId(requestId)) {
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
      const denialMessage = record["message"];
      if (denialMessage !== undefined) {
        // The message rides a deny only (§4.1): with an allow it is
        // rejected the way an unknown key is, never silently dropped.
        if (
          decision !== "deny" ||
          typeof denialMessage !== "string" ||
          !validDenialMessage(denialMessage)
        ) {
          return { ok: false, reason: "malformed" };
        }
      }
      return {
        ok: true,
        message: {
          // `permission_response` is the consumer's alias (the Self-Grant
          // study's runner); it normalizes to the one decision frame.
          type: "permission_decision",
          request_id: requestId,
          decision,
          ...(updatedInput === undefined
            ? {}
            : { updated_input: updatedInput as Record<string, unknown> }),
          ...(denialMessage === undefined ? {} : { message: denialMessage }),
        },
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
  | "warning"
  | "session_started"
  | "input_accepted"
  | "input_rejected"
  | "user_message"
  | "permission_request"
  | "permission_resolved"
  | "permission_denied"
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
  if (type === "tool_call" && (envelope.input === null || typeof envelope.input !== "object" ||
      Array.isArray(envelope.input))) envelope.input = {};
  return JSON.stringify(envelope);
}

/** The `session_started` announcement (§4.2), built once for every
 * driver, so the payload set stays uniform (design P5, the parity
 * rule). `raw` mirrors the harness line that proved the identity when
 * one exists, null on codemux-made ones; extra keys pass through (agy's
 * `hermetic`). */
export function buildSessionStarted(
  seq: number,
  sessionId: string,
  raw: string | null,
  fields: SessionStartedFields & Record<string, unknown>
): string {
  return buildEvent(seq, sessionId, "session_started", raw, { ...fields });
}

/** The `input_accepted`/`input_rejected` ack for one input line. The
 * optional `message` is the denial text the harness was sent — present
 * on `autonomy_escalation`, whose deny the caller never chose. */
export function buildInputAck(
  seq: number,
  sessionId: string,
  inputSeq: number,
  accepted: boolean,
  reason?: InputRejectionReason,
  message?: string
): string {
  return accepted
    ? buildEvent(seq, sessionId, "input_accepted", null, { input_seq: inputSeq })
    : buildEvent(seq, sessionId, "input_rejected", null, {
        input_seq: inputSeq,
        reason: reason ?? "malformed",
        ...(message !== undefined ? { message } : {}),
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
 * reason (§4.2): allow, deny, timeout, superseded. The optional
 * `message` is the denial text the harness was sent — present whenever
 * the resolution carried one, omitted on an allow and on a Codex decline
 * (its wire answer carries no text). */
export function buildPermissionResolved(
  seq: number,
  sessionId: string,
  requestId: string,
  resolution: "allow" | "deny" | "timeout" | "superseded",
  message?: string
): string {
  return buildEvent(seq, sessionId, "permission_resolved", null, {
    request_id: requestId,
    resolution,
    ...(message !== undefined ? { message } : {}),
  });
}

/** `permission_denied`: the `--permission-policy deny` mode's record of a
 * request it answered the moment it arrived. The request never joins the
 * pending set — no caller decision can arrive for it — so this, not
 * `permission_resolved`, is the one record of how it left. `message` is
 * the denial text the harness was sent. */
export function buildPermissionDenied(
  seq: number,
  sessionId: string,
  requestId: string,
  tool: string,
  message: string
): string {
  return buildEvent(seq, sessionId, "permission_denied", null, {
    request_id: requestId,
    tool,
    message,
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
