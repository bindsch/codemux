import { describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { chmodSync, existsSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { acquireLock, listHeldLocks } from "../src/session/registry-io.js";
import { recordSessionStart, touchSession } from "../src/session/registry.js";
import { DEAD_PID, makeRoot, newRecord, registryIn } from "./helpers/session-registry.js";

describe("the writer lock", () => {
  /** Seed a held-format lock file directly: `<pid>\n<start>\n` under a
   * never-reused held name, the shape acquireLock itself creates. */
  function seedHeldLock(lockPath: string, pid: number, start: string | null, salt: string): string {
    const path = join(
      dirname(lockPath),
      `.${basename(lockPath)}.${pid}.${salt}.held`
    );
    writeFileSync(path, `${pid}\n${start ?? ""}\n`, { mode: 0o600 });
    return path;
  }

  test("a touch on the turn-path budget never waits behind a live writer (review live13)", () => {
    const root = makeRoot();
    const path = registryIn(root);
    expect(recordSessionStart(path, newRecord()).ok).toBe(true);
    // Hold the writer lock from this (live) process, the way a concurrent
    // codemux registry write would.
    const handle = acquireLock(`${path}.lock`, { attempts: 1 });
    try {
      const began = Date.now();
      const outcome = touchSession(path, "sess-1", { attempts: 1 });
      const elapsed = Date.now() - began;
      // Fail fast AND report it: the pre-fix call ran the default budget
      // (40 sleeps of 250 ms plus jitter — about 10 s of Atomics.wait on
      // the main thread) before failing; the turn path must instead take
      // one sweep and return.
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.error).toMatch(/live writer/);
      expect(elapsed).toBeLessThan(1_000);
    } finally {
      handle.release();
    }
    // Contention was the only problem: with the lock free again, the same
    // single-attempt touch succeeds.
    expect(touchSession(path, "sess-1", { attempts: 1 }).ok).toBe(true);
  });

  test("an unreadable lock corpse is never stolen (audit round 2, test 6)", () => {
    if (typeof process.getuid === "function" && process.getuid() === 0) return; // root ignores modes
    const root = makeRoot();
    const lockPath = join(root, "live-sessions.json.lock");
    // A live-looking holder whose file cannot be read at all: the state is
    // `unknown`, the fail-closed arm — never `dead`, never stolen.
    // The salt must be hex: a non-hex middle makes the name invisible to
    // the lock's namespace scan, and an invisible corpse blocks nothing.
    const corpse = seedHeldLock(lockPath, process.pid, null, "0dead");
    chmodSync(corpse, 0o000);
    try {
      expect(() => acquireLock(lockPath, { attempts: 1 })).toThrow(/held by a live writer/);
      // Nothing was written or removed: the corpse is exactly where it was.
      expect(existsSync(corpse)).toBe(true);
      expect(listHeldLocks(lockPath)).toHaveLength(1);
    } finally {
      chmodSync(corpse, 0o600);
    }
    // Readable again, the payload decides: this process is the holder, so
    // the lock is live and still blocks.
    expect(() => acquireLock(lockPath, { attempts: 1 })).toThrow(/held by a live writer/);
  });

  test("acquire and release round-trip; a stale lock is stolen", () => {
    const root = makeRoot();
    const lockPath = join(root, "live-sessions.json.lock");
    const handle = acquireLock(lockPath, { attempts: 1 });
    const held = listHeldLocks(lockPath);
    expect(held.length).toBe(1);
    expect(held[0]!.holder?.pid).toBe(process.pid);
    expect(existsSync(held[0]!.path)).toBe(true);
    handle.release();
    expect(listHeldLocks(lockPath)).toHaveLength(0);

    // A lock whose holder is dead is stale, not blocking.
    seedHeldLock(lockPath, DEAD_PID, null, "0bad1");
    const stolen = acquireLock(lockPath, { attempts: 1 });
    const after = listHeldLocks(lockPath);
    expect(after.length).toBe(1);
    expect(after[0]!.holder?.pid).not.toBe(DEAD_PID);
    stolen.release();
    expect(listHeldLocks(lockPath)).toHaveLength(0);
  });

  test("a lock create the directory denies is thrown at once, never blamed on a live writer (review live25)", () => {
    // Review live25, correctness-2 major 1: every openSync failure was
    // read as contention, so a read-only registry directory slept the
    // full default budget (about 10 s) and then reported a live holder.
    if (typeof process.getuid === "function" && process.getuid() === 0) return;
    const root = makeRoot();
    const lockPath = join(root, "live-sessions.json.lock");
    chmodSync(root, 0o500);
    try {
      const began = Date.now();
      let message = "";
      try {
        acquireLock(lockPath);
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toContain("cannot create the session registry lock");
      expect(message).toContain("EACCES");
      expect(message).not.toMatch(/live writer/);
      expect(Date.now() - began).toBeLessThan(1_000);
    } finally {
      chmodSync(root, 0o700);
    }
  });

  test("a dead holder's lock the directory will not let go is thrown at once (review live25 sibling)", () => {
    // The sweep's sibling: a failed unlink of a dead corpse marked the
    // sweep blocked, so the same denied directory waited the budget and
    // blamed a live writer.
    if (typeof process.getuid === "function" && process.getuid() === 0) return;
    const root = makeRoot();
    const lockPath = join(root, "live-sessions.json.lock");
    seedHeldLock(lockPath, DEAD_PID, null, "dead25");
    chmodSync(root, 0o500);
    try {
      const began = Date.now();
      expect(() => acquireLock(lockPath)).toThrow(/cannot remove the dead session registry lock/);
      expect(Date.now() - began).toBeLessThan(1_000);
    } finally {
      chmodSync(root, 0o700);
    }
  });

  test("a live holder blocks within the bounded retry budget", () => {
    const root = makeRoot();
    const lockPath = join(root, "live-sessions.json.lock");
    seedHeldLock(lockPath, process.pid, null, "1e7e");
    expect(() => acquireLock(lockPath, { attempts: 2, retryMs: 5 })).toThrow(/live writer/);
  });

  test("two writers that both observe a stale lock cannot both acquire it", () => {
    // Review live9, correctness 1: the steal used to unlink a reused
    // lock pathname, so writer B's fresh lock sat where writer A had
    // verified a corpse — A's late unlink removed B's live lock and both
    // held it. Held names are never reused: B's steal consumes the stale
    // file itself, so an A that verified it earlier finds nothing left
    // to unlink, and blocks behind B's live lock instead.
    const root = makeRoot();
    const lockPath = join(root, "live-sessions.json.lock");
    const staleName = seedHeldLock(lockPath, DEAD_PID, null, "07a1e");
    // B acquires first; its sweep steals the corpse by that exact name.
    const b = acquireLock(lockPath, { attempts: 1 });
    expect(existsSync(staleName)).toBe(false);
    expect(listHeldLocks(lockPath)).toHaveLength(1);
    // A, arriving with its own stale observation, must not clear B.
    expect(() => acquireLock(lockPath, { attempts: 1, retryMs: 5 })).toThrow(/live writer/);
    const stillHeld = listHeldLocks(lockPath);
    expect(stillHeld).toHaveLength(1);
    expect(existsSync(stillHeld[0]!.path)).toBe(true);
    // With B gone, A acquires cleanly.
    b.release();
    const a = acquireLock(lockPath, { attempts: 1 });
    expect(listHeldLocks(lockPath)).toHaveLength(1);
    a.release();
    expect(listHeldLocks(lockPath)).toHaveLength(0);
  });

  test("losing the steal of a dead holder to another writer is not contention (review live20)", () => {
    // Two writers that both judge the same corpse dead both unlink it;
    // the loser's unlink fails ENOENT. That used to mark the sweep
    // blocked, so a single-attempt acquisition (the per-turn touch)
    // failed although the lock was free. The spy removes the corpse just
    // before the real unlink, which is exactly the loser's view.
    const root = makeRoot();
    const lockPath = join(root, "live-sessions.json.lock");
    const corpse = seedHeldLock(lockPath, DEAD_PID, null, "5ea1ed");
    const realUnlink = fs.unlinkSync;
    const spy = spyOn(fs, "unlinkSync").mockImplementation(((target: fs.PathLike) => {
      if (target === corpse) realUnlink(target);
      realUnlink(target);
    }) as typeof fs.unlinkSync);
    let handle: ReturnType<typeof acquireLock> | null = null;
    try {
      handle = acquireLock(lockPath, { attempts: 1, retryMs: 5 });
    } finally {
      spy.mockRestore();
    }
    expect(existsSync(corpse)).toBe(false);
    expect(listHeldLocks(lockPath).map((held) => held.holder?.pid)).toEqual([process.pid]);
    handle.release();
    expect(listHeldLocks(lockPath)).toHaveLength(0);
  });

  test("losing a confirm-time steal to another writer is not a conflict either (review live20)", () => {
    // The sweep's sibling in the post-create confirm: a dead rival that
    // appeared between the sweep and the create is stolen there, and an
    // ENOENT from a writer that stole it first released our claim as if
    // a live rival had won. The openSync spy plants the corpse at our
    // create; the unlinkSync spy removes it just before the real unlink.
    const root = makeRoot();
    const lockPath = join(root, "live-sessions.json.lock");
    const corpse = join(root, `.live-sessions.json.lock.${DEAD_PID}.c0ff1e.held`);
    const realOpen = fs.openSync;
    const realUnlink = fs.unlinkSync;
    const openSpy = spyOn(fs, "openSync").mockImplementation(((target: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
      if (flags === "wx" && !existsSync(corpse)) {
        writeFileSync(corpse, `${DEAD_PID}\n\n`, { mode: 0o600 });
      }
      return realOpen(target, flags, mode);
    }) as typeof fs.openSync);
    const unlinkSpy = spyOn(fs, "unlinkSync").mockImplementation(((target: fs.PathLike) => {
      if (target === corpse) realUnlink(target);
      realUnlink(target);
    }) as typeof fs.unlinkSync);
    let handle: ReturnType<typeof acquireLock> | null = null;
    try {
      handle = acquireLock(lockPath, { attempts: 1, retryMs: 5 });
    } finally {
      openSpy.mockRestore();
      unlinkSpy.mockRestore();
    }
    expect(existsSync(corpse)).toBe(false);
    expect(listHeldLocks(lockPath).map((held) => held.holder?.pid)).toEqual([process.pid]);
    handle.release();
  });

  test("an unjudgeable held file with a live name-pid blocks and is never stolen", () => {
    // Fail closed: a held file whose payload cannot be judged (junk
    // content, or an unreadable file) is treated as live while its
    // name-encoded pid is live — the bounded budget decides, and the
    // file is still there afterwards. (A dead name-pid is the other
    // arm, review live14: such a corpse is stealable — pinned below.)
    const root = makeRoot();
    const lockPath = join(root, "live-sessions.json.lock");
    const junkPath = join(root, `.live-sessions.json.lock.${process.pid}.ff00d.held`);
    writeFileSync(junkPath, "junk\n", { mode: 0o600 });
    expect(() => acquireLock(lockPath, { attempts: 1, retryMs: 5 })).toThrow(/live writer/);
    expect(existsSync(junkPath)).toBe(true);
    expect(listHeldLocks(lockPath)).toEqual([{ path: junkPath, holder: null }]);
  });

  test("a held file a dead acquirer left unjudgeable is stolen, not a permanent block", () => {
    // Review live14: the lock create writes the file before the payload,
    // so a process killed between the two (or a write that died on
    // ENOSPC) left a corpse whose payload cannot be judged. Pre-fix it
    // read as `unknown` forever — never stolen — and every later
    // registry write failed its full retry budget until someone deleted
    // the file by hand: no session could start, stamp, or end. The pid
    // in the never-reused name is the fallback: dead (an empty corpse,
    // junk content — any unjudgeable payload) means the file can only
    // be that failed acquisition's leftover, so the steal that consumes
    // the exact name is sound.
    const root = makeRoot();
    const lockPath = join(root, "live-sessions.json.lock");
    const corpse = join(root, `.live-sessions.json.lock.${DEAD_PID}.0dd1e5.held`);
    writeFileSync(corpse, "", { mode: 0o600 });
    const handle = acquireLock(lockPath, { attempts: 1 });
    // The corpse was consumed by the steal; our own held file is the
    // only one left, and a follow-up write is uncontended.
    expect(existsSync(corpse)).toBe(false);
    const held = listHeldLocks(lockPath);
    expect(held).toHaveLength(1);
    expect(held[0]!.holder?.pid).toBe(process.pid);
    handle.release();
    expect(listHeldLocks(lockPath)).toHaveLength(0);
  });
});
