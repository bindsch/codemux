// Unit tests for the copilot session wiring (src/session/copilot-session.ts):
// the floor, the minted id shape, the honest capability matrix, the
// per-turn command (the hardening flags and the session-id/resume
// carrier), and the turn parse's identity rule. No spawning — the wire
// strings below are the fixture's and the bundle's shapes, rendered
// inline.
import { describe, expect, test } from "bun:test";
import { CopilotAdapter } from "../src/adapters/copilot.js";
import {
  COPILOT_SESSION_FLOOR,
  COPILOT_SESSION_ID_PATTERN,
  buildCopilotSessionCommand,
  copilotSessionAutonomyFlags,
  copilotSessionCapabilities,
  parseCopilotSessionTurn,
} from "../src/session/copilot-session.js";

const ID = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
const OTHER_ID = "2b3c4d5e-6f70-4a8b-9c0d-1e2f3a4b5c6d";

/** One copilot JSONL turn: an assistant message, then the result line. */
const turn = (result: Record<string, unknown>): string =>
  `${JSON.stringify({ type: "assistant.message", data: { content: "Done" } })}\n` +
  `${JSON.stringify({ type: "result", sessionId: ID, exitCode: 0, ...result })}\n`;

describe("copilot session wiring", () => {
  test("the floor and the minted id shape", () => {
    expect(COPILOT_SESSION_FLOOR).toBe("1.0.85");
    expect(COPILOT_SESSION_ID_PATTERN.test(ID)).toBe(true);
    // Goose's date_time mint is not a copilot id.
    expect(COPILOT_SESSION_ID_PATTERN.test("20250921_143022")).toBe(false);
    // Uppercase is not the canonical mint (codemux mints lowercase).
    expect(COPILOT_SESSION_ID_PATTERN.test(ID.toUpperCase())).toBe(false);
  });

  test("capabilities: live input, resume, and interrupt; nothing else", () => {
    expect(copilotSessionCapabilities()).toEqual({
      live_input: true,
      user_during_turn: false,
      steer: false,
      // Interrupt is declared in SESSION_AGENTS (cli-agents.ts) and carried natively.
      interrupt: true,
      permissions: false,
      deltas: false,
      file_changes: false,
      usage_stream: false,
      resume: true,
    });
  });

  test("the session autonomy flags are the run adapter's mapping", () => {
    const adapter = new CopilotAdapter({});
    for (const level of ["read-only", "low", "medium", "high"] as const) {
      expect(copilotSessionAutonomyFlags(level)).toEqual(adapter.mapAutonomy(level));
    }
  });

  test("the first turn names the minted id; later turns resume it", () => {
    expect(
      buildCopilotSessionCommand({
        sessionId: ID,
        firstTurn: true,
        autonomy: "read-only",
        prompt: "the prompt",
      })
    ).toEqual([
      "copilot",
      "--no-auto-update",
      "--no-bash-env",
      "--no-remote",
      "--no-remote-export",
      "--no-custom-instructions",
      "--no-experimental",
      "--disable-builtin-mcps",
      "--plan",
      "--session-id",
      ID,
      "--output-format",
      "json",
      "--silent",
    ]);
    expect(
      buildCopilotSessionCommand({
        sessionId: ID,
        firstTurn: false,
        autonomy: "high",
        model: "gpt-5.1",
        effort: "medium",
        prompt: "the prompt",
      })
    ).toEqual([
      "copilot",
      // High autonomy keeps the built-in MCP servers: the run adapter's
      // own rule (everything else is the same hardening head).
      "--no-auto-update",
      "--no-bash-env",
      "--no-remote",
      "--no-remote-export",
      "--no-custom-instructions",
      "--no-experimental",
      "--model",
      "gpt-5.1",
      "--allow-all",
      "--reasoning-effort",
      "medium",
      "--resume",
      ID,
      "--output-format",
      "json",
      "--silent",
    ]);
  });

  test("a hermetic turn wraps the command in the run path's env middle", () => {
    expect(
      buildCopilotSessionCommand({
        sessionId: ID,
        firstTurn: true,
        autonomy: "read-only",
        prompt: "the prompt",
        hermeticHome: "/private/session-home",
      })
    ).toEqual([
      "env",
      "COPILOT_HOME=/private/session-home",
      "copilot",
      "--no-auto-update",
      "--no-bash-env",
      "--no-remote",
      "--no-remote-export",
      "--no-custom-instructions",
      "--no-experimental",
      "--disable-builtin-mcps",
      "--plan",
      "--session-id",
      ID,
      "--output-format",
      "json",
      "--silent",
    ]);
  });

  test("parse reads the answer and the result line's id and exit code", () => {
    expect(parseCopilotSessionTurn(turn({}), { knownSessionId: ID })).toEqual({
      answer: "Done",
      sessionId: ID,
      reportedExitCode: 0,
      errorText: null,
      wrongSession: false,
      noWire: false,
    });
  });

  test("stdout with no JSON lines is the no-wire fatal", () => {
    expect(parseCopilotSessionTurn("plain text the harness printed\n", {
      knownSessionId: ID,
    })).toEqual({
      answer: null,
      sessionId: null,
      reportedExitCode: null,
      errorText: null,
      wrongSession: false,
      noWire: true,
    });
  });

  test("a session.error event carries its message; the error verdict keeps the id", () => {
    const stdout =
      `${JSON.stringify({ type: "session.error", data: { message: "the model call failed" } })}\n` +
      `${JSON.stringify({ type: "result", sessionId: ID, exitCode: 1 })}\n`;
    const parsed = parseCopilotSessionTurn(stdout, { knownSessionId: ID });
    expect(parsed.answer).toBeNull();
    expect(parsed.errorText).toBe("the model call failed");
    expect(parsed.reportedExitCode).toBe(1);
    expect(parsed.sessionId).toBe(ID);
    expect(parsed.wrongSession).toBe(false);
  });

  test("a result line naming another session is the wrong-session defect", () => {
    const parsed = parseCopilotSessionTurn(turn({ sessionId: OTHER_ID }), {
      knownSessionId: ID,
    });
    expect(parsed.sessionId).toBe(OTHER_ID);
    expect(parsed.wrongSession).toBe(true);
  });
});
