/**
 * The shared turn engine's private-home end path (turn-driver-core.ts
 * settleHomeAtEnd and removeFinalHomeSettled), driven at the driver
 * level over the watching home: every keep-or-remove verdict a private
 * home can take at the end — deferred settle at the adopt, the resumable
 * settle onto the session id, the abandoned removal, and the --final
 * removal's retry-and-fail ladder.
 */

import { describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  engineSession,
  fakeTurnProcess,
  watchingHome,
  wireProfile,
} from "./helpers/session-turn-engine.js";

const waitCode = async (session: ReturnType<typeof engineSession>): Promise<number> => {
  const code = await session.code();
  session.dispose();
  return code;
};

const spyErrors = (): { noted: () => string; restore: () => void } => {
  const noted: string[] = [];
  const error = spyOn(console, "error").mockImplementation((...values: unknown[]) => {
    noted.push(values.map(String).join(" "));
  });
  return { noted: () => noted.join("\n"), restore: () => error.mockRestore() };
};

describe("the private home at the end path", () => {
  test("a deferred session settles its home at the first turn's completion", async () => {
    const home = watchingHome();
    const proc = fakeTurnProcess();
    const session = engineSession({
      options: {
        privateHome: home,
        profile: wireProfile({ sessionId: "harness-mint-9" }, { identity: "deferred" }),
        spawnTurn: async () => proc,
      },
    });
    session.user();
    proc.exit(0);
    await session.wait("turn_completed");
    expect(home.settles).toEqual(["harness-mint-9"]);
    session.shutdown();
    expect(await waitCode(session)).toBe(0);
  });

  test("a settle that throws at the turn's completion is reported, not fatal", async () => {
    const home = watchingHome({ settleThrows: true });
    const proc = fakeTurnProcess();
    const errors = spyErrors();
    let session: ReturnType<typeof engineSession> | null = null;
    try {
      session = engineSession({
        options: {
          privateHome: home,
          profile: wireProfile({ sessionId: "harness-mint-9" }, { identity: "deferred" }),
          spawnTurn: async () => proc,
        },
      });
      session.user();
      proc.exit(0);
      const completed = await session.wait("turn_completed");
      expect(completed).toMatchObject({ finish: "end" });
      expect(errors.noted()).toContain("settlement failed");
      session.shutdown();
      expect(await session.code()).toBe(0);
    } finally {
      errors.restore();
      session?.dispose();
    }
  });

  test("a fresh resumable home settles onto the session id at the end", async () => {
    const dir = mkdtempSync(join(tmpdir(), "codemux-turn-registry-"));
    const home = watchingHome();
    let session: ReturnType<typeof engineSession> | null = null;
    try {
      session = engineSession({
        options: { registryPath: join(dir, "live-sessions.json"), privateHome: home },
      });
      session.shutdown();
      await session.wait("session_ended");
      expect(home.settles).toEqual(["m-1"]);
      expect(await session.code()).toBe(0);
    } finally {
      session?.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a resumed home settles at the end and is never removed", async () => {
    const home = watchingHome({ resumed: true });
    const session = engineSession({
      options: { privateHome: home, resumeSessionId: "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d" },
    });
    session.shutdown();
    await session.wait("session_ended");
    expect(home.settles).toEqual(["1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d"]);
    expect(home.removals).toBe(0);
    expect(await waitCode(session)).toBe(0);
  });

  test("an abandoned fresh home is removed when the session crashes", async () => {
    const home = watchingHome();
    const session = engineSession({
      options: {
        privateHome: home,
        spawnTurn: async () => Promise.reject(new Error("probe refused")),
      },
    });
    session.user();
    await session.until((event) => event.type === "error" && event.fatal === true);
    await session.wait("session_ended");
    expect(home.removals).toBe(1);
    expect(home.settles).toEqual([]);
    expect(await waitCode(session)).toBe(1);
  });

  test("a --final home that fails removal once retries and then removes", async () => {
    const home = watchingHome({ removeThrows: 1 });
    const errors = spyErrors();
    const proc = fakeTurnProcess();
    let session: ReturnType<typeof engineSession> | null = null;
    try {
      session = engineSession({
        options: { privateHome: home, final: true, spawnTurn: async () => proc },
      });
      session.user();
      proc.exit(0);
      await session.wait("turn_completed");
      session.shutdown();
      const ended = await session.wait("session_ended");
      expect(ended).toMatchObject({ exit_code: 0, resumable: false });
      expect(home.removals).toBe(2);
      expect(errors.noted()).toContain("could not remove the session's private home");
      expect(await session.code()).toBe(0);
    } finally {
      errors.restore();
      session?.dispose();
    }
  });

  test("a --final home that never removes keeps the home and fails the exit", async () => {
    const home = watchingHome({ removeThrows: 2 });
    const errors = spyErrors();
    let session: ReturnType<typeof engineSession> | null = null;
    try {
      session = engineSession({
        options: { privateHome: home, final: true },
      });
      session.shutdown();
      const ended = await session.wait("session_ended");
      expect(ended).toMatchObject({ exit_code: 1, resumable: false });
      expect(home.removals).toBe(2);
      expect(await session.code()).toBe(1);
    } finally {
      errors.restore();
      session?.dispose();
    }
  });

  test("a settle that throws at the end of a resumed session reports and stays resumable-false", async () => {
    const home = watchingHome({ resumed: true, settleThrows: true });
    const errors = spyErrors();
    let session: ReturnType<typeof engineSession> | null = null;
    try {
      session = engineSession({
        options: {
          privateHome: home,
          resumeSessionId: "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d",
        },
      });
      session.shutdown();
      const ended = await session.wait("session_ended");
      expect(ended).toMatchObject({ resumable: false });
      expect(errors.noted()).toContain("settlement failed");
      expect(await session.code()).toBe(0);
    } finally {
      errors.restore();
      session?.dispose();
    }
  });

  test("a lost end stamp after a settled --final removal fails the exit", async () => {
    const dir = mkdtempSync(join(tmpdir(), "codemux-turn-registry-"));
    const registryPath = join(dir, "live-sessions.json");
    const home = watchingHome();
    const errors = spyErrors();
    const proc = fakeTurnProcess();
    let session: ReturnType<typeof engineSession> | null = null;
    try {
      session = engineSession({
        options: {
          registryPath,
          privateHome: home,
          final: true,
          spawnTurn: async () => proc,
        },
      });
      session.user();
      proc.exit(0);
      await session.wait("turn_completed");
      rmSync(registryPath, { force: true });
      session.shutdown();
      const ended = await session.wait("session_ended");
      expect(ended).toMatchObject({ exit_code: 1, resumable: false });
      expect(home.removals).toBe(1);
      expect(errors.noted()).toContain("cannot stamp the session end");
      expect(await session.code()).toBe(1);
    } finally {
      errors.restore();
      session?.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
