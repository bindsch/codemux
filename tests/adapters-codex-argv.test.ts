import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexAdapter } from "../src/adapters/codex.js";
import type { RunRequest } from "../src/types.js";

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

  test("an empty passed-through CODEX_HOME is refused, not treated as unset", () => {
    // Review round 381, kimi's rule: the guard read the empty value as
    // unset (falsy) and fell back to the default home while the sanitized
    // child environment still carried CODEX_HOME="" — two different homes
    // for one run. The empty value is refused at validation, before
    // prepareRun creates the run's directories under either.
    const empty = new CodexAdapter({ CODEX_HOME: "" });
    expect(() =>
      empty.validateRunRequest({
        agent: "codex",
        prompt: "t",
        resultJson: true,
        passthroughEnv: ["CODEX_HOME"],
      })
    ).toThrow(/CODEX_HOME must not be empty when passed through/);
    // Without the passthrough the sanitizer drops the empty value, so the
    // default home is the one both sides use: no refusal.
    const cwd = mkdtempSync(join(tmpdir(), "codemux-codex-empty-home-"));
    try {
      expect(() =>
        empty.validateRunRequest({
          agent: "codex",
          prompt: "t",
          resultJson: true,
          cwd,
        })
      ).not.toThrow();
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
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

  // Every exec run carries the event stream flag and names the
  // final-message fallback file, whose static no-context shape is the
  // fail-closed placeholder. Round al29 restored the plain run's file
  // (al28 had deleted it from plain runs): the plain verdict reads it
  // only for the Plan-only turn's messageless stream, so plain and
  // --result-json runs share one tail.
  const runTail = (home: string): string[] => [
    "--json",
    "--output-last-message",
    join(home, ".codex", ".codemux-scratch", "unprepared", "last-message"),
    "-",
  ];

  test("buildRunCommand with prompt only", () => {
    const home = mkdtempSync(join(tmpdir(), "codemux-codex-"));
    try {
      const scoped = new CodexAdapter({}, home);
      const cmd = scoped.buildRunCommand({ agent: "codex", prompt: "test prompt" });
      expect(cmd).toEqual([
        "codex",
        "exec",
        "--skip-git-repo-check",
        "--ephemeral",
        "--ignore-rules",
        ...runTail(home),
      ]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("buildRunCommand with model", () => {
    const home = mkdtempSync(join(tmpdir(), "codemux-codex-"));
    try {
      const scoped = new CodexAdapter({}, home);
      const cmd = scoped.buildRunCommand({ agent: "codex", prompt: "test", model: "gpt-5.1" });
      expect(cmd).toEqual([
        "codex",
        "-m",
        "gpt-5.1",
        "exec",
        "--skip-git-repo-check",
        "--ephemeral",
        "--ignore-rules",
        ...runTail(home),
      ]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("buildRunCommand with autonomy levels", () => {
    // The approval policy rides on -c, not -a: an -a before `exec` is
    // dropped by codex's root-to-exec handoff and 0.159.x accepts only
    // on-request|never there anyway, while the config override reaches
    // exec, exec resume, and the TUI alike.
    const home = mkdtempSync(join(tmpdir(), "codemux-codex-"));
    try {
      const scoped = new CodexAdapter({}, home);
      const tail = runTail(home);
      expect(scoped.buildRunCommand({ agent: "codex", prompt: "t", autonomy: "read-only" }))
        .toEqual(["codex", "-s", "read-only", "-c", 'approval_policy="never"', "exec", "--skip-git-repo-check", "--ephemeral", "--ignore-rules", ...tail]);
      expect(scoped.buildRunCommand({ agent: "codex", prompt: "t", autonomy: "low" }))
        .toEqual(["codex", "-s", "workspace-write", "-c", 'approval_policy="untrusted"', "exec", "--skip-git-repo-check", "--ephemeral", "--ignore-rules", ...tail]);
      expect(scoped.buildRunCommand({ agent: "codex", prompt: "t", autonomy: "medium" }))
        .toEqual(["codex", "-s", "workspace-write", "-c", 'approval_policy="never"', "exec", "--skip-git-repo-check", "--ephemeral", "--ignore-rules", ...tail]);
      expect(scoped.buildRunCommand({ agent: "codex", prompt: "t", autonomy: "high" }))
        .toEqual(["codex", "-s", "danger-full-access", "-c", 'approval_policy="never"', "exec", "--skip-git-repo-check", "--ephemeral", "--ignore-rules", ...tail]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("buildRunCommand with effort levels", () => {
    const home = mkdtempSync(join(tmpdir(), "codemux-codex-"));
    try {
      const scoped = new CodexAdapter({}, home);
      const tail = runTail(home);
      expect(scoped.buildRunCommand({ agent: "codex", prompt: "t", effort: "low" }))
        .toEqual(["codex", "-c", 'model_reasoning_effort="low"', "exec", "--skip-git-repo-check", "--ephemeral", "--ignore-rules", ...tail]);
      expect(scoped.buildRunCommand({ agent: "codex", prompt: "t", effort: "medium" }))
        .toEqual(["codex", "-c", 'model_reasoning_effort="medium"', "exec", "--skip-git-repo-check", "--ephemeral", "--ignore-rules", ...tail]);
      expect(scoped.buildRunCommand({ agent: "codex", prompt: "t", effort: "high" }))
        .toEqual(["codex", "-c", 'model_reasoning_effort="high"', "exec", "--skip-git-repo-check", "--ephemeral", "--ignore-rules", ...tail]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("buildRunCommand with --no-web disables the web search tool through a config override", () => {
    const home = mkdtempSync(join(tmpdir(), "codemux-codex-"));
    try {
      const scoped = new CodexAdapter({}, home);
      const tail = runTail(home);
      // codex 0.166.0: ToolsToml's web_search field takes a WebSearchMode
      // (disabled|cached|indexed|live) and -c overrides config.toml per
      // invocation, so the denial rides the top-level WebSearchMode key.
      expect(scoped.buildRunCommand({ agent: "codex", prompt: "t", web: false }))
        .toEqual(["codex", "-c", 'web_search="disabled"', "exec", "--skip-git-repo-check", "--ephemeral", "--ignore-rules", ...tail]);
      expect(scoped.buildRunCommand({ agent: "codex", prompt: "t" }))
        .toEqual(["codex", "exec", "--skip-git-repo-check", "--ephemeral", "--ignore-rules", ...tail]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("buildRunCommand with external sandbox bypasses codex sandbox flags", () => {
    const home = mkdtempSync(join(tmpdir(), "codemux-codex-"));
    try {
      const scoped = new CodexAdapter({}, home);
      const cmd = scoped.buildRunCommand({
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
        ...runTail(home),
      ]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("getStdinInput returns prompt", () => {
    const request: RunRequest = { agent: "codex", prompt: "my prompt" };
    expect(adapter.getStdinInput(request)).toBe("my prompt");
  });

  test("codex declares it can return a result envelope", () => {
    expect(adapter.capabilities().supportsResultJson).toBe(true);
  });

  test("every run names the --output-last-message file; the verdict scopes it (al29)", () => {
    // Round al29 restores what al28 deleted: a plain run names the file
    // again — the Plan-only turn's recorded final message is the reply's
    // only carrier, the one item the JSONL wire does not carry — and the
    // al28 defect (a second source that could contradict the stream) is
    // answered by scoping the READ, not deleting the file: the plain
    // verdict consults it only for a completed messageless turn
    // (plain-unwrap-codex-fold-verdicts.test.ts's bounded-fallback tests), so plain and
    // --result-json argv are one shape. The path a buildRunCommand
    // without prepareRun names sits under the real CODEX_HOME's
    // .codemux-scratch/, with the unprepared marker standing where the
    // per-run directory would be (the same fail-closed shape the
    // hermetic home's preview uses).
    const home = mkdtempSync(join(tmpdir(), "codemux-codex-"));
    try {
      const scoped = new CodexAdapter({}, home);
      const plain = scoped.buildRunCommand({ agent: "codex", prompt: "t" });
      expect(plain).toEqual([
        "codex",
        "exec",
        "--skip-git-repo-check",
        "--ephemeral",
        "--ignore-rules",
        ...runTail(home),
      ]);
      expect(
        scoped.buildRunCommand({ agent: "codex", prompt: "t", resultJson: true })
      ).toEqual(plain);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
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
