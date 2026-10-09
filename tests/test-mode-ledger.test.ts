/**
 * The wiring contract of the test-run ledger redirect (review ul4): the
 * package.json test scripts load tests/setup.ts with `--preload`, and the
 * preload sets `CODEMUX_TEST_LEDGER` — the one variable the append path
 * trusts for a test run, never a generic marker another process may set.
 * The child process runs the pin fixture under that preload with both
 * ledger variables stripped and a neutral HOME; it fails unless the
 * redirect fires, so a dropped `--preload` flag cannot pass silently.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { callLogPath } from "../src/call-log.js";

describe("the test-run ledger redirect", () => {
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
      // (the registry-path guard in tests/session-cli.test.ts).
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
