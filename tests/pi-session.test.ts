// Unit tests for the pi session wiring (src/session/pi-session.ts): the
// floor, the minted id shape, the honest capability matrix, the per-turn
// command (the resume-or-create carrier), and the turn parse's identity
// rules over the --mode json wire. No spawning — the wire strings below
// are the fixture's and the bundle's shapes, rendered inline.
import { describe, expect, test } from "bun:test";
import { PiAdapter } from "../src/adapters/pi.js";
import {
  buildPiSessionCommand,
  parsePiSessionTurn,
  piSessionAutonomyFlags,
  piSessionCapabilities,
  piSessionEffortFlags,
  PI_SESSION_FLOOR,
  PI_SESSION_ID_PATTERN,
} from "../src/session/pi-session.js";

const ID = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
const OTHER_ID = "00000000-0000-4000-8000-000000000000";

/** The wire's `{type:"session"}` header line, the shape runPrintMode
 * writes first in json mode (newSession's header entry). */
const header = (id: string): string =>
  JSON.stringify({
    type: "session",
    version: 3,
    id,
    timestamp: "2026-11-09T00:00:00.000Z",
    cwd: "/repo",
  });

const messageEnd = (message: Record<string, unknown>): string =>
  JSON.stringify({ type: "message_end", message });

describe("pi session wiring", () => {
  test("the floor and the minted id shape", () => {
    expect(PI_SESSION_FLOOR).toBe("0.85.1");
    // The codemux mint is a lowercase UUID — also pi's own uuidv7 shape.
    expect(PI_SESSION_ID_PATTERN.test(ID)).toBe(true);
    expect(PI_SESSION_ID_PATTERN.test("01939cde-7a1b-7def-8123-456789abcdef")).toBe(true);
    // pi's own wider validation class still refuses these; the mint is
    // narrower than the class, never wider.
    expect(PI_SESSION_ID_PATTERN.test("20250921_143022")).toBe(false);
    expect(PI_SESSION_ID_PATTERN.test(".dotted-edges.")).toBe(false);
    expect(PI_SESSION_ID_PATTERN.test("")).toBe(false);
  });

  test("capabilities: live input, resume, and interrupt; nothing else", () => {
    expect(piSessionCapabilities()).toEqual({
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

  test("the session autonomy and effort flags are the run adapter's mapping", () => {
    const adapter = new PiAdapter();
    for (const level of ["read-only", "low", "medium", "high"] as const) {
      expect(piSessionAutonomyFlags(level)).toEqual(adapter.mapAutonomy(level));
    }
    for (const level of ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const) {
      expect(piSessionEffortFlags(level)).toEqual(adapter.mapEffort(level));
    }
    expect(piSessionEffortFlags("none")).toEqual(["--thinking", "off"]);
  });

  test("the fresh turn and the resumed turn are the same command", () => {
    // --session-id resumes OR creates ("Use exact project session ID,
    // creating it if missing", 0.85.1 help), so the codemux-minted id
    // rides every turn identically.
    const fresh = buildPiSessionCommand({ sessionId: ID, autonomy: "read-only" });
    const resumed = buildPiSessionCommand({ sessionId: ID, autonomy: "read-only" });
    expect(fresh).toEqual(resumed);
    expect(fresh).toEqual([
      "pi",
      "--print",
      "--no-approve",
      "--mode",
      "json",
      "--session-id",
      ID,
      "--no-extensions",
      "--tools",
      "read,grep,find,ls",
    ]);
    // The run path's --no-session is absent: it makes the manager
    // in-memory, which would leave every turn unpersisted.
    expect(fresh.includes("--no-session")).toBe(false);
  });

  test("model, effort, hermetic, and the env wrap ride the per-turn command", () => {
    expect(
      buildPiSessionCommand({
        sessionId: ID,
        autonomy: "high",
        model: "anthropic/claude-sonnet-4",
        effort: "max",
        hermetic: true,
      })
    ).toEqual([
      "pi",
      "--print",
      "--no-approve",
      "--mode",
      "json",
      "--session-id",
      ID,
      "--model",
      "anthropic/claude-sonnet-4",
      "--no-context-files",
      "--thinking",
      "max",
    ]);
    expect(
      buildPiSessionCommand({
        sessionId: ID,
        autonomy: "low",
        hermeticEnvAssignments: ["PI_CODING_AGENT_DIR=/private/agent"],
      }).slice(0, 3)
    ).toEqual(["env", "PI_CODING_AGENT_DIR=/private/agent", "pi"]);
  });

  test("the turn parse folds a good wire and verifies the header's id", () => {
    const wire = [
      header(ID),
      messageEnd({
        role: "user",
        content: [{ type: "text", text: "hello" }],
        // A user message's usage must not fold into the turn's.
        usage: { input: 999, output: 999, cacheRead: 0, cacheWrite: 0 },
      }),
      messageEnd({
        role: "assistant",
        content: [{ type: "text", text: "part one" }],
        stopReason: "stop",
        usage: {
          input: 100,
          output: 10,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 110,
          cost: { total: 0.01 },
        },
        model: "fake-pi-model",
      }),
      messageEnd({
        role: "assistant",
        content: [{ type: "text", text: "the reply" }],
        stopReason: "stop",
        usage: {
          input: 50,
          output: 5,
          cacheRead: 5,
          cacheWrite: 0,
          totalTokens: 60,
          cost: { total: 0.01 },
        },
        model: "fake-pi-model",
      }),
    ].join("\n");
    const parsed = parsePiSessionTurn(wire, { knownSessionId: ID });
    expect(parsed.noWire).toBe(false);
    expect(parsed.noSessionId).toBe(false);
    expect(parsed.sessionId).toBe(ID);
    expect(parsed.wrongSession).toBe(false);
    // Every assistant message of the turn is the answer, a blank line
    // between two (the run parser's rule, lane AN1); usage sums over every
    // assistant message_end.
    expect(parsed.answer).toBe("part one\n\nthe reply");
    expect(parsed.usage).toEqual({
      input_tokens: 150,
      output_tokens: 15,
      cached_input_tokens: 5,
      total_tokens: 170,
      cost_usd: 0.02,
    });
    expect(parsed.servedModel).toBe("fake-pi-model");
    expect(parsed.stopReason).toBe("stop");
    expect(parsed.errorText).toBeNull();
  });

  test("no wire at all is the no-wire fatal", () => {
    const parsed = parsePiSessionTurn("Error: no provider configured\n", { knownSessionId: ID });
    expect(parsed.noWire).toBe(true);
    expect(parsed.answer).toBeNull();
    expect(parsed.sessionId).toBeNull();
    expect(parsed.noSessionId).toBe(false);
    expect(parsed.wrongSession).toBe(false);
    expect(parsed.usage.total_tokens).toBeNull();
  });

  test("a wire without a header names no session id — a defect even fresh", () => {
    const wire = messageEnd({
      role: "assistant",
      content: [{ type: "text", text: "reply" }],
      stopReason: "stop",
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
      model: "m",
    });
    const parsed = parsePiSessionTurn(wire, { knownSessionId: null });
    expect(parsed.noWire).toBe(false);
    expect(parsed.answer).toBe("reply");
    expect(parsed.noSessionId).toBe(true);
    expect(parsed.sessionId).toBeNull();
    expect(parsed.wrongSession).toBe(false);
    // A header whose id is not a string counts as naming none, and the
    // scan is line-order tolerant: noise lines and null JSON never match.
    const malformed = [
      "null",
      "42",
      "not json",
      JSON.stringify({ type: "session", id: 7, version: 3 }),
    ].join("\n");
    const parsedMalformed = parsePiSessionTurn(malformed, { knownSessionId: ID });
    expect(parsedMalformed.noSessionId).toBe(true);
    expect(parsedMalformed.sessionId).toBeNull();
  });

  test("a resumed turn whose header names another id is the wrong-session defect", () => {
    const wire = [
      header(OTHER_ID),
      messageEnd({
        role: "assistant",
        content: [{ type: "text", text: "reply" }],
        stopReason: "stop",
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
        model: "m",
      }),
    ].join("\n");
    const parsed = parsePiSessionTurn(wire, { knownSessionId: ID });
    expect(parsed.wrongSession).toBe(true);
    expect(parsed.sessionId).toBe(OTHER_ID);
    expect(parsed.noSessionId).toBe(false);
    // The fresh turn (no known id yet) adopts the header's id instead.
    const fresh = parsePiSessionTurn(wire, { knownSessionId: null });
    expect(fresh.wrongSession).toBe(false);
    expect(fresh.sessionId).toBe(OTHER_ID);
    // A matching header on a resumed turn is clean.
    expect(
      parsePiSessionTurn(wire.replace(OTHER_ID, ID), { knownSessionId: ID }).wrongSession
    ).toBe(false);
  });

  test("an error stop carries the structured failure regardless of the process exit", () => {
    // json mode keeps the exit code 0 for a failed stopReason (the pinned
    // runPrintMode fact), so the verdict is the stopReason, not the code.
    const wire = [
      header(ID),
      messageEnd({
        role: "assistant",
        content: [],
        stopReason: "error",
        errorMessage: "the model refused the turn",
        usage: { input: 10, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
        model: "m",
      }),
    ].join("\n");
    const parsed = parsePiSessionTurn(wire, { knownSessionId: ID });
    expect(parsed.stopReason).toBe("error");
    expect(parsed.errorText).toBe("the model refused the turn");
    expect(parsed.answer).toBeNull();
    expect(parsed.noWire).toBe(false);
    expect(parsed.sessionId).toBe(ID);
  });
});
