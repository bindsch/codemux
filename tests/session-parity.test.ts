import { describe, expect, test } from "bun:test";
import {
  buildGeminiSessionCommand,
  geminiSessionAutonomyFlags,
  geminiSessionCapabilities,
  GEMINI_SESSION_FLOOR,
  GEMINI_SESSION_ID_PATTERN,
  parseGeminiStreamLine,
} from "../src/session/gemini-session.js";
import {
  buildCopilotSessionCommand,
  copilotSessionAutonomyFlags,
  copilotSessionCapabilities,
  COPILOT_SESSION_FLOOR,
  COPILOT_SESSION_ID_PATTERN,
  parseCopilotSessionTurn,
} from "../src/session/copilot-session.js";
import {
  buildGooseSessionCommand,
  buildGooseSessionEnv,
  gooseSessionCapabilities,
  gooseSessionEffortEnv,
  gooseSessionMode,
  GOOSE_SESSION_FLOOR,
  GOOSE_SESSION_ID_PATTERN,
  parseGooseSessionTurn,
} from "../src/session/goose-session.js";
import { GeminiAdapter } from "../src/adapters/gemini.js";
import { CopilotAdapter } from "../src/adapters/copilot.js";
import { GooseAdapter } from "../src/adapters/goose.js";

const ID = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";

describe("gemini session wiring", () => {
  test("the floor and the minted id shape", () => {
    expect(GEMINI_SESSION_FLOOR).toBe("0.60.0");
    expect(GEMINI_SESSION_ID_PATTERN.test(ID)).toBe(true);
    expect(GEMINI_SESSION_ID_PATTERN.test("20250921_143022")).toBe(false);
  });

  test("capabilities: live input, deltas, resume, interrupt; nothing else", () => {
    // Gemini 0.60.0 ACP session/cancel interrupts the active prompt (cli-agents.ts).
    expect(geminiSessionCapabilities()).toEqual({
      live_input: true,
      user_during_turn: false,
      steer: false,
      interrupt: true,
      permissions: false,
      deltas: true,
      file_changes: false,
      usage_stream: false,
      resume: true,
    });
  });

  test("the session autonomy flags are the run adapter's mapping", () => {
    const adapter = new GeminiAdapter();
    for (const level of ["read-only", "low", "medium", "high"] as const) {
      expect(geminiSessionAutonomyFlags(level)).toEqual(adapter.mapAutonomy(level));
    }
  });

  test("first turn names the minted id; later turns resume it; hermetic wraps env", () => {
    expect(
      buildGeminiSessionCommand({
        autonomy: "read-only",
        sessionId: ID,
        firstTurn: true,
        prompt: "hello",
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
        autonomy: "high",
        model: "gemini-2.5-pro",
        sessionId: ID,
        firstTurn: false,
        prompt: "again",
      })
    ).toEqual([
      "gemini",
      "--sandbox=false",
      "-m",
      "gemini-2.5-pro",
      "--approval-mode",
      "yolo",
      "--output-format",
      "stream-json",
      "--resume",
      ID,
      "-p",
      "",
    ]);
    expect(
      buildGeminiSessionCommand({
        autonomy: "low",
        sessionId: ID,
        firstTurn: false,
        prompt: "p",
        hermeticHome: "/private/home",
      }).slice(0, 3)
    ).toEqual(["env", "GEMINI_CLI_HOME=/private/home", "gemini"]);
  });

  test("init adopts only the named session; a foreign id is the wrong-session defect", () => {
    const line = JSON.stringify({ type: "init", session_id: ID, model: "gemini-x" });
    expect(parseGeminiStreamLine(line, { knownSessionId: ID })).toEqual({
      kind: "init",
      sessionId: ID,
      model: "gemini-x",
    });
    const foreign = parseGeminiStreamLine(line, { knownSessionId: "00000000-0000-4000-8000-000000000000" });
    expect(foreign.kind).toBe("grammar_error");
    if (foreign.kind === "grammar_error") {
      expect(foreign.wrongSession).toEqual({ named: ID, known: "00000000-0000-4000-8000-000000000000" });
    }
    const malformed = parseGeminiStreamLine(
      JSON.stringify({ type: "init", session_id: "not!!an!!id" }),
      { knownSessionId: ID }
    );
    expect(malformed.kind).toBe("grammar_error");
  });

  test("assistant, tool, error, and result events parse to their facts", () => {
    expect(
      parseGeminiStreamLine(
        JSON.stringify({ type: "message", role: "assistant", content: "hi", delta: true }),
        { knownSessionId: ID }
      )
    ).toEqual({ kind: "assistant", text: "hi", delta: true });
    expect(
      parseGeminiStreamLine(JSON.stringify({ type: "message", role: "user", content: "echo" }), {
        knownSessionId: ID,
      }).kind
    ).toBe("unknown");
    expect(
      parseGeminiStreamLine(
        JSON.stringify({ type: "tool_use", tool_name: "read_file", tool_id: "t1", parameters: { path: "x" } }),
        { knownSessionId: ID }
      )
    ).toEqual({ kind: "tool_use", toolId: "t1", name: "read_file", input: { path: "x" } });
    expect(
      parseGeminiStreamLine(
        JSON.stringify({ type: "tool_result", tool_id: "t1", status: "error", output: "nope" }),
        { knownSessionId: ID }
      )
    ).toEqual({ kind: "tool_result", toolId: "t1", output: "nope", isError: true });
    expect(
      parseGeminiStreamLine(JSON.stringify({ type: "error", severity: "warning", message: "heads up" }), {
        knownSessionId: ID,
      })
    ).toEqual({ kind: "error", severity: "warning", message: "heads up" });
    const result = parseGeminiStreamLine(
      JSON.stringify({
        type: "result",
        status: "success",
        stats: { input_tokens: 100, output_tokens: 10, cached: 20 },
      }),
      { knownSessionId: ID }
    );
    expect(result).toEqual({
      kind: "result",
      status: "success",
      errorText: null,
      usage: { input_tokens: 80, cached_input_tokens: 20, output_tokens: 10, total_tokens: 110, cost_usd: null },
    });
  });

  test("grammar breaks and non-JSON lines hit tiers 2 and 3", () => {
    expect(parseGeminiStreamLine("not json", { knownSessionId: ID }).kind).toBe("unusable");
    expect(
      parseGeminiStreamLine(JSON.stringify({ type: "message", role: "assistant" }), { knownSessionId: ID }).kind
    ).toBe("grammar_error");
    expect(
      parseGeminiStreamLine(JSON.stringify({ type: "tool_use", tool_id: "", tool_name: "x" }), { knownSessionId: ID }).kind
    ).toBe("grammar_error");
    expect(
      parseGeminiStreamLine(JSON.stringify({ type: "result", status: "weird" }), { knownSessionId: ID }).kind
    ).toBe("grammar_error");
    expect(parseGeminiStreamLine(JSON.stringify({ type: "new-thing", x: 1 }), { knownSessionId: ID }).kind)
      .toBe("unknown");
  });
});

describe("copilot session wiring", () => {
  test("the floor and the minted id shape", () => {
    expect(COPILOT_SESSION_FLOOR).toBe("1.0.85");
    expect(COPILOT_SESSION_ID_PATTERN.test(ID)).toBe(true);
    expect(COPILOT_SESSION_ID_PATTERN.test("0cb916d")).toBe(false);
  });

  test("capabilities: live input and resume; no deltas, no usage stream", () => {
    const caps = copilotSessionCapabilities();
    expect(caps.live_input).toBe(true);
    expect(caps.resume).toBe(true);
    expect(caps.deltas).toBe(false);
    expect(caps.usage_stream).toBe(false);
    expect(caps.permissions).toBe(false);
  });

  test("the session autonomy flags are the run adapter's mapping", () => {
    const adapter = new CopilotAdapter();
    for (const level of ["read-only", "low", "medium", "high"] as const) {
      expect(copilotSessionAutonomyFlags(level)).toEqual(adapter.mapAutonomy(level));
    }
  });

  test("first turn names the minted id; later turns resume it; hardening and json always ride", () => {
    expect(
      buildCopilotSessionCommand({
        autonomy: "read-only",
        sessionId: ID,
        firstTurn: true,
        prompt: "hello",
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
        autonomy: "high",
        model: "gpt-5.4",
        effort: "medium",
        sessionId: ID,
        firstTurn: false,
        prompt: "again",
      })
    ).toEqual([
      "copilot",
      "--no-auto-update",
      "--no-bash-env",
      "--no-remote",
      "--no-remote-export",
      "--no-custom-instructions",
      "--no-experimental",
      "--model",
      "gpt-5.4",
      "--allow-all",
      "--reasoning-effort",
      "medium",
      "--resume",
      ID,
      "--output-format",
      "json",
      "--silent",
    ]);
    expect(
      buildCopilotSessionCommand({
        autonomy: "low",
        sessionId: ID,
        firstTurn: false,
        prompt: "p",
        hermeticHome: "/private/home",
      }).slice(0, 3)
    ).toEqual(["env", "COPILOT_HOME=/private/home", "copilot"]);
  });

  test("the turn parse folds the wire and checks the session identity", () => {
    const wire = [
      JSON.stringify({ type: "assistant.message", data: { content: "answer" } }),
      JSON.stringify({ type: "result", sessionId: ID, exitCode: 0, usage: {} }),
    ].join("\n");
    expect(parseCopilotSessionTurn(wire, { knownSessionId: ID })).toEqual({
      answer: "answer",
      sessionId: ID,
      reportedExitCode: 0,
      errorText: null,
      wrongSession: false,
      noWire: false,
    });
    expect(parseCopilotSessionTurn(wire, { knownSessionId: "other" }).wrongSession).toBe(true);
    const noWire = parseCopilotSessionTurn("plain", { knownSessionId: ID });
    expect(noWire.noWire).toBe(true);
    expect(noWire.answer).toBeNull();
  });
});

describe("goose session wiring", () => {
  test("the floor and the goose-minted id shape", () => {
    expect(GOOSE_SESSION_FLOOR).toBe("1.50.1");
    expect(GOOSE_SESSION_ID_PATTERN.test("20250921_143022")).toBe(true);
    expect(GOOSE_SESSION_ID_PATTERN.test(ID)).toBe(false);
  });

  test("capabilities: live input and resume; nothing else", () => {
    const caps = gooseSessionCapabilities();
    expect(caps.live_input).toBe(true);
    expect(caps.resume).toBe(true);
    expect(caps.deltas).toBe(false);
    expect(caps.usage_stream).toBe(false);
    expect(caps.interrupt).toBe(false);
  });

  test("the session mode and effort env are the run adapter's mapping", () => {
    const adapter = new GooseAdapter();
    for (const level of ["read-only", "low", "medium", "high"] as const) {
      const runEnv = adapter.getRunEnv({ agent: "goose", prompt: "t", autonomy: level });
      expect(gooseSessionMode(level)).toBe(runEnv.GOOSE_MODE ?? "");
    }
    // The env spelling is pinned against the adapter's own getRunEnv: the
    // session env must be the run env for the same inputs (provider part
    // aside, which the caller threads in).
    const sessionEnv = buildGooseSessionEnv({
      autonomy: "medium",
      model: "m1",
      effort: "none",
      providerEnv: { OPENAI_API_KEY: "k" },
    });
    expect(sessionEnv).toEqual({
      GOOSE_MODE: "smart_approve",
      GOOSE_MODEL: "m1",
      GOOSE_THINKING_EFFORT: "off",
      OPENAI_API_KEY: "k",
    });
    expect(gooseSessionMode("read-only")).toBe("chat");
    expect(gooseSessionMode("high")).toBe("auto");
    expect(gooseSessionEffortEnv("none")).toBe("off");
    expect(gooseSessionEffortEnv("max")).toBe("max");
  });

  test("a fresh turn carries no session flags; a resume carries both flags", () => {
    expect(buildGooseSessionCommand({ prompt: "hello" })).toEqual([
      "goose",
      "run",
      "--output-format",
      "json",
      "-t",
      "hello",
    ]);
    expect(buildGooseSessionCommand({ prompt: "again", resumeSessionId: "20250921_143022" })).toEqual([
      "goose",
      "run",
      "--resume",
      "--session-id",
      "20250921_143022",
      "--output-format",
      "json",
      "-t",
      "again",
    ]);
    expect(
      buildGooseSessionCommand({ prompt: "p", hermeticEnvAssignments: ["XDG_CONFIG_HOME=/x"] })
    ).toEqual(["env", "XDG_CONFIG_HOME=/x", "goose", "run", "--output-format", "json", "-t", "p"]);
  });

  test("the turn parse folds the object, requires an id, and checks it on resume", () => {
    const object = JSON.stringify({
      session_id: "20250921_143022",
      content: "reply",
      usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 },
    });
    const fresh = parseGooseSessionTurn(object, { knownSessionId: null });
    expect(fresh.noWire).toBe(false);
    expect(fresh.noSessionId).toBe(false);
    expect(fresh.sessionId).toBe("20250921_143022");
    expect(fresh.answer).toBe("reply");
    expect(fresh.usage.input_tokens).toBe(10);
    expect(parseGooseSessionTurn(object, { knownSessionId: "20250921_143022" }).wrongSession).toBe(false);
    expect(parseGooseSessionTurn(object, { knownSessionId: "19990101_000000" }).wrongSession).toBe(true);
    const noId = parseGooseSessionTurn(JSON.stringify({ content: "x" }), { knownSessionId: null });
    expect(noId.noSessionId).toBe(true);
    const noWire = parseGooseSessionTurn("nothing", { knownSessionId: null });
    expect(noWire.noWire).toBe(true);
    expect(noWire.usage.total_tokens).toBeNull();
  });
});
