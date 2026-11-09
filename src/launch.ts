import type { BaseAdapter, RunContext } from "./adapters/base.js";
import type { CopilotAdapter } from "./adapters/copilot.js";
import { join } from "node:path";
import { applyAgyIsolationSandboxBlocks } from "./launch/agy-isolation-sandbox.js";
import { assertCompatibleScode, launchRedirectCheck, resolveScodeExecutableForEnv, runSandboxedWithStdin } from "./cli-runtime.js";
import { foldedSinkUsage } from "./plain-unwrap.js";
import { ExperimentFailure, experimentFailure } from "./experiment-records.js";
import { experimentFailedResult } from "./result-envelope/experiment.js";
import { assertExperimentLoopbackPolicy } from "./experiment-mcp.js";
import {
  CapturedRunFailure,
} from "./process-runner.js";
import { appendFailedLaunchReceipt, appendInterruptedLaunchReceipt, launchProvider, recordCompletedLaunch } from "./launch/receipts.js";
import {
  armExperimentFailure,
  assertExperimentCaptureBound,
  completeExperimentRuns,
  recordExperimentEmptyAnswer,
  earlyExperimentResult,
  prepareExperimentRuns,
  recordExperimentInterruption,
  retainedExperimentFailure as retainedFailureOf,
} from "./launch/experiment-arms.js";
import { registerRunExitCleanup } from "./run-exit-cleanup.js";
import { runDirect } from "./launch/direct.js";
import { collectCodexNativeCost, type CodexCostBinding } from "./codex-native-cost.js";
import {
  resolveSandboxOptionsForAgent,
  type SandboxPolicyOverrides,
} from "./sandbox-policy.js";
import { assertNoCallerBlockOverStateDirs, withKeepEnvExemption } from "./sandbox.js";
import { SCODE_FLOORS } from "./harness-contracts.js";
import type { AutonomyLevel, RunRequest, RunResult } from "./types.js";
import { UsageRefusalError } from "./validation.js";
import { assertSandboxedLaunchAgreement, effectiveWorkingDirectory } from "./launch/constraints.js";
import { enforceNonEmptyResult } from "./result-empty.js";

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
  // The ledger's `ts`: the moment this launch began, before any refusal could end it.
  const startedAt = Date.now();
  const provider = launchProvider(adapter);
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
  // The experiment arms live in launch/experiment-arms.ts (file-size
  // round); these closures bind them to this launch's context.
  const retainedExperimentFailure = () => retainedFailureOf(context);
  const recordInterruption = () => recordExperimentInterruption(context);
  const cleanup = async () => {
    if (context === undefined || cleanupStarted) return;
    cleanupStarted = true;
    // The exit backstop is released when the cleanup succeeded, or failed
    // with nothing left to retry. It stays registered only while the
    // adapter kept state for a retry (agy's private home, review round
    // 137): the exit then runs cleanupRunSync once more (rounds 138, 141).
    let cleaned = false;
    try {
      await adapter.cleanupRun(context);
      cleaned = true;
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
    finally { if (cleaned || !adapter.cleanupRetryPending(context)) releaseExitCleanup?.(); }
  };
  try {
    if (options.printSandbox && request.experimentMcp) {
      // The experiment relays are minted at prepare — the MCP server command
      // from the spec is spawned there — so a launch that must not run
      // anything can never reach the argv print. The CLI refuses the
      // combination before any preparation (run-command.ts); this guard
      // holds it for any other caller of the launcher, before prepareRun
      // (claude's and zai's already write the recording file).
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
    if (request.experimentMcp) {
      // The shared loopback policy, fed the options-only constraints the
      // request flags do not carry (review m1): every relay host, not a
      // hand-written three.
      assertExperimentLoopbackPolicy({
        agent: request.agent,
        sandboxNoNet: request.sandboxNoNet || options.sandboxPolicyOverrides?.noNet === true,
        sandboxTrust: options.sandboxPolicyOverrides?.trust === "untrusted" ? "untrusted" : request.sandboxTrust,
      });
    }
    if (request.agent === "agy" && (request.hermetic || request.tools === "none") &&
        (!options.sandbox ||
         effectiveWorkingDirectory(options.cwd) !== effectiveWorkingDirectory(request.cwd))) {
      throw new Error("agy isolation launch requires scode and the run's own working directory");
    }
    if (request.experimentProjectSettings &&
        effectiveWorkingDirectory(options.cwd) !== effectiveWorkingDirectory(request.cwd)) {
      // The project-settings gate validates the directory the REQUEST
      // names (claude's adapter reads request.cwd), while the child runs
      // in options.cwd — the same split the experiment MCP and agy rules
      // above refuse: a caller passing two directories could validate a
      // safe one and execute with the project hooks of another (round 16).
      throw new UsageRefusalError(
        "experiment project-settings launch must run in the request's working directory"
      );
    }
    if (options.sandbox) assertSandboxedLaunchAgreement(request, options);
    // Every adapter validates and mints its grants from the REQUEST's
    // working directory (the claude family's medium-autonomy Edit grant
    // names it), while the spawn runs in the OPTIONS' directory: the two
    // must agree on every launch. The sandboxed agreement above already
    // refuses the split with its own message; this covers the direct
    // launch (review round 372, item 11). The CLI always passes one
    // value; this refuses a programmatic caller's split.
    if (effectiveWorkingDirectory(options.cwd) !== effectiveWorkingDirectory(request.cwd)) {
      throw new UsageRefusalError("the launch must run in the request's working directory");
    }
    if (!options.sandbox) {
      // A direct launch has no sandbox it could attest, so a request that
      // claims one is refused: the sandboxed branch below is the only launch
      // that may run one.
      if (request.sandboxed) {
        throw new Error(
          "cannot attest an external sandbox on a direct run; use the sandbox runner"
        );
      }
      // The same impossible attestation for the policy flags a sandbox
      // would carry: a direct run has no network boundary and no trust
      // level to apply, so a request still claiming one would run
      // unrestricted while saying restricted — silently before round 341.
      // The CLI's warning path drops the flags before building the
      // request, so only a caller that bypassed it lands here.
      if (request.sandboxNoNet || request.sandboxTrust !== undefined) {
        throw new UsageRefusalError(
          "cannot honor sandbox policy flags on a direct run; use the sandbox runner"
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
      // sandboxed path: a failing beforeLaunch (zai's missing API key)
      // must not leave scratch state behind.
      adapter.beforeLaunch();
      context = adapter.prepareRun(effective);
      if (adapter.id === "copilot" && effective.resultJson && !effective.experimentMcp) (adapter as CopilotAdapter).prepareCopilotModelRun(effective, context);
      if (options.harnessVersion !== undefined) context.harnessVersion = options.harnessVersion;
      releaseExitCleanup = registerRunExitCleanup(adapter, context);
      // A const for the receipt closures below: `context` is assigned by now, but its `let` type follows the variable.
      const runContext = context;
      // True once the run's own capture resolved: a rejection past that
      // point is processRunResult's, and a capture failure of a run that
      // spawned carries CapturedRunFailure — both ran the harness, so both
      // owe the failure receipt; a refusal before the spawn records
      // nothing (review ul8).
      const raw = await runDirect(
        adapter,
        effective,
        runContext,
        async () => {
          recordInterruption();
          try { await cleanup(); }
          finally { appendInterruptedLaunchReceipt(provider, effective, options, runContext, startedAt); }
        }
      );
      captured = true;
      capturedResult = raw;
      await (context as Parameters<CopilotAdapter["prepareCopilotModelRun"]>[1]).copilotModelRun?.complete();
      processed = adapter.processRunResult(raw, effective, context);
      processed = enforceNonEmptyResult(processed, effective, raw.exitCode);
      await cleanup();
      recordCompletedLaunch(provider, effective, options, processed, startedAt);
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
    if (adapter.id === "copilot" && request.resultJson && !request.experimentMcp && !options.printSandbox) (adapter as CopilotAdapter).prepareCopilotModelRun({ ...request, sandboxTrust: sandboxOptions.trust }, context);
    if (options.harnessVersion !== undefined) context.harnessVersion = options.harnessVersion;
    releaseExitCleanup = registerRunExitCleanup(adapter, context);
    if (context.agyProbe?.diagnostic && context.agyProbe.operatorHome) {
      // Shared temp storage is hidden. Expose only this check's HOME,
      // never the planted parent or cwd; --ro still protects the project.
      sandboxOptions.harnessStateDirs = [context.agyProbe.home ?? context.agyProbe.operatorHome];
      assertNoCallerBlockOverStateDirs(sandboxOptions.blockPaths ?? [], sandboxOptions.harnessStateDirs);
    }
    if (request.agent === "agy" && (request.hermetic || request.tools === "none") &&
        context.agyProbe?.diagnostic !== true) {
      // Block the operator's real ~/.gemini — scode's standard profile
      // leaves it writable (report-h3 item 2) — and re-allow only the
      // private home (launch/agy-isolation-sandbox.ts). Diagnostics block nothing.
      const { home, operatorHome } = context.agyProbe ?? {};
      if (home === undefined || operatorHome === undefined) {
        throw new Error("agy isolation launch requires its private home before the sandbox boundary");
      }
      applyAgyIsolationSandboxBlocks(sandboxOptions,
        { realStateRoot: join(operatorHome, ".gemini"), privateHome: home });
    }
    if (context.claudeProjectConfigDir !== undefined) {
      // A project-settings run points the harness at a private config
      // directory, but the operator's real config root still sits inside
      // the sandbox's default-allowed harness state — readable and
      // writable. Block it (and the ~/.claude.json beside it), then
      // re-allow only this run's own private directory: every other run's
      // and session's tree under .codemux-hermetic stays unreachable, and
      // scode's final guards re-assert both. A caller's own block must
      // not be re-opened by that allow: it is checked here, while
      // blockPaths still holds only the caller's --sandbox-block values
      // (review round 9, edges finding 1).
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
    // options -- is what the sandbox environment is built from. A
    // print-only launch skips prepareSandbox: it contributes nothing to
    // the argv or the sandbox options, and the claude family's
    // implementation refreshes or scrubs the operator's credential mirror
    // — state a diagnostic command that promises to run nothing must not
    // touch (review round 18, edges 2).
    if (options.printSandbox) {
      console.error("codemux: credential sandbox preparation skipped: --print-sandbox is print only");
      // The credential copy is deferred too (round 19, edges 3): getRunEnv
      // below still runs — the printed argv needs CLAUDE_CONFIG_DIR — and
      // claude's copy reads the operator's mirror (refusing a
      // refresh-token mirror) and writes into the private directory, the
      // same deferral the session's pre-claim probe uses (cli-spawn-prep.ts).
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
    // makes that mandatory: its key is the run's only credential, so a
    // scode that cannot exempt it refuses the launch rather than running
    // it stripped (the session spawns' rule, withKeepEnvExemption).
    const injectedEnv = {
      ...adapter.getEnv(),
      ...adapter.getRunEnv(request, context),
    };
    const envArg = adapter.buildExecutionEnv(injectedEnv, request.passthroughEnv);
    // Probe the same binaries and environment that the sandbox runner resolves.
    // The floor comes from SCODE_FLOORS, the table doctor reads, so a launch
    // refusal and the SANDBOX-TOO-OLD row cannot disagree on the number.
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
    await prepareExperimentRuns(adapter, request, options, context, envArg);
    // The override question reads the ADAPTER's environment view, not
    // process.env: a custom-environment launch must decide on the same
    // environment it validated against, or an unrelated ambient
    // CODEMUX_<AGENT>_PROVIDER_* value would refuse a launch whose view
    // carries no override (round al12).
    sandboxOptions = withKeepEnvExemption(
      sandboxOptions,
      injectedEnv,
      adapter.providerOverrideActive()
    );
    // The executable an active redirect (OPENCODE_BIN_PATH) selected in
    // the launch environment (review round 331, item 5): the harness's
    // own launcher execs it inside the sandbox, invisible to the command
    // re-check, so it is pinned here as a statement (every adapter hook
    // between here and the call runs after the identity was taken) and
    // revalidated immediately before the spawn. The gate has already
    // refused a redirect it could not resolve, so null only
    // means no redirect is active.
    const redirectCheck = launchRedirectCheck(
      adapter.id,
      envArg,
      effectiveWorkingDirectory(options.cwd)
    );
    // The direct path's `captured` rule, mirrored: a capture failure of a
    // run that spawned (scode included) or a processRunResult throw owes
    // the failure receipt; a refusal before the spawn (a missing scode,
    // an untrusted command) owes nothing (review ul8).
    let codexCostBinding: CodexCostBinding | null = null;
    const raw = await runSandboxedWithStdin(
      adapter.buildRunCommand(request, context),
      adapter.getStdinInput(request),
      options.cwd,
      envArg,
      options.requestedAutonomy,
      sandboxOptions,
      // One deadline governs both paths: the direct branch below runs on
      // request.timeoutMs, so the sandboxed branch does too; the guard
      // above already refused a disagreeing request/options pair.
      request.timeoutMs,
      adapter.getEnvOmissions(),
      context.stdoutSink,
      async () => {
        recordInterruption();
        try { await cleanup(); }
        finally { appendInterruptedLaunchReceipt(provider, request, options, runContext, startedAt); }
      },
      options.printSandbox,
      // The Playwright binary embedded in the --mcp-config argument
      // (review round 110): revalidated beside the runner's own positions
      // immediately before the spawn.
      context.playwrightMcpCheck ?? null,
      // The repeating decline carrier (review round 153): aider's canned
      // negatives feed the child for its whole lifetime, never a one-shot
      // block whose EOF a yes-default prompt would read as acceptance.
      adapter.stdinRepeats(request),
      // The redirect target's pin, captured above: revalidated immediately
      // before the spawn (review round 331, item 5).
      redirectCheck,
      (command, checks, resolvedPolicy) => {
        if (adapter.id === "codex") codexCostBinding = { command, checks, env: envArg,
          options: { cwd: options.cwd, sandboxed: true, autonomy: options.requestedAutonomy,
            sandboxOptions: resolvedPolicy, envOmissions: adapter.getEnvOmissions() } };
      }
    );
    if (options.printSandbox) {
      // The argv was already printed inside the runner (after every probe
      // and resolution above); nothing ran, so there is no result to
      // process, record, or receipt.
      await cleanup();
      return raw;
    }
    captured = true;
    capturedResult = raw;
    if (codexCostBinding !== null) {
      await collectCodexNativeCost(raw, request, context, codexCostBinding, adapter.providerOverrideActive());
    }
    assertExperimentCaptureBound(request, raw);
    // Read Codex's fallback before verification can trigger private-home cleanup.
    processed = earlyExperimentResult(adapter, context, request, raw);
    // Stdout EOF can precede the runner's timeout; the completion chain
    // receives the final timer outcome.
    await completeExperimentRuns(context, raw);
    await (context as Parameters<CopilotAdapter["prepareCopilotModelRun"]>[1]).copilotModelRun?.complete();
    processed ??= adapter.processRunResult(raw, request, context);
    processed = enforceNonEmptyResult(processed, request, raw.exitCode);
    recordExperimentEmptyAnswer(context, request, processed);
    await cleanup();
    recordCompletedLaunch(provider, request, options, processed, startedAt);
    return processed;
  } catch (error) {
    const armed = armExperimentFailure(adapter, request, receiptRequest, context, error,
      { capturedResult, processed });
    capturedResult = armed.capturedResult;
    processed = armed.processed;
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
      if (context) appendFailedLaunchReceipt(provider, receiptRequest, options, context, startedAt, failure,
        captured || error instanceof CapturedRunFailure, result, result.exitCode);
      return result;
    }
    if (context) appendFailedLaunchReceipt(provider, receiptRequest, options, context, startedAt, failure,
      captured || error instanceof CapturedRunFailure, processed);
    throw failure;
  }
}
