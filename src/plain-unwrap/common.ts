/** Helpers shared by every plain-unwrap module: the reply spellings, the
 * JSON-shape test and failure wrapper, byte accounting, and the
 * usage-folding sink seam. src/plain-unwrap.ts owns the public surface. */
import { appendDiagnostic } from "../result-envelope.js";
import type { StdoutSink } from "../process-runner.js";
import type { ResultUsageBlock, RunResult } from "../types.js";

/** The plain-text spelling of a structured result: verbatim, plus one
 * trailing newline when non-empty and lacking one; empty stays empty. */
export function plainText(text: string): string {
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
export function codexPlainReply(message: string): string {
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
export const byteLength = (text: string): number => Buffer.byteLength(text);

/** The longest prefix of `text` whose UTF-8 encoding fits in `maxBytes`,
 * backing off any multibyte sequence the cut would split (round al31): the
 * prefix an oversized human-mode line is accounted with must stay
 * decodable — it becomes the partial output a capture-limit failure
 * reports, and a string the encoding cannot spell is no output at all. */
export function utf8BytePrefix(text: string, maxBytes: number): string {
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
export function diagnosticExcerpt(text: string): string {
  const flat = text.trim().replace(/\s+/g, " ");
  return flat.length <= 80 ? flat : `${flat.slice(0, 80)}…`;
}

export function failed(result: RunResult, diagnostic: string, stdout = result.stdout): RunResult {
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
export function jsonShapedStdout(stdout: string): boolean {
  if (stdout.trimStart().startsWith("{")) return true;
  try {
    JSON.parse(stdout);
    return true;
  } catch {
    return false;
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
