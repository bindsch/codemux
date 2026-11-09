/** Unit coverage for the shared hermetic-session private home
 * (src/session/private-home.ts, the SessionPrivateHome contract in
 * session/private-home-types.ts): every arm of openSessionPrivateHome —
 * the keyed fresh open, the run-shaped fresh open and its settle, the
 * resume (found, missing, and swapped), the populate failure's removal,
 * and the removal contract itself — plus the sweep's session-directory
 * branch over a non-UUID id shape. */

import { afterAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { openSessionPrivateHome } from "../src/session/private-home.js";
import type { SessionPrivateHome } from "../src/session/private-home-types.js";
import { prepareRunDirParent } from "../src/hermetic-home.js";
import { sessionHoldState } from "../src/session/registry.js";
import type { SessionHold } from "../src/session/registry.js";
import { sessionKeyedHomePath, settledPrivateHomePath } from "../src/session/private-home-key.js";
import { settledAgyHarnessHome } from "../src/session/agy-private-home.js";
import { kimiPrivateBrandHome } from "../src/kimi-hermetic.js";

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/** One launcher-shaped parent under a fresh root; the sweep consults a
 * stub registry answer, never the operator's. */
function parentDir(): string {
  const root = mkdtempSync(join(tmpdir(), "private-home-"));
  roots.push(root);
  const parent = join(root, "brand", ".codemux-hermetic");
  return parent;
}

const IDS = /^\S{1,128}$/;
const free: (id: string) => SessionHold = () => "free";

function keyed(parent: string, id: string): string {
  return join(parent, `session-${id}`);
}

describe("openSessionPrivateHome - fresh with a known id", () => {
  test("creates the settled name, mode 0700, and runs populate inside it", () => {
    const parent = parentDir();
    const populated: string[] = [];
    const home = openSessionPrivateHome({
      parent,
      sessionId: "conv-abc-1",
      resume: false,
      idPattern: IDS,
      blockedPaths: ["/blocked"],
      holdStateOf: free,
      populate: (dir) => populated.push(dir),
    });
    expect(home.dir).toBe(keyed(parent, "conv-abc-1"));
    expect(home.resumed).toBe(false);
    expect(home.settled).toBe(true);
    expect(home.blockedPaths).toEqual(["/blocked"]);
    expect(populated).toEqual([home.dir]);
    expect(statSync(home.dir).mode & 0o777).toBe(0o700);
    // Settle is a no-op from the settled name on.
    home.settle("conv-abc-1");
    expect(home.dir).toBe(keyed(parent, "conv-abc-1"));
  });

  test("refuses an id outside the pattern before any path is built", () => {
    const parent = parentDir();
    expect(() =>
      openSessionPrivateHome({
        parent,
        sessionId: "bad id\nwith newline",
        resume: false,
        idPattern: IDS,
        blockedPaths: [],
        holdStateOf: free,
      })
    ).toThrow("does not match the id shape this agent's sessions resume by");
    expect(existsSync(parent)).toBe(false);
  });

  test("refuses a keyed name that already exists, keeping it untouched", () => {
    const parent = parentDir();
    mkdirSync(parent, { recursive: true });
    const taken = keyed(parent, "conv-taken");
    mkdirSync(taken);
    expect(() =>
      openSessionPrivateHome({
        parent,
        sessionId: "conv-taken",
        resume: false,
        idPattern: IDS,
        blockedPaths: [],
        holdStateOf: free,
      })
    ).toThrow("refusing to reuse a directory this command did not create");
    expect(existsSync(taken)).toBe(true);
  });

  test("a populate throw removes the fresh home and rethrows", () => {
    const parent = parentDir();
    expect(() =>
      openSessionPrivateHome({
        parent,
        sessionId: "conv-fails",
        resume: false,
        idPattern: IDS,
        blockedPaths: [],
        holdStateOf: free,
        populate: () => {
          throw new Error("synthetic populate failure");
        },
      })
    ).toThrow("synthetic populate failure");
    expect(existsSync(keyed(parent, "conv-fails"))).toBe(false);
  });
});

describe("openSessionPrivateHome - fresh run-shaped", () => {
  test("starts run-shaped, settles onto the id, and dir follows the rename", () => {
    const parent = parentDir();
    const home = openSessionPrivateHome({
      parent,
      resume: false,
      idPattern: IDS,
      blockedPaths: [],
      holdStateOf: free,
    });
    expect(basename(home.dir).startsWith(`run-${process.pid}-`)).toBe(true);
    expect(home.settled).toBe(false);
    const runShaped = home.dir;
    home.settle("sess_7f9");
    expect(home.settled).toBe(true);
    expect(home.dir).toBe(keyed(parent, "sess_7f9"));
    expect(existsSync(runShaped)).toBe(false);
    // Idempotent: the rename happens once.
    home.settle("sess_7f9");
    expect(home.dir).toBe(keyed(parent, "sess_7f9"));
    // remove() follows the rename too.
    expect(home.remove()).toBe(true);
    expect(existsSync(keyed(parent, "sess_7f9"))).toBe(false);
    expect(home.remove()).toBe(true);
  });

  test("settle refuses a bad id shape and an existing target, keeping the home run-shaped", () => {
    const parent = parentDir();
    const home = openSessionPrivateHome({
      parent,
      resume: false,
      idPattern: IDS,
      blockedPaths: [],
      holdStateOf: free,
    });
    expect(() => home.settle("not an id\n")).toThrow(
      "does not match the id shape this agent's sessions resume by"
    );
    const taken = keyed(parent, "sess-taken");
    mkdirSync(taken, { recursive: true });
    expect(() => home.settle("sess-taken")).toThrow(
      "refusing to reuse a directory this command did not create"
    );
    expect(home.settled).toBe(false);
    expect(existsSync(home.dir)).toBe(true);
    expect(home.remove()).toBe(true);
  });

  test("a populate throw removes the run-shaped home and rethrows", () => {
    const parent = parentDir();
    let observed: string | undefined;
    expect(() =>
      openSessionPrivateHome({
        parent,
        resume: false,
        idPattern: IDS,
        blockedPaths: [],
        holdStateOf: free,
        populate: (dir) => {
          observed = dir;
          throw new Error("no login to copy");
        },
      })
    ).toThrow("no login to copy");
    expect(observed !== undefined && existsSync(observed)).toBe(false);
  });
});

describe("openSessionPrivateHome - resume", () => {
  test("opens the keyed directory settled with nothing rewritten", () => {
    const parent = parentDir();
    const dir = keyed(parent, "sess-live");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const home = openSessionPrivateHome({
      parent,
      sessionId: "sess-live",
      resume: true,
      idPattern: IDS,
      blockedPaths: [],
      holdStateOf: free,
    });
    expect(home.dir).toBe(dir);
    expect(home.resumed).toBe(true);
    expect(home.settled).toBe(true);
    home.settle("sess-live"); // no-op
    expect(home.dir).toBe(dir);
  });

  test("a missing home is refused naming the id and the transcript", () => {
    const parent = parentDir();
    expect(() =>
      openSessionPrivateHome({
        parent,
        sessionId: "sess-gone",
        resume: true,
        idPattern: IDS,
        blockedPaths: [],
        holdStateOf: free,
      })
    ).toThrow(
      "session sess-gone has no private home at " +
        `${join(parent, "session-sess-gone")}: it was removed (--final or the stale sweep) ` +
        "and the session's transcript with it, so it cannot resume"
    );
  });

  test("a resume without its recorded id is refused", () => {
    const parent = parentDir();
    expect(() =>
      openSessionPrivateHome({
        parent,
        resume: true,
        idPattern: IDS,
        blockedPaths: [],
        holdStateOf: free,
      })
    ).toThrow("must be opened with its recorded session id");
  });

  test("a swapped link at the keyed name is refused, never followed", () => {
    const parent = parentDir();
    mkdirSync(parent, { recursive: true });
    const elsewhere = join(parent, "elsewhere");
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, keyed(parent, "sess-link"));
    expect(() =>
      openSessionPrivateHome({
        parent,
        sessionId: "sess-link",
        resume: true,
        idPattern: IDS,
        blockedPaths: [],
        holdStateOf: free,
      })
    ).toThrow();
  });
});

describe("openSessionPrivateHome - removal", () => {
  test("remove throws the reason when the parent was swapped, and stays retryable", () => {
    const parent = parentDir();
    const home: SessionPrivateHome = openSessionPrivateHome({
      parent,
      resume: false,
      idPattern: IDS,
      blockedPaths: [],
      holdStateOf: free,
    });
    // Swap the recorded parent for a different directory: the removal
    // must refuse through it rather than delete the replacement's tree.
    rmSync(parent, { recursive: true, force: true });
    mkdirSync(parent, { recursive: true });
    expect(() => home.remove()).toThrow();
  });
});

describe("the stale sweep's session-directory branch", () => {
  test("a stale non-UUID session key goes only past a free registry answer", () => {
    const root = mkdtempSync(join(tmpdir(), "private-home-sweep-"));
    roots.push(root);
    const registry = join(root, "registry.json");
    const parent = join(root, "brand", ".codemux-hermetic");
    const holdState = (id: string): SessionHold =>
      sessionHoldState(registry, id);
    // Age past the two-day session gate; ids are NOT UUIDs here.
    const stale = join(parent, "session-conv-stale-1");
    const held = join(parent, "session-conv-held-1");
    const fresh = join(parent, "session-conv-fresh-1");
    for (const dir of [stale, held, fresh]) mkdirSync(dir, { recursive: true });
    const old = new Date(Date.now() - 3 * 86_400_000);
    utimesSync(stale, old, old);
    utimesSync(held, old, old);
    chmodSync(parent, 0o700);
    // A run-shaped dead-pid dir three days old: swept by its own rule.
    const deadRun = join(parent, "run-999999999-gone");
    mkdirSync(deadRun);
    utimesSync(deadRun, old, old);
    // held: the registry answers anything but free for that id.
    const holdOf = (id: string): SessionHold =>
      id === "conv-held-1" ? "held" : holdState(id);
    prepareRunDirParent(
      join(parent, ".."),
      basename(parent),
      holdOf
    );
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(deadRun)).toBe(false);
    expect(existsSync(held)).toBe(true);
    expect(existsSync(fresh)).toBe(true);
  });
});

describe("the session key spelled from the parent equals the drivers' settled spelling (review round 412)", () => {
  // A resume knows the parent and the id, never the run-shaped dir; the
  // drivers record settledPrivateHomePath(<run-shaped dir>, id). Passing
  // the parent to that helper looked one directory too high and every
  // hermetic resume answered the missing-home refusal.
  test("codex, kimi, and agy spellings agree", () => {
    const parent = "/state/brand/.codemux-hermetic";
    const runShaped = `${parent}/run-123-abc`;
    const id = "thread-9";
    expect(sessionKeyedHomePath(parent, id)).toBe(settledPrivateHomePath(runShaped, id));
    expect(kimiPrivateBrandHome(sessionKeyedHomePath(parent, id))).toBe(
      kimiPrivateBrandHome(settledPrivateHomePath(runShaped, id))
    );
    expect(`${sessionKeyedHomePath(parent, id)}/.gemini/antigravity-cli`).toBe(
      settledAgyHarnessHome(runShaped, id)
    );
    // The old mistake, pinned as wrong: the parent through the dir helper.
    expect(settledPrivateHomePath(parent, id)).not.toBe(sessionKeyedHomePath(parent, id));
  });
});

describe("the kimi hermetic turn context follows the settle rename", () => {
  test("every path field reads the home's current directory; finalize is a no-op", () => {
    const parent = mkdtempSync(join(tmpdir(), "codemux-kimi-turn-ctx-"));
    const { openSessionPrivateHome } = require("../src/session/private-home.js") as typeof import("../src/session/private-home.js");
    const { kimiHermeticTurnContext } = require("../src/session/kimi-turn-context.js") as typeof import("../src/session/kimi-turn-context.js");
    try {
      const home = openSessionPrivateHome({
        parent,
        sessionId: undefined,
        resume: false,
        idPattern: /^\S{1,128}$/,
        blockedPaths: [],
        holdStateOf: () => "free",
        populate: () => {},
      });
      const context = kimiHermeticTurnContext(home);
      const before = home.dir;
      expect(context.kimiHermeticHome!.home).toBe(before);
      expect(context.kimiHermeticHome!.kimiHome).toBe(kimiPrivateBrandHome(before));
      expect(context.kimiHermeticHome!.skillsDir).toBe(join(before, "skills-dir"));
      expect(context.kimiHermeticHome!.agentFile).toBe(join(before, "agent.md"));
      home.settle("kimi-1");
      expect(context.kimiHermeticHome!.home).toBe(sessionKeyedHomePath(parent, "kimi-1"));
      expect(context.kimiHermeticHome!.kimiHome).toBe(kimiPrivateBrandHome(sessionKeyedHomePath(parent, "kimi-1")));
      expect(() => context.kimiHermeticHome!.finalize()).not.toThrow();
      expect(existsSync(home.dir)).toBe(true);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });
});
