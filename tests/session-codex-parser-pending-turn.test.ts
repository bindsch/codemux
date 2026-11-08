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

  test("a lifecycle notification for the provisional turn is accepted the way a delta is (review round 232)", () => {
    // A fast server can emit turn/started or turn/completed before the
    // turn/start response that names the turn; the window accepts them
    // on the provisional id like any scoped notification, holds to that
    // id, and still rejects another turn and a closed turn's echo.
    const first = feed({ method: "turn/started", params: { threadId: THREAD, turn: { id: "turn-a" } } },
      { threadId: THREAD, activeTurnId: null, turnPending: true });
    expect(first).toEqual([{ kind: "turn_started", threadId: THREAD, turnId: "turn-a" }]);
    const held = { threadId: THREAD, activeTurnId: null, turnPending: true, pendingTurnId: "turn-a" };
    expect(
      feed({ method: "turn/completed", params: { threadId: THREAD, turn: { id: "turn-a", status: "completed" } } }, held)
    ).toEqual([{ kind: "turn_completed", threadId: THREAD, turnId: "turn-a", finish: "end", reason: null }]);
    expect(
      feed({ method: "turn/completed", params: { threadId: THREAD, turn: { id: "turn-b", status: "completed" } } }, held)
    ).toEqual([
      { kind: "grammar_error", message: "a turn/completed notification for turn turn-b arrived while the starting turn's notifications name turn-a" },
    ]);
    // A closed turn's lifecycle notification never completes the
    // starting turn: only item, delta, and usage stragglers are tier-1.
    const closed = { threadId: THREAD, activeTurnId: null, turnPending: true, pendingTurnId: "turn-a",
      closedTurnIds: new Set([TURN]) };
    expect(
      feed({ method: "turn/completed", params: { threadId: THREAD, turn: { id: TURN, status: "completed" } } }, closed)[0]!.kind
    ).toBe("grammar_error");
    expect(
      feed({ method: "turn/completed", params: { threadId: THREAD, turn: { id: "turn-a" } } }, held)[0]!.kind
    ).toBe("turn_completed");
    // An empty id is no id (review round 250): neither a lifecycle
    // notification nor a delta may name the provisional turn "".
    const open = { threadId: THREAD, activeTurnId: null, turnPending: true };
    expect(
      feed({ method: "turn/completed", params: { threadId: THREAD, turn: { id: "", status: "completed" } } }, open)
    ).toEqual([{ kind: "grammar_error", message: "a turn/completed notification carries no turn id while a turn is starting" }]);
    expect(
      feed({ method: "item/agentMessage/delta", params: { threadId: THREAD, turnId: "", itemId: "m", delta: "x" } }, open)[0]!.kind
    ).toBe("grammar_error");
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


  test("a string request id is bounded like every harness id; its JSON spelling is the request_id (review round 74)", () => {
    const { MAX_ID_CHARS } = require("../src/session/protocol.js") as { MAX_ID_CHARS: number };
    const ctx = { threadId: THREAD, activeTurnId: TURN };
    const approval = (id: unknown) => feed({ id, method: "item/commandExecution/requestApproval",
      params: { threadId: THREAD, turnId: TURN, itemId: "c1", command: ["ls"], cwd: "/" } }, ctx)[0]!;
    const longest = "a".repeat(MAX_ID_CHARS);
    const accepted = approval(longest) as { kind: string; requestId?: string };
    expect(accepted.kind).toBe("permission_request");
    expect(accepted.requestId).toBe(JSON.stringify(longest));
    expect(approval("a".repeat(MAX_ID_CHARS + 1)).kind).toBe("grammar_error");
    expect(approval("").kind).toBe("grammar_error");
  });

  test("an explicit null turnId is the absent case (review round 391, item 7)", () => {
    // With no turn open, `"turnId": null` passed the idle check (null === the
    // idle activeTurnId) where an absent key was a tier-2 grammar error, and
    // a stray thread/tokenUsage/updated with a null turnId folded its usage
    // into the session's cumulative bucket, inflating session_ended.usage.
    // An explicit null is the absent case in every branch.
    const idle = { threadId: THREAD, activeTurnId: null };
    expect(feed({ method: "thread/tokenUsage/updated",
      params: { threadId: THREAD, turnId: null, tokenUsage: { last: { totalTokens: 3 } } } }, idle)).toEqual([
      { kind: "grammar_error", message: "a scoped notification with no turn id arrived while no turn is open" },
    ]);
    expect(feed({ method: "item/agentMessage/delta", params: { threadId: THREAD, turnId: null, delta: "x" } }, idle)).toEqual([
      { kind: "grammar_error", message: "a scoped notification with no turn id arrived while no turn is open" },
    ]);
    // Inside the window a non-string id was already the round-70 error; the
    // null now answers the same way it does when idle.
    const held = { threadId: THREAD, activeTurnId: null, turnPending: true, pendingTurnId: "turn-a" };
    expect(feed({ method: "thread/tokenUsage/updated",
      params: { threadId: THREAD, turnId: null, tokenUsage: { last: { totalTokens: 3 } } } }, held)).toEqual([
      { kind: "grammar_error", message: "a scoped notification with no turn id arrived while a turn was starting" },
    ]);
  });

  test("an approval request naming the provisional turn id is accepted during the window (review round 391, item 16)", () => {
    // Rounds 232 to 247 gave scoped notifications and lifecycle events the
    // turn/start window's provisional id; an approval request naming it was
    // still an unconditional grammar error, though a fast server can emit the
    // approval before the turn/start response that names the turn. The
    // approval follows the notification rule: the window holds to its id,
    // and without a held id there is nothing to name.
    const held = { threadId: THREAD, activeTurnId: null, turnPending: true, pendingTurnId: "turn-a" };
    const approval = (ctx: Parameters<CodexStreamParser["feed"]>[1], turnId: unknown) =>
      feed({ id: 5, method: "item/commandExecution/requestApproval",
        params: { threadId: THREAD, turnId, itemId: "c1", command: ["ls"], cwd: "/" } }, ctx)[0]!;
    const accepted = approval(held, "turn-a") as { kind: string; requestId?: string };
    expect(accepted.kind).toBe("permission_request");
    expect(accepted.requestId).toBe("5");
    expect(approval(held, "turn-b")).toEqual(
      { kind: "grammar_error", message: "an approval request for turn turn-b arrived with no open turn" }
    );
    expect(approval({ threadId: THREAD, activeTurnId: null, turnPending: true }, "turn-a").kind).toBe("grammar_error");
    // Outside the window nothing changes: no open turn, no approval.
    expect(approval({ threadId: THREAD, activeTurnId: null }, "turn-a").kind).toBe("grammar_error");
  });
});
