import type { BaseAdapter, RunContext } from "./adapters/base.js";

/**
 * The exit-time backstop for one launch's run context.
 *
 * Every disposal path the lifecycle owns — processRunResult, where per-run
 * state is consumed, and cleanupRun after a finished or rejected launch —
 * runs while the launch is still on the call stack. A signal is not: while a
 * captured command is in flight the process runner owns signals, and it ends
 * a signaled run with process.exit(143) from inside the runner, so the
 * launch path never resumes and its cleanup calls are skipped. Without a
 * backstop, the scratch the run already wrote (codex's
 * `--output-last-message` file holds model output in the run's own temp
 * directory) outlives the interrupted run.
 *
 * Registering cleanupRun as an exit handler covers every exit that can
 * happen while the context lives, that one included (the hermetic home has
 * its own exit handler already; the two agree because both are idempotent).
 * The returned disposer unregisters the handler once the lifecycle has
 * disposed the context itself, so a finished run leaves nothing registered
 * and no second cleanup runs at exit.
 */
export function registerRunExitCleanup(
  adapter: Pick<BaseAdapter, "cleanupRun">,
  context: RunContext
): () => void {
  const onExit = (): void => {
    try {
      adapter.cleanupRun(context);
    } catch (error) {
      // An exit handler that throws would mask the exit itself, and
      // cleanupRun's contract says the same; an adapter that violates it
      // cannot take the exit path down with it.
      console.error(
        "codemux: could not clean up per-run state at exit: " +
          (error instanceof Error ? error.message : String(error))
      );
    }
  };
  process.once("exit", onExit);
  return () => {
    process.off("exit", onExit);
  };
}
