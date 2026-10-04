import { describe, test, expect } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { ClaudeAdapter } from "../src/adapters/claude.js";
import { CodexAdapter } from "../src/adapters/codex.js";
import { DroidAdapter } from "../src/adapters/droid.js";
import { GooseAdapter } from "../src/adapters/goose.js";
import {
  GEMINI_SYSTEM_SETTINGS_PATH,
  GeminiAdapter,
} from "../src/adapters/gemini.js";
import { OpencodeAdapter } from "../src/adapters/opencode.js";
import { PiAdapter } from "../src/adapters/pi.js";
import { QwenAdapter } from "../src/adapters/qwen.js";
import { ZaiAdapter } from "../src/adapters/zai.js";
import { launchRunRequest } from "../src/launch.js";
import {
  AGENT_IDS,
  getAdapter,
  getAllAdapters,
  getAvailableAdapters,
} from "../src/adapters/index.js";
import type { RunContext } from "../src/adapters/base.js";
import { BaseAdapter } from "../src/adapters/base.js";
import type { AdapterCapabilities, RunRequest } from "../src/types.js";

describe("Adapter Registry", () => {
  test("AGENT_IDS contains all expected agents", () => {
    expect(AGENT_IDS).toContain("claude");
    expect(AGENT_IDS).toContain("codex");
    expect(AGENT_IDS).toContain("droid");
    expect(AGENT_IDS).toContain("goose");
    expect(AGENT_IDS).toContain("gemini");
    expect(AGENT_IDS).toContain("opencode");
    expect(AGENT_IDS).toContain("pi");
    expect(AGENT_IDS).toContain("qwen");
    expect(AGENT_IDS).toContain("zai");
    expect(AGENT_IDS).toContain("kimi");
    expect(AGENT_IDS).toContain("openhands");
    expect(AGENT_IDS.length).toBe(15);
  });

  test("every agent id resolves to an adapter that reports that id", () => {
    // The per-class assertions below cover a subset by hand; this one closes
    // the gap for the whole set, so a new agent cannot be registered without
    // a working adapter behind it.
    for (const id of AGENT_IDS) {
      expect(getAdapter(id).id, id).toBe(id);
    }
  });

  test("getAdapter returns correct adapter for each agent", () => {
    expect(getAdapter("claude")).toBeInstanceOf(ClaudeAdapter);
    expect(getAdapter("codex")).toBeInstanceOf(CodexAdapter);
    expect(getAdapter("droid")).toBeInstanceOf(DroidAdapter);
    expect(getAdapter("goose")).toBeInstanceOf(GooseAdapter);
    expect(getAdapter("gemini")).toBeInstanceOf(GeminiAdapter);
    expect(getAdapter("opencode")).toBeInstanceOf(OpencodeAdapter);
    expect(getAdapter("pi")).toBeInstanceOf(PiAdapter);
    expect(getAdapter("qwen")).toBeInstanceOf(QwenAdapter);
    expect(getAdapter("zai")).toBeInstanceOf(ZaiAdapter);
  });

  test("getAdapter throws for unknown agent", () => {
    expect(() => getAdapter("unknown" as any)).toThrow("Unknown agent: unknown");
  });

  test("getAllAdapters returns all 15 adapters", () => {
    const adapters = getAllAdapters();
    expect(adapters.length).toBe(15);
  });

  test("getAvailableAdapters filters by executable availability", () => {
    const available = getAvailableAdapters();
    expect(available.every((adapter) => adapter.isAvailable())).toBe(true);
  });
});

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
    ]);
  });

  test("--result-json asks Claude Code for its single-result envelope", () => {
    // Without it the reply is bare text and what the run consumed is unrecoverable: these runs
    // pass --no-session-persistence, so no session file exists to read afterward.
    const request: RunRequest = { agent: "claude", prompt: "test", resultJson: true };
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

  test("the envelope is off unless asked for", () => {
    const cmd = adapter.buildRunCommand({ agent: "claude", prompt: "test" });
    expect(cmd).not.toContain("--output-format");
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
      "--model",
      "opus",
    ]);
  });

  test("buildRunCommand with autonomy levels", () => {
    expect(adapter.buildRunCommand({ agent: "claude", prompt: "t", autonomy: "read-only" }))
      .toEqual(["claude", "-p", "--setting-sources", "user", "--strict-mcp-config", "--no-session-persistence", "--permission-mode", "plan"]);
    expect(adapter.buildRunCommand({ agent: "claude", prompt: "t", autonomy: "low" }))
      .toEqual(["claude", "-p", "--setting-sources", "user", "--strict-mcp-config", "--no-session-persistence", "--permission-mode", "manual"]);
    // A real directory, so the grant's canonicalization is exercised and
    // the expectation stays stable regardless of /tmp symlinking.
    const grantWksp = realpathSync(mkdtempSync(join(tmpdir(), "codemux-grant-")));
    try {
      expect(adapter.buildRunCommand({ agent: "claude", prompt: "t", autonomy: "medium", cwd: grantWksp }))
        .toEqual(["claude", "-p", "--setting-sources", "user", "--strict-mcp-config", "--no-session-persistence", "--permission-mode", "acceptEdits", "--allowedTools", `Edit(//${grantWksp.replace(/^\/+/, "")}/**)`]);
    } finally {
      rmSync(grantWksp, { recursive: true, force: true });
    }
    expect(adapter.buildRunCommand({ agent: "claude", prompt: "t", autonomy: "high" }))
      .toEqual(["claude", "-p", "--setting-sources", "user", "--strict-mcp-config", "--no-session-persistence", "--dangerously-skip-permissions", "--allowedTools", "Edit", "Write", "NotebookEdit", "Bash"]);
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
    ]);
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

  test("read-only and low grant no tools", () => {
    // Allow rules bypass mode checks, so they must ride only on
    // write-capable levels.
    expect(adapter.mapAutonomy("read-only")).not.toContain("--allowedTools");
    expect(adapter.mapAutonomy("low")).not.toContain("--allowedTools");
  });
});

describe("DroidAdapter", () => {
  const adapter = new DroidAdapter();

  test("has correct id and binary name", () => {
    expect(adapter.id).toBe("droid");
    expect(adapter.binaryName).toBe("droid");
  });

  test("capabilities are correct", () => {
    const caps = adapter.capabilities();
    expect(caps.supportsNonInteractive).toBe(true);
    expect(caps.supportsInteractive).toBe(true);
    expect(caps.supportsModel).toBe(true);
    expect(caps.supportsAutonomy).toBe(true);
    expect(caps.autonomyLevels).toEqual(["read-only", "low", "medium", "high"]);
    expect(caps.supportsEffort).toBe(true);
    expect(caps.effortLevels).toEqual(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);
  });

  test("buildRunCommand with prompt only", () => {
    const request: RunRequest = { agent: "droid", prompt: "test prompt" };
    const cmd = adapter.buildRunCommand(request);
    expect(cmd).toEqual(["droid", "exec"]);
  });

  test("buildRunCommand with model", () => {
    const request: RunRequest = { agent: "droid", prompt: "test", model: "gpt-5.1" };
    const cmd = adapter.buildRunCommand(request);
    expect(cmd).toEqual(["droid", "exec", "-m", "gpt-5.1"]);
  });

  test("buildRunCommand with autonomy levels", () => {
    expect(adapter.buildRunCommand({ agent: "droid", prompt: "t", autonomy: "read-only" }))
      .toEqual(["droid", "exec"]);
    expect(adapter.buildRunCommand({ agent: "droid", prompt: "t", autonomy: "low" }))
      .toEqual(["droid", "exec", "--auto", "low"]);
    expect(adapter.buildRunCommand({ agent: "droid", prompt: "t", autonomy: "medium" }))
      .toEqual(["droid", "exec", "--auto", "medium"]);
    expect(adapter.buildRunCommand({ agent: "droid", prompt: "t", autonomy: "high" }))
      .toEqual(["droid", "exec", "--auto", "high"]);
  });

  test("buildRunCommand with effort levels", () => {
    expect(adapter.buildRunCommand({ agent: "droid", prompt: "t", effort: "none" }))
      .toEqual(["droid", "exec", "--reasoning-effort", "off"]);
    expect(adapter.buildRunCommand({ agent: "droid", prompt: "t", effort: "low" }))
      .toEqual(["droid", "exec", "--reasoning-effort", "low"]);
    expect(adapter.buildRunCommand({ agent: "droid", prompt: "t", effort: "medium" }))
      .toEqual(["droid", "exec", "--reasoning-effort", "medium"]);
    expect(adapter.buildRunCommand({ agent: "droid", prompt: "t", effort: "high" }))
      .toEqual(["droid", "exec", "--reasoning-effort", "high"]);
  });

  test("uses the model-specific no-reasoning value", () => {
    expect(adapter.buildRunCommand({
      agent: "droid",
      prompt: "t",
      model: "gpt-5.6-sol",
      effort: "none",
    })).toContain("none");
    expect(adapter.buildRunCommand({
      agent: "droid",
      prompt: "t",
      model: "claude-opus-5",
      effort: "none",
    })).toContain("off");
  });

  test("buildRunCommand with all options", () => {
    const request: RunRequest = {
      agent: "droid",
      prompt: "test",
      model: "gpt-5.1",
      autonomy: "medium",
      effort: "high",
    };
    const cmd = adapter.buildRunCommand(request);
    expect(cmd).toEqual(["droid", "exec", "-m", "gpt-5.1", "--auto", "medium", "--reasoning-effort", "high"]);
  });

  test("getStdinInput returns prompt", () => {
    const request: RunRequest = { agent: "droid", prompt: "my prompt" };
    expect(adapter.getStdinInput(request)).toBe("my prompt");
  });

  test("buildTuiCommand basic", () => {
    expect(adapter.buildTuiCommand()).toEqual(["droid"]);
  });

  test("buildTuiCommand with model", () => {
    expect(adapter.buildTuiCommand("gpt-5.1")).toEqual(["droid"]);
  });

  test("buildTuiCommand with autonomy", () => {
    expect(adapter.buildTuiCommand(undefined, "high")).toEqual(["droid", "--auto", "high"]);
    expect(adapter.buildTuiCommand("gpt-5.1", "low")).toEqual(["droid", "--auto", "low"]);
  });

  test("buildTuiCommand with effort", () => {
    expect(adapter.buildTuiCommand(undefined, undefined, "high")).toEqual(["droid"]);
    expect(adapter.buildTuiCommand("gpt-5.1", undefined, "medium")).toEqual(["droid"]);
  });

  test("TUI rejects unsupported model and effort flags", () => {
    expect(adapter.supportsTuiModel()).toBe(false);
    expect(adapter.supportsTuiEffort()).toBe(false);
  });

  test("mapAutonomy returns correct flags", () => {
    expect(adapter.mapAutonomy("read-only")).toEqual([]);
    expect(adapter.mapAutonomy("low")).toEqual(["--auto", "low"]);
    expect(adapter.mapAutonomy("medium")).toEqual(["--auto", "medium"]);
    expect(adapter.mapAutonomy("high")).toEqual(["--auto", "high"]);
  });

  test("mapEffort returns correct flags", () => {
    expect(adapter.mapEffort("none")).toEqual(["--reasoning-effort", "off"]);
    expect(adapter.mapEffort("low")).toEqual(["--reasoning-effort", "low"]);
    expect(adapter.mapEffort("medium")).toEqual(["--reasoning-effort", "medium"]);
    expect(adapter.mapEffort("high")).toEqual(["--reasoning-effort", "high"]);
  });
});

describe("CodexAdapter", () => {
  const adapter = new CodexAdapter();

  test("has correct id and binary name", () => {
    expect(adapter.id).toBe("codex");
    expect(adapter.binaryName).toBe("codex");
  });

  test("a whitespace-padded passed-through CODEX_HOME is refused, not trimmed", () => {
    // The round10 CLAUDE_CONFIG_DIR rule applied to this sibling boundary:
    // codex reads CODEX_HOME without trimming, so a padded value is
    // relative at launch and validating a trimmed copy would wave it
    // through. Validation owns the refusal, and both launch paths validate
    // before prepareRun creates the run's .codemux-scratch/ directory under
    // CODEX_HOME (back there since round27), so a refused value never
    // touches disk.
    const padded = new CodexAdapter({ CODEX_HOME: " /tmp/codex-profile" });
    expect(() =>
      padded.validateRunRequest({
        agent: "codex",
        prompt: "t",
        resultJson: true,
        passthroughEnv: ["CODEX_HOME"],
      })
    ).toThrow(/CODEX_HOME must be an absolute path/);
  });

  test("an absolute CODEX_HOME with surrounding whitespace is refused", () => {
    // Round13, the CLAUDE_CONFIG_DIR rule's sibling: isAbsolute reads only
    // the leading character, so "/tmp/codex-profile " passed absolute while
    // codex -- which does not trim the variable -- would keep the space and
    // put the harness state in a padded directory name. The padding itself
    // is refused now, matching what the docs already claimed.
    const padded = new CodexAdapter({ CODEX_HOME: "/tmp/codex-profile " });
    expect(() =>
      padded.validateRunRequest({
        agent: "codex",
        prompt: "t",
        resultJson: true,
        passthroughEnv: ["CODEX_HOME"],
      })
    ).toThrow(/CODEX_HOME must not be whitespace-padded/);
  });

  test("capabilities are correct", () => {
    const caps = adapter.capabilities();
    expect(caps.supportsNonInteractive).toBe(true);
    expect(caps.supportsInteractive).toBe(true);
    expect(caps.supportsModel).toBe(true);
    expect(caps.supportsAutonomy).toBe(true);
    expect(caps.autonomyLevels).toEqual(["read-only", "low", "medium", "high"]);
    expect(caps.supportsEffort).toBe(true);
    expect(caps.effortLevels).toEqual(["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);
  });

  test("buildRunCommand with prompt only", () => {
    const request: RunRequest = { agent: "codex", prompt: "test prompt" };
    const cmd = adapter.buildRunCommand(request);
    expect(cmd).toEqual(["codex", "exec", "--skip-git-repo-check", "--ephemeral", "--ignore-rules", "-"]);
  });

  test("buildRunCommand with model", () => {
    const request: RunRequest = { agent: "codex", prompt: "test", model: "gpt-5.1" };
    const cmd = adapter.buildRunCommand(request);
    expect(cmd).toEqual(["codex", "-m", "gpt-5.1", "exec", "--skip-git-repo-check", "--ephemeral", "--ignore-rules", "-"]);
  });

  test("buildRunCommand with autonomy levels", () => {
    // The approval policy rides on -c, not -a: an -a before `exec` is
    // dropped by codex's root-to-exec handoff and 0.159.x accepts only
    // on-request|never there anyway, while the config override reaches
    // exec, exec resume, and the TUI alike.
    expect(adapter.buildRunCommand({ agent: "codex", prompt: "t", autonomy: "read-only" }))
      .toEqual(["codex", "-s", "read-only", "-c", 'approval_policy="never"', "exec", "--skip-git-repo-check", "--ephemeral", "--ignore-rules", "-"]);
    expect(adapter.buildRunCommand({ agent: "codex", prompt: "t", autonomy: "low" }))
      .toEqual(["codex", "-s", "workspace-write", "-c", 'approval_policy="untrusted"', "exec", "--skip-git-repo-check", "--ephemeral", "--ignore-rules", "-"]);
    expect(adapter.buildRunCommand({ agent: "codex", prompt: "t", autonomy: "medium" }))
      .toEqual(["codex", "-s", "workspace-write", "-c", 'approval_policy="never"', "exec", "--skip-git-repo-check", "--ephemeral", "--ignore-rules", "-"]);
    expect(adapter.buildRunCommand({ agent: "codex", prompt: "t", autonomy: "high" }))
      .toEqual(["codex", "-s", "danger-full-access", "-c", 'approval_policy="never"', "exec", "--skip-git-repo-check", "--ephemeral", "--ignore-rules", "-"]);
  });

  test("buildRunCommand with effort levels", () => {
    expect(adapter.buildRunCommand({ agent: "codex", prompt: "t", effort: "low" }))
      .toEqual(["codex", "-c", 'model_reasoning_effort="low"', "exec", "--skip-git-repo-check", "--ephemeral", "--ignore-rules", "-"]);
    expect(adapter.buildRunCommand({ agent: "codex", prompt: "t", effort: "medium" }))
      .toEqual(["codex", "-c", 'model_reasoning_effort="medium"', "exec", "--skip-git-repo-check", "--ephemeral", "--ignore-rules", "-"]);
    expect(adapter.buildRunCommand({ agent: "codex", prompt: "t", effort: "high" }))
      .toEqual(["codex", "-c", 'model_reasoning_effort="high"', "exec", "--skip-git-repo-check", "--ephemeral", "--ignore-rules", "-"]);
  });

  test("buildRunCommand with external sandbox bypasses codex sandbox flags", () => {
    const cmd = adapter.buildRunCommand({
      agent: "codex",
      prompt: "t",
      autonomy: "high",
      sandboxed: true,
    });
    expect(cmd).toEqual([
      "codex",
      "--dangerously-bypass-approvals-and-sandbox",
      "exec",
      "--skip-git-repo-check",
      "--ephemeral",
      "--ignore-rules",
      "-",
    ]);
  });

  test("getStdinInput returns prompt", () => {
    const request: RunRequest = { agent: "codex", prompt: "my prompt" };
    expect(adapter.getStdinInput(request)).toBe("my prompt");
  });

  test("codex declares it can return a result envelope", () => {
    expect(adapter.capabilities().supportsResultJson).toBe(true);
  });

  test("--result-json asks for the JSONL event stream and the recorded final message", () => {
    // The --output-last-message path a buildRunCommand without prepareRun
    // names: under the real CODEX_HOME's .codemux-scratch/, where prepareRun
    // puts the real per-run file, with the unprepared marker standing where
    // the per-run directory would be (the same fail-closed shape the
    // hermetic home's preview uses).
    const home = mkdtempSync(join(tmpdir(), "codemux-codex-"));
    try {
      const scoped = new CodexAdapter({}, home);
      const cmd = scoped.buildRunCommand({ agent: "codex", prompt: "t", resultJson: true });
      expect(cmd).toEqual([
        "codex",
        "exec",
        "--skip-git-repo-check",
        "--ephemeral",
        "--ignore-rules",
        "--json",
        "--output-last-message",
        join(home, ".codex", ".codemux-scratch", "unprepared", "last-message"),
        "-",
      ]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("the event stream is off unless asked for", () => {
    const cmd = adapter.buildRunCommand({ agent: "codex", prompt: "t" });
    expect(cmd).not.toContain("--json");
  });

  test("processRunResult reduces the event stream to the envelope", () => {
    const stream = [
      { type: "thread.started", thread_id: "0192b8d4-4d4f-7c4a-9d0e-6f5a4b3c2d1e" },
      { type: "turn.started" },
      {
        type: "item.completed",
        item: { id: "item_0", type: "agent_message", text: "the reply" },
      },
      {
        type: "turn.completed",
        usage: {
          input_tokens: 10,
          cached_input_tokens: 4,
          cache_write_input_tokens: 0,
          output_tokens: 6,
          reasoning_output_tokens: 0,
        },
      },
    ].map((line) => JSON.stringify(line)).join("\n") + "\n";
    const out = adapter.processRunResult(
      { stdout: stream, stderr: "", exitCode: 0, success: true },
      { agent: "codex", prompt: "t", resultJson: true }
    );
    const envelope = JSON.parse(out.stdout);
    expect(envelope.result).toBe("the reply");
    expect(envelope.codemux.agent).toBe("codex");
    // The run launched with --ephemeral, so the thread id the stream named
    // is not one a later run could continue: null.
    expect(envelope.codemux.session_id).toBeNull();
    expect(envelope.codemux.usage.total_tokens).toBe(16);
  });

  test("processRunResult leaves stdout alone without --result-json", () => {
    const result = { stdout: "the reply\n", stderr: "", exitCode: 0, success: true };
    expect(adapter.processRunResult(result, { agent: "codex", prompt: "t" })).toBe(result);
  });

  test("a plan-only turn succeeds through the recorded final message", () => {
    // The finding's reproduction at the adapter seam: the stream carries a
    // complete turn with no agent_message (codex's mapper drops the Plan
    // item), and the file the launch told codex to write
    // (--output-last-message, in this run's own scratch directory under the
    // real CODEX_HOME) carries the message. Without it this valid completed
    // run exited 1.
    const home = mkdtempSync(join(tmpdir(), "codemux-codex-"));
    try {
      const codexHome = join(home, ".codex");
      mkdirSync(codexHome);
      const prepared = new CodexAdapter({}, home);
      const request: RunRequest = {
        agent: "codex",
        prompt: "t",
        resultJson: true,
      };
      const context = prepared.prepareRun(request);
      // The argv names this run's own file under the CODEX_HOME scratch
      // root -- never the unprepared placeholder -- and the directory is
      // unique to this run.
      const argv = prepared.buildRunCommand(request, context);
      const flag = argv.indexOf("--output-last-message");
      expect(flag).toBeGreaterThanOrEqual(0);
      const lastMessageFile = argv[flag + 1]!;
      expect(lastMessageFile.startsWith(join(codexHome, ".codemux-scratch"))).toBe(true);
      expect(lastMessageFile).not.toContain("unprepared");
      const other = new CodexAdapter({}, home);
      const otherContext = other.prepareRun(request);
      const otherArgv = other.buildRunCommand(request, otherContext);
      expect(
        otherArgv[otherArgv.indexOf("--output-last-message") + 1]
      ).not.toBe(lastMessageFile);
      // What codex would have written: the Plan it treats as the final
      // message even though the JSONL stream never carries it.
      writeFileSync(lastMessageFile, "1. Inspect the tree.\n2. Plan the change.");
      const stream = [
        { type: "thread.started", thread_id: "0192b8d4-4d4f-7c4a-9d0e-6f5a4b3c2d1e" },
        { type: "turn.started" },
        { type: "item.completed", item: { id: "item_0", type: "reasoning", text: "thinking" } },
        { type: "turn.completed", usage: { input_tokens: 10, output_tokens: 2 } },
      ].map((line) => JSON.stringify(line)).join("\n") + "\n";
      const out = prepared.processRunResult(
        { stdout: stream, stderr: "", exitCode: 0, success: true },
        request,
        context
      );
      expect(out.success).toBe(true);
      expect(out.exitCode).toBe(0);
      expect(JSON.parse(out.stdout).result).toBe("1. Inspect the tree.\n2. Plan the change.");
      expect(out.stderr).toContain("final message codex recorded itself");
      // The file is consumed, not left behind.
      expect(existsSync(lastMessageFile)).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("a plain run's fallback file lives in a per-run scratch directory under the real CODEX_HOME", () => {
    // The round27 major: with the file under the OS temp root, scode's
    // Linux sandbox mounted a fresh /tmp over the parent's, so a sandboxed
    // run's fallback never surfaced and a successful Plan-only
    // --result-json run exited 1 with a null result. The file now lives
    // under the real CODEX_HOME (.codemux-scratch/), harness state scode
    // keeps writable on every platform and never shadows.
    const home = mkdtempSync(join(tmpdir(), "codemux-codex-"));
    const scratchDirs: string[] = [];
    try {
      mkdirSync(join(home, ".codex"));
      const adapter = new CodexAdapter({ CODEX_API_KEY: "sk-test" }, home);
      const request: RunRequest = { agent: "codex", prompt: "t", resultJson: true };
      // A direct launch passes no trust and a standard-trust sandboxed one
      // resolves "standard": both are the plain branch and both land in the
      // scratch root, each in its own per-run directory.
      const direct = adapter.prepareRun(request);
      scratchDirs.push(direct.lastMessageDir!);
      const directArgv = adapter.buildRunCommand(request, direct);
      const directFile = directArgv[directArgv.indexOf("--output-last-message") + 1]!;
      expect(directFile.startsWith(join(home, ".codex", ".codemux-scratch", "run-"))).toBe(true);
      expect(directFile).not.toContain("unprepared");
      expect(dirname(directFile)).toBe(direct.lastMessageDir!);
      const sandboxed = adapter.prepareRun(request, "standard");
      scratchDirs.push(sandboxed.lastMessageDir!);
      const sandboxedArgv = adapter.buildRunCommand(request, sandboxed);
      expect(
        sandboxedArgv[sandboxedArgv.indexOf("--output-last-message") + 1]
      ).not.toBe(directFile);
      // The parent reads the file back at the same path the child wrote --
      // the property the temp-root placement lost under scode's Linux /tmp.
      writeFileSync(directFile, "the plan");
      expect(existsSync(directFile)).toBe(true);
      adapter.cleanupRun(direct);
      adapter.cleanupRun(sandboxed);
      expect(existsSync(direct.lastMessageDir!)).toBe(false);
      // The scratch root itself stays for the next run; only per-run
      // directories go.
      expect(readdirSync(join(home, ".codex", ".codemux-scratch"))).toEqual([]);
    } finally {
      for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("a hermetic run's fallback file lives inside the private home", () => {
    // The hermetic branch of the placement rule: the private home is itself
    // under the real CODEX_HOME, so it follows the same harness-state
    // writability, and finalize removes the file with the home.
    const home = mkdtempSync(join(tmpdir(), "codemux-codex-"));
    try {
      mkdirSync(join(home, ".codex"));
      const adapter = new CodexAdapter({ CODEX_API_KEY: "sk-test" }, home);
      const request: RunRequest = {
        agent: "codex",
        prompt: "t",
        resultJson: true,
        hermetic: true,
      };
      const hermetic = adapter.prepareRun(request);
      const hermeticArgv = adapter.buildRunCommand(request, hermetic);
      const hermeticFile = hermeticArgv[hermeticArgv.indexOf("--output-last-message") + 1]!;
      expect(hermeticFile.startsWith(join(home, ".codex", ".codemux-hermetic"))).toBe(true);
      writeFileSync(hermeticFile, "the plan");
      adapter.cleanupRun(hermetic);
      expect(existsSync(hermeticFile)).toBe(false);
      expect(readdirSync(join(home, ".codex", ".codemux-hermetic"))).toEqual([]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("an untrusted sandbox run passes no fallback file: the stream is the only source", () => {
    // The untrusted branch: that preset denies harness state (and scode's
    // Linux sandbox shadows the temp root), so no location is both writable
    // by the child and readable by the parent. The launch names no
    // --output-last-message file at all, and a Plan-only turn -- the one
    // case the file existed for -- reports a null result, the documented
    // cost (README), instead of silently losing a fallback.
    const home = mkdtempSync(join(tmpdir(), "codemux-codex-"));
    try {
      mkdirSync(join(home, ".codex"));
      const adapter = new CodexAdapter({ CODEX_API_KEY: "sk-test" }, home);
      const request: RunRequest = { agent: "codex", prompt: "t", resultJson: true };
      const context = adapter.prepareRun(request, "untrusted");
      expect(context.lastMessagePath).toBeUndefined();
      expect(context.lastMessageDir).toBeUndefined();
      const argv = adapter.buildRunCommand(request, context);
      expect(argv).toContain("--json");
      expect(argv).not.toContain("--output-last-message");
      // Nothing was created on disk: an untrusted run touches no scratch.
      expect(readdirSync(join(home, ".codex"))).toEqual([]);
      // The Plan-only turn without a fallback: a complete stream whose turn
      // ended messageless fails with no result, not a silent success.
      const stream = [
        { type: "thread.started", thread_id: "0192b8d4-4d4f-7c4a-9d0e-6f5a4b3c2d1e" },
        { type: "turn.started" },
        { type: "item.completed", item: { id: "item_0", type: "reasoning", text: "thinking" } },
        { type: "turn.completed", usage: { input_tokens: 10, output_tokens: 2 } },
      ].map((line) => JSON.stringify(line)).join("\n") + "\n";
      const out = adapter.processRunResult(
        { stdout: stream, stderr: "", exitCode: 0, success: true },
        request,
        context
      );
      expect(out.success).toBe(false);
      expect(out.exitCode).toBe(1);
      expect(JSON.parse(out.stdout).result).toBeNull();
      expect(out.stderr).toContain("ended without a final assistant message");
      // Cleanup of a context with no scratch is a no-op, not an error.
      adapter.cleanupRun(context);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("two concurrent runs keep their own --output-last-message fallback", () => {
    // The round6 finding: the fallback path was a shared adapter field, so
    // run B's prepareRun overwrote run A's; A's completion read and removed
    // B's file (returning B's message) and left B without its fallback, to
    // fail a successful Plan-only turn. The path is this run's own context
    // now, carried by the caller from prepareRun to processRunResult.
    const home = mkdtempSync(join(tmpdir(), "codemux-codex-"));
    const scratchDirs: string[] = [];
    try {
      mkdirSync(join(home, ".codex"));
      const adapter = new CodexAdapter({}, home);
      const planOnlyStream = (threadId: string): string =>
        [
          { type: "thread.started", thread_id: threadId },
          { type: "turn.started" },
          { type: "item.completed", item: { id: "item_0", type: "reasoning", text: "thinking" } },
          { type: "turn.completed", usage: { input_tokens: 10, output_tokens: 2 } },
        ].map((line) => JSON.stringify(line)).join("\n") + "\n";
      const runOutcome = (
        result: { stdout: string; stderr: string; exitCode: number; success: boolean },
        request: RunRequest,
        context: RunContext
      ) => adapter.processRunResult(result, request, context);

      const requestA: RunRequest = {
        agent: "codex",
        prompt: "a",
        resultJson: true,
      };
      const contextA = adapter.prepareRun(requestA);
      scratchDirs.push(contextA.lastMessageDir!);
      const argvA = adapter.buildRunCommand(requestA, contextA);
      const fileA = argvA[argvA.indexOf("--output-last-message") + 1]!;
      writeFileSync(fileA, "A's plan");

      const requestB: RunRequest = {
        agent: "codex",
        prompt: "b",
        resultJson: true,
      };
      const contextB = adapter.prepareRun(requestB);
      scratchDirs.push(contextB.lastMessageDir!);
      const argvB = adapter.buildRunCommand(requestB, contextB);
      const fileB = argvB[argvB.indexOf("--output-last-message") + 1]!;
      expect(fileB).not.toBe(fileA);
      writeFileSync(fileB, "B's plan");

      // A finishes first: it must read its own file, and B's must still be
      // standing for B's own completion -- A's completion must not consume
      // it the way the shared pointer let it.
      const outA = runOutcome(
        { stdout: planOnlyStream("0192b8d4-4d4f-7c4a-9d0e-6f5a4b3c2d1e"), stderr: "", exitCode: 0, success: true },
        requestA,
        contextA
      );
      expect(outA.success).toBe(true);
      expect(JSON.parse(outA.stdout).result).toBe("A's plan");
      expect(existsSync(fileA)).toBe(false);
      expect(existsSync(fileB)).toBe(true);

      const outB = runOutcome(
        { stdout: planOnlyStream("6f9619ff-8ba7-4c95-9d9b-ac905e48cfd7"), stderr: "", exitCode: 0, success: true },
        requestB,
        contextB
      );
      expect(outB.success).toBe(true);
      expect(JSON.parse(outB.stdout).result).toBe("B's plan");
      expect(existsSync(fileB)).toBe(false);
    } finally {
      for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("two overlapping launches through one request object each carry their own context", () => {
    // Round13 refused the second launch because per-run state was keyed by
    // the request object; the round15 restructure made the context a value
    // the launcher owns, so the SAME request object may launch twice
    // concurrently and each launch reads and removes only its own file.
    const home = mkdtempSync(join(tmpdir(), "codemux-codex-"));
    const scratchDirs: string[] = [];
    try {
      mkdirSync(join(home, ".codex"));
      const adapter = new CodexAdapter({}, home);
      const request: RunRequest = {
        agent: "codex",
        prompt: "t",
        resultJson: true,
      };
      const planOnlyStream = (threadId: string): string =>
        [
          { type: "thread.started", thread_id: threadId },
          { type: "turn.started" },
          { type: "item.completed", item: { id: "item_0", type: "reasoning", text: "thinking" } },
          { type: "turn.completed", usage: { input_tokens: 10, output_tokens: 2 } },
        ].map((line) => JSON.stringify(line)).join("\n") + "\n";

      // Two overlapping launches of the SAME object: two contexts, two files.
      const contextA = adapter.prepareRun(request);
      scratchDirs.push(contextA.lastMessageDir!);
      const argvA = adapter.buildRunCommand(request, contextA);
      const fileA = argvA[argvA.indexOf("--output-last-message") + 1]!;
      writeFileSync(fileA, "A's plan");
      const contextB = adapter.prepareRun(request);
      scratchDirs.push(contextB.lastMessageDir!);
      const argvB = adapter.buildRunCommand(request, contextB);
      const fileB = argvB[argvB.indexOf("--output-last-message") + 1]!;
      expect(fileB).not.toBe(fileA);
      writeFileSync(fileB, "B's plan");

      // B completes first and consumes only its own file; A's still stands.
      const outB = adapter.processRunResult(
        { stdout: planOnlyStream("6f9619ff-8ba7-4c95-9d9b-ac905e48cfd7"), stderr: "", exitCode: 0, success: true },
        request,
        contextB
      );
      expect(outB.success).toBe(true);
      expect(JSON.parse(outB.stdout).result).toBe("B's plan");
      expect(existsSync(fileB)).toBe(false);
      expect(existsSync(fileA)).toBe(true);

      // A completes on its own context, whole.
      const outA = adapter.processRunResult(
        { stdout: planOnlyStream("0192b8d4-4d4f-7c4a-9d0e-6f5a4b3c2d1e"), stderr: "", exitCode: 0, success: true },
        request,
        contextA
      );
      expect(outA.success).toBe(true);
      expect(JSON.parse(outA.stdout).result).toBe("A's plan");
      expect(existsSync(fileA)).toBe(false);
    } finally {
      for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("a scratch directory swapped for a symlink loses the fallback; the victim keeps its file", () => {
    // The round29 security finding: noFollow refuses a symlink at the
    // file's own name only, and an intermediate path component is followed
    // however the final one is opened. A compromised child that replaced
    // this run's per-run directory -- or the `.codemux-scratch` parent it
    // lives under -- with a symlink pointed the parent's read and delete
    // at `<victim>/last-message`: the victim's text became the run's
    // result and the file was then deleted outside the sandbox. Both
    // directories are lstat-checked before either happens now (the same
    // check prepareRunDirParent applies at creation time), so a swapped
    // directory loses the fallback with a warning and the victim is
    // untouched.
    const home = mkdtempSync(join(tmpdir(), "codemux-codex-"));
    const victims: string[] = [];
    const errors: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    };
    try {
      mkdirSync(join(home, ".codex"));
      const adapter = new CodexAdapter({ CODEX_API_KEY: "sk-test" }, home);
      const request: RunRequest = { agent: "codex", prompt: "t", resultJson: true };
      const planOnlyStream = [
        { type: "thread.started", thread_id: "0192b8d4-4d4f-7c4a-9d0e-6f5a4b3c2d1e" },
        { type: "turn.started" },
        { type: "item.completed", item: { id: "item_0", type: "reasoning", text: "thinking" } },
        { type: "turn.completed", usage: { input_tokens: 10, output_tokens: 2 } },
      ].map((line) => JSON.stringify(line)).join("\n") + "\n";

      // The child's chosen target: a user-owned directory of the user's
      // own, holding a file named exactly last-message.
      const victim = mkdtempSync(join(tmpdir(), "codemux-victim-"));
      victims.push(victim);
      const victimFile = join(victim, "last-message");
      writeFileSync(victimFile, "the victim's own text");

      // Plant 1, the finding's example: the run directory itself becomes
      // a symlink to the victim.
      const swappedRun = adapter.prepareRun(request);
      const runDir = swappedRun.lastMessageDir!;
      rmSync(runDir, { recursive: true, force: true });
      symlinkSync(victim, runDir);
      const outRun = adapter.processRunResult(
        { stdout: planOnlyStream, stderr: "", exitCode: 0, success: true },
        request,
        swappedRun
      );
      // Refused, so it fails closed like any run whose fallback is
      // unreadable: no result built from the victim's file, exit 1.
      expect(outRun.success).toBe(false);
      expect(outRun.exitCode).toBe(1);
      expect(JSON.parse(outRun.stdout).result).toBeNull();
      expect(outRun.stderr).toContain("ended without a final assistant message");
      expect(errors.join("\n")).toContain("refusing codex's --output-last-message file");
      expect(readFileSync(victimFile, "utf8")).toBe("the victim's own text");
      // cleanupRun removes only the link standing in for the run
      // directory, never following it into the victim.
      adapter.cleanupRun(swappedRun);
      expect(readFileSync(victimFile, "utf8")).toBe("the victim's own text");

      errors.length = 0;

      // Plant 2: the `.codemux-scratch` parent becomes the symlink. The
      // child re-created the run directory under its chosen parent, so
      // the run-directory check alone would pass (lstat follows the
      // intermediate link) and the parent needs its own check.
      const swappedParent = adapter.prepareRun(request);
      const plantedDir = basename(swappedParent.lastMessageDir!);
      mkdirSync(join(victim, plantedDir), { recursive: true });
      const plantedFile = join(victim, plantedDir, "last-message");
      writeFileSync(plantedFile, "the victim's own text");
      const scratchParent = join(home, ".codex", ".codemux-scratch");
      rmSync(scratchParent, { recursive: true, force: true });
      symlinkSync(victim, scratchParent);
      const outParent = adapter.processRunResult(
        { stdout: planOnlyStream, stderr: "", exitCode: 0, success: true },
        request,
        swappedParent
      );
      expect(outParent.success).toBe(false);
      expect(JSON.parse(outParent.stdout).result).toBeNull();
      expect(errors.join("\n")).toContain("refusing codex's --output-last-message file");
      expect(readFileSync(plantedFile, "utf8")).toBe("the victim's own text");
    } finally {
      console.error = originalError;
      for (const dir of victims) rmSync(dir, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("cleanupRun refuses a swapped scratch parent; the victim keeps its directory", () => {
    // The finding, and the minor under it: readFinalMessageFallback
    // revalidates the `.codemux-scratch` parent before it reads and removes
    // the file, but cleanupRun's recursive removal of the per-run directory
    // never did -- and pathname resolution follows an intermediate symlink
    // like any other component, so a child that replaced the parent with a
    // link pointed the rm at a matching run directory of its choosing,
    // outside the sandbox, even on a launch whose result read already
    // refused the swap. The parent is lstat-checked before the removal now
    // (rm removes a symlink at the run directory's own name rather than
    // following it, so the parent is the one component that needs it); a
    // parent that fails keeps its directory and says why, the reader's
    // wording.
    const home = mkdtempSync(join(tmpdir(), "codemux-codex-"));
    const victims: string[] = [];
    const errors: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    };
    try {
      mkdirSync(join(home, ".codex"));
      const adapter = new CodexAdapter({ CODEX_API_KEY: "sk-test" }, home);
      const request: RunRequest = { agent: "codex", prompt: "t", resultJson: true };

      // The child's chosen target: a user-owned directory holding a run
      // directory of exactly the name prepareRun created, so only the
      // parent check tells the intended tree from the planted one.
      const victim = mkdtempSync(join(tmpdir(), "codemux-victim-"));
      victims.push(victim);
      const context = adapter.prepareRun(request);
      const plantedDir = basename(context.lastMessageDir!);
      const plantedPath = join(victim, plantedDir);
      mkdirSync(plantedPath, { recursive: true });
      const plantedFile = join(plantedPath, "last-message");
      writeFileSync(plantedFile, "the victim's own text");
      const scratchParent = join(home, ".codex", ".codemux-scratch");
      rmSync(scratchParent, { recursive: true, force: true });
      symlinkSync(victim, scratchParent);

      adapter.cleanupRun(context);

      // The recursive removal would have deleted the planted directory and
      // everything in it, outside codemux's scratch tree; the refusal is
      // the security outcome, distinct from a cleanup that merely failed.
      expect(existsSync(plantedPath)).toBe(true);
      expect(readFileSync(plantedFile, "utf8")).toBe("the victim's own text");
      expect(errors.join("\n")).toContain(
        "refusing to remove codex's --output-last-message directory"
      );
      expect(errors.join("\n")).not.toContain("could not remove");
    } finally {
      console.error = originalError;
      for (const dir of victims) rmSync(dir, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("a rejected launch cleans up only its own context, never a live run's", async () => {
    // Round15's major finding, both halves. A launch that rejects BEFORE
    // prepareRun (validation refusing the request) and one that rejects
    // AFTER its own prepareRun (the .scode.yaml workdir refusal) used to
    // run cleanupRun against the live run's keyed state, deleting its
    // --output-last-message file and leaving a successful Plan-only run
    // without its reply. Each launch now owns exactly the context it
    // created, so both rejections leave run A's file standing.
    const home = mkdtempSync(join(tmpdir(), "codemux-codex-"));
    const workdir = mkdtempSync(join(tmpdir(), "codemux-workdir-"));
    let scratchDir: string | undefined;
    try {
      mkdirSync(join(home, ".codex"));
      writeFileSync(join(workdir, ".scode.yaml"), "");
      const adapter = new CodexAdapter({}, home);
      const request: RunRequest = {
        agent: "codex",
        prompt: "t",
        resultJson: true,
        sandboxed: true,
        cwd: workdir,
      };
      // Run A in flight: its own context, its file standing.
      const contextA = adapter.prepareRun(request);
      scratchDir = contextA.lastMessageDir;
      const argvA = adapter.buildRunCommand(request, contextA);
      const fileA = argvA[argvA.indexOf("--output-last-message") + 1]!;
      writeFileSync(fileA, "A's plan");

      // Rejection before prepareRun: a request validation refuses, so the
      // second launch never prepares a context and has nothing of its own
      // -- or of A's -- to clean.
      await expect(
        launchRunRequest(
          adapter,
          { ...request, tools: "none", autonomy: "medium" },
          {
            sandbox: true,
            sandboxPolicyOverrides: { trust: "untrusted" },
            requestedAutonomy: "read-only",
            cwd: workdir,
          }
        )
      ).rejects.toThrow(/codex cannot remove its apply_patch tool/);
      expect(existsSync(fileA)).toBe(true);

      // Rejection after prepareRun: the .scode.yaml workdir refuses the
      // launch once its OWN context exists, and only that context is
      // disposed (the rejected-launch test above covers its own file).
      await expect(
        launchRunRequest(adapter, request, {
          sandbox: true,
          requestedAutonomy: "read-only",
          cwd: workdir,
        })
      ).rejects.toThrow(/\.scode\.yaml/);
      expect(existsSync(fileA)).toBe(true);

      // Run A completes on its own context, whole.
      const stream = [
        { type: "thread.started", thread_id: "0192b8d4-4d4f-7c4a-9d0e-6f5a4b3c2d1e" },
        { type: "turn.started" },
        { type: "item.completed", item: { id: "item_0", type: "reasoning", text: "thinking" } },
        { type: "turn.completed", usage: { input_tokens: 10, output_tokens: 2 } },
      ].map((line) => JSON.stringify(line)).join("\n") + "\n";
      const outA = adapter.processRunResult(
        { stdout: stream, stderr: "", exitCode: 0, success: true },
        request,
        contextA
      );
      expect(outA.success).toBe(true);
      expect(JSON.parse(outA.stdout).result).toBe("A's plan");
      expect(existsSync(fileA)).toBe(false);
    } finally {
      if (scratchDir !== undefined) rmSync(scratchDir, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
      rmSync(workdir, { recursive: true, force: true });
    }
  });

  test("the launch path has one passthroughEnv source: the request", async () => {
    // Round15: the launch options used to carry a second passthroughEnv
    // list, so a programmatic caller could validate one list and build the
    // child environment from another -- a relative CLAUDE_CONFIG_DIR that
    // reached only the options bypassed the absolute-path guard and landed
    // the config store under the working directory. The options field is
    // gone; validation and the sandbox environment read the same list.
    const prev = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = "relative-profile";
    try {
      await expect(
        launchRunRequest(
          new ClaudeAdapter(),
          {
            agent: "claude",
            prompt: "t",
            autonomy: "high",
            sandboxed: false,
            passthroughEnv: ["CLAUDE_CONFIG_DIR"],
          },
          { sandbox: false, requestedAutonomy: "high" }
        )
      ).rejects.toThrow(/CLAUDE_CONFIG_DIR must be an absolute path/);
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = prev;
    }
  });

  test("a direct launch validates before the run's scratch state exists", async () => {
    // Round17: the direct path built the run context before any validation
    // (adapter.run validated only after receiving it), and building a
    // context writes scratch state -- codex's --output-last-message path,
    // a hermetic home. A request the run will refuse must not touch disk
    // first, so validation precedes prepareRun on this path too.
    class ProbeAdapter extends BaseAdapter {
      readonly id = "claude" as const;
      readonly binaryName = "claude";
      prepared = 0;
      refuse = false;
      capabilities(): AdapterCapabilities {
        return {
          supportsNonInteractive: true,
          supportsInteractive: true,
          supportsModel: false,
          supportsAutonomy: true,
          autonomyLevels: ["read-only", "low", "medium", "high"],
          supportsEffort: false,
          effortLevels: [],
          supportsHermetic: false,
          supportsToolSelection: false,
          supportsResultJson: false,
        };
      }
      buildRunCommand(): string[] {
        // A real command shape, so the control launch below spawns a real
        // (harmless) process through the launch path run() now shares.
        return [process.execPath, "-e", "process.exit(0)"];
      }
      buildTuiCommand(): string[] {
        return ["claude"];
      }
      override validateRunRequest(request: RunRequest): void {
        super.validateRunRequest(request);
        if (this.refuse) throw new Error("probe: request refused");
      }
      override prepareRun(): RunContext {
        this.prepared++;
        return {};
      }
    }
    const adapter = new ProbeAdapter();
    const request: RunRequest = {
      agent: "claude",
      prompt: "t",
      autonomy: "high",
      sandboxed: false,
    };
    adapter.refuse = true;
    await expect(
      launchRunRequest(adapter, request, { sandbox: false, requestedAutonomy: "high" })
    ).rejects.toThrow("probe: request refused");
    expect(adapter.prepared).toBe(0);
    // The control: a valid request still prepares exactly one context and
    // runs on it.
    adapter.refuse = false;
    const result = await launchRunRequest(adapter, request, {
      sandbox: false,
      requestedAutonomy: "high",
    });
    expect(result.success).toBe(true);
    expect(adapter.prepared).toBe(1);
  });

  test("a rejected sandboxed launch still removes the run's --output-last-message file", async () => {
    // The round9 finding: post-processing was skipped when the launch
    // itself rejected, so the file codex had already written -- model
    // output -- stayed in CODEX_HOME. Here the sandboxed path rejects
    // after prepareRun (a working directory with .scode.yaml is refused),
    // and the per-run file must not outlive the failed launch.
    const home = mkdtempSync(join(tmpdir(), "codemux-codex-"));
    const workdir = mkdtempSync(join(tmpdir(), "codemux-workdir-"));
    try {
      mkdirSync(join(home, ".codex"));
      writeFileSync(join(workdir, ".scode.yaml"), "");
      // buildRunCommand runs after prepareRun on the launch path; writing
      // the file there stands in for the output codex itself records
      // before a later failure (a captured stdout that is not UTF-8).
      class RecordingCodexAdapter extends CodexAdapter {
        lastMessageFile: string | null = null;
        override buildRunCommand(request: RunRequest, context?: RunContext): string[] {
          const argv = super.buildRunCommand(request, context);
          const flag = argv.indexOf("--output-last-message");
          if (flag >= 0) {
            this.lastMessageFile = argv[flag + 1]!;
            writeFileSync(this.lastMessageFile, "model output");
          }
          return argv;
        }
      }
      const adapter = new RecordingCodexAdapter({}, home);
      const request: RunRequest = {
        agent: "codex",
        prompt: "t",
        resultJson: true,
        sandboxed: true,
        cwd: workdir,
      };
      await expect(
        launchRunRequest(adapter, request, {
          sandbox: true,
          requestedAutonomy: "read-only",
          cwd: workdir,
        })
      ).rejects.toThrow(/\.scode\.yaml/);
      expect(adapter.lastMessageFile).not.toBeNull();
      expect(existsSync(adapter.lastMessageFile!)).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(workdir, { recursive: true, force: true });
    }
  });

  test("a rejected direct run still removes the run's --output-last-message file", async () => {
    // The unsandboxed twin of the finding: adapter.run() itself rejects
    // (the harness binary cannot be resolved here) after prepareRun
    // recorded the file, and the same cleanup applies before the rethrow.
    const home = mkdtempSync(join(tmpdir(), "codemux-codex-"));
    try {
      mkdirSync(join(home, ".codex"));
      class MissingBinaryCodexAdapter extends CodexAdapter {
        lastMessageFile: string | null = null;
        override buildRunCommand(request: RunRequest, context?: RunContext): string[] {
          const argv = super.buildRunCommand(request, context);
          const flag = argv.indexOf("--output-last-message");
          if (flag >= 0) {
            this.lastMessageFile = argv[flag + 1]!;
            writeFileSync(this.lastMessageFile, "model output");
          }
          // Name a binary no PATH holds, so resolution fails after
          // prepareRun instead of spawning a real codex.
          argv[0] = "codemux-no-such-harness-binary";
          return argv;
        }
      }
      const adapter = new MissingBinaryCodexAdapter({}, home);
      const request: RunRequest = {
        agent: "codex",
        prompt: "t",
        resultJson: true,
        autonomy: "high",
        sandboxed: false,
        cwd: home,
      };
      await expect(
        launchRunRequest(adapter, request, {
          sandbox: false,
          requestedAutonomy: "high",
        })
      ).rejects.toThrow(/was not found/);
      expect(adapter.lastMessageFile).not.toBeNull();
      expect(existsSync(adapter.lastMessageFile!)).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("a cleanup failure removing the --output-last-message file cannot fail the run", () => {
    // The round12 finding: the fallback reader's final rmSync sat outside
    // its try/catch, so an EACCES or ENOTEMPTY there rejected processing
    // on a finished run and replaced its result with a cleanup error. The
    // guard is the rejected-launch cleanup's rule: the failure says so on
    // stderr and stays out of the run's way. A read-only per-run directory
    // makes the removal fail while the read still succeeds.
    const home = mkdtempSync(join(tmpdir(), "codemux-codex-"));
    const errors: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    };
    let lastMessageDir = "";
    try {
      const adapter = new CodexAdapter({}, home);
      const request: RunRequest = {
        agent: "codex",
        prompt: "t",
        resultJson: true,
      };
      const context = adapter.prepareRun(request);
      const argv = adapter.buildRunCommand(request, context);
      const lastMessageFile = argv[argv.indexOf("--output-last-message") + 1]!;
      lastMessageDir = dirname(lastMessageFile);
      writeFileSync(lastMessageFile, "the recorded message");
      chmodSync(lastMessageDir, 0o500);
      const stream = [
        { type: "thread.started", thread_id: "0192b8d4-4d4f-7c4a-9d0e-6f5a4b3c2d1e" },
        { type: "turn.started" },
        { type: "item.completed", item: { id: "item_0", type: "reasoning", text: "thinking" } },
        { type: "turn.completed", usage: { input_tokens: 10, output_tokens: 2 } },
      ].map((line) => JSON.stringify(line)).join("\n") + "\n";
      const out = adapter.processRunResult(
        { stdout: stream, stderr: "", exitCode: 0, success: true },
        request,
        context
      );
      // The run's own result stands; the cleanup failure only warns.
      expect(out.success).toBe(true);
      expect(out.exitCode).toBe(0);
      expect(JSON.parse(out.stdout).result).toBe("the recorded message");
      expect(out.stderr).toContain("final message codex recorded itself");
      expect(errors.join("\n")).toContain(
        "could not remove codex's --output-last-message file"
      );
      // Removal failed, so the file is still there -- visibly, not as a
      // thrown error replacing the result.
      expect(existsSync(lastMessageFile)).toBe(true);
    } finally {
      console.error = originalError;
      if (lastMessageDir !== "") {
        chmodSync(lastMessageDir, 0o700);
        rmSync(lastMessageDir, { recursive: true, force: true });
      }
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("a stream with no thread.started is a parse failure, not a warned run", () => {
    // The old warning still exited 0 on a stream like this. Strict parsing
    // now rejects a stream with no thread.started outright -- the grammar
    // opens every stream with it -- so the raw stdout stays and the run
    // fails as a parse failure.
    const stream = [
      { type: "turn.started" },
      {
        type: "item.completed",
        item: { id: "item_0", type: "agent_message", text: "the reply" },
      },
      { type: "turn.completed", usage: { input_tokens: 10, output_tokens: 2 } },
    ].map((line) => JSON.stringify(line)).join("\n") + "\n";
    const out = adapter.processRunResult(
      { stdout: stream, stderr: "", exitCode: 0, success: true },
      { agent: "codex", prompt: "t", resultJson: true }
    );
    expect(out.success).toBe(false);
    expect(out.exitCode).toBe(1);
    expect(out.stdout).toBe(stream);
    expect(out.stderr).toContain("cannot parse");
  });

  test("a turn failure fails the run even when codex exits 0", () => {
    // The blocker's reproduction: thread.started plus a usage-limit
    // turn.failed with codex's own exit 0 used to stay successful with
    // empty stdout.
    const stream = [
      { type: "thread.started", thread_id: "0192b8d4-4d4f-7c4a-9d0e-6f5a4b3c2d1e" },
      { type: "turn.started" },
      { type: "item.completed", item: { id: "item_0", type: "agent_message", text: "partial" } },
      { type: "turn.failed", error: { message: "Usage limit reached" } },
    ].map((line) => JSON.stringify(line)).join("\n") + "\n";
    const out = adapter.processRunResult(
      { stdout: stream, stderr: "", exitCode: 0, success: true },
      { agent: "codex", prompt: "t", resultJson: true }
    );
    expect(out.success).toBe(false);
    expect(out.exitCode).toBe(1);
    // A failed turn has no final message, so the envelope carries none.
    expect(JSON.parse(out.stdout).result).toBeNull();
    expect(out.stderr).toContain("Usage limit reached");
  });

  test("an unparseable stream fails a --result-json run", () => {
    // Drift: the raw stdout stays for inspection and the run fails
    // instead of warning and exiting 0.
    const out = adapter.processRunResult(
      { stdout: "human-mode text\n", stderr: "", exitCode: 0, success: true },
      { agent: "codex", prompt: "t", resultJson: true }
    );
    expect(out.success).toBe(false);
    expect(out.exitCode).toBe(1);
    expect(out.stdout).toBe("human-mode text\n");
    expect(out.stderr).toContain("cannot parse");
  });

  test("a truncated stream fails the run too", () => {
    // The wrapper shape from the round-4 finding: a zero-exit stream whose
    // message item completed but whose turn never did has no result.
    const stream = [
      { type: "thread.started", thread_id: "0192b8d4-4d4f-7c4a-9d0e-6f5a4b3c2d1e" },
      { type: "turn.started" },
      {
        type: "item.completed",
        item: { id: "item_0", type: "agent_message", text: "partial" },
      },
    ].map((line) => JSON.stringify(line)).join("\n") + "\n";
    const out = adapter.processRunResult(
      { stdout: stream, stderr: "", exitCode: 0, success: true },
      { agent: "codex", prompt: "t", resultJson: true }
    );
    expect(out.success).toBe(false);
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain("turn.completed");
  });

  test("an envelope whose stream names no thread cannot parse", () => {
    // A stream without the thread announcement is drift, so no envelope is
    // built from it: strict parsing rejects the stream before any verdict
    // runs, the raw stdout stays.
    const stream = [
      {
        type: "item.completed",
        item: { id: "item_0", type: "agent_message", text: "continued" },
      },
      { type: "turn.completed", usage: { input_tokens: 10, output_tokens: 2 } },
    ].map((line) => JSON.stringify(line)).join("\n") + "\n";
    const out = adapter.processRunResult(
      { stdout: stream, stderr: "", exitCode: 0, success: true },
      { agent: "codex", prompt: "t", resultJson: true }
    );
    expect(out.exitCode).toBe(1);
    expect(out.success).toBe(false);
    expect(out.stdout).toBe(stream);
    expect(out.stderr).toContain("cannot parse");
  });

  test("buildTuiCommand basic", () => {
    expect(adapter.buildTuiCommand()).toEqual(["codex"]);
  });

  test("buildTuiCommand with model", () => {
    expect(adapter.buildTuiCommand("gpt-5.1")).toEqual(["codex", "-m", "gpt-5.1"]);
  });

  test("buildTuiCommand with autonomy", () => {
    // Same mapping as exec runs: the TUI honors -s directly and reads the
    // approval policy from the config override (-a at 0.159.x accepts only
    // on-request|never and cannot express `untrusted` at all).
    expect(adapter.buildTuiCommand(undefined, "high")).toEqual(["codex", "-s", "danger-full-access", "-c", 'approval_policy="never"']);
  });

  test("buildTuiCommand with effort", () => {
    expect(adapter.buildTuiCommand(undefined, undefined, "low")).toEqual(["codex", "-c", 'model_reasoning_effort="low"']);
    expect(adapter.buildTuiCommand("gpt-5.1", undefined, "high")).toEqual(["codex", "-m", "gpt-5.1", "-c", 'model_reasoning_effort="high"']);
  });

  test("buildTuiCommand with external sandbox bypasses codex sandbox flags", () => {
    const cmd = adapter.buildTuiCommand("gpt-5.1", "high", "low", true);
    expect(cmd).toEqual([
      "codex",
      "-m",
      "gpt-5.1",
      "--dangerously-bypass-approvals-and-sandbox",
      "-c",
      'model_reasoning_effort="low"',
    ]);
  });

  test("mapAutonomy returns correct flags", () => {
    // Every level carries the approval policy as a config override: `-a`
    // never reaches a codex exec run (the root handoff drops it) and its
    // CLI values at 0.159.x are only on-request|never, which cannot express
    // low's `untrusted`.
    expect(adapter.mapAutonomy("read-only")).toEqual(["-s", "read-only", "-c", 'approval_policy="never"']);
    expect(adapter.mapAutonomy("low")).toEqual(["-s", "workspace-write", "-c", 'approval_policy="untrusted"']);
    expect(adapter.mapAutonomy("medium")).toEqual(["-s", "workspace-write", "-c", 'approval_policy="never"']);
    expect(adapter.mapAutonomy("high")).toEqual(["-s", "danger-full-access", "-c", 'approval_policy="never"']);
  });

  test("mapEffort returns correct flags", () => {
    expect(adapter.mapEffort("low")).toEqual(["-c", 'model_reasoning_effort="low"']);
    expect(adapter.mapEffort("medium")).toEqual(["-c", 'model_reasoning_effort="medium"']);
    expect(adapter.mapEffort("high")).toEqual(["-c", 'model_reasoning_effort="high"']);
  });
});

describe("GooseAdapter", () => {
  const adapter = new GooseAdapter();

  test("has correct id and binary name", () => {
    expect(adapter.id).toBe("goose");
    expect(adapter.binaryName).toBe("goose");
  });

  test("capabilities are correct", () => {
    const caps = adapter.capabilities();
    expect(caps.supportsNonInteractive).toBe(true);
    expect(caps.supportsInteractive).toBe(true);
    expect(caps.supportsModel).toBe(true);
    expect(caps.supportsAutonomy).toBe(true);
    expect(caps.autonomyLevels).toEqual(["read-only", "low", "medium", "high"]);
    expect(caps.supportsEffort).toBe(false);
    expect(caps.effortLevels).toEqual([]);
  });

  test("buildRunCommand", () => {
    const request: RunRequest = { agent: "goose", prompt: "test prompt" };
    const cmd = adapter.buildRunCommand(request);
    expect(cmd).toEqual(["goose", "run", "-t", "test prompt"]);
  });

  test("buildRunCommand with autonomy", () => {
    expect(adapter.buildRunCommand({ agent: "goose", prompt: "t", autonomy: "read-only" }))
      .toEqual(["goose", "run", "-t", "t"]);
    expect(adapter.buildRunCommand({ agent: "goose", prompt: "t", autonomy: "low" }))
      .toEqual(["goose", "run", "-t", "t"]);
    expect(adapter.buildRunCommand({ agent: "goose", prompt: "t", autonomy: "medium" }))
      .toEqual(["goose", "run", "-t", "t"]);
    expect(adapter.buildRunCommand({ agent: "goose", prompt: "t", autonomy: "high" }))
      .toEqual(["goose", "run", "-t", "t"]);
  });

  test("buildTuiCommand", () => {
    expect(adapter.buildTuiCommand()).toEqual(["goose"]);
    expect(adapter.buildTuiCommand(undefined, "high")).toEqual(["goose"]);
  });

  test("getRunEnv and getTuiEnv set goose mode from autonomy", () => {
    expect(adapter.getRunEnv({ agent: "goose", prompt: "t" })).toEqual({ GOOSE_MODE: "chat" });
    expect(adapter.getRunEnv({ agent: "goose", prompt: "t", autonomy: "medium" }))
      .toEqual({ GOOSE_MODE: "smart_approve" });
    expect(adapter.getTuiEnv(undefined, undefined)).toEqual({ GOOSE_MODE: "chat" });
    expect(adapter.getTuiEnv(undefined, "high")).toEqual({ GOOSE_MODE: "auto" });
    expect(adapter.getRunEnv({ agent: "goose", prompt: "t", model: "provider/model" }))
      .toEqual({ GOOSE_MODE: "chat", GOOSE_MODEL: "provider/model" });
  });

  test("mapAutonomy returns goose mode env", () => {
    expect(adapter.mapAutonomy("read-only")).toEqual([]);
    expect(adapter.mapAutonomy("low")).toEqual([]);
    expect(adapter.mapAutonomy("medium")).toEqual([]);
    expect(adapter.mapAutonomy("high")).toEqual([]);
  });
});

describe("GeminiAdapter", () => {
  const adapter = new GeminiAdapter();

  test("has correct id and binary name", () => {
    expect(adapter.id).toBe("gemini");
    expect(adapter.binaryName).toBe("gemini");
  });

  test("disables repository .env loading with authoritative settings", () => {
    expect(adapter.getEnv()).toEqual({
      GEMINI_CLI_SYSTEM_SETTINGS_PATH: GEMINI_SYSTEM_SETTINGS_PATH,
    });
  });

  test("capabilities are correct", () => {
    const caps = adapter.capabilities();
    expect(caps.supportsNonInteractive).toBe(true);
    expect(caps.supportsInteractive).toBe(true);
    expect(caps.supportsModel).toBe(true);
    expect(caps.supportsAutonomy).toBe(true);
    expect(caps.autonomyLevels).toEqual(["read-only", "low", "medium", "high"]);
    expect(caps.supportsEffort).toBe(false);
    expect(caps.effortLevels).toEqual([]);
  });

  test("buildRunCommand with model", () => {
    const request: RunRequest = { agent: "gemini", prompt: "test", model: "gemini-pro" };
    const cmd = adapter.buildRunCommand(request);
    expect(cmd).toEqual(["gemini", "--sandbox=false", "-m", "gemini-pro", "-p", "test"]);
  });

  test("buildRunCommand with autonomy levels", () => {
    expect(adapter.buildRunCommand({ agent: "gemini", prompt: "t", autonomy: "read-only" }))
      .toEqual(["gemini", "--sandbox=false", "--approval-mode", "plan", "-p", "t"]);
    expect(adapter.buildRunCommand({ agent: "gemini", prompt: "t", autonomy: "low" }))
      .toEqual(["gemini", "--sandbox=false", "--approval-mode", "default", "-p", "t"]);
    expect(adapter.buildRunCommand({ agent: "gemini", prompt: "t", autonomy: "medium" }))
      .toEqual(["gemini", "--sandbox=false", "--approval-mode", "auto_edit", "-p", "t"]);
    expect(adapter.buildRunCommand({ agent: "gemini", prompt: "t", autonomy: "high" }))
      .toEqual(["gemini", "--sandbox=false", "--approval-mode", "yolo", "-p", "t"]);
  });

  test("buildTuiCommand with model", () => {
    expect(adapter.buildTuiCommand("gemini-pro")).toEqual(["gemini", "--sandbox=false", "-m", "gemini-pro"]);
  });

  test("buildTuiCommand with autonomy", () => {
    expect(adapter.buildTuiCommand(undefined, "medium")).toEqual(["gemini", "--sandbox=false", "--approval-mode", "auto_edit"]);
  });

  test("mapAutonomy returns approval mode flags", () => {
    expect(adapter.mapAutonomy("read-only")).toEqual(["--approval-mode", "plan"]);
    expect(adapter.mapAutonomy("low")).toEqual(["--approval-mode", "default"]);
    expect(adapter.mapAutonomy("medium")).toEqual(["--approval-mode", "auto_edit"]);
    expect(adapter.mapAutonomy("high")).toEqual(["--approval-mode", "yolo"]);
  });

  test("requires an outer boundary for headless plan mode", () => {
    expect(adapter.requiresSandboxForAutonomy("read-only")).toBe(true);
    expect(adapter.requiresSandboxForAutonomy("low")).toBe(true);
    expect(adapter.requiresSandboxForAutonomy("medium")).toBe(true);
    expect(adapter.requiresSandboxForAutonomy("high")).toBe(false);
    // The TUI follows the same policy as headless: no level below `high` runs
    // without the boundary.
    expect(adapter.requiresSandboxForTuiAutonomy("read-only")).toBe(true);
  });
});
