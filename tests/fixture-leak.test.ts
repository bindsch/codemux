/**
 * The fixture-leak guard (audit round 2, C-4): the `pid\nstart` identity
 * format the tracked fixtures write, and the exit sweep that kills only a
 * fixture whose recorded identity is still alive. The start token is the
 * reuse check — a pid the OS reassigned to a different process between the
 * test's crash and the run's exit must never be signaled, which a
 * process.kill spy pins without touching any real process.
 */

import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProcessTable } from "../src/process-table.js";
import {
  childIdentityWrite,
  readFixtureIdentity,
  sweepLeakedFixtures,
  writeFixtureIdentity,
} from "./helpers/fixture-leak.js";

describe("fixture identity files", () => {
  const scratch: string[] = [];
  afterAll(() => {
    for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function tempDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    scratch.push(dir);
    return dir;
  }

  test("the pid line carries the pid and the start line the token, each optional shape", () => {
    const dir = tempDir("codemux-fixture-id-");
    const file = (body: string): string => {
      const path = join(dir, `id-${scratch.length}`);
      writeFileSync(path, body);
      scratch.push(path);
      return path;
    };
    expect(readFixtureIdentity(file("4242\nMon Nov  3 09:00:00 2026"))).toEqual({
      pid: 4242,
      start: "Mon Nov  3 09:00:00 2026",
    });
    // No token recorded (the table was unreadable where the fixture ran).
    expect(readFixtureIdentity(file("4242\n"))).toEqual({ pid: 4242, start: null });
    expect(readFixtureIdentity(file("4242"))).toEqual({ pid: 4242, start: null });
    // A pid nothing should ever signal, and garbage.
    expect(readFixtureIdentity(file("1\nx"))).toBeNull();
    expect(readFixtureIdentity(file("not a pid"))).toBeNull();
    expect(readFixtureIdentity(join(dir, "missing"))).toBeNull();
  });

  test("a pid whose start token differs is not signaled; the same token is", () => {
    const dir = tempDir("codemux-fixture-sweep-");
    const pidFile = join(dir, "fixture.pid");
    writeFileSync(pidFile, "4242\nMon Nov  3 09:00:00 2026");
    const table: ProcessTable = new Map([
      // The pid exists, but its launch token is a different process's.
      [4242, { ppid: 1, pgid: 4242, start: "Mon Nov  3 09:10:00 2026" }],
    ]);
    const calls: Array<[number, string]> = [];
    const kill = spyOn(process, "kill").mockImplementation(((pid: number, signal: string) => {
      calls.push([pid, signal]);
    }) as typeof process.kill);
    try {
      expect(sweepLeakedFixtures([{ label: "reused pid fixture", pidFile }], table)).toEqual([]);
      expect(calls).toEqual([]);
      // The recorded token matching the table's entry is the fixture: the
      // sweep kills the group first, then the pid.
      writeFileSync(pidFile, "4242\nMon Nov  3 09:10:00 2026");
      expect(sweepLeakedFixtures([{ label: "live fixture", pidFile }], table)).toEqual([
        { label: "live fixture", pid: 4242 },
      ]);
      expect(calls).toEqual([
        [-4242, "SIGKILL"],
        [4242, "SIGKILL"],
      ]);
    } finally {
      kill.mockRestore();
    }
  });

  test("an identity the table no longer lists is not signaled", () => {
    // The fixture died and was reaped: a readable table lists other
    // processes but not this pid, so no signal flies. (An EMPTY table
    // means the host could not be read at all — there the sweep keeps the
    // pre-identity degrade and still signals by pid.)
    const dir = tempDir("codemux-fixture-gone-");
    const pidFile = join(dir, "fixture.pid");
    writeFileSync(pidFile, "4242\nMon Nov  3 09:00:00 2026");
    const table: ProcessTable = new Map([
      [1, { ppid: 0, pgid: 1, start: "Mon Nov  3 08:00:00 2026" }],
    ]);
    const kill = spyOn(process, "kill").mockImplementation((() => true) as typeof process.kill);
    try {
      expect(sweepLeakedFixtures([{ label: "gone fixture", pidFile }], table)).toEqual([]);
      expect(kill).not.toHaveBeenCalled();
    } finally {
      kill.mockRestore();
    }
  });

  test("writeFixtureIdentity writes the two-line format a real child carries", async () => {
    const dir = tempDir("codemux-fixture-write-");
    const parentFile = join(dir, "parent.pid");
    const childFile = join(dir, "child.pid");
    writeFixtureIdentity(parentFile, process.pid);
    expect(readFixtureIdentity(parentFile)?.pid).toBe(process.pid);
    // The embedded-script statement writes the same shape from inside the
    // process it names.
    const child = Bun.spawn(
      [
        process.execPath,
        "-e",
        `${childIdentityWrite(childFile, "process.pid")}\nsetInterval(() => {}, 1000);`,
      ],
      { cwd: dir, stdout: "ignore", stderr: "inherit", stdin: "ignore" }
    );
    try {
      const deadline = Date.now() + 10_000;
      while (!existsSyncSafe(childFile) && Date.now() < deadline) await Bun.sleep(20);
      const identity = readFixtureIdentity(childFile);
      expect(identity?.pid).toBe(child.pid);
      expect(readFileSync(childFile, "utf8")).toBe(`${child.pid}\n${identity?.start ?? ""}`);
    } finally {
      try {
        process.kill(child.pid, "SIGKILL");
      } catch {
        // Already gone.
      }
      await child.exited;
    }
  }, 15_000);
});

function existsSyncSafe(path: string): boolean {
  try {
    readFileSync(path, "utf8");
    return true;
  } catch {
    return false;
  }
}
