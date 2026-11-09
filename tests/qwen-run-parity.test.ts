import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  lstatSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { QwenAdapter } from "../src/adapters/qwen.js";
import {
  qwenBrandHome,
  writeQwenEffortSettings,
  QWEN_EFFORT_SETTINGS_ENV,
} from "../src/qwen-effort.js";
import { QWEN_CORE_TOOLS } from "../src/qwen-tools.js";
import {
  QWEN_ANSWER_FIELD,
  parseQwenResultEnvelope,
  qwenResult,
} from "../src/result-envelope/qwen.js";
import type { RunRequest, RunResult } from "../src/types.js";
import type { RunContext } from "../src/adapters/base.js";

// Lane R-a: qwen's run-surface parity — the reasoning effort over a per-run
// system settings file, the provider override over the OPENAI_* environment
// trio, the --result-json envelope over `--output-format json`, and the
// hermetic no-op claim on top of the unconditional --safe-mode.

function scratchHome(): string {
  const parent = join(process.cwd(), "scratch", "fix", "qwen-run-parity");
  mkdirSync(parent, { recursive: true });
  return mkdtempSync(join(parent, "home-"));
}

function adapter(
  home: string,
  env: Record<string, string | undefined> = {}
): QwenAdapter {
  return new QwenAdapter(
    (name) => (name === "qwen" ? "/fake/qwen" : null),
    { HOME: home, QWEN_HOME: home, ...env } as NodeJS.ProcessEnv
  );
}

describe("qwen --effort", () => {
  test("the tier rides a per-run system settings file", () => {
    const home = scratchHome();
    try {
      const a = adapter(home);
      const context = a.prepareRun({ agent: "qwen", prompt: "p", effort: "high" });
      const settings = context.qwenEffortSettings!;
      expect(settings.path.startsWith(join(home, ".codemux", "effort-"))).toBe(true);
      expect(JSON.parse(readFileSync(settings.path, "utf8")))
        .toEqual({ model: { reasoningEffort: "high" } });
      expect(a.getRunEnv({ agent: "qwen", prompt: "p", effort: "high" }, context))
        .toEqual({ [QWEN_EFFORT_SETTINGS_ENV]: settings.path });
      // The argv carries nothing: the tier is env-delivered.
      expect(a.buildRunCommand({ agent: "qwen", prompt: "p", effort: "high" }))
        .toEqual(["/fake/qwen", "--safe-mode"]);
      a.cleanupRunSync(context);
      expect(existsSync(settings.path)).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("every accepted tier is written verbatim; the others are refused", () => {
    const home = scratchHome();
    try {
      for (const effort of ["none", "low", "medium", "high", "xhigh", "max"] as const) {
        const settings = writeQwenEffortSettings(qwenBrandHome({ QWEN_HOME: home }), effort);
        expect(JSON.parse(readFileSync(settings.path, "utf8")).model.reasoningEffort).toBe(effort);
        settings.finalize();
      }
      const a = adapter(home);
      expect(() => a.validateRunRequest({ agent: "qwen", prompt: "p", effort: "minimal" }))
        .toThrow("qwen does not support reasoning effort 'minimal'");
      expect(() => a.validateRunRequest({ agent: "qwen", prompt: "p", effort: "ultra" }))
        .toThrow("qwen does not support reasoning effort 'ultra'");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("a passed-through system settings path is refused under --effort", () => {
    const home = scratchHome();
    try {
      const a = adapter(home);
      expect(() => a.validateRunRequest({
        agent: "qwen", prompt: "p", effort: "low",
        passthroughEnv: [QWEN_EFFORT_SETTINGS_ENV],
      })).toThrow(`remove --pass-env ${QWEN_EFFORT_SETTINGS_ENV}`);
      expect(() => a.validateRunRequest({
        agent: "qwen", prompt: "p", effort: "low",
        passthroughEnv: ["OPENAI_API_KEY"],
      })).not.toThrow();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("interactive effort validates and writes a launch-owned settings file", () => {
    const home = scratchHome();
    try {
      expect(() => adapter(home).validateTuiRequest(undefined, undefined, "read-only", "high"))
        .not.toThrow();
      const prepared = adapter(home).prepareTuiEnvironment(undefined, "read-only", "high");
      const path = prepared.env[QWEN_EFFORT_SETTINGS_ENV]!;
      expect(JSON.parse(readFileSync(path, "utf8")).model.reasoningEffort).toBe("high");
      prepared.finalize();
      expect(existsSync(path)).toBe(false);
      expect(() => adapter(home).validateTuiRequest(undefined, undefined, "read-only"))
        .not.toThrow();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("the brand home follows QWEN_HOME and defaults to the platform home", () => {
    expect(qwenBrandHome({ QWEN_HOME: join(tmpdir(), "abs") })).toBe(join(tmpdir(), "abs"));
    // A relative redirect resolves against the cwd, the way qwen's own
    // path resolver treats it.
    expect(qwenBrandHome({ QWEN_HOME: "rel/qwen" })).toBe(resolve("rel/qwen"));
    expect(qwenBrandHome({ QWEN_HOME: "" })).toBe(join(homedir(), ".qwen"));
    expect(qwenBrandHome({})).toBe(join(homedir(), ".qwen"));
  });

  test("the sweep removes only stale directories of dead processes", () => {
    const home = scratchHome();
    try {
      // The first write creates the parent directory.
      writeQwenEffortSettings(qwenBrandHome({ QWEN_HOME: home }), "low").finalize();
      const parent = join(home, ".codemux");
      const deadStale = join(parent, "effort-999999999-stale");
      const deadFresh = join(parent, "effort-999999998-fresh");
      const mine = join(parent, `effort-${process.pid}-mine`);
      const unrelated = join(parent, "not-an-effort-dir");
      for (const dir of [deadStale, deadFresh, mine, unrelated]) mkdirSync(dir);
      // A broken symlink: stat fails on it, so the sweep must skip it
      // without touching anything else.
      symlinkSync(join(parent, "no-such-target"), join(parent, "effort-999999997-broken"));
      const threeDaysAgo = new Date(Date.now() - 3 * 86_400_000);
      utimesSync(deadStale, threeDaysAgo, threeDaysAgo);
      utimesSync(mine, threeDaysAgo, threeDaysAgo);
      // deadFresh keeps its creation mtime: a dead owner, but too recent
      // for the sweep to judge abandoned.

      writeQwenEffortSettings(qwenBrandHome({ QWEN_HOME: home }), "high").finalize();

      // Gone: a dead owner and older than any run could still read it.
      expect(existsSync(deadStale)).toBe(false);
      // Kept: this codemux still owns it, a dead owner wrote it recently,
      // and a name outside the pattern is never the sweep's to judge.
      expect(existsSync(mine)).toBe(true);
      expect(existsSync(deadFresh)).toBe(true);
      expect(existsSync(unrelated)).toBe(true);
      // existsSync follows the link and its target is missing; lstat
      // shows the skipped link itself is still there.
      expect(lstatSync(join(parent, "effort-999999997-broken")).isSymbolicLink()).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("the legacy qwen-coder binary keeps the base refusals", () => {
    const home = scratchHome();
    try {
      const legacy = new QwenAdapter(
        (name) => (name === "qwen-coder" ? "/fake/qwen-coder" : null),
        { HOME: home, QWEN_HOME: home } as NodeJS.ProcessEnv
      );
      expect(legacy.capabilities().supportsEffort).toBe(false);
      expect(legacy.capabilities().supportsProviderOverride).toBe(false);
      expect(() => legacy.validateRunRequest({
        agent: "qwen", prompt: "p", effort: "high", sandboxed: true,
      })).toThrow("qwen does not support reasoning effort 'high'");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("qwen provider override", () => {
  const overrideEnv = {
    CODEMUX_QWEN_PROVIDER_BASE_URL: "https://api.example/v1",
    CODEMUX_QWEN_PROVIDER_API_KEY: "key-1",
    CODEMUX_QWEN_PROVIDER_MODEL: "provider-model",
  };

  test("the environment trio rides the run environment", () => {
    const home = scratchHome();
    try {
      const request: RunRequest = { agent: "qwen", prompt: "p" };
      expect(adapter(home, overrideEnv).getRunEnv(request)).toEqual({
        OPENAI_API_KEY: "key-1",
        OPENAI_BASE_URL: "https://api.example/v1",
        OPENAI_MODEL: "provider-model",
      });
      // The request's model names the run; the override's still completes
      // the trio the auth type requires.
      expect(adapter(home, overrideEnv).getRunEnv({ ...request, model: "m1" })).toEqual({
        OPENAI_API_KEY: "key-1",
        OPENAI_BASE_URL: "https://api.example/v1",
        OPENAI_MODEL: "m1",
      });
      // The --model flag follows the request, not the override.
      expect(adapter(home, overrideEnv).buildRunCommand({ ...request, model: "m1" }))
        .toEqual(["/fake/qwen", "--safe-mode", "--model", "m1"]);
      expect(adapter(home, overrideEnv).buildRunCommand(request))
        .toEqual(["/fake/qwen", "--safe-mode"]);
      expect(adapter(home).getRunEnv(request)).toEqual({});
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("the output cap rides QWEN_CODE_MAX_OUTPUT_TOKENS; the context cap rides the settings file", () => {
    const home = scratchHome();
    try {
      const capped = adapter(home, {
        ...overrideEnv,
        CODEMUX_QWEN_PROVIDER_MAX_OUTPUT_TOKENS: "8192",
      });
      expect(capped.getRunEnv({ agent: "qwen", prompt: "p" })).toEqual({
        OPENAI_API_KEY: "key-1",
        OPENAI_BASE_URL: "https://api.example/v1",
        OPENAI_MODEL: "provider-model",
        QWEN_CODE_MAX_OUTPUT_TOKENS: "8192",
      });
      // The context cap rides model.generationConfig.contextWindowSize in
      // the per-run system settings file (resolveModelConfig honors a
      // defined contextWindowSize, chunk-366JNNY7.js, read 2026-11-09) —
      // no env var carries it.
      const contextCapped = adapter(home, {
        ...overrideEnv,
        CODEMUX_QWEN_PROVIDER_MAX_CONTEXT_TOKENS: "1000000",
      });
      expect(() => contextCapped.validateRunRequest({ agent: "qwen", prompt: "p" }))
        .not.toThrow();
      const context = contextCapped.prepareRun({ agent: "qwen", prompt: "p" });
      const settings = context.qwenEffortSettings!;
      expect(JSON.parse(readFileSync(settings.path, "utf8"))).toEqual({
        model: { generationConfig: { contextWindowSize: 1000000 } },
      });
      expect(contextCapped.getRunEnv({ agent: "qwen", prompt: "p" }, context))
        .toEqual({
          OPENAI_API_KEY: "key-1",
          OPENAI_BASE_URL: "https://api.example/v1",
          OPENAI_MODEL: "provider-model",
          [QWEN_EFFORT_SETTINGS_ENV]: settings.path,
        });
      contextCapped.cleanupRunSync(context);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("an override without a model is refused: the auth type needs all three", () => {
    const home = scratchHome();
    try {
      expect(() => adapter(home, {
        CODEMUX_QWEN_PROVIDER_BASE_URL: "https://api.example/v1",
        CODEMUX_QWEN_PROVIDER_API_KEY: "key-1",
      }).validateRunRequest({ agent: "qwen", prompt: "p" }))
        .toThrow("CODEMUX_QWEN_PROVIDER_MODEL");
      expect(() => adapter(home, overrideEnv).validateTuiRequest())
        .not.toThrow();
      expect(adapter(home, overrideEnv).prepareTuiEnvironment().env.OPENAI_API_KEY).toBe(overrideEnv.CODEMUX_QWEN_PROVIDER_API_KEY);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("qwen --result-json", () => {
  test("a result-json run switches the output format", () => {
    const home = scratchHome();
    try {
      const a = adapter(home);
      expect(a.buildRunCommand({ agent: "qwen", prompt: "p", resultJson: true }))
        .toEqual(["/fake/qwen", "--safe-mode", "--output-format", "json"]);
      expect(a.buildRunCommand({ agent: "qwen", prompt: "p" }))
        .toEqual(["/fake/qwen", "--safe-mode"]);
      expect(a.buildRunCommand({
        agent: "qwen", prompt: "p", model: "qwen3-coder", autonomy: "high", resultJson: true,
      })).toEqual([
        "/fake/qwen", "--safe-mode", "--model", "qwen3-coder",
        "--output-format", "json", "--approval-mode", "yolo",
      ]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  function wire(resultMessage: Record<string, unknown>): string {
    return `${JSON.stringify([
      { type: "user", message: { role: "user", content: "p" } },
      { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "partial" }] } },
      resultMessage,
    ])}\n`;
  }

  test("the result message folds into the envelope under its native field", () => {
    expect(QWEN_ANSWER_FIELD).toBe("result");
    const stdout = wire({
      type: "result", subtype: "success", session_id: "sess-4", is_error: false,
      result: "the answer",
      usage: { input_tokens: 9, output_tokens: 3, cache_read_input_tokens: 2, total_tokens: 14 },
    });
    const parsed = parseQwenResultEnvelope(stdout)!;
    expect(parsed.answer).toBe("the answer");
    expect(parsed.sessionId).toBe("sess-4");
    // Qwen reports the cache-read count only; the shared normalizer keeps
    // a one-sided cache report null rather than guessing the missing
    // creation half as zero, so the derived total stays null too.
    expect(parsed.usage).toEqual({
      input_tokens: 9,
      output_tokens: 3,
      cached_input_tokens: null,
      total_tokens: null,
      cost_usd: null,
    });
    const result = qwenResult(
      { stdout, stderr: "", exitCode: 0, success: true } as RunResult,
      { agent: "qwen", prompt: "p", resultJson: true, model: "m1" }
    );
    const envelope = JSON.parse(result.stdout);
    expect(envelope.result).toBe("the answer");
    expect(envelope.codemux).toEqual({
      agent: "qwen",
      labels: null,
      model: "m1",
      served_model: null,
      model_alias: null,
      usage: envelope.usage,
      session_id: "sess-4",
      recording: null,
      failure_code: null,
    });
  });

  test("an absent usage key stays all-null, not zero", () => {
    const parsed = parseQwenResultEnvelope(wire({
      type: "result", subtype: "success", is_error: false, result: "r", session_id: "s",
    }))!;
    expect(parsed.usage).toEqual({
      input_tokens: null,
      output_tokens: null,
      cached_input_tokens: null,
      total_tokens: null,
      cost_usd: null,
    });
  });

  test("an error result message fails even at exit 0", () => {
    const stdout = wire({
      type: "result", subtype: "error_during_execution", session_id: "s", is_error: true,
      error: { message: "quota exceeded" },
    });
    const result = qwenResult(
      { stdout, stderr: "", exitCode: 0, success: true },
      { agent: "qwen", prompt: "p", resultJson: true }
    );
    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout).codemux.failure_code).toBe("harness-error");
    expect(result.stderr).toContain("an error result (quota exceeded)");
  });

  test("stdout with no result array fails loudly", () => {
    expect(parseQwenResultEnvelope("plain text reply\n")).toBeNull();
    expect(parseQwenResultEnvelope(`${JSON.stringify({ type: "user" })}\n`)).toBeNull();
    const result = qwenResult(
      { stdout: "boom\n", stderr: "error: boom", exitCode: 1, success: false },
      { agent: "qwen", prompt: "p", resultJson: true }
    );
    expect(result.success).toBe(false);
    expect(result.stderr).toContain("qwen printed no result message");
  });

  test("a success message with empty text fails too, and plain runs pass through", () => {
    const stdout = wire({ type: "result", subtype: "success", is_error: false, result: " ", session_id: "s" });
    expect(qwenResult(
      { stdout, stderr: "", exitCode: 0, success: true },
      { agent: "qwen", prompt: "p", resultJson: true }
    ).stderr).toContain("no result text");
    const home = scratchHome();
    try {
      const plain = { stdout: "text answer", stderr: "", exitCode: 0, success: true } as RunResult;
      expect(adapter(home).processRunResult(plain, { agent: "qwen", prompt: "p" })).toBe(plain);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("qwen --hermetic, --tools none, --no-web, and Playwright MCP", () => {
  test("hermetic is claimed on the always-on safe mode", () => {
    const home = scratchHome();
    try {
      const a = adapter(home);
      expect(a.capabilities().supportsHermetic).toBe(true);
      expect(() => a.validateRunRequest({
        agent: "qwen", prompt: "p", hermetic: true, sandboxed: true, autonomy: "high",
      })).not.toThrow();
      // The command is byte-identical: --safe-mode is the containment.
      expect(a.buildRunCommand({ agent: "qwen", prompt: "p", hermetic: true }))
        .toEqual(a.buildRunCommand({ agent: "qwen", prompt: "p" }));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("--tools none excludes every built-in tool; the capability is claimed", () => {
    const home = scratchHome();
    try {
      const a = adapter(home);
      expect(a.capabilities().supportsToolSelection ?? false).toBe(true);
      expect(() => a.validateRunRequest({
        agent: "qwen", prompt: "p", tools: "none", sandboxed: true, autonomy: "high",
      })).not.toThrow();
      const cmd = a.buildRunCommand({ agent: "qwen", prompt: "p", tools: "none" });
      const exclusion = cmd[cmd.indexOf("--exclude-tools") + 1] ?? "";
      // The complete native registry includes tools outside CORE_TOOLS.
      expect(exclusion.split(",")).toEqual([
        ...QWEN_CORE_TOOLS,
      ]);
      expect(exclusion.split(",").length).toBe(new Set(exclusion.split(",")).size);
      for (const name of ["get_goal", "update_goal", "agent", "skill", "tool_search", "report_findings", "enter_worktree"]) {
        expect(exclusion.split(",")).toContain(name);
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("--no-web excludes exactly the two web tools", () => {
    const home = scratchHome();
    try {
      const a = adapter(home);
      const cmd = a.buildRunCommand({ agent: "qwen", prompt: "p", web: false });
      expect(cmd[cmd.indexOf("--exclude-tools") + 1]).toBe("web_search,web_fetch");
      // With tools still on, the full exclusion list must not appear.
      expect(a.buildRunCommand({ agent: "qwen", prompt: "p" }))
        .not.toContain("--exclude-tools");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("a sandboxed run with the Playwright option attaches the server inline", () => {
    const home = scratchHome();
    const root = mkdtempSync(join(tmpdir(), "codemux-qwen-run-mcp-"));
    const cwd = join(root, "work");
    const binary = join(root, "playwright-mcp");
    mkdirSync(cwd);
    writeFileSync(binary, "#!/bin/sh\nexit 0\n");
    chmodSync(binary, 0o755);
    try {
      const a = adapter(home, { PATH: `${root}:${process.env.PATH ?? ""}` });
      const context: RunContext = {};
      const cmd = a.buildRunCommand(
        { agent: "qwen", prompt: "p", sandboxed: true, enablePlaywrightMcp: true, cwd },
        context
      );
      expect(cmd).toContain("--safe-mode");
      const config = cmd[cmd.indexOf("--mcp-config") + 1] ?? "";
      expect(JSON.parse(config).mcpServers.playwright.command)
        .toBe(realpathSync(binary));
      // The trust check rides the context for the spawn's re-stat.
      expect(context.playwrightMcpCheck).not.toBeNull();
      // Without the flag — or without the sandbox — nothing attaches.
      expect(a.buildRunCommand({ agent: "qwen", prompt: "p", sandboxed: true }, {}))
        .not.toContain("--mcp-config");
      expect(
        a.buildRunCommand({ agent: "qwen", prompt: "p", enablePlaywrightMcp: true }, {})
      ).not.toContain("--mcp-config");
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });
});
