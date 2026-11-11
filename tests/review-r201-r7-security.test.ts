import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SESSION_AGENTS } from "../src/session/cli-agents.js";
import { openSessionPrivateHome } from "../src/session/private-home.js";
import { sessionKeyedHomePath } from "../src/session/private-home-key.js";
import { MTIME_WALK_ENTRY_CAP, newestMtimeMs, prepareRunDirParent } from "../src/hermetic-sweep.js";
import { recordTrustedParent, removeUnderTrustedParentOrThrow } from "../src/safe-remove.js";
import { SAFE_SESSION_ID_PATTERN } from "../src/session/id-pattern.js";
import { DROID_DRIVER_PROFILE } from "../src/session/droid-driver.js";
import { engineSession, fakeTurnProcess } from "./helpers/session-turn-engine.js";

const root = () => mkdtempSync(join(import.meta.dir, "../scratch/fix/r7-security-"));
const unsafe = ["x/../../../outside", "x\\..\\..\\outside", ".", "..", "/outside", "x\0y"];

for (const [agent, support] of Object.entries(SESSION_AGENTS)) {
  test(`${agent}: session IDs cannot be paths`, () => {
    for (const id of unsafe) expect(support.resumePattern.test(id), JSON.stringify(id)).toBe(false);
  });
  test(`${agent}: private homes reject unsafe known and deferred identities`, () => {
    const parent = join(root(), ".codemux-hermetic");
    const open = { parent, resume: false, idPattern: support.resumePattern, blockedPaths: [], holdStateOf: () => "free" as const };
    for (const sessionId of unsafe) {
      expect(() => openSessionPrivateHome({ ...open, sessionId })).toThrow();
      expect(existsSync(parent)).toBe(false);
    }
    const home = openSessionPrivateHome(open);
    for (const id of unsafe) expect(() => home.settle(id)).toThrow();
    expect(home.settled).toBe(false);
    expect(home.remove()).toBe(true);
  });
}

test("the shared ID boundary accepts ordinary punctuation but rejects dot segments and separators", () => {
  for (const id of ["session-id", "name.with.dots", "name:1", "20261111_1"]) expect(SAFE_SESSION_ID_PATTERN.test(id)).toBe(true);
  for (const id of [...unsafe, "", "a b", "id\n"]) expect(SAFE_SESSION_ID_PATTERN.test(id)).toBe(false);
});

test("Droid refuses a path-shaped ID from stdout before announcing a fresh session", async () => {
  const child = fakeTurnProcess();
  const h = engineSession({ options: { profile: DROID_DRIVER_PROFILE, mintedSessionId: null,
    cwd: process.cwd(), harnessHome: process.cwd(), spawnTurn: async () => child } });
  try {
    h.user(); await h.wait("turn_started");
    h.line(JSON.stringify({ type: "completion", session_id: "x/../../../outside", finalText: "Done" }));
    child.exit(0);
    expect(await h.code()).toBe(1);
    expect(h.events.some((event) => event.type === "session_started")).toBe(false);
    expect(h.events.find((event) => event.type === "turn_completed")?.finish).toBe("failed");
  } finally { h.dispose(); }
});

test("path construction and private homes enforce safety even with a permissive caller pattern", () => {
  const parent = join(root(), ".codemux-hermetic");
  for (const sessionId of unsafe) {
    expect(() => sessionKeyedHomePath(parent, sessionId)).toThrow();
    expect(() => openSessionPrivateHome({ parent, sessionId, resume: false, idPattern: /.*/, blockedPaths: [] })).toThrow();
    expect(existsSync(parent)).toBe(false);
  }
});

test("trusted-parent removal refuses siblings and the parent itself", () => {
  const base = root();
  const parent = join(base, "parent");
  const sibling = join(base, "outside");
  mkdirSync(parent, { mode: 0o700 });
  mkdirSync(sibling);
  const record = recordTrustedParent(parent);
  for (const path of [sibling, parent, join(parent, "..", "outside")]) {
    expect(() => removeUnderTrustedParentOrThrow(path, record, "test path")).toThrow();
    expect(existsSync(path)).toBe(true);
  }
});

test("settlement refuses a replaced parent before reading or renaming its children", () => {
  const base = root();
  const parent = join(base, ".codemux-hermetic");
  const home = openSessionPrivateHome({ parent, resume: false, idPattern: /^safe$/, blockedPaths: [], holdStateOf: () => "free" });
  renameSync(parent, join(base, "original"));
  const outside = join(base, "outside");
  mkdirSync(outside);
  symlinkSync(outside, parent);
  expect(() => home.settle("safe")).toThrow();
  expect(existsSync(join(outside, "session-safe"))).toBe(false);
});

test("freshness scanning does not enumerate a symlink at the tree root", () => {
  const base = root();
  const outside = join(base, "outside");
  const link = join(base, "link");
  mkdirSync(outside); symlinkSync(outside, link);
  const spy = spyOn(fs, "readdirSync").mockImplementation(() => { throw new Error("unexpected traversal"); });
  try {
    expect(newestMtimeMs(link)).not.toBeNull();
    expect(spy).not.toHaveBeenCalled();
  } finally { spy.mockRestore(); }
});

for (const entry of ["session-safe", "session-home-0123456789ab-safe"]) {
  test(`${entry}: an unreadable subtree keeps a free resumable home`, () => {
    const base = root();
    const parent = join(base, ".codemux-hermetic");
    const dir = join(parent, entry);
    const subtree = join(dir, "transcripts");
    mkdirSync(subtree, { recursive: true, mode: 0o700 });
    const old = new Date(Date.now() - 35 * 86_400_000);
    utimesSync(subtree, old, old); utimesSync(dir, old, old);
    const read = fs.readdirSync;
    const spy = spyOn(fs, "readdirSync").mockImplementation(((path: string, ...args: unknown[]) => {
      if (String(path) === subtree) throw Object.assign(new Error("unreadable transcript"), { code: "EACCES" });
      return (read as Function)(path, ...args);
    }) as typeof fs.readdirSync);
    try {
      prepareRunDirParent(base, ".codemux-hermetic", () => "free");
      expect(existsSync(dir)).toBe(true);
    } finally { spy.mockRestore(); }
  });
  test(`${entry}: an incomplete freshness scan keeps a free resumable home`, () => {
    const base = root();
    const parent = join(base, ".codemux-hermetic");
    const dir = join(parent, entry);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const old = new Date(Date.now() - 35 * 86_400_000);
    for (let i = 0; i <= MTIME_WALK_ENTRY_CAP; i++) writeFileSync(join(dir, `file-${i}`), "fresh transcript");
    utimesSync(dir, old, old);
    prepareRunDirParent(base, ".codemux-hermetic", () => "free");
    expect(existsSync(dir)).toBe(true);
    expect(readFileSync(join(dir, "file-0"), "utf8")).toBe("fresh transcript");
  });
}
