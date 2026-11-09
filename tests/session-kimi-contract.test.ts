/**
 * Unit tests for the kimi session wiring (design §4.7): the floor, the
 * honest capability matrix, the per-turn spawn command, and the
 * command-shape refusal — each shape pinned against the installed 0.31.1
 * binary's prompt-mode writer (kimi-session.ts names the sources). Split
 * from tests/session-kimi.test.ts; the stream-json line parser suites are
 * tests/session-kimi-parser*.test.ts, the driver round-trips the e2e
 * suite (tests/session-kimi-e2e*.test.ts).
 */

import { describe, expect, test } from "bun:test";
import {
  buildKimiSessionCommand,
  KIMI_SESSION_FLOOR,
  KIMI_SESSION_ID_PATTERN,
  kimiPromptIsCommand,
  kimiSessionCapabilities,
} from "../src/session/kimi-session.js";
import { ID } from "./helpers/session-kimi.js";

describe("kimi session - contract", () => {
  test("the floor is the pinned 2.5.2", () => {
    expect(KIMI_SESSION_FLOOR).toBe("2.5.2");
  });

  test("the capability matrix includes supervisor interruption", () => {
    expect(kimiSessionCapabilities()).toEqual({
      live_input: true,
      user_during_turn: false,
      steer: false,
      interrupt: true,
      permissions: false,
      deltas: false,
      file_changes: false,
      usage_stream: false,
      resume: true,
    });
  });

  test("the resume pattern accepts native ids and refuses pastes", () => {
    expect(KIMI_SESSION_ID_PATTERN.test(ID)).toBe(true);
    // The store mints lowercase UUIDs only.
    expect(
      KIMI_SESSION_ID_PATTERN.test("session_11111111-2222-3333-4444-555555555555".toUpperCase())
    ).toBe(false);
    expect(KIMI_SESSION_ID_PATTERN.test("ses_abc12345")).toBe(false);
    expect(KIMI_SESSION_ID_PATTERN.test("session_11111111")).toBe(false);
    expect(KIMI_SESSION_ID_PATTERN.test("../../etc")).toBe(false);
    expect(KIMI_SESSION_ID_PATTERN.test("")).toBe(false);
  });
});

describe("kimi session - spawn command", () => {
  test("a fresh turn is stream-json with the prompt as the argv tail", () => {
    expect(buildKimiSessionCommand({ prompt: "hello" })).toEqual([
      "kimi",
      "--output-format",
      "stream-json",
      "--prompt",
      "hello",
    ]);
  });

  test("the model rides first; the resume id sits before the output format", () => {
    expect(
      buildKimiSessionCommand({ model: "kimi-k2.5", resumeSessionId: ID, prompt: "hello" })
    ).toEqual([
      "kimi",
      "--model",
      "kimi-k2.5",
      "--session",
      ID,
      "--output-format",
      "stream-json",
      "--prompt",
      "hello",
    ]);
  });

  test("no autonomy flags ride the command: kimi refuses them with --prompt", () => {
    // The run adapter's pinned fact (0.31.1): --plan/--yolo/--auto are
    // interactive-only. The command carries none at any level, so the
    // check is the same flat argv for every level the CLI may pass.
    for (const argv of [
      buildKimiSessionCommand({ prompt: "x" }),
      buildKimiSessionCommand({ prompt: "x", resumeSessionId: ID }),
    ]) {
      expect(argv).not.toContain("--plan");
      expect(argv).not.toContain("--yolo");
      expect(argv).not.toContain("--auto");
    }
  });
});

describe("kimi session - command-shape refusal", () => {
  test("the word-bounded /goal name and the ! shape are commands (al17)", () => {
    // The binary's own rule (0.31.1, both headless entry points): only
    // goal-creates are dispatched before the model turn. codemux refuses
    // the whole word-bounded /goal name — kimi's GOAL_PREFIX is
    // /^\/goal(\s|$)/ on the trimmed prompt — and the ! shape.
    expect(kimiPromptIsCommand("/goal create ship it")).toBe(true);
    expect(kimiPromptIsCommand("/goal")).toBe(true);
    expect(kimiPromptIsCommand("/goal status")).toBe(true);
    expect(kimiPromptIsCommand("  /goal create ship it")).toBe(true);
    expect(kimiPromptIsCommand("!rm -rf /")).toBe(true);
    expect(kimiPromptIsCommand("  !ls")).toBe(true);
  });

  test("every other prompt is model text, /-leading paths included (al17)", () => {
    // The al11 rule refused these; 0.31.1 sends them to the model
    // unchanged (the major: /tmp/notes.md please summarize exited 64).
    expect(kimiPromptIsCommand("/tmp/notes.md please summarize")).toBe(false);
    expect(kimiPromptIsCommand("/init")).toBe(false);
    expect(kimiPromptIsCommand("/help")).toBe(false);
    // Word-bounded: /goalfoo and /goals are not the /goal name.
    expect(kimiPromptIsCommand("/goalfoo ship it")).toBe(false);
    expect(kimiPromptIsCommand("/goals for today")).toBe(false);
    expect(kimiPromptIsCommand("use /goal here")).toBe(false);
    expect(kimiPromptIsCommand("hello world")).toBe(false);
    expect(kimiPromptIsCommand("")).toBe(false);
    // An author prefix sits ahead of the shape and neutralizes it.
    expect(kimiPromptIsCommand("[author] /goal create ship it")).toBe(false);
  });
});
