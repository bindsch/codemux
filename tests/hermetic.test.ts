import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAdapter } from "../src/adapters/index.js";
import { ClaudeAdapter } from "../src/adapters/claude.js";
import { ZaiAdapter } from "../src/adapters/zai.js";
import { evaluateCanary, plantCanary } from "../src/hermetic-canary.js";
import { AGENT_IDS, type RunRequest } from "../src/types.js";

// The verified harnesses (claude, zai, codex, aider, opencode) and the
// shared refusal, canary and env-prefix machinery live here. Codex's
// private-home suite is in hermetic-codex.test.ts; the implemented-but-
// unclaimed harness mappings (droid, kimi) in
// hermetic-harness-mappings.test.ts.

const PLAIN_CLAUDE = ["claude", "-p", "--setting-sources", "user", "--strict-mcp-config", "--no-session-persistence"];

describe("hermetic runs: claude and zai", () => {
  const HERMETIC_CLAUDE = ["claude", "-p", "--safe-mode", "--setting-sources", "user", "--strict-mcp-config", "--no-session-persistence"];

  test("--hermetic adds --safe-mode, keeps the user setting source and the tools", () => {
    const cmd = new ClaudeAdapter().buildRunCommand({ agent: "claude", prompt: "p", model: "haiku", hermetic: true });
    expect(cmd).toEqual([...HERMETIC_CLAUDE, "--model", "haiku"]);
  });

  test("--tools none removes the built-in tools independently of --hermetic", () => {
    expect(new ClaudeAdapter().buildRunCommand({ agent: "claude", prompt: "p", tools: "none" }))
      .toEqual([...PLAIN_CLAUDE, "--tools", ""]);
    expect(new ClaudeAdapter().buildRunCommand({ agent: "claude", prompt: "p", hermetic: true, tools: "none" }))
      .toEqual([...HERMETIC_CLAUDE, "--tools", ""]);
    expect(new ClaudeAdapter().buildRunCommand({ agent: "claude", prompt: "p", tools: "default" }))
      .toEqual(PLAIN_CLAUDE);
  });

  test("zai follows the same mapping", () => {
    const cmd = new ZaiAdapter().buildRunCommand({ agent: "zai", prompt: "p", hermetic: true, tools: "none" });
    expect(cmd).toEqual([...HERMETIC_CLAUDE, "--tools", "", "--model", "opus"]);
  });

  test("plain commands are unchanged", () => {
    expect(new ClaudeAdapter().buildRunCommand({ agent: "claude", prompt: "p" })).toEqual(PLAIN_CLAUDE);
  });

  test("instruction directories become --add-dir; the project source turns on only for the working directory itself", () => {
    expect(new ClaudeAdapter().buildRunCommand({ agent: "claude", prompt: "p", cwd: "/tmp/a", instructionDirs: ["/tmp/a", "/tmp/b"] }))
      .toEqual(["claude", "-p", "--setting-sources", "user,project", "--strict-mcp-config", "--no-session-persistence", "--add-dir", "/tmp/a", "--add-dir", "/tmp/b"]);
    expect(new ClaudeAdapter().buildRunCommand({ agent: "claude", prompt: "p", cwd: "/tmp/a", hermetic: true, instructionDirs: ["/tmp/a"] }))
      .toEqual(["claude", "-p", "--safe-mode", "--setting-sources", "user,project", "--strict-mcp-config", "--no-session-persistence", "--add-dir", "/tmp/a"]);
    // An instruction directory elsewhere never enables the working
    // directory's own settings file.
    expect(new ClaudeAdapter().buildRunCommand({ agent: "claude", prompt: "p", cwd: "/tmp/repo", instructionDirs: ["/tmp/a"] }))
      .toEqual([...PLAIN_CLAUDE, "--add-dir", "/tmp/a"]);
  });
});

describe("hermetic runs: the other harnesses refuse", () => {
  const supportedHermetic = new Set(["claude", "zai", "codex", "aider", "opencode"]);
  const supportedTools = new Set(["claude", "zai", "codex", "opencode", "kimi"]);
  for (const agentId of AGENT_IDS) {
    if (supportedHermetic.has(agentId) && supportedTools.has(agentId)) continue;
    test(`${agentId} refuses what it cannot do but accepts --tools default`, () => {
      const adapter = getAdapter(agentId);
      const cwd = mkdtempSync(join(tmpdir(), "codemux-hermetic-refuse-"));
      mkdirSync(join(cwd, ".git"));
      try {
        const base: RunRequest = { agent: agentId, prompt: "p", cwd, sandboxed: true, autonomy: "high" };
        if (!supportedHermetic.has(agentId)) {
          expect(adapter.capabilities().supportsHermetic ?? false).toBe(false);
          expect(() => adapter.validateRunRequest({ ...base, hermetic: true }))
            .toThrow("no verified hermetic mode");
        }
        if (!supportedTools.has(agentId)) {
          expect(adapter.capabilities().supportsToolSelection ?? false).toBe(false);
          expect(() => adapter.validateRunRequest({ ...base, tools: "none" }))
            .toThrow("cannot remove its built-in tools");
        }
        expect(() => adapter.validateRunRequest({ ...base, tools: "default" })).not.toThrow();
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    });
  }

  test("an unknown tools value is rejected", () => {
    expect(() => getAdapter("claude").validateRunRequest({ agent: "claude", prompt: "p", tools: "all" as never }))
      .toThrow("tools must be one of");
  });
});

describe("hermetic canary", () => {
  test("plants the code word in every instruction file the harnesses read", () => {
    const canary = plantCanary();
    try {
      for (const name of ["AGENTS.md", "CLAUDE.md"]) {
        expect(readFileSync(join(canary.cwd, name), "utf8")).toContain(canary.marker);
      }
      expect(statSync(join(canary.cwd, ".git")).isDirectory()).toBe(true);
    } finally {
      canary.cleanup();
    }
    expect(() => statSync(canary.cwd)).toThrow();
  });

  test("judges the model's answer: only a bare OK is clean", () => {
    expect(evaluateCanary("OK\n", "CODEMUX-CANARY-1")).toEqual({ kind: "clean" });
    expect(evaluateCanary("`OK.`\n", "CODEMUX-CANARY-1")).toEqual({ kind: "clean" });
    expect(evaluateCanary("```\nOK\n```\n", "CODEMUX-CANARY-1")).toEqual({ kind: "clean" });
    expect(evaluateCanary("CODEMUX-CANARY-1 OK", "CODEMUX-CANARY-1"))
      .toEqual({ kind: "leak", what: "marker", answer: "CODEMUX-CANARY-1" });
    expect(evaluateCanary("Laurent\n", "CODEMUX-CANARY-1"))
      .toEqual({ kind: "leak", what: "other", answer: "Laurent" });
    // An OK line beside a name is not a pass.
    expect(evaluateCanary("Some Owner\nOK\n", "CODEMUX-CANARY-1"))
      .toEqual({ kind: "leak", what: "other", answer: "Some Owner\nOK" });
  });
});

describe("env-prefixed commands", () => {
  test("both env and the program it launches are resolved and validated", () => {
    const { resolveTrustedCommand } = require("../src/executable-security.js") as typeof import("../src/executable-security.js");
    const resolved = resolveTrustedCommand(["env", "HOME=/x", "CODEX_HOME=/x/.codex", "sh", "-c", "true"], "test");
    expect(resolved[0]).toMatch(/\/env$/);
    expect(resolveTrustedCommand(["/usr/bin/env", "HOME=/x", "sh"], "test")[2]).toMatch(/\/(sh|dash)$/);
    // env keeps the name it was found under (a multi-call binary reads argv[0]).
    expect(resolveTrustedCommand(["/usr/bin/env", "HOME=/x", "sh"], "test")[0]).toBe("/usr/bin/env");
    expect(resolved.slice(1, 3)).toEqual(["HOME=/x", "CODEX_HOME=/x/.codex"]);
    // The program slot is the validated realpath: dash where /bin/sh links to it.
    expect(resolved[3]).toMatch(/\/(sh|dash)$/);
    expect(resolved.slice(4)).toEqual(["-c", "true"]);
  });

  test("a program the env prefix cannot resolve is refused", () => {
    const { resolveTrustedCommand } = require("../src/executable-security.js") as typeof import("../src/executable-security.js");
    expect(() => resolveTrustedCommand(["env", "HOME=/x", "codemux-no-such-binary"], "test"))
      .toThrow("executable 'codemux-no-such-binary' was not found");
    expect(() => resolveTrustedCommand(["env", "HOME=/x"], "test")).toThrow("names no program");
  });

  test("-u pairs before the assignments only unset a plain variable name", () => {
    const { resolveTrustedCommand } = require("../src/executable-security.js") as typeof import("../src/executable-security.js");
    const resolved = resolveTrustedCommand(
      ["env", "-u", "OPENCODE_CONFIG_DIR", "-u", "OPENCODE_CONFIG_CONTENT", "HOME=/x", "sh", "-c", "true"],
      "test"
    );
    expect(resolved.slice(1, 6)).toEqual(["-u", "OPENCODE_CONFIG_DIR", "-u", "OPENCODE_CONFIG_CONTENT", "HOME=/x"]);
    expect(resolved[6]).toMatch(/\/(sh|dash)$/);
    expect(() => resolveTrustedCommand(["env", "-u", "PATH2=x", "sh"], "test"))
      .toThrow("env prefix unsets an invalid variable name");
    expect(() => resolveTrustedCommand(["env", "-u"], "test")).toThrow("unsets an invalid variable name");
    // Every other option stays refused: -i and -S reinterpret the prefix.
    expect(() => resolveTrustedCommand(["env", "-i", "HOME=/x", "sh"], "test")).toThrow("names no program");
    expect(() => resolveTrustedCommand(["env", "-S", "HOME=/x", "sh"], "test")).toThrow("names no program");
  });

  test("a hermetic codex run refuses a repository-planted codex binary", () => {
    const { resolveTrustedCommand } = require("../src/executable-security.js") as typeof import("../src/executable-security.js");
    const repo = mkdtempSync(join(tmpdir(), "codemux-planted-"));
    try {
      writeFileSync(join(repo, "codex"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      expect(() => resolveTrustedCommand(["env", "HOME=/x", "codex"], "codex", repo, `${repo}:/usr/bin:/bin`))
        .toThrow("must not be inside the execution working directory");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
