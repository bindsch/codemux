import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, linkSync, mkdirSync, readFileSync, renameSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isCallerHarnessHome, linkHarnessLogin, openCallerHarnessHome, recordedHarnessHome, validateHarnessHome } from "../src/session/harness-home.js";
import { removeDir, tempWorkdir } from "./helpers/session-command.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) removeDir(root); });

function fixture() {
  const root = tempWorkdir("caller-home"); roots.push(root);
  const cwd = join(root, "work");
  const sourceHome = join(root, "operator", ".codex");
  for (const path of [cwd, sourceHome]) mkdirSync(path, { recursive: true, mode: 0o700 });
  const dir = join(root, "job");
  const blockedPaths = [sourceHome];
  const input = { agent: "codex" as const, dir, cwd, sourceHome, blockedPaths, apiKeyAuth: false };
  writeFileSync(join(sourceHome, "auth.json"), "synthetic-login", { mode: 0o600 });
  return { ...input, root, input };
}

describe("caller-owned harness directory", () => {
  test("creates a private home, preserves settings and runtime state, and never removes it", () => {
    const f = fixture();
    const first = openCallerHarnessHome(f.input);
    expect(first.environment).toMatchObject({ HOME: f.dir, CODEX_HOME: join(f.dir, ".codex"), XDG_CONFIG_HOME: join(f.dir, ".config") });
    expect(statSync(f.dir).mode & 0o777).toBe(0o700);
    expect(statSync(join(f.dir, ".codex")).mode & 0o777).toBe(0o700);
    const target = join(f.dir, ".codex", "auth.json");
    expect(statSync(target).ino).toBe(statSync(join(f.sourceHome, "auth.json")).ino);
    writeFileSync(target, "rotated-synthetic-login");
    expect(readFileSync(join(f.sourceHome, "auth.json"), "utf8")).toBe("rotated-synthetic-login");
    const settings = join(f.dir, ".codex", "config.toml");
    writeFileSync(settings, 'model = "caller-model"\n');
    writeFileSync(join(f.dir, "transcript"), "caller-state");
    first.settle("synthetic-session");
    expect(first.dir).toBe(f.dir);
    expect(isCallerHarnessHome(first)).toBe(true);
    expect(isCallerHarnessHome(null)).toBe(false);
    expect(isCallerHarnessHome({})).toBe(false);
    expect(recordedHarnessHome(first, "synthetic-session")).toBe(f.dir);
    expect(recordedHarnessHome({ ...first, callerOwned: undefined } as unknown as typeof first, "synthetic-session"))
      .toBe(join(f.root, "session-synthetic-session"));
    expect(first.remove()).toBe(false);
    const resumed = openCallerHarnessHome({ ...f.input, resumed: true });
    expect(resumed.resumed).toBe(true);
    expect(resumed.settled).toBe(true);
    expect(resumed.callerOwned).toBe(true);
    expect(readFileSync(settings, "utf8")).toBe('model = "caller-model"\n');
    expect(readFileSync(join(f.dir, "transcript"), "utf8")).toBe("caller-state");
    resumed.verify();
  });

  const claudeLogin = (access: string, refresh = "") => JSON.stringify({
    claudeAiOauth: { accessToken: access, refreshToken: refresh, scopes: ["synthetic"] },
    mcpOAuth: { synthetic: { refreshToken: "synthetic-mcp-refresh" } } });

  test("Claude and ZAI use the caller root without copying settings", () => {
    const f = fixture();
    writeFileSync(join(f.sourceHome, ".credentials.json"), claudeLogin("synthetic-access-a"), { mode: 0o600 });
    writeFileSync(join(f.sourceHome, "settings.json"), "operator-settings");
    const home = openCallerHarnessHome({ ...f.input, agent: "claude" });
    expect(home.environment).toMatchObject({ HOME: f.dir, CLAUDE_CONFIG_DIR: f.dir, CLAUDE_SECURESTORAGE_CONFIG_DIR: f.dir });
    const copy = join(f.dir, ".credentials.json");
    expect(statSync(copy).ino).not.toBe(statSync(join(f.sourceHome, ".credentials.json")).ino);
    expect(JSON.parse(readFileSync(copy, "utf8"))).toEqual({ claudeAiOauth: { accessToken: "synthetic-access-a", refreshToken: "", scopes: ["synthetic"] } });
    expect(statSync(copy).mode & 0o777).toBe(0o600);
    expect(existsSync(join(f.dir, "settings.json"))).toBe(false);
    const zaiDir = join(f.root, "zai-job");
    openCallerHarnessHome({ ...f.input, agent: "zai", dir: zaiDir });
    expect(existsSync(join(zaiDir, ".credentials.json"))).toBe(false);
  });

  // Review R420 B1: a mirror that still carries a refresh token never reaches
  // a caller home, linked or copied; the launch refuses before writing it.
  test("Claude refuses a mirror that carries a refresh token and writes nothing", () => {
    const f = fixture();
    writeFileSync(join(f.sourceHome, ".credentials.json"), claudeLogin("synthetic-access-a", "synthetic-refresh"), { mode: 0o600 });
    expect(() => openCallerHarnessHome({ ...f.input, agent: "claude" })).toThrow("holds a refresh token; refusing the --harness-home session");
    expect(existsSync(join(f.dir, ".credentials.json"))).toBe(false);
  });

  // Review R420 M1: codemux and scode refresh the mirror by rename. Each launch
  // rebuilds the caller copy from the current mirror instead of pinning an inode.
  test("Claude rebuilds the access-only copy after a rename refresh and replaces a stale hard link", () => {
    const f = fixture();
    const mirror = join(f.sourceHome, ".credentials.json");
    writeFileSync(mirror, claudeLogin("synthetic-access-a"), { mode: 0o600 });
    mkdirSync(f.dir, { mode: 0o700 });
    linkSync(mirror, join(f.dir, ".credentials.json"));
    const home = openCallerHarnessHome({ ...f.input, agent: "claude" });
    expect(statSync(join(f.dir, ".credentials.json")).nlink).toBe(1);
    expect(readFileSync(mirror, "utf8")).toBe(claudeLogin("synthetic-access-a"));
    writeFileSync(join(f.sourceHome, "staged"), claudeLogin("synthetic-access-b"), { mode: 0o600 });
    renameSync(join(f.sourceHome, "staged"), mirror);
    home.verify();
    expect(JSON.parse(readFileSync(join(f.dir, ".credentials.json"), "utf8")).claudeAiOauth.accessToken).toBe("synthetic-access-b");
    const resumed = openCallerHarnessHome({ ...f.input, agent: "claude", resumed: true });
    resumed.verify();
    renameSync(mirror, join(f.sourceHome, "saved"));
    expect(() => home.verify()).toThrow("missing login");
  });

  test("API-key auth does not link the operator login", () => {
    const f = fixture();
    openCallerHarnessHome({ ...f.input, apiKeyAuth: true });
    expect(existsSync(join(f.dir, ".codex", "auth.json"))).toBe(false);
  });

  test("print validates paths without creating or changing directories", () => {
    const f = fixture();
    const home = openCallerHarnessHome({ ...f.input, printOnly: true });
    home.verify();
    expect(existsSync(f.dir)).toBe(false);
    mkdirSync(f.dir, { mode: 0o755 });
    openCallerHarnessHome({ ...f.input, printOnly: true });
    expect(statSync(f.dir).mode & 0o777).toBe(0o755);
    openCallerHarnessHome(f.input);
    expect(statSync(f.dir).mode & 0o777).toBe(0o700);
  });

  test.each(["relative", "", " /absolute", "/absolute ", "/absolute\0bad"])("refuses malformed path %j", (path) => {
    const f = fixture();
    expect(() => validateHarnessHome(path, f.cwd, f.blockedPaths)).toThrow("absolute, unpadded");
  });

  test("refuses cwd and brand-home overlap in both directions", () => {
    const f = fixture();
    for (const dir of [f.cwd, join(f.cwd, "job"), f.sourceHome, join(f.sourceHome, "job"), f.root]) {
      expect(() => validateHarnessHome(dir, f.cwd, f.blockedPaths)).toThrow("separate");
    }
  });

  test("refuses a file, directory symlink, and symlinked ancestor", () => {
    const f = fixture();
    writeFileSync(f.dir, "file");
    expect(() => validateHarnessHome(f.dir, f.cwd, f.blockedPaths)).toThrow("directory");
    const alias = join(f.root, "alias");
    symlinkSync(f.cwd, alias);
    expect(() => validateHarnessHome(alias, f.cwd, f.blockedPaths)).toThrow("symlink");
    expect(() => validateHarnessHome(join(alias, "new"), f.cwd, f.blockedPaths)).toThrow("symlink");
    const nested = join(f.cwd, "existing"); mkdirSync(nested);
    expect(() => validateHarnessHome(join(alias, "existing"), f.cwd, [])).toThrow("symlink ancestors");
  });

  test("refuses a directory owned by another user", () => {
    const f = fixture(); mkdirSync(f.dir);
    const uid = spyOn(process, "getuid").mockReturnValue(statSync(f.dir).uid + 1);
    try { expect(() => validateHarnessHome(f.dir, f.cwd, [])).toThrow("owned"); }
    finally { uid.mockRestore(); }
  });

  test("rechecks home ownership and login identity on every launch", () => {
    const f = fixture();
    const home = openCallerHarnessHome(f.input);
    renameSync(f.dir, join(f.root, "saved-job"));
    symlinkSync(f.cwd, f.dir);
    expect(() => home.verify()).toThrow("symlink");
  });

  test("does not silently recreate a removed home during preflight", () => {
    const f = fixture(); const home = openCallerHarnessHome(f.input);
    renameSync(f.dir, join(f.root, "saved-job"));
    expect(() => home.verify()).toThrow("removed before launch");
    expect(existsSync(f.dir)).toBe(false);
  });

  test("a replaced or removed real login refuses stale private credentials", () => {
    const f = fixture(); const home = openCallerHarnessHome(f.input);
    const source = join(f.sourceHome, "auth.json");
    renameSync(source, join(f.sourceHome, "saved-auth"));
    expect(() => home.verify()).toThrow("missing login");
    writeFileSync(source, "replacement-login");
    expect(() => home.verify()).toThrow("login link changed");
  });

  test("refuses planted private credentials without overwriting them", () => {
    const f = fixture();
    mkdirSync(join(f.dir, ".codex"), { recursive: true });
    const target = join(f.dir, ".codex", "auth.json");
    writeFileSync(target, "planted");
    expect(() => openCallerHarnessHome(f.input)).toThrow("login link changed");
    expect(readFileSync(target, "utf8")).toBe("planted");
  });

  test("rejects symlink logins and allows a missing optional file", () => {
    const f = fixture();
    const alias = join(f.root, "login-alias");
    symlinkSync(join(f.sourceHome, "auth.json"), alias);
    expect(() => linkHarnessLogin(alias, join(f.root, "linked"), false)).toThrow("regular file");
    linkHarnessLogin(join(f.root, "missing"), join(f.root, "target"), false);
    expect(existsSync(join(f.root, "target"))).toBe(false);
    expect(() => linkHarnessLogin(join(f.root, "missing"), join(f.root, "target"), true)).toThrow("file login");
  });
});
