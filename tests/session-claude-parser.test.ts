/**
 * Unit tests for the claude session wire: the outbound writers the
 * driver sends (wire writers), the ClaudeStreamParser tiers, and the
 * shared tier-3 excerpt bound (review live23). Split from the former
 * tests/session-claude.test.ts.
 */

import { describe, expect, test } from "bun:test";
import {
  DEFAULT_DENIAL_MESSAGE,
  buildControlResponse,
  buildHarnessUserMessage,
  buildInterruptRequest,
  claudeSessionCapabilities,
  ClaudeStreamParser,
} from "../src/session/claude-session.js";
import { CodexStreamParser } from "../src/session/codex-session.js";
import { parseAgySessionLine } from "../src/session/agy-session.js";
import { FLOOR_ID } from "./helpers/session-claude.js";

function feedOne(parser: ClaudeStreamParser, event: unknown, expectedSessionId = FLOOR_ID): unknown[] {
  return parser.feed(JSON.stringify(event), { expectedSessionId });
}

describe("wire writers", () => {
  test("the can_use_tool answer matches the fixture-pinned shape", () => {
    const line = JSON.parse(
      buildControlResponse("req_1", "allow", { command: "echo hi" }, "go ahead")
    ) as Record<string, unknown>;
    expect(line).toEqual({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: "req_1",
        response: {
          behavior: "allow",
          updatedInput: { command: "echo hi" },
          message: "go ahead",
        },
      },
    });
  });

  test("deny carries no updatedInput and Claude Code's own rejection text", () => {
    const line = JSON.parse(buildControlResponse("req_2", "deny")) as {
      response: { response: Record<string, unknown> };
    };
    expect(line.response.response["behavior"]).toBe("deny");
    expect(line.response.response["updatedInput"]).toBeUndefined();
    // The installed 2.1.300 binary's own user-rejection wording, so the
    // agent reads the deny as its harness's, never a wrapper's.
    expect(line.response.response["message"]).toBe(DEFAULT_DENIAL_MESSAGE);
    expect(DEFAULT_DENIAL_MESSAGE.startsWith("The user doesn't want to proceed with this tool use.")).toBe(true);
    expect(DEFAULT_DENIAL_MESSAGE.includes("STOP what you are doing")).toBe(true);
    expect(DEFAULT_DENIAL_MESSAGE.includes("codemux")).toBe(false);
  });

  test("a caller denial message substitutes; an allow's default is unchanged", () => {
    const custom = JSON.parse(
      buildControlResponse("req_2b", "deny", undefined, "Not in this fixture.")
    ) as {
      response: { response: Record<string, unknown> };
    };
    expect(custom.response.response["message"]).toBe("Not in this fixture.");
    const allow = JSON.parse(
      buildControlResponse("req_2c", "allow", { command: "echo hi" })
    ) as {
      response: { response: Record<string, unknown> };
    };
    expect(allow.response.response["message"]).toBe("codemux: allow");
  });

  test("the user line and the interrupt request match the recorded shapes", () => {
    expect(JSON.parse(buildHarnessUserMessage("hello"))).toEqual({
      type: "user",
      message: { role: "user", content: [{ type: "text", text: "hello" }] },
    });
    expect(JSON.parse(buildInterruptRequest("req_3"))).toEqual({
      type: "control_request",
      request_id: "req_3",
      request: { subtype: "interrupt" },
    });
  });
});

describe("ClaudeStreamParser", () => {
  test("capabilities report the fixture-pinned claude-family flags", () => {
    // `steer` is honestly false (review live3, contracts), and so is
    // `user_during_turn` (review live21): print mode folds a mid-turn
    // message into the running turn's result when the turn makes another
    // model request and answers it in its own result when it does not, so
    // no flag value describes it and the line is rejected `busy`.
    expect(claudeSessionCapabilities()).toEqual({
      live_input: true,
      user_during_turn: false,
      steer: false,
      interrupt: true,
      permissions: true,
      deltas: true,
      file_changes: "derived",
      usage_stream: false,
      resume: true,
    });
  });

  test("system/init parses once; later ones pass through unknown (per-turn init)", () => {
    const parser = new ClaudeStreamParser();
    expect(feedOne(parser, { type: "system", subtype: "init", session_id: FLOOR_ID })).toEqual([
      { kind: "init", sessionId: FLOOR_ID },
    ]);
    // The real wire emits one init per turn with the same session id (the
    // zai-session-a fixture): the second and later ones are tier-1
    // unknowns, never session-enders.
    expect(feedOne(parser, { type: "system", subtype: "init", session_id: FLOOR_ID })).toEqual([
      { kind: "unknown" },
    ]);
  });

  test("an init without a session id is a grammar error, not a pass-through", () => {
    const parser = new ClaudeStreamParser();
    const parse = feedOne(parser, { type: "system", subtype: "init" })[0] as { kind: string };
    expect(parse.kind).toBe("grammar_error");
  });

  test("an event framed with a foreign session id is a grammar error", () => {
    const parser = new ClaudeStreamParser();
    const parse = feedOne(parser, {
      type: "assistant",
      session_id: "00000000-dead-beef-0000-000000000000",
      message: { id: "m1", content: [{ type: "text", text: "hi" }] },
    })[0] as { kind: string; message: string };
    expect(parse.kind).toBe("grammar_error");
    expect(parse.message).toContain("expected");
  });

  test("assistant text, tool_use, and the derived file change parse from one line", () => {
    const parser = new ClaudeStreamParser();
    const parses = feedOne(parser, {
      type: "assistant",
      session_id: FLOOR_ID,
      message: {
        id: "msg_1",
        content: [
          { type: "text", text: "editing" },
          { type: "tool_use", id: "toolu_1", name: "Edit", input: { file_path: "/tmp/launch/a.txt", old_string: "a", new_string: "b" } },
        ],
        usage: { input_tokens: 3, output_tokens: 1 },
      },
    });
    expect(parses).toEqual([
      { kind: "assistant_text", text: "editing" },
      {
        kind: "tool_call",
        callId: "toolu_1",
        name: "Edit",
        input: { file_path: "/tmp/launch/a.txt", old_string: "a", new_string: "b" },
      },
      // The parser names the candidate keyed to its call (review live10):
      // whether it happened — and the Write add/edit split — is the
      // driver's call, settled by the tool's own result.
      { kind: "file_change", callId: "toolu_1", path: "/tmp/launch/a.txt", write: false },
    ]);
  });

  test("Write is marked for the driver's existsSync; NotebookEdit reads notebook_path; other tools derive nothing", () => {
    const parser = new ClaudeStreamParser();
    const parses = feedOne(parser, {
      type: "assistant",
      session_id: FLOOR_ID,
      message: {
        id: "msg_2",
        content: [
          { type: "tool_use", id: "t1", name: "Write", input: { file_path: "/tmp/new.txt", content: "x" } },
          { type: "tool_use", id: "t2", name: "NotebookEdit", input: { notebook_path: "/tmp/nb.ipynb" } },
          { type: "tool_use", id: "t3", name: "Bash", input: { command: "ls" } },
        ],
      },
    });
    expect(parses).toEqual([
      { kind: "tool_call", callId: "t1", name: "Write", input: { file_path: "/tmp/new.txt", content: "x" } },
      { kind: "file_change", callId: "t1", path: "/tmp/new.txt", write: true },
      { kind: "tool_call", callId: "t2", name: "NotebookEdit", input: { notebook_path: "/tmp/nb.ipynb" } },
      { kind: "file_change", callId: "t2", path: "/tmp/nb.ipynb", write: false },
      { kind: "tool_call", callId: "t3", name: "Bash", input: { command: "ls" } },
    ]);
  });

  test("sibling assistant frames sharing a message id all parse (no dedupe)", () => {
    // The recorded wire sends one content block per assistant frame under
    // a shared message id (zai-permission.ndjson: thinking then tool_use;
    // zai-permission2.ndjson: thinking then text). Dropping every frame
    // after the first per id silently removed tool calls and final
    // answers; usage was never read from these frames to begin with (it
    // comes from the `result` event), so there is nothing to dedupe.
    const parser = new ClaudeStreamParser();
    expect(
      feedOne(parser, {
        type: "assistant",
        session_id: FLOOR_ID,
        message: { id: "msg_shared", content: [{ type: "thinking", thinking: "hmm" }] },
      })
    ).toEqual([{ kind: "unknown" }]);
    expect(
      feedOne(parser, {
        type: "assistant",
        session_id: FLOOR_ID,
        message: { id: "msg_shared", content: [{ type: "text", text: "the answer" }] },
      })
    ).toEqual([{ kind: "assistant_text", text: "the answer" }]);
    expect(
      feedOne(parser, {
        type: "assistant",
        session_id: FLOOR_ID,
        message: { id: "msg_shared", content: [{ type: "text", text: "twice" }] },
      })
    ).toEqual([{ kind: "assistant_text", text: "twice" }]);
  });

  test("tool_result parses from the user frame; the replay echo is unknown", () => {
    const parser = new ClaudeStreamParser();
    expect(
      feedOne(parser, {
        type: "user",
        session_id: FLOOR_ID,
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "done", is_error: true }],
        },
      })
    ).toEqual([{ kind: "tool_result", callId: "toolu_1", output: "done", isError: true }]);
    expect(
      feedOne(parser, {
        type: "user",
        session_id: FLOOR_ID,
        isReplay: true,
        message: { role: "user", content: [{ type: "text", text: "echoed" }] },
      })
    ).toEqual([{ kind: "unknown" }]);
  });

  test("text deltas parse; other stream_event variants pass through unknown", () => {
    const parser = new ClaudeStreamParser();
    expect(
      feedOne(parser, {
        type: "stream_event",
        session_id: FLOOR_ID,
        event: { type: "content_block_delta", delta: { type: "text_delta", text: "abc" } },
      })
    ).toEqual([{ kind: "assistant_delta", text: "abc" }]);
    // Review live15: an empty text_delta is never silently dropped — it
    // mirrors as tier-1 unknown (the codex parser's delta rule).
    expect(
      feedOne(parser, {
        type: "stream_event",
        session_id: FLOOR_ID,
        event: { type: "content_block_delta", delta: { type: "text_delta", text: "" } },
      })
    ).toEqual([{ kind: "unknown" }]);
    expect(
      feedOne(parser, { type: "stream_event", session_id: FLOOR_ID, event: { type: "message_stop" } })
    ).toEqual([{ kind: "unknown" }]);
    expect(
      feedOne(parser, {
        type: "stream_event",
        session_id: FLOOR_ID,
        event: { type: "content_block_delta", delta: { type: "input_json_delta", partial_json: "{" } },
      })
    ).toEqual([{ kind: "unknown" }]);
  });

  test("results report the raw error bit; the interrupt verdict is the driver's", () => {
    // Review live12: the parser no longer folds the driver's interrupt
    // state into the finish — an error result is interrupted only when
    // codemux knows an interrupt was outstanding, which the line cannot
    // know. The parser reports the wire's error bit and subtype; the
    // driver pairs them with its own state (the e2e race regression).
    const parser = new ClaudeStreamParser();
    const ok = feedOne(parser, {
      type: "result",
      session_id: FLOOR_ID,
      subtype: "success",
      is_error: false,
      usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 2, cache_creation_input_tokens: 1 },
      total_cost_usd: 0.01,
    })[0] as Record<string, unknown>;
    expect(ok["kind"]).toBe("turn_completed");
    expect(ok["isError"]).toBe(false);
    expect(ok["usage"]).toEqual({
      input_tokens: 10,
      output_tokens: 5,
      cached_input_tokens: 3,
      total_tokens: 18,
      cost_usd: 0.01,
    });

    const parser2 = new ClaudeStreamParser();
    const failed = parser2.feed(
      JSON.stringify({ type: "result", session_id: FLOOR_ID, subtype: "error_during_execution", is_error: true }),
      { expectedSessionId: FLOOR_ID }
    )[0] as Record<string, unknown>;
    expect(failed["isError"]).toBe(true);
    expect(failed["reason"]).toBe("error_during_execution");

    // The subtype alone carries the error when is_error is absent: the
    // raw bit covers both spellings the wire uses (fixture probes).
    const parser3 = new ClaudeStreamParser();
    const subtypeOnly = parser3.feed(
      JSON.stringify({ type: "result", session_id: FLOOR_ID, subtype: "error_tool_use_too_long" }),
      { expectedSessionId: FLOOR_ID }
    )[0] as Record<string, unknown>;
    expect(subtypeOnly["isError"]).toBe(true);
    expect(subtypeOnly["reason"]).toBe("error_tool_use_too_long");
  });

  test("can_use_tool parses; an unreadable payload is answered, not passed through", () => {
    const parser = new ClaudeStreamParser();
    expect(
      feedOne(parser, {
        type: "control_request",
        request_id: "req_9",
        request: { subtype: "can_use_tool", tool_name: "Bash", input: { command: "echo hi" } },
      })
    ).toEqual([
      { kind: "permission_request", requestId: "req_9", tool: "Bash", input: { command: "echo hi" } },
    ]);
    // A can_use_tool whose payload cannot be read (no input object): the
    // driver must answer deny keyed by request_id, so the parse names it.
    expect(
      feedOne(parser, {
        type: "control_request",
        request_id: "req_10",
        request: { subtype: "can_use_tool", tool_name: "Bash" },
      })
    ).toEqual([{ kind: "unparseable_permission", requestId: "req_10" }]);
    // Without a request_id there is nothing to key an answer on: the
    // driver reports it unanswerable (review live18).
    expect(
      feedOne(parser, {
        type: "control_request",
        request: { subtype: "can_use_tool", tool_name: "Bash", input: {} },
      })
    ).toEqual([{ kind: "unsupported_control_request", requestId: null, subtype: "can_use_tool" }]);
    // Any other subtype waits on an answer harness-side: the parse names
    // it so the driver can answer with an error (review live18).
    expect(
      feedOne(parser, {
        type: "control_request",
        request_id: "req_11",
        request: { subtype: "hook_callback", callback_id: "h" },
      })
    ).toEqual([{ kind: "unsupported_control_request", requestId: "req_11", subtype: "hook_callback" }]);
    expect(
      feedOne(parser, { type: "control_response", response: { request_id: "x" } })
    ).toEqual([{ kind: "unknown" }]);
  });

  test("unmapped system subtypes and unknown types are unknown", () => {
    const parser = new ClaudeStreamParser();
    expect(feedOne(parser, { type: "system", session_id: FLOOR_ID, subtype: "status" })).toEqual([{ kind: "unknown" }]);
    expect(feedOne(parser, { type: "totally-new", payload: 1 })).toEqual([{ kind: "unknown" }]);
  });

  test("a stamped frame without a session id is a grammar error, never an accepted event", () => {
    // Review live15: the id check ran only when `session_id` was a string,
    // so a `result` with a missing or null id closed the open turn. The
    // recorded wire stamps every system/assistant/user/stream_event/result
    // frame with the id, so its absence on one of those types is drift —
    // tier-2, fail-closed — while control frames (never stamped on the
    // wire) and unknown types keep passing through.
    const parser = new ClaudeStreamParser();
    const missing = feedOne(parser, {
      type: "result",
      subtype: "success",
      usage: { input_tokens: 1, output_tokens: 1 },
    })[0] as { kind: string; message: string };
    expect(missing.kind).toBe("grammar_error");
    expect(missing.message).toContain("carries no session id");
    const nullId = feedOne(parser, { type: "assistant", session_id: null, message: { id: "m", content: [] } })[0] as {
      kind: string;
    };
    expect(nullId.kind).toBe("grammar_error");
    // The unstamped wire shapes stay legal.
    expect(
      feedOne(parser, { type: "control_response", response: { request_id: "x" } })
    ).toEqual([{ kind: "unknown" }]);
  });

  test("non-JSON and non-object lines are tier-3 unusable, with a bounded excerpt", () => {
    const parser = new ClaudeStreamParser();
    // Regression: these were tier-1 unknown, letting garbage stream on.
    expect(parser.feed("not json", { expectedSessionId: FLOOR_ID })).toEqual([
      { kind: "unusable", excerpt: "not json", bytes: 8 },
    ]);
    expect(parser.feed("[1,2]", { expectedSessionId: FLOOR_ID })).toEqual([
      { kind: "unusable", excerpt: "[1,2]", bytes: 5 },
    ]);
    const long = `${"x".repeat(5000)} not json`;
    const parse = parser.feed(long, {
      expectedSessionId: FLOOR_ID,
    })[0] as { kind: string; excerpt: string; bytes: number };
    expect(parse.kind).toBe("unusable");
    expect(parse.excerpt.length).toBe(4096);
    expect(parse.bytes).toBe(5009);
  });
});

describe("review live23", () => {
  test("the tier-3 excerpt is 4 KiB of bytes in every parser, not 4096 characters", () => {
    // Contracts minor 7: the parsers cut `line.slice(0, 4096)`, so a
    // multibyte line carried up to 16 KiB against the documented bound,
    // while the process layer cut bytes.
    const line = `${"é".repeat(3000)} not json`;
    const encoder = new TextEncoder();
    const claude = new ClaudeStreamParser().feed(line, { expectedSessionId: FLOOR_ID })[0] as {
      kind: string;
      excerpt: string;
      bytes: number;
    };
    const codex = new CodexStreamParser().feed(line, { threadId: null, activeTurnId: null })[0] as {
      kind: string;
      excerpt: string;
      bytes: number;
    };
    const agy = parseAgySessionLine(line, { knownConversationId: null }) as {
      kind: string;
      excerpt: string;
      bytes: number;
    };
    for (const parse of [claude, codex, agy]) {
      expect(parse.kind).toBe("unusable");
      expect(parse.bytes).toBe(6009);
      expect(encoder.encode(parse.excerpt).byteLength).toBeLessThanOrEqual(4096);
      expect(parse.excerpt.startsWith("é".repeat(2048))).toBe(true);
    }
  });
});
