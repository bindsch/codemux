/** The parser's served-model facts (design P5), split from
 * tests/session-codex-parser.test.ts at the 500-line bound: the
 * model/rerouted notification is the one wire line that attributes a
 * codex turn's model from the provider side. */

import { describe, expect, test } from "bun:test";
import { CodexStreamParser } from "../src/session/codex-session.js";

describe("codex session - served model facts", () => {
  const THREAD = "0123456789abcdef";
  const TURN = "turn-fake-1";

  function parser(): { parser: CodexStreamParser; ctx: { threadId: string | null; activeTurnId: string | null } } {
    return {
      parser: new CodexStreamParser(),
      ctx: { threadId: THREAD, activeTurnId: TURN },
    };
  }

  function feed(line: Record<string, any>, ctx = parser().ctx, p = parser().parser) {
    return p.feed(JSON.stringify(line), ctx);
  }

  test("model/rerouted reports its to-model in both spellings; an unreadable one stays unknown (design P5)", () => {
    // codex 0.166.0's serde definitions carry both the camelCase
    // `toModel` and the snake_case `to_model` variants of the
    // ModelReroutedNotification, so both parse. No params, or no readable
    // string, is tier-1 unknown — never an attribution codemux invented.
    const { parser: p, ctx } = parser();
    expect(feed({ method: "model/rerouted", params: { toModel: "gpt-5.3-codex" } }, ctx, p)).toEqual([
      { kind: "model_rerouted", model: "gpt-5.3-codex" },
    ]);
    expect(feed({ method: "model/rerouted", params: { to_model: "gpt-5.3" } }, ctx, p)).toEqual([
      { kind: "model_rerouted", model: "gpt-5.3" },
    ]);
    expect(feed({ method: "model/rerouted", params: {} }, ctx, p)).toEqual([{ kind: "unknown" }]);
    expect(feed({ method: "model/rerouted", params: { toModel: 42 } }, ctx, p)).toEqual([{ kind: "unknown" }]);
    expect(feed({ method: "model/rerouted", params: { toModel: "" } }, ctx, p)).toEqual([{ kind: "unknown" }]);
    expect(feed({ method: "model/rerouted" }, ctx, p)).toEqual([{ kind: "unknown" }]);
  });
});
