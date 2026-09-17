import { afterEach, describe, expect, test } from "bun:test";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAdapter } from "../src/adapters/index.js";
import { ClaudeAdapter } from "../src/adapters/claude.js";
import { CodexAdapter } from "../src/adapters/codex.js";
import { ZaiAdapter } from "../src/adapters/zai.js";
import { createCodexHermeticHome } from "../src/hermetic-home.js";
import { evaluateCanary, plantCanary } from "../src/hermetic-canary.js";
import { AGENT_IDS, type RunRequest } from "../src/types.js";

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

describe("hermetic runs: codex", () => {
  const scratch: string[] = [];
  afterEach(() => {
    for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function fakeHome(): string {
    const home = mkdtempSync(join(tmpdir(), "codemux-codex-home-"));
    scratch.push(home);
    mkdirSync(join(home, ".codex"));
    writeFileSync(join(home, ".codex", "auth.json"), '{"tokens":{"access_token":"a"}}\n', { mode: 0o600 });
    return home;
  }

  test("hermetic flags disable project docs, account and disk customizations", () => {
    const adapter = new CodexAdapter({}, fakeHome());
    adapter.prepareRun({ agent: "codex", prompt: "p", hermetic: true });
    const cmd = adapter.buildRunCommand({ agent: "codex", prompt: "p", hermetic: true, sandboxed: true });
    // The private home reaches Codex through env(1), never through the
    // environment scode itself runs with.
    expect(cmd[0]).toBe("env");
    expect(cmd[1]).toMatch(/^HOME=.*\.codex\/\.codemux-hermetic\/run-\d+-/);
    expect(cmd[2]).toBe(`CODEX_HOME=${cmd[1]!.slice("HOME=".length)}/.codex`);
    expect(cmd.slice(3, 5)).toEqual(["codex", "-c"]);
    expect(cmd).toContain('cli_auth_credentials_store="file"');
    expect(cmd).toContain("project_doc_max_bytes=0");
    expect(cmd).toContain("include_apps_instructions=false");
    for (const feature of ["apps", "plugins", "hooks", "memories", "shell_snapshot"]) {
      expect(cmd[cmd.indexOf(feature) - 1]).toBe("--disable");
    }
    expect(cmd.slice(-6)).toEqual(["exec", "--skip-git-repo-check", "--ephemeral", "--ignore-rules", "--ignore-user-config", "-"]);
    // No tools flag unless asked.
    expect(cmd).not.toContain("shell_tool");
  });

  test("--tools none disables every tool that reaches the machine or network", () => {
    const cmd = new CodexAdapter({}, fakeHome()).buildRunCommand({ agent: "codex", prompt: "p", tools: "none" });
    expect(cmd[0]).toBe("codex");
    for (const feature of ["shell_tool", "unified_exec", "view_image", "multi_agent", "browser_use", "computer_use"]) {
      expect(cmd[cmd.indexOf(feature) - 1]).toBe("--disable");
    }
    // The top-level mode; Codex drops a boolean tools.web_search.
    expect(cmd).toContain('web_search="disabled"');
    expect(cmd).not.toContain("tools.web_search=false");
    expect(cmd).not.toContain("--ignore-user-config");
    expect(cmd.slice(-5)).toEqual(["exec", "--skip-git-repo-check", "--ephemeral", "--ignore-rules", "-"]);
  });

  test("--tools none is accepted only at read-only autonomy (apply_patch cannot be removed)", () => {
    const adapter = new CodexAdapter({}, fakeHome());
    const cwd = mkdtempSync(join(tmpdir(), "codemux-codex-ro-"));
    scratch.push(cwd);
    mkdirSync(join(cwd, ".git"));
    expect(() => adapter.validateRunRequest({ agent: "codex", prompt: "p", cwd, tools: "none" })).not.toThrow();
    expect(() => adapter.validateRunRequest({ agent: "codex", prompt: "p", cwd, tools: "none", autonomy: "read-only" })).not.toThrow();
    for (const autonomy of ["low", "medium", "high"] as const) {
      expect(() => adapter.validateRunRequest({ agent: "codex", prompt: "p", cwd, tools: "none", autonomy }))
        .toThrow("needs --auto read-only");
    }
  });

  test("a static hermetic command without prepareRun points at a home that does not exist", () => {
    const cmd = new CodexAdapter({}, fakeHome()).buildRunCommand({ agent: "codex", prompt: "p", hermetic: true });
    expect(cmd[1]).toMatch(/^HOME=.*\.codemux-hermetic\/unprepared$/);
    expect(() => statSync(cmd[1]!.slice("HOME=".length))).toThrow();
  });

  test("plain commands are unchanged", () => {
    expect(new CodexAdapter({}, fakeHome()).buildRunCommand({ agent: "codex", prompt: "p" }))
      .toEqual(["codex", "exec", "--skip-git-repo-check", "--ephemeral", "--ignore-rules", "-"]);
  });

  function privateHome(cmd: string[]): { home: string; codexHome: string } {
    return { home: cmd[1]!.slice("HOME=".length), codexHome: cmd[2]!.slice("CODEX_HOME=".length) };
  }

  test("prepareRun creates a private HOME and CODEX_HOME inside the real one, holding only the linked login", () => {
    const home = fakeHome();
    const adapter = new CodexAdapter({}, home);
    adapter.prepareRun({ agent: "codex", prompt: "p" });
    expect(adapter.buildRunCommand({ agent: "codex", prompt: "p" })[0]).toBe("codex");
    adapter.prepareRun({ agent: "codex", prompt: "p", hermetic: true });
    const cmd = adapter.buildRunCommand({ agent: "codex", prompt: "p", hermetic: true });
    const priv = privateHome(cmd);
    expect(priv.home.startsWith(join(home, ".codex", ".codemux-hermetic", `run-${process.pid}-`))).toBe(true);
    expect(readdirSync(priv.home)).toEqual([".codex"]);
    expect(readdirSync(priv.codexHome)).toEqual(["auth.json"]);
    expect(priv.codexHome).toBe(join(priv.home, ".codex"));
    const link = join(priv.codexHome, "auth.json");
    expect(statSync(link).ino).toBe(statSync(join(home, ".codex", "auth.json")).ino);
    expect(adapter.getRunEnv({ agent: "codex", prompt: "p", hermetic: true })).toEqual({});
    // Repeated builds for the same prepared run agree.
    expect(adapter.buildRunCommand({ agent: "codex", prompt: "p", hermetic: true }).slice(0, 3)).toEqual(cmd.slice(0, 3));
  });

  test("the real login is the one a plain run sees: ~/.codex, or CODEX_HOME only when passed through", () => {
    const home = fakeHome();
    const profile = fakeHome();
    const adapter = new CodexAdapter({ CODEX_HOME: join(profile, ".codex") }, home);
    // Not passed through: the sanitized child environment drops it.
    adapter.prepareRun({ agent: "codex", prompt: "p", hermetic: true });
    const priv = privateHome(adapter.buildRunCommand({ agent: "codex", prompt: "p", hermetic: true }));
    expect(priv.home.startsWith(join(home, ".codex", ".codemux-hermetic"))).toBe(true);
    expect(lstatSync(join(priv.codexHome, "auth.json")).isFile()).toBe(true);
    // Passed through: the plain run uses that profile, so the hermetic run
    // links that profile's login.
    const request: RunRequest = { agent: "codex", prompt: "p", hermetic: true, passthroughEnv: ["CODEX_HOME"] };
    adapter.prepareRun(request);
    const profiled = privateHome(adapter.buildRunCommand(request));
    expect(profiled.home.startsWith(join(profile, ".codex", ".codemux-hermetic"))).toBe(true);
  });

  test("refuses a missing file login and explains the Keychain case", () => {
    const home = mkdtempSync(join(tmpdir(), "codemux-codex-nologin-"));
    scratch.push(home);
    expect(() => new CodexAdapter({}, home).prepareRun({ agent: "codex", prompt: "p", hermetic: true }))
      .toThrow(/need a file login.*Keychain.*CODEX_API_KEY/s);
  });

  test("CODEX_API_KEY makes the run API-key-only: no login is linked, with or without a login file", () => {
    const withoutLogin = mkdtempSync(join(tmpdir(), "codemux-codex-apikey-"));
    scratch.push(withoutLogin);
    mkdirSync(join(withoutLogin, ".codex"));
    for (const home of [withoutLogin, fakeHome()]) {
      const adapter = new CodexAdapter({ CODEX_API_KEY: "sk-test" }, home);
      adapter.prepareRun({ agent: "codex", prompt: "p", hermetic: true });
      const priv = privateHome(adapter.buildRunCommand({ agent: "codex", prompt: "p", hermetic: true }));
      expect(readdirSync(priv.codexHome)).toEqual([]);
      expect(adapter.getRunEnv({ agent: "codex", prompt: "p", hermetic: true })).toEqual({});
    }
  });

  test("a stray OPENAI_API_KEY does not switch a hermetic run away from the account login", () => {
    // Codex 0.154 ignores OPENAI_API_KEY, so a plain run uses the file
    // login; the hermetic run must use the very same credential.
    const home = fakeHome();
    const adapter = new CodexAdapter({ OPENAI_API_KEY: "sk-old" }, home);
    adapter.prepareRun({ agent: "codex", prompt: "p", hermetic: true });
    const priv = privateHome(adapter.buildRunCommand({ agent: "codex", prompt: "p", hermetic: true }));
    expect(readdirSync(priv.codexHome)).toEqual(["auth.json"]);
    expect(adapter.getRunEnv({ agent: "codex", prompt: "p", hermetic: true })).toEqual({});
  });

  test("every hermetic run gets a fresh home; an earlier run's home stays until exit", () => {
    const adapter = new CodexAdapter({}, fakeHome());
    adapter.prepareRun({ agent: "codex", prompt: "p", hermetic: true });
    const first = privateHome(adapter.buildRunCommand({ agent: "codex", prompt: "p", hermetic: true }));
    writeFileSync(join(first.home, "leftover"), "x");
    adapter.prepareRun({ agent: "codex", prompt: "p", hermetic: true });
    const second = privateHome(adapter.buildRunCommand({ agent: "codex", prompt: "p", hermetic: true }));
    expect(second.home).not.toBe(first.home);
    // Still there: a run started through the same adapter may be using it.
    expect(statSync(join(first.home, "leftover")).isFile()).toBe(true);
    expect(readdirSync(second.home)).toEqual([".codex"]);
  });

  test("a symlinked hermetic parent directory is refused", () => {
    const home = fakeHome();
    const elsewhere = mkdtempSync(join(tmpdir(), "codemux-elsewhere-"));
    scratch.push(elsewhere);
    symlinkSync(elsewhere, join(home, ".codex", ".codemux-hermetic"));
    expect(() => createCodexHermeticHome(join(home, ".codex")))
      .toThrow("must be a directory owned by the current user");
  });

  test("launching without prepareRun is refused on the codemux side", () => {
    const adapter = new CodexAdapter({}, fakeHome());
    expect(() => adapter.getRunEnv({ agent: "codex", prompt: "p", hermetic: true }))
      .toThrow("was not prepared before launch");
    expect(adapter.getRunEnv({ agent: "codex", prompt: "p" })).toEqual({});
  });

  test("an in-place token rewrite reaches the real login; a replaced private file is discarded", () => {
    const home = fakeHome();
    const real = join(home, ".codex", "auth.json");
    const hermetic = createCodexHermeticHome(join(home, ".codex"));
    const link = join(hermetic.codexHome, "auth.json");
    writeFileSync(link, '{"tokens":{"access_token":"rotated"}}');
    expect(readFileSync(real, "utf8")).toContain("rotated");
    // A rename-style replacement breaks the link; nothing is ever written
    // back over the real file.
    rmSync(link);
    writeFileSync(link, '{"tokens":{"access_token":"replaced"}}');
    hermetic.finalize();
    expect(readFileSync(real, "utf8")).toContain("rotated");
    expect(() => statSync(hermetic.home)).toThrow();
  });

  test("finalize never restores a login the operator removed or replaced", () => {
    const home = fakeHome();
    const real = join(home, ".codex", "auth.json");
    const removed = createCodexHermeticHome(join(home, ".codex"));
    rmSync(real); // codex logout while the run is in flight
    removed.finalize();
    expect(() => statSync(real)).toThrow();

    writeFileSync(real, '{"tokens":{"access_token":"a"}}', { mode: 0o600 });
    const replaced = createCodexHermeticHome(join(home, ".codex"));
    rmSync(real);
    writeFileSync(real, '{"tokens":{"access_token":"fresh-login"}}', { mode: 0o600 });
    writeFileSync(join(replaced.codexHome, "auth.json"), '{"tokens":{"access_token":"stale-session"}}');
    replaced.finalize();
    expect(readFileSync(real, "utf8")).toContain("fresh-login");
  });

  test("old homes of dead codemux processes are swept; recent ones may still host a child", () => {
    const home = fakeHome();
    const parent = join(home, ".codex", ".codemux-hermetic");
    const old = join(parent, "run-999999999-old");
    const recent = join(parent, "run-999999998-recent");
    mkdirSync(join(old, ".codex"), { recursive: true });
    mkdirSync(join(recent, ".codex"), { recursive: true });
    const threeDaysAgo = new Date(Date.now() - 3 * 86_400_000);
    utimesSync(old, threeDaysAgo, threeDaysAgo);
    const hermetic = createCodexHermeticHome(join(home, ".codex"));
    const left = readdirSync(parent).filter((entry) => entry.startsWith("run-9999"));
    expect(left).toEqual(["run-999999998-recent"]);
    hermetic.finalize();
  });

  test("hermetic runs refuse repository skills found in HOME itself, but not from a directory below it", () => {
    const home = fakeHome();
    mkdirSync(join(home, ".agents", "skills", "x"), { recursive: true });
    const below = join(home, "Downloads", "work");
    mkdirSync(below, { recursive: true });
    // The adapter's effective home (seam, else $HOME) is the user home for
    // the skills walk.
    const adapter = new CodexAdapter({ HOME: home });
    expect(() => adapter.validateRunRequest({ agent: "codex", prompt: "p", cwd: home }))
      .not.toThrow();
    expect(() => adapter.validateRunRequest({ agent: "codex", prompt: "p", cwd: home, hermetic: true }))
      .toThrow("refuses repository skills in a hermetic run");
    // User-level skills under HOME are hidden by the private home; only
    // HOME as the working directory makes them repository skills.
    expect(() => adapter.validateRunRequest({ agent: "codex", prompt: "p", cwd: below, hermetic: true }))
      .not.toThrow();
    expect(() => new CodexAdapter({}, home).validateRunRequest({ agent: "codex", prompt: "p", cwd: home, hermetic: true }))
      .toThrow("refuses repository skills in a hermetic run");
    // A HOME that is itself a Git root is Codex's project root for any
    // directory below it without another root in between.
    mkdirSync(join(home, ".git"));
    expect(() => adapter.validateRunRequest({ agent: "codex", prompt: "p", cwd: below, hermetic: true }))
      .toThrow("refuses repository skills in a hermetic run");
  });

  test("hermetic runs refuse repository skills", () => {
    const home = fakeHome();
    const repo = mkdtempSync(join(tmpdir(), "codemux-codex-repo-"));
    scratch.push(repo);
    mkdirSync(join(repo, ".git"));
    mkdirSync(join(repo, ".agents", "skills", "x"), { recursive: true });
    const adapter = new CodexAdapter({}, home);
    expect(() => adapter.validateRunRequest({ agent: "codex", prompt: "p", cwd: repo }))
      .not.toThrow();
    expect(() => adapter.validateRunRequest({ agent: "codex", prompt: "p", cwd: repo, hermetic: true }))
      .toThrow("refuses repository skills in a hermetic run");
  });
});

describe("hermetic runs: the other harnesses refuse", () => {
  const supported = new Set(["claude", "zai", "codex"]);
  for (const agentId of AGENT_IDS) {
    if (supported.has(agentId)) continue;
    test(`${agentId} refuses --hermetic and --tools none but accepts --tools default`, () => {
      const adapter = getAdapter(agentId);
      const cwd = mkdtempSync(join(tmpdir(), "codemux-hermetic-refuse-"));
      mkdirSync(join(cwd, ".git"));
      try {
        const base: RunRequest = { agent: agentId, prompt: "p", cwd, sandboxed: true, autonomy: "high" };
        expect(adapter.capabilities().supportsHermetic ?? false).toBe(false);
        expect(() => adapter.validateRunRequest({ ...base, hermetic: true }))
          .toThrow("no verified hermetic mode");
        expect(() => adapter.validateRunRequest({ ...base, tools: "none" }))
          .toThrow("cannot remove its built-in tools");
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
    expect(resolveTrustedCommand(["/usr/bin/env", "HOME=/x", "sh"], "test")[2]).toMatch(/\/sh$/);
    // env keeps the name it was found under (a multi-call binary reads argv[0]).
    expect(resolveTrustedCommand(["/usr/bin/env", "HOME=/x", "sh"], "test")[0]).toBe("/usr/bin/env");
    expect(resolved.slice(1, 3)).toEqual(["HOME=/x", "CODEX_HOME=/x/.codex"]);
    expect(resolved[3]).toMatch(/\/sh$/);
    expect(resolved.slice(4)).toEqual(["-c", "true"]);
  });

  test("a program the env prefix cannot resolve is refused", () => {
    const { resolveTrustedCommand } = require("../src/executable-security.js") as typeof import("../src/executable-security.js");
    expect(() => resolveTrustedCommand(["env", "HOME=/x", "codemux-no-such-binary"], "test"))
      .toThrow("executable 'codemux-no-such-binary' was not found");
    expect(() => resolveTrustedCommand(["env", "HOME=/x"], "test")).toThrow("names no program");
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
