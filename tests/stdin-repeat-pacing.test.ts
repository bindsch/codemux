/**
 * The repeating stdin feeder is paced and survives a closed sink (review
 * round 153, found reading the fix). Three cases, on both carriers where
 * they apply:
 *
 * - a sink that takes every write at once (a child draining stdin as fast
 *   as it is written) used to keep the feeder in a loop of synchronous
 *   writes that never returned to the event loop, so the run's timeout
 *   and its signal handling stopped;
 * - Bun answers a write to a sink it already closed (the child exited)
 *   with a boolean, and the run path called `.then` on it: an unhandled
 *   rejection;
 * - a real child that discards its stdin must still meet the run's
 *   timeout;
 * - a first write that is pending behind backpressure counts toward the
 *   one-block-in-flight bound: no repeat until it drains (review round
 *   154).
 */
import { expect, test } from "bun:test";
import {
  RepeatPacer,
  sinkWriteState,
  startRepeatingStdin,
} from "../src/process-stdin-repeat.js";
import { runCapturedCommand } from "../src/process-runner.js";
import { SessionWriter } from "../src/session/stdin-writer.js";

/** Past this many writes the fake sink throws: the unpaced loop ends on
 * it (the throw is a synchronous write failure) and the count shows it
 * ran away, where a hang would only time the test out. */
const RUNAWAY_WRITES = 5000;

function exitAfter(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("sinkWriteState: a byte count flushed, a promise is pending, a boolean is a closed sink", () => {
  expect(sinkWriteState(128)).toBe("flushed");
  expect(sinkWriteState(0)).toBe("flushed");
  expect(sinkWriteState(Promise.resolve(128))).toBe("pending");
  expect(sinkWriteState(true)).toBe("closed");
  expect(sinkWriteState(false)).toBe("closed");
  expect(sinkWriteState(undefined)).toBe("closed");
});

test("run path: a sink that takes every write at once gets one block per pause, not a runaway loop", async () => {
  let writes = 0;
  let ends = 0;
  const sink = {
    write(): number {
      writes += 1;
      if (writes > RUNAWAY_WRITES) throw new Error("runaway feeder");
      return 128;
    },
    end(): number {
      ends += 1;
      return 0;
    },
  };
  const exited = exitAfter(120);
  let timerRan = false;
  setTimeout(() => { timerRan = true; }, 20);
  startRepeatingStdin("n\n", sink, exited, () => {}, 10);
  await exited;
  await Bun.sleep(30);
  // The event loop kept running, and 120 ms of 10 ms pauses is about a
  // dozen blocks: the bound leaves room for a slow host, never for the
  // thousands an unpaced loop writes.
  expect(timerRan).toBe(true);
  expect(writes).toBeGreaterThanOrEqual(2);
  expect(writes).toBeLessThan(60);
  const settled = writes;
  await Bun.sleep(40);
  // The exit stopped the feeder, and it released its end of the pipe.
  expect(writes).toBe(settled);
  expect(ends).toBe(1);
});

test("run path: a closed sink's boolean answer ends the feeder without an unhandled rejection", async () => {
  const answers: unknown[] = [128, 128, true];
  let writes = 0;
  let ends = 0;
  const sink = {
    write(): unknown {
      writes += 1;
      return answers.shift() ?? true;
    },
    end(): number {
      ends += 1;
      return 0;
    },
  };
  // The child never "exits" here: only the sink's answer can stop the
  // feeder. bun fails the test on an unhandled rejection.
  startRepeatingStdin("n\n", sink, new Promise(() => {}), () => {}, 5);
  await Bun.sleep(80);
  expect(writes).toBe(3);
  expect(ends).toBe(1);
});

test("run path: a rejected pending write ends the feeder and is consumed", async () => {
  let writes = 0;
  let ends = 0;
  const sink = {
    write(): unknown {
      writes += 1;
      return writes === 1 ? 128 : Promise.reject(new Error("EPIPE: broken pipe, write"));
    },
    end(): Promise<number> {
      ends += 1;
      return Promise.reject(new Error("EPIPE: broken pipe, write"));
    },
  };
  startRepeatingStdin("n\n", sink, new Promise(() => {}), () => {}, 5);
  await Bun.sleep(60);
  expect(writes).toBe(2);
  expect(ends).toBe(1);
});

test("RepeatPacer: the exit ends a pause and a drain wait early", async () => {
  let exit!: () => void;
  const pacer = new RepeatPacer(new Promise<void>((resolve) => { exit = resolve; }), 10_000);
  const pause = pacer.pause();
  exit();
  expect(await pause).toBe(false);
  expect(await pacer.pause()).toBe(false);
  expect(await pacer.drained(new Promise(() => {}))).toBe(false);
});

test("session path: a sink that takes every write at once gets one block per pause, then the pipe is released", async () => {
  let writes = 0;
  let ends = 0;
  const proc = {
    stdin: {
      write(): number {
        writes += 1;
        if (writes > RUNAWAY_WRITES) throw new Error("runaway feeder");
        return 128;
      },
      end(): number {
        ends += 1;
        return 0;
      },
    },
  } as unknown as ReturnType<typeof Bun.spawn>;
  const writer = new SessionWriter(proc);
  const exited = exitAfter(120);
  expect(writer.repeatRawUntilExit("n\n", exited)).toEqual({ ok: true });
  await exited;
  await Bun.sleep(30);
  expect(writes).toBeGreaterThanOrEqual(2);
  expect(writes).toBeLessThan(60);
  expect(ends).toBe(1);
  // The feeder half-closed stdin when the child exited: a later write is
  // refused as closed, never sent into a dead pipe.
  expect(writer.writeRaw("n\n")).toEqual({ ok: false, reason: "closed" });
});

test("session path: a closed sink's boolean answer is a refused write", () => {
  const proc = {
    stdin: { write: (): boolean => true, end: (): number => 0 },
  } as unknown as ReturnType<typeof Bun.spawn>;
  const writer = new SessionWriter(proc);
  expect(writer.writeRaw("n\n")).toEqual({ ok: false, reason: "closed" });
  expect(writer.writeLine("n")).toEqual({ ok: false, reason: "closed" });
});

test("a real child that discards its stdin still meets the run's timeout", async () => {
  const started = Date.now();
  const result = await runCapturedCommand(["/bin/sh", "-c", "cat > /dev/null"], {
    cwd: process.cwd(),
    env: { PATH: "/usr/bin:/bin" },
    stdinInput: "n\n".repeat(64),
    stdinRepeats: true,
    timeoutMs: 400,
  });
  // 124 is the runner's timeout exit code.
  expect(result.exitCode).toBe(124);
  expect(result.stderr).toContain("agent timed out after 400ms");
  expect(Date.now() - started).toBeLessThan(15_000);
}, 30_000);

test("run path: no repeat is issued while the first write is still pending", async () => {
  let writes = 0;
  let release!: () => void;
  const firstDrain = new Promise<void>((resolve) => { release = resolve; });
  const sink = {
    write(): unknown {
      writes += 1;
      return writes === 1 ? firstDrain : 128;
    },
    end: (): number => 0,
  };
  startRepeatingStdin("n\n", sink, new Promise(() => {}), () => {}, 5);
  await Bun.sleep(60);
  expect(writes).toBe(1);
  release();
  await Bun.sleep(60);
  expect(writes).toBeGreaterThanOrEqual(2);
});

test("session path: no repeat is issued while the first write is still pending", async () => {
  let writes = 0;
  let release!: () => void;
  const firstDrain = new Promise<void>((resolve) => { release = resolve; });
  const proc = {
    stdin: {
      write(): unknown {
        writes += 1;
        return writes === 1 ? firstDrain : 128;
      },
      end: (): number => 0,
    },
  } as unknown as ReturnType<typeof Bun.spawn>;
  const writer = new SessionWriter(proc);
  let exit!: () => void;
  const exited = new Promise<void>((resolve) => { exit = resolve; });
  expect(writer.repeatRawUntilExit("n\n", exited)).toEqual({ ok: true });
  await Bun.sleep(60);
  expect(writes).toBe(1);
  release();
  await Bun.sleep(60);
  expect(writes).toBeGreaterThanOrEqual(2);
  exit();
  await Bun.sleep(30);
  const settled = writes;
  await Bun.sleep(40);
  expect(writes).toBe(settled);
});
