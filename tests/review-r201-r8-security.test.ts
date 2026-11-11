import { afterEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";
import { prepareRunDirParent } from "../src/hermetic-sweep.js";
import { sessionRegistryPath } from "../src/session/registry.js";
import { acquireLock, listHeldLocks } from "../src/session/registry-io.js";
import { updateRegistry } from "../src/session/registry/mutations.js";
import { writePrivateFile } from "../src/private-write.js";
import { syncKeychainCredential } from "../src/credentials.js";
import { BACKUPS, SECRET, withTarget } from "./helpers/credentials.js";
import { createCodexHermeticHome } from "../src/hermetic-home.js";
import { sweepStaleHomes } from "../src/adapters/agy-homes.js";
import { ClaudeAdapter } from "../src/adapters/claude.js";

const roots: string[] = [];
const root = () => {
  const parent = join(import.meta.dir, "../scratch/fix");
  fs.mkdirSync(parent, { recursive: true });
  const path = fs.realpathSync(fs.mkdtempSync(join(parent, "r8-security-")));
  roots.push(path); return path;
};
afterEach(() => { for (const path of roots.splice(0)) fs.rmSync(path, { recursive: true, force: true }); });

for (const entry of ["session-safe", "session-home-0123456789ab-safe"]) {
  test(`${entry}: resume cannot claim between the sweep's check and removal`, () => {
    const home = root(), dir = join(home, ".codemux-hermetic", entry);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const old = new Date(Date.now() - 35 * 86400_000);
    fs.utimesSync(dir, old, old);
    const registry = sessionRegistryPath();
    let lockedAtCheck = false, lockedAtDelete = false, contenderWasBusy = false;
    const remove = fs.rmSync;
    const spy = spyOn(fs, "rmSync").mockImplementation((path, options) => {
      if (String(path) === dir) {
        lockedAtDelete = listHeldLocks(`${registry}.lock`).length === 1;
        const contender = updateRegistry(registry, () => null, "fail", { attempts: 1 });
        contenderWasBusy = !contender.ok && contender.kind === "busy";
      }
      return remove(path, options);
    });
    try {
      prepareRunDirParent(home, ".codemux-hermetic", () => {
        lockedAtCheck = listHeldLocks(`${registry}.lock`).length === 1;
        return "free";
      });
      expect([lockedAtCheck, lockedAtDelete, contenderWasBusy]).toEqual([true, true, true]);
      expect(fs.existsSync(dir)).toBe(false);
      expect(listHeldLocks(`${registry}.lock`)).toEqual([]);
    } finally { spy.mockRestore(); }
  });
  test(`${entry}: a concurrent registry writer spares stale state`, () => {
    const home = root(), dir = join(home, ".codemux-hermetic", entry);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const old = new Date(Date.now() - 35 * 86400_000); fs.utimesSync(dir, old, old);
    updateRegistry(sessionRegistryPath(), () => false, "fail");
    const lock = acquireLock(`${sessionRegistryPath()}.lock`, { attempts: 1 });
    try {
      prepareRunDirParent(home, ".codemux-hermetic", () => "free");
      expect(fs.existsSync(dir)).toBe(true);
    } finally { lock.release(); }
  });
}

test("credential symlink swap during the Keychain read refuses launch", () => {
  withTarget((target, dir) => {
    const real = join(dir, "swapped.json");
    const readSecret = () => {
      fs.renameSync(target, real); fs.symlinkSync(real, target);
      return { kind: "secret" as const, value: SECRET };
    };
    expect(syncKeychainCredential("fixture", target, readSecret, BACKUPS(target))).toBe("unsafe");
    expect(fs.lstatSync(target).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(real, "utf8")).toContain("refreshToken");
  });
});

test("private writes reject every path-shaped name before creating anything", () => {
  const base = root(), dir = join(base, "private"); fs.mkdirSync(dir, { mode: 0o700 });
  for (const name of ["../outside", "/outside", "sub/file", "sub\\file", ".", "..", "", "nul\0name"]) {
    expect(() => writePrivateFile(dir, name, "secret")).toThrow("one path component");
  }
  expect(fs.readdirSync(base)).toEqual(["private"]);
  expect(fs.readdirSync(dir)).toEqual([]);
});

test("hermetic creation preserves the original error when finalize also fails", () => {
  const base = root(); fs.writeFileSync(join(base, "auth.json"), "{}");
  const original = new Error("login link creation failed");
  const before = new Set(process.listeners("exit"));
  const remove = spyOn(fs, "rmSync").mockImplementation(() => { throw new Error("cleanup denied"); });
  try {
    let caught: unknown;
    try { createCodexHermeticHome(base, false, {
      hard: () => { throw original; }, symlink: () => { throw original; },
    }); } catch (error) { caught = error; }
    expect(caught).toBe(original);
    expect(original.message).toContain("login link creation failed; cleanup failed:");
    expect(original.message).toContain("cleanup denied");
  } finally {
    remove.mockRestore();
    for (const hook of process.listeners("exit")) if (!before.has(hook)) (hook as () => void)();
  }
});

test("Agy sweep accepts a canonical root on platforms without getuid", () => {
  const base = root(), descriptor = Object.getOwnPropertyDescriptor(process, "getuid")!;
  Object.defineProperty(process, "getuid", { configurable: true, value: undefined });
  try { expect(() => sweepStaleHomes(base)).not.toThrow(); }
  finally { Object.defineProperty(process, "getuid", descriptor); }
});

test("undefined Claude profile redirects do not reach path APIs", () => {
  class InspectClaude extends ClaudeAdapter {
    report() { this.reportProfileRedirects("fixture", ["CLAUDE_CONFIG_DIR", "CLAUDE_SECURESTORAGE_CONFIG_DIR"]); }
  }
  const adapter = new InspectClaude({ CLAUDE_CONFIG_DIR: undefined, CLAUDE_SECURESTORAGE_CONFIG_DIR: undefined });
  expect(() => adapter.report()).not.toThrow();
});
