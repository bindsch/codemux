import { describe, test, expect } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeAdapter } from "../src/adapters/claude.js";
import { claudeAutonomyFlags } from "../src/claude-autonomy.js";
import { getAdapter } from "../src/adapters/index.js";
import type { RunRequest } from "../src/types.js";

describe("ClaudeAdapter", () => {
  const adapter = new ClaudeAdapter();

  test("has correct id and binary name", () => {
    expect(adapter.id).toBe("claude");
    expect(adapter.binaryName).toBe("claude");
  });

  test("capabilities are correct", () => {
    const caps = adapter.capabilities();
    expect(caps.supportsNonInteractive).toBe(true);
    expect(caps.supportsInteractive).toBe(true);
    expect(caps.supportsModel).toBe(true);
    expect(caps.supportsAutonomy).toBe(true);
    expect(caps.autonomyLevels).toEqual(["read-only", "low", "medium", "high"]);
    expect(caps.supportsEffort).toBe(true);
    expect(caps.effortLevels).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });

  test("buildRunCommand with prompt only", () => {
    const request: RunRequest = { agent: "claude", prompt: "test prompt" };
    const cmd = adapter.buildRunCommand(request);
    expect(cmd).toEqual([
      "claude",
      "-p",
      "--setting-sources",
      "user",
      "--strict-mcp-config",
      "--no-session-persistence",
      "--output-format",
      "json",
    ]);
  });

  test("the envelope is always on, so --result-json adds no flag", () => {
    // The envelope is what makes usage recoverable: these runs pass
    // --no-session-persistence, so no session file exists to read
    // afterward. Plain runs ask for it too and unwrap it in
    // processRunResult; --result-json only stops the unwrap.
    const plain = adapter.buildRunCommand({ agent: "claude", prompt: "test" });
    const enveloped = adapter.buildRunCommand({ agent: "claude", prompt: "test", resultJson: true });
    expect(plain).toEqual(enveloped);
    expect(plain).toContain("--output-format");
  });

  test("claude declares it can return a result envelope", () => {
    expect(adapter.capabilities().supportsResultJson).toBe(true);
  });

  test("--result-json is refused by a harness that cannot do it", () => {
    // Refusing beats running and returning plain text: a caller that asked for usage and got
    // none would record the run as costing nothing.
    const other = getAdapter("aider");
    expect(() =>
      other.validateRunRequest({ agent: "aider", prompt: "test", resultJson: true })
    ).toThrow(/--result-json is unsupported/);
  });

  test("claude declares the spend limit flag", () => {
    expect(adapter.capabilities().budgetLimit).toBe(true);
  });

  test("buildRunCommand carries --max-budget-usd once on plain, hermetic, and result-json runs", () => {
    // Claude Code takes the flag on --print runs (2.1.317), which is this
    // adapter's spawn shape (-p). Neither --safe-mode (hermetic) nor the
    // envelope switch (--result-json) may drop or duplicate it, and the
    // harness receives the one spelling of the parsed number.
    for (const extra of [{}, { hermetic: true }, { resultJson: true }]) {
      const cmd = adapter.buildRunCommand({ agent: "claude", prompt: "t", maxBudgetUsd: 2.5, ...extra });
      expect(cmd.filter((argument) => argument === "--max-budget-usd"), JSON.stringify(extra)).toHaveLength(1);
      expect(cmd[cmd.indexOf("--max-budget-usd") + 1], JSON.stringify(extra)).toBe("2.5");
    }
  });

  test("a provider override run carries the spend limit flag once too", () => {
    // The override changes the environment the child runs in, never the
    // argv path, so the same build carries the cap under it.
    const override = new ClaudeAdapter({
      CODEMUX_CLAUDE_PROVIDER_BASE_URL: "https://provider.test/v1",
      CODEMUX_CLAUDE_PROVIDER_API_KEY: "sk-test",
      CODEMUX_CLAUDE_PROVIDER_MODEL: "glm-5.3",
    });
    const cmd = override.buildRunCommand({ agent: "claude", prompt: "t", maxBudgetUsd: 0.75 });
    expect(cmd.filter((argument) => argument === "--max-budget-usd")).toHaveLength(1);
    expect(cmd[cmd.indexOf("--max-budget-usd") + 1]).toBe("0.75");
  });

  test("a programmatic budget outside the CLI's rule is refused on the value", () => {
    // The CLI parses the flag before a request exists; a programmatic
    // caller can hand over any value, so the shared validator judges the
    // number itself before the capability is read.
    for (const value of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, "5" as unknown as number]) {
      expect(() =>
        adapter.validateRunRequest({ agent: "claude", prompt: "t", maxBudgetUsd: value })
      ).toThrow(/maxBudgetUsd must be a positive amount with at most ten integer digits and two fraction digits/);
    }
    expect(() =>
      adapter.validateRunRequest({ agent: "claude", prompt: "t", maxBudgetUsd: 1.5 })
    ).not.toThrow();
  });

  test("resultJson must be a boolean", () => {
    expect(() =>
      adapter.validateRunRequest({
        agent: "claude",
        prompt: "test",
        resultJson: "yes" as unknown as boolean,
      })
    ).toThrow(/resultJson must be a boolean/);
  });

  test("a wrapper banner is not a result envelope", () => {
    // The round7 finding, restated for the envelope path: a wrapper
    // masking a harness failure can print a banner and exit 0. A banner is
    // not the envelope the launch asked for, so the run fails with the raw
    // stdout kept for inspection.
    const out = adapter.processRunResult(
      { stdout: "wrapper banner\n", stderr: "", exitCode: 0, success: true },
      { agent: "claude", prompt: "t", resultJson: true }
    );
    expect(out.exitCode).toBe(1);
    expect(out.success).toBe(false);
    expect(out.stdout).toBe("wrapper banner\n");
    expect(out.stderr).toContain("printed no result envelope");
    expect(out.stderr).toContain("so this --result-json run carries no codemux block");
  });

  test("a relative passed-through CLAUDE_CONFIG_DIR is refused", () => {
    // Claude Code resolves CLAUDE_CONFIG_DIR against the child's working
    // directory, so a relative value lands the config store somewhere
    // --cwd decides; validation refuses it before launch (the round-8
    // relative-path finding, closed by refusing rather than resolving).
    const prev = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = "relative-profile";
    try {
      expect(() =>
        adapter.validateRunRequest({
          agent: "claude",
          prompt: "t",
          passthroughEnv: ["CLAUDE_CONFIG_DIR"],
        })
      ).toThrow(/CLAUDE_CONFIG_DIR must be an absolute path/);
      expect(() =>
        adapter.validateTuiRequest(undefined, undefined, undefined, undefined, [
          "CLAUDE_CONFIG_DIR",
        ])
      ).toThrow(/CLAUDE_CONFIG_DIR must be an absolute path/);
      // Without the pass-through the value is not the adapter's business.
      expect(() =>
        adapter.validateRunRequest({ agent: "claude", prompt: "t" })
      ).not.toThrow();
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = prev;
    }
  });

  test("a whitespace-padded CLAUDE_CONFIG_DIR is refused, not trimmed absolute", () => {
    // Round10: validation trimmed the value before the absolute check, so
    // " /var/claude-profile" passed while the installed binary -- which
    // reads the variable without trimming -- resolved it relative against
    // the run's working directory. The check reads the exact value the
    // child receives; only the literal empty string is no redirect.
    const prev = process.env.CLAUDE_CONFIG_DIR;
    try {
      for (const padded of [" /var/claude-profile", "relative-profile ", "\trelative"]) {
        process.env.CLAUDE_CONFIG_DIR = padded;
        expect(() =>
          adapter.validateRunRequest({
            agent: "claude",
            prompt: "t",
            passthroughEnv: ["CLAUDE_CONFIG_DIR"],
          })
        ).toThrow(/CLAUDE_CONFIG_DIR must be an absolute path/);
        expect(() =>
          adapter.validateTuiRequest(undefined, undefined, undefined, undefined, [
            "CLAUDE_CONFIG_DIR",
          ])
        ).toThrow(/CLAUDE_CONFIG_DIR must be an absolute path/);
      }
      process.env.CLAUDE_CONFIG_DIR = "";
      expect(() =>
        adapter.validateRunRequest({
          agent: "claude",
          prompt: "t",
          passthroughEnv: ["CLAUDE_CONFIG_DIR"],
        })
      ).not.toThrow();
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = prev;
    }
  });

  test("an absolute CLAUDE_CONFIG_DIR with surrounding whitespace is refused", () => {
    // Round13: the docs promised every padded value is refused, but the
    // check caught only padding that made the value relative (" /var/x") --
    // POSIX isAbsolute reads just the first character, so "/var/x " passed
    // absolute and the harness would keep the space, landing the config
    // store in a directory literally named "/var/x ". The padding itself
    // is refused now, at both boundaries.
    const prev = process.env.CLAUDE_CONFIG_DIR;
    try {
      for (const padded of ["/var/claude-profile ", "/var/claude-profile\t"]) {
        process.env.CLAUDE_CONFIG_DIR = padded;
        expect(() =>
          adapter.validateRunRequest({
            agent: "claude",
            prompt: "t",
            passthroughEnv: ["CLAUDE_CONFIG_DIR"],
          })
        ).toThrow(/CLAUDE_CONFIG_DIR must not be whitespace-padded/);
        expect(() =>
          adapter.validateTuiRequest(undefined, undefined, undefined, undefined, [
            "CLAUDE_CONFIG_DIR",
          ])
        ).toThrow(/CLAUDE_CONFIG_DIR must not be whitespace-padded/);
      }
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = prev;
    }
  });

  test("buildRunCommand with model", () => {
    const request: RunRequest = { agent: "claude", prompt: "test", model: "opus" };
    const cmd = adapter.buildRunCommand(request);
    expect(cmd).toEqual([
      "claude",
      "-p",
      "--setting-sources",
      "user",
      "--strict-mcp-config",
      "--no-session-persistence",
      "--output-format",
      "json",
      "--model",
      "opus",
    ]);
  });

  test("buildRunCommand with autonomy levels", () => {
    expect(adapter.buildRunCommand({ agent: "claude", prompt: "t", autonomy: "read-only" }))
      .toEqual(["claude", "-p", "--setting-sources", "user", "--strict-mcp-config", "--no-session-persistence", "--output-format", "json", "--permission-mode", "plan", "--allowedTools", "WebSearch", "WebFetch"]);
    expect(adapter.buildRunCommand({ agent: "claude", prompt: "t", autonomy: "low" }))
      .toEqual(["claude", "-p", "--setting-sources", "user", "--strict-mcp-config", "--no-session-persistence", "--output-format", "json", "--permission-mode", "manual", "--allowedTools", "WebSearch", "WebFetch"]);
    // A real directory, so the grant's canonicalization is exercised and
    // the expectation stays stable regardless of /tmp symlinking.
    const grantWksp = realpathSync(mkdtempSync(join(tmpdir(), "codemux-grant-")));
    try {
      expect(adapter.buildRunCommand({ agent: "claude", prompt: "t", autonomy: "medium", cwd: grantWksp }))
        .toEqual(["claude", "-p", "--setting-sources", "user", "--strict-mcp-config", "--no-session-persistence", "--output-format", "json", "--permission-mode", "acceptEdits", "--allowedTools", `Edit(//${grantWksp.replace(/^\/+/, "")}/**)`, "Bash", "WebSearch", "WebFetch"]);
    } finally {
      rmSync(grantWksp, { recursive: true, force: true });
    }
    expect(adapter.buildRunCommand({ agent: "claude", prompt: "t", autonomy: "high" }))
      .toEqual(["claude", "-p", "--setting-sources", "user", "--strict-mcp-config", "--no-session-persistence", "--output-format", "json", "--dangerously-skip-permissions", "--allowedTools", "Edit", "Write", "NotebookEdit", "Bash", "WebSearch", "WebFetch"]);
  });

  test("buildRunCommand does not inject an MCP server by default", () => {
    const cmd = adapter.buildRunCommand({ agent: "claude", prompt: "t", sandboxed: true });
    expect(cmd).toEqual([
      "claude",
      "-p",
      "--setting-sources",
      "user",
      "--strict-mcp-config",
      "--no-session-persistence",
      "--output-format",
      "json",
    ]);
  });

  test("the run request validator refuses the Playwright option without the sandbox", () => {
    // Review round 147: the CLI's rule lives in the shared validator, so a
    // programmatic request meets it too, with the CLI's wording.
    expect(() => adapter.validateRunRequest({ agent: "claude", prompt: "t", enablePlaywrightMcp: true }))
      .toThrow("--enable-playwright-mcp requires --sandbox");
    // With the sandbox the request validates; the sandboxed-TUI path runs
    // this same request, so the TUI validator cannot carry the sandbox rule.
    expect(() => adapter.validateRunRequest({
      agent: "claude", prompt: "t", sandboxed: true, enablePlaywrightMcp: true,
    })).not.toThrow();
    expect(() => adapter.validateTuiRequest(undefined, undefined, undefined, undefined, [], true))
      .not.toThrow();
    // A hermetic run starts with MCP servers off and a run with no tools
    // cannot call one: the CLI's third rule, in the shared validator too.
    for (const extra of [{ hermetic: true }, { tools: "none" as const }]) {
      expect(() => adapter.validateRunRequest({
        agent: "claude", prompt: "t", sandboxed: true, enablePlaywrightMcp: true, ...extra,
      })).toThrow("--hermetic and --tools none cannot be combined with --enable-playwright-mcp");
    }
  });

  test("a run with the Playwright option but no sandbox keeps the every-customization-off baseline", () => {
    // Review round 147: the validators refuse that combination first; this
    // is the fail-closed command a caller that reaches the builder directly
    // gets — --safe-mode, no settings sources, no MCP configuration.
    const cmd = adapter.buildRunCommand({ agent: "claude", prompt: "t", enablePlaywrightMcp: true });
    expect(cmd).toEqual([
      "claude",
      "-p",
      "--safe-mode",
      "--no-session-persistence",
      "--output-format",
      "json",
    ]);
  });

  test("a sandboxed run with the Playwright option attaches the server through the settings branch", () => {
    // Review round 147, unchanged opt-in: the settings branch is selected by
    // what the MCP build attached, and the binary the build resolved rides
    // the --mcp-config argument.
    const root = mkdtempSync(join(tmpdir(), "codemux-run-mcp-opt-in-"));
    const cwd = join(root, "work");
    const binary = join(root, "playwright-mcp");
    mkdirSync(cwd);
    writeFileSync(binary, "#!/bin/sh\nexit 0\n");
    chmodSync(binary, 0o755);
    const originalPath = process.env.PATH;
    process.env.PATH = `${root}:${originalPath ?? ""}`;
    try {
      const cmd = adapter.buildRunCommand({
        agent: "claude", prompt: "t", sandboxed: true, enablePlaywrightMcp: true, cwd,
      });
      expect(cmd).toContain("--setting-sources");
      expect(cmd).toContain("--strict-mcp-config");
      expect(cmd).not.toContain("--safe-mode");
      const config = cmd[cmd.indexOf("--mcp-config") + 1] ?? "";
      expect(JSON.parse(config).mcpServers.playwright.command).toBe(realpathSync(binary));
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a TUI command with the Playwright option but no sandbox keeps --safe-mode", () => {
    // Review round 147: unsandboxed launches never select the user settings
    // source; the branch is chosen by what the MCP build attached, and an
    // unsandboxed build attaches nothing.
    const cmd = adapter.buildTuiCommand(undefined, undefined, undefined, false, true, process.cwd());
    expect(cmd).toEqual(["claude", "--safe-mode"]);
  });

  test("scrubs project hook subprocess environments", () => {
    expect(adapter.getEnv()).toEqual({
      CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: "1",
    });
  });

  test("getStdinInput returns prompt", () => {
    const request: RunRequest = { agent: "claude", prompt: "my prompt" };
    expect(adapter.getStdinInput(request)).toBe("my prompt");
  });

  test("buildTuiCommand basic", () => {
    expect(adapter.buildTuiCommand()).toEqual(["claude", "--safe-mode"]);
  });

  test("buildTuiCommand with model", () => {
    expect(adapter.buildTuiCommand("opus")).toEqual(["claude", "--safe-mode", "--model", "opus"]);
  });

  test("buildTuiCommand with autonomy", () => {
    expect(adapter.buildTuiCommand(undefined, "high")).toEqual(["claude", "--safe-mode", "--dangerously-skip-permissions"]);
    expect(adapter.buildTuiCommand("opus", "medium")).toEqual(["claude", "--safe-mode", "--model", "opus", "--permission-mode", "acceptEdits"]);
  });

  test("buildTuiCommand does not inject an MCP server by default", () => {
    const cmd = adapter.buildTuiCommand("opus", "high", undefined, true);
    expect(cmd).toEqual([
      "claude",
      "--safe-mode",
      "--model",
      "opus",
      "--dangerously-skip-permissions",
    ]);
  });

  test("TUI Playwright MCP rejects a binary inside the requested cwd", () => {
    const cwd = mkdtempSync(join(tmpdir(), "codemux-tui-mcp-"));
    const binary = join(cwd, "playwright-mcp");
    writeFileSync(binary, "#!/bin/sh\nexit 0\n");
    chmodSync(binary, 0o755);
    const originalPath = process.env.PATH;
    process.env.PATH = `${cwd}:${originalPath ?? ""}`;
    try {
      expect(() => adapter.buildTuiCommand(
        "opus",
        "high",
        undefined,
        true,
        true,
        cwd
      )).toThrow("inside the execution working directory");
    } finally {
      if (originalPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = originalPath;
      }
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("TUI Playwright MCP keeps project settings isolated without safe mode", () => {
    const root = mkdtempSync(join(tmpdir(), "codemux-tui-mcp-opt-in-"));
    const cwd = join(root, "work");
    const binary = join(root, "playwright-mcp");
    mkdirSync(cwd);
    writeFileSync(binary, "#!/bin/sh\nexit 0\n");
    chmodSync(binary, 0o755);
    const originalPath = process.env.PATH;
    process.env.PATH = `${root}:${originalPath ?? ""}`;
    try {
      const cmd = adapter.buildTuiCommand(
        "opus",
        "high",
        undefined,
        true,
        true,
        cwd
      );
      expect(cmd).toContain("--setting-sources");
      expect(cmd).toContain("--strict-mcp-config");
      expect(cmd).toContain("--mcp-config");
      expect(cmd).not.toContain("--safe-mode");
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("mapAutonomy returns correct flags", () => {
    expect(adapter.mapAutonomy("read-only")).toEqual(["--permission-mode", "plan"]);
    expect(adapter.mapAutonomy("low")).toEqual(["--permission-mode", "manual"]);
    expect(adapter.mapAutonomy("medium")).toEqual(["--permission-mode", "acceptEdits"]);
    expect(adapter.mapAutonomy("high")).toEqual(["--dangerously-skip-permissions"]);
  });

  test("--no-web denies the web tools at every level, which holds under bypass and over saved approvals", () => {
    expect(adapter.buildRunCommand({ agent: "claude", prompt: "t", autonomy: "read-only", web: false }))
      .toEqual(["claude", "-p", "--setting-sources", "user", "--strict-mcp-config", "--no-session-persistence", "--output-format", "json",
        "--permission-mode", "plan", "--disallowedTools", "WebSearch", "WebFetch"]);
    const high = adapter.buildRunCommand({ agent: "claude", prompt: "t", autonomy: "high", web: false });
    expect(high.slice(high.indexOf("--allowedTools") + 1)).toEqual(["Edit", "Write", "NotebookEdit", "Bash", "--disallowedTools", "WebSearch", "WebFetch"]);
    expect(high).toContain("--dangerously-skip-permissions");
    for (const level of ["low", "medium"] as const) {
      const flags = adapter.buildRunCommand({ agent: "claude", prompt: "t", autonomy: level, cwd: "/tmp/plain", web: false });
      expect(flags.slice(flags.indexOf("--disallowedTools"))).toEqual(["--disallowedTools", "WebSearch", "WebFetch"]);
      expect(flags.filter((flag) => flag === "WebFetch")).toHaveLength(1);
    }
  });

  test("the TUI mapping grants no tools; headless read-only and low grant only the web tools", () => {
    // Allow rules bypass mode checks: in the TUI a human approves, so no
    // rule rides there; headless, every level grants the two read-only web
    // tools the hardening would otherwise deny, and nothing that writes.
    expect(adapter.mapAutonomy("read-only")).not.toContain("--allowedTools");
    expect(adapter.mapAutonomy("low")).not.toContain("--allowedTools");
    for (const level of ["read-only", "low"] as const) {
      const flags = claudeAutonomyFlags(level, "/tmp/launch");
      expect(flags.slice(flags.indexOf("--allowedTools") + 1)).toEqual(["WebSearch", "WebFetch"]);
    }
  });
});
