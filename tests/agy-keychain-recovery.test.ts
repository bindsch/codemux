import { afterEach, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AgyAdapter } from "../src/adapters/agy.js";
import { AGY_MIRROR_PATH, agyKeychainHost, recoverAgyKeychainSearchList, verifyAgyKeychainSearchList } from "../src/agy-keychain.js";
import type { RunRequest } from "../src/types.js";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn(); });

function setup(includeMirror = true) {
  const scratch = join(import.meta.dir, "../scratch");
  mkdirSync(scratch, { recursive: true });
  const home = mkdtempSync(join(scratch, "agy-recovery-"));
  cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  const homeMock = spyOn(agyKeychainHost, "home").mockReturnValue(home);
  const securityMock = spyOn(agyKeychainHost, "securityPath").mockReturnValue(process.execPath);
  cleanup.push(() => homeMock.mockRestore(), () => securityMock.mockRestore());
  const original = join(home, AGY_MIRROR_PATH);
  const mirror = join(home, ".gemini/.codemux-isolation-probes/run-crashed", AGY_MIRROR_PATH);
  let list = includeMirror ? [original, mirror] : [original];
  const calls: string[][] = [];
  const result = (stdout = "", exitCode = 0) => ({ stdout: Buffer.from(stdout), stderr: Buffer.alloc(0), exitCode, signalCode: null });
  const spawn = spyOn(agyKeychainHost, "spawnSync").mockImplementation(((command: string[]) => {
    const args = command.slice(1);
    calls.push(args);
    if (args[0] === "list-keychains") {
      if (args.includes("-s")) list = args.slice(4);
      return result(list.map((path) => `"${path}"\n`).join(""));
    }
    return result("", 1);
  }) as unknown as typeof Bun.spawnSync);
  cleanup.push(() => spawn.mockRestore());
  return { home, original, mirror, calls, environment: { HOME: home, PATH: "/usr/bin:/bin" },
    currentList: () => list };
}

test("mirror search-list recovery only reads and restores the search list", () => {
  const state = setup();
  expect(() => recoverAgyKeychainSearchList(state.environment)).not.toThrow();
  expect(state.currentList()).toEqual([state.original]);
  expect(state.calls.every((args) => args[0] === "list-keychains")).toBe(true);
});

test("mirror cleanup verification only reads the search list", () => {
  const state = setup(false);
  expect(() => verifyAgyKeychainSearchList(state.environment)).not.toThrow();
  expect(state.calls).toEqual([["list-keychains", "-d", "user"]]);
});

test("failed mirror preparation never reads the default during recovery or cleanup", () => {
  const state = setup();
  const cwd = join(state.home, "work");
  mkdirSync(cwd);
  const adapter = new AgyAdapter(state.environment);
  const request: RunRequest = { agent: "agy", cwd, prompt: "unused", sandboxed: true, autonomy: "read-only" };
  expect(() => adapter.prepareRun(request)).toThrow("agy is not logged in");
  expect(state.calls.some((args) => args[0] === "find-generic-password")).toBe(true);
  expect(state.calls.filter((args) => args[0] === "default-keychain")).toEqual([]);
});

test.each(["GEMINI_API_KEY", "GOOGLE_API_KEY", "file"])("%s authentication never reads the real default during preparation or cleanup", (auth) => {
  const state = setup();
  const environment: NodeJS.ProcessEnv = { ...state.environment };
  if (auth === "file") {
    const directory = join(state.home, ".gemini/antigravity-cli");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "antigravity-oauth-token"), "synthetic file token");
  } else environment[auth] = "synthetic API key";
  const cwd = join(state.home, "work");
  mkdirSync(cwd);
  const adapter = new AgyAdapter(environment);
  const request: RunRequest = { agent: "agy", cwd, prompt: "unused", sandboxed: true, autonomy: "read-only" };
  const context = adapter.prepareRun(request);
  cleanup.push(() => adapter.cleanupRun(context));
  expect(existsSync(join(context.agyProbe!.home!, AGY_MIRROR_PATH))).toBe(false);
  adapter.cleanupRun(context);
  expect(state.calls.every((args) => args[0] === "list-keychains")).toBe(true);
  expect(state.currentList()).toEqual([state.original]);
});
