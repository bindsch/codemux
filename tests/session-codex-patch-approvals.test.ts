import { describe, expect, test } from "bun:test";
import { CodexStreamParser } from "../src/session/codex-session.js";
import { CodexPatchApprovals, MAX_PATCH_APPROVAL_BYTES, MAX_PATCH_APPROVAL_ITEMS } from "../src/session/codex-patch-approvals.js";

const THREAD = "0123456789abcdef";
const TURN = "turn-1";
const changes = [{ path: "/workspace/file.txt", kind: { type: "update" }, diff: "-a\n+b\n" }];
const context = { threadId: THREAD, activeTurnId: TURN };
const ask = (parser: CodexStreamParser, extra: Record<string, unknown> = {}) => parser.feed(JSON.stringify({
  id: "approval-1", method: "item/fileChange/requestApproval",
  params: { threadId: THREAD, turnId: TURN, itemId: "patch-1", ...extra },
}), context);
const notify = (parser: CodexStreamParser, method: string, params: Record<string, unknown>) => parser.feed(
  JSON.stringify({ method, params: { threadId: THREAD, turnId: TURN, ...params } }), context
);
const start = (parser: CodexStreamParser) => notify(parser, "item/started", {
  item: { id: "patch-1", type: "fileChange", status: "inProgress", changes },
});

describe("native codex patch approval correlation", () => {
  test("native itemId requests receive the matching proposed changes", () => {
    const parser = new CodexStreamParser();
    expect(start(parser)).toEqual([{ kind: "unknown" }]);
    expect(ask(parser)[0]).toMatchObject({ kind: "permission_request", input: { itemId: "patch-1", changes } });
    expect(ask(parser, { itemId: "other" })[0]?.kind).toBe("unparseable_approval");
    expect(ask(parser, { itemId: 1 })[0]?.kind).toBe("unparseable_approval");
    expect(ask(parser, { changes: [] })[0]?.kind).toBe("unparseable_approval");
  });

  test("updates replace the proposal and malformed updates invalidate it", () => {
    const parser = new CodexStreamParser();
    start(parser);
    const moved = [{ path: "/workspace/file.txt", kind: { type: "update", move_path: "/outside/file.txt" } }];
    notify(parser, "item/fileChange/patchUpdated", { itemId: "patch-1", changes: moved });
    expect(ask(parser)[0]).toMatchObject({ kind: "permission_request", input: { changes: moved } });
    notify(parser, "item/updated", { item: { id: "patch-1", type: "fileChange", changes: [] } });
    expect(ask(parser)[0]?.kind).toBe("unparseable_approval");
  });

  test("updates reject other threads and turns without replacing the proposal", () => {
    const parser = new CodexStreamParser();
    start(parser);
    expect(notify(parser, "item/fileChange/patchUpdated", { threadId: "other-thread", itemId: "patch-1", changes: [] })[0]?.kind)
      .toBe("grammar_error");
    expect(notify(parser, "item/fileChange/patchUpdated", { turnId: "other-turn", itemId: "patch-1", changes: [] })[0]?.kind)
      .toBe("grammar_error");
    expect(notify(parser, "item/fileChange/patchUpdated", { changes: [] })).toEqual([{ kind: "unknown" }]);
    expect(ask(parser)[0]).toMatchObject({ kind: "permission_request", input: { changes } });
  });

  test("item completion and turn completion discard proposed changes", () => {
    const parser = new CodexStreamParser();
    start(parser);
    notify(parser, "item/completed", { item: { id: "patch-1", type: "fileChange", changes, status: "completed" } });
    expect(ask(parser)[0]?.kind).toBe("unparseable_approval");
    start(parser);
    notify(parser, "turn/completed", { turn: { id: TURN, status: "completed" } });
    expect(ask(parser)[0]?.kind).toBe("unparseable_approval");
  });

  test("inline changes from older servers still work without an item", () => {
    expect(ask(new CodexStreamParser(), { changes })[0]).toMatchObject({ kind: "permission_request", input: { changes } });
  });

  test("a declined patch completion preserves raw output without reporting writes", () => {
    const parser = new CodexStreamParser();
    start(parser);
    expect(notify(parser, "item/completed", {
      item: { id: "patch-1", type: "fileChange", changes, status: "declined" },
    })).toEqual([{ kind: "unknown" }]);
    expect(ask(parser)[0]?.kind).toBe("unparseable_approval");
  });
});

describe("bounded patch proposals", () => {
  test("thread, turn and item IDs are independent keys and cleanup is scoped", () => {
    const cache = new CodexPatchApprovals();
    cache.record("thread-a", TURN, "item", changes);
    cache.record("thread-a", "turn-2", "item", changes);
    expect(cache.changes("thread-b", TURN, "item")).toBeUndefined();
    expect(cache.changes("thread-a", TURN, null)).toBeUndefined();
    cache.forgetTurn(TURN);
    expect(cache.changes("thread-a", TURN, "item")).toBeUndefined();
    expect(cache.changes("thread-a", "turn-2", "item")).toEqual(changes);
    cache.forgetItem("thread-a", "turn-2", "item");
    expect(cache.changes("thread-a", "turn-2", "item")).toBeUndefined();
  });

  test("the item limit evicts old proposals", () => {
    const cache = new CodexPatchApprovals();
    for (let index = 0; index <= MAX_PATCH_APPROVAL_ITEMS; index++) cache.record(THREAD, TURN, `item-${index}`, changes);
    expect(cache.changes(THREAD, TURN, "item-0")).toBeUndefined();
    expect(cache.changes(THREAD, TURN, `item-${MAX_PATCH_APPROVAL_ITEMS}`)).toEqual(changes);
  });

  test("the byte limit evicts old proposals and refuses oversized replacements", () => {
    const cache = new CodexPatchApprovals();
    const large = [{ path: "/workspace/file.txt", diff: "a".repeat(MAX_PATCH_APPROVAL_BYTES / 2) }];
    cache.record(THREAD, TURN, "a", large);
    cache.record(THREAD, TURN, "b", large);
    expect(cache.changes(THREAD, TURN, "a")).toBeUndefined();
    expect(cache.changes(THREAD, TURN, "b")).toEqual(large);
    cache.record(THREAD, TURN, "b", [{ path: "/workspace/file.txt", diff: "a".repeat(MAX_PATCH_APPROVAL_BYTES) }]);
    expect(cache.changes(THREAD, TURN, "b")).toBeUndefined();
    cache.record(THREAD, TURN, "c", null);
    cache.record(THREAD, TURN, "c", [{}]);
    expect(cache.changes(THREAD, TURN, "c")).toBeUndefined();
  });
});
