/**
 * A usage refusal comes before the "is not installed" report on every
 * launching command (review round 159, finding 3, and the same order in
 * run, check, and session found while checking the fix). A malformed
 * request is the caller's mistake; reporting a missing harness or scode
 * first would send them to an installer for a typing error.
 *
 * No harness and no scode are on the PATH here, so a request check that
 * still ran after the availability check would exit 1 with "is not
 * installed" and fail its row.
 */
import { expect, test } from "bun:test";
import { minimalPath, runCli } from "./helpers/cli.js";

const refusals: Array<[string[], string]> = [
  [["run", "-a", "claude", "-p", "x", "--cwd", ""], "cwd must be a non-empty path"],
  [["run", "-a", "claude", "-p", "x", "--cwd", "/definitely/not/a/dir"], "/definitely/not/a/dir"],
  [["run", "-a", "claude", "-p", "x", "--quota-ceiling", ""], "--quota-ceiling must be a number from 0 to 100"],
  [["run", "-a", "claude", "-p", "x", "--quota-ceiling", "101"], "--quota-ceiling must be a number from 0 to 100"],
  [["tui", "-a", "claude", "--quota-ceiling", ""], "--quota-ceiling must be a number from 0 to 100"],
  [["check", "-a", "claude", "--cwd", ""], "cwd must be a non-empty path"],
  [["check", "-a", "claude", "--quota-ceiling", ""], "--quota-ceiling must be a number from 0 to 100"],
  [["check", "-a", "claude", "--label", ""], "invalid label"],
  [["check", "-a", "claude", "-m", " padded "], "invalid model name"],
  [["check", "-a", "agy", "--agy-isolation-probe", ""], "--agy-isolation-probe must be one of"],
  [["check", "-a", "agy", "--agy-isolation-probe", "nonsense"], "--agy-isolation-probe must be one of"],
  [["session", "-a", "claude", "--resume", ""], "--resume expects a UUID session id"],
  [["session", "-a", "claude", "--resume", "not-a-uuid"], "--resume expects a UUID session id"],
  [["session", "-a", "claude", "--quota-ceiling", ""], "--quota-ceiling must be a number from 0 to 100"],
];

test.each(refusals)("%j is a usage refusal, not an installation failure", async (args, message) => {
  const { exitCode, stderr } = await runCli(args, { PATH: minimalPath() }, { stdin: "" });
  expect(stderr).toContain(message);
  expect(stderr).not.toContain("is not installed");
  expect(exitCode).toBe(64);
});

const valid: string[][] = [
  ["run", "-a", "claude", "-p", "x"],
  ["run", "-a", "claude", "-p", "x", "--quota-ceiling", "50"],
  ["tui", "-a", "claude"],
  ["check", "-a", "claude"],
  ["session", "-a", "claude"],
];

test.each(valid.map((args) => [args]))("%j still reports the missing harness with exit 1", async (args) => {
  const { exitCode, stderr } = await runCli(args, { PATH: minimalPath() }, { stdin: "" });
  expect(stderr).toContain("claude is not installed");
  expect(exitCode).toBe(1);
});

test("run -f - with a missing harness does not wait for stdin", async () => {
  // The availability check stays ahead of the stdin read: the producer
  // here never closes the pipe, and the command still ends at once.
  const started = Date.now();
  const { exitCode, stderr } = await runCli(
    ["run", "-a", "claude", "-f", "-", "--timeout", "30"],
    { PATH: minimalPath() },
    { stdin: "", holdStdin: true }
  );
  expect(stderr).toContain("claude is not installed");
  expect(exitCode).toBe(1);
  expect(Date.now() - started).toBeLessThan(15_000);
}, 30_000);
