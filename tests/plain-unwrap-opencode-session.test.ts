import { describe, expect, test } from "bun:test";
import { opencodePlainResult } from "../src/plain-unwrap.js";
import { parseOpenCodeRunLine } from "../src/session/opencode-session.js";
import type { RunResult } from "../src/types.js";
import { finished, opencodeFoldStream } from "./helpers/plain-unwrap.js";

const SESSION_ID = "ses_0123456789abcdef";
const OTHER_SESSION_ID = "ses_fedcba9876543210";

const event = (type: string, sessionID: string, part: Record<string, unknown> = {}): string =>
  JSON.stringify({ type, sessionID, part });

const malformedFirstEvents: Array<[string, (sessionID: string) => string]> = [
  ["text without text", (sessionID) => event("text", sessionID)],
  ["tool without a part", (sessionID) => JSON.stringify({ type: "tool_use", sessionID })],
  ["step without a part", (sessionID) => JSON.stringify({ type: "step_finish", sessionID })],
  ["event without a type", (sessionID) => JSON.stringify({ sessionID })],
];

const runModes: Array<[string, (stream: string) => RunResult]> = [
  ["whole capture", (stream) => opencodePlainResult(finished(stream))],
  ...[1, 7, 4096].map((chunkSize): [string, (stream: string) => RunResult] => [
    `streamed in ${chunkSize}-character chunks`,
    (stream) => opencodeFoldStream(stream, chunkSize).verdict(finished("")),
  ]),
];

describe("OpenCode run session consistency", () => {
  test("the parser identifies a session mismatch separately from other grammar errors", () => {
    const mismatch = parseOpenCodeRunLine(event("text", OTHER_SESSION_ID, { text: "foreign" }), {
      knownSessionId: SESSION_ID,
    });
    expect(mismatch).toEqual({
      kind: "grammar_error",
      reason: "session-mismatch",
      message: `a run-output line names session ${OTHER_SESSION_ID}, not ${SESSION_ID}`,
    });
    expect(parseOpenCodeRunLine(event("text", SESSION_ID), { knownSessionId: SESSION_ID })).toEqual({
      kind: "grammar_error",
      sessionId: SESSION_ID,
      message: "a text line carries no text part",
    });
  });

  for (const [mode, run] of runModes) {
    for (const [label, malformedEvent] of malformedFirstEvents) {
      test(`${mode}: ${label} establishes the session before a foreign reply`, () => {
        const result = run([
          malformedEvent(SESSION_ID),
          event("text", OTHER_SESSION_ID, { text: "foreign reply" }),
        ].join("\n"));
        expect(result.success).toBe(false);
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain(`names session ${OTHER_SESSION_ID}, not ${SESSION_ID}`);
        expect(result.stdout).toBe("");
        expect(result.usage?.total_tokens).toBeNull();
      });

      test(`${mode}: ${label} remains a diagnostic for the same session`, () => {
        const result = run([
          malformedEvent(SESSION_ID),
          "not json",
          event("text", SESSION_ID, { text: "the reply" }),
          event("step_finish", SESSION_ID, { tokens: { input: 8, output: 3, total: 11 } }),
        ].join("\n"));
        expect(result.success).toBe(true);
        expect(result.exitCode).toBe(0);
        expect(result.stderr).toContain("were not the wire");
        expect(result.stdout).toBe("the reply\n");
        expect(result.usage?.total_tokens).toBe(11);
      });
    }

    test(`${mode}: a second session fails and cannot add reply text or usage`, () => {
      const stream = [
        event("step_start", SESSION_ID),
        event("text", OTHER_SESSION_ID, { text: "foreign reply" }),
        event("text", SESSION_ID, { text: "first reply" }),
        event("step_finish", SESSION_ID, { tokens: { input: 8, output: 3, total: 11 } }),
        event("step_finish", OTHER_SESSION_ID, { tokens: { input: 90, output: 9, total: 99 } }),
        event("text", SESSION_ID, { text: "last reply" }),
      ].join("\n");
      const result = run(stream);
      expect(result.success).toBe(false);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(`names session ${OTHER_SESSION_ID}, not ${SESSION_ID}`);
      // Two steps are two assistant messages: a blank line between them (lane AN1).
      expect(result.stdout).toBe("first reply\n\nlast reply\n");
      expect(result.usage?.total_tokens).toBe(11);
    });

    test(`${mode}: one session succeeds across multiple event types`, () => {
      const stream = [
        event("step_start", SESSION_ID),
        event("text", SESSION_ID, { text: "first reply" }),
        event("tool_use", SESSION_ID, {
          id: "call_1", tool: "read", state: { status: "completed", input: {}, output: "file text" },
        }),
        event("step_finish", SESSION_ID, { tokens: { input: 8, output: 3, total: 11 } }),
        event("text", SESSION_ID, { text: "last reply" }),
      ].join("\n");
      const result = run(stream);
      expect(result.success).toBe(true);
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      // Two steps are two assistant messages: a blank line between them (lane AN1).
      expect(result.stdout).toBe("first reply\n\nlast reply\n");
      expect(result.usage?.total_tokens).toBe(11);
    });
  }
});
