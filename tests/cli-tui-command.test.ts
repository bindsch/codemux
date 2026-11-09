import { describe, expect, spyOn, test } from "bun:test";
import { Command } from "commander";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDefaultConfig } from "../src/config.js";
import { registerTuiCommand } from "../src/tui-command.js";
import { createFakeBinaryEnv } from "./helpers/cli.js";

/**
 * The in-process side of the tui command: registerTuiCommand runs inside
 * the coverage process (option wiring, validation refusals, both launch
 * arms — runInteractive and the sandboxed scode spawn). `process.exit`
 * throws a sentinel carrying its code, as in cli-run-command.test.ts.
 */

class ExitSentinel extends Error {
  constructor(readonly code: number) {
    super(`process.exit(${code})`);
  }
}

// --version inside each contract's range; an interactive invocation exits
// with a distinctive code, so the test can tell the launch really ran.
const FAKE_CLAUDE = `if [ "$1" = "--version" ]; then printf '2.1.220 (Claude Code)\\n'; exit 0; fi
exit 7`;
const FAKE_DROID = `if [ "$1" = "--version" ]; then printf '0.186.0\\n'; exit 0; fi
exit 0`;
const FAKE_KIMI = `if [ "$1" = "--version" ]; then printf '2.4.0\\n'; exit 0; fi
exit 0`;

interface Outcome {
  stdout: string;
  stderr: string;
  warnings: string[];
  exitCode: number | undefined;
}

async function runTuiCommand(
  args: string[],
  binaries: Record<string, string> = { claude: FAKE_CLAUDE }
): Promise<Outcome> {
  const fake = createFakeBinaryEnv(binaries);
  const program = new Command();
  program.exitOverride();
  registerTuiCommand(program, getDefaultConfig(), () => {});
  const stderrLines: string[] = [];
  const warnings: string[] = [];
  const originalPath = process.env.PATH;
  const originalExitCode = process.exitCode;
  const error = spyOn(console, "error").mockImplementation((...values: unknown[]) => {
    stderrLines.push(values.map(String).join(" "));
  });
  const warn = spyOn(console, "warn").mockImplementation((...values: unknown[]) => {
    warnings.push(values.map(String).join(" "));
  });
  const exit = spyOn(process, "exit").mockImplementation(((code?: string | number | null) => {
    throw new ExitSentinel(typeof code === "number" ? code : 0);
  }) as typeof process.exit);
  process.env.PATH = fake.env.PATH;
  try {
    await program.parseAsync(["node", "codemux", ...args]);
    // exitCode is number | undefined in this outcome; the ambient field
    // admits string/null, so narrow it.
    const resolved = process.exitCode;
    return { stdout: "", stderr: stderrLines.join("\n"), warnings, exitCode: typeof resolved === "number" ? resolved : undefined };
  } catch (thrown) {
    if (thrown instanceof ExitSentinel) {
      return { stdout: "", stderr: stderrLines.join("\n"), warnings, exitCode: thrown.code };
    }
    throw thrown;
  } finally {
    process.env.PATH = originalPath;
    process.exitCode = originalExitCode;
    error.mockRestore();
    warn.mockRestore();
    exit.mockRestore();
    fake.cleanup();
  }
}

describe("the tui command in process", () => {
  test("a non-sandboxed tui runs the harness interactively", async () => {
    const outcome = await runTuiCommand(["tui", "--no-sandbox", "--auto", "high", "-a", "claude"]);
    expect(outcome.exitCode).toBe(7);
  });

  test("a sandboxed tui builds the scode argv and runs it", async () => {
    const argvDir = mkdtempSync(join(tmpdir(), "codemux-tui-cmd-"));
    const argvFile = join(argvDir, "scode-argv.txt");
    try {
      const outcome = await runTuiCommand(
        ["tui", "-a", "claude", "--cwd", argvDir],
        {
          claude: FAKE_CLAUDE,
          scode: `printf '%s\\n' "$@" > ${argvFile}
exit 5`,
        }
      );
      expect(outcome.exitCode).toBe(5);
      const argv = readFileSync(argvFile, "utf8").split("\n");
      expect(argv.some((line) => line.endsWith("/claude"))).toBe(true);
      // Read-only autonomy rides scode's own flag.
      expect(argv).toContain("--ro");
    } finally {
      rmSync(argvDir, { recursive: true, force: true });
    }
  });

  test("a relative --sandbox-block path is a usage refusal after the repeatable option accumulates", async () => {
    const outcome = await runTuiCommand(["tui", "-a", "claude", "--sandbox-block", "/a", "--sandbox-block", "relative"]);
    expect(outcome.exitCode).toBe(64);
    expect(outcome.stderr).toContain("--sandbox-block requires absolute paths");
  });

  test("an unknown agent is a usage refusal: exit 64", async () => {
    const outcome = await runTuiCommand(["tui", "-a", "nope"]);
    expect(outcome.exitCode).toBe(64);
    expect(outcome.stderr).toContain("Unknown agent 'nope'");
  });

  test("an invalid autonomy value is refused with its allowed set", async () => {
    const outcome = await runTuiCommand(["tui", "--auto", "banana"]);
    expect(outcome.exitCode).toBe(1);
    expect(outcome.stderr).toContain("Invalid value 'banana' for --auto");
  });

  test("a missing harness is refused with its binary name", async () => {
    const outcome = await runTuiCommand(["tui", "--no-sandbox", "--auto", "high", "-a", "goose"]);
    expect(outcome.exitCode).toBe(1);
    expect(outcome.stderr).toContain("goose is not installed");
  });

  test("a sandboxed tui without scode is refused", async () => {
    const outcome = await runTuiCommand(["tui", "-a", "claude"]);
    expect(outcome.exitCode).toBe(1);
    expect(outcome.stderr).toContain("scode is not installed (required for --sandbox)");
  });

  test("--enable-playwright-mcp without --sandbox is refused", async () => {
    const outcome = await runTuiCommand(["tui", "--no-sandbox", "--auto", "high", "--enable-playwright-mcp"]);
    expect(outcome.exitCode).toBe(64);
    expect(outcome.stderr).toContain("--enable-playwright-mcp requires --sandbox");
  });

  test("an effort a harness cannot take in TUI mode refuses with exit 64", async () => {
    // Gemini 0.60.0 has no effort carrier at all (W4 moved droid's TUI
    // effort onto its settings file), so the refusal names the agent and
    // the value, never a silently dropped flag. Sandboxed launch: gemini
    // enforces no autonomy level on its own.
    const outcome = await runTuiCommand(
      ["tui", "-a", "gemini", "--effort", "low"],
      { gemini: "exit 0", scode: "exit 0" }
    );
    expect(outcome.exitCode).toBe(64);
    expect(outcome.stderr).toContain("gemini does not support reasoning effort 'low'");
  });

  test("an effort value outside the harness set refuses in TUI mode exactly as on run", async () => {
    const outcome = await runTuiCommand(
      ["tui", "--no-sandbox", "--auto", "high", "-a", "kimi", "--effort", "xhigh"],
      { kimi: FAKE_KIMI }
    );
    expect(outcome.exitCode).toBe(64);
    expect(outcome.stderr).toContain("kimi does not support reasoning effort 'xhigh'");
  });

  test("--effort none stays the no-flag spelling in TUI mode", async () => {
    const outcome = await runTuiCommand(
      ["tui", "--no-sandbox", "--auto", "high", "-a", "droid", "--effort", "none"],
      { droid: FAKE_DROID }
    );
    expect(outcome.exitCode).toBe(0);
    expect(outcome.warnings.join("\n")).not.toContain("--effort");
  });

  test("droid carries TUI model and effort through its settings file", async () => {
    // W4: the TUI selects model and effort via sessionDefaultSettings, so
    // -m and --effort launch instead of refusing. The settings file must
    // land in a scratch home, never the operator's real one.
    const home = mkdtempSync(join(tmpdir(), "codemux-tui-droid-"));
    const originalHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const outcome = await runTuiCommand(
        ["tui", "--no-sandbox", "--auto", "high", "-a", "droid", "-m", "any-model", "--effort", "low"],
        { droid: FAKE_DROID }
      );
      expect(outcome.exitCode).toBe(0);
      expect(outcome.stderr).not.toContain("TUI mode");
      expect(outcome.warnings.join("\n")).not.toContain("--effort");
    } finally {
      process.env.HOME = originalHome;
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("a model a harness cannot take in TUI mode is a usage refusal", async () => {
    const outcome = await runTuiCommand(
      ["tui", "--no-sandbox", "-a", "qwen", "-m", "any-model"],
      { "qwen-coder": "exit 0" }
    );
    expect(outcome.exitCode).toBe(64);
    expect(outcome.stderr).toContain("qwen does not support model selection in TUI mode");
  });
});
