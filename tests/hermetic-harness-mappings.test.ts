import { afterEach, describe, expect, test } from "bun:test";
import {
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
import { CopilotAdapter } from "../src/adapters/copilot.js";
import { KimiAdapter } from "../src/adapters/kimi.js";
import { OpencodeAdapter } from "../src/adapters/opencode.js";
import { createCopilotHermeticHome } from "../src/copilot-hermetic.js";
import { createOpencodeHermeticHome } from "../src/opencode-hermetic.js";
import { writeKimiNoToolsFile } from "../src/kimi-no-tools.js";

// The per-harness --hermetic / --tools none mappings. Aider and OpenCode
// are claimed (verified live through provider overrides); Copilot, droid
// and kimi keep their capabilities off until a live probe passes
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

  test("aider claims --hermetic (verified live) and refuses --tools none", () => {
    const cwd = mkdtempSync(join(tmpdir(), "codemux-aider-claim-"));
    try {
      mkdirSync(join(cwd, ".git"));
      // The live two-probe check passed on 2026-09-17 through a provider
      // override (GLM-5.3 via Z.AI); --tools none still has nothing to map
      // onto: aider has no tool set to remove.
      expect(adapter().capabilities().supportsHermetic ?? false).toBe(true);
      expect(() => adapter().validateRunRequest({ agent: "aider", prompt: "p", cwd, hermetic: true }))
        .not.toThrow();
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
    // Passthrough neutralizers: removed, never blanked — an empty
    // OPENCODE_CONFIG_DIR survives `??` in Global.Path.config and turns the
    // global AGENTS.md path into a project-relative one (a live leak at
    // 1.18.18; see the adapter comment).
    const unset = (cmd: string[]): string[] =>
      cmd.filter((_, index) => index > 0 && cmd[index - 1] === "-u").sort();
    expect(unset(cmd)).toEqual(["OPENCODE_CONFIG", "OPENCODE_CONFIG_CONTENT", "OPENCODE_CONFIG_DIR"]);
    expect(assignment(cmd, "OPENCODE_CONFIG")).toBeUndefined();
    expect(assignment(cmd, "OPENCODE_CONFIG_DIR")).toBeUndefined();
    expect(assignment(cmd, "OPENCODE_CONFIG_CONTENT")).toBeUndefined();
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

  test("opencode claims --hermetic and --tools none (verified live)", () => {
    const { adapter } = opencodeAdapter();
    const cwd = mkdtempSync(join(tmpdir(), "codemux-opencode-claim-"));
    scratch.push(cwd);
    try {
      mkdirSync(join(cwd, ".git"));
      // Both passed the live checks on 2026-09-17 through a provider
      // override (GLM-5.3 via Z.AI): the two-probe check leaked through its
      // control probe, and the --tools none capability probes could neither
      // read a file nor run a command.
      expect(adapter.capabilities().supportsHermetic ?? false).toBe(true);
      expect(() => adapter.validateRunRequest({ agent: "opencode", prompt: "p", cwd, hermetic: true }))
        .not.toThrow();
      expect(adapter.capabilities().supportsToolSelection ?? false).toBe(true);
      expect(() => adapter.validateRunRequest({ agent: "opencode", prompt: "p", cwd, tools: "none" }))
        .not.toThrow();
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
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

describe("hermetic runs: kimi", () => {
  const scratch: string[] = [];
  const adapters: KimiAdapter[] = [];
  afterEach(() => {
    for (const adapter of adapters.splice(0)) adapter.disposeNoToolsFiles();
    for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  const kimiAdapter = (env: NodeJS.ProcessEnv = {}): KimiAdapter => {
    const home = mkdtempSync(join(tmpdir(), "codemux-kimi-home-"));
    scratch.push(home);
    const adapter = new KimiAdapter(env, home);
    adapters.push(adapter);
    return adapter;
  };
  const agentFileOf = (cmd: string[]): string =>
    cmd[cmd.indexOf("--agent-file") + 1]!;

  test("--tools none selects a generated agent file whose allowlist is empty and whose body is the base prompt", () => {
    const adapter = kimiAdapter();
    adapter.prepareRun({ agent: "kimi", prompt: "p", tools: "none" });
    const cmd = adapter.buildRunCommand({ agent: "kimi", prompt: "p", tools: "none" });
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

  test("the brand home follows a passed-through KIMI_CODE_HOME, never a stray one", () => {
    const profile = mkdtempSync(join(tmpdir(), "codemux-kimi-profile-"));
    scratch.push(profile);
    const droppedAdapter = kimiAdapter({ KIMI_CODE_HOME: profile });
    droppedAdapter.prepareRun({ agent: "kimi", prompt: "p", tools: "none" });
    const dropped = agentFileOf(droppedAdapter.buildRunCommand({ agent: "kimi", prompt: "p", tools: "none" }));
    expect(dropped).not.toContain(profile);
    const passedAdapter = kimiAdapter({ KIMI_CODE_HOME: profile });
    const request = { agent: "kimi" as const, prompt: "p", tools: "none" as const, passthroughEnv: ["KIMI_CODE_HOME"] };
    passedAdapter.prepareRun(request);
    expect(agentFileOf(passedAdapter.buildRunCommand(request))).toContain(profile);
  });

  test("every prepared run gets a fresh file, and dispose removes them all", () => {
    const adapter = kimiAdapter();
    adapter.prepareRun({ agent: "kimi", prompt: "p", tools: "none" });
    const first = agentFileOf(adapter.buildRunCommand({ agent: "kimi", prompt: "p", tools: "none" }));
    expect(statSync(first).isFile()).toBe(true);
    adapter.prepareRun({ agent: "kimi", prompt: "p", tools: "none" });
    const second = agentFileOf(adapter.buildRunCommand({ agent: "kimi", prompt: "p", tools: "none" }));
    expect(second).not.toBe(first);
    // The earlier file stays until exit: an earlier run may still read it.
    expect(statSync(first).isFile()).toBe(true);
    adapter.disposeNoToolsFiles();
    expect(() => statSync(first)).toThrow();
    expect(() => statSync(second)).toThrow();
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
    const file = writeKimiNoToolsFile(brand);
    expect(readdirSync(parent).filter((entry) => entry.startsWith("no-tools-9999"))).toEqual([]);
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

  test("kimi refuses --hermetic and --tools none until the live probe runs", () => {
    const adapter = kimiAdapter();
    const cwd = mkdtempSync(join(tmpdir(), "codemux-kimi-refuse-"));
    scratch.push(cwd);
    try {
      mkdirSync(join(cwd, ".git"));
      // Hermetic has no mechanism: the AGENTS.md merger has no switch and
      // also reads ~/.agents under the real home. Tools none is implemented
      // but unclaimed: the probe needs usage headroom.
      expect(adapter.capabilities().supportsHermetic ?? false).toBe(false);
      expect(adapter.capabilities().supportsToolSelection ?? false).toBe(false);
      expect(() => adapter.validateRunRequest({ agent: "kimi", prompt: "p", cwd, hermetic: true }))
        .toThrow("no verified hermetic mode");
      expect(() => adapter.validateRunRequest({ agent: "kimi", prompt: "p", cwd, tools: "none" }))
        .toThrow("cannot remove its built-in tools");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe("hermetic runs: copilot", () => {
  const scratch: string[] = [];
  const adapters: CopilotAdapter[] = [];
  afterEach(() => {
    for (const adapter of adapters.splice(0)) adapter.disposeHermeticHome();
    for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  const copilotAdapter = (env: NodeJS.ProcessEnv = {}): CopilotAdapter => {
    const home = mkdtempSync(join(tmpdir(), "codemux-copilot-home-"));
    scratch.push(home);
    const adapter = new CopilotAdapter(env, home);
    adapters.push(adapter);
    return adapter;
  };
  const plainHeadless = [
    "copilot",
    "--no-auto-update",
    "--no-bash-env",
    "--no-remote",
    "--no-remote-export",
    "--no-custom-instructions",
    "--no-experimental",
    "--disable-builtin-mcps",
    "--prompt=p",
    "--silent",
  ];

  test("--hermetic points COPILOT_HOME at a private home and drops the built-in MCPs even at high autonomy", () => {
    const adapter = copilotAdapter();
    const request = { agent: "copilot" as const, prompt: "p", hermetic: true, autonomy: "high" as const };
    adapter.prepareRun(request);
    const cmd = adapter.buildRunCommand(request);
    expect(cmd[0]).toBe("env");
    expect(cmd[1]!.startsWith("COPILOT_HOME=")).toBe(true);
    const home = cmd[1]!.slice("COPILOT_HOME=".length);
    expect(home).toContain(join(".copilot", ".codemux-hermetic", `run-${process.pid}-`));
    expect(cmd[2]).toBe("copilot");
    expect(cmd).toContain("--disable-builtin-mcps");
    expect(cmd).toContain("--no-custom-instructions");
    expect(cmd.slice(-1)).toEqual(["--silent"]);
    expect(statSync(home).isDirectory()).toBe(true);
  });

  test("--tools none adds a bare --available-tools allowlist, with or without --hermetic", () => {
    const adapter = copilotAdapter();
    const none = adapter.buildRunCommand({ agent: "copilot", prompt: "p", tools: "none", model: "m" });
    expect(none[none.indexOf("--available-tools") + 1]).toBe("--disable-builtin-mcps");
    expect(none).toContain("--model");
    expect(adapter.buildRunCommand({ agent: "copilot", prompt: "p", tools: "default" })).toEqual(plainHeadless);
    expect(adapter.buildRunCommand({ agent: "copilot", prompt: "p" })).toEqual(plainHeadless);
    const request = { agent: "copilot" as const, prompt: "p", hermetic: true, tools: "none" as const };
    adapter.prepareRun(request);
    const both = adapter.buildRunCommand(request);
    expect(both[0]).toBe("env");
    expect(both).toContain("--available-tools");
  });

  test("the config directory follows a passed-through COPILOT_HOME, never a stray one", () => {
    const profile = mkdtempSync(join(tmpdir(), "codemux-copilot-profile-"));
    scratch.push(profile);
    const droppedAdapter = copilotAdapter({ COPILOT_HOME: profile });
    droppedAdapter.prepareRun({ agent: "copilot", prompt: "p", hermetic: true });
    const dropped = droppedAdapter.buildRunCommand({ agent: "copilot", prompt: "p", hermetic: true })[1]!;
    expect(dropped).not.toContain(profile);
    const passedAdapter = copilotAdapter({ COPILOT_HOME: profile });
    const request = { agent: "copilot" as const, prompt: "p", hermetic: true as const, passthroughEnv: ["COPILOT_HOME"] };
    passedAdapter.prepareRun(request);
    expect(passedAdapter.buildRunCommand(request)[1]!).toContain(profile);
  });

  test("every prepared run gets a fresh home, and dispose removes them all", () => {
    const adapter = copilotAdapter();
    const request = { agent: "copilot" as const, prompt: "p", hermetic: true as const };
    adapter.prepareRun(request);
    const first = adapter.buildRunCommand(request)[1]!.slice("COPILOT_HOME=".length);
    adapter.prepareRun(request);
    const second = adapter.buildRunCommand(request)[1]!.slice("COPILOT_HOME=".length);
    expect(second).not.toBe(first);
    // The earlier home stays until exit: an earlier run may still be using it.
    expect(statSync(first).isDirectory()).toBe(true);
    adapter.disposeHermeticHome();
    expect(() => statSync(first)).toThrow();
    expect(() => statSync(second)).toThrow();
  });

  test("a static hermetic command without prepareRun points at a home that does not exist", () => {
    const adapter = copilotAdapter();
    const cmd = adapter.buildRunCommand({ agent: "copilot", prompt: "p", hermetic: true });
    expect(cmd[1]).toMatch(/\.codemux-hermetic\/unprepared$/);
    expect(() => statSync(cmd[1]!.slice("COPILOT_HOME=".length))).toThrow();
    expect(() => adapter.getRunEnv({ agent: "copilot", prompt: "p", hermetic: true }))
      .toThrow("was not prepared before launch");
    expect(adapter.getRunEnv({ agent: "copilot", prompt: "p" })).toEqual({});
  });

  test("old homes of dead codemux processes are swept", () => {
    const home = mkdtempSync(join(tmpdir(), "codemux-copilot-sweep-"));
    scratch.push(home);
    const parent = join(home, ".copilot", ".codemux-hermetic");
    const old = join(parent, "run-999999999-old");
    mkdirSync(old, { recursive: true });
    const threeDaysAgo = new Date(Date.now() - 3 * 86_400_000);
    utimesSync(old, threeDaysAgo, threeDaysAgo);
    const fresh = createCopilotHermeticHome(join(home, ".copilot"));
    expect(readdirSync(parent).filter((entry) => entry.startsWith("run-9999"))).toEqual([]);
    fresh.finalize();
  });

  test("a symlinked hermetic parent directory is refused", () => {
    const home = mkdtempSync(join(tmpdir(), "codemux-copilot-symlink-"));
    scratch.push(home);
    const elsewhere = mkdtempSync(join(tmpdir(), "codemux-copilot-elsewhere-"));
    scratch.push(elsewhere);
    const config = join(home, ".copilot");
    mkdirSync(join(config, ".codemux-hermetic"), { recursive: true });
    rmSync(join(config, ".codemux-hermetic"), { recursive: true });
    symlinkSync(elsewhere, join(config, ".codemux-hermetic"));
    expect(() => createCopilotHermeticHome(config))
      .toThrow("must be a directory owned by the current user");
  });

  test("copilot refuses --hermetic and --tools none until an installed live check runs", () => {
    const adapter = copilotAdapter();
    const cwd = mkdtempSync(join(tmpdir(), "codemux-copilot-refuse-"));
    scratch.push(cwd);
    try {
      mkdirSync(join(cwd, ".git"));
      // Both mappings are implemented but unclaimed: Copilot is not
      // installed here, so the check and the capability probe are pending.
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
