import { describe, test, expect } from "bun:test";

async function runCli(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(["bun", "run", "src/index.ts", ...args], {
    cwd: import.meta.dir + "/..",
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  return { stdout, stderr, exitCode };
}

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
    expect(stdout.trim()).toBe("0.1.0");
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
    expect(stdout).toContain("--sandbox-allow-net");
    expect(stdout).toContain("--sandbox-keep-env");
    expect(stdout).toContain("--sandbox-no-defaults");
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
    expect(stdout).toContain("--sandbox-allow-net");
    expect(stdout).toContain("--sandbox-keep-env");
    expect(stdout).toContain("--sandbox-no-defaults");
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
    expect(stdout).toContain("--sandbox-allow-net");
    expect(stdout).toContain("--sandbox-keep-env");
    expect(stdout).toContain("--sandbox-no-defaults");
  });
});

describe("CLI - List", () => {
  test("list shows all agents", async () => {
    const { stdout } = await runCli(["list"]);
    expect(stdout).toContain("Available agents:");
    expect(stdout).toContain("claude");
    expect(stdout).toContain("codex");
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
    expect(stdout).toContain("| codex |");
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

  test("verify --show-scode uses stricter default trust for low autonomy", async () => {
    const { stdout, exitCode } = await runCli(["verify", "-a", "codex", "--show-scode"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("| codex | low | run | `scode --trust untrusted --rw --");
  });

  test("verify --show-scode uses stricter medium trust for coarse harnesses", async () => {
    const { stdout, exitCode } = await runCli(["verify", "-a", "opencode", "--show-scode"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("| opencode | medium | run | `scode --trust untrusted --rw --");
  });

  test("verify sandbox preview flags without --show-scode warns", async () => {
    const { stderr, exitCode } = await runCli(["verify", "--sandbox-no-net"]);
    expect(exitCode).toBe(0);
    expect(stderr).toContain("sandbox policy flags require --show-scode");
  });

  test("verify with conflicting sandbox policy flags fails", async () => {
    const { stderr, exitCode } = await runCli([
      "verify",
      "--show-scode",
      "--sandbox-no-net",
      "--sandbox-allow-net",
    ]);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("--sandbox-no-net cannot be combined with --sandbox-allow-net");
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
    const { stdout } = await runCli(["doctor"]);
    expect(stdout).toContain("Non-interactive: yes");
    expect(stdout).toContain("Interactive: yes");
    expect(stdout).toContain("Model selection: yes");
    expect(stdout).toContain("Autonomy levels:");
    expect(stdout).toContain("Effort levels:");
  });
});

describe("CLI - Run validation", () => {
  test("run without prompt shows error", async () => {
    const { stderr, exitCode } = await runCli(["run"]);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("No prompt provided");
  });

  test("run with unknown agent shows error", async () => {
    const { stderr, exitCode } = await runCli(["run", "-a", "unknown", "-p", "test"]);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("Unknown agent");
  });

  test("run with unavailable agent shows error", async () => {
    const { stderr, exitCode } = await runCli(["run", "-a", "goose", "-p", "test"]);
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
    const { stderr, exitCode } = await runCli(["run", "--effort", "ultra", "-p", "test"]);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("Invalid value 'ultra' for --effort");
    expect(stderr).toContain("none, low, medium, high");
  });

  test("run with invalid sandbox trust level shows error", async () => {
    const { stderr, exitCode } = await runCli(["run", "--sandbox-trust", "danger", "-p", "test"]);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("Invalid value 'danger' for --sandbox-trust");
    expect(stderr).toContain("trusted, standard, untrusted");
  });
});

describe("CLI - Run warnings (no actual execution)", () => {
  test("effort flag on unsupported agent shows warning in stderr", async () => {
    const { stderr } = await runCli(["run", "-a", "goose", "--effort", "high", "-p", "test"]);
    expect(stderr).toContain("not installed");
  });
});

describe("CLI - File input validation", () => {
  test("run with nonexistent file shows error", async () => {
    const { stderr, exitCode } = await runCli(["run", "-f", "/nonexistent/file.txt"]);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("Could not read file");
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
