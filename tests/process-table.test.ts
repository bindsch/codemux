import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isStillOurs,
  listDescendants,
  parsePsOutput,
  processTableReadable,
  readProcTable,
  readProcessTable,
} from "../src/process-table.js";

/** A table from `[pid, ppid]` pairs, each process given start time "t1". */
function tableOf(pairs: Array<[number, number]>) {
  return new Map(pairs.map(([pid, ppid]) => [pid, { ppid, pgid: pid, start: "t1" }]));
}

describe("process table", () => {
  test("parses ps output, ignoring blank or malformed lines and zombies", () => {
    const table = parsePsOutput(
      [
        "    1     0     1 Ss   Wed Sep  3 00:00:01 2026",
        "  340     1   340 S    Wed Sep  3 00:00:02 2026",
        "",
        "garbage line",
        " 4242   340   340 R+   Wed Sep  3 00:12:34 2026",
        " 4243   340   340 Z    Wed Sep  3 00:12:35 2026",
        " 4244   340  4244 S", // truncated: no start time, so no identity; dropped
        "",
      ].join("\n")
    );
    expect([...table]).toEqual([
      [1, { ppid: 0, pgid: 1, start: "Wed Sep 3 00:00:01 2026" }],
      [340, { ppid: 1, pgid: 340, start: "Wed Sep 3 00:00:02 2026" }],
      [4242, { ppid: 340, pgid: 340, start: "Wed Sep 3 00:12:34 2026" }],
    ]);
  });

  test("reads a procfs tree, taking ppid and starttime after the last ')' of a hostile comm", () => {
    const root = mkdtempSync(join(tmpdir(), "codemux-proc-"));
    try {
      const entry = (pid: number, comm: string, ppid: number, state = "S") => {
        mkdirSync(join(root, String(pid)));
        if (state === "") return;
        // Field 22 (starttime) is the identity token; give each a distinct one.
        // Fields after the comm: state ppid pgrp session ... starttime(22).
        writeFileSync(
          join(root, String(pid), "stat"),
          `${pid} (${comm}) ${state} ${ppid} ${ppid || pid} ${pid} 0 -1 4194560 0 0 0 0 0 0 0 0 20 0 1 0 ${pid * 100} 0 0\n`
        );
      };
      entry(1, "systemd", 0);
      entry(77, "weird ) name (x", 1);
      entry(78, "bash", 77);
      entry(79, "gone", 1, ""); // exited between readdir and read (ENOENT)
      entry(80, "defunct", 77, "Z"); // a zombie is dead for our purposes
      mkdirSync(join(root, "self")); // non-numeric entries are skipped
      // readdir order is unspecified, so compare as sorted entries.
      const entries = [...readProcTable(new Map(), root)].sort((a, b) => a[0] - b[0]);
      expect(entries).toEqual([
        [1, { ppid: 0, pgid: 1, start: "100" }],
        [77, { ppid: 1, pgid: 1, start: "7700" }],
        [78, { ppid: 77, pgid: 77, start: "7800" }],
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("an unreadable procfs root yields an empty table rather than throwing", () => {
    expect(readProcTable(new Map(), join(tmpdir(), "codemux-no-such-proc")).size).toBe(0);
  });

  test("lists descendants breadth first without revisiting, from one root or many", () => {
    const table = tableOf([[1, 0], [10, 1], [11, 10], [12, 10], [13, 12], [20, 1], [21, 20]]);
    expect(listDescendants(10, table)).toEqual([11, 12, 13]);
    expect(listDescendants(20, table)).toEqual([21]);
    expect(listDescendants(999, table)).toEqual([]);
    // Roots inside another root's subtree are not listed as descendants.
    expect(listDescendants([10, 12, 20], table)).toEqual([11, 13, 21]);
  });

  test("a remembered pid stays ours while its start time is unchanged", () => {
    const remembered = { ppid: 10, pgid: 10, start: "t1" };
    // Same process, whether still under its parent or reparented to init or
    // to a Linux subreaper (pid 1234) after the parent died.
    expect(isStillOurs(11, remembered, tableOf([[1, 0], [10, 1], [11, 10]]))).toBe(true);
    expect(isStillOurs(11, remembered, tableOf([[1, 0], [11, 1]]))).toBe(true);
    expect(isStillOurs(11, remembered, tableOf([[1, 0], [1234, 1], [11, 1234]]))).toBe(true);
    // Gone.
    expect(isStillOurs(11, remembered, tableOf([[1, 0], [10, 1]]))).toBe(false);
    // Pid reused by a stranger: new start time, even under the same parent.
    expect(isStillOurs(11, remembered, new Map([[11, { ppid: 10, pgid: 10, start: "t2" }]]))).toBe(false);
  });

  test.skipIf(process.platform === "win32" || !processTableReadable())(
    "the live table on this host lists this process under its parent with a start time",
    () => {
      const self = readProcessTable().get(process.pid);
      expect(self?.ppid).toBe(process.ppid);
      expect(self?.pgid).toBeGreaterThan(0);
      expect(self?.start.length).toBeGreaterThan(0);
    }
  );
});
