/**
 * Unit tests for the cumulative usage arithmetic (design §4.2): the sums
 * are field-wise and keep what is known — a null side yields the other
 * side, never a guessed zero, and never a wipe of what earlier turns
 * reported (the review-live4 defect: one partially-reporting turn nulled
 * the cumulative field for the whole session).
 */

import { afterEach, describe, expect, test } from "bun:test";
import { emptyUsage, normalizeClaudeUsage } from "../src/result-envelope/common.js";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import type { ResultUsageBlock } from "../src/types.js";
import { markOverflowed, overflowedFields, addTurnUsage, addUsage, accumulateUsage } from "../src/session/usage.js";
import { appendSessionCallRecord, CALL_LOG_ENV, readCallLog, resetCallLogWarningForTests } from "../src/call-log.js";
import { buildEvent } from "../src/session/protocol.js";
import { tempEnv } from "./helpers/call-log.js";

afterEach(() => {
  resetCallLogWarningForTests();
});

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

  test("a token sum that would leave the safe-integer range is unknown, never rounded (round 80)", () => {
    // The finding's example, in the cumulative fold: a block reporting
    // input at the ceiling joined by one reporting two more summed to
    // 9007199254740992 — a rounded number, not the mathematical
    // 9007199254740993. The safe-sum rule (safeTokenSum) makes the
    // overflowing field null; the parts that stay inside the range keep
    // their sums; the computed total certifies nothing while a part is
    // unknown.
    const huge = block({
      input_tokens: Number.MAX_SAFE_INTEGER,
      output_tokens: 0,
      cached_input_tokens: 0,
      total_tokens: Number.MAX_SAFE_INTEGER,
      cost_usd: null,
    });
    const small = block({
      input_tokens: 2,
      output_tokens: 0,
      cached_input_tokens: 0,
      total_tokens: 2,
      cost_usd: null,
    });
    const folded = addUsage(huge, small);
    expect(folded.input_tokens).toBe(null);
    expect(folded.output_tokens).toBe(0);
    expect(folded.cached_input_tokens).toBe(0);
    expect(folded.total_tokens).toBe(null);
    // The turn fold inherits the same rule.
    expect(addTurnUsage(huge, small).input_tokens).toBe(null);
    // Cost is money, not a count: it keeps its plain float sum.
    expect(addUsage(block({ cost_usd: 0.01 }), block({ cost_usd: 0.02 })).cost_usd).toBe(0.03);
  });

  test("a cost sum that leaves the finite range is null, never Infinity (round 90)", () => {
    // The ledger's reader accepts every finite cost, so two
    // Number.MAX_VALUE blocks are honest inputs; the fold's money total is
    // unknown, not the float addition's Infinity.
    const overflowed = addUsage(
      block({ cost_usd: Number.MAX_VALUE }),
      block({ cost_usd: Number.MAX_VALUE })
    );
    expect(overflowed.cost_usd).toBe(null);
    // The overflow is sticky: a later figure does not restart the total
    // from the null the overflow left (round 91).
    expect(overflowedFields(overflowed)).toEqual(["cost_usd"]);
    expect(addUsage(overflowed, block({ cost_usd: 1 })).cost_usd).toBe(null);
    expect(addUsage(block({ cost_usd: 1 }), overflowed).cost_usd).toBe(null);
    // The turn fold adopts the harness's latest session figure, which
    // settles the cost again; a turn that reports none keeps it unknown,
    // and the token fold is untouched either way.
    const noCost = addTurnUsage(overflowed, block({ input_tokens: 2, output_tokens: 1, cached_input_tokens: 0, total_tokens: 3, cost_usd: null }));
    expect(noCost.cost_usd).toBe(null);
    expect(overflowedFields(noCost)).toEqual(["cost_usd"]);
    // 10 + 10 from the two overflowed blocks' defaults, plus this turn's 2.
    expect(noCost.input_tokens).toBe(22);
    const settled = addTurnUsage(noCost, block({ cost_usd: 0.25 }));
    expect(settled.cost_usd).toBe(0.25);
    expect(overflowedFields(settled)).toEqual([]);
    // A turn whose own accumulation overflowed makes the session cost unknown.
    expect(addTurnUsage(block({ cost_usd: 3 }), overflowed).cost_usd).toBe(null);
  });

  test("an overflowed field stays unknown through every later fold (round 81)", () => {
    // After MAX_SAFE_INTEGER + 2 overflowed input_tokens to null, a later
    // turn reporting 5 must not revive it as 5: the null of an overflow
    // is not the null of "never reported".
    const at = (input_tokens: number): ResultUsageBlock => block({
      input_tokens, output_tokens: 1, cached_input_tokens: 0, total_tokens: input_tokens + 1, cost_usd: null,
    });
    let running = addUsage(at(Number.MAX_SAFE_INTEGER), at(2));
    expect(running.input_tokens).toBe(null);
    expect(overflowedFields(running)).toEqual(["input_tokens"]);
    running = addUsage(running, at(5));
    expect(running.input_tokens).toBe(null);
    expect(running.output_tokens).toBe(3);
    expect(running.total_tokens).toBe(null);
    // The turn fold and the per-turn accumulator carry the mark too.
    running = addTurnUsage(running, { ...at(7), cost_usd: 0.5 });
    expect(running.input_tokens).toBe(null);
    expect(running.cost_usd).toBe(0.5);
    expect(overflowedFields(running)).toEqual(["input_tokens"]);
    expect(accumulateUsage(running, at(1)).input_tokens).toBe(null);
    // A marked addend marks the result as well.
    expect(addUsage(at(1), running).input_tokens).toBe(null);
    // A turn whose own accumulator overflowed (two deltas inside one turn)
    // carries the mark through the turn fold's copy of the addend, so the
    // next turn cannot revive the cumulative field (round 82).
    const turn = accumulateUsage(accumulateUsage(null, at(Number.MAX_SAFE_INTEGER)), at(2));
    expect(overflowedFields(turn)).toEqual(["input_tokens"]);
    let cumulative = addTurnUsage(block({ input_tokens: 1, output_tokens: 1, cached_input_tokens: 0, total_tokens: 2, cost_usd: null }), turn);
    expect(cumulative.input_tokens).toBe(null);
    expect(overflowedFields(cumulative)).toEqual(["input_tokens"]);
    cumulative = addTurnUsage(cumulative, at(5));
    expect(cumulative.input_tokens).toBe(null);
    // A normalizer's own overflow (a cache pair past the range) is marked
    // the same way, so the fold never revives the field (round 84).
    const cacheOverflow = markOverflowed(block({ input_tokens: 1, output_tokens: 1, cached_input_tokens: null, total_tokens: null, cost_usd: null }), ["cached_input_tokens"]);
    const later = block({ input_tokens: 1, output_tokens: 1, cached_input_tokens: 5, total_tokens: 7, cost_usd: null });
    expect(addUsage(cacheOverflow, later).cached_input_tokens).toBe(null);
    expect(addUsage(later, cacheOverflow).cached_input_tokens).toBe(null);
    // The Claude and Z.AI normalizer marks its own cache-sum overflow, so
    // a later turn's cache count cannot revive the cumulative (round 85).
    const claudeTurn = normalizeClaudeUsage({ input_tokens: 1, output_tokens: 1,
      cache_read_input_tokens: Number.MAX_SAFE_INTEGER, cache_creation_input_tokens: 2 }, null);
    expect(claudeTurn.cached_input_tokens).toBe(null);
    expect(overflowedFields(claudeTurn)).toEqual(["cached_input_tokens"]);
    const nextTurn = normalizeClaudeUsage({ input_tokens: 1, output_tokens: 1,
      cache_read_input_tokens: 5, cache_creation_input_tokens: 0 }, null);
    expect(overflowedFields(nextTurn)).toEqual([]);
    const session = addTurnUsage(addTurnUsage(emptyUsage(), claudeTurn), nextTurn);
    expect(session.cached_input_tokens).toBe(null);
    expect(session.input_tokens).toBe(2);
  });

  test("an unknown total carries null into the session event and the ledger summary (round 80)", () => {
    // What the surfaces carry was decided with the fix: null, the field
    // the envelope itself reports for an unknown count — never a rounded
    // number and never zero.
    const unknown: ResultUsageBlock = {
      input_tokens: null,
      output_tokens: 3,
      cached_input_tokens: null,
      total_tokens: null,
      cost_usd: null,
    };
    const event = buildEvent(7, "sess-1", "session_ended", null, { usage: unknown });
    expect(event).toContain('"total_tokens":null');
    expect(JSON.parse(event).usage.total_tokens).toBe(null);
    const { env, dir, cleanup } = tempEnv();
    try {
      const path = join(dir, "calls.jsonl");
      appendSessionCallRecord(
        {
          agent: "codex",
          model: null,
          provider: "default",
          autonomy: "low",
          hermetic: false,
          sandboxed: true,
          cwd: "/repo",
        },
        "sess-1",
        Date.now() - 1000,
        "stdin-close",
        0,
        unknown,
        { ...env, [CALL_LOG_ENV]: path }
      );
      expect(readFileSync(path, "utf8")).toContain('"total_tokens":null');
      const record = readCallLog(path).entries[0]!.record!;
      expect(record.usage.total_tokens).toBe(null);
      expect(record.usage.input_tokens).toBe(null);
    } finally {
      cleanup();
    }
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
