import type { BaseAdapter, RunContext } from "./adapters/base.js";
import { runSandboxedWithStdin } from "./cli-runtime.js";
import { runCapturedCommand } from "./process-runner.js";
import { registerRunExitCleanup } from "./run-exit-cleanup.js";
import {
  resolveSandboxOptionsForAgent,
  type SandboxPolicyOverrides,
} from "./sandbox-policy.js";
import type { AutonomyLevel, RunRequest, RunResult } from "./types.js";
import { validateWorkingDirectory } from "./validation.js";

export interface LaunchOptions {
  sandbox: boolean;
  sandboxPolicyOverrides?: SandboxPolicyOverrides;
  /** The autonomy the caller asked for; it selects the scode policy. */
  requestedAutonomy: AutonomyLevel;
  timeoutMs?: number;
  cwd?: string;
}

/**
 * Runs one validated request either under scode or directly, the way `run`
 * and `check` both do. This is the ONLY place a run is spawned and
 * post-processed: BaseAdapter.run delegates here rather than spawning
 * itself, so no caller can get a raw spawn without processRunResult (a
 * direct `resultJson` call owes the caller the envelope just as a launched
 * one does). The sandboxed path attests the boundary itself. Either way the
 * launcher owns the run's context: prepareRun builds it, every seam
 * (buildRunCommand, getRunEnv, processRunResult) receives the same object,
 * and cleanupRun -- when it runs -- receives only that object, never another
 * launch's. From prepareRun until that disposal, an exit-time backstop
 * (run-exit-cleanup) disposes the same context on the exits the lifecycle
 * cannot reach, the process runner's exit 143 on a signal above all.
 */
export async function launchRunRequest(
  adapter: BaseAdapter,
  request: RunRequest,
  options: LaunchOptions
): Promise<RunResult> {
  // Undefined until this launch's own prepareRun succeeds, so a rejection
  // before that point (an untrusted sandbox, a refused request) has nothing
  // of its own to clean and cannot touch a concurrent launch's context.
  let context: RunContext | undefined;
  // Released once the lifecycle below has disposed the context itself;
  // while it is registered, an exit from anywhere -- the process runner's
  // exit 143 on a signal above all -- still cleans this launch's scratch.
  let releaseExitCleanup: (() => void) | undefined;
  try {
    if (!options.sandbox) {
      // A direct launch has no sandbox it could attest, so a request that
      // claims one is refused: the sandboxed branch below is the only launch
      // that may run one.
      if (request.sandboxed) {
        throw new Error(
          "cannot attest an external sandbox on a direct run; use the sandbox runner"
        );
      }
      // An unset autonomy is pinned on an EFFECTIVE copy, never the caller's
      // object: leaning on the autonomy refusal below alone left the run
      // claiming no autonomy was requested, and the day an adapter enforces
      // read-only natively the run would sail into buildRunCommand with no
      // autonomy flags at all. The copy (rather than a write to the request)
      // keeps a frozen or shared request usable -- mutating the caller's
      // object threw a TypeError on frozen requests (round19) and let one
      // caller's launch edit another's request.
      const effective: RunRequest =
        request.autonomy === undefined
          ? { ...request, autonomy: "read-only" }
          : request;
      const effectiveAutonomy: AutonomyLevel = request.autonomy ?? "read-only";
      if (adapter.requiresSandboxForAutonomy(effectiveAutonomy)) {
        throw new Error(
          `${adapter.id} cannot enforce '${effectiveAutonomy}' autonomy without an external sandbox`
        );
      }
      // Validation precedes prepareRun (round17): a run's context can write
      // scratch state as soon as it is built (codex's --output-last-message
      // directory, a hermetic home), and a request the run will refuse must
      // not touch disk first -- cleanup would remove it again, but the write
      // should never happen. The checks above are pure, so a request that
      // passed them passes validation on the same values.
      adapter.validateRunRequest(effective);
      // beforeLaunch precedes prepareRun too (round19), matching the
      // sandboxed path and the lifecycle contract: a failing beforeLaunch
      // (zai's missing API key) must not leave scratch state behind, and
      // preparation may depend on initialization performed there.
      adapter.beforeLaunch();
      context = adapter.prepareRun(effective);
      releaseExitCleanup = registerRunExitCleanup(adapter, context);
      const raw = await runDirect(adapter, effective, context);
      const processed = adapter.processRunResult(raw, effective, context);
      adapter.cleanupRun(context);
      releaseExitCleanup();
      return processed;
    }
    const sandboxOptions = resolveSandboxOptionsForAgent(
      request.agent,
      options.requestedAutonomy,
      options.sandboxPolicyOverrides
    );
    adapter.validateRunRequest(request);
    adapter.beforeLaunch();
    // The resolved trust rides into prepareRun so per-run scratch can be
    // shaped for the sandbox the child will actually run in (an untrusted
    // sandbox denies harness state, where codex's fallback file lives).
    context = adapter.prepareRun(request, sandboxOptions.trust);
    releaseExitCleanup = registerRunExitCleanup(adapter, context);
    // One source for the whole launch (round15): request.passthroughEnv is
    // the list validation checked, so it -- not a second copy on the
    // options -- is what the sandbox environment is built from.
    adapter.prepareSandbox({
      sandboxTrust: sandboxOptions.trust,
      passthroughEnv: request.passthroughEnv,
    });
    const envArg = adapter.buildExecutionEnv(
      adapter.getRunEnv(request, context),
      request.passthroughEnv
    );
    const raw = await runSandboxedWithStdin(
      adapter.buildRunCommand(request, context),
      adapter.getStdinInput(request),
      options.cwd,
      envArg,
      options.requestedAutonomy,
      sandboxOptions,
      options.timeoutMs,
      adapter.getEnvOmissions()
    );
    const processed = adapter.processRunResult(raw, request, context);
    // processRunResult consumed what it could (codex reads and removes its
    // --output-last-message file there); whatever remains -- an unread
    // file, the private hermetic home -- is disposed now that the run is
    // over.
    adapter.cleanupRun(context);
    releaseExitCleanup();
    return processed;
  } catch (error) {
    // A launch that rejects (a captured stdout that is not UTF-8, a missing
    // scode, a refused working directory) never reaches processRunResult,
    // where adapters consume per-run state -- codex removes its
    // --output-last-message file there, and the model output that file holds
    // must not outlive the run even when the run itself failed. Dispose only
    // the context THIS launch created, then rethrow: the launch's own failure
    // is the diagnostic the caller gets, and a concurrent launch through the
    // same adapter keeps its own context untouched.
    if (context !== undefined) adapter.cleanupRun(context);
    releaseExitCleanup?.();
    throw error;
  }
}

/**
 * The one direct spawn: builds and runs the harness command outside any
 * sandbox. This is the whole direct half of a launch, split out so the
 * launcher stays the only place that spawns and post-processes a run --
 * BaseAdapter.run delegates to launchRunRequest, so every caller of either
 * gets the same lifecycle. Returns the RAW captured result; the launcher
 * hands it to processRunResult.
 */
async function runDirect(
  adapter: BaseAdapter,
  request: RunRequest,
  context: RunContext
): Promise<RunResult> {
  const cwd = validateWorkingDirectory(request.cwd) ?? process.cwd();
  const command = adapter.resolveExecutionCommand(
    adapter.buildRunCommand(request, context),
    cwd
  );
  const stdinInput = adapter.getStdinInput(request);
  const env = adapter.buildExecutionEnv(
    adapter.getRunEnv(request, context),
    request.passthroughEnv
  );
  return runCapturedCommand(command, {
    cwd,
    env,
    stdinInput,
    timeoutMs: request.timeoutMs,
  });
}
