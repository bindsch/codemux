import type { BaseAdapter, RunContext } from "./adapters/base.js";
import { appendCallRecord, providerHost } from "./call-log.js";
import { runSandboxedWithStdin, unexpectedErrorExitCode } from "./cli-runtime.js";
import { OpenCodePlainFold } from "./plain-unwrap.js";
import { readProviderOverride } from "./provider-override.js";
import {
  CapturedRunFailure,
  runCapturedCommand,
  SIGNAL_EXIT_CODE,
} from "./process-runner.js";
import { emptyUsage } from "./result-envelope.js";
import { registerRunExitCleanup } from "./run-exit-cleanup.js";
import {
  resolveSandboxOptionsForAgent,
  type SandboxPolicyOverrides,
} from "./sandbox-policy.js";
import type { AgentId, AutonomyLevel, RunRequest, RunResult } from "./types.js";
import { validateWorkingDirectory } from "./validation.js";

export interface LaunchOptions {
  sandbox: boolean;
  sandboxPolicyOverrides?: SandboxPolicyOverrides;
  /** The autonomy the caller asked for; it selects the scode policy. */
  requestedAutonomy: AutonomyLevel;
  timeoutMs?: number;
  cwd?: string;
  /** Which command asked for this launch: the call ledger's `kind` field.
   * Absent means "run" — the default caller. */
  kind?: "run" | "check";
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
  // The ledger's `ts`: the moment this launch began, before any refusal
  // could end it.
  const startedAt = Date.now();
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
      // A const for the receipt closures below: `context` is assigned by
      // now, but its `let` type follows the variable, not this point.
      const runContext = context;
      // True once the run's own capture resolved: a rejection past that
      // point is processRunResult's, and a capture failure of a run that
      // spawned carries CapturedRunFailure — both ran the harness, so both
      // owe the failure receipt. A refusal before the spawn inside the
      // runner helpers (an unresolved binary) is neither and records
      // nothing (review ul8).
      let captured = false;
      let processed: RunResult;
      try {
        const raw = await runDirect(
          adapter,
          effective,
          runContext,
          () => appendInterruptedLaunchReceipt(effective, options, runContext, startedAt)
        );
        captured = true;
        processed = adapter.processRunResult(raw, effective, context);
      } catch (error) {
        // The harness ran and the launch still rejects: the receipt is
        // written before the rejection travels to the caller (review ul8).
        appendFailedLaunchReceipt(effective, options, runContext, startedAt, error, captured);
        throw error;
      }
      // The receipt precedes cleanup: a launch whose cleanup failed still
      // spent its tokens, and the record is the one thing that must survive.
      recordCompletedLaunch(effective, options, processed, startedAt);
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
    // Same const capture as the direct path, for the receipt closures.
    const runContext = context;
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
    // The direct path's `captured` rule, mirrored: a capture failure of a
    // run that spawned (scode included — the harness ran under it) or a
    // processRunResult throw owes the failure receipt; a refusal before
    // the spawn (a missing scode, an untrusted command) owes nothing
    // (review ul8).
    let captured = false;
    let processed: RunResult;
    try {
      const raw = await runSandboxedWithStdin(
        adapter.buildRunCommand(request, context),
        adapter.getStdinInput(request),
        options.cwd,
        envArg,
        options.requestedAutonomy,
        sandboxOptions,
        options.timeoutMs,
        adapter.getEnvOmissions(),
        context.stdoutSink,
        () => appendInterruptedLaunchReceipt(request, options, runContext, startedAt)
      );
      captured = true;
      processed = adapter.processRunResult(raw, request, context);
    } catch (error) {
      appendFailedLaunchReceipt(request, options, runContext, startedAt, error, captured);
      throw error;
    }
    // The receipt precedes cleanup for the same reason as the direct path.
    recordCompletedLaunch(request, options, processed, startedAt);
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
    // must not outlive the run even when the run itself failed. Any ledger
    // receipt the rejection owed was already written on the run path above
    // (appendFailedLaunchReceipt). Dispose only
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
 * hands it to processRunResult. `onSignaled` is the runner's pre-exit hook:
 * the receipt a signal interrupt owes, written before the process exits
 * (see appendInterruptedLaunchReceipt).
 */
async function runDirect(
  adapter: BaseAdapter,
  request: RunRequest,
  context: RunContext,
  onSignaled: () => void
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
    // A harness whose stream outgrows the capture bound (opencode's JSON
    // event lines carry every tool's output) hung its fold on the context;
    // the runner streams stdout through it, and processRunResult reads the
    // folded reply and usage back off the same object (review ul4).
    stdoutSink: context.stdoutSink,
    onSignaled,
  });
}

/**
 * Appends the call ledger's receipt for one completed launch. Runs only on
 * the paths that reached a finished (captured, post-processed) result: a
 * launch that rejected before the spawn — a refused request, a missing
 * sandbox — completed no call and records nothing, a launch whose harness
 * ran but whose capture rejected or post-processor threw records through
 * appendFailedLaunchReceipt instead, and a launch stopped by a signal to
 * codemux records through appendInterruptedLaunchReceipt, because the
 * runner's exit 143 means this path never runs. The ledger itself never
 * fails the run (call-log.ts), and usage stays an all-null block when no
 * structured wire reported any, never a fabricated one.
 */
function recordCompletedLaunch(
  request: RunRequest,
  options: LaunchOptions,
  result: RunResult,
  startedAt: number
): void {
  appendCallRecord({
    ts: new Date(startedAt).toISOString(),
    kind: options.kind ?? "run",
    agent: request.agent,
    model: request.model ?? null,
    model_effective: result.servedModel ?? null,
    provider: providerHostFor(request.agent),
    session_id: null,
    turn_id: null,
    autonomy: request.autonomy ?? "read-only",
    hermetic: Boolean(request.hermetic),
    sandboxed: Boolean(request.sandboxed),
    exit_code: result.exitCode,
    finish: null,
    duration_ms: Math.max(0, Date.now() - startedAt),
    cwd: request.cwd ?? process.cwd(),
    usage: result.usage ?? emptyUsage(),
  });
}

/** The receipt a signal interrupt owes the ledger: the run was in flight
 * when a signal to codemux stopped it, so the process runner exits 143
 * from inside the run and this launch's recordCompletedLaunch never runs.
 * Called from the runner's onSignaled hook — the one place left with the
 * launch's facts — it writes the signal exit code and whatever usage the
 * stdout fold had already folded (null everywhere else, never a guess)
 * through the same never-fail append. Must not throw: a throw here would
 * only mask the exit it runs inside (review ul6). */
function appendInterruptedLaunchReceipt(
  request: RunRequest,
  options: LaunchOptions,
  context: RunContext,
  startedAt: number
): void {
  try {
    const folded =
      context.stdoutSink instanceof OpenCodePlainFold
        ? context.stdoutSink.foldedUsage()
        : null;
    appendCallRecord({
      ts: new Date(startedAt).toISOString(),
      kind: options.kind ?? "run",
      agent: request.agent,
      model: request.model ?? null,
      model_effective: null,
      provider: providerHostFor(request.agent),
      session_id: null,
      turn_id: null,
      autonomy: request.autonomy ?? "read-only",
      hermetic: Boolean(request.hermetic),
      sandboxed: Boolean(request.sandboxed),
      exit_code: SIGNAL_EXIT_CODE,
      finish: null,
      duration_ms: Math.max(0, Date.now() - startedAt),
      cwd: request.cwd ?? process.cwd(),
      usage: folded ?? emptyUsage(),
    });
  } catch {
    // The never-fail contract, enforced here too: appendCallRecord already
    // swallows its own failures, and anything else (a read of the sink)
    // must not turn the exit path into a crash.
  }
}

/** The receipt a failed launch owes the ledger: the harness ran — its
 * capture rejected (invalid UTF-8 on a stream; the runner wraps that as
 * CapturedRunFailure) or its processRunResult threw (`captured` true, the
 * raw result was in hand) — so the call happened even though the launch
 * rejects and recordCompletedLaunch never runs. A refusal before the spawn
 * (a missing scode, an unresolved binary) is neither: it ran nothing and
 * records nothing, keeping recordCompletedLaunch's contract. The exit code
 * is the one the CLI gives the failed launch (unexpectedErrorExitCode: 64
 * for a usage refusal, 1 otherwise) and the usage is what the stdout fold
 * had folded — all-null when no structured stream reported any, never a
 * guess. Must not throw: the rejection it rides cannot gain a second
 * failure (review ul8). */
function appendFailedLaunchReceipt(
  request: RunRequest,
  options: LaunchOptions,
  context: RunContext,
  startedAt: number,
  error: unknown,
  captured: boolean
): void {
  if (!captured && !(error instanceof CapturedRunFailure)) return;
  try {
    const folded =
      context.stdoutSink instanceof OpenCodePlainFold
        ? context.stdoutSink.foldedUsage()
        : null;
    appendCallRecord({
      ts: new Date(startedAt).toISOString(),
      kind: options.kind ?? "run",
      agent: request.agent,
      model: request.model ?? null,
      model_effective: null,
      provider: providerHostFor(request.agent),
      session_id: null,
      turn_id: null,
      autonomy: request.autonomy ?? "read-only",
      hermetic: Boolean(request.hermetic),
      sandboxed: Boolean(request.sandboxed),
      exit_code: unexpectedErrorExitCode(error),
      finish: null,
      duration_ms: Math.max(0, Date.now() - startedAt),
      cwd: request.cwd ?? process.cwd(),
      usage: folded ?? emptyUsage(),
    });
  } catch {
    // The never-fail contract, as the interrupted receipt enforces it.
  }
}

/** The endpoint identity for the ledger: "default", or the host of the
 * provider override this launch ran against — never the key. A malformed
 * override cannot fail the receipt; it failed the launch itself already. */
function providerHostFor(agent: AgentId): string {
  try {
    return providerHost(readProviderOverride(agent)?.baseUrl ?? null);
  } catch {
    return "default";
  }
}
