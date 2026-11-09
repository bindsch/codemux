/**
 * The copilot session wiring: the per-turn spawn command over copilot's
 * own session store, the honest capability matrix, and the JSONL line
 * parse shared with the run path. Pure functions only — all live state
 * lives in the launcher-owned driver (the turn-per-process table,
 * src/session/turn-per-process.ts).
 *
 * Wire facts pinned against installed @github/copilot 1.0.85 app.js and
 * 1.0.103 copilot.tgz/package/cli-main.js, read 2026-11-09:
 *
 * - "Start a new session with a specific UUID — copilot
 *   --session-id=0cb916db-26aa-40f2-86b5-1ba81b225fd2", "Resume a
 *   specific session by ID — copilot --resume=<session-id>", and the
 *   argv filter that recognizes -r/--resume/--session-id/--continue.
 *   Codemux mints a lowercase UUID and names it with --session-id on the
 *   first turn, so the session's identity is known at spawn (the claude
 *   model), and resumes the SAME full id — never a prefix, which the CLI
 *   also accepts and would match more than one session.
 * - `--output-format json` ("JSONL, one JSON object per line", the
 *   flag's own help) is the turn's event stream; the run path's parser
 *   (src/result-envelope/copilot.ts) pins the line shapes: the last
 *   `assistant.message` event's `data.content` is the answer, the final
 *   `result` line carries `{type:"result", timestamp, sessionId,
 *   exitCode, usage}` and NO token counts (the writer suppresses the
 *   usage events), and `session.error` events carry
 *   `data.message`.
 * - Piped stdin selects prompt mode and carries the full prompt.
 */

import { featureFloor } from "../harness-contracts.js";
import { parseCopilotResultEnvelope } from "../result-envelope/copilot.js";
import type { AutonomyLevel, ReasoningEffort } from "../types.js";
import type { SessionCapabilities } from "./protocol.js";
import { buildCopilotPlaywrightMcp } from "../copilot-mcp.js";
import type { ExecutableCheck } from "../executable-security.js";
import type { ToolSelection } from "../types.js";

/** The session-only version floor (§4.3): 1.0.85, whose installed app.js
 * contains the session flags and JSONL stream used here. */
export const COPILOT_SESSION_FLOOR = featureFloor("copilot", "sessions");

/** The id shape codemux mints for a copilot session (a plain lowercase
 * UUID — the CLI's own help spells the flag "a specific UUID" with a
 * UUID example). Codemux only ever resumes the ids it minted, so the
 * pattern pins its own mint — the claude convention. */
export const COPILOT_SESSION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Capability flags for copilot sessions (§3.4): live input yes (one
 * caller input, one copilot process), resume yes through copilot's own
 * store keyed by the codemux-minted id. The RPC driver wires native
 * session abort for caller interrupts; permission requests have no
 * caller round trip (native requests are answered by policy), so
 * permissions stays false. It emits complete assistant messages rather
 * than deltas or file-change frames. Native usage comes from a post-exit
 * artifact, so usage_stream remains false.
 */
export function copilotSessionCapabilities(): SessionCapabilities {
  return {
    live_input: true,
    user_during_turn: false,
    steer: false,
    interrupt: true,
    permissions: false,
    deltas: false,
    file_changes: false,
    usage_stream: false,
    resume: true,
  };
}

/**
 * The session autonomy mapping, pinned here independently of the run
 * adapter's (the agy/aider session modules' convention): the per-turn
 * processes carry the same flags `run` does, and a unit test pins the
 * two together so they cannot drift.
 */
export function copilotSessionAutonomyFlags(level: AutonomyLevel): string[] {
  switch (level) {
    case "read-only":
      return ["--plan"];
    case "low":
      return ["--allow-tool", "read"];
    case "medium":
      return ["--allow-all-tools"];
    case "high":
      return ["--allow-all"];
  }
}

export interface CopilotSessionCommand {
  /** The `--model` value, when one applies. */
  model?: string;
  autonomy: AutonomyLevel;
  effort?: ReasoningEffort;
  /** The codemux-minted session id: --session-id on the first turn (a new
   * session named for it), --resume on every later one. */
  sessionId: string;
  /** True while this turn STARTS the session (the first turn). */
  firstTurn: boolean;
  /** The turn's stdin prompt, with the author prefix applied. */
  prompt: string;
  /** The private COPILOT_HOME a hermetic session turn runs under, when
   * the session is hermetic: every turn carries the run path's env
   * prefix pointed at it, so session turns and hermetic runs cannot
   * drift. */
  hermeticHome?: string;
  tools?: ToolSelection;
  playwrightMcp?: boolean;
  sandboxed?: boolean;
  cwd?: string;
  pathEnv?: string;
  nestedChecks?: ExecutableCheck[];
  usageOutputPath?: string;
  callerOwnedHome?: boolean;
}

/**
 * The per-turn spawn command: the run adapter's hardening flags in its
 * exact order (no updates, no bash env, no remote, no workspace custom
 * instructions, no experiments; the built-in MCP servers off below
 * `high`), then model, autonomy, effort, the session carrier
 * (`--session-id <minted>` on the turn that starts the session,
 * `--resume <minted>` on every later one), the JSONL output format, and
 * `--silent`. The driver sends the prompt on stdin.
 */
export function buildCopilotSessionCommand(command: CopilotSessionCommand): string[] {
  const argv =
    command.hermeticHome === undefined
      ? ["copilot"]
      : ["env", `COPILOT_HOME=${command.hermeticHome}`, "copilot"];
  argv.push(
    "--no-auto-update",
    "--no-bash-env",
    "--no-remote",
    "--no-remote-export",
    ...(command.callerOwnedHome ? [] : ["--no-custom-instructions"]),
    "--no-experimental"
  );
  if (command.autonomy !== "high") {
    argv.push("--disable-builtin-mcps");
  }
  if (command.model !== undefined) {
    argv.push("--model", command.model);
  }
  argv.push(...copilotSessionAutonomyFlags(command.autonomy));
  if (command.effort !== undefined) {
    argv.push("--reasoning-effort", command.effort);
  }
  if (command.tools === "none") argv.push("--available-tools", "codemux-no-tools");
  const playwright = buildCopilotPlaywrightMcp(command.sandboxed, {
    enabled: command.playwrightMcp, forbiddenRoot: command.cwd ?? process.cwd(),
    pathEnv: command.pathEnv ?? "",
  });
  argv.push(...playwright.args);
  if (playwright.check !== null) command.nestedChecks?.push(playwright.check);
  if (command.firstTurn) {
    argv.push("--session-id", command.sessionId);
  } else {
    argv.push("--resume", command.sessionId);
  }
  argv.push("--output-format", "json");
  if (command.usageOutputPath !== undefined) argv.push("--usage-output-file", command.usageOutputPath);
  argv.push("--silent");
  return argv;
}

/** What one turn's whole stdout resolves to: the run path's parser
 * (answer, sessionId, reported exit code, error text — the line shapes
 * are pinned there) plus the identity check a session adds. */
export interface CopilotSessionTurnParse {
  answer: string | null;
  /** The result line's sessionId, when the line arrived. */
  sessionId: string | null;
  /** The final result line's exitCode, when the line arrived. */
  reportedExitCode: number | null;
  errorText: string | null;
  /** True when a result line named a session other than the one codemux
   * minted — the driver fails the turn's identity, not just its shape. */
  wrongSession: boolean;
  /** True when stdout carried no JSON lines at all (the driver's
   * tier-3 fatal: the launch ran with --output-format json). */
  noWire: boolean;
}

/**
 * Parse one turn's JSONL stream: the run envelope parser folds the wire,
 * and this adds the session's one rule — the result line's sessionId,
 * when one arrives, must be the id codemux named for the turn. A fresh
 * session's result line echoes the minted id and a resumed turn's names
 * the same one, so anything else means the harness ran a different
 * session than the one this session is (tier 2, the kimi wrong-session
 * rule).
 */
export function parseCopilotSessionTurn(
  stdout: string,
  context: { knownSessionId: string }
): CopilotSessionTurnParse {
  const parsed = parseCopilotResultEnvelope(stdout);
  if (parsed === null) {
    return {
      answer: null,
      sessionId: null,
      reportedExitCode: null,
      errorText: null,
      wrongSession: false,
      noWire: true,
    };
  }
  return {
    answer: parsed.answer,
    sessionId: parsed.sessionId,
    reportedExitCode: parsed.reportedExitCode,
    errorText: parsed.errorText,
    wrongSession:
      parsed.sessionId !== null && parsed.sessionId !== context.knownSessionId,
    noWire: false,
  };
}
