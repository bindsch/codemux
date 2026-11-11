/**
 * The pi session wiring: the per-turn spawn command over pi's own session
 * store, the honest capability matrix, and the turn parse shared with the
 * run path's event-wire parser. Pure functions only — all live state lives
 * in the launcher-owned driver (the turn-per-process table,
 * src/session/turn-per-process.ts).
 *
 * Wire facts pinned against the installed 0.85.1 bundle
 * (/opt/homebrew/bin/pi is a launcher for
 * /opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/
 * dist/bundle/cli.js, whose payload chunk is
 * dist/bundle/chunks/chunk-JVUZSMYM.js; package.json says "0.85.1"; every
 * string below was read in that chunk, 2026-11-09):
 *
 * - The session flags, from the CLI's own help block (offset ~1067658):
 *   "--continue, -c   Continue previous session",
 *   "--resume, -r     Select a session to resume",
 *   "--session <path|id>   Use specific session file or partial UUID",
 *   "--session-id <id>     Use exact project session ID, creating it if
 *   missing", "--no-session    Don't save session (ephemeral)". The
 *   parser (offset ~1062100) binds each to its field:
 *   `result.session=args[++i]`, `result.sessionId=args[++i]`,
 *   `result.noSession=!0`, and `--continue`/`--resume` are bare booleans.
 * - `--session-id` refuses the three other resume spellings and validates
 *   its value (validateSessionIdFlags, offset ~3985634): "Error:
 *   --session-id cannot be combined with ${…}" over --session,
 *   --continue, --resume, then assertValidSessionId —
 *   /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/ with the message
 *   "Session id must be non-empty, contain only alphanumeric characters,
 *   '-', '_', and '.', and start and end with an alphanumeric character"
 *   — and process.exit(1). A malformed id therefore fails the whole
 *   process loudly at startup; this module does not re-validate.
 * - Resolution (createSessionManager, offset ~3986610): with --session-id
 *   and no --no-session, pi looks the exact id up in the project session
 *   store and OPENS it when found — `findLocalSessionByExactId(…
 *   ).find(s=>s.id===sessionId)` — and otherwise warns on stderr,
 *   "Warning: No project session found with id '${…}'; creating a new
 *   session with that id.", and creates it:
 *   `SessionManager.create(cwd,sessionDir,{id:parsed.sessionId})`. One
 *   flag therefore resumes AND creates. That is the codemux-minted
 *   identity model (the gemini/claude one, not the deferred goose/kimi
 *   one): codemux names a UUID before the first spawn and every turn
 *   carries the same `--session-id <minted>` — no first-turn special
 *   case, no adoption state.
 * - The id pi itself mints when nobody passes --session-id is a uuidv7
 *   (`function createSessionId(){return uuidv7()}`, offset ~2481700), and
 *   every session opens with the header entry
 *   `{type:"session",version:CURRENT_SESSION_VERSION,id,timestamp,cwd,
 *   parentSession}` (newSession; CURRENT_SESSION_VERSION is 3). The file
 *   lands in the cwd-scoped store — getDefaultSessionDirPath joins
 *   `<agentDir>/sessions/--<cwd-dashed>--/<ISO-timestamp-dashes>_<id>.
 *   jsonl` — and the agent dir honors PI_CODING_AGENT_DIR, so a hermetic
 *   session's private agent dir relocates its store with it.
 * - The session id's ONLY place on the `--mode json` wire is that header.
 *   runPrintMode (offset ~3903774) writes it first — `if(mode==="json")
 *   {let header=session.sessionManager.getHeader();header&&
 *   writeRawStdout(`${JSON.stringify(header)}\n`)}` — then one JSON line
 *   per event, `writeRawStdout(`${JSON.stringify(toJsonEvent(event))}
 *   \n`)`. No event carries a session id: the bus spells message ends
 *   `{type:"message_end",message}` throughout (offsets ~2553085 ff.).
 *   The header is also the wire's FIRST line, so the identity is
 *   checkable the moment the turn starts, not only at its end.
 * - Exit codes (runPrintMode, offset ~3902136): json mode never raises
 *   the code for a failed stopReason — only the text branch does
 *   (`if(mode==="text"){…stopReason==="error"||stopReason==="aborted"…
 *   exitCode=1}`), and a thrown error returns 1 with a stderr message.
 *   A session turn's verdict therefore reads the structured stopReason,
 *   not the process exit — the run path's rule
 *   (src/result-envelope/pi.ts).
 * - The prompt rides STDIN, never argv (the run adapter's getStdinInput
 *   returns the prompt; pi's readPipedStdin becomes the turn's initial
 *   message), so no argv byte bound caps a session turn. Model rides
 *   `--model`; effort rides `--thinking <level>` ("Set thinking level:
 *   off, minimal, low, medium, high, xhigh, max"; codemux's `none` maps
 *   to `off`); autonomy rides the run adapter's flag mapping, pinned to
 *   it below so session turns and runs cannot drift.
 */

import { sessionIdPattern } from "./id-pattern.js";
import { featureFloor } from "../harness-contracts.js";
import { parsePiResultEnvelope } from "../result-envelope/pi.js";
import { emptyUsage } from "../result-envelope.js";
import type { AutonomyLevel, ReasoningEffort, ResultUsageBlock, ToolSelection } from "../types.js";
import type { SessionCapabilities } from "./protocol.js";

/** The session-only version floor (§4.3): 0.85.1, the installed bundle
 * whose session flag contract, id shape, and json wire this command and
 * parse are pinned against. */
export const PI_SESSION_FLOOR = featureFloor("pi", "sessions");

/** The id shape codemux mints for a pi session: a plain lowercase UUID,
 * which is also the uuidv7 shape pi itself mints (createSessionId). Pi's
 * own validation accepts the wider alphanumeric class quoted in the
 * header, but codemux only ever names ids it minted, so the pattern pins
 * its own mint — the gemini/claude convention. */
export const PI_SESSION_ID_PATTERN = sessionIdPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

/**
 * Capability flags for pi sessions (§3.4): live input yes (one caller
 * input, one pi process), interrupt yes (the native RPC abort command
 * ends the active prompt and preserves the session), resume yes through
 * pi's own project session store keyed by the codemux-minted id.
 * Everything else honestly no — there is no steering channel, no
 * permission round-trip (--no-approve leaves the project untrusted and
 * the json wire's event vocabulary — message_start, message_update,
 * message_end, agent_start, agent_end, agent_settled, custom_message —
 * has no permission request frame), no file-change frames, and usage
 * arrives on assistant message_end events only, so it rides the per-turn
 * completion (the agy/claude contract), not a stream. The wire does
 * carry message_update frames (toJsonEvent keeps their usage and delta
 * events), but the turn-per-process contract delivers one folded
 * completion per input; a later driver that surfaces those frames flips
 * deltas, and this module does not promise it.
 */
export function piSessionCapabilities(): SessionCapabilities {
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
 * The session autonomy mapping, the run adapter's mapAutonomy verbatim
 * (the gemini/goose convention): every turn's process carries the same
 * tool boundary a run does, and a unit test pins the two together so
 * they cannot drift.
 */
export function piSessionAutonomyFlags(level: AutonomyLevel): string[] {
  switch (level) {
    case "read-only":
      return ["--no-extensions", "--tools", "read,grep,find,ls"];
    case "low":
      return ["--no-extensions", "--tools", "read,grep,find,ls,edit,write"];
    case "medium":
    case "high":
      // medium and high have no dedicated flags: pi's default mode
      // already runs every tool (the run adapter's own note).
      return [];
  }
}

/** The effort flags: `--thinking <level>`, with codemux's `none` mapped
 * to the enum's `off` — the run adapter's mapEffort verbatim. */
export function piSessionEffortFlags(level: ReasoningEffort): string[] {
  return ["--thinking", level === "none" ? "off" : level];
}

export interface PiSessionCommand {
  /** The codemux-minted session id. Every turn carries it: pi opens the
   * existing project session with that exact id or creates it, so the
   * fresh turn and the resumed turn are the same command. A malformed id
   * makes pi itself exit 1 at flag validation (assertValidSessionId),
   * which fails the turn loudly. */
  sessionId: string;
  /** The session's autonomy level; every turn's process carries its
   * flags, exactly as a run's do. */
  autonomy: AutonomyLevel;
  /** The --model value, when one applies. */
  model?: string;
  /** A provider override selects its models.json entry by qualified id. */
  providerModelId?: string;
  /** A stable native transcript directory, independent of per-turn models.json. */
  sessionDir?: string;
  /** Reapplied on every launch, including a resumed native session. */
  tools?: ToolSelection;
  mcpExtensionPath?: string;
  /** The --thinking level, when one applies. */
  effort?: ReasoningEffort;
  /** True for a HERMETIC session turn: adds --no-context-files, the run
   * adapter's hermetic rule (the private agent directory alone does not
   * stop AGENTS.md/CLAUDE.md discovery). */
  hermetic?: boolean;
  /** The env(1) assignments a HERMETIC session turn is wrapped in, when
   * the session is hermetic: the driver passes the private agent dir's
   * relocation (`PI_CODING_AGENT_DIR=<dir>`) here, so session turns and
   * hermetic runs cannot drift (the goose module's convention). */
  hermeticEnvAssignments?: readonly string[];
}

/**
 * The per-turn spawn command: the run adapter's headless shape
 * (`--print --no-approve`, `--mode json`, model, hermetic, autonomy,
 * effort) plus the one session carrier, `--session-id <minted>`. The run
 * path's `--no-session` is deliberately ABSENT: it makes the manager
 * in-memory (createSessionManager returns inMemory under it), which
 * would leave every turn unpersisted and unresumable. The prompt does
 * not ride argv at all — the driver feeds it on stdin, the run adapter's
 * carrier.
 */
export function buildPiSessionCommand(command: PiSessionCommand): string[] {
  const argv =
    command.hermeticEnvAssignments === undefined
      ? ["pi"]
      : ["env", ...command.hermeticEnvAssignments, "pi"];
  argv.push("--print", "--no-approve");
  argv.push("--mode", "json");
  argv.push("--session-id", command.sessionId);
  if (command.mcpExtensionPath !== undefined) argv.push("--extension", command.mcpExtensionPath);
  if (command.sessionDir !== undefined) {
    argv.push("--session-dir", command.sessionDir);
  }
  const model = command.providerModelId ?? command.model;
  if (model !== undefined) {
    argv.push("--model", model);
  }
  if (command.hermetic) {
    argv.push("--no-context-files");
  }
  if (command.tools === "none") {
    // sdk.js prefers options.tools over noTools. Never pair an autonomy
    // allowlist with --no-tools: that would silently restore the tools.
    argv.push("--no-extensions", "--no-tools");
  } else if (command.mcpExtensionPath !== undefined) {
    const excluded = command.autonomy === "read-only" ? "bash,powershell,edit,write"
      : command.autonomy === "low" ? "bash,powershell" : null;
    if (excluded !== null) argv.push("--no-extensions", "--exclude-tools", excluded);
  } else {
    argv.push(...piSessionAutonomyFlags(command.autonomy));
  }
  if (command.effort !== undefined) {
    argv.push(...piSessionEffortFlags(command.effort));
  }
  return argv;
}

/** What one turn's whole stdout resolves to: the run path's envelope
 * facts (answer, summed usage, served model, failure stop reason) plus
 * the session's two identity rules, read off the wire's header line. */
export interface PiSessionTurnParse {
  answer: string | null;
  usage: ResultUsageBlock;
  servedModel: string | null;
  /** The last assistant message's stopReason, when it names a failure
   * ("error"/"aborted") — the verdict the driver reads, because json
   * mode keeps the process exit 0 for these. */
  stopReason: string | null;
  errorText: string | null;
  /** The `{type:"session"}` header line's id, when the wire carried one. */
  sessionId: string | null;
  /** True when the wire named no session id at all. Under the
   * codemux-minted model EVERY turn names the id through --session-id
   * and pi writes the header first in json mode, so a missing id breaks
   * the pin on the fresh turn and the resumed turn alike — the driver's
   * fatal, not an adoptable state. */
  noSessionId: boolean;
  /** True when the header named a session other than the id codemux
   * passed: pi opens the exact id or creates it with that exact id, so
   * any other id is a hard identity defect (the kimi wrong-session
   * rule). */
  wrongSession: boolean;
  /** True when stdout carried no JSON line at all (the launch ran with
   * `--mode json`, so that breaks the contract — the driver's tier-3
   * fatal). */
  noWire: boolean;
}

/**
 * Parse one turn's stdout: the run envelope parser folds the events, and
 * this adds the session's identity rules over the header line — the wire
 * must name a session id, and on a resumed turn it must name the id
 * codemux passed.
 */
export function parsePiSessionTurn(
  stdout: string,
  context: { knownSessionId: string | null }
): PiSessionTurnParse {
  const parsed = parsePiResultEnvelope(stdout);
  if (parsed === null) {
    return {
      answer: null,
      usage: emptyUsage(),
      servedModel: null,
      stopReason: null,
      errorText: null,
      sessionId: null,
      noSessionId: false,
      wrongSession: false,
      noWire: true,
    };
  }
  const sessionId = piWireSessionId(stdout);
  return {
    answer: parsed.answer,
    usage: parsed.usage,
    servedModel: parsed.servedModel,
    stopReason: parsed.stopReason,
    errorText: parsed.errorText,
    sessionId,
    noSessionId: sessionId === null,
    wrongSession:
      sessionId !== null &&
      context.knownSessionId !== null &&
      sessionId !== context.knownSessionId,
    noWire: false,
  };
}

/** The first `{type:"session"}` line's id — the header runPrintMode
 * writes ahead of every event (the pinned quote in the module header).
 * The FIRST such line wins: the header is the wire's opening line, and a
 * later duplicate can only be noise a broken binary appended. A header
 * whose id is not a string counts as naming none — the parse reports
 * noSessionId and the driver fails the turn rather than guessing. */
function piWireSessionId(stdout: string): string | null {
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (typeof parsed !== "object" || parsed === null) continue;
    const event = parsed as Record<string, unknown>;
    if (event.type !== "session") continue;
    return typeof event.id === "string" ? event.id : null;
  }
  return null;
}
