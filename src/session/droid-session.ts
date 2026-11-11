/**
 * The droid session wiring: the per-turn spawn command over droid's own
 * session ledger, the honest capability matrix, and the turn parse shared
 * with the run path. Pure functions only — all live state lives in the
 * launcher-owned driver (the turn-per-process table,
 * src/session/turn-per-process.ts).
 *
 * Wire facts pinned against the installed droid binary (Factory's Droid
 * CLI, version 0.221.0, a 178 MB minified JS payload read as bytes with
 * the offsets below, read 2026-11-09):
 *
 * - The exec command registers `-s, --session-id <id>` with the
 *   description "Existing session to continue (requires a prompt)"
 *   (byte offset 136845948: `.option("-s, --session-id <id>","Existing
 *   session to continue (requires a prompt)")`). The same registration
 *   block has `--fork <id>` ("Fork an existing session into a new
 *   session (requires a prompt)") and `--init-session-id <id>`
 *   ("Create a new session with this specific ID (internal use, for
 *   subagent pre-generation)") — the one flag that could NAME a new
 *   session's id is marked internal use, so codemux does not build on
 *   it. The exec validation agrees that -s means an existing session
 *   (offset 153808343): `if(c&&(t.sessionId||t.fork))throw new
 *   i("Invalid flags: tool execution overrides only apply when creating
 *   a new session.")`, and the run body fetches the id up front
 *   (offset 153834579): `N=await se.fetchSession(s.sessionId)` with the
 *   refusal "Failed to fetch session". A session turn that RESUMES
 *   carries `-s <id>`; the turn that STARTS one carries nothing —
 *   droid mints the id itself, so codemux uses the deferred-identity
 *   model (the goose/opencode one): the id is adopted from the first
 *   turn's completion event.
 * - The one-shot body proves the resumed id is the id the turn runs
 *   under (offset 153836971): `let u=s.fork?...:s.sessionId` then
 *   `if(u){...ensureSessionLoaded(u,...);...v=u}else{...v=...
 *   createSession({sessionId:s.initSessionId??k,...})}` — `v` feeds the
 *   turn and its closing event, so a resumed turn's completion event names
 *   the resumed id (the wrongSession rule) and a fresh turn's names the
 *   mint.
 * - The mint (offset 144558807): `async createNewSession(t){let r=Ee();
 *   return this.createSessionWithId({sessionId:r,...}` calling the v4
 *   template generator (offset 144095499): `function Ee(){return
 *   "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g,...)}`. The
 *   binary's ONLY id validation (offset 137281670): `static
 *   isValidSessionId(t){return Boolean(t)&&t.trim()!==""}` with the
 *   error "Invalid sessionId: received empty or whitespace-only
 *   sessionId" — no shape check anywhere, so the pattern below is
 *   permissive but anchored: nonempty, no whitespace.
 * - Turns launch with `--output-format stream-json` (lane AN1): the
 *   stream's assistant message events carry every message of the turn,
 *   and its closing `{type:"completion",finalText,numTurns,durationMs,
 *   session_id,usage}` event carries the session id and usage
 *   (src/result-envelope/droid.ts names the stream evidence). The
 *   `--output-format json` result object the turns used before is still
 *   parsed, for older captures. That format prints exactly one result
 *   object on stdout (offset 153812787): `function ae(t,r,s){return{type:"result",
 *   subtype:t.isError?"failure":"success",is_error:t.isError,
 *   duration_ms:r,num_turns:t.numTurns,result:t.finalText,
 *   session_id:t.sessionId,usage:s}}`, handed to
 *   `_(JSON.stringify(c))` by the dispatcher `if(s==="json"){let c=
 *   ae(t,r,a);_(JSON.stringify(c));return}` (offset 153815800). The
 *   early-failure builder (offset 153812970) prints the same shape with
 *   `subtype:"failure"` and `session_id:t` — the id passed directly,
 *   which can be the empty string before a session exists, so the turn
 *   parse folds a blank id to no id (the binary's own isValidSessionId
 *   rule). The run path's parser (src/result-envelope/droid.ts) pins
 *   the fields; a session turn reads the same object.
 * - The prompt rides stdin, never argv (the run adapter's
 *   getStdinInput), so the command below carries no prompt argument;
 *   the driver feeds the turn's input on stdin.
 * - Model, autonomy, and effort ride argv exactly as the run path
 *   spells them (`-m`, `--auto`, `--reasoning-effort`; read-only
 *   autonomy maps to no flag — the run adapter's mapAutonomy), so
 *   session turns and runs cannot drift.
 */

import { sessionIdPattern } from "./id-pattern.js";
import { featureFloor } from "../harness-contracts.js";
import { parseDroidResultEnvelope } from "../result-envelope/droid.js";
import { emptyUsage } from "../result-envelope.js";
import type { AutonomyLevel, ReasoningEffort, ResultUsageBlock, ToolSelection } from "../types.js";
import type { SessionCapabilities } from "./protocol.js";

/** The session-only version floor (§4.3): 0.221.0, the installed binary
 * whose -s contract, id mint, and exec wire this command and
 * parse are pinned against. The FEATURE_FLOORS entry lands with the
 * lane's SESSION_AGENTS wiring; the value there must be this one. */
export const DROID_SESSION_FLOOR = featureFloor("droid", "sessions");

/** The id shape codemux resumes for a droid session: any nonempty token
 * with no whitespace. The binary mints v4 UUIDs (the quoted template
 * generator) but validates only nonempty (the quoted isValidSessionId),
 * and codemux only ever feeds back ids droid itself reported, so the
 * pattern also applies codemux's shared single-component safety boundary. */
export const DROID_SESSION_ID_PATTERN = sessionIdPattern(/^\S+$/);

/**
 * Capability flags for droid sessions (§3.4): live input yes (one caller
 * input, one droid exec process), resume yes through droid's own session
 * ledger keyed by the id the first turn's completion event reported.
 * Everything else honestly no — there is no steering or interrupt
 * channel into a one-shot process, no permission round-trip (the
 * --auto boundary is set at spawn), no deltas (codemux reports the turn
 * once its stream ends), no file-change frames, and usage arrives only
 * on the turn's closing completion event, so it rides the per-turn completion
 * (the agy/claude contract), not a stream.
 */
export function droidSessionCapabilities(): SessionCapabilities {
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
 * The effort level's --reasoning-effort value, pinned here
 * independently of the run adapter's (the goose session module's
 * convention) so the two cannot drift silently: codemux's `none` maps
 * to the generic `off`, except on the gpt-5.6 family whose enum keeps a
 * literal `none` (the run adapter's review-round-361 rule — the bare
 * `gpt-5.6` id is the family too).
 */
export function droidSessionEffortValue(level: ReasoningEffort, model?: string): string {
  if (level === "none" && (model === "gpt-5.6" || model?.startsWith("gpt-5.6-"))) {
    return "none";
  }
  return level === "none" ? "off" : level;
}

export interface DroidSessionCommand {
  /** The droid-minted session id to resume (`-s`), or undefined to
   * start fresh (droid mints the id; the driver adopts it from the
   * first turn's completion event). */
  resumeSessionId?: string;
  /** The turn's model in its RAW request spelling — the resolved
   * `--model` or the override's env model, exactly what the run path's
   * effort mapping judges. */
  model?: string;
  /** The BYOK entry's id (droidProviderModelId) an override turn's
   * `-m` carries instead of the raw spelling — the run path's rule:
   * `-m` names the settings entry, `--reasoning-effort` maps on the
   * raw model (gpt-5.6 family), so the two never read one field. */
  providerModelId?: string;
  /** The turn's autonomy: read-only maps to no flag (the run adapter's
   * mapAutonomy — droid has no read-only exec level). */
  autonomy?: AutonomyLevel;
  /** The turn's --reasoning-effort level, when one applies. */
  effort?: ReasoningEffort;
  /** The per-turn BYOK settings file an override session rides
   * (adapters/droid.ts): `--settings` is a root-level flag, so it
   * precedes `exec`. */
  settingsPath?: string;
  /** The env(1) assignments a HERMETIC session turn is wrapped in (the
   * run path's HOME redirect, turn-driver-homes.ts): when present the
   * command is wrapped, so session turns and hermetic runs cannot
   * drift. */
  hermeticEnvAssignments?: readonly string[];
  /** `--tools none` reapplied on every turn: the run path's
   * --only-tools carrier (src/adapters/droid.ts), so a resumed session
   * keeps the tool set the first turn promised. */
  tools?: ToolSelection;
}

/**
 * The per-turn spawn command: `droid exec` in the run path's exact
 * spelling (model, then the JSON wire — always on, a session turn is a
 * --result-json turn — then autonomy, then effort), plus the resume
 * flag `-s <id>` on every turn but the first. The prompt is stdin, not
 * argv, so the driver feeds it after the spawn. An override turn
 * carries the per-run settings file before the subcommand and names
 * the BYOK entry's id on `-m`; a hermetic turn wraps the command in
 * the run path's env(1) shape.
 */
export function buildDroidSessionCommand(command: DroidSessionCommand): string[] {
  const argv =
    command.hermeticEnvAssignments === undefined
      ? ["droid"]
      : ["env", ...command.hermeticEnvAssignments, "droid"];
  if (command.settingsPath !== undefined) {
    argv.push("--settings", command.settingsPath);
  }
  argv.push("exec");
  const modelId = command.providerModelId ?? command.model;
  if (modelId !== undefined) {
    argv.push("-m", modelId);
  }
  // The stream, as the run uses (lane AN1): the json format's result is
  // the last text block alone, and a turn's answer is every message.
  argv.push("--output-format", "stream-json");
  if (command.autonomy !== undefined && command.autonomy !== "read-only") {
    argv.push("--auto", command.autonomy);
  }
  if (command.effort !== undefined) {
    argv.push(
      "--reasoning-effort",
      droidSessionEffortValue(command.effort, command.model)
    );
  }
  if (command.tools === "none") {
    argv.push("--only-tools", "ToolSearch");
  }
  if (command.resumeSessionId !== undefined) {
    argv.push("-s", command.resumeSessionId);
  }
  return argv;
}

/** What one turn's whole stdout resolves to: the run path's parser (the
 * stream's assistant messages for the answer text, the completion event
 * for usage and session id) plus the identity check a session adds. */
export interface DroidSessionTurnParse {
  answer: string | null;
  failed: boolean;
  failureReason: string | null;
  usage: ResultUsageBlock;
  /** The completion event's session_id, when it carried a usable one. */
  sessionId: string | null;
  /** True when the completion event named no session id at all: a fresh session's
   * first turn owes one (without it the session is untrackable — the
   * opencode rule), and a resumed turn breaks the pin. */
  noSessionId: boolean;
  /** True when the completion event named a session other than the one this turn
   * resumed — the driver fails the turn's identity, not just its
   * shape. */
  wrongSession: boolean;
  /** True when stdout carried no wire event at all (the driver's
   * tier-3 fatal: the launch ran with --output-format stream-json). */
  noWire: boolean;
}

/**
 * Parse one turn's stdout: the run envelope parser folds the stream (or
 * a json-format result object), and this adds the session's two rules —
 * the closing event must name
 * a session id (the deferred identity arrives here; a blank id is no
 * id, the binary's own isValidSessionId rule, because the early-failure
 * builder can print session_id:""), and on a resumed turn it must name
 * the id codemux resumed (the wrong-session rule).
 */
export function parseDroidSessionTurn(
  stdout: string,
  context: { knownSessionId: string | null }
): DroidSessionTurnParse {
  const parsed = parseDroidResultEnvelope(stdout);
  if (parsed === null) {
    return {
      answer: null,
      failed: true,
      failureReason: "no result event",
      usage: emptyUsage(),
      sessionId: null,
      noSessionId: false,
      wrongSession: false,
      noWire: true,
    };
  }
  const sessionId =
    parsed.sessionId !== null && DROID_SESSION_ID_PATTERN.test(parsed.sessionId)
      ? parsed.sessionId
      : null;
  return {
    answer: parsed.answer,
    failed: parsed.isError || parsed.subtype !== "success",
    failureReason: parsed.errorMessage ?? (parsed.subtype !== "success" ? `result subtype ${parsed.subtype ?? "missing"}` : null),
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
