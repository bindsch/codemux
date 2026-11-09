/** The claude-family parser's served-model facts (design P5), split from
 * tests/session-claude-parser.test.ts at the 500-line bound: the init
 * model (the harness's configured model), the assistant frame's
 * message.model (the provider's own naming), and the result's
 * modelUsage keys. */

import { describe, expect, test } from "bun:test";
import { ClaudeStreamParser } from "../src/session/claude-session.js";
import { FLOOR_ID } from "./helpers/session-claude.js";

function feedOne(parser: ClaudeStreamParser, event: unknown, expectedSessionId = FLOOR_ID): unknown[] {
  return parser.feed(JSON.stringify(event), { expectedSessionId });
}

describe("ClaudeStreamParser - served model facts", () => {
  test("init reports the model the harness configured (design P5)", () => {
    // claude.exe 2.1.317 writes `model:e.model` on the init subtype; a
    // non-string or empty model reports null — the fact always carries the
    // field, so the announcement spells a null, never a missing key.
    const parser = new ClaudeStreamParser();
    expect(
      feedOne(parser, { type: "system", subtype: "init", session_id: FLOOR_ID, model: "glm-5.3" })
    ).toEqual([{ kind: "init", sessionId: FLOOR_ID, model: "glm-5.3" }]);
    const parser2 = new ClaudeStreamParser();
    expect(
      feedOne(parser2, { type: "system", subtype: "init", session_id: FLOOR_ID, model: "" })
    ).toEqual([{ kind: "init", sessionId: FLOOR_ID, model: null }]);
    const parser3 = new ClaudeStreamParser();
    expect(
      feedOne(parser3, { type: "system", subtype: "init", session_id: FLOOR_ID, model: 42 })
    ).toEqual([{ kind: "init", sessionId: FLOOR_ID, model: null }]);
  });

  test("an assistant frame reports its message.model ahead of the content facts", () => {
    // The provider's own naming of the model that answered (design P5):
    // one fact per frame, before the block facts, and a frame with no
    // readable model contributes none.
    const parser = new ClaudeStreamParser();
    expect(
      feedOne(parser, {
        type: "assistant",
        session_id: FLOOR_ID,
        message: { id: "msg_m", model: "glm-5.3", content: [{ type: "text", text: "hi" }] },
      })
    ).toEqual([
      { kind: "assistant_model", model: "glm-5.3" },
      { kind: "assistant_text", text: "hi" },
    ]);
    expect(
      feedOne(parser, {
        type: "assistant",
        session_id: FLOOR_ID,
        message: { id: "msg_m2", content: [{ type: "text", text: "anon" }] },
      })
    ).toEqual([{ kind: "assistant_text", text: "anon" }]);
    expect(
      feedOne(parser, {
        type: "assistant",
        session_id: FLOOR_ID,
        message: { id: "msg_m3", model: "", content: [{ type: "text", text: "empty model" }] },
      })
    ).toEqual([{ kind: "assistant_text", text: "empty model" }]);
  });

  test("a result names its modelUsage keys; two keys or an array name none (round 211)", () => {
    // One key is the provider's single-model report for the turn; two
    // keys cannot name one model, and an array's "0" index is a position,
    // never a model name — both read as no models at all.
    const parser = new ClaudeStreamParser();
    const one = feedOne(parser, {
      type: "result",
      session_id: FLOOR_ID,
      subtype: "success",
      usage: { input_tokens: 1, output_tokens: 1 },
      modelUsage: { "glm-5.3": { input_tokens: 1, output_tokens: 1 } },
    })[0] as { kind: string; models: string[] };
    expect(one.kind).toBe("turn_completed");
    expect(one.models).toEqual(["glm-5.3"]);
    const two = feedOne(parser, {
      type: "result",
      session_id: FLOOR_ID,
      subtype: "success",
      usage: { input_tokens: 1, output_tokens: 1 },
      modelUsage: {
        "glm-5.3": { input_tokens: 1 },
        "glm-5.3-air": { input_tokens: 1 },
      },
    })[0] as { models: string[] };
    expect(two.models).toEqual(["glm-5.3", "glm-5.3-air"]);
    const array = feedOne(parser, {
      type: "result",
      session_id: FLOOR_ID,
      subtype: "success",
      usage: { input_tokens: 1, output_tokens: 1 },
      modelUsage: [{ "glm-5.3": { input_tokens: 1 } }],
    })[0] as { models: string[] };
    expect(array.models).toEqual([]);
  });
});
