/**
 * Kimi lifecycle interleavings, signals and end failures: the second
 * signal's escalation onto the abandoned spawn's late child, the
 * stalled-sink bound, and the coded and signal deaths during shutdown.
 * Split from tests/session-kimi-interleavings.test.ts; the rig is
 * tests/helpers/session-kimi-interleavings.ts.
 */

import { afterAll, describe, expect, test } from "bun:test";
import {
  SESSION_SIGNAL_EXIT_CODE,
  TERMINAL_LANE_CAPACITY,
} from "../src/session/process.js";
import {
  armSignalSwallow,
  drainRig,
  type Event,
  FakeTurnProcess,
  recordEnded,
  send,
  startRig,
  until,
} from "./helpers/session-kimi-interleavings.js";

armSignalSwallow();
afterAll(drainRig);

describe("kimi session interleavings (round al28)", () => {
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
    await until("the escalation onto the late child", () => late.escalated);
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
    await until("the escalation onto the turn child", () => child.escalated);
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
