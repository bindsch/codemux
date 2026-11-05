/**
 * Unit tests for the agy template lock's staleness rule (review round
 * 110): content that is not a decimal pid — empty, malformed, past the
 * byte bound, or a pid `process.kill` itself rejects — used to never
 * become stale, so every later launch waited out the full minute and
 * failed. It now follows the empty case: stale once its mtime is older
 * than EMPTY_LOCK_STALE_MS. A live owner still blocks, a dead owner is
 * still taken over at any age, and the wait deadline is injectable so
 * the blocking cases prove themselves in milliseconds.
 */

import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  AGY_TEMPLATE_NAME,
  agyKeychainHost,
  agyKeychainStateDir,
} from "../src/agy-keychain.js";
import { cleanup, setup } from "./helpers/agy-keychain.js";

afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn(); });

/** Plant a lock file with the given content, backdated by ageMs. */
function plantLock(content: string, ageMs: number): string {
  mkdirSync(agyKeychainStateDir(), { recursive: true });
  const lock = join(agyKeychainStateDir(), `${AGY_TEMPLATE_NAME}.lock`);
  writeFileSync(lock, content, { mode: 0o600 });
  const stamp = new Date(Date.now() - ageMs);
  utimesSync(lock, stamp, stamp);
  return lock;
}

/** The lock wait, shortened so the blocking cases do not sit out a minute.
 * The field is data, not a method, so the injection is a plain assignment
 * restored with the rest of the cleanup. */
function shortenLockWait(ms: number): void {
  const saved = agyKeychainHost.lockWaitMs;
  agyKeychainHost.lockWaitMs = ms;
  cleanup.push(() => { agyKeychainHost.lockWaitMs = saved; });
}

test.each([
  "not a pid",
  "", // Empty content already followed the age rule; it still must.
  "0", // Pids this program writes start at 1.
  "9".repeat(30), // Above the platform range; process.kill rejects it.
  `${"1".repeat(65)}\n`, // Past the 64-byte read bound.
])("a malformed lock older than the stale bound is taken over: %j", (content) => {
  const { adapter, request } = setup();
  const lock = plantLock(content, 61_000);
  const context = adapter.prepareRun(request);
  cleanup.push(() => adapter.cleanupRun(context));
  expect(existsSync(lock)).toBe(false);
  expect(existsSync(join(agyKeychainStateDir(), AGY_TEMPLATE_NAME))).toBe(true);
});

test("a fresh malformed lock blocks until the wait expires, not forever", () => {
  const { adapter, request } = setup();
  shortenLockWait(250);
  const lock = plantLock("not a pid", 0);
  expect(() => adapter.prepareRun(request)).toThrow(
    "timed out waiting for agy template keychain lock"
  );
  expect(existsSync(lock)).toBe(true);
});

test("a live lock owner blocks the launch for the whole wait", () => {
  const { adapter, request } = setup();
  shortenLockWait(250);
  const lock = plantLock(String(process.pid), 0);
  expect(() => adapter.prepareRun(request)).toThrow(
    "timed out waiting for agy template keychain lock"
  );
  expect(existsSync(lock)).toBe(true);
});

test("a dead lock owner is taken over regardless of the lock's age", async () => {
  const { adapter, request } = setup();
  const child = Bun.spawn([process.execPath, "-e", ""]);
  await child.exited;
  const lock = plantLock(String(child.pid), 0);
  const context = adapter.prepareRun(request);
  cleanup.push(() => adapter.cleanupRun(context));
  expect(existsSync(lock)).toBe(false);
});

test("a FIFO at the lock path fails the launch at once instead of blocking the open (review round 111)", () => {
  const { adapter, request } = setup();
  mkdirSync(agyKeychainStateDir(), { recursive: true });
  const lock = join(agyKeychainStateDir(), `${AGY_TEMPLATE_NAME}.lock`);
  if (Bun.spawnSync(["mkfifo", lock]).exitCode !== 0) return; // no mkfifo here: nothing to prove
  // A plain read-only open of a FIFO with no writer never returns, so the
  // wait deadline was never reached. The type check now runs before a
  // non-blocking open.
  const started = Date.now();
  expect(() => adapter.prepareRun(request)).toThrow("agy template lock must be a regular file");
  expect(Date.now() - started).toBeLessThan(5_000);
  expect(existsSync(lock)).toBe(true);
});
