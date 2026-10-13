/**
 * Unit tests for the kimi session wiring (design §4.7): the floor, the
 * honest capability matrix, the per-turn spawn command, the command-shape
 * refusal, and the stream-json line parser under the three tiers — each
 * shape pinned against the installed 0.31.1 binary's prompt-mode writer
 * (kimi-session.ts names the sources). The driver round-trips are the
 * e2e suite (tests/session-kimi-e2e.test.ts).
 */

import { describe, expect, test } from "bun:test";
import {
  buildKimiSessionCommand,
  KIMI_SESSION_FLOOR,
  KIMI_SESSION_ID_PATTERN,
  kimiPromptIsCommand,
  kimiSessionCapabilities,
  parseKimiStreamLine,
} from "../src/session/kimi-session.js";

const ID = "session_11111111-2222-3333-4444-555555555555";
const OTHER = "session_99999999-8888-7777-6666-555555555555";

describe("kimi session - contract", () => {
  test("the floor is the pinned 0.31.1", () => {
    expect(KIMI_SESSION_FLOOR).toBe("0.31.1");
  });

  test("the capability matrix is honest: only live input and resume", () => {
    expect(kimiSessionCapabilities()).toEqual({
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

describe("kimi session - parser tiers", () => {
  test("an assistant text line parses with its content", () => {
    const parse = parseKimiStreamLine(
      JSON.stringify({ role: "assistant", content: "hello" }),
      { knownSessionId: null }
    );
    expect(parse).toEqual({ kind: "assistant", text: "hello", toolCalls: [] });
  });

  test("a tool-calling assistant line parses each call with its arguments", () => {
    const parse = parseKimiStreamLine(
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
    );
    expect(parse).toEqual({
      kind: "assistant",
      text: null,
      toolCalls: [{ callId: "call_1", name: "bash", input: { command: "ls" } }],
    });
  });

  test("an assistant line may carry content and tool calls together", () => {
    const parse = parseKimiStreamLine(
      JSON.stringify({
        role: "assistant",
        content: "listing",
        tool_calls: [
          { type: "function", id: "c2", function: { name: "read", arguments: '{"path":"x"}' } },
        ],
      }),
      { knownSessionId: null }
    );
    expect(parse).toMatchObject({ kind: "assistant", text: "listing" });
    expect(parse.kind === "assistant" && parse.toolCalls[0]?.input).toEqual({ path: "x" });
  });

  test("unparseable tool arguments stay the raw string, never guessed", () => {
    const parse = parseKimiStreamLine(
      JSON.stringify({
        role: "assistant",
        tool_calls: [
          { type: "function", id: "c1", function: { name: "bash", arguments: "{not json" } },
        ],
      }),
      { knownSessionId: null }
    );
    expect(parse.kind === "assistant" && parse.toolCalls[0]?.input).toBe("{not json");
  });

  test("a tool result line parses with its call id and stringified output", () => {
    const parse = parseKimiStreamLine(
      JSON.stringify({ role: "tool", tool_call_id: "call_1", content: "file-a\nfile-b" }),
      { knownSessionId: null }
    );
    expect(parse).toEqual({
      kind: "tool_result",
      callId: "call_1",
      output: "file-a\nfile-b",
    });
  });

  test("the resume hint parses with the session id the driver adopts", () => {
    const line = JSON.stringify({
      role: "meta",
      type: "session.resume_hint",
      session_id: ID,
      command: `kimi -r ${ID}`,
      content: `To resume this session: kimi -r ${ID}`,
    });
    expect(parseKimiStreamLine(line, { knownSessionId: null })).toEqual({
      kind: "resume_hint",
      sessionId: ID,
    });
    expect(parseKimiStreamLine(line, { knownSessionId: ID })).toEqual({
      kind: "resume_hint",
      sessionId: ID,
    });
  });

  test("informational meta (retrying, version) and roleless lines are tier-1 unknown", () => {
    expect(
      parseKimiStreamLine(
        JSON.stringify({ role: "meta", type: "turn.step.retrying", failed_attempt: 1 }),
        { knownSessionId: ID }
      ).kind
    ).toBe("unknown");
    expect(
      parseKimiStreamLine(JSON.stringify({ role: "meta", type: "system.version", version: "0.31.1" }), {
        knownSessionId: ID,
      }).kind
    ).toBe("unknown");
    expect(parseKimiStreamLine(JSON.stringify({ type: "goal.summary" }), { knownSessionId: ID }).kind).toBe(
      "unknown"
    );
  });

  test("a non-JSON line is tier-3 unusable, with a bounded excerpt", () => {
    const parse = parseKimiStreamLine("this is not json", { knownSessionId: null });
    expect(parse.kind).toBe("unusable");
    if (parse.kind === "unusable") {
      expect(parse.excerpt).toBe("this is not json");
      expect(parse.bytes).toBe("this is not json".length);
    }
  });

  test("a JSON non-object (array) is tier-3 unusable", () => {
    expect(parseKimiStreamLine("[1,2]", { knownSessionId: null }).kind).toBe("unusable");
  });

  test("a resume hint with a malformed id, or naming a different session, is tier-2", () => {
    const bad = parseKimiStreamLine(
      JSON.stringify({
        role: "meta",
        type: "session.resume_hint",
        session_id: "not-a-session-id",
      }),
      { knownSessionId: null }
    );
    expect(bad.kind).toBe("grammar_error");
    const wrong = parseKimiStreamLine(
      JSON.stringify({
        role: "meta",
        type: "session.resume_hint",
        session_id: OTHER,
      }),
      { knownSessionId: ID }
    );
    expect(wrong.kind).toBe("grammar_error");
    expect(wrong.kind === "grammar_error" && wrong.message).toContain(OTHER);
  });

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
