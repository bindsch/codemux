import { afterEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { Database } from "bun:sqlite";
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openCodexSessionPrivateHome, repairCodexHomeRollouts } from "../src/session/codex-home.js";
import { createCodexSessionProviderHome, openCodexSessionProviderHome, codexSessionProviderHomePath } from "../src/codex-provider.js";
import { MODEL, OVERRIDE, SESSION_ID } from "./helpers/codex-provider.js";
import { cleanupSessions, startAndWait, send } from "./session-codex-e2e-helpers.js";

const roots: string[] = [];
function root(): string {
  const dir = mkdtempSync(join(import.meta.dir, "../scratch/fix/codex-relocate-"));
  roots.push(dir);
  return dir;
}
afterEach(async () => {
  await cleanupSessions();
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const tail = "sessions/2026/11/14/rollout-selected.jsonl";
function seed(home: string, old = home, suffix = tail): string {
  mkdirSync(join(home, "sessions/2026/11/14"), { recursive: true });
  writeFileSync(join(home, tail), "selected history\n");
  const db = new Database(join(home, "state_5.sqlite"));
  db.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, history_mode TEXT, updated_at INTEGER)");
  db.query("INSERT INTO threads VALUES (?, ?, 'paginated', 42)").run(SESSION_ID, join(old, suffix));
  db.close();
  return join(home, "state_5.sqlite");
}
function rows(home: string): unknown[] {
  const db = new Database(join(home, "state_5.sqlite"), { readonly: true });
  try { return db.query("SELECT * FROM threads ORDER BY id").all(); }
  finally { db.close(); }
}
function moved(nested = true): { home: string; old: string; dir: string } {
  const dir = root();
  const old = join(dir, "run-123-before", ...(nested ? [".codex"] : []));
  const home = join(dir, `session-${SESSION_ID}`, ...(nested ? [".codex"] : []));
  mkdirSync(join(dir, "run-123-before"), { mode: 0o700 });
  seed(old);
  renameSync(join(dir, "run-123-before"), join(dir, `session-${SESSION_ID}`));
  return { home, old, dir };
}

for (const mask of [0o002, 0o022]) {
  for (const nested of [true, false]) {
    test(`repairs ${nested ? "hermetic" : "provider"} child entries created under umask ${mask.toString(8)}`, () => {
      const previous = process.umask(mask);
      try {
        const { home } = moved(nested);
        expect(lstatSync(join(home, tail)).mode & 0o777).toBe(0o666 & ~mask);
        expect(lstatSync(join(home, "sessions/2026/11/14")).mode & 0o777).toBe(0o777 & ~mask);
        repairCodexHomeRollouts(home);
        expect(rows(home)).toContainEqual({ id: SESSION_ID, rollout_path: join(home, tail), history_mode: "paginated", updated_at: 42 });
      } finally { process.umask(previous); }
    });
  }
}

for (const target of ["state_5.sqlite", tail, ".", "sessions", "sessions/2026/11/14"]) {
  test(`refuses world-writable child entry ${target}`, () => {
    const { home } = moved();
    chmodSync(join(home, target), 0o777);
    expect(() => repairCodexHomeRollouts(home)).toThrow();
  });
  test(`refuses foreign-owned child entry ${target}`, () => {
    const { home } = moved();
    const path = join(home, target);
    const actual = fs.lstatSync;
    const stat = actual(path);
    const mock = spyOn(fs, "lstatSync").mockImplementation(((p: fs.PathLike, options: any) =>
      String(p) === path ? Object.assign(stat, { uid: (process.getuid?.() ?? 0) + 1 }) : actual(p, options)) as typeof fs.lstatSync);
    try { expect(() => repairCodexHomeRollouts(home)).toThrow(); }
    finally { mock.mockRestore(); }
  });
}

for (const target of ["root", "parent"]) {
  test(`still refuses a group-writable private ${target}`, () => {
    const { home, dir } = moved();
    chmodSync(target === "root" ? join(dir, `session-${SESSION_ID}`) : dir, 0o770);
    expect(() => repairCodexHomeRollouts(home)).toThrow("not group- or world-writable");
  });
}

for (const nested of [true, false]) {
  test(`rebases ${nested ? "hermetic" : "provider"} selected paths and preserves history and metadata`, () => {
    const { home } = moved(nested);
    repairCodexHomeRollouts(home);
    expect(rows(home)).toEqual([{ id: SESSION_ID, rollout_path: join(home, tail), history_mode: "paginated", updated_at: 42 }]);
    expect(readFileSync(join(home, tail), "utf8")).toBe("selected history\n");
    repairCodexHomeRollouts(home);
    expect(rows(home)).toEqual([{ id: SESSION_ID, rollout_path: join(home, tail), history_mode: "paginated", updated_at: 42 }]);
  });
}

test("does not replace a selected rollout with another file or rewrite unrelated paths", () => {
  const { home, old } = moved();
  const db = new Database(join(home, "state_5.sqlite"));
  db.query("INSERT INTO threads VALUES (?, ?, 'legacy', 7)").run("outside", join(old + "-other", tail));
  db.close();
  writeFileSync(join(home, "sessions/2026/11/14/rollout-older.jsonl"), "older");
  repairCodexHomeRollouts(home);
  expect(rows(home)).toContainEqual({ id: "outside", rollout_path: join(old + "-other", tail), history_mode: "legacy", updated_at: 7 });
  expect(rows(home)).toContainEqual({ id: SESSION_ID, rollout_path: join(home, tail), history_mode: "paginated", updated_at: 42 });
});

test("missing selected history rolls back every update", () => {
  const { home, old } = moved();
  const db = new Database(join(home, "state_5.sqlite"));
  db.query("INSERT INTO threads VALUES (?, ?, 'paginated', 8)").run("missing", join(old, "sessions/2026/11/14/missing.jsonl"));
  db.close();
  const before = rows(home);
  expect(() => repairCodexHomeRollouts(home)).toThrow("relocated rollout is missing");
  expect(rows(home)).toEqual(before);
});

test("rebases archived and compressed rollouts without changing the native path representation", () => {
  const { home, old } = moved();
  renameSync(join(home, tail), join(home, tail + ".zst"));
  mkdirSync(join(home, "archived_sessions"));
  writeFileSync(join(home, "archived_sessions/archived.jsonl"), "archived");
  const db = new Database(join(home, "state_5.sqlite"));
  db.query("INSERT INTO threads VALUES (?, ?, 'legacy', 9)").run("archived", join(old, "archived_sessions/archived.jsonl"));
  db.close();
  repairCodexHomeRollouts(home);
  expect(rows(home)).toContainEqual({ id: SESSION_ID, rollout_path: join(home, tail), history_mode: "paginated", updated_at: 42 });
  expect(rows(home)).toContainEqual({ id: "archived", rollout_path: join(home, "archived_sessions/archived.jsonl"), history_mode: "legacy", updated_at: 9 });
});

for (const target of ["state_5.sqlite", "state_5.sqlite-wal", "state_5.sqlite-shm", "state_5.sqlite-journal", tail, "sessions"]) {
  test(`refuses symlink at ${target}`, () => {
    const { home, dir } = moved();
    const path = join(home, target);
    const outside = join(dir, "outside");
    if (existsSync(path)) renameSync(path, outside);
    else writeFileSync(outside, "untouched");
    symlinkSync(outside, path);
    expect(() => repairCodexHomeRollouts(home)).toThrow();
  });
}

test("refuses a hard-linked database and unknown schema", () => {
  const { home, dir } = moved();
  linkSync(join(home, "state_5.sqlite"), join(dir, "linked"));
  expect(() => repairCodexHomeRollouts(home)).toThrow("unlinked regular file");
  const other = join(root(), `session-${SESSION_ID}`);
  mkdirSync(other);
  new Database(join(other, "state_5.sqlite")).close();
  expect(() => repairCodexHomeRollouts(other)).toThrow("threads");
});

test("missing native database is a no-op; ordinary homes are refused", () => {
  const dir = root();
  const home = join(dir, `session-${SESSION_ID}`);
  mkdirSync(home);
  repairCodexHomeRollouts(join(home, ".codex"));
  mkdirSync(join(home, ".codex"));
  repairCodexHomeRollouts(join(home, ".codex"));
  expect(existsSync(join(home, ".codex/state_5.sqlite"))).toBe(false);
  expect(() => repairCodexHomeRollouts(dir)).toThrow("session-keyed");
});

function privateOpen(parent: string, resume = false, printOnly = false) {
  return { parent, resume, printOnly, sessionId: resume ? SESSION_ID : undefined,
    idPattern: /^[A-Za-z0-9-]+$/, blockedPaths: [], holdStateOf: () => "free" as const };
}

test("repairs a pre-fix home on resume, but never in print-only mode", () => {
  const { home, dir, old } = moved();
  openCodexSessionPrivateHome(privateOpen(dir, true, true));
  expect(rows(home)).toContainEqual({ id: SESSION_ID, rollout_path: join(old, tail), history_mode: "paginated", updated_at: 42 });
  const resumed = openCodexSessionPrivateHome(privateOpen(dir, true));
  expect(resumed.settled).toBe(true);
  expect(rows(home)).toContainEqual({ id: SESSION_ID, rollout_path: join(home, tail), history_mode: "paginated", updated_at: 42 });
});

test("settles after the child exits, repairs before release, and supports final removal", async () => {
  const home = openCodexSessionPrivateHome(privateOpen(join(root(), ".codemux-hermetic")));
  const old = join(home.dir, ".codex");
  seed(old);
  const session = await startAndWait({ privateHome: home, harnessVersion: "0.167.1" });
  expect(home.settled).toBe(false);
  send(session.driver, { type: "shutdown" });
  expect(await session.code).toBe(0);
  expect(home.settled).toBe(true);
  expect(rows(join(home.dir, ".codex"))).toContainEqual({ id: SESSION_ID, rollout_path: join(home.dir, ".codex", tail), history_mode: "paginated", updated_at: 42 });
  expect(session.events.at(-1)?.resumable).toBe(true);
  home.remove();
  expect(existsSync(home.dir)).toBe(false);
});

test("repair failure costs resumable and exit success", async () => {
  const home = openCodexSessionPrivateHome(privateOpen(join(root(), ".codemux-hermetic")));
  seed(join(home.dir, ".codex"), join(home.dir, ".codex"), "sessions/2026/11/14/missing.jsonl");
  const session = await startAndWait({ privateHome: home });
  send(session.driver, { type: "shutdown" });
  expect(await session.code).toBe(1);
  expect(home.settled).toBe(false);
  expect(session.events.at(-1)?.resumable).toBe(false);
});

test("provider settlement and pre-spawn resume repair share the same path correction", () => {
  const dir = root();
  const fresh = createCodexSessionProviderHome(dir, OVERRIDE, MODEL, null);
  seed(fresh.codexHome);
  fresh.prepareConfig();
  expect(fresh.settle(SESSION_ID, true)).toBe(true);
  const target = codexSessionProviderHomePath(dir, OVERRIDE.baseUrl, SESSION_ID);
  expect(rows(target)).toContainEqual({ id: SESSION_ID, rollout_path: join(target, tail), history_mode: "paginated", updated_at: 42 });
  const db = new Database(join(target, "state_5.sqlite"));
  db.query("UPDATE threads SET rollout_path = ?").run(join(fresh.codexHome, tail));
  db.close();
  const resumed = openCodexSessionProviderHome(dir, OVERRIDE, MODEL, null, SESSION_ID);
  resumed.prepareConfig();
  expect(rows(target)).toContainEqual({ id: SESSION_ID, rollout_path: join(target, tail), history_mode: "paginated", updated_at: 42 });
});

test("provider repair failure names the already-keyed home and preserves its history", () => {
  const dir = root();
  const fresh = createCodexSessionProviderHome(dir, OVERRIDE, MODEL, null);
  seed(fresh.codexHome, fresh.codexHome, "sessions/2026/11/14/missing.jsonl");
  const errors: string[] = [];
  const warning = spyOn(console, "error").mockImplementation(message => { errors.push(String(message)); });
  try { expect(fresh.settle(SESSION_ID, true)).toBe(false); }
  finally { warning.mockRestore(); }
  const target = codexSessionProviderHomePath(dir, OVERRIDE.baseUrl, SESSION_ID);
  expect(existsSync(fresh.codexHome)).toBe(false);
  expect(readFileSync(join(target, tail), "utf8")).toBe("selected history\n");
  expect(errors).toHaveLength(1);
  expect(errors[0]).toContain(`could not repair rollout paths in the session's provider home ${target}`);
  expect(errors[0]).toContain("relocated rollout is missing");
  expect(errors[0]).not.toContain("could not set aside");
});
