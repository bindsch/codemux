/** The kimi interleaving rig (split from tests/session-kimi-interleavings.
 * test.ts): a scripted turn spawn and a child with independently ordered
 * death and exit delivery, over the real KimiSessionDriver resuming a
 * claimed record. Shared by the session-kimi-interleavings-*.test.ts
 * suites; each of those files arms the signal swallow and drains
 * `cleanups` in its own afterAll. bun shares this module across files, so
 * a later file's afterAll re-runs the earlier files' teardowns — every
 * cleanup is dispose-only and idempotent. */

import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  KimiSessionDriver,
  type KimiDriverOptions,
} from "../../src/session/kimi-driver.js";
import type { TurnChild } from "../../src/session/kimi-machine.js";
import type { SessionChildOutcome } from "../../src/session/process.js";
import { readRegistry } from "../../src/session/registry.js";

/** The rig's fixed native id: a resumed session, so the registry record
 * exists from run_started and every scenario's release is observable. */
export const ID = "session_11111111-2222-3333-4444-555555555555";

export type Event = Record<string, any>;

/** The events the matrix orders. */
export type Injection =
  | "stdin_eof"
  | "signal"
  | "session_timeout"
  | "fatal"
  | "spawn_ok"
  | "spawn_fail"
  | "exit_normal"
  | "exit_143"
  | "exit_crash";

// --- the scripted child and spawn -------------------------------------------

/** A child with independently controlled death and exit delivery. */
export class FakeTurnProcess implements TurnChild {
  alive = true;
  /** Die to the stop the way kimi really does — its handler re-exits the
   * coded 143 — instead of dying by the signal itself. */
  codedStop = false;
  /** Survive requestStop's SIGTERM (a harness that misses the signal):
   * the hold's settle window stays open, which the escalation test needs. */
  ignoreStop = false;
  /** The driver's escalation landed here (round al30's second-signal
   * rule): the group SIGKILL a second SIGINT/SIGTERM asks for. */
  escalated = false;
  /** How many times escalateStop ran — the once-latch's counter (round
   * al33, edges major 3: the driver's aliasing and repeated second
   * signals must reach the child once, so a duplicate tree SIGKILL
   * never races the first). */
  escalationCount = 0;
  /** requestStop has asked for the stop (the settle window is open). */
  stopArmed = false;
  /** The exit has landed (die() ran) — the flag whose staleness is the
   * race: a real requestStop reads a childExited that lags the death,
   * so a stop can fly at a child already dead (round al32). Once set,
   * no further send is recorded — the pid-reuse rule a real child's own
   * guard already carries. */
  private exitLanded = false;
  /** The stored outcome of a kill() whose exit has not landed yet. */
  private pendingOutcome: SessionChildOutcome | null = null;
  childOutcome: SessionChildOutcome | null = null;
  private exitResolve!: (outcome: SessionChildOutcome) => void;
  readonly exited: Promise<SessionChildOutcome>;
  private settleResolve!: () => void;
  readonly settled: Promise<void>;

  constructor() {
    this.exited = new Promise<SessionChildOutcome>((resolve) => {
      this.exitResolve = resolve;
    });
    this.settled = new Promise<void>((resolve) => {
      this.settleResolve = resolve;
    });
  }

  requestStop(): void {
    if (this.stopArmed || this.exitLanded) return;
    this.stopArmed = true;
    if (this.ignoreStop) return;
    if (this.alive) {
      this.die(
        this.codedStop ? { code: 143, signal: null } : { code: null, signal: "SIGTERM" }
      );
    }
  }

  escalateStop(): void {
    // Latched like the real SessionProcess (session/process.ts): the
    // escalation fires once however many paths reach it.
    if (this.escalated) return;
    this.escalated = true;
    this.escalationCount++;
  }

  endInput(): void {
    // Kimi children never read stdin; the close is a no-op.
  }

  async awaitEndAnswer(answered: () => boolean): Promise<void> {
    const deadline = Date.now() + 100;
    while (!answered() && this.alive && Date.now() < deadline) await Bun.sleep(2);
  }


  /** An external death whose exit has not landed: the child is gone
   * (the drain's answer wait ends with its aliveness), but exited stays
   * pending — die() lands it. The deterministic form of the window a
   * real requestStop races (round al32, correctness major 2). */
  kill(outcome: SessionChildOutcome): void {
    if (!this.alive) return;
    this.alive = false;
    this.pendingOutcome = outcome;
  }

  /** Deliver the stored outcome when kill() held it back, otherwise the
   * argument. Repeated delivery is a no-op. */
  die(outcome?: SessionChildOutcome): void {
    if (this.pendingOutcome === null) {
      if (!this.alive || outcome === undefined) return;
      this.alive = false;
      this.pendingOutcome = outcome;
    }
    this.exitLanded = true;
    this.childOutcome = this.pendingOutcome;
    this.exitResolve(this.pendingOutcome);
    this.pendingOutcome = null;
    this.settleResolve();
  }
}

/** The turn spawn as a promise the test holds: the probes a real scode
 * closure runs become a settle the scenario times itself. */
class ScriptedSpawn {
  private pending: {
    resolve: (child: TurnChild) => void;
    reject: (error: unknown) => void;
  } | null = null;

  readonly spawnTurn = (_argv: string[]): Promise<TurnChild> =>
    new Promise<TurnChild>((resolve, reject) => {
      this.pending = { resolve, reject };
    });

  settle(child: TurnChild): void {
    const pending = this.pending;
    this.pending = null;
    pending?.resolve(child);
  }

  fail(error: unknown): void {
    const pending = this.pending;
    this.pending = null;
    pending?.reject(error);
  }

  get inFlight(): boolean {
    return this.pending !== null;
  }
}

export interface Rig {
  driver: KimiSessionDriver;
  events: Event[];
  code: Promise<number>;
  registryPath: string;
  spawn: ScriptedSpawn;
  children: FakeTurnProcess[];
  timeoutMs: number | null;
}

export const cleanups: Array<() => Promise<void> | void> = [];

/** The suite signals its own process to order the signal event; this
 * listener keeps a disposed gate's window (no driver listening yet or
 * anymore) from terminating the test run. Every driver gate that exists
 * still fires — all listeners run. Each test file of this base arms one
 * count at load; its afterAll (drainRig) drains the cleanups and disarms
 * its count, so the listener stays installed while any sibling file of
 * the base still runs. */
const swallowSignal = (): void => {};
let armedFiles = 0;
export function armSignalSwallow(): void {
  armedFiles++;
  process.on("SIGTERM", swallowSignal);
}
export async function drainRig(): Promise<void> {
  for (const clean of cleanups) await clean();
  if (--armedFiles <= 0) process.off("SIGTERM", swallowSignal);
}

let root: string | null = null;
export function workRoot(): string {
  if (root === null) root = mkdtempSync(join(tmpdir(), "codemux-kimi-matrix-"));
  return root;
}

/** One driver over the scripted spawn, resuming ID with the record
 * claimed: the registry record exists from run_started, so every
 * scenario's release is observable in the registry file. A custom sink
 * (the al29 overflow test's stopped reader) replaces the collecting
 * one; the session_started wait is skipped there, for the custom sink
 * delivers nothing to wait on. */
export async function startRig(
  timeoutMs: number | null,
  sink?: KimiDriverOptions["sink"]
): Promise<Rig> {
  const dir = mkdtempSync(join(workRoot(), "s-"));
  const workDir = join(dir, "work");
  const registryDir = join(dir, "registry");
  mkdirSync(workDir);
  mkdirSync(registryDir, { mode: 0o700 });
  const events: Event[] = [];
  const registryPath = join(registryDir, "live-sessions.json");
  const spawn = new ScriptedSpawn();
  const children: FakeTurnProcess[] = [];
  const options: KimiDriverOptions = {
    resumeSessionId: ID,
    autonomy: "high",
    cwd: workDir,
    hermetic: false,
    sandboxed: true,
    sandboxTrust: "standard",
    sandboxNoNet: false,
    sandboxScrubEnv: false,
    passEnv: [],
    authorPrefix: true,
    sessionTimeoutMs: timeoutMs,
    registryPath,
    harnessHome: join(dir, "home"),
    providerBaseUrl: null,
    spawnTurn: spawn.spawnTurn,
    sink:
      sink ??
      ((line: string): void => {
        events.push(JSON.parse(line) as Event);
      }),
  };
  const driver = new KimiSessionDriver(options);
  driver.adoptResumeClaim();
  const code = driver.run();
  cleanups.push(() => {
    driver.dispose();
  });
  const rig: Rig = {
    driver,
    events,
    code,
    registryPath,
    spawn,
    children,
    timeoutMs,
  };
  // The record and the announcement land before the scenario starts.
  if (sink === undefined) {
    await until("session_started recorded", () =>
      events.some((event) => event.type === "session_started")
    );
  }
  return rig;
}

/** Wait until `holds` reads true (10 ms polls, 5 s cap), naming what was
 * waited for in the failure. */
export async function until(label: string, holds: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!holds()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await Bun.sleep(10);
  }
}

export const send = (rig: Rig, text: string): void => {
  rig.driver.handleCallerLine(JSON.stringify({ type: "user", text }));
};

/** The most recent child still believed alive (the drain's child), or
 * null — a dead child's further exits assert the supersession no-op. */
function lastAlive(rig: Rig): FakeTurnProcess | null {
  for (let i = rig.children.length - 1; i >= 0; i--) {
    if (rig.children[i]!.alive) return rig.children[i]!;
  }
  return null;
}

/** Deliver one matrix event. `session_timeout` waits past the armed
 * deadline (the timer fired by then); `signal` signals the process —
 * skipped when the session already ended, for its gate is disposed and
 * the pair's first event is the whole story. */
export async function inject(rig: Rig, event: Injection): Promise<void> {
  switch (event) {
    case "stdin_eof":
      rig.driver.handleCallerEnd();
      await Bun.sleep(5);
      return;
    case "signal":
      if (rig.events.some((e) => e.type === "session_ended")) return;
      process.kill(process.pid, "SIGTERM");
      await Bun.sleep(15);
      return;
    case "session_timeout":
      await Bun.sleep((rig.timeoutMs ?? 0) + 80);
      return;
    case "fatal":
      // A child line that cannot parse: the tier-3 fatal route.
      rig.driver.handleHarnessLine("this line is not json");
      await Bun.sleep(5);
      return;
    case "spawn_ok": {
      if (!rig.spawn.inFlight) return; // stale: already resolved
      const child = new FakeTurnProcess();
      rig.children.push(child);
      rig.spawn.settle(child);
      await Bun.sleep(5);
      return;
    }
    case "spawn_fail":
      if (!rig.spawn.inFlight) return; // stale: already resolved
      rig.spawn.fail(new Error("the probe could not verify the sandbox"));
      await Bun.sleep(5);
      return;
    case "exit_normal":
      lastAlive(rig)?.die({ code: 0, signal: null });
      await Bun.sleep(5);
      return;
    case "exit_143":
      lastAlive(rig)?.die({ code: 143, signal: null });
      await Bun.sleep(5);
      return;
    case "exit_crash":
      lastAlive(rig)?.die({ code: null, signal: "SIGKILL" });
      await Bun.sleep(5);
      return;
  }
}

/** Close what the pair left open, so every scenario reaches `ended`:
 * resolve a spawn still in flight FIRST — an end that abandoned it would
 * hold the registry record behind its never-landing child forever —
 * then exit a child still draining, and close a still-live session
 * cleanly. Then the invariants hold of every ordering. */
export async function finish(rig: Rig): Promise<void> {
  const endedNow = async (): Promise<boolean> =>
    await Promise.race([rig.code.then(() => true), Bun.sleep(150).then(() => false)]);
  if (rig.spawn.inFlight) {
    const child = new FakeTurnProcess();
    rig.children.push(child);
    rig.spawn.settle(child);
    await Bun.sleep(25);
  }
  if (await endedNow()) return;
  const alive = lastAlive(rig);
  if (alive !== null) {
    alive.die({ code: 0, signal: null });
    await Bun.sleep(25);
  }
  if (!(await endedNow())) rig.driver.handleCallerEnd();
  if (!(await endedNow())) {
    throw new Error(
      `the scenario never ended; events: ${rig.events.map((e) => e.type).join(",")}`
    );
  }
}

/** The registry record's end stamp: null while the record is held. */
export function recordEnded(rig: Rig): string | null | undefined {
  const registry = readRegistry(rig.registryPath);
  if (registry.outcome !== "ok") return undefined;
  const entry = registry.file.sessions.find((record) => record.id === ID) as
    | { ended: string | null }
    | undefined;
  return entry?.ended;
}

// --- the machine's turn-reply rule, probed purely ------------------------------

// The kimi wire's line spellings, shared by the reply-rule and tool-loop
// describes below (the grammar each probe builds its streams from).
export const assistantText = (text: string): string =>
  JSON.stringify({ role: "assistant", content: text });
export const assistantCall = (callId: string): string =>
  JSON.stringify({
    role: "assistant",
    tool_calls: [
      { type: "function", id: callId, function: { name: "read_file", arguments: "{}" } },
    ],
  });
export const toolResult = (callId: string): string =>
  JSON.stringify({ role: "tool", tool_call_id: callId, content: "ok" });
export const hintLine = (id: string): string =>
  JSON.stringify({
    role: "meta",
    type: "session.resume_hint",
    session_id: id,
    command: `kimi -r ${id}`,
    content: `To resume this session: kimi -r ${id}`,
  });
