import { describe, expect, test } from "bun:test";
import {
  awaitFinalFlush,
  BoundedOutboundQueue,
  TERMINAL_LANE_CAPACITY,
} from "../src/session/process.js";
import type { OutboundFailure } from "../src/session/process-outbound.js";
import { waitUntil } from "./helpers/session-process.js";

describe("bounded outbound queue", () => {
  test("delivers entries to the sink in order and flushes", async () => {
    const delivered: string[] = [];
    const queue = new BoundedOutboundQueue(
      async (line) => {
        await Bun.sleep(2);
        delivered.push(line);
      },
      () => {}
    );
    for (const word of ["a", "b", "c", "d", "e"]) {
      expect(queue.enqueue(word)).toBe(true);
    }
    await queue.flush();
    expect(delivered).toEqual(["a", "b", "c", "d", "e"]);
    expect(queue.pending.events).toBe(0);
  });

  test("a stopped reader trips the event bound and reports the overflow", async () => {
    const overflows: unknown[] = [];
    const queue = new BoundedOutboundQueue(
      () => new Promise<void>(() => {}),
      (overflow) => overflows.push(overflow),
      { events: 3 }
    );
    expect(queue.enqueue("one")).toBe(true);
    expect(queue.enqueue("two")).toBe(true);
    expect(queue.enqueue("three")).toBe(true);
    expect(queue.enqueue("four")).toBe(false);
    expect(overflows).toHaveLength(1);
    expect((overflows[0] as { events: number }).events).toBe(4);
  });

  test("the overflow class latches too: harness lines after the first breach cannot re-fire it", async () => {
    // The drivers keep enqueueing while harness lines arrive; an unlatched
    // overflow re-reported the diagnostic per line. Like the sink class,
    // the class fires exactly once.
    const overflows: unknown[] = [];
    const queue = new BoundedOutboundQueue(
      () => new Promise<void>(() => {}),
      (overflow) => overflows.push(overflow),
      { events: 2 }
    );
    expect(queue.enqueue("one")).toBe(true);
    expect(queue.enqueue("two")).toBe(true);
    for (const line of ["three", "four", "five", "six"]) {
      expect(queue.enqueue(line)).toBe(false);
    }
    expect(overflows).toHaveLength(1);
  });

  test("an overflow is sticky: ordinary events stay refused after a drain, the end event still delivers (round 100)", async () => {
    const overflows: unknown[] = [];
    let openGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    const delivered: string[] = [];
    const queue = new BoundedOutboundQueue(
      async (line) => {
        await gate;
        delivered.push(line);
      },
      (overflow) => overflows.push(overflow),
      { events: 2 }
    );
    expect(queue.enqueue("one")).toBe(true);
    expect(queue.enqueue("two")).toBe(true);
    expect(queue.enqueue("three")).toBe(false);
    expect(overflows).toHaveLength(1);
    // The sink drains every queued entry; the freed capacity must not
    // resume ordinary delivery after the acknowledged gap.
    openGate();
    await queue.flush();
    expect(delivered).toEqual(["one", "two"]);
    expect(queue.pending.events).toBe(0);
    expect(queue.enqueue("after-drain")).toBe(false);
    // `terminal: false` spells an ordinary event too (review round 102).
    expect(queue.enqueue("explicit-ordinary", { terminal: false })).toBe(false);
    expect(overflows).toHaveLength(1);
    // The terminal classes the overflow path needs still queue and
    // deliver, the end event above all.
    expect(queue.enqueue("fatal notice", { terminal: "fatal" })).toBe(true);
    expect(queue.enqueue("session_ended", { terminal: true })).toBe(true);
    await queue.flush();
    expect(delivered).toEqual(["one", "two", "fatal notice", "session_ended"]);
  });

  test("the byte bound counts UTF-8 bytes plus the newline", async () => {
    const overflows: unknown[] = [];
    const queue = new BoundedOutboundQueue(
      () => new Promise<void>(() => {}),
      (overflow) => overflows.push(overflow),
      { bytes: 10 }
    );
    // "aaaaé" is 6 bytes + 1 newline = 7.
    expect(queue.enqueue("aaaaé")).toBe(true);
    // "bbb" is 3 + 1 = 4; 7 + 4 > 10.
    expect(queue.enqueue("bbb")).toBe(false);
    expect(overflows).toHaveLength(1);
    expect((overflows[0] as { bytes: number }).bytes).toBe(11);
  });

  test("the terminal lane splits its classes: fatals cap one short, and session_ended's slot survives a fatal flood (al35)", async () => {
    // Round al35 (edges major 4): fatal-class entries and session_ended
    // shared one undifferentiated lane count, so eight queued fatals
    // refused the end event behind them — the lane exists to keep that
    // one slot reachable. A fatal may occupy at most
    // TERMINAL_LANE_CAPACITY - 1 slots; the end event's cap is the full
    // lane. The overflow callback still fires exactly once for the
    // refusal class.
    const overflows: unknown[] = [];
    let openGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    const delivered: string[] = [];
    const queue = new BoundedOutboundQueue(
      async (line) => {
        await gate;
        delivered.push(line);
      },
      (overflow) => overflows.push(overflow),
      { events: 3 }
    );
    // Ordinary entries fill the ordinary bound first.
    for (const word of ["e1", "e2", "e3"]) {
      expect(queue.enqueue(word)).toBe(true);
    }
    // Seven fatal-class entries ride the lane past the full ordinary
    // bound; the eighth is refused — the last slot is not a fatal's.
    for (let index = 1; index <= TERMINAL_LANE_CAPACITY - 1; index++) {
      expect(queue.enqueue(`fatal ${index}`, { terminal: "fatal" })).toBe(true);
    }
    expect(queue.enqueue("fatal 8", { terminal: "fatal" })).toBe(false);
    expect(overflows).toHaveLength(1);
    expect((overflows[0] as { kind: string }).kind).toBe("overflow");
    // The end event still takes its slot behind the fatal flood, and an
    // ordinary entry behind the full bounds is still refused.
    expect(queue.enqueue("session_ended", { terminal: true })).toBe(true);
    expect(queue.enqueue("late ordinary")).toBe(false);
    expect(overflows).toHaveLength(1);
    // Delivery is in arrival order with the end event last.
    openGate();
    await queue.flush();
    expect(delivered).toEqual([
      "e1",
      "e2",
      "e3",
      "fatal 1",
      "fatal 2",
      "fatal 3",
      "fatal 4",
      "fatal 5",
      "fatal 6",
      "fatal 7",
      "session_ended",
    ]);
    expect(queue.pending.events).toBe(0);
    // A terminal entry with ordinary room left takes the ordinary
    // capacity first (its bytes count, and it cannot be starved by other
    // ordinary entries any more than they can starve the end event's
    // lane fallback).
    const roomy = new BoundedOutboundQueue(
      () => {},
      () => {}
    );
    expect(roomy.enqueue("session_ended", { terminal: true })).toBe(true);
    expect(roomy.pending.events).toBe(1);
    expect(roomy.pending.bytes).toBe("session_ended".length + 1);
  });

  test("a failing sink poisons the queue: the failure is reported once, enqueue refuses, flush rejects", async () => {
    const failures: { kind: string; error?: unknown }[] = [];
    const queue = new BoundedOutboundQueue(
      () => {
        throw new Error("sink broke");
      },
      (failure) => failures.push(failure)
    );
    expect(queue.enqueue("line")).toBe(true);
    // The failure record is the observable: fail() latches the poison and
    // drops the entries before it fires, so the refusal below cannot race
    // the async drain.
    await waitUntil(() => failures.length === 1, 5_000);
    expect(queue.enqueue("later")).toBe(false);
    // The sink failure reached the callback exactly once, with its class
    // and the error — silently disabling delivery is the defect this
    // pins (a dead sink must be as loud as an overrun bound).
    expect(failures).toHaveLength(1);
    expect(failures[0]?.kind).toBe("sink");
    expect((failures[0]?.error as Error).message).toBe("sink broke");
    expect(queue.enqueue("again")).toBe(false);
    expect(failures).toHaveLength(1);
    await expect(queue.flush()).rejects.toThrow("sink broke");
  });

  test("a sink that rejects with null still poisons the queue (review round 64)", async () => {
    // `null` is a legal rejection value and doubled as the queue's "no
    // error" marker: after Promise.reject(null), later entries stayed
    // accepted and flush() resolved — a final session event reported
    // delivered by a sink that refused it. A distinct sentinel carries
    // the no-error state now, so the null rejection latches like any
    // other failure.
    const failures: { kind: string; error?: unknown }[] = [];
    const queue = new BoundedOutboundQueue(
      () => Promise.reject(null),
      (failure) => failures.push(failure)
    );
    expect(queue.enqueue("final")).toBe(true);
    await waitUntil(() => failures.length === 1, 5_000);
    expect(queue.enqueue("later")).toBe(false);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.kind).toBe("sink");
    expect(failures[0]?.error).toBeNull();
    await expect(queue.flush()).rejects.toBe(null);
  });

  test("abandon drops the entries and releases a flush waiting on a stalled sink", async () => {
    // Review live3, correctness 1: a sink that neither resolves nor
    // throws left flush()'s poll loop spinning forever. abandon() is the
    // give-up's release valve — flush() resolves, pending empties, and
    // further enqueues refuse — so the driver's end path can report the
    // final event undelivered and still finish.
    const queue = new BoundedOutboundQueue(
      () => new Promise<void>(() => {}),
      () => {}
    );
    expect(queue.enqueue("final")).toBe(true);
    await Bun.sleep(10);
    expect(queue.pending.events).toBe(1);
    queue.abandon();
    expect(queue.pending.events).toBe(0);
    expect(queue.pending.bytes).toBe(0);
    // The stalled flush resolves instead of hanging.
    await queue.flush();
    expect(queue.enqueue("after")).toBe(false);
    // Idempotent: a second abandon changes nothing.
    queue.abandon();
    await queue.flush();
  });

  test("a sink that settles after abandon changes no accounting and reports no failure", async () => {
    // Review round 108: abandon() cleared the accounting, and the flush
    // loop then subtracted the in-flight entry on a late resolve (pending
    // bytes went negative) or called the failure callback on a late
    // reject, which every driver treats as a new fatal end.
    for (const outcome of ["resolve", "reject"] as const) {
      let settle: () => void = () => {};
      const failures: OutboundFailure[] = [];
      const queue = new BoundedOutboundQueue(
        () =>
          new Promise<void>((resolve, reject) => {
            settle = outcome === "resolve" ? resolve : () => reject(new Error("late"));
          }),
        (failure) => failures.push(failure)
      );
      expect(queue.enqueue("final")).toBe(true);
      await Bun.sleep(5);
      queue.abandon();
      settle();
      await Bun.sleep(5);
      expect(queue.pending).toEqual({ events: 0, bytes: 0 });
      expect(failures).toEqual([]);
      await queue.flush();
      expect(queue.enqueue("after")).toBe(false);
    }
  });

  test("awaitFinalFlush reports a stalled final flush as undelivered, a completed one as delivered", async () => {
    const stalled = new BoundedOutboundQueue(
      () => new Promise<void>(() => {}),
      () => {}
    );
    stalled.enqueue("final");
    const startedAt = Date.now();
    expect(await awaitFinalFlush(stalled, 50)).toBe(false);
    // Bounded by the give-up, not by the sink.
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    const completed: string[] = [];
    const healthy = new BoundedOutboundQueue(
      (line) => {
        completed.push(line);
      },
      () => {}
    );
    healthy.enqueue("final");
    expect(await awaitFinalFlush(healthy, 1_000)).toBe(true);
    expect(completed).toEqual(["final"]);
    const broke = new BoundedOutboundQueue(
      () => {
        throw new Error("sink broke");
      },
      () => {}
    );
    broke.enqueue("final");
    expect(await awaitFinalFlush(broke, 1_000)).toBe(false);
  });
});
