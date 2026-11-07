/** The `run --max-budget-usd` flag surface: value parsing, the capability
 * refusal on harnesses without the flag, the printed-argv carry-through,
 * and the tui/session refusals. All synthetic — fake binaries on a fake
 * PATH, no harness is run. */

import { describe, expect, test } from "bun:test";
import { parseBudgetUsdOption } from "../src/cli-runtime/options.js";
import { createFakeBinaryEnv, minimalPath, runCli } from "./helpers/cli.js";

describe("CLI - run --max-budget-usd", () => {
  test("every invalid amount is a usage refusal before anything spawns", async () => {
    // Each row is refused at parse time, ahead of the prompt read, the
    // adapter checks, and every availability gate, so minimalPath (no
    // harness installed) still reaches the refusal with exit 64.
    const malformed = ["abc", "-5", "NaN", "Infinity", "1.234", ".5", "5.", "1e3", ""];
    for (const value of malformed) {
      const { stderr, exitCode } = await runCli(
        ["run", "-a", "claude", "-p", "test", "--max-budget-usd", value],
        { PATH: minimalPath() }
      );
      expect(exitCode, value).toBe(64);
      expect(stderr, value).toContain(
        "--max-budget-usd must be a positive dollar amount written as a decimal with at most ten integer digits and two fraction digits"
      );
    }
    // Zero is well-formed but caps the run at nothing, so it is refused on
    // its value, with its own message.
    for (const value of ["0", "0.00"]) {
      const { stderr, exitCode } = await runCli(
        ["run", "-a", "claude", "-p", "test", "--max-budget-usd", value],
        { PATH: minimalPath() }
      );
      expect(exitCode, value).toBe(64);
      expect(stderr, value).toContain("--max-budget-usd must be greater than zero");
    }
  });

  test("a valid amount rides the printed sandbox argv exactly once", async () => {
    // --print-sandbox prints the scode argv one argument per line and runs
    // nothing, so it shows the flag the launch would carry end to end:
    // parsed to a number, rendered back as its one decimal spelling
    // ("2.50" and "2.5" are the same cap).
    const fake = createFakeBinaryEnv({
      claude: `if [ "$1" = "--version" ]; then printf '2.1.317 (Claude Code)\\n'; exit 0; fi
exit 7`,
      scode: "exit 9",
    });
    try {
      const { stdout, exitCode } = await runCli(
        ["run", "-a", "claude", "-p", "test", "--max-budget-usd", "2.50", "--print-sandbox"],
        fake.env
      );
      expect(exitCode).toBe(0);
      expect(stdout.match(/^--max-budget-usd$/gm)).toHaveLength(1);
      expect(stdout).toContain("--max-budget-usd\n2.5\n");
    } finally {
      fake.cleanup();
    }
  });

  test("harnesses without the flag refuse the request before any spawn", async () => {
    // The adapter validator refuses the request ahead of the
    // availability gates, so minimalPath reaches it: a dropped limit
    // would run uncapped under a caller who set one.
    for (const agent of ["codex", "kimi", "opencode", "agy"]) {
      const { stderr, exitCode } = await runCli(
        ["run", "-a", agent, "-p", "test", "--max-budget-usd", "5"],
        { PATH: minimalPath() }
      );
      expect(exitCode, agent).toBe(64);
      expect(stderr, agent).toContain(
        `${agent} has no spend limit flag; --max-budget-usd is unsupported`
      );
    }
  });

  test("tui refuses the flag with 64", async () => {
    // Claude Code applies the spend limit to --print runs only, so the
    // interactive command refuses it by name instead of letting commander
    // answer a generic parse error (exit 1).
    const { stderr, exitCode } = await runCli(
      ["tui", "-a", "claude", "--max-budget-usd", "5"],
      { PATH: minimalPath() }
    );
    expect(exitCode).toBe(64);
    expect(stderr).toContain("--max-budget-usd is not supported on tui");
    expect(stderr).toContain("headless runs only");
  });

  test("session refuses the flag with 64", async () => {
    const { stderr, exitCode } = await runCli(
      ["session", "-a", "claude", "--max-budget-usd", "5"],
      { PATH: minimalPath() }
    );
    expect(exitCode).toBe(64);
    expect(stderr).toContain("--max-budget-usd is not supported for sessions");
    expect(stderr).toContain("headless runs only");
  });

  test("the amount reaches the harness exactly as written: at most ten integer digits (review round 274)", () => {
    // A longer amount would round through the number the request carries
    // and reach the harness as more than the caller wrote.
    expect(String(parseBudgetUsdOption("9999999999.99"))).toBe("9999999999.99");
    expect(String(parseBudgetUsdOption("0.75"))).toBe("0.75");
    expect(() => parseBudgetUsdOption("9999999999999999.99")).toThrow("at most ten integer digits");
    expect(() => parseBudgetUsdOption("12345678901")).toThrow("at most ten integer digits");
  });
});
