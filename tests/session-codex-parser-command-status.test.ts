/**
 * The codex commandExecution completion status (review round 199): the
 * repo's recorded fixtures define `completed` as the one success (a
 * refusal lands `declined`), so a completion with a missing or unknown
 * status is an error result, never a success. Fail-closed, the same rule
 * the parser applies to an unreadable turn status. Split from
 * tests/session-codex-parser.test.ts, which was at the 500-line cap.
 */
import { describe, expect, test } from "bun:test";
import { CodexStreamParser } from "../src/session/codex-session.js";
import { CWD } from "./helpers/session-codex.js";

const THREAD = "0123456789abcdef";
const TURN = "turn-fake-1";

const feed = (item: Record<string, unknown>): unknown[] =>
  new CodexStreamParser().feed(
    JSON.stringify({ method: "item/completed", params: { threadId: THREAD, turnId: TURN, item } }),
    { threadId: THREAD, activeTurnId: TURN }
  );

describe("commandExecution completion statuses", () => {
  test("completed is the success; declined and failed are errors", () => {
    expect(feed({ type: "commandExecution", id: "cmd-1", status: "completed", aggregatedOutput: "hi\n", exitCode: 0 }))
      .toEqual([{ kind: "tool_result", threadId: THREAD, turnId: TURN, callId: "cmd-1", output: "hi\n", isError: false }]);
    expect(feed({ type: "commandExecution", id: "cmd-2", status: "declined", aggregatedOutput: "" }))
      .toEqual([{ kind: "tool_result", threadId: THREAD, turnId: TURN, callId: "cmd-2", output: "", isError: true }]);
    expect(feed({ type: "commandExecution", id: "cmd-3", status: "failed", aggregatedOutput: "boom\n" }))
      .toEqual([{ kind: "tool_result", threadId: THREAD, turnId: TURN, callId: "cmd-3", output: "boom\n", isError: true }]);
  });

  test("a missing status is an error result, not a success", () => {
    expect(feed({ type: "commandExecution", id: "cmd-4", aggregatedOutput: "hi\n", exitCode: 0, cwd: CWD }))
      .toEqual([{ kind: "tool_result", threadId: THREAD, turnId: TURN, callId: "cmd-4", output: "hi\n", isError: true }]);
  });

  test("an unknown status is an error result, not a success", () => {
    expect(feed({ type: "commandExecution", id: "cmd-5", status: "wedged", aggregatedOutput: "hi\n", exitCode: 0 }))
      .toEqual([{ kind: "tool_result", threadId: THREAD, turnId: TURN, callId: "cmd-5", output: "hi\n", isError: true }]);
  });
});
