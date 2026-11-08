/**
 * The codex stream parser's scope checks, split from
 * src/session/codex-stream-parser.ts (review round 232, which also added
 * the lifecycle notifications to the pending window): the thread check
 * every translated notification passes, the two params shapes turn
 * notifications carry, and the turn-id rules — the open turn outside the
 * turn/start window, the provisional id inside it. Free functions over
 * the parser's context; the parser classifies, these validate.
 */

import { isRecord } from "./codex-parse-facts.js";
import type { CodexParseContext } from "./codex-session.js";

/** A grammar error a scope check returns; the parser relays it as-is. */
export interface ScopeError {
  kind: "grammar_error";
  message: string;
}

/** The thread-scope check every translated notification passes: the
 * event must reference the one thread this session owns. */
export function checkThread(threadId: string, context: CodexParseContext): ScopeError | null {
  if (context.threadId !== null && threadId !== context.threadId) {
    return {
      kind: "grammar_error",
      message: `an event references thread ${threadId}, expected ${context.threadId}`,
    };
  }
  return null;
}

/** Validate the thread-scoped params turn-lifecycle notifications
 * carry ({threadId, turn}): the turn identity rides the object. */
export function threadScopedParams(
  params: Record<string, unknown> | null,
  context: CodexParseContext
): { params: Record<string, unknown> | null; threadId: string; error: ScopeError | null } {
  if (params === null) {
    return { params: null, threadId: "", error: { kind: "grammar_error", message: "a turn notification carries no params" } };
  }
  const threadId = params["threadId"];
  if (typeof threadId !== "string") {
    return { params: null, threadId: "", error: { kind: "grammar_error", message: "a turn notification carries no thread id" } };
  }
  const threadError = checkThread(threadId, context);
  if (threadError !== null) {
    return { params: null, threadId: "", error: threadError };
  }
  return { params, threadId, error: null };
}

/** The {threadId, turnId} scope item and turn notifications share, plus
 * the open-turn requirement once a turn is involved. */
export interface ScopedParams {
  params: Record<string, unknown> | null;
  threadId: string;
  turnId: string | null;
  error: ScopeError | null;
}

/** Validate the {threadId, turnId} scope item and turn notifications
 * share, plus the open-turn requirement once a turn is involved. */
export function scopedParams(
  params: Record<string, unknown> | null,
  context: CodexParseContext
): ScopedParams {
  const grammar = (message: string): ScopedParams =>
    ({ params: null, threadId: "", turnId: null, error: { kind: "grammar_error", message } });
  if (params === null) return grammar("a scoped notification carries no params");
  const threadId = params["threadId"];
  if (typeof threadId !== "string") return grammar("a scoped notification carries no thread id");
  const threadError = checkThread(threadId, context);
  if (threadError !== null) return { params: null, threadId: "", turnId: null, error: threadError };
  // An explicit null turnId is the absent case (round 391, item 7): the raw
  // null once equaled the idle branch's null activeTurnId, slipping a stray
  // usage event past the no-open-turn grammar check and into the session's
  // cumulative bucket.
  const turnId = params["turnId"] ?? undefined;
  const straggler = typeof turnId === "string" && context.closedTurnIds?.has(turnId) === true;
  if (context.turnPending === true && context.activeTurnId === null) {
    // The turn/start window: the first id seen is provisional; a second
    // or missing id is a grammar error (rounds 67 and 70).
    const pending = context.pendingTurnId;
    if (typeof turnId !== "string" || turnId.length === 0) {
      return grammar("a scoped notification with no turn id arrived while a turn was starting");
    }
    if (typeof pending === "string" && turnId !== pending && !straggler) {
      return grammar(`a scoped notification for turn ${turnId} arrived while the starting turn's notifications name ${pending}`);
    }
  } else if (turnId !== context.activeTurnId && !straggler) {
    // Idle: no turn to own the event (round 64); closed turns' stragglers
    // stay accepted (real codex sends usage after turn/completed).
    return grammar(context.activeTurnId === null
      ? typeof turnId === "string"
        ? `a scoped notification for turn ${turnId} arrived with no open turn`
        : "a scoped notification with no turn id arrived while no turn is open"
      : `an event references turn ${String(turnId)} but the open turn is ${context.activeTurnId}`);
  }
  return { params, threadId, turnId: typeof turnId === "string" ? turnId : null, error: null };
}

/** The id check a turn-lifecycle notification (turn/started,
 * turn/completed) passes. Outside the turn/start window it must name the
 * open turn. Inside the window the provisional id is accepted the way a
 * delta's is — a fast server can emit the notification before the
 * response that names the turn (review round 232) — but a closed turn's
 * id never is: a lifecycle straggler would complete or re-announce a
 * turn other than the one being started. Returns the accepted id, or
 * the grammar error. */
export function lifecycleTurnId(
  params: Record<string, unknown> | null,
  method: string,
  context: CodexParseContext
): string | ScopeError {
  const turn = isRecord(params?.["turn"]) ? (params["turn"] as Record<string, unknown>) : null;
  const turnId = turn !== null ? turn["id"] : undefined;
  if (context.turnPending === true && context.activeTurnId === null) {
    // An empty id is no id: the response side refuses it too, and a
    // provisional "" would complete the turn under a name nothing can
    // match later (review round 250).
    if (typeof turnId !== "string" || turnId.length === 0) {
      return { kind: "grammar_error", message: `a ${method} notification carries no turn id while a turn is starting` };
    }
    if (context.closedTurnIds?.has(turnId) === true) {
      return { kind: "grammar_error", message: `a ${method} notification names the closed turn ${turnId} while a turn is starting` };
    }
    if (typeof context.pendingTurnId === "string" && turnId !== context.pendingTurnId) {
      return { kind: "grammar_error", message: `a ${method} notification for turn ${turnId} arrived while the starting turn's notifications name ${context.pendingTurnId}` };
    }
    return turnId;
  }
  if (context.activeTurnId === null) {
    return { kind: "grammar_error", message: method === "turn/started"
      ? "turn/started arrived before the turn/start response named the turn"
      : `turn/completed for ${String(turnId)} arrived with no open turn` };
  }
  if (typeof turnId !== "string" || turnId !== context.activeTurnId) {
    return { kind: "grammar_error", message: method === "turn/started"
      ? `turn/started names ${String(turnId)}, expected ${context.activeTurnId}`
      : `turn/completed names ${String(turnId)} but the open turn is ${context.activeTurnId}` };
  }
  return turnId;
}
