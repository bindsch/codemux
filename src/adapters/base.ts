import {
  type AgentId,
  type AutonomyLevel,
  type ReasoningEffort,
  type RunRequest,
  type RunResult,
  type AdapterCapabilities,
 type LaunchIntent } from "../types.js";
import { sanitizeEnvironment } from "../environment.js";
import { isAbsolute } from "node:path";
import { readProviderOverride, type ProviderOverride } from "../provider-override.js";
import { launchRunRequest } from "../launch.js";
import type { ExperimentFailure } from "../experiment-records.js";
import { runInteractive } from "./interactive.js";
import { validateRunRequestFor, validateTuiRequestFor } from "./base-validate.js";
import type { LoginState } from "../harness-health.js";
import type { SandboxOptions, ScodeTrustLevel } from "../sandbox.js";
import { resolveTrustedCommand, type ExecutableCheck } from "../executable-security.js";
import type { RunContext } from "../run-context.js";
import { UsageRefusalError } from "../validation.js";

export interface SandboxPreparation {
  /** The RESOLVED trust preset of the sandbox the child will run in
   * (not the raw CLI override): "standard" unless another level was
   * resolved. */
  sandboxTrust?: ScodeTrustLevel;
  /** Env var names explicitly forwarded to the child via --pass-env. */
  passthroughEnv?: readonly string[];
}

/**
 * One launch's per-run state, defined in run-context.ts: the scratch a run
 * needs on disk between prepareRun and processRunResult, owned by the
 * launcher and never recorded on the adapter. Re-exported here because
 * every adapter seam (buildRunCommand, getRunEnv, processRunResult,
 * cleanupRun) speaks it.
 */
export type { RunContext } from "../run-context.js";

export abstract class BaseAdapter {
  abstract readonly id: AgentId;
  abstract readonly binaryName: string;

  /**
   * The environment view this adapter reads operator opt-ins and provider
   * overrides from. The launch path hands it the operator's shell
   * (process.env, the default here and in getAdapter); static diagnostics
   * (`verify`) hand it only PATH, so exported opt-ins and overrides
   * cannot change a static wiring result — the contract adapters/index.ts
   * states. Every check in this class that reads an override reads this
   * view, so an adapter constructed against a view must forward it here.
   */
  constructor(protected readonly environment: NodeJS.ProcessEnv = process.env) {
    if (environment.HOME !== undefined && !isAbsolute(environment.HOME)) {
      throw new Error("HOME must be an absolute path");
    }
  }

  /**
   * The name diagnostics display for this adapter. Spawn-free by contract:
   * `doctor` prints it for every adapter and must not launch anything, so it
   * defaults to `binaryName`, which every adapter must keep resolvable
   * without executing a harness.
   */
  get displayName(): string {
    return this.binaryName;
  }

  /** The PATH this adapter's child environment carries: its environment
   * view's PATH (sanitizeEnvironment keeps it; no adapter injects one), so
   * every executable a launch embeds inside an argument resolves through
   * it like the command's own positions do (review round 391, item 13).
   * Reads the view alone, never getEnv: zai's credential resolution must
   * stay behind the session resume guards (rounds al15/al16). */
  executionPathEnv(): string {
    return this.environment.PATH ?? "";
  }

  abstract capabilities(): AdapterCapabilities;

  /**
   * The argv for a headless run. `context` carries this run's per-run state
   * when the launch path prepared one; it is omitted by static previews
   * (`verify`), which never launch, and adapters with no per-run state
   * ignore it. Codex fails closed without one (placeholder scratch paths, a
   * refused hermetic launch).
   */
  abstract buildRunCommand(request: RunRequest, context?: RunContext): string[];

  /** `nestedChecks` receives this build's own trust check of every
   * executable the command names inside an argument (the Playwright MCP
   * binary in --mcp-config JSON), so the launch re-stats the identity this
   * build resolved and never a second resolution's (review round 111). */
  abstract buildTuiCommand(
    model?: string,
    autonomy?: AutonomyLevel,
    effort?: ReasoningEffort,
    sandboxed?: boolean,
    enablePlaywrightMcp?: boolean,
    cwd?: string,
    nestedChecks?: ExecutableCheck[]
  ): string[];

  isAvailable(): boolean {
    return Bun.which(this.binaryName, { PATH: this.environment.PATH ?? "" }) !== null;
  }

  mapAutonomy(_level: AutonomyLevel): string[] {
    return [];
  }

  mapEffort(_level: ReasoningEffort): string[] {
    return [];
  }

  getStdinInput(_request: RunRequest): string | null {
    return null;
  }

  /** Whether the prompt rides argv for this request. The shared validator
   * reads this — not `getStdinInput` — to decide the argv rules (the NUL
   * refusal and the argv byte bound): an adapter whose stdin carries
   * something other than the prompt (aider's canned declines) still puts
   * the prompt in argv, and the default here is wrong for exactly that
   * shape, so such an adapter overrides it (review round 153). */
  promptInArgv(request: RunRequest): boolean {
    return this.getStdinInput(request) === null;
  }

  /** Whether the child's stdin block repeats for the child's whole
   * lifetime: the writer keeps one block in flight, writes the next only
   * after the previous flushed, and never closes stdin first. For a
   * harness that reads EOF as acceptance of a yes-default prompt (aider),
   * this is what keeps every prompt answered with a decline however many
   * arrive (review round 153). Default false: one write, then the
   * half-close every stdin-transport harness expects. */
  stdinRepeats(_request: RunRequest): boolean {
    return false;
  }

  supportsTuiModel(): boolean {
    return this.capabilities().supportsModel;
  }

  supportsTuiAutonomy(): boolean {
    return this.capabilities().supportsAutonomy;
  }

  supportsTuiEffort(): boolean {
    return this.capabilities().supportsEffort;
  }

  /**
   * Every autonomy level below `high` needs scode underneath it.
   *
   * Harness-native permission controls are treated as defense in depth, not as
   * the boundary. Upstream can restructure them without removing the flags we
   * pass -- OpenCode 1.18.18 turned its deny map into a rules list resolving to
   * allow-all, and `--agent build` kept working while silently losing its gate.
   * Anchoring the boundary in scode means an upstream change costs a warning
   * rather than a silent downgrade, and removes the need to track every
   * harness's permission semantics. `high` is exempt because the user asked for
   * auto-approval; there is no boundary left to protect.
   */
  requiresSandboxForAutonomy(level: AutonomyLevel): boolean {
    return level !== "high";
  }

  requiresSandboxForTuiAutonomy(level: AutonomyLevel): boolean {
    return this.requiresSandboxForAutonomy(level);
  }

  /**
   * The machine check's login read: whether this harness is logged in on
   * this machine, from the credential store codemux can read without
   * running the harness. Touches existence, mode, and expiry only — never
   * a credential value. The base answer is `unknown`; every adapter with a
   * readable store overrides it (src/harness-health.ts holds the readers).
   */
  loginState(): LoginState {
    return { state: "unknown", note: "no credential store codemux can read" };
  }

  /**
   * Returns custom environment variables for this adapter.
   * Override in subclasses to set things like API endpoints.
   */
  getEnv(): Record<string, string> {
    return {};
  }

  getEnvOmissions(): readonly string[] {
    return [];
  }

  buildExecutionEnv(
    extraEnv: Record<string, string> = {},
    passthroughEnv: readonly string[] = []
  ): Record<string, string> {
    const adapterProvided = {
      ...this.getEnv(),
      ...extraEnv,
    };
    const env = {
      ...this.environment,
      ...adapterProvided,
    } as Record<string, string>;
    for (const name of this.getEnvOmissions()) delete env[name];
    return sanitizeEnvironment(
      this.id,
      env,
      passthroughEnv,
      Object.keys(adapterProvided)
    );
  }

  resolveExecutionCommand(command: string[], cwd: string): string[] {
    if (
      command.length === 0 ||
      typeof command[0] !== "string" ||
      command[0].length === 0 ||
      command.some(
        (argument) =>
          typeof argument !== "string" ||
          argument.includes("\0")
      )
    ) {
      throw new Error(`${this.id} produced an invalid command`);
    }
    return resolveTrustedCommand(command, this.id, cwd, this.environment.PATH ?? "");
  }

  /**
   * Returns request-specific environment overrides for non-interactive runs.
   * `context` is the run's own when the launch path prepared one; adapters
   * that need prepared state refuse a launch without it.
   */
  getRunEnv(_request: RunRequest, _context?: RunContext): Record<string, string> {
    return {};
  }

  /**
   * Returns request-specific environment overrides for interactive runs.
   */
  getTuiEnv(
    _model?: string,
    _autonomy?: AutonomyLevel,
    _effort?: ReasoningEffort,
    _sandboxed?: boolean,
    _passthroughEnv?: readonly string[]
  ): Record<string, string> {
    return {};
  }

  /** Launch-owned interactive environment, finalized on every exit path. */
  prepareTuiEnvironment(model?: string, autonomy?: AutonomyLevel, effort?: ReasoningEffort,
    sandboxed?: boolean, passthroughEnv?: readonly string[], _printOnly = false) {
    return { env: this.getTuiEnv(model, autonomy, effort, sandboxed, passthroughEnv), finalize: () => {} };
  }

  /**
   * Called before launching the agent. Use for banners, validation, etc.
   * Throw to abort launch.
   */
  beforeLaunch(): void {
    // Default: no-op
  }

  resultModel(request: RunRequest): string | undefined { return request.model; }

  /**
   * Post-processes a finished run's captured result on every launch path
   * (sandboxed and direct). Adapters whose harness prints something other
   * than the reply on stdout (`--result-json` envelopes, codex's event
   * stream) override this to hand the caller what they were promised; the
   * default returns the result unchanged. `context` is the same run context
   * the launch path built the command from, so the post-processor reads
   * (and consumes) this run's own scratch. It preserves reply text and
   * scanSurface before cleanup. An experiment failure permits partial output.
   */
  processRunResult(result: RunResult, _request: RunRequest, _context?: RunContext, _failure?: ExperimentFailure): RunResult {
    return result;
  }

  /**
   * Called before every headless launch, after validation and beforeLaunch.
   * Returns the run's context: every piece of per-run state (scratch paths,
   * the private hermetic home) the run needs between here and
   * processRunResult, as plain data the caller owns and threads through the
   * lifecycle. Records NOTHING on the adapter: adapters are singletons, and
   * an adapter field here would let a concurrent launch read or overwrite
   * another run's state. Static command previews (`verify`) never call it.
   *
   * A sandboxed launch passes the RESOLVED sandbox trust as `sandboxTrust`,
   * so preparation can skip what an untrusted sandbox denies the child
   * (codex prepares no `--output-last-message` file under it); a direct
   * launch passes nothing, and adapters that need no trust keep ignoring it.
   * The full sandbox options let authentication selection account for scrubbing.
   */
  prepareRun(_request: RunRequest, _sandboxTrust?: ScodeTrustLevel, _sandboxOptions?: SandboxOptions, _launch?: LaunchIntent): RunContext {
    // Most adapters need no per-run state.
    return {};
  }

  /**
   * Disposes one launch's own context once that launch is over. The launch
   * path (launch.ts) calls it exactly once for each context it created:
   * after a finished run -- processRunResult has already consumed what it
   * could there (codex reads and removes its `--output-last-message` file),
   * and cleanupRun disposes whatever remains (the per-run temp directory,
   * the private hermetic home) -- after a rejected launch, where
   * processRunResult never ran, and before the runner's signal exit.
   * Unexpected exits use the separate synchronous cleanupRunSync backstop.
   * Whatever the run may already
   * have written on disk (codex's `--output-last-message` file holds model
   * output) must not outlive the run. May throw or reject when cleanup fails;
   * callers await completion and append cleanup errors to a completed result.
   * Exit handlers can only perform synchronous termination and report errors.
   * Only receives the context the same launch created, never another run's.
   */
  cleanupRun(context?: RunContext): void | Promise<void> {
    this.cleanupRunSync(context);
  }

  /** Exit backstop: implementations must use synchronous operations only.
   * `atExit` is true on the process-exit backstop's call (run-exit-cleanup),
   * the last attempt there can be: a retryable failure may release what it
   * holds then, since no later call exists. */
  cleanupRunSync(_context?: RunContext, _atExit?: boolean): void {}

  /** Whether a cleanup that failed kept state a later cleanupRunSync call
   * can still use. The launcher keeps its exit backstop registered only
   * then; for every other failure a second call would do nothing. */
  cleanupRetryPending(_context?: RunContext): boolean {
    return false;
  }

  /**
   * Called before a SANDBOXED launch only, after beforeLaunch. Use for
   * preparation that only sandboxed processes need — e.g. materializing a
   * credential a sandbox cannot fetch itself. Unsandboxed launches must not
   * pay these side effects. The context carries the resolved sandbox trust
   * level, so preparation can skip work an untrusted sandbox cannot use.
   */
  prepareSandbox(_context: SandboxPreparation = {}): void {
    // Default: no-op
  }

  configurationIssues(): string[] {
    return [];
  }

  /** The provider override in THIS adapter's environment view, read from
   * the same `readProviderOverride(this.id, this.environment)` call every
   * override consumer in this class makes. Throws on a malformed override
   * exactly as the direct call does. Receipts and other records that must
   * name the endpoint a launch used read it through here, never
   * process.env, so an adapter built against a custom environment is
   * recorded against the provider it actually ran (round 137). */
  providerOverride(): ProviderOverride | null {
    return readProviderOverride(this.id, this.environment);
  }

  /** Whether a provider override is active in THIS adapter's environment
   * view. The launch path's keep-env gate asks this (launch.ts) so a
   * custom-environment launch decides on the same view the adapter
   * validated against — never the ambient process.env, where an unrelated
   * malformed CODEMUX_<AGENT>_PROVIDER_* value would fail a launch whose
   * own view has no override at all (round al12). */
  providerOverrideActive(): boolean {
    return this.providerOverride() !== null;
  }

  /**
   * Refuses a provider override this harness cannot carry. A set
   * CODEMUX_<AGENT>_PROVIDER_* name on an unsupported harness must fail the
   * run loudly: honoring it silently would bill the operator's ordinary
   * provider while they believe the override routed the run (the same rule
   * that refuses an uncarryable token cap). Base validators call this;
   * supporting adapters read the override themselves past it. The override
   * is read from this adapter's environment view, not process.env, so
   * `verify` (PATH-only view) never reports an exported override as broken
   * wiring while a real launch still refuses it.
   */
  // Public for base-validate.ts's structural seam; no adapter overrides it.
  assertNoUnsupportedProviderOverride(): void {
    if (this.capabilities().supportsProviderOverride) return;
    const override = readProviderOverride(this.id, this.environment);
    if (override !== null) {
      throw new UsageRefusalError(
        `${this.id} does not support a provider override; unset ` +
          `CODEMUX_${this.id.toUpperCase()}_PROVIDER_* to run it, or route ` +
          "through an agent that does (codemux list marks them \"provider\")"
      );
    }
  }

  /** What a launch's override validation would say about this adapter's
   * environment view: the unsupported-override refusal, then the adapter's
   * own validator (provider shape, token caps) where it has one. The
   * refusal's first line, or null when a launch would accept the override
   * (review round 45; the machine check reads this). */
  providerOverrideIssue(): string | null {
    try {
      this.assertNoUnsupportedProviderOverride();
      (this as unknown as { validatedProvider?: () => unknown }).validatedProvider?.();
      return null;
    } catch (error) {
      return error instanceof Error ? error.message.split("\n")[0] ?? "" : String(error);
    }
  }

  validateRunRequest(request: RunRequest): void {
    validateRunRequestFor(this, request);
  }

  validateTuiRequest(
    model?: string,
    cwd?: string,
    autonomy: AutonomyLevel = "read-only",
    effort?: ReasoningEffort,
    passthroughEnv: readonly string[] = [],
    enablePlaywrightMcp = false
  ): void {
    validateTuiRequestFor(this, {
      model,
      cwd,
      autonomy,
      effort,
      passthroughEnv,
      enablePlaywrightMcp,
    });
  }

  /**
   * Runs one request directly, without a sandbox, through the one launch
   * path (launch.ts): the same result and refusals as launchRunRequest —
   * a request that claims a sandbox or needs one is refused.
   */
  async run(request: RunRequest): Promise<RunResult> {
    // The request's own cwd, never an implicit process.cwd() (review round
    // 16, edges 2): the launch's cwd guards compare options.cwd with it.
    return launchRunRequest(this, request, {
      sandbox: false,
      requestedAutonomy: request.autonomy ?? "read-only",
      cwd: request.cwd,
    });
  }

  async runInteractive(...args: Parameters<typeof runInteractive>): Promise<number> {
    return runInteractive.call(this, ...args);
  }
}
