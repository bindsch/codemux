import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createFakeBinaryEnv,
  runCli,
} from "./helpers/cli.js";

describe("CLI - Run validation", () => {
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

});
