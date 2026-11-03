import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync } from "node:fs";
import { acquireLock, resolveRegistryPath } from "../src/session/registry-io.js";
import { lookupForResume, readRegistry } from "../src/session/registry.js";
import type { AutonomyLevel } from "../src/types.js";
import { cleanups, of, send, startSession, waitFor, type Event } from "./helpers/session-e2e.js";

afterAll(async () => {
  for (const clean of cleanups.reverse()) await clean();
});

describe("claude session driver e2e", () => {
  test("the registry guards resume: live owner, autonomy reach, agent match", async () => {
    const session = await startSession({ autonomy: "read-only" });
    send(session.driver, { type: "user", text: "scenario:basic warm" });
    const started = await waitFor(session.events, of("session_started"), "session_started");
    const probe = {
      agent: "claude",
      harnessHome: session.options.harnessHome,
      autonomy: "read-only" as AutonomyLevel,
      sandboxed: false,
      sandboxTrust: "standard" as const,
      sandboxNoNet: false,
      sandboxScrubEnv: false,
      sandboxBlock: [],
      cwd: session.options.cwd,
      passEnv: [],
      playwrightMcp: false,
      providerBaseUrl: null,
      hermetic: false,
      projectSettings: false,
    };
    // Live owner: this test process owns the session, recorded unended.
    // Its own pid is never a rival owner (review live25, the
    // recordSessionStart rule), so the busy refusal for a foreign live
    // owner is pinned in tests/session-registry-recording.test.ts.
    const live = readRegistry(session.options.registryPath as string);
    expect(live.outcome).toBe("ok");
    if (live.outcome === "ok") {
      const entry = live.file.sessions.find((candidate) => candidate.id === started.session_id);
      expect(entry?.owner_pid).toBe(process.pid);
      expect(entry?.ended).toBeNull();
    }

    send(session.driver, { type: "shutdown" });
    await waitFor(session.events, of("session_ended"), "session_ended");
    await session.code;

    const ok = lookupForResume(session.options.registryPath as string, started.session_id, probe);
    expect(ok.outcome).toBe("ok");
    const narrowed = lookupForResume(session.options.registryPath as string, started.session_id, {
      ...probe,
      autonomy: "low",
    });
    expect(narrowed.outcome).toBe("refused");
    if (narrowed.outcome === "refused") expect(narrowed.reason).toContain("autonomy");
    const crossAgent = lookupForResume(session.options.registryPath as string, started.session_id, {
      ...probe,
      agent: "zai",
    });
    expect(crossAgent.outcome).toBe("refused");
  });

  test("the turn-path registry stamp never waits behind another writer, and says so once (review live13)", async () => {
    const session = await startSession();
    send(session.driver, { type: "user", text: "scenario:basic hello" });
    await waitFor(session.events, of("turn_completed"), "turn_completed");
    // Hold the writer lock the way a concurrent codemux registry write
    // would: this (live) process's own held file.
    const lockPath = `${resolveRegistryPath(session.options.registryPath as string)}.lock`;
    const handle = acquireLock(lockPath, { attempts: 1 });
    const lines: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    };
    try {
      const began = Date.now();
      send(session.driver, { type: "user", text: "scenario:basic again" });
      const second = await waitFor(
        session.events,
        (events) => events.filter((event) => event.type === "turn_completed")[1],
        "second turn_completed under a held registry lock"
      );
      expect(second.finish).toBe("end");
      // Pre-fix, this one turn's stamp waited out the lock's full budget
      // (~10 s of synchronous Atomics.wait with the event loop — stdout
      // reads, caller events, signal handlers — frozen) before failing.
      expect(Date.now() - began).toBeLessThan(5_000);
    } finally {
      console.error = original;
      handle.release();
    }
    // The failed stamp is reported, once for the session, not per turn.
    const stamps = lines.filter((line) => line.includes("cannot stamp the session registry"));
    expect(stamps).toHaveLength(1);
    expect(stamps[0]).toContain(session.options.sessionId);
    expect(lines.filter((line) => line.includes("cannot stamp the session end"))).toHaveLength(0);
    // The end stamp keeps the full lock budget, and the lock is free
    // again: the session ends clean and the registry stays readable.
    send(session.driver, { type: "shutdown" });
    const ended = await waitFor(session.events, of("session_ended"), "session_ended");
    expect(ended.resumable).toBe(true);
    expect(await session.code).toBe(0);
    expect(readRegistry(session.options.registryPath as string).outcome).toBe("ok");
  });

  test("a lost end stamp reports on stderr instead of vanishing (review live13)", async () => {
    const session = await startSession();
    send(session.driver, { type: "user", text: "scenario:basic hello" });
    await waitFor(session.events, of("turn_completed"), "turn_completed");
    // Break the registry so the end stamp must fail: a mode other than
    // 0600 makes every read untrusted (the fail-closed placement check).
    chmodSync(session.options.registryPath as string, 0o644);
    const lines: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    };
    try {
      send(session.driver, { type: "shutdown" });
      const ended = await waitFor(session.events, of("session_ended"), "session_ended");
      expect(ended.reason).toBe("shutdown");
      expect(await session.code).toBe(0);
    } finally {
      console.error = original;
    }
    // The stamp's loss is the one consequence the caller cannot see in
    // the event stream (a later resume may answer session_busy because
    // the record still names a live owner), so it rides stderr — the
    // pre-fix code swallowed the outcome and said nothing.
    const stamps = lines.filter((line) => line.includes("cannot stamp the session end"));
    expect(stamps).toHaveLength(1);
    expect(stamps[0]).toContain(session.options.sessionId);
    expect(stamps[0]).toContain("session_busy");
  });

  test("a claimed resume that times out before its init frame is not resumable (review live21)", async () => {
    // The lifecycle sibling of correctness minor 1: a resume the harness
    // never confirmed is resumable only when its end did not fail. A
    // harness that hangs before init until --session-timeout ends with
    // exit 1 and proves nothing about the transcript.
    const session = await startSession({ sessionTimeoutMs: 200 });
    session.driver.adoptResumeClaim();
    expect(await session.code).toBe(1);
    const ended = session.events.at(-1) as Event;
    expect(ended.type).toBe("session_ended");
    expect(ended.reason).toBe("timeout");
    expect(ended.resumable).toBe(false);
  });
});
