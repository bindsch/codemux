/**
 * The qwen session wiring: the per-turn spawn command over qwen's own
 * session ledger, the honest capability matrix, and the turn parse shared
 * with the run path. Pure functions only — all live state lives in the
 * launcher-owned driver (the turn-per-process table,
 * src/session/turn-per-process.ts).
 *
 * Wire facts pinned against the installed @qwen-code/qwen-code 0.24.0
 * bundle (/opt/homebrew/lib/node_modules/@qwen-code/qwen-code/chunks/,
 * read 2026-11-09):
 *
 * - The option table (chunk-BSIOCNDK.js): `continue: { alias: "c", type:
 *   "boolean", description: "Resume the most recent session for the
 *   current project.", default: false }` (byte 9779); `resume: { alias:
 *   "r", type: "string", description: "Resume a specific session by its
 *   ID. Use without an ID to show session picker." }` (byte 9930) — the
 *   id is the flag's VALUE, not a boolean; `"session-id": { type:
 *   "string", description: "Specify a session ID for this run." }` (byte
 *   10081).
 * - The CLI's argv validation (chunk-HWKWZSZY.js): "Cannot use both
 *   --continue and --resume together. Use --continue to resume the latest
 *   session, or --resume <sessionId> to resume a specific session."
 *   (byte 2063354) and "Cannot use --session-id with --continue or
 *   --resume. Use --session-id to start a new session with a specific
 *   ID, or use --continue/--resume to resume an existing session."
 *   (byte 2063646) — the second string settles the semantics: --session-id
 *   STARTS a new session under a caller-supplied id, --resume <id> resumes
 *   an existing one. The codemux-minted model (claude/gemini), not the
 *   deferred one (goose/opencode): the first turn names the mint, every
 *   later turn resumes it.
 * - The id shape (chunk-ZEZKIS2K.js, packages/cli/src/config/session-id.ts):
 *   INTERNAL_SESSION_ID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}(-agent-[a-zA-Z0-9_.-]+)?$/i
 *   (byte 229) and CALLER_SUPPLIED_SESSION_ID_REGEX =
 *   /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
 *   (byte 364). The argv validation refuses a malformed --session-id:
 *   `Invalid --session-id: "${...}". Must be a valid UUID (e.g.,
 *   "123e4567-e89b-12d3-a456-426614174000").` (chunk-HWKWZSZY.js byte
 *   2064276, via isValidSessionId at chunk-ZEZKIS2K.js byte 477). An
 *   occupied id is refused too: `Error: Session Id ${...} already exists
 *   (active or archived). Delete or unarchive it first.` (byte 2094415)
 *   — more proof --session-id creates, not selects.
 *   normalizeSessionIdForLookup lowercases a UUID-shaped id, so codemux
 *   mints lowercase and the echo matches byte for byte.
 * - A resumed run's result message names the resumed id, through the
 *   traced chain: `if (argv.resume) { sessionId = argv.resume; ...
 *   sessionData = await sessionService.loadSession(argv.resume); }`
 *   (chunk-HWKWZSZY.js byte 2091593; a miss exits 1 with `No saved
 *   session found with ID ${...}`) → configParams.sessionId → the
 *   Config constructor `this.sessionId = params.sessionId ??
 *   randomUUID18();` (chunk-SNPYTKXI.js byte 6107940 — the mint when no
 *   id is supplied) → the adapter's `getSessionId() { return
 *   this.config.getSessionId(); }` (chunk-6XRR4RYH.js byte 11518) →
 *   buildResultMessage's `const baseSessionId = this.getSessionId();`
 *   (byte 29979) feeding `session_id: baseSessionId` in both the error
 *   and the success arm (buildResultMessage at byte 29697).
 * - `--output-format json` prints the whole message array as ONE stdout
 *   line with the result message last (chunk-ZJBYZN5D.js byte 3169:
 *   `this.messages.push(resultMessage); ... const json =
 *   JSON.stringify(this.messages); ... process.stdout.write(frame);`) —
 *   the run path's parser (src/result-envelope/qwen.ts) pins the fields.
 * - The always-on `--safe-mode` ("Disable all customizations (context
 *   files, hooks, extensions, skills, MCP servers)", chunk-BSIOCNDK.js
 *   byte 2411) does not touch the session ledger: chat recording defaults
 *   on independently of it (`this.chatRecordingEnabled = params.chatRecording
 *   ?? true;`, chunk-SNPYTKXI.js byte 6120711), and it is the recorded
 *   transcript --resume loads — the option's own text says so
 *   ("If false, chat history is not saved and --continue/--resume will
 *   not work.", chunk-BSIOCNDK.js byte 2983).
 * - The prompt rides stdin (the run adapter's getStdinInput), never argv,
 *   so the per-turn deliverability bound is the stdin write
 *   (MAX_INPUT_TEXT_BYTES and the driver's pre-ack frame check), not an
 *   argv byte cap.
 */

import { sessionIdPattern } from "./id-pattern.js";
import { featureFloor } from "../harness-contracts.js";
import { buildPlaywrightSandboxMcp } from "../mcp.js";
import { parseQwenResultEnvelope } from "../result-envelope/qwen.js";
import { emptyUsage } from "../result-envelope.js";
import { qwenNoToolsArgs } from "../qwen-tools.js";
import type { AutonomyLevel, ResultUsageBlock, ToolSelection } from "../types.js";
import type { SessionCapabilities } from "./protocol.js";

/** The session-only version floor (§4.3): 0.24.0, the installed bundle
 * whose --session-id/--resume contract, id validation, and message-array
 * output this command and parse are pinned against. Fails closed until
 * the FEATURE_FLOORS row lands (featureFloor throws on an unrecorded
 * mechanism — by design, never launch on an unjudged binary). */
export const QWEN_SESSION_FLOOR = featureFloor("qwen", "sessions");

/** The id shape qwen accepts from a caller (CALLER_SUPPLIED_SESSION_ID_
 * REGEX, chunk-ZEZKIS2K.js byte 364): an RFC 4122 v1-v5 UUID, variant
 * nibble 8/9/a/b, pinned lowercase because that is what codemux mints
 * and what normalizeSessionIdForLookup canonicalizes to. The internal
 * class adds a `-agent-<name>` suffix for subagent messages; codemux
 * only ever resumes the ids it minted, so the pattern pins its own
 * mint — the claude convention. */
export const QWEN_SESSION_ID_PATTERN = sessionIdPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);

/**
 * Capability flags for qwen sessions (§3.4): live input yes (one caller
 * input, one qwen process), resume yes through qwen's own session ledger
 * keyed by the codemux-minted id. Everything else honestly no — there is
 * no steering or interrupt channel into a one-shot process, no permission
 * round-trip (the --approval-mode flags bound the whole turn at spawn;
 * the one-shot json wire only reports permission_denials, it never asks),
 * no deltas (the message array is the turn's one complete output), no
 * file-change frames, and usage arrives only on the result message, so
 * it rides the per-turn completion (the agy/claude contract), not a
 * stream.
 */
export function qwenSessionCapabilities(): SessionCapabilities {
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
 * adapter's (the agy/aider/goose session modules' convention): every
 * turn's argv carries the same --approval-mode flags `run` does, and a
 * unit test pins the two together so they cannot drift.
 */
export function qwenSessionAutonomyFlags(level: AutonomyLevel): string[] {
  switch (level) {
    case "read-only":
      return ["--approval-mode", "plan"];
    case "low":
      return ["--approval-mode", "default"];
    case "medium":
      return ["--approval-mode", "auto"];
    case "high":
      return ["--approval-mode", "yolo"];
  }
}

export interface QwenSessionCommand {
  /** The codemux-minted session id: --session-id on the turn that starts
   * the session (qwen creates the session under it), --resume on every
   * later one (qwen loads the recorded transcript it names). */
  sessionId: string;
  /** True while this turn STARTS the session (the first turn). */
  firstTurn: boolean;
  autonomy: AutonomyLevel;
  /** The --model value, when one applies. */
  model?: string;
  /** "none" removes every built-in tool for this turn — the run path's
   * `--exclude-tools` carrier (src/qwen-tools.ts). Because every turn's
   * argv is rebuilt from this record, a resumed session keeps the tool
   * set the first turn promised: the exclusion rides the argv of each
   * spawn, and the unconditional merge that honors it cannot decay with
   * a session's settings the way a settings-sourced rule would (safe
   * mode empties those). */
  tools?: ToolSelection;
  /** Attach the trust-checked Playwright stdio server for this turn —
   * the run path's `--mcp-config` carrier (top-tier servers survive
   * safe mode, chunk-HWKWZSZY.js offset 2095089, read 2026-11-09).
   * Per-turn, like the exclusion: a resumed turn's argv carries it
   * again. The launcher captures and rechecks the executable identity. */
  playwrightMcp?: boolean;
  playwrightMcpPath?: string;
  callerOwnedHome?: boolean;
}

/**
 * The per-turn spawn command: the run adapter's exact flag order
 * (`qwen --safe-mode`, model, the json wire, the approval mode — the
 * prefix a `--result-json` run launches with) plus the session carrier —
 * `--session-id <minted>` on the first turn, `--resume <minted>` on
 * every later one, never both (the binary's own refusal, byte 2063354).
 * The prompt is not in argv: it rides stdin like a run's.
 */
export function buildQwenSessionCommand(command: QwenSessionCommand): string[] {
  const argv = ["qwen", ...(command.callerOwnedHome ? [] : ["--safe-mode"])];
  if (command.model !== undefined) {
    argv.push("--model", command.model);
  }
  // The run path's flag order: the exclusion sits with the model flags,
  // ahead of the json wire, so a turn's argv is the run's plus the
  // session carrier.
  if (command.tools === "none") {
    argv.push(...qwenNoToolsArgs());
  }
  argv.push("--output-format", "json");
  if (command.playwrightMcp === true) {
    if (command.playwrightMcpPath === undefined) {
      throw new Error("qwen Playwright session command requires the captured executable path");
    }
    // The gate already refused playwright without --sandbox, so a session
    // that reaches here is sandboxed (the mcp.ts rule).
    argv.push(
      ...buildPlaywrightSandboxMcp(true, {
        enabled: true,
        binaryPath: command.playwrightMcpPath,
        pathEnv: "",
      }).args
    );
  }
  argv.push(...qwenSessionAutonomyFlags(command.autonomy));
  argv.push(command.firstTurn ? "--session-id" : "--resume", command.sessionId);
  return argv;
}

/** What one turn's whole stdout resolves to: the run path's parser (the
 * result message — answer text, usage, session id, the error fold) plus
 * the identity check a session adds. */
export interface QwenSessionTurnParse {
  answer: string | null;
  usage: ResultUsageBlock;
  /** The result message's session_id, when it carried one. */
  sessionId: string | null;
  /** The result message's subtype, when one arrived. */
  subtype: string | null;
  /** True when the result message carries is_error. */
  isError: boolean;
  /** The error message a failed result carries (error.message). */
  errorMessage: string | null;
  /** True when the message named no session id at all: a fresh session's
   * first turn knows its id at spawn (the minted model), so an output
   * without one breaks the pin — and a resumed turn breaks it too. */
  noSessionId: boolean;
  /** True when the message named a session other than the one this turn
   * holds — the driver fails the turn's identity, not just its shape. */
  wrongSession: boolean;
  /** True when stdout carried no result message at all (the driver's
   * tier-3 fatal: the launch ran with --output-format json, and qwen
   * prints the array even for a failure that happens before the first
   * turn). */
  noWire: boolean;
}

/**
 * Parse one turn's stdout: the run envelope parser folds the result
 * message, and this adds the session's two rules — the message must name
 * a session id, and it must name the id codemux holds (the minted id on
 * a first turn, the resumed one on every later turn — both are known at
 * spawn, so anything else is the wrong-session defect).
 */
export function parseQwenSessionTurn(
  stdout: string,
  context: { knownSessionId: string | null }
): QwenSessionTurnParse {
  const parsed = parseQwenResultEnvelope(stdout);
  if (parsed === null) {
    return {
      answer: null,
      usage: emptyUsage(),
      sessionId: null,
      subtype: null,
      isError: false,
      errorMessage: null,
      noSessionId: false,
      wrongSession: false,
      noWire: true,
    };
  }
  const sessionId = parsed.sessionId;
  return {
    answer: parsed.answer,
    usage: parsed.usage,
    sessionId,
    subtype: parsed.subtype,
    isError: parsed.isError,
    errorMessage: parsed.errorMessage,
    noSessionId: sessionId === null,
    wrongSession:
      sessionId !== null &&
      context.knownSessionId !== null &&
      sessionId !== context.knownSessionId,
    noWire: false,
  };
}
