/**
 * The gemini session wiring: the per-turn spawn command over gemini's own
 * session store, the honest capability matrix, and the stream-json line
 * parser under the three tiers. Pure functions only — all live state
 * lives in the launcher-owned driver (the turn-per-process table,
 * src/session/turn-per-process.ts).
 *
 * Wire facts pinned against the installed 0.60.0 bundle
 * (/opt/homebrew/lib/node_modules/@google/gemini-cli/bundle/,
 * gemini-LUNNHKPJ.js and chunk-M6NSK26M.js, read 2026-11-09):
 *
 * - `--session-id <id>` starts a NEW session with a caller-provided id
 *   ("Start a new session with a manually provided UUID", coerced to
 *   /^[a-zA-Z0-9-_]+$/), and `--resume <id>` (alias -r) resumes one; the
 *   two (plus --session-file) are mutually exclusive, and a bare
 *   `--resume ""` means "most recent". Codemux mints a lowercase UUID and
 *   names it with --session-id on the first turn, so the session's
 *   identity is known at spawn (the claude model, not the deferred one).
 * - `--output-format stream-json` switches stdout to one JSON object per
 *   line (the same formatter the run path's `json` mode wraps):
 *   `{type:"init", timestamp, session_id, model}` first,
 *   `{type:"message", timestamp, role:"user"|"assistant", content,
 *   delta?}` for text (delta:true marks a streaming chunk),
 *   `{type:"tool_use", timestamp, tool_name, tool_id, parameters}`,
 *   `{type:"tool_result", timestamp, tool_id, status:"success"|"error",
 *   output, error?}`, `{type:"error", timestamp,
 *   severity:"error"|"warning", message}`, and the closing
 *   `{type:"result", timestamp, status:"success"|"error", error?, stats}`
 *   whose stats are convertToStreamStats's
 *   `{total_tokens, input_tokens, output_tokens, cached, input,
 *   duration_ms, tool_calls, models}`.
 * - Piped stdin supplies the prompt; -p "" selects headless mode without
 *   appending text. The session frame limit applies, not the argv cap.
 */

import { featureFloor } from "../harness-contracts.js";
import { geminiUsageFromStats } from "../result-envelope/gemini.js";
import { emptyUsage } from "../result-envelope.js";
import type { ResultUsageBlock } from "../types.js";
import type { AutonomyLevel } from "../types.js";
import { unusableFacts } from "./process.js";
import type { SessionCapabilities } from "./protocol.js";

/** The session-only version floor (§4.3): 0.60.0, the audited bundle whose
 * stream-json event shapes, --session-id/--resume contract, and stats
 * fields this parser and command are pinned against. */
export const GEMINI_SESSION_FLOOR = featureFloor("gemini", "sessions");

/** The id shape codemux mints for a gemini session (a plain lowercase
 * UUID). The CLI's own coerce accepts the wider /^[a-zA-Z0-9-_]+$/ class
 * (0.60.0 bundle), but codemux only ever resumes the ids it minted, so
 * the pattern pins its own mint — the claude convention. */
export const GEMINI_SESSION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Capability flags for gemini sessions (§3.4): live input yes (one caller
 * input, one gemini process), deltas yes (ACP agent_message_chunk frames
 * plus the terminal assembled message), interrupt yes (ACP session/cancel
 * ends the active native prompt), resume yes through gemini's own store
 * keyed by the native session id. Everything else honestly no — there is
 * no steering channel, no permission round-trip (confirmations are
 * refused; the --policy file bounds the whole turn at spawn), no
 * file-change frames, and usage arrives only on the closing prompt
 * response, so it rides the per-turn completion (the agy/claude
 * contract), not a stream.
 */
export function geminiSessionCapabilities(): SessionCapabilities {
  return {
    live_input: true,
    user_during_turn: false,
    steer: false,
    interrupt: true,
    permissions: false,
    deltas: true,
    file_changes: false,
    usage_stream: false,
    resume: true,
  };
}

/**
 * The session autonomy mapping, pinned here independently of the run
 * adapter's (the agy/aider session modules' convention): the per-turn
 * processes carry the same --approval-mode flags `run` does, and a unit
 * test pins the two together so they cannot drift.
 */
export function geminiSessionAutonomyFlags(level: AutonomyLevel): string[] {
  switch (level) {
    case "read-only":
      return ["--approval-mode", "plan"];
    case "low":
      return ["--approval-mode", "default"];
    case "medium":
    case "high":
      return ["--approval-mode", "yolo"];
  }
}

export interface GeminiSessionCommand {
  /** The `-m` value, when one applies. */
  model?: string;
  autonomy: AutonomyLevel;
  /** The codemux-minted session id: --session-id on the first turn (a new
   * session named for it), --resume on every later one. */
  sessionId: string;
  /** True while this turn STARTS the session (the first turn). */
  firstTurn: boolean;
  /** The turn's prompt; the driver writes it on stdin. */
  prompt: string;
  /** The private GEMINI_CLI_HOME a hermetic session turn runs under, when
   * the session is hermetic: every turn carries the run path's env
   * prefix pointed at it, so session turns and hermetic runs cannot
   * drift. */
  hermeticHome?: string;
  /** A private policy applied again on every resumed turn. */
  policyPath?: string;
}

/**
 * The per-turn spawn command: the run adapter's flag order (sandbox off
 * for scode to own, model, approval mode, output format) with the session
 * carrier — `--session-id <minted>` on the turn that starts the session,
 * `--resume <minted>` on every later one — and an empty -p headless
 * selector. A hermetic turn wraps the command in the run path's env(1)
 * shape.
 */
export function buildGeminiSessionCommand(command: GeminiSessionCommand): string[] {
  const argv =
    command.hermeticHome === undefined
      ? ["gemini"]
      : ["env", `GEMINI_CLI_HOME=${command.hermeticHome}`, "gemini"];
  argv.push("--sandbox=false");
  if (command.policyPath !== undefined) argv.push("--policy", command.policyPath);
  if (command.model !== undefined) {
    argv.push("-m", command.model);
  }
  argv.push(...geminiSessionAutonomyFlags(command.autonomy));
  argv.push("--output-format", "stream-json");
  if (command.firstTurn) {
    argv.push("--session-id", command.sessionId);
  } else {
    argv.push("--resume", command.sessionId);
  }
  argv.push("-p", "");
  return argv;
}

/** What one stream-json output line resolves to. The driver owns the
 * lifecycle; these are the parser's facts. */
export type GeminiParse =
  | { kind: "init"; sessionId: string; model: string | null }
  | { kind: "assistant"; text: string; delta: boolean }
  | {
      kind: "tool_use";
      toolId: string;
      name: string;
      input: unknown;
    }
  | { kind: "tool_result"; toolId: string; output: unknown; isError: boolean }
  | { kind: "error"; severity: string; message: string }
  | { kind: "result"; status: string; errorText: string | null; usage: ResultUsageBlock }
  | { kind: "unknown" }
  | {
      kind: "grammar_error";
      message: string;
      /** Set when the defect proves the harness ran a session other than
       * the one codemux named: an init event carrying a foreign id. The
       * driver reads it to fail the turn's identity, not just its shape. */
      wrongSession?: { named: string; known: string };
    }
  | { kind: "unusable"; excerpt: string; bytes: number };

export interface GeminiParseContext {
  /** The session id codemux minted (every turn knows it at spawn — the
   * claude model). An init event naming a different id is the
   * wrong-session defect (tier 2). */
  knownSessionId: string;
}

/**
 * Parse one `--output-format stream-json` line under the §4.2 tiers.
 * Never throws: a line that is not a JSON object is `unusable` (tier 3,
 * the driver's fatal), a line that claims a mapped shape but breaks its
 * contract — an init event with a malformed or foreign session id, a
 * message with no string content, a tool event with no id — is a
 * `grammar_error` (tier 2), and a shape codemux does not map (the user
 * echo, anything newer) is `unknown` (tier 1, raw preserved by the
 * driver).
 */
export function parseGeminiStreamLine(
  line: string,
  context: GeminiParseContext
): GeminiParse {
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
  switch (event["type"]) {
    case "init":
      return parseInitLine(event, context);
    case "message":
      return parseMessageLine(event);
    case "tool_use":
      return parseToolUseLine(event);
    case "tool_result":
      return parseToolResultLine(event);
    case "error":
      return parseErrorLine(event);
    case "result":
      return parseResultLine(event);
    default:
      // No type or an unrecognized one — well-formed JSON codemux does not
      // map. The user message echo arrives here too: it is codemux's own
      // prompt coming back, not a fact about the model's work.
      return { kind: "unknown" };
  }
}

/** `{type:"init", timestamp, session_id, model}` — the session's
 * identity line. The session_id must be a well-formed gemini id and the
 * one codemux named: a fresh session echoes the minted id back, and a
 * resumed one names the same id, so anything else is the wrong-session
 * defect. `model` is the CLI's resolved model string or absent. */
function parseInitLine(
  event: Record<string, unknown>,
  context: GeminiParseContext
): GeminiParse {
  const sessionId = event["session_id"];
  if (typeof sessionId !== "string" || !GEMINI_SESSION_ID_PATTERN.test(sessionId)) {
    return {
      kind: "grammar_error",
      message: "an init event carries an invalid session id",
    };
  }
  if (sessionId !== context.knownSessionId) {
    return {
      kind: "grammar_error",
      message: `an init event names session ${sessionId}, not ${context.knownSessionId}`,
      wrongSession: { named: sessionId, known: context.knownSessionId },
    };
  }
  const model = event["model"];
  return {
    kind: "init",
    sessionId,
    model: typeof model === "string" && model !== "" ? model : null,
  };
}

/** `{type:"message", timestamp, role, content, delta?}` — the writer
 * always spells `content` for a message line, and `delta` only on the
 * streaming chunks. A message with no string content breaks the pin;
 * `delta` is read leniently (absent means false) because its absence is
 * the complete-message spelling. */
function parseMessageLine(event: Record<string, unknown>): GeminiParse {
  const content = event["content"];
  if (typeof content !== "string") {
    return {
      kind: "grammar_error",
      message: "a message event carries no string content",
    };
  }
  const role = event["role"];
  if (role !== "assistant" && role !== "user") {
    return {
      kind: "grammar_error",
      message: "a message event carries an unrecognized role",
    };
  }
  // The user echo is not a model fact; the driver maps only assistant
  // text (the raw line stays available to it either way).
  if (role === "user") return { kind: "unknown" };
  return { kind: "assistant", text: content, delta: event["delta"] === true };
}

/** `{type:"tool_use", timestamp, tool_name, tool_id, parameters}` — the
 * id and name are non-empty strings; `parameters` is passed through
 * unparsed (an object, or absent when the tool takes none). */
function parseToolUseLine(event: Record<string, unknown>): GeminiParse {
  const toolId = event["tool_id"];
  const name = event["tool_name"];
  if (typeof toolId !== "string" || toolId === "") {
    return { kind: "grammar_error", message: "a tool_use event carries no tool_id" };
  }
  if (typeof name !== "string" || name === "") {
    return { kind: "grammar_error", message: "a tool_use event carries no tool_name" };
  }
  return { kind: "tool_use", toolId, name, input: event["parameters"] ?? null };
}

/** `{type:"tool_result", timestamp, tool_id, status, output, error?}` —
 * the status is the error marker; `output` passes through unparsed. */
function parseToolResultLine(event: Record<string, unknown>): GeminiParse {
  const toolId = event["tool_id"];
  if (typeof toolId !== "string" || toolId === "") {
    return { kind: "grammar_error", message: "a tool_result event carries no tool_id" };
  }
  const status = event["status"];
  if (status !== "success" && status !== "error") {
    return {
      kind: "grammar_error",
      message: "a tool_result event carries an unrecognized status",
    };
  }
  return {
    kind: "tool_result",
    toolId,
    output: event["output"] ?? null,
    isError: status === "error",
  };
}

/** `{type:"error", timestamp, severity, message}` — severity "warning"
 * events are informational (the driver reports them without failing the
 * turn); "error" ones fail it (the plain-run rule). */
function parseErrorLine(event: Record<string, unknown>): GeminiParse {
  const message = event["message"];
  if (typeof message !== "string" || message === "") {
    return { kind: "grammar_error", message: "an error event carries no message" };
  }
  const severity = event["severity"];
  return {
    kind: "error",
    severity: typeof severity === "string" ? severity : "error",
    message,
  };
}

/** `{type:"result", timestamp, status, error?, stats}` — the turn's
 * closing verdict. `status` is "success" or "error"; the optional error
 * object carries `{type, message}`; `stats` is the
 * convertToStreamStats object whose token arithmetic the run envelope
 * and this parse share (geminiUsageFromStats). */
function parseResultLine(event: Record<string, unknown>): GeminiParse {
  const status = event["status"];
  if (status !== "success" && status !== "error") {
    return {
      kind: "grammar_error",
      message: "a result event carries an unrecognized status",
    };
  }
  const rawError = event["error"];
  const errorText =
    typeof rawError === "object" && rawError !== null
      ? (rawError as Record<string, unknown>).message
      : null;
  const usage =
    typeof event["stats"] === "object" && event["stats"] !== null
      ? geminiUsageFromStats(event["stats"] as Record<string, unknown>)
      : null;
  return {
    kind: "result",
    status,
    errorText: typeof errorText === "string" && errorText !== "" ? errorText : null,
    usage: usage ?? emptyUsage(),
  };
}
