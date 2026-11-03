/** The experiment bridge's `check` lifecycle, split from
 * tests/experiment-bridge.test.ts: the paired probe/control recordings a
 * check writes, and the canary cleanup an interrupted check owes. */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createFakeBinaryEnv, runCli } from "./helpers/cli.js";
import { cleanupExperimentDirs, experimentDirs, setupExperiment } from "./helpers/experiment-setup.js";

afterEach(cleanupExperimentDirs);

describe("the experiment check lifecycle", () => {
  test("paired check writes unique probe and control recordings in the specified directory", async () => {
    const { cwd, path, spec } = setupExperiment();
    const recording = join(cwd, "recordings");
    writeFileSync(path, JSON.stringify({ ...spec, recording: "recordings" }));
    const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
    const fake = createFakeBinaryEnv({
      claude: `if [ "$1" = "--version" ]; then printf '2.1.280\\n'; exit 0; fi
mode=check-control
for arg in "$@"; do if [ "$arg" = "--safe-mode" ]; then mode=check-probe; fi; done
exec ${quote(process.execPath)} --no-env-file --no-install --config=${quote(resolve("bunfig.runtime.toml"))} ${quote(resolve("tests/fixtures/experiment-claude.ts"))} "$mode"`,
      scode: 'while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do shift; done\nshift\nexec "$@"',
    });
    try {
      const result = await runCli(["check", "-a", "claude", "--hermetic", "--tools", "none",
        "--experiment-mcp", path, "--auto", "read-only", "--timeout", "5"], fake.env);
      expect(result.exitCode).toBe(0);
      expect(result.stdout + result.stderr).toContain("HERMETIC claude: OK");
      const files = readdirSync(recording);
      expect(files).toHaveLength(2);
      expect(files.filter((file) => file.endsWith(".control.jsonl"))).toHaveLength(1);
      for (const name of files) {
        const file = join(recording, name);
        expect(result.stderr).toContain(`experiment MCP recording: ${join(realpathSync(recording), name)}`);
        expect(statSync(file).mode & 0o777).toBe(0o600);
        const end = JSON.parse(readFileSync(file, "utf8").trim().split("\n").at(-1)!);
        expect(end).toMatchObject({ kind: "run_end", result_received: true, error: null });
        expect(name).toBe(`${end.run_id}${name.endsWith(".control.jsonl") ? ".control" : ""}.jsonl`);
      }
      expect(JSON.parse(readFileSync(path, "utf8")).recording).toBe("recordings");
    } finally { fake.cleanup(); }
  });

  test("an interrupted experiment check removes its canary fixtures on exit", async () => {
    const { path } = setupExperiment();
    const caller = mkdtempSync(join(tmpdir(), "codemux-sigint-caller-"));
    experimentDirs.push(caller);
    const fake = createFakeBinaryEnv({
      // The harness announces its start in the canary directory (its
      // scratch cwd): a SIGINT before the run starts exits 130, not 143.
      claude: `if [ "$1" = "--version" ]; then printf '2.1.280\\n'; exit 0; fi\ntouch ./harness-started\nsleep 30`,
      scode: 'while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do shift; done\nshift\nexec "$@"',
    });
    const prefix = ".codemux-experiment-check-";
    const stale = new Set(readdirSync(tmpdir()).filter((name) => name.startsWith(prefix)));
    const planted = (): string[] => readdirSync(tmpdir()).filter((name) => name.startsWith(prefix) && !stale.has(name));
    const harnessStarted = (): boolean => planted().some((name) => existsSync(join(tmpdir(), name, "harness-started")));
    try {
      const proc = Bun.spawn([join(import.meta.dir, "..", "bin", "codemux"), "check", "-a", "claude",
        "--hermetic", "--tools", "none", "--experiment-mcp", path, "--auto", "read-only", "--timeout", "30"], {
        cwd: caller, stdout: "pipe", stderr: "pipe", stdin: "ignore",
        env: { ...process.env, PATH: fake.env.PATH, HOME: caller, XDG_CONFIG_HOME: join(caller, ".config"),
          CODEMUX_NO_KEYCHAIN_SYNC: "1" } as Record<string, string>,
      });
      const drained = new Response(proc.stderr).text();
      for (const deadline = Date.now() + 15_000; !harnessStarted() && Date.now() < deadline;) await Bun.sleep(100);
      expect(harnessStarted(), "no canary run appeared in the temp root").toBe(true);
      proc.kill("SIGINT");
      expect(await proc.exited).toBe(143);
      await drained;
      await Bun.sleep(200);
      // Nothing in the temp root, and no canary fixtures in the invoking
      // directory (codemux's own HOME-scoped state may appear there).
      expect(planted()).toEqual([]);
      expect(readdirSync(caller).filter((name) => /^\.?codemux-(experiment-check|canary|agy-check)/.test(name))).toEqual([]);
    } finally { fake.cleanup(); }
  }, 45_000);
});
