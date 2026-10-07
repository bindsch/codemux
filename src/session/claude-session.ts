/**
 * The claude-family session wiring (design §4.7): the spawn command, the
 * stream-json parsers under the three tiers, and the control-response
 * writer that enforces the ceiling. Pure functions and one small parser
 * class — all live state lives in the launcher-owned driver context.
 *
 * Wire facts here are pinned by the step-0 fixtures
 * (tests/fixtures/live/): the `--verbose` requirement, the
 * `--permission-prompt-tool stdio` carrier, the per-turn `system/init`,
 * the can_use_tool round-trip shapes, the interrupt round-trip, and the
 * `user`-frame replay echo. The fake harness the e2e tests drive is
 * generated from those fixtures, so this parser cannot drift from the
 * recorded reality.
 */

import { randomUUID } from "node:crypto";
import { claudeAutonomyFlags } from "../claude-autonomy.js";
import { getPlaywrightSandboxMcpArgs } from "../mcp.js";
import { normalizeClaudeUsage } from "../result-envelope.js";
import type {
  AutonomyLevel,
  ReasoningEffort,
  ResultUsageBlock,
} from "../types.js";
import { unusableFacts } from "./process.js";
import type { SessionCapabilities } from "./protocol.js";

/** The session-only version floor (design §4.3): 2.1.280, the audited
 * `--permission-prompt-tool stdio` build. The run contract's 2.1.220
 * admits pre-hardening builds where the bypass flag is honored and the
 * resume ladder's reasoning would not hold. */
export const CLAUDE_SESSION_FLOOR = "2.1.280";

export interface ClaudeSessionCommand {
  agent: "claude" | "zai";
  resumeId?: string;
  model?: string;
  autonomy: AutonomyLevel;
  effort?: ReasoningEffort;
  cwd?: string;
  /** Whether scode wraps the session; drives the Playwright MCP args. */
  sandboxed?: boolean;
  /** Enable the local Playwright MCP inside the sandbox (run parity). */
  enablePlaywrightMcp?: boolean;
}

/** The session high mapping: `--permission-mode default` plus the grant
 * list — never `--dangerously-skip-permissions`. High's reach is set by
 * codemux's grants, not a harness side effect, so the resume ladder's
 * low→high move narrows reach on every build the floor admits. Medium,
 * low, and read-only reuse the run mapping verbatim (medium already
 * carries the scoped Edit grant; low and read-only carry no grants). */
export function claudeSessionAutonomyFlags(
  level: AutonomyLevel,
  launchDir: string
): string[] {
  if (level === "high") {
    return [
      "--permission-mode",
      "default",
      "--allowedTools",
      "Edit",
      "Write",
      "NotebookEdit",
      "Bash",
    ];
  }
  return claudeAutonomyFlags(level, launchDir);
}

/**
 * The spawn command (§4.7). Flag order is load-bearing: the resume id
 * comes first and the autonomy flags after it, unconditionally, on every
 * launch — fresh or resumed — with the live invocation's `--auto` as
 * their only input. A session created at high and resumed at read-only
 * emits exactly read-only's flags. Notably WITHOUT
 * `--no-session-persistence` (that flag is `run`'s statelessness, wrong
 * here) and with `--replay-user-messages` so the transcript echoes what
 * codemux submits.
 */
export function buildClaudeSessionCommand(
  command: ClaudeSessionCommand
): { argv: string[]; sessionId: string } {
  const sessionId = randomUUID();
  // The whole family spawns the same `claude` binary: the zai agent is
  // that binary pointed at the Z.AI endpoint through the adapter's env
  // (ANTHROPIC_AUTH_TOKEN/ANTHROPIC_BASE_URL), not a separate executable
  // — the adapter's binaryName is "claude", and no zai binary exists.
  const binary = "claude";
  const launchDir = command.cwd ?? process.cwd();
  const argv = [
    binary,
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--permission-prompt-tool",
    "stdio",
    "--replay-user-messages",
  ];
  // The resume id precedes every autonomy-derived flag (§4.7).
  if (command.resumeId !== undefined) {
    argv.push("--resume", command.resumeId);
  } else {
    argv.push("--session-id", sessionId);
  }
  argv.push("--setting-sources", "user", "--strict-mcp-config");
  // Run parity for --enable-playwright-mcp (§4.5): the same verified
  // carrier, in run's position — after the writable roots, before the
  // model. Absent (not an error) unless sandboxed and enabled.
  argv.push(
    ...getPlaywrightSandboxMcpArgs(command.sandboxed, {
      enabled: command.enablePlaywrightMcp,
      forbiddenRoot: launchDir,
    })
  );
  if (command.model !== undefined) {
    argv.push("--model", command.model);
  }
  argv.push(...claudeSessionAutonomyFlags(command.autonomy, launchDir));
  if (command.effort !== undefined && command.effort !== "none") {
    argv.push("--effort", command.effort);
  }
  return { argv, sessionId };
}

/** Capability flags for claude-family sessions (§4.3), pinned by the
 * fixtures: interrupts round-trip, asks surface through the stdio
 * carrier, and deltas stream with `--include-partial-messages`.
 * `user_during_turn` is honestly false (review live21): print mode
 * delivers a mid-turn message at the running turn's next model request
 * when there is one — folded into that turn, one result answering both
 * (fixture zai-session-a.ndjson) — and in a result of its own when there
 * is not, so which result answers it is not knowable when it is sent. A
 * mid-turn `user` line is rejected `busy`; the caller waits for
 * `turn_completed` or interrupts. `steer` is false for the same reason:
 * no carrier shapes the running turn on demand, so a `steer` line is
 * rejected `unsupported` by name. `usage_stream` is honestly false the
 * same way: the claude-family wire reports usage only on the turn's
 * `result` event, so per-turn usage arrives with `turn_completed` and
 * session usage with `session_ended`, never as standalone `usage`
 * events. */
export function claudeSessionCapabilities(): SessionCapabilities {
  return {
    live_input: true,
    user_during_turn: false,
    steer: false,
    interrupt: true,
    permissions: true,
    deltas: true,
    file_changes: "derived",
    usage_stream: false,
    resume: true,
  };
}

/** The harness-side line for one user/steer input. The recorded replay
 * echo (`isReplay: true` user frames) is this exact shape. */
export function buildHarnessUserMessage(text: string): string {
  return JSON.stringify({
    type: "user",
    message: {
      role: "user",
      content: [{ type: "text", text }],
    },
  });
}

/** The interrupt control request, pinned by the fixture round-trip. */
export function buildInterruptRequest(requestId: string): string {
  return JSON.stringify({
    type: "control_request",
    request_id: requestId,
    request: { subtype: "interrupt" },
  });
}

/** The can_use_tool answer, pinned by the fixture round-trip: the
 * `updatedInput` the probe recorded carries the full merged input, so
 * the caller's `updated_input` (validated by the ceiling before this
 * runs) substitutes wholesale. An allow always carries one — the
 * request's own input when the caller substituted nothing — because the
 * harness runs the tool with exactly that object (review live18: a plain
 * allow went out without it). The overloads make an allow without it a
 * type error. */
export function buildControlResponse(
  requestId: string,
  behavior: "allow",
  updatedInput: Record<string, unknown>,
  message?: string
): string;
export function buildControlResponse(
  requestId: string,
  behavior: "deny",
  updatedInput?: undefined,
  message?: string
): string;
export function buildControlResponse(
  requestId: string,
  behavior: "allow" | "deny",
  updatedInput?: Record<string, unknown>,
  message?: string
): string {
  const response: Record<string, unknown> = { behavior };
  if (updatedInput !== undefined) {
    response.updatedInput = updatedInput;
  }
  response.message = message ?? `codemux: ${behavior}`;
  return JSON.stringify({
    type: "control_response",
    response: {
      subtype: "success",
      request_id: requestId,
      response,
    },
  });
}

/** The error answer for a harness `control_request` codemux does not
 * implement: the control protocol's `subtype: "error"` response, keyed
 * to the request's own id so the harness stops waiting on it (review
 * live18 — the codex driver's `-32601` answer, the claude-family
 * sibling). The id is echoed with its wire type. */
export function buildControlErrorResponse(
  requestId: string | number,
  error: string
): string {
  return JSON.stringify({
    type: "control_response",
    response: {
      subtype: "error",
      request_id: requestId,
      error,
    },
  });
}

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
          // HARNESS-COMPATIBILITY), so a repeat is tier-1 unknown, not a
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
        if (subtype !== "can_use_tool" || typeof requestId !== "string") {
          // Any other control request (a subtype codemux does not
          // implement, or a can_use_tool with no usable string id) still
          // waits on an answer harness-side: passing it through as
          // `unknown` alone left the turn blocked until --turn-timeout or
          // the session end (review live18). The driver answers it with
          // the control protocol's error response when the id can be
          // echoed, and reports it either way.
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
