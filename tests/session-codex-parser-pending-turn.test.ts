/**
 * The codex stream parser's pending-turn window (review round 67): the
 * first turn id a scoped notification names while the turn/start response
 * is in flight is provisional, and the window holds to it.
 */
import { describe, expect, test } from "bun:test";
import { CodexStreamParser } from "../src/session/codex-session.js";

describe("codex session - stream parser, pending turn", () => {
  const THREAD = "0123456789abcdef";
  const TURN = "turn-fake-1";

  function feed(line: Record<string, unknown>, ctx: Parameters<CodexStreamParser["feed"]>[1], p = new CodexStreamParser()) {
    return p.feed(JSON.stringify(line), ctx);
  }

  test("the pending window holds to the first turn id it saw (review round 67)", () => {
    // Once the driver recorded the provisional id, a notification naming
    // another turn inside the same window is a grammar error; the same
    // id and a closed turn's straggler stay accepted.
    const ctx = { threadId: THREAD, activeTurnId: null, turnPending: true, pendingTurnId: "turn-a", closedTurnIds: new Set([TURN]) };
    const other = feed({ method: "item/agentMessage/delta", params: { threadId: THREAD, turnId: "turn-b", delta: "x" } }, ctx);
    expect(other).toEqual([
      { kind: "grammar_error", message: "a scoped notification for turn turn-b arrived while the starting turn's notifications name turn-a" },
    ]);
    expect(
      feed({ method: "item/agentMessage/delta", params: { threadId: THREAD, turnId: "turn-a", delta: "x" } }, ctx)
    ).toEqual([{ kind: "assistant_delta", threadId: THREAD, turnId: "turn-a", text: "x" }]);
    expect(
      feed({ method: "item/agentMessage/delta", params: { threadId: THREAD, turnId: TURN, delta: "x" } }, ctx)
    ).toEqual([{ kind: "assistant_delta", threadId: THREAD, turnId: TURN, text: "x" }]);
  });

  test("a scoped notification with no turn id during the window is a grammar error (review round 70)", () => {
    // With no id the window cannot hold to it and the turn/start response
    // cannot contradict it, so the event would be charged to the starting
    // turn silently; a non-string id is the same error.
    for (const pendingTurnId of [null, "turn-a"]) {
      const ctx = { threadId: THREAD, activeTurnId: null, turnPending: true, pendingTurnId };
      for (const params of [{ threadId: THREAD, delta: "x" }, { threadId: THREAD, turnId: 7, delta: "x" }]) {
        expect(feed({ method: "item/agentMessage/delta", params }, ctx)).toEqual([
          { kind: "grammar_error", message: "a scoped notification with no turn id arrived while a turn was starting" },
        ]);
      }
      expect(feed({ method: "thread/tokenUsage/updated",
        params: { threadId: THREAD, tokenUsage: { last: { totalTokens: 3 } } } }, ctx)[0]!.kind).toBe("grammar_error");
    }
  });

});
