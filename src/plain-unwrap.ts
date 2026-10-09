/**
 * The plain-run unwrap: adapters that can report usage launch their harness
 * in its structured mode even without `--result-json` (claude/zai's
 * `--output-format json`, agy's `--output-format=json`, opencode's
 * `--format json`), and these functions turn the structured stdout back
 * into the plain reply so `codemux run` stdout keeps its contract — the
 * model's final message and nothing else — while the run's usage and served
 * model are recorded on the RunResult for the call ledger. Codex is the
 * exception (codexPlainResult below): a plain run keeps human mode,
 * because `--json` streams every event with all tool output past the
 * 16 MiB capture bound, and its usage comes from the stderr figure.
 * opencode's `--format json` stream carries the same volume (every tool's
 * output rides the event lines), so its plain run streams instead of
 * buffering: the launcher feeds each chunk to OpenCodePlainFold, which
 * keeps only the reply text, the folded usage, and the break notes — tool
 * parts are dropped as they arrive — and the capture bound measures that
 * residue, never the raw stream (review ul4).
 *
 * The unwrap reproduces plain-text mode byte for byte: the result text
 * verbatim, plus one trailing newline when the text is non-empty and lacks
 * one. opencode's reply is spelled the way its run command's plain mode
 * prints it (verified against upstream v1.18.18, scratch/upstream-run.ts):
 * each completed text part trimmed, empty parts skipped, one newline after
 * every part — the banner, tool lines, and errors all go to stderr there,
 * so stdout is the parts and nothing else. An empty result stays empty.
 * Stdout that is not the structured output the launch asked for — an older
 * binary, a wrapper that strips the flag, a fake in a test — passes
 * through verbatim with the run unchanged and no usage recorded: the
 * escape hatch that keeps every binary codemux did not structure its
 * output for working. The hatch opens only when nothing on stdout is the
 * wire: one broken line among wire lines (opencode, where a timeout can
 * cut the last write mid-line) or a stdout that parses as JSON or opens
 * like the envelope but is not it (the claude family and agy, where the
 * envelope is one write a kill can halve — any JSON value, an array
 * included, not only a leading `{`; review ul7) is a structured stream
 * that broke, not a plain reply — the text and usage folded so far stay,
 * and the break becomes a codemux diagnostic on stderr (review ul3). When the
 * structured output IS recognized, the same verdict rules as the envelope
 * path apply: an error result or a result with no text fails the run
 * (README: "An empty result is a failed run on every path, plain or
 * structured"). A failed run keeps the harness's own text on stdout — the
 * error envelope's `result` or `response`, the text opencode streamed
 * before its error line — exactly what plain mode would have printed; the
 * structured wire itself never reaches stdout, failed or not.
 */

import {
  appendDiagnostic,
  emptyUsage,
  parseAgyResultEnvelope,
  parseClaudeResultEnvelope,
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

/** UTF-8 size in bytes — the unit the capture bound is stated in, so the
 * fold's keptBytes and the whole-capture path's bytesRead measure one and
 * the same thing (review ul6). */
const byteLength = (text: string): number => Buffer.byteLength(text);

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
 * codex: a plain run launches in human mode (review ul3) — `--json` streams
 * every event with all tool output, so an agentic run fills the 16 MiB
 * stdout capture and dies at exit 125 with the reply lost. Human mode
 * prints the reply on stdout, which passes through verbatim exactly as it
 * did before the ledger, and reports one blended `tokens used` figure on
 * stderr: that figure becomes the run's usage, total_tokens alone with
 * every other field null, because it is (input − cached) + output and the
 * parts cannot be recovered. A stderr without the figure records no usage.
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
 * can cut the last write mid-line; review ul3). */
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
 * volume of tool output can reach the bound. One line whose size in bytes
 * — the bound's unit; the ul7 trigger replaced a code-unit count that let
 * a multibyte line slip past un-dropped — passes the whole capture bound
 * is dropped unread with a note rather than buffered: the chunks of its
 * tail are dropped whole until the newline that ends it, so the line's
 * full size never touches the residue (review ul5). A wire line
 * (`{`-shaped; tool output, almost surely) is dropped as wire noise, while
 * bytes that could only have been the hatch's plain stdout mark the run
 * over the limit instead — truncating those silently would be worse than
 * the capture failure the whole-stream path always had. The verbatim stream
 * is kept only until the first wire line: past that the escape hatch can no
 * longer open, so its bytes are freed, and the residue (the reply text, or
 * the raw text when no line was the wire) is what the capture bound
 * measures. Line boundaries are searched in the newly arrived chunk alone —
 * the buffered partial line provably carries no newline — so one long line
 * arriving in many chunks costs a single pass over the stream, never a
 * per-chunk rescan of everything buffered (review ul8). `keptBytes` counts
 * exactly that residue as running byte totals
 * maintained with each mutation, never a re-measure of a string the chunks
 * are still growing (review ul7), so a partial line counts only while it
 * can still become stdout (before any wire evidence); past that it is on
 * its way to being parsed and dropped, never returned.
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
  /** An oversized line is being skipped; every chunk of its tail is
   * dropped whole until its newline arrives. */
  private discarding = false;
  /** Bytes that would have been stdout were dropped in the hatch regime:
   * keptBytes reports over the bound so the run fails at the capture
   * limit, never a silent truncation. */
  private overflowed = false;
  private closed = false;

  push(chunk: string): void {
    if (this.closed) return;
    if (this.discarding) {
      // The oversized line's tail is never buffered: whole chunks are
      // dropped until the newline that ends the line arrives, so the rest
      // of a line of any size costs nothing (review ul5).
      const newline = chunk.indexOf("\n");
      if (newline === -1) return;
      // The oversized line ends here; the drop was noted where it began.
      this.discarding = false;
      chunk = chunk.slice(newline + 1);
    }
    this.bufferBytes += byteLength(chunk);
    // The buffered partial line carries no newline — every exit below
    // leaves it that way — so the boundary search runs over the newly
    // arrived chunk alone, from where the previous pass stopped. Searching
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
      this.takeLine(line, true);
    }
    if (this.bufferBytes > MAX_CAPTURE_BYTES) {
      this.discarding = true;
      // Every wire line is a JSON object, so a `{`-shaped oversized line is
      // the wire's grammar even unread; anything else could only have been
      // the hatch's plain stdout.
      const wireShaped = this.buffer.trimStart().startsWith("{");
      this.buffer = "";
      this.bufferBytes = 0;
      noteOpenCodeBreak(
        this.state,
        `a single line over the ${MAX_CAPTURE_BYTES}-byte capture bound was dropped unread`
      );
      if (wireShaped) this.state.sawWire = true;
      else this.overflowed = true;
    }
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
    if (this.discarding) {
      // The stream ended inside an oversized line; noted where it began.
      this.discarding = false;
    } else if (this.buffer !== "") {
      // A stream can end mid-line (the write was cut) or without the final
      // newline; folding the tail as a line is what the whole-capture
      // split did (review ul3's cut-off shape).
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
