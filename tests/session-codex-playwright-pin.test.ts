/**
 * Review M5 (scratch/fix/review-owner-integration.md): a codex session's
 * --enable-playwright-mcp reaches the driver's record, so the record and
 * the resume probe (which carries the flag) agree. The argv already
 * attaches the server (tests/session-codex-playwright.test.ts).
 */

import { expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as cliDrivers from "../src/session/cli-drivers.js";
import * as spawnModule from "../src/session/spawn.js";
import { runSessionCommand, tempWorkdir, removeDir } from "./helpers/session-command.js";
import { resolveTrustedCommand, trustCheckedCommandChecks } from "../src/executable-security.js";

const FAKE_CODEX = `if [ "$1" = "--version" ]; then printf 'codex-cli 0.159.3\\n'; exit 0; fi
exit 7`;
const SCODE_PASSTHROUGH = 'while [ "$1" != "--" ]; do shift; done\nshift\nexec "$@"';

/** Run a codex session up to its long-lived spawn, which is stubbed to
 * throw; returns the driver options and the spawn options seen. */
async function codexSessionToSpawn(flags: string[]) {
  const root = tempWorkdir("session-codex-pw-pin");
  const codexHome = join(root, "codex-home");
  const workdir = join(root, "work");
  mkdirSync(codexHome);
  mkdirSync(workdir);
  const seen: {
    driverOptions: Record<string, unknown> | null;
    spawnOptions: { extraExecutableChecks?: Array<{ path: string }> } | null;
  } = { driverOptions: null, spawnOptions: null };
  try {
    const outcome = await runSessionCommand(
      ["-a", "codex", "--sandbox", "--auto", "low", "--cwd", workdir, ...flags],
      { codex: FAKE_CODEX, scode: SCODE_PASSTHROUGH, "playwright-mcp": "exit 0" },
      {
        registryFile: join(root, "live-sessions.json"),
        env: { CODEX_HOME: codexHome },
        setup: () => {
          const original = cliDrivers.createSessionDriver;
          const drivers = spyOn(cliDrivers, "createSessionDriver").mockImplementation((...args) => {
            const built = original(...args);
            seen.driverOptions = (built.driver as unknown as { options: Record<string, unknown> }).options;
            return built;
          });
          const spawn = spyOn(spawnModule, "spawnSessionChild").mockImplementation(async (_argv, _env, options) => {
            seen.spawnOptions = options as typeof seen.spawnOptions;
            throw new Error("synthetic spawn stop");
          });
          return () => { spawn.mockRestore(); drivers.mockRestore(); };
        },
      }
    );
    return { outcome, ...seen };
  } finally {
    removeDir(root);
  }
}

test("the codex driver records --enable-playwright-mcp (review M5)", async () => {
  const on = await codexSessionToSpawn(["--enable-playwright-mcp"]);
  expect(on.outcome.stderr).toContain("synthetic spawn stop");
  expect(on.driverOptions?.playwrightMcp).toBe(true);
  const off = await codexSessionToSpawn([]);
  expect(off.driverOptions?.playwrightMcp).toBe(false);
}, 20_000);

test("the codex spawn re-stats the Playwright binary inside its -c value (review M5)", async () => {
  const on = await codexSessionToSpawn(["--enable-playwright-mcp"]);
  const paths = (on.spawnOptions?.extraExecutableChecks ?? []).map((check) => check.path);
  expect(paths.some((path) => path.endsWith("/playwright-mcp"))).toBe(true);
  const off = await codexSessionToSpawn([]);
  expect((off.spawnOptions?.extraExecutableChecks ?? []).map((check) => check.path)
    .some((path) => path.endsWith("/playwright-mcp"))).toBe(false);
}, 20_000);

test("a replaced nested Playwright executable is rejected before the fake child starts", async () => {
  const parent = join(process.cwd(), "scratch", "fix", "codex-playwright-pin");
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, "case-"));
  const binary = join(root, "playwright-mcp");
  const cwd = join(root, "work"); mkdirSync(cwd);
  try {
    writeFileSync(binary, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    const command = resolveTrustedCommand([binary], "fake Playwright", cwd, "");
    const checks = trustCheckedCommandChecks(command);
    writeFileSync(binary, "#!/bin/sh\nexit 23\n", { mode: 0o700 });
    await expect(spawnModule.spawnSessionChild([process.execPath, "-e", "process.exit(0)"], { PATH: process.env.PATH ?? "" }, {
      cwd, sandboxed: false, autonomy: "read-only", extraExecutableChecks: checks,
    }, { onLine() {}, onFatal() {} })).rejects.toThrow("changed");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
