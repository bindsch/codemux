/** The agy session e2e rig (split from tests/session-agy-e2e.test.ts):
 * the real AgySessionDriver over the scenario-driven fake agy
 * (tests/fixtures/live/fake-agy-session.ts), whose wire shapes come from
 * the step-0 fixture — the claude-style input frame and the `event`-keyed
 * result envelope. Shared by the session-agy-e2e-*.test.ts suites; each
 * of those files drains `cleanups` in its own afterAll (bun shares this
 * module across files, so a later file's afterAll re-runs the earlier
 * files' teardowns — dispose and requestStop are idempotent). */

import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AgySessionDriver, type AgyDriverOptions } from "../../src/session/agy-driver.js";
import { SessionProcess } from "../../src/session/process.js";
import { readFakeRecords } from "./fake-records.js";

export const FAKE = fileURLToPath(
  new URL("../fixtures/live/fake-agy-session.ts", import.meta.url)
);

/** A session child that survives its stop request for a moment: the
 * fixture prints READY once its SIGTERM handler is installed and then
 * holds the signal FAKE_HOLD_MS (default 400) before exiting 0. */
export const HOLD = fileURLToPath(
  new URL("../fixtures/live/fake-hold-then-exit.ts", import.meta.url)
);

export type Event = Record<string, any>;

export interface Session {
  driver: AgySessionDriver;
  proc: SessionProcess;
  events: Event[];
  code: Promise<number>;
  options: AgyDriverOptions;
  stateDir: string;
  workDir: string;
}

export const cleanups: Array<() => Promise<void> | void> = [];

let root: string | null = null;
export function workRoot(): string {
  if (root === null) root = mkdtempSync(join(tmpdir(), "codemux-agy-e2e-"));
  return root;
}

/** One driver over the fake agy; `overrides` may bend any option and
 * `extraEnv` reaches the fake's environment (scenario switches). */
export async function startSession(
  overrides: Partial<AgyDriverOptions> = {},
  extraEnv: Record<string, string> = {},
  beforeAttach?: (driver: AgySessionDriver) => void,
  graceMs = 500
): Promise<Session> {
  const dir = mkdtempSync(join(workRoot(), "s-"));
  const workDir = join(dir, "work");
  const stateDir = join(dir, "state");
  const registryDir = join(dir, "registry");
  mkdirSync(workDir);
  mkdirSync(stateDir);
  mkdirSync(registryDir, { mode: 0o700 });
  const events: Event[] = [];
  const options: AgyDriverOptions = {
    resumeConversationId: null,
    autonomy: "high",
    cwd: workDir,
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
    sink: (line) => {
      events.push(JSON.parse(line) as Event);
    },
    ...overrides,
  };
  // The fake reads the conversation it must name from its argv, exactly
  // the way the real binary reads `--conversation`.
  const command = ["bun", FAKE];
  if (options.resumeConversationId !== null) {
    command.push(`--conversation=${options.resumeConversationId}`);
  }
  const driver = new AgySessionDriver(options);
  const proc = new SessionProcess({
    command,
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
  // A harness line that lands before attach queues as an early line.
  beforeAttach?.(driver);
  driver.attach(proc);
  const code = driver.run();
  cleanups.push(async () => {
    driver.dispose();
    proc.requestStop();
    await proc.settled;
  });
  return { driver, proc, events, code, options, stateDir, workDir };
}

/** What the fake agy recorded, re-read so late appends are visible. */
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

export const send = (driver: AgySessionDriver, message: unknown): void => {
  driver.handleCallerLine(JSON.stringify(message));
};
