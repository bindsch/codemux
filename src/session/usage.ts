/**
 * Cumulative usage arithmetic for the session drivers (design §4.2):
 * field-wise sums where an unknown side yields the known one — a null
 * component is never guessed into a zero, and a turn that reports
 * nothing (nulls) leaves the running total it joins unchanged. A field
 * is null only when no report has ever named it, and the computed
 * `total_tokens` is null whenever any folded turn left a token part
 * unreported — the missing figure is not counted as zero (review
 * live15). Cost is the one exception a session-lifetime wire forces:
 * `addTurnUsage` adopts the harness's latest figure rather than summing
 * per-turn ones.
 */

import type { ResultUsageBlock } from "../types.js";

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
 * voids nothing: the running total stands as it was. */
export function addUsage(
  total: ResultUsageBlock,
  addend: ResultUsageBlock
): ResultUsageBlock {
  const sum = (a: number | null, b: number | null): number | null =>
    a === null ? b : b === null ? a : a + b;
  const input_tokens = sum(total.input_tokens, addend.input_tokens);
  const output_tokens = sum(total.output_tokens, addend.output_tokens);
  const cached_input_tokens = sum(total.cached_input_tokens, addend.cached_input_tokens);
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
  return {
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
        ? input_tokens + cached_input_tokens + output_tokens
        : null,
    cost_usd: sum(total.cost_usd, addend.cost_usd),
  };
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
  return {
    ...addUsage(total, { ...addend, cost_usd: null }),
    cost_usd: addend.cost_usd ?? total.cost_usd,
  };
}
