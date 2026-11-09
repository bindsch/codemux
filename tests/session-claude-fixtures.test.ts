/**
 * Fixture replay tests for the claude session parser over the committed
 * zai recordings: the per-turn init stream and the shared-message-id
 * dedupe blocker. Split from the former tests/session-claude.test.ts.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ClaudeStreamParser } from "../src/session/claude-session.js";
import { servedModelForTurn } from "../src/session/driver-turns.js";
import { emptyUsage } from "../src/result-envelope.js";
import { addTurnUsage } from "../src/session/usage.js";

describe("fixture replay - zai-session-a.ndjson", () => {
  test("the per-turn init stream parses with exactly one init and no fatals", () => {
    const records = readFileSync(
      fileURLToPath(new URL("./fixtures/live/zai-session-a.ndjson", import.meta.url)),
      "utf8"
    )
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as { dir: string; line: string });
    const parser = new ClaudeStreamParser();
    let inits = 0;
    const fatal: string[] = [];
    for (const record of records) {
      if (record.dir !== "out") continue;
      for (const parse of parser.feed(record.line, {
        expectedSessionId: "cf65c7fd-b902-4d5b-908f-92159e3829d5",
      })) {
        if (parse.kind === "init") inits += 1;
        if (parse.kind === "grammar_error" || parse.kind === "unusable") {
          fatal.push(record.line);
        }
      }
    }
    // Four turns, four init frames, one session (the fixture's own
    // header): only the first parses as init; the rest are tier-1
    // unknowns and nothing in the recorded exchange is a grammar break.
    expect(inits).toBe(1);
    expect(fatal).toEqual([]);
  });

  test("the session cumulative reproduces: tokens sum, the cost adopts", () => {
    // The review-live8 defect, replayed on the committed fixture: the
    // four results report per-turn token counts but a session-lifetime
    // total_cost_usd (0.101124 -> 0.1066152 -> 0.118512, the aborted
    // result repeating the last figure). Summing the per-turn costs
    // reported $0.4447632 against the harness's own final $0.118512 —
    // the fold must adopt the cost while it sums the tokens. The
    // fixture's own final modelUsage snapshot (inputTokens 25636,
    // outputTokens 40, cacheReadInputTokens 75840) is the harness's
    // independent statement of the same totals.
    const records = readFileSync(
      fileURLToPath(new URL("./fixtures/live/zai-session-a.ndjson", import.meta.url)),
      "utf8"
    )
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as { dir: string; line: string });
    const parser = new ClaudeStreamParser();
    let cumulative = emptyUsage();
    for (const record of records) {
      if (record.dir !== "out") continue;
      for (const parse of parser.feed(record.line, {
        expectedSessionId: "cf65c7fd-b902-4d5b-908f-92159e3829d5",
      })) {
        if (parse.kind === "turn_completed") {
          cumulative = addTurnUsage(cumulative, parse.usage);
        }
      }
    }
    expect(cumulative.input_tokens).toBe(25636);
    expect(cumulative.output_tokens).toBe(40);
    expect(cumulative.cached_input_tokens).toBe(75840);
    expect(cumulative.cost_usd).toBe(0.118512);
  });

  test("the naming frames flow: init model at start, message.model per turn (design P5)", () => {
    // The recorded wire names its model three ways — `model` on every
    // init frame, `model` on every assistant message, `modelUsage` keyed
    // by it on every result — all "claude-opus-5-5". The announcement
    // reports the init value as source `harness`; each turn reports the
    // single provider-named id as source `provider` (servedModelForTurn,
    // the driver's own rule, applied to the replayed facts).
    const records = readFileSync(
      fileURLToPath(new URL("./fixtures/live/zai-session-a.ndjson", import.meta.url)),
      "utf8"
    )
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as { dir: string; line: string });
    const parser = new ClaudeStreamParser();
    let initModel: string | null = null;
    const turnModels = new Set<string>();
    const served: (string | null)[] = [];
    for (const record of records) {
      if (record.dir !== "out") continue;
      for (const parse of parser.feed(record.line, {
        expectedSessionId: "cf65c7fd-b902-4d5b-908f-92159e3829d5",
      })) {
        if (parse.kind === "init") initModel = parse.model;
        if (parse.kind === "assistant_model") turnModels.add(parse.model);
        if (parse.kind === "turn_completed") {
          served.push(servedModelForTurn(turnModels, parse.models));
          turnModels.clear();
        }
      }
    }
    expect(initModel).toBe("claude-opus-5-5");
    // Four turns (the fixture's own header), each attributed to the one
    // model the provider named — including the aborted last one.
    expect(served).toEqual(["claude-opus-5-5", "claude-opus-5-5", "claude-opus-5-5", "claude-opus-5-5"]);
  });
});

describe("fixture replay - shared message ids (the dedupe blocker)", () => {
  function outLines(name: string): string[] {
    return readFileSync(fileURLToPath(new URL(`./fixtures/live/${name}`, import.meta.url)), "utf8")
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as { dir: string; line: string })
      .filter((record) => record.dir === "out")
      .map((record) => record.line);
  }

  test("zai-permission.ndjson: the Bash tool call after a thinking frame survives", () => {
    // Lines 48/49 share msg_…4486c — thinking, then the tool_use. The
    // message-id dedupe dropped the second frame, so the session's
    // caller never saw the very tool call the permission request was
    // about.
    const parser = new ClaudeStreamParser();
    const parses = outLines("zai-permission.ndjson").flatMap((line) =>
      parser.feed(line, {
        expectedSessionId: "5678e74c-468d-4479-83cf-629359c284a7",
      })
    );
    expect(
      parses.find(
        (parse) => parse.kind === "tool_call" && parse.callId === "call_beb0254ff96e499fa71e7bd6"
      )
    ).toMatchObject({ kind: "tool_call", name: "Bash" });
  });

  test("zai-permission2.ndjson: the final text after a thinking frame survives", () => {
    // Lines 29/30 share msg_…141e0 — thinking, then the answer text. The
    // dedupe dropped the text, so the turn ended with no assistant
    // message at all.
    const parser = new ClaudeStreamParser();
    const parses = outLines("zai-permission2.ndjson").flatMap((line) =>
      parser.feed(line, {
        expectedSessionId: "4fa7aa96-6700-4b93-874f-b6a5982387c4",
      })
    );
    expect(
      parses.some(
        (parse) => parse.kind === "assistant_text" && parse.text.startsWith("The command was blocked")
      )
    ).toBe(true);
  });
});
