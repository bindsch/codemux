import { describe, test, expect } from "bun:test";
import {
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
      const proc = Bun.spawn([linkedBin, "doctor"], {
        cwd: hostile,
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          HOME: home,
          PATH: minimalPath(),
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
    expect(stdout).toContain("[model, autonomy]");
    expect(stdout).toContain("[model, autonomy, effort]");
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
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("Unknown agent");
  });

  test("verify --show-scode prints effective command matrix", async () => {
    const { stdout, exitCode } = await runCli(["verify", "-a", "codex", "--show-scode"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Effective scode command preview");
    expect(stdout).toContain("| Agent | Autonomy | Mode | Command |");
    expect(stdout).toContain("| codex | read-only | run |");
    expect(stdout).toContain("`scode --trust");
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
    expect(stdout).toContain("scode --trust trusted --ro --no-net --scrub-env --");
  });

  test("verify --show-scode keeps hosted agents network-capable", async () => {
    const { stdout, exitCode } = await runCli(["verify", "-a", "codex", "--show-scode"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("| codex | low | run | `scode --trust standard --rw --");
  });

  test("verify --show-scode uses explicit standard trust for coarse harnesses", async () => {
    const { stdout, exitCode } = await runCli(["verify", "-a", "opencode", "--show-scode"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("| opencode | medium | run | `scode --trust standard --rw --");
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
  test("doctor shows agent status", async () => {
    const { stdout } = await runCli(["doctor"]);
    expect(stdout).toContain("Checking AI coding agents");
    expect(stdout).toContain("claude (claude):");
    expect(stdout).toContain("codex (codex):");
    expect(stdout).toContain("droid (droid):");
    expect(stdout).toContain("goose (goose):");
    expect(stdout).toContain("gemini (gemini):");
    expect(stdout).toContain("opencode (opencode):");
    expect(stdout).toContain("pi (pi):");
    expect(stdout).toContain("qwen (qwen):");
    expect(stdout).toContain("zai (claude):");
  });

  test("doctor shows summary", async () => {
    const { stdout } = await runCli(["doctor"]);
    expect(stdout).toContain("Summary:");
    expect(stdout).toContain("installed");
    expect(stdout).toContain("missing");
  });

  test("doctor shows default agent", async () => {
    const { stdout } = await runCli(["doctor"]);
    expect(stdout).toContain("Default agent: claude");
  });

  test("doctor shows model aliases", async () => {
    const { stdout } = await runCli(["doctor"]);
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
        ["tui", "-a", "goose", "-m", "provider/model"],
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
      const env = { XDG_CONFIG_HOME: dir };
      const help = await runCli(["--help"], env);
      expect(help.exitCode).toBe(0);
      expect(help.stdout).toContain("Usage: codemux");

      const doctor = await runCli(["doctor"], env);
      expect(doctor.exitCode).toBe(1);
      expect(doctor.stdout).toContain("Configuration: ❌");
      expect(doctor.stdout).toContain("unknown configuration key");

      const run = await runCli(["run", "-p", "test"], env);
      expect(run.exitCode).not.toBe(0);
      expect(run.stderr).toContain("unknown configuration key");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
