/** The second-signal escalation reaches a child that did not exist when
 * the signal arrived (review round 162, finding 2): the long-lived-
 * process drivers (claude/zai, codex, agy) latch the request, and the
 * path that adopts the child kills its tree on arrival. Two adoption
 * paths exist. An end that began while the spawn was pending waits for
 * the child and adopts it in `finish`. An end that completed with no
 * spawn pending adopts nothing, so `attach` itself stops the child.
 * Both must use the tree SIGKILL once a second signal has latched; the
 * stop with grace would keep a SIGTERM-trapping child alive for the
 * whole shutdown grace. Signals reach the driver only through the
 * gate's `trigger`, never the test process. */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ClaudeSessionDriver } from "../src/session/driver.js";
import { CodexSessionDriver } from "../src/session/codex-driver.js";
import { AgySessionDriver } from "../src/session/agy-driver.js";
import { SessionProcess, type SessionFatal } from "../src/session/process.js";

/** Traps SIGTERM and holds past every deadline here: only a SIGKILL
 * ends it inside the test's window. */
const HOLD = fileURLToPath(new URL("./fixtures/live/fake-hold-then-exit.ts", import.meta.url));
const LONG_GRACE_MS = 30_000;

type Event = Record<string, any>;

interface Driver {
  attach(proc: SessionProcess): void;
  spawnPending(): void;
  handleFatal(fatal: SessionFatal): void;
  dispose(): void;
}

const cleanups: Array<() => Promise<void> | void> = [];

afterAll(async () => {
  for (const clean of cleanups.reverse()) await clean();
});

const trigger = (driver: object): void =>
  (driver as unknown as { signals: { trigger(signal: NodeJS.Signals): void } })
    .signals.trigger("SIGTERM");

const done = (driver: object): Promise<number> =>
  (driver as unknown as { done: Promise<number> }).done;

interface Fixture {
  driver: Driver;
  events: Event[];
  /** A live HOLD child whose SIGTERM trap is already installed. */
  child(): Promise<SessionProcess>;
}

function fixture(agent: "claude" | "codex" | "agy"): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "codemux-escalation-late-"));
  const work = join(dir, "work");
  const registry = join(dir, "registry");
  mkdirSync(work);
  mkdirSync(registry, { mode: 0o700 });
  const events: Event[] = [];
  const shared = {
    autonomy: "high" as const,
    cwd: work,
    sandboxTrust: "standard" as const,
    sandboxNoNet: false,
    sandboxScrubEnv: false,
    passEnv: [],
    authorPrefix: true,
    sessionTimeoutMs: null,
    registryPath: join(registry, "live-sessions.json"),
    harnessHome: join(dir, "home"),
    providerBaseUrl: null,
    sink: (line: string) => {
      events.push(JSON.parse(line) as Event);
    },
  };
  let driver: Driver;
  if (agent === "claude") {
    driver = new ClaudeSessionDriver({
      ...shared,
      agent: "claude",
      sessionId: crypto.randomUUID(),
      sandboxed: false,
      playwrightMcp: false,
      permissionTimeoutMs: 300_000,
      turnTimeoutMs: null,
    });
  } else if (agent === "codex") {
    driver = new CodexSessionDriver({
      ...shared,
      resumeThreadId: null,
      sandboxed: true,
      permissionTimeoutMs: 300_000,
      turnTimeoutMs: null,
    });
  } else {
    driver = new AgySessionDriver({ ...shared, resumeConversationId: null, sandboxed: true });
  }
  cleanups.push(() => driver.dispose());
  const child = async (): Promise<SessionProcess> => {
    let childReady: () => void = () => {};
    const ready = new Promise<void>((resolve) => {
      childReady = resolve;
    });
    const proc = new SessionProcess({
      command: ["bun", HOLD],
      cwd: work,
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: dir, FAKE_HOLD_MS: "60000" },
      // READY is not JSON, so it reaches no parser; it only says the
      // SIGTERM trap is installed.
      onLine: (line) => {
        if (line === "READY") childReady();
      },
      onFatal: (fatal) => driver.handleFatal(fatal),
      graceMs: LONG_GRACE_MS,
    });
    cleanups.push(async () => {
      proc.requestStop();
      await proc.settled;
    });
    await ready;
    return proc;
  };
  return { driver, events, child };
}

/** The child's exit, or "alive" when it outlives the bound. */
async function exitWithin(proc: SessionProcess, ms: number): Promise<string> {
  const outcome = await Promise.race([
    proc.exited,
    Bun.sleep(ms).then(() => null),
  ]);
  return outcome === null ? "alive" : String(outcome.signal ?? outcome.code);
}

describe("second-signal escalation - a child that arrives after the signal (review round 162)", () => {
  for (const agent of ["claude", "codex", "agy"] as const) {
    test(`${agent}: a child adopted by a waiting end is killed on arrival`, async () => {
      const { driver, events, child } = fixture(agent);
      const proc = await child();
      // The CLI's pre-spawn window: the first signal starts an end that
      // waits for the pending spawn, the second latches with no child.
      driver.spawnPending();
      trigger(driver);
      trigger(driver);
      const startedAt = Date.now();
      driver.attach(proc);
      expect(await exitWithin(proc, 5_000)).toBe("SIGKILL");
      expect(await done(driver)).toBe(143);
      expect(Date.now() - startedAt).toBeLessThan(5_000);
      expect(events.filter((event) => event.type === "session_ended")).toHaveLength(1);
    }, 15_000);

    test(`${agent}: a child attached after a completed end is killed on arrival`, async () => {
      const { driver, events, child } = fixture(agent);
      const proc = await child();
      // No spawn pending: the first signal's end completes with no child,
      // and nothing waits for one. The second signal latches.
      trigger(driver);
      expect(await done(driver)).toBe(143);
      trigger(driver);
      driver.attach(proc);
      expect(await exitWithin(proc, 5_000)).toBe("SIGKILL");
      expect(events.filter((event) => event.type === "session_ended")).toHaveLength(1);
    }, 15_000);

    test(`${agent}: with one signal only, a late child keeps the graceful stop`, async () => {
      const { driver, child } = fixture(agent);
      const proc = await child();
      trigger(driver);
      expect(await done(driver)).toBe(143);
      driver.attach(proc);
      // The SIGTERM-trapping child survives the stop with grace: no
      // SIGKILL arrives before the 30 s grace, far past this window.
      expect(await exitWithin(proc, 600)).toBe("alive");
      proc.escalateStop();
      expect(await exitWithin(proc, 5_000)).toBe("SIGKILL");
    }, 15_000);
  }
});
