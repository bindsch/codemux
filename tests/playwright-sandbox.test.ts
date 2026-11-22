import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAdapter } from "../src/adapters/index.js";
import { buildPlaywrightSandboxMcp, playwrightServerArgs } from "../src/mcp.js";
import {
  PLAYWRIGHT_SOCKET_DIR_MAX_BYTES,
  finalizePlaywrightSocketDir,
  playwrightBrowsersDir,
  playwrightRegistryDir,
  preparePlaywrightSocketDir,
  reservePlaywrightSocketDir,
} from "../src/playwright-sandbox.js";
import { buildScodeCommand, type SandboxOptions } from "../src/sandbox.js";
import { buildClaudeSessionCommand } from "../src/session/claude-session.js";

// 2026-11-21: with the tools granted, a sandboxed headless zai run still
// could not open a page until the server ran with --isolated --headless
// --no-sandbox, had a short PWTEST_SOCKETS_DIR, and the sandbox allowed
// that directory and the browser install directory.

function fixture(): { binDir: string; home: string; cwd: string; binary: string; cleanup: () => void } {
  const binDir = mkdtempSync(join(tmpdir(), "codemux-pws-bin-"));
  const home = mkdtempSync(join(tmpdir(), "codemux-pws-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "codemux-pws-cwd-"));
  const binary = join(binDir, "playwright-mcp");
  writeFileSync(binary, "#!/bin/sh\nexit 0\n");
  chmodSync(binary, 0o755);
  return { binDir, home, cwd, binary, cleanup: () => { for (const dir of [binDir, home, cwd]) rmSync(dir, { recursive: true, force: true }); } };
}

function serverEntry(cmd: readonly string[]): { args: string[]; env?: Record<string, string> } {
  return JSON.parse(cmd[cmd.indexOf("--mcp-config") + 1] ?? "").mcpServers.playwright;
}

/** The paths one flag grants in a scode argv, in order. */
function granted(argv: readonly string[], flag: string): string[] {
  const end = argv.indexOf("--");
  return argv.slice(0, end).flatMap((argument, index) => argument === flag ? [argv[index + 1] ?? ""] : []);
}

describe("the Playwright server entry under the sandbox", () => {
  test("a launch setting adds the sandbox arguments and the socket directory; none keeps the bare entry", () => {
    const f = fixture();
    try {
      const base = { enabled: true, binaryPath: f.binary, pathEnv: "" };
      const bare = serverEntry(buildPlaywrightSandboxMcp(true, base).args);
      expect(bare.args).toEqual([]);
      expect(bare.env).toBeUndefined();
      const headless = serverEntry(buildPlaywrightSandboxMcp(true, { ...base, launch: { headless: true, socketDir: "/tmp/cmx-pw-test" } }).args);
      expect(headless.args).toEqual(["--isolated", "--headless", "--no-sandbox"]);
      expect(headless.env).toEqual({ PWTEST_SOCKETS_DIR: "/tmp/cmx-pw-test", PWTEST_SERVER_REGISTRY: "/tmp/cmx-pw-test/r" });
      const watched = serverEntry(buildPlaywrightSandboxMcp(true, { ...base, launch: { headless: false } }).args);
      expect(watched.args).toEqual(["--isolated", "--no-sandbox"]);
      expect(watched.env).toBeUndefined();
      expect(playwrightServerArgs({ headless: false })).not.toContain("--headless");
    } finally { f.cleanup(); }
  });

  for (const agent of ["claude", "zai"] as const) {
    test(`${agent}: a run is headless and carries its socket directory; the TUI shows the browser`, () => {
      const f = fixture();
      try {
        const adapter = getAdapter(agent, { PATH: f.binDir, HOME: f.home, ZAI_API_KEY: "synthetic" });
        const request = { agent, prompt: "p", cwd: f.cwd, sandboxed: true, enablePlaywrightMcp: true, autonomy: "read-only" } as const;
        const sandbox: SandboxOptions = {};
        const context = adapter.prepareRun(request, "standard", sandbox, { printOnly: true });
        const socketDir = context.playwrightSocketDir?.path ?? "";
        expect(sandbox.playwrightSocketDir).toBe(socketDir);
        const run = serverEntry(adapter.buildRunCommand(request, context));
        expect(run.args).toEqual(["--isolated", "--headless", "--no-sandbox"]);
        expect(run.env).toEqual({ PWTEST_SOCKETS_DIR: socketDir, PWTEST_SERVER_REGISTRY: join(socketDir, "r") });
        const tui = serverEntry(adapter.buildTuiCommand(undefined, "read-only", undefined, true, true, f.cwd, [], false, "/tmp/cmx-pw-tui"));
        expect(tui.args).toEqual(["--isolated", "--no-sandbox"]);
        expect(tui.env).toEqual({ PWTEST_SOCKETS_DIR: "/tmp/cmx-pw-tui", PWTEST_SERVER_REGISTRY: "/tmp/cmx-pw-tui/r" });
      } finally { f.cleanup(); }
    });
  }

  test("a session launch is headless and carries its socket directory", () => {
    const f = fixture();
    try {
      const { argv } = buildClaudeSessionCommand({
        agent: "zai", pathEnv: f.binDir, autonomy: "low", cwd: f.cwd, sandboxed: true,
        enablePlaywrightMcp: true, playwrightSocketDir: "/tmp/cmx-pw-session",
      });
      expect(serverEntry(argv)).toMatchObject({
        args: ["--isolated", "--headless", "--no-sandbox"], env: { PWTEST_SOCKETS_DIR: "/tmp/cmx-pw-session" },
      });
    } finally { f.cleanup(); }
  });
});

describe("the Playwright socket directory", () => {
  test("is short, private, created on demand, and removed at cleanup", () => {
    const dir = reservePlaywrightSocketDir();
    expect(dir.path).toMatch(/^\/tmp\/cmx-pw-[0-9a-f]{8}$/);
    expect(Buffer.byteLength(dir.path)).toBeLessThanOrEqual(PLAYWRIGHT_SOCKET_DIR_MAX_BYTES);
    // Reserving names the path and creates nothing.
    expect(existsSync(dir.path)).toBe(false);
    dir.finalize();
    dir.create();
    // The server's registry lives inside the socket directory, not in the
    // read-only browser install directory.
    expect(lstatSync(playwrightRegistryDir(dir.path)).isDirectory()).toBe(true);
    try {
      const stat = statSync(dir.path);
      expect(stat.isDirectory()).toBe(true);
      expect(stat.mode & 0o777).toBe(0o700);
      // What the server leaves inside goes with the directory.
      mkdirSync(join(dir.path, "browser"));
      writeFileSync(join(dir.path, "browser", "x.sock"), "");
    } finally { dir.finalize(); }
    expect(existsSync(dir.path)).toBe(false);
    expect(() => dir.finalize()).not.toThrow();
  });

  test("a root too long for a Unix socket is refused by name", () => {
    const root = join("/tmp", "x".repeat(PLAYWRIGHT_SOCKET_DIR_MAX_BYTES));
    expect(() => reservePlaywrightSocketDir(root)).toThrow(/needs a short socket directory.*a Unix socket path cannot hold it/);
  });

  test("an existing path is never adopted, and a replaced directory is never removed", () => {
    const root = mkdtempSync("/tmp/cmx-pwt-");
    try {
      const planted = reservePlaywrightSocketDir(root);
      symlinkSync(root, planted.path);
      expect(() => planted.create()).toThrow(/EEXIST/);
      planted.finalize();
      expect(existsSync(planted.path)).toBe(true);
      rmSync(planted.path);

      const dir = reservePlaywrightSocketDir(root);
      dir.create();
      // Renamed, not removed: Linux gives a new directory the inode of one
      // just deleted, and the original must stay distinct from its stand-in.
      renameSync(dir.path, `${dir.path}-moved`);
      mkdirSync(dir.path);
      writeFileSync(join(dir.path, "keep"), "");
      expect(() => dir.finalize()).toThrow("was replaced; it was not removed");
      expect(existsSync(join(dir.path, "keep"))).toBe(true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  for (const agent of ["claude", "zai"] as const) {
    test(`${agent}: prepareRun creates it, cleanup removes it, and a print-only launch creates nothing`, async () => {
      const f = fixture();
      try {
        const adapter = getAdapter(agent, { PATH: f.binDir, HOME: f.home, ZAI_API_KEY: "synthetic" });
        const request = { agent, prompt: "p", cwd: f.cwd, sandboxed: true, enablePlaywrightMcp: true } as const;
        const preview = adapter.prepareRun(request, "standard", {}, { printOnly: true });
        expect(preview.playwrightSocketDir?.path).toStartWith("/tmp/cmx-pw-");
        expect(existsSync(preview.playwrightSocketDir!.path)).toBe(false);
        await adapter.cleanupRun(preview);

        const context = adapter.prepareRun(request, "standard", {});
        const path = context.playwrightSocketDir!.path;
        expect(statSync(path).mode & 0o777).toBe(0o700);
        await adapter.cleanupRun(context);
        expect(existsSync(path)).toBe(false);

        const backstop = adapter.prepareRun(request, "standard", {});
        adapter.cleanupRunSync(backstop);
        expect(existsSync(backstop.playwrightSocketDir!.path)).toBe(false);

        // No browser asked for, or no sandbox: no directory at all.
        expect(adapter.prepareRun({ ...request, enablePlaywrightMcp: false }, "standard", {}).playwrightSocketDir).toBeNull();
        expect(preparePlaywrightSocketDir({ ...request, sandboxed: false }, undefined, false)).toBeNull();
      } finally { f.cleanup(); }
    });
  }
});

describe("the sandbox grants of a launch that attaches the server", () => {
  test("the browser directory follows PLAYWRIGHT_BROWSERS_PATH, then the platform default, and must exist", () => {
    const home = mkdtempSync(join(tmpdir(), "codemux-pws-home-"));
    try {
      expect(playwrightBrowsersDir({ HOME: home }, "darwin")).toBeNull();
      const mac = join(home, "Library/Caches/ms-playwright");
      const linux = join(home, ".cache/ms-playwright");
      const custom = join(home, "browsers");
      for (const dir of [mac, linux, custom]) mkdirSync(dir, { recursive: true });
      expect(playwrightBrowsersDir({ HOME: home }, "darwin")).toBe(mac);
      expect(playwrightBrowsersDir({ HOME: home }, "linux")).toBe(linux);
      expect(playwrightBrowsersDir({ HOME: home, XDG_CACHE_HOME: join(home, "missing") }, "linux")).toBeNull();
      expect(playwrightBrowsersDir({ HOME: home, PLAYWRIGHT_BROWSERS_PATH: custom }, "darwin")).toBe(custom);
      // A relative value (Playwright's "0" included) names a directory codemux
      // cannot resolve: refused, never replaced by the default (review of 2.0.5).
      for (const relative of ["0", "browsers", "./pw"]) {
        expect(() => playwrightBrowsersDir({ HOME: home, PLAYWRIGHT_BROWSERS_PATH: relative }, "darwin")).toThrow("not an absolute path");
      }
      // The home directory and anything above it is not a browser directory.
      for (const wide of ["/", home, join(home, "..")]) {
        expect(() => playwrightBrowsersDir({ HOME: home, PLAYWRIGHT_BROWSERS_PATH: wide }, "darwin")).toThrow("contains the home directory");
      }
      expect(playwrightBrowsersDir({ HOME: home, PLAYWRIGHT_BROWSERS_PATH: "" }, "darwin")).toBe(mac);
      // scode re-allows a grant beneath its default blocks: only the standard
      // cache location may sit in one (review of 2.0.5, security).
      for (const blocked of [join(home, ".ssh"), join(home, ".ssh/keys"), join(home, "Library"), join(home, "Library/Caches/other")]) {
        mkdirSync(blocked, { recursive: true });
        expect(() => playwrightBrowsersDir({ HOME: home, PLAYWRIGHT_BROWSERS_PATH: blocked }, "darwin")).toThrow("overlaps scode's default-blocked path");
      }
      expect(playwrightBrowsersDir({ HOME: home, PLAYWRIGHT_BROWSERS_PATH: mac }, "darwin")).toBe(mac);
      // Playwright honors a relative XDG_CACHE_HOME; codemux cannot name that directory.
      expect(() => playwrightBrowsersDir({ HOME: home, XDG_CACHE_HOME: "relative" }, "linux")).toThrow("XDG_CACHE_HOME is \"relative\", which is not an absolute path");
      expect(playwrightBrowsersDir({ HOME: home, XDG_CACHE_HOME: "relative" }, "darwin")).toBe(mac);
      // An absolute XDG_CACHE_HOME inside a blocked tree is judged like the variable.
      mkdirSync(join(home, ".ssh/ms-playwright"), { recursive: true });
      expect(() => playwrightBrowsersDir({ HOME: home, XDG_CACHE_HOME: join(home, ".ssh") }, "linux")).toThrow("overlaps scode's default-blocked path");
      // A link at the standard location is judged by its target, on both platforms.
      for (const [platform, standard] of [["darwin", mac], ["linux", linux]] as const) {
        rmSync(standard, { recursive: true });
        symlinkSync(join(home, ".ssh"), standard);
        expect(() => playwrightBrowsersDir({ HOME: home }, platform)).toThrow(/resolves to .*\.ssh, which overlaps scode's default-blocked path/);
        rmSync(standard);
        symlinkSync(custom, standard);
        expect(playwrightBrowsersDir({ HOME: home }, platform)).toBe(standard);
        rmSync(standard);
        mkdirSync(standard);
      }
      expect(playwrightBrowsersDir({ HOME: home }, "win32")).toBeNull();
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test("the scode argv allows the socket and browser directories, and only for such a launch", () => {
    const home = mkdtempSync(join(tmpdir(), "codemux-pws-home-"));
    try {
      const browsers = join(home, "Library/Caches/ms-playwright");
      mkdirSync(browsers, { recursive: true });
      const build = (options: SandboxOptions, env: NodeJS.ProcessEnv = { HOME: home }) =>
        buildScodeCommand(["claude", "-p"], "/work", "read-only", options, "scode", env, true, true, true, "darwin");
      const argv = build({ playwrightSocketDir: "/tmp/cmx-pw-test", blockPaths: ["/elsewhere"] });
      expect(granted(argv, "--allow")).toContain("/tmp/cmx-pw-test");
      // The browser executables run outside the sandbox later: read-only at
      // every trust level, and refused where scode cannot grant read-only
      // (review of 2.0.5, correctness 1 and security 1).
      expect(granted(argv, "--allow-ro")).toContain(browsers);
      expect(granted(argv, "--allow")).not.toContain(browsers);
      for (const trust of ["trusted", "standard", "untrusted"] as const) {
        const leveled = build({ playwrightSocketDir: "/tmp/cmx-pw-test", trust });
        expect(granted(leveled, "--allow-ro")).toContain(browsers);
        expect(granted(leveled, "--allow")).not.toContain(browsers);
      }
      // A store this launch blocks itself is never reopened by the grant.
      expect(() => build({ playwrightSocketDir: "/tmp/cmx-pw-test", harnessHomeBlockedPaths: [join(home, "Library")] }))
        .toThrow("which this launch blocks");
      expect(() => buildScodeCommand(["claude", "-p"], "/work", "read-only", { playwrightSocketDir: "/tmp/cmx-pw-test" },
        "scode", { HOME: home }, false, true, true, "darwin")).toThrow("requires scode 0.6.7 or newer");
      // Blocks precede the allows that follow them in scode's ordering.
      expect(argv.indexOf("--block")).toBeLessThan(argv.indexOf("/tmp/cmx-pw-test"));
      expect(build({}).join(" ")).not.toContain("ms-playwright");
      // No installed browsers: the socket directory alone.
      const bare = build({ playwrightSocketDir: "/tmp/cmx-pw-test" }, { HOME: join(home, "none") });
      expect(granted(bare, "--allow")).toEqual(["/tmp/cmx-pw-test"]);
      expect(granted(bare, "--allow-ro")).toEqual([]);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test("a caller block over either directory is refused, in both directions", () => {
    const home = mkdtempSync(join(tmpdir(), "codemux-pws-home-"));
    try {
      const browsers = join(home, "browsers");
      mkdirSync(join(browsers, "chromium"), { recursive: true });
      const build = (blockPaths: string[], callerBlockPaths?: string[]) => buildScodeCommand(["claude", "-p"], "/work", "read-only",
        { playwrightSocketDir: "/tmp/cmx-pw-test", blockPaths, ...(callerBlockPaths ? { callerBlockPaths } : {}) },
        "scode", { HOME: home, PLAYWRIGHT_BROWSERS_PATH: browsers }, true, true, true, "darwin");
      expect(() => build(["/tmp"])).toThrow(/--sandbox-block \/tmp overlaps the Playwright socket directory \/tmp\/cmx-pw-test.*--enable-playwright-mcp must allow/);
      expect(() => build(["/tmp/cmx-pw-test/browser"])).toThrow("overlaps the Playwright socket directory");
      expect(() => build([home])).toThrow(`overlaps the Playwright browser install directory ${browsers}`);
      expect(() => build([join(browsers, "chromium")])).toThrow("overlaps the Playwright browser install directory");
      // A launcher block is not the caller's, so the socket directory keeps
      // its grant; the browser directory is never reopened beneath one.
      expect(() => build([home], [])).toThrow("which this launch blocks");
      // The socket directory itself, not /tmp: on Linux the fixture's browser
      // directory is under /tmp too.
      expect(() => build(["/tmp/cmx-pw-test"], [])).not.toThrow();
      expect(() => build([join(home, "other")])).not.toThrow();
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});

// Review of 2.0.5: a run refused during preparation must not strand the
// socket directory. The unreadable experiment spec is read after the
// directory is created, so the refusal exercises its removal.
test.each(["claude", "zai"] as const)("%s: a run refused after the socket directory exists leaves none behind", (agent) => {
  const mine = () => new Set(readdirSync("/tmp").filter((name) => name.startsWith("cmx-pw-")));
  const before = mine();
  const adapter = getAdapter(agent, { PATH: "/usr/bin:/bin", HOME: tmpdir(), ZAI_API_KEY: "synthetic" });
  expect(() => adapter.prepareRun({ agent, prompt: "p", cwd: tmpdir(), sandboxed: true, autonomy: "low",
    enablePlaywrightMcp: true, experimentMcp: join(tmpdir(), "codemux-no-such-spec.json") }, undefined, {})).toThrow(/experiment MCP spec|ENOENT/);
  expect([...mine()].filter((name) => !before.has(name))).toEqual([]);
});

test("a socket directory that was replaced is reported by the quiet cleanup, which never throws", () => {
  const previous = process.exitCode;
  const errors: string[] = [];
  const original = console.error;
  console.error = (line: string) => { errors.push(line); };
  try {
    finalizePlaywrightSocketDir({ finalize: () => { throw new Error("the Playwright socket directory /tmp/x was replaced; it was not removed"); } });
    finalizePlaywrightSocketDir(null);
    expect(errors).toEqual(["codemux: the Playwright socket directory /tmp/x was replaced; it was not removed"]);
    expect(process.exitCode).toBe(1);
  } finally { console.error = original; process.exitCode = previous; }
});
