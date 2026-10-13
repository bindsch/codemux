import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createFakeBinaryEnv,
  minimalPath,
  runCli,
} from "./helpers/cli.js";

describe("CLI - Run validation", () => {
  test("run without prompt shows error", async () => {
    const { stderr, exitCode } = await runCli(
      ["run"],
      { PATH: minimalPath() }
    );
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("No prompt provided");
  });

  test("run with unknown agent shows error", async () => {
    const { stderr, exitCode } = await runCli(["run", "-a", "unknown", "-p", "test"]);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("Unknown agent");
  });

  test("run with unavailable agent shows error", async () => {
    const { stderr, exitCode } = await runCli(
      ["run", "--no-sandbox", "--auto", "high", "-a", "goose", "-p", "test"],
      { PATH: minimalPath() }
    );
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("not installed");
  });

  test("run -a shows valid agents in error", async () => {
    const { stderr } = await runCli(["run", "-a", "invalid", "-p", "test"]);
    expect(stderr).toContain("claude");
    expect(stderr).toContain("droid");
    expect(stderr).toContain("codex");
  });

  test("run with invalid autonomy level shows error", async () => {
    const { stderr, exitCode } = await runCli(["run", "--auto", "banana", "-p", "test"]);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("Invalid value 'banana' for --auto");
    expect(stderr).toContain("read-only");
  });

  test("run with invalid effort level shows error", async () => {
    const { stderr, exitCode } = await runCli(["run", "--effort", "extreme", "-p", "test"]);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("Invalid value 'extreme' for --effort");
    expect(stderr).toContain("none, minimal, low, medium, high, xhigh, max, ultra");
  });

  test("run with invalid sandbox trust level shows error", async () => {
    const { stderr, exitCode } = await runCli(["run", "--sandbox-trust", "danger", "-p", "test"]);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("Invalid value 'danger' for --sandbox-trust");
    expect(stderr).toContain("trusted, standard, untrusted");
  });

  test("Gemini read-only mode requires a durable outer sandbox", async () => {
    // Opting out of the default boundary is what makes read-only unenforceable.
    const { stderr, exitCode } = await runCli(
      ["run", "-a", "gemini", "--no-sandbox", "--auto", "read-only", "-p", "test"],
      { PATH: minimalPath() }
    );
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain(
      "gemini cannot enforce 'read-only' autonomy without --sandbox"
    );
  });

  test("run forwards Goose model selection through its environment", async () => {
    const fake = createFakeBinaryEnv({
      goose: `printf '%s' "\${GOOSE_MODEL-unset}"`,
    });
    try {
      const { stdout, stderr, exitCode } = await runCli(
        ["run", "--no-sandbox", "--auto", "high", "-a", "goose", "-m", "provider/model", "-p", "test"],
        fake.env
      );
      expect(exitCode).toBe(0);
      expect(stdout).toBe("provider/model");
      expect(stderr).not.toContain("does not support model selection");
    } finally {
      fake.cleanup();
    }
  });

  test("passes only explicitly granted sensitive variables and blocks loaders", async () => {
    const fake = createFakeBinaryEnv({
      claude: `printf '%s|%s|%s' "\${INTERNAL_TOKEN-unset}" "\${BASH_ENV-unset}" "\${CODEMUX_PASSTHROUGH_ENV-unset}"`,
    });
    try {
      const result = await runCli(
        ["run", "--no-sandbox", "--auto", "high", "-a", "claude", "--pass-env", "INTERNAL_TOKEN", "-p", "test"],
        {
          ...fake.env,
          INTERNAL_TOKEN: "allowed",
          BASH_ENV: "/repo/owned.sh",
          CODEMUX_PASSTHROUGH_ENV: "BASH_ENV",
        }
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("allowed|unset|unset");
    } finally {
      fake.cleanup();
    }
  });

  test("legacy environment grants cannot authorize secret passthrough", async () => {
    const fake = createFakeBinaryEnv({
      claude: `printf '%s' "\${INTERNAL_TOKEN-unset}"`,
    });
    try {
      const result = await runCli(
        ["run", "-a", "claude", "--no-sandbox", "--auto", "high", "-p", "test"],
        {
        ...fake.env,
        INTERNAL_TOKEN: "must-not-pass",
        CODEMUX_PASSTHROUGH_ENV: "INTERNAL_TOKEN",
        }
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("unset");
    } finally {
      fake.cleanup();
    }
  });

  test("Playwright MCP requires an explicit sandboxed CLI grant", async () => {
    const fake = createFakeBinaryEnv({
      claude: "exit 0",
      scode: "printf '%s\\n' \"$@\"",
      "playwright-mcp": "exit 0",
    });
    try {
      const result = await runCli([
        "run",
        "-a",
        "claude",
        "--sandbox",
        "--enable-playwright-mcp",
        "-p",
        "test",
      ], fake.env);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("--mcp-config");
      // The sandbox is on by default now, so the rejection has to be provoked
      // by opting out explicitly.
      const rejected = await runCli([
        "run",
        "-a",
        "claude",
        "--no-sandbox",
        "--auto",
        "high",
        "--enable-playwright-mcp",
        "-p",
        "test",
      ], fake.env);
      expect(rejected.exitCode).not.toBe(0);
      expect(rejected.stderr).toContain("requires --sandbox");
    } finally {
      fake.cleanup();
    }
  });

  test("a provider override's injected environment rides scode's --keep-env exemption", async () => {
    // scode 0.6.0's --scrub-env strips by pattern, credentials included;
    // the environment codemux itself injected for the override (the
    // gateway pair, the pinned model tiers, the subprocess scrub pin)
    // must ride the --keep-env exemption, and the run must still reply.
    const argvDir = mkdtempSync(join(tmpdir(), "codemux-keepenv-e2e-"));
    const argvFile = join(argvDir, "scode-argv.txt");
    const fake = createFakeBinaryEnv({
      claude: `
if [ "$1" = "--version" ]; then printf '2.1.280\\n'; exit 0; fi
printf 'OK'
`,
      scode: `
if [ "$1" = "--help" ]; then printf 'Usage: scode [options] command\\n  --keep-env NAME[,NAME...]  keep named variables under --scrub-env\\n'; exit 0; fi
printf '%s\\n' "$@" > ${argvFile}
while [ "$1" != "--" ]; do shift; done
shift
exec "$@"
`,
    });
    try {
      const { stdout, stderr, exitCode } = await runCli(
        [
          "run",
          "-a",
          "claude",
          "--sandbox-scrub-env",
          "--auto",
          "high",
          "-p",
          "Reply with exactly the word OK",
        ],
        {
          ...fake.env,
          CODEMUX_CLAUDE_PROVIDER_BASE_URL: "https://override.example/v1",
          CODEMUX_CLAUDE_PROVIDER_API_KEY: "e2e-keepenv-key",
          CODEMUX_CLAUDE_PROVIDER_MODEL: "claw-32b",
        }
      );
      expect(exitCode).toBe(0);
      expect(stdout).toBe("OK");
      const argv = readFileSync(argvFile, "utf8").split("\n");
      expect(argv).toContain("--scrub-env");
      const keepIndex = argv.indexOf("--keep-env");
      expect(keepIndex).toBeGreaterThan(-1);
      // Exactly what the adapter injected for this run, nothing ambient.
      expect(argv[keepIndex + 1]!.split(",").sort()).toEqual([
        "ANTHROPIC_BASE_URL",
        "ANTHROPIC_DEFAULT_HAIKU_MODEL",
        "ANTHROPIC_DEFAULT_OPUS_MODEL",
        "ANTHROPIC_DEFAULT_SONNET_MODEL",
        "ANTHROPIC_SMALL_FAST_MODEL",
        "ANTHROPIC_AUTH_TOKEN",
        "CLAUDE_CODE_SUBPROCESS_ENV_SCRUB",
      ].sort());
      expect(stderr).not.toContain("e2e-keepenv-key");
    } finally {
      fake.cleanup();
      rmSync(argvDir, { recursive: true, force: true });
    }
  });

  test("an override under --sandbox-trust untrusted rides the --keep-env exemption (al21)", async () => {
    // scode's untrusted preset implies --scrub-env (0.6.0 --help), so the
    // credentials codemux injected are stripped there exactly as under
    // --sandbox-scrub-env. Before al21 the exemption keyed on scrubEnv
    // alone: this run launched with no --keep-env and its only credential
    // scrubbed away by the trust preset.
    const argvDir = mkdtempSync(join(tmpdir(), "codemux-keepenv-untrusted-"));
    const argvFile = join(argvDir, "scode-argv.txt");
    const fake = createFakeBinaryEnv({
      claude: `
if [ "$1" = "--version" ]; then printf '2.1.280\\n'; exit 0; fi
printf 'OK'
`,
      scode: `
if [ "$1" = "--help" ]; then printf 'Usage: scode [options] command\\n  --keep-env NAME[,NAME...]  keep named variables under --scrub-env\\n'; exit 0; fi
printf '%s\\n' "$@" > ${argvFile}
while [ "$1" != "--" ]; do shift; done
shift
exec "$@"
`,
    });
    try {
      const { stdout, stderr, exitCode } = await runCli(
        [
          "run",
          "-a",
          "claude",
          "--sandbox-trust",
          "untrusted",
          "--auto",
          "high",
          "-p",
          "Reply with exactly the word OK",
        ],
        {
          ...fake.env,
          CODEMUX_CLAUDE_PROVIDER_BASE_URL: "https://override.example/v1",
          CODEMUX_CLAUDE_PROVIDER_API_KEY: "e2e-untrusted-key",
          CODEMUX_CLAUDE_PROVIDER_MODEL: "claw-32b",
        }
      );
      expect(exitCode).toBe(0);
      expect(stdout).toBe("OK");
      const argv = readFileSync(argvFile, "utf8").split("\n");
      // The trust spelling the operator asked for, with the ro the preset
      // forces regardless of --auto high.
      const trustIndex = argv.indexOf("--trust");
      expect(trustIndex).toBeGreaterThan(-1);
      expect(argv[trustIndex + 1]).toBe("untrusted");
      expect(argv).toContain("--ro");
      // The exemption rides the implied scrub: the same name set the
      // explicit --sandbox-scrub-env run carries.
      const keepIndex = argv.indexOf("--keep-env");
      expect(keepIndex).toBeGreaterThan(-1);
      expect(argv[keepIndex + 1]!.split(",").sort()).toEqual([
        "ANTHROPIC_BASE_URL",
        "ANTHROPIC_DEFAULT_HAIKU_MODEL",
        "ANTHROPIC_DEFAULT_OPUS_MODEL",
        "ANTHROPIC_DEFAULT_SONNET_MODEL",
        "ANTHROPIC_SMALL_FAST_MODEL",
        "ANTHROPIC_AUTH_TOKEN",
        "CLAUDE_CODE_SUBPROCESS_ENV_SCRUB",
      ].sort());
      expect(stderr).not.toContain("e2e-untrusted-key");
    } finally {
      fake.cleanup();
      rmSync(argvDir, { recursive: true, force: true });
    }
  });

  test("an override under --sandbox-trust untrusted refuses on a scode without --keep-env (al21)", async () => {
    // The untrusted preset scrubs, so the override's key needs the
    // exemption and a scode without it refuses — naming the trust
    // spelling, never --sandbox-scrub-env, which this argv never passed
    // (the remedy must match the operator's own flags).
    const argvDir = mkdtempSync(join(tmpdir(), "codemux-keepenv-untrusted-refuse-"));
    const argvFile = join(argvDir, "scode-argv.txt");
    const fake = createFakeBinaryEnv({
      claude: "printf 'OK'",
      scode: `
if [ "$1" = "--help" ]; then printf 'Usage: scode [options] command\\n'; exit 0; fi
printf '%s\\n' "$@" > ${argvFile}
while [ "$1" != "--" ]; do shift; done
shift
exec "$@"
`,
    });
    try {
      const { stdout, stderr, exitCode } = await runCli(
        [
          "run",
          "-a",
          "claude",
          "--sandbox-trust",
          "untrusted",
          "--auto",
          "high",
          "-p",
          "Reply with exactly the word OK",
        ],
        {
          ...fake.env,
          CODEMUX_CLAUDE_PROVIDER_BASE_URL: "https://override.example/v1",
          CODEMUX_CLAUDE_PROVIDER_API_KEY: "e2e-untrusted-key",
          CODEMUX_CLAUDE_PROVIDER_MODEL: "claw-32b",
        }
      );
      expect(exitCode).toBe(1);
      expect(stdout).toBe("");
      expect(stderr).toContain("no --keep-env");
      expect(stderr).toContain("--sandbox-trust untrusted");
      // Never names the flag this argv did not pass.
      expect(stderr).not.toContain("--sandbox-scrub-env");
      // Refused before the spawn: the --version and --help probes are the
      // only scode invocations.
      expect(existsSync(argvFile)).toBe(false);
      expect(stderr).not.toContain("e2e-untrusted-key");
    } finally {
      fake.cleanup();
      rmSync(argvDir, { recursive: true, force: true });
    }
  });

  test("an override under both --sandbox-scrub-env and --sandbox-trust untrusted refuses naming both in the remedy (al23)", async () => {
    // The correctness minor: with both scrub spellings active the refusal
    // once recommended dropping either one — but each alone keeps the
    // scrub on, so following either suggestion repeated the refusal. The
    // remedy must say to remove both flags (or upgrade scode), and the
    // refusal still never carries the key.
    const argvDir = mkdtempSync(join(tmpdir(), "codemux-keepenv-both-refuse-"));
    const argvFile = join(argvDir, "scode-argv.txt");
    const fake = createFakeBinaryEnv({
      claude: "printf 'OK'",
      scode: `
if [ "$1" = "--help" ]; then printf 'Usage: scode [options]\\n'; exit 0; fi
printf '%s\\n' "$@" > ${argvFile}
while [ "$1" != "--" ]; do shift; done
shift
exec "$@"
`,
    });
    try {
      const { stdout, stderr, exitCode } = await runCli(
        [
          "run",
          "-a",
          "claude",
          "--sandbox-scrub-env",
          "--sandbox-trust",
          "untrusted",
          "--auto",
          "high",
          "-p",
          "Reply with exactly the word OK",
        ],
        {
          ...fake.env,
          CODEMUX_CLAUDE_PROVIDER_BASE_URL: "https://override.example/v1",
          CODEMUX_CLAUDE_PROVIDER_API_KEY: "e2e-both-key",
          CODEMUX_CLAUDE_PROVIDER_MODEL: "claw-32b",
        }
      );
      expect(exitCode).toBe(1);
      expect(stdout).toBe("");
      expect(stderr).toContain("no --keep-env");
      // The cause names both spellings; the remedy names both too — never
      // an "or" that would leave the other scrubbing.
      expect(stderr).toContain("--sandbox-scrub-env under --sandbox-trust untrusted");
      expect(stderr).toContain(
        "drop both --sandbox-scrub-env and --sandbox-trust untrusted"
      );
      expect(stderr).not.toContain("drop --sandbox-scrub-env or --sandbox-trust untrusted");
      // Refused before the spawn: the --version and --help probes are the
      // only scode invocations, and the key never appears.
      expect(existsSync(argvFile)).toBe(false);
      expect(stderr).not.toContain("e2e-both-key");
    } finally {
      fake.cleanup();
      rmSync(argvDir, { recursive: true, force: true });
    }
  });

  test("an override under --sandbox-scrub-env refuses on a scode without --keep-env", async () => {
    // The override's key is the run's only credential (the operator's own
    // was omitted on purpose), so a sandbox that cannot exempt it refuses
    // the launch instead of running it stripped. The fixture's scode —
    // version 0.2.0, its --help documenting no --keep-env — is exactly
    // such a scode.
    const argvDir = mkdtempSync(join(tmpdir(), "codemux-keepenv-refuse-"));
    const argvFile = join(argvDir, "scode-argv.txt");
    const fake = createFakeBinaryEnv({
      claude: "printf 'OK'",
      scode: `
if [ "$1" = "--help" ]; then printf 'Usage: scode [options] command\\n'; exit 0; fi
printf '%s\\n' "$@" > ${argvFile}
while [ "$1" != "--" ]; do shift; done
shift
exec "$@"
`,
    });
    try {
      const { stdout, stderr, exitCode } = await runCli(
        [
          "run",
          "-a",
          "claude",
          "--sandbox-scrub-env",
          "--auto",
          "high",
          "-p",
          "Reply with exactly the word OK",
        ],
        {
          ...fake.env,
          CODEMUX_CLAUDE_PROVIDER_BASE_URL: "https://override.example/v1",
          CODEMUX_CLAUDE_PROVIDER_API_KEY: "e2e-keepenv-key",
          CODEMUX_CLAUDE_PROVIDER_MODEL: "claw-32b",
        }
      );
      expect(exitCode).toBe(1);
      expect(stdout).toBe("");
      expect(stderr).toContain("no --keep-env");
      expect(stderr).toContain("--sandbox-scrub-env");
      // Refused before the spawn: the --version and --help probes are the
      // only scode invocations, and neither reached the command.
      expect(existsSync(argvFile)).toBe(false);
      expect(stderr).not.toContain("e2e-keepenv-key");
    } finally {
      fake.cleanup();
      rmSync(argvDir, { recursive: true, force: true });
    }
  });

  test("a zai run under --sandbox-scrub-env refuses on a scode without --keep-env (al11 re-review)", async () => {
    // zai injects its gateway credential (ANTHROPIC_AUTH_TOKEN from
    // ZAI_API_KEY) with no provider override to mark it, so the run
    // path's keepEnvRequired — override presence alone — stayed false and
    // a scode without --keep-env dropped the exemption and launched with
    // the scrub stripping the run's only credential (round al11's
    // re-review, edges 1). The requirement now keys on the injected
    // names themselves: a credential-shaped name refuses exactly as an
    // override's key does.
    const argvDir = mkdtempSync(join(tmpdir(), "codemux-keepenv-zai-"));
    const argvFile = join(argvDir, "scode-argv.txt");
    const fake = createFakeBinaryEnv({
      claude: `
if [ "$1" = "--version" ]; then printf '2.1.280\\n'; exit 0; fi
printf 'OK'
`,
      scode: `
if [ "$1" = "--help" ]; then printf 'Usage: scode [options] command\\n'; exit 0; fi
printf '%s\\n' "$@" > ${argvFile}
while [ "$1" != "--" ]; do shift; done
shift
exec "$@"
`,
    });
    try {
      const { stdout, stderr, exitCode } = await runCli(
        [
          "run",
          "-a",
          "zai",
          "--sandbox-scrub-env",
          "--auto",
          "high",
          "-p",
          "Reply with exactly the word OK",
        ],
        {
          ...fake.env,
          ZAI_API_KEY: "e2e-zai-keepenv-key",
        }
      );
      expect(exitCode).toBe(1);
      expect(stdout).toBe("");
      expect(stderr).toContain("no --keep-env");
      expect(stderr).toContain("--sandbox-scrub-env");
      // The refusal names both remedies by name: the release that carries
      // the flag and the flag itself, so an operator on 0.5.0 knows the
      // upgrade target without reading the docs (round al12 — zai is an
      // injected-credential route, and the README says so).
      expect(stderr).toContain("0.6.0");
      expect(stderr).toContain("--keep-env");
      // Refused before the spawn: the --version and --help probes are the
      // only scode invocations.
      expect(existsSync(argvFile)).toBe(false);
      expect(stderr).not.toContain("e2e-zai-keepenv-key");
    } finally {
      fake.cleanup();
      rmSync(argvDir, { recursive: true, force: true });
    }
  });

  test("a tui under a provider override rides the same --keep-env exemption (al7)", async () => {
    // The run and session paths gained the exemption in 0.12.0; the tui
    // path still passed --scrub-env through without it, so an override
    // tui ran with its only credential scrubbed away. The tui launch now
    // attaches the exemption over the adapter's injected names — the
    // standing getEnv() set for claude — with the same resolver, so a
    // supporting scode keeps exactly those names.
    const argvDir = mkdtempSync(join(tmpdir(), "codemux-keepenv-tui-"));
    const argvFile = join(argvDir, "scode-argv.txt");
    const fake = createFakeBinaryEnv({
      claude: `
if [ "$1" = "--version" ]; then printf '2.1.280\\n'; exit 0; fi
exit 0
`,
      scode: `
if [ "$1" = "--help" ]; then printf 'Usage: scode [options] command\\n  --keep-env NAME[,NAME...]  keep named variables under --scrub-env\\n'; exit 0; fi
printf '%s\\n' "$@" > ${argvFile}
while [ "$1" != "--" ]; do shift; done
shift
exec "$@"
`,
    });
    try {
      const { exitCode, stderr } = await runCli(
        ["tui", "-a", "claude", "--sandbox-scrub-env"],
        {
          ...fake.env,
          CODEMUX_CLAUDE_PROVIDER_BASE_URL: "https://override.example/v1",
          CODEMUX_CLAUDE_PROVIDER_API_KEY: "e2e-keepenv-key",
          CODEMUX_CLAUDE_PROVIDER_MODEL: "claw-32b",
        }
      );
      expect(exitCode).toBe(0);
      const argv = readFileSync(argvFile, "utf8").split("\n");
      expect(argv).toContain("--scrub-env");
      const keepIndex = argv.indexOf("--keep-env");
      expect(keepIndex).toBeGreaterThan(-1);
      // The adapter's standing environment for the tui child — the same
      // set a run keeps, nothing ambient.
      expect(argv[keepIndex + 1]!.split(",").sort()).toEqual([
        "ANTHROPIC_BASE_URL",
        "ANTHROPIC_DEFAULT_HAIKU_MODEL",
        "ANTHROPIC_DEFAULT_OPUS_MODEL",
        "ANTHROPIC_DEFAULT_SONNET_MODEL",
        "ANTHROPIC_SMALL_FAST_MODEL",
        "ANTHROPIC_AUTH_TOKEN",
        "CLAUDE_CODE_SUBPROCESS_ENV_SCRUB",
      ].sort());
      expect(stderr).not.toContain("e2e-keepenv-key");
    } finally {
      fake.cleanup();
      rmSync(argvDir, { recursive: true, force: true });
    }
  });

  test("a tui override under --sandbox-scrub-env refuses on a scode without --keep-env (al7)", async () => {
    // The run path's refusal, verbatim, on the tui path: the override's
    // key is the launch's only credential, so a scode that cannot exempt
    // it refuses instead of running the tui stripped. Refused before the
    // spawn — the --version and --help probes are the only scode
    // invocations.
    const argvDir = mkdtempSync(join(tmpdir(), "codemux-keepenv-tui-refuse-"));
    const argvFile = join(argvDir, "scode-argv.txt");
    const fake = createFakeBinaryEnv({
      claude: "exit 0",
      scode: `
if [ "$1" = "--help" ]; then printf 'Usage: scode [options] command\\n'; exit 0; fi
printf '%s\\n' "$@" > ${argvFile}
while [ "$1" != "--" ]; do shift; done
shift
exec "$@"
`,
    });
    try {
      const { stdout, stderr, exitCode } = await runCli(
        ["tui", "-a", "claude", "--sandbox-scrub-env"],
        {
          ...fake.env,
          CODEMUX_CLAUDE_PROVIDER_BASE_URL: "https://override.example/v1",
          CODEMUX_CLAUDE_PROVIDER_API_KEY: "e2e-keepenv-key",
          CODEMUX_CLAUDE_PROVIDER_MODEL: "claw-32b",
        }
      );
      expect(exitCode).toBe(1);
      expect(stdout).toBe("");
      expect(stderr).toContain("no --keep-env");
      expect(stderr).toContain("--sandbox-scrub-env");
      expect(existsSync(argvFile)).toBe(false);
      expect(stderr).not.toContain("e2e-keepenv-key");
    } finally {
      fake.cleanup();
      rmSync(argvDir, { recursive: true, force: true });
    }
  });

  test("run surfaces adapter errors without stack traces", async () => {
    const fake = createFakeBinaryEnv({
      claude: "exit 0",
    });
    const homeDir = mkdtempSync(join(tmpdir(), "codemux-zai-home-"));
    try {
      const { stderr, exitCode } = await runCli(
        ["run", "--no-sandbox", "--auto", "high", "-a", "zai", "-p", "test"],
        {
          ...fake.env,
          HOME: homeDir,
          ZAI_API_KEY: "",
        }
      );
      expect(exitCode).not.toBe(0);
      expect(stderr).toContain("Z.AI API key not found.");
      expect(stderr).not.toContain("at getZaiApiKey");
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
      fake.cleanup();
    }
  });

  test("run enforces its configured timeout", async () => {
    const fake = createFakeBinaryEnv({ claude: "sleep 2" });
    try {
      const { stderr, exitCode } = await runCli(
        ["run", "--no-sandbox", "--auto", "high", "-a", "claude", "-p", "test", "--timeout", "0.02"],
        fake.env
      );
      expect(exitCode).toBe(124);
      expect(stderr).toContain("timed out");
    } finally {
      fake.cleanup();
    }
  });

  test("sandbox resolves a relative cwd exactly once", async () => {
    const fake = createFakeBinaryEnv({
      claude: "exit 0",
      scode: "printf '%s\\n' \"$PWD\"; printf '%s\\n' \"$@\"",
    });
    try {
      const { stdout, exitCode } = await runCli(
        ["run", "-a", "claude", "-s", "--cwd", "tests", "-p", "test"],
        fake.env
      );
      const expected = join(import.meta.dir, "..", "tests");
      expect(exitCode).toBe(0);
      expect(stdout).toContain(expected);
      expect(stdout).not.toContain(join(expected, "tests"));
    } finally {
      fake.cleanup();
    }
  });
});

describe("CLI - Run warnings (no actual execution)", () => {
  test("effort flag on unsupported agent fails explicitly", async () => {
    const fake = createFakeBinaryEnv({ goose: "exit 0" });
    try {
      const { stderr, exitCode } = await runCli(
        ["run", "--no-sandbox", "--auto", "high", "-a", "goose", "--effort", "high", "-p", "test"],
        fake.env
      );
      expect(exitCode).not.toBe(0);
      expect(stderr).toContain("does not support reasoning effort 'high'");
    } finally {
      fake.cleanup();
    }
  });
});

describe("CLI - File input validation", () => {
  test("run with nonexistent file shows error", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "codemux-missing-file-"));
    try {
      const { stderr, exitCode } = await runCli([
        "run",
        "-f",
        join(tempDir, "missing.txt"),
      ], { PATH: minimalPath() });
      expect(exitCode).not.toBe(0);
      expect(stderr).toContain("Could not read file");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("run with file forwards file content as prompt", async () => {
    const fake = createFakeBinaryEnv({
      claude: "cat",
    });
    const tempDir = mkdtempSync(join(tmpdir(), "codemux-file-input-"));
    const promptFile = join(tempDir, "prompt.txt");
    writeFileSync(promptFile, "Prompt from file\n");

    try {
      const { stdout, exitCode } = await runCli(
        ["run", "--no-sandbox", "--auto", "high", "-a", "claude", "-f", promptFile],
        fake.env
      );
      expect(exitCode).toBe(0);
      expect(stdout).toBe("Prompt from file\n");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
      fake.cleanup();
    }
  });

  test("run rejects ambiguous prompt and file input", async () => {
    const fake = createFakeBinaryEnv({ claude: "exit 0" });
    const tempDir = mkdtempSync(join(tmpdir(), "codemux-prompt-conflict-"));
    const promptFile = join(tempDir, "prompt.txt");
    writeFileSync(promptFile, "file prompt");
    try {
      const { stderr, exitCode } = await runCli(
        ["run", "-a", "claude", "-p", "inline", "-f", promptFile],
        fake.env
      );
      expect(exitCode).not.toBe(0);
      expect(stderr).toContain("--prompt and --file cannot be used together");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
      fake.cleanup();
    }
  });
});

describe("CLI - Hermetic runs", () => {
  test("run --hermetic is refused for a harness without a verified mechanism", async () => {
    const fake = createFakeBinaryEnv({ droid: "exit 0", copilot: "exit 0" });
    try {
      const { stderr, exitCode } = await runCli(
        ["run", "-a", "droid", "--no-sandbox", "--auto", "high", "--hermetic", "-p", "test"],
        fake.env
      );
      expect(exitCode).not.toBe(0);
      expect(stderr).toContain("no verified hermetic mode");
      const tools = await runCli(
        ["run", "-a", "copilot", "--no-sandbox", "--auto", "high", "--tools", "none", "-p", "test"],
        fake.env
      );
      expect(tools.exitCode).not.toBe(0);
      expect(tools.stderr).toContain("cannot remove its built-in tools");
    } finally {
      fake.cleanup();
    }
  });

  test("run --hermetic --tools none reaches claude as --safe-mode and an empty --tools", async () => {
    const fake = createFakeBinaryEnv({ claude: "cat >/dev/null; printf '[%s]' \"$@\"" });
    try {
      const { stdout, exitCode } = await runCli(
        ["run", "-a", "claude", "--no-sandbox", "--auto", "high", "--hermetic", "--tools", "none", "-p", "test"],
        fake.env
      );
      expect(exitCode).toBe(0);
      expect(stdout).toContain("[--safe-mode][--setting-sources][user]");
      expect(stdout).toContain("[--tools][]");
    } finally {
      fake.cleanup();
    }
  });

  test("run rejects an unknown --tools value", async () => {
    const { stderr, exitCode } = await runCli(["run", "--tools", "some", "-p", "test"]);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("Invalid value 'some' for --tools");
  });

  // A stand-in harness: with --safe-mode it answers OK, otherwise it repeats
  // the code word planted in the working directory's CLAUDE.md.
  const canaryAwareClaude =
    "cat >/dev/null; for a in \"$@\"; do [ \"$a\" = --safe-mode ] && { printf 'OK\\n'; exit 0; }; done; " +
    "grep -o 'CODEMUX-CANARY-[A-Z0-9]*' CLAUDE.md";

  test("check --hermetic passes when the hermetic probe is clean and the control leaks", async () => {
    const fake = createFakeBinaryEnv({ claude: canaryAwareClaude });
    try {
      const { stdout, stderr, exitCode } = await runCli(
        ["check", "-a", "claude", "--no-sandbox", "--auto", "high", "--hermetic"],
        fake.env
      );
      expect(exitCode).toBe(0);
      expect(stdout).toBe("HERMETIC claude: OK\n");
      expect(stderr).toContain("planted code word CODEMUX-CANARY-");
      expect(stderr).toContain("control: planted code word reached the model");
    } finally {
      fake.cleanup();
    }
  });

  test("check --hermetic fails when the planted code word reaches a hermetic run", async () => {
    const fake = createFakeBinaryEnv({
      claude: "cat >/dev/null; grep -o 'CODEMUX-CANARY-[A-Z0-9]*' CLAUDE.md",
    });
    try {
      const { stdout, stderr, exitCode } = await runCli(
        ["check", "-a", "claude", "--no-sandbox", "--auto", "high", "--hermetic"],
        fake.env
      );
      expect(exitCode).toBe(1);
      expect(stdout).toBe("");
      expect(stderr).toContain("NOT hermetic");
      expect(stderr).toContain("the planted code word reached the model");
    } finally {
      fake.cleanup();
    }
  });

  test("check --hermetic reports a name the model answered instead of OK", async () => {
    const fake = createFakeBinaryEnv({ claude: "cat >/dev/null; printf 'Some Owner\\n'" });
    try {
      const { stderr, exitCode } = await runCli(
        ["check", "-a", "claude", "--no-sandbox", "--auto", "high", "--hermetic"],
        fake.env
      );
      expect(exitCode).toBe(1);
      expect(stderr).toContain("the model answered 'Some Owner'");
    } finally {
      fake.cleanup();
    }
  });

  test("check --hermetic fails when the control request fails", async () => {
    const fake = createFakeBinaryEnv({
      claude: "cat >/dev/null; for a in \"$@\"; do [ \"$a\" = --safe-mode ] && { printf 'OK\\n'; exit 0; }; done; echo boom >&2; exit 23",
    });
    try {
      const { stdout, stderr, exitCode } = await runCli(
        ["check", "-a", "claude", "--no-sandbox", "--auto", "high", "--hermetic"],
        fake.env
      );
      expect(exitCode).toBe(1);
      expect(stdout).toBe("");
      expect(stderr).toContain("proved nothing: the request failed (exit 23)");
      expect(stderr).toContain("boom");
    } finally {
      fake.cleanup();
    }
  });

  test("check --hermetic fails when the control is clean too", async () => {
    const fake = createFakeBinaryEnv({ claude: "cat >/dev/null; printf 'OK\\n'" });
    try {
      const { stdout, stderr, exitCode } = await runCli(
        ["check", "-a", "claude", "--no-sandbox", "--auto", "high", "--hermetic"],
        fake.env
      );
      expect(exitCode).toBe(1);
      expect(stdout).toBe("");
      expect(stderr).toContain("proved nothing: clean too");
    } finally {
      fake.cleanup();
    }
  });

  test("check --hermetic fails when the control answers without the planted code word", async () => {
    const fake = createFakeBinaryEnv({
      claude: "cat >/dev/null; for a in \"$@\"; do [ \"$a\" = --safe-mode ] && { printf 'OK\\n'; exit 0; }; done; printf 'I cannot determine that\\n'",
    });
    try {
      const { stdout, stderr, exitCode } = await runCli(
        ["check", "-a", "claude", "--no-sandbox", "--auto", "high", "--hermetic"],
        fake.env
      );
      expect(exitCode).toBe(1);
      expect(stdout).toBe("");
      expect(stderr).toContain("proved nothing: answered 'I cannot determine that' without the planted code word");
    } finally {
      fake.cleanup();
    }
  });

  test("check --hermetic hands the planted directory to claude as --add-dir", async () => {
    const fake = createFakeBinaryEnv({
      claude: "cat >/dev/null; d=''; while [ $# -gt 0 ]; do [ \"$1\" = --safe-mode ] && { printf 'OK\\n'; exit 0; }; [ \"$1\" = --add-dir ] && d=$2; shift; done; grep -o 'CODEMUX-CANARY-[A-Z0-9]*' \"$d/CLAUDE.md\"",
    });
    try {
      const { stdout, exitCode } = await runCli(
        ["check", "-a", "claude", "--no-sandbox", "--auto", "high", "--hermetic"],
        fake.env
      );
      expect(exitCode).toBe(0);
      expect(stdout).toBe("HERMETIC claude: OK\n");
    } finally {
      fake.cleanup();
    }
  });

  // A stand-in opencode: under the hermetic run's permission deny it answers
  // OK; on a plain run (no deny in the environment) it leaks the code word
  // planted in the working directory.
  const canaryAwareOpencode =
    'if [ "$1" = --version ]; then printf "opencode 1.18.18\\n"; exit 0; fi\n' +
    "cat >/dev/null\n" +
    'case "$OPENCODE_PERMISSION" in *"deny"*) printf "OK\\n"; exit 0;; esac\n' +
    "grep -ho 'CODEMUX-CANARY-[A-Z0-9]*' AGENTS.md CLAUDE.md";

  test("check --hermetic --tools none runs the control with the same --tools none", async () => {
    // The control varies --hermetic alone (h7 review): with --tools none
    // given, both probes carry it, so a leaking control proves the planted
    // files reached the model without any tool — the attribution that makes
    // the hermetic probe's clean OK mean isolation, not tool removal. The
    // stand-in claude logs its arguments so the control's own command is
    // asserted, not just the verdict lines.
    const tempDir = mkdtempSync(join(tmpdir(), "codemux-control-argv-"));
    const argvLog = join(tempDir, "argv.log");
    const fake = createFakeBinaryEnv({
      claude:
        `cat >/dev/null; printf '%s\\n' "$@" >> ${argvLog}; printf '===\\n' >> ${argvLog}; ` +
        'for a in "$@"; do [ "$a" = --safe-mode ] && { printf "OK\\n"; exit 0; }; done; ' +
        "grep -o 'CODEMUX-CANARY-[A-Z0-9]*' CLAUDE.md",
    });
    try {
      const { stdout, stderr, exitCode } = await runCli(
        ["check", "-a", "claude", "--no-sandbox", "--auto", "high", "--hermetic", "--tools", "none"],
        fake.env
      );
      expect(exitCode).toBe(0);
      expect(stdout).toBe("HERMETIC claude: OK\n");
      expect(stderr).toContain("control: planted code word reached the model");
      const invocations = readFileSync(argvLog, "utf8")
        .split("===\n")
        .filter((block) => block.trim().length > 0);
      expect(invocations).toHaveLength(2);
      const control = invocations.find((block) => !block.includes("--safe-mode\n"));
      expect(control).toBeDefined();
      const args = control!.split("\n");
      const toolsIndex = args.indexOf("--tools");
      expect(toolsIndex).toBeGreaterThanOrEqual(0);
      expect(args[toolsIndex + 1]).toBe("");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
      fake.cleanup();
    }
  });

  test("check --hermetic --tools none refuses opencode before probing", async () => {
    // opencode scopes --tools none to hermetic runs, so the control cannot
    // carry the same selection without --hermetic; the check refuses the
    // combination up front instead of running an armed control (h7 review).
    const fake = createFakeBinaryEnv({ opencode: canaryAwareOpencode });
    try {
      const { stdout, stderr, exitCode } = await runCli(
        ["check", "-a", "opencode", "--no-sandbox", "--auto", "high", "--hermetic", "--tools", "none"],
        fake.env
      );
      expect(exitCode).toBe(1);
      expect(stdout).toBe("");
      expect(stderr).toContain("check --hermetic --tools none cannot run for opencode");
      expect(stderr).toContain("plain --tools none run, which opencode refuses");
      expect(stderr).not.toContain("Checking opencode hermetically");
    } finally {
      fake.cleanup();
    }
  });

  test("run --tools none refuses the Playwright MCP", async () => {
    const fake = createFakeBinaryEnv({ claude: "exit 0", scode: "exit 0", "playwright-mcp": "exit 0" });
    try {
      const { stderr, exitCode } = await runCli(
        ["run", "-a", "claude", "--sandbox", "--enable-playwright-mcp", "--tools", "none", "-p", "test"],
        fake.env
      );
      expect(exitCode).not.toBe(0);
      expect(stderr).toContain("cannot be combined with --enable-playwright-mcp");
    } finally {
      fake.cleanup();
    }
  });

  test("check --hermetic refuses an unsupported harness before probing", async () => {
    const fake = createFakeBinaryEnv({ droid: "printf 'OK\\n'" });
    try {
      const { stderr, exitCode } = await runCli(
        ["check", "-a", "droid", "--no-sandbox", "--auto", "high", "--hermetic"],
        fake.env
      );
      expect(exitCode).not.toBe(0);
      expect(stderr).toContain("no verified hermetic mode");
      expect(stderr).not.toContain("Checking");
    } finally {
      fake.cleanup();
    }
  });
});

describe("CLI - Signals", () => {
  test("a SIGTERM to a headless run terminates the agent's process tree", async () => {
    const pidDir = mkdtempSync(join(tmpdir(), "codemux-signal-"));
    const pidFile = join(pidDir, "child.pid");
    const fake = createFakeBinaryEnv({
      // Detached from codemux's process group like a real harness; records
      // its pid so the test can see whether the signal reached it.
      claude: `[ "$1" = --version ] && { echo 2.1.270; exit 0; }; cat >/dev/null; echo $$ > ${pidFile}; sleep 30`,
    });
    try {
      const proc = Bun.spawn(
        [join(import.meta.dir, "..", "bin", "codemux"), "run", "-a", "claude", "--no-sandbox", "--auto", "high", "-p", "test"],
        {
          cwd: join(import.meta.dir, ".."),
          stdout: "pipe",
          stderr: "pipe",
          env: { ...process.env, ...fake.env, CODEMUX_NO_KEYCHAIN_SYNC: "1", HOME: pidDir } as Record<string, string>,
        }
      );
      const deadline = Date.now() + 15_000;
      while (!existsSync(pidFile) && Date.now() < deadline) await Bun.sleep(100);
      expect(existsSync(pidFile)).toBe(true);
      const childPid = Number(readFileSync(pidFile, "utf8").trim());
      proc.kill("SIGTERM");
      const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
      expect(exitCode).toBe(143);
      expect(stderr).toContain("interrupted; the agent's process tree was terminated");
      // The fake agent is gone too, not orphaned.
      let alive = true;
      for (let i = 0; i < 50 && alive; i++) {
        try {
          process.kill(childPid, 0);
          await Bun.sleep(100);
        } catch {
          alive = false;
        }
      }
      expect(alive).toBe(false);
    } finally {
      fake.cleanup();
      rmSync(pidDir, { recursive: true, force: true });
    }
  }, 30_000); // the runner grants the tree its grace period before returning

  // A stand-in codex: writes the --output-last-message file the launch names
  // (model output in this run's scratch directory under the real CODEX_HOME,
  // or its private hermetic home), records the path it wrote so the test can
  // find it, then keeps the run in flight so a signal can arrive after the
  // write -- exactly the leak window.
  const lastMessageWritingCodex = (pidFile: string, pathMarker: string): string =>
    'if [ "$1" = --version ]; then printf "codex-cli 0.159.3\\n"; exit 0; fi\n' +
    "while [ $# -gt 0 ]; do\n" +
    '  if [ "$1" = --output-last-message ]; then\n' +
    `    mkdir -p "$(dirname "$2")"; printf "the interrupted reply\\n" > "$2"; printf '%s' "$2" > ${pathMarker}; shift 2; continue\n` +
    "  fi\n" +
    "  shift\n" +
    "done\n" +
    `echo $$ > ${pidFile}; sleep 30`;

  test("a SIGTERM to a codex --result-json run removes the --output-last-message file", async () => {
    // The round21 major: the process runner ends a signaled run with
    // process.exit(143) from inside the runner, past the launch path's
    // cleanup calls, so the file codex had already written outlived the
    // run. The launch's exit-time backstop now disposes the run's context
    // on that exit too. The file lives in this run's own directory under
    // the real CODEX_HOME's .codemux-scratch/ (round27) -- harness state,
    // which the parent reaches on every platform.
    const home = mkdtempSync(join(tmpdir(), "codemux-signal-lastmsg-"));
    const pidFile = join(home, "child.pid");
    const pathMarker = join(home, "last-message-path");
    const fake = createFakeBinaryEnv({
      codex: lastMessageWritingCodex(pidFile, pathMarker),
    });
    try {
      const proc = Bun.spawn(
        [join(import.meta.dir, "..", "bin", "codemux"), "run", "-a", "codex", "--no-sandbox", "--auto", "high", "--result-json", "-p", "test"],
        {
          cwd: join(import.meta.dir, ".."),
          stdout: "pipe",
          stderr: "pipe",
          env: { ...process.env, ...fake.env, CODEMUX_NO_KEYCHAIN_SYNC: "1", HOME: home } as Record<string, string>,
        }
      );
      const deadline = Date.now() + 15_000;
      while (!existsSync(pidFile) && Date.now() < deadline) await Bun.sleep(100);
      expect(existsSync(pidFile)).toBe(true);
      const lastMessageFile = readFileSync(pathMarker, "utf8");
      expect(lastMessageFile.startsWith(join(home, ".codex", ".codemux-scratch"))).toBe(true);
      expect(existsSync(lastMessageFile)).toBe(true);
      proc.kill("SIGTERM");
      const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
      expect(exitCode).toBe(143);
      expect(stderr).toContain("interrupted; the agent's process tree was terminated");
      // The run never reached processRunResult, where the file is normally
      // read and removed; only the exit backstop can have removed it.
      expect(existsSync(lastMessageFile)).toBe(false);
      expect(readdirSync(join(home, ".codex", ".codemux-scratch"))).toEqual([]);
    } finally {
      fake.cleanup();
      rmSync(home, { recursive: true, force: true });
    }
  }, 30_000); // the runner grants the tree its grace period before returning

  test("a SIGTERM to a sandboxed hermetic codex run leaves neither scratch nor private home", async () => {
    // The same exit through the sandboxed branch of the launch path, where
    // the finding located the leak "including for hermetic runs": the
    // --output-last-message file -- inside the run's private hermetic home
    // since round25 -- and the home itself must both be gone once the exit
    // handlers have run.
    const home = mkdtempSync(join(tmpdir(), "codemux-signal-hermetic-"));
    const pidFile = join(home, "child.pid");
    const pathMarker = join(home, "last-message-path");
    const fake = createFakeBinaryEnv({
      codex: lastMessageWritingCodex(pidFile, pathMarker),
      scode: 'while [ "$1" != "--" ]; do shift; done; shift; exec "$@"',
    });
    try {
      const proc = Bun.spawn(
        [join(import.meta.dir, "..", "bin", "codemux"), "run", "-a", "codex", "--hermetic", "--result-json", "-p", "test"],
        {
          cwd: join(import.meta.dir, ".."),
          stdout: "pipe",
          stderr: "pipe",
          env: {
            ...process.env,
            ...fake.env,
            CODEMUX_NO_KEYCHAIN_SYNC: "1",
            HOME: home,
            CODEX_API_KEY: "sk-test",
          } as Record<string, string>,
        }
      );
      const deadline = Date.now() + 15_000;
      while (!existsSync(pidFile) && Date.now() < deadline) await Bun.sleep(100);
      expect(existsSync(pidFile)).toBe(true);
      const lastMessageFile = readFileSync(pathMarker, "utf8");
      const hermeticParent = join(home, ".codex", ".codemux-hermetic");
      // Round25: the file lives INSIDE the run's private home, which the
      // sandbox keeps writable even where it denies the real CODEX_HOME.
      expect(lastMessageFile.startsWith(hermeticParent)).toBe(true);
      expect(existsSync(lastMessageFile)).toBe(true);
      expect(readdirSync(hermeticParent).length).toBeGreaterThan(0);
      proc.kill("SIGTERM");
      const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
      expect(exitCode).toBe(143);
      expect(stderr).toContain("interrupted; the agent's process tree was terminated");
      expect(existsSync(lastMessageFile)).toBe(false);
      // The hermetic home's own exit handler did this part before the
      // backstop existed; both paths still agree because both are idempotent.
      expect(readdirSync(hermeticParent)).toEqual([]);
    } finally {
      fake.cleanup();
      rmSync(home, { recursive: true, force: true });
    }
  }, 30_000); // the runner grants the tree its grace period before returning
});

describe("CLI - Signals during the version probe", () => {
  test("a SIGTERM during the harness version probe stops codemux instead of launching", async () => {
    const pidDir = mkdtempSync(join(tmpdir(), "codemux-signal-probe-"));
    const probeFile = join(pidDir, "probe.pid");
    const launched = join(pidDir, "launched");
    const fake = createFakeBinaryEnv({
      claude: `if [ "$1" = --version ]; then echo $$ > ${probeFile}; sleep 30; fi; cat >/dev/null; touch ${launched}; printf 'OK\\n'`,
    });
    try {
      const proc = Bun.spawn(
        [join(import.meta.dir, "..", "bin", "codemux"), "run", "-a", "claude", "--no-sandbox", "--auto", "high", "-p", "test"],
        {
          cwd: join(import.meta.dir, ".."),
          stdout: "pipe",
          stderr: "pipe",
          env: { ...process.env, ...fake.env, CODEMUX_NO_KEYCHAIN_SYNC: "1", HOME: pidDir } as Record<string, string>,
        }
      );
      const deadline = Date.now() + 15_000;
      while (!existsSync(probeFile) && Date.now() < deadline) await Bun.sleep(100);
      expect(existsSync(probeFile)).toBe(true);
      proc.kill("SIGTERM");
      const exitCode = await proc.exited;
      expect(exitCode).toBe(143);
      expect(existsSync(launched)).toBe(false);
    } finally {
      fake.cleanup();
      rmSync(pidDir, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("CLI - Check probe", () => {
  test("accepts an exact OK response", async () => {
    const fake = createFakeBinaryEnv({ claude: "printf 'OK'" });
    try {
      const { stdout, exitCode } = await runCli(["check", "-a", "claude", "--no-sandbox", "--auto", "high"], fake.env);
      expect(exitCode).toBe(0);
      expect(stdout).toBe("OK\n");
    } finally {
      fake.cleanup();
    }
  });

  test("accepts an isolated OK line from verbose harness output", async () => {
    const fake = createFakeBinaryEnv({
      claude: "printf 'status banner\\nOK.\\nusage summary\\n'",
    });
    try {
      const { stdout, exitCode } = await runCli(
        ["check", "--no-sandbox", "--auto", "high", "-a", "claude"],
        fake.env
      );
      expect(exitCode).toBe(0);
      expect(stdout).toBe("OK\n");
    } finally {
      fake.cleanup();
    }
  });

  test("can probe sandbox-required Cursor mode", async () => {
    const fake = createFakeBinaryEnv({
      agent: "cat >/dev/null; printf 'OK\\n'",
      scode: "while [ \"$1\" != \"--\" ]; do shift; done; shift; exec \"$@\"",
    });
    try {
      const { stdout, stderr, exitCode } = await runCli(
        ["check", "-a", "cursor", "--sandbox"],
        fake.env
      );
      expect(exitCode).toBe(0);
      expect(stdout).toBe("OK\n");
      expect(stderr).toContain("sandboxed");
    } finally {
      fake.cleanup();
    }
  });

  test("rejects unrelated exit-zero output", async () => {
    const fake = createFakeBinaryEnv({ claude: "printf 'NOT_OK'" });
    try {
      const { stderr, exitCode } = await runCli(["check", "-a", "claude", "--no-sandbox", "--auto", "high"], fake.env);
      expect(exitCode).toBe(1);
      expect(stderr).toContain("unexpected response");
      expect(stderr).toContain("NOT_OK");
    } finally {
      fake.cleanup();
    }
  });

  test("preserves stdout diagnostics from a failed harness", async () => {
    const fake = createFakeBinaryEnv({
      claude: "printf 'authentication required\\n'; exit 2",
    });
    try {
      const { stderr, exitCode } = await runCli(
        ["check", "--no-sandbox", "--auto", "high", "-a", "claude"],
        fake.env
      );
      expect(exitCode).toBe(2);
      expect(stderr).toContain("authentication required");
    } finally {
      fake.cleanup();
    }
  });

  test("enforces a bounded probe timeout", async () => {
    const fake = createFakeBinaryEnv({
      claude: "sleep 2",
    });
    try {
      const { stderr, exitCode } = await runCli(
        ["check", "--no-sandbox", "--auto", "high", "-a", "claude", "--timeout", "0.02"],
        fake.env
      );
      expect(exitCode).toBe(124);
      expect(stderr).toContain("timed out");
    } finally {
      fake.cleanup();
    }
  });
});

describe("CLI - zai effort none (review al11)", () => {
  // 0.11 accepted `--effort none` on zai as the mapper's "no flag"
  // spelling; 0.12's capabilities list omitted it, so the same command
  // failed with "does not support reasoning effort 'none'" — a
  // regression against the mapper and the README both. The list carries
  // it again (src/adapters/zai.ts), and these pin both run kinds end to
  // end: the refusal is gone and no --effort flag reaches the binary.
  const zaiArgvFake = (argvFile: string) =>
    createFakeBinaryEnv({
      claude: `
if [ "$1" = "--version" ]; then printf '2.1.223\\n'; exit 0; fi
printf '%s\\n' "$@" > ${argvFile}
printf 'OK'
`,
    });

  test("run accepts --effort none and sends no flag; a real level still sends it", async () => {
    const argvDir = mkdtempSync(join(tmpdir(), "codemux-zai-effort-"));
    const argvFile = join(argvDir, "argv.txt");
    const fake = zaiArgvFake(argvFile);
    try {
      const none = await runCli(
        ["run", "--no-sandbox", "--auto", "high", "-a", "zai", "--effort", "none", "-p", "test"],
        { ...fake.env, ZAI_API_KEY: "zai-effort-key" }
      );
      expect(none.exitCode).toBe(0);
      expect(none.stderr).not.toContain("does not support reasoning effort");
      expect(none.stdout).toBe("OK");
      const noneArgv = readFileSync(argvFile, "utf8").split("\n");
      expect(noneArgv).not.toContain("--effort");

      const low = await runCli(
        ["run", "--no-sandbox", "--auto", "high", "-a", "zai", "--effort", "low", "-p", "test"],
        { ...fake.env, ZAI_API_KEY: "zai-effort-key" }
      );
      expect(low.exitCode).toBe(0);
      const lowArgv = readFileSync(argvFile, "utf8").split("\n");
      expect(lowArgv[lowArgv.indexOf("--effort") + 1]).toBe("low");
    } finally {
      fake.cleanup();
      rmSync(argvDir, { recursive: true, force: true });
    }
  });

  test("tui accepts --effort none and sends no flag", async () => {
    const argvDir = mkdtempSync(join(tmpdir(), "codemux-zai-effort-"));
    const argvFile = join(argvDir, "argv.txt");
    const fake = zaiArgvFake(argvFile);
    try {
      const { exitCode, stderr } = await runCli(
        ["tui", "--no-sandbox", "--auto", "high", "-a", "zai", "--effort", "none"],
        { ...fake.env, ZAI_API_KEY: "zai-effort-key" }
      );
      expect(exitCode).toBe(0);
      expect(stderr).not.toContain("does not support reasoning effort");
      const argv = readFileSync(argvFile, "utf8").split("\n");
      expect(argv).not.toContain("--effort");
    } finally {
      fake.cleanup();
      rmSync(argvDir, { recursive: true, force: true });
    }
  });

  test("the same spelling through -a claude still refuses: each adapter keeps its own surface (al21)", async () => {
    // contracts-2 minor 4: same binary, two adapters, two CLI surfaces.
    // zai carries `none` (its 0.11 surface, pinned above); claude never
    // took the spelling, so its effortLevels omit it and the gate
    // refuses. Both adapters' comments name the divergence so neither
    // list "fixes" the other by accident.
    const fake = createFakeBinaryEnv({ claude: "exit 0" });
    try {
      const { stderr, exitCode } = await runCli(
        ["run", "--no-sandbox", "--auto", "high", "-a", "claude", "--effort", "none", "-p", "test"],
        fake.env
      );
      expect(exitCode).not.toBe(0);
      expect(stderr).toContain("does not support reasoning effort 'none'");
    } finally {
      fake.cleanup();
    }
  });
});

describe("CLI - kimi run-path command refusal (review al11, narrowed al17)", () => {
  test("the /goal command and ! shape refuse with 64; a /-leading path runs", async () => {
    // The binary's own rule (0.31.1): only goal-creates are dispatched
    // before the model turn, so the refusal is the word-bounded /goal
    // name (dispatched as the goal flow with its own exit codes, never
    // a model turn) and the ! shell-escape shape — and nothing else.
    // The al11 rule refused every /- or !-leading prompt; al17's
    // correctness review caught the cost — an ordinary path-like prompt
    // exited 64. Exit 64 (usage), the marker a script can tell apart
    // from a failed run; the path-like prompt launches the harness.
    const fake = createFakeBinaryEnv({
      kimi: `
if [ "$1" = "--version" ]; then printf '0.31.1\\n'; exit 0; fi
exit 0
`,
    });
    const cwd = mkdtempSync(join(tmpdir(), "codemux-kimi-slash-"));
    try {
      for (const prompt of ["/goal create ship it", "/goal status", "!rm -rf /"]) {
        const { stderr, exitCode } = await runCli(
          ["run", "--no-sandbox", "--auto", "high", "-a", "kimi", "--cwd", cwd, "-p", prompt],
          fake.env
        );
        expect(exitCode, prompt).toBe(64);
        expect(stderr, prompt).toContain(
          "must not be the /goal command or a '!' shell line"
        );
      }
      // A path-like prompt — the major's own example — is model text in
      // 0.31.1 (verified live post-fix): the run launches and exits 0.
      const { exitCode } = await runCli(
        [
          "run",
          "--no-sandbox",
          "--auto",
          "high",
          "-a",
          "kimi",
          "--cwd",
          cwd,
          "-p",
          "/tmp/notes.md please summarize",
        ],
        fake.env
      );
      expect(exitCode).toBe(0);
    } finally {
      fake.cleanup();
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
