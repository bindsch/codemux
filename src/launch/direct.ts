// The direct half of a launch, split from src/launch.ts so the launcher
// file keeps its size budget (review round 153's lane rule): the one spawn
// that runs outside any sandbox.

import type { BaseAdapter, RunContext } from "../adapters/base.js";
import { runCapturedCommand } from "../process-runner.js";
import {
  trustCheckedCommandChecks,
  trustCheckedCommandPaths,
} from "../executable-security.js";
import type { RunRequest, RunResult } from "../types.js";
import { validateWorkingDirectory } from "../validation.js";

/**
 * The one direct spawn: builds and runs the harness command outside any
 * sandbox. This is the whole direct half of a launch, split out so the
 * launcher stays the only place that spawns and post-processes a run --
 * BaseAdapter.run delegates to launchRunRequest, so every caller of either
 * gets the same lifecycle. Returns the RAW captured result; the launcher
 * hands it to processRunResult. `onSignaled` is the runner's pre-exit hook:
 * the receipt a signal interrupt owes, written before the process exits
 * (see appendInterruptedLaunchReceipt).
 */
export async function runDirect(
  adapter: BaseAdapter,
  request: RunRequest,
  context: RunContext,
  onSignaled: () => void | Promise<void>
): Promise<RunResult> {
  const cwd = validateWorkingDirectory(request.cwd) ?? process.cwd();
  const command = adapter.resolveExecutionCommand(
    adapter.buildRunCommand(request, context),
    cwd
  );
  // This launch's own resolutions (resolveExecutionCommand's trust
  // checks), captured in the resolution's synchronous block and carried to
  // the runner's pre-spawn re-stat: without them the re-stat falls back to
  // the process-wide identity list, where another launch's record of a
  // replaced binary would let this one exec bytes it never checked (round
  // 23, edges 1). The required paths refuse a recording gap instead of
  // skipping the re-check.
  const requiredPaths = trustCheckedCommandPaths(command);
  const checks = trustCheckedCommandChecks(command);
  // The Playwright binary buildRunCommand embedded in a --mcp-config
  // argument (review round 110): re-stat it like the command's own
  // positions. Null on every direct run that built no such argument.
  const playwrightCheck = context.playwrightMcpCheck ?? null;
  const stdinInput = adapter.getStdinInput(request);
  const env = adapter.buildExecutionEnv(
    adapter.getRunEnv(request, context),
    request.passthroughEnv
  );
  return runCapturedCommand(command, {
    cwd,
    env,
    stdinInput,
    // The adapter's repeating rule (review round 153): the run path and
    // the sandboxed path in launch.ts feed the same carrier.
    stdinRepeats: adapter.stdinRepeats(request),
    timeoutMs: request.timeoutMs,
    // A harness whose stream outgrows the capture bound (opencode's JSON
    // event lines carry every tool's output) hung its fold on the context;
    // the runner streams stdout through it, and processRunResult reads the
    // folded reply and usage back off the same object (review ul4).
    stdoutSink: context.stdoutSink,
    onSignaled,
    requiredPaths,
    checks: [...checks, ...(playwrightCheck === null ? [] : [playwrightCheck])],
  });
}
