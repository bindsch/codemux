/**
 * zai session resume refusals (split from the "CLI - zai sessions" block
 * of tests/session-cli.test.ts): the agent, key, and provider-identity
 * guards on a --resume.
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createFakeBinaryEnv, runCli } from "./helpers/cli.js";
import { readRegistry, sessionRegistryPath } from "../src/session/registry.js";
import { FAKE, driveSession, fakeClaudeEnv } from "./helpers/session-cli.js";

describe("CLI - zai sessions", () => {
  /** A registry with one ended claude session recorded under `home`. */
  function seededClaudeRegistry(home: string): string {
    const dir = dirname(sessionRegistryPath(home));
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const path = sessionRegistryPath(home);
    writeFileSync(
      path,
      `${JSON.stringify({
        version: 1,
        sessions: [
          {
            id: "11111111-2222-3333-4444-555555555555",
            agent: "claude",
            created_at: "2026-10-04T10:00:00.000Z",
            last_activity: "2026-10-04T10:05:00.000Z",
            cwd: join(home, "work"),
            hermetic: false,
            harness_home: join(home, ".claude"),
            model: null,
            autonomy: "high",
            sandboxed: false,
            sandbox_trust: "standard",
            sandbox_no_net: false,
            sandbox_scrub_env: false,
            pass_env: [],
            playwright_mcp: false,
            owner_pid: 999999,
            owner_start: null,
            ended: "2026-10-04T10:05:00.000Z",
          },
        ],
      })}\n`,
      { mode: 0o600 }
    );
    return path;
  }

  test("resuming a claude session through zai is refused with 78 (round 17)", async () => {
    const fake = fakeClaudeEnv();
    const home = mkdtempSync(join(tmpdir(), "codemux-zai-resume-"));
    try {
      seededClaudeRegistry(home);
      const { stderr, exitCode } = await runCli(
        [
          "session", "-a", "zai", "--no-sandbox", "--auto", "high",
          "--resume", "11111111-2222-3333-4444-555555555555",
        ],
        { ...fake.env, HOME: home }
      );
      expect(exitCode).toBe(78);
      expect(stderr).toContain("belongs to agent claude, not zai");
    } finally {
      fake.cleanup();
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("a keyless zai resume under --sandbox --sandbox-scrub-env gets the resume refusal, not the key error (al16)", async () => {
    // Round al15's start gate computed the injected-credential question
    // eagerly, before the resume guards — and adapter.getEnv() resolves
    // the agent's credentials, with zai's throwing outright when no key
    // exists. A keyless zai --resume of a claude-recorded session
    // answered the key error (exit 1) where the round-17 guard above
    // exists to answer the policy refusal (78); the guard's own test was
    // the gate failure. The question is computed lazily now, after every
    // earlier refusal, so under scrub — the one spelling that would
    // reach it on this resume — the guard still speaks first.
    const home = mkdtempSync(join(tmpdir(), "codemux-zai-keyless-"));
    const fake = createFakeBinaryEnv({
      claude: `exec bun '${FAKE}' "$@"`,
      // Exists for the sandbox gate's availability check; never run —
      // the refusal precedes every probe and spawn this test could make.
      scode: "exit 0",
    });
    try {
      seededClaudeRegistry(home);
      const { stderr, exitCode } = await runCli(
        [
          "session", "-a", "zai", "--sandbox", "--sandbox-scrub-env",
          "--auto", "high",
          "--resume", "11111111-2222-3333-4444-555555555555",
        ],
        { ...fake.env, HOME: home }
      );
      expect(exitCode).toBe(78);
      expect(stderr).toContain("belongs to agent claude, not zai");
      // The key error never fired, and neither did the keep-env gate
      // that a resume surviving this one would have run into.
      expect(stderr).not.toContain("Z.AI API key");
      expect(stderr).not.toContain("--keep-env");
    } finally {
      fake.cleanup();
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("a session recorded under an override refuses a resume on another provider or the operator login (review D3, security)", async () => {
    // The recorded harness home (~/.claude) does not move with the
    // endpoint, so without the provider identity in the record every
    // other guard passed and Claude Code replayed the stored transcript
    // at whatever endpoint the resume exported. The record now carries
    // the override's base URL and the resume guard refuses a mismatch in
    // both directions, exit 78 like the other policy refusals.
    const fake = fakeClaudeEnv();
    const isolatedHome = mkdtempSync(join(tmpdir(), "codemux-session-provider-"));
    const workdir = join(isolatedHome, "work");
    mkdirSync(workdir);
    const overrideAt = (baseUrl: string): Record<string, string> => ({
      CODEMUX_CLAUDE_PROVIDER_BASE_URL: baseUrl,
      CODEMUX_CLAUDE_PROVIDER_API_KEY: "e2e-key-do-not-print",
      CODEMUX_CLAUDE_PROVIDER_MODEL: "clawvm-qwen32b-coder",
    });
    try {
      const session = await driveSession(
        [
          "session", "-a", "claude", "--no-sandbox", "--auto", "high",
          "--cwd", workdir, "--shutdown-grace", "2",
          "--pass-env", "FAKE_STATE_DIR,FAKE_CWD",
        ],
        {
          HOME: isolatedHome,
          XDG_CONFIG_HOME: join(isolatedHome, ".config"),
          FAKE_STATE_DIR: fake.stateDir,
          FAKE_CWD: workdir,
          ...fake.env,
          ...overrideAt("http://127.0.0.1:9/v1"),
        }
      );
      let sessionId = "";
      try {
        session.send({ type: "user", text: "scenario:basic hello" });
        const started = await session.waitFor(
          "session_started",
          (event) => event.type === "session_started"
        );
        sessionId = started.session_id as string;
        await session.waitFor("turn_completed", (event) => event.type === "turn_completed");
        session.send({ type: "shutdown" });
        const [exitCode] = await session.exit;
        expect(exitCode).toBe(0);
      } finally {
        await session.proc.kill();
      }
      // The record carries the endpoint the transcript ran against.
      const registryPath = sessionRegistryPath(isolatedHome);
      const registry = readRegistry(registryPath);
      expect(registry.outcome).toBe("ok");
      const entry =
        registry.outcome === "ok"
          ? registry.file.sessions.find((r) => r.id === sessionId)
          : undefined;
      expect(entry?.provider_base_url).toBe("http://127.0.0.1:9/v1");

      // The same transcript on another endpoint: refused before spawn.
      const other = await runCli(
        [
          "session", "-a", "claude", "--no-sandbox", "--auto", "high",
          "--cwd", workdir, "--resume", sessionId,
        ],
        {
          ...fake.env,
          HOME: isolatedHome,
          XDG_CONFIG_HOME: join(isolatedHome, ".config"),
          ...overrideAt("http://127.0.0.1:10/v1"),
        }
      );
      expect(other.exitCode).toBe(78);
      expect(other.stderr).toContain("created against the provider override at http://127.0.0.1:9/v1");
      expect(other.stderr).toContain("cannot resume against the provider override at http://127.0.0.1:10/v1");
      // And back onto the operator's own login: refused too.
      const login = await runCli(
        [
          "session", "-a", "claude", "--no-sandbox", "--auto", "high",
          "--cwd", workdir, "--resume", sessionId,
        ],
        {
          ...fake.env,
          HOME: isolatedHome,
          XDG_CONFIG_HOME: join(isolatedHome, ".config"),
        }
      );
      expect(login.exitCode).toBe(78);
      expect(login.stderr).toContain("cannot resume against the operator's own login");
    } finally {
      fake.cleanup();
      rmSync(isolatedHome, { recursive: true, force: true });
    }
  }, 30_000);
});
