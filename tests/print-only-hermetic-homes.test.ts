/**
 * A print-only launch (`--print-sandbox`) prepares a hermetic home that holds
 * the path its argv names and nothing of the operator's (review round 55):
 * codex links no auth.json and needs none; kimi reads no configuration and
 * links no credential directory. The quota gate does not run for a print
 * either: it spends nothing.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexAdapter } from "../src/adapters/codex.js";
import { KimiAdapter } from "../src/adapters/kimi.js";
import { createFakeBinaryEnv, runCli } from "./helpers/cli.js";
import { fakeUsagemux } from "./helpers/doctor.js";

const homes: string[] = [];
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });
const home = (): string => { const h = mkdtempSync(join(tmpdir(), "codemux-print-only-")); homes.push(h); return h; };

describe("codex", () => {
  test("a print-only hermetic home holds no login and needs none", () => {
    const h = home();
    mkdirSync(join(h, ".codex"));
    const adapter = new CodexAdapter({}, h);
    const request = { agent: "codex" as const, prompt: "x", hermetic: true, sandboxed: true };
    // Without the login file a real hermetic run refuses; a print does not.
    expect(() => adapter.prepareRun(request)).toThrow();
    const context = adapter.prepareRun(request, undefined, undefined, { printOnly: true });
    try {
      expect(context.hermeticHome).toBeDefined();
      expect(existsSync(join(context.hermeticHome!.codexHome, "auth.json"))).toBe(false);
    } finally {
      adapter.cleanupRun(context);
    }
  });
});

describe("kimi", () => {
  test("a print-only hermetic home reads no configuration and links no credentials", () => {
    const h = home();
    mkdirSync(join(h, ".kimi-code", "credentials"), { recursive: true });
    const adapter = new KimiAdapter({ HOME: h }, h);
    const request = { agent: "kimi" as const, prompt: "x", hermetic: true, sandboxed: true };
    const context = adapter.prepareRun(request, undefined, undefined, { printOnly: true });
    try {
      const kimiHome = context.kimiHermeticHome!.kimiHome;
      expect(lstatSync(join(kimiHome, "credentials"), { throwIfNoEntry: false })).toBeUndefined();
      expect(readFileSync(join(kimiHome, "config.toml"), "utf8")).toBe("");
    } finally {
      adapter.cleanupRun(context);
    }
    const linked = adapter.prepareRun(request);
    try {
      expect(lstatSync(join(linked.kimiHermeticHome!.kimiHome, "credentials")).isSymbolicLink()).toBe(true);
    } finally {
      adapter.cleanupRun(linked);
    }
  });
});

describe("the quota gate", () => {
  test.each([
    ["check", ["check", "-a", "claude", "--print-sandbox"]],
    ["tui", ["tui", "-a", "claude", "-s", "--print-sandbox"]],
  ])("does not refuse a print-only %s on an exhausted window (review round 56)", async (_label, argv) => {
    const fake = createFakeBinaryEnv({
      claude: `if [ "$1" = "--version" ]; then printf '2.1.300 (Claude Code)\\n'; exit 0; fi; exit 7`,
      scode: "exit 9",
      usagemux: fakeUsagemux({ remainingPercent: 0, usedPercent: 100 }),
    });
    try {
      const { stdout, exitCode, stderr } = await runCli(argv, fake.env);
      expect(exitCode).toBe(0);
      expect(stdout).toContain("/claude\n");
      expect(stderr).not.toContain("quota gate");
    } finally {
      fake.cleanup();
    }
  });

  test("does not refuse a print-only launch on an exhausted window", async () => {
    const fake = createFakeBinaryEnv({
      claude: `if [ "$1" = "--version" ]; then printf '2.1.300 (Claude Code)\\n'; exit 0; fi; exit 7`,
      scode: "exit 9",
      usagemux: fakeUsagemux({ remainingPercent: 0, usedPercent: 100 }),
    });
    try {
      const { stdout, exitCode, stderr } = await runCli(["run", "-a", "claude", "-s", "--print-sandbox", "-p", "OK"], fake.env);
      expect(exitCode).toBe(0);
      expect(stdout).toContain("/claude\n");
      expect(stderr).not.toContain("quota gate");
    } finally {
      fake.cleanup();
    }
  });
});
