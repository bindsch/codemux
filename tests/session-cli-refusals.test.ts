/**
 * The session command's refusal surface (split from
 * tests/session-cli.test.ts): usage errors, version floors, and
 * capability refusals, all before a harness spawns.
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { minimalPath, runCli } from "./helpers/cli.js";
import { sessionRegistryPath } from "../src/session/registry.js";
import { fakeClaudeEnv, fakeCodexEnv } from "./helpers/session-cli.js";

describe("CLI - session refusals", () => {
  test("sessions for an agent whose driver has not landed refuse with 64", async () => {
    const { stderr, exitCode } = await runCli(
      ["session", "-a", "gemini"],
      { PATH: minimalPath() }
    );
    expect(exitCode).toBe(64);
    expect(stderr).toContain("not implemented for 'gemini'");
  });

  test("--hermetic for an agent with no verified mode is refused with 64", async () => {
    // The gate is the adapter's own validateRunRequest on the
    // run-like, so the session answers the run path's refusal verbatim
    // (exit 64); the agents with a verified hermetic mode — claude,
    // zai, codex, kimi, opencode, agy — accept the flag.
    const { stderr, exitCode } = await runCli(
      ["session", "-a", "aider", "--hermetic"],
      { PATH: minimalPath() }
    );
    expect(exitCode).toBe(64);
    expect(stderr).toContain("aider has no verified hermetic mode; see docs/isolation.md");
  });

  test("--sandbox-trust untrusted is refused for sessions with 64", async () => {
    const { stderr, exitCode } = await runCli(
      ["session", "-a", "claude", "--sandbox-trust", "untrusted"],
      { PATH: minimalPath() }
    );
    expect(exitCode).toBe(64);
    expect(stderr).toContain("untrusted");
  });

  test("the scode accounting pair is refused for sessions with 64", async () => {
    // Audit round 2, A8: the pair used to be a commander parse error
    // (exit 1) here while run and tui carried it. A session spawns
    // several children per turn, so there is no single accounting stream
    // to append to; the flags are refused by name with that reason.
    const { stderr, exitCode } = await runCli(
      ["session", "-a", "claude", "--sandbox-account", "ledger.jsonl"],
      { PATH: minimalPath() }
    );
    expect(exitCode).toBe(64);
    expect(stderr).toContain(
      "--sandbox-account and --sandbox-account-id are not supported for sessions"
    );
    expect(stderr).toContain("use run or tui");
    const idOnly = await runCli(
      ["session", "-a", "claude", "--sandbox-account-id", "corr-1"],
      { PATH: minimalPath() }
    );
    expect(idOnly.exitCode).toBe(64);
    expect(idOnly.stderr).toContain("not supported for sessions");
  });

  test("--sandbox-trust untrusted is refused for sessions before the keep-env gate (al21)", async () => {
    // The untrusted preset scrubs, so an override session under it would
    // need the keep-env exemption — but untrusted trust is refused
    // outright for sessions (a session must write harness state), and
    // that refusal fires before the keep-env probe: an operator on a
    // scode without --keep-env reads the trust refusal, never the
    // capability one.
    const fake = fakeClaudeEnv({
      env: {
        CODEMUX_CLAUDE_PROVIDER_BASE_URL: "https://override.example/v1",
        CODEMUX_CLAUDE_PROVIDER_API_KEY: "e2e-untrusted-key",
        CODEMUX_CLAUDE_PROVIDER_MODEL: "claw-32b",
      },
    });
    try {
      const { stderr, exitCode } = await runCli(
        [
          "session", "-a", "claude", "--sandbox",
          "--sandbox-trust", "untrusted", "--sandbox-scrub-env",
        ],
        fake.env
      );
      expect(exitCode).toBe(64);
      expect(stderr).toContain("untrusted");
      expect(stderr).not.toContain("--keep-env");
      expect(stderr).not.toContain("e2e-untrusted-key");
    } finally {
      fake.cleanup();
    }
  });

  test("a --resume id that is not a UUID refuses with 64", async () => {
    const fake = fakeClaudeEnv();
    try {
      const { stderr, exitCode } = await runCli(
        [
          "session", "-a", "claude", "--no-sandbox", "--auto", "high",
          "--resume", "not-a-uuid",
        ],
        fake.env
      );
      expect(exitCode).toBe(64);
      expect(stderr).toContain("UUID");
    } finally {
      fake.cleanup();
    }
  });

  test("a malformed --permission-timeout or --shutdown-grace refuses with 64", async () => {
    // Review live5, contracts 1: the two session-only timeouts were
    // parsed with a bare parseTimeoutOption call, so a malformed value
    // threw into the outer catch and exited 1 (an internal error) where
    // every other bad flag value is usage (64). The same funnel
    // --timeout/--turn-timeout use.
    const fake = fakeClaudeEnv();
    try {
      for (const flag of ["--permission-timeout", "--shutdown-grace"]) {
        const { stderr, exitCode } = await runCli(
          ["session", "-a", "claude", "--no-sandbox", "--auto", "high", flag, "bogus"],
          fake.env
        );
        expect(exitCode).toBe(64);
        expect(stderr).toContain(`${flag} must be a number`);
      }
    } finally {
      fake.cleanup();
    }
  });

  test("a bad --auto or --sandbox-trust value is usage (64) on session and run alike", async () => {
    // Review live10, minor 8: failInvalidOption exited 1, so a bogus
    // --auto on either command was a runtime failure while the session
    // CLI's own usageError exited 64 for the same class of mistake. One
    // class, one code: EX_USAGE everywhere an option value is refused.
    const fake = fakeClaudeEnv();
    try {
      for (const argv of [
        ["session", "-a", "claude", "--auto", "bogus"],
        ["session", "-a", "claude", "--no-sandbox", "--auto", "high", "--sandbox-trust", "bogus"],
        ["run", "-a", "claude", "--auto", "bogus"],
      ]) {
        const { stderr, exitCode } = await runCli(argv, fake.env);
        expect(exitCode).toBe(64);
        expect(stderr).toContain("Invalid value 'bogus'");
      }
    } finally {
      fake.cleanup();
    }
  });

  test("the --tools help text says the flag itself is refused", async () => {
    // Review live4, contracts 2: the string implied `default` was
    // accepted ("Tool selection: default ('none' is refused for
    // sessions)") while every value exits 64. The help must state the
    // refusal outright, the way --hermetic's entry does.
    const { stdout, exitCode } = await runCli(
      ["session", "--help"],
      { PATH: minimalPath() }
    );
    expect(exitCode).toBe(0);
    // Commander wraps the description; compare against whitespace-collapsed
    // output so the wrap point cannot break the assertion.
    const flat = stdout.replace(/\s+/g, " ");
    expect(flat).toContain("--tools <selection>");
    expect(flat).toContain("Tool selection (refused for sessions in this release)");
  });

  test("a well-formed --resume id the registry never recorded exits 66", async () => {
    const fake = fakeClaudeEnv();
    try {
      const { stderr, exitCode } = await runCli(
        [
          "session", "-a", "claude", "--no-sandbox", "--auto", "high",
          "--resume", "11111111-2222-3333-4444-555555555555",
        ],
        fake.env
      );
      expect(exitCode).toBe(66);
      expect(stderr).toContain("no recorded session");
    } finally {
      fake.cleanup();
    }
  });

  test("a harness below the session floor is refused before spawn", async () => {
    const fake = fakeClaudeEnv({ version: "2.1.100" });
    try {
      const { stderr, exitCode } = await runCli(
        [
          "session", "-a", "claude", "--no-sandbox", "--auto", "high",
        ],
        fake.env
      );
      expect(exitCode).toBe(1);
      expect(stderr).toContain("2.1.280");
    } finally {
      fake.cleanup();
    }
  });

  test("a harness whose version cannot be read is refused before spawn too", async () => {
    // Review live9: an unreadable version used to skip the session floor
    // entirely (warn and continue). A wrapper whose --version prints
    // nothing parseable is refused like a below-floor build, naming the
    // floor; the operator override is the only way past.
    const fake = fakeClaudeEnv({ version: "not-a-version" });
    try {
      const { stderr, exitCode } = await runCli(
        [
          "session", "-a", "claude", "--no-sandbox", "--auto", "high",
        ],
        fake.env
      );
      expect(exitCode).toBe(1);
      expect(stderr).toContain("could not determine the claude version");
      expect(stderr).toContain("2.1.280");
    } finally {
      fake.cleanup();
    }
  });

  test("--tools none is refused for sessions with 64", async () => {
    const fake = fakeCodexEnv();
    try {
      const { stderr, exitCode } = await runCli(
        [
          "session", "-a", "codex", "--no-sandbox", "--auto", "high",
          "--tools", "none",
        ],
        fake.env
      );
      expect(exitCode).toBe(64);
      expect(stderr).toContain("--tools none is refused for sessions");
    } finally {
      fake.cleanup();
    }
  });

  test("--tools is refused for an agent with no verified carrier with 64", async () => {
    const fake = fakeClaudeEnv();
    try {
      const { stderr, exitCode } = await runCli(
        [
          "session", "-a", "claude", "--no-sandbox", "--auto", "high",
          "--tools", "default",
        ],
        fake.env
      );
      expect(exitCode).toBe(64);
      expect(stderr).toContain("--tools is not implemented for 'claude' sessions");
    } finally {
      fake.cleanup();
    }
  });

  test("codex --tools is refused like every other agent (honest capability flag)", async () => {
    // Codex has no verified carrier either — the flag is false, so
    // `--tools default` must refuse exactly like claude's, not pass
    // through as a silent no-op (README documents a blanket refusal).
    const { stderr, exitCode } = await runCli(
      [
        "session", "-a", "codex", "--no-sandbox", "--auto", "high",
        "--tools", "default",
      ],
      { PATH: minimalPath() }
    );
    expect(exitCode).toBe(64);
    expect(stderr).toContain("--tools is not implemented for 'codex' sessions");
  });

  test("--enable-playwright-mcp without --sandbox is refused with 64", async () => {
    const { stderr, exitCode } = await runCli(
      [
        "session", "-a", "claude", "--no-sandbox", "--auto", "high",
        "--enable-playwright-mcp",
      ],
      { PATH: minimalPath() }
    );
    expect(exitCode).toBe(64);
    expect(stderr).toContain("--enable-playwright-mcp requires --sandbox");
  });

  test("a provider override an agent cannot carry is refused with run's own message (zai, agy)", async () => {
    // Overrides reach session spawns through the same adapters `run`
    // uses, so the refusal is the adapter's own (base.ts), surfaced by
    // the uniform validateRunRequest gate — verbatim, exit 64 exactly as
    // `codemux run` exits for it, with no key material echoed.
    const cases: Array<{ agent: string; env: Record<string, string> }> = [
      { agent: "zai", env: { CODEMUX_ZAI_PROVIDER_MODEL: "glm" } },
      { agent: "agy", env: { CODEMUX_AGY_PROVIDER_BASE_URL: "https://gateway.example" } },
    ];
    for (const { agent, env } of cases) {
      const { stderr, exitCode } = await runCli(
        ["session", "-a", agent, "--no-sandbox", "--auto", "high"],
        { PATH: minimalPath(), ...env }
      );
      expect(exitCode).toBe(64);
      expect(stderr).toContain(
        `${agent} does not support a provider override; unset CODEMUX_${agent.toUpperCase()}_PROVIDER_* to run it, or route through an agent that does (codemux list marks them "provider")`
      );
    }
    // A half-configured override for an agent that does carry them fails
    // at the same gate with the override module's own message — a usage
    // refusal (64) since review round 5, contracts-2 finding 2.
    const { stderr: capStderr, exitCode: capCode } = await runCli(
      ["session", "-a", "claude", "--no-sandbox", "--auto", "high"],
      {
        PATH: minimalPath(),
        CODEMUX_CLAUDE_PROVIDER_MAX_OUTPUT_TOKENS: "4096",
      }
    );
    expect(capCode).toBe(64);
    expect(capStderr).toContain(
      "CODEMUX_CLAUDE_PROVIDER_MAX_OUTPUT_TOKENS is set but no provider override is"
    );
    // Codex's knob rides the override's config.toml; set without one it
    // fails loudly, on the session path exactly as on the run path.
    const { stderr: knobStderr, exitCode: knobCode } = await runCli(
      ["session", "-a", "codex", "--no-sandbox", "--auto", "high"],
      { PATH: minimalPath(), CODEMUX_CODEX_PROVIDER_MULTI_AGENT: "off" }
    );
    expect(knobCode).toBe(64);
    expect(knobStderr).toContain(
      "CODEMUX_CODEX_PROVIDER_MULTI_AGENT is set but no provider override is"
    );
    // The STORE knob names a config key no supported codex release has
    // (codemux already sends store: false on every Responses request), so
    // the session path refuses it too — every value, "on" included.
    const { stderr: storeStderr, exitCode: storeCode } = await runCli(
      ["session", "-a", "codex", "--no-sandbox", "--auto", "high"],
      { PATH: minimalPath(), CODEMUX_CODEX_PROVIDER_STORE: "on" }
    );
    expect(storeCode).toBe(64);
    expect(storeStderr).toContain("CODEMUX_CODEX_PROVIDER_STORE is refused");
    // A blank value counts as unset, the override module's own rule.
    const fake = fakeClaudeEnv({ version: "2.1.100" });
    try {
      const { stderr, exitCode } = await runCli(
        ["session", "-a", "claude", "--no-sandbox", "--auto", "high"],
        { ...fake.env, CODEMUX_CLAUDE_PROVIDER_BASE_URL: "  " }
      );
      expect(stderr).not.toContain("does not support a provider override");
      expect(exitCode).toBe(1);
    } finally {
      fake.cleanup();
    }
  });

  test("flag values run's shared validators refuse are usage (64), not exit 1 (review live25)", async () => {
    // Review live25, correctness-2 minor 7: plain errors from --pass-env,
    // effort, autonomy, and --cwd validation fell through to the outer
    // catch's exit 1.
    const fake = fakeClaudeEnv();
    try {
      for (const [extra, expected] of [
        [["--pass-env", ","], "--pass-env requires"],
        [["--effort", "ultra"], "does not support reasoning effort 'ultra'"],
        [["--cwd", "/definitely/not/a/dir"], "cwd is not accessible"],
      ] as const) {
        const { stderr, exitCode } = await runCli(
          ["session", "-a", "claude", "--no-sandbox", "--auto", "high", ...extra],
          fake.env
        );
        expect(exitCode).toBe(64);
        expect(stderr).toContain(expected);
      }
    } finally {
      fake.cleanup();
    }
  });

  test("--effort none is codex's no-effort spelling on sessions too (audit round 2, A2)", async () => {
    // Review live25 made `--effort none` a codex-session refusal because
    // the wire dropped the level silently. The shared rule now resolves
    // `none` to "send no effort flag" on every adapter — codex's effort
    // set no longer lists it — so the session accepts it exactly as run
    // does, and turn/start carries no effort field (the wire's own drop
    // is pinned in tests/session-codex-wire.test.ts).
    const { stderr, exitCode } = await runCli(
      ["session", "-a", "codex", "--no-sandbox", "--auto", "high", "--effort", "none"],
      { PATH: minimalPath() }
    );
    expect(stderr).not.toContain("--effort none is not carried by codex sessions");
    expect(exitCode).not.toBe(64);
  });

  test("--enable-playwright-mcp outside --auto low is refused with 64 (review live25)", async () => {
    // Review live25, correctness-2 major 2: the ceiling grants no mcp__*
    // tool at medium or high (and read-only allows none), so the flag
    // added a server whose every call was denied autonomy_escalation.
    for (const level of ["read-only", "medium", "high"]) {
      const { stderr, exitCode } = await runCli(
        ["session", "-a", "claude", "--sandbox", "--auto", level, "--enable-playwright-mcp"],
        { PATH: minimalPath() }
      );
      expect(exitCode).toBe(64);
      expect(stderr).toContain("--enable-playwright-mcp requires --auto low for sessions");
    }
  });

  test("--enable-playwright-mcp is refused for codex with 64", async () => {
    // The agent check fires before any scode resolution, so no scode
    // stub is needed on PATH.
    const { stderr, exitCode } = await runCli(
      [
        "session", "-a", "codex", "--sandbox", "--auto", "high",
        "--enable-playwright-mcp",
      ],
      { PATH: minimalPath() }
    );
    expect(exitCode).toBe(64);
    expect(stderr).toContain("--enable-playwright-mcp is supported only by claude and zai");
  });

  test("a codex workdir with .codex/config.toml is refused before spawn", async () => {
    // The same project-execution guard run's validateRunRequest applies:
    // repository content must not decide the app-server's MCP servers or
    // providers, sessions no less than runs.
    const fake = fakeCodexEnv();
    const home = mkdtempSync(join(tmpdir(), "codemux-codex-projcfg-"));
    const workdir = join(home, "work");
    mkdirSync(join(workdir, ".codex"), { recursive: true });
    writeFileSync(join(workdir, ".codex", "config.toml"), "[mcp_servers.x]\n");
    try {
      const { stderr, exitCode } = await runCli(
        ["session", "-a", "codex", "--no-sandbox", "--auto", "high", "--cwd", workdir],
        { ...fake.env, HOME: home }
      );
      expect(exitCode).toBe(64);
      expect(stderr).toContain("refuses repository executable configuration");
      expect(stderr).toContain("config.toml");
    } finally {
      fake.cleanup();
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("a registry inside the working directory is refused with 64", async () => {
    // Design §4.8 rule 2, start-time half: the registry the resume
    // guards rest on must not sit inside a directory the child can
    // write. With the home itself as the cwd, the default registry path
    // (sessionRegistryPath: ~/Library/Application Support on macOS,
    // ~/.local/state elsewhere) is inside it.
    const fake = fakeClaudeEnv();
    const home = mkdtempSync(join(tmpdir(), "codemux-session-reginside-"));
    const workdir = join(home, "work");
    mkdirSync(workdir);
    mkdirSync(dirname(sessionRegistryPath(home)), { recursive: true });
    try {
      const { stderr, exitCode } = await runCli(
        ["session", "-a", "claude", "--no-sandbox", "--auto", "high", "--cwd", home],
        { ...fake.env, HOME: home }
      );
      expect(exitCode).toBe(64);
      expect(stderr).toContain("sits inside the working directory");
    } finally {
      fake.cleanup();
      rmSync(home, { recursive: true, force: true });
    }
  });
});

