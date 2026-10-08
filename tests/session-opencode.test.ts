/**
 * Unit tests for the opencode session wiring (design §4.7, plan step 8):
 * the floor, the honest capability matrix, the per-turn spawn command, and
 * the `run --format json` line parser under the three tiers — each shape
 * pinned against the installed 1.18.18 binary's run wire
 * (opencode-session.ts names the sources). The driver round-trips are the
 * e2e suite (tests/session-opencode-e2e.test.ts).
 */

import { describe, expect, test } from "bun:test";
import { getAdapter } from "../src/adapters/index.js";
import {
  buildOpenCodeSessionCommand,
  normalizeOpenCodeUsage,
  OPENCODE_SESSION_FLOOR,
  OPENCODE_SESSION_ID_PATTERN,
  opencodeSessionAutonomyFlags,
  opencodeSessionCapabilities,
  parseOpenCodeRunLine,
} from "../src/session/opencode-session.js";
import type { AutonomyLevel } from "../src/types.js";

/** A well-formed line body minus the session id, so each test names the
 * id it wants. */
const line = (payload: Record<string, unknown>): string =>
  JSON.stringify({ timestamp: "2026-10-07T00:00:00.000Z", ...payload });

const ID = "ses_abc12345";

describe("opencode session - contract", () => {
  test("the floor is the pinned 1.18.18", () => {
    expect(OPENCODE_SESSION_FLOOR).toBe("1.18.18");
  });

  test("the capability matrix is honest: only live input and resume", () => {
    expect(opencodeSessionCapabilities()).toEqual({
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

  test("the session autonomy flags are the adapter's mapping, no drift", () => {
    const adapter = getAdapter("opencode");
    for (const level of ["read-only", "low", "medium", "high"] as AutonomyLevel[]) {
      expect(opencodeSessionAutonomyFlags(level)).toEqual(adapter.mapAutonomy(level));
    }
  });

  test("the resume pattern accepts native ids and refuses pastes", () => {
    expect(OPENCODE_SESSION_ID_PATTERN.test("ses_" + "a1B2c3".repeat(4))).toBe(true);
    expect(OPENCODE_SESSION_ID_PATTERN.test("ses_short")).toBe(false);
    expect(OPENCODE_SESSION_ID_PATTERN.test("ses_" + "a".repeat(65))).toBe(false);
    expect(OPENCODE_SESSION_ID_PATTERN.test("11111111-2222-3333-4444-555555555555")).toBe(false);
    expect(OPENCODE_SESSION_ID_PATTERN.test("")).toBe(false);
    // The id character class is alnum only: a path or whitespace paste
    // refuses before it reaches a spawn.
    expect(OPENCODE_SESSION_ID_PATTERN.test("ses_abc/def")).toBe(false);
    expect(OPENCODE_SESSION_ID_PATTERN.test("ses_ abc12345")).toBe(false);
  });
});

describe("opencode session - spawn command", () => {
  test("a fresh high-autonomy turn is run/json plus the adapter's autonomy flags", () => {
    expect(
      buildOpenCodeSessionCommand({ autonomy: "high" })
    ).toEqual(["opencode", "--pure", "run", "--format", "json", "--agent", "build", "--auto"]);
  });

  test("read-only maps to the plan agent; every level is the adapter's mapping", () => {
    expect(
      buildOpenCodeSessionCommand({ autonomy: "read-only" })
    ).toEqual(["opencode", "--pure", "run", "--format", "json", "--agent", "plan"]);
  });

  test("model rides before autonomy, effort as --variant, and the resume id is last", () => {
    expect(
      buildOpenCodeSessionCommand({
        autonomy: "medium",
        model: "codemux/clawvm-qwen32b-coder",
        effort: "high",
        resumeSessionId: "ses_abc12345",
      })
    ).toEqual([
      "opencode",
      "--pure",
      "run",
      "--format",
      "json",
      "--model",
      "codemux/clawvm-qwen32b-coder",
      "--agent",
      "build",
      "--variant",
      "high",
      "--session",
      "ses_abc12345",
    ]);
  });

  test("no argv message: the prompt rides stdin, so no flag carries it", () => {
    const argv = buildOpenCodeSessionCommand({ autonomy: "low" });
    expect(argv.some((argument) => argument.includes(" "))).toBe(false);
    expect(argv).toEqual(["opencode", "--pure", "run", "--format", "json", "--agent", "build"]);
  });
});

describe("opencode session - usage normalization", () => {
  test("the ai-sdk v5 token shape folds cache read+write into cached_input_tokens", () => {
    expect(
      normalizeOpenCodeUsage({
        tokens: { input: 100, output: 20, reasoning: 5, total: 120, cache: { read: 40, write: 10 } },
        cost: 0.01,
      })
    ).toEqual({
      input_tokens: 100,
      output_tokens: 20,
      cached_input_tokens: 50,
      total_tokens: 120,
      cost_usd: 0.01,
    });
  });

  test("unreported fields are null, never guessed; reasoning has no slot and drops", () => {
    expect(normalizeOpenCodeUsage({ tokens: { input: 7, output: 3 } })).toEqual({
      input_tokens: 7,
      output_tokens: 3,
      cached_input_tokens: null,
      total_tokens: null,
      cost_usd: null,
    });
    expect(normalizeOpenCodeUsage({})).toEqual({
      input_tokens: null,
      output_tokens: null,
      cached_input_tokens: null,
      total_tokens: null,
      cost_usd: null,
    });
  });

  test("fractional and negative counts floor or null, never round up a lie", () => {
    expect(
      normalizeOpenCodeUsage({ tokens: { input: 10.9, output: -1, cache: { read: 2.5, write: 1 } } })
    ).toEqual({
      input_tokens: 10,
      output_tokens: null,
      // 2.5 floors to a valid count of 2, so the cache pair still sums.
      cached_input_tokens: 3,
      total_tokens: null,
      cost_usd: null,
    });
  });
});

describe("opencode session - parser tiers", () => {
  test("a text line parses with the session id the driver adopts", () => {
    const parse = parseOpenCodeRunLine(
      line({ type: "text", sessionID: ID, part: { id: "tx_1", type: "text", text: "hello" } }),
      { knownSessionId: null }
    );
    expect(parse).toEqual({ kind: "text", sessionId: ID, text: "hello" });
  });

  test("a completed tool_use parses with input, output, and no error", () => {
    const parse = parseOpenCodeRunLine(
      line({
        type: "tool_use",
        sessionID: ID,
        part: {
          id: "tu_1",
          type: "tool_use",
          tool: "bash",
          state: { status: "completed", input: { command: "ls" }, output: "file-a" },
        },
      }),
      { knownSessionId: ID }
    );
    expect(parse).toMatchObject({
      kind: "tool_use",
      sessionId: ID,
      callId: "tu_1",
      tool: "bash",
      input: { command: "ls" },
      output: "file-a",
      isError: false,
      errorText: null,
    });
  });

  test("an errored tool_use parses with the error text", () => {
    const parse = parseOpenCodeRunLine(
      line({
        type: "tool_use",
        sessionID: ID,
        part: {
          id: "tu_2",
          type: "tool_use",
          tool: "edit",
          state: { status: "error", error: "the file was read-only", input: { path: "x" } },
        },
      }),
      { knownSessionId: ID }
    );
    expect(parse).toMatchObject({
      kind: "tool_use",
      isError: true,
      // The parser passes the state's fields through; the driver's
      // tool_result is what nulls a missing output.
      output: undefined,
      errorText: "the file was read-only",
    });
  });

  test("a step_finish line parses as the normalized usage", () => {
    // Review D2, contracts 1: the real wire line is
    // `{type, timestamp, sessionID, part}` — the run command's emitter
    // spreads its payload beside the envelope, so the tokens and cost
    // live INSIDE part. The old pin read them off the line's top level,
    // a shape the pinned binary never writes, so every real turn
    // reported all-null usage.
    const parse = parseOpenCodeRunLine(
      line({
        type: "step_finish",
        sessionID: ID,
        part: {
          id: "st_1",
          type: "step",
          tokens: { input: 100, output: 20, total: 120, cache: { read: 40, write: 10 } },
          cost: 0.01,
        },
      }),
      { knownSessionId: ID }
    );
    expect(parse).toEqual({
      kind: "step_finish",
      sessionId: ID,
      usage: {
        input_tokens: 100,
        output_tokens: 20,
        cached_input_tokens: 50,
        total_tokens: 120,
        cost_usd: 0.01,
      },
    });
  });

  test("a step_finish line whose tokens sit at the top level is a grammar error, not null usage", () => {
    // The shape the old parser accepted — envelope-level tokens/cost the
    // pinned binary never writes. It must not parse to all-null usage
    // (the review D2 defect): it breaks the pin, so tier 2.
    const parse = parseOpenCodeRunLine(
      line({
        type: "step_finish",
        sessionID: ID,
        tokens: { input: 100, output: 20, total: 120 },
        cost: 0.01,
      }),
      { knownSessionId: ID }
    );
    expect(parse).toEqual({
      kind: "grammar_error",
      message: "a step_finish line carries no part",
    });
  });

  test("error lines prefer error.data.message, then error.message, then String", () => {
    expect(
      parseOpenCodeRunLine(
        line({
          type: "error",
          sessionID: ID,
          error: { data: { message: "endpoint said no" }, message: "wrapped" },
        }),
        { knownSessionId: ID }
      )
    ).toMatchObject({ kind: "error", message: "endpoint said no" });
    expect(
      parseOpenCodeRunLine(line({ type: "error", sessionID: ID, error: { message: "plain" } }), {
        knownSessionId: ID,
      })
    ).toMatchObject({ kind: "error", message: "plain" });
    expect(
      parseOpenCodeRunLine(line({ type: "error", sessionID: ID, error: 42 }), {
        knownSessionId: ID,
      })
    ).toMatchObject({ kind: "error", message: "42" });
  });

  test("unmapped types (step_start, reasoning) are tier-1 unknown with the id", () => {
    expect(
      parseOpenCodeRunLine(
        line({ type: "step_start", sessionID: ID, part: { id: "st_1", type: "step" } }),
        { knownSessionId: null }
      )
    ).toEqual({ kind: "unknown", sessionId: ID });
    expect(
      parseOpenCodeRunLine(line({ type: "reasoning", sessionID: ID }), { knownSessionId: null })
    ).toEqual({ kind: "unknown", sessionId: ID });
  });

  test("a non-JSON line is tier-3 unusable, with a bounded excerpt", () => {
    const parse = parseOpenCodeRunLine("this is not json", { knownSessionId: null });
    expect(parse.kind).toBe("unusable");
    if (parse.kind === "unusable") {
      expect(parse.excerpt.startsWith("this is not")).toBe(true);
      expect(parse.bytes).toBe(16);
    }
  });

  test("a JSON non-object (array) is tier-3 unusable", () => {
    expect(parseOpenCodeRunLine("[1,2,3]", { knownSessionId: null }).kind).toBe("unusable");
  });

  test("a line without a type, or with no sessionID, or an invalid id, is tier-2", () => {
    expect(
      parseOpenCodeRunLine(line({ sessionID: ID, part: {} }), { knownSessionId: null })
    ).toMatchObject({ kind: "grammar_error", message: "a run-output line carries no type" });
    expect(
      parseOpenCodeRunLine(line({ type: "text", part: { text: "x" } }), { knownSessionId: null })
    ).toMatchObject({
      kind: "grammar_error",
      message: "a run-output line carries no sessionID",
    });
    expect(
      parseOpenCodeRunLine(
        line({ type: "text", sessionID: "ses_short", part: { text: "x" } }),
        { knownSessionId: null }
      )
    ).toMatchObject({
      kind: "grammar_error",
      message: "a run-output line carries an invalid sessionID",
    });
  });

  test("a line naming a different session than the one adopted is tier-2", () => {
    expect(
      parseOpenCodeRunLine(
        line({ type: "text", sessionID: "ses_other123456789", part: { text: "x" } }),
        { knownSessionId: ID }
      )
    ).toMatchObject({
      kind: "grammar_error",
      message: "a run-output line names session ses_other123456789, not " + ID,
    });
  });

  test("mapped types with broken payloads are tier-2: text without a part, tool_use without ids or with an unreported status", () => {
    expect(
      parseOpenCodeRunLine(line({ type: "text", sessionID: ID }), { knownSessionId: null })
    ).toMatchObject({ kind: "grammar_error", message: "a text line carries no text part" });
    expect(
      parseOpenCodeRunLine(
        line({ type: "tool_use", sessionID: ID, part: { tool: "bash", state: { status: "completed" } } }),
        { knownSessionId: null }
      )
    ).toMatchObject({ kind: "grammar_error", message: "a tool_use line carries no call id" });
    expect(
      parseOpenCodeRunLine(
        line({
          type: "tool_use",
          sessionID: ID,
          part: { id: "tu_1", tool: "bash", state: { status: "running" } },
        }),
        { knownSessionId: null }
      )
    ).toMatchObject({
      kind: "grammar_error",
      message: "a tool_use line carries the unreported status running",
    });
  });

  test("a fresh session adopts the id from its first unknown line too", () => {
    // step_start is unmapped, but it still carries the sessionID — the
    // gate validated it, so the driver's identity adoption runs on it.
    const parse = parseOpenCodeRunLine(
      line({ type: "step_start", sessionID: ID, part: { id: "st_1", type: "step" } }),
      { knownSessionId: null }
    );
    expect(parse).toEqual({ kind: "unknown", sessionId: ID });
  });
});
