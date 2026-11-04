import { closeSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import type { CallRecord } from "./call-log.js";
import { parseLabels, validateLabelKey } from "./labels.js";

/** Reads never look beyond the log's last 16 MiB. */
export const MAX_CALL_LOG_BYTES = 16 * 1024 * 1024;

/** The ledger's line bound, shared by the writer and the reader. The
 * writer refuses a record whose line exceeds it (one stderr note, never
 * a silent gap); the reader counts and skips a line that long without
 * ever holding it, so memory stays bounded whatever the file holds. It
 * matches the process-capture bound (`MAX_CAPTURE_BYTES` in
 * process-capture.ts), so no single harness-reported string can exceed
 * it; a record combining several near-bound strings still can, and the
 * writer's refusal — not the reader's silent skip — is what names it. */
export const MAX_CALL_LOG_LINE_BYTES = 16 * 1024 * 1024;
const STREAM_CHUNK_BYTES = 64 * 1024;

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
  /** Lines with malformed records or labels. Records with invalid labels are retained. */
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

// Lines older than the field carry no cost_source (read as null, a cost
// with no claim); anything but these three strings, or null, is a
// wrong-shaped line (audit round 2, B5).
const COST_SOURCES: ReadonlySet<string> = new Set([
  "billed",
  "harness-estimate",
  "subscription-zero",
]);

// Token counts are whole, never negative, and inside the safe-integer
// range; a cost is finite and never negative. A record outside that is
// malformed, not a line to subtract from a total (review round 45). The
// safe bound matters on the read side because JSON parsing rounds: a count
// such as 9007199254740993 arrives as 9007199254740992, an integer whose
// value is no longer the one the writer named, so it is refused rather
// than stored as its rounded neighbor (review round 80).
function isCount(value: unknown): boolean {
  return value === null || (typeof value === "number" && Number.isSafeInteger(value) && value >= 0);
}

function isCost(value: unknown): boolean {
  return value === null || (typeof value === "number" && Number.isFinite(value) && value >= 0);
}

function isStringOrNull(value: unknown): boolean {
  return value === null || typeof value === "string";
}

function isLabels(value: unknown): value is Record<string, string> | null | undefined {
  // JSON parsing keeps the last duplicate key; validate only its surviving value.
  if (value === undefined || value === null) return true;
  if (typeof value !== "object" || Array.isArray(value) ||
    !Object.values(value).every((item) => typeof item === "string")) return false;
  try {
    parseLabels(Object.entries(value).map(([key, item]) => `${validateLabelKey(key)}=${item}`));
    return true;
  } catch {
    return false;
  }
}

type StoredCallRecord = Omit<CallRecord, "labels"> & { labels?: unknown };

/** The full flat shape, not a lenient three-field check: a line that
 * parses as JSON and names `ts`/`agent`/`kind` but misses `usage` (or
 * carries a wrong-typed field) is not a record, and every consumer that
 * trusts the shape — the table's columns, the totals — would crash on
 * the missing half (review ul2). Wrong-shaped lines are malformed like
 * unparseable ones: skipped and counted, never fatal. */
function isCallRecord(parsed: unknown): parsed is StoredCallRecord {
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
  const costSource = record["cost_source"];
  if (
    costSource !== undefined &&
    costSource !== null &&
    (typeof costSource !== "string" || !COST_SOURCES.has(costSource))
  ) {
    return false;
  }
  const usage = record["usage"];
  if (typeof usage !== "object" || usage === null) return false;
  const counts = usage as Record<string, unknown>;
  return (
    isCount(counts["input_tokens"]) &&
    isCount(counts["output_tokens"]) &&
    isCount(counts["cached_input_tokens"]) &&
    isCount(counts["total_tokens"]) &&
    isCost(counts["cost_usd"])
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
 * skipped and counted, never fatal. Invalid labels are counted and replaced
 * with null while retaining the rest of the record. Throws on read errors
 * (absent file, not a regular file); callers report those. Invalid UTF-8
 * is not one of them: the bytes decode with replacement characters, so
 * the affected lines simply land in `malformed`.
 */
export function readCallLog(path: string): CallLogContents {
  const ledgerStat = statSync(path);
  if (!ledgerStat.isFile()) throw new Error(`the call log at ${path} is not a regular file`);
  const size = ledgerStat.size;
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
    const parsed = parseLine(line);
    if (parsed.malformed) malformed++;
    entries.push({ line, record: parsed.record });
  }
  return { entries, malformed, truncated };
}

/** Parses one ledger line into a record or a malformed count, the single
 * grammar both readers share. Invalid labels keep the record (labels
 * replaced with null) and count as malformed, exactly as before. */
function parseLine(line: string): { record: CallRecord | null; malformed: boolean } {
  try {
    const parsed: unknown = JSON.parse(line);
    if (isCallRecord(parsed)) {
      if (isLabels(parsed.labels)) {
        return {
          record: { ...parsed, labels: parsed.labels ?? null, cost_source: parsed.cost_source ?? null },
          malformed: false,
        };
      }
      return { record: { ...parsed, labels: null, cost_source: parsed.cost_source ?? null }, malformed: true };
    }
  } catch {
    // A hand-edited or truncated line; counted below.
  }
  return { record: null, malformed: true };
}

export interface StreamedCallLog {
  /** Lines with malformed records or labels, counted like readCallLog. */
  malformed: number;
}

/**
 * Streams the whole ledger line by line in bounded memory: 64 KiB reads,
 * one line held at a time, nothing else. Unlike readCallLog there is no
 * 16 MiB tail bound — the totals must see every record, whatever the
 * ledger has grown to. A line longer than MAX_CALL_LOG_LINE_BYTES counts
 * as malformed once and is skipped without being held; a final line
 * without a trailing newline is still a line, as readCallLog's split
 * treats it. Throws on read errors like readCallLog; invalid UTF-8 and
 * wrong-shaped lines are malformed, never fatal.
 */
export function streamCallLog(
  path: string,
  visit: (entry: CallLogEntry) => void,
  options: { endAt?: number } = {}
): StreamedCallLog {
  // `endAt` fixes the byte the read stops at, so two passes over a ledger
  // that is still being appended to see the same records (round 28,
  // edges 2): bytes past it, a partial line included, are the next
  // invocation's business.
  const ledgerStat = statSync(path);
  // A FIFO or a directory at the path would block or fail the read: only a
  // regular file is a ledger (review round 56).
  if (!ledgerStat.isFile()) throw new Error(`the call log at ${path} is not a regular file`);
  const size = ledgerStat.size;
  const endAt = Math.min(options.endAt ?? size, size);
  const fd = openSync(path, "r");
  try {
    const chunk = Buffer.alloc(STREAM_CHUNK_BYTES);
    // An incomplete line is held as the chunks that carry it and joined
    // once, at its newline: joining it on every chunk made a 16 MiB line
    // cost about 2 GiB of copying (round 29, edges 4).
    let carryParts: Buffer[] = [];
    let carryBytes = 0;
    let oversized = false;
    let malformed = 0;
    let position = 0;
    const emit = (line: Buffer): void => {
      const text = line.toString("utf8");
      const parsed = parseLine(text);
      if (parsed.malformed) malformed++;
      visit({ line: text, record: parsed.record });
    };
    const dropCarry = (): void => {
      carryParts = [];
      carryBytes = 0;
    };
    for (;;) {
      const room = Math.min(chunk.length, endAt - position);
      if (room <= 0) break;
      const read = readSync(fd, chunk, 0, room, position);
      if (read === 0) break;
      position += read;
      const buf = chunk.subarray(0, read);
      let offset = 0;
      for (;;) {
        const newline = buf.indexOf(0x0a, offset);
        if (newline === -1) {
          const rest = buf.subarray(offset);
          if (oversized || carryBytes + rest.length > MAX_CALL_LOG_LINE_BYTES) {
            // Over the cap, or continuing a line that was: its bytes are
            // dropped here and counted as malformed once, at its end.
            oversized = true;
            dropCarry();
          } else if (rest.length > 0) {
            // Copy the partial line: the chunk buffer is reused below.
            carryParts.push(Buffer.from(rest));
            carryBytes += rest.length;
          }
          break;
        }
        const head = buf.subarray(offset, newline);
        if (oversized) {
          malformed++;
          oversized = false;
        } else if (carryBytes + head.length > MAX_CALL_LOG_LINE_BYTES) {
          malformed++;
        } else if (carryBytes === 0) {
          emit(head);
        } else {
          emit(Buffer.concat([...carryParts, head]));
        }
        dropCarry();
        offset = newline + 1;
      }
    }
    if (oversized) malformed++;
    else if (carryBytes > 0) emit(Buffer.concat(carryParts));
    return { malformed };
  } finally {
    closeSync(fd);
  }
}
