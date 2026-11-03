/**
 * The --keep-env exemption for session spawns under --sandbox-scrub-env
 * (split from tests/session-cli.test.ts): the scode preflight and the
 * kept-name set, or the start refusal on a scode without it.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakeBinaryEnv, runCli } from "./helpers/cli.js";
import { FAKE, FAKE_KIMI, driveSession } from "./helpers/session-cli.js";

describe("CLI - session keep-env under --sandbox-scrub-env (review al2, correctness 1)", () => {
  // The run path's --keep-env exemption (0.12.0) was wired only into
  // launchRunRequest; session spawns went through spawnSessionChild with
  // no keepEnv at all, so an override session under --sandbox-scrub-env
  // would run every turn with its only credential scrubbed. Both outcomes
  // now, run-path parity: the kept-name set on a supporting scode, the
  // pre-start refusal (the run path's message verbatim, key never echoed)
  // on one without — kimi (turn-per-process, env rebuilt per turn) and
  // claude (long-lived child, env built once) alike.

  /** The fake scode + harness pair: the scode stub answers the version
   * gate (createFakeBinaryEnv's preamble), serves either --help shape, and
   * execs the command unchanged after recording its argv; the harness
   * wrapper is the scenario fake (kimi's version probe answered by the
   * wrapper; fake-claude-session answers --version itself). */
  function fakeScodeSessionEnv(
    harness: "kimi" | "claude" | "zai",
    harnessScript: string,
    keepEnvHelp: boolean,
    argvFile: string
  ): { env: Record<string, string>; cleanup: () => void } {
    const help = keepEnvHelp
      ? "printf 'Usage: scode [options] command\\n  --keep-env NAME[,NAME...]  keep named variables under --scrub-env\\n'; exit 0"
      : "printf 'Usage: scode [options] command\\n'; exit 0";
    const preamble =
      harness === "kimi"
        ? `if [ "$1" = "--version" ]; then printf '0.31.1\\n'; exit 0; fi\n`
        : "";
    return createFakeBinaryEnv({
      // Appends: a session spawns through scode once per turn (kimi) or
      // once for the long-lived child, and the whole history is what the
      // assertions read.
      scode: `if [ "$1" = "--help" ]; then ${help}; fi\nprintf '%s\\n' "$@" >> '${argvFile}'\nwhile [ "$1" != "--" ]; do shift; done\nshift\nexec "$@"`,
      // zai runs the claude binary.
      [harness === "zai" ? "claude" : harness]: `${preamble}exec bun '${harnessScript}' "$@"`,
    });
  }

  /** The recorded scode argv as a flat line list (the --keep-env value is
   * its own argv element, so its own line). */
  const scodeArgvLines = (argvFile: string): string[] =>
    readFileSync(argvFile, "utf8").split("\n").filter((line) => line !== "");

  test("the override session's start preflight probes scode with the launch environment, never an empty one (al14)", async () => {
    // The blocker, reproduced exactly: the installed scode refuses to run
    // without HOME, so a probe whose environment is empty answers
    // "unprobeable" — and before al14 the session start gate probed
    // exactly that way (buildSandboxEnv of nothing), refusing valid
    // override sessions before anything launched with "could not probe
    // the installed scode". The probe now runs with the environment the
    // session's children spawn with — the adapter's standing environment
    // through buildExecutionEnv, HOME and PATH included — and the scode
    // resolves through that environment's PATH, the same resolver the
    // run runner and every session spawn use, so the preflight judges
    // the binary the launches will run.
    const isolatedHome = mkdtempSync(join(tmpdir(), "codemux-session-keepenv-"));
    const workdir = join(isolatedHome, "work");
    const stateDir = mkdtempSync(join(tmpdir(), "session-cli-state-"));
    const argvFile = join(stateDir, "scode-argv.txt");
    mkdirSync(workdir);
    // The fake scode's --help fails without HOME — the installed scode's
    // own empty-env failure shape — and documents --keep-env with it.
    const fake = createFakeBinaryEnv({
      scode:
        `if [ "$1" = "--help" ]; then if [ -z "$HOME" ]; then exit 1; fi; ` +
        `printf 'Usage: scode [options] command\\n  --keep-env NAME[,NAME...]  keep named variables under --scrub-env\\n'; exit 0; fi\n` +
        `printf '%s\\n' "$@" >> '${argvFile}'\nwhile [ "$1" != "--" ]; do shift; done\nshift\nexec "$@"`,
      kimi: `if [ "$1" = "--version" ]; then printf '0.31.1\\n'; exit 0; fi\nexec bun '${FAKE_KIMI}' "$@"`,
    });
    try {
      const session = await driveSession(
        [
          "session", "-a", "kimi", "--sandbox", "--sandbox-scrub-env",
          "--auto", "high", "--cwd", workdir, "--shutdown-grace", "2",
          "--pass-env", "FAKE_STATE_DIR",
        ],
        {
          HOME: isolatedHome,
          XDG_CONFIG_HOME: join(isolatedHome, ".config"),
          FAKE_STATE_DIR: stateDir,
          ...fake.env,
          CODEMUX_KIMI_PROVIDER_BASE_URL: "http://127.0.0.1:9/v1",
          CODEMUX_KIMI_PROVIDER_API_KEY: "e2e-key-do-not-print",
          CODEMUX_KIMI_PROVIDER_MODEL: "clawvm-qwen32b-coder",
        }
      );
      try {
        // Before al14 this spawn exited 1 before any event: the preflight
        // probed with an empty environment, the HOME-dependent scode
        // refused to answer, and the session was refused as unprobeable.
        // The deferred-identity model: the first turn's closing hint is
        // what announces session_started.
        session.send({ type: "user", text: "scenario:basic one" });
        const started = await session.waitFor(
          "session_started",
          (event) => event.type === "session_started"
        );
        expect(started.agent).toBe("kimi");
        const completed = await session.waitFor(
          "turn_completed",
          (event) => event.type === "turn_completed"
        );
        expect(completed.finish).toBe("end");
        session.send({ type: "shutdown" });
        const [exitCode] = await session.exit;
        expect(exitCode).toBe(0);
        // No probe refusal on stderr, and the override's key never there.
        const stderrText = await new Response(
          session.proc.stderr as ReadableStream<Uint8Array>
        ).text();
        expect(stderrText).not.toContain("could not probe");
        expect(stderrText).not.toContain("e2e-key-do-not-print");
        // The turn's spawn went through scode with the scrub and the
        // exemption — the probe's --help exits before the record.
        const lines = scodeArgvLines(argvFile);
        expect(lines).toContain("--scrub-env");
        expect(lines).toContain("--keep-env");
      } finally {
        await session.proc.kill();
      }
    } finally {
      fake.cleanup();
      rmSync(isolatedHome, { recursive: true, force: true });
      rmSync(stateDir, { recursive: true, force: true });
    }
  }, 30_000);

  test("preflight and turn probes include provider credentials from getRunEnv (al39)", async () => {
    const isolatedHome = mkdtempSync(join(tmpdir(), "codemux-session-preflight-"));
    const workdir = join(isolatedHome, "work");
    const stateDir = join(isolatedHome, "state");
    mkdirSync(workdir);
    mkdirSync(stateDir);
    const probeFile = join(stateDir, "probes.txt");
    const fake = createFakeBinaryEnv({
      scode:
        `if [ "$1" = "--help" ]; then\n` +
        `  [ "$KIMI_MODEL_API_KEY" = "preflight-test-key" ] || exit 1\n` +
        `  printf 'credential-present\\n' >> '${probeFile}'\n` +
        `  printf 'Usage: scode [options] command\\n  --keep-env NAME[,NAME...]\\n'; exit 0\nfi\n` +
        `[ "$KIMI_MODEL_API_KEY" = "preflight-test-key" ] || exit 1\n` +
        `while [ "$1" != "--" ]; do shift; done\nshift\nexec "$@"`,
      kimi: `if [ "$1" = "--version" ]; then printf '0.31.1\\n'; exit 0; fi\nexec bun '${FAKE_KIMI}' "$@"`,
    });
    try {
      const session = await driveSession([
        "session", "-a", "kimi", "--sandbox", "--sandbox-scrub-env",
        "--auto", "high", "--cwd", workdir, "--shutdown-grace", "2",
        "--pass-env", "FAKE_STATE_DIR",
      ], {
        ...fake.env, HOME: isolatedHome, XDG_CONFIG_HOME: join(isolatedHome, ".config"),
        FAKE_STATE_DIR: stateDir,
        CODEMUX_KIMI_PROVIDER_BASE_URL: "http://127.0.0.1:9/v1",
        CODEMUX_KIMI_PROVIDER_API_KEY: "preflight-test-key",
        CODEMUX_KIMI_PROVIDER_MODEL: "test-model",
      });
      try {
        session.send({ type: "user", text: "scenario:basic one" });
        const completed = await session.waitFor("turn_completed", (event) => event.type === "turn_completed");
        expect(completed.finish).toBe("end");
        session.send({ type: "shutdown" });
        expect((await session.exit)[0]).toBe(0);
        // Identical environments let the turn reuse the successful preflight.
        expect(readFileSync(probeFile, "utf8").trim().split("\n")).toEqual(["credential-present"]);
        const stderr = await new Response(session.proc.stderr as ReadableStream<Uint8Array>).text();
        expect(stderr).not.toContain("could not probe");
        expect(stderr).not.toContain("preflight-test-key");
      } finally {
        session.proc.kill();
      }
    } finally {
      fake.cleanup();
      rmSync(isolatedHome, { recursive: true, force: true });
    }
  }, 30_000);

  test("a kimi override session under scrub keeps its injected names on every turn spawn", async () => {
    const isolatedHome = mkdtempSync(join(tmpdir(), "codemux-session-keepenv-"));
    const workdir = join(isolatedHome, "work");
    const stateDir = mkdtempSync(join(tmpdir(), "session-cli-state-"));
    const argvFile = join(stateDir, "scode-argv.txt");
    mkdirSync(workdir);
    const fake = fakeScodeSessionEnv("kimi", FAKE_KIMI, true, argvFile);
    try {
      const session = await driveSession(
        [
          "session", "-a", "kimi", "--sandbox", "--sandbox-scrub-env",
          "--auto", "high", "--cwd", workdir, "--shutdown-grace", "2",
          "--pass-env", "FAKE_STATE_DIR",
        ],
        {
          HOME: isolatedHome,
          XDG_CONFIG_HOME: join(isolatedHome, ".config"),
          FAKE_STATE_DIR: stateDir,
          ...fake.env,
          CODEMUX_KIMI_PROVIDER_BASE_URL: "http://127.0.0.1:9/v1",
          CODEMUX_KIMI_PROVIDER_API_KEY: "e2e-key-do-not-print",
          CODEMUX_KIMI_PROVIDER_MODEL: "clawvm-qwen32b-coder",
        }
      );
      try {
        session.send({ type: "user", text: "scenario:basic one" });
        await session.waitFor("turn_completed", (event) => event.type === "turn_completed");
        session.send({ type: "user", text: "scenario:basic two" });
        await session.waitFor(
          "the second turn",
          (event) =>
            event.type === "turn_completed" &&
            session.events.filter((done) => done.type === "turn_completed").length >= 2
        );
        session.send({ type: "shutdown" });
        const [exitCode] = await session.exit;
        expect(exitCode).toBe(0);
        // The override's key is never on the session's own stderr.
        const stderrText = await new Response(session.proc.stderr as ReadableStream<Uint8Array>).text();
        expect(stderrText).not.toContain("e2e-key-do-not-print");
      } finally {
        await session.proc.kill();
      }

      // Every turn spawn went through scode with the scrub AND the
      // exemption: exactly the adapter's injected name set, on both turns
      // (the probe's --help exits before the record, so the two recorded
      // argvs are the two turn spawns).
      const lines = scodeArgvLines(argvFile);
      expect(lines).toContain("--scrub-env");
      const keepAt = lines.indexOf("--keep-env");
      expect(keepAt).toBeGreaterThan(-1);
      expect(lines[keepAt + 1]!.split(",").sort()).toEqual([
        "KIMI_MODEL_API_KEY",
        "KIMI_MODEL_BASE_URL",
        "KIMI_MODEL_NAME",
        "KIMI_MODEL_PROVIDER_TYPE",
      ]);
      expect(lines.filter((line) => line === "--keep-env")).toHaveLength(2);
    } finally {
      fake.cleanup();
      rmSync(isolatedHome, { recursive: true, force: true });
      rmSync(stateDir, { recursive: true, force: true });
    }
  }, 30_000);

  test("a claude override session under scrub keeps its injected names on the long-lived child", async () => {
    const isolatedHome = mkdtempSync(join(tmpdir(), "codemux-session-keepenv-"));
    const workdir = join(isolatedHome, "work");
    const stateDir = mkdtempSync(join(tmpdir(), "session-cli-state-"));
    const argvFile = join(stateDir, "scode-argv.txt");
    mkdirSync(workdir);
    const fake = fakeScodeSessionEnv("claude", FAKE, true, argvFile);
    try {
      const session = await driveSession(
        [
          "session", "-a", "claude", "--sandbox", "--sandbox-scrub-env",
          "--auto", "high", "--cwd", workdir, "--shutdown-grace", "2",
          "--pass-env", "FAKE_STATE_DIR,FAKE_CWD",
        ],
        {
          HOME: isolatedHome,
          XDG_CONFIG_HOME: join(isolatedHome, ".config"),
          FAKE_STATE_DIR: stateDir,
          FAKE_CWD: workdir,
          ...fake.env,
          CODEMUX_CLAUDE_PROVIDER_BASE_URL: "http://127.0.0.1:9/v1",
          CODEMUX_CLAUDE_PROVIDER_API_KEY: "e2e-key-do-not-print",
          CODEMUX_CLAUDE_PROVIDER_MODEL: "clawvm-qwen32b-coder",
        }
      );
      try {
        session.send({ type: "user", text: "scenario:basic hello" });
        await session.waitFor("turn_completed", (event) => event.type === "turn_completed");
        session.send({ type: "shutdown" });
        const [exitCode] = await session.exit;
        expect(exitCode).toBe(0);
        const stderrText = await new Response(session.proc.stderr as ReadableStream<Uint8Array>).text();
        expect(stderrText).not.toContain("e2e-key-do-not-print");
      } finally {
        await session.proc.kill();
      }

      // One long-lived child through scode, carrying the adapter's whole
      // override env — the getEnv() name set the run path exempts.
      const lines = scodeArgvLines(argvFile);
      expect(lines).toContain("--scrub-env");
      const keepAt = lines.indexOf("--keep-env");
      expect(keepAt).toBeGreaterThan(-1);
      expect(lines[keepAt + 1]!.split(",").sort()).toEqual([
        "ANTHROPIC_AUTH_TOKEN",
        "ANTHROPIC_BASE_URL",
        "ANTHROPIC_DEFAULT_HAIKU_MODEL",
        "ANTHROPIC_DEFAULT_OPUS_MODEL",
        "ANTHROPIC_DEFAULT_SONNET_MODEL",
        "ANTHROPIC_SMALL_FAST_MODEL",
        "CLAUDE_CODE_SUBPROCESS_ENV_SCRUB",
      ]);
      expect(lines.filter((line) => line === "--keep-env")).toHaveLength(1);
    } finally {
      fake.cleanup();
      rmSync(isolatedHome, { recursive: true, force: true });
      rmSync(stateDir, { recursive: true, force: true });
    }
  }, 30_000);

  test("a session carrying an injected credential refuses to start under scrub on a scode without --keep-env (kimi, claude, zai)", async () => {
    // Turn-per-process and long-lived alike: the refusal is at START, with
    // the run path's message verbatim — the run path's own rule (the
    // override's key is the session's only credential), not a per-turn
    // death after the first input was acked. No child ever spawns, and
    // the key never appears on stderr.
    const cases: Array<{ agent: "kimi" | "claude" | "zai"; script: string; env: Record<string, string> }> = [
      {
        agent: "kimi",
        script: FAKE_KIMI,
        env: {
          CODEMUX_KIMI_PROVIDER_BASE_URL: "http://127.0.0.1:9/v1",
          CODEMUX_KIMI_PROVIDER_API_KEY: "e2e-key-do-not-print",
          CODEMUX_KIMI_PROVIDER_MODEL: "clawvm-qwen32b-coder",
        },
      },
      {
        // No override: zai injects its gateway token on its own, and the
        // start gate applies the run path's credential rule to it
        // (review 7b209e37, contracts-2), not only to overrides.
        agent: "zai",
        script: FAKE,
        env: { ZAI_API_KEY: "e2e-key-do-not-print" },
      },
      {
        agent: "claude",
        script: FAKE,
        env: {
          CODEMUX_CLAUDE_PROVIDER_BASE_URL: "http://127.0.0.1:9/v1",
          CODEMUX_CLAUDE_PROVIDER_API_KEY: "e2e-key-do-not-print",
          CODEMUX_CLAUDE_PROVIDER_MODEL: "clawvm-qwen32b-coder",
        },
      },
    ];
    for (const { agent, script, env } of cases) {
      const isolatedHome = mkdtempSync(join(tmpdir(), "codemux-session-keepenv-ref-"));
      const workdir = join(isolatedHome, "work");
      const stateDir = mkdtempSync(join(tmpdir(), "session-cli-state-"));
      const argvFile = join(stateDir, "scode-argv.txt");
      mkdirSync(workdir);
      const fake = fakeScodeSessionEnv(agent, script, false, argvFile);
      try {
        const { stderr, exitCode } = await runCli(
          [
            "session", "-a", agent, "--sandbox", "--sandbox-scrub-env",
            "--auto", "high", "--cwd", workdir,
          ],
          { ...fake.env, ...env }
        );
        expect(exitCode, `${agent}: ${stderr}`).toBe(1);
        expect(stderr).toContain("no --keep-env");
        expect(stderr).toContain("--sandbox-scrub-env");
        expect(stderr).not.toContain("e2e-key-do-not-print");
        // Nothing ever spawned: no scode invocation reached the command
        // record — under --sandbox every session spawn rides scode, so
        // the empty record is the proof no harness turn ran. (The fake
        // harness's own argv.jsonl is no proof here: this test never
        // sets FAKE_STATE_DIR, so the fake would record under its /tmp
        // default, never in stateDir — asserting on stateDir's copy
        // would be inert.)
        expect(existsSync(argvFile)).toBe(false);
      } finally {
        fake.cleanup();
        rmSync(isolatedHome, { recursive: true, force: true });
        rmSync(stateDir, { recursive: true, force: true });
      }
    }
  }, 30_000);
});
