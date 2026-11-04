/**
 * The codex app-server NDJSON stream parser (design §4.2), one line at
 * a time under the three tiers. src/session/codex-session.ts owns the
 * lifecycle.
 */

import { normalizeCodexTokenUsage, type RequestId } from "./codex-protocol-builders.js";
import { MAX_ID_CHARS } from "./protocol.js";
import { CODEX_APPROVAL_METHODS, fileChangePaths } from "./codex-session-approvals.js";
import { bufferable, CODEX_THREAD_ID_PATTERN, isRecord, PARSE_BUFFER_MAX_BYTES, PARSE_BUFFER_MAX_LINES, type PendingParse } from "./codex-parse-facts.js";
import { unusableFacts } from "./process.js";
import type { CodexParse, CodexParseContext } from "./codex-session.js";

const UTF8 = new TextEncoder();
/** The rejoin bounds are byte bounds: a string's `.length` counts UTF-16
 * code units and under-reports text outside basic Latin (review round 64). */
const utf8Bytes = (text: string): number => UTF8.encode(text).byteLength;

type ScopedParams = { params: Record<string, unknown> | null; threadId: string; turnId: string | null; error: CodexParse | null };

/**
 * Parse the app-server NDJSON stream, one line at a time, under the §4.2
 * tiers. Never throws. One tolerance: codex has emitted JSON with raw
 * newlines inside string values, so a line that starts an object and
 * fails as unterminated is buffered and rejoined with an escaped newline
 * once its continuation arrives (bounded; fatal past the bounds).
 * Responses are keyed on id-without-method, notifications on method.
 */
export class CodexStreamParser {
  private threadStartedSeen = false;
  private pendingParse: PendingParse | null = null;

  feed(line: string, context: CodexParseContext): CodexParse[] {
    if (this.pendingParse !== null) {
      return this.feedPending(line, context);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      // The first fragment is bounded like its continuations: an opener
      // past the bound is the tier-3 fatal, never a growing buffer (round 64).
      if (bufferable(line, error) && utf8Bytes(line) <= PARSE_BUFFER_MAX_BYTES) {
        this.pendingParse = { text: line, lines: 1 };
        return [];
      }
      return [{ kind: "unusable", ...unusableFacts(line) }];
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      // Tier 3 (§4.2): the stream grammar is one JSON object per line.
      return [{ kind: "unusable", ...unusableFacts(line) }];
    }
    return this.classify(parsed as Record<string, unknown>, context);
  }

  /** Take the buffered fragment the stream ended inside, as the tier-3
   * facts its report carries, or null when none is held. The driver calls
   * this once the child has settled: nothing more can complete the
   * fragment, and dropping it silently lost the output it held (review
   * live25). */
  takeFragment(): { excerpt: string; bytes: number } | null {
    const pending = this.pendingParse;
    this.pendingParse = null;
    return pending === null ? null : unusableFacts(pending.text);
  }

  private feedPending(line: string, context: CodexParseContext): CodexParse[] {
    const pending = this.pendingParse as PendingParse;
    // The raw newline becomes the two-character escape it should have
    // been, which is what makes the rejoined message parse.
    const candidate = `${pending.text}\\n${line}`;
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch (error) {
      const lines = pending.lines + 1;
      if (
        bufferable(candidate, error) &&
        utf8Bytes(candidate) <= PARSE_BUFFER_MAX_BYTES &&
        lines <= PARSE_BUFFER_MAX_LINES
      ) {
        this.pendingParse = { text: candidate, lines };
        return [];
      }
      this.pendingParse = null;
      return [{ kind: "unusable", ...unusableFacts(candidate) }];
    }
    this.pendingParse = null;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return [{ kind: "unusable", ...unusableFacts(candidate) }];
    }
    return this.classify(parsed as Record<string, unknown>, context);
  }

  private classify(
    frame: Record<string, unknown>,
    context: CodexParseContext
  ): CodexParse[] {
    const method = frame["method"];
    if (typeof method === "string") {
      if (frame["id"] !== undefined) {
        return this.classifyServerRequest(frame, method, context);
      }
      return this.classifyNotification(frame, method, context);
    }
    if (frame["id"] !== undefined) {
      const id = frame["id"] as RequestId;
      if (typeof id !== "number" && typeof id !== "string") {
        return [{ kind: "grammar_error", message: "a response carries a non-scalar id" }];
      }
      const error = frame["error"];
      if (isRecord(error)) {
        const message = typeof error["message"] === "string" ? error["message"] : "unknown error";
        return [{ kind: "response_error", id, message }];
      }
      // JSON-RPC 2.0 makes `error` an object and requires `result` on
      // success. Anything else is a failure, never a success with an
      // undefined result: `{"id":7,"error":"boom"}` used to report a
      // failed steer or interrupt as accepted (review live16).
      if (error !== undefined && error !== null) {
        return [{ kind: "response_error", id, message: "the app-server returned a malformed error" }];
      }
      if (frame["result"] === undefined) {
        return [{ kind: "response_error", id, message: "the response carries neither result nor error" }];
      }
      return [{ kind: "response", id, result: frame["result"] }];
    }
    return [{ kind: "unknown" }]; // neither method nor id: not JSON-RPC
  }

  private classifyServerRequest(
    frame: Record<string, unknown>,
    method: string,
    context: CodexParseContext
  ): CodexParse[] {
    const id = frame["id"] as RequestId;
    if (typeof id !== "number" && typeof id !== "string") {
      return [{ kind: "grammar_error", message: `server request ${method} carries a non-scalar id` }];
    }
    if (typeof id === "string" && (id.length === 0 || id.length > MAX_ID_CHARS || id.includes("\0"))) {
      return [{ kind: "grammar_error", message: `server request ${method} carries an id outside the bound` }];
    }
    const kindOfApproval = CODEX_APPROVAL_METHODS[method];
    if (kindOfApproval === undefined) {
      return [{ kind: "server_request", id, method }];
    }
    const params = frame["params"];
    if (!isRecord(params)) {
      // Permission-shaped requests never kill the session on shape alone
      // (§4.2): the driver answers the per-method decline and reports a
      // non-fatal error with the raw preserved.
      return [{ kind: "unparseable_approval", id, method }];
    }
    const thread = params["threadId"];
    const turn = params["turnId"];
    if (typeof thread !== "string" || typeof turn !== "string") {
      return [{ kind: "unparseable_approval", id, method }];
    }
    const threadError = this.checkThread(thread, context);
    if (threadError !== null) return [threadError];
    if (context.activeTurnId === null) {
      return [
        {
          kind: "grammar_error",
          message: `an approval request for turn ${turn} arrived with no open turn`,
        },
      ];
    }
    if (turn !== context.activeTurnId) {
      return [
        {
          kind: "grammar_error",
          message: `an approval request references turn ${turn} but the open turn is ${context.activeTurnId}`,
        },
      ];
    }
    if (kindOfApproval === "fileChange" && fileChangePaths(params).length === 0) {
      // The ceiling cannot judge a patch without paths; the driver
      // answers decline rather than forward an opaque action.
      return [{ kind: "unparseable_approval", id, method }];
    }
    return [
      {
        kind: "permission_request",
        // The reply echoes the id with its original type; the caller-facing
        // `request_id` is its JSON spelling, so 1 and "1" stay distinct
        // pending-set keys (§4.2; review round 73).
        id,
        requestId: JSON.stringify(id),
        kindOfApproval,
        input: params,
      },
    ];
  }

  private classifyNotification(
    frame: Record<string, unknown>,
    method: string,
    context: CodexParseContext
  ): CodexParse[] {
    const params = isRecord(frame["params"]) ? (frame["params"] as Record<string, unknown>) : null;
    switch (method) {
      case "thread/started": {
        if (this.threadStartedSeen) {
          return [{ kind: "grammar_error", message: "a second thread/started in one session" }];
        }
        this.threadStartedSeen = true;
        const thread = params !== null ? params["thread"] : undefined;
        const id = isRecord(thread) ? thread["id"] : undefined;
        if (typeof id !== "string" || id.length === 0) {
          return [{ kind: "grammar_error", message: "thread/started carries no thread id" }];
        }
        // The id becomes the registry key and the `--resume` argument, so
        // it must be one `--resume` accepts (review live16).
        if (!CODEX_THREAD_ID_PATTERN.test(id)) {
          return [{ kind: "grammar_error", message: "thread/started carries an invalid thread id" }];
        }
        if (context.threadId !== null && id !== context.threadId) {
          return [
            {
              kind: "grammar_error",
              message: `thread/started announces ${id}, expected ${context.threadId}`,
            },
          ];
        }
        return [{ kind: "thread_started", threadId: id }];
      }
      case "turn/started": {
        // Turn-lifecycle notifications carry the turn as an object, not a
        // params-level turnId (the fixture's shape).
        const scoped = this.threadScopedParams(params, context);
        if (scoped.error !== null) return [scoped.error];
        const turn = isRecord(scoped.params?.["turn"]) ? (scoped.params["turn"] as Record<string, unknown>) : null;
        const turnId = turn !== null ? turn["id"] : undefined;
        if (context.activeTurnId === null) {
          return [
            {
              kind: "grammar_error",
              message: "turn/started arrived before the turn/start response named the turn",
            },
          ];
        }
        if (typeof turnId !== "string" || turnId !== context.activeTurnId) {
          return [
            {
              kind: "grammar_error",
              message: `turn/started names ${String(turnId)}, expected ${context.activeTurnId}`,
            },
          ];
        }
        return [{ kind: "turn_started", threadId: scoped.threadId, turnId }];
      }
      case "turn/completed": {
        const scoped = this.threadScopedParams(params, context);
        if (scoped.error !== null) return [scoped.error];
        const turn = isRecord(scoped.params?.["turn"]) ? (scoped.params["turn"] as Record<string, unknown>) : null;
        const turnId = turn !== null ? turn["id"] : undefined;
        if (context.activeTurnId === null) {
          return [
            {
              kind: "grammar_error",
              message: `turn/completed for ${String(turnId)} arrived with no open turn`,
            },
          ];
        }
        if (typeof turnId !== "string" || turnId !== context.activeTurnId) {
          return [
            {
              kind: "grammar_error",
              message: `turn/completed names ${String(turnId)} but the open turn is ${context.activeTurnId}`,
            },
          ];
        }
        const status = turn?.["status"];
        if (status === "completed") {
          return [{ kind: "turn_completed", threadId: scoped.threadId, turnId, finish: "end", reason: null }];
        }
        if (status === "interrupted") {
          return [{ kind: "turn_completed", threadId: scoped.threadId, turnId, finish: "interrupted", reason: null }];
        }
        if (status === "failed") {
          const error = turn?.["error"];
          const reason = isRecord(error) && typeof error["message"] === "string" ? error["message"] : "turn failed";
          return [{ kind: "turn_completed", threadId: scoped.threadId, turnId, finish: "failed", reason }];
        }
        // inProgress or an unrecognized status: a recognized method naming
        // the open turn whose outcome cannot be read. Passing it through
        // as unknown left the turn open forever — queued input never ran
        // and only a timeout or shutdown ended the session (review
        // live15) — so the turn completes failed with the unreadable
        // status named: fail-closed, and the queued input the completion
        // releases still runs.
        return [
          {
            kind: "turn_completed",
            threadId: scoped.threadId,
            turnId,
            finish: "failed",
            reason:
              typeof status === "string" && status.length > 0
                ? `the turn completed with unrecognized status ${status}`
                : "the turn completed with no status",
          },
        ];
      }
      case "item/agentMessage/delta": {
        const scoped = this.scopedParams(params, context);
        if (scoped.error !== null) return [scoped.error];
        const delta = scoped.params?.["delta"];
        if (typeof delta !== "string" || delta.length === 0) return [{ kind: "unknown" }];
        return [
          {
            kind: "assistant_delta",
            threadId: scoped.threadId,
            turnId: scoped.turnId as string,
            text: delta,
          },
        ];
      }
      case "item/started":
      case "item/updated":
      case "item/completed": {
        const scoped = this.scopedParams(params, context);
        if (scoped.error !== null) return [scoped.error];
        const item = isRecord(scoped.params?.["item"]) ? (scoped.params["item"] as Record<string, unknown>) : null;
        if (item === null) return [{ kind: "unknown" }];
        const itemId = item["id"];
        if (typeof itemId !== "string" || itemId.length === 0) return [{ kind: "unknown" }];
        const type = item["type"];
        if (type === "agentMessage" && method === "item/completed") {
          // Commentary is mid-turn chatter, not the final answer.
          const phase = item["phase"];
          const text = item["text"];
          if (phase !== "commentary" && typeof text === "string") {
            return [
              { kind: "assistant_text", threadId: scoped.threadId, turnId: scoped.turnId as string, text },
            ];
          }
          return [{ kind: "unknown" }];
        }
        if (type === "commandExecution" && method === "item/started") {
          const command = item["command"];
          if (typeof command !== "string") return [{ kind: "unknown" }];
          const cwd = item["cwd"];
          return [
            {
              kind: "tool_call",
              threadId: scoped.threadId,
              turnId: scoped.turnId as string,
              callId: itemId,
              input:
                typeof cwd === "string" ? { command, cwd } : { command },
            },
          ];
        }
        if (type === "commandExecution" && method === "item/completed") {
          const output = item["aggregatedOutput"];
          const status = item["status"];
          return [
            {
              kind: "tool_result",
              threadId: scoped.threadId,
              turnId: scoped.turnId as string,
              callId: itemId,
              output: typeof output === "string" ? output : null,
              isError: status === "failed" || status === "declined",
            },
          ];
        }
        if (type === "fileChange" && method === "item/completed") {
          const changes = item["changes"];
          if (!Array.isArray(changes) || changes.length === 0) return [{ kind: "unknown" }];
          const parses: CodexParse[] = [];
          for (const change of changes) {
            if (!isRecord(change)) return [{ kind: "unknown" }];
            const path = change["path"];
            const kind = isRecord(change["kind"]) ? change["kind"]["type"] : undefined;
            const action =
              kind === "add" ? "add" : kind === "update" ? "edit" : kind === "delete" ? "delete" : null;
            if (typeof path !== "string" || path.length === 0 || action === null) {
              // All-or-nothing: a partially parsable change list is
              // never partially emitted.
              return [{ kind: "unknown" }];
            }
            parses.push({
              kind: "file_change",
              threadId: scoped.threadId,
              turnId: scoped.turnId as string,
              path,
              action,
            });
          }
          return parses;
        }
        // userMessage echo (codemux's user_message event is the
        // authoritative record), mcpToolCall, webSearch, reasoning, …:
        // recognized harness items with no codemux translation.
        return [{ kind: "unknown" }];
      }
      case "thread/tokenUsage/updated": {
        const scoped = this.scopedParams(params, context);
        if (scoped.error !== null) return [scoped.error];
        const tokenUsage = scoped.params?.["tokenUsage"];
        const last = isRecord(tokenUsage) ? tokenUsage["last"] : undefined;
        if (!isRecord(last)) return [{ kind: "unknown" }];
        return [
          {
            kind: "usage",
            threadId: scoped.threadId,
            turnId: scoped.turnId as string,
            usage: normalizeCodexTokenUsage(last),
          },
        ];
      }
      case "thread/status/changed": {
        // A cosmetic status flip: thread-checked when parseable, then a
        // tier-1 passthrough.
        if (params === null) return [{ kind: "unknown" }];
        const thread = params["threadId"];
        if (typeof thread !== "string") return [{ kind: "unknown" }];
        const error = this.checkThread(thread, context);
        if (error !== null) return [error];
        return [{ kind: "unknown" }];
      }
      default:
        // Ambient account/remoteControl/mcpServer traffic and anything
        // newer: valid harness events codemux does not map.
        return [{ kind: "unknown" }];
    }
  }

  /** The thread-scope check every translated notification passes: the
   * event must reference the one thread this session owns. */
  private checkThread(threadId: string, context: CodexParseContext): CodexParse | null {
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
  private threadScopedParams(
    params: Record<string, unknown> | null,
    context: CodexParseContext
  ): { params: Record<string, unknown> | null; threadId: string; error: CodexParse | null } {
    if (params === null) {
      return { params: null, threadId: "", error: { kind: "grammar_error", message: "a turn notification carries no params" } };
    }
    const threadId = params["threadId"];
    if (typeof threadId !== "string") {
      return { params: null, threadId: "", error: { kind: "grammar_error", message: "a turn notification carries no thread id" } };
    }
    const threadError = this.checkThread(threadId, context);
    if (threadError !== null) {
      return { params: null, threadId: "", error: threadError };
    }
    return { params, threadId, error: null };
  }

  /** Validate the {threadId, turnId} scope item and turn notifications
   * share, plus the open-turn requirement once a turn is involved. */
  private scopedParams(
    params: Record<string, unknown> | null,
    context: CodexParseContext
  ): ScopedParams {
    const grammar = (message: string): ScopedParams =>
      ({ params: null, threadId: "", turnId: null, error: { kind: "grammar_error", message } });
    if (params === null) return grammar("a scoped notification carries no params");
    const threadId = params["threadId"];
    if (typeof threadId !== "string") return grammar("a scoped notification carries no thread id");
    const threadError = this.checkThread(threadId, context);
    if (threadError !== null) return { params: null, threadId: "", turnId: null, error: threadError };
    const turnId = params["turnId"];
    const straggler = typeof turnId === "string" && context.closedTurnIds?.has(turnId) === true;
    if (context.turnPending === true && context.activeTurnId === null) {
      // The turn/start window: the first id seen is provisional; a second
      // or missing id is a grammar error (rounds 67 and 70).
      const pending = context.pendingTurnId;
      if (typeof turnId !== "string") {
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
}
