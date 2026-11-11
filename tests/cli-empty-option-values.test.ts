/**
 * Review round 159 (lane F22): an option given on the command line is
 * present even when its value is the empty string, and an empty value is
 * a usage refusal (exit 64) unless the option's own documentation gives
 * the empty value a meaning. One regression test per review finding,
 * then the sweep over every value option the class covers. Every drive
 * is synthetic: fake binaries on a private PATH, in-process commander
 * actions, and stubbed commands — never a real harness.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakeBinaryEnv, minimalPath, runCli } from "./helpers/cli.js";
import { cleanupFixtureHomes, fakeScodeHelp, fakeUsagemux, fixtureHome, runDoctor } from "./helpers/doctor.js";
import {
  claudeRecord,
  removeDir,
  runSessionCommand,
  seedRegistry,
  tempWorkdir,
} from "./helpers/session-command.js";
import { codexSessionProviderHomePath } from "../src/codex-provider.js";
import { parseOptions } from "../scripts/live-gate/options.js";

const doctorHomes: string[] = [];

// A fake claude that answers the version probe inside the contract's
// range and appends every other invocation's argv to a record file, so a
// test can prove the harness never ran. A launched run also prints one
// plain line: an empty success is a failed plain run (round 259), and
// these tests assert the launch, not a silent child.
const recordingClaude = (record: string): string =>
  `if [ "$1" = "--version" ]; then printf '2.1.220 (Claude Code)\\n'; exit 0; fi
printf '%s\\n' "$*" >> ${JSON.stringify(record)}
printf '{"type":"result","subtype":"success","result":"OK"}\\n'`;

// A scode that runs what it wraps (after `--`, the command the launcher
// built), so a sandboxed print-only launch resolves its argv for real.
const SCODE_EXEC = `while [ "$1" != "--" ]; do shift; done
shift
exec "$@"`;

describe("review round 159: an explicitly empty option value", () => {
  test("-p with -f \"\" keeps the mutual-exclusion refusal and launches no harness", async () => {
    // Finding 1: the file option tested by truthiness read `-f ""` (an
    // unset shell variable) as absent, so the clash check never ran and
    // the inline prompt silently won.
    const root = mkdtempSync(join(tmpdir(), "codemux-empty-opt-"));
    const record = join(root, "calls.log");
    const fake = createFakeBinaryEnv({ claude: recordingClaude(record) });
    try {
      const { stderr, exitCode } = await runCli(
        ["run", "-a", "claude", "-p", "test", "-f", ""],
        fake.env
      );
      expect(exitCode).toBe(64);
      expect(stderr).toContain("--prompt and --file cannot be used together");
      expect(existsSync(record)).toBe(false);
    } finally {
      fake.cleanup();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("-f \"\" alone is a usage refusal naming the option, and no harness runs", async () => {
    const root = mkdtempSync(join(tmpdir(), "codemux-empty-opt-"));
    const record = join(root, "calls.log");
    const fake = createFakeBinaryEnv({ claude: recordingClaude(record) });
    try {
      const { stderr, exitCode } = await runCli(
        ["run", "-a", "claude", "-f", ""],
        fake.env
      );
      expect(exitCode).toBe(64);
      expect(stderr).toContain("--file requires a path or '-' as its value");
      expect(existsSync(record)).toBe(false);
    } finally {
      fake.cleanup();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("--model \"\" refuses with the model-name message on run, tui, and check", async () => {
    // Finding 2 (three of the four sites): the empty value must reach
    // resolveModel's validateModelName instead of reading as "no model"
    // and silently launching the provider default.
    const run = await runCli(["run", "-a", "claude", "-m", "", "-p", "test"], {
      PATH: minimalPath(),
    });
    expect(run.exitCode).toBe(64);
    expect(run.stderr).toContain("invalid model name");

    const tui = await runCli(["tui", "-a", "claude", "-m", ""], { PATH: minimalPath() });
    expect(tui.exitCode).toBe(64);
    expect(tui.stderr).toContain("invalid model name");

    const check = await runCli(["check", "-a", "claude", "-m", ""], { PATH: minimalPath() });
    expect(check.exitCode).toBe(64);
    expect(check.stderr).toContain("invalid model name");
  });

  test("session --model \"\" refuses even when the environment carries an override model", async () => {
    // Finding 2, session: the request used to fall back to the override's
    // model; an explicitly empty --model is a refusal instead.
    const outcome = await runSessionCommand(["-a", "claude", "-m", ""], {}, {
      env: {
        CODEMUX_CLAUDE_PROVIDER_BASE_URL: "https://override.example/v1",
        CODEMUX_CLAUDE_PROVIDER_API_KEY: "e2e-key-do-not-print",
        CODEMUX_CLAUDE_PROVIDER_MODEL: "claw-32b",
      },
    });
    expect(outcome.exitCode).toBe(64);
    expect(outcome.stderr).toContain("invalid model name");
  });

  test("session --resume with a recorded override refuses --model \"\" before any spawn", async () => {
    // Finding 2, session resume: the registry holds an override session
    // (provider_base_url and its keyed home), so the resume would have
    // every reason to fall back to the recorded override model. The
    // refusal fires in the request phase, before the registry is read or
    // the harness binary is probed.
    const regRoot = tempWorkdir("f22-resume-reg");
    const workdir = tempWorkdir("f22-resume-work");
    const codexHome = tempWorkdir("f22-resume-home");
    const root = mkdtempSync(join(tmpdir(), "codemux-empty-opt-"));
    const record = join(root, "calls.log");
    const id = "0123456789abcdef";
    const baseUrl = "http://127.0.0.1:9/v1";
    seedRegistry(join(regRoot, "live-sessions.json"), [
      claudeRecord(id, workdir, {
        agent: "codex",
        sandboxed: true,
        harness_home: codexSessionProviderHomePath(codexHome, baseUrl, id),
        pass_env: ["CODEX_HOME"],
        provider_base_url: baseUrl,
      }),
    ]);
    try {
      const outcome = await runSessionCommand(
        ["-a", "codex", "--resume", id, "--auto", "high", "--cwd", workdir, "-m", ""],
        { codex: recordingClaude(record).replaceAll("2.1.220 (Claude Code)", "codex-cli 0.159.3") },
        {
          registryFile: join(regRoot, "live-sessions.json"),
          env: {
            CODEX_HOME: codexHome,
            CODEMUX_CODEX_PROVIDER_BASE_URL: baseUrl,
            CODEMUX_CODEX_PROVIDER_API_KEY: "e2e-key-do-not-print",
            CODEMUX_CODEX_PROVIDER_MODEL: "clawvm-qwen32b-coder",
          },
        }
      );
      expect(outcome.exitCode).toBe(64);
      expect(outcome.stderr).toContain("invalid model name");
      expect(existsSync(record)).toBe(false);
    } finally {
      removeDir(regRoot);
      removeDir(workdir);
      removeDir(codexHome);
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("tui validates the whole request before reporting a missing harness (finding 3)", async () => {
    // With the harness absent from the PATH, a malformed request is a
    // usage refusal (64), never an installation failure (1).
    const padded = await runCli(["tui", "-a", "claude", "--model", " padded "], {
      PATH: minimalPath(),
    });
    expect(padded.exitCode).toBe(64);
    expect(padded.stderr).toContain("invalid model name");
    expect(padded.stderr).not.toContain("is not installed");

    const cwd = await runCli(["tui", "-a", "claude", "--cwd", "/definitely/not/a/dir"], {
      PATH: minimalPath(),
    });
    expect(cwd.exitCode).toBe(64);
    expect(cwd.stderr).toContain("cwd is not accessible");
    expect(cwd.stderr).not.toContain("is not installed");

    // A valid request still gets the installation failure with exit 1.
    const valid = await runCli(["tui", "-a", "claude"], { PATH: minimalPath() });
    expect(valid.exitCode).toBe(1);
    expect(valid.stderr).toContain("claude is not installed");
    expect(valid.stderr).toContain("Please install 'claude' and try again");
  });

  test("verify --agent \"\" is an unknown-agent refusal that inspects no agent (finding 4)", async () => {
    const { stdout, stderr, exitCode } = await runCli(["verify", "--agent", ""], {
      PATH: minimalPath(),
    });
    expect(exitCode).toBe(64);
    expect(stderr).toContain("Unknown agent ''");
    expect(stdout).not.toContain("Verification checks");
  });
});

describe("review round 159 sweep: every fixed empty-value row refuses with 64", () => {
  const refusalCases: {
    label: string;
    binaries: Record<string, string>;
    argv: string[];
    message: string;
  }[] = [
    {
      label: "run --file \"\"",
      binaries: {},
      argv: ["run", "-a", "claude", "-f", ""],
      message: "--file requires a path or '-' as its value",
    },
    {
      label: "run --model \"\"",
      binaries: {},
      argv: ["run", "-a", "claude", "-m", "", "-p", "test"],
      message: "invalid model name",
    },
    {
      label: "tui --model \"\"",
      binaries: {},
      argv: ["tui", "-a", "claude", "-m", ""],
      message: "invalid model name",
    },
    {
      label: "check --model \"\"",
      binaries: {},
      argv: ["check", "-a", "claude", "-m", ""],
      message: "invalid model name",
    },
    {
      label: "verify --agent \"\"",
      binaries: {},
      argv: ["verify", "--agent", ""],
      message: "Unknown agent ''",
    },
    {
      // The agy diagnostic's guard read `--cwd \"\"` as absent, so the
      // empty value skipped the "no other isolation flags" refusal.
      label: "check --cwd \"\" beside --agy-isolation-probe",
      binaries: {},
      argv: ["check", "-a", "agy", "--agy-isolation-probe", "login", "--cwd", ""],
      message: "--agy-isolation-probe requires -a agy --auto read-only with default scode and no other isolation flags",
    },
    {
      // A bad mode value — the empty string included — is a usage
      // refusal (64), the class every other option validator uses.
      label: "check --agy-isolation-probe \"\"",
      binaries: {
        agy: `if [ "$1" = "--version" ]; then printf '1.3.2\\n'; exit 0; fi
exit 0`,
        scode: SCODE_EXEC,
      },
      argv: ["check", "-a", "agy", "--agy-isolation-probe", ""],
      message: "--agy-isolation-probe must be one of:",
    },
  ];
  test.each(refusalCases)("$label", async ({ binaries, argv, message }) => {
    const fake = createFakeBinaryEnv(binaries);
    try {
      const { stderr, exitCode } = await runCli(argv, fake.env);
      expect(exitCode).toBe(64);
      expect(stderr).toContain(message);
    } finally {
      fake.cleanup();
    }
  });

  test("a valid non-empty value still passes on run, tui, check, and verify", async () => {
    const root = mkdtempSync(join(tmpdir(), "codemux-empty-opt-"));
    const record = join(root, "calls.log");
    const promptFile = join(root, "prompt.txt");
    writeFileSync(promptFile, "from the file");
    const fake = createFakeBinaryEnv({
      claude: recordingClaude(record),
      scode: SCODE_EXEC,
    });
    try {
      // run: -f with a real path launches and the fake records the call
      // (the prompt itself travels over stdin, so the record holds the
      // run argv, not the prompt text).
      const run = await runCli(
        ["run", "-a", "claude", "-f", promptFile, "--no-sandbox", "--auto", "high"],
        fake.env
      );
      expect(run.exitCode).toBe(0);
      expect(existsSync(record)).toBe(true);
      expect(readFileSync(record, "utf8")).toContain("--output-format");

      // tui and check: a print-only launch carries the model into the
      // argv it prints and runs nothing.
      const tui = await runCli(
        ["tui", "-a", "claude", "--model", "some-model-1", "--print-sandbox"],
        fake.env
      );
      expect(tui.exitCode).toBe(0);
      expect(tui.stdout).toContain("some-model-1");

      const check = await runCli(
        ["check", "-a", "claude", "--model", "some-model-1", "--print-sandbox"],
        fake.env
      );
      expect(check.exitCode).toBe(0);
      expect(check.stdout).toContain("some-model-1");

      // verify: a named agent verifies exactly that agent.
      const verify = await runCli(["verify", "--agent", "claude"], { PATH: minimalPath() });
      expect(verify.exitCode).toBe(0);
      expect(verify.stdout).toContain("| claude |");
      expect(verify.stdout).not.toContain("| droid");
    } finally {
      fake.cleanup();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("session: a valid non-empty model passes the request phase", async () => {
    // No claude binary on the PATH: the request phase completes (the
    // model resolves) and the session ends at the availability gate,
    // exit 1 — the contrast with the 64 the empty value earns above.
    const outcome = await runSessionCommand(["-a", "claude", "--model", "some-model-1"]);
    expect(outcome.exitCode).toBe(1);
    expect(outcome.stderr).toContain("claude is not installed");
    expect(outcome.stderr).not.toContain("invalid model name");
  });

  test("doctor --spend-cap \"\" is a usage refusal; a number still parses", async () => {
    // Number("") is 0, which is in range, so the empty value used to cap
    // the paid stage at zero probes instead of refusing. The fake
    // scode/usagemux keep the machine check itself healthy, so the valid
    // row's exit code says only what the option decided.
    const fake = createFakeBinaryEnv({ scode: fakeScodeHelp(), usagemux: fakeUsagemux() });
    try {
      const refused = await runDoctor(["--spend-cap", ""], {
        path: fake.env.PATH!,
        home: fixtureHome({}, doctorHomes),
      });
      expect(refused.exitCode).toBe(64);
      expect(refused.errors).toContain(
        "--spend-cap requires a whole number of harnesses, 0 or more"
      );

      const valid = await runDoctor(["--spend-cap", "2"], {
        path: fake.env.PATH!,
        home: fixtureHome({}, doctorHomes),
      });
      expect(valid.exitCode).toBe(0);
      expect(valid.errors).not.toContain("--spend-cap");
    } finally {
      fake.cleanup();
    }
  });

  test.each([
    ["--skip", ""],
    ["--skip", ","],
    ["--only", ""],
    ["--only", "claude,"],
    ["--pass-env", ""],
    ["--probe", ""],
    ["--probe", "A,"],
    ["--skip-probe", ""],
    ["--skip-probe", ",B"],
    ["--probe-anyway", ""],
    ["--probe-anyway", "claude,,codex"],
  ])("live-gate %s '%s' refuses the empty entry", (flag, value) => {
    // The gate's list parsers skip empty entries, so an explicitly empty
    // flag value read as "flag not given" and selected every harness.
    expect(() => parseOptions([flag, value], undefined)).toThrow(
      "takes a comma-separated list; an entry is empty"
    );
  });

  test("live-gate list flags still take valid lists; a blank env merge stays unset", () => {
    expect(() =>
      parseOptions(
        ["--skip", "qwen", "--only", "claude, codex", "--pass-env", "FOO", "--probe", "A,B",
          "--skip-probe", "B", "--probe-anyway", "claude"],
        undefined
      )
    ).not.toThrow();
    // LIVE_GATE_SKIP="" keeps its env convention: blank means unset.
    expect(() => parseOptions([], "")).not.toThrow();
  });
});

afterAll(() => cleanupFixtureHomes(doctorHomes));
