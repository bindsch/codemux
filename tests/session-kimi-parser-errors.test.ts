/**
 * Unit tests for the kimi session's stream-json line parser, malformed
 * shapes (design §4.7): every present-but-invalid payload the installed
 * 0.31.1 binary's prompt-mode writer never sends is a tier-2 grammar
 * error, never a guessed event (kimi-session.ts names the sources). Split
 * from tests/session-kimi.test.ts; the valid shapes are
 * tests/session-kimi-parser.test.ts.
 */

import { describe, expect, test } from "bun:test";
import { parseKimiStreamLine } from "../src/session/kimi-session.js";
import { ID, OTHER } from "./helpers/session-kimi.js";

describe("kimi session - parser tiers", () => {
  test("a resume hint missing the pinned command or content is a grammar error, not confirmation (al24)", () => {
    // The edges minor: the hint was accepted on its session_id alone, so
    // a record the pinned writer never sends — the resume command or the
    // human note missing — was taken as proof the turn persisted and the
    // session was marked resumable. The writer emits all five fields, so
    // the confirmation now requires the whole pinned shape.
    const shapes: [string, Record<string, unknown>][] = [
      ["no command or content", { role: "meta", type: "session.resume_hint", session_id: ID }],
      [
        "no content",
        {
          role: "meta",
          type: "session.resume_hint",
          session_id: ID,
          command: `kimi -r ${ID}`,
        },
      ],
      [
        "no command",
        {
          role: "meta",
          type: "session.resume_hint",
          session_id: ID,
          content: `To resume this session: kimi -r ${ID}`,
        },
      ],
      [
        "an empty command",
        {
          role: "meta",
          type: "session.resume_hint",
          session_id: ID,
          command: "",
          content: `To resume this session: kimi -r ${ID}`,
        },
      ],
      [
        "empty content",
        {
          role: "meta",
          type: "session.resume_hint",
          session_id: ID,
          command: `kimi -r ${ID}`,
          content: "",
        },
      ],
      [
        "a non-string command",
        {
          role: "meta",
          type: "session.resume_hint",
          session_id: ID,
          command: 7,
          content: `To resume this session: kimi -r ${ID}`,
        },
      ],
    ];
    for (const [label, shape] of shapes) {
      const parse = parseKimiStreamLine(JSON.stringify(shape), { knownSessionId: null });
      expect(parse.kind, label).toBe("grammar_error");
    }
    // The full pinned shape still confirms.
    expect(
      parseKimiStreamLine(
        JSON.stringify({
          role: "meta",
          type: "session.resume_hint",
          session_id: ID,
          command: `kimi -r ${ID}`,
          content: `To resume this session: kimi -r ${ID}`,
        }),
        { knownSessionId: null }
      )
    ).toEqual({ kind: "resume_hint", sessionId: ID });
  });

  test("a resume hint whose command or note names anything but the pinned resume for its session is a grammar error (al30)", () => {
    // Round al30, rule 4 (edges minor): al24 required the fields present,
    // but any non-empty value passed — so a hint naming session A with a
    // command naming session B confirmed A, and a reworded-away note
    // confirmed a hint whose resume instruction the human could not read.
    // The writer's pinned spellings are exact: `command` is exactly
    // `kimi -r <session_id>` for the session the hint names, and
    // `content` is the pinned writer line `To resume this session:
    // kimi -r <session_id>` itself — matched exactly, not by substring
    // (round al33, edges minor: inclusion let a negation of the command
    // confirm the session).
    const shapes: [string, Record<string, unknown>][] = [
      [
        "a command naming a foreign session",
        {
          role: "meta",
          type: "session.resume_hint",
          session_id: ID,
          command: `kimi -r ${OTHER}`,
          content: `To resume this session: kimi -r ${ID}`,
        },
      ],
      [
        "a command with a different spelling",
        {
          role: "meta",
          type: "session.resume_hint",
          session_id: ID,
          command: `kimi --resume ${ID}`,
          content: `To resume this session: kimi -r ${ID}`,
        },
      ],
      [
        "a note that rewords the command away",
        {
          role: "meta",
          type: "session.resume_hint",
          session_id: ID,
          command: `kimi -r ${ID}`,
          content: `To resume this session: rerun kimi with the stored id`,
        },
      ],
      [
        "a whitespace-only note",
        {
          role: "meta",
          type: "session.resume_hint",
          session_id: ID,
          command: `kimi -r ${ID}`,
          content: "   ",
        },
      ],
      [
        "a note carrying a foreign session's command",
        {
          role: "meta",
          type: "session.resume_hint",
          session_id: ID,
          command: `kimi -r ${ID}`,
          content: `To resume this session: kimi -r ${OTHER}`,
        },
      ],
      [
        "a non-string note",
        {
          role: "meta",
          type: "session.resume_hint",
          session_id: ID,
          command: `kimi -r ${ID}`,
          content: 7,
        },
      ],
    ];
    for (const [label, shape] of shapes) {
      const parse = parseKimiStreamLine(JSON.stringify(shape), { knownSessionId: null });
      expect(parse.kind, label).toBe("grammar_error");
    }
    // A note that only carries the command inside other prose — wrapped,
    // or negated outright — is not the writer's line (round al33, edges
    // minor: the substring match confirmed a hint whose instruction read
    // "DO NOT run" the resume command it named).
    for (const content of [
      `You can pick this up later (${ID}). To resume this session: kimi -r ${ID}`,
      `DO NOT run kimi -r ${ID}`,
      `To resume this session: kimi -r ${ID} `,
    ]) {
      const parse = parseKimiStreamLine(
        JSON.stringify({
          role: "meta",
          type: "session.resume_hint",
          session_id: ID,
          command: `kimi -r ${ID}`,
          content,
        }),
        { knownSessionId: null }
      );
      expect(parse.kind).toBe("grammar_error");
    }
    // The pinned writer line itself, exactly, still confirms.
    expect(
      parseKimiStreamLine(
        JSON.stringify({
          role: "meta",
          type: "session.resume_hint",
          session_id: ID,
          command: `kimi -r ${ID}`,
          content: `To resume this session: kimi -r ${ID}`,
        }),
        { knownSessionId: null }
      )
    ).toEqual({ kind: "resume_hint", sessionId: ID });
  });

  test("mapped shapes with broken payloads are tier-2: an empty assistant line, a tool line without an id, a non-array tool_calls", () => {
    expect(
      parseKimiStreamLine(JSON.stringify({ role: "assistant" }), { knownSessionId: null }).kind
    ).toBe("grammar_error");
    expect(
      parseKimiStreamLine(JSON.stringify({ role: "assistant", content: "" }), {
        knownSessionId: null,
      }).kind
    ).toBe("grammar_error");
    expect(
      parseKimiStreamLine(JSON.stringify({ role: "tool", content: "x" }), { knownSessionId: null })
        .kind
    ).toBe("grammar_error");
    expect(
      parseKimiStreamLine(JSON.stringify({ role: "assistant", tool_calls: "bash" }), {
        knownSessionId: null,
      }).kind
    ).toBe("grammar_error");
    expect(
      parseKimiStreamLine(
        JSON.stringify({
          role: "assistant",
          tool_calls: [{ type: "function", function: { name: "bash", arguments: "{}" } }],
        }),
        { knownSessionId: null }
      ).kind
    ).toBe("grammar_error");
    // An empty array is no calls (al11 re-review): `{tool_calls:[]}` is
    // the neither-nor shape — before the fix it slipped past the check
    // and the turn completed with no message and no calls.
    expect(
      parseKimiStreamLine(JSON.stringify({ role: "assistant", tool_calls: [] }), {
        knownSessionId: null,
      }).kind
    ).toBe("grammar_error");
    // Content beside the empty array is still a real assistant line.
    expect(
      parseKimiStreamLine(JSON.stringify({ role: "assistant", content: "hi", tool_calls: [] }), {
        knownSessionId: null,
      }).kind
    ).toBe("assistant");
  });

  test("present-but-invalid assistant content is tier-2, tool calls or not (al13)", () => {
    // The edges-2 finding: a present content that is not a non-empty
    // string — null, a number, an object, the empty string (the last
    // already pinned above) — breaks the writer's pin, and before al13
    // it was nulled silently: the line passed as valid with its
    // malformed content dropped on the floor, and a tool-calls-only
    // line carrying a broken content beside the calls counted as
    // answered. The wire writer drops an empty content entirely
    // (flushAssistant passes void 0), so every present-but-invalid
    // spelling is a grammar error whatever else the line carries.
    for (const line of [
      JSON.stringify({ role: "assistant", content: null }),
      JSON.stringify({ role: "assistant", content: 7 }),
      JSON.stringify({ role: "assistant", content: { text: "hi" } }),
      JSON.stringify({
        role: "assistant",
        content: null,
        tool_calls: [
          { type: "function", id: "call_1", function: { name: "bash", arguments: "{}" } },
        ],
      }),
      JSON.stringify({
        role: "assistant",
        content: 7,
        tool_calls: [
          { type: "function", id: "call_1", function: { name: "bash", arguments: "{}" } },
        ],
      }),
    ]) {
      const parse = parseKimiStreamLine(line, { knownSessionId: null });
      expect(parse.kind, line).toBe("grammar_error");
      if (parse.kind === "grammar_error") {
        expect(parse.message, line).toBe(
          "an assistant line carries a present-but-invalid content"
        );
      }
    }
    // Absent content beside real calls stays the writer's own
    // tool-calls-only spelling, and a valid content passes: the guard
    // reads presence and validity, never absence.
    expect(
      parseKimiStreamLine(
        JSON.stringify({
          role: "assistant",
          tool_calls: [
            { type: "function", id: "call_1", function: { name: "bash", arguments: "{}" } },
          ],
        }),
        { knownSessionId: null }
      )
    ).toEqual({
      kind: "assistant",
      text: null,
      toolCalls: [{ callId: "call_1", name: "bash", input: {} }],
    });
    expect(
      parseKimiStreamLine(JSON.stringify({ role: "assistant", content: "hi" }), {
        knownSessionId: null,
      })
    ).toEqual({ kind: "assistant", text: "hi", toolCalls: [] });
  });

  test("a tool result with missing or non-string content is tier-2, never an outputless event (al13)", () => {
    // The edges-3 finding: the writer stringifies the tool output into
    // `content`, so a result whose content is missing or not a string
    // breaks the pin. Before al13 the line passed and emitted a
    // tool_result with no `output` field at all — a valid-looking event
    // with its payload missing. The empty string is the stringified
    // empty output and stays valid.
    for (const line of [
      JSON.stringify({ role: "tool", tool_call_id: "call_1" }),
      JSON.stringify({ role: "tool", tool_call_id: "call_1", content: null }),
      JSON.stringify({ role: "tool", tool_call_id: "call_1", content: 3 }),
      JSON.stringify({ role: "tool", tool_call_id: "call_1", content: { out: "x" } }),
    ]) {
      const parse = parseKimiStreamLine(line, { knownSessionId: null });
      expect(parse.kind, line).toBe("grammar_error");
      if (parse.kind === "grammar_error") {
        expect(parse.message, line).toBe("a tool line carries no string content");
      }
    }
    expect(
      parseKimiStreamLine(JSON.stringify({ role: "tool", tool_call_id: "call_1", content: "" }), {
        knownSessionId: null,
      })
    ).toEqual({ kind: "tool_result", callId: "call_1", output: "" });
  });

  test("a tool call's arguments must be a string and its name non-empty, its type function (al14)", () => {
    // The edges finding: the writer's exact spelling is
    // {type:"function",id,function:{name,arguments}} with arguments the
    // JSON-stringified call input. Before al14 the loop checked only the
    // id and a string name — an empty name passed, `type` went unchecked,
    // and `arguments` could be missing or non-string, which handed the
    // event layer an `input` of `undefined` whose serialization drops the
    // required `input` field while the turn still completed `end`.
    const cases: [line: string, message: string][] = [
      [
        JSON.stringify({
          role: "assistant",
          tool_calls: [
            { type: "function", id: "call_1", function: { name: "bash" } },
          ],
        }),
        "an assistant line carries a tool call without string arguments",
      ],
      [
        JSON.stringify({
          role: "assistant",
          tool_calls: [
            { type: "function", id: "call_1", function: { name: "bash", arguments: 7 } },
          ],
        }),
        "an assistant line carries a tool call without string arguments",
      ],
      [
        JSON.stringify({
          role: "assistant",
          tool_calls: [
            {
              type: "function",
              id: "call_1",
              function: { name: "bash", arguments: { command: "ls" } },
            },
          ],
        }),
        "an assistant line carries a tool call without string arguments",
      ],
      [
        JSON.stringify({
          role: "assistant",
          tool_calls: [
            { type: "function", id: "call_1", function: { name: "", arguments: "{}" } },
          ],
        }),
        "an assistant line carries a tool call with no name",
      ],
      [
        JSON.stringify({
          role: "assistant",
          tool_calls: [
            { id: "call_1", function: { name: "bash", arguments: "{}" } },
          ],
        }),
        "an assistant line carries a tool call that is not a function call",
      ],
      [
        JSON.stringify({
          role: "assistant",
          tool_calls: [
            { type: "tool", id: "call_1", function: { name: "bash", arguments: "{}" } },
          ],
        }),
        "an assistant line carries a tool call that is not a function call",
      ],
    ];
    for (const [line, message] of cases) {
      const parse = parseKimiStreamLine(line, { knownSessionId: null });
      expect(parse.kind, line).toBe("grammar_error");
      if (parse.kind === "grammar_error") {
        expect(parse.message, line).toBe(message);
      }
    }
    // The writer's own spelling parses, `input` the parsed value — never
    // `undefined` — and an unparseable string keeps the raw string (the
    // never-guessed rule).
    expect(
      parseKimiStreamLine(
        JSON.stringify({
          role: "assistant",
          tool_calls: [
            {
              type: "function",
              id: "call_1",
              function: { name: "bash", arguments: JSON.stringify({ command: "ls" }) },
            },
          ],
        }),
        { knownSessionId: null }
      )
    ).toEqual({
      kind: "assistant",
      text: null,
      toolCalls: [{ callId: "call_1", name: "bash", input: { command: "ls" } }],
    });
    expect(
      parseKimiStreamLine(
        JSON.stringify({
          role: "assistant",
          tool_calls: [
            { type: "function", id: "call_1", function: { name: "bash", arguments: "{" } },
          ],
        }),
        { knownSessionId: null }
      )
    ).toEqual({
      kind: "assistant",
      text: null,
      toolCalls: [{ callId: "call_1", name: "bash", input: "{" }],
    });
  });
});
