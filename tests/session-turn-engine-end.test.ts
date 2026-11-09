/**
 * The shared turn engine's end path (turn-driver-core.ts finish and the
 * record layer), driven at the driver level: the shutdown interleavings
 * with a spawn in flight and the registry record arms behind the
 * kimi-style rival lock. The private-home verdicts live in
 * tests/session-turn-engine-home.test.ts (the 500-line split).
 */

import { describe, expect, spyOn, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { currentProcessIdentity } from "../src/session/registry-io.js";
import {
  engineSession,
  fakeTurnProcess,
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

/** The rival's live registry lock (tests/session-kimi-e2e-resume-busy's
 * recipe): one held lock file makes every record attempt busy. */
const rivalLock = (registryPath: string): string => {
  const identity = currentProcessIdentity();
  const rival = join(
    dirname(registryPath),
    `.${basename(`${registryPath}.lock`)}.${identity.pid}.${randomUUID().slice(0, 8)}.held`
  );
  writeFileSync(rival, `${identity.pid}\n${identity.start ?? ""}\n`, { mode: 0o600 });
  return rival;
};

describe("the shutdown interleavings with a spawn in flight", () => {
  test("a late-landing child gets the prompt and completes the turn", async () => {
    const late = fakeTurnProcess();
    let release!: (proc: typeof late) => void;
    const session = engineSession({
      options: {
        spawnTurn: () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      },
    });
    session.user();
    session.shutdown();
    release(late);
    late.exit(0);
    const ended = await session.wait("session_ended");
    expect(ended).toMatchObject({ reason: "shutdown", exit_code: 0 });
    expect(late.wrote).toEqual(["the prompt"]);
    expect(await waitCode(session)).toBe(0);
  });

  test("a late child whose prompt write refuses ends the session crashed", async () => {
    const late = fakeTurnProcess();
    late.failWrites = true;
    let release!: (proc: typeof late) => void;
    const errors = spyErrors();
    try {
      const session = engineSession({
        options: {
          spawnTurn: () =>
            new Promise((resolve) => {
              release = resolve;
            }),
        },
      });
      session.user();
      session.shutdown();
      release(late);
      late.exit(0);
      const completed = await session.wait("turn_completed");
      expect(completed).toMatchObject({ finish: "failed" });
      expect(completed.reason).toContain("could not deliver the prompt");
      expect(await waitCode(session)).toBe(1);
    } finally {
      errors.restore();
    }
  });

  test("a spawn that rejects during the shutdown drain is the spawn fatal", async () => {
    let reject!: (error: Error) => void;
    const session = engineSession({
      options: {
        spawnTurn: () =>
          new Promise((_resolve, rejectSpawn) => {
            reject = rejectSpawn;
          }),
      },
    });
    session.user();
    session.shutdown();
    reject(new Error("probe refused late"));
    const error = await session.until((event) => event.type === "error" && event.fatal === true);
    expect(error.message).toContain("could not spawn the droid turn process");
    expect(await waitCode(session)).toBe(1);
  });

  test("a spawn that never appears within the end grace is abandoned", async () => {
    const late = fakeTurnProcess();
    let release!: (proc: typeof late) => void;
    const errors = spyErrors();
    let session: ReturnType<typeof engineSession> | null = null;
    try {
      session = engineSession({
        options: {
          spawnGraceMs: 40,
          spawnTurn: () =>
            new Promise((resolve) => {
              release = resolve;
            }),
        },
      });
      session.user();
      session.shutdown();
      const error = await session.until((event) => event.type === "error" && event.fatal === true);
      expect(error.message).toContain("never appeared within the 40 ms end grace");
      const ended = await session.wait("session_ended");
      expect(ended).toMatchObject({ exit_code: 1 });
      expect(await session.code()).toBe(1);
      // The hold settles once the abandoned spawn finally lands: the
      // child is stopped, its exit absorbed.
      release(late);
      late.exit(0);
      await session.driver.awaitAbandonedSpawn();
    } finally {
      errors.restore();
      session?.dispose();
    }
  });

  test("a turn process dying failed under stdin-close ends the session harness_failed", async () => {
    const proc = fakeTurnProcess();
    const session = engineSession({ options: { spawnTurn: async () => proc } });
    session.user();
    proc.exit(3);
    // The verdict answers (a good result line), so the turn fails on the
    // exit code alone; the stdin-close drain then sees the failed child.
    session.close();
    const completed = await session.wait("turn_completed");
    expect(completed).toMatchObject({ finish: "failed", reason: "the process exited with code 3" });
    const error = await session.until((event) => event.type === "error" && event.fatal === true);
    expect(error).toMatchObject({ source: "harness" });
    expect(error.message).toContain("code 3");
    const ended = await session.wait("session_ended");
    expect(ended).toMatchObject({ reason: "harness_failed", exit_code: 1 });
    expect(await waitCode(session)).toBe(1);
  });

  test("the session timer ends an idle-but-open session on time", async () => {
    const proc = fakeTurnProcess();
    const session = engineSession({
      options: { spawnTurn: async () => proc, sessionTimeoutMs: 40 },
    });
    session.user();
    setTimeout(() => proc.exit(0), 10);
    const ended = await session.wait("session_ended");
    expect(ended).toMatchObject({ reason: "timeout", exit_code: 1 });
    expect(await waitCode(session)).toBe(1);
  });

  test("a second signal escalates the late child and interrupts the open turn", async () => {
    const late = fakeTurnProcess();
    let release!: (proc: typeof late) => void;
    const session = engineSession({
      options: {
        spawnTurn: () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      },
    });
    session.user();
    try {
      // Two emitted signals: the first ends the session, the second
      // latches the escalation so the child that lands is killed, not fed.
      process.emit("SIGTERM", "SIGTERM");
      process.emit("SIGTERM", "SIGTERM");
      release(late);
      late.exit(0);
      const completed = await session.wait("turn_completed");
      expect(completed).toMatchObject({ finish: "interrupted" });
      expect(completed.reason).toContain("ended (signal) before the turn completed");
      expect(late.wrote).toEqual([]);
      const ended = await session.wait("session_ended");
      expect(ended).toMatchObject({ reason: "signal", exit_code: 143 });
      expect(await waitCode(session)).toBe(143);
    } finally {
      session.dispose();
    }
  });
});

describe("the registry record arms", () => {
  test("an unwritable registry refuses a fresh session before any turn", async () => {
    const dir = mkdtempSync(join(tmpdir(), "codemux-turn-registry-"));
    const errors = spyErrors();
    let session: ReturnType<typeof engineSession> | null = null;
    try {
      chmodSync(dir, 0o500);
      session = engineSession({
        options: { registryPath: join(dir, "live-sessions.json") },
      });
      const error = await session.until((event) => event.type === "error" && event.fatal === true);
      expect(error.message).toContain("cannot record the session in the registry");
      expect(session.events.find((event) => event.type === "session_started")).toBeUndefined();
      expect(await session.code()).toBe(1);
    } finally {
      errors.restore();
      session?.dispose();
      chmodSync(dir, 0o700);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a resumed session whose record stays busy ends cleanly on its claim", async () => {
    const dir = mkdtempSync(join(tmpdir(), "codemux-turn-registry-"));
    const registryPath = join(dir, "live-sessions.json");
    const rival = rivalLock(registryPath);
    const errors = spyErrors();
    const proc = fakeTurnProcess();
    let session: ReturnType<typeof engineSession> | null = null;
    try {
      session = engineSession({
        options: {
          registryPath,
          registryStartBudget: { attempts: 2, retryMs: 20 },
          resumeSessionId: "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d",
          spawnTurn: async () => proc,
        },
      });
      session.driver.adoptResumeClaim();
      await session.wait("session_started");
      session.user();
      proc.exit(0);
      await session.wait("turn_completed");
      const shutdownStarted = performance.now();
      session.shutdown();
      expect(performance.now() - shutdownStarted).toBeLessThan(1_000);
      const ended = await session.wait("session_ended");
      expect(ended).toMatchObject({ exit_code: 0 });
      expect(errors.noted()).toContain("claim stays the record");
      expect(errors.noted()).toContain("retrying in the background");
      expect(session.events.find((event) => event.type === "error" && event.fatal === true)).toBeUndefined();
      expect(await session.code()).toBe(0);
    } finally {
      errors.restore();
      session?.dispose();
      rmSync(rival, { force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a fresh session whose record cannot land fails closed", async () => {
    // A deferred identity records at the adopt, after the fresh-session
    // probe already passed: unwritable at the record is the fail-closed
    // arm (the busy-from-the-start case is the probe's own refusal).
    const dir = mkdtempSync(join(tmpdir(), "codemux-turn-registry-"));
    const proc = fakeTurnProcess();
    const errors = spyErrors();
    let session: ReturnType<typeof engineSession> | null = null;
    try {
      session = engineSession({
        options: {
          registryPath: join(dir, "live-sessions.json"),
          profile: wireProfile({ sessionId: "harness-mint-9" }, { identity: "deferred" }),
          spawnTurn: async () => proc,
        },
      });
      chmodSync(dir, 0o500);
      session.user();
      proc.exit(0);
      const error = await session.until((event) => event.type === "error" && event.fatal === true);
      expect(error.message).toContain("cannot record the session in the registry");
      expect(await session.code()).toBe(1);
      expect(session.events.at(-1)).toMatchObject({ type: "session_ended", exit_code: 1 });
      expect(session.events.some((event) => event.type === "assistant_message")).toBe(false);
    } finally {
      errors.restore();
      session?.dispose();
      chmodSync(dir, 0o700);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a record still pending when the session ends is the pending-record fatal", async () => {
    const dir = mkdtempSync(join(tmpdir(), "codemux-turn-registry-"));
    const registryPath = join(dir, "live-sessions.json");
    const errors = spyErrors();
    const proc = fakeTurnProcess();
    let session: ReturnType<typeof engineSession> | null = null;
    let rival: string | null = null;
    try {
      session = engineSession({
        options: {
          registryPath,
          registryStartBudget: { attempts: 20, retryMs: 500 },
          profile: wireProfile({ sessionId: "harness-mint-9" }, { identity: "deferred" }),
          spawnTurn: async () => proc,
        },
      });
      // The probe passed (the registry is writable); the rival lands
      // before the adopt's record, so the record retries while the
      // session ends before the budget does.
      rival = rivalLock(registryPath);
      session.user();
      proc.exit(0);
      await session.wait("turn_completed");
      session.shutdown();
      const error = await session.until((event) => event.type === "error" && event.fatal === true);
      expect(error.message).toContain("the lock stayed busy until the session ended");
      expect(await session.code()).toBe(1);
    } finally {
      errors.restore();
      session?.dispose();
      if (rival !== null) rmSync(rival, { force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an activity stamp that fails warns once and the session continues", async () => {
    const dir = mkdtempSync(join(tmpdir(), "codemux-turn-registry-"));
    const registryPath = join(dir, "live-sessions.json");
    const errors = spyErrors();
    const turns = [fakeTurnProcess(), fakeTurnProcess(), fakeTurnProcess()];
    let session: ReturnType<typeof engineSession> | null = null;
    try {
      let spawns = 0;
      session = engineSession({
        options: { registryPath, spawnTurn: async () => turns[spawns++]! },
      });
      session.user();
      turns[0]!.exit(0);
      await session.wait("turn_completed");
      rmSync(registryPath, { force: true });
      session.user();
      turns[1]!.exit(0);
      await session.until(
        (event) => event.type === "turn_completed" && event.turn_id === "t2"
      );
      session.user();
      turns[2]!.exit(0);
      await session.until(
        (event) => event.type === "turn_completed" && event.turn_id === "t3"
      );
      session.shutdown();
      await session.wait("session_ended");
      expect(errors.noted().match(/cannot stamp the session registry/g)).toHaveLength(1);
    } finally {
      errors.restore();
      session?.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
