import { describe, expect, test } from "bun:test";
import {
  applyAuthorPrefix,
  buildEvent,
  buildInputAck,
  buildPermissionResolved,
  buildUnknownEvent,
  buildUserMessage,
  MAX_AUTHOR_CODEPOINTS,
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
    const echo = JSON.parse(buildUserMessage(5, "s", 2, "hi", "ops", null));
    expect(echo.type).toBe("user_message");
    expect(echo.author).toBe("ops");
    expect(echo.turn_id).toBeUndefined();
    const resolved = JSON.parse(buildPermissionResolved(6, "s", "r1", "superseded"));
    expect(resolved.resolution).toBe("superseded");
    expect(resolved.request_id).toBe("r1");
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
