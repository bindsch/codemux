import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as filesystem from "node:fs";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  callerHarnessHomeApiKeyAuth, callerHarnessHomeAuthEnvironment, callerHarnessHomeEnvAssignments, isCallerHarnessHome,
  linkHarnessLogin, openCallerHarnessHome, recordedHarnessHome, validateHarnessHome,
} from "../src/session/harness-home.js";
import { harnessHomeBlockedPaths, applyHarnessHomeSandboxBlocks } from "../src/launch/harness-home-sandbox.js";
import type { AgentId } from "../src/types.js";
import type { SandboxOptions } from "../src/sandbox.js";

// Synthetic stores only. This test does not import a launcher or start a process.
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const agents = ["agy", "aider", "claude", "codex", "copilot", "cursor", "droid", "gemini", "goose", "kimi", "opencode", "openhands", "pi", "qwen", "zai"] as const;
type SupportedAgent = typeof agents[number];
const cursorAuth = process.platform === "darwin" ? ".cursor/auth.json" : ".config/cursor/auth.json";
const paths: Record<SupportedAgent, { settings: string; source?: string; target?: string; rootEnv?: string; rootPath?: string }> = {
  agy: { settings: ".gemini/antigravity-cli/settings.json" },
  aider: { settings: ".aider.conf.yml", source: ".aider/oauth-keys.env", target: ".aider/oauth-keys.env" },
  claude: { settings: "settings.json", source: ".credentials.json", target: ".credentials.json", rootEnv: "CLAUDE_CONFIG_DIR", rootPath: "" },
  codex: { settings: ".codex/config.toml", source: "auth.json", target: ".codex/auth.json", rootEnv: "CODEX_HOME", rootPath: ".codex" },
  copilot: { settings: ".copilot/config.json", rootEnv: "COPILOT_HOME", rootPath: ".copilot" },
  cursor: { settings: ".cursor/cli-config.json", source: cursorAuth, target: cursorAuth, rootEnv: "CURSOR_CONFIG_DIR", rootPath: ".cursor" },
  droid: { settings: ".factory/settings.json", source: ".factory/auth.json", target: ".factory/auth.json", rootEnv: "FACTORY_HOME_OVERRIDE", rootPath: "" },
  gemini: { settings: ".gemini/settings.json", source: ".gemini/oauth_creds.json", target: ".gemini/oauth_creds.json", rootEnv: "GEMINI_CLI_HOME", rootPath: "" },
  goose: { settings: "config/config.yaml", rootEnv: "GOOSE_PATH_ROOT", rootPath: "" },
  kimi: { settings: ".kimi-code/config.toml", source: ".kimi-code/credentials/kimi-code.json", target: ".kimi-code/credentials/kimi-code.json", rootEnv: "KIMI_CODE_HOME", rootPath: ".kimi-code" },
  opencode: { settings: ".config/opencode/opencode.json", source: ".local/share/opencode/auth.json", target: ".local/share/opencode/auth.json", rootEnv: "OPENCODE_CONFIG_DIR", rootPath: ".config/opencode" },
  openhands: { settings: ".openhands/agent_settings.json", rootEnv: "OPENHANDS_PERSISTENCE_DIR", rootPath: ".openhands" },
  pi: { settings: ".pi/agent/settings.json", source: ".pi/agent/auth.json", target: ".pi/agent/auth.json", rootEnv: "PI_CODING_AGENT_DIR", rootPath: ".pi/agent" },
  qwen: { settings: ".qwen/settings.json", source: ".qwen/oauth_creds.json", target: ".qwen/oauth_creds.json", rootEnv: "QWEN_HOME", rootPath: ".qwen" },
  zai: { settings: "settings.json", rootEnv: "CLAUDE_CONFIG_DIR", rootPath: "" },
};

// How each agent's login reaches the caller home (review R420 B1, M1, M4):
// a hard link where the harness rewrites in place, an access-token-only
// mirror where it renames, and kimi's shared directory symlink.
const MIRRORED = new Set<SupportedAgent>(["claude", "qwen"]);
const claudeLogin = (access = "synthetic-access") =>
  JSON.stringify({ claudeAiOauth: { accessToken: access, refreshToken: "" } });
const qwenLogin = (access = "synthetic-access") => JSON.stringify({ access_token: access, token_type: "Bearer",
  refresh_token: "synthetic-refresh-value", expiry_date: Date.now() + 3_600_000 });
const loginFor = (agent: SupportedAgent): string =>
  agent === "claude" ? claudeLogin() : agent === "qwen" ? qwenLogin() : "synthetic-login";

function write(path: string, content = "synthetic-login"): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, content, { mode: 0o600 });
}

function fixture(agent: SupportedAgent = "droid") {
  const root = realpathSync(mkdtempSync(join(import.meta.dir, "../scratch/caller-home-agents-")));
  roots.push(root);
  const sourceHome = join(root, "operator");
  const cwd = join(root, "work");
  const dir = join(root, "caller");
  for (const path of [sourceHome, cwd]) mkdirSync(path, { mode: 0o700 });
  const sourceEnv: Record<string, string> = {};
  const blockedPaths = [sourceHome];
  const input = { agent, dir, cwd, sourceHome, blockedPaths, sourceEnv,
    apiKeyAuth: agent === "agy", providerOverride: agent === "copilot" || agent === "openhands" || agent === "goose" };
  const row = paths[agent];
  if (row.source) write(join(sourceHome, row.source), loginFor(agent));
  return { root, input, row };
}

describe("every supported caller-owned harness home", () => {
  test.each([...agents])("%s retains caller settings, uses private roots, and keeps auth-only logins", (agent) => {
    const { input, row } = fixture(agent);
    const settings = join(input.dir, row.settings);
    write(settings, "caller-customization");
    write(join(input.sourceHome, "operator-settings"), "must-not-copy");
    const home = openCallerHarnessHome(input);
    expect(home.environment.HOME).toBe(input.dir);
    expect(home.environment.USERPROFILE).toBe(input.dir);
    if (row.rootEnv) expect(home.environment[row.rootEnv]).toBe(join(input.dir, row.rootPath ?? ""));
    for (const [name, value] of Object.entries(home.environment)) {
      if (name === "GOOSE_DISABLE_KEYRING") { expect(value).toBe("true"); continue; }
      expect(value === input.dir || value.startsWith(`${input.dir}/`)).toBe(true);
      expect(statSync(value).mode & 0o777).toBe(0o700);
    }
    expect(readFileSync(settings, "utf8")).toBe("caller-customization");
    expect(existsSync(join(input.dir, "operator-settings"))).toBe(false);
    if (row.source && row.target && MIRRORED.has(agent)) {
      const source = join(input.sourceHome, row.source);
      const target = join(input.dir, row.target);
      expect(statSync(target).ino).not.toBe(statSync(source).ino);
      expect(readFileSync(target, "utf8")).toContain("synthetic-access");
      expect(readFileSync(target, "utf8")).not.toContain("synthetic-refresh-value");
    } else if (row.source && row.target && agent === "kimi") {
      const store = join(input.dir, ".kimi-code", "credentials");
      expect(lstatSync(store).isSymbolicLink()).toBe(true);
      // Kimi refreshes by rename inside the store; the rename lands in the real store.
      write(join(store, ".staged"), "refreshed-login");
      renameSync(join(store, ".staged"), join(store, "kimi-code.json"));
      expect(readFileSync(join(input.sourceHome, row.source), "utf8")).toBe("refreshed-login");
    } else if (row.source && row.target) {
      const source = join(input.sourceHome, row.source);
      const target = join(input.dir, row.target);
      expect(statSync(target).ino).toBe(statSync(source).ino);
      expect(statSync(target).dev).toBe(statSync(source).dev);
      writeFileSync(target, "refreshed-login");
      expect(readFileSync(source, "utf8")).toBe("refreshed-login");
    }
    const assignments = callerHarnessHomeEnvAssignments(home);
    expect(assignments).toContain(`HOME=${input.dir}`);
    for (const name of home.environmentOmissions ?? []) {
      expect(assignments[assignments.indexOf(name) - 1]).toBe("-u");
    }
    home.verify();
    home.settle("synthetic-session");
    expect(recordedHarnessHome(home, "synthetic-session")).toBe(input.dir);
    expect(home.remove()).toBe(false);
    expect(home.dir).toBe(input.dir);
    const resumed = openCallerHarnessHome({ ...input, resumed: true });
    expect(resumed.resumed).toBe(true);
    expect(resumed.settled).toBe(true);
    expect(readFileSync(settings, "utf8")).toBe("caller-customization");
  });

  test.each([...agents])("%s print mode changes no directory or credentials", (agent) => {
    const { input } = fixture(agent);
    const home = openCallerHarnessHome({ ...input, printOnly: true });
    home.verify();
    expect(existsSync(input.dir)).toBe(false);
    mkdirSync(input.dir, { mode: 0o755 });
    openCallerHarnessHome({ ...input, printOnly: true });
    expect(statSync(input.dir).mode & 0o777).toBe(0o755);
  });

  test.each([...agents])("%s provider authentication reads and links no operator login", (agent) => {
    const { input, row } = fixture(agent);
    const home = openCallerHarnessHome({ ...input, apiKeyAuth: true });
    home.verify();
    if (row.target) expect(existsSync(join(input.dir, row.target))).toBe(false);
  });

  test.each(["copilot", "openhands"] as const)("%s refuses mixed-store auth without a provider override", (agent) => {
    const { input, row } = fixture(agent);
    write(join(input.sourceHome, row.settings), "operator-secret-and-settings");
    expect(() => openCallerHarnessHome({ ...input, apiKeyAuth: true, providerOverride: false })).toThrow("requires a provider override");
    expect(existsSync(input.dir)).toBe(false);
    openCallerHarnessHome(input);
    expect(existsSync(join(input.dir, row.settings))).toBe(false);
  });

  test("Agy requires explicit auth and never links an unverified token filename", () => {
    const { input } = fixture("agy");
    expect(() => openCallerHarnessHome({ ...input, apiKeyAuth: false })).toThrow("no dedicated portable login file");
    expect(existsSync(input.dir)).toBe(false);
    expect(openCallerHarnessHome({ ...input, apiKeyAuth: false, providerOverride: true }).environment.HOME).toBe(input.dir);
  });
});

describe("native credential source roots captured before redirect", () => {
  const redirects = [
    ["droid", "FACTORY_HOME_OVERRIDE", ".factory/auth.json"],
    ["gemini", "GEMINI_CLI_HOME", ".gemini/oauth_creds.json"],
    ["pi", "PI_CODING_AGENT_DIR", "auth.json"],
    ["opencode", "XDG_DATA_HOME", "opencode/auth.json"],
  ] as const;
  test.each(redirects)("%s uses captured %s", (agent, name, suffix) => {
    const { input, root, row } = fixture(agent);
    const alternate = join(root, "alternate");
    const source = join(alternate, suffix);
    write(source, "alternate-login");
    input.sourceEnv[name] = alternate;
    const home = openCallerHarnessHome(input);
    input.sourceEnv[name] = join(root, "changed-env");
    home.verify();
    const target = join(input.dir, row.target!);
    expect(statSync(target).ino).toBe(statSync(source).ino);
    expect(readFileSync(target, "utf8")).toBe("alternate-login");
    renameSync(source, join(root, "saved-login"));
    expect(() => home.verify()).toThrow("missing login");
    write(source, "replacement-login");
    expect(() => home.verify()).toThrow("login link changed");
  });

  // Review R420 M4 class: Qwen renames oauth_creds.json on refresh, so the
  // caller home holds only the access fields, rebuilt from the real file.
  test("qwen uses captured QWEN_HOME and rebuilds its access-only login every launch", () => {
    const { input, root, row } = fixture("qwen");
    const source = join(root, "alternate", "oauth_creds.json");
    write(source, qwenLogin("alternate-access"));
    input.sourceEnv.QWEN_HOME = join(root, "alternate");
    const home = openCallerHarnessHome(input);
    input.sourceEnv.QWEN_HOME = join(root, "changed-env");
    const target = join(input.dir, row.target!);
    expect(JSON.parse(readFileSync(target, "utf8"))).toMatchObject({ access_token: "alternate-access", refresh_token: "codemux-access-only" });
    write(join(root, "staged"), qwenLogin("rotated-access"));
    renameSync(join(root, "staged"), source);
    home.verify();
    expect(JSON.parse(readFileSync(target, "utf8")).access_token).toBe("rotated-access");
    expect(readFileSync(target, "utf8")).not.toContain("synthetic-refresh-value");
    renameSync(source, join(root, "saved-login"));
    expect(() => home.verify()).toThrow("missing login");
  });

  test("Qwen resolves a relative source root from the launch cwd", () => {
    const { input, row } = fixture("qwen");
    const source = join(input.cwd, "relative-qwen", "oauth_creds.json");
    write(source, qwenLogin("relative-access"));
    input.sourceEnv.QWEN_HOME = "relative-qwen";
    openCallerHarnessHome(input);
    expect(readFileSync(join(input.dir, row.target!), "utf8")).toContain("relative-access");
    expect(() => openCallerHarnessHome({ ...input, sourceEnv: { QWEN_HOME: "bad\0path" } })).toThrow("NUL bytes");
  });

  test("Cursor uses the Linux XDG auth backend separately from CURSOR_CONFIG_DIR", () => {
    const { input, root } = fixture("cursor");
    const original = Object.getOwnPropertyDescriptor(process, "platform")!;
    const source = join(root, "cursor-xdg", "cursor", "auth.json");
    write(source);
    try {
      Object.defineProperty(process, "platform", { value: "linux", configurable: true });
      input.sourceEnv.XDG_CONFIG_HOME = join(root, "cursor-xdg");
      input.sourceEnv.CURSOR_CONFIG_DIR = join(root, "not-a-credential-root");
      const home = openCallerHarnessHome(input);
      expect(home.environment.CURSOR_CONFIG_DIR).toBe(join(input.dir, ".cursor"));
      expect(statSync(join(input.dir, ".config", "cursor", "auth.json")).ino).toBe(statSync(source).ino);
    } finally { Object.defineProperty(process, "platform", original); }
  });

  test("gemini links optional account metadata and rejects stale accounts", () => {
    const { input } = fixture("gemini");
    const relative = ".gemini/google_accounts.json";
    const source = join(input.sourceHome, relative);
    write(source);
    const home = openCallerHarnessHome(input);
    expect(statSync(join(input.dir, relative)).ino).toBe(statSync(source).ino);
    renameSync(source, `${source}.saved`);
    expect(() => home.verify()).toThrow("missing login");
  });

  test("goose requires a provider override and never links secrets.yaml", () => {
    const { input } = fixture("goose");
    write(join(input.sourceHome, ".config", "goose", "secrets.yaml"));
    expect(() => openCallerHarnessHome({ ...input, providerOverride: false })).toThrow("requires a provider override");
    expect(existsSync(input.dir)).toBe(false);
    openCallerHarnessHome(input);
    expect(existsSync(join(input.dir, "config", "secrets.yaml"))).toBe(false);
  });

  // Review R420 M1 class: kimi renames token files, which a per-file hard link
  // strands. The caller home shares the store as the hermetic home does.
  test("Kimi shares a captured dedicated store by directory symlink and refuses a changed link", () => {
    const { input, root } = fixture("kimi");
    const alternate = join(root, "alternate-kimi");
    write(join(alternate, "credentials", "kimi-code.json"));
    input.sourceEnv.KIMI_CODE_HOME = alternate;
    const home = openCallerHarnessHome(input);
    const destination = join(input.dir, ".kimi-code", "credentials");
    expect(readlinkSync(destination)).toBe(join(alternate, "credentials"));
    home.verify();
    rmSync(destination);
    mkdirSync(destination);
    expect(() => home.verify()).toThrow("credential store link changed");
    rmSync(destination, { recursive: true });
    symlinkSync(join(root, "elsewhere"), destination);
    expect(() => home.verify()).toThrow("credential store link changed");
  });

  test("Kimi refuses a missing, empty, or symlinked dedicated store", () => {
    const { input, root } = fixture("kimi");
    const home = openCallerHarnessHome(input);
    const source = join(input.sourceHome, ".kimi-code", "credentials");
    renameSync(source, join(root, "saved-credentials"));
    expect(() => home.verify()).toThrow("removed before launch");
    mkdirSync(source);
    expect(() => openCallerHarnessHome(input)).toThrow("nonempty dedicated credential store");
    const alias = join(root, "alias-home"); mkdirSync(alias);
    symlinkSync(join(root, "saved-credentials"), join(alias, "credentials"));
    expect(() => openCallerHarnessHome({ ...input, sourceEnv: { KIMI_CODE_HOME: alias } })).toThrow("symlink");
  });
});

describe("credential and directory integrity", () => {
  test("refuses login replacement during hard-link creation", () => {
    const { input, root, row } = fixture();
    const realLink = filesystem.linkSync;
    const link = spyOn(filesystem, "linkSync").mockImplementation((source, destination) => {
      renameSync(source, join(root, "saved-login"));
      writeFileSync(source, "replacement-login");
      realLink(source, destination);
    });
    try {
      expect(() => linkHarnessLogin(join(input.sourceHome, row.source!), join(root, "target"), true))
        .toThrow("changed while linking");
    } finally { link.mockRestore(); }
  });

  test("a hard-link failure refuses without creating a symlink fallback", () => {
    const { input, root, row } = fixture();
    const target = join(root, "target");
    const link = spyOn(filesystem, "linkSync").mockImplementation(() => { throw new Error("synthetic cross-device failure"); });
    try {
      expect(() => linkHarnessLogin(join(input.sourceHome, row.source!), target, true)).toThrow("cannot hard-link");
      expect(existsSync(target)).toBe(false);
    } finally { link.mockRestore(); }
  });

  test("rejects source and destination parent symlinks before reusing a hard link", () => {
    const { input, root, row } = fixture();
    const home = openCallerHarnessHome(input);
    const brand = join(input.dir, ".factory");
    renameSync(brand, join(root, "saved-factory"));
    symlinkSync(join(root, "saved-factory"), brand);
    expect(() => home.verify()).toThrow("symlink");
    const source = join(input.sourceHome, ".factory");
    renameSync(source, join(input.sourceHome, "saved-factory"));
    symlinkSync(join(input.sourceHome, "saved-factory"), source);
    expect(() => linkHarnessLogin(join(input.sourceHome, row.source!), join(root, "fresh-login"), true)).toThrow("symlink");
  });

  test("rejects planted or symlink credentials and keeps their bytes", () => {
    const { input, row, root } = fixture();
    const target = join(input.dir, row.target!);
    write(target, "caller-login");
    expect(() => openCallerHarnessHome(input)).toThrow("login link changed");
    expect(readFileSync(target, "utf8")).toBe("caller-login");
    const alias = join(root, "source-alias");
    symlinkSync(join(input.sourceHome, row.source!), alias);
    expect(() => linkHarnessLogin(alias, join(root, "target"), true)).toThrow("regular file");
    linkHarnessLogin(join(root, "missing"), join(root, "target"), false);
  });

  test("rechecks removal and ownership, and refuses malformed paths and overlap", () => {
    const { input, root } = fixture();
    for (const path of ["relative", "", " padded", "bad\0value"]) {
      expect(() => validateHarnessHome(path, input.cwd, [])).toThrow("absolute, unpadded");
    }
    for (const path of [root, input.cwd, input.sourceHome, join(input.cwd, "nested")]) {
      expect(() => validateHarnessHome(path, input.cwd, input.blockedPaths)).toThrow("separate");
    }
    const home = openCallerHarnessHome(input);
    const uid = spyOn(process, "getuid").mockReturnValue(statSync(input.dir).uid + 1);
    try { expect(() => home.verify()).toThrow("owned"); } finally { uid.mockRestore(); }
    renameSync(input.dir, join(root, "saved-caller"));
    expect(() => home.verify()).toThrow("removed before launch");
    expect(existsSync(input.dir)).toBe(false);
    write(input.dir, "file");
    expect(() => home.verify()).toThrow("directory");
  });

  test("caller identity and managed recording remain distinct", () => {
    const { input } = fixture();
    const home = openCallerHarnessHome(input);
    expect(isCallerHarnessHome(home)).toBe(true);
    expect(isCallerHarnessHome(null)).toBe(false);
    expect(isCallerHarnessHome({})).toBe(false);
    expect(recordedHarnessHome({ ...home, callerOwned: undefined } as unknown as typeof home, "synthetic-session"))
      .toBe(join(dirname(input.dir), "session-synthetic-session"));
    // Cline's recipe needs a provider override (its provider settings file
    // stores API keys beside settings); without one the home never opens.
    expect(() => openCallerHarnessHome({ ...input, agent: "cline", sourceEnv: {} }))
      .toThrow("--harness-home for 'cline' requires a provider override");
    expect(callerHarnessHomeEnvAssignments({ ...home, environmentOmissions: undefined })).toContain(`HOME=${input.dir}`);
  });

  test("native key detection excludes non-authentication settings", () => {
    for (const agent of agents) expect(callerHarnessHomeApiKeyAuth(agent, {})).toBe(false);
    const keys: Partial<Record<AgentId, string>> = { agy: "GEMINI_API_KEY", aider: "ANTHROPIC_API_KEY", claude: "CLAUDE_CODE_OAUTH_TOKEN",
      codex: "CODEX_API_KEY", copilot: "GH_TOKEN", cursor: "CURSOR_API_KEY", droid: "FACTORY_API_KEY", gemini: "GOOGLE_API_KEY",
      kimi: "KIMI_API_KEY", openhands: "LLM_API_KEY", qwen: "QWEN_API_KEY", zai: "ZAI_API_KEY" };
    for (const [agent, name] of Object.entries(keys)) {
      expect(callerHarnessHomeApiKeyAuth(agent as AgentId, { [name]: "synthetic-key" })).toBe(true);
      expect(callerHarnessHomeApiKeyAuth(agent as AgentId, { [name]: "  " })).toBe(false);
    }
    expect(callerHarnessHomeApiKeyAuth("cursor", { CURSOR_API_ENDPOINT: "synthetic-endpoint" })).toBe(false);
    expect(callerHarnessHomeApiKeyAuth("openhands", { LLM_MODEL: "synthetic-model" })).toBe(false);
  });

  test("native auth environment retains only the agent's nonempty credential values", () => {
    const env = { GEMINI_API_KEY: " synthetic-key ", GOOGLE_API_KEY: "   ", CURSOR_API_ENDPOINT: "synthetic-endpoint",
      CURSOR_API_KEY: "synthetic-cursor-key", LLM_MODEL: "synthetic-model", GITHUB_TOKEN: undefined };
    expect(callerHarnessHomeAuthEnvironment("gemini", env)).toEqual({ GEMINI_API_KEY: " synthetic-key " });
    expect(callerHarnessHomeAuthEnvironment("agy", { ...env, GOOGLE_API_KEY: "unverified-agy-key" }))
      .toEqual({ GEMINI_API_KEY: " synthetic-key " });
    expect(callerHarnessHomeAuthEnvironment("cursor", env)).toEqual({ CURSOR_API_KEY: "synthetic-cursor-key" });
    expect(callerHarnessHomeAuthEnvironment("copilot", env)).toEqual({});
    expect(callerHarnessHomeAuthEnvironment("openhands", env)).toEqual({});
    expect(callerHarnessHomeAuthEnvironment("pi", env)).toEqual({});
  });
});

describe("operator sandbox snapshot extensions", () => {
  test("blocks alternate OpenHands stores, Qwen runtime, and Cursor XDG credentials", () => {
    const { input, root } = fixture();
    const env = { HOME: input.sourceHome, XDG_CONFIG_HOME: join(root, "xdg"),
      OPENHANDS_PERSISTENCE_DIR: join(root, "persistence"), OPENHANDS_CONVERSATIONS_DIR: join(root, "conversations"),
      PERSISTENCE_DIR: join(root, "secondary-persistence"), QWEN_RUNTIME_DIR: "relative-runtime" };
    const blocked = harnessHomeBlockedPaths(env, input.sourceHome, input.cwd);
    for (const path of [env.OPENHANDS_PERSISTENCE_DIR, env.OPENHANDS_CONVERSATIONS_DIR, env.PERSISTENCE_DIR,
      join(input.cwd, "relative-runtime"), join(env.XDG_CONFIG_HOME, "cursor"), join(input.sourceHome, ".config", "cursor")]) {
      expect(blocked).toContain(path);
    }
    const options: SandboxOptions = {};
    applyHarnessHomeSandboxBlocks(options, input.dir, blocked);
    expect(options.blockPaths).toEqual(blocked);
    expect(options.harnessStateDirs).toEqual([input.dir]);
    expect(() => applyHarnessHomeSandboxBlocks({}, env.PERSISTENCE_DIR, blocked)).toThrow("overlaps");
    expect(() => applyHarnessHomeSandboxBlocks({ blockPaths: [input.dir] }, input.dir, blocked)).toThrow("--sandbox-block");
    expect(() => applyHarnessHomeSandboxBlocks({}, input.dir, [])).toThrow("requires");
    expect(() => harnessHomeBlockedPaths({ HOME: input.sourceHome, QWEN_RUNTIME_DIR: "bad\0value" })).toThrow("NUL");
    expect(() => harnessHomeBlockedPaths({ HOME: input.sourceHome, PERSISTENCE_DIR: "relative" })).toThrow("absolute");
  });
});
