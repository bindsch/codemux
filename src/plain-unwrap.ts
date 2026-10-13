/**
 * The plain-run unwrap: adapters that can report usage launch their harness
 * in its structured mode even without `--result-json` (claude/zai's
 * `--output-format json`, agy's `--output-format=json`, opencode's
 * `--format json`, codex's `--json`), and these functions turn the
 * structured stdout back into the plain reply so `codemux run` stdout keeps
 * its contract — the model's final message and nothing else — while the
 * run's usage and served model are recorded on the RunResult for the call
 * ledger. opencode's `--format json` and codex's `--json` streams carry the
 * same volume (every tool's output rides the event lines), so their plain
 * runs stream instead of buffering: the launcher feeds each chunk to a
 * fold (OpenCodePlainFold, CodexPlainFold) that keeps only the reply text,
 * the folded usage, and the break notes — tool output is dropped as it
 * arrives — and the capture bound measures that residue, never the raw
 * stream (review ul4).
 *
 * The unwrap reproduces plain-text mode byte for byte: the result text
 * verbatim, plus one trailing newline when the text is non-empty and lacks
 * one — codex excepted below, whose pinned printer appends its newline
 * unconditionally. opencode's reply is spelled the way its run command's
 * plain mode
 * prints it (verified against upstream v1.18.18, scratch/upstream-run.ts):
 * each completed text part trimmed, empty parts skipped, one newline after
 * every part — the banner, tool lines, and errors all go to stderr there,
 * so stdout is the parts and nothing else. codex's is the final assistant
 * message its human mode prints (`final_message_from_turn_items` picks the
 * last AgentMessage, and a failed turn's is discarded — the stream
 * reduction in result-envelope.ts applies the same rules): the message of
 * a completed turn stays on stdout even when codex itself exits nonzero,
 * and a turn that never completed prints nothing (round al5). The message
 * prints verbatim plus exactly one trailing newline, always — the pinned
 * human processor's `println!` (rust-v0.160.1), which appends it whatever
 * the message ends with, an empty-text or whitespace-only one included
 * (round al11; al10 had emptied those). A completed turn with no message
 * anywhere succeeds with empty stdout (round al10): human mode exits 0 for
 * that turn (`final_message` was `None` and no line was written). The one
 * bounded exception consults the `--output-last-message` file the launch
 * named (round al29, replacing al28's no-file-at-all rule): when the
 * stream completed a turn with no agent_message — a Plan-only turn, the
 * one item the JSONL wire does not carry — and only then, the recorded
 * final message is the reply (CodexPlanFallbackRead below: text answers
 * with the fallback note, an empty file confirms the messageless turn
 * with no note, a missing file fails the run naming the unwritten file
 * (round al34, edges major 2 — it was the reply's only carrier), and an
 * unreadable file fails the run with its read error). No other path
 * touches the file, so it can never contradict a stream that carried the
 * reply — the al28 defect this restates the guard against.
 * Stdout that is not the structured output the launch asked for — an older
 * binary, a wrapper that strips the flag, a fake in a test — passes
 * through verbatim with the run unchanged: no usage is recorded, except
 * on codex's hatch, whose blended `tokens used` stderr figure becomes the
 * run's usage (codexPlainResult) — the escape hatch that keeps every
 * binary codemux did not structure its output for working. The opencode
 * and claude-family/agy hatches open only when nothing on stdout is the
 * wire: one broken line among wire lines (opencode, where a timeout can
 * cut the last write mid-line) or a stdout that parses as JSON or opens
 * like the envelope but is not it (the claude family and agy, where the
 * envelope is one write a kill can halve — any JSON value, an array
 * included, not only a leading `{`; review ul7) is a structured stream
 * that broke, not a plain reply — the text and usage folded so far stay,
 * and the break becomes a codemux diagnostic on stderr (review ul3).
 * Codex's hatch is decided once per stream, by the FIRST non-empty line
 * (round al30, rule 3): the launch always passes `--json`, and a binary
 * that honored it prints `thread.started` as the first non-empty line of
 * the stream, so that line — parsed as exactly that event — commits the
 * whole stream to the wire, and any other first non-empty line commits it
 * to human mode: verbatim passthrough for the stream's whole length, with
 * nothing later flipping it however event-like a line looks — a fenced
 * example quoting a stream's events, JSON quoted inside the reply (the
 * round's correctness major: a reply whose code block quoted
 * thread.started/turn.started/turn.failed was reduced as a failed stream
 * and turned exit 0 into 1). When the structured output IS recognized,
 * the same verdict rules as the envelope path apply: an error result or a
 * result with no text fails the run
 * (README: "An empty result is a failed run on every path, plain or
 * structured") — the one exception is codex's completed messageless turn,
 * which succeeds exactly as human mode exited 0 for it (round al10, the
 * header's codex paragraph above): empty text means empty stdout, and a
 * whitespace-only message is messageless the same way but keeps its own
 * bytes on stdout verbatim plus the one trailing newline (round al11) —
 * so that arm's stdout is NOT empty (`" \n"` for a message of one
 * space). `messagelessCompletedTurnSucceeds` drops the whole empty and
 * whitespace arm of the shared verdict (codexStreamVerdict,
 * result-envelope.ts), which is how both spellings reach success here. A
 * failed run keeps
 * the harness's own text on stdout — the
 * error envelope's `result` or `response`, the text opencode streamed
 * before its error line — exactly what plain mode would have printed; the
 * structured wire itself never reaches stdout, failed or not.
 */

import {
  appendDiagnostic,
  emptyUsage,
  parseAgyResultEnvelope,
  parseClaudeResultEnvelope,
  CodexEventReducer,
  CODEX_FINAL_MESSAGE_FALLBACK_NOTE,
  codexStreamVerdict,
  codexWarningNote,
  codexWarningNoteBytes,
} from "./result-envelope.js";
import { MAX_CAPTURE_BYTES, type StdoutSink } from "./process-runner.js";
import { parseOpenCodeRunLine } from "./session/opencode-session.js";
import { accumulateUsage } from "./session/usage.js";
import type { AgentId, ResultUsageBlock, RunResult } from "./types.js";

/** The plain-text spelling of a structured result: verbatim, plus one
 * trailing newline when non-empty and lacking one; empty stays empty. */
function plainText(text: string): string {
  if (text.length === 0 || text.endsWith("\n")) return text;
  return `${text}\n`;
}

/** The plain-text spelling of a codex reply: the final message verbatim
 * plus exactly one trailing newline, always. The pinned human processor
 * prints the message with `println!("{message}")` (rust-v0.160.1,
 * event_processor_with_human_output.rs), which appends a newline whatever
 * the message ends with — a message already ending in one prints two, and
 * an empty-text or whitespace-only agent_message prints its bytes and the
 * newline (round al11, correcting al10's emptied spelling); a turn with
 * no message at all prints nothing, for `final_message` was `None` and no
 * line was written. */
function codexPlainReply(message: string): string {
  return `${message}\n`;
}

/** What reading the `--output-last-message` file a plain codex run named
 * produced, in the ONE bounded case the plain verdict consults it (round
 * al29): `text` is a named file read and holding the recorded message
 * (verbatim, whatever it ends with — an empty file is this same outcome
 * with empty text, upstream's own messageless-turn record); `missing` is
 * a named file that is not there (round al34, edges major 2: the file
 * was the messageless turn's only carrier, so its absence is an upstream
 * write failure and fails the run, never an empty success); `unreadable`
 * is a file the read refused (a permission error, a refused symlink).
 * The launch reads the file before the verdict runs (the read-and-remove
 * rule; codex.ts) and hands the outcome over as a thunk, so the verdict's
 * read is bounded to the single arm that needs it: a turn that completed
 * with no agent_message anywhere — the Plan-only turn, the one item the
 * JSONL wire does not carry. A launch that named no file passes no thunk
 * at all — that absence, not this type's `missing`, is the no-fallback
 * shape that keeps the empty success of round al10. No other arm
 * consults the thunk, so no other path can let the file contradict the
 * stream. */
export type CodexPlanFallbackRead =
  | { outcome: "text"; text: string }
  | { outcome: "missing"; path: string }
  | { outcome: "unreadable"; error: string };

/** UTF-8 size in bytes — the unit the capture bound is stated in, so the
 * fold's keptBytes and the whole-capture path's bytesRead measure one and
 * the same thing (review ul6). */
const byteLength = (text: string): number => Buffer.byteLength(text);

/** The longest prefix of `text` whose UTF-8 encoding fits in `maxBytes`,
 * backing off any multibyte sequence the cut would split (round al31): the
 * prefix an oversized human-mode line is accounted with must stay
 * decodable — it becomes the partial output a capture-limit failure
 * reports, and a string the encoding cannot spell is no output at all. */
function utf8BytePrefix(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  const bytes = Buffer.from(text, "utf8");
  if (bytes.byteLength <= maxBytes) return text;
  let end = maxBytes;
  // A continuation byte is 0b10xxxxxx: walk back while the cut lands
  // inside a multibyte sequence, so the prefix ends on a boundary.
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString("utf8");
}

/** A bounded one-line excerpt of broken structured output for a stderr
 * diagnostic: whitespace flattened, so the line names the break without
 * carrying the wire anywhere. */
function diagnosticExcerpt(text: string): string {
  const flat = text.trim().replace(/\s+/g, " ");
  return flat.length <= 80 ? flat : `${flat.slice(0, 80)}…`;
}

function failed(result: RunResult, diagnostic: string, stdout = result.stdout): RunResult {
  return {
    ...result,
    stdout,
    stderr: appendDiagnostic(result.stderr, diagnostic),
    exitCode: result.exitCode === 0 ? 1 : result.exitCode,
    success: false,
  };
}

/** Stdout that is JSON — any complete value — or `{`-shaped stdout the
 * parser cannot take carries the structured stream's grammar: these
 * launches asked for JSON output, so JSON that is not the envelope is a
 * stream that broke, never a plain reply, and a truncated `{` is the
 * envelope's own shape cut mid-write. The line is JSON, not a leading
 * bracket: text that opens with `[` without being JSON (an argv echo like
 * `[--safe-mode][--tools][]`) is not the wire's grammar and keeps the
 * hatch. A leading-`{`-only check let a JSON array pass through as the
 * reply with no usage (review ul7). */
function jsonShapedStdout(stdout: string): boolean {
  if (stdout.trimStart().startsWith("{")) return true;
  try {
    JSON.parse(stdout);
    return true;
  } catch {
    return false;
  }
}

/**
 * claude/zai: stdout should be the single JSON result envelope
 * `--output-format json` prints. Stdout no binary asked for that format
 * would print — plain text that is not JSON — passes through verbatim.
 * JSON that is not a parseable envelope never does: any complete JSON
 * value that is not it (an array, a scalar, an unrecognized object), and
 * an object a kill or the capture cap cut mid-write, both fail the run
 * with the break on stderr and nothing on stdout — the wire is never the
 * reply (reviews ul3, ul7).
 */
export function claudeFamilyPlainResult(result: RunResult, agent: AgentId): RunResult {
  const parsed = parseClaudeResultEnvelope(result.stdout);
  if (parsed === null) {
    if (!jsonShapedStdout(result.stdout)) return result;
    return failed(
      result,
      `codemux: ${agent} printed JSON-shaped stdout that is not a result ` +
        `envelope (truncated or unrecognized), so this run fails rather than ` +
        `pass it through as the reply: ${diagnosticExcerpt(result.stdout)}`,
      ""
    );
  }
  const base = {
    usage: parsed.usage,
    servedModel: parsed.multipleModels ? null : parsed.servedModel,
  };
  if (parsed.isError) {
    const reason =
      parsed.errorSubtype !== null
        ? `subtype "${parsed.errorSubtype}"`
        : "is_error: true";
    // An error envelope still carries its `result` text — the error text
    // plain mode would have printed — so stdout shows that, never the
    // JSON wire the structured launch produced (review ul2).
    const errorText =
      typeof parsed.envelope.result === "string" && parsed.envelope.result.trim() !== ""
        ? parsed.envelope.result
        : "";
    return {
      ...failed(
        result,
        `codemux: ${agent} reported an error result (${reason}), ` +
          `so this run fails even though the harness exited ${result.exitCode}`,
        plainText(errorText)
      ),
      ...base,
    };
  }
  if (typeof parsed.envelope.result !== "string" || parsed.envelope.result.trim() === "") {
    return {
      ...failed(
        result,
        `codemux: ${agent} printed an envelope with no result text, ` +
          "so this run reports no result",
        ""
      ),
      ...base,
    };
  }
  return { ...result, stdout: plainText(parsed.envelope.result), ...base };
}

/**
 * agy: stdout should be the `--output-format=json` result object. Anything
 * that is not JSON passes through verbatim — except JSON that is not the
 * envelope: the envelope is one JSON object, so a JSON value the parser
 * cannot take (an array or a scalar, a complete but unrecognized object,
 * or an object a kill or the capture cap cut mid-write) is a structured
 * result that broke, not a plain reply, and fails the run with nothing on
 * stdout — the claude family's rule (reviews ul4, ul7).
 */
export function agyPlainResult(result: RunResult): RunResult {
  const parsed = parseAgyResultEnvelope(result.stdout);
  if (parsed === null) {
    if (!jsonShapedStdout(result.stdout)) return result;
    return failed(
      result,
      `codemux: agy printed JSON-shaped stdout that is not a result ` +
        `envelope (truncated or unrecognized), so this run fails rather than ` +
        `pass it through as the reply: ${diagnosticExcerpt(result.stdout)}`,
      ""
    );
  }
  const base = { usage: parsed.usage, servedModel: null };
  if (parsed.isError) {
    const reason =
      parsed.errorText !== null
        ? `status "${parsed.status}": ${parsed.errorText}`
        : `status "${parsed.status}"`;
    // The response text is what plain mode would have printed; an error
    // envelope that carries none prints nothing. The wire never leaks
    // (review ul2).
    const errorText =
      typeof parsed.envelope.response === "string" && parsed.envelope.response.trim() !== ""
        ? parsed.envelope.response
        : "";
    return {
      ...failed(
        result,
        `codemux: agy reported an error result (${reason}), ` +
          `so this run fails even though the harness exited ${result.exitCode}`,
        plainText(errorText)
      ),
      ...base,
    };
  }
  const response =
    typeof parsed.envelope.response === "string" ? parsed.envelope.response : "";
  if (response.trim() === "") {
    return {
      ...failed(
        result,
        "codemux: agy printed an envelope with no result text, " +
          "so this run reports no result",
        ""
      ),
      ...base,
    };
  }
  return { ...result, stdout: plainText(response), ...base };
}

// Codex's human exec mode prints its token figure on stderr as two lines
// after the run — "tokens used", then the total with locale digit
// separators (print_final_output, codex-rs's human event processor). The
// label is styled when the terminal supports it, so escape codes are
// stripped before matching; the scan runs from the end so harness chatter
// containing the phrase cannot shadow the real one. The number is blended:
// (input − cached) + output, which cannot be split back apart, so it lands
// in total_tokens alone.
const ANSI_ESCAPE = /\x1b\[[0-9;?]*[A-Za-z]/g;
// Locale digit separators the formatter can emit: comma, period,
// apostrophe (the right single quote in some locales), and space-like
// characters including no-break and narrow no-break spaces.
const SEPARATED_NUMBER = /^[.,''’\s   \d]+$/;

/**
 * Extracts codex's token total from a plain run's captured stderr, or null
 * when the figure is absent or not a separated number (then no usage is
 * recorded).
 */
export function parseCodexTokenTotal(stderr: string): number | null {
  const lines = stderr.replace(ANSI_ESCAPE, "").split(/\r?\n/);
  let label = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i]!.trim() === "tokens used") {
      label = i;
      break;
    }
  }
  if (label === -1) return null;
  for (let j = label + 1; j < lines.length; j++) {
    const line = lines[j]!.trim();
    if (line === "") continue;
    if (!SEPARATED_NUMBER.test(line) || !/\d/.test(line)) return null;
    const value = Number(line.replace(/\D/g, ""));
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  }
  return null;
}

/**
 * codex, escape-hatch shape: a plain run now launches `--json` and streams
 * through CodexPlainFold below, so this function is what a hatch run — a
 * binary that ignored the flag and printed human mode anyway — gets. Its
 * stdout passes through verbatim exactly as plain runs always did, and the
 * one blended `tokens used` figure human mode reports on stderr becomes
 * the run's usage, total_tokens alone with every other field null, because
 * it is (input − cached) + output and the parts cannot be recovered. A
 * stderr without the figure records no usage.
 */
export function codexPlainResult(result: RunResult): RunResult {
  const total = parseCodexTokenTotal(result.stderr);
  if (total === null) return result;
  return {
    ...result,
    usage: { ...emptyUsage(), total_tokens: total },
    servedModel: null,
  };
}

/** What the opencode wire fold keeps as the lines arrive: the reply spelled
 * as plain mode prints it, the folded `step_finish` usage, the first error,
 * and the notes for lines that were not the wire — the first two notes and
 * a count of the rest, everything the verdict ever prints, so a stream of
 * noise cannot grow the residue (review ul5). One shape shared by the
 * whole-capture unwrap and the streaming sink below, so the two paths
 * cannot drift (review ul4). */
interface OpenCodeFoldState {
  sawWire: boolean;
  text: string;
  /** UTF-8 bytes of `text`, maintained as it grows: keptBytes reads a
   * running total instead of re-measuring a string that grows with every
   * text line, because the runner asks after every chunk (review ul7). */
  textBytes: number;
  usage: ResultUsageBlock | null;
  errorMessage: string | null;
  /** At most the first two notes; `brokenCount` carries the total. */
  broken: string[];
  /** UTF-8 bytes of the kept `broken` notes, maintained with them
   * (review ul7). */
  brokenBytes: number;
  brokenCount: number;
}

/** Records one line that was not the wire: the verdict prints only the
 * first two reasons and a count, so only those are kept — the notes stay
 * bounded residue the capture bound can measure (review ul5). */
function noteOpenCodeBreak(state: OpenCodeFoldState, note: string): void {
  state.brokenCount++;
  if (state.broken.length < 2) {
    state.broken.push(note);
    state.brokenBytes += byteLength(note);
  }
}

function foldOpenCodeLine(line: string, state: OpenCodeFoldState): void {
  const parse = parseOpenCodeRunLine(line, { knownSessionId: null });
  switch (parse.kind) {
    case "unusable":
      noteOpenCodeBreak(state, `an unparseable line of ${parse.bytes} bytes`);
      break;
    case "grammar_error":
      noteOpenCodeBreak(state, parse.message);
      break;
    case "text": {
      state.sawWire = true;
      const printed = parse.text.trim();
      if (printed !== "") {
        state.text += `${printed}\n`;
        state.textBytes += byteLength(printed) + 1; // the newline is one byte
      }
      break;
    }
    case "step_finish":
      state.sawWire = true;
      state.usage = accumulateUsage(state.usage, parse.usage);
      break;
    case "error":
      state.sawWire = true;
      state.errorMessage ??= parse.message;
      break;
    default:
      state.sawWire = true; // tool_use/unknown events: the wire, no reply text
      break;
  }
}

/** The verdict every opencode path shares: with no wire evidence the run
 * passes through unchanged (the escape hatch); with any, the reply is the
 * folded text, the usage the folded `step_finish` count, an `error` line
 * fails the run like a nonzero exit does, and the lines that were not the
 * wire become a bounded stderr diagnostic instead of a lost run (a timeout
 * can cut the last write mid-line; review ul3). The verdict is never
 * reached for a stream that latched the capture bound — the runner fails
 * that run at exit 125 before post-processing runs — so this function
 * answers only streams whose every line the fold could read. */
function opencodeVerdict(result: RunResult, state: OpenCodeFoldState): RunResult {
  const { sawWire, text, usage, errorMessage, broken, brokenCount } = state;
  if (!sawWire) {
    // No line is the wire: the whole stdout is plain text from a binary
    // that ignored `--format json` (an older binary, a wrapper, a fake).
    return result;
  }
  // A break beside wire evidence is a diagnostic, never a lost run: the
  // first two reasons name what broke, the count says if more did.
  const withBreakNote = (stderr: string): string =>
    brokenCount === 0
      ? stderr
      : appendDiagnostic(
          stderr,
          `codemux: ${brokenCount} opencode output line(s) were not the ` +
            `wire (${broken.join("; ")}), so the reply and usage ` +
            "come from the lines that were"
        );
  if (errorMessage !== null) {
    // The streamed text stays on stdout (plain mode would have printed
    // it before the error), and the usage the run's steps reported is
    // kept: the tokens were spent even though the run failed (review
    // ul2). The JSON lines themselves never leak.
    const errorResult = failed(
      result,
      `codemux: opencode reported an error (${errorMessage}), ` +
        `so this run fails even though the harness exited ${result.exitCode}`,
      text
    );
    return {
      ...errorResult,
      usage: usage ?? emptyUsage(),
      servedModel: null,
      stderr: withBreakNote(errorResult.stderr),
    };
  }
  if (text.trim() === "") {
    const noReply = failed(
      result,
      "codemux: the opencode run printed no assistant text, " +
        "so this run reports no result",
      ""
    );
    return {
      ...noReply,
      usage: usage ?? emptyUsage(),
      servedModel: null,
      stderr: withBreakNote(noReply.stderr),
    };
  }
  return {
    ...result,
    stdout: text,
    usage: usage ?? emptyUsage(),
    servedModel: null,
    stderr: withBreakNote(result.stderr),
  };
}

/**
 * opencode, whole-capture shape: stdout should be the `--format json` event
 * lines the session driver parses (text parts, step_finish usage). The
 * launch path streams them instead (OpenCodePlainFold below, review ul4);
 * this function remains for callers that already hold the captured stdout,
 * and folds the same state through the same verdict.
 */
export function opencodePlainResult(result: RunResult): RunResult {
  const lines = result.stdout.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  if (lines.length === 0) return result;
  const state: OpenCodeFoldState = {
    sawWire: false,
    text: "",
    textBytes: 0,
    usage: null,
    errorMessage: null,
    broken: [],
    brokenBytes: 0,
    brokenCount: 0,
  };
  for (const line of lines) foldOpenCodeLine(line, state);
  return opencodeVerdict(result, state);
}

/**
 * opencode, streaming shape: the run's stdout — the whole `--format json`
 * event stream, every tool's output riding the tool parts — is fed chunk by
 * chunk and never captured whole, because an agentic run's stream passes the
 * 16 MiB capture bound and dies at exit 125 with the reply lost (the codex
 * finding's mirror; review ul4). The fold keeps what plain mode printed (the
 * text parts, each trimmed on its own line), the folded `step_finish`
 * usage, and the break notes; tool parts are dropped as they arrive, so no
 * volume of tool output can reach the bound.
 *
 * One rule for a line past the capture bound (round al37), whatever the
 * stream's regime — hatch open, wire proven, or a stream that never
 * decided — and whatever the event's type: the run fails with the
 * capture-limit failure, exit 125, the latch `overflowed` answering
 * MAX_CAPTURE_BYTES + 1 to every keptBytes poll the runner makes. The line
 * is dropped unread with its note, nothing after it folds (push returns at
 * the top for the latch's whole remainder — the tail chunks of the line
 * and every later line alike cost nothing, review ul5), and close() folds
 * no tail. The check runs at both moments the fold can meet such a line —
 * mid-accumulation and complete in one chunk (round al16) — and because
 * the latch freezes the state at the same completed-lines prefix under
 * every chunking, the pipe's read grouping cannot decide anything. The
 * al34–al36 carve-outs are gone with the accounting that served them: no
 * provisional latch waiting on a later line to commit the wire, no
 * prefix retention in the open hatch, no classifier reading a dropped
 * line's head to decide which oversized wire events may die quietly. A
 * stream whose tool volume alone crosses the bound dies at 125 with the
 * run — the bound is stated on what a line is, not on what it carries,
 * and a fold that picked which unread bytes were safe to lose was
 * guessing about lines it never read (main's own answer: the
 * whole-stream capture dies there too).
 *
 * The verbatim stream is kept only until the first wire line: past that
 * the escape hatch can no longer open, so its bytes are freed, and the
 * residue (the reply text, or the raw text when no line was the wire) is
 * what the capture bound measures. Line boundaries are searched in the
 * newly arrived chunk alone — the buffered partial line provably carries
 * no newline — so one long line arriving in many chunks costs a single
 * pass over the stream, never a per-chunk rescan of everything buffered
 * (review ul8). `keptBytes` counts exactly that residue as running byte
 * totals maintained with each mutation, never a re-measure of a string
 * the chunks are still growing (review ul7), so a partial line counts
 * only while it can still become stdout (before any wire evidence);
 * past that it is on its way to being parsed and dropped, never
 * returned.
 */
export class OpenCodePlainFold implements StdoutSink {
  private readonly state: OpenCodeFoldState = {
    sawWire: false,
    text: "",
    textBytes: 0,
    usage: null,
    errorMessage: null,
    broken: [],
    brokenBytes: 0,
    brokenCount: 0,
  };
  /** The partial line the chunks have not terminated yet. */
  private buffer = "";
  /** UTF-8 bytes of `buffer`, maintained with every mutation: the drop
   * trigger below and keptBytes read this counter, never a re-measure of a
   * string that grows with every chunk (review ul7). */
  private bufferBytes = 0;
  /** Verbatim stdout for the escape hatch, kept only while no line has
   * been the wire. */
  private raw = "";
  /** UTF-8 bytes of `raw`, maintained alongside it (review ul7). */
  private rawBytes = 0;
  /** A line past the capture bound was dropped: the run fails at the
   * capture limit. Sticky — nothing after the drop folds, and keptBytes
   * answers MAX_CAPTURE_BYTES + 1 to every poll from the moment it trips
   * (round al37's one rule). */
  private overflowed = false;
  private closed = false;

  push(chunk: string): void {
    if (this.closed || this.overflowed) return;
    this.bufferBytes += byteLength(chunk);
    // The buffered partial line carries no newline — every exit below
    // leaves it that way — so the boundary search runs over the newly
    // arrived chunk alone, from where the previous pass stops. Searching
    // the whole buffer made every chunk rescan the 0–15 MiB already
    // buffered (and flatten the grown string besides), so one long line in
    // 64 KiB pipe chunks scanned gigabytes of it; `carried` is consumed by
    // the first line it completes, so each byte is prepended at most once
    // (review ul8).
    let carried = this.buffer;
    let start = 0;
    for (;;) {
      const newline = chunk.indexOf("\n", start);
      if (newline === -1) {
        // The chunk ends inside a line: its tail joins the partial line.
        this.buffer = carried + (start === 0 ? chunk : chunk.slice(start));
        break;
      }
      const line = carried + chunk.slice(start, newline);
      carried = "";
      start = newline + 1;
      this.bufferBytes -= byteLength(line) + 1; // the newline is one byte
      // The completed line is size-checked before it is folded (round
      // al16), and the drop returns from push at once: the rest of the
      // chunk never folds, for the latch owns everything after the line.
      if (byteLength(line) > MAX_CAPTURE_BYTES) {
        this.dropOversizedLine();
        return;
      }
      this.takeLine(line, true);
    }
    if (this.bufferBytes > MAX_CAPTURE_BYTES) {
      this.dropOversizedLine();
    }
  }

  /** The one treatment for a line past the capture bound (round al37's
   * rule, the class comment above): the note, the latch, and nothing
   * else — no regime read, no head classified. Fires at either moment
   * the fold meets such a line: mid-accumulation (the partial line
   * outgrew the bound, push's trailing check) or complete in one chunk
   * (the newline arrived with the bytes that crossed the bound, round
   * al16). After it, keptBytes answers over the bound for good, push
   * folds nothing further, and close() folds no tail — the state is
   * frozen at the same completed-lines prefix under every chunking. */
  private dropOversizedLine(): void {
    noteOpenCodeBreak(
      this.state,
      `a single line over the ${MAX_CAPTURE_BYTES}-byte capture bound was dropped unread`
    );
    this.buffer = "";
    this.bufferBytes = 0;
    this.overflowed = true;
  }

  keptBytes(): number {
    if (this.overflowed) return MAX_CAPTURE_BYTES + 1;
    // What the fold can still return: the reply text once the wire was
    // seen, or the hatch's verbatim bytes — buffered tail included, for it
    // becomes raw byte-for-byte — while no line has been the wire. The
    // wire regime's buffer is a line on its way to being parsed and
    // dropped; counting it is what killed runs whose tool output arrived
    // as one long line (review ul5). The capped break notes count too:
    // kept bytes are kept bytes. Every term is a UTF-8 BYTE total the
    // mutation that grew it maintains (Buffer.byteLength, the unit the
    // whole-capture path's bytesRead uses, review ul6), because the
    // runner asks after EVERY chunk (process-runner.ts): re-measuring the
    // strings here made the fallback path quadratic — a 12 MiB plain
    // reply in 8 KiB chunks re-scanned the growing residue once per chunk
    // (review ul7).
    return this.state.sawWire
      ? this.state.textBytes + this.state.brokenBytes
      : this.rawBytes + this.bufferBytes + this.state.brokenBytes;
  }

  /** The usage folded so far — the `step_finish` counts of the steps that
   * already finished — for a run still in flight (the receipt a signal
   * interrupt writes, launch.ts); null when no step reported any. */
  foldedUsage(): ResultUsageBlock | null {
    return this.state.usage;
  }

  finish(): string {
    this.close();
    return this.state.sawWire ? this.state.text : this.raw;
  }

  /** Applies the shared verdict to a finished run; closes the fold first
   * so an unterminated tail line is folded exactly as the whole-capture
   * split folded it. */
  verdict(result: RunResult): RunResult {
    this.close();
    return opencodeVerdict(result, this.state);
  }

  private close(): void {
    if (this.closed) return;
    this.closed = true;
    if (!this.overflowed && this.buffer !== "") {
      // A stream can end mid-line (the write was cut) or without the final
      // newline; folding the tail as a line is what the whole-capture
      // split did (review ul3's cut-off shape). A latched fold folds
      // nothing: its answer was decided at the drop (round al37).
      this.takeLine(this.buffer, false);
    }
    this.buffer = "";
    this.bufferBytes = 0;
  }

  private takeLine(line: string, terminated: boolean): void {
    const wasWire = this.state.sawWire;
    foldOpenCodeLine(line, this.state);
    if (!this.state.sawWire) {
      // Still no wire evidence: the hatch wants the bytes verbatim, the
      // tail byte-for-byte (no newline the stream never sent).
      this.raw += terminated ? `${line}\n` : line;
      this.rawBytes += byteLength(line) + (terminated ? 1 : 0);
    } else if (!wasWire) {
      // First wire evidence: the hatch can no longer open; free its bytes.
      this.raw = "";
      this.rawBytes = 0;
    }
  }
}

/** A stdout fold that also carries usage for a receipt written before the
 * run's post-processing could run (the interrupted and failed launch
 * receipts in launch.ts): the live counts the fold has folded so far, null
 * when no structured line reported any. */
export interface UsageFoldingSink extends StdoutSink {
  foldedUsage(): ResultUsageBlock | null;
}

/** The usage any fold had folded, null for sinks that keep none (never a
 * guess): one seam so a new fold is carried by the launch receipts without
 * their knowing its class. */
export function foldedSinkUsage(sink: StdoutSink | undefined): ResultUsageBlock | null {
  return sink !== undefined && "foldedUsage" in sink
    ? (sink as UsageFoldingSink).foldedUsage()
    : null;
}

/** What the codex wire fold keeps as the lines arrive: the stream's regime
 * — decided once, by the first non-empty line (round al30, rule 3) — the
 * stream reduction (final message, usage snapshot, served model, failure
 * — the same state the whole-capture parse keeps), and the bounded break
 * notes for lines that could not be read. The reducer's `drift` is the
 * streaming spelling of the whole-capture parse's null. */
interface CodexFoldState {
  /** null until the first non-empty line, then "wire" or "human" for the
   * stream's whole remaining length: "wire" when that line parsed as the
   * thread.started announcement a `--json`-honoring binary prints first,
   * "human" for any other first line — a binary that ignored the flag —
   * whose bytes pass through verbatim. Nothing later flips it, however
   * event-like a line looks (a fenced example quoting a stream's events
   * is reply text, not the wire identifying itself). */
  mode: "wire" | "human" | null;
  reducer: CodexEventReducer;
  /** At most the first two notes; `brokenCount` carries the total. */
  broken: string[];
  /** UTF-8 bytes of the kept `broken` notes, maintained with them. */
  brokenBytes: number;
  brokenCount: number;
}

/** Records one line the fold could not keep: the verdict prints only the
 * first two reasons and a count, so only those are kept — the notes stay
 * bounded residue the capture bound can measure. */
function noteCodexBreak(state: CodexFoldState, note: string): void {
  state.brokenCount++;
  if (state.broken.length < 2) {
    state.broken.push(note);
    state.brokenBytes += byteLength(note);
  }
}

/** Whether a line is the thread.started announcement — the one test that
 * decides the stream's regime (round al30, rule 3): the line parses as a
 * JSON object whose `type` is exactly "thread.started". The event's own
 * grammar (the thread id, the first position) is validated by the reducer
 * once the regime is wire, exactly as the whole-capture parse validates
 * it, so the mode test stays a shape question: an announcement spelling
 * the reducer will refuse (a missing thread id) still commits the stream
 * to the wire, and the refusal is the drift that fails it. */
function parsesAsThreadStarted(line: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return false;
  }
  return (
    typeof parsed === "object" &&
    parsed !== null &&
    !Array.isArray(parsed) &&
    (parsed as Record<string, unknown>)["type"] === "thread.started"
  );
}

/** Folds one line of a stream already committed to the wire. Every line is
 * classified exactly as parseCodexEventStream classifies it, so the
 * streaming fold and the whole-capture parse share one verdict: a
 * whitespace-only line is skipped (the parse's blank-line skip), and EVERY
 * line that parses as a JSON object is fed to the reducer — including one
 * whose `type` is not an event the reduction reads, which the parse feeds
 * too. The reducer freezes on its first violation exactly where the parse
 * stops, so the two always hold the same reduction; the fold keeps
 * classifying the lines after it, so the drop notes stay honest. A line
 * that is not JSON — a kill can cut the last write mid-line — or JSON
 * that is not an event object is a break in the structured stream, which
 * the whole-capture parse answers with null: the first break freezes the
 * reducer (later breaks cannot replace it) and the verdict fails the run,
 * never passes the partial stream as the reply. A non-JSON line that
 * opens like an event object is named as the cut mid-event it almost
 * certainly is (a truncated `{"type":"turn.failed"}`; round al25's
 * diagnostic, kept for the wire regime it was written for). */
function foldCodexWireLine(line: string, state: CodexFoldState): void {
  if (line.trim() === "") return; // the whole-capture parse's blank-line skip
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    state.reducer.drift ??=
      line.trimStart().startsWith("{")
        ? "a line that opens like an event object but is not complete JSON " +
          "(the stream was cut mid-event)"
        : "a line among the event stream's lines that was not JSON";
    return;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    state.reducer.drift ??= "a line of JSON that was not an event object";
    return;
  }
  // A no-op once the reducer froze on an earlier violation, so a drifted
  // stream's later objects are safely fed and never advance it past the
  // position the whole-capture parse stopped at.
  state.reducer.takeEvent(parsed as Record<string, unknown>);
}

/** The reduction's retained state — every field a verdict or the caller
 * hands back: the reply text, the usage snapshot, the kept warnings, the
 * failure text, the thread id, the served model, the drift string the
 * failure arms print. Round al29's accounting measures the VALUES: the
 * fold snapshots these before each completed wire line and applies the
 * byte DELTA after it, so a superseded value — a newer assistant message
 * replacing an older one, a recovered error's text leaving — gives its
 * bytes back before the replacing value's are added, and retainedBytes
 * always reads what the reduction holds NOW (the al28 rule it replaces
 * counted every retained line whole and never returned superseded bytes,
 * so three 3 MiB messages tripped a bound only the last one still met).
 * The snapshot holds string and object REFERENCES, not copies: every one
 * of these fields is replaced, never mutated in place (the reducer
 * assigns fresh strings and fresh usage blocks; warnings only append), so
 * reference inequality is the cheap change test and byteLength runs only
 * on the fields that moved. `usageReported` and the counters are verdict
 * inputs, not residue, and stay out. */
interface CodexRetainedSnapshot {
  threadId: string;
  finalMessage: string | null;
  servedModel: string | null;
  failure: string | null;
  warnings: number;
  drift: string | null;
  usage: ResultUsageBlock;
}

const codexRetainedOf = (reducer: CodexEventReducer): CodexRetainedSnapshot => ({
  threadId: reducer.threadId,
  finalMessage: reducer.finalMessage,
  servedModel: reducer.servedModel,
  failure: reducer.failureText(),
  warnings: reducer.warnings.length,
  drift: reducer.drift,
  usage: reducer.usage,
});

/** The bytes one retained string books in the total: its own UTF-8 size,
 * zero for null. */
const codexValueBytes = (text: string | null): number =>
  text === null ? 0 : byteLength(text);

/** The byte delta one completed line moved the retained values by —
 * negative when the line superseded a larger value than it set. Warnings
 * book their rendered note (codexWarningNoteBytes): the verdict prints
 * exactly that line per warning, so an empty message still costs its
 * prefix and a flood of them stays measured. */
const codexRetainedDelta = (
  before: CodexRetainedSnapshot,
  reducer: CodexEventReducer
): number => {
  let delta = 0;
  if (before.threadId !== reducer.threadId) {
    delta += byteLength(reducer.threadId) - byteLength(before.threadId);
  }
  if (before.finalMessage !== reducer.finalMessage) {
    delta += codexValueBytes(reducer.finalMessage) - codexValueBytes(before.finalMessage);
  }
  if (before.servedModel !== reducer.servedModel) {
    delta += codexValueBytes(reducer.servedModel) - codexValueBytes(before.servedModel);
  }
  const failure = reducer.failureText();
  if (before.failure !== failure) {
    delta += codexValueBytes(failure) - codexValueBytes(before.failure);
  }
  if (before.drift !== reducer.drift) {
    delta += codexValueBytes(reducer.drift) - codexValueBytes(before.drift);
  }
  if (before.usage !== reducer.usage) {
    delta +=
      byteLength(JSON.stringify(reducer.usage)) -
      byteLength(JSON.stringify(before.usage));
  }
  // Warnings only append (takeWarning pushes; nothing removes), so the
  // entries added since the snapshot are the whole change.
  for (let i = before.warnings; i < reducer.warnings.length; i++) {
    delta += codexWarningNoteBytes(reducer.warnings[i]!);
  }
  return delta;
};

/** The retained values' whole byte total, measured now — the hatch→wire
 * flip's one-time initialization: the counter starts at what the
 * reduction already holds, never at zero, for values set by lines the
 * hatch fed survive the flip and stay retained. */
const codexRetainedTotal = (reducer: CodexEventReducer): number => {
  let total = byteLength(reducer.threadId);
  total += codexValueBytes(reducer.finalMessage);
  total += codexValueBytes(reducer.servedModel);
  total += codexValueBytes(reducer.failureText());
  total += codexValueBytes(reducer.drift);
  for (const warning of reducer.warnings) total += codexWarningNoteBytes(warning);
  total += byteLength(JSON.stringify(reducer.usage));
  return total;
};

/** The verdict every codex plain path shares (the streaming fold and a
 * whole-capture replay of captured stdout). The stream's regime was
 * decided once, by the FIRST non-empty line (round al30, rule 3): human
 * mode — any first line but the thread.started announcement, a stream of
 * blank lines that never committed itself included — is the hatch's:
 * verbatim stdout, the stderr `tokens used` figure (codexPlainResult),
 * 0.11.0's verdict exactly, and no line later in the stream can change
 * that, however event-like it looks (a fenced example quoting a stream's
 * events is reply text; the al24/al25 quoted-announcement machinery this
 * replaces lived exactly that mistake — a code block quoting
 * thread.started closed the hatch, and a quote carrying turn.failed
 * failed the reply around it). Wire mode — the announcement parsed as
 * the first non-empty line — runs the same rules as the envelope path:
 * the folded final message is the reply under the decided failure
 * contract (round al5, its spelling settled in al11): stdout carries the
 * reply exactly when the stream completed the turn — a `turn.completed`
 * closed every turn and a final message exists — even when codex then
 * exited nonzero, because human mode printed that message before exiting,
 * and the message prints verbatim plus exactly one trailing newline
 * however it ends (`println!`; see codexPlainReply); a turn that never
 * completed (drift, a truncated stream, a `turn.failed`, a kill or
 * timeout after an intermediate agent message) prints nothing, which is
 * also what human mode printed; and a turn that completed with no message
 * anywhere succeeds with empty stdout and keeps the usage (round al10).
 * The messageless arm is where the ONE bounded fallback lives (round
 * al29, replacing al28's no-file-at-all rule): a plain run names a
 * `--output-last-message` file again — a Plan-only turn's recorded final
 * message is the reply's only carrier, the one item the JSONL wire does
 * not carry — but the verdict consults it only when the stream completed
 * a turn with no agent_message and nothing else failed, through the
 * `planFallback` thunk the launch hands over after its own
 * read-and-remove (CodexPlanFallbackRead above): text answers with
 * CODEX_FINAL_MESSAGE_FALLBACK_NOTE, an empty file confirms the
 * messageless turn (human mode's `final_message` was `None`; no note), a
 * missing file fails the run naming the unwritten file (round al34,
 * edges major 2 — the file was the turn's only carrier, and codex did
 * not write it), and an unreadable one fails with its read error. No
 * thunk, or any other stream shape, never reads the file — the
 * two-verdicts-for-one-stream defect al28 answered by deleting the file
 * is answered here by scoping it. The wire itself never reaches stdout,
 * failed or not. */
function codexFoldVerdict(
  result: RunResult,
  state: CodexFoldState,
  planFallback?: () => CodexPlanFallbackRead
): RunResult {
  const withBreakNote = (stderr: string): string =>
    state.brokenCount === 0
      ? stderr
      : appendDiagnostic(
          stderr,
          `codemux: ${state.brokenCount} codex output line(s) were dropped ` +
            `unread (${state.broken.join("; ")}), so the reply and usage ` +
            "come from the lines that were read"
        );
  // The whole-capture parse returns null for drift and the envelope path
  // keeps the raw stream for inspection; the fold never held it. A drifted
  // run prints no reply: the turn never completed, and human mode printed
  // nothing for a turn that never completed. The warnings the reduction
  // retained before the break ride the failure's stderr exactly as the
  // clean path renders them (round al25, correctness minor): a parse
  // failure must not silently discard them.
  const streamFailure = (diagnostic: string): RunResult => {
    const notes: string[] = [diagnostic];
    for (const warning of state.reducer.warnings) {
      notes.push(codexWarningNote(warning));
    }
    const failureResult = failed(result, notes.join("\n"), "");
    return {
      ...failureResult,
      servedModel: state.reducer.servedModel,
      stderr: withBreakNote(failureResult.stderr),
    };
  };
  const driftFailure = (drift: string): RunResult =>
    streamFailure(
      `codemux: codex printed an event stream this codemux cannot parse ` +
        `(${drift}), so this run fails rather than pass a partial one ` +
        "as the reply"
    );
  if (state.mode !== "wire") {
    // Human mode — or a stream of blank lines that never decided: the
    // whole stdout is plain text from a binary that ignored `--json` (an
    // older binary, a wrapper, a fake; round al30 made the first
    // non-empty line the one and only test). The reply passes through
    // verbatim at the child's own exit code — codexPlainResult keeps
    // whatever exit the harness reported, 0 and non-zero alike.
    return codexPlainResult(result);
  }
  // Wire mode: the first non-empty line was the thread.started
  // announcement the reducer accepted (or an oversized `{`-shaped first
  // line, whose unread drop set the reduction's drift below), so the
  // no-announcement null the whole-capture parse answers for an
  // unannounced stream cannot arise on this branch — an unannounced
  // stream is human mode here, passthrough.
  const drift = state.reducer.drift;
  if (drift !== null) {
    return driftFailure(drift);
  }
  const stream = state.reducer.toStream();
  const verdict = codexStreamVerdict(stream, result, {
    messagelessCompletedTurnSucceeds: true,
  });
  const notes: string[] = [];
  if (verdict.diagnostic !== null) notes.push(verdict.diagnostic);
  if (stream.servedModel !== null) {
    notes.push(
      `codemux: codex rerouted the model, so this run was served by ${stream.servedModel}`
    );
  }
  // Round al22 (correctness minor): codex reports configuration and runtime
  // warnings as completed error items the turn survives, and human mode
  // printed each message on stderr — so a plain run that reduced them away
  // exited 0 with the warnings nowhere. Every non-reroute error item the
  // reduction kept now rides stderr beside the reply, success and failure
  // alike, one note per warning in arrival order.
  for (const warning of state.reducer.warnings) {
    notes.push(codexWarningNote(warning));
  }
  // The decided plain-run rule (round al5, its spelling settled in al11):
  // the reply prints exactly when the stream completed it — every turn
  // closed by a `turn.completed` and a final message the stream carries —
  // even on a failed run (codex exited nonzero
  // after completing; human mode printed the message before exiting). The
  // spelling is the pinned processor's own (`println!`): the message
  // verbatim plus exactly one trailing newline, always — an empty-text or
  // whitespace-only message prints its bytes and that newline (al11;
  // al10 had emptied them), and a message ending in a newline prints two.
  // A turn that never completed has no reply to print: the reducer still
  // holds the last intermediate agent message of a killed or timed-out
  // turn, and a failed turn's message is discarded upstream, so neither
  // may pose as the reply. A turn that completed with NO message anywhere
  // prints nothing too, but succeeds (round al10, the verdict option
  // above): stdout's emptiness is the run succeeding the way human mode
  // did — `final_message` was `None`, and no line was written — not a
  // failed result.
  let reply =
    stream.turnCompleted && stream.finalMessage !== null
      ? codexPlainReply(stream.finalMessage)
      : "";
  // The ONE bounded fallback (round al29): a completed messageless turn —
  // the Plan-only shape, the one item the JSONL wire cannot carry — and
  // only that, with the verdict otherwise clean, consults the
  // --output-last-message file the launch named. The thunk reads nothing
  // itself (the launch read and removed the file before the verdict ran,
  // so it cannot outlive the run), and no other arm invokes it: a stream
  // that carried the reply, failed, or never completed answers from the
  // stream alone, exactly as it did before the file existed.
  if (
    planFallback !== undefined &&
    !verdict.failed &&
    stream.turnCompleted &&
    stream.finalMessage === null
  ) {
    const fallback = planFallback();
    if (fallback.outcome === "text" && fallback.text !== "") {
      reply = codexPlainReply(fallback.text);
      notes.push(CODEX_FINAL_MESSAGE_FALLBACK_NOTE);
    } else if (fallback.outcome === "text") {
      // An empty file is upstream's messageless-turn record: human mode
      // printed nothing for it, so the reply stays empty — the al10
      // verdict with the file's own confirmation, and no note for a turn
      // that had no message to report.
    } else if (fallback.outcome === "missing") {
      // Round al34 (edges major 2): the launch NAMED this file, and for
      // the messageless turn it was the reply's only carrier — codex
      // writes something for every completed turn, so a named file that
      // is not there is a write codex only logged. The run fails naming
      // the unwritten file, exactly as the envelope path fails the same
      // shape — never an empty success beside a message that was lost.
      return {
        ...streamFailure(
          `codemux: codex completed the turn but did not write the ` +
            `--output-last-message file the launch named (${fallback.path}), ` +
            `so the turn's final message is lost`
        ),
        usage: emptyUsage(),
      };
    } else {
      // A file the read refused loses the only carrier the messageless
      // turn had: the run fails with the read error, never an empty
      // success posing beside a message codemux could not read.
      return {
        ...streamFailure(
          `codemux: could not read codex's --output-last-message file: ` +
            fallback.error
        ),
        usage: emptyUsage(),
      };
    }
  }
  return {
    ...result,
    stdout: reply,
    stderr: withBreakNote(
      notes.length > 0 ? appendDiagnostic(result.stderr, notes.join("\n")) : result.stderr
    ),
    exitCode: verdict.failed && result.exitCode === 0 ? 1 : result.exitCode,
    success: !verdict.failed,
    // A failed run reports null usage (the envelope path's rule): a figure
    // from a run whose end the harness itself called failed is at best
    // incomplete.
    usage: verdict.failed ? emptyUsage() : stream.usage,
    servedModel: stream.servedModel,
  };
}

/**
 * codex, streaming shape: the run's stdout — the whole `--json` event
 * stream, every tool's output riding the item events — is fed chunk by
 * chunk and never captured whole, because an agentic run's stream passes
 * the 16 MiB capture bound and dies at exit 125 with the reply lost (the
 * ul3 finding, now solved the way opencode's was). The fold keeps the
 * final-message candidate, the last usage snapshot, the served model, and
 * the break notes; item events are dropped as they arrive, so no volume
 * of tool output can reach the bound.
 *
 * The stream's regime is decided once, by the first non-empty line
 * (round al30, rule 3): a line that parses as the thread.started
 * announcement commits the stream to the wire; any other first line
 * commits it to human mode — verbatim passthrough, the bytes kept whole
 * in `raw` — and nothing later flips it (a fenced example quoting the
 * events, quoted JSON: reply text, whatever it looks like). The verbatim
 * stream is kept only while the regime is undecided or human, and the
 * boundary search runs over the newly arrived chunk alone (reviews ul5,
 * ul8).
 *
 * One rule for a line past the capture bound (round al37), whatever the
 * stream's regime — wire, human, or undecided — and whatever the event's
 * type: the run fails with the capture-limit failure, exit 125 — the
 * latch `overflowed` answering MAX_CAPTURE_BYTES + 1 to every keptBytes
 * poll, push folding nothing after the drop, close() folding no tail.
 * The check runs at both moments the fold can meet such a line —
 * mid-accumulation or complete in one chunk (round al16) — and the latch
 * freezes the state at the same completed-lines prefix under every
 * chunking, so the pipe's read grouping cannot decide anything. The
 * al34–al36 carve-outs are gone with the accounting that served them: an
 * oversized line no longer commits an undecided stream to human (round
 * al35's commit rule is deleted — the regime stays undecided, for the
 * wire is committed only by a line read whole as the thread.started
 * announcement), and no dropped head is classified (round al8's
 * tool part, round al11's error event and re-review, round al22/al35's
 * warning item, round al34's reroute notice, round al14's non-object
 * drift — none of them): a fold that picked which unread bytes were
 * safe to lose by their first 512 bytes was guessing about lines it
 * never read. The one thing kept is round al31's decided-human prefix:
 * a stream already committed to human mode retains the bounded prefix
 * of the line, so the capture-limit result carries the same partial
 * output the whole-stream capture would have returned instead of only
 * what preceded the oversized line.
 *
 * Round al29 gives the capture-bound accounting ONE rule, stated once and
 * chunking-independent (al28's property test delivers the same bytes
 * whole and in every chunking from 1 byte to 64 KiB and requires
 * byte-identical verdicts and a byte-identical keptBytes): a line is
 * accounted when it COMPLETES, after the reduction has consumed it, and
 * `retainedBytes` moves by the byte DELTA the line made in the retained
 * values (the reply text, the usage snapshot, the kept warnings, the
 * failure text, the thread id, the served model, the drift string — the
 * fields codexRetainedOf snapshots) — so the counter always reads what
 * the reduction holds NOW, a superseded value's bytes leaving with the
 * value (the al28 rule it replaces added the whole line whenever anything
 * changed and never subtracted, so three 3 MiB messages tripped a bound
 * only the last one still met), and the limit check runs right after
 * that update and nowhere else, over `retainedBytes + brokenBytes` alone.
 * Tool-output lines — the wire's volume, the reason the fold exists —
 * move no retained value, so they are dropped before accounting by the
 * same diff; the buffered partial line is never in the check, for the
 * same bytes cross the bound at different partial heights under different
 * chunkings (round al27's verdict rule, now the accounting's).
 * keptBytes reports the latch once it trips (MAX_CAPTURE_BYTES + 1, what
 * the process runner kills on) and otherwise the two regimes' honest
 * residues: the retained values plus break notes on the wire branch, the
 * verbatim bytes human mode still owes on the other. The regime's
 * commitment to wire frees human mode's raw beside itself and starts the
 * wire regime's counter at the values the reduction holds at that moment
 * (round al21's one-counter rule; round al29 replaced the reset-to-zero,
 * which let values the hatch had fed survive the flip unmeasured), while
 * the latch itself is sticky — a bound the residue crossed cannot be
 * un-tripped by later structure.
 */
export class CodexPlainFold implements UsageFoldingSink {
  private readonly state: CodexFoldState = {
    mode: null,
    reducer: new CodexEventReducer(),
    broken: [],
    brokenBytes: 0,
    brokenCount: 0,
  };
  /** The partial line the chunks have not terminated yet. */
  private buffer = "";
  /** UTF-8 bytes of `buffer`, maintained with every mutation. */
  private bufferBytes = 0;
  /** Verbatim stdout for the escape hatch, kept only while no line has
   * been the wire. */
  private raw = "";
  /** UTF-8 bytes of `raw`, maintained alongside it. */
  private rawBytes = 0;
  /** UTF-8 bytes of the retained values the reduction holds now (the wire
   * branch of keptBytes and one side of the limit check): every completed
   * wire line applies the byte delta it moved, so a superseded value's
   * bytes leave with the value. Initialized at the hatch→wire flip. */
  private retainedBytes = 0;
  /** A line past the capture bound was dropped: the run fails at the
   * capture limit (round al37's one rule). Sticky — keptBytes answers
   * MAX_CAPTURE_BYTES + 1 and the process runner kills the run on that;
   * a later line cannot un-trip a bound the residue already crossed. */
  private overflowed = false;
  private closed = false;

  push(chunk: string): void {
    if (this.closed || this.overflowed) return;
    this.bufferBytes += byteLength(chunk);
    // The buffered partial line carries no newline — every exit below
    // leaves it that way — so the boundary search runs over the newly
    // arrived chunk alone (review ul8).
    let carried = this.buffer;
    let start = 0;
    for (;;) {
      const newline = chunk.indexOf("\n", start);
      if (newline === -1) {
        this.buffer = carried + (start === 0 ? chunk : chunk.slice(start));
        break;
      }
      const line = carried + chunk.slice(start, newline);
      carried = "";
      start = newline + 1;
      this.bufferBytes -= byteLength(line) + 1; // the newline is one byte
      // The completed line is size-checked BEFORE it is parsed (round
      // al16), and the drop returns from push at once: the rest of the
      // chunk never folds, for the latch owns everything after the line.
      if (byteLength(line) > MAX_CAPTURE_BYTES) {
        this.dropOversizedLine(line);
        return;
      }
      this.takeLine(line, true);
      if (this.overflowed) return;
    }
    if (this.bufferBytes > MAX_CAPTURE_BYTES) {
      this.dropOversizedLine(this.buffer);
    }
  }

  /** The one treatment for a line past the capture bound (round al37's
   * rule, the class comment above): the note, the latch, and — for a
   * DECIDED human stream only — al31's bounded prefix. No regime is
   * committed and no head classified. Fires at either moment the fold
   * meets such a line: mid-accumulation (the partial line outgrew the
   * bound, push's trailing check) or complete in one chunk (round al16:
   * the newline arrived with the bytes that crossed the bound). `line`
   * is what was read of it — the whole line when it completed, its head
   * only when it did not — which yields the identical prefix either
   * way: the prefix depends on the first `room` bytes alone, and both
   * forms share them (the head is always the longer). */
  private dropOversizedLine(line: string): void {
    noteCodexBreak(
      this.state,
      `a single line over the ${MAX_CAPTURE_BYTES}-byte capture bound was dropped unread`
    );
    if (this.state.mode === "human") {
      // Human mode's plain stdout, unreadable whole: the run fails at the
      // capture limit, never a silent truncation (the ul5 pin). The bytes
      // are still accounted before the discard (round al31, correctness
      // major): the capture-limit result owes the caller the same partial
      // output the whole-stream path returns — the first bytes it could
      // hold — so the bounded prefix of the line joins raw here, against
      // the room left beside what raw and the note already hold.
      const room = Math.max(
        0,
        MAX_CAPTURE_BYTES - this.rawBytes - this.state.brokenBytes
      );
      const prefix = utf8BytePrefix(line, room);
      this.raw += prefix;
      this.rawBytes += byteLength(prefix);
    }
    this.overflowed = true;
    this.buffer = "";
    this.bufferBytes = 0;
  }

  keptBytes(): number {
    if (this.overflowed) return MAX_CAPTURE_BYTES + 1;
    // The two regimes' honest residues (round al29's one rule, the class
    // comment above): the wire branch reports the retained values plus
    // the break notes — the measure the limit check latches
    // on, so what the runner kills on and what the fold reports are one
    // number. Neither regime counts the buffered partial line: its
    // height depends on chunking. close() accounts for an unfinished
    // tail, and push() independently bounds each buffered line.
    return this.state.mode === "wire"
      ? this.retainedBytes + this.state.brokenBytes
      : this.rawBytes + this.state.brokenBytes;
  }

  /** The usage folded so far — the last `turn.completed` snapshot — for a
   * run still in flight (the receipt a signal interrupt writes,
   * launch.ts); null when no turn reported any. */
  foldedUsage(): ResultUsageBlock | null {
    return this.state.reducer.usageReported ? this.state.reducer.usage : null;
  }

  finish(): string {
    this.close();
    // The last message's own spelling (codexPlainReply), NOT always the
    // verdict's: a killed or timed-out turn whose stream carried an
    // intermediate agent_message returns that message here, while
    // verdict() prints nothing for it (round al21, contracts-2 minor 5 —
    // this comment once claimed the verdict's spelling outright). Safe
    // because the launch flow's processRunResult runs after finish() and
    // overwrites stdout with the verdict's own; finish() alone answers
    // only callers that asked for the folded message, not a run result.
    // A null message is the no-message turn's — nothing, never a bare
    // newline — and any real one carries its newline whatever it ends
    // with.
    return this.state.mode === "wire"
      ? this.state.reducer.finalMessage === null
        ? ""
        : codexPlainReply(this.state.reducer.finalMessage)
      : this.raw;
  }

  /** Applies the shared verdict to a finished run; closes the fold first
   * so an unterminated tail line is folded exactly as the whole-capture
   * split folded it. The optional `planFallback` thunk is the round-al29
   * bounded fallback: the launch reads the run's --output-last-message
   * file before the verdict runs and hands its outcome over, and the
   * verdict consults it only for a completed messageless turn
   * (codexFoldVerdict above). No thunk — every whole-capture replay, and
   * any launch that named no file — answers from the stream alone. */
  verdict(
    result: RunResult,
    planFallback?: () => CodexPlanFallbackRead
  ): RunResult {
    this.close();
    return codexFoldVerdict(result, this.state, planFallback);
  }

  private close(): void {
    if (this.closed) return;
    this.closed = true;
    if (!this.overflowed && this.buffer !== "") {
      // A stream can end mid-line (the write was cut) or without the final
      // newline; folding the tail as a line matches the whole-capture
      // split (review ul3's cut-off shape). A latched fold folds nothing:
      // its answer was decided at the drop (round al37).
      this.takeLine(this.buffer, false);
    }
    this.buffer = "";
    this.bufferBytes = 0;
  }

  private takeLine(line: string, terminated: boolean): void {
    // The regime is decided by the first non-empty line and never
    // revisited (round al30, rule 3): blank lines alone commit nothing.
    if (this.state.mode === null && line.trim() !== "") {
      this.decideMode(line);
    }
    if (this.state.mode !== "wire") {
      // Undecided (blank lines so far) or human mode: the bytes are kept
      // verbatim, the tail byte-for-byte (no newline the stream never
      // sent).
      this.raw += terminated ? `${line}\n` : line;
      this.rawBytes += byteLength(line) + (terminated ? 1 : 0);
      this.boundCheck();
      return;
    }
    // The round-al29 accounting diff: the snapshot before the line, the
    // reduction consuming it, and the byte DELTA the line moved in the
    // retained values — a completed line that superseded a larger value
    // than it set gives bytes back, and one that moved nothing (a tool
    // part, the wire's volume) is dropped before accounting. The counter
    // was initialized at the regime's commitment (decideMode), so the
    // first wire line's delta lands on the same total the old flip
    // computed after folding it.
    const before = codexRetainedOf(this.state.reducer);
    foldCodexWireLine(line, this.state);
    const delta = codexRetainedDelta(before, this.state.reducer);
    if (delta !== 0) this.accountRetained(delta);
  }

  /** Commit the stream to its regime from the first non-empty line
   * (round al30, rule 3): a line that parses as the thread.started
   * announcement is the wire — the grammar makes it the first event of
   * every stream, and the launch always asked for `--json`, so a binary
   * that honored the flag prints it here — and anything else is human
   * mode, verbatim passthrough for the stream's whole remaining length.
   * The commitment to wire frees the bytes human mode had kept (blank
   * lines, at most) and starts the retained counter at the values the
   * reduction holds NOW (round al21's one-counter rule; round al29's
   * initialization), so the announcement line's own delta lands on the
   * exact total. */
  private decideMode(line: string): void {
    if (parsesAsThreadStarted(line)) {
      this.state.mode = "wire";
      this.raw = "";
      this.rawBytes = 0;
      this.retainedBytes = codexRetainedTotal(this.state.reducer);
      this.boundCheck();
    } else {
      this.state.mode = "human";
    }
  }

  /** One accounting update: the byte delta joins the retained total
   * (negative when a value was superseded or cleared), then check the
   * current total. Raw appends and the regime's initialization use the
   * same check. */
  private accountRetained(delta: number): void {
    this.retainedBytes += delta;
    this.boundCheck();
  }

  /** The limit check, over completed retained lines and break notes
   * alone: never the buffered partial line, whose height at any
   * completion moment is a property of the chunking, not of the bytes. */
  private boundCheck(): void {
    const retained = this.state.mode === "wire" ? this.retainedBytes : this.rawBytes;
    if (retained + this.state.brokenBytes > MAX_CAPTURE_BYTES) {
      this.overflowed = true;
    }
  }
}

/**
 * codex, whole-capture shape: folds an already-captured stdout through the
 * same reduction and verdict, for callers that hold the stream without a
 * launch-owned fold (a direct processRunResult call in a test, say). The
 * launch path streams (CodexPlainFold above, review ul4's rule), because a
 * captured stream is the one shape the 16 MiB bound cannot hold. The
 * optional `planFallback` thunk is the round-al29 bounded fallback, passed
 * by the launch's processRunResult when the run named a
 * --output-last-message file (codex.ts); the replay here stays callable
 * without one — a caller holding captured stdout and no context answers
 * from the stream alone.
 */
export function codexPlainStreamResult(
  result: RunResult,
  planFallback?: () => CodexPlanFallbackRead
): RunResult {
  const fold = new CodexPlainFold();
  if (result.stdout !== "") fold.push(result.stdout);
  return fold.verdict(result, planFallback);
}
