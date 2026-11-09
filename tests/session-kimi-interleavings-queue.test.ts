/**
 * Kimi lifecycle interleavings, queue bounds and pending exits: the
 * overflow that parks behind an effect list, the ledger's final-record
 * rules, and the exits that land while a stop is in flight. Split from
 * tests/session-kimi-interleavings.test.ts; the rig is
 * tests/helpers/session-kimi-interleavings.ts.
 */

import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { initialKimiState, step } from "../src/session/kimi-machine.js";
import { emptyUsage } from "../src/result-envelope.js";
import {
  BoundedOutboundQueue,
  SessionProcess,
  TERMINAL_LANE_CAPACITY,
} from "../src/session/process.js";
import {
  armSignalSwallow,
  assistantText,
  drainRig,
  FakeTurnProcess,
  hintLine,
  ID,
  recordEnded,
  send,
  startRig,
  type Event,
  until,
  workRoot,
} from "./helpers/session-kimi-interleavings.js";

armSignalSwallow();
afterAll(drainRig);

describe("kimi session interleavings (round al28)", () => {
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
        Bun.sleep(12_000).then(() => {
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

      const effects = step(state, { kind: "child_exit", child, outcome, usage: emptyUsage() }, config);
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
});
