/** The opencode session e2e rig (split from
 * tests/session-opencode-e2e.test.ts): the real OpenCodeSessionDriver
 * over the scenario-driven fake `opencode run --format json`
 * (tests/fixtures/live/fake-opencode-run.ts), whose wire shapes are
 * pinned against the installed 1.18.18 binary. The session is
 * turn-per-process — the driver's spawnTurn closure spawns one fake per
 * caller input. Shared by the session-opencode-e2e-*.test.ts suites;
 * each of those files drains `cleanups` in its own afterAll (bun shares
 * this module across files, so a later file's afterAll re-runs the
 * earlier files' teardowns — dispose and requestStop are idempotent). */

import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  OpenCodeSessionDriver,
  type OpenCodeDriverOptions,
} from "../../src/session/opencode-driver.js";
import { SessionProcess } from "../../src/session/process.js";

const FAKE = fileURLToPath(
  new URL("../fixtures/live/fake-opencode-run.ts", import.meta.url)
);

export type Event = Record<string, any>;

export interface Session {
  driver: OpenCodeSessionDriver;
  events: Event[];
  code: Promise<number>;
  options: OpenCodeDriverOptions;
  stateDir: string;
  workDir: string;
  /** Lifecycle milestones from the turn children and the session's done
   * promise, in the order they happened ("spawned", "settled", "done"). */
  order: string[];
}

export const cleanups: Array<() => Promise<void> | void> = [];

let root: string | null = null;
export function workRoot(): string {
  if (root === null) root = mkdtempSync(join(tmpdir(), "codemux-opencode-e2e-"));
  return root;
}

/** One driver whose spawnTurn spawns the fake per turn, exactly the way
 * the CLI's closure spawns one `opencode run` per caller input. A nonzero
 * spawnDelayMs holds the spawn in flight first — the review D5 late-child
 * window, where the end path begins while the turn's process has not
 * landed yet. A spawnGate holds it until the test opens the gate — the
 * review round 110 stalled-spawn window, where the end path gives up on
 * the child entirely. */
export async function startSession(
  overrides: Partial<OpenCodeDriverOptions> = {},
  extraEnv: Record<string, string> = {},
  spawnDelayMs = 0,
  spawnGate?: Promise<unknown>
): Promise<Session> {
  const dir = mkdtempSync(join(workRoot(), "s-"));
  const workDir = join(dir, "work");
  const stateDir = join(dir, "state");
  const registryDir = join(dir, "registry");
  mkdirSync(workDir);
  mkdirSync(stateDir);
  mkdirSync(registryDir, { mode: 0o700 });
  const events: Event[] = [];
  const order: string[] = [];
  let driver!: OpenCodeSessionDriver;
  const procs: SessionProcess[] = [];
  const options: OpenCodeDriverOptions = {
    resumeSessionId: null,
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
    harnessHome: join(dir, "home"),
    providerBaseUrl: null,
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
        graceMs: 500,
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
  driver = new OpenCodeSessionDriver(options);
  const code = driver.run();
  void code.then(() => order.push("done"));
  cleanups.push(async () => {
    driver.dispose();
    for (const proc of procs) {
      proc.requestStop();
      await proc.settled;
    }
  });
  return { driver, events, code, options, stateDir, workDir, order };
}

/** What the fake recorded, re-read so late appends are visible. */
export function fakeRecord(session: Session, name: string): Record<string, any>[] {
  const path = join(session.stateDir, name);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Record<string, any>);
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

export const send = (driver: OpenCodeSessionDriver, message: unknown): void => {
  driver.handleCallerLine(JSON.stringify(message));
};
