import { afterEach, expect, mock, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AgyAdapter } from "../src/adapters/agy.js";
import { AGENT_IDS, getAdapter } from "../src/adapters/index.js";
import { AGY_MIRROR_PATH, agyKeychainHost, recoverAgyKeychainSearchList } from "../src/agy-keychain.js";
import { FORCE_KILL_DELAY_MS } from "../src/process-runner.js";
import { codexPlainStreamResult } from "../src/plain-unwrap.js";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const action of cleanup.splice(0).reverse()) action(); });

function homes() {
  const home = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "codemux-0132-")));
  cleanup.push(() => fs.rmSync(home, { recursive: true, force: true }));
  const host = spyOn(agyKeychainHost, "home").mockReturnValue(home);
  const security = spyOn(agyKeychainHost, "securityPath").mockReturnValue(undefined);
  cleanup.push(() => host.mockRestore(), () => security.mockRestore());
  const supplied = join(home, "supplied");
  fs.mkdirSync(supplied);
  return { home, supplied, security };
}

const probeRoot = (home: string) => join(home, ".gemini/.codemux-isolation-probes");

function searchList(security: ReturnType<typeof homes>["security"], initial: string[]) {
  security.mockReturnValue(process.execPath);
  let list = initial;
  const spawn = spyOn(agyKeychainHost, "spawnSync").mockImplementation(((args: string[]) => {
    if (args[1] === "list-keychains" && args[4] === "-s") list = args.slice(5);
    const output = args[1] === "default-keychain" ? `"${join(agyKeychainHost.home(), AGY_MIRROR_PATH)}"` : list.map((path) => `"${path}"`).join("\n");
    return { exitCode: 0, stdout: Buffer.from(output), stderr: Buffer.alloc(0) };
  }) as typeof Bun.spawnSync);
  cleanup.push(() => spawn.mockRestore());
  return { list: () => list, spawn };
}

test("a top-level Codex error after a messageless completed turn never reads the fallback", () => {
  const stdout = [{ type: "thread.started", thread_id: "t" }, { type: "turn.started" },
    { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } },
    { type: "error", message: "protocol failed" },
  ].map((frame) => JSON.stringify(frame)).join("\n");
  const fallback = mock(() => ({ outcome: "text" as const, text: "stale Plan" }));
  const result = codexPlainStreamResult({ stdout, stderr: "", exitCode: 0, success: true }, fallback);
  expect(result).toMatchObject({ stdout: "", exitCode: 1, success: false });
  expect(result.stderr).toContain("protocol failed");
  expect(fallback).not.toHaveBeenCalled();
});

test("API-key private homes share configuration entries but no login or injected token", () => {
  const { home, supplied } = homes();
  const token = ".gemini/antigravity-cli/antigravity-oauth-token";
  for (const base of [home, supplied]) {
    fs.mkdirSync(join(base, ".gemini/antigravity-cli"), { recursive: true });
    fs.writeFileSync(join(base, token), "original token");
  }
  fs.writeFileSync(join(supplied, ".gemini/GEMINI.md"), "configuration");
  fs.writeFileSync(join(supplied, ".gemini/antigravity-cli/settings.json"), "{}");
  for (const hermetic of [false, true]) {
    for (const key of ["GEMINI_API_KEY", "GOOGLE_API_KEY"]) {
      const adapter = new AgyAdapter({ HOME: supplied, [key]: "synthetic-key" });
      const context = adapter.prepareRun({ agent: "agy", prompt: "test", sandboxed: true, hermetic });
      cleanup.push(() => adapter.cleanupRunSync(context));
      const privateHome = context.agyProbe!.home!;
      expect(fs.existsSync(join(privateHome, token))).toBe(false);
      expect(fs.lstatSync(join(privateHome, ".gemini")).isSymbolicLink()).toBe(false);
      expect(fs.existsSync(join(privateHome, ".gemini/GEMINI.md"))).toBe(!hermetic);
      if (!hermetic) expect(fs.lstatSync(join(privateHome, ".gemini/antigravity-cli/settings.json")).isSymbolicLink()).toBe(true);
      fs.writeFileSync(join(privateHome, token), "child token");
      for (const base of [home, supplied]) expect(fs.readFileSync(join(base, token), "utf8")).toBe("original token");
    }
  }
});

test("stale marked homes and mirrors are recovered from both login and injected roots", () => {
  const { home, supplied, security } = homes();
  const stale = [home, supplied].map((base) => {
    const path = join(probeRoot(base), "run-dead");
    fs.mkdirSync(join(path, "Library/Keychains"), { recursive: true });
    fs.writeFileSync(join(path, ".codemux-probe-pid"), "2147483647");
    fs.writeFileSync(join(path, ".codemux-probe-owner"), crypto.randomUUID());
    fs.writeFileSync(join(path, AGY_MIRROR_PATH), "synthetic mirror");
    return path;
  });
  const ordinary = join(home, "personal.keychain-db");
  const state = searchList(security, [...stale.map((path) => join(path, AGY_MIRROR_PATH)), ordinary]);
  new AgyAdapter({ HOME: supplied }).prepareRun({ agent: "agy", prompt: "test", sandboxed: false });
  expect(state.list()).toEqual([ordinary]);
  for (const path of stale) expect(fs.existsSync(path)).toBe(false);
});

test("a symlinked probe root is rejected before any search-list mutation", () => {
  const { home, supplied, security } = homes();
  fs.mkdirSync(join(home, ".gemini"));
  fs.symlinkSync(supplied, probeRoot(home));
  const personal = join(supplied, "personal.keychain-db");
  fs.writeFileSync(personal, "personal");
  const state = searchList(security, [personal]);
  expect(() => new AgyAdapter({ HOME: home }).prepareRun({ agent: "agy", prompt: "test", sandboxed: false }))
    .toThrow("symlink");
  expect(state.list()).toEqual([personal]);
  expect(state.spawn).not.toHaveBeenCalled();
});

test("recovery only owns mirrors at the exact run-directory layout", () => {
  const { home, security } = homes();
  const root = probeRoot(home);
  fs.mkdirSync(root, { recursive: true });
  const unrelated = [join(root, "run-old/personal.keychain-db"), join(root, "run-old/Library/Keychains/personal.keychain-db"),
    join(root, "ordinary", AGY_MIRROR_PATH), join(root, "nested/run-old", AGY_MIRROR_PATH)];
  const state = searchList(security, [...unrelated, join(root, "run-old", AGY_MIRROR_PATH)]);
  recoverAgyKeychainSearchList({ HOME: home });
  expect(state.list()).toEqual(unrelated);
});

test("inaccessible unrelated search-list entries never block mirror recovery", () => {
  const { home, security } = homes();
  const root = probeRoot(home);
  fs.mkdirSync(root, { recursive: true });
  const denied = join(home, "denied");
  const notDirectory = join(home, "file");
  const unrelated = [join(denied, "personal.keychain-db"), join(notDirectory, "personal.keychain-db")];
  const state = searchList(security, [...unrelated, join(root, "run-old", AGY_MIRROR_PATH)]);
  const original = fs.realpathSync;
  const canonicalize = spyOn(fs, "realpathSync").mockImplementation(((path: fs.PathLike) => {
    if (String(path) === denied || String(path) === notDirectory) {
      throw Object.assign(new Error("unrelated entry"), { code: String(path) === denied ? "EACCES" : "ENOTDIR" });
    }
    return original(path);
  }) as typeof fs.realpathSync);
  cleanup.push(() => canonicalize.mockRestore());
  expect(() => recoverAgyKeychainSearchList({ HOME: home })).not.toThrow();
  expect(state.list()).toEqual(unrelated);
});

test("every adapter refuses relative or empty injected HOME before preparation", () => {
  for (const agent of AGENT_IDS) {
    for (const HOME of ["relative", "", "."]) expect(() => getAdapter(agent, { HOME })).toThrow("HOME must be an absolute path");
  }
});

test("SIGTERM exits within the cleanup grace when adapter cleanup never settles", async () => {
  const script = `
    import { runCapturedCommand } from ${JSON.stringify(join(import.meta.dir, "../src/process-runner.ts"))};
    await runCapturedCommand([process.execPath, "-e", "console.log('OK')"], {
      cwd: process.cwd(), env: {},
      stdoutSink: { push() {}, finish() { return "OK"; }, keptBytes() { return 0; },
        closeProtocol() { process.kill(process.pid, "SIGTERM"); return Bun.sleep(25); } },
      onSignaled() { console.error("cleanup-started"); return new Promise(() => {}); }
    });`;
  const child = Bun.spawn([process.execPath, "-e", script], { stdout: "pipe", stderr: "pipe" });
  const started = performance.now();
  let forced = false;
  const watchdog = setTimeout(() => { forced = true; child.kill("SIGKILL"); }, FORCE_KILL_DELAY_MS + 2500);
  try {
    const [exit, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect(stderr).toContain("cleanup-started");
    expect(forced).toBe(false);
    expect(exit).toBe(143);
    expect(performance.now() - started).toBeLessThan(FORCE_KILL_DELAY_MS + 2000);
    expect(stderr).toContain("adapter cleanup and interruption receipt remain incomplete");
  } finally { clearTimeout(watchdog); child.kill(); }
}, 7000);
