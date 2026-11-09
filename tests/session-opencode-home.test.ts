import { afterAll, afterEach, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import {
  finishOpenCodeSessionHome, openCodeSessionHomePrefix, openOpenCodeSessionHome,
  settleOpenCodeSessionHome,
  openCodeSessionSandboxOptions,
} from "../src/session/opencode-home.js";
import { OpenCodeSessionDriver, type OpenCodeDriverOptions } from "../src/session/opencode-driver.js";
import type { SessionPrivateHome } from "../src/session/private-home-types.js";
import { canonicalSandboxBlockPaths } from "../src/session/registry/format.js";
import { cleanups, send, startSession } from "./helpers/session-opencode-e2e.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
afterAll(async () => { for (const cleanup of cleanups.reverse()) await cleanup(); });
const id = "ses_private12345678";
function paths() {
  const root = mkdtempSync(join(tmpdir(), "codemux-opencode-home-"));
  roots.push(root);
  const dataDir = join(root, "data");
  const stateDir = join(root, "state");
  mkdirSync(dataDir, { mode: 0o700 });
  mkdirSync(stateDir, { mode: 0o700 });
  return { root, dataDir, stateDir };
}
function stubHome(): SessionPrivateHome {
  return { dir: "/fixture/private", resumed: false, settled: false, blockedPaths: [],
    settle() {}, remove: () => true };
}

test("private OpenCode data persists across turns and resume; final removes it", async () => {
  const input = paths();
  writeFileSync(join(input.dataDir, "auth.json"), "{}", { mode: 0o600 });
  writeFileSync(join(input.stateDir, "model.json"), '{"recent":[]}');
  const home = openOpenCodeSessionHome(input);
  const data = join(home.dir, ".local", "share", "opencode");
  expect(readFileSync(join(data, "auth.json"), "utf8")).toBe("{}");
  // Review R420 M4 class: a refresh written through the session reaches the real login.
  expect(statSync(join(data, "auth.json")).ino).toBe(statSync(join(input.dataDir, "auth.json")).ino);
  writeFileSync(join(data, "auth.json"), '{"rotated":true}');
  expect(readFileSync(join(input.dataDir, "auth.json"), "utf8")).toBe('{"rotated":true}');
  const db = new Database(join(data, "opencode.db"), { create: true });
  db.exec("CREATE TABLE account (id TEXT, url TEXT); CREATE TABLE account_state (active_account_id TEXT, active_org_id TEXT)");
  db.close();
  expect(openCodeSessionHomePrefix(home)).toContain(`XDG_DATA_HOME=${join(home.dir, ".local", "share")}`);
  expect(settleOpenCodeSessionHome(home, id)).toBe(true);
  const resumed = openOpenCodeSessionHome({ ...input, resumeSessionId: id });
  expect(resumed.dir).toBe(home.dir);
  expect(existsSync(join(resumed.dir, ".local", "share", "opencode", "opencode.db"))).toBe(true);
  expect(await finishOpenCodeSessionHome(resumed, { final: true, resumable: true, sessionId: id }))
    .toEqual({ usable: false, removed: true });
  expect(existsSync(resumed.dir)).toBe(false);
  expect(() => openOpenCodeSessionHome({ ...input, resumeSessionId: id })).toThrow("has no private home");
});

test("missing login is allowed; linked login and invalid model state refuse", () => {
  const input = paths();
  const home = openOpenCodeSessionHome(input);
  expect(existsSync(join(home.dir, ".local", "share", "opencode", "auth.json"))).toBe(false);
  home.remove();
  symlinkSync(join(input.root, "other"), join(input.dataDir, "auth.json"));
  expect(() => openOpenCodeSessionHome(input)).toThrow("owned regular file");
  const malformed = paths();
  writeFileSync(join(malformed.stateDir, "model.json"), "not JSON");
  expect(() => openOpenCodeSessionHome(malformed)).toThrow("model state");
});

test("home cleanup retries removals and keeps a failed final resumable", async () => {
  const quiet = spyOn(console, "error").mockImplementation(() => {});
  try {
    let attempts = 0;
    const home = stubHome();
    home.remove = () => { if (++attempts === 1) throw new Error("busy"); return true; };
    expect(await finishOpenCodeSessionHome(home, { final: true, resumable: true, sessionId: id }))
      .toEqual({ usable: false, removed: true });
    expect(attempts).toBe(2);
    home.remove = () => false;
    expect(await finishOpenCodeSessionHome(home, { final: true, resumable: true, sessionId: id }))
      .toEqual({ usable: true, removed: false });
    home.settle = () => { throw new Error("collision"); };
    expect(settleOpenCodeSessionHome(home, id)).toBe(false);
  } finally { quiet.mockRestore(); }
});

test("a FIFO login refuses without waiting for a writer", () => {
  const input = paths();
  const fifo = Bun.spawnSync(["mkfifo", join(input.dataDir, "auth.json")]);
  expect(fifo.exitCode).toBe(0);
  expect(() => openOpenCodeSessionHome(input)).toThrow("owned regular file");
});

test("plain sessions need no private home; abandoned fresh homes are removed", async () => {
  const input = { final: false, resumable: false, sessionId: null };
  expect(await finishOpenCodeSessionHome(null, input)).toEqual({ usable: true, removed: false });
  let removed = 0;
  const home = { ...stubHome(), remove: () => { removed++; return true; } };
  expect(await finishOpenCodeSessionHome(home, input)).toEqual({ usable: false, removed: false });
  expect(removed).toBe(1);
  await finishOpenCodeSessionHome({ ...home, resumed: true }, input);
  expect(removed).toBe(1);
});

test("each sandbox turn allows the current home and fresh provider config only", () => {
  const home = stubHome();
  const oldHome = "/fixture/run-before-settlement";
  const options = { harnessStateDirs: ["/fixture/keep", oldHome], blockPaths: ["/fixture"] };
  const policy = openCodeSessionSandboxOptions(options, home, oldHome, "/fixture/provider-new/opencode.json");
  expect(policy.harnessStateDirs).toEqual(["/fixture/keep", home.dir, "/fixture/provider-new"]);
  expect(policy.blockPaths).toEqual(["/fixture"]);
  expect(options.harnessStateDirs).toContain(oldHome);
  expect(openCodeSessionSandboxOptions({}, home, oldHome).harnessStateDirs).toEqual([home.dir]);
});

test("caller blocks are never reopened for fresh provider or turn directories", () => {
  const home = stubHome();
  const options = { blockPaths: ["/fixture"] };
  const provider = "/fixture/provider-new/opencode.json";
  expect(() => openCodeSessionSandboxOptions(options, home, home.dir, provider, ["/fixture/provider-new"]))
    .toThrow("--sandbox-block");
  expect(() => openCodeSessionSandboxOptions(options, home, home.dir, provider, ["/fixture/turn"], "/fixture/turn"))
    .toThrow("--sandbox-block");
  expect(openCodeSessionSandboxOptions(options, home, home.dir, provider, [], "/fixture/turn").harnessStateDirs)
    .toEqual([home.dir, "/fixture/turn", "/fixture/provider-new"]);
});

test("persistent config cannot replace fresh turn config, and changed private logins refuse", () => {
  const input = paths();
  const home = openOpenCodeSessionHome(input);
  const config = join(home.dir, ".config", "opencode");
  mkdirSync(config, { recursive: true });
  writeFileSync(join(config, "opencode.json"), '{"agent":{"build":{"permission":{"bash":"allow"}}}}');
  const prefix = openCodeSessionHomePrefix(home);
  expect(prefix.some((arg) => /^(HOME|XDG_CONFIG_HOME|XDG_CACHE_HOME)=/.test(arg))).toBe(false);
  writeFileSync(join(home.dir, ".local", "share", "opencode", "auth.json"), '{"provider":{"type":"wellknown"}}');
  expect(() => openCodeSessionHomePrefix(home)).toThrow("login carries remote configuration");
});

test("captured caller blocks retain their target after an alias changes", () => {
  const input = paths();
  const providerRoot = join(input.dataDir, ".codemux");
  mkdirSync(providerRoot);
  const alias = join(input.root, "block-alias");
  symlinkSync(providerRoot, alias);
  const captured = canonicalSandboxBlockPaths([alias]);
  rmSync(alias);
  symlinkSync(input.stateDir, alias);
  const home = { ...stubHome(), dir: join(input.dataDir, ".codemux-hermetic", "session") };
  expect(() => openCodeSessionSandboxOptions({}, home, home.dir,
    join(providerRoot, "fresh", "opencode.json"), captured)).toThrow("--sandbox-block");
});

test("an idle final driver reports its private home and closes its resume record", async () => {
  const input = paths();
  const home = openOpenCodeSessionHome(input);
  home.settle(id);
  const events: Record<string, any>[] = [];
  const options: OpenCodeDriverOptions = {
    resumeSessionId: id, autonomy: "low", cwd: input.root, hermetic: true,
    privateHome: home, final: true, sandboxed: false, sandboxTrust: "standard",
    sandboxNoNet: false, sandboxScrubEnv: false, passEnv: [], authorPrefix: false,
    sessionTimeoutMs: null, registryPath: null, harnessHome: input.dataDir, providerBaseUrl: null,
    spawnTurn: async () => { throw new Error("idle session must not spawn"); },
    sink: (line) => { events.push(JSON.parse(line)); },
  };
  const driver = new OpenCodeSessionDriver(options);
  const code = driver.run();
  driver.handleCallerLine('{"type":"shutdown"}');
  expect(await code).toBe(0);
  expect(events.find((event) => event.type === "session_started")?.private_home).toBe(home.dir);
  expect(events.at(-1)?.resumable).toBe(false);
  expect(existsSync(home.dir)).toBe(false);
  driver.dispose();
});

test("final waits for an abandoned spawn before removing the private home", async () => {
  const input = paths();
  const home = openOpenCodeSessionHome(input);
  const sessionId = "ses_fake1234567890";
  home.settle(sessionId);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const session = await startSession({ resumeSessionId: sessionId, privateHome: home,
    hermetic: true, final: true, spawnGraceMs: 200 }, {}, 0, gate);
  let finished = false;
  void session.code.then(() => { finished = true; });
  send(session.driver, { type: "user", text: "scenario:wait late" });
  send(session.driver, { type: "shutdown" });
  await Bun.sleep(250);
  expect(finished).toBe(false);
  expect(existsSync(home.dir)).toBe(true);
  release();
  expect(await session.code).toBe(1);
  expect(existsSync(home.dir)).toBe(false);
});
