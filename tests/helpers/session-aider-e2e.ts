/** The aider session e2e rig (split from tests/session-aider-e2e.test.ts):
 * the real AiderSessionDriver over the scenario-driven fake headless
 * aider (tests/fixtures/live/fake-aider-run.ts), whose wire shapes are
 * pinned against the installed 0.86.2 binary. The session is
 * turn-per-process with codemux-owned state — one `aider --message=<prompt>`
 * process per caller input, replaying and appending the per-session chat
 * history file. Shared by the session-aider-e2e-*.test.ts suites; each
 * of those files drains `cleanups` in its own afterAll (bun shares this
 * module across files, so a later file's afterAll re-runs the earlier
 * files' teardowns — dispose and requestStop are idempotent). */

import { expect } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AiderSessionDriver, type AiderDriverOptions } from "../../src/session/aider-driver.js";
import { aiderSessionHistoryPath } from "../../src/session/aider-session.js";
import { SessionProcess } from "../../src/session/process.js";
import { readFakeRecords } from "./fake-records.js";

const FAKE = fileURLToPath(new URL("../fixtures/live/fake-aider-run.ts", import.meta.url));

export type Event = Record<string, any>;

export interface Session {
  driver: AiderSessionDriver;
  events: Event[];
  code: Promise<number>;
  options: AiderDriverOptions;
  stateDir: string;
  historyPath: string;
  /** Lifecycle milestones from the turn children and the session's done
   * promise, in the order they happened ("spawned", "settled", "done"). */
  order: string[];
}

export const cleanups: Array<() => Promise<void> | void> = [];

let root: string | null = null;
export function workRoot(): string {
  if (root === null) root = mkdtempSync(join(tmpdir(), "codemux-aider-e2e-"));
  return root;
}

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// Positive late-spawn checks allow interpreter startup under full-suite load.
export const STARTUP_GRACE_MS = 5_000;

/** One driver whose spawnTurn spawns the fake per turn, exactly the way
 * the CLI's closure spawns one headless aider per caller input. A nonzero
 * spawnDelayMs holds the spawn in flight first — the review D5 late-child
 * window, where the end path begins while the turn's process has not
 * landed yet. A spawnGate holds it until the test opens the gate — the
 * review round 110 stalled-spawn window, where the end path gives up on
 * the child entirely. */
export async function startSession(
  overrides: Partial<AiderDriverOptions> = {},
  extraEnv: Record<string, string> = {},
  beforeRun?: (historyPath: string) => void,
  spawnDelayMs = 0,
  graceMs = 500,
  spawnGate?: Promise<unknown>
): Promise<Session> {
  const dir = mkdtempSync(join(workRoot(), "s-"));
  const workDir = join(dir, "work");
  const stateDir = join(dir, "state");
  const registryDir = join(dir, "registry");
  mkdirSync(workDir);
  mkdirSync(stateDir);
  mkdirSync(registryDir, { mode: 0o700 });
  const harnessHome = join(dir, "aider-home");
  const sessionId = overrides.sessionId ?? crypto.randomUUID();
  const historyPath = overrides.historyPath ?? aiderSessionHistoryPath(harnessHome, sessionId);
  const events: Event[] = [];
  const order: string[] = [];
  let driver!: AiderSessionDriver;
  const procs: SessionProcess[] = [];
  const options: AiderDriverOptions = {
    sessionId,
    resume: false,
    autonomy: "high",
    cwd: workDir,
    hermetic: false,
    sandboxed: true,
    sandboxTrust: "standard",
    sandboxNoNet: false,
    sandboxScrubEnv: false,
    passEnv: [],
    authorPrefix: true,
    sessionTimeoutMs: null,
    registryPath: join(registryDir, "live-sessions.json"),
    harnessHome,
    providerBaseUrl: null,
    historyPath,
    spawnTurn: async (argv) => {
      if (spawnDelayMs > 0) await Bun.sleep(spawnDelayMs);
      if (spawnGate !== undefined) await spawnGate;
      // The fake replaces the binary name and keeps every flag, so the
      // recorded argv is the argv the driver built.
      const proc = new SessionProcess({
        command: ["bun", FAKE, ...argv.slice(1)],
        cwd: options.cwd,
        env: {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          FAKE_STATE_DIR: stateDir,
          HOME: dir,
          ...extraEnv,
        },
        onLine: (line) => driver.handleHarnessLine(line),
        onFatal: (fatal) => driver.handleFatal(fatal),
        graceMs,
      });
      procs.push(proc);
      order.push("spawned");
      void proc.settled.then(() => order.push("settled"));
      return proc;
    },
    sink: (line) => {
      events.push(JSON.parse(line) as Event);
    },
    ...overrides,
  };
  driver = new AiderSessionDriver(options);
  // The CLI's order: the pre-spawn step (fresh history + start record),
  // any pre-run state setup, then the main wait.
  expect(driver.recordBeforeSpawn()).toBeNull();
  beforeRun?.(historyPath);
  const code = driver.run();
  void code.then(() => order.push("done"));
  cleanups.push(async () => {
    driver.dispose();
    for (const proc of procs) {
      proc.requestStop();
      await proc.settled;
    }
  });
  return { driver, events, code, options, stateDir, historyPath, order };
}

/** What the fake recorded, re-read so late appends are visible. */
export function fakeRecord(session: Session, name: string): Record<string, any>[] {
  return readFakeRecords<Record<string, any>>(join(session.stateDir, name));
}

/** Wait until the event stream satisfies `want`, or fail with what came. */
export async function waitFor<T>(
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

export const of = (type: string) => (events: Event[]) =>
  events.find((event) => event.type === type);

export const send = (driver: AiderSessionDriver, message: unknown): void => {
  driver.handleCallerLine(JSON.stringify(message));
};

/** The argv entry starting with --message=, if the turn spawned. */
export const messageArg = (session: Session, turn: number): string | undefined =>
  fakeRecord(session, "argv.jsonl")[turn]?.args.find((arg: string) =>
    arg.startsWith("--message=")
  );
