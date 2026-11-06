/**
 * The stale agy probe-home sweep's reads of the harness-writable marker
 * and PID files (review round 199): each is read once, bounded, without
 * following a link, with its bytes decoded as they are. A marker that
 * cannot be read that way identifies no home; an owner file that names no
 * pid follows the age rule. Nothing is read whole or parked on a FIFO.
 */
import { describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { PROBE_MARKER, PROBE_PID, sweepStaleHomes } from "../src/adapters/agy-homes.js";

// Older than UNREADABLE_OWNER_STALE_MS (two days), so a PID file whose
// content names no pid is old enough for the old sweep to remove.
const OLD = new Date(Date.now() - 3 * 86_400_000);

function sweepRoot(): string {
  // The sweep refuses a root whose realpath differs from its spelling.
  return realpathSync(mkdtempSync(join(tmpdir(), "codemux-agy-sweep-")));
}

function entry(root: string, name: string): string {
  const home = join(root, name);
  mkdirSync(home, { mode: 0o700 });
  return home;
}

/** The pid of a process that has exited and been reaped: dead to
 * pidProbeAlive, so the sweep's owner check passes. */
function deadPid(): string {
  const child = Bun.spawnSync(["/bin/sh", "-c", "exit 0"]);
  expect(child.exitCode).toBe(0);
  return String(child.pid);
}

describe("the stale agy probe-home sweep's entry-file reads", () => {
  test("an identified home whose owner is gone is swept", () => {
    const root = sweepRoot();
    try {
      const home = entry(root, "run-gone");
      writeFileSync(join(home, PROBE_MARKER), randomUUID(), { mode: 0o600 });
      writeFileSync(join(home, PROBE_PID), deadPid(), { mode: 0o600 });
      sweepStaleHomes(root);
      expect(existsSync(home)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a marker that is a FIFO does not block the sweep: the entry is skipped", () => {
    // Review round 199: the read is one non-following open typed on its
    // descriptor, so a FIFO marker (a harness leftover) is refused at
    // once instead of parking a blocking read.
    const root = sweepRoot();
    try {
      const home = entry(root, "run-fifo");
      if (Bun.spawnSync(["mkfifo", join(home, PROBE_MARKER)]).exitCode !== 0) {
        return; // no mkfifo here: nothing to prove
      }
      writeFileSync(join(home, PROBE_PID), deadPid(), { mode: 0o600 });
      const started = performance.now();
      sweepStaleHomes(root);
      expect(performance.now() - started).toBeLessThan(2_000);
      expect(existsSync(home)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("an oversized or byte-order-marked marker identifies no home, and nothing is read whole", () => {
    // Review rounds 199 and 204: the reads are bounded and byte-exact. A
    // marker past the bound, or one that only reads as a UUID once a
    // byte-order mark is stripped, is not a marker; the home is left
    // alone. The old whole-file read (fs.readFileSync by path) is gone.
    const root = sweepRoot();
    const whole = spyOn(fs, "readFileSync");
    try {
      const oversizeMarker = entry(root, "run-marker");
      writeFileSync(join(oversizeMarker, PROBE_MARKER), `${randomUUID()}${"x".repeat(300)}`, { mode: 0o600 });
      writeFileSync(join(oversizeMarker, PROBE_PID), deadPid(), { mode: 0o600 });
      const bomMarker = entry(root, "run-bom");
      writeFileSync(join(bomMarker, PROBE_MARKER), `\uFEFF${randomUUID()}`, { mode: 0o600 });
      writeFileSync(join(bomMarker, PROBE_PID), deadPid(), { mode: 0o600 });
      sweepStaleHomes(root);
      expect(existsSync(oversizeMarker)).toBe(true);
      expect(existsSync(bomMarker)).toBe(true);
      expect(whole.mock.calls.filter(([path]) => typeof path === "string" && path.startsWith(root))).toEqual([]);
    } finally {
      whole.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("an owner file that names no pid, oversized or not text, follows the age rule", () => {
    // The existing rule for an owner file the sweep cannot read as a pid:
    // the home goes only once that file is old (the child can rewrite it).
    // A file past the bound is such a file; it is never read whole.
    const root = sweepRoot();
    try {
      const home = (name: string, content: string | Uint8Array, aged: boolean): string => {
        const dir = entry(root, name);
        writeFileSync(join(dir, PROBE_MARKER), randomUUID(), { mode: 0o600 });
        const pidPath = join(dir, PROBE_PID);
        writeFileSync(pidPath, content, { mode: 0o600 });
        if (aged) utimesSync(pidPath, OLD, OLD);
        return dir;
      };
      const oversizedOld = home("run-big-old", `1\n${"y".repeat(300)}`, true);
      const oversizedNew = home("run-big-new", `1\n${"y".repeat(300)}`, false);
      const binaryOld = home("run-bin-old", Uint8Array.from([0x31, 0x80, 0x0a]), true);
      const binaryNew = home("run-bin-new", Uint8Array.from([0x31, 0x80, 0x0a]), false);
      sweepStaleHomes(root);
      expect(existsSync(oversizedOld)).toBe(false);
      expect(existsSync(binaryOld)).toBe(false);
      expect(existsSync(oversizedNew)).toBe(true);
      expect(existsSync(binaryNew)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
