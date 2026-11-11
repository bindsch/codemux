/**
 * `codemux calls`: reads the per-call usage ledger (call-log.ts) and shows
 * recent records — the last 20 in reverse append order by default. The
 * whole ledger streams through bounded passes (call-log-reader.ts
 * `streamCallLog`): the agent and label filters, the `--since` window,
 * and the `--sum` totals see every record, whatever the ledger has grown
 * to. Retained memory is proportional to `-n` and to the number of
 * distinct sessions, never to the ledger's length: a ring of `-n`
 * records (at most 100000), raw lines only under `--json`, one closing
 * record per session (calls-totals.ts), and — under `--since` — one
 * session id per session with an in-window turn, never an empty one
 * (an empty session id is unkeyed legacy data, review round 80). A
 * `--since` window
 * keeps a record whose `ts` falls inside it, and a closing `session`
 * record also when any turn of the same session fell inside — its `ts` is the
 * session's start, so a session that began before the cutoff can include
 * cost from outside that interval. Closing `session` records fold in per
 * field: a summary contributes a field only when no matched turn of the same
 * session reported it, so its tokens are never counted beside the turns
 * that already carry them (review ul2) while the claude family's session
 * cost — null on every turn by wire design — still lands in the totals
 * (review ul3), a resumed session's several closings fold to the
 * newest one. Tokens restart per driver, so missing turn records can make
 * that fold omit earlier invocation usage. A summary with no session id
 * (null or empty) is excluded,
 * never merged under one key (review ul6). A corrupt
 * or wrong-shaped line is skipped and counted, never fatal. Everything
 * informational goes to stderr; only the table, stored records (`--json`),
 * and the totals print on stdout. An unusable `--since` value — neither a
 * duration nor a timestamp, or a duration whose cutoff falls outside the
 * date range — is a usage error (exit 64 with a message), never a silently
 * empty view (review ul7).
 */

import type { Command } from "commander";
import { statEntryPresent } from "./file-io.js";
import {
  CALL_LOG_ENV,
  callLogPath,
  sanitizeReportedString,
  streamCallLog,
  type CallLogIdentity,
  type CallRecord,
} from "./call-log.js";
import { timestampMs } from "./calendar.js";
import { CallTotals, sessionKey } from "./calls-totals.js";
import { collectLabel, escapeJsonControls, parseLabels, validateLabelKey } from "./labels.js";
import { AGENT_IDS, type AgentId } from "./types.js";
import { CALL_RECORD_KIND_NAMES as CALL_KINDS } from "./call-log-reader.js";
import { UsageRefusalError, USAGE_REFUSAL_EXIT_CODE } from "./validation.js";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100_000;

function parseLimitOption(value: string): number | null {
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit <= 0 || limit > MAX_LIMIT) return null;
  return limit;
}

/** `--since` accepts a duration ("90m", "24h", "7d", "30s") or a Date-parsed
 * timestamp; returns the cutoff instant, or null when the value is neither
 * — or when the duration it names lands outside the representable date
 * range, whose cutoff is an invalid Date. Returning that unchecked made
 * every window comparison against it false and the command answered a
 * silent empty table (review ul7); it is refused like any other value the
 * window cannot use. A digit-only value is refused outright (review round
 * 361): the duration branch requires a unit letter, so "7" fell through to
 * `new Date`, which JSC reads as July 2001 while V8 rejects it — an
 * engine-dependent cutoff 25 years in the past, silently. A bare number is
 * neither a duration nor a date. A date-only ISO value ("2026-11-08") cuts
 * at UTC midnight, the ECMAScript reading of a date-only string; durations
 * are relative to the local now. */
export function parseSinceOption(
  value: string,
  now: Date = new Date()
): Date | null {
  const trimmed = value.trim();
  const duration = /^(\d+)\s*(s|m|h|d|w)$/.exec(trimmed);
  if (duration !== null) {
    const count = Number(duration[1]);
    const unitMs: Record<string, number> = {
      s: 1000,
      m: 60_000,
      h: 3_600_000,
      d: 86_400_000,
      w: 604_800_000,
    };
    const cutoff = new Date(now.getTime() - count * unitMs[duration[2]!]!);
    return Number.isNaN(cutoff.getTime()) ? null : cutoff;
  }
  if (/^\d+$/.test(trimmed)) return null;
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed;
}

function formatCount(value: number | null): string {
  return value === null ? "-" : value.toLocaleString("en-US");
}

// Local time for the table; --json keeps the exact UTC timestamps. The
// reader refuses a `ts` that is not an RFC 3339 timestamp (review round
// 151), so an unparseable value cannot arrive through the ledger; the
// fallback is a fixed dash, never the raw string. The parse is the
// shared one (calendar.ts timestampMs), so a leap second the reader
// accepts renders as the instant after 23:59:59 instead of the dash.
function formatTimestamp(iso: string): string {
  const date = new Date(timestampMs(iso));
  if (Number.isNaN(date.getTime())) return "-";
  const pad = (value: number) => String(value).padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}

interface Column {
  header: string;
  align: "left" | "right";
  value: (record: CallRecord) => string;
}

// Cells that render harness-reported strings are sanitized here too, not
// only at the store's seam (call-log.ts): a ledger written before that
// strip landed may still carry terminal controls in a model name or finish
// reason, and the table is what reaches the operator's terminal. --json
// keeps the stored JSON, with DEL and C1 characters escaped for the terminal.
const COLUMNS: readonly Column[] = [
  { header: "TIMESTAMP", align: "left", value: (r) => formatTimestamp(r.ts) },
  { header: "KIND", align: "left", value: (r) => r.kind },
  // A `complete` record has no agent; its column shows the upstream host.
  { header: "AGENT", align: "left", value: (r) => r.agent ?? sanitizeReportedString(r.provider) ?? "-" },
  {
    header: "MODEL",
    align: "left",
    value: (r) => sanitizeReportedString(r.model_effective ?? r.model) ?? "-",
  },
  { header: "IN", align: "right", value: (r) => formatCount(r.usage.input_tokens) },
  { header: "CACHED", align: "right", value: (r) => formatCount(r.usage.cached_input_tokens) },
  { header: "OUT", align: "right", value: (r) => formatCount(r.usage.output_tokens) },
  { header: "TOTAL", align: "right", value: (r) => formatCount(r.usage.total_tokens) },
  {
    header: "COST",
    align: "right",
    value: (r) => (r.usage.cost_usd === null ? "-" : `$${r.usage.cost_usd.toFixed(4)}`),
  },
  {
    header: "EXIT",
    align: "right",
    value: (r) =>
      r.exit_code !== null ? String(r.exit_code) : sanitizeReportedString(r.finish) ?? "-",
  },
  { header: "DUR(MS)", align: "right", value: (r) => r.duration_ms.toLocaleString("en-US") },
];

function printTable(records: readonly CallRecord[]): void {
  const widths = COLUMNS.map((column) =>
    Math.max(column.header.length, ...records.map((r) => column.value(r).length))
  );
  const renderRow = (cells: readonly string[]) =>
    COLUMNS.map((column, index) =>
      column.align === "right"
        ? cells[index]!.padStart(widths[index]!)
        : cells[index]!.padEnd(widths[index]!)
    ).join("  ");
  console.log(renderRow(COLUMNS.map((column) => column.header)));
  for (const record of records) {
    console.log(renderRow(COLUMNS.map((column) => column.value(record))));
  }
}

/** The listing's memory bound: a ring holding the newest `limit` records
 * pushed. The streaming pass pushes every record it keeps and this discards
 * the oldest beyond `limit`, so a ledger of any length leaves the listing
 * holding `-n` records — never the matching history (review round 22). */
export class ListingRing<T> {
  private readonly slots: (T | undefined)[];
  private next = 0;
  private filled = 0;

  constructor(private readonly limit: number) {
    this.slots = new Array<T | undefined>(limit);
  }

  push(item: T): void {
    this.slots[this.next] = item;
    this.next = (this.next + 1) % this.limit;
    if (this.filled < this.limit) this.filled++;
  }

  /** The newest records, oldest first — reverse for newest-first display. */
  items(): T[] {
    const start = this.filled < this.limit ? 0 : this.next;
    const items: T[] = [];
    for (let i = 0; i < this.filled; i++) {
      items.push(this.slots[(start + i) % this.limit]!);
    }
    return items;
  }
}

/** The `--since` window. A record whose own `ts` falls inside counts. A
 * closing `session` record also counts when a turn of the same session
 * fell inside: its `ts` is the session's START, so a session that began
 * before the cutoff and ran turns inside the window would lose its
 * summary — the claude family's only cost figure, reported by no turn —
 * to a filter that never looked at its turns (review ul6). A resumed
 * session appends its earlier closing BEFORE the turns its resume ran,
 * so the set of sessions with an in-window turn must be COMPLETE before
 * any closing is decided: `--since` runs a first pass that collects the
 * set (collectSessionWithTurn below), and the listing pass then decides
 * every closing against the full set (round 23, edges 4). Counted once:
 * the fold in the totals keeps the summary beside its turns without
 * counting either twice. The set of session keys is the only retained
 * state, one entry per session with an in-window turn; the key is the
 * agent and the session id together (calls-totals.ts sessionKey), so a
 * recent turn of one agent never admits an old closing record of
 * another agent that shares its session id, and an empty session id
 * keys nothing, so an old empty-id closing record stays behind the
 * cutoff (review rounds 80 and 127). */
function recordInsideWindow(record: CallRecord, cutoff: Date): boolean {
  // The same parse the reader's rule uses, so every ts the reader
  // accepts (a leap second included) is placed in the window.
  const ts = timestampMs(record.ts);
  return Number.isFinite(ts) && ts >= cutoff.getTime();
}

/** The first pass's one job: name every session with an in-window turn,
 * after the agent and label filters — one key per such session, never one
 * per turn. The key is the totals' session key (calls-totals.ts): the
 * agent and the session id together, so another agent's session sharing
 * the id is a different session; an empty session id is unkeyed legacy
 * data and never a key, so a recent empty-id turn cannot pull an old
 * empty-id closing record past the cutoff (review round 80). */
export function collectSessionWithTurn(
  record: CallRecord,
  cutoff: Date,
  sessionsWithTurnsInside: Set<string>
): void {
  const key = sessionKey(record);
  if (
    record.kind === "session_turn" &&
    key !== null &&
    recordInsideWindow(record, cutoff)
  ) {
    sessionsWithTurnsInside.add(key);
  }
}

export function windowKeeps(
  record: CallRecord,
  cutoff: Date,
  sessionsWithTurnsInside: ReadonlySet<string>
): boolean {
  if (recordInsideWindow(record, cutoff)) return true;
  const key = sessionKey(record);
  return record.kind === "session" && key !== null && sessionsWithTurnsInside.has(key);
}

/**
 * Registers `codemux calls`. The ledger streams once in bounded memory,
 * end to end: the agent and label filters run during the pass, the window
 * decides each record as it arrives, the listing keeps the newest `limit`
 * of what the window kept, and the totals accumulate per record. The
 * totals fold closing `session` summaries per field — a summary counts
 * only what its matched turns left unreported, so turns are never counted
 * twice and the claude family's session cost is — and a resumed session's
 * closing summaries fold to the newest one. This avoids duplicate lifetime
 * cost but can omit tokens when turns are absent.
 */
export function registerCallsCommand(
  program: Command,
  setExitCode: (code: number) => void = (code) => {
    process.exitCode = code;
  }
): void {
  program
    .command("calls")
    .description("Show recent records from the per-call usage ledger")
    .option("-n, --limit <count>", "Records to list, newest ledger append first; bounds the listing only", String(DEFAULT_LIMIT))
    .option("-a, --agent <id>", "Show only one agent's calls")
    .option("--kind <kind>", `Show only one record kind: ${CALL_KINDS.join(", ")}`)
    .option("--label <KEY=VALUE>", "Filter by a label; repeat for AND matching", collectLabel, [])
    .option("--since <when>", "Cutoff as a duration with a unit (90m, 24h, 7d) or an ISO date (a date-only value cuts at UTC midnight); a bare number is refused")
    .option("--json", "Print stored JSONL with controls escaped; --sum appends human-readable totals")
    .option("--sum", "Append totals over every matching record in the whole ledger, not only the listed ones")
    .option("--by <key>", "Group --sum totals by this label; records without it form a separate group")
    .action(async (options) => {
      const fail = (message: string): Promise<void> => {
        console.error(`Error: ${message}`);
        setExitCode(1);
        return Promise.resolve();
      };
      // A --since value only the caller can fix is a usage error (EX_USAGE,
      // the same 64 the option validators use, validation.ts): a script
      // can tell a bad cutoff from a ledger problem. Before ul7 a duration
      // that overflowed the date range was an invalid Date unchecked, and
      // the command answered an empty table at exit 0.
      const usageFail = (message: string): Promise<void> => {
        console.error(`Error: ${message}`);
        setExitCode(64);
        return Promise.resolve();
      };
      let labels: Record<string, string> | null;
      let by: string | undefined;
      try {
        labels = parseLabels(options.label);
        if (options.by !== undefined) {
          if (!options.sum) return usageFail("--by requires --sum");
          by = validateLabelKey(options.by);
        }
      } catch (error) {
        if (error instanceof UsageRefusalError) return usageFail(error.message);
        throw error;
      }
      const limit = parseLimitOption(options.limit);
      if (limit === null) {
        return usageFail(`--limit must be an integer from 1 to ${MAX_LIMIT}`);
      }
      let agent: AgentId | undefined;
      if (options.agent !== undefined) {
        if (!AGENT_IDS.includes(options.agent as AgentId)) {
          console.error(`Error: Unknown agent '${options.agent}'`);
          console.error(`Available agents: ${AGENT_IDS.join(", ")}`);
          setExitCode(USAGE_REFUSAL_EXIT_CODE);
          return;
        }
        agent = options.agent as AgentId;
      }
      let kind: CallRecord["kind"] | undefined;
      if (options.kind !== undefined) {
        if (!(CALL_KINDS as readonly string[]).includes(options.kind)) {
          return usageFail(`--kind must be one of ${CALL_KINDS.join(", ")}`);
        }
        kind = options.kind as CallRecord["kind"];
      }
      let since: Date | null = null;
      if (options.since !== undefined) {
        since = parseSinceOption(options.since);
        if (since === null) {
          return usageFail(
            "--since must be a duration with a unit (90m, 24h, 7d) or an ISO date " +
              "(a bare number is neither), and the cutoff it names must land inside the date range"
          );
        }
      }

      const path = callLogPath();
      if (path === null) {
        return fail(`the call ledger is disabled (${CALL_LOG_ENV}=off)`);
      }
      // ENOENT and ENOTDIR mean nothing is recorded yet; any other
      // inspection failure (an unreadable parent, an I/O error) is a
      // read failure, never an empty ledger: existsSync folded those
      // into "absent" and the command answered exit 0 (review round
      // 232).
      let present: boolean;
      try {
        present = statEntryPresent(path, (code) => {
          throw new Error(`could not inspect the call ledger at ${path} (${code})`);
        });
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error));
      }
      if (!present) {
        console.error(`codemux: no calls recorded yet (${path} does not exist)`);
        return;
      }

      // Streaming passes, bounded end to end. The ring keeps the newest
      // `limit` windowed records — a raw line beside each only under
      // `--json`, which prints those lines; the table needs the record
      // alone. The totals see every windowed record, one at a time.
      // Retained memory is proportional to `-n` and to the number of
      // distinct sessions, never to the ledger's length: a ring of `-n`
      // records, raw lines only under `--json`, one closing record per
      // session, and — under `--since` — one session id per session with
      // an in-window turn.
      const keepLine = options.json === true;
      const listing = new ListingRing<{ record: CallRecord; line: string | null }>(limit);
      const totals = options.sum ? new CallTotals(by) : null;
      const cutoff = since;
      let malformed: number;
      try {
        const passesFilters = (record: CallRecord): boolean => {
          if (agent !== undefined && record.agent !== agent) return false;
          if (kind !== undefined && record.kind !== kind) return false;
          if (labels !== null) {
            for (const [key, value] of Object.entries(labels)) {
              if (
                record.labels === null || record.labels === undefined ||
                !Object.hasOwn(record.labels, key) || record.labels[key] !== value
              ) {
                return false;
              }
            }
          }
          return true;
        };
        const sessionsWithTurnsInside = new Set<string>();
        // The first pass pins the ledger's identity — device, inode, and
        // the byte its read stopped at — and the second carries the pin:
        // an atomic replacement of the ledger between the passes used to
        // let session ids collected from one file admit records from
        // another, a view of neither ledger; the stream now refuses the
        // different file (round 307). The pinned byte also keeps both
        // passes at the size the ledger had at the first open: a record
        // appended while they run belongs to the next invocation, so the
        // two passes cannot disagree about a session (round 28, edges 2).
        let pinned: CallLogIdentity | undefined;
        if (cutoff !== null) {
          // First pass, `--since` only: the complete set of sessions with
          // an in-window turn, so a closing that PRECEDES a resumed
          // session's in-window turns is kept like any other closing
          // (round 23, edges 4).
          pinned = streamCallLog(path, (entry) => {
            const record = entry.record;
            if (record === null || !passesFilters(record)) return;
            collectSessionWithTurn(record, cutoff, sessionsWithTurnsInside);
          }).identity;
        }
        // The second pass keeps adding to the same set, so a turn and its
        // closing appended between the passes follow the one-pass rule: the
        // closing comes after its turn in append order (round 26, edges 3).
        const stream = streamCallLog(path, (entry) => {
          const record = entry.record;
          if (record === null || !passesFilters(record)) return;
          if (cutoff !== null) {
            collectSessionWithTurn(record, cutoff, sessionsWithTurnsInside);
            if (!windowKeeps(record, cutoff, sessionsWithTurnsInside)) return;
          }
          listing.push({ record, line: keepLine ? entry.line : null });
          totals?.add(record);
        }, pinned === undefined ? {} : { endAt: pinned.size, identity: pinned });
        malformed = stream.malformed;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return fail(`could not read the call ledger at ${path}: ${message}`);
      }
      if (malformed > 0) {
        console.error(
          `codemux: skipped ${malformed} unparseable line(s) or invalid label map(s) in ${path}`
        );
      }
      // The ledger appends, so the tail is the newest: the ring holds the
      // last `limit` windowed records, reversed for newest-first display.
      const shown = listing.items().reverse();
      if (shown.length === 0) {
        console.error(`codemux: no matching calls in ${path}`);
        return;
      }

      if (options.json) {
        for (const entry of shown) console.log(escapeJsonControls(entry.line!));
      } else {
        printTable(shown.map((entry) => entry.record));
      }
      // The limit bounds the listing only; the totals have no bound.
      totals?.print();
    });
}
