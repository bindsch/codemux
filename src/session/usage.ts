/**
 * Cumulative usage arithmetic for the session drivers (design §4.2):
 * field-wise sums where an unknown side yields the known one — a null
 * component is never guessed into a zero, and a turn that reports
 * nothing (nulls) leaves the running total it joins unchanged. A field
 * is null only when no report has ever named it, and the computed
 * `total_tokens` is null whenever any folded turn left a token part
 * unreported — the missing figure is not counted as zero (review
 * live15). Token sums follow the envelope's safe rule (safeTokenSum,
 * src/result-envelope/common.ts): a sum that would leave the
 * safe-integer range is null — unknown — never the rounded number the
 * float addition produces (review round 80). An unknown total stays
 * unknown downstream: the usage events and the ledger's closing summary
 * carry null for it, the same field the envelope reports null. Cost is
 * the one exception a session-lifetime wire forces: `addTurnUsage`
 * adopts the harness's latest figure rather than summing per-turn ones.
 */

import type { ResultUsageBlock } from "../types.js";
import { safeTokenSum } from "../result-envelope/common.js";

import { markOverflowed, overflowMarks, overflowedFields, TOKEN_FIELDS, type OverflowField, type TokenField } from "../usage-overflow.js";

export { markOverflowed, overflowedFields };

/** Sum two usage blocks field-wise: a null side yields the other side,
 * two nulls stay null. A partially-reporting turn therefore cannot wipe
 * what earlier turns established — the defect the old both-null rule
 * had, where one missing counter nulled the cumulative field forever.
 *
 * `total_tokens` carries the wire identity every normalizer enforces —
 * total = input + cached + output — computed only while it is exact:
 * the addend must report all three parts, and no earlier fold may have
 * left one unreported (a running block whose parts are known while its
 * total is null is exactly that uncertifiable state; a fresh all-null
 * block is merely empty). Summing the parts when a folded turn's cache
 * count was missing counted that figure as zero — the live10 rule
 * matched the components but the value was still a guess (review
 * live15). A token-empty addend (all parts null) certifies nothing and
 * voids nothing: the running total stands as it was.
 *
 * Token sums are safe sums (safeTokenSum): a sum that would leave the
 * safe-integer range is null — unknown — never the rounded number the
 * float addition produces, the envelope's rule, so a session cannot
 * report a total the equivalent non-session run would call unknown
 * (review round 80). Cost still sums as a plain float — it is money, not
 * a count, and its accuracy is the cent-level float's, not the integer
 * range's — except a total that leaves the finite range, which is null
 * (review round 90). */
export function addUsage(
  total: ResultUsageBlock,
  addend: ResultUsageBlock
): ResultUsageBlock {
  const overflowed = new Set<OverflowField>(overflowMarks.get(total) ?? []);
  for (const field of [...TOKEN_FIELDS, "cost_usd"] as const) {
    if (overflowMarks.get(addend)?.has(field)) overflowed.add(field);
  }
  // An overflowed field stays unknown whatever later turns report.
  const sum = (field: TokenField): number | null => {
    if (overflowed.has(field)) return null;
    const a = total[field];
    const b = addend[field];
    if (a === null) return b;
    if (b === null) return a;
    const result = safeTokenSum(a, b);
    if (result === null) overflowed.add(field);
    return result;
  };
  // A cost sum that leaves the finite range is null — unknown — never the
  // float addition's Infinity: the reader accepts every finite cost, so
  // two valid figures can overflow a money total (review round 90).
  // The overflow is marked like a token field's, so a later figure cannot
  // restart the total from the null it left (review round 91).
  const sumCost = (a: number | null, b: number | null): number | null => {
    if (overflowed.has("cost_usd")) return null;
    if (a === null) return b;
    if (b === null) return a;
    const next = a + b;
    if (Number.isFinite(next)) return next;
    overflowed.add("cost_usd");
    return null;
  };
  const input_tokens = sum("input_tokens");
  const output_tokens = sum("output_tokens");
  const cached_input_tokens = sum("cached_input_tokens");
  const addendReportsTokens =
    addend.input_tokens !== null ||
    addend.output_tokens !== null ||
    addend.cached_input_tokens !== null;
  const addendComplete =
    addend.input_tokens !== null &&
    addend.output_tokens !== null &&
    addend.cached_input_tokens !== null;
  // Prior folds certify the running total unless one of them left the
  // block with known parts and an unknown total; an empty block (all
  // parts null, total null) has folded nothing token-wise and certifies
  // vacuously.
  const priorCertifiable =
    total.total_tokens !== null ||
    (total.input_tokens === null &&
      total.output_tokens === null &&
      total.cached_input_tokens === null);
  const result: ResultUsageBlock = {
    input_tokens,
    output_tokens,
    cached_input_tokens,
    total_tokens: !addendReportsTokens
      ? total.total_tokens // nothing token-wise folded: stand as it was
      : priorCertifiable &&
          addendComplete &&
          input_tokens !== null &&
          output_tokens !== null &&
          cached_input_tokens !== null
        ? safeTokenSum(input_tokens, cached_input_tokens, output_tokens)
        : null,
    cost_usd: sumCost(total.cost_usd, addend.cost_usd),
  };
  if (overflowed.size > 0) overflowMarks.set(result, overflowed);
  return result;
}

/** Fold one reported delta into a per-turn accumulator that starts
 * unreported (`null`): the first delta replaces, later ones add, so a
 * turn with no report stays honestly null instead of collapsing to
 * zeros. */
export function accumulateUsage(
  current: ResultUsageBlock | null,
  delta: ResultUsageBlock
): ResultUsageBlock {
  return current === null ? delta : addUsage(current, delta);
}

/** Fold one per-turn report into the session cumulative. Token counts
 * sum field-wise (addUsage); cost does not — the only wire that carries
 * one (the claude-family result's `total_cost_usd`) reports a
 * session-lifetime figure each turn, already including every earlier
 * turn, so the latest report IS the session cost and summing the
 * per-turn figures counts the earlier turns again (review live8:
 * replaying the zai-session-a fixture summed $0.4447632 against the
 * harness's final $0.118512). A report carrying no cost leaves the
 * known figure standing, the same keep-semantics every null here
 * follows. Wires without a cost carrier (codex, agy) report null and
 * are unaffected. */
export function addTurnUsage(
  total: ResultUsageBlock,
  addend: ResultUsageBlock
): ResultUsageBlock {
  const costLost = (block: ResultUsageBlock): boolean => overflowMarks.get(block)?.has("cost_usd") === true;
  // Tokens fold with the addend's token marks only; the cost is decided
  // here: the harness's latest figure when it reports one, unknown when
  // the turn's own accumulation overflowed, the standing figure otherwise.
  const tokenOnly: ResultUsageBlock = { ...addend, cost_usd: null };
  markOverflowed(tokenOnly, overflowedFields(addend).filter((field) => field !== "cost_usd"));
  const folded = addUsage(stripCostMark(total), tokenOnly);
  const cost = addend.cost_usd ?? (costLost(addend) ? null : total.cost_usd);
  const result: ResultUsageBlock = { ...folded, cost_usd: cost };
  const marks = new Set<OverflowField>(overflowMarks.get(folded) ?? []);
  if (addend.cost_usd === null && (costLost(addend) || costLost(total))) marks.add("cost_usd");
  if (marks.size > 0) overflowMarks.set(result, marks);
  return result;
}

/** `block` with its token marks and no cost mark: the turn fold sums
 * tokens only, and a cost mark would otherwise void the token fold's
 * untouched cost slot. */
function stripCostMark(block: ResultUsageBlock): ResultUsageBlock {
  if (overflowMarks.get(block)?.has("cost_usd") !== true) return block;
  const copy = { ...block };
  markOverflowed(copy, overflowedFields(block).filter((field) => field !== "cost_usd"));
  return copy;
}
