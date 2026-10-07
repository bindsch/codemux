/**
 * Unit tests for the agy session wiring (design §4.7, plan step 8): the
 * floor, the honest capability matrix, the spawn command's `=`-form
 * flags, and the `event`-keyed result parser under the three tiers —
 * each shape pinned against the step-0 fixture
 * (tests/fixtures/live/agy-session.ndjson), because no live exchange
 * ever ran (login expired). The driver round-trips are the e2e suite
 * (tests/session-agy-e2e.test.ts).
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { getAdapter } from "../src/adapters/index.js";
import {
  AGY_CONVERSATION_ID_PATTERN,
  AGY_SESSION_FLOOR,
  agySessionAutonomyFlags,
  agySessionCapabilities,
  buildAgySessionCommand,
  buildAgyUserMessage,
  parseAgySessionLine,
} from "../src/session/agy-session.js";
import type { AutonomyLevel } from "../src/types.js";

const FIXTURE = fileURLToPath(new URL("./fixtures/live/agy-session.ndjson", import.meta.url));

/** The fixture's records, as recorded: {dir, line} per frame. */
function fixtureRecords(): { dir: string; line: string }[] {
  return readFileSync(FIXTURE, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as { dir: string; line: string });
}

describe("agy session - contract", () => {
  test("the floor is the audited 1.2.14", () => {
    expect(AGY_SESSION_FLOOR).toBe("1.2.14");
  });

  test("the capability matrix is honest: only live input and resume", () => {
    expect(agySessionCapabilities()).toEqual({
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
    const adapter = getAdapter("agy");
    for (const level of ["read-only", "low", "medium", "high"] as AutonomyLevel[]) {
      expect(agySessionAutonomyFlags(level)).toEqual(adapter.mapAutonomy(level));
    }
  });

  test("the resume pattern accepts the registry's id class and refuses pastes", () => {
    expect(AGY_CONVERSATION_ID_PATTERN.test("conv-fake-1")).toBe(true);
    expect(
      AGY_CONVERSATION_ID_PATTERN.test("11111111-2222-3333-4444-555555555555")
    ).toBe(true);
    expect(AGY_CONVERSATION_ID_PATTERN.test("bad id")).toBe(false);
    expect(AGY_CONVERSATION_ID_PATTERN.test("")).toBe(false);
    expect(AGY_CONVERSATION_ID_PATTERN.test("x".repeat(129))).toBe(false);
  });
});

describe("agy session - spawn command", () => {
  test("a fresh high-autonomy spawn is the NDJSON loop plus the bypass", () => {
    expect(
      buildAgySessionCommand({ autonomy: "high" })
    ).toEqual([
      "agy",
      "--disable-slash-commands",
      "--input-format=stream-json",
      "--output-format=stream-json",
      "--dangerously-skip-permissions",
    ]);
  });

  test("autonomy maps like the run path, every level", () => {
    expect(buildAgySessionCommand({ autonomy: "read-only" })).toContain("--mode=plan");
    expect(buildAgySessionCommand({ autonomy: "low" })).not.toContain("--mode=plan");
    expect(buildAgySessionCommand({ autonomy: "medium" })).toContain("--mode=accept-edits");
    const low = buildAgySessionCommand({ autonomy: "low" });
    expect(low.filter((arg) => arg.startsWith("--mode") || arg.startsWith("--dangerously"))).toEqual([]);
  });

  test("model and effort ride the = form; the conversation rides last", () => {
    expect(
      buildAgySessionCommand({
        autonomy: "medium",
        model: "gemini-3-pro",
        effort: "xhigh",
        resumeConversationId: "conv-42",
      })
    ).toEqual([
      "agy",
      "--disable-slash-commands",
      "--input-format=stream-json",
      "--output-format=stream-json",
      "--mode=accept-edits",
      "--model=gemini-3-pro",
      "--effort=xhigh",
      "--conversation=conv-42",
    ]);
  });

  test("no --print: stdin drives the turns", () => {
    for (const autonomy of ["read-only", "low", "medium", "high"] as AutonomyLevel[]) {
      expect(
        buildAgySessionCommand({ autonomy }).some((arg) => arg.startsWith("--print"))
      ).toBe(false);
    }
  });
});

describe("agy session - parser tiers", () => {
  const envelope = (fields: Record<string, unknown>): string =>
    JSON.stringify({ event: "result", result: fields });

  test("the fixture's input line is exactly the user frame codemux sends", () => {
    const input = fixtureRecords().find((record) => record.dir === "in");
    expect(input).toBeDefined();
    if (input === undefined) return;
    expect(buildAgyUserMessage("Reply with exactly: one")).toBe(input.line);
  });

  test("the fixture's auth-failure result parses as a no-identity error result", () => {
    const output = fixtureRecords().find((record) => record.dir === "out");
    expect(output).toBeDefined();
    const parse = parseAgySessionLine(output!.line, { knownConversationId: null });
    expect(parse.kind).toBe("result");
    if (parse.kind !== "result") return;
    expect(parse.conversationId).toBeNull();
    expect(parse.isError).toBe(true);
    expect(parse.status).toBe("ERROR");
    expect(parse.errorText).toBe("authentication failed or timed out");
    expect(parse.responseText).toBeNull();
    expect(parse.usage).toEqual({
      input_tokens: 0,
      output_tokens: 0,
      cached_input_tokens: 0,
      total_tokens: 0,
      cost_usd: null,
    });
  });

  test("a result naming a conversation id --resume would refuse is a grammar error (review live16)", () => {
    // Review live16, correctness major: any non-empty id was adopted, and
    // one past the registry's cap made the whole registry corrupt.
    for (const id of ["x".repeat(129), "has space"]) {
      const parse = parseAgySessionLine(
        envelope({ conversation_id: id, status: "SUCCESS", response: "Done." }),
        { knownConversationId: null }
      );
      expect(parse).toEqual({ kind: "grammar_error", message: "a result names an invalid conversation id" });
    }
  });

  test("a successful result normalizes usage through the run path's arithmetic", () => {
    const parse = parseAgySessionLine(
      envelope({
        conversation_id: "conv-1",
        status: "SUCCESS",
        response: "Done.",
        usage: {
          input_tokens: 100,
          output_tokens: 20,
          thinking_tokens: 5,
          cache_read_tokens: 40,
          total_tokens: 120,
        },
      }),
      { knownConversationId: null }
    );
    expect(parse.kind).toBe("result");
    if (parse.kind !== "result") return;
    expect(parse.conversationId).toBe("conv-1");
    expect(parse.isError).toBe(false);
    expect(parse.responseText).toBe("Done.");
    // Raw input includes the cache reads: 100 - 40 uncached, and the
    // total is the sum of the three known components (120).
    expect(parse.usage).toEqual({
      input_tokens: 60,
      output_tokens: 20,
      cached_input_tokens: 40,
      total_tokens: 120,
      cost_usd: null,
    });
  });

  test("a non-JSON line is tier-3 unusable", () => {
    const parse = parseAgySessionLine("this is not json", { knownConversationId: null });
    expect(parse.kind).toBe("unusable");
    if (parse.kind !== "unusable") return;
    expect(parse.bytes).toBeGreaterThan(0);
    expect(parse.excerpt).toContain("this is not json");
  });

  test("an unrecognized event name is tier-1 unknown", () => {
    const parse = parseAgySessionLine(
      JSON.stringify({ event: "status", payload: {} }),
      { knownConversationId: null }
    );
    expect(parse.kind).toBe("unknown");
  });

  test("a frame without an event name is tier-2", () => {
    const parse = parseAgySessionLine(
      JSON.stringify({ type: "system", subtype: "ambient" }),
      { knownConversationId: null }
    );
    expect(parse.kind).toBe("grammar_error");
  });

  test("a result frame without a result object is tier-2", () => {
    const parse = parseAgySessionLine(
      JSON.stringify({ event: "result" }),
      { knownConversationId: null }
    );
    expect(parse.kind).toBe("grammar_error");
  });

  test("a result envelope without a status, or a success without response, is tier-2", () => {
    expect(
      parseAgySessionLine(envelope({}), { knownConversationId: null }).kind
    ).toBe("grammar_error");
    expect(
      parseAgySessionLine(
        envelope({ conversation_id: "conv-1", status: "SUCCESS" }),
        { knownConversationId: null }
      ).kind
    ).toBe("grammar_error");
  });

  test("a result naming a different conversation than the session's is tier-2", () => {
    const parse = parseAgySessionLine(
      envelope({ conversation_id: "conv-other", status: "SUCCESS", response: "hi" }),
      { knownConversationId: "conv-1" }
    );
    expect(parse.kind).toBe("grammar_error");
    if (parse.kind !== "grammar_error") return;
    expect(parse.message).toContain("conv-other");
    expect(parse.message).toContain("conv-1");
  });

  test("an empty conversation id parses (the driver owns the no-identity verdict)", () => {
    const parse = parseAgySessionLine(
      envelope({
        conversation_id: "",
        status: "ERROR",
        error: "authentication failed or timed out",
      }),
      { knownConversationId: null }
    );
    expect(parse.kind).toBe("result");
    if (parse.kind !== "result") return;
    expect(parse.conversationId).toBeNull();
  });

  test("a result for the adopted conversation parses on resume", () => {
    const parse = parseAgySessionLine(
      envelope({ conversation_id: "conv-1", status: "SUCCESS", response: "back" }),
      { knownConversationId: "conv-1" }
    );
    expect(parse.kind).toBe("result");
  });
});
