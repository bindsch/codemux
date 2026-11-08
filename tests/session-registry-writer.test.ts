import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  readRegistry,
  recordSessionStart,
  REGISTRY_MAX_ENTRIES,
  type SessionRecord,
} from "../src/session/registry.js";
import { durableFs } from "../src/fs-durable.js";
import { writeRegistryAtomic } from "../src/session/registry-io.js";
import { craftEntry, makeRoot, newRecord, registryIn, seedRegistry } from "./helpers/session-registry.js";

describe("pruning", () => {
  test("prune keeps 1000 by last_activity and never evicts a live owner", () => {
    const root = makeRoot();
    const path = registryIn(root);
    const sessions: SessionRecord[] = [];
    // 999 stale entries plus the live-owner survivor: 1000 total, so the
    // seeded file is valid; recording one more pushes it over the bound.
    for (let i = 0; i < REGISTRY_MAX_ENTRIES - 1; i++) {
      sessions.push(
        craftEntry({
          id: `old-${i}`,
          last_activity: new Date(Date.UTC(2026, 0, 1, 0, 0, 0, i)).toISOString(),
        })
      );
    }
    // Oldest of all, but its owner is us: live, so it must survive.
    sessions.push(
      craftEntry({
        id: "live-oldest",
        last_activity: "2025-01-01T00:00:00.000Z",
        owner_pid: process.pid,
      })
    );
    seedRegistry(path, sessions);
    expect(recordSessionStart(path, newRecord({ id: "fresh" })).ok).toBe(true);
    const read = readRegistry(path);
    expect(read.outcome).toBe("ok");
    if (read.outcome !== "ok") return;
    expect(read.file.sessions.length).toBe(REGISTRY_MAX_ENTRIES);
    const ids = new Set(read.file.sessions.map((entry) => entry.id));
    expect(ids.has("fresh")).toBe(true);
    expect(ids.has("live-oldest")).toBe(true);
    expect(ids.has("old-0")).toBe(false);
    expect(ids.has("old-1")).toBe(true);
  });

  test("an all-live overflow still prunes to a file the validator accepts (review live13)", () => {
    const root = makeRoot();
    const path = registryIn(root);
    const sessions: SessionRecord[] = [];
    // Exactly REGISTRY_MAX_ENTRIES entries, every one owned by a live
    // process (us), so recording one more crosses the bound with no
    // evictable entry in sight.
    for (let i = 0; i < REGISTRY_MAX_ENTRIES; i++) {
      sessions.push(
        craftEntry({
          id: `live-${i}`,
          last_activity: new Date(Date.UTC(2026, 0, 1, 0, 0, 0, i)).toISOString(),
          owner_pid: process.pid,
        })
      );
    }
    seedRegistry(path, sessions);
    const began = Date.now();
    const outcome = recordSessionStart(path, newRecord({ id: "fresh" }));
    const elapsed = Date.now() - began;
    expect(outcome.ok).toBe(true);
    // The liveness judgments share one process-table snapshot; without
    // it, this one call enumerates the host's processes once per live
    // owner (a thousand spawns inside the held writer lock).
    expect(elapsed).toBeLessThan(8_000);
    // The writer must never leave a file its own validator rejects:
    // more than REGISTRY_MAX_ENTRIES reads as corrupt on the next open,
    // which fails every resume closed and makes the next start back the
    // file up and reset it — dropping the records of every live session.
    const read = readRegistry(path);
    expect(read.outcome).toBe("ok");
    if (read.outcome !== "ok") return;
    expect(read.file.sessions.length).toBe(REGISTRY_MAX_ENTRIES);
    const ids = new Set(read.file.sessions.map((entry) => entry.id));
    expect(ids.has("fresh")).toBe(true);
    // The overflow falls on the oldest entry even though its owner is
    // live: a lookup hint evicted answers not_found, the smaller loss.
    expect(ids.has("live-0")).toBe(false);
    expect(ids.has("live-1")).toBe(true);
  });
});

describe("review live18", () => {
  test("the writer refuses a symlinked registry directory the reader refuses", () => {
    // Correctness 3: updateRegistry resolved the path before reading, so
    // the leaf symlink check never saw the link. Every session recorded
    // fine and none could resume (the reader said "symbolic link").
    const linkRoot = makeRoot();
    const realDir = join(linkRoot, "real");
    mkdirSync(realDir, { recursive: true, mode: 0o700 });
    symlinkSync(realDir, join(linkRoot, "link"));
    const throughLink = join(linkRoot, "link", "live-sessions.json");
    const outcome = recordSessionStart(throughLink, newRecord());
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toContain("symbolic link");
    expect(existsSync(join(realDir, "live-sessions.json"))).toBe(false);
  });

  test("an oversize registry is corrupt, so the next start backs it up instead of failing forever", () => {
    // Minor: a file over the 4 MiB cap read as untrusted, which the start
    // path never recovers, so every new session failed until someone
    // deleted it.
    const path = registryIn(makeRoot());
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, " ".repeat(4 * 1024 * 1024 + 1), { mode: 0o600 });
    expect(readRegistry(path).outcome).toBe("corrupt");
    expect(recordSessionStart(path, newRecord()).ok).toBe(true);
    expect(readRegistry(path).outcome).toBe("ok");
    const backups = readdirSync(dirname(path)).filter((name) => name.includes(".corrupt-"));
    expect(backups).toHaveLength(1);
  });

  test("the writer prunes to the byte cap, never writing a file the reader rejects", () => {
    // Minor, the writer half: only the entry count was enforced, so long
    // records could push the file past 4 MiB, which the reader refused.
    const path = registryIn(makeRoot());
    const sessions: SessionRecord[] = [];
    for (let i = 0; i < 700; i++) {
      sessions.push(
        craftEntry({
          id: `long-${i}`,
          cwd: `/${"d".repeat(5000)}`,
          last_activity: new Date(Date.UTC(2026, 0, 1, 0, 0, 0, i)).toISOString(),
        })
      );
    }
    seedRegistry(path, sessions);
    expect(readRegistry(path).outcome).toBe("ok");
    expect(recordSessionStart(path, newRecord({ id: "fresh", cwd: `/${"f".repeat(400_000)}` })).ok).toBe(true);
    const read = readRegistry(path);
    expect(read.outcome).toBe("ok");
    if (read.outcome !== "ok") return;
    const ids = new Set(read.file.sessions.map((entry) => entry.id));
    expect(ids.has("fresh")).toBe(true);
    expect(ids.has("long-0")).toBe(false);
    expect(ids.has("long-699")).toBe(true);
  });

  test("a failed registry write removes its temp file and leaves the registry intact", () => {
    // Minor: a writeSync failure (ENOSPC) left the temp file behind.
    const path = registryIn(makeRoot());
    seedRegistry(path, [craftEntry()]);
    const before = readFileSync(path, "utf8");
    expect(() =>
      writeRegistryAtomic(path, "{}\n", () => {
        throw Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" });
      })
    ).toThrow("ENOSPC");
    expect(readdirSync(dirname(path)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    expect(readFileSync(path, "utf8")).toBe(before);
  });
});

describe("review round 401, item 5: corrupt-registry recovery", () => {
  const corrupt = (path: string): void => {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, "{ this is not the registry\n", { mode: 0o600 });
  };

  test("a recovery refused at the writer's own validation leaves the live file in place", () => {
    // The old recovery unlinked the registry before it knew the
    // replacement write would happen: a refusal after that (here a record
    // the reader's validator rejects — a harness-supplied id past the
    // cap) returned "nothing was written" with the registry gone, so
    // resumes answered not_found instead of failing closed.
    const path = registryIn(makeRoot());
    corrupt(path);
    expect(readRegistry(path).outcome).toBe("corrupt");
    const outcome = recordSessionStart(path, newRecord({ id: "x".repeat(129) }));
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toContain("nothing was written");
    // The live file survived the refused recovery, so the reader still
    // sees corrupt state — fail-closed — and the backup keeps the bytes.
    expect(readRegistry(path).outcome).toBe("corrupt");
    expect(readdirSync(dirname(path)).filter((name) => name.includes(".corrupt-"))).toHaveLength(1);
  });

  test("a recovery whose replacement write fails leaves the live file in place", () => {
    const path = registryIn(makeRoot());
    corrupt(path);
    // The writer publishes through the durableFs seam, whose members are
    // captured at module load, so the member itself is swapped; it renames
    // to the resolved spelling of the registry path (/private/var for a
    // /var temp root), so the live name is matched by its basename.
    const realRename = durableFs.renameSync;
    durableFs.renameSync = ((from: fs.PathLike, to: fs.PathLike) => {
      if (basename(String(to)) === basename(path)) {
        throw Object.assign(new Error("EISDIR: illegal operation on a directory"), {
          code: "EISDIR",
        });
      }
      return realRename(from, to);
    }) as typeof fs.renameSync;
    try {
      const outcome = recordSessionStart(path, newRecord());
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.kind).toBe("unavailable");
      expect(readRegistry(path).outcome).toBe("corrupt");
    } finally {
      durableFs.renameSync = realRename;
    }
  });

  test("repeated corruption keeps the newest five backups and prunes the rest", () => {
    // The corrupt backups had no rotation, so a repeatedly corrupting
    // state accumulated one copy per start until the disk filled.
    const path = registryIn(makeRoot());
    const dir = dirname(path);
    // The backup name is the ISO stamp; a same-millisecond repeat would
    // collide, so each recovery is at least 2 ms after the last.
    const wait = (): void => {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
    };
    const known: string[] = [];
    for (let i = 0; i < 6; i++) {
      corrupt(path);
      expect(recordSessionStart(path, newRecord({ id: `fresh-${i}` })).ok).toBe(true);
      known.push(
        ...readdirSync(dir).filter((name) => name.includes(".corrupt-") && !known.includes(name))
      );
      wait();
    }
    const remaining = readdirSync(dir).filter((name) => name.includes(".corrupt-")).sort();
    expect(remaining).toHaveLength(5);
    // The oldest of the six went; the newest five stay.
    expect(remaining).not.toContain(known[0]);
    expect(remaining).toContain(known[5]!);
  });
});
