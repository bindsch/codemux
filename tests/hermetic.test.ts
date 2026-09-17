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
import { OpencodeAdapter } from "../src/adapters/opencode.js";
import { ZaiAdapter } from "../src/adapters/zai.js";
import { createCodexHermeticHome } from "../src/hermetic-home.js";
import { createOpencodeHermeticHome } from "../src/opencode-hermetic.js";
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

describe("hermetic runs: aider", () => {
  const adapter = () => getAdapter("aider");

  test("--hermetic disables the repository map; everything else is pinned in every run", () => {
    const plain = adapter().buildRunCommand({ agent: "aider", prompt: "p" });
    const hermetic = adapter().buildRunCommand({ agent: "aider", prompt: "p", hermetic: true });
    expect(hermetic).toEqual([...plain.slice(0, -1), "--map-tokens", "0", plain.at(-1)!]);
    expect(hermetic).toContain("--map-tokens");
    expect(hermetic.indexOf("0")).toBe(hermetic.indexOf("--map-tokens") + 1);
  });

  test("instruction directories become --read files in plain runs only", () => {
    const cmd = adapter().buildRunCommand({
      agent: "aider",
      prompt: "p",
      instructionDirs: ["/tmp/canary"],
    });
    expect(cmd).toContain("--read");
    expect(cmd[cmd.indexOf("--read") + 1]).toBe("/tmp/canary/AGENTS.md");
    expect(cmd).toContain("/tmp/canary/CLAUDE.md");
    // Under --hermetic the channel codemux controls is simply not passed:
    // aider would load anything it is handed.
    const hermetic = adapter().buildRunCommand({
      agent: "aider",
      prompt: "p",
      hermetic: true,
      instructionDirs: ["/tmp/canary"],
    });
    expect(hermetic).not.toContain("--read");
    expect(hermetic).toContain("--map-tokens");
  });

  test("aider refuses --hermetic and --tools none until the live check runs", () => {
    const cwd = mkdtempSync(join(tmpdir(), "codemux-aider-refuse-"));
    try {
      mkdirSync(join(cwd, ".git"));
      expect(adapter().capabilities().supportsHermetic ?? false).toBe(false);
      expect(adapter().capabilities().supportsToolSelection ?? false).toBe(false);
      expect(() => adapter().validateRunRequest({ agent: "aider", prompt: "p", cwd, hermetic: true }))
        .toThrow("no verified hermetic mode");
      expect(() => adapter().validateRunRequest({ agent: "aider", prompt: "p", cwd, tools: "none" }))
        .toThrow("cannot remove its built-in tools");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe("hermetic runs: opencode", () => {
  const scratch: string[] = [];
  const adapters: OpencodeAdapter[] = [];
  afterEach(() => {
    for (const adapter of adapters.splice(0)) adapter.disposeHermeticHome();
    for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  const opencodeAdapter = (
    env: NodeJS.ProcessEnv = {}
  ): { adapter: OpencodeAdapter; home: string } => {
    const home = mkdtempSync(join(tmpdir(), "codemux-opencode-home-"));
    scratch.push(home);
    const adapter = new OpencodeAdapter(env, home);
    adapters.push(adapter);
    return { adapter, home };
  };
  // The first element after the env(1) assignments; no assignment is ever
  // exactly the program name.
  const programAt = (cmd: string[]): number =>
    cmd.findIndex((part, index) => index > 0 && part === "opencode");
  const assignment = (cmd: string[], name: string): string | undefined =>
    cmd.find((part) => part.startsWith(`${name}=`))?.slice(name.length + 1);

  test("--hermetic redirects the XDG world into a private home and keeps the real data directory", () => {
    const { adapter, home: userHome } = opencodeAdapter();
    adapter.prepareRun({ agent: "opencode", prompt: "p", hermetic: true });
    const cmd = adapter.buildRunCommand({ agent: "opencode", prompt: "p", hermetic: true, model: "m" });
    expect(cmd[0]).toBe("env");
    const program = programAt(cmd);
    expect(program).toBeGreaterThan(1);
    const home = assignment(cmd, "HOME")!;
    expect(home.startsWith(join(userHome, ".local", "share", "opencode", ".codemux-hermetic", `run-${process.pid}-`))).toBe(true);
    // Everything the operator customizes moves; the login's data directory stays.
    expect(assignment(cmd, "XDG_CONFIG_HOME")).toBe(join(home, ".config"));
    expect(assignment(cmd, "XDG_CACHE_HOME")).toBe(join(home, ".cache"));
    expect(assignment(cmd, "XDG_STATE_HOME")).toBe(join(home, ".local", "state"));
    expect(assignment(cmd, "XDG_DATA_HOME")).toBe(join(userHome, ".local", "share"));
    expect(assignment(cmd, "OPENCODE_DISABLE_PROJECT_CONFIG")).toBe("1");
    expect(assignment(cmd, "OPENCODE_DISABLE_CLAUDE_CODE")).toBe("1");
    expect(assignment(cmd, "OPENCODE_DISABLE_EXTERNAL_SKILLS")).toBe("1");
    // Passthrough neutralizers: empty is falsy where OpenCode reads them.
    expect(assignment(cmd, "OPENCODE_CONFIG")).toBe("");
    expect(assignment(cmd, "OPENCODE_CONFIG_DIR")).toBe("");
    expect(assignment(cmd, "OPENCODE_CONFIG_CONTENT")).toBe("");
    expect(assignment(cmd, "OPENCODE_PERMISSION")).toBeUndefined();
    expect(cmd.slice(program)).toEqual(["opencode", "--pure", "run", "--model", "m"]);
  });

  test("an operator XDG_DATA_HOME keeps its login; the other XDG vars are overridden", () => {
    const data = mkdtempSync(join(tmpdir(), "codemux-opencode-data-"));
    scratch.push(data);
    const { adapter } = opencodeAdapter({ XDG_CONFIG_HOME: join(data, "operator-config"), XDG_DATA_HOME: join(data, "share") });
    adapter.prepareRun({ agent: "opencode", prompt: "p", hermetic: true });
    const cmd = adapter.buildRunCommand({ agent: "opencode", prompt: "p", hermetic: true });
    const home = assignment(cmd, "HOME")!;
    expect(home.startsWith(join(data, "share", "opencode", ".codemux-hermetic", `run-${process.pid}-`))).toBe(true);
    expect(assignment(cmd, "XDG_DATA_HOME")).toBe(join(data, "share"));
    expect(assignment(cmd, "XDG_CONFIG_HOME")).toBe(join(home, ".config"));
  });

  test("--tools none denies every tool through the environment, with or without --hermetic", () => {
    const { adapter } = opencodeAdapter();
    const plain = adapter.buildRunCommand({ agent: "opencode", prompt: "p", tools: "none" });
    expect(plain).toEqual(["env", 'OPENCODE_PERMISSION={"*":"deny"}', "opencode", "--pure", "run"]);
    adapter.prepareRun({ agent: "opencode", prompt: "p", hermetic: true });
    const hermetic = adapter.buildRunCommand({ agent: "opencode", prompt: "p", hermetic: true, tools: "none" });
    expect(assignment(hermetic, "OPENCODE_PERMISSION")).toBe('{"*":"deny"}');
    expect(assignment(hermetic, "OPENCODE_DISABLE_PROJECT_CONFIG")).toBe("1");
  });

  test("plain commands are unchanged", () => {
    const { adapter } = opencodeAdapter();
    expect(adapter.buildRunCommand({ agent: "opencode", prompt: "p" }))
      .toEqual(["opencode", "--pure", "run"]);
  });

  test("a static hermetic command without prepareRun points at a home that does not exist", () => {
    const { adapter } = opencodeAdapter();
    const cmd = adapter.buildRunCommand({ agent: "opencode", prompt: "p", hermetic: true });
    expect(assignment(cmd, "HOME")).toMatch(/\.codemux-hermetic\/unprepared$/);
    expect(() => statSync(assignment(cmd, "HOME")!)).toThrow();
    expect(() => adapter.getRunEnv({ agent: "opencode", prompt: "p", hermetic: true }))
      .toThrow("was not prepared before launch");
    expect(adapter.getRunEnv({ agent: "opencode", prompt: "p" })).toEqual({});
  });

  test("every hermetic run gets a fresh home, and finalize removes it", () => {
    const { adapter } = opencodeAdapter();
    adapter.prepareRun({ agent: "opencode", prompt: "p", hermetic: true });
    const first = assignment(adapter.buildRunCommand({ agent: "opencode", prompt: "p", hermetic: true }), "HOME")!;
    expect(statSync(first).isDirectory()).toBe(true);
    adapter.prepareRun({ agent: "opencode", prompt: "p", hermetic: true });
    const second = assignment(adapter.buildRunCommand({ agent: "opencode", prompt: "p", hermetic: true }), "HOME")!;
    expect(second).not.toBe(first);
    // The earlier home stays until exit: an earlier run may still use it.
    expect(statSync(first).isDirectory()).toBe(true);
    adapter.disposeHermeticHome();
    expect(() => statSync(first)).toThrow();
    expect(() => statSync(second)).toThrow();
  });

  test("old homes of dead codemux processes are swept", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "codemux-opencode-sweep-"));
    scratch.push(dataDir);
    const parent = join(dataDir, ".codemux-hermetic");
    const old = join(parent, "run-999999999-old");
    mkdirSync(old, { recursive: true });
    const threeDaysAgo = new Date(Date.now() - 3 * 86_400_000);
    utimesSync(old, threeDaysAgo, threeDaysAgo);
    const home = createOpencodeHermeticHome(dataDir);
    expect(readdirSync(parent).filter((entry) => entry.startsWith("run-9999"))).toEqual([]);
    home.finalize();
  });

  test("a symlinked hermetic parent directory is refused", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "codemux-opencode-symlink-"));
    scratch.push(dataDir);
    const elsewhere = mkdtempSync(join(tmpdir(), "codemux-opencode-elsewhere-"));
    scratch.push(elsewhere);
    mkdirSync(join(dataDir, ".codemux-hermetic"), { recursive: true });
    rmSync(join(dataDir, ".codemux-hermetic"), { recursive: true });
    symlinkSync(elsewhere, join(dataDir, ".codemux-hermetic"));
    expect(() => createOpencodeHermeticHome(dataDir))
      .toThrow("must be a directory owned by the current user");
  });
});

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

describe("hermetic runs: droid", () => {
  test("--tools none allowlists the one tool droid pins; the autonomy mapping is untouched", () => {
    const adapter = getAdapter("droid");
    const plain = adapter.buildRunCommand({ agent: "droid", prompt: "p", autonomy: "low" });
    const none = adapter.buildRunCommand({ agent: "droid", prompt: "p", autonomy: "low", tools: "none" });
    expect(none).toEqual([...plain, "--only-tools", "ToolSearch"]);
    expect(adapter.buildRunCommand({ agent: "droid", prompt: "p", tools: "default" }))
      .toEqual(["droid", "exec"]);
  });

  test("droid refuses --hermetic and --tools none until the live probe runs", () => {
    const adapter = getAdapter("droid");
    const cwd = mkdtempSync(join(tmpdir(), "codemux-droid-refuse-"));
    try {
      mkdirSync(join(cwd, ".git"));
      // Hermetic has no mechanism: AGENTS.md and CLAUDE.md load from the
      // working directory up to the git root with no switch, and skills
      // load from both ~/.factory and ~/.agents. Tools none is implemented
      // but unclaimed: the probe needs a logged-in droid.
      expect(adapter.capabilities().supportsHermetic ?? false).toBe(false);
      expect(adapter.capabilities().supportsToolSelection ?? false).toBe(false);
      expect(() => adapter.validateRunRequest({ agent: "droid", prompt: "p", cwd, hermetic: true }))
        .toThrow("no verified hermetic mode");
      expect(() => adapter.validateRunRequest({ agent: "droid", prompt: "p", cwd, tools: "none" }))
        .toThrow("cannot remove its built-in tools");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe("hermetic runs: the other harnesses refuse", () => {
  const supportedHermetic = new Set(["claude", "zai", "codex"]);
  const supportedTools = new Set(["claude", "zai", "codex"]);
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
