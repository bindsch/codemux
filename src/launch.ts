import type { BaseAdapter, RunContext } from "./adapters/base.js";
import { assertCompatibleScode, assertHarnessSupported, resolveScodeExecutableForEnv, runSandboxedWithStdin } from "./cli-runtime.js";
import { foldedSinkUsage } from "./plain-unwrap.js";
import { ExperimentFailure, experimentFailure } from "./experiment-records.js";
import { experimentFailedResult } from "./result-envelope/experiment.js";
import {
  CapturedRunFailure,
  runCapturedCommand,
} from "./process-runner.js";
import { trustCheckedCommandChecks, trustCheckedCommandPaths } from "./executable-security.js";
import { appendFailedLaunchReceipt, appendInterruptedLaunchReceipt, recordCompletedLaunch } from "./launch/receipts.js";
import { registerRunExitCleanup } from "./run-exit-cleanup.js";
import {
  resolveSandboxOptionsForAgent,
  type SandboxPolicyOverrides,
} from "./sandbox-policy.js";
import { assertNoCallerBlockOverStateDirs, withKeepEnvExemption } from "./sandbox.js";
import { featureFloor, SCODE_FLOORS } from "./harness-contracts.js";
import type { AutonomyLevel, RunRequest, RunResult } from "./types.js";
import { UsageRefusalError, validateWorkingDirectory } from "./validation.js";
import { assertSandboxedLaunchAgreement, effectiveWorkingDirectory } from "./launch/constraints.js";

export interface LaunchOptions {
  sandbox: boolean;
  sandboxPolicyOverrides?: SandboxPolicyOverrides;
  /** The autonomy the caller asked for; it selects the scode policy. */
  requestedAutonomy: AutonomyLevel;
  timeoutMs?: number;
  cwd?: string;
  /** Version already obtained by the CLI compatibility gate. */
  harnessVersion?: string | null;
  /** Which command asked for this launch: the call ledger's `kind` field.
   * Absent means "run" — the default caller. */
  kind?: "run" | "check";
  /** `--print-sandbox`: the launch resolves and prints its scode argv
   * instead of running the harness. The sandboxed path still runs its
   * preflight (probes, validation, option resolution) so the printed argv
   * is the real one; nothing is spawned, recorded, or receipted. Refused
   * with `experimentMcp`: the relay is minted at start, so its argv cannot
   * be shown without starting it. */
  printSandbox?: boolean;
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
  let captured = false;
  let receiptRequest = request;
  let processed: RunResult | undefined;
  let capturedResult: RunResult | undefined;
  let cleanupStarted = false;
  const retainedExperimentFailure = () => context?.experimentBridge?.failureError ??
    context?.experimentCodex?.failureError ?? context?.experimentKimi?.relay.failureError ?? null;
  const recordInterruption = () => {
    context?.experimentCodex?.interruptBeforeEvidence();
    const kimi = context?.experimentKimi;
    if (kimi) kimi.relay.fail(new Error(kimi.hasOutput ? "interrupted before verification" : "interrupted before harness evidence"));
  };
  const cleanup = async () => {
    if (context === undefined || cleanupStarted) return;
    cleanupStarted = true;
    try {
      await adapter.cleanupRun(context);
      const failure = retainedExperimentFailure();
      // Explicit experiments must fail on retained verification errors. Other
      // runs already received protocol cleanup errors from the capture layer.
      if (request.experimentMcp && failure) throw failure;
    }
    catch (error) {
      if (!processed || context.experimentRecording) throw error;
      const separator = processed.stderr && !processed.stderr.endsWith("\n") ? "\n" : "";
      processed.stderr += `${separator}Note: cleanup failed: ${error instanceof Error ? error.message : String(error)}\n`;
    }
    finally { releaseExitCleanup?.(); }
  };
  try {
    if (options.printSandbox && request.experimentMcp) {
      // The experiment relays are minted at prepare — the MCP server command
      // from the spec is spawned there — so a launch that must not run
      // anything can never reach the argv print. The CLI refuses the
      // combination before any preparation (run-command.ts); this guard
      // holds it for any other caller of the launcher, before prepareRun
      // (claude's and zai's already write the recording file) and before
      // the codex/kimi prepare block below.
      throw new UsageRefusalError(
        "--print-sandbox cannot be combined with --experiment-mcp: the MCP relay is minted at start, so its argv cannot be shown without starting it"
      );
    }
    if (options.printSandbox && !options.sandbox) {
      // Fail closed in the launcher itself, not only in the CLI: the
      // direct branch below has no sandboxed spawn, so a caller that
      // bypassed run-command.ts's refusal must not reach a real spawn
      // it believed was only printed (review round 7, edges).
      throw new UsageRefusalError("--print-sandbox requires --sandbox");
    }
    if (request.experimentMcp && (!options.sandbox || options.requestedAutonomy !== "read-only" ||
        effectiveWorkingDirectory(options.cwd) !== effectiveWorkingDirectory(request.cwd))) {
      throw new Error("experiment MCP launch must use read-only scode and the request's working directory");
    }
    if (request.experimentMcp && (request.agent === "codex" || request.agent === "kimi") &&
        (request.sandboxNoNet || options.sandboxPolicyOverrides?.noNet)) {
      throw new Error(`--experiment-mcp with ${request.agent} refuses --sandbox-no-net because the relay requires loopback`);
    }
    if (request.experimentMcp && (request.agent === "codex" || request.agent === "kimi") &&
        (request.sandboxTrust === "untrusted" || options.sandboxPolicyOverrides?.trust === "untrusted")) {
      throw new Error(`--experiment-mcp with ${request.agent} refuses --sandbox-trust untrusted because the relay requires loopback`);
    }
    if (request.agent === "agy" && (request.hermetic || request.tools === "none") &&
        (!options.sandbox || options.requestedAutonomy !== "read-only" ||
         effectiveWorkingDirectory(options.cwd) !== effectiveWorkingDirectory(request.cwd))) {
      throw new Error("agy isolation launch requires read-only scode and the run's own working directory");
    }
    if (request.experimentProjectSettings &&
        effectiveWorkingDirectory(options.cwd) !== effectiveWorkingDirectory(request.cwd)) {
      // The project-settings gate validates the directory the REQUEST
      // names (claude's adapter reads request.cwd), while the child runs
      // in options.cwd — the same split the experiment MCP and agy rules
      // above refuse. A caller passing two directories could validate a
      // safe one and execute with the project hooks of another (review
      // round 16, edges 2).
      throw new UsageRefusalError(
        "experiment project-settings launch must run in the request's working directory"
      );
    }
    if (options.sandbox) assertSandboxedLaunchAgreement(request, options);
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
      receiptRequest = effective;
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
      if (options.harnessVersion !== undefined) context.harnessVersion = options.harnessVersion;
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
      const raw = await runDirect(
        adapter,
        effective,
        runContext,
        async () => {
          recordInterruption();
          try { await cleanup(); }
          finally { appendInterruptedLaunchReceipt(effective, options, runContext, startedAt); }
        }
      );
      captured = true;
      capturedResult = raw;
      processed = adapter.processRunResult(raw, effective, context);
      await cleanup();
      recordCompletedLaunch(effective, options, processed, startedAt);
      return processed;
    }
    let sandboxOptions = resolveSandboxOptionsForAgent(
      request.agent,
      options.requestedAutonomy,
      options.sandboxPolicyOverrides
    );
    adapter.validateRunRequest(request);
    adapter.beforeLaunch();
    // The resolved trust rides into prepareRun so per-run scratch can be
    // shaped for the sandbox the child will actually run in (an untrusted
    // sandbox denies harness state, where codex's fallback file lives).
    // Print-only launches prepare paths, never credentials (LaunchIntent);
    // the request itself is never mutated (review round 42).
    context = adapter.prepareRun(request, sandboxOptions.trust, sandboxOptions, { printOnly: options.printSandbox === true });
    if (options.harnessVersion !== undefined) context.harnessVersion = options.harnessVersion;
    releaseExitCleanup = registerRunExitCleanup(adapter, context);
    if (context.agyProbe?.diagnostic && context.agyProbe.operatorHome) {
      // Shared temp storage is hidden. Expose only this check's HOME,
      // never the planted parent or cwd; --ro still protects the project.
      sandboxOptions.harnessStateDirs = [context.agyProbe.home ?? context.agyProbe.operatorHome];
      assertNoCallerBlockOverStateDirs(sandboxOptions.blockPaths ?? [], sandboxOptions.harnessStateDirs);
    }
    if (context.claudeProjectConfigDir !== undefined) {
      // A project-settings run points the harness at a private config
      // directory, but the operator's real config root still sits inside
      // the sandbox's default-allowed harness state — readable and
      // writable. Block it (and the ~/.claude.json beside it), then
      // re-allow only this run's own private directory: every other run's
      // and session's tree under .codemux-hermetic stays unreachable too.
      // scode emits the block first and the child allow after it, and its
      // final guards re-assert both, so exactly the private directory
      // remains reachable.
      // A caller's own block must not be re-opened by that allow: it is
      // checked here, while sandboxOptions.blockPaths still holds only the
      // caller's --sandbox-block values, before the launcher's own pair
      // is appended (review round 9, edges finding 1).
      assertNoCallerBlockOverStateDirs(
        sandboxOptions.blockPaths ?? [],
        [...(sandboxOptions.harnessStateDirs ?? []), context.claudeProjectConfigDir.dir]
      );
      sandboxOptions.blockPaths = [
        ...(sandboxOptions.blockPaths ?? []),
        ...context.claudeProjectConfigDir.blockedPaths,
      ];
      sandboxOptions.harnessStateDirs = [
        ...(sandboxOptions.harnessStateDirs ?? []),
        context.claudeProjectConfigDir.dir,
      ];
    }
    // Same const capture as the direct path, for the receipt closures.
    const runContext = context;
    // One source for the whole launch (round15): request.passthroughEnv is
    // the list validation checked, so it -- not a second copy on the
    // options -- is what the sandbox environment is built from.
    // A print-only launch skips it: prepareSandbox contributes nothing to
    // the argv or the sandbox options (it exists for its side effects
    // alone), and the claude family's implementation refreshes or scrubs
    // the operator's default credential mirror and prunes its backups —
    // authentication state a diagnostic command that promises to run
    // nothing must not touch (review round 18, edges 2).
    if (options.printSandbox) {
      console.error("codemux: credential sandbox preparation skipped: --print-sandbox is print only");
      // The credential copy is deferred too (round 19, edges 3): getRunEnv
      // below still runs — the printed argv needs CLAUDE_CONFIG_DIR — and
      // claude's copy reads the operator's mirror (refusing a
      // refresh-token mirror) and writes into the private directory. A
      // print answers the environment with neither side effect, the same
      // deferral the session's pre-claim probe uses (cli-spawn-prep.ts).
      if (context.claudeProjectConfigDir !== undefined) {
        context.claudeProjectConfigDir.deferCredentialCopy = true;
      }
    } else {
      adapter.prepareSandbox({
        sandboxTrust: sandboxOptions.trust,
        passthroughEnv: request.passthroughEnv,
      });
    }
    // The environment codemux itself chose for this child: the adapter's
    // standing variables plus the per-run ones — exactly the two maps
    // buildExecutionEnv merges — captured here for their names. Under
    // --sandbox-scrub-env those names ride scode's --keep-env exemption,
    // so the scrub strips the ambient environment without stripping the
    // configuration codemux deliberately injected. A provider override
    // makes that mandatory: its key is the run's only credential (the
    // operator's own was omitted on purpose), so a scode that cannot
    // exempt it refuses the launch rather than running it stripped. The
    // same rule the session spawns apply (withKeepEnvExemption).
    const injectedEnv = {
      ...adapter.getEnv(),
      ...adapter.getRunEnv(request, context),
    };
    const envArg = adapter.buildExecutionEnv(injectedEnv, request.passthroughEnv);
    // Probe the same binaries and environment that the sandbox runner resolves.
    // The floor comes from SCODE_FLOORS, the same table doctor reads, so a
    // launch refusal and the machine check's SANDBOX-TOO-OLD row cannot
    // disagree on the number.
    const scodeFloorForAgent = SCODE_FLOORS[request.agent];
    if (scodeFloorForAgent !== undefined) {
      const cwd = effectiveWorkingDirectory(options.cwd);
      const scode = resolveScodeExecutableForEnv(envArg, cwd);
      if (!scode) throw new Error(`every sandboxed ${request.agent} run requires scode ${scodeFloorForAgent} or newer`);
      try { await assertCompatibleScode(scode, cwd, envArg, scodeFloorForAgent); }
      catch (error) {
        throw new Error(`every sandboxed ${request.agent} run requires scode ${scodeFloorForAgent} or newer: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (request.experimentMcp) {
      // The experiment floor comes from FEATURE_FLOORS (fail closed: the
      // accessor throws when an experiment harness has no recorded floor),
      // the same table the session drivers and doctor read.
      context.harnessVersion = await assertHarnessSupported(adapter.id, adapter.binaryName, options.cwd, envArg,
        request.autonomy, true, request.passthroughEnv, featureFloor(adapter.id, "experiment-mcp"));
      try { await context.experimentCodex?.prepare(context.harnessVersion); }
      finally {
        context.experimentRecording ??= context.experimentCodex?.startedRecordingPath;
      }
      await context.experimentKimi?.prepare();
    }
    // The override question reads the ADAPTER's environment view, not
    // process.env: a custom-environment launch (an adapter built against
    // its own view) must decide on the same environment it validated
    // against, or an unrelated ambient CODEMUX_<AGENT>_PROVIDER_* value
    // would refuse a launch whose view carries no override (round al12).
    sandboxOptions = withKeepEnvExemption(
      sandboxOptions,
      injectedEnv,
      adapter.providerOverrideActive()
    );
    // The direct path's `captured` rule, mirrored: a capture failure of a
    // run that spawned (scode included — the harness ran under it) or a
    // processRunResult throw owes the failure receipt; a refusal before
    // the spawn (a missing scode, an untrusted command) owes nothing
    // (review ul8).
    const raw = await runSandboxedWithStdin(
      adapter.buildRunCommand(request, context),
      adapter.getStdinInput(request),
      options.cwd,
      envArg,
      options.requestedAutonomy,
      sandboxOptions,
      // One deadline governs both paths: the direct branch below runs on
      // request.timeoutMs, so the sandboxed branch does too. The guard
      // above already refused a request and an options pair that disagree,
      // so the two spell the same value whenever either carries one.
      request.timeoutMs,
      adapter.getEnvOmissions(),
      context.stdoutSink,
      async () => {
        recordInterruption();
        try { await cleanup(); }
        finally { appendInterruptedLaunchReceipt(request, options, runContext, startedAt); }
      },
      options.printSandbox
    );
    if (options.printSandbox) {
      // The argv was already printed inside the runner (after every probe
      // and resolution above, so it is the argv a real launch would exec);
      // nothing ran, so there is no result to process, record, or receipt.
      await cleanup();
      return raw;
    }
    captured = true;
    capturedResult = raw;
    if (request.experimentMcp && raw.captureLimitExceeded)
      throw experimentFailure(new Error("experiment output exceeded the capture limit"));
    // Read Codex's fallback before verification can trigger private-home cleanup.
    if (context.experimentCodex) processed = adapter.processRunResult(raw, request, context);
    // Stdout EOF can precede the runner's timeout; pass the final timer outcome.
    await context.experimentCodex?.verify({ timedOut: raw.timedOut === true });
    await context.experimentKimi?.complete({ timedOut: raw.timedOut === true });
    processed ??= adapter.processRunResult(raw, request, context);
    await cleanup();
    recordCompletedLaunch(request, options, processed, startedAt);
    return processed;
  } catch (error) {
    if (context?.experimentCodex && !capturedResult && !processed) capturedResult = { stdout: context.experimentCodex.capturedOutput, stderr: "", exitCode: 1, success: false };
    const owner = context?.experimentBridge ?? (context?.experimentCodex?.startedRecordingPath
      ? context.experimentCodex.relay : context?.experimentKimi?.relay);
    owner?.fail(experimentFailure(error instanceof CapturedRunFailure ? error.cause : error));
    if (request.experimentMcp && request.agent === "kimi") {
      const source = capturedResult ?? processed ?? { stdout: context?.experimentKimi?.capturedOutput ?? "", stderr: "", exitCode: 1, success: false };
      processed = adapter.processRunResult({ ...source,
        usage: processed?.usage ?? foldedSinkUsage(context?.stdoutSink) ?? source.usage }, receiptRequest, context,
        retainedExperimentFailure() ?? experimentFailure(error instanceof CapturedRunFailure ? error.cause : error));
    }
    let failure = error;
    let cleanupFailure: unknown;
    try { await cleanup(); }
    catch (cleanupError) {
      cleanupFailure = cleanupError;
      if (cleanupError !== error) {
        failure = new AggregateError([error, cleanupError],
          `${error instanceof Error ? error.message : String(error)}; cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`);
      }
    }
    if (request.experimentMcp && (context?.experimentRecording || context?.experimentCodex || error instanceof ExperimentFailure)) {
      const primary = retainedExperimentFailure() ?? experimentFailure(error instanceof CapturedRunFailure ? error.cause : error);
      const diagnostic = cleanupFailure && cleanupFailure !== primary && cleanupFailure !== error
        ? new ExperimentFailure(primary.code, `${primary.message}; cleanup failed: ${cleanupFailure instanceof Error ? cleanupFailure.message : String(cleanupFailure)}`)
        : primary;
      const result = experimentFailedResult(processed ?? capturedResult, receiptRequest,
        context?.experimentRecording ?? null, diagnostic, foldedSinkUsage(context?.stdoutSink), adapter.resultModel(receiptRequest));
      if (context) appendFailedLaunchReceipt(receiptRequest, options, context, startedAt, failure,
        captured || error instanceof CapturedRunFailure, result, result.exitCode);
      return result;
    }
    if (context) appendFailedLaunchReceipt(receiptRequest, options, context, startedAt, failure,
      captured || error instanceof CapturedRunFailure, processed);
    throw failure;
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
    requiredPaths,
    checks,
  });
}
