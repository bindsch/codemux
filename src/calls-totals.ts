import { sanitizeReportedString, type CallRecord } from "./call-log.js";
import type { ResultUsageBlock } from "./types.js";

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

function printTotal(records: readonly CallRecord[], group?: string): void {
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
  // id. Claude-family cost is session-lifetime, so summing those closings
  // would double-count it. Token counters restart per driver; retaining
  // only the newest summary can omit earlier tokens when turns are absent.
  // The records are newest-first, so the first closing per session is the
  // newest one and wins; older closings are excluded. The ledger has no
  // invocation identifier or persisted cost baseline to reconstruct exact
  // usage for arbitrary filtered histories.
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
  const heading = group === undefined ? "Totals" : `Totals for ${group}`;
  let line = `${heading} over ${counted.length} record(s): ${parts.join(" ")}`;
  if (notes.length > 0) {
    line += ` (${notes.join("; ")})`;
  }
  console.log(line);
}

/** Group only the selected records; each group keeps the normal session fold. */
export function printTotals(records: readonly CallRecord[], by?: string): void {
  if (by === undefined) {
    printTotal(records);
    return;
  }
  const groups = new Map<string | null, CallRecord[]>();
  for (const record of records) {
    const value = record.labels !== null && record.labels !== undefined && Object.hasOwn(record.labels, by)
      ? record.labels[by]!
      : null;
    const group = groups.get(value) ?? [];
    group.push(record);
    groups.set(value, group);
  }
  for (const [value, group] of groups) {
    const name = value === null ? "(none)" : sanitizeReportedString(value)!;
    printTotal(group, `${by}=${name}`);
  }
}
