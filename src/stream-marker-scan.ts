/** Canary-marker evidence for the stdout folds of structured runs (lane
 * AN1, contracts review finding 1). A plain or hermetic-check run that
 * reads a structured stream prints the assembled answer, and its fold
 * sheds tool results, tool inputs, and every other event the answer never
 * reads. The hermetic check scans `scanSurface ?? stdout` for the planted
 * marker (src/check-command.ts), so a marker that rode only a shed tool
 * result would vanish from the verdict: the run would be certified clean.
 *
 * `StreamMarkerScan` sees every byte the harness wrote, before any fold
 * decides a line's fate, and keeps each distinct marker match with
 * bounded context. Scanning the whole stream, not only the shed lines,
 * keeps the rule independent of each fold's keep/drop logic: no fold can
 * shed a line the scan did not read. `withStreamScanSurface` joins the
 * capture, the printed answer, and that evidence into the run's
 * scanSurface. */
import { CANARY_MARKER_PATTERN } from "./hermetic-canary.js";
import type { StdoutSink } from "./process-runner.js";
import type { RunResult } from "./types.js";

/** Context kept on each side of a match, and the tail carried between
 * chunks (longer than a marker, so a marker split across chunks is seen). */
const CONTEXT_CHARS = 64;
/** Distinct markers kept; one is enough for a leak verdict. */
const MAX_DISTINCT = 1024;

export class StreamMarkerScan {
  private carry = "";
  private readonly found = new Map<string, string>();

  /** Scans one stdout chunk, in arrival order. */
  push(chunk: string): void {
    const text = this.carry + chunk;
    const pattern = new RegExp(CANARY_MARKER_PATTERN.source, "g");
    for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
      // A match that ends inside the carry was recorded on the last push.
      if (match.index + match[0].length <= this.carry.length) continue;
      if (this.found.has(match[0]) || this.found.size >= MAX_DISTINCT) continue;
      this.found.set(match[0],
        text.slice(Math.max(0, match.index - CONTEXT_CHARS), match.index + match[0].length + CONTEXT_CHARS));
    }
    this.carry = text.length <= CONTEXT_CHARS ? text : text.slice(-CONTEXT_CHARS);
  }

  /** Every distinct match with its context, one per line. */
  evidence(): string {
    return [...this.found.values()].join("\n");
  }
}

/** A sink that reports the markers it saw (the folds that hold a
 * StreamMarkerScan, AnswerStreamFold in answer-stream-fold.ts, and the
 * kimi fold in plain-unwrap/kimi-fold.ts). */
interface MarkerEvidenceSink {
  droppedMarkerEvidence(): string;
}

function hasMarkerEvidence(sink: StdoutSink | undefined): sink is StdoutSink & MarkerEvidenceSink {
  return typeof (sink as Partial<MarkerEvidenceSink> | undefined)?.droppedMarkerEvidence === "function";
}

/** The marker evidence of a run's sink, or "" for a sink that keeps none. */
export function sinkMarkerEvidence(sink: StdoutSink | undefined): string {
  return hasMarkerEvidence(sink) ? sink.droppedMarkerEvidence() : "";
}

/** The processed result with a scanSurface covering the whole run: the
 * captured stdout (the fold's kept lines, or the whole stream when no fold
 * ran), the printed answer when processing replaced stdout, and the sink's
 * marker evidence. A scanSurface the adapter already set (an experiment
 * run's trace) is kept, and a result whose stdout is the unchanged
 * capture with no evidence beside it gets none (stdout is the record). */
export function withStreamScanSurface(
  processed: RunResult,
  captured: string,
  sink: StdoutSink | undefined
): RunResult {
  if (processed.scanSurface !== undefined) return processed;
  const evidence = sinkMarkerEvidence(sink);
  // Stdout is the whole record already: the check's default scan covers it.
  if (processed.stdout === captured && evidence === "") return processed;
  const parts = [captured];
  if (processed.stdout !== captured) parts.push(processed.stdout);
  if (evidence !== "") parts.push(evidence);
  return { ...processed, scanSurface: parts.join("\n") };
}
