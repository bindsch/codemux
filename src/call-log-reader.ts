import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { timestampValid } from "./calendar.js";
import { SCODE_TRUST_LEVELS } from "./sandbox.js";
import { AGENT_IDS, AUTONOMY_LEVELS } from "./types.js";
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
  /** The raw line as it appears in the file; a line whose bytes are not
   * valid UTF-8 appears with them replaced and never carries a record. */
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

// `CallRecord` types `agent` as a known AgentId and `autonomy` as null or a
// known AutonomyLevel; the reader enforces the same sets (derived from the
// one definition in types.ts, never a second list). Anything else makes the
// line malformed — counted, skipped, never listed or summed (review round
// 104) — because every consumer that trusts the record's shape (agent
// filters, per-agent totals) assumes the id is one codemux can launch.
const KNOWN_AGENT_IDS: ReadonlySet<string> = new Set(AGENT_IDS);
const KNOWN_AUTONOMY_LEVELS: ReadonlySet<string> = new Set(AUTONOMY_LEVELS);

// Lines older than the field carry no cost_source (read as null, a cost
// with no claim); anything but these three strings, or null, is a
// wrong-shaped line (audit round 2, B5).
const SCODE_TRUST_LEVEL_SET: ReadonlySet<string> = new Set(SCODE_TRUST_LEVELS);
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
  // The writer always stores `new Date(ms).toISOString()`; a `ts` that is
  // not an RFC 3339 timestamp — a control character, a date-only string,
  // free text — is a wrong-shaped line like any other (review round 151),
  // judged by the one shared rule (calendar.ts timestampValid) so it can
  // never reach a renderer or a window comparison.
  if (typeof record["ts"] !== "string" || !timestampValid(record["ts"])) return false;
  if (
    typeof record["kind"] !== "string" ||
    !CALL_RECORD_KINDS.has(record["kind"])
  ) {
    return false;
  }
  if (typeof record["agent"] !== "string" || !KNOWN_AGENT_IDS.has(record["agent"])) return false;
  if (!isStringOrNull(record["model"])) return false;
  if (!isStringOrNull(record["model_effective"])) return false;
  if (typeof record["provider"] !== "string") return false;
  if (!isStringOrNull(record["session_id"])) return false;
  if (!isStringOrNull(record["turn_id"])) return false;
  if (!isStringOrNull(record["finish"])) return false;
  if (
    record["autonomy"] !== null &&
    (typeof record["autonomy"] !== "string" ||
      !KNOWN_AUTONOMY_LEVELS.has(record["autonomy"]))
  ) {
    return false;
  }
  if (typeof record["hermetic"] !== "boolean") return false;
  if (typeof record["sandboxed"] !== "boolean") return false;
  // Absent on older lines and session records; present means it must hold
  // the writer's shape (review round 100).
  if (record["sandbox_no_net"] !== undefined && record["sandbox_no_net"] !== null &&
      typeof record["sandbox_no_net"] !== "boolean") {
    return false;
  }
  if (record["sandbox_trust"] !== undefined && record["sandbox_trust"] !== null &&
      (typeof record["sandbox_trust"] !== "string" || !SCODE_TRUST_LEVEL_SET.has(record["sandbox_trust"]))) {
    return false;
  }
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

/** What one open of the ledger read: the file's identity (device and
 * inode, the pair a replacement at the same path cannot keep), the byte
 * its read stopped at, and the mtime the open saw. A second pass that
 * must see the same file carries this and refuses anything else (round
 * 307; round 391, item 14 added the mtime: an in-place rewrite keeps the
 * inode, and only a changed mtime or size betrays it). */
export interface CallLogIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly size: number;
  readonly mtimeNs: bigint;
}

/** Opens the ledger once and answers a validated descriptor with its
 * identity, the rule both readers share: O_NONBLOCK so a FIFO with no writer
 * never parks the open, O_NOFOLLOW so a final symlink is refused, never
 * read through, and only a regular file is a ledger. Opening first and
 * judging the descriptor closes the pathname-then-open window a swap
 * defeats (review round 90) and the stat-then-read window that read a
 * different object than it validated (review round 147). The descriptor
 * is closed before a validation error escapes; the caller closes it on
 * success. */
function openCallLogDescriptor(path: string): { fd: number; identity: CallLogIdentity } {
  const noFollowFlag = process.platform !== "win32" ? constants.O_NOFOLLOW : 0;
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | noFollowFlag);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ELOOP") throw new Error(`the call log at ${path} is not a regular file`);
    throw error;
  }
  try {
    const ledgerStat = fstatSync(fd, { bigint: true });
    if (!ledgerStat.isFile()) {
      throw new Error(`the call log at ${path} is not a regular file`);
    }
    return {
      fd,
      identity: { dev: ledgerStat.dev, ino: ledgerStat.ino, size: Number(ledgerStat.size), mtimeNs: ledgerStat.mtimeNs },
    };
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

/** The decoder rule the ledger reads share with readUtf8FileBounded
 * (file-io.ts): fatal, so a line whose bytes are not valid UTF-8 is
 * malformed — counted and skipped, never accepted. A replacing decode
 * rewrote an invalid byte inside a permissive string field (`provider`
 * holds any string) into U+FFFD while the line stayed valid JSON, passed
 * the record check, and reached the table and totals as content that is
 * not the bytes on disk (review round 223). The malformed line's
 * displayed text keeps the replacing decode, so `calls --json` still
 * shows the line as it reads. A byte-order mark is kept, not stripped:
 * the ledger writer never writes one, and a line that opens with one is
 * not JSON, as the replacing decode read it (review round 226). */
const fatalUtf8Decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** Decodes and parses one ledger line into an entry and a malformed
 * count, the one rule both readers share. Invalid labels keep the record
 * (labels replaced with null) and count as malformed, exactly as before. */
function readLedgerLine(line: Buffer): { entry: CallLogEntry; malformed: boolean } {
  let text: string;
  try {
    text = fatalUtf8Decoder.decode(line);
  } catch {
    return { entry: { line: line.toString("utf8"), record: null }, malformed: true };
  }
  const parsed = parseLine(text);
  return { entry: { line: text, record: parsed.record }, malformed: parsed.malformed };
}

/** Splits the read window into lines at the byte level: 0x0a cannot
 * appear inside a multi-byte UTF-8 sequence, so the cut points are the
 * ones a decoded split would find, and each line's bytes reach the fatal
 * decoder whole. A final line without a trailing newline is a line; a
 * trailing newline adds no empty final line. `dropFirstLine` carries the
 * tail window's partial-line rule. */
function splitLineBytes(windowBytes: Buffer, dropFirstLine: boolean): Buffer[] {
  let start = 0;
  if (dropFirstLine) {
    const firstNewline = windowBytes.indexOf(0x0a);
    if (firstNewline === -1) return [];
    start = firstNewline + 1;
  }
  const lines: Buffer[] = [];
  for (;;) {
    const newline = windowBytes.indexOf(0x0a, start);
    if (newline === -1) {
      if (start < windowBytes.length) lines.push(windowBytes.subarray(start));
      return lines;
    }
    lines.push(windowBytes.subarray(start, newline));
    start = newline + 1;
  }
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
 * (absent file, not a regular file, a final symlink — the same refusal
 * streamCallLog makes); callers report those. Invalid UTF-8 is not one of
 * them: a line whose bytes are not valid UTF-8 is malformed like a corrupt
 * one — counted and skipped, never accepted with replacement characters in
 * place of the bytes on disk (review round 223).
 */
export function readCallLog(path: string): CallLogContents {
  const { fd, identity } = openCallLogDescriptor(path);
  const size = identity.size;
  try {
    let windowBytes: Buffer;
    let truncated = false;
    let dropFirstLine = false;
    if (size <= MAX_CALL_LOG_BYTES) {
      // The small-file window is the fstat size, read through the
      // validated descriptor: a file that grew past the bound after the
      // fstat is still read as one bounded window, and a file that
      // shrank is decoded up to the bytes that arrived, never the
      // zero-filled tail of the allocation (the rule the tail branch
      // below has had since review round 90).
      const buffer = Buffer.alloc(size);
      let read = 0;
      while (read < buffer.length) {
        const n = readSync(fd, buffer, read, buffer.length - read, read);
        if (n === 0) break;
        read += n;
      }
      windowBytes = buffer.subarray(0, read);
    } else {
      const cut = size - MAX_CALL_LOG_BYTES;
      const buffer = Buffer.alloc(MAX_CALL_LOG_BYTES);
      let read = 0;
      while (read < buffer.length) {
        const n = readSync(fd, buffer, read, buffer.length - read, cut + read);
        if (n === 0) break;
        read += n;
      }
      // Only the bytes actually read: a ledger that shrank between the
      // size check and this read leaves the buffer's tail zero-filled, and
      // decoding the whole allocation turned those NUL bytes into the
      // final line's content (review round 90).
      windowBytes = buffer.subarray(0, read);
      // The read may have started mid-line, in which case the window's
      // first line is the one the bounded read cut and is dropped. But the
      // byte BEFORE the cut decides that, not an unconditional drop: a cut
      // landing exactly on a record boundary (that byte a newline) leaves
      // a complete record at the front of the window, and dropping through
      // the first newline anyway discarded it (review ul6).
      const prelude = Buffer.alloc(1);
      const n = readSync(fd, prelude, 0, 1, cut - 1);
      if (n !== 1 || prelude[0] !== 0x0a) dropFirstLine = true;
      truncated = true;
    }
    const entries: CallLogEntry[] = [];
    let malformed = 0;
    for (const line of splitLineBytes(windowBytes, dropFirstLine)) {
      const read = readLedgerLine(line);
      if (read.malformed) malformed++;
      entries.push(read.entry);
    }
    return { entries, malformed, truncated };
  } finally {
    closeSync(fd);
  }
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
  /** What this pass read — the file's device and inode, and the byte the
   * read stopped at. A second pass over the same ledger carries this in
   * its options, so both passes see one file. */
  identity: CallLogIdentity;
}

/**
 * Streams the whole ledger line by line in bounded memory: 64 KiB reads,
 * one line held at a time, nothing else. Unlike readCallLog there is no
 * 16 MiB tail bound — the totals must see every record, whatever the
 * ledger has grown to. A line longer than MAX_CALL_LOG_LINE_BYTES counts
 * as malformed once and is skipped without being held; a final line
 * without a trailing newline is still a line, as readCallLog's split
 * treats it. Throws on read errors like readCallLog; invalid UTF-8 and
 * wrong-shaped lines are malformed, never fatal. `options.identity` is
 * the identity an earlier pass of the same command read; a ledger whose
 * device or inode differs — an atomic replacement — or that was rewritten
 * in place (a shrink, or a same-size file whose mtime moved; round 391,
 * item 14) is refused, never read as one file with the first pass's
 * records (round 307). `endAt` still fixes the byte the read stops at, so two passes
 * over a ledger that is still being appended to see the same records
 * (round 28, edges 2): bytes past it, a partial line included, are the
 * next invocation's business.
 */
export function streamCallLog(
  path: string,
  visit: (entry: CallLogEntry) => void,
  options: { endAt?: number; identity?: CallLogIdentity } = {}
): StreamedCallLog {
  // The open-and-validate rule both readers share: openCallLogDescriptor
  // above (O_NONBLOCK, O_NOFOLLOW, only a regular file — review rounds 90
  // and 56).
  const { fd, identity } = openCallLogDescriptor(path);
  if (options.identity !== undefined) {
    // A replacement (a new inode, round 307) or an in-place rewrite
    // (round 391, item 14): a shrink, or a same-size file whose mtime
    // moved. Growth alone is an append (round 28, edges 2), allowed.
    const pinned = options.identity;
    const replaced = identity.dev !== pinned.dev || identity.ino !== pinned.ino;
    const rewritten = identity.size < pinned.size ||
      (identity.size === pinned.size && identity.mtimeNs !== pinned.mtimeNs);
    if (replaced || rewritten) {
      closeSync(fd);
      throw new Error(
        `the call ledger at ${path} was replaced while being read; refusing to combine two files into one view`
      );
    }
  }
  try {
    const endAt = Math.min(options.endAt ?? identity.size, identity.size);
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
      const read = readLedgerLine(line);
      if (read.malformed) malformed++;
      visit(read.entry);
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
    // The pinned size is what this pass read, not what it meant to read: a
    // ledger that shrank under the pass reached EOF early, and a second
    // pass pinned to the planned end would read bytes the first never saw
    // (review round 316).
    return { malformed, identity: { dev: identity.dev, ino: identity.ino, size: position, mtimeNs: identity.mtimeNs } };
  } finally {
    closeSync(fd);
  }
}
