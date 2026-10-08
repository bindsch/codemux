/**
 * CLI-level session tests (design §4.5, §4.6): the exit-code surface and
 * one deterministic happy path through `codemux session`, with a fake
 * claude on PATH standing in for the harness. The driver's stream
 * behavior is covered by tests/session-e2e.test.ts; here what is under
 * test is the commander wiring: refusals before anything spawns, the
 * session-only floor, and the argv the harness actually receives.
 */

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createFakeBinaryEnv, minimalPath, runCli } from "./helpers/cli.js";
import { readRegistry, sessionRegistryPath } from "../src/session/registry.js";
import { claudeFamilyHarnessHome, frameCallerStdin } from "../src/session/cli.js";
import { MAX_INPUT_LINE_BYTES } from "../src/session/process.js";

const FAKE = fileURLToPath(new URL("./fixtures/live/fake-claude-session.ts", import.meta.url));
const FAKE_CODEX = fileURLToPath(new URL("./fixtures/live/fake-codex-app-server.ts", import.meta.url));
const FAKE_AGY = fileURLToPath(new URL("./fixtures/live/fake-agy-session.ts", import.meta.url));

/** The fake harness binary env: the named binary execs the
 * scenario-driven fake. A pinned `version` is answered by the wrapper
 * itself — the version probe's environment is allowlisted, so a
 * FAKE_VERSION variable would never reach it. */
function fakeHarnessEnv(
  binary: "claude" | "codex" | "agy" | "opencode" | "aider",
  script: string,
  extra: { version?: string; env?: Record<string, string> } = {}
): {
  env: Record<string, string>;
  stateDir: string;
  cleanup: () => void;
} {
  const preamble =
    extra.version === undefined
      ? ""
      : `if [ "$1" = "--version" ]; then printf '${extra.version}\\n'; exit 0; fi\n`;
  const fake = createFakeBinaryEnv({
    [binary]: `${preamble}exec bun '${script}' "$@"`,
  });
  const stateDir = mkdtempSync(join(tmpdir(), "session-cli-state-"));
  return {
    env: { ...fake.env, FAKE_STATE_DIR: stateDir, ...(extra.env ?? {}) },
    stateDir,
    cleanup: () => {
      fake.cleanup();
      rmSync(stateDir, { recursive: true, force: true });
    },
  };
}

function fakeClaudeEnv(extra: { version?: string; env?: Record<string, string> } = {}) {
  return fakeHarnessEnv("claude", FAKE, extra);
}

function fakeCodexEnv(extra: { version?: string; env?: Record<string, string> } = {}) {
  return fakeHarnessEnv("codex", FAKE_CODEX, extra);
}

function fakeAgyEnv(extra: { version?: string; env?: Record<string, string> } = {}) {
  return fakeHarnessEnv("agy", FAKE_AGY, extra);
}

describe("CLI - session refusals", () => {
  test("sessions for an agent whose driver has not landed refuse with 64", async () => {
    const { stderr, exitCode } = await runCli(
      ["session", "-a", "gemini"],
      { PATH: minimalPath() }
    );
    expect(exitCode).toBe(64);
    expect(stderr).toContain("not implemented for 'gemini'");
  });

  test("--hermetic is refused for sessions with 64", async () => {
    const { stderr, exitCode } = await runCli(
      ["session", "-a", "claude", "--hermetic"],
      { PATH: minimalPath() }
    );
    expect(exitCode).toBe(64);
    expect(stderr).toContain("--hermetic is refused for sessions");
  });

  test("--sandbox-trust untrusted is refused for sessions with 64", async () => {
    const { stderr, exitCode } = await runCli(
      ["session", "-a", "claude", "--sandbox-trust", "untrusted"],
      { PATH: minimalPath() }
    );
    expect(exitCode).toBe(64);
    expect(stderr).toContain("untrusted");
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
    // the uniform validateRunRequest gate — verbatim, exit 1 exactly as
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
      expect(exitCode).toBe(1);
      expect(stderr).toContain(
        `${agent} does not support a provider override; unset CODEMUX_${agent.toUpperCase()}_PROVIDER_* to run it, or route through an agent that does (codemux list marks them "provider")`
      );
    }
    // A half-configured override for an agent that does carry them fails
    // at the same gate with the override module's own message.
    const { stderr: capStderr, exitCode: capCode } = await runCli(
      ["session", "-a", "claude", "--no-sandbox", "--auto", "high"],
      {
        PATH: minimalPath(),
        CODEMUX_CLAUDE_PROVIDER_MAX_OUTPUT_TOKENS: "4096",
      }
    );
    expect(capCode).toBe(1);
    expect(capStderr).toContain(
      "CODEMUX_CLAUDE_PROVIDER_MAX_OUTPUT_TOKENS is set but no provider override is"
    );
    // Codex's knob rides the override's config.toml; set without one it
    // fails loudly, on the session path exactly as on the run path.
    const { stderr: knobStderr, exitCode: knobCode } = await runCli(
      ["session", "-a", "codex", "--no-sandbox", "--auto", "high"],
      { PATH: minimalPath(), CODEMUX_CODEX_PROVIDER_MULTI_AGENT: "off" }
    );
    expect(knobCode).toBe(1);
    expect(knobStderr).toContain(
      "CODEMUX_CODEX_PROVIDER_MULTI_AGENT is set but no provider override is"
    );
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

  test("--effort none is refused for codex sessions instead of silently dropped (review live25)", async () => {
    // Review live25, correctness-2 minor 8: codex lists `none`, the CLI
    // accepted it, and turn/start then omitted it, so the model's default
    // reasoning applied with no word to the caller.
    const { stderr, exitCode } = await runCli(
      ["session", "-a", "codex", "--no-sandbox", "--auto", "high", "--effort", "none"],
      { PATH: minimalPath() }
    );
    expect(exitCode).toBe(64);
    expect(stderr).toContain("--effort none is not carried by codex sessions");
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
      expect(exitCode).toBe(1);
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

describe("CLI - session happy path", () => {
  test("drives one turn over stdio and ends cleanly on shutdown", async () => {
    const fake = fakeClaudeEnv();
    const isolatedHome = mkdtempSync(join(tmpdir(), "codemux-session-home-"));
    const workdir = join(isolatedHome, "work");
    mkdirSync(workdir);
    try {
      const proc = Bun.spawn(
        [
          join(import.meta.dir, "..", "bin", "codemux"),
          "session", "-a", "claude", "--no-sandbox", "--auto", "high",
          "--cwd", workdir, "--shutdown-grace", "2",
          // The launch environment is allowlisted; the fake's state
          // variables reach the harness only through the sanctioned
          // passthrough, which is exactly the seam under test here.
          "--pass-env", "FAKE_STATE_DIR,FAKE_CWD",
        ],
        {
          cwd: join(import.meta.dir, ".."),
          stdout: "pipe",
          stderr: "pipe",
          stdin: "pipe",
          env: {
            ...process.env,
            CODEMUX_NO_KEYCHAIN_SYNC: "1",
            HOME: isolatedHome,
            XDG_CONFIG_HOME: join(isolatedHome, ".config"),
            ...fake.env,
            FAKE_CWD: workdir,
          } as Record<string, string>,
        }
      );
      const events: Record<string, any>[] = [];
      const stdoutDone = (async () => {
        const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let newline = buffer.indexOf("\n");
          while (newline !== -1) {
            const line = buffer.slice(0, newline);
            buffer = buffer.slice(newline + 1);
            if (line.trim() !== "") events.push(JSON.parse(line) as Record<string, any>);
            newline = buffer.indexOf("\n");
          }
        }
      })();
      const waitFor = async (label: string, pred: (event: Record<string, any>) => boolean) => {
        const deadline = Date.now() + 15_000;
        for (;;) {
          const found = events.find(pred);
          if (found !== undefined) return found;
          if (Date.now() > deadline) {
            throw new Error(
              `timed out waiting for ${label}; saw: ${events.map((event) => event.type).join(",")}`
            );
          }
          await Bun.sleep(10);
        }
      };

      // The fake emits system/init per turn and nothing at spawn, so the
      // first user line is what produces session_started: send it before
      // waiting (the CLI relays stdin the moment the harness spawns, and
      // the driver must open the turn at the init frame).
      const stdin = proc.stdin;
      stdin.write(`${JSON.stringify({ type: "user", text: "scenario:basic hello" })}\n`);
      const started = await waitFor("session_started", (event) => event.type === "session_started");
      expect(started.agent).toBe("claude");
      expect(started.autonomy).toBe("high");
      expect(started.protocol).toBe("codemux-live-session/1");
      expect(typeof started.session_id).toBe("string");

      const echo = await waitFor("user_message", (event) => event.type === "user_message");
      expect(echo.text).toBe("scenario:basic hello");
      const completed = await waitFor("turn_completed", (event) => event.type === "turn_completed");
      expect(completed.finish).toBe("end");

      stdin.write(`${JSON.stringify({ type: "shutdown" })}\n`);
      const [exitCode] = await Promise.all([proc.exited, stdoutDone]);
      const ended = events[events.length - 1] as Record<string, any> | undefined;
      expect(ended?.type).toBe("session_ended");
      expect(ended?.reason).toBe("shutdown");
      expect(ended?.resumable).toBe(true);
      expect(exitCode).toBe(0);

      // The harness saw the real session argv (§4.7): the carrier, the
      // codemux session id, and high's grants — spawned directly, no scode.
      const argv = (readFileSync(join(fake.stateDir, "argv.jsonl"), "utf8")
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => JSON.parse(line) as { args: string[] }))
        .find((entry) => !entry.args.includes("--version"));
      expect(argv).toBeDefined();
      if (argv !== undefined) {
        expect(argv.args).toContain("-p");
        expect(argv.args).toContain("--permission-prompt-tool");
        expect(argv.args[argv.args.indexOf("--permission-prompt-tool") + 1]).toBe("stdio");
        expect(argv.args).toContain("--allowedTools");
        expect(argv.args.join(" ")).not.toContain("dangerously");
        const idAt = argv.args.indexOf("--session-id");
        expect(idAt).not.toBe(-1);
        expect(argv.args[idAt + 1]).toBe(started.session_id);
      }
    } finally {
      fake.cleanup();
      rmSync(isolatedHome, { recursive: true, force: true });
    }
  });

  test("codex: drives one turn over the app-server protocol and ends cleanly", async () => {
    const fake = fakeCodexEnv({ version: "codex-cli 0.159.3" });
    const isolatedHome = mkdtempSync(join(tmpdir(), "codemux-session-home-"));
    const workdir = join(isolatedHome, "work");
    mkdirSync(workdir);
    try {
      const proc = Bun.spawn(
        [
          join(import.meta.dir, "..", "bin", "codemux"),
          "session", "-a", "codex", "--no-sandbox", "--auto", "high",
          "--cwd", workdir, "--shutdown-grace", "2",
          "--pass-env", "FAKE_STATE_DIR,FAKE_CWD",
        ],
        {
          cwd: join(import.meta.dir, ".."),
          stdout: "pipe",
          stderr: "pipe",
          stdin: "pipe",
          env: {
            ...process.env,
            CODEMUX_NO_KEYCHAIN_SYNC: "1",
            HOME: isolatedHome,
            XDG_CONFIG_HOME: join(isolatedHome, ".config"),
            ...fake.env,
            FAKE_CWD: workdir,
          } as Record<string, string>,
        }
      );
      const events: Record<string, any>[] = [];
      const stdoutDone = (async () => {
        const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let newline = buffer.indexOf("\n");
          while (newline !== -1) {
            const line = buffer.slice(0, newline);
            buffer = buffer.slice(newline + 1);
            if (line.trim() !== "") events.push(JSON.parse(line) as Record<string, any>);
            newline = buffer.indexOf("\n");
          }
        }
      })();
      const waitFor = async (label: string, pred: (event: Record<string, any>) => boolean) => {
        const deadline = Date.now() + 15_000;
        for (;;) {
          const found = events.find(pred);
          if (found !== undefined) return found;
          if (Date.now() > deadline) {
            throw new Error(
              `timed out waiting for ${label}; saw: ${events.map((event) => event.type).join(",")}`
            );
          }
          await Bun.sleep(10);
        }
      };

      const started = await waitFor("session_started", (event) => event.type === "session_started");
      expect(started.agent).toBe("codex");
      expect(started.session_id).toBe("0123456789abcdef");
      expect(started.capabilities.user_during_turn).toBe("queue");
      expect(started.capabilities.file_changes).toBe("native");

      const stdin = proc.stdin;
      stdin.write(`${JSON.stringify({ type: "user", text: "scenario:basic hello" })}\n`);
      const echo = await waitFor("user_message", (event) => event.type === "user_message");
      expect(echo.text).toBe("scenario:basic hello");
      expect(echo.turn_id).toBe("t1");
      const completed = await waitFor("turn_completed", (event) => event.type === "turn_completed");
      expect(completed.finish).toBe("end");

      stdin.write(`${JSON.stringify({ type: "shutdown" })}\n`);
      const [exitCode] = await Promise.all([proc.exited, stdoutDone]);
      const ended = events[events.length - 1] as Record<string, any> | undefined;
      expect(ended?.type).toBe("session_ended");
      expect(ended?.reason).toBe("shutdown");
      expect(ended?.resumable).toBe(true);
      expect(exitCode).toBe(0);

      // The harness spawn is exactly `codex app-server` (§4.7): one
      // dedicated app-server per session, everything else on JSON-RPC.
      const argv = (readFileSync(join(fake.stateDir, "argv.jsonl"), "utf8")
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => JSON.parse(line) as { args: string[] }))
        .find((entry) => !entry.args.includes("--version"));
      expect(argv).toBeDefined();
      expect(argv?.args).toEqual(["app-server"]);
    } finally {
      fake.cleanup();
      rmSync(isolatedHome, { recursive: true, force: true });
    }
  });
});

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

  test("the provider identity records the base URL without its query, and a rotated key still resumes (review D10, security)", async () => {
    // A gateway key can ride the override's base URL query (`?key=…`).
    // The raw value used to reach the registry verbatim and came back in
    // every resume-refusal message, so the secret sat on disk (0600, but
    // on disk) and in logs. The record, the comparison, and the refusal
    // surface all carry the identity form now — query and fragment
    // stripped — so a key rotation between the session and its resume
    // still matches while a different endpoint still refuses, and the
    // refusal names only the identities.
    const fake = fakeClaudeEnv();
    const isolatedHome = mkdtempSync(join(tmpdir(), "codemux-session-identity-"));
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
          ...overrideAt("http://127.0.0.1:9/v1?key=e2e-secret"),
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
      // The record carries the identity, and the raw registry file — the
      // thing that lands on disk — never holds the query key.
      const registryPath = sessionRegistryPath(isolatedHome);
      const registry = readRegistry(registryPath);
      expect(registry.outcome).toBe("ok");
      const entry =
        registry.outcome === "ok"
          ? registry.file.sessions.find((r) => r.id === sessionId)
          : undefined;
      expect(entry?.provider_base_url).toBe("http://127.0.0.1:9/v1");
      expect(readFileSync(registryPath, "utf8")).not.toContain("e2e-secret");

      // The same endpoint under a rotated key resumes — a full turn, not
      // just the guards: the comparison runs on the identity form, so the
      // query cannot split what the identity joins.
      const rotatedSession = await driveSession(
        [
          "session", "-a", "claude", "--no-sandbox", "--auto", "high",
          "--cwd", workdir, "--shutdown-grace", "2",
          "--resume", sessionId,
          "--pass-env", "FAKE_STATE_DIR,FAKE_CWD",
        ],
        {
          HOME: isolatedHome,
          XDG_CONFIG_HOME: join(isolatedHome, ".config"),
          FAKE_STATE_DIR: fake.stateDir,
          FAKE_CWD: workdir,
          ...fake.env,
          ...overrideAt("http://127.0.0.1:9/v1?key=rotated-other"),
        }
      );
      try {
        rotatedSession.send({ type: "user", text: "scenario:basic again" });
        const started = await rotatedSession.waitFor(
          "session_started",
          (event) => event.type === "session_started"
        );
        expect(started.session_id).toBe(sessionId);
        await rotatedSession.waitFor(
          "turn_completed",
          (event) => event.type === "turn_completed"
        );
        rotatedSession.send({ type: "shutdown" });
        const [exitCode] = await rotatedSession.exit;
        expect(exitCode).toBe(0);
      } finally {
        await rotatedSession.proc.kill();
      }

      // A different endpoint still refuses, naming the two identities —
      // and neither side of the message carries the query key.
      const other = await runCli(
        [
          "session", "-a", "claude", "--no-sandbox", "--auto", "high",
          "--cwd", workdir, "--resume", sessionId,
        ],
        {
          ...fake.env,
          HOME: isolatedHome,
          XDG_CONFIG_HOME: join(isolatedHome, ".config"),
          ...overrideAt("http://127.0.0.1:10/v1?key=attacker-key"),
        }
      );
      expect(other.exitCode).toBe(78);
      expect(other.stderr).toContain("created against the provider override at http://127.0.0.1:9/v1");
      expect(other.stderr).toContain("cannot resume against the provider override at http://127.0.0.1:10/v1");
      expect(other.stderr).not.toContain("e2e-secret");
      expect(other.stderr).not.toContain("attacker-key");
    } finally {
      fake.cleanup();
      rmSync(isolatedHome, { recursive: true, force: true });
    }
  }, 30_000);

  test("a zai session without an API key refuses before spawn", async () => {
    const fake = fakeClaudeEnv();
    const home = mkdtempSync(join(tmpdir(), "codemux-zai-nokey-"));
    try {
      const { stderr, exitCode } = await runCli(
        ["session", "-a", "zai", "--no-sandbox", "--auto", "high"],
        { ...fake.env, HOME: home, ZAI_API_KEY: "" }
      );
      expect(exitCode).toBe(1);
      expect(stderr).toContain("Z.AI API key not found.");
      expect(stderr).not.toContain("at getZaiApiKey");
    } finally {
      fake.cleanup();
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("a zai session runs the claude binary against the Z.AI endpoint", async () => {
    const fake = fakeClaudeEnv();
    const isolatedHome = mkdtempSync(join(tmpdir(), "codemux-session-home-"));
    const workdir = join(isolatedHome, "work");
    mkdirSync(workdir);
    try {
      const proc = Bun.spawn(
        [
          join(import.meta.dir, "..", "bin", "codemux"),
          "session", "-a", "zai", "--no-sandbox", "--auto", "high",
          "--cwd", workdir, "--shutdown-grace", "2",
          "--pass-env", "FAKE_STATE_DIR,FAKE_CWD",
        ],
        {
          cwd: join(import.meta.dir, ".."),
          stdout: "pipe",
          stderr: "pipe",
          stdin: "pipe",
          env: {
            ...process.env,
            CODEMUX_NO_KEYCHAIN_SYNC: "1",
            HOME: isolatedHome,
            XDG_CONFIG_HOME: join(isolatedHome, ".config"),
            ZAI_API_KEY: "zai-test-key",
            ...fake.env,
            FAKE_CWD: workdir,
          } as Record<string, string>,
        }
      );
      const events: Record<string, any>[] = [];
      const stdoutDone = (async () => {
        const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let newline = buffer.indexOf("\n");
          while (newline !== -1) {
            const line = buffer.slice(0, newline);
            buffer = buffer.slice(newline + 1);
            if (line.trim() !== "") events.push(JSON.parse(line) as Record<string, any>);
            newline = buffer.indexOf("\n");
          }
        }
      })();
      const waitFor = async (label: string, pred: (event: Record<string, any>) => boolean) => {
        const deadline = Date.now() + 15_000;
        for (;;) {
          const found = events.find(pred);
          if (found !== undefined) return found;
          if (Date.now() > deadline) {
            throw new Error(
              `timed out waiting for ${label}; saw: ${events.map((event) => event.type).join(",")}`
            );
          }
          await Bun.sleep(10);
        }
      };

      // Same shape as the claude happy path: the per-turn init means the
      // first user line is what produces session_started.
      const stdin = proc.stdin;
      stdin.write(`${JSON.stringify({ type: "user", text: "scenario:basic hello" })}\n`);
      const started = await waitFor("session_started", (event) => event.type === "session_started");
      expect(started.agent).toBe("zai");
      expect(started.autonomy).toBe("high");

      const completed = await waitFor("turn_completed", (event) => event.type === "turn_completed");
      expect(completed.finish).toBe("end");

      stdin.write(`${JSON.stringify({ type: "shutdown" })}\n`);
      const [exitCode] = await Promise.all([proc.exited, stdoutDone]);
      const ended = events[events.length - 1] as Record<string, any> | undefined;
      expect(ended?.type).toBe("session_ended");
      expect(ended?.reason).toBe("shutdown");
      expect(exitCode).toBe(0);

      // The Z.AI identity rode the adapter's env, not the argv: the fake
      // saw the endpoint and the token, and never the raw key.
      const env = (readFileSync(join(fake.stateDir, "env.jsonl"), "utf8")
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => JSON.parse(line) as Record<string, any>))
        .find(() => true);
      expect(env?.anthropic_base_url).toBe("https://api.z.ai/api/anthropic");
      expect(env?.anthropic_auth_token).toBe(true);
      expect(env?.zai_api_key_present).toBe(false);

      // The registry entry names zai against the shared claude home —
      // the store is one, the identity is not (§4.8).
      const read = readRegistry(
        sessionRegistryPath(isolatedHome)
      );
      expect(read.outcome).toBe("ok");
      const entry =
        read.outcome === "ok"
          ? read.file.sessions.find((r) => r.id === started.session_id)
          : undefined;
      expect(entry?.agent).toBe("zai");
      expect(entry?.harness_home).toBe(join(isolatedHome, ".claude"));
    } finally {
      fake.cleanup();
      rmSync(isolatedHome, { recursive: true, force: true });
    }
  });
});

describe("CLI - agy sessions", () => {
  test("an agy harness below the session floor is refused before spawn", async () => {
    const fake = fakeAgyEnv({ version: "1.2.13" });
    try {
      const { stderr, exitCode } = await runCli(
        ["session", "-a", "agy", "--no-sandbox", "--auto", "high"],
        fake.env
      );
      expect(exitCode).toBe(1);
      expect(stderr).toContain("1.2.14");
    } finally {
      fake.cleanup();
    }
  });

  test("--turn-timeout is refused: agy sessions cannot interrupt a turn", async () => {
    const fake = fakeAgyEnv();
    try {
      const { stderr, exitCode } = await runCli(
        [
          "session", "-a", "agy", "--no-sandbox", "--auto", "high",
          "--turn-timeout", "30",
        ],
        fake.env
      );
      expect(exitCode).toBe(64);
      expect(stderr).toContain("--turn-timeout requires an agent whose sessions support interrupt");
    } finally {
      fake.cleanup();
    }
  });

  test("a --resume id that is not an agy conversation id refuses with 64", async () => {
    const fake = fakeAgyEnv();
    try {
      const { stderr, exitCode } = await runCli(
        [
          "session", "-a", "agy", "--no-sandbox", "--auto", "high",
          "--resume", "bad id",
        ],
        fake.env
      );
      expect(exitCode).toBe(64);
      expect(stderr).toContain("agy conversation id");
    } finally {
      fake.cleanup();
    }
  });

  test("an agy executable project config is refused before spawn", async () => {
    const fake = fakeAgyEnv();
    const home = mkdtempSync(join(tmpdir(), "codemux-agy-projcfg-"));
    const workdir = join(home, "work");
    mkdirSync(join(workdir, ".agents"), { recursive: true });
    writeFileSync(join(workdir, ".agents", "skills.json"), "{}\n");
    try {
      const { stderr, exitCode } = await runCli(
        ["session", "-a", "agy", "--no-sandbox", "--auto", "high", "--cwd", workdir],
        { ...fake.env, HOME: home }
      );
      expect(exitCode).toBe(1);
      expect(stderr).toContain("refuses repository executable configuration");
      expect(stderr).toContain("skills.json");
    } finally {
      fake.cleanup();
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("drives one turn over the NDJSON loop and records the conversation", async () => {
    const fake = fakeAgyEnv();
    const isolatedHome = mkdtempSync(join(tmpdir(), "codemux-session-home-"));
    const workdir = join(isolatedHome, "work");
    mkdirSync(workdir);
    try {
      const proc = Bun.spawn(
        [
          join(import.meta.dir, "..", "bin", "codemux"),
          "session", "-a", "agy", "--no-sandbox", "--auto", "high",
          "--cwd", workdir, "--shutdown-grace", "2",
          "--pass-env", "FAKE_STATE_DIR,FAKE_CWD",
        ],
        {
          cwd: join(import.meta.dir, ".."),
          stdout: "pipe",
          stderr: "pipe",
          stdin: "pipe",
          env: {
            ...process.env,
            CODEMUX_NO_KEYCHAIN_SYNC: "1",
            HOME: isolatedHome,
            XDG_CONFIG_HOME: join(isolatedHome, ".config"),
            ...fake.env,
            FAKE_CWD: workdir,
          } as Record<string, string>,
        }
      );
      const events: Record<string, any>[] = [];
      const stdoutDone = (async () => {
        const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let newline = buffer.indexOf("\n");
          while (newline !== -1) {
            const line = buffer.slice(0, newline);
            buffer = buffer.slice(newline + 1);
            if (line.trim() !== "") events.push(JSON.parse(line) as Record<string, any>);
            newline = buffer.indexOf("\n");
          }
        }
      })();
      const waitFor = async (label: string, pred: (event: Record<string, any>) => boolean) => {
        const deadline = Date.now() + 15_000;
        for (;;) {
          const found = events.find(pred);
          if (found !== undefined) return found;
          if (Date.now() > deadline) {
            throw new Error(
              `timed out waiting for ${label}; saw: ${events.map((event) => event.type).join(",")}`
            );
          }
          await Bun.sleep(10);
        }
      };

      // The identity is deferred: send the first turn before waiting for
      // session_started, because the first result is what names the
      // conversation (§4.7's agy model).
      const stdin = proc.stdin;
      stdin.write(`${JSON.stringify({ type: "user", text: "scenario:basic hello" })}\n`);

      const started = await waitFor("session_started", (event) => event.type === "session_started");
      expect(started.agent).toBe("agy");
      expect(started.session_id).toBe("conv-fake-1");
      expect(started.capabilities.user_during_turn).toBe(false);
      expect(started.capabilities.interrupt).toBe(false);
      expect(started.capabilities.resume).toBe(true);

      const echo = await waitFor("user_message", (event) => event.type === "user_message");
      expect(echo.text).toBe("scenario:basic hello");
      expect(echo.session_id).toBe("");
      const completed = await waitFor("turn_completed", (event) => event.type === "turn_completed");
      expect(completed.finish).toBe("end");

      stdin.write(`${JSON.stringify({ type: "shutdown" })}\n`);
      const [exitCode] = await Promise.all([proc.exited, stdoutDone]);
      const ended = events[events.length - 1] as Record<string, any> | undefined;
      expect(ended?.type).toBe("session_ended");
      expect(ended?.reason).toBe("shutdown");
      expect(ended?.resumable).toBe(true);
      expect(exitCode).toBe(0);

      // The harness saw the NDJSON loop argv exactly (§4.7): the io
      // pair, slash commands off, and high's bypass — spawned directly,
      // no scode.
      const argv = (readFileSync(join(fake.stateDir, "argv.jsonl"), "utf8")
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => JSON.parse(line) as { args: string[] }))
        .find((entry) => !entry.args.includes("--version"));
      expect(argv).toBeDefined();
      // The wrapper execs the fake with the session args, so the binary
      // name itself is not among them — same convention as the codex
      // test's ["app-server"].
      expect(argv?.args).toEqual([
        "--disable-slash-commands",
        "--input-format=stream-json",
        "--output-format=stream-json",
        "--dangerously-skip-permissions",
      ]);

      // The registry entry names agy under the antigravity home (§4.8).
      const read = readRegistry(
        sessionRegistryPath(isolatedHome)
      );
      expect(read.outcome).toBe("ok");
      const entry =
        read.outcome === "ok"
          ? read.file.sessions.find((r) => r.id === "conv-fake-1")
          : undefined;
      expect(entry?.agent).toBe("agy");
      expect(entry?.harness_home).toBe(join(isolatedHome, ".gemini", "antigravity-cli"));
    } finally {
      fake.cleanup();
      rmSync(isolatedHome, { recursive: true, force: true });
    }
  });
});

describe("claudeFamilyHarnessHome", () => {
  test("CLAUDE_CONFIG_DIR is honored only when it is passed through", () => {
    // The recorded home must be the child's actual home: without the
    // passthrough the execution environment strips the variable, so an
    // honored redirect would record a home the child never ran against —
    // a lie the resume guards would then judge against.
    const original = process.env.CLAUDE_CONFIG_DIR;
    const redirect = mkdtempSync(join(tmpdir(), "codemux-claude-redirect-"));
    process.env.CLAUDE_CONFIG_DIR = redirect;
    try {
      expect(claudeFamilyHarnessHome(["OTHER_VAR"])).toBe(join(homedir(), ".claude"));
      expect(claudeFamilyHarnessHome(["CLAUDE_CONFIG_DIR"])).toBe(redirect);
    } finally {
      if (original === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = original;
      rmSync(redirect, { recursive: true, force: true });
    }
  });
});

describe("CLI - registry path seam", () => {
  test("no test spells the default registry layout by hand", () => {
    // Linux CI fix (0.9.0): seven tests seeded the registry under
    // `Library/Application Support` while the CLI, on Linux, reads
    // `~/.local/state` — so a seeded entry read as missing (66, not 78).
    // Every test must take the default path from sessionRegistryPath,
    // the seam the CLI itself uses.
    const testsDir = dirname(fileURLToPath(import.meta.url));
    const handSpelled = /["']Application Support["'],\s*["']codemux["']|["']\.local["'],\s*["']state["'],\s*["']codemux["']/;
    const offenders = readdirSync(testsDir)
      .filter((name) => name.endsWith(".test.ts"))
      .filter((name) => handSpelled.test(readFileSync(join(testsDir, name), "utf8")));
    expect(offenders).toEqual([]);
  });
});

describe("CLI - session resume guards", () => {
  test("a registry inside the entry's own working directory refuses with 78, not 66", async () => {
    // §4.8's containment rule is a policy refusal (the registry is a
    // file the child could have altered), so it shares `refused`'s exit
    // code — the review caught it reporting 66, the missing-entry code.
    // Review live23: the resume runs in the recorded cwd, so the
    // containment guard itself refuses. The test used to resume in
    // another cwd and passed through the cwd-mismatch guard, while the
    // start-time check (exit 64) made the containment guard unreachable.
    const fake = fakeClaudeEnv();
    const home = realpathSync(mkdtempSync(join(tmpdir(), "codemux-resume-inside-")));
    try {
      const dir = dirname(sessionRegistryPath(home));
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      writeFileSync(
        sessionRegistryPath(home),
        `${JSON.stringify({
          version: 1,
          sessions: [
            {
              id: "11111111-2222-3333-4444-555555555555",
              agent: "claude",
              created_at: "2026-10-04T10:00:00.000Z",
              last_activity: "2026-10-04T10:05:00.000Z",
              // The registry file sits inside this cwd (under the home),
              // which is exactly the untrusted placement.
              cwd: home,
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
      const { stderr, exitCode } = await runCli(
        [
          "session", "-a", "claude", "--no-sandbox", "--auto", "high",
          "--cwd", home,
          "--resume", "11111111-2222-3333-4444-555555555555",
        ],
        { ...fake.env, HOME: home }
      );
      expect(exitCode).toBe(78);
      expect(stderr).toContain("cannot resume");
      expect(stderr).toContain("the registry sits inside the session's own cwd");
    } finally {
      fake.cleanup();
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("a corrupt registry's resume refusal names the registry path", async () => {
    // §4.8's failure policy ("error names the path"): an operator told
    // the registry is unreadable or corrupt needs the file's path to fix
    // it. Review live6, finding 5 — the message used to name only the id
    // and the reason, never the file.
    const fake = fakeClaudeEnv();
    const home = mkdtempSync(join(tmpdir(), "codemux-resume-corrupt-"));
    const workdir = join(home, "elsewhere");
    mkdirSync(workdir);
    try {
      const dir = dirname(sessionRegistryPath(home));
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const registryPath = sessionRegistryPath(home);
      writeFileSync(registryPath, "{corrupt", { mode: 0o600 });
      const { stderr, exitCode } = await runCli(
        [
          "session", "-a", "claude", "--no-sandbox", "--auto", "high",
          "--cwd", workdir,
          "--resume", "11111111-2222-3333-4444-555555555555",
        ],
        { ...fake.env, HOME: home }
      );
      expect(exitCode).toBe(78);
      expect(stderr).toContain("cannot resume");
      expect(stderr).toContain("not valid JSON");
      expect(stderr).toContain(registryPath);
    } finally {
      fake.cleanup();
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("a session created with --sandbox-no-net refuses a resume that drops it, argv or not", async () => {
    // Review live4, security: the guard must judge the containment the
    // resume EFFECTIVELY runs at. `--sandbox-no-net` without --sandbox is
    // a warned-and-ignored argv bit (parseSandboxPolicyOverrides), so a
    // resume passing the raw flag unsandboxed must still refuse — the
    // probe reading the resolved options, not the raw command line, is
    // exactly what this pins.
    const fake = fakeClaudeEnv();
    const home = mkdtempSync(join(tmpdir(), "codemux-resume-nonnet-"));
    const workdir = join(home, "elsewhere");
    mkdirSync(workdir);
    try {
      const dir = dirname(sessionRegistryPath(home));
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      writeFileSync(
        sessionRegistryPath(home),
        `${JSON.stringify({
          version: 1,
          sessions: [
            {
              id: "11111111-2222-3333-4444-555555555555",
              agent: "claude",
              created_at: "2026-10-04T10:00:00.000Z",
              last_activity: "2026-10-04T10:05:00.000Z",
              cwd: workdir,
              hermetic: false,
              harness_home: join(home, ".claude"),
              model: null,
              autonomy: "high",
              sandboxed: false,
              sandbox_trust: "standard",
              sandbox_no_net: true,
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
      const args = [
        "session", "-a", "claude", "--no-sandbox", "--auto", "high",
        "--cwd", workdir,
        "--resume", "11111111-2222-3333-4444-555555555555",
      ];
      const plain = await runCli(args, { ...fake.env, HOME: home });
      expect(plain.exitCode).toBe(78);
      expect(plain.stderr).toContain("--sandbox-no-net");
      // The raw flag without --sandbox changes nothing: the resume does
      // not run with a network boundary, so it still refuses.
      const flagged = await runCli([...args, "--sandbox-no-net"], { ...fake.env, HOME: home });
      expect(flagged.exitCode).toBe(78);
      expect(flagged.stderr).toContain("--sandbox-no-net");
    } finally {
      fake.cleanup();
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("CLI - resume reach (review live16)", () => {
  test("a resume in another --cwd or with an added --pass-env name is refused with 78", async () => {
    // Review live16, security: the finding's trigger — create in one
    // tree, resume with `--cwd ~/repo` — passed every guard, and so did
    // adding `--pass-env GITHUB_TOKEN` to a session created without it.
    const fake = fakeClaudeEnv();
    const home = realpathSync(mkdtempSync(join(tmpdir(), "codemux-resume-reach-")));
    const created = join(home, "created");
    const other = join(home, "other");
    mkdirSync(created);
    mkdirSync(other);
    try {
      const dir = dirname(sessionRegistryPath(home));
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      writeFileSync(
        sessionRegistryPath(home),
        `${JSON.stringify({
          version: 1,
          sessions: [
            {
              id: "11111111-2222-3333-4444-555555555555",
              agent: "claude",
              created_at: "2026-10-04T10:00:00.000Z",
              last_activity: "2026-10-04T10:05:00.000Z",
              cwd: created,
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
      const base = [
        "session", "-a", "claude", "--no-sandbox", "--auto", "high",
        "--resume", "11111111-2222-3333-4444-555555555555",
      ];
      const env = { ...fake.env, HOME: home, GITHUB_TOKEN: "not-a-real-token" };
      const moved = await runCli([...base, "--cwd", other], env);
      expect(moved.exitCode).toBe(78);
      expect(moved.stderr).toContain(`cannot resume in ${other}`);
      const secret = await runCli([...base, "--cwd", created, "--pass-env", "GITHUB_TOKEN"], env);
      expect(secret.exitCode).toBe(78);
      expect(secret.stderr).toContain("--pass-env GITHUB_TOKEN");
    } finally {
      fake.cleanup();
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("CLI - concurrent resume (review live19)", () => {
  test("a second resume of a claimed id is refused before it spawns a harness", async () => {
    // The claude family records ownership at the init frame, which the
    // harness sends only after the caller's first input. Two resumes of
    // one id both passed the lock-free lookup, both spawned, and both
    // forwarded input; the loser was refused only after its harness had
    // acted on it. The claim now runs before the spawn: while the first
    // resume sits idle (no input, so no init), the second exits 78
    // session_busy and its harness never starts.
    const fake = fakeClaudeEnv();
    const home = realpathSync(mkdtempSync(join(tmpdir(), "codemux-resume-race-")));
    const workdir = join(home, "work");
    mkdirSync(workdir);
    const id = "11111111-2222-3333-4444-555555555555";
    const registryPath = sessionRegistryPath(home);
    let first: ReturnType<typeof Bun.spawn> | null = null;
    try {
      mkdirSync(dirname(registryPath), { recursive: true, mode: 0o700 });
      writeFileSync(
        registryPath,
        `${JSON.stringify({
          version: 1,
          sessions: [
            {
              id,
              agent: "claude",
              created_at: "2026-10-04T10:00:00.000Z",
              last_activity: "2026-10-04T10:05:00.000Z",
              cwd: workdir,
              hermetic: false,
              harness_home: join(home, ".claude"),
              model: null,
              autonomy: "high",
              sandboxed: false,
              sandbox_trust: "standard",
              sandbox_no_net: false,
              sandbox_scrub_env: false,
              pass_env: ["FAKE_CWD", "FAKE_STATE_DIR"],
              playwright_mcp: false,
              owner_pid: 999999,
              owner_start: null,
              ended: "2026-10-04T10:05:00.000Z",
            },
          ],
        })}\n`,
        { mode: 0o600 }
      );
      const args = [
        "session", "-a", "claude", "--no-sandbox", "--auto", "high",
        "--cwd", workdir, "--resume", id, "--shutdown-grace", "2",
        "--pass-env", "FAKE_STATE_DIR,FAKE_CWD",
      ];
      first = Bun.spawn([join(import.meta.dir, "..", "bin", "codemux"), ...args], {
        cwd: join(import.meta.dir, ".."),
        stdout: "pipe",
        stderr: "pipe",
        stdin: "pipe",
        env: {
          ...process.env,
          CODEMUX_NO_KEYCHAIN_SYNC: "1",
          HOME: home,
          XDG_CONFIG_HOME: join(home, ".config"),
          ...fake.env,
          FAKE_CWD: workdir,
        } as Record<string, string>,
      });
      const argvLog = join(fake.stateDir, "argv.jsonl");
      const deadline = Date.now() + 15_000;
      while (!existsSync(argvLog) || readFileSync(argvLog, "utf8").trim() === "") {
        if (Date.now() > deadline || first.exitCode !== null) {
          throw new Error(`the first resume never spawned its harness: ${await new Response(first.stderr as ReadableStream).text()}`);
        }
        await Bun.sleep(20);
      }
      const second = await runCli(args, { ...fake.env, HOME: home, FAKE_CWD: workdir }, {
        stdin: `${JSON.stringify({ type: "user", text: "scenario:basic hi" })}\n`,
      });
      expect(second.exitCode).toBe(78);
      expect(second.stderr).toContain("session_busy");
      const spawned = readFileSync(argvLog, "utf8").trim().split("\n");
      expect(spawned).toHaveLength(1);
      const read = readRegistry(registryPath);
      expect(read.outcome).toBe("ok");
      if (read.outcome === "ok") {
        expect(read.file.sessions[0]?.owner_pid).toBe(first.pid);
        expect(read.file.sessions[0]?.ended).toBeNull();
      }
      // The winner runs on: its init frame's start write finds its own
      // claim, so the turn runs and the session ends clean and resumable.
      const winner = first.stdin as import("bun").FileSink;
      winner.write(`${JSON.stringify({ type: "user", text: "scenario:basic hi" })}\n`);
      const reader = (first.stdout as ReadableStream<Uint8Array>).getReader();
      const decoder = new TextDecoder();
      let stdout = "";
      let closed = false;
      while (!stdout.includes('"type":"session_ended"')) {
        const { done, value } = await reader.read();
        if (done) break;
        stdout += decoder.decode(value, { stream: true });
        if (!closed && stdout.includes('"type":"turn_completed"')) {
          closed = true;
          winner.end();
        }
      }
      expect(await first.exited).toBe(0);
      const events = stdout.trim().split("\n").map((line) => JSON.parse(line) as Record<string, any>);
      expect(events.find((event) => event.type === "session_started")?.session_id).toBe(id);
      expect(events.find((event) => event.type === "turn_completed")?.finish).toBe("end");
      expect(events.at(-1)?.type).toBe("session_ended");
      expect(events.at(-1)?.resumable).toBe(true);
      const after = readRegistry(registryPath);
      expect(after.outcome === "ok" && after.file.sessions[0]?.ended !== null).toBe(true);
    } finally {
      if (first !== null && first.exitCode === null) first.kill();
      await first?.exited;
      fake.cleanup();
      rmSync(home, { recursive: true, force: true });
    }
  }, 30_000);
});

/** Seed a registry holding one ended claude record created at `autonomy`
 * in `workdir`, owned by a dead pid, so a `--resume` of `id` passes the
 * guard bundle. */
function seedClaudeRecord(
  home: string,
  workdir: string,
  id: string,
  autonomy: "read-only" | "low" | "medium" | "high"
): string {
  const registryPath = sessionRegistryPath(home);
  mkdirSync(dirname(registryPath), { recursive: true, mode: 0o700 });
  writeFileSync(
    registryPath,
    `${JSON.stringify({
      version: 1,
      sessions: [
        {
          id,
          agent: "claude",
          created_at: "2026-10-04T10:00:00.000Z",
          last_activity: "2026-10-04T10:05:00.000Z",
          cwd: workdir,
          hermetic: false,
          harness_home: join(home, ".claude"),
          model: null,
          autonomy,
          sandboxed: false,
          sandbox_trust: "standard",
          sandbox_no_net: false,
          sandbox_scrub_env: false,
          pass_env: ["FAKE_CWD", "FAKE_STATE_DIR"],
          playwright_mcp: false,
          owner_pid: 999999,
          owner_start: null,
          ended: "2026-10-04T10:05:00.000Z",
        },
      ],
    })}\n`,
    { mode: 0o600 }
  );
  return registryPath;
}

describe("CLI - resume claim (review live20)", () => {
  test("a resume that ends before its first turn releases the claim and stays resumable", async () => {
    // The claim stamps this process as owner before the spawn, but the
    // claude driver recorded ownership only at the init frame, which
    // follows the first input. A resume that ended with no input skipped
    // the end stamp (the claim stayed open) and reported resumable false.
    const fake = fakeClaudeEnv();
    const home = realpathSync(mkdtempSync(join(tmpdir(), "codemux-resume-noinput-")));
    const workdir = join(home, "work");
    mkdirSync(workdir);
    const id = "11111111-2222-3333-4444-555555555555";
    try {
      const registryPath = seedClaudeRecord(home, workdir, id, "high");
      const { stdout, stderr, exitCode } = await runCli(
        [
          "session", "-a", "claude", "--no-sandbox", "--auto", "high",
          "--cwd", workdir, "--resume", id, "--shutdown-grace", "2",
          "--pass-env", "FAKE_STATE_DIR,FAKE_CWD",
        ],
        { ...fake.env, HOME: home, FAKE_CWD: workdir },
        { stdin: "" }
      );
      expect(exitCode, stderr).toBe(0);
      const events = stdout.trim().split("\n").map((line) => JSON.parse(line) as Record<string, any>);
      expect(events.at(-1)?.type).toBe("session_ended");
      expect(events.at(-1)?.reason).toBe("stdin-close");
      expect(events.at(-1)?.resumable).toBe(true);
      const read = readRegistry(registryPath);
      expect(read.outcome).toBe("ok");
      if (read.outcome === "ok") {
        expect(read.file.sessions[0]?.ended).not.toBeNull();
        expect(read.file.sessions[0]?.ended).not.toBe("2026-10-04T10:05:00.000Z");
      }
    } finally {
      fake.cleanup();
      rmSync(home, { recursive: true, force: true });
    }
  }, 30_000);
  test("a resume the harness refuses is not reported resumable (review live21)", async () => {
    // Correctness minor 1: `resumable` was true as soon as the CLI's claim
    // succeeded. A record whose transcript Claude Code already deleted
    // passes every registry guard, the harness exits 1 at startup, and
    // the session still ended `resumable: true`, so a retrying caller
    // repeated the same failure.
    const fake = fakeClaudeEnv();
    const home = realpathSync(mkdtempSync(join(tmpdir(), "codemux-resume-refused-")));
    const workdir = join(home, "work");
    mkdirSync(workdir);
    const id = "22222222-3333-4444-5555-666666666666";
    writeFileSync(join(fake.env.FAKE_STATE_DIR as string, "resume-missing"), "");
    try {
      const registryPath = seedClaudeRecord(home, workdir, id, "high");
      const { stdout, stderr, exitCode } = await runCli(
        [
          "session", "-a", "claude", "--no-sandbox", "--auto", "high",
          "--cwd", workdir, "--resume", id, "--shutdown-grace", "2",
          "--pass-env", "FAKE_STATE_DIR,FAKE_CWD",
        ],
        { ...fake.env, HOME: home, FAKE_CWD: workdir },
        // Held open: the harness's own exit must end the session, not EOF.
        { stdin: `${JSON.stringify({ type: "user", text: "hello" })}\n`, holdStdin: true }
      );
      expect(exitCode, stderr).toBe(1);
      const events = stdout.trim().split("\n").map((line) => JSON.parse(line) as Record<string, any>);
      expect(events.at(-1)?.type).toBe("session_ended");
      expect(events.at(-1)?.resumable).toBe(false);
      // The harness's refusal goes out raw and the fatal names it; the
      // forwarded line was answered, so no "may still run it" notice.
      const raw = events.find((event) => event.type === "unknown");
      expect(String(raw?.raw)).toContain("No conversation found");
      const errors = events.filter((event) => event.type === "error");
      expect(errors.map((event) => event.message)).toEqual([
        "the claude process sent a result before its init frame, so no session started " +
          "(a refused --resume ends this way; the result's errors and codemux's stderr carry the reason)",
      ]);
      // The claim is still released.
      const read = readRegistry(registryPath);
      expect(read.outcome).toBe("ok");
      if (read.outcome === "ok") {
        expect(read.file.sessions[0]?.ended).not.toBeNull();
        expect(read.file.sessions[0]?.ended).not.toBe("2026-10-04T10:05:00.000Z");
      }
    } finally {
      fake.cleanup();
      rmSync(home, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("CLI - caller-stdin framing", () => {
  test("an oversized line's remainder is discarded, not parsed as the next command", async () => {
    // M1: one physical line of 17 MiB + 1 byte whose tail contains a
    // shutdown command. The rejection fires exactly once and the
    // shutdown — part of the rejected line — never executes; the session
    // ends on the stdin close that follows.
    const fake = fakeClaudeEnv();
    const isolatedHome = mkdtempSync(join(tmpdir(), "codemux-session-oversize-"));
    const workdir = join(isolatedHome, "work");
    mkdirSync(workdir);
    try {
      const proc = Bun.spawn(
        [
          join(import.meta.dir, "..", "bin", "codemux"),
          "session", "-a", "claude", "--no-sandbox", "--auto", "high",
          "--cwd", workdir, "--shutdown-grace", "2",
        ],
        {
          cwd: join(import.meta.dir, ".."),
          stdout: "pipe",
          stderr: "pipe",
          stdin: "pipe",
          env: {
            ...process.env,
            CODEMUX_NO_KEYCHAIN_SYNC: "1",
            HOME: isolatedHome,
            XDG_CONFIG_HOME: join(isolatedHome, ".config"),
            ...fake.env,
          } as Record<string, string>,
        }
      );
      const events: Record<string, any>[] = [];
      const stdoutDone = (async () => {
        const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let newline = buffer.indexOf("\n");
          while (newline !== -1) {
            const line = buffer.slice(0, newline);
            buffer = buffer.slice(newline + 1);
            if (line.trim() !== "") events.push(JSON.parse(line) as Record<string, any>);
            newline = buffer.indexOf("\n");
          }
        }
      })();
      const oversized =
        "x".repeat(17 * 1024 * 1024 + 1) + " " + JSON.stringify({ type: "shutdown" }) + "\n";
      proc.stdin!.write(oversized);
      proc.stdin!.end();
      const [exitCode] = await Promise.all([proc.exited, stdoutDone]);
      const rejections = events.filter((event) => event.type === "input_rejected");
      expect(rejections).toHaveLength(1);
      expect(rejections[0]?.reason).toBe("malformed");
      const ended = events[events.length - 1] as Record<string, any> | undefined;
      expect(ended?.type).toBe("session_ended");
      // The shutdown inside the rejected line never ran: the end is the
      // stdin close, not a shutdown command.
      expect(ended?.reason).toBe("stdin-close");
      expect(exitCode).toBe(0);
    } finally {
      fake.cleanup();
      rmSync(isolatedHome, { recursive: true, force: true });
    }
  });
});

/** A minimal stdin-shaped input the framer tests drive by hand: no real
 * pipe, no timing — the framing is pure computation. */
class StubInput {
  private dataListener: ((chunk: Buffer) => void) | null = null;
  private endListener: (() => void) | null = null;
  private errorListener: ((error: unknown) => void) | null = null;

  on(_event: "data", listener: (chunk: Buffer) => void): unknown {
    this.dataListener = listener;
    return this;
  }

  once(event: "end" | "error", listener: (error: unknown) => void): unknown {
    if (event === "end") this.endListener = listener as () => void;
    else this.errorListener = listener;
    return this;
  }

  removeListener(event: "data" | "end" | "error", _listener: unknown): unknown {
    if (event === "data") this.dataListener = null;
    else if (event === "end") this.endListener = null;
    else this.errorListener = null;
    return this;
  }

  emitData(chunk: Buffer): void {
    this.dataListener?.(chunk);
  }

  emitEnd(): void {
    this.endListener?.();
  }

  emitError(error: unknown): void {
    this.errorListener?.(error);
  }
}

describe("CLI - caller stdin framing", () => {
  test("frames lines, strips the CR, skips blanks, delivers the tail on end, and unframes cleanly", () => {
    const lines: string[] = [];
    let ends = 0;
    const input = new StubInput();
    const unframe = frameCallerStdin(
      {
        handleCallerLine: (line: string) => lines.push(line),
        handleCallerEnd: () => {
          ends += 1;
        },
      },
      input
    );
    // One chunk, three complete lines: a CR that belongs to the framing,
    // a blank line, and a plain third.
    input.emitData(Buffer.from("one\r\ntwo\n\nthree\n"));
    expect(lines).toEqual(["one", "two", "three"]);
    // The tail stays buffered until the stream ends.
    input.emitData(Buffer.from("tail"));
    expect(lines).toEqual(["one", "two", "three"]);
    input.emitEnd();
    expect(lines).toEqual(["one", "two", "three", "tail"]);
    expect(ends).toBe(1);
    // Nothing after unframe: the listeners came off.
    unframe();
    input.emitData(Buffer.from("gone\n"));
    input.emitEnd();
    expect(lines).toEqual(["one", "two", "three", "tail"]);
    expect(ends).toBe(1);
  });

  test("a read error is reported as a failure, never as a clean end (review live17)", () => {
    // Review live17, correctness major: `error` ran the same handler as
    // `end`, so a broken caller pipe ended the session "stdin-close" with
    // exit 0. The driver now hears the error itself, the partial tail is
    // not delivered (it may be a fragment), and a later `end` is ignored.
    const lines: string[] = [];
    const ends: unknown[] = [];
    const input = new StubInput();
    frameCallerStdin(
      {
        handleCallerLine: (line: string) => lines.push(line),
        handleCallerEnd: (error?: unknown) => {
          ends.push(error);
        },
      },
      input
    );
    input.emitData(Buffer.from("one\npartial"));
    const failure = new Error("EIO: i/o error, read");
    input.emitError(failure);
    input.emitEnd();
    expect(lines).toEqual(["one"]);
    expect(ends).toEqual([failure]);
  });

  test("a complete line past the cap is rejected even when its newline shares the chunk (review live18)", () => {
    // Review live18, minor: the cap was checked only while the buffer held
    // no newline, so a line just under the cap followed by one chunk that
    // carried both the overflow and the newline was delivered whole.
    const lines: string[] = [];
    const input = new StubInput();
    frameCallerStdin(
      {
        handleCallerLine: (line: string) => lines.push(line),
        handleCallerEnd: () => {},
      },
      input
    );
    input.emitData(Buffer.alloc(MAX_INPUT_LINE_BYTES - 10, 0x61));
    expect(lines).toEqual([]);
    input.emitData(Buffer.concat([Buffer.alloc(100, 0x61), Buffer.from("\nnext\n")]));
    // The over-cap line reaches the driver as the rejection sentinel, the
    // next line is intact.
    expect(lines).toEqual(["oversize", "next"]);
  });

  test("a line that is not valid UTF-8 is rejected, never decoded lossily (review live20)", () => {
    // Contracts major 1: the caller framer decoded with Buffer#toString,
    // which substitutes U+FFFD, so a line carrying one bad byte was
    // acked, echoed, and forwarded with its text changed. Decoding is
    // fatal-strict now; the line reaches the driver as the rejection
    // sentinel (answered input_rejected malformed), and the stream goes
    // on. A valid multi-byte character split across chunks still decodes.
    const lines: string[] = [];
    const input = new StubInput();
    frameCallerStdin(
      {
        handleCallerLine: (line: string) => lines.push(line),
        handleCallerEnd: () => {},
      },
      input
    );
    input.emitData(
      Buffer.concat([
        Buffer.from('{"type":"user","text":"a'),
        Buffer.from([0xff]),
        Buffer.from('b"}\n'),
      ])
    );
    // Byte 23 starts the two-byte "é"; the chunk boundary splits it.
    const accented = Buffer.from('{"type":"user","text":"é"}\n');
    input.emitData(accented.subarray(0, 24));
    input.emitData(accented.subarray(24));
    input.emitData(Buffer.from([0x7b, 0xc3]));
    input.emitEnd();
    expect(lines).toEqual(["invalid-utf8", '{"type":"user","text":"é"}', "invalid-utf8"]);
  });

  test("framing large input lines in pipe-sized chunks stays linear, not quadratic", () => {
    // Review live15, the harness-side framer's sibling (process.ts):
    // frameCallerStdin recopied the whole buffer on every chunk
    // (Buffer.concat) and restarted its newline scan from byte 0, so a
    // caller line near the cap arriving in ~64 KiB pipe chunks was
    // quadratic in the line size. The discriminator compares the SAME
    // 12 MiB line delivered in one chunk and in 8 KiB chunks (smaller than
    // a pipe's, to amplify the quadratic term): the linear framer pays
    // about the same CPU either way (one pass over the bytes plus a
    // per-chunk constant), the quadratic one rescans the whole buffer on
    // each of the 1536 chunks (~9 GiB of indexOf). Same bytes, same host,
    // same decode: no absolute bound, so a fast or a slow runner reads the
    // same ratio. Measured 2026-10-07: linear 2.2 ms whole / 2.6 ms
    // chunked; with `searchFrom = 0` reinstated in `deliver` (the
    // quadratic restart) 165 ms chunked — 60x, against a 4x bound.
    const line = Buffer.concat([Buffer.alloc(12 * 1024 * 1024, 0x61), Buffer.from("\n")]);
    const frameCpuMs = (chunkBytes: number): number => {
      const lines: string[] = [];
      const input = new StubInput();
      frameCallerStdin(
        { handleCallerLine: (text: string) => lines.push(text), handleCallerEnd: () => {} },
        input
      );
      const started = process.cpuUsage();
      for (let offset = 0; offset < line.length; offset += chunkBytes) {
        input.emitData(line.subarray(offset, Math.min(offset + chunkBytes, line.length)));
      }
      const spent = process.cpuUsage(started);
      input.emitEnd();
      expect(lines).toHaveLength(1);
      expect(lines[0]?.length).toBe(12 * 1024 * 1024);
      return (spent.user + spent.system) / 1000;
    };
    const best = (chunkBytes: number): number =>
      Math.min(...Array.from({ length: 3 }, () => frameCpuMs(chunkBytes)));
    const whole = best(line.length);
    const chunked = best(8 * 1024);
    expect(chunked).toBeLessThan(4 * whole + 10);
  }, 60_000);
});

describe("CLI - the registry before the first turn (review live22)", () => {
  /** A registry under `home` the reader refuses: right content, mode 0644. */
  function seedLooseRegistry(home: string): string {
    const registryPath = sessionRegistryPath(home);
    mkdirSync(dirname(registryPath), { recursive: true, mode: 0o700 });
    writeFileSync(registryPath, '{"version":1,"sessions":[]}\n', { mode: 0o644 });
    return registryPath;
  }

  for (const agent of ["claude", "agy"] as const) {
    test(`a fresh ${agent} session with an untrusted registry exits 1 before any input reaches the harness`, async () => {
      // Correctness major 4: a fresh session recorded itself only after
      // the harness named it — for the claude family at the init frame,
      // which follows the caller's first input; for agy at its first
      // result. An untrusted registry let that turn, tool calls included,
      // run before the session failed. The claude family now records
      // before the spawn; agy probes the registry before the spawn.
      const fake = agent === "claude" ? fakeClaudeEnv() : fakeAgyEnv();
      const home = realpathSync(mkdtempSync(join(tmpdir(), `codemux-fresh-${agent}-`)));
      const workdir = join(home, "work");
      mkdirSync(workdir);
      try {
        const registryPath = seedLooseRegistry(home);
        const { stdout, stderr, exitCode } = await runCli(
          [
            "session", "-a", agent, "--no-sandbox", "--auto", "high",
            "--cwd", workdir, "--shutdown-grace", "2",
            ...(agent === "claude" ? ["--pass-env", "FAKE_STATE_DIR,FAKE_CWD"] : []),
          ],
          { ...fake.env, HOME: home, FAKE_CWD: workdir },
          { stdin: `${JSON.stringify({ type: "user", text: "scenario:basic hi" })}\n` }
        );
        expect(exitCode, stderr).toBe(1);
        expect(stderr).toContain("cannot record the session in the registry");
        expect(stderr).toContain(registryPath);
        expect(stdout.trim()).toBe("");
        expect(existsSync(join(fake.stateDir, "input-lines.jsonl"))).toBe(false);
      } finally {
        fake.cleanup();
        rmSync(home, { recursive: true, force: true });
      }
    }, 30_000);
  }

  test("a fresh claude session's pre-spawn record is discarded when the harness never confirms it", async () => {
    // The pre-spawn record is owned from the start. A session that ends
    // before the harness ever confirmed it has no transcript behind it:
    // it is not reported resumable, and the record is removed, so a
    // later `--resume` of the id is the registry's not-found (66) rather
    // than a harness refusal (the audit's minor observation, live22).
    const fake = fakeClaudeEnv();
    const home = realpathSync(mkdtempSync(join(tmpdir(), "codemux-fresh-early-")));
    const workdir = join(home, "work");
    mkdirSync(workdir);
    try {
      const { stdout, stderr, exitCode } = await runCli(
        [
          "session", "-a", "claude", "--no-sandbox", "--auto", "high",
          "--cwd", workdir, "--shutdown-grace", "2",
          "--pass-env", "FAKE_STATE_DIR,FAKE_CWD",
        ],
        { ...fake.env, HOME: home, FAKE_CWD: workdir },
        { stdin: "" }
      );
      expect(exitCode, stderr).toBe(0);
      const events = stdout.trim().split("\n").map((line) => JSON.parse(line) as Record<string, any>);
      const ended = events.at(-1);
      expect(ended?.type).toBe("session_ended");
      expect(ended?.resumable).toBe(false);
      const read = readRegistry(sessionRegistryPath(home));
      expect(read.outcome).toBe("ok");
      if (read.outcome === "ok") expect(read.file.sessions).toHaveLength(0);
    } finally {
      fake.cleanup();
      rmSync(home, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("CLI - a claude resume records before the spawn (review live22 audit)", () => {
  test("the resume's own flags are in the record before any input reaches the harness", async () => {
    // A claude-family resume claimed the record before the spawn but
    // wrote it only at the init frame, which follows the caller's first
    // input; a lock held past the budget then failed the session after
    // that turn had started, and the resume's narrower flags reached the
    // record only once the turn was already running under them. The
    // record is now written before the spawn: here the resume drops a
    // `--pass-env` name the creation had and ends before any input, and
    // the record already carries the narrower list.
    const fake = fakeClaudeEnv();
    const home = realpathSync(mkdtempSync(join(tmpdir(), "codemux-resume-prerecord-")));
    const workdir = join(home, "work");
    mkdirSync(workdir);
    const id = "33333333-4444-5555-6666-777777777777";
    try {
      const registryPath = seedClaudeRecord(home, workdir, id, "high");
      const seeded = JSON.parse(readFileSync(registryPath, "utf8"));
      seeded.sessions[0].pass_env = ["FAKE_CWD", "FAKE_STATE_DIR", "ZZZ_EXTRA"];
      writeFileSync(registryPath, `${JSON.stringify(seeded)}\n`, { mode: 0o600 });
      const { stderr, exitCode } = await runCli(
        [
          "session", "-a", "claude", "--no-sandbox", "--auto", "high",
          "--cwd", workdir, "--resume", id, "--shutdown-grace", "2",
          "--pass-env", "FAKE_STATE_DIR,FAKE_CWD",
        ],
        { ...fake.env, HOME: home, FAKE_CWD: workdir },
        { stdin: "" }
      );
      expect(exitCode, stderr).toBe(0);
      const read = readRegistry(registryPath);
      expect(read.outcome).toBe("ok");
      if (read.outcome === "ok") {
        expect(read.file.sessions).toHaveLength(1);
        expect(read.file.sessions[0]?.pass_env).toEqual(["FAKE_CWD", "FAKE_STATE_DIR"]);
        expect(read.file.sessions[0]?.ended).not.toBeNull();
      }
    } finally {
      fake.cleanup();
      rmSync(home, { recursive: true, force: true });
    }
  }, 30_000);
});

const FAKE_OPENCODE = fileURLToPath(new URL("./fixtures/live/fake-opencode-run.ts", import.meta.url));
const FAKE_AIDER = fileURLToPath(new URL("./fixtures/live/fake-aider-run.ts", import.meta.url));

function fakeOpenCodeEnv(extra: { version?: string; env?: Record<string, string> } = {}) {
  return fakeHarnessEnv("opencode", FAKE_OPENCODE, { version: "1.18.18", ...extra });
}

function fakeAiderEnv(extra: { version?: string; env?: Record<string, string> } = {}) {
  return fakeHarnessEnv("aider", FAKE_AIDER, { version: "aider 0.86.2", ...extra });
}

/** One `codemux session` child driven over stdio, with the parsed event
 * stream and helpers to wait and send (the happy-path shape, factored for
 * the turn-per-process agents). */
async function driveSession(
  args: string[],
  env: Record<string, string>
): Promise<{
  events: Record<string, any>[];
  waitFor: (label: string, pred: (event: Record<string, any>) => boolean) => Promise<Record<string, any>>;
  send: (message: unknown) => void;
  exit: Promise<[number, void]>;
  proc: Bun.Subprocess;
}> {
  const proc = Bun.spawn([join(import.meta.dir, "..", "bin", "codemux"), ...args], {
    cwd: join(import.meta.dir, ".."),
    stdout: "pipe",
    stderr: "pipe",
    stdin: "pipe",
    env: { ...process.env, CODEMUX_NO_KEYCHAIN_SYNC: "1", ...env } as Record<string, string>,
  });
  const events: Record<string, any>[] = [];
  const stdoutDone = (async () => {
    const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.trim() !== "") events.push(JSON.parse(line) as Record<string, any>);
        newline = buffer.indexOf("\n");
      }
    }
  })();
  const waitFor = async (label: string, pred: (event: Record<string, any>) => boolean) => {
    const deadline = Date.now() + 15_000;
    for (;;) {
      const found = events.find(pred);
      if (found !== undefined) return found;
      if (Date.now() > deadline) {
        throw new Error(
          `timed out waiting for ${label}; saw: ${events.map((event) => event.type).join(",")}`
        );
      }
      await Bun.sleep(10);
    }
  };
  return {
    events,
    waitFor,
    send: (message: unknown) => {
      (proc.stdin as { write: (text: string) => unknown }).write(`${JSON.stringify(message)}\n`);
    },
    exit: Promise.all([proc.exited, stdoutDone]),
    proc,
  };
}

describe("CLI - opencode sessions", () => {
  test("drives a session over the native run wire, records the real data dir, and carries the override", async () => {
    const fake = fakeOpenCodeEnv();
    const isolatedHome = mkdtempSync(join(tmpdir(), "codemux-session-home-"));
    const workdir = join(isolatedHome, "work");
    const xdgData = join(isolatedHome, "xdg-data");
    mkdirSync(workdir);
    mkdirSync(xdgData);
    try {
      const session = await driveSession(
        [
          "session", "-a", "opencode", "--no-sandbox", "--auto", "high",
          "--cwd", workdir, "--shutdown-grace", "2",
          "--pass-env", "FAKE_STATE_DIR",
        ],
        {
          HOME: isolatedHome,
          XDG_DATA_HOME: xdgData,
          FAKE_STATE_DIR: fake.stateDir,
          ...fake.env,
          CODEMUX_OPENCODE_PROVIDER_BASE_URL: "http://127.0.0.1:9/v1",
          CODEMUX_OPENCODE_PROVIDER_API_KEY: "e2e-key-do-not-print",
          CODEMUX_OPENCODE_PROVIDER_MODEL: "clawvm-qwen32b-coder",
        }
      );
      try {
        session.send({ type: "user", text: "scenario:basic one" });
        const started = await session.waitFor(
          "session_started",
          (event) => event.type === "session_started"
        );
        expect(started.agent).toBe("opencode");
        expect(started.session_id).toBe("ses_fake1234567890");
        // The override's wire model is what the spawn carries.
        expect(started.model).toBe("codemux/clawvm-qwen32b-coder");
        const completed = await session.waitFor(
          "turn_completed",
          (event) => event.type === "turn_completed"
        );
        expect(completed.finish).toBe("end");

        session.send({ type: "shutdown" });
        const [exitCode] = await session.exit;
        expect(exitCode).toBe(0);
        const ended = session.events[session.events.length - 1] as Record<string, any>;
        expect(ended.resumable).toBe(true);

        // The turn spawn carried the adapter's wire model and the
        // override's env delivery: the key through the environment, the
        // provider config through OPENCODE_CONFIG (prepareRun at every
        // turn, exactly the run path's seam).
        const argv = JSON.parse(
          readFileSync(join(fake.stateDir, "argv.jsonl"), "utf8").split("\n")[0] as string
        ) as { args: string[] };
        expect(argv.args[argv.args.indexOf("--model") + 1]).toBe("codemux/clawvm-qwen32b-coder");
        const envRecord = JSON.parse(
          readFileSync(join(fake.stateDir, "env.jsonl"), "utf8").split("\n")[0] as string
        ) as { hasProviderKey: boolean; openCodeConfig: string | null };
        expect(envRecord.hasProviderKey).toBe(true);
        expect(envRecord.openCodeConfig).toMatch(
          /\.codemux[/\\]provider-[^/\\]+[/\\]opencode\.json$/
        );

        // The harness home is the real data directory (XDG_DATA_HOME
        // honored) — the override swaps the provider, never the store a
        // --resume reads.
        const registry = readRegistry(
          sessionRegistryPath(isolatedHome)
        );
        expect(registry.outcome).toBe("ok");
        const entry =
          registry.outcome === "ok"
            ? registry.file.sessions.find((r) => r.id === "ses_fake1234567890")
            : undefined;
        expect(entry?.agent).toBe("opencode");
        expect(entry?.harness_home).toBe(join(xdgData, "opencode"));
      } finally {
        await session.proc.kill();
      }
    } finally {
      fake.cleanup();
      rmSync(isolatedHome, { recursive: true, force: true });
    }
  }, 30_000);

  test("a project config written between turns stops the next turn before it spawns (review D2, security 1)", async () => {
    // The start-time validateRunRequest gate alone left the hole: opencode
    // and aider spawn a NEW process every turn, and turn N's child can
    // write the very config turn N+1 reloads (opencode.json granting
    // permissions, .aider.model.settings.yml). spawnTurn re-runs the
    // adapter's gate before every turn, so the second turn fails instead
    // of running with reach the recorded autonomy never granted.
    const fake = fakeOpenCodeEnv();
    const isolatedHome = mkdtempSync(join(tmpdir(), "codemux-session-guard-"));
    const workdir = join(isolatedHome, "work");
    mkdirSync(workdir);
    try {
      const session = await driveSession(
        [
          "session", "-a", "opencode", "--no-sandbox", "--auto", "high",
          "--cwd", workdir, "--shutdown-grace", "2",
          "--pass-env", "FAKE_STATE_DIR",
        ],
        { HOME: isolatedHome, FAKE_STATE_DIR: fake.stateDir, ...fake.env }
      );
      try {
        session.send({ type: "user", text: "scenario:basic one" });
        const first = await session.waitFor(
          "turn_completed",
          (event) => event.type === "turn_completed"
        );
        expect(first.finish).toBe("end");
        // What turn 1's child could have written: a project config that
        // widens the next process's reach.
        writeFileSync(
          join(workdir, "opencode.json"),
          JSON.stringify({ permission: { bash: "allow" } })
        );
        session.send({ type: "user", text: "scenario:basic two" });
        const failure = await session.waitFor(
          "the guard fatal",
          (event) => event.type === "error" && event.fatal === true
        );
        expect(failure.message).toContain("could not spawn the opencode turn process");
        expect(failure.message).toContain("refuses repository executable configuration");
        expect(failure.message).toContain("opencode.json");
        const [exitCode] = await session.exit;
        expect(exitCode).toBe(1);
        // Exactly one turn process ever spawned: the guarded turn never
        // reached the harness.
        const spawns = readFileSync(join(fake.stateDir, "argv.jsonl"), "utf8")
          .trim()
          .split("\n");
        expect(spawns).toHaveLength(1);
      } finally {
        await session.proc.kill();
      }
    } finally {
      fake.cleanup();
      rmSync(isolatedHome, { recursive: true, force: true });
    }
  }, 30_000);

  test("each turn loads a fresh provider config; an earlier turn's rewrite never reaches the next (review D3, security 2)", async () => {
    // The provider config file lives in the opencode data directory,
    // which the sandboxed child can write, and every turn is a new
    // process that reloads it through OPENCODE_CONFIG. A config cached
    // at the first turn let turn 1's child rewrite what turn 2 ran with
    // (permissions, MCP servers) — the run path never shares the file
    // across processes, and neither does a session now: one fresh
    // unguessable config per turn, the previous one finalized at the
    // next turn's spawn.
    const fake = fakeOpenCodeEnv();
    const isolatedHome = mkdtempSync(join(tmpdir(), "codemux-session-turncfg-"));
    const workdir = join(isolatedHome, "work");
    const xdgData = join(isolatedHome, "xdg-data");
    mkdirSync(workdir);
    mkdirSync(xdgData);
    try {
      const session = await driveSession(
        [
          "session", "-a", "opencode", "--no-sandbox", "--auto", "high",
          "--cwd", workdir, "--shutdown-grace", "2",
          "--pass-env", "FAKE_STATE_DIR",
        ],
        {
          HOME: isolatedHome,
          XDG_DATA_HOME: xdgData,
          FAKE_STATE_DIR: fake.stateDir,
          ...fake.env,
          CODEMUX_OPENCODE_PROVIDER_BASE_URL: "http://127.0.0.1:9/v1",
          CODEMUX_OPENCODE_PROVIDER_API_KEY: "e2e-key-do-not-print",
          CODEMUX_OPENCODE_PROVIDER_MODEL: "clawvm-qwen32b-coder",
        }
      );
      try {
        session.send({ type: "user", text: "scenario:basic one" });
        await session.waitFor("turn_completed", (event) => event.type === "turn_completed");
        const configs = (): Array<{ openCodeConfig: string | null }> =>
          readFileSync(join(fake.stateDir, "env.jsonl"), "utf8")
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line) as { openCodeConfig: string | null });
        const first = configs()[0] as { openCodeConfig: string | null };

        // What turn 1's child could have written into its own config:
        // permissions turn 2 must never run with. Turns serialize, so
        // turn 1's process has exited by the time this runs.
        expect(first.openCodeConfig).not.toBeNull();
        const firstConfig = first.openCodeConfig as string;
        expect(existsSync(firstConfig)).toBe(true);
        writeFileSync(firstConfig, JSON.stringify({ permission: { bash: "allow" } }));

        session.send({ type: "user", text: "scenario:basic two" });
        await session.waitFor(
          "the second turn",
          () => session.events.filter((event) => event.type === "turn_completed").length === 2
        );
        const second = configs()[1] as { openCodeConfig: string | null };
        // A different, fresh config file — and turn 1's config directory
        // is gone, finalized at turn 2's spawn.
        expect(second.openCodeConfig).not.toBeNull();
        expect(second.openCodeConfig).not.toBe(firstConfig);
        expect(second.openCodeConfig).toMatch(
          /\.codemux[/\\]provider-[^/\\]+[/\\]opencode\.json$/
        );
        expect(existsSync(firstConfig)).toBe(false);
        expect(existsSync(second.openCodeConfig as string)).toBe(true);

        session.send({ type: "shutdown" });
        const [exitCode] = await session.exit;
        expect(exitCode).toBe(0);
        // The live config dies with the session.
        expect(existsSync(second.openCodeConfig as string)).toBe(false);
      } finally {
        await session.proc.kill();
      }
    } finally {
      fake.cleanup();
      rmSync(isolatedHome, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("CLI - aider sessions", () => {
  test("drives a session over the per-turn history file and records ~/.aider as the home", async () => {
    const fake = fakeAiderEnv();
    const isolatedHome = mkdtempSync(join(tmpdir(), "codemux-session-home-"));
    const workdir = join(isolatedHome, "work");
    mkdirSync(workdir);
    try {
      const session = await driveSession(
        [
          "session", "-a", "aider", "--no-sandbox", "--auto", "high",
          "--cwd", workdir, "--shutdown-grace", "2",
          "--pass-env", "FAKE_STATE_DIR",
        ],
        { HOME: isolatedHome, FAKE_STATE_DIR: fake.stateDir, ...fake.env }
      );
      try {
        session.send({ type: "user", text: "scenario:basic one" });
        const started = await session.waitFor(
          "session_started",
          (event) => event.type === "session_started"
        );
        expect(started.agent).toBe("aider");
        expect(started.session_id).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
        );
        expect(started.model).toBeNull();
        const message = await session.waitFor(
          "assistant_message",
          (event) => event.type === "assistant_message"
        );
        expect(message.text).toBe("Done: scenario:basic one");
        const completed = await session.waitFor(
          "turn_completed",
          (event) => event.type === "turn_completed"
        );
        expect(completed.finish).toBe("end");

        session.send({ type: "shutdown" });
        const [exitCode] = await session.exit;
        expect(exitCode).toBe(0);

        // The exchange lives in the per-session history file codemux
        // owns, and the turn spawned with no model flags at all (the
        // adapter leaves aider's own default alone without an override).
        const registry = readRegistry(
          sessionRegistryPath(isolatedHome)
        );
        expect(registry.outcome).toBe("ok");
        const entry =
          registry.outcome === "ok"
            ? registry.file.sessions.find((r) => r.id === started.session_id)
            : undefined;
        expect(entry?.agent).toBe("aider");
        expect(entry?.harness_home).toBe(join(isolatedHome, ".aider"));
        expect(
          existsSync(join(isolatedHome, ".aider", ".codemux", "sessions", started.session_id, "history.md"))
        ).toBe(true);
        const argv = JSON.parse(
          readFileSync(join(fake.stateDir, "argv.jsonl"), "utf8").split("\n")[0] as string
        ) as { args: string[] };
        // Exact flags: aiderBaseFlags always carries --model-settings-file
        // and --model-metadata-file, which a startsWith match would hit.
        expect(argv.args).not.toContain("--model");
        expect(argv.args).not.toContain("--weak-model");
      } finally {
        await session.proc.kill();
      }
    } finally {
      fake.cleanup();
      rmSync(isolatedHome, { recursive: true, force: true });
    }
  }, 30_000);

  test("a provider override carries the wire model and the weak model on the same endpoint", async () => {
    const fake = fakeAiderEnv();
    const isolatedHome = mkdtempSync(join(tmpdir(), "codemux-session-home-"));
    const workdir = join(isolatedHome, "work");
    mkdirSync(workdir);
    try {
      const session = await driveSession(
        [
          "session", "-a", "aider", "--no-sandbox", "--auto", "high",
          "--cwd", workdir, "--shutdown-grace", "2",
          "--pass-env", "FAKE_STATE_DIR",
        ],
        {
          HOME: isolatedHome,
          FAKE_STATE_DIR: fake.stateDir,
          ...fake.env,
          CODEMUX_AIDER_PROVIDER_BASE_URL: "http://127.0.0.1:9/v1",
          CODEMUX_AIDER_PROVIDER_API_KEY: "e2e-key-do-not-print",
          CODEMUX_AIDER_PROVIDER_MODEL: "clawvm-qwen32b-coder",
        }
      );
      try {
        session.send({ type: "user", text: "scenario:basic one" });
        const completed = await session.waitFor(
          "turn_completed",
          (event) => event.type === "turn_completed"
        );
        expect(completed.finish).toBe("end");
        session.send({ type: "shutdown" });
        const [exitCode] = await session.exit;
        expect(exitCode).toBe(0);
        // The wire model is openai/-prefixed and the weak model rides
        // the same endpoint (aider's ChatSummary runs through it) — the
        // run path's mapping, unchanged by the session boundary.
        const argv = JSON.parse(
          readFileSync(join(fake.stateDir, "argv.jsonl"), "utf8").split("\n")[0] as string
        ) as { args: string[] };
        expect(argv.args[argv.args.indexOf("--model") + 1]).toBe("openai/clawvm-qwen32b-coder");
        expect(argv.args[argv.args.indexOf("--weak-model") + 1]).toBe("openai/clawvm-qwen32b-coder");
      } finally {
        await session.proc.kill();
      }
    } finally {
      fake.cleanup();
      rmSync(isolatedHome, { recursive: true, force: true });
    }
  }, 30_000);

  test("a bad passed-through CODEX_HOME never ends a non-codex session (review D8, correctness 2)", async () => {
    // codexHarnessHome's CODEX_HOME validation (absolute, unpadded) ran
    // for EVERY agent at session setup, so an aider session with
    // --pass-env CODEX_HOME and a relative value exited 64 on a codex
    // rule its harness never reads. Only a codex session validates the
    // variable now; this session runs a full turn to a clean end.
    const fake = fakeAiderEnv();
    const isolatedHome = mkdtempSync(join(tmpdir(), "codemux-session-home-"));
    const workdir = join(isolatedHome, "work");
    mkdirSync(workdir);
    try {
      const session = await driveSession(
        [
          "session", "-a", "aider", "--no-sandbox", "--auto", "high",
          "--cwd", workdir, "--shutdown-grace", "2",
          "--pass-env", "CODEX_HOME,FAKE_STATE_DIR",
        ],
        {
          HOME: isolatedHome,
          CODEX_HOME: "rel/path",
          FAKE_STATE_DIR: fake.stateDir,
          ...fake.env,
        }
      );
      try {
        session.send({ type: "user", text: "scenario:basic one" });
        const completed = await session.waitFor(
          "turn_completed",
          (event) => event.type === "turn_completed"
        );
        expect(completed.finish).toBe("end");
        session.send({ type: "shutdown" });
        const [exitCode] = await session.exit;
        expect(exitCode).toBe(0);
      } finally {
        await session.proc.kill();
      }
    } finally {
      fake.cleanup();
      rmSync(isolatedHome, { recursive: true, force: true });
    }
  }, 30_000);

  test("a bad passed-through CLAUDE_CONFIG_DIR never ends a non-claude-family session (review D8, correctness 2)", async () => {
    // The CODEX_HOME finding's mirror, found in the same-class audit:
    // assertAbsoluteClaudeConfigDir ran eagerly for EVERY agent at
    // session setup, so an aider session with --pass-env
    // CLAUDE_CONFIG_DIR and a relative value exited 64 on a claude
    // rule its harness never reads. Only claude and zai sessions
    // validate the variable now; this session runs a full turn to a
    // clean end.
    const fake = fakeAiderEnv();
    const isolatedHome = mkdtempSync(join(tmpdir(), "codemux-session-home-"));
    const workdir = join(isolatedHome, "work");
    mkdirSync(workdir);
    try {
      const session = await driveSession(
        [
          "session", "-a", "aider", "--no-sandbox", "--auto", "high",
          "--cwd", workdir, "--shutdown-grace", "2",
          "--pass-env", "CLAUDE_CONFIG_DIR,FAKE_STATE_DIR",
        ],
        {
          HOME: isolatedHome,
          CLAUDE_CONFIG_DIR: "rel/path",
          FAKE_STATE_DIR: fake.stateDir,
          ...fake.env,
        }
      );
      try {
        session.send({ type: "user", text: "scenario:basic one" });
        const completed = await session.waitFor(
          "turn_completed",
          (event) => event.type === "turn_completed"
        );
        expect(completed.finish).toBe("end");
        session.send({ type: "shutdown" });
        const [exitCode] = await session.exit;
        expect(exitCode).toBe(0);
      } finally {
        await session.proc.kill();
      }
    } finally {
      fake.cleanup();
      rmSync(isolatedHome, { recursive: true, force: true });
    }
  }, 30_000);

  test("a failed start record removes the fresh session's history directory (review D2, correctness-2 3)", async () => {
    // recordBeforeSpawn creates ~/.aider/.codemux/sessions/<uuid>/ before
    // the registry write; when that write fails the CLI exits, and the
    // directory used to stay behind with nothing pointing at it until the
    // 28-day sweep. The failure path now removes it.
    const fake = fakeAiderEnv();
    const home = realpathSync(mkdtempSync(join(tmpdir(), "codemux-aider-recordfail-")));
    const workdir = join(home, "work");
    mkdirSync(workdir);
    try {
      // The untrusted registry (mode 0644) fails the start record — the
      // live22 pattern.
      const registryPath = sessionRegistryPath(home);
      mkdirSync(dirname(registryPath), { recursive: true, mode: 0o700 });
      writeFileSync(registryPath, '{"version":1,"sessions":[]}\n', { mode: 0o644 });
      const { stderr, exitCode } = await runCli(
        [
          "session", "-a", "aider", "--no-sandbox", "--auto", "high",
          "--cwd", workdir, "--shutdown-grace", "2",
        ],
        { ...fake.env, HOME: home },
        { stdin: "" }
      );
      expect(exitCode, stderr).toBe(1);
      expect(stderr).toContain("cannot record the session in the registry");
      // No orphaned session directory: nothing was recorded, so nothing
      // stays under the sessions parent.
      const sessionsDir = join(home, ".aider", ".codemux", "sessions");
      const left = existsSync(sessionsDir) ? readdirSync(sessionsDir) : [];
      expect(left).toEqual([]);
    } finally {
      fake.cleanup();
      rmSync(home, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("CLI - codex sessions under a provider override", () => {
  const THREAD_ID = "0123456789abcdef";

  /** The env both override-session tests run under: one endpoint, one
   * key, one model, isolated HOME. */
  const overrideEnv = (
    fake: ReturnType<typeof fakeCodexEnv>,
    isolatedHome: string,
    workdir: string
  ): Record<string, string> => {
    const env: Record<string, string> = {
      HOME: isolatedHome,
      XDG_CONFIG_HOME: join(isolatedHome, ".config"),
      ...fake.env,
      FAKE_STATE_DIR: fake.stateDir,
      FAKE_CWD: workdir,
      CODEMUX_CODEX_PROVIDER_BASE_URL: "http://127.0.0.1:9/v1",
      CODEMUX_CODEX_PROVIDER_API_KEY: "e2e-key-do-not-print",
      CODEMUX_CODEX_PROVIDER_MODEL: "clawvm-qwen32b-coder",
    };
    return env;
  };

  /** One `codexHome` record per harness spawn, in spawn order (the
   * version probe never reaches the fake: the wrapper answers it). */
  const recordedHomes = (fake: { stateDir: string }): string[] =>
    readFileSync(join(fake.stateDir, "env.jsonl"), "utf8")
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => (JSON.parse(line) as { codexHome: string | null }).codexHome as string);

  test("the session's home is keyed by session id, settled at the resumable end (review D1)", async () => {
    const fake = fakeCodexEnv({ version: "codex-cli 0.159.3" });
    const isolatedHome = mkdtempSync(join(tmpdir(), "codemux-session-home-"));
    const workdir = join(isolatedHome, "work");
    mkdirSync(workdir);
    const baseUrl = "http://127.0.0.1:9/v1";
    try {
      const session = await driveSession(
        [
          "session", "-a", "codex", "--no-sandbox", "--auto", "high",
          "--cwd", workdir, "--shutdown-grace", "2",
          "--pass-env", "FAKE_STATE_DIR,FAKE_CWD",
        ],
        overrideEnv(fake, isolatedHome, workdir)
      );
      try {
        session.send({ type: "user", text: "scenario:basic hello" });
        const started = await session.waitFor(
          "session_started",
          (event) => event.type === "session_started"
        );
        expect(started.agent).toBe("codex");
        expect(started.session_id).toBe(THREAD_ID);
        // The override's model is the reported one, raw.
        expect(started.model).toBe("clawvm-qwen32b-coder");
        const completed = await session.waitFor(
          "turn_completed",
          (event) => event.type === "turn_completed"
        );
        expect(completed.finish).toBe("end");

        // While the session runs, its home is run-shaped (review D1): a
        // fresh directory under .codemux-provider, not the keyed path —
        // the id that keys it only arrives at thread/start.
        const liveHome = recordedHomes(fake)[0] as string;
        expect(liveHome.startsWith(join(isolatedHome, ".codex", ".codemux-provider") + "/")).toBe(true);
        expect(liveHome.split("/").pop()).toMatch(/^run-\d+-/);
        expect(existsSync(join(liveHome, "config.toml"))).toBe(true);

        session.send({ type: "shutdown" });
        const [exitCode] = await session.exit;
        expect(exitCode).toBe(0);

        // The registry recorded the keyed path the resume's guard will
        // compare (the driver's seam), never the live run-shaped name.
        const hash = createHash("sha256").update(baseUrl).digest("hex").slice(0, 12);
        const keyed = join(isolatedHome, ".codex", ".codemux-provider", `session-home-${hash}-${THREAD_ID}`);
        const registry = readRegistry(
          sessionRegistryPath(isolatedHome)
        );
        expect(registry.outcome).toBe("ok");
        const entry =
          registry.outcome === "ok"
            ? registry.file.sessions.find((r) => r.id === THREAD_ID)
            : undefined;
        expect(entry?.harness_home).toBe(keyed);

        // The resumable end settled the home onto its key: the run-shaped
        // name is gone, the keyed directory holds the config, and nothing
        // else is left under the parent.
        expect(existsSync(liveHome)).toBe(false);
        const config = readFileSync(join(keyed, "config.toml"), "utf8");
        expect(config).toContain(`base_url = "${baseUrl}"`);
        expect(config).toContain(`model = "clawvm-qwen32b-coder"`);
        expect(readdirSync(join(isolatedHome, ".codex", ".codemux-provider"))).toEqual([
          `session-home-${hash}-${THREAD_ID}`,
        ]);

        // The spawn delivered CODEX_HOME through env(1) (the run path's
        // launch shape), and thread/start carried no model — wireModel
        // null under an override.
        const requests = readFileSync(join(fake.stateDir, "requests.jsonl"), "utf8")
          .split("\n")
          .filter((line) => line.trim() !== "")
          .map((line) => JSON.parse(line) as { method: string; params: Record<string, unknown> });
        const start = requests.find((request) => request.method === "thread/start");
        expect(start).toBeDefined();
        expect(start?.params.model).toBeUndefined();
      } finally {
        await session.proc.kill();
      }
    } finally {
      fake.cleanup();
      rmSync(isolatedHome, { recursive: true, force: true });
    }
  }, 30_000);

  test("a resume reopens the session-keyed home, rewrites the config, and keeps it at its end", async () => {
    const fake = fakeCodexEnv({ version: "codex-cli 0.159.3" });
    const isolatedHome = mkdtempSync(join(tmpdir(), "codemux-session-home-"));
    const workdir = join(isolatedHome, "work");
    mkdirSync(workdir);
    const baseUrl = "http://127.0.0.1:9/v1";
    const hash = createHash("sha256").update(baseUrl).digest("hex").slice(0, 12);
    const keyed = join(isolatedHome, ".codex", ".codemux-provider", `session-home-${hash}-${THREAD_ID}`);
    const args = [
      "session", "-a", "codex", "--no-sandbox", "--auto", "high",
      "--cwd", workdir, "--shutdown-grace", "2",
      "--pass-env", "FAKE_STATE_DIR,FAKE_CWD",
    ];
    try {
      // Session one: run to a resumable end, leaving the home on its key.
      const first = await driveSession(args, overrideEnv(fake, isolatedHome, workdir));
      try {
        first.send({ type: "user", text: "scenario:basic hello" });
        await first.waitFor("turn_completed", (event) => event.type === "turn_completed");
        first.send({ type: "shutdown" });
        expect((await first.exit)[0]).toBe(0);
      } finally {
        await first.proc.kill();
      }
      const configInode = statSync(join(keyed, "config.toml")).ino;

      // Session two: the resume. Its guard passes only because the
      // recorded harness_home is the keyed path this resume computes
      // (review D1: one session's home, keyed by endpoint AND id).
      const second = await driveSession([...args, "--resume", THREAD_ID], overrideEnv(fake, isolatedHome, workdir));
      try {
        second.send({ type: "user", text: "scenario:basic again" });
        const started = await second.waitFor(
          "session_started",
          (event) => event.type === "session_started"
        );
        expect(started.session_id).toBe(THREAD_ID);
        await second.waitFor("turn_completed", (event) => event.type === "turn_completed");
        second.send({ type: "shutdown" });
        const [exitCode] = await second.exit;
        expect(exitCode).toBe(0);
      } finally {
        await second.proc.kill();
      }

      // The resumed process ran in the keyed home (env(1) delivered it),
      // resumed the thread rather than starting one, and the resume's
      // config rewrite replaced the file (a new inode — never a write
      // through whatever the old session's child left at the name).
      const homes = recordedHomes(fake);
      expect(homes).toHaveLength(2);
      expect(homes[1]).toBe(keyed);
      const requests = readFileSync(join(fake.stateDir, "requests.jsonl"), "utf8")
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => JSON.parse(line) as { method: string; params: Record<string, unknown> });
      const resumed = requests.find((request) => request.method === "thread/resume");
      expect(resumed).toBeDefined();
      expect(statSync(join(keyed, "config.toml")).ino).not.toBe(configInode);
      // The resumed session's own resumable end keeps the home — it IS
      // the state the next resume needs — and leaves nothing else.
      expect(existsSync(keyed)).toBe(true);
      expect(readdirSync(join(isolatedHome, ".codex", ".codemux-provider"))).toEqual([
        `session-home-${hash}-${THREAD_ID}`,
      ]);
    } finally {
      fake.cleanup();
      rmSync(isolatedHome, { recursive: true, force: true });
    }
  }, 30_000);

  test("a resume refused session_busy never rewrote the live session's config (review D5, correctness 3)", async () => {
    // The race the finding named: two resumes of one id whose lock-free
    // lookups BOTH pass — the loser's before the winner's claim — so the
    // loser reaches its home open while the winner is live. That open
    // used to rewrite config.toml BEFORE the claim: the loser rewrote
    // the live session's config (here a different context cap would
    // land) and then exited session_busy. The write now happens only
    // after the claim, so the loser rewrites nothing.
    //
    // The loser is parked at the harness version probe — the CLI's order
    // is lookup, probe, home open, claim — by a wrapper whose --version
    // touches a marker and waits for a release file beside it: the
    // probe's environment is allowlisted, so no FAKE_* variable reaches
    // it and only the wrapper's own directory can carry the signal. The
    // marker says the lookup already passed (program order), and the
    // winner starts only then, so the ordering is deterministic.
    const fake = fakeCodexEnv({ version: "codex-cli 0.159.3" });
    const isolatedHome = mkdtempSync(join(tmpdir(), "codemux-session-home-"));
    const workdir = join(isolatedHome, "work");
    mkdirSync(workdir);
    const baseUrl = "http://127.0.0.1:9/v1";
    const hash = createHash("sha256").update(baseUrl).digest("hex").slice(0, 12);
    const keyed = join(isolatedHome, ".codex", ".codemux-provider", `session-home-${hash}-${THREAD_ID}`);
    const args = [
      "session", "-a", "codex", "--no-sandbox", "--auto", "high",
      "--cwd", workdir, "--shutdown-grace", "2",
      "--pass-env", "FAKE_STATE_DIR,FAKE_CWD",
    ];
    try {
      // Session one: fresh, run to a resumable end so the keyed home
      // exists with its config and the record is ended.
      const first = await driveSession(args, overrideEnv(fake, isolatedHome, workdir));
      try {
        first.send({ type: "user", text: "scenario:basic hello" });
        await first.waitFor("turn_completed", (event) => event.type === "turn_completed");
        first.send({ type: "shutdown" });
        expect((await first.exit)[0]).toBe(0);
      } finally {
        await first.proc.kill();
      }

      // The loser starts FIRST: its lookup passes (the record is ended),
      // and it parks at the probe — before the home open, before any
      // claim — carrying a context cap the pre-D5 write would have
      // planted into the live session's file.
      const parked = createFakeBinaryEnv({
        codex: [
          'if [ "$1" = "--version" ]; then',
          '  printf "parked" > "$(dirname "$0")/parked"',
          '  while [ ! -f "$(dirname "$0")/release" ]; do sleep 0.05; done',
          "  printf 'codex-cli 0.159.3\\n'",
          "  exit 0",
          "fi",
          `exec bun '${FAKE_CODEX}' "$@"`,
        ].join("\n"),
      });
      try {
        // createFakeBinaryEnv puts its bin directory first on PATH.
        const parkedBin = (parked.env.PATH as string).split(":")[0] as string;
        const loser = Bun.spawn(
          [join(import.meta.dir, "..", "bin", "codemux"), ...args, "--resume", THREAD_ID],
          {
            cwd: join(import.meta.dir, ".."),
            stdout: "ignore",
            stderr: "pipe",
            stdin: "ignore",
            env: {
              ...process.env,
              CODEMUX_NO_KEYCHAIN_SYNC: "1",
              PATH: parked.env.PATH,
              HOME: isolatedHome,
              XDG_CONFIG_HOME: join(isolatedHome, ".config"),
              FAKE_STATE_DIR: fake.stateDir,
              FAKE_CWD: workdir,
              CODEMUX_CODEX_PROVIDER_BASE_URL: baseUrl,
              CODEMUX_CODEX_PROVIDER_API_KEY: "e2e-key-do-not-print",
              CODEMUX_CODEX_PROVIDER_MODEL: "clawvm-qwen32b-coder",
              CODEMUX_CODEX_PROVIDER_MAX_CONTEXT_TOKENS: "999999",
            } as Record<string, string>,
          }
        );
        const loserStderr = new Response(loser.stderr).text();
        const parkedMarker = join(parkedBin, "parked");
        const parkDeadline = Date.now() + 10_000;
        while (!existsSync(parkedMarker)) {
          if (Date.now() > parkDeadline) throw new Error("the loser never reached its probe");
          await Bun.sleep(10);
        }

        // The winner: the resume that claims. Its lookup still passes
        // (the loser has claimed nothing), its claim stamps it live, and
        // its config is prepared before its spawn — the second env.jsonl
        // entry is its keyed-home child.
        const winner = await driveSession([...args, "--resume", THREAD_ID], overrideEnv(fake, isolatedHome, workdir));
        try {
          winner.send({ type: "user", text: "scenario:basic again" });
          await winner.waitFor("session_started", (event) => event.type === "session_started");
          expect(recordedHomes(fake)).toHaveLength(2);
          expect(recordedHomes(fake)[1]).toBe(keyed);

          // What the loser must not touch, while the winner is live.
          const configBefore = readFileSync(join(keyed, "config.toml"), "utf8");
          expect(configBefore).not.toContain("model_context_window = 999999");
          const inodeBefore = statSync(join(keyed, "config.toml")).ino;

          // Release the loser: probe passes, the home opens — and the
          // claim, re-judged under the writer lock against the winner's
          // live ownership, refuses session_busy.
          writeFileSync(join(parkedBin, "release"), "");
          expect(await loser.exited).toBe(78);
          expect(await loserStderr).toContain("session_busy");

          // The live session's config is byte-for-byte what its own
          // prepareConfig wrote, still the same file, and the loser never
          // spawned a child.
          expect(readFileSync(join(keyed, "config.toml"), "utf8")).toBe(configBefore);
          expect(statSync(join(keyed, "config.toml")).ino).toBe(inodeBefore);
          expect(recordedHomes(fake)).toHaveLength(2);

          winner.send({ type: "shutdown" });
          expect((await winner.exit)[0]).toBe(0);
        } finally {
          await winner.proc.kill();
        }
      } finally {
        parked.cleanup();
      }
    } finally {
      fake.cleanup();
      rmSync(isolatedHome, { recursive: true, force: true });
    }
  }, 30_000);

  test("a session that never adopted a thread id leaves no home behind", async () => {
    // The settle rule's other arm: a fresh session whose handshake never
    // completes (the fake stalls the initialize) adopts no id, so its end
    // removes the home instead of settling it onto a key.
    const fake = fakeCodexEnv({ version: "codex-cli 0.159.3" });
    const isolatedHome = mkdtempSync(join(tmpdir(), "codemux-session-home-"));
    const workdir = join(isolatedHome, "work");
    mkdirSync(workdir);
    try {
      const session = await driveSession(
        [
          "session", "-a", "codex", "--no-sandbox", "--auto", "high",
          "--cwd", workdir, "--shutdown-grace", "2",
          "--pass-env", "FAKE_STATE_DIR,FAKE_CWD,FAKE_STALL_INIT",
        ],
        { ...overrideEnv(fake, isolatedHome, workdir), FAKE_STALL_INIT: "1" }
      );
      try {
        // Give the spawn a moment to make its home, then end the session
        // before any session_started can exist.
        await Bun.sleep(500);
        const homes = recordedHomes(fake);
        expect(homes).toHaveLength(1);
        expect(homes[0]?.split("/").pop()).toMatch(/^run-\d+-/);
        session.send({ type: "shutdown" });
        const [exitCode] = await session.exit;
        expect(exitCode).toBe(0);
        // Nothing survives: no run-shaped dir, no session-keyed one.
        const parent = join(isolatedHome, ".codex", ".codemux-provider");
        expect(existsSync(homes[0] as string)).toBe(false);
        expect(existsSync(parent) ? readdirSync(parent) : []).toEqual([]);
      } finally {
        await session.proc.kill();
      }
    } finally {
      fake.cleanup();
      rmSync(isolatedHome, { recursive: true, force: true });
    }
  }, 30_000);
});
