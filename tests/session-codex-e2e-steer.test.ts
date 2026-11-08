/**
 * The steer batching probe's work bound (review round 341): flushSteer
 * counts batch bytes incrementally — one serialization per text — instead
 * of re-serializing the whole batch per increment, which was quadratic up
 * to the 256-line / 32 MiB buffer caps and stalled harness reads in one
 * synchronous block. Split from tests/session-codex-e2e-turns.test.ts at
 * the 500-line cap.
 */
import { afterAll, describe, expect, spyOn, test } from "bun:test";
import {
  cleanupMark,
  cleanupSessions,
  cleanupSessionsSince,
  fakeRecord,
  send,
  startAndWait,
  waitForRecord,
} from "./session-codex-e2e-helpers.js";
import { registerNoLeakedSignals } from "./helpers/signal-listeners.js";

afterAll(cleanupSessions);
registerNoLeakedSignals(cleanupSessionsSince, cleanupMark);

describe("codex session e2e - steer batching work (round 341)", () => {
  test("the batching probe serializes one text at a time, never the batch per increment", async () => {
    // 128 steers of ~4 KiB buffer behind a delayed turn/start response,
    // exactly the window the batched flush exists for. Measured across
    // the window: a JSON.stringify call whose result spans more than one
    // steer text is a whole-batch serialization. With the incremental
    // count there are exactly two — the one frame flushSteer sends, and
    // the assistant_message echo event the fake's reply produces — plus
    // slack for a second echo. The pre-fix probe rebuilt the batch's
    // serialization for every prefix (~126 more whole-batch calls here,
    // ~34 MB of transient strings in one synchronous block on the
    // harness-output path).
    const steers = 128;
    const size = 4096;
    const text = (index: number) => `${index.toString().padStart(4, "0")} ${"s".repeat(size)}`;
    const session = await startAndWait({}, { FAKE_TURNSTART_DELAY: "250" });
    send(session.driver, { type: "user", text: "scenario:wait held" });
    let wholeBatch = 0;
    const stringify = JSON.stringify;
    const spy = spyOn(JSON, "stringify").mockImplementation(
      ((...args: unknown[]) => {
        const result = stringify(...(args as Parameters<typeof JSON.stringify>));
        if (result.length > 2 * (size + 64)) wholeBatch += 1;
        return result;
      }) as typeof JSON.stringify
    );
    try {
      for (let index = 0; index < steers; index++) {
        send(session.driver, { type: "steer", text: text(index) });
      }
      // The response lands, the batched frame is written, and the fake
      // reads it: the whole flush happens inside the measured window.
      await waitForRecord(session, "steers.jsonl", 1, 10_000);
    } finally {
      spy.mockRestore();
    }
    expect(wholeBatch).toBeLessThanOrEqual(4);
    // The batch itself happened: one turn/steer frame of all 128 texts,
    // all under the write cap.
    const records = fakeRecord(session, "steers.jsonl");
    expect(records).toHaveLength(1);
    expect(records[0]!.texts).toHaveLength(steers);
    send(session.driver, { type: "shutdown" });
    expect(await session.code).toBe(0);
  });
});
