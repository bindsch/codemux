import { describe, expect, test } from "bun:test";
import { MAX_ID_CHARS, MAX_REQUEST_ID_CHARS,
  applyAuthorPrefix,
  buildEvent,
  buildInputAck,
  buildPermissionDenied,
  buildPermissionResolved,
  buildUnknownEvent,
  buildUserMessage,
  MAX_AUTHOR_CODEPOINTS,
  MAX_DECISION_MESSAGE_UNITS,
  MAX_INPUT_TEXT_BYTES,
  parseInputLine,
  validateAuthor,
  type InputContext,
  type SessionCapabilities,
} from "../src/session/protocol.js";
import { SessionFsm } from "../src/session/fsm.js";

const ALL_CAPS: SessionCapabilities = {
  live_input: true,
  user_during_turn: "queue",
  steer: true,
  interrupt: true,
  permissions: true,
  deltas: true,
  file_changes: "native",
  usage_stream: true,
  resume: true,
};

function context(overrides: Partial<InputContext> = {}): InputContext {
  return {
    capabilities: ALL_CAPS,
    hasActiveTurn: false,
    pendingRequestIds: new Set<string>(),
    shuttingDown: false,
    ...overrides,
  };
}

describe("author validation", () => {
  test("accepts plain handles and names up to 64 code points", () => {
    expect(validateAuthor("ana")).toBe(true);
    expect(validateAuthor("Ana B.")).toBe(true);
    expect(validateAuthor("é")).toBe(true);
    expect(validateAuthor("a".repeat(MAX_AUTHOR_CODEPOINTS))).toBe(true);
    // Emoji count as single code points, not surrogate pairs.
    expect(validateAuthor("🦀".repeat(MAX_AUTHOR_CODEPOINTS))).toBe(true);
  });

  test("rejects bounds, brackets, control/format/line categories, lone surrogates", () => {
    expect(validateAuthor("")).toBe(false);
    expect(validateAuthor("a".repeat(MAX_AUTHOR_CODEPOINTS + 1))).toBe(false);
    expect(validateAuthor("a[b")).toBe(false);
    expect(validateAuthor("a]b")).toBe(false);
    expect(validateAuthor("a\nb")).toBe(false); // Cc
    expect(validateAuthor("a\u0000b")).toBe(false); // Cc
    expect(validateAuthor("a\u202eb")).toBe(false); // U+202E Cf (bidi override)
    expect(validateAuthor("a\u2028b")).toBe(false); // Zl
    expect(validateAuthor("a\u2029b")).toBe(false); // Zp
    expect(validateAuthor("a\x7fb")).toBe(false); // DEL is Cc
    // A lone surrogate (the start of a pair, alone).
    expect(validateAuthor("a\uD800b")).toBe(false);
  });
});

describe("input parsing", () => {
  test("parses each message type and rejects unknown types and fields", () => {
    expect(parseInputLine('{"type":"user","text":"hi"}', context())).toEqual({
      ok: true,
      message: { type: "user", text: "hi" },
    });
    expect(parseInputLine('{"type":"user","text":"hi","author":"a"}', context())).toEqual({
      ok: true,
      message: { type: "user", text: "hi", author: "a" },
    });
    expect(parseInputLine('{"type":"shutdown"}', context())).toEqual({
      ok: true,
      message: { type: "shutdown" },
    });
    expect(parseInputLine('{"type":"nope","text":"hi"}', context())).toEqual({
      ok: false,
      reason: "unknown_type",
    });
    expect(parseInputLine('{"type":"user","text":"hi","extra":1}', context())).toEqual({
      ok: false,
      reason: "malformed",
    });
    expect(parseInputLine('{"type":"shutdown","x":1}', context())).toEqual({
      ok: false,
      reason: "malformed",
    });
    expect(parseInputLine("not json", context())).toEqual({ ok: false, reason: "malformed" });
    expect(parseInputLine("[]", context())).toEqual({ ok: false, reason: "malformed" });
    expect(parseInputLine('{"text":"no type"}', context())).toEqual({
      ok: false,
      reason: "malformed",
    });
  });

  test("text bounds and NUL", () => {
    const ok = "a".repeat(MAX_INPUT_TEXT_BYTES);
    const big = "a".repeat(MAX_INPUT_TEXT_BYTES + 1);
    expect(parseInputLine(JSON.stringify({ type: "user", text: ok }), context()).ok).toBe(true);
    expect(
      parseInputLine(JSON.stringify({ type: "user", text: big }), context())
    ).toEqual({ ok: false, reason: "text_too_long" });
    expect(
      parseInputLine(JSON.stringify({ type: "user", text: "a\0b" }), context())
    ).toEqual({ ok: false, reason: "text_nul" });
    expect(parseInputLine('{"type":"user","text":42}', context())).toEqual({
      ok: false,
      reason: "malformed",
    });
  });

  test("bad author is rejected before anything else about the text matters", () => {
    expect(
      parseInputLine('{"type":"user","text":"hi","author":"x]\\ny"}', context())
    ).toEqual({ ok: false, reason: "invalid_author" });
  });

  test("capability-false inputs are rejected, never ignored", () => {
    const noSteer = context({
      capabilities: { ...ALL_CAPS, steer: false },
      hasActiveTurn: true,
    });
    expect(parseInputLine('{"type":"steer","text":"x"}', noSteer)).toEqual({
      ok: false,
      reason: "unsupported",
    });
    const noInterrupt = context({ capabilities: { ...ALL_CAPS, interrupt: false } });
    expect(parseInputLine('{"type":"interrupt"}', noInterrupt)).toEqual({
      ok: false,
      reason: "unsupported",
    });
    const noMidturn = context({
      capabilities: { ...ALL_CAPS, user_during_turn: false },
      hasActiveTurn: true,
    });
    expect(parseInputLine('{"type":"user","text":"x"}', noMidturn)).toEqual({
      ok: false,
      reason: "busy",
    });
    // The same message is fine when no turn runs.
    expect(parseInputLine('{"type":"user","text":"x"}', {
      ...noMidturn,
      hasActiveTurn: false,
    }).ok).toBe(true);
  });

  test("steer without an active turn is rejected; interrupt without one is a no-op ack", () => {
    expect(parseInputLine('{"type":"steer","text":"x"}', context())).toEqual({
      ok: false,
      reason: "no_active_turn",
    });
    expect(parseInputLine('{"type":"interrupt"}', context()).ok).toBe(true);
    expect(
      parseInputLine('{"type":"interrupt","reason":"user asked"}', context()).ok
    ).toBe(true);
  });

  test("permission_decision: pending-set membership, decision shape, updated_input", () => {
    const ctx = context({ pendingRequestIds: new Set(["req-1"]) });
    expect(
      parseInputLine('{"type":"permission_decision","request_id":"req-1","decision":"deny"}', ctx)
    ).toEqual({ ok: true, message: { type: "permission_decision", request_id: "req-1", decision: "deny" } });
    // A request_id is the harness id's JSON spelling, so the longest valid
    // one is a MAX_ID_CHARS id with every character escaped, plus quotes
    // (review round 74); one more character is malformed.
    const longest = `"${"\\u0041".repeat(MAX_ID_CHARS)}"`;
    expect(longest).toHaveLength(MAX_REQUEST_ID_CHARS);
    const longCtx = context({ pendingRequestIds: new Set([longest]) });
    expect(parseInputLine(JSON.stringify({ type: "permission_decision", request_id: longest, decision: "deny" }), longCtx).ok).toBe(true);
    expect(parseInputLine(JSON.stringify({ type: "permission_decision", request_id: `${longest}x`, decision: "deny" }), longCtx))
      .toEqual({ ok: false, reason: "malformed" });
    expect(
      parseInputLine('{"type":"permission_decision","request_id":"req-2","decision":"allow"}', ctx)
    ).toEqual({ ok: false, reason: "unknown_request" });
    expect(
      parseInputLine('{"type":"permission_decision","request_id":"req-1","decision":"maybe"}', ctx)
    ).toEqual({ ok: false, reason: "malformed" });
    const withUpdate = parseInputLine(
      '{"type":"permission_decision","request_id":"req-1","decision":"allow","updated_input":{"file_path":"/tmp/x"}}',
      ctx
    );
    expect(withUpdate.ok).toBe(true);
    if (withUpdate.ok) {
      expect(withUpdate.message.type).toBe("permission_decision");
    }
    expect(
      parseInputLine('{"type":"permission_decision","request_id":"req-1","decision":"allow","updated_input":[]}', ctx)
    ).toEqual({ ok: false, reason: "malformed" });
  });

  test("permission_decision message: deny-only, bounded, no NUL, no controls but newline", () => {
    const ctx = context({ pendingRequestIds: new Set(["req-1"]) });
    expect(
      parseInputLine(
        '{"type":"permission_decision","request_id":"req-1","decision":"deny","message":"Not now."}',
        ctx
      )
    ).toEqual({
      ok: true,
      message: {
        type: "permission_decision",
        request_id: "req-1",
        decision: "deny",
        message: "Not now.",
      },
    });
    // Newline is the one control character a denial text may carry.
    expect(
      parseInputLine(
        JSON.stringify({
          type: "permission_decision",
          request_id: "req-1",
          decision: "deny",
          message: "line one\nline two",
        }),
        ctx
      ).ok
    ).toBe(true);
    // With an allow it is rejected the way an unknown key is.
    expect(
      parseInputLine(
        '{"type":"permission_decision","request_id":"req-1","decision":"allow","message":"x"}',
        ctx
      )
    ).toEqual({ ok: false, reason: "malformed" });
    // Empty, over the bound, NUL, and every other control character
    // (CR, TAB, DEL, NEL) are rejections too.
    for (const bad of [
      "",
      "x".repeat(MAX_DECISION_MESSAGE_UNITS + 1),
      "a\0b",
      "a\rb",
      "a\tb",
      "a\x7fb",
      "a\u0085b",
    ]) {
      expect(
        parseInputLine(
          JSON.stringify({
            type: "permission_decision",
            request_id: "req-1",
            decision: "deny",
            message: bad,
          }),
          ctx
        )
      ).toEqual({ ok: false, reason: "malformed" });
    }
    expect(
      parseInputLine(
        JSON.stringify({
          type: "permission_decision",
          request_id: "req-1",
          decision: "deny",
          message: "x".repeat(MAX_DECISION_MESSAGE_UNITS),
        }),
        ctx
      ).ok
    ).toBe(true);
    expect(
      parseInputLine(
        '{"type":"permission_decision","request_id":"req-1","decision":"deny","message":5}',
        ctx
      )
    ).toEqual({ ok: false, reason: "malformed" });
  });

  test.each([
    { decision: "allow" },
    { decision: "deny" },
    { decision: "allow", updated_input: { file_path: "workspace/file.txt", values: [1, 2] } },
    { decision: "deny", updated_input: { command: "echo safe" }, message: "Not now.\nTry later." },
  ])("permission_response normalizes to permission_decision and preserves fields: %j", (fields) => {
    const ctx = context({ pendingRequestIds: new Set(["req-1"]) });
    const input = { type: "permission_response", request_id: "req-1", ...fields };
    expect(parseInputLine(JSON.stringify(input), ctx)).toEqual({
      ok: true,
      message: { ...input, type: "permission_decision" },
    });
  });

  test.each([
    ["an unknown field", { extra: true }],
    ["a missing request ID", { request_id: undefined }],
    ["an empty request ID", { request_id: "" }],
    ["a numeric request ID", { request_id: 1 }],
    ["a NUL in the request ID", { request_id: "req-\0" }],
    ["an oversized request ID", { request_id: "r".repeat(MAX_REQUEST_ID_CHARS + 1) }],
    ["a missing decision", { decision: undefined }],
    ["an unknown decision", { decision: "accept" }],
    ["a null update", { updated_input: null }],
    ["an array update", { updated_input: [] }],
    ["a string update", { updated_input: "file.txt" }],
    ["a message on allow", { decision: "allow", message: "No." }],
    ["an empty denial message", { message: "" }],
    ["a non-string denial message", { message: 1 }],
    ["a control in the denial message", { message: "Not\tnow." }],
    ["an oversized denial message", { message: "x".repeat(MAX_DECISION_MESSAGE_UNITS + 1) }],
  ] as const)("permission_response rejects %s", (_label, fields) => {
    const ctx = context({ pendingRequestIds: new Set(["req-1"]) });
    expect(parseInputLine(JSON.stringify({
      type: "permission_response", request_id: "req-1", decision: "deny", ...fields,
    }), ctx)).toEqual({ ok: false, reason: "malformed" });
  });

  test("permission_response retains capability, pending-request, and shutdown checks", () => {
    const input = JSON.stringify({ type: "permission_response", request_id: "req-1", decision: "allow" });
    expect(parseInputLine(input, context())).toEqual({ ok: false, reason: "unknown_request" });
    expect(parseInputLine(input, context({
      capabilities: { ...ALL_CAPS, permissions: false },
      pendingRequestIds: new Set(["req-1"]),
    }))).toEqual({ ok: false, reason: "unsupported" });
    expect(parseInputLine(input, context({
      pendingRequestIds: new Set(["req-1"]), shuttingDown: true,
    }))).toEqual({ ok: false, reason: "shutting_down" });
  });

  test("everything but a second shutdown is rejected once shutting down", () => {
    const ctx = context({ shuttingDown: true });
    expect(parseInputLine('{"type":"user","text":"x"}', ctx)).toEqual({
      ok: false,
      reason: "shutting_down",
    });
    expect(parseInputLine('{"type":"shutdown"}', ctx).ok).toBe(true);
  });
});

describe("author prefix", () => {
  test("prefixes when enabled and present; otherwise verbatim", () => {
    expect(applyAuthorPrefix("hi", "ops", true)).toBe("[ops] hi");
    expect(applyAuthorPrefix("hi", "ops", false)).toBe("hi");
    expect(applyAuthorPrefix("hi", undefined, true)).toBe("hi");
  });
});

describe("event envelope", () => {
  test("fixed key order with raw null on codemux-originated events", () => {
    const line = buildEvent(7, "sess", "turn_started", null, { turn_id: "t1" });
    const keys = Object.keys(JSON.parse(line));
    expect(keys).toEqual(["seq", "ts", "session_id", "type", "raw", "turn_id"]);
    expect(JSON.parse(line).seq).toBe(7);
    expect(JSON.parse(line).raw).toBeNull();
  });

  test("raw carries the harness line verbatim on mirrored events", () => {
    const raw = '{"event":"result","result":{"x":1}}';
    const line = buildUnknownEvent(3, "sess", raw);
    const parsed = JSON.parse(line);
    expect(parsed.type).toBe("unknown");
    expect(parsed.raw).toBe(raw);
  });

  test("input acks, user_message echo, permission_resolved shapes", () => {
    expect(JSON.parse(buildInputAck(1, "s", 2, true))).toEqual({
      seq: 1, ts: expect.any(String), session_id: "s", type: "input_accepted", raw: null, input_seq: 2,
    });
    expect(JSON.parse(buildInputAck(1, "s", 2, false, "busy")).reason).toBe("busy");
    expect(JSON.parse(buildInputAck(1, "s", 2, false, "busy")).message).toBeUndefined();
    // The autonomy_escalation rejection names the text the harness got.
    expect(JSON.parse(buildInputAck(1, "s", 2, false, "autonomy_escalation", "denied")).message).toBe("denied");
    const echo = JSON.parse(buildUserMessage(5, "s", 2, "hi", "ops", null));
    expect(echo.type).toBe("user_message");
    expect(echo.author).toBe("ops");
    expect(echo.turn_id).toBeUndefined();
    const resolved = JSON.parse(buildPermissionResolved(6, "s", "r1", "superseded", "denied"));
    expect(resolved.resolution).toBe("superseded");
    expect(resolved.request_id).toBe("r1");
    expect(resolved.message).toBe("denied");
    expect(JSON.parse(buildPermissionResolved(7, "s", "r2", "allow")).message).toBeUndefined();
    const deniedRecord = JSON.parse(buildPermissionDenied(8, "s", "r3", "Bash", "denied"));
    expect(deniedRecord.type).toBe("permission_denied");
    expect(deniedRecord.tool).toBe("Bash");
    expect(deniedRecord.message).toBe("denied");
  });
});

describe("session fsm", () => {
  test("the legal lifecycle path", () => {
    const fsm = new SessionFsm();
    expect(fsm.state).toBe("starting");
    expect(fsm.transition({ kind: "session_started" })).toBeNull();
    expect(fsm.transition({ kind: "turn_started", turnId: "t1" })).toBeNull();
    expect(fsm.state).toBe("turn_active");
    expect(fsm.activeTurn).toBe("t1");
    expect(fsm.transition({ kind: "turn_completed", turnId: "t1" })).toBeNull();
    expect(fsm.state).toBe("idle");
    expect(fsm.transition({ kind: "shutdown_started" })).toBeNull();
    expect(fsm.state).toBe("shutting_down");
    expect(fsm.transition({ kind: "ended" })).toBeNull();
    expect(fsm.state).toBe("ended");
  });

  test("grammar violations return errors instead of throwing", () => {
    const fsm = new SessionFsm();
    expect(fsm.transition({ kind: "turn_started", turnId: "t1" })?.message).toContain("turn_started in state starting");
    fsm.transition({ kind: "session_started" });
    expect(fsm.transition({ kind: "session_started" })?.message).toBe("second session_started");
    expect(fsm.transition({ kind: "turn_completed", turnId: "t1" })?.message).toContain("no open turn");
    fsm.transition({ kind: "turn_started", turnId: "t1" });
    expect(fsm.transition({ kind: "turn_started", turnId: "t2" })?.message).toContain("while turn t1 is active");
    expect(fsm.transition({ kind: "turn_completed", turnId: "t2" })?.message).toContain("the open turn is t1");
    expect(fsm.transition({ kind: "ended" })).toBeNull();
    expect(fsm.transition({ kind: "shutdown_started" })?.message).toContain("after the session ended");
  });

  test("shutdown_started and ended are idempotent; ended clears the turn", () => {
    const fsm = new SessionFsm();
    fsm.transition({ kind: "session_started" });
    fsm.transition({ kind: "turn_started", turnId: "t1" });
    expect(fsm.transition({ kind: "shutdown_started" })).toBeNull();
    expect(fsm.activeTurn).toBeNull();
    expect(fsm.transition({ kind: "shutdown_started" })).toBeNull();
    expect(fsm.transition({ kind: "ended" })).toBeNull();
    expect(fsm.transition({ kind: "ended" })).toBeNull();
  });

  test("pending requests are a set with supersede-all", () => {
    const fsm = new SessionFsm();
    fsm.transition({ kind: "session_started" });
    expect(fsm.addPending("r1")).toBeNull();
    expect(fsm.addPending("r1")?.message).toContain("duplicate");
    expect(fsm.addPending("r2")).toBeNull();
    expect(fsm.isPending("r1")).toBe(true);
    expect(fsm.pendingIds.sort()).toEqual(["r1", "r2"]);
    expect(fsm.removePending("r1")).toBeNull();
    expect(fsm.removePending("r1")?.message).toContain("not pending");
    expect(fsm.supersedePending()).toEqual(["r2"]);
    expect(fsm.supersedePending()).toEqual([]);
  });

  test("input_seq is monotonic from one", () => {
    const fsm = new SessionFsm();
    expect(fsm.nextInputSeq()).toBe(1);
    expect(fsm.nextInputSeq()).toBe(2);
    expect(fsm.nextInputSeq()).toBe(3);
  });
});
