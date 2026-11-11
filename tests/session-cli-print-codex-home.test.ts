/**
 * The --print-sandbox exit of a fresh codex provider-override session
 * uses a representative CODEX_HOME without creating it. The print path
 * still returns through the launcher's finalizers and writes no registry.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { runSessionCommand, tempWorkdir, removeDir } from "./helpers/session-command.js";

const FAKE_CODEX = `if [ "$1" = "--version" ]; then printf 'codex-cli 0.159.3\\n'; exit 0; fi
exit 7`;

describe("a codex provider-override session's --print-sandbox", () => {
  test("prints a representative provider home without creating state or records", async () => {
    const root = tempWorkdir("session-print-codex");
    const regRoot = tempWorkdir("session-print-codex-reg");
    const registry = join(regRoot, "live-sessions.json");
    const codexHome = join(root, "codex-home");
    const workdir = join(root, "work");
    mkdirSync(codexHome);
    mkdirSync(workdir);
    try {
      const outcome = await runSessionCommand(
        ["-a", "codex", "--print-sandbox", "--cwd", workdir, "--pass-env", "CODEX_HOME"],
        { codex: FAKE_CODEX, scode: "exit 9" },
        {
          registryFile: registry,
          env: {
            HOME: root,
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
      expect(outcome.stdout).toContain(`CODEX_HOME=${join(codexHome, ".codemux-provider", "preview")}`);
      expect(existsSync(registry)).toBe(false);
      expect(readdirSync(codexHome)).toEqual([]);
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
