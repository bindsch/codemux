/**
 * The launch commands refuse at exit 64 with the gate's message BEFORE the
 * harness binary runs. The fakes leave marker files behind so a refusal can
 * prove the negative. usagemux and the harness are fake binaries on a
 * private PATH (helpers/cli.ts), so nothing here spends a real request.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakeBinaryEnv, runCli } from "./helpers/cli.js";
import { result, window } from "./helpers/quota-gate.js";

describe("CLI quota gate", () => {
  // The version the fake answers the probe with; the session floor audits
  // higher than the run contract, so a session test passes a newer one.
  const CLAUDE_VERSION = "2.1.223 (Claude Code)";

  const markerClaude = (fake: { env: Record<string, string> }): string =>
    join(fake.env.PATH!.split(":")[0]!, "claude-ran");

  const gateEnv = (
    remainingPercent: number,
    usedPercent = 100 - remainingPercent,
    claudeVersion = CLAUDE_VERSION
  ): ReturnType<typeof createFakeBinaryEnv> => {
    const snapshot = JSON.stringify({
      schemaVersion: "1",
      generatedAt: new Date().toISOString(),
      results: [
        result({
          windows: [
            window({
              kind: "primary",
              usedPercent,
              remainingPercent,
              windowMinutes: 10_080,
            }),
          ],
        }),
      ],
    });
    return createFakeBinaryEnv({
      claude: `if [ "$1" = "--version" ]; then printf '${claudeVersion}\\n'; exit 0; fi\ncat >/dev/null\ntouch "$(dirname "$0")/claude-ran"\nprintf '%s\\n' '{"type":"result","subtype":"success","result":"status banner\\nOK.\\nusage summary"}'`,
      usagemux: `printf '%s' '${snapshot}'`,
      // The default 0.6.0 answers --version through the helper's preamble;
      // the sandboxed session test needs scode installed on PATH.
      scode: "exit 7",
    });
  };

  test("run refuses before the harness spawns", async () => {
    const fake = gateEnv(5);
    try {
      const { stderr, exitCode } = await runCli(
        ["run", "--no-sandbox", "--auto", "high", "-a", "claude", "-p", "test"],
        fake.env
      );
      expect(exitCode).toBe(64);
      expect(stderr).toContain("quota gate: claude: primary window has 5% left");
      expect(existsSync(markerClaude(fake))).toBe(false);
    } finally {
      fake.cleanup();
    }
  });

  test("a refused run records nothing in the ledger", async () => {
    const fake = gateEnv(5);
    const ledgerDir = mkdtempSync(join(tmpdir(), "codemux-gate-ledger-"));
    const ledgerPath = join(ledgerDir, "calls.jsonl");
    try {
      const { exitCode } = await runCli(
        ["run", "--no-sandbox", "--auto", "high", "-a", "claude", "-p", "test"],
        { ...fake.env, CODEMUX_CALL_LOG: ledgerPath }
      );
      expect(exitCode).toBe(64);
      expect(existsSync(ledgerPath)).toBe(false);
    } finally {
      fake.cleanup();
      rmSync(ledgerDir, { recursive: true, force: true });
    }
  });

  test("run with headroom proceeds and runs the harness", async () => {
    const fake = gateEnv(61);
    try {
      const { stdout, exitCode } = await runCli(
        ["run", "--no-sandbox", "--auto", "high", "-a", "claude", "-p", "test"],
        fake.env
      );
      expect(exitCode).toBe(0);
      expect(stdout).toContain("OK.");
      expect(existsSync(markerClaude(fake))).toBe(true);
    } finally {
      fake.cleanup();
    }
  });

  test("--no-quota-gate launches past a refused window", async () => {
    const fake = gateEnv(5);
    try {
      const { exitCode, stderr } = await runCli(
        ["run", "--no-sandbox", "--auto", "high", "-a", "claude", "-p", "test", "--no-quota-gate"],
        fake.env
      );
      expect(exitCode).toBe(0);
      expect(stderr).not.toContain("quota gate");
      expect(existsSync(markerClaude(fake))).toBe(true);
    } finally {
      fake.cleanup();
    }
  });

  test("quota: false in the config disables the gate", async () => {
    const fake = gateEnv(5);
    const home = mkdtempSync(join(tmpdir(), "codemux-gate-home-"));
    const configDir = join(home, ".config", "codemux");
    try {
      mkdirSync(configDir, { recursive: true });
      writeFileSync(join(configDir, "config.yaml"), "quota: false\n");
      const { exitCode, stderr } = await runCli(
        ["run", "--no-sandbox", "--auto", "high", "-a", "claude", "-p", "test"],
        { ...fake.env, XDG_CONFIG_HOME: join(home, ".config") }
      );
      expect(exitCode).toBe(0);
      expect(stderr).not.toContain("quota gate");
      expect(existsSync(markerClaude(fake))).toBe(true);
    } finally {
      fake.cleanup();
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("--quota-ceiling 50 refuses a 60-percent-used window", async () => {
    // 40% left clears the default 10% ceiling but not the caller's 50.
    const fake = gateEnv(40);
    try {
      const { stderr, exitCode } = await runCli(
        ["run", "--no-sandbox", "--auto", "high", "-a", "claude", "-p", "test", "--quota-ceiling", "50"],
        fake.env
      );
      expect(exitCode).toBe(64);
      expect(stderr).toContain("quota gate: claude: primary window has 40% left");
      expect(stderr).toContain("below the 50% ceiling");
      expect(existsSync(markerClaude(fake))).toBe(false);
    } finally {
      fake.cleanup();
    }
  });

  test("an invalid --quota-ceiling value is a usage error", async () => {
    const fake = gateEnv(61);
    try {
      const { stderr, exitCode } = await runCli(
        ["run", "--no-sandbox", "--auto", "high", "-a", "claude", "-p", "test", "--quota-ceiling", "101"],
        fake.env
      );
      expect(exitCode).toBe(64);
      expect(stderr).toContain("--quota-ceiling must be a number from 0 to 100");
    } finally {
      fake.cleanup();
    }
  });

  test("check refuses before it spends anything", async () => {
    const fake = gateEnv(5);
    try {
      const { stderr, exitCode } = await runCli(
        ["check", "-a", "claude", "--no-sandbox", "--auto", "high"],
        fake.env
      );
      expect(exitCode).toBe(64);
      expect(stderr).toContain("quota gate: claude");
      expect(existsSync(markerClaude(fake))).toBe(false);
    } finally {
      fake.cleanup();
    }
  });

  test("check with headroom proceeds", async () => {
    const fake = gateEnv(61);
    try {
      const { exitCode } = await runCli(
        ["check", "-a", "claude", "--no-sandbox", "--auto", "high"],
        fake.env
      );
      expect(exitCode).toBe(0);
    } finally {
      fake.cleanup();
    }
  });

  test("tui refuses before the harness spawns", async () => {
    const fake = gateEnv(5);
    try {
      const { stderr, exitCode } = await runCli(
        ["tui", "-a", "claude", "--no-sandbox", "--auto", "high"],
        fake.env
      );
      expect(exitCode).toBe(64);
      expect(stderr).toContain("quota gate: claude");
      expect(existsSync(markerClaude(fake))).toBe(false);
    } finally {
      fake.cleanup();
    }
  });

  test("session refuses before the harness spawns", async () => {
    const fake = gateEnv(5);
    const workdir = mkdtempSync(join(tmpdir(), "codemux-gate-work-"));
    try {
      const { stderr, exitCode } = await runCli(
        ["session", "-a", "claude", "--no-sandbox", "--auto", "high", "--cwd", workdir],
        fake.env
      );
      expect(exitCode).toBe(64);
      expect(stderr).toContain("quota gate: claude");
      expect(existsSync(markerClaude(fake))).toBe(false);
    } finally {
      fake.cleanup();
      rmSync(workdir, { recursive: true, force: true });
    }
  });

  // Review round 6, edges finding 1: the gate used to measure the native
  // account even when a validated provider override routed the run to the
  // operator's endpoint, so a low native quota refused a run that would
  // not spend it. With the override in force the gate skips the native
  // account and says so on stderr.
  const overrideEnv = {
    CODEMUX_CLAUDE_PROVIDER_BASE_URL: "https://gateway.example/v1",
    CODEMUX_CLAUDE_PROVIDER_API_KEY: "synthetic-key",
    CODEMUX_CLAUDE_PROVIDER_MODEL: "synthetic-model",
  };

  test("run with a provider override in force skips the native gate", async () => {
    const fake = gateEnv(5);
    try {
      const { stderr, exitCode } = await runCli(
        ["run", "--no-sandbox", "--auto", "high", "-a", "claude", "-p", "test"],
        { ...fake.env, ...overrideEnv }
      );
      expect(exitCode).toBe(0);
      expect(stderr).toContain(
        "quota gate: skipped, claude runs through the provider override at gateway.example"
      );
      expect(existsSync(markerClaude(fake))).toBe(true);
    } finally {
      fake.cleanup();
    }
  }, 30_000);

  test("session with a provider override in force skips the native gate", async () => {
    // The session floor audits higher than the run contract, so the fake
    // claude answers the version probe above it (gateEnv's 2.1.223 is a
    // run-floor version).
    const fake = gateEnv(5, 95, "2.1.300 (Claude Code)");
    const workdir = mkdtempSync(join(tmpdir(), "codemux-gate-ovr-"));
    try {
      // The decision under test is whether the gate let the launch past it;
      // the fake child then fails on its own (a --print-sandbox launch runs
      // no gate at all; review round 56).
      const { stderr, exitCode } = await runCli(
        ["session", "-a", "claude", "--sandbox", "--cwd", workdir, "--timeout", "5"],
        { ...fake.env, ...overrideEnv }
      );
      expect(exitCode).not.toBe(64);
      expect(stderr).toContain(
        "quota gate: skipped, claude runs through the provider override at gateway.example"
      );

      // The same launch without the override is still refused by the
      // native gate: the skip came from the override, not a broken gate.
      // The refusal lands before any child, so no print is needed to see it.
      const plain = await runCli(
        ["session", "-a", "claude", "--sandbox", "--cwd", workdir, "--timeout", "5"],
        fake.env
      );
      expect(plain.exitCode).toBe(64);
      expect(plain.stderr).toContain("quota gate: claude");
    } finally {
      fake.cleanup();
      rmSync(workdir, { recursive: true, force: true });
    }
  }, 30_000);
});
