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

import { afterEach, expect, spyOn, test } from "bun:test";
import { existsSync, linkSync, lstatSync, mkdirSync, readdirSync, readFileSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  AGY_TEMPLATE_NAME,
  agyKeychainHost,
  agyKeychainStateDir,
  reclaimStaleLock,
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

test.each([
  "4294967297", // 2^32+1: a safe integer past the 32-bit pid ceiling.
])("an out-of-range lock owner is malformed, not live: %j old is taken over", (content) => {
  // Review round 115: the owner pid is now range-checked before any
  // probe (pidProbeAlive), so a pid no kernel assigns follows the age
  // rule for malformed content instead of reaching `process.kill`.
  const { adapter, request } = setup();
  const lock = plantLock(content, 61_000);
  const context = adapter.prepareRun(request);
  cleanup.push(() => adapter.cleanupRun(context));
  expect(existsSync(lock)).toBe(false);
});

test("a fresh out-of-range lock owner waits out the lock wait, not forever", () => {
  const { adapter, request } = setup();
  shortenLockWait(250);
  const lock = plantLock("4294967297", 0);
  expect(() => adapter.prepareRun(request)).toThrow(
    "timed out waiting for agy template keychain lock"
  );
  expect(existsSync(lock)).toBe(true);
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

test("a stale lock's reclaim removes it and leaves no claim file (review 341, item 7)", () => {
  setup();
  const lock = plantLock("", 61_000); // malformed and old: stale
  reclaimStaleLock(lock, lstatSync(lock));
  expect(existsSync(lock)).toBe(false);
  expect(readdirSync(agyKeychainStateDir()).filter((entry) => entry.includes(".reclaim-"))).toEqual([]);
});

test("a late reclaim on a judged-stale incarnation never removes the winner's fresh lock (review 341, item 7)", () => {
  // The interleave the old lstat-then-unlink could not survive: waiter A
  // reclaims the stale lock and creates its own, then waiter B — which
  // judged the SAME stale incarnation before A ran — reclaims late. B's
  // link aliases A's FRESH lock, the identity check fails, and B leaves
  // A's lock alone. The stale incarnation stays pinned under a second
  // name for the whole test, so the fresh lock can never reuse its inode
  // and the incarnations stay distinguishable.
  setup();
  const lock = plantLock("", 61_000);
  const keep = `${lock}.keep`;
  linkSync(lock, keep);
  const staleIdentity = lstatSync(lock);
  try {
    reclaimStaleLock(lock, staleIdentity); // waiter A wins the claim
    expect(existsSync(lock)).toBe(false);
    writeFileSync(lock, String(process.pid), { mode: 0o600 }); // A's fresh lock
    reclaimStaleLock(lock, staleIdentity); // waiter B, late on the old incarnation
    expect(existsSync(lock)).toBe(true);
    expect(readFileSync(lock, "utf8")).toBe(String(process.pid));
    expect(readdirSync(agyKeychainStateDir()).filter((entry) => entry.includes(".reclaim-"))).toEqual([]);
  } finally {
    unlinkSync(keep);
  }
});

test("a second waiter on an already-claimed incarnation does not remove the lock (review 341, item 7)", () => {
  // While one waiter's claim is in place, another waiter on the same
  // stale incarnation answers EEXIST and polls — it never unlinks.
  setup();
  const lock = plantLock("", 61_000);
  const identity = lstatSync(lock);
  const claim = `${lock}.reclaim-${identity.dev}-${identity.ino}`;
  linkSync(lock, claim); // the winner's claim, mid-reclaim
  try {
    reclaimStaleLock(lock, identity); // the loser
    expect(existsSync(lock)).toBe(true);
    expect(existsSync(claim)).toBe(true);
  } finally {
    unlinkSync(claim);
  }
});

test("a refused hard link fails the reclaim at once instead of posing as a rival (review 344)", () => {
  // EEXIST and ENOENT mean another waiter or a vanished lock and the
  // waiter polls again; any other refusal (a directory that denies hard
  // links) can never be won, so it is an error now, not a deadline later.
  setup();
  const lock = plantLock("", 61_000);
  const denied = spyOn(agyKeychainHost, "linkSync").mockImplementation(() => {
    throw Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" });
  });
  cleanup.push(() => denied.mockRestore());
  const started = Date.now();
  expect(() => reclaimStaleLock(lock, lstatSync(lock))).toThrow("hard link refused (EPERM)");
  expect(Date.now() - started).toBeLessThan(1_000);
  expect(existsSync(lock)).toBe(true);
  denied.mockImplementation(() => {
    throw Object.assign(new Error("EEXIST: file exists"), { code: "EEXIST" });
  });
  expect(() => reclaimStaleLock(lock, lstatSync(lock))).not.toThrow();
  expect(existsSync(lock)).toBe(true);
});

test("the lock wait deadline names a leftover reclaim file (review 341, item 7)", () => {
  const { adapter, request } = setup();
  shortenLockWait(250);
  const lock = plantLock(String(process.pid), 0); // a live owner blocks
  const identity = lstatSync(lock);
  const claim = `${lock}.reclaim-${identity.dev}-${identity.ino}`;
  writeFileSync(claim, ""); // a reclaim wedged beside it
  cleanup.push(() => { try { unlinkSync(claim); } catch { /* advisory */ } });
  expect(() => adapter.prepareRun(request)).toThrow(`${claim} is a leftover reclaim file`);
});
