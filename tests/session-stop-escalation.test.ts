/** The second-signal escalation over the long-lived-process drivers
 * (review round 162, finding 2): claude/zai, codex, and agy share
 * src/session/stop-escalation.ts — the first signal starts the graceful
 * end, a later one SIGKILLs every child the driver still owns, and a
 * later one with no child alive only latches. Kimi carried the rule
 * alone before (rounds al30/al31/al33; tests/session-kimi-interleavings-
 * signals.test.ts). Signals reach the driver only through the gate's
 * `trigger`, never the test process. The turn-per-process drivers
 * (aider, opencode) have their own suite,
 * tests/session-turn-stop-escalation.test.ts. */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ClaudeSessionDriver } from "../src/session/driver.js";
import { CodexSessionDriver } from "../src/session/codex-driver.js";
import { AgySessionDriver } from "../src/session/agy-driver.js";
import { SessionProcess, type SessionFatal } from "../src/session/process.js";

/** A session child that traps SIGTERM and outlives it (the fake-hold-
 * then-exit fixture with a hold past every deadline): only the
 * escalation's tree SIGKILL ends it, which is exactly the window the
 * second signal exists for. */
const HOLD = fileURLToPath(new URL("./fixtures/live/fake-hold-then-exit.ts", import.meta.url));

/** The shutdown grace every child here runs with: long enough that a
 * regression to the graceful stop alone cannot end the session inside
 * the test's window — only the escalation can. */
const LONG_GRACE_MS = 30_000;

type Event = Record<string, any>;

const cleanups: Array<() => Promise<void> | void> = [];

afterAll(async () => {
  for (const clean of cleanups.reverse()) await clean();
});

/** One HOLD child: `onFatal` reaches the driver under test, the READY
 * line reaches nobody (a non-JSON line would be a tier-3 fatal for every
 * parser here) — it only resolves `ready`, and the test attaches
 * exclusively after it, so the child can already survive SIGTERM. */
function holdChild(
  cwd: string,
  home: string,
  onFatal: (fatal: SessionFatal) => void,
  ready: () => void
): SessionProcess {
  return new SessionProcess({
    command: ["bun", HOLD],
    cwd,
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: home,
      FAKE_HOLD_MS: "60000",
    },
    onLine: (line) => {
      if (line === "READY") ready();
    },
    onFatal,
    graceMs: LONG_GRACE_MS,
  });
}

/** Deliver one signal the way a real one arrives, through the gate. */
const trigger = (driver: object): void =>
  (driver as unknown as { signals: { trigger(signal: NodeJS.Signals): void } })
    .signals.trigger("SIGTERM");

/** The private `done` promise every driver resolves at its end. */
const done = (driver: object): Promise<number> =>
  (driver as unknown as { done: Promise<number> }).done;

/** Wait until the event stream satisfies `want`, or fail with what came. */
async function waitFor<T>(
  events: Event[],
  want: (events: Event[]) => T | undefined,
  label: string,
  timeoutMs = 8_000
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = want(events);
    if (found !== undefined) return found;
    if (Date.now() > deadline) {
      throw new Error(
        `timed out waiting for ${label}; saw: ${events.map((event) => event.type).join(",")}`
      );
    }
    await Bun.sleep(10);
  }
}

const of = (type: string) => (events: Event[]) =>
  events.find((event) => event.type === type);

/** One scratch directory tree per test: work, registry, home. */
function scratch(): { work: string; registry: string; home: string; registryPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "codemux-escalation-"));
  const work = join(dir, "work");
  const registry = join(dir, "registry");
  mkdirSync(work);
  mkdirSync(registry, { mode: 0o700 });
  return { work, registry, home: dir, registryPath: join(registry, "live-sessions.json") };
}

describe("second-signal escalation - long-lived-process drivers (review round 162)", () => {
  test("claude: the second signal ends the session at once with the child's tree killed", async () => {
    const { work, home, registryPath } = scratch();
    const events: Event[] = [];
    const driver = new ClaudeSessionDriver({
      agent: "claude",
      sessionId: crypto.randomUUID(),
      autonomy: "high",
      cwd: work,
      sandboxed: false,
      sandboxTrust: "standard",
      sandboxNoNet: false,
      sandboxScrubEnv: false,
      passEnv: [],
      playwrightMcp: false,
      authorPrefix: true,
      permissionTimeoutMs: 300_000,
      turnTimeoutMs: null,
      sessionTimeoutMs: null,
      registryPath,
      harnessHome: join(home, "home"),
      providerBaseUrl: null,
      sink: (line) => {
        events.push(JSON.parse(line) as Event);
      },
    });
    let childReady: () => void = () => {};
    const ready = new Promise<void>((resolve) => {
      childReady = resolve;
    });
    const proc = holdChild(work, home, (fatal) => driver.handleFatal(fatal), childReady);
    cleanups.push(async () => {
      driver.dispose();
      proc.requestStop();
      await proc.settled;
    });
    await ready;
    driver.attach(proc);
    const code = driver.run();
    // First signal: the graceful end begins, and the child — a SIGTERM
    // it traps — keeps the drain's settle window open.
    trigger(driver);
    await Bun.sleep(50);
    // Second signal: the tree SIGKILL, not the 30 s graceful stop. A
    // regression absorbs it and the session ends only at the grace.
    const startedAt = Date.now();
    trigger(driver);
    const ended = await waitFor(events, of("session_ended"), "session_ended");
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expect(events.filter((event) => event.type === "session_ended")).toHaveLength(1);
    expect(ended.reason).toBe("harness_failed");
    expect(ended.exit_code).toBe(143);
    expect(await code).toBe(143);
    expect((await proc.exited).signal).toBe("SIGKILL");
  }, 15_000);

  test("claude: a second signal with no child alive is a no-op", async () => {
    const { work, home, registryPath } = scratch();
    const events: Event[] = [];
    const driver = new ClaudeSessionDriver({
      agent: "claude",
      sessionId: crypto.randomUUID(),
      autonomy: "high",
      cwd: work,
      sandboxed: false,
      sandboxTrust: "standard",
      sandboxNoNet: false,
      sandboxScrubEnv: false,
      passEnv: [],
      playwrightMcp: false,
      authorPrefix: true,
      permissionTimeoutMs: 300_000,
      turnTimeoutMs: null,
      sessionTimeoutMs: null,
      registryPath,
      harnessHome: join(home, "home"),
      providerBaseUrl: null,
      sink: (line) => {
        events.push(JSON.parse(line) as Event);
      },
    });
    cleanups.push(() => driver.dispose());
    // The CLI's pre-spawn window: the driver exists, no child does. The
    // first signal starts the end (it holds on the pending spawn); the
    // second has nothing to kill and must only latch — no throw, no
    // second end, and the abandoned spawn still completes the one end.
    driver.spawnPending();
    trigger(driver);
    trigger(driver);
    driver.spawnAbandoned();
    expect(await done(driver)).toBe(143);
    expect(events.filter((event) => event.type === "session_ended")).toHaveLength(1);
    expect((events[events.length - 1] as Event).reason).toBe("signal");
  }, 15_000);

  test("codex: the second signal ends the session at once with the child's tree killed", async () => {
    const { work, home, registryPath } = scratch();
    const events: Event[] = [];
    const driver = new CodexSessionDriver({
      resumeThreadId: null,
      autonomy: "high",
      cwd: work,
      sandboxed: true,
      sandboxTrust: "standard",
      sandboxNoNet: false,
      sandboxScrubEnv: false,
      passEnv: [],
      authorPrefix: true,
      permissionTimeoutMs: 300_000,
      turnTimeoutMs: null,
      sessionTimeoutMs: null,
      registryPath,
      harnessHome: join(home, "home"),
      providerBaseUrl: null,
      sink: (line) => {
        events.push(JSON.parse(line) as Event);
      },
    });
    let childReady: () => void = () => {};
    const ready = new Promise<void>((resolve) => {
      childReady = resolve;
    });
    const proc = holdChild(work, home, (fatal) => driver.handleFatal(fatal), childReady);
    cleanups.push(async () => {
      driver.dispose();
      proc.requestStop();
      await proc.settled;
    });
    await ready;
    driver.attach(proc);
    const code = driver.run();
    trigger(driver);
    await Bun.sleep(50);
    const startedAt = Date.now();
    trigger(driver);
    const ended = await waitFor(events, of("session_ended"), "session_ended");
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expect(events.filter((event) => event.type === "session_ended")).toHaveLength(1);
    expect(ended.reason).toBe("harness_failed");
    expect(ended.exit_code).toBe(143);
    expect(await code).toBe(143);
    expect((await proc.exited).signal).toBe("SIGKILL");
  }, 15_000);

  test("codex: a second signal with no child alive is a no-op", async () => {
    const { work, home, registryPath } = scratch();
    const events: Event[] = [];
    const driver = new CodexSessionDriver({
      resumeThreadId: null,
      autonomy: "high",
      cwd: work,
      sandboxed: true,
      sandboxTrust: "standard",
      sandboxNoNet: false,
      sandboxScrubEnv: false,
      passEnv: [],
      authorPrefix: true,
      permissionTimeoutMs: 300_000,
      turnTimeoutMs: null,
      sessionTimeoutMs: null,
      registryPath,
      harnessHome: join(home, "home"),
      providerBaseUrl: null,
      sink: (line) => {
        events.push(JSON.parse(line) as Event);
      },
    });
    cleanups.push(() => driver.dispose());
    driver.spawnPending();
    trigger(driver);
    trigger(driver);
    driver.spawnAbandoned();
    expect(await done(driver)).toBe(143);
    expect(events.filter((event) => event.type === "session_ended")).toHaveLength(1);
    expect((events[events.length - 1] as Event).reason).toBe("signal");
  }, 15_000);

  test("agy: the second signal ends the session at once with the child's tree killed", async () => {
    const { work, home, registryPath } = scratch();
    const events: Event[] = [];
    const driver = new AgySessionDriver({
      resumeConversationId: null,
      autonomy: "high",
      cwd: work,
      sandboxed: true,
      sandboxTrust: "standard",
      sandboxNoNet: false,
      sandboxScrubEnv: false,
      passEnv: [],
      authorPrefix: true,
      sessionTimeoutMs: null,
      registryPath,
      harnessHome: join(home, "home"),
      providerBaseUrl: null,
      sink: (line) => {
        events.push(JSON.parse(line) as Event);
      },
    });
    let childReady: () => void = () => {};
    const ready = new Promise<void>((resolve) => {
      childReady = resolve;
    });
    const proc = holdChild(work, home, (fatal) => driver.handleFatal(fatal), childReady);
    cleanups.push(async () => {
      driver.dispose();
      proc.requestStop();
      await proc.settled;
    });
    await ready;
    driver.attach(proc);
    const code = driver.run();
    trigger(driver);
    await Bun.sleep(50);
    const startedAt = Date.now();
    trigger(driver);
    const ended = await waitFor(events, of("session_ended"), "session_ended");
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expect(events.filter((event) => event.type === "session_ended")).toHaveLength(1);
    expect(ended.reason).toBe("harness_failed");
    expect(ended.exit_code).toBe(143);
    expect(await code).toBe(143);
    expect((await proc.exited).signal).toBe("SIGKILL");
  }, 15_000);

  test("agy: a second signal with no child alive is a no-op", async () => {
    const { work, home, registryPath } = scratch();
    const events: Event[] = [];
    const driver = new AgySessionDriver({
      resumeConversationId: null,
      autonomy: "high",
      cwd: work,
      sandboxed: true,
      sandboxTrust: "standard",
      sandboxNoNet: false,
      sandboxScrubEnv: false,
      passEnv: [],
      authorPrefix: true,
      sessionTimeoutMs: null,
      registryPath,
      harnessHome: join(home, "home"),
      providerBaseUrl: null,
      sink: (line) => {
        events.push(JSON.parse(line) as Event);
      },
    });
    cleanups.push(() => driver.dispose());
    driver.spawnPending();
    trigger(driver);
    trigger(driver);
    driver.spawnAbandoned();
    expect(await done(driver)).toBe(143);
    expect(events.filter((event) => event.type === "session_ended")).toHaveLength(1);
    expect((events[events.length - 1] as Event).reason).toBe("signal");
  }, 15_000);
});
