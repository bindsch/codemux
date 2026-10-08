/**
 * The opencode session wiring: the per-turn spawn command over `opencode run
 * --session`, the honest capability matrix, and the JSON run-output parser
 * under the three tiers. Pure functions only — all live state lives in the
 * launcher-owned driver (src/session/opencode-driver.ts).
 *
 * Wire facts here are pinned against the installed 1.18.18 binary's run
 * command (scratch/opencode-run-fmt.txt holds the extracted strings): `run`
 * prints one JSON object per line of the shape `{type, timestamp,
 * sessionID, …payload}` with types `step_start`, `step_finish` (tokens and
 * cost), `text` (only once the part's time ends), `tool_use` (only once the
 * tool's state is completed or error), and `error`; a non-TTY stdin is read
 * to EOF and used as the message when the argv message is empty, an empty
 * message exits 1, and `--session <id>` resumes the native session (ids are
 * `ses_` plus ~24 mixed-case alphanumerics, verified against the on-disk
 * database). opencode speaks no event protocol beyond this one-shot output,
 * so the session is turn-per-process: one `run` per caller input, state
 * carried by the native session id.
 *
 * Every capability the wire cannot evidence (steer, interrupt, permissions,
 * user-during-turn, deltas, file changes, a usage stream) reports false,
 * honestly: usage rides only the per-turn step_finish parts, a report not a
 * stream.
 */

import type { AutonomyLevel, ReasoningEffort, ResultUsageBlock } from "../types.js";
import { unusableFacts } from "./process.js";
import type { SessionCapabilities } from "./protocol.js";

/** The session-only version floor (§4.3): 1.18.18, the build whose run wire
 * (the JSON line shapes, the stdin-to-EOF message, `--session` resume) the
 * parser and command are pinned against. */
export const OPENCODE_SESSION_FLOOR = "1.18.18";

/** The id shape `--session` accepts: `ses_` plus mixed-case alphanumerics
 * (the observed ids run ~24 characters; the bound is loose so a longer
 * release id still resumes while pastes refuse). */
export const OPENCODE_SESSION_ID_PATTERN = /^ses_[A-Za-z0-9]{8,64}$/;

/**
 * Capability flags for opencode sessions (§3.4): live input yes (one caller
 * input, one `run` process), everything else the run wire cannot carry no —
 * there is no steering or interrupt channel into a one-shot process, no
 * permission round-trip (--auto answers "once" or the process dies on
 * stderr), no deltas (text parts arrive only when complete), no file-change
 * frames, and usage arrives only in the per-turn step_finish parts.
 */
export function opencodeSessionCapabilities(): SessionCapabilities {
  return {
    live_input: true,
    user_during_turn: false,
    steer: false,
    interrupt: false,
    permissions: false,
    deltas: false,
    file_changes: false,
    usage_stream: false,
    resume: true,
  };
}

/**
 * The session autonomy mapping, pinned here independently of the run
 * adapter's (the agy session module's convention): the per-turn `run`
 * process carries the same flags `run` does, so the flags are the adapter's
 * mapAutonomy verbatim and a unit test pins the two together so they cannot
 * drift.
 */
export function opencodeSessionAutonomyFlags(level: AutonomyLevel): string[] {
  switch (level) {
    case "read-only":
      return ["--agent", "plan"];
    case "low":
      return ["--agent", "build"];
    case "medium":
      return ["--agent", "build"];
    case "high":
      return ["--agent", "build", "--auto"];
  }
}

export interface OpenCodeSessionCommand {
  autonomy: AutonomyLevel;
  model?: string;
  effort?: ReasoningEffort;
  /** The native session id to resume, or undefined to start fresh. */
  resumeSessionId?: string;
}

/**
 * The per-turn spawn command: `run` with JSON output, the flags in the run
 * adapter's order (model, autonomy, effort), and `--session` last so the
 * resume discipline is the argv's tail. No argv message: the prompt rides
 * stdin, read to EOF, so a multi-line prompt stays one message.
 */
export function buildOpenCodeSessionCommand(command: OpenCodeSessionCommand): string[] {
  const argv = ["opencode", "--pure", "run", "--format", "json"];
  if (command.model !== undefined) {
    argv.push("--model", command.model);
  }
  argv.push(...opencodeSessionAutonomyFlags(command.autonomy));
  if (command.effort !== undefined) {
    argv.push("--variant", command.effort);
  }
  if (command.resumeSessionId !== undefined) {
    argv.push("--session", command.resumeSessionId);
  }
  return argv;
}

const USAGE_COUNT = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : null;

const COST = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;

/**
 * Normalize one step_finish part's usage into `ResultUsageBlock` semantics
 * (§4.2). The part carries the ai-sdk v5 token shape (`tokens: {input,
 * output, reasoning, total, cache: {read, write}}`) plus a dollar `cost`;
 * cache reads and writes are separate there, so both fold into
 * cached_input_tokens (the run path's convention when a harness reports the
 * two apart). Each field is null when the raw fields it needs are
 * unreported, never guessed; `reasoning` has no ResultUsageBlock slot and is
 * dropped.
 */
export function normalizeOpenCodeUsage(part: Record<string, unknown>): ResultUsageBlock {
  const tokens = isRecord(part["tokens"]) ? (part["tokens"] as Record<string, unknown>) : {};
  const cache = isRecord(tokens["cache"]) ? (tokens["cache"] as Record<string, unknown>) : {};
  const read = USAGE_COUNT(cache["read"]);
  const write = USAGE_COUNT(cache["write"]);
  return {
    input_tokens: USAGE_COUNT(tokens["input"]),
    output_tokens: USAGE_COUNT(tokens["output"]),
    cached_input_tokens:
      read !== null && write !== null ? read + write : null,
    total_tokens: USAGE_COUNT(tokens["total"]),
    cost_usd: COST(part["cost"]),
  };
}

/** What one opencode run-output line resolves to. The driver owns the FSM;
 * these are the parser's facts. Every mapped or unknown kind carries the
 * validated `sessionId` — the one fact the driver adopts its identity from
 * (a fresh session's first line) and confirms a resume with. */
export type OpenCodeParse =
  | { kind: "text"; sessionId: string; text: string }
  | {
      kind: "tool_use";
      sessionId: string;
      callId: string;
      tool: string;
      input: unknown;
      output: unknown;
      isError: boolean;
      errorText: string | null;
    }
  | { kind: "step_finish"; sessionId: string; usage: ResultUsageBlock }
  | { kind: "error"; sessionId: string; message: string }
  | { kind: "unknown"; sessionId: string }
  | { kind: "grammar_error"; message: string }
  | { kind: "unusable"; excerpt: string; bytes: number };

export interface OpenCodeParseContext {
  /** The session id once adopted (the first line of a fresh session's first
   * turn, or the registry-vouched resume id); null before that. A line
   * naming a different session is the wrong-session defect (tier 2). */
  knownSessionId: string | null;
}

/**
 * Parse one `opencode run --format json` output line under the §4.2 tiers.
 * Never throws: a line that is not a JSON object is `unusable` (tier 3, the
 * driver's fatal — the process layer reports non-UTF-8 and oversize before
 * this runs), a JSON object with no `type` or no valid `sessionID` — every
 * recorded line carries one, and the session id is the one fact that makes
 * the turn belong to this session — is a `grammar_error` (tier 2), a type
 * codemux maps with a payload that breaks its grammar is a `grammar_error`
 * too, and a recognized type codemux does not map (`step_start`,
 * `reasoning`, anything newer) is `unknown` (tier 1, raw preserved by the
 * driver).
 */
export function parseOpenCodeRunLine(
  line: string,
  context: OpenCodeParseContext
): OpenCodeParse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return { kind: "unusable", ...unusableFacts(line) };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { kind: "unusable", ...unusableFacts(line) };
  }
  const event = parsed as Record<string, unknown>;
  const type = event["type"];
  if (typeof type !== "string" || type === "") {
    return { kind: "grammar_error", message: "a run-output line carries no type" };
  }
  const gate = checkSessionId(event, context);
  if (gate.error !== null) return gate.error;
  const sessionId = gate.sessionId;
  switch (type) {
    case "text": {
      const part = event["part"];
      if (!isRecord(part) || typeof part["text"] !== "string") {
        return {
          kind: "grammar_error",
          message: "a text line carries no text part",
        };
      }
      return { kind: "text", sessionId, text: part["text"] as string };
    }
    case "tool_use": {
      const part = event["part"];
      if (!isRecord(part)) {
        return { kind: "grammar_error", message: "a tool_use line carries no part" };
      }
      const callId = part["id"];
      const tool = part["tool"];
      const state = part["state"];
      if (typeof callId !== "string" || callId === "") {
        return { kind: "grammar_error", message: "a tool_use line carries no call id" };
      }
      if (typeof tool !== "string" || tool === "") {
        return { kind: "grammar_error", message: "a tool_use line names no tool" };
      }
      if (!isRecord(state)) {
        return { kind: "grammar_error", message: "a tool_use line carries no state" };
      }
      const status = state["status"];
      // The run command emits tool_use only on the completed and error
      // states (the status filter is in the extracted wire), so any other
      // status breaks the pin: an in-flight tool would report a result it
      // does not have yet.
      if (status !== "completed" && status !== "error") {
        return {
          kind: "grammar_error",
          message: `a tool_use line carries the unreported status ${String(status)}`,
        };
      }
      const error = state["error"];
      return {
        kind: "tool_use",
        sessionId,
        callId,
        tool,
        input: state["input"],
        output: state["output"],
        isError: status === "error",
        errorText: typeof error === "string" && error !== "" ? error : null,
      };
    }
    case "step_finish": {
      // The wire line is {type, timestamp, sessionID, part} (the run
      // command's emitter spreads the payload beside the envelope), so the
      // tokens and cost live INSIDE part — reading them off the envelope
      // reads undefined on every real line (review D2, contracts 1).
      const part = event["part"];
      if (!isRecord(part)) {
        return {
          kind: "grammar_error",
          message: "a step_finish line carries no part",
        };
      }
      return { kind: "step_finish", sessionId, usage: normalizeOpenCodeUsage(part) };
    }
    case "error":
      return { kind: "error", sessionId, message: openCodeErrorMessage(event["error"]) };
    default:
      return { kind: "unknown", sessionId };
  }
}

/** The session-id gate every line passes: present, well-formed, and — once
 * the session adopted one — the one it adopted. */
function checkSessionId(
  event: Record<string, unknown>,
  context: OpenCodeParseContext
): { sessionId: string; error: { kind: "grammar_error"; message: string } | null } {
  const sessionId = event["sessionID"];
  if (typeof sessionId !== "string" || sessionId === "") {
    return {
      sessionId: "",
      error: { kind: "grammar_error", message: "a run-output line carries no sessionID" },
    };
  }
  if (!OPENCODE_SESSION_ID_PATTERN.test(sessionId)) {
    return {
      sessionId,
      error: { kind: "grammar_error", message: "a run-output line carries an invalid sessionID" },
    };
  }
  if (context.knownSessionId !== null && sessionId !== context.knownSessionId) {
    return {
      sessionId,
      error: {
        kind: "grammar_error",
        message: `a run-output line names session ${sessionId}, not ${context.knownSessionId}`,
      },
    };
  }
  return { sessionId, error: null };
}

/** The message inside an error line: the run command wraps both its own
 * prompt errors and the session's accumulated errors in `error`, whose
 * useful text sits in `error.data.message` when the endpoint says so and in
 * `error.message` otherwise. */
function openCodeErrorMessage(error: unknown): string {
  if (isRecord(error)) {
    const data = isRecord(error["data"]) ? (error["data"] as Record<string, unknown>) : null;
    if (data !== null && typeof data["message"] === "string" && data["message"] !== "") {
      return data["message"];
    }
    if (typeof error["message"] === "string" && error["message"] !== "") {
      return error["message"];
    }
  }
  return String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
