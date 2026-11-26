/** `--enable-playwright-mcp` end to end on the Claude family, with fake
 * binaries on a fake PATH: what the scode argv and the server entry carry,
 * and the socket directory's life from launch to exit. */

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakeBinaryEnv, runCli } from "./helpers/cli.js";

const CLAUDE = `if [ "$1" = "--version" ]; then printf '2.1.317 (Claude Code)\\n'; exit 0; fi
cat >/dev/null
exit 0`;
const PLAYWRIGHT = "exit 0";

function socketDirs(text: string): string[] {
  return [...new Set(text.match(/\/tmp\/cmx-pw-[0-9a-f]{8}/g) ?? [])];
}

function serverEntry(printed: string): { args: string[]; env?: Record<string, string> } {
  const lines = printed.split("\n");
  return JSON.parse(lines[lines.indexOf("--mcp-config") + 1] ?? "").mcpServers.playwright;
}

describe("CLI - --enable-playwright-mcp on the Claude family", () => {
  for (const agent of ["claude", "zai"] as const) {
    test(`${agent} run refuses --no-web beside the browser, and a relative PLAYWRIGHT_BROWSERS_PATH, with exit 64`, async () => {
      // Review of 2.0.5: the browser fetched what --no-web denies, and a
      // relative browsers path was granted as the default directory.
      const fake = createFakeBinaryEnv({ claude: CLAUDE, scode: "exit 9", "playwright-mcp": PLAYWRIGHT }, "0.6.11");
      try {
        const run = ["run", "-a", agent, "--enable-playwright-mcp", "--print-sandbox", "-p", "test"];
        const env = { ...fake.env, ZAI_API_KEY: "synthetic" };
        const noWeb = await runCli([...run, "--no-web"], env);
        expect(noWeb.exitCode).toBe(64);
        expect(noWeb.stderr).toContain("--no-web cannot be combined with --enable-playwright-mcp");
        expect(noWeb.stdout).not.toContain("--mcp-config");
        const relative = await runCli([...run, "--pass-env", "PLAYWRIGHT_BROWSERS_PATH"], { ...env, PLAYWRIGHT_BROWSERS_PATH: "0" });
        expect(relative.exitCode).toBe(64);
        expect(relative.stderr).toContain("PLAYWRIGHT_BROWSERS_PATH is \"0\", which is not an absolute path");
      } finally { fake.cleanup(); }
    });

    test(`${agent} run --print-sandbox names the socket directory everywhere and creates nothing`, async () => {
      const fake = createFakeBinaryEnv({ claude: CLAUDE, scode: "exit 9", "playwright-mcp": PLAYWRIGHT }, "0.6.11");
      try {
        const { stdout, stderr, exitCode } = await runCli(
          ["run", "-a", agent, "--enable-playwright-mcp", "--print-sandbox", "-p", "test"],
          { ...fake.env, ZAI_API_KEY: "synthetic" }
        );
        expect(stderr + stdout).toContain("--mcp-config");
        expect(exitCode).toBe(0);
        const [dir, ...others] = socketDirs(stdout);
        expect(others).toEqual([]);
        expect(stdout).toContain(`--allow\n${dir}\n`);
        expect(serverEntry(stdout)).toMatchObject({
          args: ["--isolated", "--headless", "--no-sandbox"], env: { PWTEST_SOCKETS_DIR: dir },
        });
        expect(stdout).toContain("--allowedTools");
        expect(stdout).toContain("\nmcp__playwright\n");
        expect(existsSync(dir!)).toBe(false);
      } finally { fake.cleanup(); }
    });
  }

  test("a run has the directory, mode 0700, while the sandbox runs and none afterward", async () => {
    const record = mkdtempSync(join(tmpdir(), "codemux-pw-record-"));
    // The fake sandbox records its argv and the directory's state, then
    // reads the prompt and exits without running the harness.
    const fake = createFakeBinaryEnv({
      claude: CLAUDE,
      "playwright-mcp": PLAYWRIGHT,
      scode: `case " $* " in *" -- "*) ;; *) exit 0 ;; esac
for a in "$@"; do printf '%s\\n' "$a"; done > '${record}/argv'
d=$(grep -m1 '^/tmp/cmx-pw-' '${record}/argv')
ls -ld "$d" > '${record}/stat' 2>&1
cat >/dev/null
exit 0`,
    }, "0.6.11");
    try {
      await runCli(["run", "-a", "claude", "--enable-playwright-mcp", "-p", "test"], fake.env);
      const argv = readFileSync(join(record, "argv"), "utf8");
      const [dir, ...others] = socketDirs(argv);
      expect(others).toEqual([]);
      expect(argv).toContain(`--allow\n${dir}\n`);
      expect(readFileSync(join(record, "stat"), "utf8")).toStartWith("drwx------");
      expect(existsSync(dir!)).toBe(false);
    } finally {
      fake.cleanup();
      rmSync(record, { recursive: true, force: true });
    }
  });

  test("the browser install directory is granted, and a --sandbox-block over a grant is refused with exit 64", async () => {
    const browsers = mkdtempSync(join(tmpdir(), "codemux-pw-browsers-"));
    mkdirSync(join(browsers, "chromium"));
    const fake = createFakeBinaryEnv({ claude: CLAUDE, scode: "exit 9", "playwright-mcp": PLAYWRIGHT }, "0.6.11");
    const env = { ...fake.env, PLAYWRIGHT_BROWSERS_PATH: browsers };
    // The variable reaches the child, and so the grant, only when passed through.
    const run = ["run", "-a", "claude", "--enable-playwright-mcp", "--print-sandbox", "--pass-env", "PLAYWRIGHT_BROWSERS_PATH", "-p", "test"];
    try {
      const printed = await runCli(run, env);
      expect(printed.exitCode).toBe(0);
      // Read-only: the directory holds executables run outside the sandbox.
      expect(printed.stdout).toContain(`--allow-ro\n${browsers}\n`);
      expect(printed.stdout).not.toContain(`--allow\n${browsers}\n`);
      const ambient = await runCli(["run", "-a", "claude", "--enable-playwright-mcp", "--print-sandbox", "-p", "test"], env);
      expect(ambient.stdout).not.toContain(browsers);
      // Without the option the same launch grants neither directory.
      const plain = await runCli(["run", "-a", "claude", "--print-sandbox", "--pass-env", "PLAYWRIGHT_BROWSERS_PATH", "-p", "test"], env);
      expect(plain.stdout).not.toContain(browsers);
      expect(socketDirs(plain.stdout)).toEqual([]);

      for (const [block, role] of [[browsers, "browser install directory"], [join(browsers, "chromium"), "browser install directory"],
        ["/tmp", "socket directory"]] as const) {
        const refused = await runCli([...run, "--sandbox-block", block], env);
        expect(refused.exitCode, block).toBe(64);
        // The CLI hands the launcher the block in canonical form.
        expect(refused.stderr, block).toContain(`--sandbox-block ${realpathSync(block)} overlaps the Playwright ${role}`);
        expect(refused.stdout, block).not.toContain("--mcp-config");
      }
    } finally {
      fake.cleanup();
      rmSync(browsers, { recursive: true, force: true });
    }
  });

  test("tui --print-sandbox keeps the browser visible, grants the socket directory, and creates nothing", async () => {
    const fake = createFakeBinaryEnv({ claude: CLAUDE, scode: "exit 9", "playwright-mcp": PLAYWRIGHT }, "0.6.11");
    try {
      const { stdout, exitCode } = await runCli(["tui", "-a", "claude", "--enable-playwright-mcp", "--print-sandbox"], fake.env);
      expect(exitCode).toBe(0);
      const [dir, ...others] = socketDirs(stdout);
      expect(others).toEqual([]);
      expect(stdout).toContain(`--allow\n${dir}\n`);
      expect(serverEntry(stdout)).toMatchObject({ args: ["--isolated", "--no-sandbox"], env: { PWTEST_SOCKETS_DIR: dir } });
      expect(existsSync(dir!)).toBe(false);
    } finally { fake.cleanup(); }
  });

  test("session --print-sandbox is headless, grants the socket directory, and creates nothing", async () => {
    const fake = createFakeBinaryEnv({ claude: CLAUDE, scode: "exit 9", "playwright-mcp": PLAYWRIGHT }, "0.6.11");
    try {
      const { stdout, exitCode } = await runCli(
        ["session", "-a", "claude", "--auto", "low", "--enable-playwright-mcp", "--print-sandbox"], fake.env);
      expect(exitCode).toBe(0);
      const [dir, ...others] = socketDirs(stdout);
      expect(others).toEqual([]);
      expect(stdout).toContain(`--allow\n${dir}\n`);
      expect(serverEntry(stdout)).toMatchObject({
        args: ["--isolated", "--headless", "--no-sandbox"], env: { PWTEST_SOCKETS_DIR: dir },
      });
      expect(existsSync(dir!)).toBe(false);
    } finally { fake.cleanup(); }
  });

  test("a session has the directory while its child runs and none after it ends", async () => {
    const record = mkdtempSync(join(tmpdir(), "codemux-pw-record-"));
    const fake = createFakeBinaryEnv({
      claude: CLAUDE,
      "playwright-mcp": PLAYWRIGHT,
      scode: `case " $* " in *" -- "*) ;; *) exit 0 ;; esac
for a in "$@"; do printf '%s\\n' "$a"; done > '${record}/argv'
d=$(grep -m1 '^/tmp/cmx-pw-' '${record}/argv')
ls -ld "$d" > '${record}/stat' 2>&1
exit 0`,
    }, "0.6.11");
    try {
      await runCli(["session", "-a", "claude", "--auto", "low", "--enable-playwright-mcp"], fake.env, { stdin: "" });
      const argv = readFileSync(join(record, "argv"), "utf8");
      const [dir, ...others] = socketDirs(argv);
      expect(others).toEqual([]);
      expect(readFileSync(join(record, "stat"), "utf8")).toStartWith("drwx------");
      expect(existsSync(dir!)).toBe(false);
    } finally {
      fake.cleanup();
      rmSync(record, { recursive: true, force: true });
    }
  });
});
