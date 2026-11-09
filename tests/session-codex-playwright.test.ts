/**
 * The codex session's Playwright MCP carrier: `--enable-playwright-mcp`
 * rides the app-server argv as `-c mcp_servers.playwright.command=...`
 * overrides (codex-playwright-mcp.ts, wired in cli-spawn-prep's codex
 * branch), verified end-to-end through the session CLI's --print-sandbox
 * exit, plus the shared session gates that bound the flag.
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { runSessionCommand, tempWorkdir, removeDir } from "./helpers/session-command.js";

const FAKE_CODEX = `if [ "$1" = "--version" ]; then printf 'codex-cli 0.159.3\\n'; exit 0; fi
exit 7`;

describe("a codex session's --enable-playwright-mcp", () => {
  test("the printed spawn argv carries the trust-checked -c override", async () => {
    const root = tempWorkdir("session-codex-pw");
    const regRoot = tempWorkdir("session-codex-pw-reg");
    const registry = join(regRoot, "live-sessions.json");
    const codexHome = join(root, "codex-home");
    const workdir = join(root, "work");
    mkdirSync(codexHome);
    mkdirSync(workdir);
    try {
      const outcome = await runSessionCommand(
        ["-a", "codex", "--print-sandbox", "--auto", "low", "--enable-playwright-mcp", "--cwd", workdir],
        { codex: FAKE_CODEX, scode: "exit 9", "playwright-mcp": "exit 0" },
        { registryFile: registry, env: { CODEX_HOME: codexHome } }
      );
      expect(outcome.exitCode).toBe(0);
      // The printed scode argv embeds the app-server launch, and the
      // MCP server entry rides it as a -c KEY=VALUE token naming the
      // trust-checked binary the fake PATH resolved.
      expect(outcome.stdout).toContain("app-server");
      const line = outcome.stdout.split("\n").find((entry) => entry.includes("mcp_servers.playwright.command="));
      expect(line).toBeDefined();
      expect(line).toContain("playwright-mcp");
      expect(outcome.exitCalls).toEqual([]);
    } finally {
      removeDir(root);
      removeDir(regRoot);
    }
  });

  test("refuses the flag without the sandbox", async () => {
    const root = tempWorkdir("session-codex-pw-nosb");
    const regRoot = tempWorkdir("session-codex-pw-nosb-reg");
    const workdir = join(root, "work");
    mkdirSync(workdir);
    try {
      const outcome = await runSessionCommand(
        ["-a", "codex", "--print-sandbox", "--no-sandbox", "--enable-playwright-mcp", "--cwd", workdir],
        { codex: FAKE_CODEX },
        { registryFile: join(regRoot, "live-sessions.json"), env: { CODEX_HOME: join(root, "codex-home") } }
      );
      expect(outcome.exitCode).toBe(64);
      expect(outcome.stderr).toContain("--enable-playwright-mcp requires --sandbox");
    } finally {
      removeDir(root);
      removeDir(regRoot);
    }
  });

  test("refuses the flag on a hermetic session", async () => {
    const root = tempWorkdir("session-codex-pw-hermetic");
    const regRoot = tempWorkdir("session-codex-pw-hermetic-reg");
    const workdir = join(root, "work");
    mkdirSync(workdir);
    try {
      const outcome = await runSessionCommand(
        ["-a", "codex", "--hermetic", "--enable-playwright-mcp", "--cwd", workdir],
        { codex: FAKE_CODEX },
        { registryFile: join(regRoot, "live-sessions.json"), env: { CODEX_HOME: join(root, "codex-home") } }
      );
      expect(outcome.exitCode).toBe(64);
      expect(outcome.stderr).toContain("--enable-playwright-mcp cannot be combined with --hermetic");
    } finally {
      removeDir(root);
      removeDir(regRoot);
    }
  });
});
