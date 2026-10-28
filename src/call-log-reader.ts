import { closeSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import type { CallRecord } from "./call-log.js";

/** Reads never look beyond the log's last 16 MiB. */
export const MAX_CALL_LOG_BYTES = 16 * 1024 * 1024;

/** One JSONL line from the ledger, parsed or not. */
export interface CallLogEntry {
  /** The raw line as it appears in the file. */
  line: string;
  /** The parsed record, or null when the line is not one. */
  record: CallRecord | null;
}

export interface CallLogContents {
  /** Entries in file order (oldest first). */
  entries: CallLogEntry[];
  /** Lines that did not parse as call records. */
  malformed: number;
  /** True when only the last 16 MiB was read because the file is larger. */
  truncated: boolean;
}

const CALL_RECORD_KINDS: ReadonlySet<string> = new Set([
  "run",
  "check",
  "session_turn",
  "session",
]);

function isCount(value: unknown): boolean {
  return value === null || (typeof value === "number" && Number.isFinite(value));
}

function isStringOrNull(value: unknown): boolean {
  return value === null || typeof value === "string";
}

function isLabels(value: unknown): boolean {
  return value === undefined || value === null || (
    typeof value === "object" && !Array.isArray(value) &&
    Object.values(value).every((item) => typeof item === "string")
  );
}

/** The full flat shape, not a lenient three-field check: a line that
 * parses as JSON and names `ts`/`agent`/`kind` but misses `usage` (or
 * carries a wrong-typed field) is not a record, and every consumer that
 * trusts the shape — the table's columns, the totals — would crash on
 * the missing half (review ul2). Wrong-shaped lines are malformed like
 * unparseable ones: skipped and counted, never fatal. */
function isCallRecord(parsed: unknown): parsed is CallRecord {
  if (typeof parsed !== "object" || parsed === null) return false;
  const record = parsed as Record<string, unknown>;
  if (typeof record["ts"] !== "string") return false;
  if (
    typeof record["kind"] !== "string" ||
    !CALL_RECORD_KINDS.has(record["kind"])
  ) {
    return false;
  }
  if (typeof record["agent"] !== "string") return false;
  if (!isStringOrNull(record["model"])) return false;
  if (!isStringOrNull(record["model_effective"])) return false;
  if (typeof record["provider"] !== "string") return false;
  if (!isStringOrNull(record["session_id"])) return false;
  if (!isStringOrNull(record["turn_id"])) return false;
  if (!isStringOrNull(record["finish"])) return false;
  if (!isStringOrNull(record["autonomy"])) return false;
  if (typeof record["hermetic"] !== "boolean") return false;
  if (typeof record["sandboxed"] !== "boolean") return false;
  if (!isCount(record["exit_code"])) return false;
  if (
    typeof record["duration_ms"] !== "number" ||
    !Number.isFinite(record["duration_ms"]) ||
    record["duration_ms"] < 0
  ) {
    return false;
  }
  if (typeof record["cwd"] !== "string") return false;
  if (!isLabels(record["labels"])) return false;
  const usage = record["usage"];
  if (typeof usage !== "object" || usage === null) return false;
  const counts = usage as Record<string, unknown>;
  return (
    isCount(counts["input_tokens"]) &&
    isCount(counts["output_tokens"]) &&
    isCount(counts["cached_input_tokens"]) &&
    isCount(counts["total_tokens"]) &&
    isCount(counts["cost_usd"])
  );
}

/**
 * Reads the ledger, bounded to its last 16 MiB (the tail is the newest
 * data, and a multi-gigabyte ledger must not be loaded whole). A window
 * that starts mid-line drops the partial line the cut made; one that
 * starts exactly on a record boundary keeps the complete record there —
 * no complete record is ever dropped for the bound (review ul6). Lines are
 * paired with their parsed record so a caller can show raw lines
 * (`calls --json`) and parsed fields from the same pass; a line that does
 * not parse, or parses to something without the record's shape, is
 * skipped and counted, never fatal. Throws on read errors
 * (absent file, not a regular file); callers report those. Invalid UTF-8
 * is not one of them: the bytes decode with replacement characters, so
 * the affected lines simply land in `malformed`.
 */
export function readCallLog(path: string): CallLogContents {
  const size = statSync(path).size;
  let text: string;
  let truncated = false;
  if (size <= MAX_CALL_LOG_BYTES) {
    text = readFileSync(path, "utf8");
  } else {
    const cut = size - MAX_CALL_LOG_BYTES;
    const fd = openSync(path, "r");
    try {
      const buffer = Buffer.alloc(MAX_CALL_LOG_BYTES);
      let read = 0;
      while (read < buffer.length) {
        const n = readSync(fd, buffer, read, buffer.length - read, cut + read);
        if (n === 0) break;
        read += n;
      }
      text = buffer.toString("utf8");
      // The read may have started mid-line, in which case the window's
      // first line is the one the bounded read cut and is dropped. But the
      // byte BEFORE the cut decides that, not an unconditional drop: a cut
      // landing exactly on a record boundary (that byte a newline) leaves
      // a complete record at the front of the window, and dropping through
      // the first newline anyway discarded it (review ul6).
      const prelude = Buffer.alloc(1);
      const n = readSync(fd, prelude, 0, 1, cut - 1);
      if (n !== 1 || prelude[0] !== 0x0a) {
        const firstNewline = text.indexOf("\n");
        text = firstNewline === -1 ? "" : text.slice(firstNewline + 1);
      }
    } finally {
      closeSync(fd);
    }
    truncated = true;
  }
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const entries: CallLogEntry[] = [];
  let malformed = 0;
  for (const line of lines) {
    let record: CallRecord | null = null;
    try {
      const parsed: unknown = JSON.parse(line);
      if (isCallRecord(parsed)) record = { ...parsed, labels: parsed.labels ?? null };
    } catch {
      // A hand-edited or truncated line; counted below.
    }
    if (record === null) malformed++;
    entries.push({ line, record });
  }
  return { entries, malformed, truncated };
}
