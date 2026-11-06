// The repeating stdin mode for a captured run whose canned stdin answer
// must never run out (review round 153): aider reads EOF as acceptance of
// its yes-default prompts, so while the child is alive a read of its stdin
// must always return a decline and never EOF. See the adapter's
// `stdinRepeats` (src/adapters/base.ts) for who turns this on.

/** The slice of a Bun subprocess the repeater writes through. Bun's sink
 * answers a write with the byte count when it flushed at once, a promise
 * when the write is pending behind backpressure, and a boolean once the
 * sink is closed (the child exited), so the result is typed loosely and
 * classified by `sinkWriteState`. */
export interface RepeatingStdinSink {
  write(text: string): unknown;
  end(): unknown;
}

/** The pause between two repeats. A repeat is paced, never issued back to
 * back: a child (or a descendant holding the same pipe) that drains stdin
 * as fast as it is written would otherwise keep every write synchronous,
 * and a loop of synchronous writes never returns to the event loop, so
 * the run's timeout, its signal handling, and its output capture would
 * all stop (review round 153). One 64-decline block per pause answers
 * 6400 prompts a second, far past any real prompt rate. */
export const STDIN_REPEAT_PAUSE_MS = 10;

export type SinkWriteState = "flushed" | "pending" | "closed";

/** What a sink's write result means; see RepeatingStdinSink. */
export function sinkWriteState(result: unknown): SinkWriteState {
  if (typeof result === "number") return "flushed";
  if (isThenable(result)) return "pending";
  return "closed";
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

/** The two waits a repeating feeder makes, each ended early by the
 * child's exit. One feeder waits on one thing at a time, so a single
 * `wake` slot is enough, and nothing accumulates on the exit promise
 * however long the child lives. */
export class RepeatPacer {
  private stopped = false;
  private wake: (() => void) | null = null;

  constructor(
    exited: Promise<unknown>,
    private readonly pauseMs: number = STDIN_REPEAT_PAUSE_MS
  ) {
    const stop = (): void => {
      this.stopped = true;
      this.wake?.();
    };
    exited.then(stop, stop);
  }

  /** Wait one pause. False when the child exited first. */
  pause(): Promise<boolean> {
    if (this.stopped) return Promise.resolve(false);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.wake = null;
        resolve(!this.stopped);
      }, this.pauseMs);
      this.wake = () => {
        clearTimeout(timer);
        this.wake = null;
        resolve(false);
      };
    });
  }

  /** Wait for a pending write to drain. False when it failed (the read
   * end is gone) or the child exited first. The write's rejection is
   * consumed here either way, so it never surfaces as unhandled. */
  drained(pending: PromiseLike<unknown>): Promise<boolean> {
    return new Promise((resolve) => {
      this.wake = () => resolve(false);
      pending.then(
        () => resolve(!this.stopped),
        () => resolve(false)
      );
      if (this.stopped) resolve(false);
    });
  }
}

/** The runner's plain stdin carrier (src/process-runner.ts): the one-shot
 * write plus the half-close every stdin-transport harness expects, or,
 * when the adapter says the block repeats, the feeder below, which never
 * closes stdin while the child lives. A protocol sink owns stdin itself,
 * so neither runs when one is present. Synchronous throws propagate to
 * the runner's own live-child catch, exactly as the inline writes this
 * replaced did. */
export function writeRunStdin(
  options: {
    stdinInput?: string | null;
    stdinRepeats?: boolean;
    stdoutSink?: { start?: unknown };
  },
  proc: { stdin: RepeatingStdinSink; exited: Promise<unknown> },
  track: (result: unknown) => void
): void {
  if (options.stdoutSink?.start) return;
  if (options.stdinInput === null || options.stdinInput === undefined) {
    track(proc.stdin.end());
    return;
  }
  if (options.stdinRepeats === true) {
    startRepeatingStdin(options.stdinInput, proc.stdin, proc.exited, track);
    return;
  }
  track(proc.stdin.write(options.stdinInput));
  track(proc.stdin.end());
}

/** Feed `block` to the child for its whole lifetime, one block in flight
 * at a time.
 *
 * The FIRST block keeps the strict delivery rule (src/process-stdin.ts,
 * review rounds 64 to 67): it rides `track`, so a write that fails while
 * the child is live fails the run exactly as a one-shot write does.
 *
 * The repeats after it are bounded and quiet:
 * - paced: one block per STDIN_REPEAT_PAUSE_MS at most, so the feeder
 *   returns to the event loop between writes whatever the child does
 *   with its stdin;
 * - one block in flight, the first included: a write under backpressure
 *   is waited for before the next, so a child that never reads keeps one
 *   block queued, never a growing pile;
 * - stdin is never closed while the child can still read it: the child
 *   that outlives codemux's patience meets the runner's own termination,
 *   never the EOF this mode exists to withhold;
 * - a repeat that fails ends the repeating and is swallowed there: a
 *   pipe write fails only when the read end closed, which means the child
 *   is gone or closed its stdin itself. No further decline can be read
 *   either way, and the run's verdict is the child's exit, which the
 *   runner already owns.
 *
 * When the feeder ends (the child exited, or its read end closed) it
 * closes codemux's end of the pipe, so the descriptor is released by this
 * code and not left to the runtime.
 */
export function startRepeatingStdin(
  block: string,
  sink: RepeatingStdinSink,
  exited: Promise<unknown>,
  track: (result: unknown) => void,
  pauseMs: number = STDIN_REPEAT_PAUSE_MS
): void {
  const first = sink.write(block);
  track(first);
  void repeatStdinLoop(block, sink, new RepeatPacer(exited, pauseMs), first);
}

async function repeatStdinLoop(
  block: string,
  sink: RepeatingStdinSink,
  pacer: RepeatPacer,
  first: unknown
): Promise<void> {
  try {
    // The first block counts toward the one-in-flight bound (review round
    // 154): while it is pending behind backpressure, no repeat is issued.
    if (!(await firstBlockLeft(first, pacer))) return;
    while (await pacer.pause()) {
      const result = sink.write(block);
      const state = sinkWriteState(result);
      if (state === "closed") return;
      if (state === "pending" && !(await pacer.drained(result as PromiseLike<unknown>))) {
        return;
      }
    }
  } catch {
    // A synchronous EPIPE: the read end is gone. Swallowed HERE only. The
    // child's exit, which the runner already reports, is the verdict.
  } finally {
    closeSinkQuietly(sink);
  }
}

/** Whether the first block left the sink, so a repeat may follow it: it
 * flushed at once, or its pending write drained. False when the sink was
 * already closed, the write failed, or the child exited first. Shared
 * with the session writer. */
export function firstBlockLeft(first: unknown, pacer: RepeatPacer): Promise<boolean> {
  const state = sinkWriteState(first);
  if (state === "closed") return Promise.resolve(false);
  if (state === "flushed") return Promise.resolve(true);
  return pacer.drained(first as PromiseLike<unknown>);
}

/** Close the write end after the feeder stopped. Nothing can read a
 * further decline by then, and a failure to close a pipe whose other end
 * is gone changes nothing. */
function closeSinkQuietly(sink: RepeatingStdinSink): void {
  try {
    const ended = sink.end();
    if (isThenable(ended)) ended.then(undefined, () => {});
  } catch {
    // Already closed underneath us; the outcome is the same.
  }
}
