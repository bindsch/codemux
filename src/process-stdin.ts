// Stdin delivery tracking for runCapturedCommand (src/process-runner.ts):
// a write or end on the child's stdin that fails after the spawn is the
// run's failure (review rounds 64 to 67).
//
// Rules:
// - The sink may throw at once or return a promise that rejects later
//   (backpressure); a protocol sink's asynchronous writer call routes its
//   synchronous throw through attempt() to the same rules. Every promise is awaited through settled(), which the
//   runner calls only once the captures and the exit are done, so every
//   write issued before the exit is already in the chain; settled() still
//   follows the chain until nothing was added after the last awaited one.
// - A rejection that settles after the child exited still counts when the
//   write was issued before the exit (the input never arrived). A write
//   issued after the exit had nothing to reach; the child's outcome stands.
// - The first failure stops a live child like a signal (abort). A rejection
//   after a capture failure, a timeout, or a signal is their consequence,
//   the termination closed the pipe, and never replaces their diagnosis.

export interface StdinDelivery {
  /** Records one write()/end() result; a non-promise result is final. */
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
      if (!(result instanceof Promise)) return;
      const issuedAfterExit = childExited;
      const settled = result.then(() => undefined, (rejection: unknown) => {
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
