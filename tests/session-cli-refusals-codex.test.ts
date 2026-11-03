/**
 * The session command's codex-specific refusals, split from
 * tests/session-cli-refusals.test.ts: the thread-id shape of --resume and
 * codex's own session floor, both before a harness spawns.
 */

import { describe, expect, test } from "bun:test";
import { runCli } from "./helpers/cli.js";
import { fakeCodexEnv } from "./helpers/session-cli.js";

describe("CLI - session refusals (codex)", () => {
  test("a codex --resume id that is not a thread id refuses with 64", async () => {
    const fake = fakeCodexEnv();
    try {
      const { stderr, exitCode } = await runCli(
        [
          "session", "-a", "codex", "--no-sandbox", "--auto", "high",
          "--resume", "bad id",
        ],
        fake.env
      );
      expect(exitCode).toBe(64);
      expect(stderr).toContain("codex thread id");
    } finally {
      fake.cleanup();
    }
  });

  test("a codex harness below the session floor is refused before spawn", async () => {
    // The probe reads the `codex-cli <version>` line the real binary
    // prints; a bare version would be an unreadable probe, which the
    // session floor refuses too (review live9; only
    // CODEMUX_ALLOW_UNTESTED_HARNESS=1 warns through).
    const fake = fakeCodexEnv({ version: "codex-cli 0.159.2" });
    try {
      const { stderr, exitCode } = await runCli(
        [
          "session", "-a", "codex", "--no-sandbox", "--auto", "high",
        ],
        fake.env
      );
      expect(exitCode).toBe(1);
      expect(stderr).toContain("0.159.3");
    } finally {
      fake.cleanup();
    }
  });
});
