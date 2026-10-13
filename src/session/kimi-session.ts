/**
 * The kimi session wiring: the per-turn spawn command over kimi's own
 * session store, the honest capability matrix, and the stream-json line
 * parser under the three tiers. Pure functions only — all live state
 * lives in the launcher-owned driver (src/session/kimi-driver.ts).
 *
 * Wire facts pinned against the installed 0.31.1 binary (the run
 * adapter, src/adapters/kimi.ts, pins the flag surface; the facts below
 * come from the binary's bundled sources):
 *
 * - `--prompt` runs one exchange headlessly and `--output-format
 *   stream-json` switches its stdout to JSON lines; the two combine
 *   freely (only `--agent`/`--agent-file` conflict with `--session`).
 * - The prompt is an argv value (no stdin transport), so the run path's
 *   32 KiB argv bound is the per-turn cap.
 * - `--session <id>` (the `-r` alias the resume hint names) resumes
 *   kimi's own on-disk session store, refusing an unknown id or one
 *   recorded under a different working directory; the store keys
 *   sessions as `session_<uuid>` under `~/.kimi-code/sessions/`.
 * - The writer (PromptJsonWriter) emits `{role:"assistant",content,
 *   tool_calls:[{type:"function",id,function:{name,arguments}}]}` with
 *   either side dropped when empty — never both — flushed before each
 *   tool result and at the turn's end; `{role:"tool",tool_call_id,
 *   content}` for results; `{role:"meta",type:"turn.step.retrying",…}`
 *   and `{role:"meta",type:"system.version",…}` as informational meta;
 *   and, after every turn that completes, `{role:"meta",
 *   type:"session.resume_hint",session_id,command,content}` — the one
 *   line that names the session, so a fresh session's identity is
 *   deferred to it (the agy/opencode model). A turn that throws exits
 *   before its hint (runPrompt runs the turn body, then the hint write —
 *   read from the source, not live-verified), so the hint follows only
 *   completed turns.
 * - Headless kimi auto-approves every tool call and answers no question
 *   (installHeadlessHandlers), and fresh sessions are created with
 *   permission "auto": there is no permission round-trip to relay, and
 *   the autonomy ceiling rides the scode boundary exactly as the run
 *   path documents. The autonomy flags (--plan/--yolo/--auto) are
 *   refused with --prompt, so the per-turn command carries none.
 * - The headless path dispatches exactly one command: a `/goal` create
 *   (parseHeadlessGoalCreate, `GOAL_PREFIX = /^\/goal(\s|$)/` on the
 *   trimmed prompt; the create spellings are `/goal <objective>` and
 *   `/goal replace [--] <objective>`, run with their own exit codes
 *   0/3/6 and a goal-summary line). The goal subcommands (`/goal` bare,
 *   status, pause, resume, cancel, next) are not creates and fall
 *   through to the model as prompt text, and so does every other
 *   prompt: the other slash commands and the `!` shell escape are
 *   interactive-TUI dispatch only (the REPL's bash input mode, never
 *   the `-p` path — both headless entry points, runPrompt and its v2
 *   twin, parse only goal-creates before sending the prompt as the
 *   turn's user message). codemux refuses the word-bounded `/goal`
 *   name and the `!` shape — kimiPromptIsCommand below states the
 *   rule.
 * - No usage appears on the wire at all: usage is all-null on every
 *   event, the honest null.
 */

import { unusableFacts } from "./process.js";
import type { SessionCapabilities } from "./protocol.js";

/** The session-only version floor (§4.3): 0.31.1, the audited build
 * whose stream-json line shapes, `--session` resume, and resume hint
 * the parser and command are pinned against. */
export const KIMI_SESSION_FLOOR = "0.31.1";

/** The id shape `--session` accepts: `session_` plus a lowercase UUID —
 * the ids kimi's own store mints (verified on disk against 0.31.1:
 * session_index.jsonl keys and the session_<uuid> directories under
 * sessions/). */
export const KIMI_SESSION_ID_PATTERN =
  /^session_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Capability flags for kimi sessions (§3.4): live input yes (one caller
 * input, one kimi process), everything else the wire cannot carry no —
 * there is no steering or interrupt channel into a one-shot process
 * (its signal handlers self-exit 130/129/143 without answering), no
 * permission round-trip (headless kimi auto-approves), no deltas (each
 * assistant line is a complete message), no file-change frames, no
 * usage at all. Resume yes through kimi's own store, registry-vouched.
 */
export function kimiSessionCapabilities(): SessionCapabilities {
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
 * Whether codemux refuses this text as a kimi command shape rather than
 * sending it as model prompt text (round al17; the al11 rule refused
 * every `/`- or `!`-leading prompt, and the correctness review caught
 * what that costs: `/tmp/notes.md please summarize` — an ordinary
 * path-like prompt — exited 64). The rule comes from the installed
 * 0.31.1 binary, both headless entry points included: runPrompt and its
 * v2 twin parse ONLY goal-creates before the turn
 * (`parseHeadlessGoalCreate`, `GOAL_PREFIX = /^\/goal(\s|$)/` on the
 * trimmed prompt), so a `/goal <objective>` (or `/goal replace …`)
 * create is dispatched as the goal flow with its own exit codes and
 * never reaches the model,
 * while every other prompt — any other slash command, a path, `! …` —
 * is sent to the model as the turn's user message unchanged. Refused
 * exactly:
 *
 * - the word-bounded `/goal` name, kimi's own prefix test verbatim
 *   (`/goal` followed by whitespace or end, after trimming). 0.31.1
 *   sends the non-create subcommand spellings (`/goal` bare, `status`,
 *   `pause`, …) to the model, but they are the same command's grammar,
 *   and which spellings dispatch has already changed once — the whole
 *   name is the stable boundary;
 * - the `!` shape. 0.31.1 sends `! …` to the model too (verified live
 *   this round through `./bin/codemux run -a kimi`), but `!` is kimi's
 *   interactive shell escape, and a version that dispatches it
 *   headlessly would run a shell line no autonomy flag bounds — the
 *   aider rule (review D10, security): the autonomy a session records
 *   is meant to bound what caller text can do, and a dispatch the
 *   record cannot see would only hide the intent.
 *
 * Both paths refuse the shape before anything launches — the run
 * adapter in validateRunRequest (round al11) and the session driver
 * before the ack. Judged on harness text, after the author prefix — a
 * `[author] …` prefix sits ahead of the shape and neutralizes it (runs
 * carry no author prefix, so the raw prompt is the harness text there).
 */
export function kimiPromptIsCommand(text: string): boolean {
  const trimmed = text.trimStart();
  return trimmed.startsWith("!") || /^\/goal(\s|$)/.test(trimmed);
}

export interface KimiSessionCommand {
  /** The `--model` value. Never set under a provider override: the
   * synthesized `KIMI_MODEL_*` provider is the default model, and
   * `--model` names a config alias that outranks it (the run adapter's
   * rule). */
  model?: string;
  /** The native session id to resume, or undefined to start fresh
   * (kimi mints the id; the driver adopts it from the resume hint). */
  resumeSessionId?: string;
  /** The turn's prompt (the `--prompt` value, author prefix applied). */
  prompt: string;
}

/**
 * The per-turn spawn command: the model when one applies, `--session`
 * for every turn after the first (the id the first turn's resume hint
 * named), stream-json output, and the prompt as the argv tail — the run
 * adapter's flag order, so session turns and runs cannot drift. No
 * autonomy flags: kimi refuses them with `--prompt` (0.31.1), and the
 * level rides the scode boundary, exactly as headless runs document.
 */
export function buildKimiSessionCommand(command: KimiSessionCommand): string[] {
  const argv = ["kimi"];
  if (command.model !== undefined) {
    argv.push("--model", command.model);
  }
  if (command.resumeSessionId !== undefined) {
    argv.push("--session", command.resumeSessionId);
  }
  argv.push("--output-format", "stream-json");
  argv.push("--prompt", command.prompt);
  return argv;
}

/** What one stream-json output line resolves to. The driver owns the
 * FSM; these are the parser's facts. */
export type KimiParse =
  | {
      kind: "assistant";
      /** The message's text, or null when the line only calls tools. */
      text: string | null;
      toolCalls: { callId: string; name: string; input: unknown }[];
    }
  | { kind: "tool_result"; callId: string; output: unknown }
  | { kind: "resume_hint"; sessionId: string }
  | { kind: "unknown" }
  | {
      kind: "grammar_error";
      message: string;
      /** Set by the one grammar error that proves the harness ran a
       * session other than the one codemux resumed — a hint naming a
       * foreign id (round al11's re-review, edges 3): the driver reads it
       * to withdraw the resumable verdict a matching hint had earned,
       * for the store that answered is not the store the record names. */
      wrongSession?: { named: string; known: string };
    }
  | { kind: "unusable"; excerpt: string; bytes: number };

export interface KimiParseContext {
  /** The session id once adopted (a fresh session's first resume hint,
   * or the registry-vouched resume id); null before that. A hint naming
   * a different session is the wrong-session defect (tier 2). */
  knownSessionId: string | null;
}

/**
 * Parse one `--output-format stream-json` output line under the §4.2
 * tiers. Never throws: a line that is not a JSON object is `unusable`
 * (tier 3, the driver's fatal), a line that claims a mapped shape but
 * breaks its contract — an assistant line with neither content nor tool
 * calls, a tool line with no call id, a resume hint with a malformed or
 * mismatched session id — is a `grammar_error` (tier 2), and a shape
 * codemux does not map (the retrying and version meta lines, anything
 * newer) is `unknown` (tier 1, raw preserved by the driver).
 */
export function parseKimiStreamLine(
  line: string,
  context: KimiParseContext
): KimiParse {
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
  switch (event["role"]) {
    case "assistant":
      return parseAssistantLine(event);
    case "tool":
      return parseToolLine(event);
    case "meta":
      return parseMetaLine(event, context);
    default:
      // No role or an unrecognized one: nothing codemux maps, but the
      // line is well-formed JSON — tier 1, raw preserved.
      return { kind: "unknown" };
  }
}

/** `{role:"assistant", content?, tool_calls?}` with either side present
 * — the writer's flushAssistant drops an empty message entirely, so a
 * line with neither breaks the pin, and content the writer would have
 * dropped (present but empty, or not a string at all) breaks it too,
 * tool calls or not (round al13). A tool call is exactly
 * `{type:"function", id, function:{name, arguments}}` — `type` present
 * and function, `id` non-empty, `name` non-empty, and `arguments` a
 * JSON STRING (missing or non-string breaks the pin; round al14): the
 * mapped input is the parsed value, or the raw string when it does not
 * parse (never guessed), so `input` is never `undefined`. */
function parseAssistantLine(event: Record<string, unknown>): KimiParse {
  // The writer drops an empty content entirely (flushAssistant passes
  // void 0), so a present-but-invalid content — empty, null, a number,
  // an object — breaks the pin whatever else the line carries: nulled
  // silently, it let valid tool calls carry a line whose malformed
  // content was dropped on the floor while the turn counted as answered
  // (round al13, edges 2). Absent content is the tool-calls-only
  // spelling the writer emits.
  const rawText = event["content"];
  if (
    rawText !== undefined &&
    (typeof rawText !== "string" || rawText.length === 0)
  ) {
    return {
      kind: "grammar_error",
      message: "an assistant line carries a present-but-invalid content",
    };
  }
  const text = typeof rawText === "string" ? rawText : null;
  const rawCalls = event["tool_calls"];
  // An empty tool_calls array is no calls — the writer emits the field
  // only with entries to flush, so `[]` breaks the pin exactly like its
  // absence and must not slip the line past the neither-nor check (round
  // al11's re-review, correctness 2: `{role:"assistant",tool_calls:[]}`
  // passed as a completed turn with no message and no calls).
  const noCalls =
    rawCalls === undefined || (Array.isArray(rawCalls) && rawCalls.length === 0);
  if (text === null && noCalls) {
    return {
      kind: "grammar_error",
      message: "an assistant line carries neither content nor tool calls",
    };
  }
  const toolCalls: { callId: string; name: string; input: unknown }[] = [];
  if (rawCalls !== undefined) {
    if (!Array.isArray(rawCalls)) {
      return {
        kind: "grammar_error",
        message: "an assistant line carries a non-array tool_calls",
      };
    }
    for (const raw of rawCalls) {
      if (typeof raw !== "object" || raw === null) {
        return {
          kind: "grammar_error",
          message: "an assistant line carries a malformed tool call",
        };
      }
      const call = raw as Record<string, unknown>;
      const fn = call["function"];
      const id = call["id"];
      // The writer's exact spelling is
      // {type:"function",id,function:{name,arguments}} — every piece
      // pinned, round al14: before this, an empty name passed, `type`
      // went unchecked, and `arguments` could be missing or non-string,
      // which handed the event layer an `input` of `undefined` whose
      // serialization drops the required `input` field while the turn
      // still completed `end`.
      if (
        typeof id !== "string" ||
        id === "" ||
        call["type"] !== "function" ||
        typeof fn !== "object" ||
        fn === null
      ) {
        return {
          kind: "grammar_error",
          message: "an assistant line carries a tool call that is not a function call",
        };
      }
      const function_ = fn as Record<string, unknown>;
      const name = function_["name"];
      if (typeof name !== "string" || name === "") {
        return {
          kind: "grammar_error",
          message: "an assistant line carries a tool call with no name",
        };
      }
      const arguments_ = function_["arguments"];
      if (typeof arguments_ !== "string") {
        return {
          kind: "grammar_error",
          message: "an assistant line carries a tool call without string arguments",
        };
      }
      toolCalls.push({ callId: id, name, input: parseToolArguments(arguments_) });
    }
  }
  return { kind: "assistant", text, toolCalls };
}

function parseToolArguments(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/** `{role:"tool", tool_call_id, content}` — the writer stringifies the
 * output into `content`, so a result whose content is missing or not a
 * string breaks the pin: accepted, it emitted a tool_result with no
 * `output` field at all, a valid-looking event with its payload missing
 * (round al13, edges 3). The wire carries no error marker for a tool
 * result, so none is invented. */
function parseToolLine(event: Record<string, unknown>): KimiParse {
  const callId = event["tool_call_id"];
  if (typeof callId !== "string" || callId === "") {
    return {
      kind: "grammar_error",
      message: "a tool line carries no tool_call_id",
    };
  }
  const content = event["content"];
  if (typeof content !== "string") {
    return {
      kind: "grammar_error",
      message: "a tool line carries no string content",
    };
  }
  return { kind: "tool_result", callId, output: content };
}

/** Only the resume hint names the session. Its pinned shape is
 * `{role:"meta",type:"session.resume_hint",session_id,command,content}`
 * — the writer (PromptJsonWriter) emits all five fields, with
 * `command` exactly `kimi -r <session_id>` and `content` exactly
 * `To resume this session: kimi -r <session_id>` — so the hint is
 * confirmed only when the whole shape parses: the session_id must be a
 * well-formed kimi id and — once the session adopted one — the one it
 * adopted; the command must be the pinned spelling FOR THE SESSION THE
 * HINT NAMES (round al30, rule 4, edges minor: any non-empty command
 * passed before, so a hint naming session A with a command naming
 * session B confirmed A); and the note must be the writer's pinned
 * line itself, exactly — which a wrapped, reworded, or negated note
 * ("DO NOT run kimi -r …") cannot be (round al33, edges minor: the
 * note passed on a substring, so a negation of the command confirmed
 * the session). The informational meta lines
 * (retrying, version) and any new type are tier 1. */
function parseMetaLine(
  event: Record<string, unknown>,
  context: KimiParseContext
): KimiParse {
  if (event["type"] !== "session.resume_hint") {
    return { kind: "unknown" };
  }
  const sessionId = event["session_id"];
  if (typeof sessionId !== "string" || !KIMI_SESSION_ID_PATTERN.test(sessionId)) {
    return {
      kind: "grammar_error",
      message: "a resume hint carries an invalid session id",
    };
  }
  if (context.knownSessionId !== null && sessionId !== context.knownSessionId) {
    return {
      kind: "grammar_error",
      message: `a resume hint names session ${sessionId}, not ${context.knownSessionId}`,
      wrongSession: { named: sessionId, known: context.knownSessionId },
    };
  }
  const resumeCommand = `kimi -r ${sessionId}`;
  const command = event["command"];
  if (command !== resumeCommand) {
    return {
      kind: "grammar_error",
      message:
        "a resume hint command does not match the pinned " +
        `"kimi -r <session_id>" spelling for the session it names`,
    };
  }
  const content = event["content"];
  if (content !== `To resume this session: ${resumeCommand}`) {
    return {
      kind: "grammar_error",
      message:
        "a resume hint note is not the pinned writer line " +
        `"To resume this session: kimi -r <session_id>" for the session it names`,
    };
  }
  return { kind: "resume_hint", sessionId };
}
