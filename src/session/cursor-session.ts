/**
 * The cursor session wiring: the per-turn spawn command over cursor's own
 * session ledger, the honest capability matrix, and the turn parse shared
 * with the run path. Pure functions only — all live state lives in the
 * launcher-owned driver (the turn-per-process table,
 * src/session/turn-per-process.ts).
 *
 * Wire facts pinned against the installed cursor-agent 2026.11.05 bundle
 * (build versions/2026.11.05-86047df; its minified index.js and chunks
 * 1706.index.js / 2683.index.js, read 2026-11-09):
 *
 * - The agent command registers both session selectors next to --model
 *   (index.js, offset 1978723): `.option("--resume [chatId]","Select a
 *   session to resume",!1)` and `.addOption(new f.c$("--new-session-id
 *   <uuid>","Create a new session with a caller-provided ID").hideHelp())`.
 *   The caller CAN name a new session's id, so codemux owns the identity
 *   from the first turn — the codemux-minted model (aider's), not the
 *   deferred-identity one (goose's): a fresh turn claims the mint with
 *   `--new-session-id <uuid>`, every later turn continues it with
 *   `--resume <uuid>`. A bare `--resume` opens an interactive picker, so
 *   a headless turn always passes the id.
 * - The mint's shape is the binary's own validation (2683.index.js,
 *   ./src/state/requested-session-id.ts, offset 838): the zod regex
 *   /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
 *   with the refusals `Error: Invalid --new-session-id "<id>": expected a
 *   UUIDv4.` and `Error: --new-session-id cannot be combined with
 *   --resume or --continue.` (both exit 1). The claim reserves the
 *   session's storage up front and a taken id fails closed: `Session ID
 *   "<id>" is already in use.`
 * - The id never changes under resume (1706.index.js, runChat's session
 *   resolution, offsets 746508 and 746630): `case"new-with-id":
 *   lt=Qe.claim.sessionId` and `case"resume":at=Qe.sessionId … lt=at` — a
 *   resumed conversation runs under the resumed id itself.
 * - The headless result writer (1706.index.js, offset 583967) prints ONE
 *   result JSON line per turn, `{type:"result",subtype:"success",
 *   is_error:false,duration_ms,duration_api_ms,result:<string>,…,
 *   session_id:N.sessionId,request_id,usage?}`, where `result` is the FULL
 *   accumulated reply (K) — and `usage` is the LAST model call's object
 *   (`r&&(ce=r)`, an overwrite), while the stream-json wire prints one
 *   `{type:"usage",subtype:"model_call",usage:…}` event per call whose sum
 *   is the turn's honest total. Every turn launches with
 *   `--output-format stream-json` (the run path's wire, read 2026-11-09):
 *   the result line carries the turn's session id, fresh or resumed, and
 *   the parser sums the usage events around it. A failed run prints NO
 *   result line (the error goes to stderr and the process exits 1); the
 *   run path's parser (src/result-envelope/cursor.ts) pins the same wire.
 * - The headless shape is the run adapter's (src/adapters/cursor.ts):
 *   `cursor-agent --print --output-format stream-json --trust`, autonomy
 *   via mapAutonomy (--mode plan / --auto-review / --force), model via
 *   --model, and the prompt on STDIN, never argv — so the per-turn byte
 *   cap the driver enforces is the stdin frame's, not argv's.
 */

import { featureFloor } from "../harness-contracts.js";
import { parseCursorResultEnvelope } from "../result-envelope/cursor.js";
import { emptyUsage } from "../result-envelope.js";
import type { AutonomyLevel, ResultUsageBlock, ToolSelection } from "../types.js";
import type { SessionCapabilities } from "./protocol.js";

/** The session-only version floor (§4.3): 2026.11.05, the installed build
 * whose --resume/--new-session-id contract, id shape, and JSON result
 * line this command and parse are pinned against. */
export const CURSOR_SESSION_FLOOR = featureFloor("cursor", "sessions");

/** The id shape the binary itself demands of a caller-provided session id
 * (2683.index.js, offset 838): a UUIDv4, case-insensitive hex. codemux
 * mints the id (a lowercase UUIDv4), claims it on the fresh turn, and
 * refuses any other shape before a spawn — the binary's own rule, so a
 * corrupted session record can never reach argv. */
export const CURSOR_SESSION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Capability flags for cursor sessions (§3.4): live input yes (one caller
 * input, one cursor-agent process), resume yes through cursor's own
 * session ledger. Everything else honestly no — there is no steering or
 * interrupt channel into a one-shot --print process, no permission
 * round-trip (the headless loop answers interaction queries itself: it
 * replies to ask-question with "Questions skipped in headless mode" and
 * rejects switch-mode with "Switch mode requires approval",
 * 1706.index.js offsets 766086 and 765980; the autonomy boundary is set
 * at spawn via the run adapter's flags), no deltas (the whole turn's
 * stdout resolves once, at completion; the stream-json wire's assistant
 * and usage events are folded, not surfaced live), no file-change frames,
 * and usage arrives only at the turn's completion (the result line plus
 * the per-call usage events before it), so it rides the per-turn
 * completion (the agy/claude contract), not a live stream.
 */
export function cursorSessionCapabilities(): SessionCapabilities {
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
 * turn's argv carries the same flags `run` does, and a unit test pins the
 * two together so they cannot drift.
 */
export function cursorSessionAutonomyFlags(level: AutonomyLevel): string[] {
  switch (level) {
    case "read-only":
      return ["--mode", "plan"];
    case "low":
      return [];
    case "medium":
      return ["--auto-review"];
    case "high":
      return ["--force"];
  }
}

export interface CursorSessionCommand {
  autonomy: AutonomyLevel;
  /** The codemux-minted UUIDv4 session id, carried on EVERY turn: the
   * binary resolves it to the same conversation either way, and the parse
   * checks the result line against it. */
  sessionId: string;
  /** True on the fresh session's first turn (claims the id with
   * --new-session-id); false on every resumed turn (--resume). The two
   * flags cannot combine — the binary's own refusal — and one interface
   * boolean makes the conflict unrepresentable. */
  startSession: boolean;
  model?: string;
  /** `--tools none` reapplied on every turn: the run path's
   * --allowed-tools allowlist (src/adapters/cursor.ts), so a resumed
   * session keeps the tool set the first turn promised. */
  tools?: ToolSelection;
}

/**
 * The per-turn spawn command: the run adapter's headless shape
 * (`cursor-agent --print --output-format json --trust`) with the session
 * flag added — `--new-session-id <id>` on the fresh turn, `--resume <id>`
 * on every later one — then the adapter's own order (model, autonomy).
 * The prompt never rides argv; the driver feeds it on stdin. An id that
 * fails the binary's own UUIDv4 rule throws here, before any spawn.
 */
export function buildCursorSessionCommand(command: CursorSessionCommand): string[] {
  if (!CURSOR_SESSION_ID_PATTERN.test(command.sessionId)) {
    throw new Error(
      "the cursor session id must be a UUIDv4 (the binary's own " +
        `--new-session-id rule, 2683.index.js); refusing "${command.sessionId}"`
    );
  }
  const argv = ["cursor-agent", "--print", "--output-format", "stream-json", "--trust"];
  argv.push(command.startSession ? "--new-session-id" : "--resume", command.sessionId);
  if (command.model !== undefined) {
    argv.push("--model", command.model);
  }
  if (command.tools === "none") {
    argv.push("--allowed-tools", "reflect_tool_call");
  }
  argv.push(...cursorSessionAutonomyFlags(command.autonomy));
  return argv;
}

/** What one turn's whole stdout resolves to: the run path's parser (the
 * one result line — answer text, usage, session id) plus the identity
 * check a session adds. */
export interface CursorSessionTurnParse {
  answer: string | null;
  usage: ResultUsageBlock;
  /** The result line's session_id, when it carried one. */
  sessionId: string | null;
  /** True when the result line named no session id at all: the writer
   * always writes the field (1706.index.js offset 583967), so a line
   * without one is a foreign wire — the turn fails on shape, fresh or
   * resumed, because the id is codemux's own mint and never deferred. */
  noSessionId: boolean;
  /** True when the result line named a session other than the one this
   * turn's argv carried — the driver fails the turn's identity, not just
   * its shape. The minted model knows the id on EVERY turn, so the rule
   * binds the fresh turn too, not only resumed ones. */
  wrongSession: boolean;
  /** True when stdout carried no result line at all (the driver's
   * tier-3 fatal: the launch ran with --output-format json, and cursor
   * prints no result line exactly when the run failed). */
  noWire: boolean;
}

/**
 * Parse one turn's stdout: the run envelope parser folds the result line,
 * and this adds the session's two rules — the line must name a session id
 * (the binary always writes it), and it must name the id codemux's argv
 * carried, fresh or resumed.
 */
export function parseCursorSessionTurn(
  stdout: string,
  context: { sessionId: string }
): CursorSessionTurnParse {
  const parsed = parseCursorResultEnvelope(stdout);
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
    wrongSession: sessionId !== null && sessionId !== context.sessionId,
    noWire: false,
  };
}
