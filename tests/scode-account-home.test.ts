import { expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { accountHome } from "../src/account-home.js";
import { applyHarnessHomeSandboxBlocks } from "../src/launch/harness-home-sandbox.js";
import { buildScodeCommand, scodeAccountHomeBlock, type SandboxOptions } from "../src/sandbox.js";

// Live gate 2026-11-12, OpenCode K: the probe plants a synthetic HOME, and
// scode 0.6.6 then blocks the real account home wholesale. The harness
// binary in the real home (~/.opencode/bin/opencode) was denied with
// "env: ...: Operation not permitted" because no grant matched it.

test("the account home blocks only when HOME names a different directory", () => {
  const account = process.cwd();
  expect(scodeAccountHomeBlock({ HOME: account }, account)).toEqual([]);
  expect(scodeAccountHomeBlock({ HOME: join(account, "src") }, account)).toEqual([account]);
  expect(scodeAccountHomeBlock({ HOME: join(account, "missing-home") }, account)).toEqual([]);
  expect(scodeAccountHomeBlock({ HOME: join(account, "src") }, null)).toEqual([]);
});

test.skipIf(accountHome() === null)("the account home comes from the password database, not HOME", () => {
  const other = join(process.cwd(), "scratch", "fix", "other-home");
  mkdirSync(other, { recursive: true });
  try {
    const child = Bun.spawnSync([process.execPath, "-e",
      'import { accountHome } from "./src/account-home.ts"; console.log(accountHome());'],
      { cwd: process.cwd(), env: { ...process.env, HOME: other } });
    expect(child.stdout.toString().trim()).toBe(accountHome()!);
  } finally {
    rmSync(other, { recursive: true, force: true });
  }
});

test.skipIf(accountHome() === null)("a synthetic HOME grants the harness binary under the account home", () => {
  const account = accountHome()!;
  const binary = join(account, ".opencode", "bin", "opencode");
  const synthetic = join(process.cwd(), "scratch", "fix", "synthetic-home");
  const privateHome = join(process.cwd(), "scratch", "fix", "caller");
  mkdirSync(synthetic, { recursive: true });
  const options: SandboxOptions = {};
  applyHarnessHomeSandboxBlocks(options, privateHome, [join(synthetic, ".opencode")]);
  const command = ["/usr/bin/env", `HOME=${privateHome}`, binary, "run"];
  const allows = (env: NodeJS.ProcessEnv) => {
    const argv = buildScodeCommand(command, process.cwd(), "read-only", options, undefined, env);
    return argv.flatMap((arg, i) => arg === "--allow" ? [argv[i + 1]] : []);
  };
  try {
    expect(allows({ HOME: synthetic })).toContain(binary);
    // With the real HOME, scode adds no account-home block, so no grant either.
    expect(allows({ HOME: account })).not.toContain(binary);
  } finally {
    rmSync(synthetic, { recursive: true, force: true });
  }
});
