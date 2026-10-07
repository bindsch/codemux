/**
 * The agy session wiring (design §4.7, plan step 8): the spawn command,
 * the honest capability matrix, and the `event`-keyed result parser under
 * the three tiers. Pure functions only — all live state lives in the
 * launcher-owned driver (src/session/agy-driver.ts).
 *
 * Wire facts here are pinned by the step-0 fixtures and `agy --help`
 * (1.2.14): `--input-format=stream-json` "reads one NDJSON message per
 * line from stdin and runs a turn for each" (it requires
 * `--output-format=stream-json`), `--conversation <id>` resumes, and enum
 * flags accept only the `--flag=value` form. The input line the fixture
 * recorded is the claude-style user frame, and the only live output frame
 * is the auth-failure result — the full exchange never ran (login
 * expired), so the parser is documented-not-live-verified and the e2e
 * tests drive a fake built from the fixture's shapes. Every capability
 * the fixtures could not evidence (steer, interrupt, permissions,
 * user-during-turn, deltas, file changes, usage stream) reports false,
 * honestly.
 */

import { parseAgyResultEnvelope } from "../result-envelope.js";
import type { AutonomyLevel, ReasoningEffort, ResultUsageBlock } from "../types.js";
import { unusableFacts } from "./process.js";
import type { SessionCapabilities } from "./protocol.js";

/** The session-only version floor (§4.3): the installed-and-audited 1.2.14,
 * the build whose help text and binary the input loop, the `=` flag forms,
 * and the result envelope were pinned against. */
export const AGY_SESSION_FLOOR = "1.2.14";

/**
 * The id shape `--resume` accepts for agy. No live conversation id was
 * ever recorded (the fixture's frame carries an empty one), so the
 * pattern deliberately accepts the same class the registry can store — a
 * non-empty whitespace-free token up to MAX_ID_CHARS (128) — and refuses
 * only pastes that are obviously not ids. When a live exchange is ever
 * recorded, tighten this to the observed shape.
 */
export const AGY_CONVERSATION_ID_PATTERN = /^\S{1,128}$/;

/**
 * Capability flags for agy sessions (§3.4): live input yes (one NDJSON
 * line, one turn), everything the help, binary, and fixtures could not
 * evidence no. Turns serialize harness-side with no steer, interrupt, or
 * permission channel; no delta or file-change frames are known; usage
 * arrives only inside the per-turn result envelope, which is a report,
 * not a stream.
 */
export function agySessionCapabilities(): SessionCapabilities {
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

export interface AgySessionCommand {
  resumeConversationId?: string;
  model?: string;
  autonomy: AutonomyLevel;
  effort?: ReasoningEffort;
}

/**
 * The session autonomy mapping, pinned here independently of the run
 * adapter's (the claude-family session module owns its own mapping the
 * same way). Nothing session-specific changes agy's — there is no
 * permission carrier to arrange — so the flags are the adapter's
 * mapAutonomy verbatim, and a unit test pins the two together so they
 * cannot drift.
 */
export function agySessionAutonomyFlags(level: AutonomyLevel): string[] {
  switch (level) {
    case "read-only":
      return ["--mode=plan"];
    case "low":
      return [];
    case "medium":
      return ["--mode=accept-edits"];
    case "high":
      return ["--dangerously-skip-permissions"];
  }
}

/**
 * The spawn command (§4.7): the NDJSON input loop with its required
 * stream output, slash commands off (prompt text is prompt text), then
 * the autonomy flags, model, and effort — every value flag in the `=`
 * form 1.2.14 pre-parsing demands — and the resumed conversation last,
 * mirroring the claude family's resume-first discipline as closely as
 * agy's flag grammar allows. No `--print`: stdin drives the turns.
 */
export function buildAgySessionCommand(command: AgySessionCommand): string[] {
  const argv = [
    "agy",
    "--disable-slash-commands",
    "--input-format=stream-json",
    "--output-format=stream-json",
  ];
  argv.push(...agySessionAutonomyFlags(command.autonomy));
  if (command.model !== undefined) {
    argv.push(`--model=${command.model}`);
  }
  if (command.effort !== undefined) {
    argv.push(`--effort=${command.effort}`);
  }
  if (command.resumeConversationId !== undefined) {
    argv.push(`--conversation=${command.resumeConversationId}`);
  }
  return argv;
}

export { buildHarnessUserMessage as buildAgyUserMessage } from "./claude-session.js";

/** What one agy output line resolves to. The driver owns the FSM; these
 * are the parser's facts. */
export type AgyParse =
  | {
      kind: "result";
      /** The conversation the frame names, or null when it names none
       * (the auth-failure fixture carries an empty id). */
      conversationId: string | null;
      isError: boolean;
      status: string;
      errorText: string | null;
      /** The envelope's response text when it is a non-empty string;
       * otherwise null and no assistant_message is emitted. */
      responseText: string | null;
      usage: ResultUsageBlock;
    }
  | { kind: "unknown" }
  | { kind: "grammar_error"; message: string }
  | { kind: "unusable"; excerpt: string; bytes: number };

export interface AgyParseContext {
  /** The conversation id the session already adopted, or null before the
   * first usable result names one. A frame naming a different id is the
   * wrong-conversation defect (tier 2). */
  knownConversationId: string | null;
}

/**
 * Parse one agy stream-json output line under the §4.2 tiers. Never
 * throws: a line that is not a JSON object is `unusable` (tier 3, the
 * driver's fatal — the process layer reports non-UTF-8 and oversize
 * before this runs), a JSON object whose `event` name is not `result` is
 * `unknown` (tier 1, raw preserved by the driver), and a result frame
 * that breaks the grammar — no `event` name, no result object, an
 * envelope with no status or a status-less success, or a conversation id
 * that is not the one the session adopted — is a `grammar_error` (tier
 * 2). The envelope's own status/response/error/usage contract and usage
 * arithmetic are the run path's parser (parseAgyResultEnvelope), reused
 * verbatim so the two surfaces cannot disagree about what a result is.
 */
export function parseAgySessionLine(
  line: string,
  context: AgyParseContext
): AgyParse {
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
  const eventName = event["event"];
  if (typeof eventName !== "string" || eventName === "") {
    return { kind: "grammar_error", message: "a frame carries no event name" };
  }
  if (eventName !== "result") {
    return { kind: "unknown" };
  }
  const inner = event["result"];
  if (typeof inner !== "object" || inner === null || Array.isArray(inner)) {
    return {
      kind: "grammar_error",
      message: "the result frame carries no result object",
    };
  }
  const envelopeRecord = inner as Record<string, unknown>;
  const conversationId = readConversationId(envelopeRecord);
  // The id becomes the registry key and the `--resume` argument, so it
  // must be one `--resume` accepts (review live16).
  if (conversationId !== null && !AGY_CONVERSATION_ID_PATTERN.test(conversationId)) {
    return { kind: "grammar_error", message: "a result names an invalid conversation id" };
  }
  if (
    context.knownConversationId !== null &&
    conversationId !== null &&
    conversationId !== context.knownConversationId
  ) {
    return {
      kind: "grammar_error",
      message:
        `a result names conversation ${conversationId}, ` +
        `not ${context.knownConversationId}`,
    };
  }
  const envelope = parseAgyResultEnvelope(JSON.stringify(inner));
  if (envelope === null) {
    return {
      kind: "grammar_error",
      message:
        "the result frame carries no usable envelope " +
        "(no status, or a success without response text)",
    };
  }
  const response = envelopeRecord["response"];
  return {
    kind: "result",
    conversationId,
    isError: envelope.isError,
    status: envelope.status,
    errorText: envelope.errorText,
    responseText: typeof response === "string" && response !== "" ? response : null,
    usage: envelope.usage,
  };
}

function readConversationId(inner: Record<string, unknown>): string | null {
  const id = inner["conversation_id"];
  return typeof id === "string" && id !== "" ? id : null;
}

