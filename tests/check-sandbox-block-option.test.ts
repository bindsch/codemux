/**
 * `check --sandbox-block` is repeatable (audit round 2, A8): the option
 * accumulates every value before the absolute-path rule judges them, and a
 * relative path is the same exit-64 refusal run and tui give. In process,
 * so the accumulator itself runs under coverage; nothing spends.
 */

import { expect, spyOn, test } from "bun:test";
import { Command } from "commander";
import { registerCheckCommand } from "../src/check-command.js";
import { getDefaultConfig } from "../src/config.js";
import { createRunFakeBinaryEnv as createFakeBinaryEnv } from "./helpers/cli.js";

test("a relative --sandbox-block path is a usage refusal after both values accumulate", async () => {
  const fake = createFakeBinaryEnv({ claude: "exit 0", scode: "exit 0" });
  const program = new Command();
  program.exitOverride();
  registerCheckCommand(program, getDefaultConfig(), () => {});
  const errors: string[] = [];
  const error = spyOn(console, "error").mockImplementation((...values: unknown[]) => {
    errors.push(values.map(String).join(" "));
  });
  const exit = spyOn(process, "exit").mockImplementation(((code?: string | number | null) => {
    throw new Error(`exit ${String(code)}`);
  }) as typeof process.exit);
  const originalPath = process.env.PATH;
  const originalExitCode = process.exitCode;
  process.env.PATH = fake.env.PATH;
  try {
    let thrown: unknown;
    try {
      await program.parseAsync(["check", "-a", "claude", "--sandbox-block", "/a", "--sandbox-block", "relative"], { from: "user" });
    } catch (caught) {
      thrown = caught;
    }
    // The refusal exits through process.exit (the spy above turns it into
    // the sentinel error); a stale process.exitCode from an earlier test
    // must not be read before it.
    const sentinel = thrown instanceof Error ? /exit (\d+)/.exec(thrown.message)?.[1] : undefined;
    const code = sentinel !== undefined
      ? Number(sentinel)
      : typeof process.exitCode === "number" ? process.exitCode : undefined;
    expect(code).toBe(64);
    expect(errors.join("\n")).toContain("--sandbox-block requires absolute paths");
  } finally {
    error.mockRestore();
    exit.mockRestore();
    process.env.PATH = originalPath;
    process.exitCode = originalExitCode;
    fake.cleanup();
  }
});
