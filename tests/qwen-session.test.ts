import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realpathSync } from "node:fs";
import { QwenAdapter } from "../src/adapters/qwen.js";
import { BaseAdapter } from "../src/adapters/base.js";
import * as adapters from "../src/adapters/index.js";
import { getDefaultConfig } from "../src/config.js";
import { assertExecutablesUnchanged } from "../src/executable-security.js";
import type { RunContext } from "../src/run-context.js";
import type { RunRequest } from "../src/types.js";
import { resolveSessionRequest } from "../src/session/cli-request.js";
import { QWEN_DRIVER_PROFILE } from "../src/session/qwen-driver.js";
import { prepareQwenSessionPlaywright } from "../src/session/qwen-playwright.js";
import {
  QWEN_SESSION_FLOOR,
  QWEN_SESSION_ID_PATTERN,
  buildQwenSessionCommand,
  parseQwenSessionTurn,
  qwenSessionAutonomyFlags,
  qwenSessionCapabilities,
} from "../src/session/qwen-session.js";

// A v4-shape id inside the class qwen itself validates (variant nibble 8).
const ID = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
const OTHER = "2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e";

/** One qwen stdout line: the message array with the result message last
 * (chunk-ZJBYZN5D.js byte 3169 prints JSON.stringify(this.messages)). */
const resultLine = (result: Record<string, unknown>): string =>
  `${JSON.stringify([
    {
      type: "user",
      uuid: "u1",
      session_id: ID,
      parent_tool_use_id: null,
      message: { role: "user", content: "the prompt" },
    },
    {
      type: "result",
      subtype: "success",
      uuid: "u2",
      session_id: ID,
      is_error: false,
      duration_ms: 12,
      duration_api_ms: 3,
      num_turns: 1,
      result: "Done",
      usage: { input_tokens: 10, output_tokens: 4, cache_read_input_tokens: 6 },
      permission_denials: [],
      ...result,
    },
  ])}\n`;

describe("qwen session wiring", () => {
  const restores: Array<() => void> = [];
  beforeEach(() => {
    for (const name of ["spawn", "spawnSync"] as const) {
      const mock = spyOn(Bun, name).mockImplementation(() => { throw new Error(`unexpected Bun.${name} in Qwen session test`); });
      restores.push(() => mock.mockRestore());
    }
  });
  afterEach(() => { for (const restore of restores.splice(0).reverse()) restore(); });

  test("the floor and the minted id shape", () => {
    expect(QWEN_SESSION_FLOOR).toBe("0.24.0");
    expect(QWEN_SESSION_ID_PATTERN.test(ID)).toBe(true);
    // Goose's date_time mint is not a qwen id.
    expect(QWEN_SESSION_ID_PATTERN.test("20250921_143022")).toBe(false);
    // Uppercase is not the canonical mint (normalizeSessionIdForLookup
    // lowercases; codemux mints lowercase).
    expect(QWEN_SESSION_ID_PATTERN.test(ID.toUpperCase())).toBe(false);
    // The internal -agent- suffix class is not a caller-supplied id.
    expect(QWEN_SESSION_ID_PATTERN.test(`${ID}-agent-worker`)).toBe(false);
    // A variant nibble outside 8/9/a/b fails isValidSessionId's class.
    expect(QWEN_SESSION_ID_PATTERN.test("1a2b3c4d-5e6f-4a7b-ca9d-0e1f2a3b4c5d")).toBe(false);
    // A version nibble outside 1-5 fails it too.
    expect(QWEN_SESSION_ID_PATTERN.test("1a2b3c4d-5e6f-7a7b-8c9d-0e1f2a3b4c5d")).toBe(false);
  });

  test("capabilities: live input and resume; nothing else", () => {
    expect(qwenSessionCapabilities()).toEqual({
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

  test("the session autonomy flags are the run adapter's mapping", () => {
    const adapter = new QwenAdapter(() => "/usr/local/bin/qwen", {});
    for (const level of ["read-only", "low", "medium", "high"] as const) {
      expect(qwenSessionAutonomyFlags(level)).toEqual(adapter.mapAutonomy(level));
    }
  });

  test("first turn names the minted id; later turns resume it", () => {
    expect(
      buildQwenSessionCommand({
        sessionId: ID,
        firstTurn: true,
        autonomy: "read-only",
      })
    ).toEqual([
      "qwen",
      "--safe-mode",
      "--output-format",
      "json",
      "--approval-mode",
      "plan",
      "--session-id",
      ID,
    ]);
    expect(
      buildQwenSessionCommand({
        sessionId: ID,
        firstTurn: false,
        autonomy: "high",
        model: "qwen3-coder-plus",
      })
    ).toEqual([
      "qwen",
      "--safe-mode",
      "--model",
      "qwen3-coder-plus",
      "--output-format",
      "json",
      "--approval-mode",
      "yolo",
      "--resume",
      ID,
    ]);
  });

  test("every turn carries --safe-mode and the json wire, never both session flags", () => {
    for (const autonomy of ["read-only", "low", "medium", "high"] as const) {
      for (const firstTurn of [true, false]) {
        for (const model of [undefined, "qwen3-coder-plus"]) {
          const argv = buildQwenSessionCommand({
            sessionId: ID,
            firstTurn,
            autonomy,
            model,
            tools: "default",
          });
          expect(argv[0]).toBe("qwen");
          expect(argv).toContain("--safe-mode");
          expect(argv).toContain("--output-format");
          expect(argv[argv.indexOf("--output-format") + 1]).toBe("json");
          expect(argv).toContain("--approval-mode");
          // The binary's own rule (chunk-HWKWZSZY.js byte 2063646): the
          // two carriers never combine on one command.
          expect(argv.includes("--session-id") && argv.includes("--resume")).toBe(false);
          expect(argv.includes(firstTurn ? "--session-id" : "--resume")).toBe(true);
          expect(argv[argv.length - 1]).toBe(ID);
        }
      }
    }
  });

  test("a tools-none session excludes the built-in tools on every turn", () => {
    // The exclusion carrier is argv and rides every spawn, so a resumed
    // turn keeps the set the first turn promised (the run path's
    // unconditional --exclude-tools merge, src/qwen-tools.ts).
    for (const firstTurn of [true, false]) {
      const argv = buildQwenSessionCommand({
        sessionId: ID,
        firstTurn,
        autonomy: "read-only",
        tools: "none",
      });
      expect(argv).toContain("--exclude-tools");
      expect(argv[argv.indexOf("--exclude-tools") + 1]).toContain("run_shell_command");
      expect(argv[argv.indexOf("--exclude-tools") + 1]).toContain("web_search");
    }
  });

  test("a playwright session attaches the server on every turn", () => {
    const root = mkdtempSync(join(tmpdir(), "codemux-qwen-session-mcp-"));
    const binary = join(root, "playwright-mcp");
    writeFileSync(binary, "#!/bin/sh\nexit 0\n");
    chmodSync(binary, 0o755);
    const realPath = process.env.PATH;
    process.env.PATH = `${root}:${realPath ?? ""}`;
    try {
      for (const firstTurn of [true, false]) {
        const prepared: RunContext = {};
        const extras = prepareQwenSessionPlaywright({
          agent: "qwen", prompt: "p", sandboxed: true, enablePlaywrightMcp: true,
        }, prepared, root);
        expect(prepared.playwrightMcpCheck?.path).toBe(realpathSync(binary));
        const argv = QWEN_DRIVER_PROFILE.buildTurnCommand({
          sessionId: ID,
          firstTurn,
          text: "p",
          hermeticHome: null,
          autonomy: "low",
          playwrightMcp: true,
          ...extras,
        });
        // Top-tier --mcp-config servers survive safe mode (offset
        // 2095089), so the carrier rides beside it on every spawn.
        expect(argv).toContain("--safe-mode");
        const config = argv[argv.indexOf("--mcp-config") + 1] ?? "";
        expect(JSON.parse(config).mcpServers.playwright.command)
          .toBe(realpathSync(binary));
      }
      // Without the flag nothing attaches.
      expect(buildQwenSessionCommand({ sessionId: ID, firstTurn: true, autonomy: "low" }))
        .not.toContain("--mcp-config");
      const prepared: RunContext = {};
      prepareQwenSessionPlaywright({
        agent: "qwen", prompt: "p", sandboxed: true, enablePlaywrightMcp: true,
      }, prepared, root);
      const checks = [prepared.playwrightMcpCheck!];
      expect(() => assertExecutablesUnchanged([], "qwen session", [], checks)).not.toThrow();
      writeFileSync(binary, "#!/bin/sh\nexit 1\n");
      expect(() => assertExecutablesUnchanged([], "qwen session", [], checks)).toThrow("changed");
    } finally {
      if (realPath === undefined) delete process.env.PATH;
      else process.env.PATH = realPath;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("the session request retains Playwright on the per-turn run request", () => {
    const boundary = new Error("synthetic run validation boundary");
    let request: RunRequest | undefined;
    const adapter = new QwenAdapter(() => null, {});
    const construct = spyOn(adapters, "getAdapter").mockReturnValue(adapter);
    const validate = spyOn(BaseAdapter.prototype, "validateRunRequest").mockImplementation((value) => {
      request = value;
      throw boundary;
    });
    try {
      expect(() => resolveSessionRequest({
        agent: "qwen", sandbox: true, auto: "low", enablePlaywrightMcp: true,
      }, getDefaultConfig())).toThrow(boundary.message);
      expect(request).toMatchObject({ agent: "qwen", sandboxed: true, enablePlaywrightMcp: true });
    } finally { validate.mockRestore(); construct.mockRestore(); }
  });

  test("Playwright refuses missing captured identity or sandbox", () => {
    expect(() => QWEN_DRIVER_PROFILE.buildTurnCommand({
      sessionId: ID, firstTurn: true, text: "p", hermeticHome: null,
      autonomy: "low", playwrightMcp: true,
    })).toThrow("requires the captured executable path");
    expect(() => prepareQwenSessionPlaywright({
      agent: "qwen", prompt: "p", enablePlaywrightMcp: true,
    }, {}, "")).toThrow("require a sandbox");
    expect(prepareQwenSessionPlaywright({ agent: "qwen", prompt: "p" }, {}, "")).toEqual({});
  });

  test("parse reads the result message: answer, usage, session id", () => {
    const parsed = parseQwenSessionTurn(resultLine({}), {
      knownSessionId: ID,
    });
    expect(parsed).toEqual({
      answer: "Done",
      // qwen's usage carries no cache-creation key, so the cached sum
      // stays null (src/result-envelope/qwen.ts).
      usage: {
        input_tokens: 10,
        output_tokens: 4,
        cached_input_tokens: null,
        total_tokens: null,
        cost_usd: null,
      },
      sessionId: ID,
      subtype: "success",
      isError: false,
      errorMessage: null,
      noSessionId: false,
      wrongSession: false,
      noWire: false,
    });
  });

  test("stdout with no result message is the no-wire fatal", () => {
    const parsed = parseQwenSessionTurn("plain text the harness printed\n", {
      knownSessionId: ID,
    });
    expect(parsed).toEqual({
      answer: null,
      usage: {
        input_tokens: null,
        output_tokens: null,
        cached_input_tokens: null,
        total_tokens: null,
        cost_usd: null,
      },
      sessionId: null,
      subtype: null,
      isError: false,
      errorMessage: null,
      noSessionId: false,
      wrongSession: false,
      noWire: true,
    });
  });

  test("a result message with no session id breaks the fresh-turn pin", () => {
    const parsed = parseQwenSessionTurn(resultLine({ session_id: undefined }), {
      knownSessionId: ID,
    });
    expect(parsed.sessionId).toBeNull();
    expect(parsed.noSessionId).toBe(true);
    expect(parsed.wrongSession).toBe(false);
  });

  test("a resumed turn naming another session is the wrong-session defect", () => {
    const parsed = parseQwenSessionTurn(resultLine({ session_id: OTHER }), {
      knownSessionId: ID,
    });
    expect(parsed.sessionId).toBe(OTHER);
    expect(parsed.noSessionId).toBe(false);
    expect(parsed.wrongSession).toBe(true);
  });

  test("the error fold: an error result message carries its message", () => {
    const parsed = parseQwenSessionTurn(
      resultLine({
        subtype: "error_during_execution",
        is_error: true,
        result: undefined,
        error: { message: "the model call failed" },
      }),
      { knownSessionId: ID }
    );
    expect(parsed.answer).toBeNull();
    expect(parsed.isError).toBe(true);
    expect(parsed.subtype).toBe("error_during_execution");
    expect(parsed.errorMessage).toBe("the model call failed");
    // A failed turn still names its session: the identity rules hold.
    expect(parsed.sessionId).toBe(ID);
    expect(parsed.noSessionId).toBe(false);
    expect(parsed.wrongSession).toBe(false);
    expect(parsed.noWire).toBe(false);
  });
});
