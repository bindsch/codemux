/**
 * Unit tests for the codex app-server session wiring (design §4.7): the
 * spawn command, the capability flags, the sandbox/approval policy pair,
 * the request builders and their method allowlist, the parser's three
 * tiers (including the raw-newline rejoin and its bounds), the usage
 * normalization, and the approval ceiling. The driver round-trips are
 * covered by tests/session-codex-e2e.test.ts; these pin the wire shapes
 * the fixture (tests/fixtures/live/codex-app-server.ndjson, codex
 * 0.159.3) recorded.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CODEX_APPROVAL_METHODS,
  CODEX_SESSION_METHODS,
  CODEX_THREAD_ID_PATTERN,
  buildInitializeRequest,
  buildInitializedNotification,
  buildInterruptRequest,
  buildJsonRpcErrorResponse,
  buildJsonRpcResponse,
  buildSteerRequest,
  buildThreadResumeRequest,
  buildThreadStartRequest,
  buildTurnStartRequest,
  buildCodexSessionCommand,
  codexApprovalCeiling,
  codexSessionCapabilities,
  codexSessionPolicy,
  normalizeCodexTokenUsage,
  pickApprovalDecision,
  CodexStreamParser,
} from "../src/session/codex-session.js";

// The ceiling resolves realpaths, so its scope checks need a real
// directory (macOS /tmp is a symlink to /private/tmp).
const CWD = mkdtempSync(join(tmpdir(), "codemux-codex-wire-"));

function parseJson(line: string): Record<string, any> {
  return JSON.parse(line) as Record<string, any>;
}

describe("codex session - spawn and capabilities", () => {
  test("the spawn command is one dedicated app-server per session", () => {
    expect(buildCodexSessionCommand()).toEqual(["codex", "app-server"]);
  });

  test("every capability flag is true with queue semantics and native file changes", () => {
    expect(codexSessionCapabilities()).toEqual({
      live_input: true,
      user_during_turn: "queue",
      steer: true,
      interrupt: true,
      permissions: true,
      deltas: true,
      file_changes: "native",
      usage_stream: true,
      resume: true,
    });
  });

  test("the thread id pattern accepts the fixture's ids and refuses junk", () => {
    expect(CODEX_THREAD_ID_PATTERN.test("01a10908-0ebc-7aa0-874d-a59a38843101")).toBe(true);
    expect(CODEX_THREAD_ID_PATTERN.test("0123456789abcdef")).toBe(true);
    expect(CODEX_THREAD_ID_PATTERN.test("short")).toBe(false);
    expect(CODEX_THREAD_ID_PATTERN.test("has spaces in it")).toBe(false);
    expect(CODEX_THREAD_ID_PATTERN.test("")).toBe(false);
  });
});

describe("codex session - policy pair", () => {
  test("a sandboxed session passes the bypass pair at every level", () => {
    for (const level of ["read-only", "low", "medium", "high"] as const) {
      expect(codexSessionPolicy(level, true, CWD)).toEqual({
        sandbox: "danger-full-access",
        approvalPolicy: "never",
        sandboxPolicy: { type: "dangerFullAccess" },
      });
    }
  });

  test("an unsandboxed session mirrors the adapter's mapAutonomy mapping", () => {
    expect(codexSessionPolicy("read-only", false, CWD)).toEqual({
      sandbox: "read-only",
      approvalPolicy: "never",
      sandboxPolicy: { type: "readOnly", networkAccess: false },
    });
    expect(codexSessionPolicy("low", false, CWD)).toEqual({
      sandbox: "workspace-write",
      approvalPolicy: "untrusted",
      sandboxPolicy: {
        type: "workspaceWrite",
        writableRoots: [CWD],
        networkAccess: false,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      },
    });
    const medium = codexSessionPolicy("medium", false, CWD);
    expect(medium.sandbox).toBe("workspace-write");
    expect(medium.approvalPolicy).toBe("never");
    expect(medium.sandboxPolicy).toEqual({
      type: "workspaceWrite",
      writableRoots: [CWD],
      networkAccess: false,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
    });
    expect(codexSessionPolicy("high", false, CWD)).toEqual({
      sandbox: "danger-full-access",
      approvalPolicy: "never",
      sandboxPolicy: { type: "dangerFullAccess" },
    });
  });
});

describe("codex session - method allowlist and builders", () => {
  test("the allowlist is exactly the seven verified methods", () => {
    expect([...CODEX_SESSION_METHODS]).toEqual([
      "initialize",
      "notifications/initialized",
      "thread/start",
      "thread/resume",
      "turn/start",
      "turn/steer",
      "turn/interrupt",
    ]);
  });

  test("every builder emits a request that carries jsonrpc and an allowlisted method", () => {
    const policy = codexSessionPolicy("medium", false, CWD);
    const lines = [
      buildInitializeRequest(1),
      buildThreadStartRequest(2, policy, CWD),
      buildThreadResumeRequest(3, "0123456789abcdef", policy, CWD),
      buildTurnStartRequest(4, "0123456789abcdef", "hello", policy),
      buildSteerRequest(5, "0123456789abcdef", "turn-1", ["a", "b"]),
      buildInterruptRequest(6, "0123456789abcdef", "turn-1"),
    ];
    for (const line of lines) {
      const frame = parseJson(line);
      expect(frame.jsonrpc).toBe("2.0");
      expect((CODEX_SESSION_METHODS as readonly string[]).includes(frame.method)).toBe(true);
      expect(typeof frame.id).not.toBe("undefined");
    }
  });

  test("the initialized notification has no id and carries jsonrpc", () => {
    const frame = parseJson(buildInitializedNotification());
    expect(frame).toEqual({ jsonrpc: "2.0", method: "notifications/initialized" });
  });

  test("responses omit jsonrpc, matching the server's own frames", () => {
    expect(parseJson(buildJsonRpcResponse("appr-1", { decision: "decline" }))).toEqual({
      id: "appr-1",
      result: { decision: "decline" },
    });
    expect(
      parseJson(buildJsonRpcErrorResponse(7, -32601, "codemux does not implement fs/readFileText"))
    ).toEqual({ id: 7, error: { code: -32601, message: "codemux does not implement fs/readFileText" } });
  });

  test("thread/start carries cwd, the policy pair, and exactly the AGENTS.md-skip config", () => {
    // Review live3, security 2: the config object is the project-doc
    // (AGENTS.md) skip and NOTHING else — toEqual pins the exact key set.
    // It is not run's `--ignore-rules` equivalent: execpolicy rules
    // (~/.codex/rules) have no verified app-server carrier, so a codex
    // session still loads them where a run does not (the parity gap is
    // recorded in docs/HARNESS-COMPATIBILITY.md).
    const policy = codexSessionPolicy("low", false, CWD);
    const frame = parseJson(buildThreadStartRequest(2, policy, CWD, "gpt-5"));
    expect(frame.params).toEqual({
      cwd: CWD,
      sandbox: "workspace-write",
      approvalPolicy: "untrusted",
      config: { project_doc_max_bytes: 0, project_doc_fallback_filenames: [] },
      model: "gpt-5",
    });
  });

  test("thread/resume carries the thread id, cwd, the policy pair, and the config; model stays optional", () => {
    // Review live20, contracts 3: design §4.7 says every thread start,
    // thread/resume included, carries the sandbox/approval pair, or the
    // resumed thread falls back to config.toml. toEqual pins the whole
    // params object, so dropping the pair fails here.
    const policy = codexSessionPolicy("low", false, CWD);
    const withModel = parseJson(buildThreadResumeRequest(3, "0123456789abcdef", policy, CWD, "gpt-5"));
    expect(withModel.params).toEqual({
      threadId: "0123456789abcdef",
      cwd: CWD,
      sandbox: "workspace-write",
      approvalPolicy: "untrusted",
      config: { project_doc_max_bytes: 0, project_doc_fallback_filenames: [] },
      model: "gpt-5",
    });
    const withoutModel = parseJson(buildThreadResumeRequest(4, "0123456789abcdef", policy, CWD));
    const { model: _model, ...rest } = withModel.params;
    expect(withoutModel.params).toEqual(rest);
  });

  test("turn/start carries the fixture's input shape, the policy pair, and the effort override", () => {
    const policy = codexSessionPolicy("medium", false, CWD);
    const frame = parseJson(buildTurnStartRequest(5, "0123456789abcdef", "Reply with exactly: one", policy, "high"));
    expect(frame.params).toEqual({
      threadId: "0123456789abcdef",
      input: [{ type: "text", text: "Reply with exactly: one" }],
      approvalPolicy: "never",
      sandboxPolicy: {
        type: "workspaceWrite",
        writableRoots: [CWD],
        networkAccess: false,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      },
      effort: "high",
    });
  });

  test("effort none is dropped, not sent", () => {
    const policy = codexSessionPolicy("high", false, CWD);
    const frame = parseJson(buildTurnStartRequest(5, "0123456789abcdef", "hi", policy, "none"));
    expect("effort" in frame.params).toBe(false);
  });

  test("steer batches texts and carries text_elements the way openclaw's client does", () => {
    const frame = parseJson(buildSteerRequest(6, "0123456789abcdef", "turn-9", ["first", "second"]));
    expect(frame.params).toEqual({
      threadId: "0123456789abcdef",
      expectedTurnId: "turn-9",
      input: [
        { type: "text", text: "first", text_elements: [] },
        { type: "text", text: "second", text_elements: [] },
      ],
    });
  });

  test("interrupt carries both ids", () => {
    const frame = parseJson(buildInterruptRequest(7, "0123456789abcdef", "turn-9"));
    expect(frame.params).toEqual({ threadId: "0123456789abcdef", turnId: "turn-9" });
  });
});

describe("codex session - usage normalization", () => {
  test("both cache reads and writes fold out of the input count", () => {
    expect(
      normalizeCodexTokenUsage({
        inputTokens: 18974,
        cachedInputTokens: 12288,
        cacheWriteInputTokens: 0,
        outputTokens: 5,
      })
    ).toEqual({
      input_tokens: 6686,
      output_tokens: 5,
      cached_input_tokens: 12288,
      total_tokens: 18979,
      cost_usd: null,
    });
    expect(
      normalizeCodexTokenUsage({
        inputTokens: 100,
        cachedInputTokens: 20,
        cacheWriteInputTokens: 5,
        outputTokens: 10,
      })
    ).toEqual({
      input_tokens: 75,
      output_tokens: 10,
      cached_input_tokens: 25,
      total_tokens: 110,
      cost_usd: null,
    });
  });

  test("unreported fields stay null, never guessed", () => {
    expect(normalizeCodexTokenUsage({ outputTokens: 7 })).toEqual({
      input_tokens: null,
      output_tokens: 7,
      cached_input_tokens: null,
      total_tokens: null,
      cost_usd: null,
    });
    expect(normalizeCodexTokenUsage("junk")).toEqual({
      input_tokens: null,
      output_tokens: null,
      cached_input_tokens: null,
      total_tokens: null,
      cost_usd: null,
    });
  });

  test("negative and non-finite counts are unreported", () => {
    expect(
      normalizeCodexTokenUsage({ inputTokens: -5, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 1 })
        .input_tokens
    ).toBe(null);
    expect(
      normalizeCodexTokenUsage({ inputTokens: Number.POSITIVE_INFINITY, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 1 })
        .input_tokens
    ).toBe(null);
  });
});

describe("codex session - approval ceiling", () => {
  const commandInput = { command: "rm -rf /", cwd: CWD };

  test("read-only denies everything", () => {
    expect(codexApprovalCeiling("read-only", "commandExecution", commandInput, CWD).allowable).toBe(false);
    expect(
      codexApprovalCeiling("read-only", "fileChange", { changes: [{ path: join(CWD, "f") }] }, CWD).allowable
    ).toBe(false);
    expect(codexApprovalCeiling("read-only", "permissions", { permissions: {} }, CWD).allowable).toBe(false);
  });

  test("low allows every kind: the caller is the approval", () => {
    expect(codexApprovalCeiling("low", "commandExecution", commandInput, CWD).allowable).toBe(true);
    expect(
      codexApprovalCeiling("low", "fileChange", { changes: [{ path: "/etc/passwd" }] }, CWD).allowable
    ).toBe(true);
    expect(codexApprovalCeiling("low", "permissions", { permissions: { network: true } }, CWD).allowable).toBe(true);
  });

  test("medium denies commands and turn-scoped permissions, allows in-scope patches only", () => {
    expect(codexApprovalCeiling("medium", "commandExecution", commandInput, CWD).allowable).toBe(false);
    expect(
      codexApprovalCeiling("medium", "permissions", { permissions: { network: true } }, CWD).allowable
    ).toBe(false);
    expect(
      codexApprovalCeiling("medium", "fileChange", { changes: [{ path: join(CWD, "f.txt") }] }, CWD).allowable
    ).toBe(true);
    expect(
      codexApprovalCeiling("medium", "fileChange", { changes: [{ path: "/etc/passwd" }] }, CWD).allowable
    ).toBe(false);
  });

  test("high's mapping is full access for commands and patches, still no turn-scoped permissions", () => {
    expect(codexApprovalCeiling("high", "commandExecution", commandInput, CWD).allowable).toBe(true);
    expect(
      codexApprovalCeiling("high", "fileChange", { changes: [{ path: "/etc/passwd" }] }, CWD).allowable
    ).toBe(true);
    expect(
      codexApprovalCeiling("high", "permissions", { permissions: { network: true } }, CWD).allowable
    ).toBe(false);
  });

  test("a patch with no parsable paths denies fail-closed", () => {
    expect(codexApprovalCeiling("medium", "fileChange", {}, CWD).allowable).toBe(false);
    expect(
      codexApprovalCeiling("medium", "fileChange", { changes: "nope" }, CWD).allowable
    ).toBe(false);
    expect(
      codexApprovalCeiling("medium", "fileChange", { changes: [{ diff: "x" }] }, CWD).allowable
    ).toBe(false);
  });

  test("an update's move destination is judged with its source", () => {
    // Review live3, security 3: an update entry that moves a file names
    // its destination in kind.move_path (openclaw's PatchChangeKind) —
    // a move from inside the workspace to outside it is not an in-scope
    // patch, so the destination goes through pathInsideScope too.
    const moveInside = {
      changes: [
        {
          diff: "*** x",
          kind: { type: "update", move_path: join(CWD, "moved", "f.txt") },
          path: join(CWD, "f.txt"),
        },
      ],
    };
    expect(codexApprovalCeiling("medium", "fileChange", moveInside, CWD).allowable).toBe(true);
    const moveOutside = {
      changes: [
        {
          diff: "*** x",
          kind: { type: "update", move_path: "/etc/codemux-outside.txt" },
          path: join(CWD, "f.txt"),
        },
      ],
    };
    const verdict = codexApprovalCeiling("medium", "fileChange", moveOutside, CWD);
    expect(verdict.allowable).toBe(false);
    expect(verdict.reason).toContain("resolves outside the launch directory");
    // null means no move (the ordinary update); a non-string destination
    // is an opaque action — unparsable denies.
    const noMove = { changes: [{ diff: "*** x", kind: { type: "update", move_path: null }, path: join(CWD, "f.txt") }] };
    expect(codexApprovalCeiling("medium", "fileChange", noMove, CWD).allowable).toBe(true);
    const badMove = { changes: [{ diff: "*** x", kind: { type: "update", move_path: 7 }, path: join(CWD, "f.txt") }] };
    expect(codexApprovalCeiling("medium", "fileChange", badMove, CWD).allowable).toBe(false);
  });

  test("the verdict carries a reason every time", () => {
    for (const level of ["read-only", "low", "medium", "high"] as const) {
      for (const kind of ["commandExecution", "fileChange", "permissions"] as const) {
        const verdict = codexApprovalCeiling(level, kind, commandInput, CWD);
        expect(verdict.reason.length).toBeGreaterThan(0);
      }
    }
  });
});

describe("codex session - decision picking", () => {
  test("an absent availableDecisions list means everything is allowed", () => {
    expect(pickApprovalDecision(undefined, "accept")).toBe("accept");
    expect(pickApprovalDecision("not-a-list", "decline")).toBe("decline");
  });

  test("the preferred decision wins when available", () => {
    expect(pickApprovalDecision(["accept", "decline"], "accept")).toBe("accept");
    expect(pickApprovalDecision(["decline", "cancel"], "decline")).toBe("decline");
  });

  test("an unavailable preference falls to the other refusal, never acceptForSession", () => {
    expect(pickApprovalDecision(["decline", "cancel"], "accept")).toBe("decline");
    expect(pickApprovalDecision(["cancel"], "decline")).toBe("cancel");
    expect(pickApprovalDecision(["acceptForSession"], "accept")).toBe("decline");
  });
});

describe("codex session - stream parser", () => {
  const THREAD = "0123456789abcdef";
  const TURN = "turn-fake-1";

  function parser(withTurn = true): { parser: CodexStreamParser; ctx: { threadId: string | null; activeTurnId: string | null } } {
    return {
      parser: new CodexStreamParser(),
      ctx: { threadId: THREAD, activeTurnId: withTurn ? TURN : null },
    };
  }

  function feed(line: Record<string, any>, ctx = parser().ctx, p = parser().parser) {
    return p.feed(JSON.stringify(line), ctx);
  }

  test("responses classify on id-without-method; errors surface their message", () => {
    const { parser: p, ctx } = parser();
    expect(p.feed(JSON.stringify({ id: 3, result: { turn: {} } }), ctx)).toEqual([
      { kind: "response", id: 3, result: { turn: {} } },
    ]);
    expect(p.feed(JSON.stringify({ id: 4, error: { code: -1, message: "nope" } }), ctx)).toEqual([
      { kind: "response_error", id: 4, message: "nope" },
    ]);
  });

  test("a non-object error or a missing result is a failure, never a success (review live16)", () => {
    const { parser: p, ctx } = parser();
    expect(p.feed(JSON.stringify({ id: 7, error: "boom" }), ctx)).toEqual([
      { kind: "response_error", id: 7, message: "the app-server returned a malformed error" },
    ]);
    expect(p.feed(JSON.stringify({ id: 8, error: 42, result: {} }), ctx)).toEqual([
      { kind: "response_error", id: 8, message: "the app-server returned a malformed error" },
    ]);
    expect(p.feed(JSON.stringify({ id: 9 }), ctx)).toEqual([
      { kind: "response_error", id: 9, message: "the response carries neither result nor error" },
    ]);
    // A null error beside a result is the success some servers spell out.
    expect(p.feed(JSON.stringify({ id: 10, error: null, result: {} }), ctx)).toEqual([
      { kind: "response", id: 10, result: {} },
    ]);
  });

  test("a frame with neither id nor method, or a non-scalar id, never classifies as a response", () => {
    const { parser: p, ctx } = parser();
    expect(p.feed(JSON.stringify({ hello: "world" }), ctx)).toEqual([{ kind: "unknown" }]);
    expect(p.feed(JSON.stringify({ id: { nested: true }, result: 1 }), ctx)).toEqual([
      { kind: "grammar_error", message: "a response carries a non-scalar id" },
    ]);
  });

  test("a thread id --resume would refuse is a grammar error (review live16)", () => {
    // Review live16, correctness major: any non-empty id was adopted, and
    // one past the registry's cap made the whole registry corrupt.
    for (const id of ["a".repeat(129), "short", "has space here"]) {
      const { parser: p } = parser();
      expect(
        feed({ method: "thread/started", params: { thread: { id } } }, { threadId: null, activeTurnId: null }, p)
      ).toEqual([{ kind: "grammar_error", message: "thread/started carries an invalid thread id" }]);
    }
  });

  test("thread/started fires exactly once and must match the known thread", () => {
    const { parser: p, ctx } = parser();
    expect(feed({ method: "thread/started", params: { thread: { id: THREAD } } }, ctx, p)).toEqual([
      { kind: "thread_started", threadId: THREAD },
    ]);
    const second = feed({ method: "thread/started", params: { thread: { id: THREAD } } }, ctx, p);
    expect(second[0]!.kind).toBe("grammar_error");
    const fresh = parser();
    const foreign = feed(
      { method: "thread/started", params: { thread: { id: "99999999-other-thread-id" } } },
      fresh.ctx,
      fresh.parser
    );
    expect(foreign[0]!.kind).toBe("grammar_error");
  });

  test("turn lifecycle notifications carry the turn as an object and must match the open turn", () => {
    const { parser: p, ctx } = parser();
    expect(
      feed({ method: "turn/started", params: { threadId: THREAD, turn: { id: TURN, status: "inProgress" } } }, ctx, p)
    ).toEqual([{ kind: "turn_started", threadId: THREAD, turnId: TURN }]);
    expect(
      feed({ method: "turn/completed", params: { threadId: THREAD, turn: { id: TURN, status: "completed" } } }, ctx, p)
        .map((x) => x.kind)
    ).toEqual(["turn_completed"]);
  });

  test("turn lifecycle with no open turn is a grammar error", () => {
    const { parser: p, ctx } = parser(false);
    const started = feed({ method: "turn/started", params: { threadId: THREAD, turn: { id: TURN } } }, ctx, p);
    expect(started[0]!.kind).toBe("grammar_error");
    const completed = feed({ method: "turn/completed", params: { threadId: THREAD, turn: { id: TURN, status: "completed" } } }, ctx, p);
    expect(completed[0]!.kind).toBe("grammar_error");
  });

  test("turn/completed maps statuses; an unreadable one completes the turn failed", () => {
    // Review live15: an unrecognized status (inProgress, or a status a
    // newer server spells differently) used to pass through as unknown,
    // leaving the turn open — queued input never ran and only a timeout
    // or shutdown ended the session. The recognized method names the
    // open turn, so the outcome completes failed with the status named.
    const { parser: p, ctx } = parser();
    const interrupted = feed({ method: "turn/completed", params: { threadId: THREAD, turn: { id: TURN, status: "interrupted" } } }, ctx, p);
    expect(interrupted).toEqual([{ kind: "turn_completed", threadId: THREAD, turnId: TURN, finish: "interrupted", reason: null }]);
    const failed = feed({ method: "turn/completed", params: { threadId: THREAD, turn: { id: TURN, status: "failed", error: { message: "boom" } } } }, ctx, p);
    expect(failed).toEqual([{ kind: "turn_completed", threadId: THREAD, turnId: TURN, finish: "failed", reason: "boom" }]);
    const inProgress = feed({ method: "turn/completed", params: { threadId: THREAD, turn: { id: TURN, status: "inProgress" } } }, ctx, p);
    expect(inProgress).toEqual([
      { kind: "turn_completed", threadId: THREAD, turnId: TURN, finish: "failed", reason: "the turn completed with unrecognized status inProgress" },
    ]);
    const noStatus = feed({ method: "turn/completed", params: { threadId: THREAD, turn: { id: TURN } } }, ctx, p);
    expect(noStatus).toEqual([
      { kind: "turn_completed", threadId: THREAD, turnId: TURN, finish: "failed", reason: "the turn completed with no status" },
    ]);
  });

  test("an event referencing a foreign thread or turn is a grammar error", () => {
    const { parser: p, ctx } = parser();
    const foreignThread = feed({ method: "item/started", params: { threadId: "another-thread-0001", turnId: TURN, item: { type: "userMessage", id: "i1" } } }, ctx, p);
    expect(foreignThread[0]!.kind).toBe("grammar_error");
    const foreignTurn = feed({ method: "item/started", params: { threadId: THREAD, turnId: "turn-fake-9", item: { type: "userMessage", id: "i1" } } }, ctx, p);
    expect(foreignTurn[0]!.kind).toBe("grammar_error");
  });

  test("deltas stream and empty deltas pass through", () => {
    const { parser: p, ctx } = parser();
    expect(
      feed({ method: "item/agentMessage/delta", params: { threadId: THREAD, turnId: TURN, itemId: "m1", delta: "Hel" } }, ctx, p)
    ).toEqual([{ kind: "assistant_delta", threadId: THREAD, turnId: TURN, text: "Hel" }]);
    expect(
      feed({ method: "item/agentMessage/delta", params: { threadId: THREAD, turnId: TURN, itemId: "m1", delta: "" } }, ctx, p)
    ).toEqual([{ kind: "unknown" }]);
  });

  test("a completed final agentMessage is assistant text; commentary is not", () => {
    const { parser: p, ctx } = parser();
    expect(
      feed({ method: "item/completed", params: { threadId: THREAD, turnId: TURN, item: { type: "agentMessage", id: "m1", text: "one", phase: "final_answer" } } }, ctx, p)
    ).toEqual([{ kind: "assistant_text", threadId: THREAD, turnId: TURN, text: "one" }]);
    expect(
      feed({ method: "item/completed", params: { threadId: THREAD, turnId: TURN, item: { type: "agentMessage", id: "m2", text: "thinking", phase: "commentary" } } }, ctx, p)
    ).toEqual([{ kind: "unknown" }]);
  });

  test("userMessage echoes and mcpToolCall-like items pass through as unknown", () => {
    const { parser: p, ctx } = parser();
    expect(
      feed({ method: "item/completed", params: { threadId: THREAD, turnId: TURN, item: { type: "userMessage", id: "u1", content: [] } } }, ctx, p)
    ).toEqual([{ kind: "unknown" }]);
    expect(
      feed({ method: "item/completed", params: { threadId: THREAD, turnId: TURN, item: { type: "mcpToolCall", id: "t1" } } }, ctx, p)
    ).toEqual([{ kind: "unknown" }]);
  });

  test("commandExecution items map to a tool call and result", () => {
    const { parser: p, ctx } = parser();
    expect(
      feed({ method: "item/started", params: { threadId: THREAD, turnId: TURN, item: { type: "commandExecution", id: "cmd-1", command: "echo hi", cwd: CWD } } }, ctx, p)
    ).toEqual([{ kind: "tool_call", threadId: THREAD, turnId: TURN, callId: "cmd-1", input: { command: "echo hi", cwd: CWD } }]);
    expect(
      feed({ method: "item/completed", params: { threadId: THREAD, turnId: TURN, item: { type: "commandExecution", id: "cmd-1", status: "completed", aggregatedOutput: "hi\n", exitCode: 0 } } }, ctx, p)
    ).toEqual([{ kind: "tool_result", threadId: THREAD, turnId: TURN, callId: "cmd-1", output: "hi\n", isError: false }]);
    expect(
      feed({ method: "item/completed", params: { threadId: THREAD, turnId: TURN, item: { type: "commandExecution", id: "cmd-2", status: "declined" } } }, ctx, p)
    ).toEqual([{ kind: "tool_result", threadId: THREAD, turnId: TURN, callId: "cmd-2", output: null, isError: true }]);
  });

  test("a fileChange completion maps each change; kind is the object form", () => {
    const { parser: p, ctx } = parser();
    const parses = feed(
      {
        method: "item/completed",
        params: {
          threadId: THREAD,
          turnId: TURN,
          item: {
            type: "fileChange",
            id: "fc-1",
            status: "completed",
            changes: [
              { diff: "+n\n", kind: { type: "add" }, path: "/w/new.txt" },
              { diff: "-a\n+b\n", kind: { type: "update" }, path: "/w/file.txt" },
              { diff: "", kind: { type: "delete" }, path: "/w/old.txt" },
            ],
          },
        },
      },
      ctx,
      p
    );
    expect(parses).toEqual([
      { kind: "file_change", threadId: THREAD, turnId: TURN, path: "/w/new.txt", action: "add" },
      { kind: "file_change", threadId: THREAD, turnId: TURN, path: "/w/file.txt", action: "edit" },
      { kind: "file_change", threadId: THREAD, turnId: TURN, path: "/w/old.txt", action: "delete" },
    ]);
  });

  test("a partially parsable change list is all-or-nothing", () => {
    const { parser: p, ctx } = parser();
    expect(
      feed({ method: "item/completed", params: { threadId: THREAD, turnId: TURN, item: { type: "fileChange", id: "fc-2", changes: [{ path: "/w/a" }, { path: 5 }] } } }, ctx, p)
    ).toEqual([{ kind: "unknown" }]);
    expect(
      feed({ method: "item/completed", params: { threadId: THREAD, turnId: TURN, item: { type: "fileChange", id: "fc-3", changes: [] } } }, ctx, p)
    ).toEqual([{ kind: "unknown" }]);
  });

  test("tokenUsage/updated normalizes the last delta", () => {
    const { parser: p, ctx } = parser();
    const parses = feed(
      {
        method: "thread/tokenUsage/updated",
        params: {
          threadId: THREAD,
          turnId: TURN,
          tokenUsage: { total: usageRaw(18979, 18974, 12288, 0, 5), last: usageRaw(18979, 18974, 12288, 0, 5) },
        },
      },
      ctx,
      p
    );
    expect(parses).toEqual([
      {
        kind: "usage",
        threadId: THREAD,
        turnId: TURN,
        usage: {
          input_tokens: 6686,
          output_tokens: 5,
          cached_input_tokens: 12288,
          total_tokens: 18979,
          cost_usd: null,
        },
      },
    ]);
  });

  test("ambient notifications pass through unknown; thread-status flips still thread-check", () => {
    const { parser: p, ctx } = parser();
    expect(feed({ method: "account/updated", params: { authMode: "chatgpt" } }, ctx, p)).toEqual([{ kind: "unknown" }]);
    expect(feed({ method: "account/rateLimits/updated", params: {} }, ctx, p)).toEqual([{ kind: "unknown" }]);
    expect(
      feed({ method: "thread/status/changed", params: { threadId: THREAD, status: "idle" } }, ctx, p)
    ).toEqual([{ kind: "unknown" }]);
    const foreign = feed({ method: "thread/status/changed", params: { threadId: "other-thread-000012", status: "idle" } }, ctx, p);
    expect(foreign[0]!.kind).toBe("grammar_error");
  });

  test("approval requests classify per method and scope", () => {
    const { parser: p, ctx } = parser();
    const command = feed(
      {
        method: "item/commandExecution/requestApproval",
        id: "appr-1",
        params: { threadId: THREAD, turnId: TURN, callId: "cmd-1", command: "true", cwd: CWD, availableDecisions: ["accept", "decline"] },
      },
      ctx,
      p
    );
    expect(command).toEqual([
      {
        kind: "permission_request",
        id: "appr-1",
        requestId: "appr-1",
        kindOfApproval: "commandExecution",
        input: { threadId: THREAD, turnId: TURN, callId: "cmd-1", command: "true", cwd: CWD, availableDecisions: ["accept", "decline"] },
      },
    ]);
    const numeric = feed(
      {
        method: "item/commandExecution/requestApproval",
        id: 42,
        params: { threadId: THREAD, turnId: TURN, callId: "cmd-n", command: "true", cwd: CWD },
      },
      ctx,
      p
    );
    // The wire id keeps its type; the caller-facing id is its string
    // spelling (the pending set is string-keyed).
    expect(numeric).toEqual([
      {
        kind: "permission_request",
        id: 42,
        requestId: "42",
        kindOfApproval: "commandExecution",
        input: { threadId: THREAD, turnId: TURN, callId: "cmd-n", command: "true", cwd: CWD },
      },
    ]);
    const patch = feed(
      {
        method: "item/fileChange/requestApproval",
        id: "appr-2",
        params: { threadId: THREAD, turnId: TURN, callId: "fc-1", changes: [{ path: "/w/a", kind: { type: "update" } }] },
      },
      ctx,
      p
    );
    expect(patch[0]!.kind).toBe("permission_request");
    expect((patch[0] as any).kindOfApproval).toBe("fileChange");
  });

  test("the approval method table is exactly the three verified kinds", () => {
    expect(CODEX_APPROVAL_METHODS).toEqual({
      "item/commandExecution/requestApproval": "commandExecution",
      "item/fileChange/requestApproval": "fileChange",
      "item/permissions/requestApproval": "permissions",
    });
  });

  test("unparsable approvals never kill the session on shape alone", () => {
    const { parser: p, ctx } = parser();
    const noScope = feed({ method: "item/commandExecution/requestApproval", id: "a1", params: { command: "true" } }, ctx, p);
    expect(noScope).toEqual([{ kind: "unparseable_approval", id: "a1", method: "item/commandExecution/requestApproval" }]);
    const noPaths = feed(
      { method: "item/fileChange/requestApproval", id: "a2", params: { threadId: THREAD, turnId: TURN, changes: "nope" } },
      ctx,
      p
    );
    expect(noPaths[0]!.kind).toBe("unparseable_approval");
    const noParams = feed({ method: "item/fileChange/requestApproval", id: "a3" }, ctx, p);
    expect(noParams[0]!.kind).toBe("unparseable_approval");
  });

  test("an approval for a foreign or closed turn is a grammar error", () => {
    const { parser: p, ctx } = parser();
    const foreignTurn = feed(
      { method: "item/commandExecution/requestApproval", id: "a1", params: { threadId: THREAD, turnId: "turn-fake-9", command: "true" } },
      ctx,
      p
    );
    expect(foreignTurn[0]!.kind).toBe("grammar_error");
    const closed = parser(false);
    const noOpenTurn = feed(
      { method: "item/commandExecution/requestApproval", id: "a2", params: { threadId: THREAD, turnId: TURN, command: "true" } },
      closed.ctx,
      closed.parser
    );
    expect(noOpenTurn[0]!.kind).toBe("grammar_error");
  });

  test("other server requests surface for the -32601 answer", () => {
    const { parser: p, ctx } = parser();
    expect(feed({ method: "fs/readFileText", id: "req-x", params: { path: "/etc/hosts" } }, ctx, p)).toEqual([
      { kind: "server_request", id: "req-x", method: "fs/readFileText" },
    ]);
  });

  test("non-JSON and non-object lines are tier-3 unusable with bounded facts", () => {
    const { parser: p, ctx } = parser();
    const junk = p.feed("this is not json", ctx);
    expect(junk).toHaveLength(1);
    expect(junk[0]!.kind).toBe("unusable");
    expect((junk[0] as any).bytes).toBe("this is not json".length);
    expect((junk[0] as any).excerpt).toBe("this is not json");
    expect(p.feed("[1,2,3]", ctx)[0]!.kind).toBe("unusable");
    expect(p.feed("42", ctx)[0]!.kind).toBe("unusable");
  });

  test("a raw newline inside a string value rejoins into one frame", () => {
    const { parser: p, ctx } = parser();
    const first = p.feed(
      `{"method":"item/agentMessage/delta","params":{"threadId":"${THREAD}","turnId":"${TURN}","itemId":"m1","delta":"split`,
      ctx
    );
    expect(first).toEqual([]);
    const second = p.feed(`line"} }`, ctx);
    expect(second).toEqual([
      { kind: "assistant_delta", threadId: THREAD, turnId: TURN, text: "split\nline" },
    ]);
  });

  test("the rejoin buffer is bounded by line count", () => {
    const { parser: p, ctx } = parser();
    const first = p.feed(`{"method":"item/agentMessage/delta","params":{"threadId":"${THREAD}","turnId":"${TURN}","delta":"x`, ctx);
    expect(first).toEqual([]);
    // 999 further unterminated fragments stay buffered; the 1000th
    // continuation pushes past the bound and becomes the tier-3 fatal.
    for (let i = 0; i < 999; i += 1) {
      expect(p.feed(`more${i}`, ctx)).toEqual([]);
    }
    const over = p.feed(`more"}`, ctx);
    expect(over).toHaveLength(1);
    expect(over[0]!.kind).toBe("unusable");
  });

  test("a non-bufferable parse failure never buffers", () => {
    const { parser: p, ctx } = parser();
    expect(p.feed(`{"method": oops`, ctx)[0]!.kind).toBe("unusable");
    // The parser is not stuck buffering: the next line parses cleanly.
    expect(feed({ method: "account/updated", params: {} }, ctx, p)).toEqual([{ kind: "unknown" }]);
  });

  test("takeFragment hands back the buffered fragment once, then the parser is clear (review live25)", () => {
    const { parser: p, ctx } = parser();
    expect(p.takeFragment()).toBeNull();
    expect(p.feed(`{"delta":"unterminated`, ctx)).toEqual([]);
    expect(p.takeFragment()).toEqual({ excerpt: `{"delta":"unterminated`, bytes: 22 });
    expect(p.takeFragment()).toBeNull();
    expect(feed({ method: "account/updated", params: {} }, ctx, p)).toEqual([{ kind: "unknown" }]);
  });
});

function usageRaw(total: number, input: number, cached: number, cacheWrite: number, output: number) {
  return {
    totalTokens: total,
    inputTokens: input,
    cachedInputTokens: cached,
    cacheWriteInputTokens: cacheWrite,
    outputTokens: output,
    reasoningOutputTokens: 0,
  };
}
