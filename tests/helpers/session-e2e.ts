import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ClaudeSessionDriver, type SessionDriverOptions } from "../../src/session/driver.js";
import { SessionProcess } from "../../src/session/process.js";
import { readFakeRecords } from "./fake-records.js";

export const FAKE = fileURLToPath(new URL("../fixtures/live/fake-claude-session.ts", import.meta.url));

export type Event = Record<string, any>;

export interface Session {
  driver: ClaudeSessionDriver;
  proc: SessionProcess;
  events: Event[];
  rawLines: string[];
  code: Promise<number>;
  options: SessionDriverOptions;
  stateDir: string;
}

/** Every session's teardown; each test file's afterAll drains this list. */
export const cleanups: Array<() => Promise<void> | void> = [];

let root: string | null = null;
export function workRoot(): string {
  if (root === null) root = mkdtempSync(join(tmpdir(), "codemux-session-e2e-"));
  return root;
}

/** One driver over the fake harness; `overrides` may bend any option and
 * `extraEnv` reaches the fake's environment (scenario switches). */
export async function startSession(
  overrides: Partial<SessionDriverOptions> = {},
  extraEnv: Record<string, string> = {},
  harnessArgs?: string[]
): Promise<Session> {
  const dir = mkdtempSync(join(workRoot(), "s-"));
  const workDir = join(dir, "work");
  const stateDir = join(dir, "state");
  const registryDir = join(dir, "registry");
  mkdirSync(workDir);
  mkdirSync(stateDir);
  mkdirSync(registryDir, { mode: 0o700 });
  const sessionId = crypto.randomUUID();
  const events: Event[] = [];
  const rawLines: string[] = [];
  const options: SessionDriverOptions = {
    agent: "claude",
    sessionId,
    autonomy: "high",
    cwd: workDir,
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
    registryPath: join(registryDir, "live-sessions.json"),
    harnessHome: join(dir, "home"),
    providerBaseUrl: null,
    sink: (line) => {
      rawLines.push(line);
      events.push(JSON.parse(line) as Event);
    },
    ...overrides,
  };
  const driver = new ClaudeSessionDriver(options);
  // Spawn the fake the way the real builder spawns the harness: the
  // session-id flag is what the driver's grammar check expects it to echo.
  const proc = new SessionProcess({
    command: ["bun", FAKE, ...(harnessArgs ?? ["-p", "--verbose", "--session-id", options.sessionId])],
    cwd: options.cwd,
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      FAKE_STATE_DIR: stateDir,
      FAKE_CWD: options.cwd,
      HOME: dir,
      ...extraEnv,
    },
    onLine: (line) => driver.handleHarnessLine(line),
    onFatal: (fatal) => driver.handleFatal(fatal),
    graceMs: 500,
  });
  driver.attach(proc);
  const code = driver.run();
  cleanups.push(async () => {
    driver.dispose();
    proc.requestStop();
    await proc.settled;
  });
  return { driver, proc, events, rawLines, code, options, stateDir };
}

/** What the fake harness recorded, re-read so late appends are visible. */
export function fakeRecord(session: Session, name: string): unknown[] {
  return readFakeRecords<unknown>(join(session.stateDir, name));
}

/** Wait until the fake recorded `count` entries in `name`, re-reading so
 * late appends are visible. Needed wherever the awaited event is emitted
 * by codemux (not the fake): the deny write and the permission_resolved
 * emit are one synchronous step, but the fake records the line only on
 * its own event-loop turn, so a single read races the pipe. */
export async function waitForRecord(
  session: Session,
  name: string,
  count = 1,
  timeoutMs = 8_000
): Promise<Event[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const records = fakeRecord(session, name) as Event[];
    if (records.length >= count) return records;
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${count} record(s) in ${name}; saw ${records.length}`);
    }
    await Bun.sleep(10);
  }
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

export const send = (driver: ClaudeSessionDriver, message: unknown): void => {
  driver.handleCallerLine(JSON.stringify(message));
};
