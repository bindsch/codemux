/**
 * Driver e2e tests for the codex app-server session (design §4.7): the
 * real CodexSessionDriver over the scenario-driven fake app-server
 * (tests/fixtures/live/fake-codex-app-server.ts), whose wire shapes come
 * from the step-0 fixture. Every round-trip is live: the handshake, turn
 * submission and queueing, steering, interrupts, approval decisions and
 * their ceiling, usage accumulation, and the three tiers' end paths.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CodexSessionDriver,
  type CodexDriverOptions,
} from "../src/session/codex-driver.js";
import { SessionProcess } from "../src/session/process.js";

export const FAKE = fileURLToPath(new URL("./fixtures/live/fake-codex-app-server.ts", import.meta.url));

export type Event = Record<string, any>;

export interface Session {
  driver: CodexSessionDriver;
  proc: SessionProcess;
  events: Event[];
  rawLines: string[];
  code: Promise<number>;
  options: CodexDriverOptions;
  stateDir: string;
  workDir: string;
}

const cleanups: Array<() => Promise<void> | void> = [];
export async function cleanupSessions(): Promise<void> {
  while (cleanups.length > 0) await cleanups.pop()!();
}

let root: string | null = null;
export function workRoot(): string {
  if (root === null) root = mkdtempSync(join(tmpdir(), "codemux-codex-e2e-"));
  return root;
}

/** One driver over the fake app-server; `overrides` may bend any option
 * and `extraEnv` reaches the fake's environment (scenario switches). */
export async function startSession(
  overrides: Partial<CodexDriverOptions> = {},
  extraEnv: Record<string, string> = {},
  beforeAttach?: (driver: CodexSessionDriver, proc: SessionProcess) => void,
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
  const rawLines: string[] = [];
  const options: CodexDriverOptions = {
    resumeThreadId: null,
    autonomy: "high",
    cwd: workDir,
    sandboxed: true,
    sandboxTrust: "standard",
    sandboxNoNet: false,
    sandboxScrubEnv: false,
    passEnv: [],
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
  const driver = new CodexSessionDriver(options);
  const proc = new SessionProcess({
    command: ["bun", FAKE],
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
    graceMs,
  });
  // A harness line that lands before attach queues as an early line.
  beforeAttach?.(driver, proc);
  driver.attach(proc);
  const code = driver.run();
  cleanups.push(async () => {
    driver.dispose();
    proc.requestStop();
    await proc.settled;
  });
  return { driver, proc, events, rawLines, code, options, stateDir, workDir };
}

/** What the fake app-server recorded, re-read so late appends are visible. */
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

/** The fake records a decision when it reads the answer off its stdin,
 * which may land after the event that announced it; poll for it. */
export async function waitForRecord(
  session: Session,
  name: string,
  count = 1,
  timeoutMs = 8_000
): Promise<Record<string, any>[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const records = fakeRecord(session, name);
    if (records.length >= count) return records;
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${count} record(s) in ${name}; saw ${records.length}`);
    }
    await Bun.sleep(10);
  }
}

export const of = (type: string) => (events: Event[]) => events.find((event) => event.type === type);

export const send = (driver: CodexSessionDriver, message: unknown): void => {
  driver.handleCallerLine(JSON.stringify(message));
};

export async function startAndWait(
  overrides: Partial<CodexDriverOptions> = {},
  extraEnv: Record<string, string> = {},
  graceMs = 500
): Promise<Session> {
  const session = await startSession(overrides, extraEnv, undefined, graceMs);
  await waitFor(session.events, of("session_started"), "session_started");
  return session;
}

/** Refuse the harness writes `refuse` picks, the way a harness that
 * stopped reading refuses them (the backlog cap); pass the rest through. */
export function refuseWrites(proc: SessionProcess, refuse: (line: string) => boolean): void {
  const real = proc.writeLine.bind(proc);
  proc.writeLine = (line: string) => (refuse(line) ? { ok: false, reason: "backlog" } : real(line));
}
