/** A line fold for JSONL wires whose answer lives in a few event kinds
 * (droid, goose, and pi structured streams; lane AN1). Plain runs now
 * launch on the structured stream so every assistant message reaches the
 * answer, but those streams also carry every tool call and tool result:
 * captured whole, an agentic run's stream could cross the 16 MiB capture
 * bound that the text output never approached. The fold keeps the lines
 * the answer parser reads and sheds the rest as they arrive, deciding a
 * line's fate from its opening bytes so a shed line is never held whole.
 *
 * Shed bytes leave the capture but are still scanned for planted canary
 * markers (the kimi fold's rule, review round 17): `droppedMarkerEvidence`
 * joins every match with bounded context, and the adapters append it to
 * the run's scanSurface so a leak in a shed tool payload still reaches the
 * hermetic check's verdict. */
import { CANARY_MARKER_PATTERN } from "./hermetic-canary.js";
import { MAX_CAPTURE_BYTES, type StdoutSink } from "./process-runner.js";

/** What a line's opening says: keep it, shed it, or read more first. */
export type LineFate = "keep" | "drop" | "undecided";

const byteLength = (text: string): number => Buffer.byteLength(text);
/** How much of a partial line the classifier sees before it must decide. */
const HEAD_CHARS = 512;
const EVIDENCE_CAP_BYTES = 64 * 1024;

export class AnswerStreamFold implements StdoutSink {
  private kept = "";
  private keptByteCount = 0;
  private buffer = "";
  private bufferBytes = 0;
  /** True while the rest of the current line is being shed. */
  private shedding = false;
  private carry = "";
  private evidence: string[] = [];
  private evidenceBytes = 0;
  private closed = false;

  /** `classify` reads a line's opening (at least HEAD_CHARS characters,
   * or the whole line when it is shorter) and decides its fate; a line it
   * cannot place is kept. */
  constructor(private readonly classify: (head: string, complete: boolean) => LineFate) {}

  push(chunk: string): void {
    if (this.closed) return;
    let start = 0;
    for (;;) {
      const newline = chunk.indexOf("\n", start);
      const piece = newline === -1 ? chunk.slice(start) : chunk.slice(start, newline);
      if (this.shedding) {
        this.scan(piece);
      } else {
        this.buffer += piece;
        this.bufferBytes += byteLength(piece);
        if (newline === -1 && this.buffer.length >= HEAD_CHARS &&
            this.classify(this.buffer.slice(0, HEAD_CHARS), false) === "drop") {
          this.shedding = true;
          this.scan(this.buffer);
          this.buffer = "";
          this.bufferBytes = 0;
        }
      }
      if (newline === -1) return;
      this.endLine(true);
      start = newline + 1;
    }
  }

  private endLine(terminated: boolean): void {
    if (this.shedding) {
      this.shedding = false;
      this.carry = "";
      return;
    }
    const line = this.buffer;
    this.buffer = "";
    this.bufferBytes = 0;
    if (line === "" && !terminated) return;
    if (this.classify(line.slice(0, HEAD_CHARS), true) === "drop") {
      this.carry = "";
      this.scan(line);
      this.carry = "";
      return;
    }
    const text = terminated ? `${line}\n` : line;
    this.kept += text;
    this.keptByteCount += byteLength(text);
  }

  private scan(fragment: string): void {
    const text = this.carry + fragment;
    const match = CANARY_MARKER_PATTERN.exec(text);
    if (match !== null && this.evidenceBytes < EVIDENCE_CAP_BYTES) {
      const evidence = text.slice(Math.max(0, match.index - 64), match.index + match[0].length + 64);
      this.evidence.push(evidence);
      this.evidenceBytes += byteLength(evidence);
    }
    this.carry = text.length <= 64 ? text : text.slice(-64);
  }

  keptBytes(): number {
    return this.keptByteCount + (this.shedding ? 0 : Math.min(this.bufferBytes, MAX_CAPTURE_BYTES + 1));
  }

  finish(): string {
    if (!this.closed) {
      this.closed = true;
      if (this.buffer !== "" || this.shedding) this.endLine(false);
    }
    return this.kept;
  }

  /** Canary marker matches found in shed lines, joined as scan text. */
  droppedMarkerEvidence(): string {
    return this.evidence.join("\n");
  }
}

/** The scan contribution of a run's sink: the fold's shed-line evidence,
 * or "" for any other sink. */
export function answerFoldScanEvidence(sink: StdoutSink | undefined): string {
  return sink instanceof AnswerStreamFold ? sink.droppedMarkerEvidence() : "";
}

/** Whether a JSON line's opening starts with one of `prefixes`, after the
 * optional leading whitespace a writer may emit. */
export function opensWith(head: string, prefixes: readonly string[]): boolean {
  const trimmed = head.trimStart();
  return prefixes.some((prefix) => trimmed.startsWith(prefix));
}
