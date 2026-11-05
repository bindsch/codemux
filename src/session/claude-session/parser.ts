/**
 * The claude-family stream-json parser: one harness line resolved to
 * its parse facts under the design §4.2 tiers, plus the derived
 * file-change candidates the assistant frames name.
 * src/session/claude-session.ts owns the module's public surface and
 * re-exports these.
 */

import { normalizeClaudeUsage } from "../../result-envelope.js";
import type { ResultUsageBlock } from "../../types.js";
import { isAnswerableRequestId } from "../protocol.js";
import { unusableFacts } from "../process.js";

/** What one harness line resolves to. The driver owns the FSM and the
 * pending set; these are the parser's facts. */
export type ClaudeParse =
  | { kind: "init"; sessionId: string }
  | { kind: "assistant_delta"; text: string }
  | { kind: "assistant_text"; text: string }
  | { kind: "tool_call"; callId: string; name: string; input: Record<string, unknown> }
  | { kind: "tool_result"; callId: string; output: unknown; isError: boolean }
  | { kind: "file_change"; callId: string; path: string; write: boolean }
  | { kind: "permission_request"; requestId: string; tool: string; input: Record<string, unknown> }
  | { kind: "unparseable_permission"; requestId: string }
  | {
      kind: "unsupported_control_request";
      /** The wire id when it is one the answer can echo, else null. */
      requestId: string | number | null;
      subtype: string;
    }
  | { kind: "turn_completed"; isError: boolean; reason: string | null; usage: ResultUsageBlock }
  /** The harness refused one of codemux's own control requests (an
   * interrupt): the protocol's `subtype: "error"` answer (review live22). */
  | { kind: "control_error"; requestId: string; error: string }
  | { kind: "unknown" }
  | { kind: "grammar_error"; message: string }
  | { kind: "unusable"; excerpt: string; bytes: number };

export interface ClaudeParseContext {
  /** The id codemux asked for (`--session-id`); every event the harness
   * frames with a different session id is the wrong-session defect. */
  expectedSessionId: string;
}

const EDIT_TOOLS = new Set(["Edit", "Write", "NotebookEdit"]);

/** Frame types the recorded wire always stamps with the session id
 * (every `system`/`assistant`/`user`/`stream_event`/`result` frame in the
 * step-0 fixtures carries one; `control_request`/`control_response`
 * frames never do). A stamped type arriving without an id is drift, not
 * an unstamped variant: judged fail-closed below rather than accepted
 * (review live15 — a `result` with a missing id could close the open
 * turn). */
const SESSION_STAMPED_TYPES = new Set([
  "system",
  "assistant",
  "user",
  "stream_event",
  "result",
]);

/**
 * Parse the claude-family stream-json output, one line at a time, under
 * the §4.2 tiers. Never throws: a line that is not a JSON object is
 * reported as `unusable` — the driver's tier-3 fatal (the process layer
 * reports non-UTF-8 and oversize before this runs) — while a valid JSON
 * object of unrecognized shape is `unknown`. Usage is never taken from
 * assistant frames (§4.2): turn usage comes from the `result` event
 * only.
 */
export class ClaudeStreamParser {
  private initSeen = false;

  feed(line: string, context: ClaudeParseContext): ClaudeParse[] {
    let event: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        // Tier 3 (§4.2): the stream grammar is one JSON object per line;
        // an array or scalar is as unusable as a parse failure.
        return [{ kind: "unusable", ...unusableFacts(line) }];
      }
      event = parsed as Record<string, unknown>;
    } catch {
      return [{ kind: "unusable", ...unusableFacts(line) }];
    }
    const sessionId = event["session_id"];
    if (typeof sessionId === "string") {
      if (sessionId !== context.expectedSessionId) {
        return [
          {
            kind: "grammar_error",
            message: `event carries session id ${sessionId}, expected ${context.expectedSessionId}`,
          },
        ];
      }
    } else if (SESSION_STAMPED_TYPES.has(event.type as string)) {
      // The type is stamped on the recorded wire, so a missing or non-string
      // id cannot be an unstamped variant of it: tier-2, fail-closed.
      return [
        {
          kind: "grammar_error",
          message: `${String(event.type)} frame carries no session id, expected ${context.expectedSessionId}`,
        },
      ];
    }
    switch (event.type) {
      case "system": {
        if (event.subtype === "init") {
          // The id was validated before this switch — `system` is a
          // stamped type, so a missing id was rejected above and a string
          // id already matched the expected one — and the recorded wire
          // sends init once per turn (fixture zai-session-a.ndjson;
          // dated evidence in docs/archive/isolation-verification.md), so a repeat is tier-1 unknown, not a
          // grammar error. Only the first init opens the session.
          if (this.initSeen) {
            return [{ kind: "unknown" }];
          }
          this.initSeen = true;
          return [{ kind: "init", sessionId: sessionId as string }];
        }
        // hook_started/hook_response/status/permission_denied: valid,
        // unmapped — tier-1 passthrough.
        return [{ kind: "unknown" }];
      }
      case "assistant": {
        const message = event["message"];
        if (typeof message !== "object" || message === null) {
          return [{ kind: "unknown" }];
        }
        const record = message as Record<string, unknown>;
        // No dedupe by `message.id`: the recorded wire sends one content
        // block per assistant frame under a shared message id (fixture
        // zai-permission.ndjson has thinking-then-tool_use pairs; zai-
        // permission2.ndjson thinking-then-text), so a repeat id is a
        // sibling block, not a duplicate message. Usage is never read
        // from assistant frames at all — turn usage comes from the
        // `result` event only — so there is nothing to protect here.
        const parses: ClaudeParse[] = [];
        const content = record["content"];
        if (Array.isArray(content)) {
          for (const block of content) {
            if (typeof block !== "object" || block === null) continue;
            const typed = block as Record<string, unknown>;
            if (typed["type"] === "text" && typeof typed["text"] === "string") {
              parses.push({ kind: "assistant_text", text: typed["text"] });
            } else if (typed["type"] === "tool_use") {
              const callId = typed["id"];
              const name = typed["name"];
              const input = typed["input"];
              if (typeof callId === "string" && typeof name === "string" && isInputObject(input)) {
                parses.push({ kind: "tool_call", callId, name, input });
                const derived = derivedFileChange(callId, name, input);
                if (derived !== null) parses.push(derived);
              }
            }
          }
        }
        return parses.length > 0 ? parses : [{ kind: "unknown" }];
      }
      case "user": {
        const message = event["message"];
        if (typeof message !== "object" || message === null) {
          return [{ kind: "unknown" }];
        }
        const content = (message as Record<string, unknown>)["content"];
        if (!Array.isArray(content)) return [{ kind: "unknown" }];
        const parses: ClaudeParse[] = [];
        for (const block of content) {
          if (typeof block !== "object" || block === null) continue;
          const typed = block as Record<string, unknown>;
          if (typed["type"] === "tool_result" && typeof typed["tool_use_id"] === "string") {
            parses.push({
              kind: "tool_result",
              callId: typed["tool_use_id"],
              output: typed["content"] ?? null,
              isError: typed["is_error"] === true,
            });
          }
        }
        // The replay echo of codemux's own submission (§4.4): the
        // authoritative echo is codemux's `user_message` event, so the
        // harness frame passes through as unknown, never silently
        // dropped.
        return parses.length > 0 ? parses : [{ kind: "unknown" }];
      }
      case "stream_event": {
        const inner = event["event"];
        if (typeof inner !== "object" || inner === null) {
          return [{ kind: "unknown" }];
        }
        const typed = inner as Record<string, unknown>;
        if (typed["type"] === "content_block_delta") {
          const delta = typed["delta"];
          if (
            typeof delta === "object" &&
            delta !== null &&
            (delta as Record<string, unknown>)["type"] === "text_delta" &&
            typeof (delta as Record<string, unknown>)["text"] === "string"
          ) {
            const text = (delta as Record<string, unknown>)["text"] as string;
            // An empty text_delta is a recognized-but-empty variant: it
            // mirrors as tier-1 unknown instead of being silently dropped
            // (review live15 — the codex parser's delta rule, one rule for
            // both families). The driver's delta event only carries
            // non-empty text.
            return text.length > 0 ? [{ kind: "assistant_delta", text }] : [{ kind: "unknown" }];
          }
        }
        // message_start/block_start/block_stop/message_delta/message_stop:
        // stream framing, recognized but unmapped — tier-1 passthrough.
        return [{ kind: "unknown" }];
      }
      case "result": {
        const errorSubtype =
          typeof event.subtype === "string" && event.subtype.startsWith("error")
            ? event.subtype
            : null;
        // The RAW error bit, not a verdict: whether an error result is a
        // failed turn or an interrupted one depends on codemux's own
        // interrupt state — an interrupted turn arrives as an error result
        // by convention (step-0 probe 4) — which the line cannot know. The
        // driver pairs the bit with that state (review live12); the parser
        // reports what the wire said.
        const isError = event["is_error"] === true || errorSubtype !== null;
        return [
          {
            kind: "turn_completed",
            isError,
            reason: typeof event.subtype === "string" ? event.subtype : null,
            usage: normalizeClaudeUsage(event["usage"], event["total_cost_usd"]),
          },
        ];
      }
      case "control_response": {
        // Only an error answer is a fact the driver needs: a refused
        // interrupt must not stay pending (review live22). Success
        // answers and anything unreadable pass through as `unknown`.
        const response = event["response"];
        if (typeof response !== "object" || response === null) return [{ kind: "unknown" }];
        const body = response as Record<string, unknown>;
        if (body["subtype"] !== "error" || typeof body["request_id"] !== "string") {
          return [{ kind: "unknown" }];
        }
        return [
          {
            kind: "control_error",
            requestId: body["request_id"],
            error: typeof body["error"] === "string" ? body["error"].slice(0, 512) : "(no message)",
          },
        ];
      }
      case "control_request": {
        const request = event["request"];
        const requestId = event["request_id"];
        const subtype =
          typeof request === "object" && request !== null
            ? (request as Record<string, unknown>)["subtype"]
            : undefined;
        if (subtype !== "can_use_tool" || !isAnswerableRequestId(requestId)) {
          // Any other control request (a subtype codemux does not
          // implement, or a can_use_tool with no usable string id) still
          // waits on an answer harness-side: passing it through as
          // `unknown` alone left the turn blocked until --turn-timeout or
          // the session end (review live18). The driver answers it with
          // the control protocol's error response when the id can be
          // echoed, and reports it either way. A can_use_tool whose id
          // fails isAnswerableRequestId — empty, over the protocol's
          // bound, or carrying NUL — takes this same branch (review round
          // 104): the decision parser rejects every such id as malformed,
          // so emitting it as a permission request would block the
          // harness on a pending id no caller decision can resolve.
          return [
            {
              kind: "unsupported_control_request",
              requestId:
                typeof requestId === "string" ||
                (typeof requestId === "number" && Number.isFinite(requestId))
                  ? requestId
                  : null,
              subtype: typeof subtype === "string" ? subtype.slice(0, 128) : "(none)",
            },
          ];
        }
        const record = request as Record<string, unknown>;
        const tool = record["tool_name"];
        const input = record["input"];
        if (typeof tool !== "string" || !isInputObject(input)) {
          // A can_use_tool whose payload cannot be read is an opaque
          // action: the driver answers deny keyed by request_id (§4.1's
          // opaque rule, §4.2's permission-shaped rule) rather than
          // letting the request hang.
          return [{ kind: "unparseable_permission", requestId }];
        }
        return [{ kind: "permission_request", requestId, tool, input }];
      }
      default:
        return [{ kind: "unknown" }];
    }
  }
}

function isInputObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}


/** A derived file-change candidate (§4.3, `file_changes: "derived"`):
 * the parser only NAMES the candidate — an Edit/NotebookEdit/Write call
 * with a string target path, keyed to its tool_use id. Whether the
 * change happened is settled by the tool's own result (the driver holds
 * the candidate until a non-error tool_result confirms it — a denied or
 * failed call changed nothing, review live10), and so is the Write
 * add/edit split: an existsSync against the workspace as the call
 * arrives, with a relative target resolved against the session cwd the
 * harness runs in (review live15) — it follows symlinks, so a target
 * that exists through one is an edit and a dangling symlink's missing
 * target is an add (review live14; the code is driver.ts's stash, not
 * an lstat of the link).
 * `write` marks the one tool whose action depends on that check; Edit
 * and NotebookEdit only ever modify, so they are edits. Anything
 * without a string target path derives nothing. */
function derivedFileChange(
  callId: string,
  tool: string,
  input: Record<string, unknown>
): ClaudeParse | null {
  if (!EDIT_TOOLS.has(tool)) return null;
  const pathKey = tool === "NotebookEdit" ? "notebook_path" : "file_path";
  const path = input[pathKey];
  if (typeof path !== "string" || path.length === 0) return null;
  return { kind: "file_change", callId, path, write: tool === "Write" };
}
