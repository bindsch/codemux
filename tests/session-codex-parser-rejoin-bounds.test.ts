/**
 * The raw-newline rejoin bounds on a continuation that CLOSES valid JSON
 * (review round 292): the bounds used to be checked only when the parse
 * failed, so a frame that rejoined into a parseable object bypassed both
 * the byte and the line bound. Every existing bound test closed invalid
 * JSON, which is why the gap survived them.
 */

import { describe, expect, test } from "bun:test";
import { PARSE_BUFFER_MAX_BYTES } from "../src/session/codex-parse-facts.js";
import { CodexStreamParser } from "../src/session/codex-session.js";

const THREAD = "0123456789abcdef";
const TURN = "turn-fake-1";
const ctx = { threadId: THREAD, activeTurnId: TURN };

describe("codex session - rejoin bounds on a valid close (review round 292)", () => {
  test("a correctly closing continuation past the line bound is unusable", () => {
    const p = new CodexStreamParser();
    // An unterminated opener (line 1), then 999 unterminated continuations
    // (lines 2..1000): all buffered. The 1001st line closes the string,
    // params, and root — the joined text is VALID JSON — but the buffer
    // holds more lines than the bound allows, so the frame is the tier-3
    // fatal, never a classified delta.
    expect(p.feed(`{"method":"item/agentMessage/delta","params":{"threadId":"${THREAD}","turnId":"${TURN}","delta":"x`, ctx)).toEqual([]);
    for (let i = 0; i < 999; i += 1) {
      expect(p.feed(`more${i}`, ctx)).toEqual([]);
    }
    const closed = p.feed(`done"}}`, ctx);
    expect(closed).toHaveLength(1);
    expect(closed[0]!.kind).toBe("unusable");
    // The parser is clear afterwards: the next line parses on its own.
    expect(p.feed(`{"hello":"world"}`, ctx)).toEqual([{ kind: "unknown" }]);
  });

  test("a correctly closing continuation past the byte bound is unusable", () => {
    const p = new CodexStreamParser();
    // A buffered fragment just inside the byte bound, then a continuation
    // that pushes the joined size past it while completing valid JSON.
    const head = `{"method":"item/agentMessage/delta","params":{"threadId":"${THREAD}","turnId":"${TURN}","delta":"`;
    const fill = "é".repeat(Math.floor((PARSE_BUFFER_MAX_BYTES - 64 - head.length) / 2));
    const fragment = head + fill;
    expect(Buffer.byteLength(fragment, "utf8")).toBeLessThanOrEqual(PARSE_BUFFER_MAX_BYTES);
    expect(p.feed(fragment, ctx)).toEqual([]);
    const tail = `${"x".repeat(90)}"}}`; // 94 bytes; closes string, params, root
    const closed = p.feed(tail, ctx);
    expect(closed).toHaveLength(1);
    expect(closed[0]!.kind).toBe("unusable");
    expect((closed[0] as { bytes: number }).bytes).toBeGreaterThan(PARSE_BUFFER_MAX_BYTES);
    // The same continuation one line earlier (inside the bound) still
    // classifies: only the bound, not the close, makes it fatal.
    const q = new CodexStreamParser();
    expect(
      q.feed(`{"method":"item/agentMessage/delta","params":{"threadId":"${THREAD}","turnId":"${TURN}","delta":"split`, ctx)
    ).toEqual([]);
    expect(q.feed(`line"}}`, ctx)).toEqual([
      { kind: "assistant_delta", threadId: THREAD, turnId: TURN, text: "split\nline" },
    ]);
  });
});
