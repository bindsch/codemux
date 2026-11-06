/**
 * The claude-family parser's echo of a numeric control-request id
 * (review round 199): a number JSON serialization corrupts is never
 * echoed — JSON.parse has already rounded an integer past
 * Number.MAX_SAFE_INTEGER, so the parsed value is not the id the harness
 * sent — and the parse reports the request with no usable id instead,
 * the branch the driver answers with "could not be answered". Split from
 * tests/session-claude-parser.test.ts, which was at the 500-line cap.
 */
import { describe, expect, test } from "bun:test";
import { ClaudeStreamParser } from "../src/session/claude-session.js";
import { FLOOR_ID } from "./helpers/session-claude.js";

const feed = (raw: string): unknown[] =>
  new ClaudeStreamParser().feed(raw, { expectedSessionId: FLOOR_ID });

describe("numeric control-request ids the answer can echo", () => {
  test("a safe integer id echoes with its wire type", () => {
    expect(feed(JSON.stringify({ type: "control_request", request_id: 7, request: { subtype: "hook_callback" } })))
      .toEqual([{ kind: "unsupported_control_request", requestId: 7, subtype: "hook_callback" }]);
  });

  test("negative zero is reported with no usable id; a fraction and zero echo (review rounds 201, 204)", () => {
    // JSON.stringify writes -0 as 0, so the answer could name another
    // request. A fraction is written back as the same value: refusing it
    // would leave the request unanswered until the turn timeout.
    for (const id of ["-0", "-0.0"]) {
      const raw = `{"type":"control_request","request_id":${id},"request":{"subtype":"hook_callback"}}`;
      expect(feed(raw)).toEqual([{ kind: "unsupported_control_request", requestId: null, subtype: "hook_callback" }]);
    }
    for (const [id, value] of [["0", 0], ["1.5", 1.5], ["1.10", 1.1]] as const) {
      const raw = `{"type":"control_request","request_id":${id},"request":{"subtype":"hook_callback"}}`;
      expect(feed(raw)).toEqual([{ kind: "unsupported_control_request", requestId: value, subtype: "hook_callback" }]);
    }
  });

  test("an integer past the safe range is reported with no usable id, never echoed", () => {
    // The raw line carries 9007199254740993 (2^53 + 1); JSON.parse has
    // already rounded it to 2^53, so echoing the parsed value would
    // answer a request that never existed and leave the real one waiting.
    const raw = '{"type":"control_request","request_id":9007199254740993,"request":{"subtype":"hook_callback"}}';
    expect(feed(raw)).toEqual([{ kind: "unsupported_control_request", requestId: null, subtype: "hook_callback" }]);
    // The boundary itself still echoes: MAX_SAFE_INTEGER is exact.
    const bound = `{"type":"control_request","request_id":${Number.MAX_SAFE_INTEGER},"request":{"subtype":"hook_callback"}}`;
    expect(feed(bound)).toEqual([
      { kind: "unsupported_control_request", requestId: Number.MAX_SAFE_INTEGER, subtype: "hook_callback" },
    ]);
  });

  test("a number JSON.parse folds to Infinity is reported with no usable id", () => {
    // 1e999 parses to Infinity: not finite, so JSON.stringify would
    // render it null. Same refusal.
    const raw = '{"type":"control_request","request_id":1e999,"request":{"subtype":"hook_callback"}}';
    expect(feed(raw)).toEqual([{ kind: "unsupported_control_request", requestId: null, subtype: "hook_callback" }]);
  });
});
