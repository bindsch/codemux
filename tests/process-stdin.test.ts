/**
 * Stdin delivery tracking (src/process-stdin.ts, review rounds 65 to 67):
 * late rejections, writes added after the wait began, writes issued after
 * the child exited, and the precedence of an earlier failure.
 */
import { expect, test } from "bun:test";
import { trackStdinDelivery } from "../src/process-stdin.js";

const make = (exited: Promise<unknown>, superseded = () => false) => {
  const aborts: number[] = [];
  const delivery = trackStdinDelivery({ exited, superseded, abort: () => { aborts.push(1); } });
  return { delivery, aborts };
};

test("a write that rejects while the child lives fails the delivery and stops the child", async () => {
  const { delivery, aborts } = make(new Promise(() => {}));
  delivery.track(Promise.reject(new Error("EPIPE")));
  await delivery.settled();
  expect(delivery.failed()).toBe(true);
  expect((delivery.error() as Error).message).toBe("EPIPE");
  expect(aborts).toHaveLength(1);
});

test("a write added after the wait began is still awaited (review round 67)", async () => {
  // Protocol sinks keep writing while the child runs: the wait follows
  // the chain, so a later write's rejection is not lost.
  const { delivery } = make(new Promise(() => {}));
  delivery.track(Bun.sleep(20).then(() => 1));
  const wait = delivery.settled();
  await Bun.sleep(5);
  delivery.track(Bun.sleep(30).then(() => { throw new Error("late EPIPE"); }));
  await wait;
  expect(delivery.failed()).toBe(true);
  expect((delivery.error() as Error).message).toBe("late EPIPE");
});

test("a write issued after the child exited never fails the delivery", async () => {
  const { delivery, aborts } = make(Promise.resolve(0));
  await Bun.sleep(1);
  delivery.track(Promise.reject(new Error("nothing to reach")));
  await delivery.settled();
  expect(delivery.failed()).toBe(false);
  expect(aborts).toHaveLength(0);
});

test("a write issued before the exit counts even when it rejects after it (review round 66)", async () => {
  let exit!: () => void;
  const exited = new Promise<void>((resolve) => { exit = resolve; });
  const { delivery, aborts } = make(exited);
  delivery.track(Bun.sleep(20).then(() => { throw new Error("EPIPE after exit"); }));
  exit();
  await delivery.settled();
  expect(delivery.failed()).toBe(true);
  // The child was gone by then: nothing to stop.
  expect(aborts).toHaveLength(0);
});

test("a rejection after a capture failure, timeout, or signal never becomes the diagnosis", async () => {
  const { delivery, aborts } = make(new Promise(() => {}), () => true);
  delivery.track(Promise.reject(new Error("secondary EPIPE")));
  await delivery.settled();
  expect(delivery.failed()).toBe(false);
  expect(aborts).toHaveLength(0);
});

test("a synchronous result is final", async () => {
  const { delivery } = make(new Promise(() => {}));
  delivery.track(5);
  await delivery.settled();
  expect(delivery.failed()).toBe(false);
});

test("attempt() tracks a synchronous throw like a rejection (review round 71)", async () => {
  const { delivery, aborts } = make(new Promise(() => {}));
  expect(() => delivery.attempt(() => { throw new Error("sync EPIPE"); })).not.toThrow();
  await delivery.settled();
  expect(delivery.failed()).toBe(true);
  expect((delivery.error() as Error).message).toBe("sync EPIPE");
  expect(aborts).toHaveLength(1);
});
