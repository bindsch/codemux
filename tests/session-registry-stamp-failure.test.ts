/**
 * Registry-failure behavior across the live-session drivers (audit round
 * 2, test 8). A turn-path activity stamp that cannot take the registry
 * lock warns exactly once per session and never blocks the turn: the
 * lock is held by this process — a live writer — so every stamp's single
 * attempt fails fast, a second turn under the same hold stays silent
 * (the warn-once latch), and releasing the lock restores a clean exit.
 * A codex session that cannot record itself at start fails closed: no
 * announcement, a fatal error, exit 1.
 */

import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireLock } from "../src/session/registry-io.js";
import {
  cleanupMark,
  cleanupSessions,
  cleanupSessionsSince,
  startSession as startCodex,
} from "./session-codex-e2e-helpers.js";
import {
  cleanups as aiderCleanups,
  send as sendAider,
  startSession as startAider,
  type Event,
} from "./helpers/session-aider-e2e.js";
import {
  cleanups as agyCleanups,
  send as sendAgy,
  startSession as startAgy,
} from "./helpers/session-agy-e2e.js";
import {
  cleanups as kimiCleanups,
  send as sendKimi,
  startSession as startKimi,
} from "./helpers/session-kimi-e2e.js";
import {
  cleanups as opencodeCleanups,
  send as sendOpencode,
  startSession as startOpencode,
} from "./helpers/session-opencode-e2e.js";

const STAMP_WARNING = /cannot stamp the session registry for /;

/** Swallow console.error for the duration of `body`, recording every
 * line, and return how many matched the stamp warning. */
async function withConsoleErrorCaptured<T>(body: () => Promise<T>): Promise<{ result: T; warnings: number }> {
  const lines: string[] = [];
  const spy = spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    lines.push(args.filter((part) => typeof part === "string").join(" "));
  });
  try {
    const result = await body();
    return { result, warnings: lines.filter((line) => STAMP_WARNING.test(line)).length };
  } finally {
    spy.mockRestore();
  }
}

/** Wait until the event stream holds `count` events of `type`. */
async function waitForTurnEnds(events: Event[], count: number, label: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const seen = events.filter((event) => event.type === "turn_completed").length;
    if (seen >= count) return;
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${label}; saw: ${events.map((e) => e.type).join(",")}`);
    }
    await Bun.sleep(10);
  }
}

/** The shared three-turn body: turn 1 records and stamps cleanly, turns
 * 2 and 3 run under a lock this process holds, and the shutdown after
 * the release still exits 0 — the failed stamps cost a warning, not the
 * session. */
async function assertStampWarnsOnceUnderHeldLock(
  session: { events: Event[]; options: { registryPath: string | null }; code: Promise<number> },
  turn: (ordinal: "one" | "two" | "three") => void,
  shutdown: () => void
): Promise<void> {
  const registryPath = session.options.registryPath;
  if (registryPath === null) throw new Error("the rig started without a registry path");
  turn("one");
  await waitForTurnEnds(session.events, 1, "turn 1 (unlocked)");
  if (!existsSync(registryPath)) throw new Error("turn 1 never recorded the session");

  let handle: ReturnType<typeof acquireLock> | null = null;
  try {
    handle = acquireLock(`${registryPath}.lock`, { attempts: 1 });
    const { warnings: afterTurn2 } = await withConsoleErrorCaptured(async () => {
      turn("two");
      await waitForTurnEnds(session.events, 2, "turn 2 (behind a live writer)");
    });
    expect(afterTurn2).toBe(1);
    // The latch: a second failed stamp in the same session stays silent,
    // so this window holds no warning at all.
    const { warnings: afterTurn3 } = await withConsoleErrorCaptured(async () => {
      turn("three");
      await waitForTurnEnds(session.events, 3, "turn 3 (still behind the writer)");
    });
    expect(afterTurn3).toBe(0);
  } finally {
    handle?.release();
  }
  shutdown();
  expect(await session.code).toBe(0);
}

afterAll(async () => {
  for (const clean of [...aiderCleanups, ...agyCleanups, ...opencodeCleanups, ...kimiCleanups]) {
    await clean();
  }
  await cleanupSessions();
});

describe("a turn-path stamp behind a live registry writer warns once (audit round 2, test 8)", () => {
  test("aider", async () => {
    const session = await startAider();
    await assertStampWarnsOnceUnderHeldLock(
      session,
      (ordinal) => sendAider(session.driver, { type: "user", text: `scenario:basic ${ordinal}` }),
      () => sendAider(session.driver, { type: "shutdown" })
    );
  }, 30_000);

  test("agy", async () => {
    const session = await startAgy();
    await assertStampWarnsOnceUnderHeldLock(
      session,
      (ordinal) => sendAgy(session.driver, { type: "user", text: `scenario:basic ${ordinal}` }),
      () => sendAgy(session.driver, { type: "shutdown" })
    );
  }, 30_000);

  test("opencode", async () => {
    const session = await startOpencode();
    await assertStampWarnsOnceUnderHeldLock(
      session,
      (ordinal) => sendOpencode(session.driver, { type: "user", text: `scenario:basic ${ordinal}` }),
      () => sendOpencode(session.driver, { type: "shutdown" })
    );
  }, 30_000);

  test("kimi", async () => {
    const session = await startKimi();
    await assertStampWarnsOnceUnderHeldLock(
      session,
      (ordinal) => sendKimi(session.driver, { type: "user", text: `scenario:basic ${ordinal}` }),
      () => sendKimi(session.driver, { type: "shutdown" })
    );
  }, 30_000);
});

describe("a codex session that cannot record itself at start fails closed (audit round 2, test 8)", () => {
  test("the registry failure is fatal before the announcement, and the session exits 1", async () => {
    const mark = cleanupMark();
    // The registry's parent is a regular file, so the start record cannot
    // even create the directory: recordSessionStart fails at the moment
    // the thread names the session — before any announcement.
    const dir = mkdtempSync(join(tmpdir(), "codemux-codex-record-"));
    writeFileSync(join(dir, "blocker"), "a regular file");
    const session = await startCodex({
      registryPath: join(dir, "blocker", "live-sessions.json"),
    });
    try {
      expect(await session.code).toBe(1);
      const fatal = session.events.find(
        (event) => event.type === "error" && event.fatal === true
      );
      expect(fatal).toBeDefined();
      expect(fatal!.source).toBe("codemux");
      expect(fatal!.message).toContain("cannot record the session in the registry");
      // §4.8's rule: an untrackable live session never announces.
      expect(session.events.find((event) => event.type === "session_started")).toBeUndefined();
    } finally {
      await cleanupSessionsSince(mark);
    }
  }, 30_000);
});
