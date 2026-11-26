import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { KEYCHAIN_DIRECTORY, linkAccountKeychain } from "../src/darwin-keychain-home.js";
import { spawnGuarded, spawnScodeProbe, spawnSyncGuarded } from "../src/guarded-spawn.js";
import {
  NO_DEFAULT_KEYCHAIN, accountHasLoginKeychain, darwinWith, defaultKeychainStatus, fakeAccountHome, scratchRoot,
} from "./helpers/keychain-home.js";

// macOS only. A child process is started with HOME set to a directory and
// asks Security.framework for the default keychain. The call returns a
// status and shows no window; nothing is stored or read. The stand-in
// account holds an empty file named login.keychain-db, which is what the
// lookup checks for, so these tests also run on an account with no login
// keychain of its own.
const darwin = process.platform === "darwin";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function privateHome(): { root: string; account: string; home: string } {
  const root = scratchRoot("keychain-resolution");
  roots.push(root);
  const home = join(root, "private");
  mkdirSync(home);
  return { root, account: fakeAccountHome(root), home };
}

describe.skipIf(!darwin)("default keychain resolution in a child process", () => {
  test("an unprepared private home has no default keychain (the test can fail)", () => {
    const { home } = privateHome();
    expect(defaultKeychainStatus(home)).toBe(NO_DEFAULT_KEYCHAIN);
  });

  test("a home prepared by linkAccountKeychain resolves the default keychain", () => {
    const { account, home } = privateHome();
    linkAccountKeychain(home, darwinWith(account));
    expect(defaultKeychainStatus(home)).toBe(0);
  });

  test("an empty Keychains directory does not resolve until the function replaces it", () => {
    const { account, home } = privateHome();
    mkdirSync(join(home, KEYCHAIN_DIRECTORY), { recursive: true });
    expect(defaultKeychainStatus(home)).toBe(NO_DEFAULT_KEYCHAIN);
    linkAccountKeychain(home, darwinWith(account));
    expect(defaultKeychainStatus(home)).toBe(0);
  });

  test("a home created by the function resolves", () => {
    const { root, account } = privateHome();
    const home = join(root, "created-later");
    linkAccountKeychain(home, darwinWith(account));
    expect(defaultKeychainStatus(home)).toBe(0);
  });

  test("the test preload's HOME resolves, so binaries the suite starts are not in the dialog state", () => {
    if (!accountHasLoginKeychain()) return; // an account without a login keychain: nothing to link
    expect(defaultKeychainStatus(process.env.HOME!)).toBe(0);
  });
});

describe("the scode probe spawn", () => {
  test("starts only `scode --version` and `scode --help`, and never a harness", async () => {
    const { root } = privateHome();
    const scode = join(root, "scode");
    writeFileSync(scode, "#!/bin/sh\necho 'scode 0.6.11'\n", { mode: 0o755 });
    for (const flag of ["--version", "--help"]) {
      const child = spawnScodeProbe([scode, flag], { env: { PATH: "/usr/bin:/bin" }, stdout: "pipe" });
      expect(await child.exited).toBe(0);
    }
    const refused = [[scode, "--", "harness"], [scode, "--version", "extra"], [scode], [scode, "run"],
      ["/usr/bin/env", `HOME=${root}`, "harness"], [scode, "--", "/usr/bin/env", "harness", "--version"]];
    for (const command of refused) expect(() => spawnScodeProbe(command, {})).toThrow("starts only");
    expect(() => spawnScodeProbe({ cmd: [scode, "--version"] })).toThrow("starts only");
  });

  test("leaves the HOME in its environment untouched, so a preview writes nothing", async () => {
    const { root } = privateHome();
    const scode = join(root, "scode");
    writeFileSync(scode, "#!/bin/sh\necho 'scode 0.6.11'\n", { mode: 0o755 });
    const preview = join(root, "preview-home");
    const child = spawnScodeProbe([scode, "--version"], { env: { HOME: preview, PATH: "/usr/bin:/bin" }, stdout: "pipe" });
    expect(await child.exited).toBe(0);
    expect(existsSync(preview)).toBe(false);
  });
});

// The guarded spawn functions use the real account home, as a launch does.
// The spawns run on every platform; the keychain assertions apply on macOS
// when the account has a login keychain, and nothing is linked elsewhere.
describe("guarded spawn", () => {
  const probe = [process.execPath, "-e", "console.log(process.env.HOME)"];
  const linked = accountHasLoginKeychain();
  const expectHome = (home: string): void => {
    if (linked) expect(defaultKeychainStatus(home)).toBe(0);
    else expect(existsSync(join(home, "Library"))).toBe(false);
  };

  test("a child started with a private HOME in its environment finds a default keychain", async () => {
    const { home } = privateHome();
    const child = spawnGuarded(probe, { env: { HOME: home, PATH: "/usr/bin:/bin" }, stdout: "pipe" });
    expect(await child.exited).toBe(0);
    expectHome(home);
  });

  test("a child started behind `env HOME=<dir>` finds a default keychain there", () => {
    const { home } = privateHome();
    const child = spawnSyncGuarded(["/usr/bin/env", `HOME=${home}`, ...probe], { env: { PATH: "/usr/bin:/bin" }, stdout: "pipe" });
    expect(child.stdout.toString().trim()).toBe(home);
    expectHome(home);
  });

  test("the object form of the spawn call is checked too", async () => {
    const { home } = privateHome();
    const child = spawnGuarded({ cmd: probe, env: { HOME: home, PATH: "/usr/bin:/bin" }, stdout: "pipe" });
    expect(await child.exited).toBe(0);
    expectHome(home);
  });

  test.skipIf(!linked)("a home that cannot be linked refuses before any process starts", () => {
    const { root, home } = privateHome();
    mkdirSync(join(home, KEYCHAIN_DIRECTORY), { recursive: true });
    writeFileSync(join(home, KEYCHAIN_DIRECTORY, "other.keychain-db"), "");
    const marker = join(root, "started");
    const touch = ["/usr/bin/touch", marker];
    expect(() => spawnGuarded(touch, { env: { HOME: home } })).toThrow(/A keychain cannot be found to store/);
    expect(() => spawnSyncGuarded(["/usr/bin/env", `HOME=${home}`, ...touch], { env: {} })).toThrow(/A keychain cannot be found to store/);
    expect(existsSync(marker)).toBe(false);
  });
});
