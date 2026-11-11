/**
 * The openhands session wiring: the per-turn spawn command over the
 * conversation ledger, the honest capability matrix, and the turn parse
 * shared with the run path's envelope. Pure functions only — all live
 * state (the turn-per-process table, the per-turn task files) lives in
 * the launcher-owned driver.
 *
 * Wire facts pinned against the installed openhands 1.16.0
 * (~/.local/share/uv/tools/openhands/lib/python3.12/site-packages/
 * openhands_cli, read 2026-11-09):
 *
 * - A session turn is one headless run: `--headless` requires `--task`
 *   or `--file` (entrypoint.py parser.error "--headless requires either
 *   --task or --file to be specified"), sets
 *   `args.exit_without_confirmation = True`, and json mode is
 *   `args.json and args.headless` — so every turn carries the run
 *   path's exact flags and the prompt rides the per-run task file
 *   (src/openhands-task-file.ts), never argv and never stdin (the CLI
 *   has no stdin transport).
 * - Resume is a flag value, not a subcommand: add_resume_args
 *   (argparsers/util.py:45) defines `--resume` as `type=str,
 *   nargs="?", const=""` — "Conversation ID to resume" — and `--last`.
 *   handle_resume_logic (entrypoint.py:41) returns the id as-is, so
 *   `--resume <id>` on a later turn is the whole carrier.
 * - The id the caller adopts is minted harness-side: textual_app.py:198
 *   `initial_conversation_id = resume_conversation_id if
 *   resume_conversation_id else uuid.uuid4()`, and after every run
 *   entrypoint.py prints two lines carrying it —
 *   `Conversation ID: {conversation_id.hex}` (the 32-hex form) and
 *   `Hint: run openhands --resume {conversation_id} ...` (the dashed
 *   str(uuid) form). The deferred identity (the opencode model): the
 *   first turn's output names the id codemux adopts for --resume.
 * - Headless never confirms (tui/textual_app.py selects NeverConfirm
 *   whenever headless is set), so a session turn has no permission
 *   round-trip at any autonomy level — the run path's rule verbatim.
 */

import { sessionIdPattern } from "./id-pattern.js";
import { featureFloor } from "../harness-contracts.js";
import { parseOpenhandsResultEnvelope } from "../result-envelope/openhands.js";
import { emptyUsage } from "../result-envelope.js";
import { join } from "node:path";
import type { SessionCapabilities } from "./protocol.js";

/**
 * The session-only version floor (§4.3): 1.16.0, the installed CLI the
 * resume carrier, the id print, and the json event stream are pinned
 * against. Read lazily — the FEATURE_FLOORS sessions row lands with the
 * registration patch (scratch/fix/w2-session-registration.patch), and
 * this module stays importable before that: the driver and its tests
 * exercise the command builder and the parser, which the floor does not
 * gate. Fails closed once called on an unrecorded mechanism, by design.
 */
export function openhandsSessionFloor(): string {
  return featureFloor("openhands", "sessions");
}

/** The id shape openhands mints (uuid.uuid4, textual_app.py:198): a
 * lowercase dashed v4 UUID — version nibble 4, variant nibble 8/9/a/b.
 * str(uuid) prints lowercase, and the hint line's `--resume <id>` is
 * that dashed form, so the pattern pins the exact string codemux will
 * pass back on every later turn. */
export const OPENHANDS_CONVERSATION_ID_PATTERN = sessionIdPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);

/**
 * Capability flags for openhands sessions: live input yes (one caller
 * input, one headless process), resume yes through the conversation
 * ledger keyed by the harness-minted uuid. Everything else honestly
 * no — a turn is a one-shot process with no steer or interrupt channel
 * (the task file is read at start; nothing is listened to), headless
 * mode confirms nothing itself (NeverConfirm), the json event stream
 * prints complete events with no delta contract, no file-change frames
 * exist, and usage never rides the wire (the run path's pinned null
 * block), so it cannot stream.
 */
export function openhandsSessionCapabilities(): SessionCapabilities {
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

/** The hermetic session's env prefix: the run path's exact three
 * assignments (src/adapters/openhands.ts buildRunCommand) — HOME plus
 * the two persistence redirects an exported ambient value could
 * otherwise steer back at real state. A unit test pins the two
 * together so they cannot drift. */
export function openhandsSessionEnvPrefix(home: string): string[] {
  return [
    "env",
    `HOME=${home}`,
    `OPENHANDS_PERSISTENCE_DIR=${join(home, ".openhands")}`,
    `OPENHANDS_CONVERSATIONS_DIR=${join(home, ".openhands", "conversations")}`,
  ];
}

export interface OpenhandsSessionCommand {
  /** True while this turn STARTS the session; every later turn resumes
   * the conversation the first turn's output named. */
  firstTurn: boolean;
  /** The adopted conversation id. Null only on the first turn (the
   * deferred identity); a later turn without one is a driver bug. */
  conversationId: string | null;
  /** The per-turn task file's path: the prompt carrier (the run path's
   * rule — openhands has no stdin transport). */
  taskFile: string;
  /** The private home for a hermetic session's env prefix; a plain
   * session passes none. */
  hermeticHome?: string;
  overrideWithEnv?: boolean;
}

/**
 * The per-turn spawn command: the run adapter's flag shape (`openhands
 * --headless --json --file <path>`) plus the session carrier —
 * `--resume <id>` on every turn after the first, never on it (the
 * first turn mints the id the output then names).
 */
export function buildOpenhandsSessionCommand(
  command: OpenhandsSessionCommand
): string[] {
  if (!command.firstTurn && command.conversationId === null) {
    throw new Error("a resumed openhands turn names the conversation it resumes");
  }
  const argv = [
    ...(command.hermeticHome !== undefined
      ? openhandsSessionEnvPrefix(command.hermeticHome)
      : []),
    "openhands",
    "--headless",
    "--json",
    "--file",
    command.taskFile,
  ];
  if (!command.firstTurn) {
    argv.push("--resume", command.conversationId!);
  }
  if (command.overrideWithEnv) argv.push("--override-with-envs");
  return argv;
}

/** What one turn's whole stdout resolves to: the run envelope's parse
 * (the last agent MessageEvent's text, the error events' fold, the
 * pinned all-null usage) plus the session's identity rule — the tail's
 * Conversation ID line. */
export interface OpenhandsSessionTurnParse {
  answer: string | null;
  usage: ReturnType<typeof emptyUsage>;
  /** The dashed uuid the turn's tail printed, when it printed one. */
  conversationId: string | null;
  /** True when the tail carried no Conversation ID line at all: a
   * first turn that never ran (or output the CLI swallowed) leaves
   * codemux nothing to adopt — the deferred-identity fatal. */
  noConversationId: boolean;
  /** True when the tail named a conversation other than the one this
   * turn resumed. */
  wrongConversation: boolean;
  /** True when the envelope saw no json events at all (the driver's
   * tier-3 fatal: the turn launched with --json). */
  noWire: boolean;
  /** True when a ConversationErrorEvent failed the turn, with its diagnostic.
   * AgentErrorEvent is a recoverable tool observation. */
  failed: boolean;
  failureReason: string | null;
}

const CONVERSATION_ID_LINE = /^Conversation ID: ([0-9a-f]{32})$/;
// The tail prints through rich (console.print with a style), so each
// line carries SGR codes around its text — the run path's no-task
// matcher strips the same class before matching.
const ANSI_SGR = /\u001b\[[0-9;]*m/g;

/** The last `Conversation ID: <hex>` line of the tail, dashed again —
 * the hint line's `--resume` form. Hex is the uuid without dashes, so
 * the re-dash is mechanical (8-4-4-4-12), and only a line that matches
 * the full shape counts (a reply quoting the phrase does not). */
function readConversationId(stdout: string): string | null {
  let id: string | null = null;
  for (const line of stdout.split("\n")) {
    const match = CONVERSATION_ID_LINE.exec(
      line.replace(ANSI_SGR, "").trim()
    );
    if (match !== null) id = match[1] as string;
  }
  if (id === null) return null;
  return `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`;
}

/**
 * Parse one turn's stdout: the run envelope parser folds the json
 * events, and the session adds its identity rule — the tail must name a
 * conversation id (the first turn's is what codemux adopts) and a
 * resumed turn must hear its own conversation named.
 */
export function parseOpenhandsSessionTurn(
  stdout: string,
  context: { knownConversationId: string | null }
): OpenhandsSessionTurnParse {
  const envelope = parseOpenhandsResultEnvelope(stdout);
  const conversationId = readConversationId(stdout);
  const idIsUsable = conversationId !== null && OPENHANDS_CONVERSATION_ID_PATTERN.test(conversationId);
  return {
    answer: envelope === null ? null : envelope.answer,
    // The run path's pinned fact: no openhands event carries token
    // usage, so the session reports the same honest null block.
    usage: emptyUsage(),
    conversationId: idIsUsable ? conversationId : null,
    noConversationId: conversationId === null,
    wrongConversation:
      idIsUsable &&
      context.knownConversationId !== null &&
      conversationId !== context.knownConversationId,
    noWire: envelope === null,
    failed: envelope !== null && envelope.errorText !== null,
    failureReason: envelope === null ? null : envelope.errorText,
  };
}
