// Stdin delivery tracking for runCapturedCommand (src/process-runner.ts):
// a write or end on the child's stdin that fails after the spawn is the
// run's failure (review rounds 64 to 67).
//
// Rules:
// - The sink may throw at once, return a promise that rejects later
//   (backpressure), or answer a closed sink without throwing -- a number
//   says the write flushed, and every other synchronous result (Bun's
//   closed boolean, or the Error itself) says the bytes never left (round
//   211). sinkWriteState (src/process-stdin-repeat.ts) is the one
//   classifier for that result; a protocol sink's asynchronous writer call
//   routes its synchronous throw through attempt() to the same rules. Every promise is awaited through settled(), which the
//   runner calls only once the captures and the exit are done, so every
//   write issued before the exit is already in the chain; settled() still
//   follows the chain until nothing was added after the last awaited one.
// - A rejection that settles after the child exited still counts when the
//   write was issued before the exit (the input never arrived). A write
//   issued after the exit had nothing to reach; the child's outcome stands.
// - The first failure stops a live child like a signal (abort). A rejection
//   after a capture failure, a timeout, or a signal is their consequence,
//   the termination closed the pipe, and never replaces their diagnosis.

import { sinkWriteState } from "./process-stdin-repeat.js";

export interface StdinDelivery {
  /** Records one write()/end() result: a number flushed, a promise is
   * pending, and any other synchronous result is a closed sink and a
   * failed delivery (round 211). */
  track(result: unknown): void;
  /** Runs one write()/end() call: a synchronous throw is tracked like a
   * rejection, never thrown to the caller (a protocol sink calls its
   * writer asynchronously, outside any runner frame; round 71). */
  attempt(write: () => unknown): void;
  /** Resolves once every tracked promise settled and none was added after. */
  settled(): Promise<void>;
  failed(): boolean;
  error(): unknown;
}

export function trackStdinDelivery(deps: {
  exited: Promise<unknown>;
  /** True once a capture failure, timeout, or signal owns the diagnosis. */
  superseded: () => boolean;
  /** Stops the child the way a signal does. */
  abort: () => void;
}): StdinDelivery {
  let failed = false;
  let error: unknown;
  let pending: Promise<void> = Promise.resolve();
  let childExited = false;
  void deps.exited.then(() => { childExited = true; }, () => { childExited = true; });
  return {
    track(result) {
      const state = sinkWriteState(result);
      if (state === "flushed") return;
      if (state === "closed") {
        // The sink answered a closed pipe without throwing (round 211):
        // the bytes never left, so the same rules as a rejection apply --
        // a superseded run keeps its diagnosis, and a write issued after
        // the exit had nothing to reach. The verdict waits one turn of
        // the promise queue, as a rejection's does: an exit that already
        // resolved marks `childExited` through its own callback, which is
        // ahead in that queue, so a closed result that is the exit's
        // consequence never replaces the child's own exit code (review
        // round 214).
        const settled = Promise.resolve().then(() => {
          if (childExited || failed || deps.superseded()) return;
          failed = true;
          // A sink that answers its own Error keeps that error's message;
          // a bare boolean (Bun's closed sink) is wrapped, so the run's
          // stderr names the child's stdin instead of printing "false"
          // (round 381 — the stored raw value stringified to `Error: false`
          // at the runner's diagnosis).
          error = result instanceof Error
            ? result
            : new Error(`a write to the child's stdin was answered closed (${String(result)}); the bytes never left`);
          deps.abort();
        });
        pending = pending.then(() => settled);
        return;
      }
      const issuedAfterExit = childExited;
      const settled = (result as Promise<unknown>).then(() => undefined, (rejection: unknown) => {
        if (issuedAfterExit || failed || deps.superseded()) return;
        failed = true;
        error = rejection;
        if (!childExited) deps.abort();
      });
      pending = pending.then(() => settled);
    },
    attempt(write) {
      let result: unknown;
      try { result = write(); } catch (error) { result = Promise.reject(error); }
      this.track(result);
    },
    async settled() {
      let seen: Promise<void>;
      do { seen = pending; await seen; } while (seen !== pending);
    },
    failed: () => failed,
    error: () => error,
  };
}
