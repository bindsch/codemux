import { describe, test, expect } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createFakeBinaryEnv,
  minimalPath,
  runCli,
} from "./helpers/cli.js";
import { fakeScodeHelp } from "./helpers/doctor.js";
import { getAllAdapters } from "../src/adapters/index.js";
import { SESSION_AGENTS } from "../src/session/cli-agents.js";

describe("CLI - Help", () => {
  test("--help shows usage", async () => {
    const { stdout } = await runCli(["--help"]);
    expect(stdout).toContain("Usage: codemux");
    expect(stdout).toContain("Unified CLI for AI coding agents");
    expect(stdout).toContain("run");
    expect(stdout).toContain("tui");
    expect(stdout).toContain("autonomy");
    expect(stdout).toContain("verify");
    expect(stdout).toContain("list");
    expect(stdout).toContain("doctor");
    expect(stdout).toContain("usage");
  });

  test("--version shows version", async () => {
    const { stdout } = await runCli(["--version"]);
    const pkg = JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf8"));
    expect(stdout.trim()).toBe(pkg.version);
  });

  test("installed launcher ignores hostile working-tree Bun config and dotenv", async () => {
    const hostile = mkdtempSync(join(tmpdir(), "codemux-hostile-"));
    const home = join(hostile, "home");
    const marker = join(hostile, "preload-ran");
    const linkedBin = join(hostile, "bin", "codemux");
    mkdirSync(join(hostile, "codemux"), { recursive: true });
    mkdirSync(join(hostile, "bin"), { recursive: true });
    mkdirSync(home, { recursive: true });
    symlinkSync(join(import.meta.dir, "..", "bin", "codemux"), linkedBin);
    writeFileSync(join(hostile, "owned.ts"), `await Bun.write(${JSON.stringify(marker)}, "owned");`);
    writeFileSync(join(hostile, "bunfig.toml"), 'preload = ["./owned.ts"]\n');
    writeFileSync(join(hostile, ".env"), "XDG_CONFIG_HOME=.\n");
    writeFileSync(join(hostile, "codemux", "config.yaml"), "defaultAgent: codex\n");
    try {
      // A green machine-check environment (a fake scode): this test is
      // about the launcher ignoring the hostile preload and dotenv, so the
      // doctor exit code must reflect that subject alone, not a missing
      // sandbox binary.
      const fake = createFakeBinaryEnv({ scode: fakeScodeHelp() });
      try {
        const proc = Bun.spawn([linkedBin, "doctor"], {
          cwd: hostile,
          stdout: "pipe",
          stderr: "pipe",
          env: {
            ...process.env,
            HOME: home,
            PATH: fake.env.PATH!,
            // Never read the operator's real Keychain from a spawned run.
            CODEMUX_NO_KEYCHAIN_SYNC: "1",
            BUN_OPTIONS: "--preload=./owned.ts",
          },
        });
        const [stdout, exitCode] = await Promise.all([
          new Response(proc.stdout).text(),
          proc.exited,
        ]);
        expect(exitCode).toBe(0);
        expect(stdout).toContain("Default agent: claude");
        expect(await Bun.file(marker).exists()).toBe(false);
      } finally {
        fake.cleanup();
      }
    } finally {
      rmSync(hostile, { recursive: true, force: true });
    }
  });

  test("run --help shows run options", async () => {
    const { stdout } = await runCli(["run", "--help"]);
    expect(stdout).toContain("-a, --agent");
    expect(stdout).toContain("-m, --model");
    expect(stdout).toContain("-p, --prompt");
    expect(stdout).toContain("-f, --file");
    expect(stdout).toContain("--sandbox-trust");
    expect(stdout).toContain("--sandbox-no-net");
    expect(stdout).toContain("--sandbox-scrub-env");
    expect(stdout).not.toContain("--sandbox-allow-net");
    expect(stdout).not.toContain("--sandbox-keep-env");
    expect(stdout).toContain("--no-web");
    expect(stdout).toContain("--auto");
    expect(stdout).toContain("--effort");
    expect(stdout).toContain("--cwd");
  });

  test("tui --help shows tui options", async () => {
    const { stdout } = await runCli(["tui", "--help"]);
    expect(stdout).toContain("-a, --agent");
    expect(stdout).toContain("-m, --model");
    expect(stdout).toContain("--sandbox-trust");
    expect(stdout).toContain("--sandbox-no-net");
    expect(stdout).toContain("--sandbox-scrub-env");
    expect(stdout).not.toContain("--sandbox-allow-net");
    expect(stdout).not.toContain("--sandbox-keep-env");
    expect(stdout).not.toContain("--sandbox-no-defaults");
    expect(stdout).toContain("--auto");
    expect(stdout).toContain("--effort");
    expect(stdout).toContain("--cwd");
  });

  test("verify --help shows preview options", async () => {
    const { stdout } = await runCli(["verify", "--help"]);
    expect(stdout).toContain("-a, --agent");
    expect(stdout).toContain("--show-scode");
    expect(stdout).toContain("--sandbox-trust");
    expect(stdout).toContain("--sandbox-no-net");
    expect(stdout).toContain("--sandbox-scrub-env");
    expect(stdout).not.toContain("--sandbox-allow-net");
    expect(stdout).not.toContain("--sandbox-keep-env");
    expect(stdout).not.toContain("--sandbox-no-defaults");
  });
});

describe("CLI - List", () => {
  test("list shows all agents", async () => {
    const { stdout } = await runCli(["list"]);
    expect(stdout).toContain("Available agents:");
    expect(stdout).toContain("claude");
    expect(stdout).toContain("aider");
    expect(stdout).toContain("cline");
    expect(stdout).toContain("codex");
    expect(stdout).toContain("copilot");
    expect(stdout).toContain("cursor");
    expect(stdout).toContain("droid");
    expect(stdout).toContain("goose");
    expect(stdout).toContain("gemini");
    expect(stdout).toContain("opencode");
    expect(stdout).toContain("pi");
    expect(stdout).toContain("qwen");
    expect(stdout).toContain("zai");
  });

  test("list shows feature flags", async () => {
    const { stdout } = await runCli(["list"]);
    const printed = new Map([...stdout.matchAll(/^  [✅❌] (\S+)(?: \[([^\]]*)\])?$/gm)]
      .map((match) => [match[1]!, match[2]?.split(", ") ?? []]));
    for (const adapter of getAllAdapters()) {
      const caps = adapter.capabilities();
      const session = SESSION_AGENTS[adapter.id];
      expect(printed.get(adapter.id), adapter.id).toEqual([
        caps.supportsModel ? (adapter.supportsTuiModel() ? "model" : "model(run)") : null,
        caps.supportsAutonomy ? "autonomy" : null,
        caps.supportsEffort ? (adapter.supportsTuiEffort() ? "effort" : "effort(run)") : null,
        caps.supportsHermetic ? (caps.isolationRequiresReadOnly ? "hermetic(read-only)" : "hermetic") : null,
        caps.supportsToolSelection ? (caps.toolsNoneRequiresHermetic ? "tools(hermetic)"
          : caps.toolsNoneRequiresReadOnly || caps.isolationRequiresReadOnly ? "tools(read-only)" : "tools") : null,
        caps.supportsProviderOverride ? "provider" : null,
        caps.supportsResultJson ? "result-json" : null,
        caps.budgetLimit ? "budget" : null,
        session ? (session.approvals === "ask" ? "sessions(permissions)" : "sessions(no-permissions)") : null,
      ].filter((label) => label !== null));
    }
  });
});

describe("CLI - Autonomy", () => {
  test("autonomy shows equivalence matrix", async () => {
    const { stdout } = await runCli(["autonomy"]);
    expect(stdout).toContain("Autonomy equivalence matrix");
    expect(stdout).toContain("| Agent | read-only | low | medium | high | Notes |");
    expect(stdout).toContain("| codex |");
    expect(stdout).toContain("| goose |");
    expect(stdout).toContain("| gemini |");
    expect(stdout).toContain("| qwen |");
    expect(stdout).toContain("| pi |");
  });
});

describe("CLI - Verify", () => {
  test("verify shows wiring report table", async () => {
    // Full verify builds the real command for every installed adapter;
    // entry resolution is spawn-free (see the CursorEntry comment in
    // src/adapters/cursor.ts), so this stays in the default timeout.
    const { stdout, exitCode } = await runCli(["verify"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Verification checks: static wiring only");
    expect(stdout).toContain("| Agent | Installed | Mapping | Build Run | Build TUI | Warnings | Status |");
    expect(stdout).toContain("| claude |");
    expect(stdout).toContain("| aider |");
    expect(stdout).toContain("| cline |");
    expect(stdout).toContain("| codex |");
    expect(stdout).toContain("| copilot |");
    expect(stdout).toContain("| cursor |");
    expect(stdout).toContain("| droid |");
    expect(stdout).toContain("| goose |");
    expect(stdout).toContain("| gemini |");
    expect(stdout).toContain("| opencode |");
    expect(stdout).toContain("| pi |");
    expect(stdout).toContain("| qwen |");
    expect(stdout).toContain("| zai |");
    expect(stdout).toContain("Summary: PASS");
  });

  test("verify can target one agent", async () => {
    const { stdout, exitCode } = await runCli(["verify", "-a", "codex"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("| codex |");
    expect(stdout).not.toContain("| claude |");
  });

  test("verify with unknown agent shows error", async () => {
    const { stderr, exitCode } = await runCli(["verify", "-a", "unknown"]);
    expect(exitCode).toBe(64);
    expect(stderr).toContain("Unknown agent");
  });

  test("verify --show-scode prints effective command matrix", async () => {
    const { stdout, exitCode } = await runCli(["verify", "-a", "codex", "--show-scode"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Effective scode command preview");
    expect(stdout).toContain("| Agent | Autonomy | Mode | Command |");
    expect(stdout).toContain("| codex | read-only | run |");
    // Every preview carries the launch's -C pin first (review round 372, item 15).
    expect(stdout).toMatch(/`scode -C \S+ --trust/);
  });

  test("verify --show-scode applies sandbox policy overrides", async () => {
    const { stdout, exitCode } = await runCli([
      "verify",
      "-a",
      "codex",
      "--show-scode",
      "--sandbox-trust",
      "trusted",
      "--sandbox-no-net",
      "--sandbox-scrub-env",
    ]);
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/scode -C \S+ --trust trusted --ro --no-net --scrub-env --/);
  });

  test("verify --show-scode keeps hosted agents network-capable", async () => {
    const { stdout, exitCode } = await runCli(["verify", "-a", "codex", "--show-scode"]);
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/\| codex \| low \| run \| `scode -C \S+ --trust standard --rw --/);
  });

  test("verify --show-scode uses explicit standard trust for coarse harnesses", async () => {
    const { stdout, exitCode } = await runCli(["verify", "-a", "opencode", "--show-scode"]);
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/\| opencode \| medium \| run \| `scode -C \S+ --trust standard --rw --/);
  });

  test("verify sandbox preview flags without --show-scode warns", async () => {
    const { stderr, exitCode } = await runCli(["verify", "--sandbox-no-net"]);
    expect(exitCode).toBe(0);
    expect(stderr).toContain("sandbox policy flags require --show-scode");
  });

  test("removed no-op sandbox policy flags fail as unknown options", async () => {
    const { stderr, exitCode } = await runCli([
      "verify",
      "--show-scode",
      "--sandbox-allow-net",
    ]);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("unknown option '--sandbox-allow-net'");
  });

  test("verify with invalid sandbox trust level shows error", async () => {
    const { stderr, exitCode } = await runCli(["verify", "--show-scode", "--sandbox-trust", "danger"]);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("Invalid value 'danger' for --sandbox-trust");
    expect(stderr).toContain("trusted, standard, untrusted");
  });
});

describe("CLI - Doctor", () => {
  // Doctor probes every installed harness's version command, so these tests
  // never run against the machine's real PATH: a slow real binary would make
  // the result depend on the host. minimalPath() installs nothing; fakes
  // install exactly what a test names. runCli gives each spawn a throwaway
  // HOME, so no login row reads a real store. The row-level behavior lives
  // in tests/doctor-*.test.ts; these check the spawned CLI end to end.
  test("doctor prints one row per harness and the summary", async () => {
    const { stdout, exitCode } = await runCli(["doctor"], { PATH: minimalPath() });
    expect(exitCode).toBe(1); // scode missing: a broken environment row
    expect(stdout).toContain("Machine health check");
    expect(stdout).toContain(
      "| Agent | Installed | Version | Contract | Floors | Login | Usage | Sandbox | State | Remedy |"
    );
    expect(stdout).toContain("| claude | no |");
    expect(stdout).toContain("| NOT-INSTALLED |");
    expect(stdout).toContain("Summary: 0 ok, 0 warn, 0 broken, 16 not installed");
  });

  test("doctor reports the optional usage integration without requiring it", async () => {
    const { stdout } = await runCli(["doctor"], { PATH: minimalPath() });
    expect(stdout).toContain("usagemux: USAGEMUX-MISSING: not installed (optional");
    expect(stdout).toContain("brew install bindsch/tap/usagemux");
  });

  test("doctor reports an installed but untrusted usagemux", async () => {
    const fake = createFakeBinaryEnv({ usagemux: "exit 0" });
    try {
      // Group-writable fails the trust check every codemux executable
      // goes through; doctor names the issue instead of a silent pass.
      chmodSync(join(fake.env.PATH!.split(":")[0]!, "usagemux"), 0o775);
      const { stdout } = await runCli(["doctor"], fake.env);
      // Installed but unreadable, not missing (review round 361): the row
      // keeps the binary present and prescribes a reinstall.
      expect(stdout).toContain("usagemux: USAGEMUX-UNREADABLE: usagemux binary is not a trusted executable");
      expect(stdout).toContain("group- or world-writable");
      expect(stdout).toContain("brew reinstall bindsch/tap/usagemux");
    } finally {
      fake.cleanup();
    }
  });

  test("doctor shows default agent and model aliases", async () => {
    const { stdout } = await runCli(["doctor"], { PATH: minimalPath() });
    expect(stdout).toContain("Default agent: claude");
    expect(stdout).toContain("Model aliases available:");
    expect(stdout).toContain("sonnet:");
    expect(stdout).toContain("opus:");
    expect(stdout).toContain("gpt5:");
  });

  test("doctor shows capabilities for installed agents", async () => {
    const fake = createFakeBinaryEnv({
      claude: "exit 0",
    });
    try {
      const { stdout } = await runCli(["doctor"], fake.env);
      expect(stdout).toContain("claude (claude): ✅ installed");
      expect(stdout).toContain("Non-interactive: yes");
      expect(stdout).toContain("Interactive: yes");
      expect(stdout).toContain("Model selection: yes");
      expect(stdout).toContain("Autonomy levels:");
    } finally {
      fake.cleanup();
    }
  });

  test("doctor stays under one second with fake harnesses", async () => {
    // The version probes run in parallel with a bounded probe each; serial
    // probes cost the sum of every startup (about 4.8 s on a machine with
    // 14 harnesses installed). With fakes the whole report must stay fast.
    // Exit is 1: the installed harnesses have no credentials in the
    // throwaway HOME, which is a broken row, not a slow one.
    const fake = createFakeBinaryEnv({
      claude: `if [ "$1" = "--version" ]; then printf '2.1.300 (Claude Code)\\n'; fi`,
      codex: `if [ "$1" = "--version" ]; then printf 'codex-cli 0.165.0\\n'; fi`,
      gemini: `if [ "$1" = "--version" ]; then printf 'gemini version 1.2.3\\n'; fi`,
      goose: `if [ "$1" = "--version" ]; then printf 'goose version 1.0.0\\n'; fi`,
    });
    try {
      const started = Date.now();
      const { exitCode } = await runCli(["doctor"], fake.env);
      const elapsed = Date.now() - started;
      expect(exitCode).toBe(1);
      expect(elapsed).toBeLessThan(1_000);
    } finally {
      fake.cleanup();
    }
  });

  test("doctor reports a harness whose version probe times out", async () => {
    // A hanging version command must not hang the report: --timeout bounds
    // the probe and the row prints the timeout verdict. The test's own
    // bound must clear the 2 s probe plus CLI startup.
    const fake = createFakeBinaryEnv({
      scode: fakeScodeHelp(),
      claude: `if [ "$1" = "--version" ]; then sleep 30; fi`,
    });
    try {
      const { stdout, exitCode } = await runCli(
        ["doctor", "--only", "claude", "--timeout", "2"],
        fake.env
      );
      expect(exitCode).toBe(0);
      expect(stdout).toContain("unreadable (timed out)");
    } finally {
      fake.cleanup();
    }
  }, 15_000);
});

describe("CLI - Unknown options", () => {
  test("unknown option shows error", async () => {
    const { stderr, exitCode } = await runCli(["run", "--unknown-option", "test"]);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("unknown option");
  });

  test("tui with unknown option shows error", async () => {
    const { stderr, exitCode } = await runCli(["tui", "--unknown"]);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("unknown option");
  });
});

describe("CLI - Option validation", () => {
  test("check with invalid autonomy level shows error", async () => {
    const { stderr, exitCode } = await runCli(["check", "--auto", "invalid-level"]);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("Invalid value 'invalid-level' for --auto");
  });

  test("tui with invalid effort level shows error", async () => {
    const { stderr, exitCode } = await runCli(["tui", "--effort", "impossible"]);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("Invalid value 'impossible' for --effort");
  });

  test("tui with invalid sandbox trust level shows error", async () => {
    const { stderr, exitCode } = await runCli(["tui", "--sandbox-trust", "danger"]);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("Invalid value 'danger' for --sandbox-trust");
    expect(stderr).toContain("trusted, standard, untrusted");
  });

  test("tui accepts Goose model selection", async () => {
    const fake = createFakeBinaryEnv({
      goose: "exit 0",
    });
    try {
      const { stderr, exitCode } = await runCli(
        ["tui", "--no-sandbox", "--auto", "high", "-a", "goose", "-m", "provider/model"],
        fake.env
      );
      expect(exitCode).toBe(0);
      expect(stderr).not.toContain("does not support model selection");
    } finally {
      fake.cleanup();
    }
  });
});

describe("CLI - Default values", () => {
  test("run uses claude as default agent", async () => {
    const { stdout } = await runCli(["run", "--help"]);
    expect(stdout).toContain('default: "claude"');
  });

  test("run uses read-only as default autonomy", async () => {
    const { stdout } = await runCli(["run", "--help"]);
    expect(stdout).toContain("read-only");
    expect(stdout).toContain("(default:");
  });
});

describe("CLI - Configuration recovery", () => {
  test("help and doctor remain available when configuration is malformed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "codemux-invalid-config-"));
    const configDir = join(dir, "codemux");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, "config.yaml"), "default_agent: codex\n");
    try {
      const env = { XDG_CONFIG_HOME: dir, PATH: minimalPath() };
      const help = await runCli(["--help"], env);
      expect(help.exitCode).toBe(0);
      expect(help.stdout).toContain("Usage: codemux");

      const doctor = await runCli(["doctor"], env);
      // A config error is doctor's own exit lane (2), ahead of any row.
      expect(doctor.exitCode).toBe(2);
      expect(doctor.stdout).toContain("config: invalid:");
      expect(doctor.stdout).toContain("unknown configuration key");

      const run = await runCli(["run", "-p", "test"], env);
      expect(run.exitCode).not.toBe(0);
      expect(run.stderr).toContain("unknown configuration key");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
