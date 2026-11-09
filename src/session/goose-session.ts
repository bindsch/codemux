/**
 * The goose session wiring: the per-turn spawn command and environment
 * over goose's own session ledger, the honest capability matrix, and the
 * turn parse shared with the run path. Pure functions only — all live
 * state lives in the launcher-owned driver (the turn-per-process table,
 * src/session/turn-per-process.ts).
 *
 * Wire facts pinned against the installed 1.50.1 binary (its `run
 * --help` text and its embedded strings, read 2026-11-09):
 *
 * - "--session-id: Session ID (e.g., '20250921_143022'). Specify a
 *   session ID to resume. Requires --resume." and the refusals "Error:
 *   --session-id can only be used with --resume flag" / "Cannot use
 *   --session-id without --resume". A session turn that RESUMES carries
 *   both flags; the turn that STARTS one carries neither, because goose
 *   mints the id itself (a date_time string) — the deferred-identity
 *   model (the opencode/kimi one), not the codemux-minted one.
 * - The id shape is the binary's own example: eight digits, an
 *   underscore, six digits (`20250921_143022`).
 * - `--output-format json` prints the turn's final serialized agent
 *   message as one JSON object on stdout, and that object carries the
 *   session id (`session_id`) and the usage report — the run path's
 *   parser (src/result-envelope/goose.ts) pins the fields; a session
 *   turn reads the same object.
 * - The prompt is an argv value (`-t`), so the run path's argv byte
 *   bound is the per-turn cap the driver enforces before the ack.
 * - Model, autonomy, and effort ride the environment, never argv
 *   (GOOSE_MODEL, GOOSE_MODE, GOOSE_THINKING_EFFORT — the run adapter's
 *   getRunEnv), so the session's turn environment mirrors it exactly.
 */

import { featureFloor } from "../harness-contracts.js";
import { parseGooseResultEnvelope } from "../result-envelope/goose.js";
import { emptyUsage } from "../result-envelope.js";
import { buildGoosePlaywrightExtension } from "../goose-playwright.js";
import type {
  AutonomyLevel,
  ReasoningEffort,
  ResultUsageBlock,
  ToolSelection,
} from "../types.js";
import type { SessionCapabilities } from "./protocol.js";

/** The session-only version floor (§4.3): 1.50.1, the installed binary
 * whose --resume/--session-id contract, id shape, and JSON output object
 * this command and parse are pinned against. */
export const GOOSE_SESSION_FLOOR = featureFloor("goose", "sessions");

/** The id shape goose itself mints (the binary's own help example,
 * '20250921_143022'): eight digits, an underscore, six digits. Goose
 * owns the mint — codemux adopts the id from the first turn's output
 * object and refuses any other shape on --resume. */
export const GOOSE_SESSION_ID_PATTERN = /^\d{8}_\d{6}$/;

/**
 * Capability flags for goose sessions (§3.4): live input yes (one caller
 * input, one goose process), resume yes through goose's own session
 * ledger. Everything else honestly no — there is no steering or
 * interrupt channel into a one-shot process, no permission round-trip
 * (the GOOSE_MODE boundary is set at spawn), no deltas (the JSON object
 * is the turn's one complete message), no file-change frames, and usage
 * arrives only on the turn's final object, so it rides the per-turn
 * completion (the agy/claude contract), not a stream.
 */
export function gooseSessionCapabilities(): SessionCapabilities {
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
 * adapter's (the agy/aider session modules' convention): every turn's
 * environment carries the same GOOSE_MODE `run` sets, and a unit test
 * pins the two together so they cannot drift.
 */
export function gooseSessionMode(level: AutonomyLevel): string {
  switch (level) {
    case "read-only":
      return "chat";
    case "low":
      return "approve";
    case "medium":
      return "smart_approve";
    case "high":
      return "auto";
  }
}

/** The effort level's GOOSE_THINKING_EFFORT value: codemux's `none` maps
 * to the enum's `off` (the run adapter's rule; the binary's
 * ThinkingEffort enum is off/low/medium/high/max). */
export function gooseSessionEffortEnv(level: ReasoningEffort): string {
  return level === "none" ? "off" : level;
}

export interface GooseSessionEnv {
  autonomy: AutonomyLevel;
  model?: string;
  effort?: ReasoningEffort;
  /** The provider override's environment, already resolved by the caller
   * (the adapter's providerEnv) — threaded in so this module owns the
   * goose-specific spellings only and the override surface stays one
   * place. */
  providerEnv?: Record<string, string>;
}

/**
 * The per-turn environment: the run adapter's getRunEnv in the same
 * spelling (GOOSE_MODE always, GOOSE_MODEL and GOOSE_THINKING_EFFORT
 * when one applies, the provider override's variables when one is set),
 * so session turns and runs cannot drift.
 */
export function buildGooseSessionEnv(command: GooseSessionEnv): Record<string, string> {
  return {
    GOOSE_MODE: gooseSessionMode(command.autonomy),
    ...(command.model !== undefined ? { GOOSE_MODEL: command.model } : {}),
    ...(command.effort !== undefined
      ? { GOOSE_THINKING_EFFORT: gooseSessionEffortEnv(command.effort) }
      : {}),
    ...(command.providerEnv ?? {}),
  };
}

export interface GooseSessionCommand {
  /** The goose-minted session id to resume, or undefined to start fresh
   * (goose mints the id; the driver adopts it from the first turn's
   * output object). */
  resumeSessionId?: string;
  /** The turn's prompt (the -t value, author prefix applied). */
  prompt: string;
  /** The XDG env assignments of a HERMETIC session turn's private home
   * (src/goose-hermetic.ts): when present the command is wrapped in the
   * run path's env(1) shape, so session turns and hermetic runs cannot
   * drift. */
  hermeticEnvAssignments?: readonly string[];
  /** `--tools none` reapplied on EVERY turn: --no-profile (the run
   * path's carrier, src/adapters/goose.ts) so a resumed session keeps
   * the tool set the first turn promised. */
  tools?: ToolSelection;
  /** The sandbox-scoped Playwright stdio extension (src/goose-playwright.
   * ts) on every turn: owned and tested here; the shared turn threading
   * that carries the flag to this builder rides
   * scratch/fix/w4-shared.patch. */
  playwrightMcp?: boolean;
}

/**
 * The per-turn spawn command: `goose run`, the resume pair — both flags
 * or neither, the binary's own rule — the JSON output format, and the
 * prompt as the argv tail.
 */
export function buildGooseSessionCommand(command: GooseSessionCommand): string[] {
  const argv =
    command.hermeticEnvAssignments === undefined
      ? ["goose"]
      : ["env", ...command.hermeticEnvAssignments, "goose"];
  argv.push("run");
  if (command.resumeSessionId !== undefined) {
    argv.push("--resume", "--session-id", command.resumeSessionId);
  }
  argv.push("--output-format", "json");
  if (command.tools === "none") {
    argv.push("--no-profile");
  }
  if (command.playwrightMcp === true) {
    // The gate already refused playwright without --sandbox, so a session
    // that reaches here is sandboxed (the mcp.ts rule).
    argv.push(
      ...buildGoosePlaywrightExtension(true, {
        enabled: true,
        pathEnv: process.env.PATH ?? "",
      }).args
    );
  }
  argv.push("-t", command.prompt);
  return argv;
}

/** What one turn's whole stdout resolves to: the run path's parser (the
 * final JSON object — answer text, usage, session id) plus the identity
 * check a session adds. */
export interface GooseSessionTurnParse {
  answer: string | null;
  usage: ResultUsageBlock;
  /** The output object's session_id, when it carried one. */
  sessionId: string | null;
  /** True when the object named no session id at all: a fresh session's
   * first turn owes one (without it the session is untrackable — the
   * opencode rule), and a resumed turn breaks the pin. */
  noSessionId: boolean;
  /** True when the object named a session other than the one this turn
   * resumed — the driver fails the turn's identity, not just its shape. */
  wrongSession: boolean;
  /** True when stdout carried no JSON object at all (the driver's
   * tier-3 fatal: the launch ran with --output-format json). */
  noWire: boolean;
}

/**
 * Parse one turn's stdout: the run envelope parser folds the final
 * object, and this adds the session's two rules — the object must name a
 * session id (the deferred identity arrives here), and on a resumed turn
 * it must name the id codemux resumed (the kimi wrong-session rule).
 */
export function parseGooseSessionTurn(
  stdout: string,
  context: { knownSessionId: string | null }
): GooseSessionTurnParse {
  const parsed = parseGooseResultEnvelope(stdout);
  if (parsed === null) {
    return {
      answer: null,
      usage: emptyUsage(),
      sessionId: null,
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
    noSessionId: sessionId === null,
    wrongSession:
      sessionId !== null &&
      context.knownSessionId !== null &&
      sessionId !== context.knownSessionId,
    noWire: false,
  };
}
