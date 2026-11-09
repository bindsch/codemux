import { describe, expect, test } from "bun:test";
import { CursorAdapter } from "../src/adapters/cursor.js";
import {
  buildCursorSessionCommand,
  cursorSessionAutonomyFlags,
  cursorSessionCapabilities,
  CURSOR_SESSION_FLOOR,
  CURSOR_SESSION_ID_PATTERN,
  parseCursorSessionTurn,
} from "../src/session/cursor-session.js";

/** A codemux-style mint: lowercase UUIDv4 (version nibble 4, variant 8). */
const ID = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
/** A second, well-shaped mint (version 4, variant 9). */
const OTHER_ID = "2b3c4d5e-6f70-4a8b-9c0d-1e2f3a4b5c6d";

const resultLine = (fields: Record<string, unknown>): string =>
  `${JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    duration_ms: 12,
    duration_api_ms: 10,
    result: "reply",
    session_id: ID,
    request_id: "req-1",
    ...fields,
  })}\n`;

/** One stream-json model-call usage event: inputTokens is NET of the
 * cache counters (the event writer's own arithmetic, 1706.index.js). */
const usageEvent = (
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens: number,
  cacheWriteTokens: number
): string =>
  `${JSON.stringify({
    type: "usage",
    subtype: "model_call",
    session_id: ID,
    usage: { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens },
  })}\n`;

describe("cursor session wiring", () => {
  test("the floor and the binary's own UUIDv4 id shape", () => {
    expect(CURSOR_SESSION_FLOOR).toBe("2026.11.05");
    expect(CURSOR_SESSION_ID_PATTERN.test(ID)).toBe(true);
    // The binary's validation regex is case-insensitive (2683.index.js).
    expect(CURSOR_SESSION_ID_PATTERN.test(ID.toUpperCase())).toBe(true);
    // Version nibble must be 4: a v1-shaped id is refused.
    expect(CURSOR_SESSION_ID_PATTERN.test("1a2b3c4d-5e6f-1a7b-8c9d-0e1f2a3b4c5d")).toBe(false);
    // Variant nibble must be 8/9/a/b.
    expect(CURSOR_SESSION_ID_PATTERN.test("1a2b3c4d-5e6f-4a7b-0c9d-0e1f2a3b4c5d")).toBe(false);
    // Goose's date_time mint and a bare uuid-shaped-but-short string: refused.
    expect(CURSOR_SESSION_ID_PATTERN.test("20250921_143022")).toBe(false);
    expect(CURSOR_SESSION_ID_PATTERN.test("")).toBe(false);
    expect(CURSOR_SESSION_ID_PATTERN.test("1a2b3c4d-5e6f-4a7b-8c9d")).toBe(false);
  });

  test("capabilities: live input and resume; nothing else", () => {
    expect(cursorSessionCapabilities()).toEqual({
      live_input: true,
      user_during_turn: false,
      steer: false,
      interrupt: false,
      permissions: false,
      deltas: false,
      file_changes: false,
      usage_stream: false,
      resume: true,
    });
  });

  test("the session autonomy flags are the run adapter's mapping", () => {
    const adapter = new CursorAdapter();
    for (const level of ["read-only", "low", "medium", "high"] as const) {
      expect(cursorSessionAutonomyFlags(level)).toEqual(adapter.mapAutonomy(level));
    }
    expect(cursorSessionAutonomyFlags("read-only")).toEqual(["--mode", "plan"]);
    expect(cursorSessionAutonomyFlags("low")).toEqual([]);
    expect(cursorSessionAutonomyFlags("medium")).toEqual(["--auto-review"]);
    expect(cursorSessionAutonomyFlags("high")).toEqual(["--force"]);
  });

  test("a fresh turn claims the mint; a resumed turn continues it", () => {
    expect(
      buildCursorSessionCommand({ autonomy: "low", sessionId: ID, startSession: true })
    ).toEqual([
      "cursor-agent",
      "--print",
      "--output-format",
      "stream-json",
      "--trust",
      "--new-session-id",
      ID,
    ]);
    expect(
      buildCursorSessionCommand({ autonomy: "low", sessionId: ID, startSession: false })
    ).toEqual([
      "cursor-agent",
      "--print",
      "--output-format",
      "stream-json",
      "--trust",
      "--resume",
      ID,
    ]);
  });

  test("model and autonomy ride the adapter's order, after the session flag", () => {
    expect(
      buildCursorSessionCommand({
        autonomy: "medium",
        model: "gpt-5",
        sessionId: ID,
        startSession: false,
      })
    ).toEqual([
      "cursor-agent",
      "--print",
      "--output-format",
      "stream-json",
      "--trust",
      "--resume",
      ID,
      "--model",
      "gpt-5",
      "--auto-review",
    ]);
    expect(
      buildCursorSessionCommand({ autonomy: "read-only", sessionId: ID, startSession: true })
    ).toEqual([
      "cursor-agent",
      "--print",
      "--output-format",
      "stream-json",
      "--trust",
      "--new-session-id",
      ID,
      "--mode",
      "plan",
    ]);
    expect(
      buildCursorSessionCommand({ autonomy: "high", sessionId: ID, startSession: false })
    ).toEqual([
      "cursor-agent",
      "--print",
      "--output-format",
      "stream-json",
      "--trust",
      "--resume",
      ID,
      "--force",
    ]);
  });

  test("--tools none reapplies the run path's allowlist on every turn", () => {
    // Fresh or resumed, each turn's argv carries the same allowlist, so a
    // resumed session keeps the tool set the first turn promised.
    expect(
      buildCursorSessionCommand({ autonomy: "low", sessionId: ID, startSession: true, tools: "none" })
    ).toEqual([
      "cursor-agent",
      "--print",
      "--output-format",
      "stream-json",
      "--trust",
      "--new-session-id",
      ID,
      "--allowed-tools",
      "reflect_tool_call",
    ]);
    expect(
      buildCursorSessionCommand({ autonomy: "low", sessionId: ID, startSession: false, tools: "none" })
    ).toEqual([
      "cursor-agent",
      "--print",
      "--output-format",
      "stream-json",
      "--trust",
      "--resume",
      ID,
      "--allowed-tools",
      "reflect_tool_call",
    ]);
  });

  test("an id that fails the binary's UUIDv4 rule never reaches argv", () => {
    expect(() =>
      buildCursorSessionCommand({ autonomy: "low", sessionId: "20250921_143022", startSession: true })
    ).toThrow(/UUIDv4/);
    expect(() =>
      buildCursorSessionCommand({ autonomy: "low", sessionId: "1a2b3c4d-5e6f-1a7b-8c9d-0e1f2a3b4c5d", startSession: false })
    ).toThrow(/refusing/);
  });

  test("the turn parse folds the usage events and checks the mint", () => {
    const wire = usageEvent(10, 2, 3, 4) + resultLine({});
    const parsed = parseCursorSessionTurn(wire, { sessionId: ID });
    expect(parsed.noWire).toBe(false);
    expect(parsed.noSessionId).toBe(false);
    expect(parsed.wrongSession).toBe(false);
    expect(parsed.answer).toBe("reply");
    expect(parsed.sessionId).toBe(ID);
    // The claude-family usage fold: cache read + write sum into
    // cached_input_tokens, and the total folds all three counts.
    expect(parsed.usage.input_tokens).toBe(10);
    expect(parsed.usage.output_tokens).toBe(2);
    expect(parsed.usage.cached_input_tokens).toBe(7);
    expect(parsed.usage.total_tokens).toBe(19);
  });

  test("a stream with no usage events falls back to the result line's own", () => {
    const parsed = parseCursorSessionTurn(
      resultLine({ usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 } }),
      { sessionId: ID }
    );
    expect(parsed.usage.input_tokens).toBe(10);
    expect(parsed.usage.cached_input_tokens).toBe(7);
    expect(parsed.usage.total_tokens).toBe(19);
  });

  test("a result line without a usage key still parses, usage all-null", () => {
    const parsed = parseCursorSessionTurn(resultLine({}), { sessionId: ID });
    expect(parsed.noWire).toBe(false);
    expect(parsed.usage).toEqual({
      input_tokens: null,
      output_tokens: null,
      cached_input_tokens: null,
      total_tokens: null,
      cost_usd: null,
    });
  });

  test("stdout with no result line is noWire", () => {
    const parsed = parseCursorSessionTurn("not json at all\n{\"type\":\"system\"}\n", {
      sessionId: ID,
    });
    expect(parsed.noWire).toBe(true);
    expect(parsed.answer).toBeNull();
    expect(parsed.sessionId).toBeNull();
    expect(parsed.wrongSession).toBe(false);
    expect(parsed.noSessionId).toBe(false);
    expect(parsed.usage.input_tokens).toBeNull();
  });

  test("a result line without a session id fails the shape on any turn", () => {
    const parsed = parseCursorSessionTurn(resultLine({ session_id: undefined }), {
      sessionId: ID,
    });
    expect(parsed.noWire).toBe(false);
    expect(parsed.noSessionId).toBe(true);
    expect(parsed.sessionId).toBeNull();
    expect(parsed.wrongSession).toBe(false);
  });

  test("a result line naming another session fails the identity, fresh or resumed", () => {
    const fresh = parseCursorSessionTurn(resultLine({ session_id: OTHER_ID }), {
      sessionId: ID,
    });
    expect(fresh.wrongSession).toBe(true);
    expect(fresh.sessionId).toBe(OTHER_ID);
    expect(fresh.noSessionId).toBe(false);
    const resumed = parseCursorSessionTurn(resultLine({ session_id: OTHER_ID }), {
      sessionId: ID,
    });
    expect(resumed.wrongSession).toBe(true);
  });

  test("the last result line wins, as the run parser folds it", () => {
    const two = resultLine({ result: "first" }) + resultLine({ result: "second" });
    const parsed = parseCursorSessionTurn(two, { sessionId: ID });
    expect(parsed.answer).toBe("second");
    expect(parsed.wrongSession).toBe(false);
  });
});
