import type { BaseAdapter, RunContext } from "./adapters/base.js";

/**
 * The exit-time backstop for one launch's run context.
 *
 * Known completion, failure, and signal paths await cleanupRun before exit.
 * An unexpected process.exit or uncaught exception cannot await promises.
 * This backstop terminates the protocol and calls only cleanupRunSync.
 *
 * Registering cleanupRunSync covers every exit while the context lives
 * (the hermetic home has
 * its own exit handler already; the two agree because both are idempotent).
 * The returned disposer unregisters the handler once the lifecycle has
 * disposed the context itself, so a finished run leaves nothing registered
 * and no second cleanup runs at exit.
 */
export function registerRunExitCleanup(
  adapter: Pick<BaseAdapter, "cleanupRunSync">,
  context: RunContext
): () => void {
  const onExit = (): void => {
    const report = (error: unknown): void => {
      console.error("codemux: could not clean up per-run state at exit: " +
        (error instanceof Error ? error.message : String(error)));
    };
    try {
      // Async readers are drained by the runner before its signal exit.
      // An unexpected exit still terminates the external process synchronously.
      context.stdoutSink?.terminateProtocol?.();
    } catch (error) {
      report(error);
    }
    try { adapter.cleanupRunSync(context); }
    catch (error) { report(error); }
  };
  process.prependOnceListener("exit", onExit);
  return () => {
    process.off("exit", onExit);
  };
}
