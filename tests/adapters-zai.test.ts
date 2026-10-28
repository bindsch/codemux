import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ZaiAdapter } from "../src/adapters/zai.js";
import {
  claudeAutonomyFlags,
  claudeNativeAutonomyFlags,
} from "../src/claude-autonomy.js";
import type { RunRequest } from "../src/types.js";

describe("ZaiAdapter", () => {
  const adapter = new ZaiAdapter({ ZAI_API_KEY: "test-key-123" });
  const safeHeadlessArgs = [
    "claude",
    "-p",
    "--setting-sources",
    "user",
    "--strict-mcp-config",
    "--no-session-persistence",
    "--output-format",
    "json",
  ];

  test("has correct id and binary name", () => {
    expect(adapter.id).toBe("zai");
    expect(adapter.binaryName).toBe("claude");
  });

  test("capabilities are correct", () => {
    const caps = adapter.capabilities();
    expect(caps.supportsNonInteractive).toBe(true);
    expect(caps.supportsInteractive).toBe(true);
    expect(caps.supportsModel).toBe(true);
    expect(caps.supportsAutonomy).toBe(true);
    expect(caps.autonomyLevels).toEqual(["read-only", "low", "medium", "high"]);
    // Claude's flag verbatim (same binary), enabled live 2026-10-10
    // against the Z.AI endpoint: glm-5.3 answered under --effort low.
    // `none` leads the list: it is the adapter's "no flag" spelling
    // mapEffort accepts, so the capability list must carry it or the CLI
    // refuses what the mapper maps (review al11).
    expect(caps.supportsEffort).toBe(true);
    expect(caps.effortLevels).toEqual(["none", "low", "medium", "high", "xhigh", "max"]);
  });

  test("buildRunCommand defaults to opus model", () => {
    const request: RunRequest = { agent: "zai", prompt: "test" };
    const cmd = adapter.buildRunCommand(request);
    expect(cmd).toEqual([...safeHeadlessArgs, "--model", "opus"]);
  });

  test("buildRunCommand with explicit model", () => {
    const request: RunRequest = { agent: "zai", prompt: "test", model: "sonnet" };
    const cmd = adapter.buildRunCommand(request);
    expect(cmd).toEqual([...safeHeadlessArgs, "--model", "sonnet"]);
  });

  test("buildRunCommand with effort rides claude's flag; none adds nothing", () => {
    // Claude's mapping verbatim (same binary): a level rides --effort,
    // and `none` is the adapter's "no flag", not a value the binary takes.
    expect(adapter.buildRunCommand({ agent: "zai", prompt: "t", effort: "low" }))
      .toEqual([...safeHeadlessArgs, "--model", "opus", "--effort", "low"]);
    expect(adapter.buildRunCommand({ agent: "zai", prompt: "t", effort: "none" }))
      .toEqual([...safeHeadlessArgs, "--model", "opus"]);
  });

  test("buildRunCommand with autonomy levels", () => {
    expect(adapter.buildRunCommand({ agent: "zai", prompt: "t", autonomy: "read-only" }))
      .toEqual([...safeHeadlessArgs, "--model", "opus", "--permission-mode", "plan", "--allowedTools", "WebSearch", "WebFetch"]);
    expect(adapter.buildRunCommand({ agent: "zai", prompt: "t", autonomy: "low" }))
      .toEqual([...safeHeadlessArgs, "--model", "opus", "--permission-mode", "manual", "--allowedTools", "WebSearch", "WebFetch"]);
    const grantWksp = realpathSync(mkdtempSync(join(tmpdir(), "codemux-grant-")));
    try {
      expect(adapter.buildRunCommand({ agent: "zai", prompt: "t", autonomy: "medium", cwd: grantWksp }))
        .toEqual([...safeHeadlessArgs, "--model", "opus", "--permission-mode", "acceptEdits", "--allowedTools", `Edit(//${grantWksp.replace(/^\/+/, "")}/**)`, "WebSearch", "WebFetch"]);
    } finally {
      rmSync(grantWksp, { recursive: true, force: true });
    }
    expect(adapter.buildRunCommand({ agent: "zai", prompt: "t", autonomy: "high" }))
      .toEqual([...safeHeadlessArgs, "--model", "opus", "--dangerously-skip-permissions", "--allowedTools", "Edit", "Write", "NotebookEdit", "Bash", "WebSearch", "WebFetch"]);
  });

  test("--no-web denies zai's web tools", () => {
    expect(adapter.buildRunCommand({ agent: "zai", prompt: "t", autonomy: "low", web: false }))
      .toEqual([...safeHeadlessArgs, "--model", "opus", "--permission-mode", "manual", "--disallowedTools", "WebSearch", "WebFetch"]);
  });

  test("a launch directory with spaces still emits its grant", () => {
    expect(
      adapter.buildRunCommand({ agent: "zai", prompt: "t", autonomy: "medium", cwd: "/tmp/my stuff" })
    ).toEqual([
      ...safeHeadlessArgs,
      "--model",
      "opus",
      "--permission-mode",
      "acceptEdits",
      "--allowedTools",
      "Edit(//tmp/my stuff/**)",
      "WebSearch",
      "WebFetch",
    ]);
  });

  test("buildRunCommand does not inject an MCP server by default", () => {
    const cmd = adapter.buildRunCommand({ agent: "zai", prompt: "t", sandboxed: true });
    expect(cmd).toEqual([
      ...safeHeadlessArgs,
      "--model",
      "opus",
    ]);
  });

  test("getStdinInput returns prompt", () => {
    const request: RunRequest = { agent: "zai", prompt: "my prompt" };
    expect(adapter.getStdinInput(request)).toBe("my prompt");
  });

  test("zai declares it can return a result envelope", () => {
    // Same binary as claude, so the same --output-format json envelope.
    expect(adapter.capabilities().supportsResultJson).toBe(true);
  });

  test("the envelope is always on, so --result-json adds no flag", () => {
    // Same rule as the claude adapter: plain runs ask for the envelope
    // too (it is what makes usage recoverable) and unwrap it in
    // processRunResult; --result-json only stops the unwrap.
    const plain = adapter.buildRunCommand({ agent: "zai", prompt: "t" });
    const enveloped = adapter.buildRunCommand({ agent: "zai", prompt: "t", resultJson: true });
    expect(plain).toEqual(enveloped);
    expect(plain).toContain("--output-format");
  });

  test("processRunResult appends the codemux block under the zai agent", () => {
    const envelope = JSON.stringify({
      type: "result",
      result: "OK",
      usage: { input_tokens: 5, output_tokens: 2 },
      modelUsage: { "glm-5.3": {} },
    });
    const out = adapter.processRunResult(
      { stdout: envelope, stderr: "", exitCode: 0, success: true },
      { agent: "zai", prompt: "t", resultJson: true }
    );
    const parsed = JSON.parse(out.stdout);
    expect(parsed.result).toBe("OK");
    expect(parsed.codemux).toEqual({
      agent: "zai",
      model: "glm-5.3",
      usage: {
        input_tokens: 5,
        output_tokens: 2,
        // No cache counts were reported, so the total (their sum plus
        // output) is not computable -- null, never guessed from zero.
        cached_input_tokens: null,
        total_tokens: null,
        cost_usd: null,
      },
      session_id: null,
      recording: null,
      labels: null,
    });
  });

  test("buildTuiCommand defaults to opus", () => {
    expect(adapter.buildTuiCommand()).toEqual(["claude", "--safe-mode", "--model", "opus"]);
  });

  test("buildTuiCommand with model and autonomy", () => {
    expect(adapter.buildTuiCommand("sonnet", "high")).toEqual(["claude", "--safe-mode", "--model", "sonnet", "--dangerously-skip-permissions"]);
  });

  test("buildTuiCommand does not inject an MCP server by default", () => {
    const cmd = adapter.buildTuiCommand("sonnet", "high", undefined, true);
    expect(cmd).toEqual([
      "claude",
      "--safe-mode",
      "--model",
      "sonnet",
      "--dangerously-skip-permissions",
    ]);
  });

  test("mapAutonomy matches the native claude mapping", () => {
    for (const level of ["read-only", "low", "medium", "high"] as const) {
      expect(adapter.mapAutonomy(level)).toEqual(claudeNativeAutonomyFlags(level));
    }
    // The TUI path emits no grants; only headless runs carry them.
    expect(adapter.mapAutonomy("medium")).toEqual(["--permission-mode", "acceptEdits"]);
    expect(adapter.mapAutonomy("high")).toEqual(["--dangerously-skip-permissions"]);
  });

  test("parentheses refuse; commas and spaces stay one literal rule", () => {
    // A parenthesis closes the rule early and what follows it becomes new
    // grants (`/tmp/repo),Bash,Edit(` would mint bare `Bash`), and the
    // grammar has no escape for one: the launch is refused. Commas and
    // spaces inside one rule value stay literal (verified against the
    // installed 2.1.258 parser). Glob metacharacters would match siblings
    // instead of the launch directory, so such paths refuse the launch.
    expect(() => claudeAutonomyFlags("medium", "/tmp/repo),Bash,Edit(")).toThrow(
      /parenthesis/
    );
    expect(() => claudeAutonomyFlags("medium", "/tmp/a\\d")).toThrow(
      /backslash/
    );
    expect(() => claudeAutonomyFlags("medium", "/tmp/repo\napp")).toThrow(
      /tab or line break/
    );
    expect(claudeAutonomyFlags("medium", "/tmp/x,Bash,y")).toEqual([
      "--permission-mode",
      "acceptEdits",
      "--allowedTools",
      "Edit(//tmp/x,Bash,y/**)",
      "WebSearch",
      "WebFetch",
    ]);
    expect(claudeAutonomyFlags("medium", "/tmp/a b c")).toEqual([
      "--permission-mode",
      "acceptEdits",
      "--allowedTools",
      "Edit(//tmp/a b c/**)",
      "WebSearch",
      "WebFetch",
    ]);
    expect(() => claudeAutonomyFlags("medium", "/tmp/[wip]-app")).toThrow(
      /glob metacharacter/
    );
    expect(() => claudeAutonomyFlags("medium", "/tmp/a?b")).toThrow(
      /glob metacharacter/
    );
    expect(claudeAutonomyFlags("medium", "/tmp/plain")).toEqual([
      "--permission-mode",
      "acceptEdits",
      "--allowedTools",
      "Edit(//tmp/plain/**)",
      "WebSearch",
      "WebFetch",
    ]);
    // Trailing whitespace cannot be represented: the matcher trims it (an
    // escaped tab even decodes back to a space), which would retarget the
    // grant to a sibling directory. The launch is refused instead.
    expect(() => claudeAutonomyFlags("medium", "/tmp/repo ")).toThrow(
      /tab or line break, or ends with whitespace/
    );
    expect(() => claudeAutonomyFlags("medium", "/tmp/re\tpo")).toThrow(
      /tab or line break, or ends with whitespace/
    );
  });

  test("getEnv sets anthropic proxy vars", () => {
    const homeAdapter = new ZaiAdapter({ ZAI_API_KEY: "test-key-123" }, "/home/zai-user");
    const env = homeAdapter.getEnv();
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("test-key-123");
    expect(env.ANTHROPIC_BASE_URL).toBe("https://api.z.ai/api/anthropic");
    expect(env.API_TIMEOUT_MS).toBeDefined();
  });

  test("getEnv points zai at no private state; the shared store is the child's own", () => {
    // zai runs the same claude binary against the same CLAUDE_CONFIG_DIR
    // claude uses: the adapter pins nothing, so an inherited value the
    // operator passes through reaches the child, and without a pass-through
    // the sanitized child environment drops it (the documented default is
    // the child's ~/.claude).
    const homeAdapter = new ZaiAdapter({ ZAI_API_KEY: "test-key-123" }, "/home/zai-user");
    expect("CLAUDE_CONFIG_DIR" in homeAdapter.getEnv()).toBe(false);
    const home = mkdtempSync(join(tmpdir(), "codemux-zai-home-"));
    const environment = {
      ZAI_API_KEY: "test-key-123",
      CLAUDE_CONFIG_DIR: join(home, "claude-profile"),
    };
    try {
      // No pass-through: the sanitizing builder drops the inherited value.
      const dropped = new ZaiAdapter(environment, home)
        .buildExecutionEnv();
      expect(dropped.CLAUDE_CONFIG_DIR).toBeUndefined();
      // With the pass-through the operator's profile is honored exactly as
      // a claude run's would be.
      const passed = new ZaiAdapter(environment, home)
        .buildExecutionEnv({}, ["CLAUDE_CONFIG_DIR"]);
      expect(passed.CLAUDE_CONFIG_DIR).toBe(environment.CLAUDE_CONFIG_DIR);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("beforeLaunch creates no private state directory", () => {
    const home = mkdtempSync(join(tmpdir(), "codemux-zai-launch-"));
    try {
      new ZaiAdapter({ ZAI_API_KEY: "test-key-123" }, home).beforeLaunch();
      expect(existsSync(join(home, ".claude-zai"))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("an envelope without modelUsage reports the model codemux selected", () => {
    // zai always runs --model opus when the request names none; the result
    // processing must see that default, or codemux.model reads null.
    const envelope = JSON.stringify({
      type: "result",
      result: "OK",
      usage: { input_tokens: 5, output_tokens: 2 },
    });
    const out = adapter.processRunResult(
      { stdout: envelope, stderr: "", exitCode: 0, success: true },
      { agent: "zai", prompt: "t", resultJson: true }
    );
    expect(JSON.parse(out.stdout).codemux.model).toBe("opus");
  });
});
