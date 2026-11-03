/**
 * The --print-sandbox exit of a fresh codex provider-override session
 * (review round 2, edges 3): the run-<pid>-* CODEX_HOME is created before
 * the print branch, so the print path must run the same finalizers the
 * abort path owns — the home is abandoned, the registry never written —
 * instead of process.exit past them.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { runSessionCommand, tempWorkdir, removeDir } from "./helpers/session-command.js";

const FAKE_CODEX = `if [ "$1" = "--version" ]; then printf 'codex-cli 0.159.3\\n'; exit 0; fi
exit 7`;

describe("a codex provider-override session's --print-sandbox", () => {
  test("abandons its fresh provider home and records nothing", async () => {
    const root = tempWorkdir("session-print-codex");
    const regRoot = tempWorkdir("session-print-codex-reg");
    const registry = join(regRoot, "live-sessions.json");
    const codexHome = join(root, "codex-home");
    const workdir = join(root, "work");
    mkdirSync(codexHome);
    mkdirSync(workdir);
    try {
      const outcome = await runSessionCommand(
        ["-a", "codex", "--print-sandbox", "--cwd", workdir],
        { codex: FAKE_CODEX, scode: "exit 9" },
        {
          registryFile: registry,
          env: {
            CODEX_HOME: codexHome,
            CODEMUX_CODEX_PROVIDER_BASE_URL: "https://provider.example/v1",
            CODEMUX_CODEX_PROVIDER_API_KEY: "sk-test-key",
            CODEMUX_CODEX_PROVIDER_MODEL: "gpt-test",
          },
        }
      );
      expect(outcome.exitCode).toBe(0);
      // The print path leaves through the single exit, never a
      // process.exit of its own (edges 3): the finalizers ran before it.
      expect(outcome.exitCalls).toEqual([]);
      expect(outcome.stdout.split("\n").some((line) => line.endsWith("/scode"))).toBe(true);
      // The override home really fed this print (not a vacuous pass with
      // no override resolved): the child's CODEX_HOME is the fresh
      // run-<pid>-* directory under .codemux-provider.
      expect(outcome.stdout).toContain(".codemux-provider");
      expect(outcome.stdout).toContain("run-");
      expect(existsSync(registry)).toBe(false);
      // The provider parent may exist (it predates the home), but no
      // run-<pid>-* directory may remain under it: the print exit
      // abandoned the fresh home the launch had created.
      const parent = join(codexHome, ".codemux-provider");
      const entries = existsSync(parent) ? readdirSync(parent) : [];
      expect(entries.filter((name) => name.startsWith("run-"))).toEqual([]);
    } finally {
      removeDir(root);
      removeDir(regRoot);
    }
  });

  test("a refused --print-sandbox --no-sandbox creates no provider home", async () => {
    // Review round 8, contracts-2 finding 2: the flag combination is
    // refused in the request phase, before the launch phase would
    // create the fresh run-<pid>-* home the old spawn-prep refusal
    // stranded (usageError's process exit bypasses the abandon).
    const root = tempWorkdir("session-print-refused");
    const regRoot = tempWorkdir("session-print-refused-reg");
    const registry = join(regRoot, "live-sessions.json");
    const codexHome = join(root, "codex-home");
    const workdir = join(root, "work");
    mkdirSync(codexHome);
    mkdirSync(workdir);
    try {
      const outcome = await runSessionCommand(
        ["-a", "codex", "--print-sandbox", "--no-sandbox", "--cwd", workdir],
        { codex: FAKE_CODEX },
        {
          registryFile: registry,
          env: {
            CODEX_HOME: codexHome,
            CODEMUX_CODEX_PROVIDER_BASE_URL: "https://provider.example/v1",
            CODEMUX_CODEX_PROVIDER_API_KEY: "sk-test-key",
            CODEMUX_CODEX_PROVIDER_MODEL: "gpt-test",
          },
        }
      );
      expect(outcome.exitCode).toBe(64);
      expect(outcome.stderr).toContain("--print-sandbox requires --sandbox");
      const parent = join(codexHome, ".codemux-provider");
      const entries = existsSync(parent) ? readdirSync(parent) : [];
      expect(entries.filter((name) => name.startsWith("run-"))).toEqual([]);
    } finally {
      removeDir(root);
      removeDir(regRoot);
    }
  });
});
