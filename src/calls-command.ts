/**
 * `codemux calls`: reads the per-call usage ledger (call-log.ts) and shows
 * recent records — a table of the last 20 newest first by default. Filters
 * (`-a`, `--since`) apply before the limit, so the shown set is exactly
 * what the totals (`--sum`) cover. A `--since` window keeps a record whose
 * `ts` falls inside it, and a closing `session` record also when any turn
 * of the same session does — its `ts` is the session's start, so a session
 * that began before the cutoff keeps the summary its turns' window owes it
 * (review ul6). Closing `session` records fold in per
 * field: a summary contributes a field only when no shown turn of the same
 * session reported it, so its tokens are never counted beside the turns
 * that already carry them (review ul2) while the claude family's session
 * cost — null on every turn by wire design — still lands in the totals
 * (review ul3), a resumed session's several closings fold to the
 * newest one, so the pre-resume share is never counted twice (review
 * ul4), and a summary with no session id (null or empty) is excluded,
 * never merged under one key (review ul6). Reads are bounded to the
 * ledger's last 16 MiB; a corrupt
 * or wrong-shaped line is skipped and counted, never fatal. Everything
 * informational goes to stderr; only the table, the raw lines (`--json`),
 * and the totals print on stdout. An unusable `--since` value — neither a
 * duration nor a timestamp, or a duration whose cutoff falls outside the
 * date range — is a usage error (exit 64 with a message), never a silently
 * empty view (review ul7).
 */

import type { Command } from "commander";
import { existsSync } from "node:fs";
import {
  CALL_LOG_ENV,
  callLogPath,
  readCallLog,
  sanitizeReportedString,
  type CallLogEntry,
  type CallRecord,
} from "./call-log.js";
import { AGENT_IDS, type AgentId, type ResultUsageBlock } from "./types.js";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100_000;

function parseLimitOption(value: string): number | null {
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit <= 0 || limit > MAX_LIMIT) return null;
  return limit;
}

/** `--since` accepts a duration ("90m", "24h", "7d", "30s") or an ISO
 * timestamp; returns the cutoff instant, or null when the value is neither
 * — or when the duration it names lands outside the representable date
 * range, whose cutoff is an invalid Date. Returning that unchecked made
 * every window comparison against it false and the command answered a
 * silent empty table (review ul7); it is refused like any other value the
 * window cannot use. */
export function parseSinceOption(
  value: string,
  now: Date = new Date()
): Date | null {
  const duration = /^(\d+)\s*(s|m|h|d|w)$/.exec(value.trim());
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
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed;
}

function formatCount(value: number | null): string {
  return value === null ? "-" : value.toLocaleString("en-US");
}

// Local time for the table; --json keeps the exact UTC timestamps.
function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
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
// keeps the stored bytes verbatim by contract.
const COLUMNS: readonly Column[] = [
  { header: "TIMESTAMP", align: "left", value: (r) => formatTimestamp(r.ts) },
  { header: "KIND", align: "left", value: (r) => r.kind },
  { header: "AGENT", align: "left", value: (r) => r.agent },
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

interface FieldTotal {
  label: string;
  sum: number | null;
  unknown: number;
}

/** Sums one usage field over the shown records. `sum` is null when no
 * record reported the field — the honest "unknown", never a zero — and
 * `unknown` counts the records that did not, so a partial picture says
 * which part is missing. */
function totalField(
  records: readonly CallRecord[],
  label: string,
  pick: (usage: ResultUsageBlock) => number | null
): FieldTotal {
  let sum: number | null = null;
  let unknown = 0;
  for (const record of records) {
    const value = pick(record.usage);
    if (value === null) {
      unknown++;
    } else {
      sum = (sum ?? 0) + value;
    }
  }
  return { label, sum, unknown };
}

const USAGE_FIELDS = [
  { label: "input", pick: (u: ResultUsageBlock) => u.input_tokens, field: "input_tokens" },
  { label: "cached", pick: (u: ResultUsageBlock) => u.cached_input_tokens, field: "cached_input_tokens" },
  { label: "output", pick: (u: ResultUsageBlock) => u.output_tokens, field: "output_tokens" },
  { label: "total", pick: (u: ResultUsageBlock) => u.total_tokens, field: "total_tokens" },
  { label: "cost", pick: (u: ResultUsageBlock) => u.cost_usd, field: "cost_usd" },
] as const;

type UsageField = (typeof USAGE_FIELDS)[number]["field"];

function printTotals(records: readonly CallRecord[]): void {
  // Which usage fields each shown session's turns already reported. A
  // closing `session` record carries the cumulative usage of the turns
  // before it, so counting it beside them counts those turns twice
  // (review ul2) — but dropping it wholesale also dropped the claude
  // family's session cost, because every claude/zai turn reports cost
  // null (`total_cost_usd` is a session-lifetime figure only the closing
  // record adopts) (review ul3). The fold, per field: a shown closing
  // record contributes a field only when no shown turn of the same
  // session reported it. Tokens, which every family's turns report, come
  // from the turns; cost, which claude and zai turns never report, comes
  // from the closing record. A closing record with no session id (null
  // or empty — the writers key by a codemux-owned id every session has,
  // review ul6, but an older ledger may still carry "") matches no
  // session and is excluded from the totals, never merged under one key.
  const sessionKey = (record: CallRecord): string | null =>
    record.session_id === null || record.session_id === "" ? null : record.session_id;
  const turnsReported = new Map<string, Set<UsageField>>();
  for (const record of records) {
    if (record.kind !== "session_turn") continue;
    const key = sessionKey(record);
    if (key === null) continue;
    const reported = turnsReported.get(key) ?? new Set<UsageField>();
    for (const { field } of USAGE_FIELDS) {
      if (record.usage[field] !== null) reported.add(field);
    }
    turnsReported.set(key, reported);
  }
  // A resumed session writes a second closing record under the same session
  // id, and every closing record carries session-lifetime usage — the
  // claude family's cost is one figure the wire reports whole — so two
  // closings shown together double-count the pre-resume share (review ul4).
  // The records are newest-first, so the first closing per session is the
  // newest one and wins; older closings of the same session are superseded
  // and excluded from the totals. The writer cannot subtract instead: the
  // resumed run's wire reports only the new session-lifetime total, blended
  // with the resumed turn, so this run's share is not recoverable at the
  // write. A closing record with no session id (null or empty) is excluded
  // like the fold above: it matches no session (review ul6).
  const closedSessions = new Set<string>();
  const supersededClosings = new Set<CallRecord>();
  for (const record of records) {
    if (record.kind !== "session") continue;
    const key = sessionKey(record);
    if (key === null) continue;
    if (closedSessions.has(key)) supersededClosings.add(record);
    else closedSessions.add(key);
  }
  let foldedSummaries = 0;
  let excludedSummaries = 0;
  let supersededSummaries = 0;
  for (const record of records) {
    if (record.kind !== "session") continue;
    if (sessionKey(record) === null) excludedSummaries++;
    else if (supersededClosings.has(record)) supersededSummaries++;
    else foldedSummaries++;
  }
  const contributes = (record: CallRecord, field: UsageField): boolean => {
    if (record.kind !== "session") return true;
    const key = sessionKey(record);
    if (key === null) return false;
    if (supersededClosings.has(record)) return false;
    return !(turnsReported.get(key)?.has(field) ?? false);
  };
  const counted = records.filter(
    (record) =>
      record.kind !== "session" ||
      (sessionKey(record) !== null && !supersededClosings.has(record))
  );
  const totals = USAGE_FIELDS.map(({ label, pick, field }) =>
    totalField(counted.filter((record) => contributes(record, field)), label, pick)
  );
  const parts = totals.map((total) =>
    total.sum === null
      ? `${total.label}=unknown`
      : total.label === "cost"
        ? `${total.label}=$${total.sum.toFixed(4)}`
        : `${total.label}=${total.sum.toLocaleString("en-US")}`
  );
  const unknownNotes = totals
    .filter((total) => total.unknown > 0)
    .map((total) =>
      total.sum === null
        ? `${total.label}: all ${total.unknown}`
        : `${total.label}: ${total.unknown}`
    );
  const notes: string[] = [];
  if (foldedSummaries > 0) {
    notes.push(
      `${foldedSummaries} session summar${foldedSummaries === 1 ? "y" : "ies"} folded — ` +
        "contributes only the fields its shown turns left unreported, so its " +
        "tokens are never counted twice and the claude family's session cost " +
        "(null on every turn) is counted"
    );
  }
  if (excludedSummaries > 0) {
    notes.push(
      `${excludedSummaries} session summar${excludedSummaries === 1 ? "y" : "ies"} ` +
        "with no session id excluded"
    );
  }
  if (supersededSummaries > 0) {
    notes.push(
      `${supersededSummaries} superseded session ` +
        `summar${supersededSummaries === 1 ? "y" : "ies"} excluded — a resumed ` +
        "session's newest closing record wins, so the pre-resume usage is not " +
        "counted twice"
    );
  }
  if (unknownNotes.length > 0) {
    notes.push(`unreported — ${unknownNotes.join(", ")} of ${counted.length}`);
  }
  let line = `Totals over ${counted.length} record(s): ${parts.join(" ")}`;
  if (notes.length > 0) {
    line += ` (${notes.join("; ")})`;
  }
  console.log(line);
}

/**
 * Registers `codemux calls`. The table covers the shown records only:
 * filters run first, the limit last, newest first. The totals cover the
 * shown records with closing `session` summaries folded per field — a
 * summary counts only what its shown turns left unreported, so turns are
 * never counted twice and the claude family's session cost is — and a
 * resumed session's closing summaries fold to the newest one, so the
 * pre-resume share is never counted twice either.
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
    .option("-n, --limit <count>", "Records to show, most recent first", String(DEFAULT_LIMIT))
    .option("-a, --agent <id>", "Show only one agent's calls")
    .option("--since <when>", "Cutoff as a duration (90m, 24h, 7d) or ISO timestamp")
    .option("--json", "Print the raw JSONL records")
    .option("--sum", "Print totals over the shown records (session summaries folded per field)")
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
      const limit = parseLimitOption(options.limit);
      if (limit === null) {
        return fail(`--limit must be an integer from 1 to ${MAX_LIMIT}`);
      }
      let agent: AgentId | undefined;
      if (options.agent !== undefined) {
        if (!AGENT_IDS.includes(options.agent as AgentId)) {
          console.error(`Error: Unknown agent '${options.agent}'`);
          console.error(`Available agents: ${AGENT_IDS.join(", ")}`);
          setExitCode(1);
          return;
        }
        agent = options.agent as AgentId;
      }
      let since: Date | null = null;
      if (options.since !== undefined) {
        since = parseSinceOption(options.since);
        if (since === null) {
          return usageFail(
            "--since must be a duration (90m, 24h, 7d) or an ISO timestamp, " +
              "and the cutoff it names must land inside the date range"
          );
        }
      }

      const path = callLogPath();
      if (path === null) {
        return fail(`the call ledger is disabled (${CALL_LOG_ENV}=off)`);
      }
      if (!existsSync(path)) {
        console.error(`codemux: no calls recorded yet (${path} does not exist)`);
        return;
      }

      let log;
      try {
        log = readCallLog(path);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return fail(`could not read the call ledger at ${path}: ${message}`);
      }
      if (log.truncated) {
        console.error(
          `codemux: ${path} is larger than 16 MiB; showing only the most recent 16 MiB`
        );
      }
      if (log.malformed > 0) {
        console.error(
          `codemux: skipped ${log.malformed} unparseable line(s) in ${path}`
        );
      }
      const matching = log.entries.filter(
        (entry): entry is CallLogEntry & { record: CallRecord } => {
          if (entry.record === null) return false;
          if (agent !== undefined && entry.record.agent !== agent) return false;
          return true;
        }
      );
      // A window keeps a record whose `ts` falls inside it — and a closing
      // `session` record also when any turn of the same session does. The
      // closing record's `ts` is the session's START, so a session that
      // began before the cutoff and ran turns inside the window would lose
      // its summary — the claude family's only cost figure, reported by no
      // turn — to a filter that never looked at its turns (review ul6).
      // Counted once: the fold in the totals keeps the summary beside its
      // turns without counting either twice.
      let windowed = matching;
      if (since !== null) {
        const inWindow = (record: CallRecord): boolean => {
          const ts = new Date(record.ts);
          return !Number.isNaN(ts.getTime()) && ts >= since;
        };
        const sessionsWithTurnsInside = new Set<string>();
        for (const { record } of matching) {
          if (
            record.kind === "session_turn" &&
            record.session_id !== null &&
            inWindow(record)
          ) {
            sessionsWithTurnsInside.add(record.session_id);
          }
        }
        windowed = matching.filter(({ record }) => {
          if (inWindow(record)) return true;
          return (
            record.kind === "session" &&
            record.session_id !== null &&
            sessionsWithTurnsInside.has(record.session_id)
          );
        });
      }
      // The ledger appends, so the tail is the newest: take the last
      // `limit` matching records and reverse for newest-first display.
      const shown = windowed.slice(-limit).reverse();
      if (shown.length === 0) {
        console.error(`codemux: no matching calls in ${path}`);
        return;
      }

      if (options.json) {
        for (const entry of shown) console.log(entry.line);
      } else {
        printTable(shown.map((entry) => entry.record!));
      }
      if (options.sum) printTotals(shown.map((entry) => entry.record!));
    });
}
