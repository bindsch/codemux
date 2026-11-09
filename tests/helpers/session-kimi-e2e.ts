/** The kimi session e2e rig (split from tests/session-kimi-e2e.test.ts):
 * the real KimiSessionDriver over the scenario-driven fake headless kimi
 * (tests/fixtures/live/fake-kimi-run.ts), whose wire shapes are pinned
 * against the installed 0.31.1 binary. The session is turn-per-process —
 * the driver's spawnTurn closure spawns one fake per caller input — so
 * every round-trip is live. Shared by the session-kimi-e2e-*.test.ts
 * suites; each of those files drains `cleanups` in its own afterAll (bun
 * shares this module across files, so a later file's afterAll re-runs the
 * earlier files' teardowns — dispose and requestStop are idempotent). */

import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  KimiSessionDriver,
  type KimiDriverOptions,
} from "../../src/session/kimi-driver.js";
import { SessionProcess } from "../../src/session/process.js";

const FAKE = fileURLToPath(new URL("../fixtures/live/fake-kimi-run.ts", import.meta.url));

/** The fake's default minted id (fixtures/live/fake-kimi-run.ts). */
export const ID = "session_11111111-2222-3333-4444-555555555555";
export const OTHER = "session_99999999-8888-7777-6666-555555555555";

export const NULL_USAGE = {
  input_tokens: null,
  output_tokens: null,
  cached_input_tokens: null,
  total_tokens: null,
  cost_usd: null,
};

export type Event = Record<string, any>;

interface Session {
  driver: KimiSessionDriver;
  events: Event[];
  code: Promise<number>;
  options: KimiDriverOptions;
  stateDir: string;
  workDir: string;
  /** Lifecycle milestones from the turn children and the session's done
   * promise, in the order they happened ("spawned", "settled", "done"). */
  order: string[];
  /** Every per-turn argv the driver built, in turn order (the fake's
   * command strips the `env` prefix, so this is the one record of it). */
  argvs: string[][];
}

export const cleanups: Array<() => Promise<void> | void> = [];

let root: string | null = null;
// Positive late-spawn checks allow interpreter startup under full-suite load.
export const STARTUP_GRACE_MS = 5_000;
export function workRoot(): string {
  if (root === null) root = mkdtempSync(join(tmpdir(), "codemux-kimi-e2e-"));
  return root;
}

/** One driver whose spawnTurn spawns the fake per turn, exactly the way
 * the CLI's closure spawns one headless `kimi` per caller input. A
 * nonzero spawnDelayMs holds the spawn in flight first — the review D5
 * late-child window, where the end path begins while the turn's process
 * has not landed yet — from turn `delayFromTurn` on (default 1: every
 * turn; 2 leaves the first turn prompt so a record exists before the
 * hold opens, round al27). */
export async function startSession(
  overrides: Partial<KimiDriverOptions> = {},
  extraEnv: Record<string, string> = {},
  spawnDelayMs = 0,
  delayFromTurn = 1,
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
  const order: string[] = [];
  let driver!: KimiSessionDriver;
  const procs: SessionProcess[] = [];
  const argvs: string[][] = [];
  let turnCount = 0;
  const options: KimiDriverOptions = {
    resumeSessionId: null,
    autonomy: "high",
    model: undefined,
    wireModel: undefined,
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
      turnCount++;
      if (spawnDelayMs > 0 && turnCount >= delayFromTurn) await Bun.sleep(spawnDelayMs);
      argvs.push([...argv]);
      // The fake replaces the binary name and keeps every flag. Under a
      // hermetic launch the command is the real spawn shape — `env -u K
      // ... NAME=VALUE ... kimi <flags>` — so the rig applies what
      // env(1) would to the child's environment (dropped names, then
      // assignments) before swapping in the fake: the turn child really
      // runs on the private HOME and KIMI_CODE_HOME the argv names.
      const kimiAt = argv.indexOf("kimi");
      const childEnv: Record<string, string> = {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        FAKE_STATE_DIR: stateDir,
        FAKE_TURN_NUMBER: String(turnCount),
        HOME: dir,
        ...extraEnv,
      };
      if (argv[0] === "env") {
        for (let i = 1; i < kimiAt; i++) {
          const token = argv[i]!;
          if (token === "-u") {
            delete childEnv[argv[++i]!];
            continue;
          }
          const eq = token.indexOf("=");
          if (eq > 0) childEnv[token.slice(0, eq)] = token.slice(eq + 1);
        }
      }
      const proc = new SessionProcess({
        command: ["bun", FAKE, ...argv.slice(kimiAt + 1)],
        cwd: options.cwd,
        env: childEnv,
        onLine: (line) => driver.handleHarnessLine(line),
        onFatal: (fatal) => driver.handleFatal(fatal),
        graceMs,
      });
      procs.push(proc);
      order.push("spawned");
      void proc.settled.then(() => order.push("settled"));
      const prompt = argv[argv.indexOf("--prompt") + 1] ?? "";
      if (/\bscenario:wait\b/.test(prompt) &&
          (extraEnv.FAKE_DRAIN_SELFKILL === "1" || extraEnv.FAKE_DRAIN_EXIT143 === "1")) {
        // Start the drain only after the fake has installed its EOF handler.
        // Interpreter startup must not consume the drain's 500 ms budget.
        const readyPath = join(stateDir, "drain-ready.jsonl");
        await waitFor(events, () => {
          if (!existsSync(readyPath)) return undefined;
          const ready = readFileSync(readyPath, "utf8").trim().split("\n");
          return ready.some((line) => JSON.parse(line).turn === String(turnCount)) ? true : undefined;
        }, "the fake's drain handler");
      }
      return proc;
    },
    sink: (line) => {
      events.push(JSON.parse(line) as Event);
    },
    ...overrides,
  };
  driver = new KimiSessionDriver(options);
  const code = driver.run();
  void code.then(() => order.push("done"));
  cleanups.push(async () => {
    driver.dispose();
    for (const proc of procs) {
      proc.requestStop();
      await proc.settled;
    }
  });
  return { driver, events, code, options, stateDir, workDir, order, argvs };
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

export const of = (type: string) => (events: Event[]) => events.find((event) => event.type === type);

export const send = (driver: KimiSessionDriver, message: unknown): void => {
  driver.handleCallerLine(JSON.stringify(message));
};
