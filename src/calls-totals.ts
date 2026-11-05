import type { AgentId } from "./types.js";
import type { CallRecord, CostSource } from "./call-log.js";
import { costSourceFor } from "./call-log.js";
import { safeTokenSum } from "./result-envelope/common.js";
import { escapeForTerminal } from "./usage-protocol.js";
import type { ResultUsageBlock } from "./types.js";

const USAGE_FIELDS = [
  { label: "input", pick: (u: ResultUsageBlock) => u.input_tokens, field: "input_tokens" },
  { label: "cached", pick: (u: ResultUsageBlock) => u.cached_input_tokens, field: "cached_input_tokens" },
  { label: "output", pick: (u: ResultUsageBlock) => u.output_tokens, field: "output_tokens" },
  { label: "total", pick: (u: ResultUsageBlock) => u.total_tokens, field: "total_tokens" },
  { label: "cost", pick: (u: ResultUsageBlock) => u.cost_usd, field: "cost_usd" },
] as const;

type UsageField = (typeof USAGE_FIELDS)[number]["field"];

/** The count fields safeTokenSum guards; cost is money, not a token count. */
type TokenField = Exclude<UsageField, "cost_usd">;

/** The next running cost total, or null once the addition has left the
 * finite range: the reader accepts every finite cost, so two valid
 * figures can sum past Number.MAX_VALUE, and the float addition's
 * `Infinity` is not a monetary total (review round 90). */
const nextCostSum = (current: number | null, value: number): number | null => {
  const next = (current ?? 0) + value;
  return Number.isFinite(next) ? next : null;
};

/** A record's session key: null when the record keys nothing. A session
 * id of null — or "", which older ledgers wrote where a session had no
 * native id — matches no session and is never merged under one shared
 * key (review ul6); the writers key by a codemux-owned id every session
 * has. The `--since` window keys by the same rule (review round 80): an
 * empty id is unkeyed legacy data, never a session identity, so a
 * recent empty-id turn cannot admit an old empty-id closing record. */
export const sessionKey = (record: CallRecord): string | null =>
  record.session_id === null || record.session_id === "" ? null : record.session_id;

/**
 * Running totals for one group — the whole ledger, or one `--by` label
 * value — built one record at a time so a streaming pass never holds the
 * matching history. Retained memory is proportional to the number of
 * distinct sessions, never to the ledger's length: the usage fields each
 * session's turns reported (a set of field names keyed by session id)
 * and one closing record per session, the newest. A null sum is the
 * honest "unknown", never a zero, and `unknown` counts the records that
 * did not report the field, so a partial picture says which part is
 * missing. Token sums follow the envelope's safe rule (safeTokenSum):
 * a count past the safe-integer range never enters a sum, and a running
 * sum that would leave the range is unknown and stays unknown (review
 * round 80). A cost total that would leave the finite range is unknown
 * the same sticky way (review round 90).
 */
class GroupTotals {
  private readonly sums: Record<UsageField, number | null> = {
    input_tokens: null,
    cached_input_tokens: null,
    output_tokens: null,
    total_tokens: null,
    cost_usd: null,
  };
  private readonly unknowns: Record<UsageField, number> = {
    input_tokens: 0,
    cached_input_tokens: 0,
    output_tokens: 0,
    total_tokens: 0,
    cost_usd: 0,
  };
  // Cost splits by what the record claims about it (cost_source, audit
  // round 2, B5): the totals line sums billed spend only (sums.cost_usd,
  // filled by addCost), and the harness-reported estimate prints on its
  // own line beneath, so a claude session-lifetime figure never reads as
  // money billed per call.
  private costEstimated: number | null = null;
  private nonSessionRecords = 0;
  private keyedClosings = 0;
  private excludedSummaries = 0;
  // A token field whose running sum has left the safe-integer range: the
  // field stays unknown for the rest of the pass, because a later count
  // landing in it would report a number the true total has already
  // overflowed past (review round 80).
  private readonly overflowed = new Set<TokenField>();
  // A cost bucket whose running total has left the finite range follows
  // the same sticky rule (review round 90): the total stays unknown for
  // the rest of the pass, so a later figure cannot restart a sum the true
  // total has already overflowed past. One flag per bucket — the billed
  // total and the harness estimate overflow independently.
  private costOverflowed = false;
  private costEstimatedOverflowed = false;
  private readonly turnsReported = new Map<string, Set<UsageField>>();
  private readonly newestClosing = new Map<string, CallRecord>();

  /** One token count into its field's running sum, under the envelope's
   * safe-sum rule (safeTokenSum): a sum that would leave the safe-integer
   * range is unknown — printed as `unknown` — never the rounded number
   * the float addition produces (review round 80). */
  private addCount(field: TokenField, value: number, sums: Record<UsageField, number | null>): void {
    if (this.overflowed.has(field)) return;
    const next = safeTokenSum(sums[field] ?? 0, value);
    if (next === null) this.overflowed.add(field);
    sums[field] = next;
  }

  /** One cost figure into its bucket: an estimate stays out of the billed
   * sum; billed and subscription-covered zeros (which add nothing) land in
   * the billed bucket. A ledger line older than the field is classified
   * the way the writer classifies it today (costSourceFor), so a claude or
   * zai estimate recorded before 2.0.0 does not read as a provider charge
   * (review round 39). A total that would leave the finite range is
   * unknown and stays unknown (review round 90). */
  private addCost(value: number | null, source: CostSource | null, agent: AgentId): void {
    if (value === null) {
      this.unknowns.cost_usd++;
      return;
    }
    if ((source ?? costSourceFor(agent, value)) === "harness-estimate") {
      if (this.costEstimatedOverflowed) return;
      const next = nextCostSum(this.costEstimated, value);
      if (next === null) this.costEstimatedOverflowed = true;
      this.costEstimated = next;
      return;
    }
    if (this.costOverflowed) return;
    const next = nextCostSum(this.sums.cost_usd, value);
    if (next === null) this.costOverflowed = true;
    this.sums.cost_usd = next;
  }

  add(record: CallRecord): void {
    const key = sessionKey(record);
    // Which fields this session's turns reported, remembered so the
    // closing summary can skip them at print time.
    if (record.kind === "session_turn" && key !== null) {
      const reported = this.turnsReported.get(key) ?? new Set<UsageField>();
      for (const { field } of USAGE_FIELDS) {
        if (record.usage[field] !== null) reported.add(field);
      }
      this.turnsReported.set(key, reported);
    }
    if (record.kind !== "session") {
      this.nonSessionRecords++;
      for (const { field, pick } of USAGE_FIELDS) {
        if (field === "cost_usd") {
          this.addCost(pick(record.usage), record.cost_source ?? null, record.agent);
          continue;
        }
        const value = pick(record.usage);
        if (value === null) this.unknowns[field]++;
        else this.addCount(field, value, this.sums);
      }
      return;
    }
    if (key === null) {
      this.excludedSummaries++;
      return;
    }
    // A resumed session writes a second closing record under the same
    // session id. Claude-family cost is session-lifetime, so summing
    // those closings would double-count it. Token counters restart per
    // driver; retaining only the newest summary can omit earlier tokens
    // when turns are absent. The pass feeds records oldest first, so the
    // closing seen last is the newest one and wins. The ledger has no
    // invocation identifier or persisted cost baseline to reconstruct
    // exact usage for arbitrary filtered histories.
    this.keyedClosings++;
    this.newestClosing.set(key, record);
  }

  /** Records held: the newest closing per keyed session, nothing else. */
  get retained(): number {
    return this.newestClosing.size;
  }

  print(heading: string): void {
    // The fold, evaluated once against the final turn picture. A closing
    // `session` record carries the cumulative usage of the turns before
    // it, so counting it beside them counts those turns twice (review
    // ul2) — but dropping it wholesale also dropped the claude family's
    // session cost, because every claude/zai turn reports cost null
    // (`total_cost_usd` is a session-lifetime figure only the closing
    // record adopts) (review ul3). Per field: the newest closing
    // contributes a field only when no matched turn of the same session
    // reported it. Tokens, which every family's turns report, come from
    // the turns; cost, which claude and zai turns never report, comes
    // from the closing record.
    const sums = { ...this.sums };
    const unknowns = { ...this.unknowns };
    let costEstimated = this.costEstimated;
    // The fold obeys the same sticky finite rule the pass did (review
    // round 90): a bucket the pass already overflowed stays unknown, and
    // one the fold overflows joins it.
    let costOverflowed = this.costOverflowed;
    let costEstimatedOverflowed = this.costEstimatedOverflowed;
    for (const [key, closing] of this.newestClosing) {
      const reported = this.turnsReported.get(key);
      for (const { field, pick } of USAGE_FIELDS) {
        if (reported?.has(field) === true) continue;
        if (field === "cost_usd") {
          const value = pick(closing.usage);
          if (value === null) unknowns.cost_usd++;
          else if ((closing.cost_source ?? costSourceFor(closing.agent, value)) === "harness-estimate") {
            if (!costEstimatedOverflowed) {
              const next = nextCostSum(costEstimated, value);
              if (next === null) costEstimatedOverflowed = true;
              costEstimated = next;
            }
          } else if (!costOverflowed) {
            const next = nextCostSum(sums.cost_usd, value);
            if (next === null) costOverflowed = true;
            sums.cost_usd = next;
          }
          continue;
        }
        const value = pick(closing.usage);
        if (value === null) unknowns[field]++;
        else this.addCount(field, value, sums);
      }
    }
    const foldedSummaries = this.newestClosing.size;
    const supersededSummaries = this.keyedClosings - foldedSummaries;
    const counted = this.nonSessionRecords + foldedSummaries;
    const parts = USAGE_FIELDS.map(({ label, field }) => {
      // sums.cost_usd carries the billed bucket only (addCost); the
      // estimate prints on its own line right below the totals line.
      const sum = sums[field];
      if (sum === null) return `${label}=unknown`;
      return label === "cost"
        ? `${label}=$${sum.toFixed(4)}`
        : `${label}=${sum.toLocaleString("en-US")}`;
    });
    const unknownNotes = USAGE_FIELDS.filter(({ field }) => unknowns[field] > 0).map(
      ({ label, field }) =>
        sums[field] === null ? `${label}: all ${unknowns[field]}` : `${label}: ${unknowns[field]}`
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
    if (this.excludedSummaries > 0) {
      notes.push(
        `${this.excludedSummaries} session summar${this.excludedSummaries === 1 ? "y" : "ies"} ` +
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
      notes.push(`unreported — ${unknownNotes.join(", ")} of ${counted}`);
    }
    let line = `${heading} over ${counted} record(s): ${parts.join(" ")}`;
    if (notes.length > 0) {
      line += ` (${notes.join("; ")})`;
    }
    console.log(line);
    // The estimate on its own line, never inside the billed total: a
    // claude or zai session-lifetime figure is what the harness folded,
    // not money the provider billed per call (audit round 2, B5). A total
    // that left the finite range prints `unknown` rather than a figure
    // (review round 90).
    if (costEstimated !== null || costEstimatedOverflowed) {
      const figure = costEstimated === null ? "unknown" : `$${costEstimated.toFixed(4)}`;
      console.log(
        `${heading} harness estimate ${figure} — ` +
          "claude and zai report session-lifetime figures, not per-call bills"
      );
    }
  }
}

/**
 * The `--sum` accumulator: `add` one matching record at a time as the
 * ledger streams past, `print` the totals line(s) when the pass ends.
 * With `by`, each group keeps the normal session fold; groups print
 * newest-record-first, the order the array form produced when it read
 * the records newest first. Retained memory is proportional to the number
 * of distinct sessions (one closing record per session, per group), never
 * to the ledger's length.
 */
export class CallTotals {
  private readonly by: string | undefined;
  private readonly single = new GroupTotals();
  private readonly groups = new Map<string | null, GroupTotals>();

  constructor(by?: string) {
    this.by = by;
  }

  add(record: CallRecord): void {
    if (this.by === undefined) {
      this.single.add(record);
      return;
    }
    const labels = record.labels;
    const value =
      labels !== null && labels !== undefined && Object.hasOwn(labels, this.by)
        ? labels[this.by]!
        : null;
    // Reinsertion on every arrival orders the map by each group's newest
    // record; printing it backwards is the newest-group-first order.
    const existing = this.groups.get(value);
    if (existing !== undefined) this.groups.delete(value);
    const group = existing ?? new GroupTotals();
    group.add(record);
    this.groups.set(value, group);
  }

  print(): void {
    if (this.by === undefined) {
      this.single.print("Totals");
      return;
    }
    // The same escaper every human-readable string uses (audit round 2,
    // B14); --json keeps its own \uXXXX forms (escapeJsonControls).
    const key = escapeForTerminal(this.by);
    for (const [value, group] of [...this.groups.entries()].reverse()) {
      group.print(
        value === null
          ? `Totals for records without label ${key}`
          : `Totals for ${key}=${escapeForTerminal(value)}`
      );
    }
  }

  /** Records held across groups: the newest closing per session. */
  get retained(): number {
    let total = this.single.retained;
    for (const group of this.groups.values()) total += group.retained;
    return total;
  }
}

/** The array form, for callers that already hold the records (they have
 * always passed them newest first): fed to the accumulator in reverse,
 * oldest first, the order the streaming pass feeds it. */
export function printTotals(records: readonly CallRecord[], by?: string): void {
  const totals = new CallTotals(by);
  for (let i = records.length - 1; i >= 0; i--) totals.add(records[i]!);
  totals.print();
}
