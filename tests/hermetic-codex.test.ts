import { afterEach, describe, expect, test } from "bun:test";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexAdapter } from "../src/adapters/codex.js";
import { createCodexHermeticHome } from "../src/hermetic-home.js";
import type { RunRequest } from "../src/types.js";

describe("hermetic runs: codex", () => {
  const scratch: string[] = [];
  const adapters: CodexAdapter[] = [];
  const signalListeners = () =>
    process.listenerCount("SIGINT") + process.listenerCount("SIGTERM") + process.listenerCount("SIGHUP");
  const baseline = signalListeners();
  afterEach(() => {
    for (const adapter of adapters.splice(0)) adapter.disposeHermeticHome();
    for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
    // No home may leave a signal handler behind: a later synthetic signal
    // in another test would otherwise end the whole test process.
    expect(signalListeners()).toBe(baseline);
  });
  const codexAdapter = (env: NodeJS.ProcessEnv, home?: string): CodexAdapter => {
    const adapter = new CodexAdapter(env, home);
    adapters.push(adapter);
    return adapter;
  };

  function fakeHome(): string {
    const home = mkdtempSync(join(tmpdir(), "codemux-codex-home-"));
    scratch.push(home);
    mkdirSync(join(home, ".codex"));
    writeFileSync(join(home, ".codex", "auth.json"), '{"tokens":{"access_token":"a"}}\n', { mode: 0o600 });
    return home;
  }

  test("hermetic flags disable project docs, account and disk customizations", () => {
    const adapter = codexAdapter({}, fakeHome());
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
    const cmd = codexAdapter({}, fakeHome()).buildRunCommand({ agent: "codex", prompt: "p", tools: "none" });
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
    const adapter = codexAdapter({}, fakeHome());
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
    const cmd = codexAdapter({}, fakeHome()).buildRunCommand({ agent: "codex", prompt: "p", hermetic: true });
    expect(cmd[1]).toMatch(/^HOME=.*\.codemux-hermetic\/unprepared$/);
    expect(() => statSync(cmd[1]!.slice("HOME=".length))).toThrow();
  });

  test("plain commands are unchanged", () => {
    expect(codexAdapter({}, fakeHome()).buildRunCommand({ agent: "codex", prompt: "p" }))
      .toEqual(["codex", "exec", "--skip-git-repo-check", "--ephemeral", "--ignore-rules", "-"]);
  });

  function privateHome(cmd: string[]): { home: string; codexHome: string } {
    return { home: cmd[1]!.slice("HOME=".length), codexHome: cmd[2]!.slice("CODEX_HOME=".length) };
  }

  test("prepareRun creates a private HOME and CODEX_HOME inside the real one, holding only the linked login", () => {
    const home = fakeHome();
    const adapter = codexAdapter({}, home);
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
    const adapter = codexAdapter({ CODEX_HOME: join(profile, ".codex") }, home);
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
    expect(() => codexAdapter({}, home).prepareRun({ agent: "codex", prompt: "p", hermetic: true }))
      .toThrow(/need a file login.*Keychain.*CODEX_API_KEY/s);
  });

  test("CODEX_API_KEY makes the run API-key-only: no login is linked, with or without a login file", () => {
    const withoutLogin = mkdtempSync(join(tmpdir(), "codemux-codex-apikey-"));
    scratch.push(withoutLogin);
    mkdirSync(join(withoutLogin, ".codex"));
    for (const home of [withoutLogin, fakeHome()]) {
      const adapter = codexAdapter({ CODEX_API_KEY: "sk-test" }, home);
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
    const adapter = codexAdapter({ OPENAI_API_KEY: "sk-old" }, home);
    adapter.prepareRun({ agent: "codex", prompt: "p", hermetic: true });
    const priv = privateHome(adapter.buildRunCommand({ agent: "codex", prompt: "p", hermetic: true }));
    expect(readdirSync(priv.codexHome)).toEqual(["auth.json"]);
    expect(adapter.getRunEnv({ agent: "codex", prompt: "p", hermetic: true })).toEqual({});
  });

  test("every hermetic run gets a fresh home; an earlier run's home stays until exit", () => {
    const adapter = codexAdapter({}, fakeHome());
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
    const adapter = codexAdapter({}, fakeHome());
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
    const adapter = codexAdapter({ HOME: home });
    expect(() => adapter.validateRunRequest({ agent: "codex", prompt: "p", cwd: home }))
      .not.toThrow();
    expect(() => adapter.validateRunRequest({ agent: "codex", prompt: "p", cwd: home, hermetic: true }))
      .toThrow("refuses repository skills in a hermetic run");
    // User-level skills under HOME are hidden by the private home; only
    // HOME as the working directory makes them repository skills.
    expect(() => adapter.validateRunRequest({ agent: "codex", prompt: "p", cwd: below, hermetic: true }))
      .not.toThrow();
    expect(() => codexAdapter({}, home).validateRunRequest({ agent: "codex", prompt: "p", cwd: home, hermetic: true }))
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
    const adapter = codexAdapter({}, home);
    expect(() => adapter.validateRunRequest({ agent: "codex", prompt: "p", cwd: repo }))
      .not.toThrow();
    expect(() => adapter.validateRunRequest({ agent: "codex", prompt: "p", cwd: repo, hermetic: true }))
      .toThrow("refuses repository skills in a hermetic run");
  });
});

describe("hermetic home signal handling", () => {
  test("handlers exist only while a home is live, and finalize on a signal outside a run", () => {
    const home = mkdtempSync(join(tmpdir(), "codemux-codex-signals-"));
    mkdirSync(join(home, ".codex"));
    writeFileSync(join(home, ".codex", "auth.json"), "{}", { mode: 0o600 });
    const before = process.listenerCount("SIGHUP");
    const first = createCodexHermeticHome(join(home, ".codex"));
    const second = createCodexHermeticHome(join(home, ".codex"));
    try {
      expect(process.listenerCount("SIGHUP")).toBe(before + 1);
      first.finalize();
      expect(process.listenerCount("SIGHUP")).toBe(before + 1);
      second.finalize();
      expect(process.listenerCount("SIGHUP")).toBe(before);
      expect(() => statSync(first.home)).toThrow();
      expect(() => statSync(second.home)).toThrow();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
