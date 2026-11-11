/** A stdout fold for a JSONL wire whose tool payloads would otherwise ride
 * the capture (lane AN1): gemini and qwen runs read their stream-json wire
 * for the complete answer, and that wire also carries every tool result.
 * A line whose opening names a dropped kind is shed as it streams, never
 * held whole; a dropped kind may leave a short marker line in its place
 * (a tool call is a message boundary the answer parser reads). Every other
 * line is kept, optionally rewritten once complete (`shrink`), so the
 * parser sees what a whole capture would give it minus the payloads.
 * Every chunk is scanned for canary markers before any line is shed
 * (src/stream-marker-scan.ts), so a marker that rode a dropped tool
 * result still reaches the hermetic check through the run's scanSurface. */
import type { StdoutSink } from "./process-runner.js";
import { StreamMarkerScan } from "./stream-marker-scan.js";

export interface DropRule {
  /** The exact line opening, in the writer's own key order. */
  opening: string;
  /** The line kept in place of a dropped one, or null for none. */
  marker: string | null;
}

export class StreamDropFold implements StdoutSink {
  private kept = "";
  private partial = "";
  private keptByteCount = 0;
  private partialBytes = 0;
  private dropping: DropRule | null = null;
  private readonly markers = new StreamMarkerScan();

  constructor(
    private readonly rules: readonly DropRule[],
    private readonly shrink: (line: string) => string = (line) => line
  ) {}

  push(chunk: string): void {
    this.markers.push(chunk);
    let rest = chunk;
    while (rest.length > 0) {
      const newline = rest.indexOf("\n");
      const piece = newline === -1 ? rest : rest.slice(0, newline);
      rest = newline === -1 ? "" : rest.slice(newline + 1);
      if (this.dropping === null) {
        this.partial += piece;
        this.partialBytes += Buffer.byteLength(piece);
        const rule = this.rules.find((candidate) => this.partial.startsWith(candidate.opening));
        if (rule !== undefined) {
          this.dropping = rule;
          this.partial = "";
          this.partialBytes = 0;
        }
      }
      if (newline !== -1) this.endLine("\n");
    }
  }

  private endLine(terminator: string): void {
    let line = "";
    if (this.dropping !== null) {
      if (this.dropping.marker !== null) line = `${this.dropping.marker}${terminator}`;
    } else {
      line = `${this.shrink(this.partial)}${terminator}`;
    }
    this.kept += line;
    this.keptByteCount += Buffer.byteLength(line);
    this.partial = "";
    this.partialBytes = 0;
    this.dropping = null;
  }

  finish(): string {
    if (this.partial !== "" || this.dropping !== null) this.endLine("");
    return this.kept;
  }

  /** Canary marker matches anywhere in the stream, shed lines included. */
  droppedMarkerEvidence(): string {
    return this.markers.evidence();
  }

  keptBytes(): number {
    // Until a line can be dropped, its unfinished bytes occupy capture
    // memory and must count toward the same limit as complete lines.
    return this.keptByteCount + this.partialBytes;
  }
}
