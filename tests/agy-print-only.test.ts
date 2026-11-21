/**
 * A print-only agy launch (`--print-sandbox`) prepares the private HOME path
 * its argv names and nothing else: no `security` invocation of any kind, no
 * login preparation or native state changes. On 2026-11-03 a
 * print-only path that prepared credentials put the macOS prompt "a keychain
 * cannot be found to store antigravity" on the operator's screen; this test
 * pins the rule at the adapter and through the CLI.
 */

import { afterEach, expect, test } from "bun:test";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { runCli } from "./helpers/cli.js";
import { cleanup, setup } from "./helpers/agy-login.js";

afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn(); });

test("prepareRun with printOnly names an uncreated private HOME and never calls security", () => {
  const { adapter, request, calls, home } = setup();
  const context = adapter.prepareRun(request, undefined, {}, { printOnly: true });
  cleanup.push(() => adapter.cleanupRun(context));
  const privateHome = context.agyProbe!.home!;
  expect(privateHome.startsWith(join(realpathSync(home), ".gemini"))).toBe(true);
  expect(existsSync(privateHome)).toBe(false);
  // Preparation does not create a login or a child process.
  expect(existsSync(join(privateHome, ".gemini/antigravity-cli/antigravity-oauth-token"))).toBe(false);
  expect(existsSync(calls)).toBe(false);
  adapter.cleanupRun(context);
  expect(existsSync(privateHome)).toBe(false);
  expect(existsSync(calls)).toBe(false);
});

test("plain private preparation uses the API key without a credential subprocess", () => {
  const { adapter, request, calls } = setup();
  const context = adapter.prepareRun(request);
  cleanup.push(() => adapter.cleanupRun(context));
  expect(existsSync(calls)).toBe(false);
});

test("run -a agy -s --print-sandbox prints the argv, exits 0, and calls security never", async () => {
  const { env, calls, request } = setup();
  const { stdout, exitCode } = await runCli(
    ["run", "-a", "agy", "-s", "--print-sandbox", "--auto", "read-only", "--cwd", request.cwd!, "-p", "OK"],
    env
  );
  expect(exitCode).toBe(0);
  expect(stdout.split("\n").some((line) => line.endsWith("/agy"))).toBe(true);
  expect(existsSync(calls) ? readFileSync(calls, "utf8") : "").toBe("");
});

test("the recording security fake on PATH makes the never-call assertions able to fail", () => {
  const { env, calls } = setup();
  expect(existsSync(calls)).toBe(false);
  const probe = Bun.spawnSync(["security", "find-generic-password", "-s", "synthetic"], { env });
  expect(probe.exitCode).toBe(0);
  expect(readFileSync(calls, "utf8")).toBe("find-generic-password -s synthetic\n");
});
