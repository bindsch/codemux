import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { createFakeBinaryEnv, runCli } from "./helpers/cli.js";
import { runSessionCommand } from "./helpers/session-command.js";

const root = realpathSync(mkdtempSync(join(import.meta.dir, "../scratch/strict-cli-refusals-")));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const home = join(root, "home"), cwd = join(root, "project"), redirected = join(root, "redirected");
mkdirSync(home); mkdirSync(cwd); mkdirSync(join(cwd, ".git")); mkdirSync(redirected);
symlinkSync(cwd, join(redirected, "opencode"));
const alias = join(root, "root-alias"); symlinkSync("/", alias);
const env = { HOME: home, XDG_STATE_HOME: join(home, "state"), XDG_CACHE_HOME: join(home, "cache"),
  XDG_CONFIG_HOME: join(home, ".config"), XDG_DATA_HOME: join(home, "data"), CODEMUX_NO_KEYCHAIN_SYNC: "1" };
const cases: { name: string; message: string; env?: Record<string, string>; flags?: string[] }[] = [
  { name: "relative state", message: "absolute path", env: { XDG_STATE_HOME: "relative" } },
  { name: "state below a file", message: "ENOTDIR", env: { XDG_STATE_HOME: "/dev/null" } },
  { name: "root state", message: "filesystem root", env: { XDG_STATE_HOME: "/" } },
  { name: "root cache alias", message: "filesystem root", env: { XDG_CACHE_HOME: alias } },
  { name: "HOME grant", message: "HOME or its ancestors", env: { HOME: join(root, "opencode"), XDG_STATE_HOME: root } },
  { name: "redirected state", message: "redirected by a symlink", env: { XDG_STATE_HOME: redirected } },
  { name: "ancestor caller block", message: "covers the launch's own harness state", flags: ["--sandbox-block", join(home, "cache")] },
  { name: "descendant caller block", message: "sits inside the launch's own harness state", flags: ["--sandbox-block", join(home, "cache/opencode/child")] },
];
const binaries = { opencode: 'case "$1" in --version) echo 1.19.5; exit 0;; esac\nexit 99', scode: "exit 99" };
for (const mode of ["run", "session", "tui", "check"] as const) {
  test.each(cases)(`${mode} reports $name as exit 64`, async (entry) => {
    const flags = ["-a", "opencode", "--sandbox-strict", "--print-sandbox", "--cwd", cwd, ...(entry.flags ?? [])];
    const environment = { ...env, ...entry.env };
    const fake = createFakeBinaryEnv(binaries);
    try {
      const result = mode === "session" ? await runSessionCommand(flags, binaries, { env: environment })
        : await runCli([mode, ...flags, ...(mode === "run" ? ["-p", "unused preview"] : [])], { ...fake.env, ...environment });
      expect(result.exitCode, result.stderr).toBe(64);
      expect(result.stderr).toContain(entry.message);
      expect(result.stdout).not.toContain("--allow");
    } finally { fake.cleanup(); }
  });
}
