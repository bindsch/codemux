/**
 * The --final late-attach hold (review round 18, edges 1): a signal that
 * lands while the CLI's spawn is still in its preflight starts the end
 * path with no child to stop. The end path must hold at the late-child
 * wait until the child the spawn produces is terminated and settled, and
 * only then run the --final removal and the end stamp — never remove the
 * private directory under a child that could still read or recreate it.
 */

import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as processTable from "../src/process-table.js";
import { ClaudeSessionDriver } from "../src/session/driver.js";
import { SessionProcess } from "../src/session/process.js";
import { claudeRecord, seedRegistry } from "./helpers/session-command.js";
import { registerNoLeakedSignals } from "./helpers/signal-listeners.js";

const FAKE = fileURLToPath(new URL("./fixtures/live/fake-claude-session.ts", import.meta.url));

registerNoLeakedSignals();

let readProcessTable: ReturnType<typeof spyOn>;
beforeEach(() => {
  readProcessTable = spyOn(processTable, "readProcessTable").mockReturnValue(new Map());
});
afterEach(() => readProcessTable.mockRestore());

/** The CLI's spawn shape: spawnPending, then the async preflight, then the
 * child. handleCallerEnd is the deterministic stand-in for the signal that
 * fires during the preflight (review live4 used the same seam). */
async function spawnAfterPreflight(
  driver: ClaudeSessionDriver,
  dir: string,
  stateDir: string
): Promise<SessionProcess> {
  driver.spawnPending();
  // The preflight the signal interrupts: the real spawn's scode
  // compatibility probe is async, so the end path begins while the child
  // does not exist yet.
  await Bun.sleep(20);
  return new SessionProcess({
    command: ["bun", FAKE, "-p", "--verbose", "--session-id", "unused"],
    cwd: dir,
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      FAKE_STATE_DIR: stateDir,
      FAKE_CWD: dir,
      HOME: dir,
    },
    onLine: (line) => driver.handleHarnessLine(line),
    onFatal: (fatal) => driver.handleFatal(fatal),
    graceMs: 500,
  });
}

test("a --final end during the spawn preflight removes the directory only after the child settles (round 18, edges 1)", async () => {
  const root = mkdtempSync(join(tmpdir(), "codemux-final-late-"));
  const dir = join(root, "work");
  const stateDir = join(root, "state");
  const registryDir = join(root, "registry");
  const finalDir = join(root, "private-session-dir");
  mkdirSync(dir);
  mkdirSync(stateDir);
  mkdirSync(registryDir, { mode: 0o700 });
  mkdirSync(finalDir, { mode: 0o700 });
  writeFileSync(join(finalDir, "transcript.jsonl"), "{}\n", { mode: 0o600 });
  const registryPath = join(registryDir, "live-sessions.json");
  const sessionId = crypto.randomUUID();
  // A resumed --final session is the arm whose end path owns the removal:
  // the claim makes the record this process's, so the end stamps it final
  // once the directory is gone (a fresh record the harness never confirmed
  // is discarded instead, and the CLI's finally removes that directory).
  seedRegistry(registryPath, [claudeRecord(sessionId, dir, {
    hermetic: true,
    project_settings: true,
    harness_home: finalDir,
  })]);
  // Whether the child had settled at each removal attempt, and how many
  // attempts ran: the regression is an attempt with settled === false.
  let childSettled = false;
  const removalSawSettled: boolean[] = [];
  const events: Record<string, unknown>[] = [];
  const driver = new ClaudeSessionDriver({
    agent: "claude",
    sessionId,
    autonomy: "low",
    cwd: dir,
    sandboxed: true,
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
    harnessHome: join(root, "home"),
    providerBaseUrl: null,
    hermetic: true,
    projectSettings: true,
    final: true,
    removeFinalProjectDir: () => {
      removalSawSettled.push(childSettled);
      rmSync(finalDir, { recursive: true, force: true });
      return true;
    },
    sink: (line) => {
      events.push(JSON.parse(line) as Record<string, unknown>);
    },
  });
  try {
    // The resume claim the CLI adopts before the spawn: it makes the end
    // path own the record and run the --final removal.
    driver.adoptResumeClaim();
    const spawn = spawnAfterPreflight(driver, dir, stateDir);
    // The signal during the preflight: the end path begins with no child.
    driver.handleCallerEnd();
    const proc = await spawn;
    void proc.settled.then(() => {
      childSettled = true;
    });
    driver.attach(proc);
    // run() resolves only after the end path completes: the late child
    // settled, the removal ran, the record was stamped.
    expect(await driver.run()).toBe(1);
    await proc.settled;
    expect(childSettled).toBe(true);
    // One removal sequence, started after the child settled — the defect
    // was a removal with settled === false, ahead of the late child.
    expect(removalSawSettled).toEqual([true]);
    expect(driver.finalRemovalRan).toBe(true);
    expect(existsSync(finalDir)).toBe(false);
    // The record stamped final once, and the end event promised no resume.
    const record = JSON.parse(readFileSync(registryPath, "utf8")) as {
      sessions: Array<{ final?: boolean; ended?: string | null }>;
    };
    expect(record.sessions).toHaveLength(1);
    expect(record.sessions[0]?.final).toBe(true);
    expect(record.sessions[0]?.ended).toBeTruthy();
    const ended = events.at(-1);
    expect(ended?.type).toBe("session_ended");
    expect(ended?.resumable).toBe(false);
  } finally {
    driver.dispose();
    rmSync(root, { recursive: true, force: true });
  }
}, 20_000);

test("a resumed --final spawn that throws during the held end preserves the transcript byte-for-byte", async () => {
  const root = mkdtempSync(join(tmpdir(), "codemux-final-late-abandon-"));
  const dir = join(root, "work");
  const registryDir = join(root, "registry");
  const finalDir = join(root, "private-session-dir");
  mkdirSync(dir);
  mkdirSync(registryDir, { mode: 0o700 });
  mkdirSync(finalDir, { mode: 0o700 });
  writeFileSync(join(finalDir, "transcript.jsonl"), '{"event":"prior turn"}\n', { mode: 0o600 });
  const snapshot = (): string => readdirSync(finalDir).sort().map((name) => {
    const path = join(finalDir, name);
    return `${name} ${statSync(path).mode} ${readFileSync(path).toString("hex")}`;
  }).join("\n");
  const before = snapshot();
  const registryPath = join(registryDir, "live-sessions.json");
  const sessionId = crypto.randomUUID();
  seedRegistry(registryPath, [claudeRecord(sessionId, dir, {
    hermetic: true,
    project_settings: true,
    harness_home: finalDir,
  })]);
  let removals = 0;
  const events: Record<string, unknown>[] = [];
  const driver = new ClaudeSessionDriver({
    agent: "claude",
    sessionId,
    autonomy: "low",
    cwd: dir,
    sandboxed: true,
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
    harnessHome: join(root, "home"),
    providerBaseUrl: null,
    hermetic: true,
    projectSettings: true,
    final: true,
    removeFinalProjectDir: () => {
      removals += 1;
      rmSync(finalDir, { recursive: true, force: true });
      return true;
    },
    sink: (line) => {
      events.push(JSON.parse(line) as Record<string, unknown>);
    },
  });
  const done = (driver as unknown as { done: Promise<number> }).done;
  try {
    driver.adoptResumeClaim();
    driver.spawnPending();
    // The signal during the preflight starts the held end path...
    driver.handleCallerEnd();
    // ...and the spawn then throws: the CLI's catch must release the wait
    // (spawnAbandoned) or the command never exits.
    driver.spawnAbandoned();
    // No hang: the end path completes without a child.
    expect(await Promise.race([done, Bun.sleep(5_000).then(() => null)])).not.toBeNull();
    expect(existsSync(finalDir)).toBe(true);
    expect(snapshot()).toBe(before);
    expect(removals).toBe(0);
    expect(driver.finalRemovalRan).toBe(false);
    const record = JSON.parse(readFileSync(registryPath, "utf8")) as {
      sessions: Array<{ final?: boolean; ended?: string | null }>;
    };
    expect(record.sessions).toHaveLength(1);
    expect(record.sessions[0]?.final).toBeFalsy();
    expect(record.sessions[0]?.ended).toBeTruthy();
    expect(events.at(-1)?.type).toBe("session_ended");
    expect(events.at(-1)?.resumable).toBe(true);
  } finally {
    driver.dispose();
    rmSync(root, { recursive: true, force: true });
  }
}, 20_000);
