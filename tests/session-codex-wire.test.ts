/**
 * Unit tests for the codex app-server session wiring (design §4.7): the
 * spawn command, the capability flags, the sandbox/approval policy pair,
 * and the request builders with their method allowlist. Split from the
 * former tests/session-codex.test.ts. The driver round-trips are covered
 * by tests/session-codex-e2e.test.ts; these pin the wire shapes the
 * fixture (tests/fixtures/live/codex-app-server.ndjson, codex 0.159.3)
 * recorded.
 */

import { describe, expect, test } from "bun:test";
import {
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
  codexSessionCapabilities,
  codexSessionPolicy,
} from "../src/session/codex-session.js";
import { CWD } from "./helpers/session-codex.js";

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

  test("a response builder refuses an id serialization would corrupt (review round 110)", () => {
    // JSON.stringify turns Infinity and NaN into null and rounds unsafe
    // integers, so echoing such an id would answer the wrong request; the
    // builders refuse instead of corrupting the wire.
    for (const id of [1e400, 1.5, 1e21, 9007199254740992, -0, Number.NaN]) {
      expect(() => buildJsonRpcResponse(id as never, {})).toThrow("safe integer");
      expect(() => buildJsonRpcErrorResponse(id as never, -1, "nope")).toThrow("safe integer");
    }
    expect(parseJson(buildJsonRpcResponse(0, {}))).toEqual({ id: 0, result: {} });
    expect(parseJson(buildJsonRpcResponse(-7, {}))).toEqual({ id: -7, result: {} });
  });

  test("thread/start carries cwd, the policy pair, and exactly the AGENTS.md-skip config", () => {
    // Review live3, security 2: the config object is the project-doc
    // (AGENTS.md) skip and NOTHING else — toEqual pins the exact key set.
    // It is not run's `--ignore-rules` equivalent: execpolicy rules
    // (~/.codex/rules) have no verified app-server carrier, so a codex
    // session still loads them where a run does not (the parity gap is
    // recorded in docs/harnesses.md).
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
