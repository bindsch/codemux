/** The kimi plain-run streaming fold: the `--output-format stream-json`
 * event stream fed chunk by chunk under the capture bound.
 * src/plain-unwrap.ts owns the public surface and the module overview. */
import { CANARY_MARKER_PATTERN } from "../hermetic-canary.js";
import { MAX_CAPTURE_BYTES, type StdoutSink } from "../process-runner.js";
import { byteLength, utf8BytePrefix } from "./common.js";
import { payloadOpening, toolPayloadLine, wireShapedLine } from "./kimi-fold-lines.js";

/** Bytes of the offending line the capture-limit failure reports: enough
 * to name the line, never a second capture bound to babysit. */
const OVERFLOW_EVIDENCE_BYTES = 512;

/**
 * kimi, streaming shape: every plain run asks for the stream-json wire
 * (the result-json launch's own flag), so its stdout carries every tool's
 * result payload on the `tool` event lines and every tool call's input on
 * the tool-calls-only assistant lines — volume an agentic run pushes past
 * the 16 MiB capture bound, dying at exit 125 with the reply lost. The
 * launcher feeds the stream to this fold chunk by chunk instead; the fold
 * keeps, verbatim, only the lines the plain unwrap reads (assistant text —
 * a mixed line carrying text and tool calls keeps its text with the calls
 * dropped, toolPayloadLine below — meta lines — the resume hint names the
 * session whose wire log carries the usage — error events, and anything
 * the parser would reject, so a broken wire still fails downstream
 * identically) and drops the tool
 * payloads as they arrive, so no volume of tool output can reach the
 * bound. What is shed is still scanned for planted canary markers
 * (droppedMarkerEvidence): the hermetic check's leak scan must cover the
 * whole output the harness printed, dropped tool payloads included.
 * `--result-json` runs do not use the fold: their envelope carries
 * the full events array by design, so they capture whole and answer to
 * the bound the whole-capture path always had.
 *
 * The stream's regime is decided once, by the first non-empty line
 * (wireShapedLine above — the hatch's own rule, applied at the same
 * place): wire-shaped is the wire for the stream's whole length, anything
 * else is verbatim passthrough kept in `raw` (the hatch a binary that
 * ignored the flag needs, the 2.3.2 bullet spelling included), and
 * nothing later flips it. The verbatim bytes are kept only while the
 * regime is undecided or the hatch's.
 *
 * One rule for a KEPT line past the capture bound, whatever the regime
 * and whatever the event's type: the run fails with the capture-limit
 * failure, exit 125 — the sticky latch `overflowed` answering
 * MAX_CAPTURE_BYTES + 1 to every keptBytes poll the runner makes, push
 * folding nothing after the drop, close() folding no tail. The check runs
 * at both moments the fold can meet such a line — mid-accumulation (the
 * partial line outgrew the bound) and complete in one chunk — and the
 * buffered partial line is never in the residue check on the wire side,
 * for the same bytes cross the bound at different partial heights under
 * different chunkings. A TOOL payload past the bound is the exception
 * (review round 20, edges finding 1): one large tool result used to abort
 * a plain run before the fold could shed it, losing the reply that
 * followed. The fold classifies such a line by its streamed opening
 * (payloadOpening: the pinned writer opens every payload with its role)
 * and sheds it without ever holding it whole — the already-buffered
 * prefix and each further chunk are scanned for planted canary markers
 * and dropped — so keptBytes never sees the payload and the reply after
 * it survives. Only a line the plain verdict would read is subject to
 * the bound.
 *
 * `finish()` answers what kimiPlainResult parses unchanged: the hatch's
 * verbatim bytes, or the kept lines re-emitted as JSONL — a subset of the
 * original stream the downstream parser consumes exactly as the whole
 * capture (dropped lines were ones it would have ignored). A wire stream
 * that kept nothing readable (tool payloads only, or blank lines only)
 * still answers its first line, so the wire stays proven and the run
 * fails downstream as "no assistant reply" instead of slipping through
 * the hatch as plain text.
 */
export class KimiPlainFold implements StdoutSink {
  /** "wire" or "text", set by the first non-empty line; null while only
   * blank lines have arrived. */
  private mode: "wire" | "text" | null = null;
  /** The wire lines kept verbatim, in arrival order. */
  private readonly kept: string[] = [];
  /** UTF-8 bytes of the kept lines (each counted with its re-emitted
   * newline, except a final line the stream never terminated: it is
   * re-emitted without one and charged without one, the byte-for-byte rule
   * the hatch's tail already keeps), maintained with every keep so
   * keptBytes never re-measures a growing list. */
  private keptLineBytes = 0;
  /** Whether the last kept line was newline-terminated; only the stream's
   * final line can lack one. */
  private keptLastTerminated = true;
  /** The line that committed the stream to the wire: the finish-time
   * anchor while no non-blank line has been kept. */
  private firstWireLine: string | null = null;
  /** Whether the anchor line was newline-terminated (an unterminated
   * single-line stream anchors on its tail). */
  private firstWireLineTerminated = true;
  /** Whether the anchor's bytes are already in keptBytes. */
  private anchorCounted = false;
  /** Whether any non-blank line was kept: only that releases the anchor
   * (a blank line kept is not content — review round 10, edges 3). */
  private keptNonBlank = false;
  /** Verbatim stdout for the hatch, kept only while the regime is
   * undecided or the hatch's. */
  private raw = "";
  /** UTF-8 bytes of `raw`, maintained alongside it. */
  private rawBytes = 0;
  /** The partial line the chunks have not terminated yet. */
  private buffer = "";
  /** UTF-8 bytes of `buffer`, maintained with every mutation. */
  private bufferBytes = 0;
  /** The resume-hint state threaded across wire lines. */
  private sessionId: string | null = null;
  /** A line past the capture bound was dropped: the run fails at the
   * capture limit. Sticky — keptBytes answers MAX_CAPTURE_BYTES + 1 from
   * the moment it trips. */
  private overflowed = false;
  /** The first bytes of the line that tripped the capture bound, kept for
   * the failure message: without them the 125 says only that some line
   * passed 16 MiB, and the run's killer — one runaway event — is
   * nameless (lane C30, item 2). Set once, at the drop. */
  private overflowLinePrefix: string | null = null;
  /** The line's UTF-8 bytes at the latch: exact for a complete line, the
   * bytes streamed so far for a partial one (`final` false — the latch
   * stops folding, so the rest never counts). */
  private overflowLineBytes = 0;
  private overflowLineFinal = false;
  private closed = false;
  /** Inside a tool payload past the capture bound whose remainder streams
   * away chunk by chunk (discardOversizedPayload): push feeds those chunks
   * to the canary scan directly until the payload's newline. */
  private discarding = false;
  /** The trailing characters of the discard stream, so a canary marker
   * split across chunks — and the context around it — still matches. */
  private discardCarry = "";
  /** Evidence that a shed payload carried a planted canary marker: the
   * match with a little context around it, one entry per shed text. The
   * capture bound never applies to this list — it holds only matched
   * fragments, each bounded below, however much payload was shed. */
  private readonly canaryEvidence: string[] = [];
  /** Bytes held in canaryEvidence, capped at CANARY_EVIDENCE_CAP_BYTES:
   * one match already decides the leak verdict, so the rest is context. */
  private canaryEvidenceBytes = 0;
  /** The evidence list's bound: past it the fold stops recording (one
   * match decides the verdict; the overflow already failed the run for a
   * line the scan never saw). */
  private static readonly CANARY_EVIDENCE_CAP_BYTES = 4096;

  push(chunk: string): void {
    if (this.closed || this.overflowed) return;
    if (this.discarding) {
      // Still inside a line this fold shed without holding: everything up
      // to its newline is scanned and dropped, and the remainder of the
      // chunk folds normally once the line ends.
      const newline = chunk.indexOf("\n");
      if (newline === -1) {
        this.feedDiscard(chunk);
        return;
      }
      this.feedDiscard(chunk.slice(0, newline));
      this.discarding = false;
      this.discardCarry = "";
      chunk = chunk.slice(newline + 1);
      if (chunk === "") return;
    }
    this.bufferBytes += byteLength(chunk);
    // The buffered partial line carries no newline — every exit below
    // leaves it that way — so the boundary search runs over the newly
    // arrived chunk alone (the shared fold rule).
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
      // The completed line is size-checked before it is folded, and the
      // drop returns from push at once: the latch owns everything after
      // the line.
      const lineBytes = byteLength(line);
      if (lineBytes > MAX_CAPTURE_BYTES) {
        // A line whose opening proves it a tool payload is shed from its
        // prefix instead (review round 20, edges finding 1): the folding
        // continues past it.
        if (this.mode !== "text" && payloadOpening(line)) {
          this.discardOversizedPayload(line, false);
          continue;
        }
        this.dropOversizedLine(line, lineBytes, true);
        return;
      }
      this.takeLine(line, true);
      if (this.overflowed) return;
    }
    if (this.bufferBytes > MAX_CAPTURE_BYTES) {
      // The partial line outgrew the bound. A tool payload's opening sheds
      // it here too — the remainder streams through feedDiscard chunk by
      // chunk and never rejoins the buffer — while every kept shape keeps
      // the latch.
      if (this.mode !== "text" && payloadOpening(this.buffer)) {
        this.discardOversizedPayload(this.buffer, true);
      } else {
        this.dropOversizedLine(this.buffer, this.bufferBytes, false);
      }
    }
  }

  /** Sheds one line past the capture bound whose streamed opening proved
   * it a tool payload (payloadOpening): the bytes are scanned for planted
   * canary markers and dropped, never held whole and never charged to
   * keptBytes. `continues` marks a partial line still arriving: its
   * remainder streams through feedDiscard until the newline, chunk by
   * chunk, instead of joining the buffer; a complete payload line scans
   * and is done. When nothing has committed the stream's regime yet, a
   * bounded error event anchors the wire proof in place of the whole line
   * this fold refused to hold: finish() answers it only when nothing
   * readable was kept. The anchor is a COMPLETE wire line, not the cut
   * excerpt it replaces — a line that does not parse no longer proves
   * the wire (kimiWireShapedLine, lane C30, item 3), so the excerpt
   * would slip the run through the plain hatch as a silent success. The
   * error event parses, carries the error type the wire spells, and
   * fails the downstream verdict with a message that names what
   * happened. */
  private discardOversizedPayload(text: string, continues: boolean): void {
    if (this.mode === null) {
      this.mode = "wire";
      this.firstWireLine = JSON.stringify({
        type: "error",
        message: "codemux: shed an oversized tool payload; no complete line arrived",
      });
      this.firstWireLineTerminated = false;
      this.raw = "";
      this.rawBytes = 0;
    }
    this.feedDiscard(text);
    if (continues) {
      this.buffer = "";
      this.bufferBytes = 0;
      this.discarding = true;
    } else {
      this.discardCarry = "";
    }
  }

  /** The one treatment for a KEPT line past the capture bound: the latch,
   * and nothing else. Fires at either moment the fold can meet such a
   * line — mid-accumulation (the partial line outgrew the bound, push's
   * trailing check) or complete in one chunk — so the offending line's
   * first bytes and its count are recorded before the buffer goes. A tool
   * payload past the bound never reaches this: its opening sheds it
   * (discardOversizedPayload). After the latch, keptBytes answers over
   * the bound for good, push folds nothing further, and close() folds no
   * tail. */
  private dropOversizedLine(line: string, bytes: number, final: boolean): void {
    this.overflowLinePrefix = utf8BytePrefix(line, OVERFLOW_EVIDENCE_BYTES);
    this.overflowLineBytes = bytes;
    this.overflowLineFinal = final;
    this.buffer = "";
    this.bufferBytes = 0;
    this.overflowed = true;
  }

  /** The line that tripped the capture bound — its first bytes (at most
   * OVERFLOW_EVIDENCE_BYTES of UTF-8) and its byte count at the latch —
   * or null when no single line tripped it (a cumulative overflow of many
   * kept lines keeps no evidence: no one line is the offender). */
  overflowLineEvidence(): { prefix: string; bytes: number; final: boolean } | null {
    return this.overflowLinePrefix === null
      ? null
      : { prefix: this.overflowLinePrefix, bytes: this.overflowLineBytes, final: this.overflowLineFinal };
  }

  keptBytes(): number {
    if (this.overflowed) return MAX_CAPTURE_BYTES + 1;
    // What the fold can still return: the kept wire lines, or the hatch's
    // verbatim bytes — buffered tail included, for it becomes raw
    // byte-for-byte — while the regime is undecided or the hatch's. The
    // wire regime's buffer is a line on its way to being classified and
    // dropped or kept; counting it is what killed runs whose tool output
    // arrived as one long line.
    return this.mode === "wire" ? this.keptLineBytes : this.rawBytes + this.bufferBytes;
  }

  finish(): string {
    this.close();
    if (this.mode !== "wire") return this.raw;
    // Blank lines kept alone prove nothing about the wire (a dropped
    // first tool event followed by a blank line used to answer "\n",
    // which the plain hatch read as empty output and reported as
    // success), so the anchor answers until a non-blank line was kept.
    if (this.kept.length > 0 && this.keptNonBlank) {
      return this.kept
        .map((line, index) =>
          index === this.kept.length - 1 && !this.keptLastTerminated ? line : `${line}\n`)
        .join("");
    }
    // A wire that kept nothing readable (tool payloads only, or blank
    // lines only) still proves the wire: the committing line answers in
    // its place, counted against the bound here exactly as the runner's
    // post-finish check reads it — without a newline the stream never
    // sent, like the kept tail above.
    if (this.firstWireLine !== null && !this.anchorCounted) {
      this.keptLineBytes += byteLength(this.firstWireLine) + (this.firstWireLineTerminated ? 1 : 0);
      this.anchorCounted = true;
    }
    if (this.firstWireLine === null) return "";
    return this.firstWireLineTerminated ? `${this.firstWireLine}\n` : this.firstWireLine;
  }

  private close(): void {
    if (this.closed) return;
    this.closed = true;
    if (!this.overflowed && this.buffer !== "") {
      // A stream can end mid-line (the write was cut) or without the final
      // newline; folding the tail as a line matches the whole-capture
      // split. A latched fold folds nothing: its answer was decided at
      // the drop.
      this.takeLine(this.buffer, false);
    }
    this.buffer = "";
    this.bufferBytes = 0;
  }

  private takeLine(line: string, terminated: boolean): void {
    // The regime is decided by the first non-empty line and never
    // revisited: blank lines alone commit nothing.
    if (this.mode === null && line.trim() !== "") this.decideMode(line, terminated);
    if (this.mode !== "wire") {
      // Undecided (blank lines so far) or the hatch: the bytes are kept
      // verbatim, the tail byte-for-byte (no newline the stream never
      // sent).
      const incoming = terminated ? `${line}\n` : line;
      const room = Math.max(0, MAX_CAPTURE_BYTES - this.rawBytes);
      const bytes = byteLength(incoming);
      const retained = bytes > room ? utf8BytePrefix(incoming, room) : incoming;
      this.raw += retained;
      this.rawBytes += byteLength(retained);
      if (bytes > room) this.overflowed = true;
      return;
    }
    const verdict = toolPayloadLine(line, this.sessionId);
    this.sessionId = verdict.sessionId;
    if (verdict.droppedText !== undefined) this.scanDroppedPayload(verdict.droppedText);
    if (verdict.drop) return;
    const kept = verdict.keptLine ?? line;
    this.kept.push(kept);
    this.keptLastTerminated = terminated;
    // The re-emitted newline, charged only when the stream sent one: a
    // tail without it is re-emitted without it, so a record exactly at the
    // bound passes here exactly as the whole-capture path accepts it
    // (review round 12, edges 4).
    this.keptLineBytes += byteLength(kept) + (terminated ? 1 : 0);
    // The anchor's job ended the moment a NON-BLANK line was kept:
    // finish() answers kept content, so holding the committing line
    // would pin its bytes (a dropped first tool event can sit at the
    // whole capture bound) beyond the residue keptBytes reports (review
    // round 8, edges). A blank line kept is not content — it releases
    // nothing (review round 10, edges 3), so a wire whose kept lines
    // are all blank still answers the anchor and fails downstream as
    // "no assistant reply" instead of slipping through the hatch.
    if (line.trim() !== "") {
      this.keptNonBlank = true;
      this.firstWireLine = null;
    }
    if (this.keptLineBytes > MAX_CAPTURE_BYTES) this.overflowed = true;
  }

  /** Scans one shed text for a planted canary marker and records the
   * match. The capture bound is enforced on KEPT bytes only; this scan is
   * the dropped bytes' compensation, so a marker that appears only in a
   * tool result — exactly the payload this fold sheds — still reaches the
   * canary verdict through droppedMarkerEvidence (review round 17,
   * contracts-2 1: the adapter's scanSurface once missed it, and a
   * harness printing the planted marker was certified clean). */
  private scanDroppedPayload(text: string): void {
    const match = CANARY_MARKER_PATTERN.exec(text);
    if (match !== null) this.recordCanaryEvidence(text, match);
  }

  /** Feeds one fragment of a payload this fold sheds without holding:
   * scanned like a shed line, but the fragment's tail rides as carry so a
   * marker split across chunk boundaries — and the context around it —
   * still matches (review round 20, edges finding 1: the bytes stream
   * now, so no whole text ever carries the boundary). */
  private feedDiscard(fragment: string): void {
    const text = this.discardCarry + fragment;
    const match = CANARY_MARKER_PATTERN.exec(text);
    if (match !== null) this.recordCanaryEvidence(text, match);
    this.discardCarry = text.length <= 64 ? text : text.slice(-64);
  }

  /** The match plus bounded context, never the payload's volume: a shed
   * line can be megabytes, and the evidence must stay small whatever the
   * stream shed. */
  private recordCanaryEvidence(text: string, match: RegExpExecArray): void {
    if (this.canaryEvidenceBytes >= KimiPlainFold.CANARY_EVIDENCE_CAP_BYTES) return;
    const start = Math.max(0, match.index - 64);
    const end = Math.min(text.length, match.index + match[0].length + 64);
    const evidence = text.slice(start, end);
    this.canaryEvidence.push(evidence);
    this.canaryEvidenceBytes += byteLength(evidence);
  }

  /** Every canary marker match found in shed payloads, joined as scan
   * text. The adapter appends this to its scanSurface so
   * evaluateCanary's full-output scan sees what the fold dropped. */
  droppedMarkerEvidence(): string {
    return this.canaryEvidence.join("\n");
  }

  /** Commit the stream to its regime from the first non-empty line: a
   * wire-shaped line is the wire — the launch always asked for
   * stream-json, so a binary that honored the flag prints it here — and
   * anything else is the hatch, verbatim passthrough for the stream's
   * whole remaining length. The commitment to wire frees the bytes the
   * hatch had kept (blank lines, at most). */
  private decideMode(line: string, terminated: boolean): void {
    if (wireShapedLine(line)) {
      this.mode = "wire";
      this.firstWireLine = line;
      this.firstWireLineTerminated = terminated;
      this.raw = "";
      this.rawBytes = 0;
    } else {
      this.mode = "text";
    }
  }
}

/** The leak-scan contribution of a run's stdout sink: a streamed plain
 * run's stdout is the fold's KEPT subset, so markers printed only in the
 * shed tool payloads ride the fold's evidence instead (review round 17,
 * contracts-2 1: a marker in a tool result was missed and the run
 * certified clean). Any other sink — none, or a plain capture — shed
 * nothing and contributes "". */
export function foldScanEvidence(sink: StdoutSink | undefined): string {
  return sink instanceof KimiPlainFold ? sink.droppedMarkerEvidence() : "";
}

/** The capture-limit evidence of a streamed plain run's sink (the fold's
 * offending line, when one single line tripped the bound); any other sink
 * — none, a plain capture, an experiment sink — answers null, and the
 * failure keeps the capture limit's own message. */
export function foldOverflowEvidence(
  sink: StdoutSink | undefined
): { prefix: string; bytes: number; final: boolean } | null {
  return sink instanceof KimiPlainFold ? sink.overflowLineEvidence() : null;
}
