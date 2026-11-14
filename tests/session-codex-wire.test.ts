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
  buildThreadUnsubscribeRequest,
  buildTurnStartRequest,
  buildCodexSessionCommand,
  codexSessionCapabilities,
  codexSessionHermeticEnvPrefix,
  codexSessionPolicy,
  steerElementBytes,
} from "../src/session/codex-session.js";
import { utf8ByteLength } from "../src/session/stdin-writer.js";
import { CWD } from "./helpers/session-codex.js";

function parseJson(line: string): Record<string, any> {
  return JSON.parse(line) as Record<string, any>;
}

describe("codex session - spawn and capabilities", () => {
  test("the spawn command is one dedicated app-server per session", () => {
    expect(buildCodexSessionCommand()).toEqual(["codex", "app-server"]);
  });

  test("the hermetic spawn carries only the two home variables: -c is available and unused (round 413, item 4)", () => {
    // codex-cli 0.166.0's `codex app-server --help` lists
    // `-c, --config <key=value>` under Options (checked by the session
    // owner 2026-11-09; the binary's own strings carry the
    // CliConfigOverrides/RAW_OVERRIDES help text). The session passes
    // no -c anyway: the private CODEX_HOME's config.toml already
    // carries cli_auth_credentials_store for the whole session, and the
    // project-doc keys ride the thread config (hermetic threads only),
    // so the argv stays the run path's two-home env(1) shape.
    const prefix = codexSessionHermeticEnvPrefix("/private/home-1");
    expect(prefix).toEqual(["HOME=/private/home-1", "CODEX_HOME=/private/home-1/.codex"]);
    expect(buildCodexSessionCommand(prefix)).toEqual([
      "env",
      "HOME=/private/home-1",
      "CODEX_HOME=/private/home-1/.codex",
      "codex",
      "app-server",
    ]);
    expect(buildCodexSessionCommand(prefix).includes("-c")).toBe(false);
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
  test("read-only retains its existing pair with approvals disabled", () => {
    expect(codexSessionPolicy("read-only", true, CWD)).toEqual({
      sandbox: "danger-full-access",
      approvalPolicy: "never",
      sandboxPolicy: { type: "dangerFullAccess" },
    });
    expect(codexSessionPolicy("read-only", false, CWD)).toEqual({
      sandbox: "read-only",
      approvalPolicy: "never",
      sandboxPolicy: { type: "readOnly", networkAccess: false },
    });
  });

  test("low and medium ask for native write access with or without an outer sandbox", () => {
    for (const sandboxed of [true, false]) {
      for (const level of ["low", "medium"] as const) {
        expect(codexSessionPolicy(level, sandboxed, CWD)).toEqual({
          sandbox: "read-only",
          approvalPolicy: "on-request",
          sandboxPolicy: { type: "readOnly", networkAccess: false },
        });
      }
      expect(codexSessionPolicy("high", sandboxed, CWD)).toEqual({
        sandbox: "danger-full-access",
        approvalPolicy: "on-request",
        sandboxPolicy: { type: "dangerFullAccess" },
      });
    }
  });

  test("start, resume and every turn carry asking policy above read-only", () => {
    for (const sandboxed of [true, false]) {
      for (const level of ["low", "medium", "high"] as const) {
        const policy = codexSessionPolicy(level, sandboxed, CWD);
        const requests = [
          buildThreadStartRequest(1, policy, CWD),
          buildThreadResumeRequest(2, "0123456789abcdef", policy, CWD),
          buildTurnStartRequest(3, "0123456789abcdef", "one", policy),
          buildTurnStartRequest(4, "0123456789abcdef", "two", policy),
        ];
        for (const request of requests) expect(parseJson(request).params.approvalPolicy).toBe("on-request");
      }
    }
  });
});

describe("codex session - method allowlist and builders", () => {
  test("the allowlist is exactly the eight verified methods", () => {
    expect([...CODEX_SESSION_METHODS]).toEqual([
      "initialize",
      "initialized",
      "thread/start",
      "thread/resume",
      "thread/unsubscribe",
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
      buildThreadUnsubscribeRequest(7, "0123456789abcdef"),
    ];
    for (const line of lines) {
      const frame = parseJson(line);
      expect(frame.jsonrpc).toBe("2.0");
      expect((CODEX_SESSION_METHODS as readonly string[]).includes(frame.method)).toBe(true);
      expect(typeof frame.id).not.toBe("undefined");
    }
  });

  test("0.166 and 0.167 app-server initialization uses initialized, not the MCP notification", () => {
    const frame = parseJson(buildInitializedNotification());
    expect(frame).toEqual({ jsonrpc: "2.0", method: "initialized" });
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

  test("a PLAIN thread/start carries cwd, the policy pair, and no config at all", () => {
    // Review round 413, item 1: a plain session must load project
    // documents exactly as a plain codex run does, so it sends no
    // thread config — toEqual pins the exact key set, `config` absent.
    const policy = codexSessionPolicy("low", false, CWD);
    const frame = parseJson(buildThreadStartRequest(2, policy, CWD, "gpt-5"));
    expect(frame.params).toEqual({
      cwd: CWD,
      sandbox: "read-only",
      approvalPolicy: "on-request",
      model: "gpt-5",
    });
  });

  test("a HERMETIC thread/start skips AGENTS.md discovery with exactly the two project-doc keys", () => {
    // Review live3, security 2: the config object is the project-doc
    // (AGENTS.md) skip and NOTHING else — toEqual pins the exact key set.
    // It is not run's `--ignore-rules` equivalent: execpolicy rules
    // (~/.codex/rules) have no verified app-server carrier, and a
    // hermetic session's fresh home carries none anyway; workspace
    // .codex/rules still load, which is the caller's own policy channel
    // (the parity gap is recorded in docs/harnesses.md).
    const policy = codexSessionPolicy("low", false, CWD);
    const frame = parseJson(buildThreadStartRequest(2, policy, CWD, "gpt-5", true));
    expect(frame.params).toEqual({
      cwd: CWD,
      sandbox: "read-only",
      approvalPolicy: "on-request",
      config: { project_doc_max_bytes: 0, project_doc_fallback_filenames: [] },
      model: "gpt-5",
    });
  });

  test("thread/resume carries the thread id, cwd, the policy pair, and the config only when hermetic; model stays optional", () => {
    // Review live20, contracts 3: design §4.7 says every thread start,
    // thread/resume included, carries the sandbox/approval pair, or the
    // resumed thread falls back to config.toml. toEqual pins the whole
    // params object, so dropping the pair fails here. The project-doc
    // skip follows the session's mode, start and resume alike (round
    // 413, item 1): a plain resume keeps AGENTS.md discovery, a
    // hermetic one skips it.
    const policy = codexSessionPolicy("low", false, CWD);
    const withModel = parseJson(
      buildThreadResumeRequest(3, "0123456789abcdef", policy, CWD, "gpt-5", true)
    );
    expect(withModel.params).toEqual({
      threadId: "0123456789abcdef",
      cwd: CWD,
      sandbox: "read-only",
      approvalPolicy: "on-request",
      config: { project_doc_max_bytes: 0, project_doc_fallback_filenames: [] },
      model: "gpt-5",
    });
    const plain = parseJson(buildThreadResumeRequest(4, "0123456789abcdef", policy, CWD));
    const { model: _model, config: _config, ...rest } = withModel.params;
    expect(plain.params).toEqual(rest);
  });

  test("turn/start carries the fixture's input shape, the policy pair, and the effort override", () => {
    const policy = codexSessionPolicy("medium", false, CWD);
    const frame = parseJson(buildTurnStartRequest(5, "0123456789abcdef", "Reply with exactly: one", policy, "high"));
    expect(frame.params).toEqual({
      threadId: "0123456789abcdef",
      input: [{ type: "text", text: "Reply with exactly: one" }],
      approvalPolicy: "on-request",
      sandboxPolicy: { type: "readOnly", networkAccess: false },
      effort: "high",
    });
  });

  test("effort none uses the native enum; omitted effort stays omitted", () => {
    const policy = codexSessionPolicy("high", false, CWD);
    const frame = parseJson(buildTurnStartRequest(5, "0123456789abcdef", "hi", policy, "none"));
    expect(frame.params.effort).toBe("none");
    const omitted = parseJson(buildTurnStartRequest(6, "0123456789abcdef", "hi", policy));
    expect("effort" in omitted.params).toBe(false);
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

  test("the incremental steer byte count matches the built frame exactly (round 341)", () => {
    // flushSteer batches steers by counting bytes incrementally
    // (steerElementBytes) instead of re-serializing the batch per
    // increment. The count must equal the built frame's own bytes for
    // every prefix — the batching decision and the cap the sent frame is
    // judged by cannot drift. The texts exercise JSON escaping and
    // multi-byte characters, where string length and byte length differ.
    const texts = [
      "first",
      'quote " and \\ backslash',
      "line\nbreak\ttab",
      "é中文 🚀",
      "s".repeat(4096),
    ];
    const base = utf8ByteLength(buildSteerRequest(5, "0123456789abcdef", "turn-1", []));
    let counted = base;
    for (const [index, text] of texts.entries()) {
      counted += steerElementBytes(text, index > 0);
      expect(counted).toBe(
        utf8ByteLength(buildSteerRequest(5, "0123456789abcdef", "turn-1", texts.slice(0, index + 1)))
      );
    }
  });

  test("interrupt carries both ids", () => {
    const frame = parseJson(buildInterruptRequest(7, "0123456789abcdef", "turn-9"));
    expect(frame.params).toEqual({ threadId: "0123456789abcdef", turnId: "turn-9" });
  });
});
