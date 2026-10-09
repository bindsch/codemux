import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
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
import { pathToFileURL } from "node:url";
import { Database } from "bun:sqlite";
import { getAdapter } from "../src/adapters/index.js";
import type { RunContext } from "../src/adapters/base.js";
import { KimiAdapter } from "../src/adapters/kimi.js";
import { OpencodeAdapter } from "../src/adapters/opencode.js";
import { createOpencodeHermeticHome } from "../src/opencode-hermetic.js";
import { opencodeRemoteConfigCarrier } from "../src/opencode-remote-config.js";
import { writeKimiNoToolsFile } from "../src/kimi-no-tools.js";
import type { RunRequest } from "../src/types.js";

// The per-harness --hermetic / --tools none mappings. OpenCode claims both;
// droid, kimi, pi and goose claim --tools none (all verified live through
// provider overrides). Aider refuses both — its --tools none has nothing to
// map onto, and its --hermetic refusal (2026-10-04 review) rides aider's
// own .aider.conf.yml/.env/.aider.model.settings.yml searches having no
// switch. Copilot refuses both on live evidence; the mechanisms the branch
// had implemented behind its refusals are removed as dead surface in 0.7.0
// (docs/HERMETIC.md).

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

  test("aider refuses --hermetic on its config layers and --tools none on its empty tool set", () => {
    const cwd = mkdtempSync(join(tmpdir(), "codemux-aider-claim-"));
    try {
      mkdirSync(join(cwd, ".git"));
      // --hermetic is refused (2026-10-04 review): the pinned flags close
      // only what codemux hands aider, while aider itself loads
      // .aider.conf.yml, .env and .aider.model.settings.yml from the home,
      // git root and working directory with no switch to stop it — the
      // check's canary never rode those channels, so the 2026-09-17 pass
      // certified what the flags do not close (docs/HERMETIC.md). The
      // --map-tokens mapping above stays for the day that changes.
      expect(adapter().capabilities().supportsHermetic ?? false).toBe(false);
      expect(() => adapter().validateRunRequest({ agent: "aider", prompt: "p", cwd, hermetic: true }))
        .toThrow("no verified hermetic mode");
      expect(adapter().capabilities().supportsToolSelection ?? false).toBe(false);
      expect(() => adapter().validateRunRequest({ agent: "aider", prompt: "p", cwd, tools: "none" }))
        .toThrow("cannot remove its built-in tools");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe("hermetic runs: opencode", () => {
  const scratch: string[] = [];
  // Every context this describe prepares, disposed per launch -- the same
  // ownership rule the launcher follows, never a whole-adapter sweep.
  const prepared: { adapter: OpencodeAdapter; context: RunContext }[] = [];
  afterEach(() => {
    for (const { adapter, context } of prepared.splice(0)) adapter.cleanupRun(context);
    for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  const opencodeAdapter = (
    env: NodeJS.ProcessEnv = {}
  ): { adapter: OpencodeAdapter; home: string } => {
    const home = mkdtempSync(join(tmpdir(), "codemux-opencode-home-"));
    scratch.push(home);
    const adapter = new OpencodeAdapter(env, home);
    return { adapter, home };
  };
  const prepare = (adapter: OpencodeAdapter, request: RunRequest): RunContext => {
    const context = adapter.prepareRun(request);
    prepared.push({ adapter, context });
    return context;
  };
  // The first element after the env(1) assignments; no assignment is ever
  // exactly the program name.
  const programAt = (cmd: string[]): number =>
    cmd.findIndex((part, index) => index > 0 && part === "opencode");
  const assignment = (cmd: string[], name: string): string | undefined =>
    cmd.find((part) => part.startsWith(`${name}=`))?.slice(name.length + 1);

  test("--hermetic redirects the XDG world into a private home and keeps the real data directory", () => {
    const { adapter, home: userHome } = opencodeAdapter();
    const request: RunRequest = { agent: "opencode", prompt: "p", hermetic: true };
    const cmd = adapter.buildRunCommand({ ...request, model: "m" }, prepare(adapter, request));
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
    // Passthrough neutralizers: removed, never blanked — an empty
    // OPENCODE_CONFIG_DIR survives `??` in Global.Path.config and turns the
    // global AGENTS.md path into a project-relative one (a live leak at
    // 1.18.18; see the adapter comment). OPENCODE_AUTH_CONTENT joins them:
    // Auth.all reads it before auth.json, so it is login state codemux
    // never inspected.
    const unset = (cmd: string[]): string[] =>
      cmd.filter((_, index) => index > 0 && cmd[index - 1] === "-u").sort();
    expect(unset(cmd)).toEqual([
      "OPENCODE_AUTH_CONTENT",
      "OPENCODE_CONFIG",
      "OPENCODE_CONFIG_CONTENT",
      "OPENCODE_CONFIG_DIR",
    ]);
    expect(assignment(cmd, "OPENCODE_CONFIG")).toBeUndefined();
    expect(assignment(cmd, "OPENCODE_CONFIG_DIR")).toBeUndefined();
    expect(assignment(cmd, "OPENCODE_CONFIG_CONTENT")).toBeUndefined();
    expect(assignment(cmd, "OPENCODE_PERMISSION")).toBeUndefined();
    expect(cmd.slice(program)).toEqual(["opencode", "--pure", "run", "--format", "json", "--model", "m"]);
  });

  test("an operator XDG_DATA_HOME keeps its login; the other XDG vars are overridden", () => {
    const data = mkdtempSync(join(tmpdir(), "codemux-opencode-data-"));
    scratch.push(data);
    const { adapter } = opencodeAdapter({ XDG_CONFIG_HOME: join(data, "operator-config"), XDG_DATA_HOME: join(data, "share") });
    const request: RunRequest = { agent: "opencode", prompt: "p", hermetic: true };
    const cmd = adapter.buildRunCommand(request, prepare(adapter, request));
    const home = assignment(cmd, "HOME")!;
    expect(home.startsWith(join(data, "share", "opencode", ".codemux-hermetic", `run-${process.pid}-`))).toBe(true);
    expect(assignment(cmd, "XDG_DATA_HOME")).toBe(join(data, "share"));
    expect(assignment(cmd, "XDG_CONFIG_HOME")).toBe(join(home, ".config"));
  });

  test("--tools none denies every tool through the environment on hermetic runs; plain runs refuse it", () => {
    const { adapter } = opencodeAdapter();
    // Regression (h2 review): a plain run's operator config can override the
    // deny per agent — verified live at 1.18.18, where an
    // `agent.build.permission = {"bash": "allow"}` entry put bash back in the
    // model's request under `OPENCODE_PERMISSION={"*":"deny"}` — so the
    // capability refuses everywhere it cannot be guaranteed.
    expect(() => adapter.buildRunCommand({ agent: "opencode", prompt: "p", tools: "none" }))
      .toThrow("requires --hermetic");
    const request: RunRequest = { agent: "opencode", prompt: "p", hermetic: true, tools: "none" };
    const hermetic = adapter.buildRunCommand(request, prepare(adapter, request));
    expect(assignment(hermetic, "OPENCODE_PERMISSION")).toBe('{"*":"deny"}');
    expect(assignment(hermetic, "OPENCODE_DISABLE_PROJECT_CONFIG")).toBe("1");
  });

  test("opencode claims --hermetic and --tools none on hermetic runs (verified live)", () => {
    const { adapter } = opencodeAdapter();
    const cwd = mkdtempSync(join(tmpdir(), "codemux-opencode-claim-"));
    scratch.push(cwd);
    try {
      mkdirSync(join(cwd, ".git"));
      // Both passed the live checks on 2026-09-17 through a provider
      // override (GLM-5.3 via Z.AI): the two-probe check leaked through its
      // control probe, and the --tools none capability probes could neither
      // read a file nor run a command. The h2 review later scoped --tools
      // none to hermetic runs (the plain-run denial is overridable from
      // operator config).
      expect(adapter.capabilities().supportsHermetic ?? false).toBe(true);
      expect(() => adapter.validateRunRequest({ agent: "opencode", prompt: "p", cwd, hermetic: true }))
        .not.toThrow();
      expect(adapter.capabilities().supportsToolSelection ?? false).toBe(true);
      expect(() => adapter.validateRunRequest({ agent: "opencode", prompt: "p", cwd, hermetic: true, tools: "none" }))
        .not.toThrow();
      expect(() => adapter.validateRunRequest({ agent: "opencode", prompt: "p", cwd, tools: "none" }))
        .toThrow("requires --hermetic");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("plain commands are unchanged by the hermetic machinery", () => {
    // No env(1) prefix and no private home; the always-on --format json is
    // part of every opencode run now, plain ones included.
    const { adapter } = opencodeAdapter();
    expect(adapter.buildRunCommand({ agent: "opencode", prompt: "p" }))
      .toEqual(["opencode", "--pure", "run", "--format", "json"]);
  });

  test("a login carrying remote configuration refuses --hermetic", () => {
    // Regression (h3 review): OpenCode's config load fetches a well-known
    // login's .well-known/opencode document and an active organization's
    // /api/config, merging both as global config — agent permissions
    // included, which append after the --tools none deny — so a hermetic
    // run refuses while either carrier exists instead of claiming a
    // guarantee the login breaks (opencode-remote-config.ts,
    // docs/HERMETIC.md).
    const { adapter, home: userHome } = opencodeAdapter();
    const dataDir = join(userHome, ".local", "share", "opencode");
    mkdirSync(dataDir, { recursive: true });
    const request: RunRequest = { agent: "opencode", prompt: "p", hermetic: true };
    const authStore = (entries: Record<string, unknown>): void =>
      writeFileSync(join(dataDir, "auth.json"), JSON.stringify(entries));
    const orgStore = (orgId: string | null): void => {
      const db = new Database(join(dataDir, "opencode.db"));
      db.exec("CREATE TABLE account (id TEXT PRIMARY KEY, url TEXT NOT NULL)");
      db.exec(
        "CREATE TABLE account_state (id INTEGER PRIMARY KEY, active_account_id TEXT, active_org_id TEXT)"
      );
      db.exec("INSERT INTO account VALUES ('acct', 'https://console.example')");
      db.exec(
        orgId === null
          ? "INSERT INTO account_state VALUES (1, 'acct', NULL)"
          : `INSERT INTO account_state VALUES (1, 'acct', '${orgId}')`
      );
      db.close();
    };

    // A well-known login in the auth store: both refusal sites fail closed.
    authStore({
      "https://proxy.example": { type: "wellknown", key: "k", token: "t" },
      anthropic: { type: "oauth", refresh: "r", access: "a", expires: 1 },
    });
    expect(() => adapter.validateRunRequest(request))
      .toThrow("refused while the login carries remote configuration");
    expect(() => adapter.buildRunCommand(request)).toThrow("well-known login");
    // Plain runs carry the operator's own channels by design; nothing
    // about the login refuses them.
    expect(adapter.buildRunCommand({ agent: "opencode", prompt: "p" }))
      .toEqual(["opencode", "--pure", "run", "--format", "json"]);

    // An account with an active organization is the same carrier; without
    // the organization the account carries nothing remote.
    authStore({ anthropic: { type: "oauth", refresh: "r", access: "a", expires: 1 } });
    orgStore("org-1");
    expect(() => adapter.buildRunCommand(request)).toThrow("active organization");
    rmSync(join(dataDir, "opencode.db"), { force: true });
    orgStore(null);
    const cmd = adapter.buildRunCommand(request, prepare(adapter, request));
    expect(assignment(cmd, "XDG_DATA_HOME")).toBe(join(userHome, ".local", "share"));

    // A store that exists but cannot be read fails closed too.
    rmSync(join(dataDir, "opencode.db"), { force: true });
    writeFileSync(join(dataDir, "opencode.db"), "not a database\n");
    expect(() => adapter.buildRunCommand(request)).toThrow("could not be read");
  });

  test("a login store the inspection cannot read fails closed fast instead of hanging", () => {
    // Regression (h6 review): the auth.json inspection runs during
    // validation, before the subprocess timeout starts, and a bare
    // readFileSync parked forever on a FIFO a harness left in place of the
    // store. The read is bounded, nonblocking and no-final-symlink now
    // (readUtf8FileBounded); anything but an absent, regular, parsable
    // store fails closed naming the file, and the account store is
    // lstat'd to a regular file before SQLite opens it — its own open has
    // the same two shapes. The FIFO cases run in a child process, so a
    // regression fails this test instead of hanging the suite.
    if (process.platform === "win32") return;
    const dataDir = mkdtempSync(join(tmpdir(), "codemux-opencode-store-"));
    scratch.push(dataDir);
    const request: RunRequest = { agent: "opencode", prompt: "p", hermetic: true };
    const { adapter, home: userHome } = opencodeAdapter();
    const realStore = join(userHome, ".local", "share", "opencode");
    mkdirSync(realStore, { recursive: true });
    const authJson = join(realStore, "auth.json");

    // A symlinked store OpenCode would follow: refused, not read.
    writeFileSync(join(realStore, "real.json"), "{}");
    symlinkSync(join(realStore, "real.json"), authJson);
    expect(() => adapter.buildRunCommand(request)).toThrow(
      "the auth store"
    );
    expect(opencodeRemoteConfigCarrier(realStore)).toContain("could not be read");

    // A store too large or unparsable to inspect: the same refusal.
    rmSync(authJson);
    writeFileSync(authJson, "x".repeat(1024 * 1024 + 1));
    expect(opencodeRemoteConfigCarrier(realStore)).toContain("could not be read");
    rmSync(authJson);
    writeFileSync(authJson, "not json");
    expect(opencodeRemoteConfigCarrier(realStore)).toContain("could not be read");

    // A FIFO in place of either store: the read returns the refusal, in
    // seconds, not a hang (the h6 auditor's reproduction needed SIGKILL).
    rmSync(authJson);
    expect(Bun.spawnSync(["mkfifo", authJson]).exitCode).toBe(0);
    const db = join(realStore, "opencode.db");
    expect(Bun.spawnSync(["mkfifo", db]).exitCode).toBe(0);
    const moduleUrl = pathToFileURL(
      join(import.meta.dir, "..", "src", "opencode-remote-config.ts")
    ).href;
    const script = [
      `import { opencodeRemoteConfigCarrier } from ${JSON.stringify(moduleUrl)};`,
      `console.log(opencodeRemoteConfigCarrier(${JSON.stringify(realStore)}));`,
    ].join("\n");
    const child = Bun.spawnSync([process.execPath, "-e", script], {
      timeout: 10_000,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(child.exitCode).toBe(0);
    const out = new TextDecoder().decode(child.stdout);
    expect(out).toContain("the auth store");
    expect(out).toContain("could not be read");
  });

  test.skipIf(
    process.platform === "win32" ||
      (typeof process.getuid === "function" && process.getuid() === 0)
  )("a stale home the sweep cannot remove neither throws nor blocks later sweeps", () => {
    // Regression (h6 review): the h4 sweep hardening missed the OpenCode
    // hermetic home sweep — the sixth — so an unremovable stale home threw
    // out of it and failed every later hermetic launch, the exact claim
    // "no longer blocks every later run" the h4 round made. The sweep now
    // warns and moves on, like the five it hardened.
    const dataDir = mkdtempSync(join(tmpdir(), "codemux-opencode-sweep-"));
    scratch.push(dataDir);
    const parent = join(dataDir, ".codemux-hermetic");
    // A stale home whose interior cannot be emptied: recursive rm throws,
    // deterministically, wherever unlink needs write permission the mode
    // denies. The h4 round declined a chmod fixture for the recursive
    // sweeps because it does not hold under root; this test skips there
    // for that reason and runs everywhere else.
    const bad = join(parent, "run-999999999-bad");
    const locked = join(bad, "locked");
    mkdirSync(locked, { recursive: true });
    writeFileSync(join(locked, "file.txt"), "x");
    chmodSync(locked, 0o500);
    const threeDaysAgo = new Date(Date.now() - 3 * 86_400_000);
    utimesSync(bad, threeDaysAgo, threeDaysAgo);
    const good = join(parent, "run-999999998-good");
    mkdirSync(good, { recursive: true });
    utimesSync(good, threeDaysAgo, threeDaysAgo);
    let home: ReturnType<typeof createOpencodeHermeticHome> | undefined;
    try {
      home = createOpencodeHermeticHome(dataDir);
      // The bad home stays (only the operator can remove it), the good
      // stale home is still swept, and nothing threw.
      expect(statSync(bad).isDirectory()).toBe(true);
      expect(existsSync(good)).toBe(false);
    } finally {
      chmodSync(locked, 0o700);
      home?.finalize();
    }
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

  test("every hermetic run gets a fresh home; cleanupRun removes each launch's own only", () => {
    const { adapter } = opencodeAdapter();
    const request: RunRequest = { agent: "opencode", prompt: "p", hermetic: true };
    const firstContext = prepare(adapter, request);
    const first = assignment(adapter.buildRunCommand(request, firstContext), "HOME")!;
    expect(statSync(first).isDirectory()).toBe(true);
    const secondContext = prepare(adapter, request);
    const second = assignment(adapter.buildRunCommand(request, secondContext), "HOME")!;
    expect(second).not.toBe(first);
    // The earlier home stays until its own launch ends: an earlier run may
    // still use it.
    expect(statSync(first).isDirectory()).toBe(true);
    adapter.cleanupRun(firstContext);
    expect(() => statSync(first)).toThrow();
    expect(statSync(second).isDirectory()).toBe(true);
  });

  test("old homes of dead codemux processes are swept", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "codemux-opencode-sweep-"));
    scratch.push(dataDir);
    const parent = join(dataDir, ".codemux-hermetic");
    const old = join(parent, "run-999999999-old");
    mkdirSync(old, { recursive: true });
    const threeDaysAgo = new Date(Date.now() - 3 * 86_400_000);
    utimesSync(old, threeDaysAgo, threeDaysAgo);
    // A fresh home of a dead pid stays: the sweep is age-gated, not a
    // wholesale delete of every dead process's artifact.
    const fresh = join(parent, "run-999999998-fresh");
    mkdirSync(fresh, { recursive: true });
    const home = createOpencodeHermeticHome(dataDir);
    expect(readdirSync(parent).filter((entry) => entry.startsWith("run-9999")))
      .toEqual(["run-999999998-fresh"]);
    expect(statSync(fresh).isDirectory()).toBe(true);
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

describe("hermetic runs: droid", () => {
  test("--tools none allowlists the one tool droid pins; the autonomy mapping is untouched", () => {
    const adapter = getAdapter("droid");
    const plain = adapter.buildRunCommand({ agent: "droid", prompt: "p", autonomy: "low" });
    const none = adapter.buildRunCommand({ agent: "droid", prompt: "p", autonomy: "low", tools: "none" });
    expect(none).toEqual([...plain, "--only-tools", "ToolSearch"]);
    expect(adapter.buildRunCommand({ agent: "droid", prompt: "p", tools: "default" }))
      .toEqual(["droid", "exec"]);
  });

  test("droid claims --tools none (verified live); --hermetic stays refused", () => {
    const adapter = getAdapter("droid");
    const cwd = mkdtempSync(join(tmpdir(), "codemux-droid-claim-"));
    try {
      mkdirSync(join(cwd, ".git"));
      // The capability probes ran live on 2026-09-17 through a provider
      // override (GLM-5.3 via Z.AI riding a per-run BYOK settings file, so
      // no Factory login was needed): under --tools none neither the read
      // probe nor the shell probe could produce its secret, while a plain
      // run produced both. Hermetic stays refused — instruction files load
      // from the working directory up to the git root with no switch, and
      // skills load from both ~/.factory and ~/.agents (docs/HERMETIC.md).
      expect(adapter.capabilities().supportsToolSelection ?? false).toBe(true);
      expect(() => adapter.validateRunRequest({ agent: "droid", prompt: "p", cwd, tools: "none" }))
        .not.toThrow();
      expect(adapter.capabilities().supportsHermetic ?? false).toBe(false);
      expect(() => adapter.validateRunRequest({ agent: "droid", prompt: "p", cwd, hermetic: true }))
        .toThrow("no verified hermetic mode");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe("hermetic runs: kimi", () => {
  const scratch: string[] = [];
  // Every context this describe prepares, disposed per launch -- the same
  // ownership rule the launcher follows, never a whole-adapter sweep.
  const prepared: { adapter: KimiAdapter; context: RunContext }[] = [];
  afterEach(() => {
    for (const { adapter, context } of prepared.splice(0)) adapter.cleanupRun(context);
    for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  const kimiAdapter = (env: NodeJS.ProcessEnv = {}): KimiAdapter => {
    const home = mkdtempSync(join(tmpdir(), "codemux-kimi-home-"));
    scratch.push(home);
    return new KimiAdapter(env, home);
  };
  const prepare = (adapter: KimiAdapter, request: RunRequest): RunContext => {
    const context = adapter.prepareRun(request);
    prepared.push({ adapter, context });
    return context;
  };
  const agentFileOf = (cmd: string[]): string =>
    cmd[cmd.indexOf("--agent-file") + 1]!;

  test("--tools none selects a generated agent file whose allowlist is empty and whose body is the base prompt", () => {
    const adapter = kimiAdapter();
    const request: RunRequest = { agent: "kimi", prompt: "p", tools: "none" };
    const cmd = adapter.buildRunCommand(request, prepare(adapter, request));
    const path = agentFileOf(cmd);
    expect(path).toContain(join(".kimi-code", ".codemux", `no-tools-${process.pid}-`));
    const text = readFileSync(path, "utf8");
    expect(text).toContain("tools: []");
    expect(text.trimEnd().endsWith("${base_prompt}")).toBe(true);
    expect(cmd[cmd.indexOf("--agent-file") + 2]).toBe("--prompt");
    expect(adapter.buildRunCommand({ agent: "kimi", prompt: "p" }))
      .toEqual(["kimi", "--prompt", "p"]);
    expect(adapter.buildRunCommand({ agent: "kimi", prompt: "p", tools: "default" }))
      .toEqual(["kimi", "--prompt", "p"]);
  });

  test("kimi claims --tools none (verified live); --hermetic stays refused", () => {
    const adapter = kimiAdapter();
    const cwd = mkdtempSync(join(tmpdir(), "codemux-kimi-claim-"));
    scratch.push(cwd);
    try {
      mkdirSync(join(cwd, ".git"));
      // The capability probes ran live on 2026-09-17 through a provider
      // override (GLM-5.3 via Z.AI): under --tools none neither the read
      // probe nor the shell probe could produce its secret, while a plain
      // run produced both. Hermetic stays refused — the same control probe
      // leaked the planted code word through ~/.agents/AGENTS.md and the
      // project AGENTS.md (docs/HERMETIC.md).
      expect(adapter.capabilities().supportsToolSelection ?? false).toBe(true);
      expect(() => adapter.validateRunRequest({ agent: "kimi", prompt: "p", cwd, tools: "none" }))
        .not.toThrow();
      expect(adapter.capabilities().supportsHermetic ?? false).toBe(false);
      expect(() => adapter.validateRunRequest({ agent: "kimi", prompt: "p", cwd, hermetic: true }))
        .toThrow("no verified hermetic mode");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("the brand home follows a passed-through KIMI_CODE_HOME, never a stray one", () => {
    const profile = mkdtempSync(join(tmpdir(), "codemux-kimi-profile-"));
    scratch.push(profile);
    const droppedAdapter = kimiAdapter({ KIMI_CODE_HOME: profile });
    const droppedRequest: RunRequest = { agent: "kimi", prompt: "p", tools: "none" };
    const dropped = agentFileOf(
      droppedAdapter.buildRunCommand(droppedRequest, prepare(droppedAdapter, droppedRequest))
    );
    expect(dropped).not.toContain(profile);
    const passedAdapter = kimiAdapter({ KIMI_CODE_HOME: profile });
    const request: RunRequest = { agent: "kimi", prompt: "p", tools: "none", passthroughEnv: ["KIMI_CODE_HOME"] };
    expect(agentFileOf(passedAdapter.buildRunCommand(request, prepare(passedAdapter, request))))
      .toContain(profile);
  });

  test("every prepared run gets a fresh file; cleanupRun removes each launch's own only", () => {
    const adapter = kimiAdapter();
    const request: RunRequest = { agent: "kimi", prompt: "p", tools: "none" };
    const firstContext = prepare(adapter, request);
    const first = agentFileOf(adapter.buildRunCommand(request, firstContext));
    expect(statSync(first).isFile()).toBe(true);
    const secondContext = prepare(adapter, request);
    const second = agentFileOf(adapter.buildRunCommand(request, secondContext));
    expect(second).not.toBe(first);
    // The earlier file stays until its own launch ends: an earlier run may
    // still read it.
    expect(statSync(first).isFile()).toBe(true);
    adapter.cleanupRun(firstContext);
    expect(() => statSync(first)).toThrow();
    expect(statSync(second).isFile()).toBe(true);
  });

  test("a static --tools none command without prepareRun points at a file that does not exist", () => {
    const adapter = kimiAdapter();
    const cmd = adapter.buildRunCommand({ agent: "kimi", prompt: "p", tools: "none" });
    expect(agentFileOf(cmd)).toMatch(/\.codemux\/unprepared$/);
    expect(() => statSync(agentFileOf(cmd))).toThrow();
  });

  test("stale files of dead codemux processes are swept", () => {
    const home = mkdtempSync(join(tmpdir(), "codemux-kimi-sweep-"));
    scratch.push(home);
    const brand = join(home, ".kimi-code");
    const parent = join(brand, ".codemux");
    mkdirSync(parent, { recursive: true });
    const old = join(parent, "no-tools-999999999-old.md");
    writeFileSync(old, "x");
    const threeDaysAgo = new Date(Date.now() - 3 * 86_400_000);
    utimesSync(old, threeDaysAgo, threeDaysAgo);
    // A fresh file of a dead pid stays: the sweep is age-gated, not a
    // wholesale delete of every dead process's artifact.
    const fresh = join(parent, "no-tools-999999998-fresh.md");
    writeFileSync(fresh, "x");
    const file = writeKimiNoToolsFile(brand);
    expect(readdirSync(parent).filter((entry) => entry.startsWith("no-tools-9999")))
      .toEqual(["no-tools-999999998-fresh.md"]);
    expect(statSync(fresh).isFile()).toBe(true);
    file.finalize();
  });

  test("a stale entry the sweep cannot remove neither throws nor blocks later sweeps", () => {
    // Regression (h4 review): a directory named like the no-tools file is
    // beyond a non-recursive rm, and one such entry used to throw out of
    // the sweep and fail every later run; the sweep now warns and moves on.
    const home = mkdtempSync(join(tmpdir(), "codemux-kimi-bad-sweep-"));
    scratch.push(home);
    const brand = join(home, ".kimi-code");
    const parent = join(brand, ".codemux");
    mkdirSync(parent, { recursive: true });
    const bad = join(parent, "no-tools-999999997-bad.md");
    mkdirSync(bad);
    const threeDaysAgo = new Date(Date.now() - 3 * 86_400_000);
    utimesSync(bad, threeDaysAgo, threeDaysAgo);
    const old = join(parent, "no-tools-999999999-old.md");
    writeFileSync(old, "x");
    utimesSync(old, threeDaysAgo, threeDaysAgo);
    const file = writeKimiNoToolsFile(brand);
    expect(statSync(bad).isDirectory()).toBe(true);
    expect(() => statSync(old)).toThrow();
    file.finalize();
  });

  test("a symlinked .codemux parent is refused", () => {
    const home = mkdtempSync(join(tmpdir(), "codemux-kimi-symlink-"));
    scratch.push(home);
    const elsewhere = mkdtempSync(join(tmpdir(), "codemux-kimi-elsewhere-"));
    scratch.push(elsewhere);
    const brand = join(home, ".kimi-code");
    mkdirSync(join(brand, ".codemux"), { recursive: true });
    rmSync(join(brand, ".codemux"), { recursive: true });
    symlinkSync(elsewhere, join(brand, ".codemux"));
    expect(() => writeKimiNoToolsFile(brand))
      .toThrow("must be a directory owned by the current user");
  });

});

describe("hermetic runs: copilot", () => {
  test("copilot refuses --hermetic and --tools none on live evidence at the installed 1.0.85", () => {
    const adapter = getAdapter("copilot");
    const cwd = mkdtempSync(join(tmpdir(), "codemux-copilot-refuse-"));
    try {
      mkdirSync(join(cwd, ".git"));
      // Both capabilities are refused on the 2026-09-17 live pass: no argv
      // spelling of an empty --available-tools allowlist disarms the
      // tools, and the check's control probe cannot leak the planted code
      // word because --no-custom-instructions rides every run
      // (docs/HERMETIC.md). The mechanisms the branch had implemented
      // behind the refusals (the private COPILOT_HOME, the BYOK provider
      // override) are removed as dead surface in 0.7.0; the refusals and
      // their evidence stay.
      expect(adapter.capabilities().supportsHermetic ?? false).toBe(false);
      expect(adapter.capabilities().supportsToolSelection ?? false).toBe(false);
      expect(() => adapter.validateRunRequest({ agent: "copilot", prompt: "p", cwd, hermetic: true }))
        .toThrow("no verified hermetic mode");
      expect(() => adapter.validateRunRequest({ agent: "copilot", prompt: "p", cwd, tools: "none" }))
        .toThrow("cannot remove its built-in tools");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
