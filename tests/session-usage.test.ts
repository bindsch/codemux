/**
 * Unit tests for the cumulative usage arithmetic (design §4.2): the sums
 * are field-wise and keep what is known — a null side yields the other
 * side, never a guessed zero, and never a wipe of what earlier turns
 * reported (the review-live4 defect: one partially-reporting turn nulled
 * the cumulative field for the whole session).
 */

import { describe, expect, test } from "bun:test";
import type { ResultUsageBlock } from "../src/types.js";
import { addTurnUsage, addUsage, accumulateUsage } from "../src/session/usage.js";

const block = (
  overrides: Partial<ResultUsageBlock> = {}
): ResultUsageBlock => ({
  input_tokens: 10,
  output_tokens: 5,
  cached_input_tokens: 3,
  total_tokens: 18,
  cost_usd: 0.01,
  ...overrides,
});

describe("usage arithmetic", () => {
  test("two known values sum field-wise", () => {
    // Both blocks carry the wire identity (total = in + cached + out);
    // the summed total is the summed parts' identity.
    expect(
      addUsage(block(), block({ input_tokens: 7, output_tokens: 1, total_tokens: 11 }))
    ).toEqual(
      block({
        input_tokens: 17,
        output_tokens: 6,
        cached_input_tokens: 6,
        total_tokens: 29,
        cost_usd: 0.02,
      })
    );
  });

  test("a null side yields the known side, in both directions", () => {
    const nothing: ResultUsageBlock = {
      input_tokens: null,
      output_tokens: null,
      cached_input_tokens: null,
      total_tokens: null,
      cost_usd: null,
    };
    // The known side survives joining an unknown one...
    expect(addUsage(block(), nothing)).toEqual(block());
    // ...and an unknown cumulative keeps the turn that just reported.
    expect(addUsage(nothing, block())).toEqual(block());
  });

  test("two nulls stay null — an unreported field is never guessed as zero", () => {
    const nothing: ResultUsageBlock = {
      input_tokens: null,
      output_tokens: null,
      cached_input_tokens: null,
      total_tokens: null,
      cost_usd: null,
    };
    expect(addUsage(nothing, nothing)).toEqual(nothing);
  });

  test("a partially-reporting turn cannot wipe the cumulative", () => {
    // The live4 defect, exactly: turn 1 reports fully, turn 2 reports no
    // cache counts (claude's result envelope leaves them null) — the
    // session total must keep the numbers it has, not null them.
    const first = block();
    const partial = block({
      cached_input_tokens: null,
      cost_usd: null,
      input_tokens: 4,
      output_tokens: 2,
      total_tokens: null,
    });
    const cumulative = addUsage(first, partial);
    expect(cumulative.input_tokens).toBe(14);
    expect(cumulative.output_tokens).toBe(7);
    expect(cumulative.cached_input_tokens).toBe(3); // kept, not wiped
    expect(cumulative.total_tokens).toBe(null); // turn 2's cache is unknown, not zero (live15)
    expect(cumulative.cost_usd).toBe(0.01); // kept, not wiped
  });

  test("the cumulative's total is exact or null — never a parts-matching guess", () => {
    // Review live10, correctness 4: `total_tokens` used to be summed
    // alongside the parts, so a turn reporting input and output but no
    // cache counts (a null total, per the wire identity every normalizer
    // enforces) added to the parts and not to the total — the cumulative
    // said 18 while its own components added to 24. Review live15 then
    // closed the remaining guess: deriving the total from the summed
    // parts counted a folded turn's MISSING cache figure as zero — 14 +
    // 3 + 7 looks exact while turn 2's cache contribution is unknown.
    // The total is now non-null only while every folded turn reported
    // all three parts; one missing figure nulls it until nothing has
    // been guessed, and the parts keep what each turn actually said.
    const nothing: ResultUsageBlock = {
      input_tokens: null,
      output_tokens: null,
      cached_input_tokens: null,
      total_tokens: null,
      cost_usd: null,
    };
    const first = block(); // 10 in / 5 out / 3 cached / 18 total
    const partial = block({
      input_tokens: 4,
      output_tokens: 2,
      cached_input_tokens: null,
      total_tokens: null,
      cost_usd: null,
    });
    const cumulative = addUsage(first, partial);
    expect(cumulative).toEqual({
      input_tokens: 14,
      output_tokens: 7,
      cached_input_tokens: 3,
      total_tokens: null, // turn 2 reported no cache figure — not zero
      cost_usd: 0.01,
    });
    // The turn fold inherits the same honesty (the drivers' cumulative).
    expect(addTurnUsage(first, partial).total_tokens).toBe(null);
    // A genuinely unknown part keeps the total null — it is not guessed.
    expect(
      addUsage(nothing, block({ cached_input_tokens: null, total_tokens: null })).total_tokens
    ).toBe(null);
    // The control: a turn reporting nothing disturbs a certified total.
    const certified = addUsage(block(), block()); // both turns complete: 36
    expect(certified.total_tokens).toBe(36);
    expect(addUsage(certified, nothing).total_tokens).toBe(36);
    // And a later complete turn cannot repair the guess: the earlier
    // turn's missing figure is still missing.
    expect(addUsage(cumulative, block()).total_tokens).toBe(null);
  });

  test("a turn's missing figure is never counted as zero in the total", () => {
    // Review live15, the finding's exact example: turn 1 reports no
    // cache count, turn 2 reports one. The cumulative's total must not
    // sum the parts as though turn 1's cache were zero — it stays null;
    // the parts keep each turn's own report.
    const nothing: ResultUsageBlock = {
      input_tokens: null,
      output_tokens: null,
      cached_input_tokens: null,
      total_tokens: null,
      cost_usd: null,
    };
    const noCache = block({
      cached_input_tokens: null,
      total_tokens: null,
    });
    const cumulative = addUsage(addUsage(nothing, noCache), block());
    expect(cumulative.input_tokens).toBe(20);
    expect(cumulative.output_tokens).toBe(10);
    expect(cumulative.cached_input_tokens).toBe(3); // turn 2's alone
    expect(cumulative.total_tokens).toBe(null); // turn 1's cache unknown
  });

  test("accumulateUsage: the first delta replaces, later ones add", () => {
    const first = accumulateUsage(null, block());
    expect(first).toEqual(block());
    expect(
      accumulateUsage(
        first,
        block({ input_tokens: 1, output_tokens: 1, cached_input_tokens: 1, total_tokens: 3, cost_usd: 0.02 })
      )
    ).toEqual(
      block({ input_tokens: 11, output_tokens: 6, cached_input_tokens: 4, total_tokens: 21, cost_usd: 0.03 })
    );
  });

  describe("addTurnUsage — the per-turn fold into the session cumulative", () => {
    test("token counts sum; the session-lifetime cost adopts the latest figure", () => {
      // The review-live8 defect: the only wire that carries a cost (the
      // claude-family result's total_cost_usd) reports a session-lifetime
      // figure each turn — every report already includes the earlier
      // turns — so summing the per-turn figures counts the earlier turns
      // again (two turns at $0.01 and $0.02 summed to $0.03).
      const nothing: ResultUsageBlock = {
        input_tokens: null,
        output_tokens: null,
        cached_input_tokens: null,
        total_tokens: null,
        cost_usd: null,
      };
      const first = addTurnUsage(nothing, block({ input_tokens: 10, cost_usd: 0.01 }));
      expect(first.input_tokens).toBe(10);
      expect(first.cost_usd).toBe(0.01);
      const second = addTurnUsage(first, block({ input_tokens: 7, cost_usd: 0.02 }));
      expect(second.input_tokens).toBe(17);
      expect(second.cost_usd).toBe(0.02); // adopted, not summed
    });

    test("a turn reporting no cost keeps the known figure", () => {
      const nothing: ResultUsageBlock = {
        input_tokens: null,
        output_tokens: null,
        cached_input_tokens: null,
        total_tokens: null,
        cost_usd: null,
      };
      const first = addTurnUsage(nothing, block({ cost_usd: 0.01 }));
      const second = addTurnUsage(first, block({ cost_usd: null, input_tokens: 1 }));
      expect(second.cost_usd).toBe(0.01);
      expect(second.input_tokens).toBe(11);
    });
  });
});
