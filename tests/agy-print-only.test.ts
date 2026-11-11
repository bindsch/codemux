/**
 * A print-only agy launch (`--print-sandbox`) prepares the private HOME path
 * its argv names and nothing else: no `security` invocation of any kind, no
 * login mirror, no token copy, no search-list repair. On 2026-11-03 a
 * print-only path that prepared credentials put the macOS prompt "a keychain
 * cannot be found to store antigravity" on the operator's screen; this test
 * pins the rule at the adapter and through the CLI. The fake `security`
 * records every call it receives.
 */

import { afterEach, expect, test } from "bun:test";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { AGY_MIRROR_PATH } from "../src/agy-keychain.js";
import { runCli } from "./helpers/cli.js";
import { cleanup, setup } from "./helpers/agy-keychain.js";

afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn(); });

test("prepareRun with printOnly names an uncreated private HOME and never calls security", () => {
  const { adapter, request, calls, home } = setup();
  const context = adapter.prepareRun(request, undefined, {}, { printOnly: true });
  cleanup.push(() => adapter.cleanupRun(context));
  const privateHome = context.agyProbe!.home!;
  expect(privateHome.startsWith(join(realpathSync(home), ".gemini"))).toBe(true);
  expect(existsSync(privateHome)).toBe(false);
  // No mirror, no token copy, no security call: the file the fake writes
  // on its first invocation never appears.
  expect(existsSync(join(privateHome, AGY_MIRROR_PATH))).toBe(false);
  expect(existsSync(join(privateHome, ".gemini/antigravity-cli/antigravity-oauth-token"))).toBe(false);
  expect(existsSync(calls)).toBe(false);
  adapter.cleanupRun(context);
  expect(existsSync(privateHome)).toBe(false);
  expect(existsSync(calls)).toBe(false);
});

test("a plain prepareRun still builds the mirror (the print-only rule is not the default)", () => {
  const { adapter, request, records } = setup();
  const context = adapter.prepareRun(request);
  cleanup.push(() => adapter.cleanupRun(context));
  expect(records().some((record) => record.input[0] === "create-keychain" || record.input[0] === "unlock-keychain")).toBe(true);
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
