import { featureFloor } from "../harness-contracts.js";
import { markOverflowed } from "./usage.js";
/**
 * The opencode session wiring: the per-turn spawn command over `opencode run
 * --session`, the honest capability matrix, and the JSON run-output parser
 * under the three tiers. Pure functions only — all live state lives in the
 * launcher-owned driver (src/session/opencode-driver.ts).
 *
 * Wire facts here are pinned against the installed 1.18.18 binary's run
 * command (upstream v1.18.18 fetched to scratch/upstream-run.ts and
 * scratch/upstream-ui.ts): `run`
 * prints one JSON object per line of the shape `{type, timestamp,
 * sessionID, …payload}` with types `step_start`, `step_finish` (tokens and
 * cost), `text` (only once the part's time ends), `tool_use` (only once the
 * tool's state is completed or error), and `error`; in plain (non-JSON)
 * mode the same loop prints each completed text part trimmed on its own
 * line and puts the banner, tool lines, and errors on stderr, which is
 * the byte-for-byte spelling plain-unwrap.ts reproduces; a non-TTY stdin
 * is read to EOF and used as the message when the argv message is empty,
 * an empty message exits 1, and `--session <id>` resumes the native
 * session (ids are `ses_` plus ~24 mixed-case alphanumerics, verified
 * against the on-disk database). opencode speaks no event protocol
 * beyond this one-shot output, so the session is turn-per-process: one
 * `run` per caller input, state carried by the native session id.
 *
 * Every capability the wire cannot evidence (steer, interrupt, permissions,
 * user-during-turn, deltas, file changes, a usage stream) reports false,
 * honestly: usage rides only the per-turn step_finish parts, a report not a
 * stream.
 */

import type { AutonomyLevel, ReasoningEffort, ResultUsageBlock } from "../types.js";
import { OPENCODE_HERMETIC_ENV } from "../adapters/opencode-env.js";
import { reportedTokenCount, safeTokenSum } from "../result-envelope/common.js";
import { unusableFacts } from "./process.js";
import type { SessionCapabilities } from "./protocol.js";

/** The session-only version floor (§4.3): 1.18.18, the build whose run wire
 * (the JSON line shapes, the stdin-to-EOF message, `--session` resume) the
 * parser and command are pinned against. */
export const OPENCODE_SESSION_FLOOR = featureFloor("opencode", "sessions");

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
  /** The `--experiment-project-settings` isolation: `--pure` is dropped
   * (the run path's rule, adapters/opencode.ts) so the project's own
   * plugins run — that is the channel under observation. */
  projectSettings?: boolean;
}

/**
 * The per-turn spawn command: `run` with JSON output, the flags in the run
 * adapter's order (model, autonomy, effort), and `--session` last so the
 * resume discipline is the argv's tail. No argv message: the prompt rides
 * stdin, read to EOF, so a multi-line prompt stays one message.
 */
export function buildOpenCodeSessionCommand(command: OpenCodeSessionCommand): string[] {
  const argv = ["opencode"];
  if (command.projectSettings !== true) {
    argv.push("--pure");
  }
  argv.push("run", "--format", "json");
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

/**
 * The env(1) prefix a HERMETIC session's per-turn argv rides: the run
 * path's own prefix (adapters/opencode.ts buildRunCommand), built from
 * the turn's freshly prepared context — a new private home per turn,
 * the session's own state (the native session id, the login) living in
 * the real data directory the prefix keeps. Null when the session is
 * not hermetic: a plain session spawns `opencode` with no prefix. The
 * assignments ride argv, never the environment handed to scode (the
 * run path's rule, adapters/opencode-env.ts).
 */
export function openCodeHermeticTurnPrefix(input: {
  hermetic: boolean;
  /** The project-settings spelling: drops the project-config disable. */
  projectSettings: boolean;
  /** The turn's prepared hermetic home (adapters/opencode.ts
   * prepareRun); a hermetic turn without one fails closed here. */
  home: string | undefined;
  providerConfigPath: string | null;
  realDataParent: string;
}): string[] | null {
  if (!input.hermetic) return null;
  if (input.home === undefined) {
    throw new Error("opencode hermetic home was not prepared before launch");
  }
  return [
    "env",
    ...OPENCODE_HERMETIC_ENV(
      input.home,
      input.realDataParent,
      input.providerConfigPath,
      input.projectSettings
    ),
  ];
}

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
 * dropped. Counts and the cache sum follow the envelope's rule
 * (reportedTokenCount and safeTokenSum, src/result-envelope/common.ts): a
 * count is a whole non-negative safe integer, and a cache read at the
 * ceiling plus two written tokens is null, never a rounded number (review
 * round 80). Whether `tokens.input` itself includes cache reads is not
 * established by any recorded OpenCode run (every live fixture reports
 * nulls), so it is taken as the non-cached input and published unchanged.
 */
export function normalizeOpenCodeUsage(part: Record<string, unknown>): ResultUsageBlock {
  const tokens = isRecord(part["tokens"]) ? (part["tokens"] as Record<string, unknown>) : {};
  const cache = isRecord(tokens["cache"]) ? (tokens["cache"] as Record<string, unknown>) : {};
  const read = reportedTokenCount(cache["read"]);
  const write = reportedTokenCount(cache["write"]);
  const cached = read !== null && write !== null ? safeTokenSum(read, write) : null;
  // A cache pair whose sum left the safe range is an overflow, not an
  // unreported field: marked, so no later fold revives it (round 84).
  return markOverflowed({
    input_tokens: reportedTokenCount(tokens["input"]),
    output_tokens: reportedTokenCount(tokens["output"]),
    cached_input_tokens: cached,
    total_tokens: reportedTokenCount(tokens["total"]),
    cost_usd: COST(part["cost"]),
  }, read !== null && write !== null && cached === null ? ["cached_input_tokens"] : []);
}

/** What one opencode run-output line resolves to. The driver owns the FSM;
 * these are the parser's facts. Every mapped or unknown kind carries the
 * validated `sessionId` — the one fact the driver adopts its identity from
 * (a fresh session's first line) and confirms a resume with. Payload grammar
 * errors also retain a validated ID so run folds can enforce continuity. */
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
  | { kind: "grammar_error"; message: string; reason?: "session-mismatch"; sessionId?: string }
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
  const gate = checkSessionId(event, context);
  if (gate.error !== null) return gate.error;
  const sessionId = gate.sessionId;
  const type = event["type"];
  if (typeof type !== "string" || type === "") {
    return { kind: "grammar_error", sessionId, message: "a run-output line carries no type" };
  }
  switch (type) {
    case "text": {
      const part = event["part"];
      if (!isRecord(part) || typeof part["text"] !== "string") {
        return {
          kind: "grammar_error",
          sessionId,
          message: "a text line carries no text part",
        };
      }
      return { kind: "text", sessionId, text: part["text"] as string };
    }
    case "tool_use": {
      const part = event["part"];
      if (!isRecord(part)) {
        return { kind: "grammar_error", sessionId, message: "a tool_use line carries no part" };
      }
      const callId = part["id"];
      const tool = part["tool"];
      const state = part["state"];
      if (typeof callId !== "string" || callId === "") {
        return { kind: "grammar_error", sessionId, message: "a tool_use line carries no call id" };
      }
      if (typeof tool !== "string" || tool === "") {
        return { kind: "grammar_error", sessionId, message: "a tool_use line names no tool" };
      }
      if (!isRecord(state)) {
        return { kind: "grammar_error", sessionId, message: "a tool_use line carries no state" };
      }
      const status = state["status"];
      // The run command emits tool_use only on the completed and error
      // states (the status filter is in the extracted wire), so any other
      // status breaks the pin: an in-flight tool would report a result it
      // does not have yet.
      if (status !== "completed" && status !== "error") {
        return {
          kind: "grammar_error",
          sessionId,
          message: `a tool_use line carries the unreported status ${String(status)}`,
        };
      }
      const error = state["error"];
      // The protocol's `tool_call.input` is an object
      // (docs/session-protocol.md), and OpenCode's completed and error
      // tool states both carry one. A line whose `state.input` is
      // missing, an array, or a primitive breaks that pin like the
      // checks above: a grammar error, not an event that violates the
      // session protocol (review round 199) and not a line passed over
      // in silence, which would let the turn complete without the tool
      // call it made (review round 207).
      if (!isRecord(state["input"])) {
        return { kind: "grammar_error", sessionId, message: "a tool_use line carries a state.input that is not an object" };
      }
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
          sessionId,
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
): { sessionId: string; error: Extract<OpenCodeParse, { kind: "grammar_error" }> | null } {
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
        reason: "session-mismatch",
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
