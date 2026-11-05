/**
 * Unit tests for the codex stream parser's JSON-RPC id gate (review
 * round 110): an id whose JSON serialization corrupts — Infinity, an
 * unsafe integer, a fraction, -0 — is a grammar error on both a
 * response and a server request, and ordinary integer and string ids
 * stay acceptable and distinct. Split from
 * tests/session-codex-parser.test.ts (the 500-line rule).
 */

import { describe, expect, test } from "bun:test";
import { CodexStreamParser } from "../src/session/codex-session.js";

describe("codex session - stream parser ids", () => {
  const THREAD = "0123456789abcdef";
  const TURN = "turn-fake-1";

  function parser(withTurn = true): { parser: CodexStreamParser; ctx: { threadId: string | null; activeTurnId: string | null } } {
    return {
      parser: new CodexStreamParser(),
      ctx: { threadId: THREAD, activeTurnId: withTurn ? TURN : null },
    };
  }

  test("a numeric id serialization would corrupt is a grammar error on a response and a server request (review round 110)", () => {
    // The raw frame text carries the literals exactly: JSON.stringify
    // cannot spell most of these back (Infinity becomes null), so the
    // frames are written by hand.
    const { parser: p, ctx } = parser();
    const badIds = ["1e400", "1.5", "1e21", "9007199254740993", "-0"];
    for (const id of badIds) {
      const response = `{"id":${id},"result":{}}`;
      expect(p.feed(response, ctx)).toEqual([
        {
          kind: "grammar_error",
          message: "a response carries an id that is not a bounded string or a safe integer",
        },
      ]);
      const request = `{"id":${id},"method":"turn/steer","params":{}}`;
      expect(p.feed(request, ctx)).toEqual([
        {
          kind: "grammar_error",
          message:
            "server request turn/steer carries an id that is not a bounded string or a safe integer",
        },
      ]);
    }
    // null is a scalar JSON value but not an acceptable id.
    expect(p.feed('{"id":null,"result":{}}', ctx)).toEqual([
      {
        kind: "grammar_error",
        message: "a response carries an id that is not a bounded string or a safe integer",
      },
    ]);
  });

  test("ordinary integer and string ids stay acceptable and distinct (review round 110)", () => {
    const { parser: p, ctx } = parser();
    expect(p.feed('{"id":1,"result":{}}', ctx)).toEqual([{ kind: "response", id: 1, result: {} }]);
    expect(p.feed('{"id":"1","result":{}}', ctx)).toEqual([
      { kind: "response", id: "1", result: {} },
    ]);
    expect(p.feed('{"id":0,"result":{}}', ctx)).toEqual([{ kind: "response", id: 0, result: {} }]);
    expect(p.feed('{"id":-7,"result":{}}', ctx)).toEqual([{ kind: "response", id: -7, result: {} }]);
    const server = p.feed('{"id":1,"method":"turn/steer","params":{}}', ctx);
    expect(server[0]).toMatchObject({ kind: "server_request", id: 1 });
    const serverText = p.feed('{"id":"1","method":"turn/steer","params":{}}', ctx);
    expect(serverText[0]).toMatchObject({ kind: "server_request", id: "1" });
    // The caller-facing pending-set key keeps the two spellings apart.
    const approval = (id: string) =>
      p.feed(
        `{"id":${id},"method":"item/commandExecution/requestApproval","params":{"threadId":"${THREAD}","turnId":"${TURN}"}}`,
        ctx
      )[0] as { kind: string; requestId: string };
    expect(approval("1").requestId).toBe("1");
    expect(approval('"1"').requestId).toBe('"1"');
  });
});
