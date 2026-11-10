/** The opencode plain-run unwrap: the `--format json` event stream folded
 * to the reply text, usage, and break notes, by the streaming sink below.
 * src/plain-unwrap.ts owns the public surface and the module overview. */
import { appendDiagnostic, emptyUsage } from "../result-envelope.js";
import { MAX_CAPTURE_BYTES, type StdoutSink } from "../process-runner.js";
import { StreamMarkerScan } from "../stream-marker-scan.js";
import { parseOpenCodeRunLine } from "../session/opencode-session.js";
import { accumulateUsage } from "../session/usage.js";
import type { ResultUsageBlock, RunResult } from "../types.js";
import { byteLength, failed } from "./common.js";
import { isLengthStop, withTruncationNotice } from "../answer-complete.js";

/** What the opencode wire fold keeps as the lines arrive: the reply spelled
 * as plain mode prints it, the folded `step_finish` usage, the first error,
 * and the notes for lines that were not the wire — the first two notes and
 * a count of the rest, everything the verdict ever prints, so a stream of
 * noise cannot grow the residue (review ul5). One shape shared by the
 * whole-capture unwrap and the streaming sink below, so the two paths
 * cannot drift (review ul4). */
/** The opencode wire fold's finished outcome, stripped of the byte counters
 * only the fold's own bookkeeping needs: the input the plain verdict reads
 * (opencodeVerdict) and the `--result-json` envelope's source
 * (result-envelope/opencode.ts) are one shape, so the two paths cannot
 * drift. */
export interface OpenCodeResultData {
  sawWire: boolean;
  text: string;
  usage: ResultUsageBlock | null;
  errorMessage: string | null;
  /** At most the first two notes; `brokenCount` carries the total. */
  broken: string[];
  brokenCount: number;
  /** The last step's text alone (lane AN1's final message): "" when the
   * last step carried no text, null before any step or text. */
  finalMessage: string | null;
  /** The last step finished with reason "length" (the output-token cap). */
  truncated: boolean;
}

interface OpenCodeFoldState extends OpenCodeResultData {
  /** Retain the first validated ID even when that event's payload is malformed. */
  knownSessionId: string | null;
  /** UTF-8 bytes of `text`, maintained as it grows: keptBytes reads a
   * running total instead of re-measuring a string that grows with every
   * text line, because the runner asks after every chunk (review ul7). */
  textBytes: number;
  /** UTF-8 bytes of the kept `broken` notes, maintained with them
   * (review ul7). */
  brokenBytes: number;
  /** The text parts of the step in progress, a blank line between two. */
  stepText: string;
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
  // Framing whitespace is never judged (review round 147): a line that is
  // empty once one trailing carriage return is removed — the blank line
  // of an LF or a CRLF wire — is skipped before the parse, exactly as the
  // session framer drops it. The skip lives here, not in the streaming
  // sink's takeLine, so the escape hatch still keeps the line's bytes
  // verbatim.
  if (line === "" || line === "\r") return;
  const parse = parseOpenCodeRunLine(line, { knownSessionId: state.knownSessionId });
  if ("sessionId" in parse && parse.sessionId !== undefined) state.knownSessionId ??= parse.sessionId;
  switch (parse.kind) {
    case "unusable":
      noteOpenCodeBreak(state, `an unparseable line of ${parse.bytes} bytes`);
      break;
    case "grammar_error":
      // A grammar error parsed as a JSON object — the wire's own grammar —
      // so it is wire evidence whatever broke (round 259): a stream whose
      // only line is such an event is a malformed structured stream, never
      // plain text that passes through verbatim as the reply. The
      // session-mismatch arm carries the stronger fact and fails the run.
      state.sawWire = true;
      if (parse.reason === "session-mismatch") {
        state.errorMessage ??= parse.message;
      } else {
        noteOpenCodeBreak(state, parse.message);
      }
      break;
    case "text": {
      state.sawWire = true;
      // Every text part joins the answer (lane AN1). One step is one
      // assistant message: its parts print trimmed on their own lines, as
      // plain mode prints them, and a blank line separates two steps'
      // text (assembleAnswer's spelling between messages).
      const printed = parse.text.trim();
      if (printed !== "") {
        const separator = state.text !== "" && state.stepText === "" ? "\n" : "";
        state.text += `${separator}${printed}\n`;
        state.textBytes += byteLength(printed) + 1 + separator.length; // newlines are one byte
        state.stepText = state.stepText === "" ? printed : `${state.stepText}\n${printed}`;
        state.finalMessage = state.stepText;
      }
      break;
    }
    case "step_finish":
      state.sawWire = true;
      state.usage = accumulateUsage(state.usage, parse.usage);
      // One step is one assistant message: its text (or "") is the final
      // message so far, and its finish reason is the step's stop reason
      // (AI SDK finishReason: "length" is the output-token cap; opencode
      // session/processor.ts writes it as the step-finish part's reason).
      state.finalMessage = state.stepText;
      state.truncated = isLengthStop(stepFinishReason(line));
      state.stepText = "";
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

/** The step-finish part's `reason`, read off the raw line (the shared
 * run-line parser reports only the usage). */
function stepFinishReason(line: string): unknown {
  try {
    const event = JSON.parse(line) as { part?: { reason?: unknown } };
    return event.part?.reason;
  } catch {
    return undefined;
  }
}

/** The verdict every opencode path shares: with no wire evidence the run
 * passes through unchanged (the escape hatch) — except empty stdout,
 * which fails as the claude family's empty success does (round 259): a
 * zero-exit run that printed nothing produced neither the wire nor a
 * reply. With any wire evidence, the reply is the folded text, the usage
 * the folded `step_finish` count, an `error` line or a session mismatch
 * fails the run like a nonzero exit does, and lines that were not the
 * wire become a bounded stderr diagnostic (a timeout can cut the last
 * write mid-line; review ul3). The verdict is never reached for a stream
 * that latched the capture bound — the runner fails that run at exit 125
 * before post-processing runs — so this function answers only streams
 * whose every line the fold could read. */
export function opencodeVerdict(result: RunResult, data: OpenCodeResultData): RunResult {
  const { sawWire, text, usage, errorMessage, broken, brokenCount } = data;
  if (!sawWire) {
    // No line is the wire: the whole stdout is plain text from a binary
    // that ignored `--format json` (an older binary, a wrapper, a fake) —
    // but a binary that printed nothing at all answered neither way.
    if (result.success && result.stdout.trim() === "") {
      return failed(
        result,
        "codemux: opencode produced no output: a --format json run prints " +
          "its event stream, so an empty success is not a plain reply",
        ""
      );
    }
    return result;
  }
  // A length stop prints its one stderr line on every arm, failed runs
  // included: codemux.truncated says so in the block regardless.
  const notice = (verdict: RunResult): RunResult =>
    withTruncationNotice(verdict, "opencode", { messages: [], truncated: data.truncated });
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
    return notice({
      ...errorResult,
      usage: usage ?? emptyUsage(),
      servedModel: null,
      stderr: withBreakNote(errorResult.stderr),
    });
  }
  if (text.trim() === "") {
    const noReply = failed(
      result,
      "codemux: the opencode run printed no assistant text, " +
        "so this run reports no result",
      ""
    );
    return notice({
      ...noReply,
      usage: usage ?? emptyUsage(),
      servedModel: null,
      stderr: withBreakNote(noReply.stderr),
    });
  }
  return notice({
    ...result,
    stdout: text,
    usage: usage ?? emptyUsage(),
    servedModel: null,
    stderr: withBreakNote(result.stderr),
  });
}

/**
 * opencode, whole-capture shape: stdout should be the `--format json` event
 * lines the session driver parses (text parts, step_finish usage). The
 * launch path streams them instead (OpenCodePlainFold below, review ul4);
 * this function remains for callers that already hold the captured stdout,
 * and folds the same state through the same verdict.
 */
export function opencodePlainResult(result: RunResult): RunResult {
  return opencodeVerdict(result, openCodeResultData(result.stdout));
}

/** The whole-capture arm of OpenCodeResultData: folds an already captured
 * stdout through the same fold the streaming sink uses, for a caller that
 * reaches processRunResult without the context's sink. Empty stdout folds
 * to no wire evidence, exactly as the former empty-split early return
 * did. */
export function openCodeResultData(stdout: string): OpenCodeResultData {
  const state: OpenCodeFoldState = {
    knownSessionId: null,
    sawWire: false,
    text: "",
    textBytes: 0,
    usage: null,
    errorMessage: null,
    broken: [],
    brokenBytes: 0,
    brokenCount: 0,
    finalMessage: null,
    truncated: false,
    stepText: "",
  };
  const lines = stdout.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  for (const line of lines) foldOpenCodeLine(line, state);
  const { knownSessionId: _knownSessionId, textBytes: _textBytes, brokenBytes: _brokenBytes, stepText: _stepText, ...data } = state;
  return data;
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
    knownSessionId: null,
    sawWire: false,
    text: "",
    textBytes: 0,
    usage: null,
    errorMessage: null,
    broken: [],
    brokenBytes: 0,
    brokenCount: 0,
    finalMessage: null,
    truncated: false,
    stepText: "",
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
  /** Sees every chunk before an item event is dropped, so a canary
   * marker in tool output still reaches the hermetic check
   * (src/stream-marker-scan.ts). */
  private readonly markers = new StreamMarkerScan();

  push(chunk: string): void {
    if (!this.closed) this.markers.push(chunk);
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

  /** Canary marker matches anywhere in the stream, dropped events included. */
  droppedMarkerEvidence(): string {
    return this.markers.evidence();
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

  /** The fold's finished outcome for the `--result-json` envelope: closes
   * first exactly as verdict does, so the envelope and the plain reply are
   * read off one and the same folded state. */
  resultData(): OpenCodeResultData {
    this.close();
    const { knownSessionId: _knownSessionId, textBytes: _textBytes, brokenBytes: _brokenBytes, stepText: _stepText, ...data } = this.state;
    return data;
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
