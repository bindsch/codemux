/**
 * Unit tests for the kimi session's stream-json line parser under the
 * three tiers (design §4.7): the valid wire shapes the installed 0.31.1
 * binary's prompt-mode writer emits (kimi-session.ts names the sources).
 * Split from tests/session-kimi.test.ts; the malformed-shape grammar
 * errors are tests/session-kimi-parser-errors.test.ts.
 */

import { describe, expect, test } from "bun:test";
import { KIMI_ERROR_WITHOUT_MESSAGE, parseKimiStreamLine } from "../src/session/kimi-session.js";
import { ID, OTHER } from "./helpers/session-kimi.js";

describe("kimi session - parser tiers", () => {
  test("an assistant text line parses with its content", () => {
    const parse = parseKimiStreamLine(
      JSON.stringify({ role: "assistant", content: "hello" }),
      { knownSessionId: null }
    );
    expect(parse).toEqual({ kind: "assistant", text: "hello", toolCalls: [] });
  });

  test("a tool-calling assistant line parses each call with its arguments", () => {
    const parse = parseKimiStreamLine(
      JSON.stringify({
        role: "assistant",
        tool_calls: [
          {
            type: "function",
            id: "call_1",
            function: { name: "bash", arguments: JSON.stringify({ command: "ls" }) },
          },
        ],
      }),
      { knownSessionId: null }
    );
    expect(parse).toEqual({
      kind: "assistant",
      text: null,
      toolCalls: [{ callId: "call_1", name: "bash", input: { command: "ls" } }],
    });
  });

  test("an assistant line may carry content and tool calls together", () => {
    const parse = parseKimiStreamLine(
      JSON.stringify({
        role: "assistant",
        content: "listing",
        tool_calls: [
          { type: "function", id: "c2", function: { name: "read", arguments: '{"path":"x"}' } },
        ],
      }),
      { knownSessionId: null }
    );
    expect(parse).toMatchObject({ kind: "assistant", text: "listing" });
    expect(parse.kind === "assistant" && parse.toolCalls[0]?.input).toEqual({ path: "x" });
  });

  test("unparseable tool arguments stay the raw string, never guessed", () => {
    const parse = parseKimiStreamLine(
      JSON.stringify({
        role: "assistant",
        tool_calls: [
          { type: "function", id: "c1", function: { name: "bash", arguments: "{not json" } },
        ],
      }),
      { knownSessionId: null }
    );
    expect(parse.kind === "assistant" && parse.toolCalls[0]?.input).toBe("{not json");
  });

  test("a tool result line parses with its call id and stringified output", () => {
    const parse = parseKimiStreamLine(
      JSON.stringify({ role: "tool", tool_call_id: "call_1", content: "file-a\nfile-b" }),
      { knownSessionId: null }
    );
    expect(parse).toEqual({
      kind: "tool_result",
      callId: "call_1",
      output: "file-a\nfile-b",
    });
  });

  test("the resume hint parses with the session id the driver adopts", () => {
    const line = JSON.stringify({
      role: "meta",
      type: "session.resume_hint",
      session_id: ID,
      command: `kimi -r ${ID}`,
      content: `To resume this session: kimi -r ${ID}`,
    });
    expect(parseKimiStreamLine(line, { knownSessionId: null })).toEqual({
      kind: "resume_hint",
      sessionId: ID,
    });
    expect(parseKimiStreamLine(line, { knownSessionId: ID })).toEqual({
      kind: "resume_hint",
      sessionId: ID,
    });
  });

  test("informational meta (retrying, version) and roleless lines are tier-1 unknown", () => {
    expect(
      parseKimiStreamLine(
        JSON.stringify({ role: "meta", type: "turn.step.retrying", failed_attempt: 1 }),
        { knownSessionId: ID }
      ).kind
    ).toBe("unknown");
    expect(
      parseKimiStreamLine(JSON.stringify({ role: "meta", type: "system.version", version: "0.31.1" }), {
        knownSessionId: ID,
      }).kind
    ).toBe("unknown");
    expect(parseKimiStreamLine(JSON.stringify({ type: "goal.summary" }), { knownSessionId: ID }).kind).toBe(
      "unknown"
    );
  });

  test("the roleless error frame maps to the error kind; every other valid shape it must not claim stays its own kind (round 127)", () => {
    // The shapes the parser must KEEP, named before the error arm could
    // widen onto them: the three wire roles (each carries its own kind,
    // whatever its `type` field says) and the roleless non-error types
    // (tier 1). The error frame itself is recognized exactly as the
    // plain path recognizes it (kimi-fold-lines.ts): a line the role
    // arms do not claim whose `type` is "error", carrying the pinned
    // non-empty string `message` — the shape the plain fold synthesizes
    // as its wire anchor (kimi-fold.ts).
    expect(
      parseKimiStreamLine(JSON.stringify({ type: "error", message: "provider overloaded" }), {
        knownSessionId: ID,
      })
    ).toEqual({ kind: "error", message: "provider overloaded" });
    // An unrecognized role is still the plain path's error frame: the
    // role arms (assistant, tool, meta) do not claim it.
    expect(
      parseKimiStreamLine(JSON.stringify({ role: "system", type: "error", message: "boom" }), {
        knownSessionId: ID,
      }).kind
    ).toBe("error");
    // A wire role keeps its own kind even when `type` says error.
    expect(
      parseKimiStreamLine(
        JSON.stringify({ role: "assistant", type: "error", content: "text" }),
        { knownSessionId: ID }
      ).kind
    ).toBe("assistant");
    expect(
      parseKimiStreamLine(
        JSON.stringify({ role: "meta", type: "error", message: "not the frame" }),
        { knownSessionId: ID }
      ).kind
    ).toBe("unknown");
    // An error event with no usable message is still the harness
    // reporting a failure (the plain path fails a run on every event whose
    // type is "error", review round 129): it maps to the error kind with a
    // fixed reason, whether the message is missing, empty, or not a string.
    for (const frame of [{ type: "error" }, { type: "error", message: "" }, { type: "error", message: 7 }]) {
      expect(parseKimiStreamLine(JSON.stringify(frame), { knownSessionId: ID })).toEqual({
        kind: "error",
        message: KIMI_ERROR_WITHOUT_MESSAGE,
      });
    }
    // A type spelled any other way is not the error event.
    expect(parseKimiStreamLine(JSON.stringify({ type: "Error", message: "x" }), { knownSessionId: ID }).kind).toBe(
      "unknown"
    );
  });

  test("a non-JSON line is tier-3 unusable, with a bounded excerpt", () => {
    const parse = parseKimiStreamLine("this is not json", { knownSessionId: null });
    expect(parse.kind).toBe("unusable");
    if (parse.kind === "unusable") {
      expect(parse.excerpt).toBe("this is not json");
      expect(parse.bytes).toBe("this is not json".length);
    }
  });

  test("a JSON non-object (array) is tier-3 unusable", () => {
    expect(parseKimiStreamLine("[1,2]", { knownSessionId: null }).kind).toBe("unusable");
  });

  test("a resume hint with a malformed id, or naming a different session, is tier-2", () => {
    const bad = parseKimiStreamLine(
      JSON.stringify({
        role: "meta",
        type: "session.resume_hint",
        session_id: "not-a-session-id",
      }),
      { knownSessionId: null }
    );
    expect(bad.kind).toBe("grammar_error");
    const wrong = parseKimiStreamLine(
      JSON.stringify({
        role: "meta",
        type: "session.resume_hint",
        session_id: OTHER,
      }),
      { knownSessionId: ID }
    );
    expect(wrong.kind).toBe("grammar_error");
    expect(wrong.kind === "grammar_error" && wrong.message).toContain(OTHER);
  });
});
