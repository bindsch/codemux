/**
 * The wiring contract of the test-run ledger redirect (review ul4): the
 * package.json test scripts load tests/setup.ts with `--preload`, and the
 * preload sets `CODEMUX_TEST_LEDGER` — the one variable the append path
 * trusts for a test run, never a generic marker another process may set.
 * Child tests cover unset and hostile inherited paths, both with the
 * explicit preload and with bunfig.toml's automatic test preload.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { callLogPath } from "../src/call-log.js";

describe("the test-run ledger redirect", () => {
  test.each(["preload", "bare"])("%s overrides inherited ledger and state paths", async (mode) => {
    const outside = mkdtempSync(join(tmpdir(), "codemux-inherited-state-"));
    try {
      const env = { ...process.env, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0", HOME: outside, USERPROFILE: outside,
        XDG_STATE_HOME: outside, XDG_DATA_HOME: outside, XDG_CACHE_HOME: outside, XDG_CONFIG_HOME: outside,
        CODEMUX_CALL_LOG: join(outside, "operator.jsonl"), CODEMUX_TEST_LEDGER: join(outside, "inherited.jsonl") };
      const proc = Bun.spawn([process.execPath, "test", ...(mode === "preload" ? ["--preload", "./tests/setup.ts"] : []),
        join(import.meta.dir, "fixtures/test-mode-pin.test.ts")], { cwd: join(import.meta.dir, ".."), env, stdout: "pipe", stderr: "pipe" });
      const [stderr, , code] = await Promise.all([new Response(proc.stderr).text(), new Response(proc.stdout).text(), proc.exited]);
      expect(code, stderr).toBe(0);
      expect(readdirSync(outside, { recursive: true })).toEqual([]);
    } finally { rmSync(outside, { recursive: true, force: true }); }
  });
  test("the preload wires CODEMUX_TEST_LEDGER into a spawned bun test (ul4)", async () => {
    const home = mkdtempSync(join(tmpdir(), "codemux-test-mode-home-"));
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (
        value !== undefined &&
        key !== "CODEMUX_CALL_LOG" &&
        key !== "CODEMUX_TEST_LEDGER"
      ) {
        env[key] = value;
      }
    }
    env.HOME = home;
    try {
      const proc = Bun.spawn(
        [
          process.execPath,
          "test",
          "--preload",
          "./tests/setup.ts",
          join(import.meta.dir, "fixtures", "test-mode-pin.test.ts"),
        ],
        {
          cwd: join(import.meta.dir, ".."),
          stdout: "pipe",
          stderr: "pipe",
          env,
        }
      );
      const [stderr, exitCode] = await Promise.all([
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      expect(exitCode, stderr).toBe(0);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("a bare bun test, with no --preload flag, still redirects through bunfig.toml and never creates the real ledger (ul6)", async () => {
    // Review ul6, correctness major 1: the package.json scripts pass
    // --preload, but `bun test` typed by hand does not; bunfig.toml's
    // [test] preload is what bun reads for every run in the repo. The pin
    // fixture fails unless the redirect fired, and the default ledger
    // path under a neutral HOME must not exist afterward.
    const home = mkdtempSync(join(tmpdir(), "codemux-test-mode-bare-"));
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (
        value !== undefined &&
        key !== "CODEMUX_CALL_LOG" &&
        key !== "CODEMUX_TEST_LEDGER" &&
        key !== "XDG_STATE_HOME"
      ) {
        env[key] = value;
      }
    }
    env.HOME = home;
    try {
      const proc = Bun.spawn(
        [process.execPath, "test", join(import.meta.dir, "fixtures", "test-mode-pin.test.ts")],
        {
          cwd: join(import.meta.dir, ".."),
          stdout: "pipe",
          stderr: "pipe",
          env,
        }
      );
      const [stderr, exitCode] = await Promise.all([
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      expect(exitCode, stderr).toBe(0);
      // The default paths come from the seam itself, never spelled by hand
      // (the registry-path guard in tests/session-cli-happy-path.test.ts).
      for (const platform of ["darwin", "linux"] as const) {
        const ledger = callLogPath({ HOME: home }, platform);
        expect(ledger).not.toBeNull();
        expect(existsSync(ledger as string)).toBe(false);
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
