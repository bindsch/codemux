/**
 * Kimi lifecycle interleavings with independently ordered child death,
 * exit delivery, caller shutdown, signals, and spawn completion.
 * Every observed failing child outcome fails the session (al41).
 */

import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  KimiSessionDriver,
  type KimiDriverOptions,
} from "../src/session/kimi-driver.js";
import {
  initialKimiState,
  step,
  type KimiEffect,
  type KimiEvent,
  type TurnChild,
} from "../src/session/kimi-machine.js";
import { BoundedOutboundQueue, SessionProcess, SESSION_SIGNAL_EXIT_CODE, TERMINAL_LANE_CAPACITY } from "../src/session/process.js";
import type { SessionChildOutcome } from "../src/session/process.js";
import { readRegistry } from "../src/session/registry.js";

/** The rig's fixed native id: a resumed session, so the registry record
 * exists from run_started and every scenario's release is observable. */
const ID = "session_11111111-2222-3333-4444-555555555555";

type Event = Record<string, any>;

/** The events the matrix orders. */
type Injection =
  | "stdin_eof"
  | "signal"
  | "session_timeout"
  | "fatal"
  | "spawn_ok"
  | "spawn_fail"
  | "exit_normal"
  | "exit_143"
  | "exit_crash";

/** The code an event contributes as a cause: its own when it is the
 * FIRST cause (stdin_eof included — a clean close is a cause at 0), and
 * the same value as a later one, for the code is the MAX over the end
 * path's causes (turn-per-process.ts, invariant 3). Events not listed
 * are never causes of their own. The exits are context-dependent: a
 * child's death during a graceful end's drain is a cause (the
 * external-death diagnostics), while the same death in a live session
 * is the turn's own verdict and costs the code nothing — and after a
 * killing end the child is already dead, suppressed at a code at least
 * its own. `spawn_fail` after a killing end is the abandoned spawn,
 * recorded nowhere, at a code already at least its 1. */
const CAUSE_CODE: Partial<Record<Injection, number>> = {
  stdin_eof: 0,
  signal: SESSION_SIGNAL_EXIT_CODE,
  session_timeout: 1,
  fatal: 1,
  spawn_fail: 1,
  exit_143: 1,
  exit_crash: 1,
};

/** The pair's expected process exit code: the first cause's floor,
 * raised by every later cause the end path meets. The rig's delivery
 * rule is part of the expectation: a killing first end resolves done
 * before the second injection runs (its guard sees session_ended, or
 * the event lands in an ended machine and is ignored), so only a
 * graceful first end — still draining — actually meets the second
 * event. */
function expectedCode(pair: readonly Injection[]): number {
  let code: number | null = null;
  let gracefulEndOpen = false;
  for (const event of pair) {
    if (code === null) {
      // No end owns yet: the first event that is a cause fixes the
      // floor. A live child's death is not one — it completes the turn.
      if (event === "exit_143" || event === "exit_crash" || event === "exit_normal") continue;
      const first = CAUSE_CODE[event];
      if (first === undefined) continue; // spawn_ok
      code = first;
      gracefulEndOpen = event === "stdin_eof" || event === "signal";
      continue;
    }
    if (!gracefulEndOpen) continue; // done already resolved; nothing delivered
    // A graceful drain is open: a clean close is the end already
    // running, a landed child's plain exit 0 completes the drained turn;
    // every other cause here is delivered and raises the code.
    if (event === "stdin_eof" || event === "spawn_ok" || event === "exit_normal") continue;
    code = Math.max(code, CAUSE_CODE[event] ?? 0);
  }
  // No event of the pair ended the session: the finisher's clean close
  // is the first cause.
  return code ?? 0;
}

/** The reason an event spells as the FIRST cause — the reason the
 * session_ended event carries, fixed forever by whichever cause landed
 * first (invariant 2). Events not listed are never causes of their own
 * (the exits complete the turn they belong to; spawn_ok lands a child),
 * and a pair with no cause at all ends through the finisher's clean
 * stdin close. The matrix asserts this for every ordering (round al37,
 * contracts item 5): a second cause may raise the code, never the
 * reason. */
const CAUSE_REASON: Partial<Record<Injection, string>> = {
  stdin_eof: "stdin-close",
  signal: "signal",
  session_timeout: "timeout",
  fatal: "crash",
  spawn_fail: "crash",
};

function expectedReason(pair: readonly Injection[]): string {
  for (const event of pair) {
    const reason = CAUSE_REASON[event];
    if (reason !== undefined) return reason;
  }
  return "stdin-close";
}

// --- the scripted child and spawn -------------------------------------------

/** A child with independently controlled death and exit delivery. */
class FakeTurnProcess implements TurnChild {
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

interface Rig {
  driver: KimiSessionDriver;
  events: Event[];
  code: Promise<number>;
  registryPath: string;
  spawn: ScriptedSpawn;
  children: FakeTurnProcess[];
  timeoutMs: number | null;
}

const cleanups: Array<() => Promise<void> | void> = [];
afterAll(async () => {
  for (const clean of cleanups) await clean();
  process.off("SIGTERM", swallowSignal);
});

/** The suite signals its own process to order the signal event; this
 * listener keeps a disposed gate's window (no driver listening yet or
 * anymore) from terminating the test run. Every driver gate that exists
 * still fires — all listeners run. */
const swallowSignal = (): void => {};
process.on("SIGTERM", swallowSignal);

let root: string | null = null;
function workRoot(): string {
  if (root === null) root = mkdtempSync(join(tmpdir(), "codemux-kimi-matrix-"));
  return root;
}

/** One driver over the scripted spawn, resuming ID with the record
 * claimed: the registry record exists from run_started, so every
 * scenario's release is observable in the registry file. A custom sink
 * (the al29 overflow test's stopped reader) replaces the collecting
 * one; the session_started wait is skipped there, for the custom sink
 * delivers nothing to wait on. */
async function startRig(
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
async function until(label: string, holds: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!holds()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await Bun.sleep(10);
  }
}

const send = (rig: Rig, text: string): void => {
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
async function inject(rig: Rig, event: Injection): Promise<void> {
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
async function finish(rig: Rig): Promise<void> {
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
function recordEnded(rig: Rig): string | null | undefined {
  const registry = readRegistry(rig.registryPath);
  if (registry.outcome !== "ok") return undefined;
  const entry = registry.file.sessions.find((record) => record.id === ID) as
    | { ended: string | null }
    | undefined;
  return entry?.ended;
}

// --- the matrix --------------------------------------------------------------

const END_EVENTS = ["stdin_eof", "signal", "session_timeout", "fatal"] as const;
const SPAWN_EVENTS = ["spawn_ok", "spawn_fail"] as const;
const EXIT_EVENTS = ["exit_normal", "exit_143", "exit_crash"] as const;

interface Scenario {
  start: "spawning" | "running";
  first: Injection;
  second: Injection;
}

const scenarios: Scenario[] = [];
// From spawning: end events and spawn resolutions, both orders, minus the
// pair of two spawn resolutions (one spawn resolves once); a spawn that
// lands first is followed by the child's exits too, for the running half
// of its own ladder.
const spawningEvents: Injection[] = [...END_EVENTS, ...SPAWN_EVENTS];
for (const first of spawningEvents) {
  for (const second of spawningEvents) {
    if (first === second) continue;
    if (
      (SPAWN_EVENTS as readonly string[]).includes(first) &&
      (SPAWN_EVENTS as readonly string[]).includes(second)
    ) {
      continue;
    }
    scenarios.push({ start: "spawning", first, second });
  }
}
for (const second of EXIT_EVENTS) {
  scenarios.push({ start: "spawning", first: "spawn_ok", second });
}
// From running: end events and the child's exits, both orders.
const runningEvents: Injection[] = [...END_EVENTS, ...EXIT_EVENTS];
for (const first of runningEvents) {
  for (const second of runningEvents) {
    if (first === second) continue;
    scenarios.push({ start: "running", first, second });
  }
}

describe("kimi session interleavings (round al28)", () => {
  for (const { start, first, second } of scenarios) {
    test(`${start}: ${first} then ${second}`, async () => {
      const timer =
        first === "session_timeout" ? 60 : second === "session_timeout" ? 300 : null;
      const rig = await startRig(timer);
      send(rig, "pair scenario");
      if (start === "running") {
        const child = new FakeTurnProcess();
        rig.children.push(child);
        rig.spawn.settle(child);
        await Bun.sleep(5);
      }
      await inject(rig, first);
      await inject(rig, second);
      await finish(rig);

      // Invariant 1: exactly one session_ended.
      const endings = rig.events.filter((event) => event.type === "session_ended");
      expect(endings).toHaveLength(1);
      // Invariant 2's reason half (round al37, contracts item 5): the
      // reason is the FIRST cause's, asserted for every ordering — a
      // later cause may raise the code, never the reason.
      const outcome = endings[0]!.harness_exit;
      const failedChild = outcome !== null && (outcome.code !== 0 || outcome.signal !== null);
      expect(endings[0]!.reason).toBe(failedChild ? "harness_failed" : expectedReason([first, second]));
      // Invariant 2: the reason is the first cause's and the exit code
      // is the end path's summary — the floor raised by every later
      // cause it met.
      expect(await rig.code).toBe(Math.max(expectedCode([first, second]), failedChild ? 1 : 0));
      // Invariant 3: no unconfirmed turn ever read success.
      for (const completed of rig.events.filter(
        (event) => event.type === "turn_completed"
      )) {
        expect(["failed", "interrupted"]).toContain(completed.finish);
      }
      // Invariant 2's ended half: nothing is accepted past the end. The
      // late input, a late resume hint (it would adopt and confirm — a
      // meta line naming the known id, the exact shape the parser maps),
      // and a late close all leave the stream untouched.
      const before = rig.events.length;
      rig.driver.handleCallerLine(JSON.stringify({ type: "user", text: "late" }));
      rig.driver.handleHarnessLine(
        `{"role":"meta","type":"session.resume_hint","session_id":"${ID}","command":"kimi -r ${ID}","content":"To resume this session: kimi -r ${ID}"}`
      );
      rig.driver.handleCallerEnd();
      await Bun.sleep(20);
      expect(rig.events.length).toBe(before);
      // Invariant 4: the record releases only once no child can exist.
      await until("the registry release", () => recordEnded(rig) != null);
      for (const child of rig.children) {
        expect(child.alive).toBe(false);
      }
    }, 15_000);
  }

  test("a spawn whose probe outlasts --timeout holds the record until it can no longer create a child", async () => {
    // The slow-scode shape: the session's absolute deadline fires while
    // the spawn closure's probes are still running (a never-settling
    // spawn is their unbounded form). The killing end abandons the spawn,
    // done resolves at the deadline, and the record stays live — only the
    // late landing's stop-and-settle releases it.
    const rig = await startRig(60);
    send(rig, "slow probe");
    await until("the timeout's end", () =>
      rig.events.some((event) => event.type === "session_ended")
    );
    const ended = rig.events.find((event) => event.type === "session_ended");
    expect(ended?.reason).toBe("timeout");
    expect(await rig.code).toBe(1);
    expect(recordEnded(rig)).toBeNull(); // held: a child may still come
    // The probe finally lands, minutes past the deadline: the hold stops
    // the child — it never runs — and only then releases the record.
    const late = new FakeTurnProcess();
    rig.children.push(late);
    rig.spawn.settle(late);
    await until("the late child settled", () => !late.alive);
    await until("the held release", () => recordEnded(rig) != null);
    expect(rig.events.some((event) => event.type === "assistant_message")).toBe(false);
  }, 15_000);

  test("a queue overflow inside a turn-opening emit still completes the effect list (al29, re-aimed by al30)", async () => {
    // The effect-completion rule: an event raised while an effect list
    // runs parks behind the list and dispatches after it finishes,
    // never aborting the remaining effects. Round al29 aimed the breach
    // at the session_ended emit; round al30's terminal lane made that
    // aim point unreachable by construction (session_ended is never
    // refused), so the breach rides the first non-terminal emit the
    // bounds CAN refuse. Round al31 demoted the acks to ordinary
    // entries; round al32 demoted turn_started and turn_completed with
    // them (the lane is the session's end events alone), so the
    // arithmetic runs on the ordinary side throughout: session_started,
    // the first turn's ack, user_message echo, and turn_started (4)
    // plus 1,019 unknown events (1,023), the turn's completion landing
    // the 1,024th ordinary entry exactly — so the second user line's
    // ack is the breach, the first emit of the turn-opening effect
    // list. What must survive it: the spawn effect
    // AFTER the breached emit still runs (the regression's core — the
    // generation-token abort this rule replaced skipped it, so the turn
    // never spawned and its prompt was lost), and the parked fatal then
    // dispatches into a machine that ends once, a killing end whose
    // hold owns the late-landing child before the registry record
    // releases.
    const previousLog = process.env.CODEMUX_CALL_LOG;
    const ledgerPath = join(mkdtempSync(join(workRoot(), "ledger-")), "calls.jsonl");
    process.env.CODEMUX_CALL_LOG = ledgerPath;
    try {
      const stoppedReader = (_line: string): Promise<void> =>
        new Promise(() => {}); // nothing ever drains
      const rig = await startRig(null, stoppedReader);
      send(rig, "flood scenario");
      const first = new FakeTurnProcess();
      rig.children.push(first);
      rig.spawn.settle(first);
      await Bun.sleep(5);
      for (let i = 0; i < 1_019; i++) {
        rig.driver.handleHarnessLine(`{"x":${i}}`);
      }
      first.die({ code: 0, signal: null }); // the completion fills the ordinary bound
      await Bun.sleep(5);
      // The breach: the ack is refused at the full ordinary bound, the
      // user_message echo and turn_started after it are refused with
      // it, and the overflow fatal parks.
      send(rig, "breach");
      // The spawn effect ran despite the fatal parked mid-list — the
      // effect-completion rule the al29 regression established.
      await until("the breached turn's spawn still started", () => rig.spawn.inFlight);
      const late = new FakeTurnProcess();
      rig.children.push(late);
      rig.spawn.settle(late);
      // The parked fatal's killing end abandoned the spawn, and its
      // hold stops the late child before the registry releases.
      await until("the hold stops the late child", () => late.stopArmed);
      expect(late.alive).toBe(false); // the default child dies to the stop
      const code = await Promise.race([
        rig.code,
        Bun.sleep(5_000).then(() => {
          throw new Error("run() never resolved after the parked fatal's end");
        }),
      ]);
      // The fatal's own floor (crash, 1); the stopped reader's flush
      // give-up cannot lower it.
      expect(code).toBe(1);
      // ledger_session ran on the parked fatal's end path: the closing
      // record exists and carries the end path's own verdict.
      const records = readFileSync(ledgerPath, "utf8")
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => JSON.parse(line) as Record<string, any>);
      const closing = records.filter((record) => record.kind === "session");
      expect(closing).toHaveLength(1);
      expect(closing[0]!.finish).toBe("crash");
      expect(closing[0]!.exit_code).toBe(1);
      // The registry released only after the late child settled, and
      // the ended machine never reopens: a late line changes nothing.
      await until("the registry release", () => recordEnded(rig) != null);
      const before = rig.events.length;
      rig.driver.handleCallerLine(JSON.stringify({ type: "user", text: "late" }));
      rig.driver.handleCallerEnd();
      await Bun.sleep(20);
      expect(rig.events.length).toBe(before);
    } finally {
      if (previousLog === undefined) delete process.env.CODEMUX_CALL_LOG;
      else process.env.CODEMUX_CALL_LOG = previousLog;
    }
  }, 15_000);

  test("a final session_ended EPIPE is recorded as exit 1 in the ledger (al39)", async () => {
    const previousLog = process.env.CODEMUX_CALL_LOG;
    const ledgerPath = join(mkdtempSync(join(workRoot(), "ledger-")), "calls.jsonl");
    process.env.CODEMUX_CALL_LOG = ledgerPath;
    try {
      let finalWrites = 0;
      const rig = await startRig(null, async (line) => {
        if (JSON.parse(line).type === "session_ended") {
          finalWrites++;
          throw Object.assign(new Error("broken pipe"), { code: "EPIPE" });
        }
      });
      rig.driver.handleCallerEnd();
      expect(await rig.code).toBe(1);
      expect(finalWrites).toBe(1);
      const closing = readFileSync(ledgerPath, "utf8").trim().split("\n")
        .map((line) => JSON.parse(line))
        .filter((record) => record.kind === "session");
      expect(closing).toHaveLength(1);
      expect(closing[0].exit_code).toBe(1);
    } finally {
      if (previousLog === undefined) delete process.env.CODEMUX_CALL_LOG;
      else process.env.CODEMUX_CALL_LOG = previousLog;
    }
  });

  test("a natural exit 0 pending before requestStop completes the turn (al39)", async () => {
    const proc = Bun.spawn(["bun", "-e", "process.exit(0)"], {
      stdin: "pipe", stdout: "pipe", stderr: "ignore",
    });
    await proc.exited;
    // Supply the already-exited child before SessionProcess's exit
    // continuation can run. The stop's send explicitly returns ESRCH.
    const noProcess = () => { throw Object.assign(new Error("no such process"), { code: "ESRCH" }); };
    const handleKill = spyOn(proc, "kill").mockImplementation(noProcess);
    const rawKill = spyOn(process, "kill").mockImplementation(noProcess);
    const spawn = spyOn(Bun, "spawn").mockReturnValue(proc);
    let child: SessionProcess;
    try {
      child = new SessionProcess({
        command: ["unused"], onLine: () => {}, onFatal: () => {}, graceMs: 1,
        cwd: workRoot(), env: {},
      });
    } finally {
      spawn.mockRestore();
    }
    try {
      const config = { authorPrefix: true, registryEnabled: false };
      const state = initialKimiState(null);
      step(state, { kind: "run_started" }, config);
      step(state, { kind: "user_input", line: JSON.stringify({ type: "user", text: "finish" }) }, config);
      step(state, { kind: "spawn_settled", child }, config);
      for (const line of [assistantText("finished"), hintLine(ID)]) {
        step(state, { kind: "child_line", line }, config);
      }
      step(state, { kind: "stdin_eof" }, config);
      child.requestStop();
      expect(handleKill).toHaveBeenCalledWith("SIGTERM");
      const outcome = await child.exited;
      expect(outcome).toEqual({ code: 0, signal: null });

      const effects = step(state, { kind: "child_exit", child, outcome }, config);
      expect(effects).toContainEqual(expect.objectContaining({
        kind: "emit", event: "turn_completed", finish: "end",
      }));
    } finally {
      await child.settled;
      handleKill.mockRestore();
      rawKill.mockRestore();
    }
  });

  test("an exit 7 pending before the stop remains a shutdown failure (al38)", async () => {
    const rig = await startRig(null);
    send(rig, "pending exit seven");
    const child = new FakeTurnProcess();
    rig.children.push(child);
    rig.spawn.settle(child);
    await Bun.sleep(5);
    rig.driver.handleCallerEnd();
    child.kill({ code: 7, signal: null });
    child.requestStop(); // The send finds no live child; the callback is still pending.
    child.die();
    expect(await rig.code).not.toBe(0);
    const ended = rig.events.find((event) => event.type === "session_ended");
    expect(ended?.exit_code).not.toBe(0);
    expect(ended?.harness_exit).toEqual({ code: 7, signal: null });

  });

  test("a synthesized completion over the ordinary queue cap uses the terminal lane (al38)", async () => {
    for (const laneExhausted of [false, true]) {
      const events: Event[] = [];
      let opened = false;
      let release!: () => void;
      const rig = await startRig(null, (line) => {
        events.push(JSON.parse(line));
        if (!opened) return new Promise<void>((resolve) => { release = resolve; });
      });
      send(rig, "final completion overflow");
      const child = new FakeTurnProcess();
      rig.children.push(child);
      rig.spawn.settle(child);
      await Bun.sleep(5);
      // Four opening events plus 1,020 unknowns fill the ordinary queue.
      for (let i = 0; i < 1020; i++) rig.driver.handleHarnessLine(`{"x":${i}}`);
      if (laneExhausted) {
        const { out } = rig.driver as unknown as { out: BoundedOutboundQueue };
        for (let i = 0; i < TERMINAL_LANE_CAPACITY - 1; i++) {
          expect(out.enqueue(JSON.stringify({ type: "error", fatal: true }), { terminal: "fatal" })).toBe(true);
        }
      }
      rig.driver.handleCallerEnd();
      child.requestStop();
      await until("final emissions queued", () => recordEnded(rig) != null);
      opened = true;
      release();
      expect(await rig.code).toBe(1);
      expect(events.filter((event) => event.type === "turn_started")).toHaveLength(1);
      expect(events.filter((event) => event.type === "turn_completed")).toHaveLength(laneExhausted ? 0 : 1);
      expect(events.at(-1)?.type).toBe("session_ended");
      expect(events.at(-1)?.exit_code).toBe(1);
    }
  });

  test("1,024 queued events then stdin close still deliver exactly one session_ended (al30)", async () => {
    // Rule 1's test, verbatim from the round: the outbound queue sits at
    // exactly its 1,024-event cap when the idle stdin close ends the
    // session. Before al30 the session_ended emit was one more event the
    // bounds refused: the flush succeeded on a queue that never held the
    // end, and run() resolved 0 with the caller never told the session
    // ended (correctness major 1). Terminal events ride the lane the
    // bounds do not close now, and the end waits for the sink: the gate
    // holds every line until the session has ended, then releases, and
    // the flush must deliver the full queue plus the lane's
    // session_ended within the documented give-up.
    const events: Event[] = [];
    let opened = false;
    const parked: Array<() => void> = [];
    const gatedSink = (line: string): Promise<void> | void => {
      events.push(JSON.parse(line) as Event);
      if (opened) return;
      return new Promise<void>((resolve) => parked.push(resolve));
    };
    const rig = await startRig(null, gatedSink);
    send(rig, "flood scenario");
    const child = new FakeTurnProcess();
    rig.children.push(child);
    rig.spawn.settle(child);
    await Bun.sleep(5);
    // The event bound counts ordinary entries (round al32: the ack,
    // turn_started, and turn_completed among them — only the session's
    // end events ride the lane): session_started, the ack, the
    // user_message echo, and turn_started (4) + 1,019 unknowns put the
    // ordinary queue at 1,023 — one below its 1,024-entry cap — and the
    // turn's completion lands the 1,024th exactly, filling it. The
    // session_ended behind it rides the terminal lane past the full
    // ordinary bound.
    for (let i = 0; i < 1_019; i++) {
      rig.driver.handleHarnessLine(`{"x":${i}}`);
    }
    child.die({ code: 0, signal: null }); // the turn completes, unconfirmed
    await Bun.sleep(5);
    rig.driver.handleCallerEnd(); // the idle stdin-close end
    // The session ends while the gate still holds the queue full.
    await Bun.sleep(25);
    opened = true;
    for (const release of parked) release();
    const code = await Promise.race([
      rig.code,
      Bun.sleep(5_000).then(() => {
        throw new Error("run() never resolved after the gated flush");
      }),
    ]);
    expect(code).toBe(0);
    const ends = events.filter((event) => event.type === "session_ended");
    expect(ends).toHaveLength(1);
    expect(ends[0]!.reason).toBe("stdin-close");
    expect(ends[0]!.exit_code).toBe(0);
    expect(events[events.length - 1]).toEqual(ends[0]);
    expect(events.filter((event) => event.type === "unknown")).toHaveLength(1_019);
    // The registry record releases: no child of the session survives.
    await until("the registry release", () => recordEnded(rig) != null);
    expect(child.alive).toBe(false);
  }, 15_000);

  test("eight pending turn_completed events cannot starve the end event (al32)", async () => {
    // Correctness major 1's starvation, whole: under the al31 rule every
    // turn_completed rode the terminal lane, so eight completions queued
    // against a stalled sink filled the lane's fixed capacity exactly,
    // and the session_ended behind them was refused — the one event the
    // caller's teardown waits on, dropped while the queue still held
    // eight turn answers. Round al32 makes completions ordinary entries
    // (the lane is the session's end events alone), so the eight turns
    // sit far inside the ordinary bound and the idle stdin close's
    // session_ended rides the ordinary capacity still open to it. The
    // gate holds every line until the session has ended; the flush then
    // delivers all eight completions AND exactly one session_ended, the
    // last line — nothing dropped, nothing starved.
    const events: Event[] = [];
    let opened = false;
    const parked: Array<() => void> = [];
    const gatedSink = (line: string): Promise<void> | void => {
      events.push(JSON.parse(line) as Event);
      if (opened) return;
      return new Promise<void>((resolve) => parked.push(resolve));
    };
    const rig = await startRig(null, gatedSink);
    for (let turn = 0; turn < 8; turn++) {
      send(rig, `turn ${turn}`);
      const child = new FakeTurnProcess();
      rig.children.push(child);
      rig.spawn.settle(child);
      await Bun.sleep(5);
      child.die({ code: 0, signal: null }); // the turn completes, unconfirmed
      await Bun.sleep(5);
    }
    rig.driver.handleCallerEnd(); // the idle stdin-close end
    // The session ends while the gate still holds everything queued.
    await Bun.sleep(25);
    opened = true;
    for (const release of parked) release();
    const code = await Promise.race([
      rig.code,
      Bun.sleep(5_000).then(() => {
        throw new Error("run() never resolved after the gated flush");
      }),
    ]);
    expect(code).toBe(0);
    const completions = events.filter((event) => event.type === "turn_completed");
    expect(completions).toHaveLength(8); // room on the ordinary side: none dropped
    for (const completed of completions) {
      expect(["failed", "interrupted"]).toContain(completed.finish);
    }
    const ends = events.filter((event) => event.type === "session_ended");
    expect(ends).toHaveLength(1);
    expect(ends[0]!.reason).toBe("stdin-close");
    expect(ends[0]!.exit_code).toBe(0);
    expect(events[events.length - 1]).toEqual(ends[0]);
    await until("the registry release", () => recordEnded(rig) != null);
    for (const child of rig.children) {
      expect(child.alive).toBe(false);
    }
  }, 15_000);

  test("a second signal during the abandoned spawn's hold escalates onto the late child (al30)", async () => {
    // Edges major 3's scenario, driven whole: the first SIGTERM ends the
    // session with a killing end that abandons the in-flight spawn, so
    // `session_ended` lands while a child can still arrive. Before al30
    // the signal handlers came down at that point — the machine's
    // dispose_signals effect — and a second SIGINT/SIGTERM met the
    // DEFAULT disposition, which would kill codemux mid-hold. They stay
    // installed through the hold now, and the second signal escalates:
    // every child the driver still owns gets the group SIGKILL at once
    // (escalateStop), no grace, no diagnostic — the ended machine absorbs
    // any event shape. The late child ignores the hold's requestStop, so
    // the settle window is provably open when the second signal flies.
    const rig = await startRig(null);
    send(rig, "escalation scenario");
    // First signal: the killing end, the abandoned spawn, the hold.
    process.kill(process.pid, "SIGTERM");
    await until("the signal end", () =>
      rig.events.some((event) => event.type === "session_ended")
    );
    const ended = rig.events.find((event) => event.type === "session_ended");
    expect(ended?.reason).toBe("signal");
    expect(await rig.code).toBe(SESSION_SIGNAL_EXIT_CODE);
    expect(recordEnded(rig)).toBeNull(); // the hold keeps the record
    // The abandoned spawn lands late and survives its stop: the window.
    const late = new FakeTurnProcess();
    late.ignoreStop = true;
    rig.children.push(late);
    rig.spawn.settle(late);
    await until("the hold's stop asked", () => late.stopArmed);
    expect(late.alive).toBe(true); // it missed the SIGTERM — still ours
    // The second signal in that window: escalation, not default death
    // (the suite's swallow listener would mask that; the escalated flag
    // would not exist to set).
    process.kill(process.pid, "SIGTERM");
    await Bun.sleep(15);
    expect(late.escalated).toBe(true);
    // Nothing about the escalation reopened the ended machine.
    expect(rig.events.filter((event) => event.type === "session_ended")).toHaveLength(1);
    // The window closes the ordinary way: the child dies, the hold
    // settles, the record releases.
    late.die({ code: null, signal: "SIGKILL" });
    await until("the registry release", () => recordEnded(rig) != null);
  }, 15_000);

  test("a second signal before the abandoned spawn lands latches: the late child escalates on arrival (al31)", async () => {
    // Correctness major 3's window: the escalation can arrive while the
    // abandoned spawn is STILL in flight — no child exists yet, so
    // escalateStop's three arms all found null and the operator's
    // second signal was lost, leaving the late child the graceful
    // requestStop the abandoned end path owes instead of the SIGKILL
    // that was already asked for. The latch this test pins carries it:
    // settleChild reads it the moment the child exists and escalates.
    // The fake's escalateStop only flags (it sets no stopArmed, kills
    // nothing), so escalated true with stopArmed false is exactly the
    // latch consumed rather than a graceful stop; the test closes the
    // child the way the tree kill the flag stands in for would.
    const rig = await startRig(null);
    send(rig, "latch scenario");
    // First signal: the killing end abandons the in-flight spawn.
    process.kill(process.pid, "SIGTERM");
    await until("the signal end", () =>
      rig.events.some((event) => event.type === "session_ended")
    );
    expect(await rig.code).toBe(SESSION_SIGNAL_EXIT_CODE);
    expect(recordEnded(rig)).toBeNull(); // the hold keeps the record
    // The second signal while the spawn is still in flight: no child
    // exists for any of escalateStop's arms — the latch takes it.
    process.kill(process.pid, "SIGTERM");
    await Bun.sleep(15);
    // The late child arrives: the latch escalates on arrival.
    const late = new FakeTurnProcess();
    rig.children.push(late);
    rig.spawn.settle(late);
    await until("the late child escalated", () => late.escalated);
    expect(late.stopArmed).toBe(false); // no graceful stop was asked
    expect(late.alive).toBe(true); // the fake's escalate only flags
    // Nothing about the escalation reopened the ended machine.
    expect(rig.events.filter((event) => event.type === "session_ended")).toHaveLength(1);
    // The tree kill the escalation stands in for closes the window.
    late.die({ code: null, signal: "SIGKILL" });
    await until("the registry release", () => recordEnded(rig) != null);
  }, 15_000);

  test("two SIGTERMs in a row escalate the turn child exactly once (al33)", async () => {
    // Round al33, edges major 3: during an active turn the driver holds
    // one child under two aliases — activeChild and state.child — so
    // even a single escalation reached the same child twice, and two
    // second signals in a row twice more: duplicate tree SIGKILLs racing
    // each other. The driver escalates each distinct child once, and the
    // child's own escalateStop latches underneath (session/process.ts).
    const rig = await startRig(null);
    send(rig, "escalation scenario");
    // The turn child attaches and survives the stop's SIGTERM: the
    // drain's settle window stays open, exactly the window the second
    // signal escalates inside.
    const child = new FakeTurnProcess();
    child.ignoreStop = true;
    rig.children.push(child);
    rig.spawn.settle(child);
    await until("the turn opened", () =>
      rig.events.some((event) => event.type === "turn_started")
    );
    // The two SIGTERMs: the first starts the graceful end — the drain
    // asks the child to stop — and the second escalates, once.
    process.kill(process.pid, "SIGTERM");
    await until("the drain's stop asked", () => child.stopArmed);
    process.kill(process.pid, "SIGTERM");
    await Bun.sleep(15);
    expect(child.escalated).toBe(true);
    expect(child.escalationCount).toBe(1);
    // The window closes the ordinary way: the escalated tree kill ends
    // the child, the end completes with exactly one session_ended for
    // the signal that started it, and the record releases.
    child.die({ code: null, signal: "SIGKILL" });
    await until("the session ended", () =>
      rig.events.some((event) => event.type === "session_ended")
    );
    expect(
      rig.events.filter((event) => event.type === "session_ended")
    ).toHaveLength(1);
    await until("the registry release", () => recordEnded(rig) != null);
  }, 15_000);

  test("a stalled sink fed repeated invalid input cannot grow the queue without bound (al31)", async () => {
    // The narrowed lane's bound test: input acks are ordinary entries
    // now (round al31), so a caller that stops reading while its input
    // keeps arriving drops the acks once a bound trips instead of
    // queueing them forever — before al30 they rode the unbounded
    // terminal lane, and al30's own carve-out still never closed. The
    // gated sink parks every line until the session has ended, so the
    // queue holds everything: session_started (1) plus the first 1,023
    // rejected acks fill the ordinary bound's 1,024 entries exactly,
    // and the 1,024th invalid line's ack is the breach — the overflow
    // fatal fires once, every later ack is refused without re-firing,
    // and the killing end's fatal error and session_ended ride the
    // terminal lane's fixed capacity. Delivered after the gate opens:
    // at most the ordinary bound plus the lane's capacity, exactly one
    // session_ended, and nothing grows while the caller stays silent.
    const events: Event[] = [];
    let opened = false;
    const parked: Array<() => void> = [];
    const gatedSink = (line: string): Promise<void> | void => {
      events.push(JSON.parse(line) as Event);
      if (opened) return;
      return new Promise<void>((resolve) => parked.push(resolve));
    };
    const rig = await startRig(null, gatedSink);
    for (let i = 0; i < 2_000; i++) {
      rig.driver.handleCallerLine("this line is not json");
    }
    // The overflow ended the session while the gate still held every
    // line but the first — the parked sink delivers nothing to wait on,
    // so the end is observed where the al29 stopped-reader test
    // observed it: the registry record, which the end path releases
    // without the sink.
    await until("the overflow end", () => recordEnded(rig) != null);
    // The gate opens: the queue drains what it held and no more.
    opened = true;
    for (const release of parked) release();
    const code = await Promise.race([
      rig.code,
      Bun.sleep(5_000).then(() => {
        throw new Error("run() never resolved after the gated drain");
      }),
    ]);
    expect(code).toBe(1);
    // The bounds held: the ordinary bound's 1,024 entries (the
    // announcement plus 1,023 rejected acks) and the terminal lane's
    // fixed capacity — never the 2,000 lines the caller sent.
    const ends = events.filter((event) => event.type === "session_ended");
    expect(ends).toHaveLength(1);
    expect(ends[0]!.reason).toBe("crash");
    expect(events.length).toBeLessThanOrEqual(1_024 + TERMINAL_LANE_CAPACITY);
    expect(events.filter((event) => event.type === "input_rejected")).toHaveLength(1_023);
    expect(events[0]!.type).toBe("session_started");
    expect(events[events.length - 1]).toEqual(ends[0]);
    // And nothing more arrives after the drain.
    await Bun.sleep(50);
    expect(events.length).toBeLessThanOrEqual(1_024 + TERMINAL_LANE_CAPACITY);
  }, 15_000);

  test("a failed stdin close is a fatal: the end kills, no answer period (al30)", async () => {
    // Correctness major 3. The first stdin read error recorded the end
    // reason `stdin-close` — true, the channel did close — and the
    // shutdown classification read only the reason, so a FAILED close
    // took the graceful end: the answer period ran (graceOpen) while the
    // fatal had already closed the parse arm (fatalClosed), accepting
    // the drain's output nowhere while the child was given time to
    // answer. The killing path is the only one that matches a fatal: the
    // child is stopped at once. The fake survives a wait that never
    // comes — only requestStop ends it — so an end that arrives without
    // the test touching the child proves the answer period was skipped.
    const rig = await startRig(null);
    send(rig, "broken pipe");
    const child = new FakeTurnProcess();
    rig.children.push(child);
    rig.spawn.settle(child);
    await Bun.sleep(5);
    rig.driver.handleCallerEnd(new Error("read EPIPE"));
    // The killing stop arrives with no answer period in between.
    await until("the killing stop", () => !child.alive);
    await until("the end", () => rig.events.some((event) => event.type === "session_ended"));
    const ended = rig.events.find((event) => event.type === "session_ended");
    expect(ended?.reason).toBe("harness_failed");
    expect(ended?.exit_code).toBe(1); // a failed close, never the clean 0
    expect(await rig.code).toBe(1);
    // The fatal is the story the caller sees, and the open turn reads
    // failed — never an interrupted drain of output nobody accepts.
    const fatal = rig.events.find((event) => event.type === "error" && event.fatal === true);
    expect(fatal?.message).toContain("reading the caller's stdin failed");
    expect(fatal?.message).toContain("read EPIPE");
    const completed = rig.events.find((event) => event.type === "turn_completed");
    expect(completed?.finish).toBe("failed");
    await until("the registry release", () => recordEnded(rig) != null);
  }, 15_000);

  test("coded 143 and signal deaths during shutdown always fail (al41)", async () => {
    const rig = await startRig(null);
    send(rig, "coded stop death");
    const child = new FakeTurnProcess();
    child.codedStop = true; // kimi's real spelling: 143, no signal
    rig.children.push(child);
    rig.spawn.settle(child);
    await Bun.sleep(5);
    rig.driver.handleCallerEnd(); // graceful end: the drain is waiting
    await Bun.sleep(5);
    child.requestStop();
    await until("the end", () => rig.events.some((event) => event.type === "session_ended"));
    const ended = rig.events.find((event) => event.type === "session_ended");
    expect(ended?.reason).toBe("harness_failed");
    expect(await rig.code).toBe(1);
    expect(rig.events.find((event) => event.type === "error")?.fatal).toBe(true);
    const completed = rig.events.find((event) => event.type === "turn_completed");
    expect(completed?.finish).toBe("failed");
    await until("the registry release", () => recordEnded(rig) != null);

    // A signal exit with no cleanup attempt fails too.
    const other = await startRig(null);
    send(other, "external kill mid-drain");
    const victim = new FakeTurnProcess();
    other.children.push(victim);
    other.spawn.settle(victim);
    await Bun.sleep(5);
    other.driver.handleCallerEnd(); // the end path begins its drain
    await Bun.sleep(5);
    victim.die({ code: null, signal: "SIGKILL" }); // nobody here sent one
    await until("the crash end", () =>
      other.events.some((event) => event.type === "session_ended")
    );
    const fatal = other.events.find(
      (event) => event.type === "error" && event.fatal === true
    );
    expect(fatal?.message).toContain("exited with signal SIGKILL");
    expect(await other.code).toBe(1);
  }, 15_000);

  test("a delayed SIGTERM exit remains a failure after cleanup attempts (al41)", async () => {
    const rig = await startRig(null);
    send(rig, "delayed sigterm");
    const child = new FakeTurnProcess();
    rig.children.push(child);
    rig.spawn.settle(child);
    await Bun.sleep(5);
    rig.driver.handleCallerEnd();
    child.kill({ code: null, signal: "SIGTERM" });
    await until("cleanup attempted", () => child.stopArmed);
    child.die();
    expect(await rig.code).toBe(1);
    const ended = rig.events.find((event) => event.type === "session_ended");
    expect(ended?.reason).toBe("harness_failed");
    expect(ended?.shutdown_requested).toBe(true);
    expect(ended?.harness_exit).toEqual({ code: null, signal: "SIGTERM" });
    expect(rig.events.find((event) => event.type === "turn_completed")?.finish).toBe("failed");
  }, 15_000);

});

// --- the machine's turn-reply rule, probed purely ------------------------------

// The kimi wire's line spellings, shared by the reply-rule and tool-loop
// describes below (the grammar each probe builds its streams from).
const assistantText = (text: string): string =>
  JSON.stringify({ role: "assistant", content: text });
const assistantCall = (callId: string): string =>
  JSON.stringify({
    role: "assistant",
    tool_calls: [
      { type: "function", id: callId, function: { name: "read_file", arguments: "{}" } },
    ],
  });
const toolResult = (callId: string): string =>
  JSON.stringify({ role: "tool", tool_call_id: callId, content: "ok" });
const hintLine = (id: string): string =>
  JSON.stringify({
    role: "meta",
    type: "session.resume_hint",
    session_id: id,
    command: `kimi -r ${id}`,
    content: `To resume this session: kimi -r ${id}`,
  });

describe("kimi machine - the turn's reply rule (al34)", () => {
  const config = { authorPrefix: true, registryEnabled: false };

  /** One turn through the pure machine: open it, attach a child, feed
   * `lines`, then exit 0 — the verdict the exit's turn_completed emit
   * carries. Pure state-machine probes were how the review found the
   * two false-success shapes, so they are how the fix is pinned. */
  const runTurn = (
    lines: string[]
  ): { finish: "end" | "failed" | "interrupted"; reason?: string } => {
    const state = initialKimiState(null);
    step(state, { kind: "run_started" }, config);
    step(
      state,
      { kind: "user_input", line: JSON.stringify({ type: "user", text: "probe" }) },
      config
    );
    const child = new FakeTurnProcess();
    step(state, { kind: "spawn_settled", child }, config);
    for (const line of lines) step(state, { kind: "child_line", line }, config);
    const effects = step(
      state,
      { kind: "child_exit", child, outcome: { code: 0, signal: null } },
      config
    );
    const completed = effects.find(
      (effect): effect is Extract<
        KimiEffect,
        { kind: "emit"; event: "turn_completed" }
      > => effect.kind === "emit" && effect.event === "turn_completed"
    );
    if (completed === undefined) {
      throw new Error("the exit carried no turn_completed emit");
    }
    return { finish: completed.finish, reason: completed.reason };
  };

  test("a final assistant text after every tool result answers the turn", () => {
    const { finish } = runTurn([
      assistantText("let me look"),
      assistantCall("call-1"),
      toolResult("call-1"),
      assistantText("here is the answer"),
      hintLine(ID),
    ]);
    expect(finish).toBe("end");
  });

  test("a resolved tool loop with no final assistant reply fails the turn", () => {
    // Edges major 1, first shape: every call's result arrived, but no
    // final assistant text stands behind them — the old condition gated
    // on unresolved calls, so this turn read success at exit 0.
    const { finish, reason } = runTurn([
      assistantText("let me look"),
      assistantCall("call-1"),
      toolResult("call-1"),
      hintLine(ID),
    ]);
    expect(finish).toBe("failed");
    expect(reason).toBe(
      "the kimi process exited 0 with no final assistant reply after its tool results"
    );
  });

  test("an assistant reply while a tool call is still pending fails the turn", () => {
    // Edges major 1, second shape: text arrived while the call was
    // unanswered — mid-loop prose, not the answer. The old setter took
    // any text frame as the final reply, so the unresolved-calls clause
    // never fired and the turn read success at exit 0.
    const { finish, reason } = runTurn([
      assistantCall("call-1"),
      assistantText("still working"),
      hintLine(ID),
    ]);
    expect(finish).toBe("failed");
    expect(reason).toBe(
      "the kimi process exited 0 with 1 tool call that never received a result " +
        "and no final assistant reply"
    );
  });
});

// --- the tool loop's id grammar, keyed by the machine's own map (al35) -------

describe("kimi machine - the tool loop's id grammar (al35)", () => {
  const config = { authorPrefix: true, registryEnabled: false };

  /** One turn fed `lines` whose malformed shape raises the fatal itself:
   * the turn's completion comes from the end path's synthesis at
   * children_settled (the executor's delivery once every child of the end
   * settled), so the probe returns the fatal's own effects beside the
   * synthesized verdict. */
  const runMalformed = (
    lines: string[]
  ): {
    lineEffects: KimiEffect[];
    finish: "end" | "failed" | "interrupted";
    reason?: string;
  } => {
    const state = initialKimiState(null);
    step(state, { kind: "run_started" }, config);
    step(
      state,
      { kind: "user_input", line: JSON.stringify({ type: "user", text: "probe" }) },
      config
    );
    const child = new FakeTurnProcess();
    step(state, { kind: "spawn_settled", child }, config);
    const lineEffects: KimiEffect[] = [];
    for (const line of lines) {
      lineEffects.push(...step(state, { kind: "child_line", line }, config));
    }
    const settled = step(state, { kind: "children_settled" }, config);
    const completed = [...lineEffects, ...settled].find(
      (effect): effect is Extract<
        KimiEffect,
        { kind: "emit"; event: "turn_completed" }
      > => effect.kind === "emit" && effect.event === "turn_completed"
    );
    if (completed === undefined) {
      throw new Error("the end path carried no turn_completed emit");
    }
    return { lineEffects, finish: completed.finish, reason: completed.reason };
  };

  /** The fatal error effect the malformed loop raised, if any. */
  const fatalError = (
    effects: KimiEffect[]
  ): Extract<KimiEffect, { kind: "error" }> | undefined =>
    effects.find(
      (effect): effect is Extract<KimiEffect, { kind: "error" }> =>
        effect.kind === "error" && effect.fatal
    );

  test("a repeated tool call id is a grammar error, never a stacked call", () => {
    // Correctness major 3, first shape: the loop keys calls by id, so one
    // id names exactly one open call — a harness repeating it cannot say
    // which result answers which call. The old set-difference bookkeeping
    // let the duplicate stack silently; the session now fails on the
    // grammar error, the raw line still goes out, and the turn's
    // completion is the end path's failed synthesis.
    const { lineEffects, finish, reason } = runMalformed([
      assistantCall("call-1"),
      assistantCall("call-1"),
    ]);
    const error = fatalError(lineEffects);
    expect(error).toBeDefined();
    expect(error!.source).toBe("harness");
    expect(error!.message).toContain("repeated the tool call id call-1");
    expect(finish).toBe("failed");
    expect(reason).toContain("repeated the tool call id call-1");
  });

  test("a tool call id cannot be reused after its result in the same turn (al39)", () => {
    const { lineEffects, finish, reason } = runMalformed([
      assistantCall("call-1"),
      toolResult("call-1"),
      assistantCall("call-1"),
    ]);
    expect(fatalError(lineEffects)?.message).toContain("repeated the tool call id call-1");
    expect(lineEffects.filter((effect) => effect.kind === "emit" && effect.event === "tool_call"))
      .toHaveLength(1);
    expect(finish).toBe("failed");
    expect(reason).toContain("repeated the tool call id call-1");
  });

  test("a tool result for an id the loop never opened is a grammar error", () => {
    // Correctness major 3, second shape: a result for an unknown id has
    // no call to answer — the old bookkeeping dropped it into the set
    // difference and the loop read resolved when it was not.
    const { lineEffects, finish } = runMalformed([toolResult("call-9")]);
    const error = fatalError(lineEffects);
    expect(error).toBeDefined();
    expect(error!.message).toContain(
      "the call id call-9 the loop never opened, or one it already answered"
    );
    expect(finish).toBe("failed");
  });

  test("a second result for one call is a grammar error, never a resolved loop", () => {
    // Correctness major 3, third shape: the result arriving twice is the
    // mirror of the unknown id — one call, two answers — and the map's
    // keying fails it the same way instead of letting the loop close
    // early behind a duplicate the harness may replay.
    const { lineEffects, finish } = runMalformed([
      assistantCall("call-1"),
      toolResult("call-1"),
      toolResult("call-1"),
    ]);
    const error = fatalError(lineEffects);
    expect(error).toBeDefined();
    expect(error!.message).toContain(
      "the call id call-1 the loop never opened, or one it already answered"
    );
    expect(finish).toBe("failed");
  });
});

// --- the defensive spawn_settled arm declares its hold (al35) ----------------

describe("kimi machine - every spawn abandonment declares hold_release (al35)", () => {
  const config = { authorPrefix: true, registryEnabled: false };

  test("the ending-phase spawn_settled arm stops the child and declares the hold", () => {
    // Contracts-2 minor: the arm that abandons an in-flight spawn when
    // the end path had already passed its waits was the only abandonment
    // without a hold_release effect — the effect union's own contract
    // says an abandoned spawn comes with one, and a consumer tracking
    // holds from the effect stream would have missed this one. The arm
    // is defensive (the grace arm awaits the spawn, the killing arm
    // abandons it earlier), so the state is forced to the shape it
    // guards: phase `ending`, spawn still in flight, not yet abandoned.
    const state = initialKimiState(null);
    step(state, { kind: "run_started" }, config);
    step(
      state,
      { kind: "user_input", line: JSON.stringify({ type: "user", text: "probe" }) },
      config
    );
    state.phase = "ending"; // the forced defensive shape
    const child = new FakeTurnProcess();
    const effects = step(state, { kind: "spawn_settled", child }, config);
    expect(effects).toEqual([
      { kind: "stop_child", child },
      { kind: "hold_release" },
    ]);
    expect(state.spawnAbandoned).toBe(true);
    expect(state.spawnInFlight).toBe(false);
  });
});

// --- the machine's ended-absorbs rule, counted --------------------------------

describe("kimi machine - ended absorbs and counts", () => {
  test("every event in ended is ignored and counted, and nothing is emitted", () => {
    const config = { authorPrefix: true, registryEnabled: false };
    const state = initialKimiState(null);
    const fatal: KimiEvent = {
      kind: "fatal",
      source: "codemux",
      message: "the outbound queue failed",
    };
    step(state, fatal, config); // the first cause
    step(state, { kind: "children_settled" }, config); // the executor's tail
    expect(state.phase).toBe("ended");
    const stray: TurnChild = new FakeTurnProcess();
    const after: KimiEvent[] = [
      { kind: "run_started" },
      { kind: "user_input", line: JSON.stringify({ type: "user", text: "late" }) },
      { kind: "spawn_settled", child: stray },
      { kind: "spawn_failed", error: new Error("late") },
      { kind: "child_line", line: "not json" },
      { kind: "child_exit", child: stray, outcome: { code: 0, signal: null } },
      { kind: "stdin_eof" },
      { kind: "signal" },
      { kind: "session_timeout" },
      fatal,
      { kind: "registry_error", message: "late" },
      { kind: "record_outcome", ok: true },
      { kind: "children_settled" }, // the once-only transition, again
    ];
    const ignoredBefore = state.end.ignored;
    for (const event of after) {
      expect(step(state, event, config)).toEqual([]);
    }
    expect(state.end.ignored).toBe(ignoredBefore + after.length);
  });
});
