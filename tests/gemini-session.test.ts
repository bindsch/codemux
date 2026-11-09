// Unit tests for the gemini session wiring (src/session/gemini-session.ts):
// the floor, the minted id shape, the honest capability matrix, the
// per-turn command (the session-id/resume carrier), the stream line
// parse's tiers, and the identity rules. No spawning — the wire strings
// below are the fixture's and the bundle's shapes, rendered inline.
import { describe, expect, test } from "bun:test";
import { GeminiAdapter } from "../src/adapters/gemini.js";
import {
  GEMINI_SESSION_FLOOR,
  GEMINI_SESSION_ID_PATTERN,
  buildGeminiSessionCommand,
  geminiSessionAutonomyFlags,
  geminiSessionCapabilities,
  parseGeminiStreamLine,
} from "../src/session/gemini-session.js";

const ID = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
const OTHER_ID = "2b3c4d5e-6f70-4a8b-9c0d-1e2f3a4b5c6d";

const line = (event: Record<string, unknown>): string => `${JSON.stringify(event)}\n`;

describe("gemini session wiring", () => {
  test("the floor and the minted id shape", () => {
    expect(GEMINI_SESSION_FLOOR).toBe("0.60.0");
    expect(GEMINI_SESSION_ID_PATTERN.test(ID)).toBe(true);
    // Goose's date_time mint is not a gemini id.
    expect(GEMINI_SESSION_ID_PATTERN.test("20250921_143022")).toBe(false);
    // Uppercase is not the canonical mint (codemux mints lowercase).
    expect(GEMINI_SESSION_ID_PATTERN.test(ID.toUpperCase())).toBe(false);
  });

  test("capabilities: deltas join live input, interrupt, and resume; nothing else", () => {
    expect(geminiSessionCapabilities()).toEqual({
      live_input: true,
      user_during_turn: false,
      steer: false,
      // session.interrupt is supported for gemini (src/parity/declarations-session.ts).
      interrupt: true,
      permissions: false,
      deltas: true,
      file_changes: false,
      usage_stream: false,
      resume: true,
    });
  });

  test("the session autonomy flags are the run adapter's mapping", () => {
    const adapter = new GeminiAdapter({});
    for (const level of ["read-only", "low", "medium", "high"] as const) {
      expect(geminiSessionAutonomyFlags(level)).toEqual(adapter.mapAutonomy(level));
    }
  });

  test("the first turn names the minted id; later turns resume it", () => {
    expect(
      buildGeminiSessionCommand({
        sessionId: ID,
        firstTurn: true,
        autonomy: "read-only",
        prompt: "the prompt",
      })
    ).toEqual([
      "gemini",
      "--sandbox=false",
      "--approval-mode",
      "plan",
      "--output-format",
      "stream-json",
      "--session-id",
      ID,
      "-p",
      "",
    ]);
    expect(
      buildGeminiSessionCommand({
        sessionId: ID,
        firstTurn: false,
        autonomy: "high",
        model: "gemini-2.6-pro",
        prompt: "the prompt",
      })
    ).toEqual([
      "gemini",
      "--sandbox=false",
      "-m",
      "gemini-2.6-pro",
      "--approval-mode",
      "yolo",
      "--output-format",
      "stream-json",
      "--resume",
      ID,
      "-p",
      "",
    ]);
  });

  test("a hermetic turn wraps the command in the run path's env middle", () => {
    expect(
      buildGeminiSessionCommand({
        sessionId: ID,
        firstTurn: true,
        autonomy: "read-only",
        prompt: "the prompt",
        hermeticHome: "/private/session-home",
      })[0]
    ).toBe("env");
    expect(
      buildGeminiSessionCommand({
        sessionId: ID,
        firstTurn: true,
        autonomy: "read-only",
        prompt: "the prompt",
        hermeticHome: "/private/session-home",
      })
    ).toEqual([
      "env",
      "GEMINI_CLI_HOME=/private/session-home",
      "gemini",
      "--sandbox=false",
      "--approval-mode",
      "plan",
      "--output-format",
      "stream-json",
      "--session-id",
      ID,
      "-p",
      "",
    ]);
  });

  test("parse reads the init line: the echoed id and the model", () => {
    expect(
      parseGeminiStreamLine(
        line({ type: "init", session_id: ID, model: "gemini-2.6-pro" }),
        { knownSessionId: ID }
      )
    ).toEqual({ kind: "init", sessionId: ID, model: "gemini-2.6-pro" });
    // An absent model is null, not a guess.
    expect(
      parseGeminiStreamLine(line({ type: "init", session_id: ID }), {
        knownSessionId: ID,
      })
    ).toEqual({ kind: "init", sessionId: ID, model: null });
  });

  test("an init line naming another session is the wrong-session defect", () => {
    const parsed = parseGeminiStreamLine(
      line({ type: "init", session_id: OTHER_ID }),
      { knownSessionId: ID }
    );
    expect(parsed.kind).toBe("grammar_error");
    if (parsed.kind === "grammar_error") {
      expect(parsed.wrongSession).toEqual({ named: OTHER_ID, known: ID });
    }
  });

  test("assistant messages carry text and the delta flag; the user echo is unknown", () => {
    expect(
      parseGeminiStreamLine(
        line({ type: "message", role: "assistant", content: "Do", delta: true }),
        { knownSessionId: ID }
      )
    ).toEqual({ kind: "assistant", text: "Do", delta: true });
    expect(
      parseGeminiStreamLine(
        line({ type: "message", role: "assistant", content: "Done" }),
        { knownSessionId: ID }
      )
    ).toEqual({ kind: "assistant", text: "Done", delta: false });
    // The user echo is codemux's own prompt coming back, not a model fact.
    expect(
      parseGeminiStreamLine(
        line({ type: "message", role: "user", content: "the prompt" }),
        { knownSessionId: ID }
      )
    ).toEqual({ kind: "unknown" });
  });

  test("tool events pass their ids, names, and payloads through", () => {
    expect(
      parseGeminiStreamLine(
        line({ type: "tool_use", tool_id: "t1", tool_name: "read_file", parameters: { path: "a" } }),
        { knownSessionId: ID }
      )
    ).toEqual({ kind: "tool_use", toolId: "t1", name: "read_file", input: { path: "a" } });
    expect(
      parseGeminiStreamLine(
        line({ type: "tool_result", tool_id: "t1", status: "error", output: "nope" }),
        { knownSessionId: ID }
      )
    ).toEqual({ kind: "tool_result", toolId: "t1", output: "nope", isError: true });
  });

  test("the result line folds the status, the error text, and the stats arithmetic", () => {
    expect(
      parseGeminiStreamLine(
        line({
          type: "result",
          status: "success",
          stats: { input_tokens: 100, output_tokens: 20, cached: 10 },
        }),
        { knownSessionId: ID }
      )
    ).toEqual({
      kind: "result",
      status: "success",
      errorText: null,
      // input_tokens includes the cache reads: 100 - 10 uncached, the
      // total recomputed from the parts (the agy rule).
      usage: {
        input_tokens: 90,
        output_tokens: 20,
        cached_input_tokens: 10,
        total_tokens: 120,
        cost_usd: null,
      },
    });
    expect(
      parseGeminiStreamLine(
        line({ type: "result", status: "error", error: { type: "error", message: "boom" } }),
        { knownSessionId: ID }
      )
    ).toEqual({
      kind: "result",
      status: "error",
      errorText: "boom",
      usage: {
        input_tokens: null,
        output_tokens: null,
        cached_input_tokens: null,
        total_tokens: null,
        cost_usd: null,
      },
    });
  });

  test("non-JSON is unusable; unmapped JSON shapes are unknown", () => {
    const unusable = parseGeminiStreamLine("plain text the harness printed\n", {
      knownSessionId: ID,
    });
    expect(unusable.kind).toBe("unusable");
    expect(
      parseGeminiStreamLine(line({ type: "brand_new_event" }), { knownSessionId: ID })
    ).toEqual({ kind: "unknown" });
  });
});
