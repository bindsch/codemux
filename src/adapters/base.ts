import {
  TOOL_SELECTIONS,
  isToolSelection,
  type AgentId,
  type AutonomyLevel,
  type ReasoningEffort,
  type RunRequest,
  type RunResult,
  type AdapterCapabilities,
} from "../types.js";
import { sanitizeEnvironment } from "../environment.js";
import { readProviderOverride } from "../provider-override.js";
import { launchRunRequest } from "../launch.js";
import type { ScodeTrustLevel } from "../sandbox.js";
import { resolveTrustedCommand } from "../executable-security.js";
import type { RunContext } from "../run-context.js";
import {
  guardedWait,
  MAX_ARGV_PROMPT_BYTES,
  validateTimeout,
} from "../process-runner.js";
import {
  validateAutonomy,
  validateEffort,
  validateEnvironmentNames,
  validateModelName,
  validatePrompt,
  validateWorkingDirectory,
} from "../validation.js";

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
   * (`verify`) hand it an explicitly empty view, so an exported variable
   * cannot change a static wiring result — the contract adapters/index.ts
   * states. Every check in this class that reads an override reads this
   * view, so an adapter constructed against a view must forward it here.
   */
  constructor(protected readonly environment: NodeJS.ProcessEnv = process.env) {}

  /**
   * The name diagnostics display for this adapter. Spawn-free by contract:
   * `doctor` prints it for every adapter and must not launch anything, so it
   * defaults to `binaryName`, which every adapter must keep resolvable
   * without executing a harness.
   */
  get displayName(): string {
    return this.binaryName;
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

  abstract buildTuiCommand(
    model?: string,
    autonomy?: AutonomyLevel,
    effort?: ReasoningEffort,
    sandboxed?: boolean,
    enablePlaywrightMcp?: boolean,
    cwd?: string
  ): string[];

  isAvailable(): boolean {
    return Bun.which(this.binaryName, { PATH: process.env.PATH }) !== null;
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
      ...process.env,
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
    return resolveTrustedCommand(command, this.id, cwd);
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
    _sandboxed?: boolean
  ): Record<string, string> {
    return {};
  }

  /**
   * Called before launching the agent. Use for banners, validation, etc.
   * Throw to abort launch.
   */
  beforeLaunch(): void {
    // Default: no-op
  }

  /**
   * Post-processes a finished run's captured result on every launch path
   * (sandboxed and direct). Adapters whose harness prints something other
   * than the reply on stdout (`--result-json` envelopes, codex's event
   * stream) override this to hand the caller what they were promised; the
   * default returns the result unchanged. `context` is the same run context
   * the launch path built the command from, so the post-processor reads
   * (and consumes) this run's own scratch. A harness that records the
   * conversation somewhere stdout does not carry (aider's chat history)
   * reads it HERE, while the context is alive, and sets the result's
   * `reply` and `scanSurface` fields -- the only channel post-launch
   * callers (the hermetic check above all) have to that record, because
   * the launcher disposes the context before the result returns.
   */
  processRunResult(result: RunResult, _request: RunRequest, _context?: RunContext): RunResult {
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
   */
  prepareRun(_request: RunRequest, _sandboxTrust?: ScodeTrustLevel): RunContext {
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
   * processRunResult never ran, and at process exit for a run the lifecycle
   * cannot finish (the process runner's exit 143 on a signal;
   * run-exit-cleanup registers that call). Whatever the run may already
   * have written on disk (codex's `--output-last-message` file holds model
   * output) must not outlive the run. Must not throw: the outcome it
   * follows -- a rejection above all -- is the failure the caller needs,
   * and a cleanup error must not replace it. Only ever receives the
   * context the same launch created, never another run's.
   */
  cleanupRun(_context?: RunContext): void {
    // Default: no-op
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

  /**
   * Refuses a provider override this harness cannot carry. A set
   * CODEMUX_<AGENT>_PROVIDER_* name on an unsupported harness must fail the
   * run loudly: honoring it silently would bill the operator's ordinary
   * provider while they believe the override routed the run (the same rule
   * that refuses an uncarryable token cap). Base validators call this;
   * supporting adapters read the override themselves past it. The override
   * is read from this adapter's environment view, not process.env, so
   * `verify` (empty view) never reports an exported override as broken
   * wiring while a real launch still refuses it.
   */
  protected assertNoUnsupportedProviderOverride(): void {
    if (this.capabilities().supportsProviderOverride) return;
    const override = readProviderOverride(this.id, this.environment);
    if (override !== null) {
      throw new Error(
        `${this.id} does not support a provider override; unset ` +
          `CODEMUX_${this.id.toUpperCase()}_PROVIDER_* to run it, or route ` +
          "through an agent that does (codemux list marks them \"provider\")"
      );
    }
  }

  validateRunRequest(request: RunRequest): void {
    if (typeof request !== "object" || request === null) {
      throw new Error("run request must be an object");
    }
    if (request.agent !== this.id) {
      throw new Error(
        `request agent '${request.agent}' does not match adapter '${this.id}'`
      );
    }
    const caps = this.capabilities();
    if (!caps.supportsNonInteractive) {
      throw new Error(`${this.id} does not support non-interactive execution`);
    }
    this.assertNoUnsupportedProviderOverride();
    validatePrompt(request.prompt);
    if (request.model !== undefined) {
      validateModelName(request.model);
      if (!caps.supportsModel) {
        throw new Error(`${this.id} does not support model selection`);
      }
    }
    const autonomy = validateAutonomy(request.autonomy);
    if (
      autonomy !== undefined &&
      (!caps.supportsAutonomy || !caps.autonomyLevels.includes(autonomy))
    ) {
      throw new Error(`${this.id} does not support autonomy level '${autonomy}'`);
    }
    const effort = validateEffort(request.effort);
    if (
      effort !== undefined &&
      (!caps.supportsEffort || !caps.effortLevels.includes(effort))
    ) {
      throw new Error(`${this.id} does not support reasoning effort '${effort}'`);
    }
    validateWorkingDirectory(request.cwd);
    validateEnvironmentNames(request.passthroughEnv);
    if (
      request.sandboxed !== undefined &&
      typeof request.sandboxed !== "boolean"
    ) {
      throw new Error("sandboxed must be a boolean");
    }
    if (
      request.enablePlaywrightMcp !== undefined &&
      typeof request.enablePlaywrightMcp !== "boolean"
    ) {
      throw new Error("enablePlaywrightMcp must be a boolean");
    }
    if (request.hermetic !== undefined && typeof request.hermetic !== "boolean") {
      throw new Error("hermetic must be a boolean");
    }
    if (request.resultJson !== undefined && typeof request.resultJson !== "boolean") {
      throw new Error("resultJson must be a boolean");
    }
    if (request.resultJson && !caps.supportsResultJson) {
      // Refuse rather than run and return plain text: a caller that asked for usage and got
      // none would record a run as costing nothing.
      throw new Error(
        `${this.id} cannot return a structured result envelope; --result-json is unsupported`
      );
    }
    if (request.hermetic && !caps.supportsHermetic) {
      // Only a mechanism verified by `codemux check --hermetic` may claim this;
      // an unverified harness would quietly run with the operator's context.
      throw new Error(
        `${this.id} has no verified hermetic mode; see docs/HERMETIC.md`
      );
    }
    if (request.tools !== undefined) {
      if (typeof request.tools !== "string" || !isToolSelection(request.tools)) {
        throw new Error(`tools must be one of: ${TOOL_SELECTIONS.join(", ")}`);
      }
      if (request.tools === "none" && !caps.supportsToolSelection) {
        throw new Error(
          `${this.id} cannot remove its built-in tools; see docs/HERMETIC.md`
        );
      }
    }
    if (request.instructionDirs !== undefined) {
      if (!Array.isArray(request.instructionDirs)) {
        throw new Error("instructionDirs must be an array of directories");
      }
      for (const dir of request.instructionDirs) validateWorkingDirectory(dir);
    }
    if (request.timeoutMs !== undefined) validateTimeout(request.timeoutMs);
    if (this.getStdinInput(request) === null) {
      if (request.prompt.includes("\0")) {
        throw new Error(`${this.id} cannot pass a NUL byte in an argv prompt`);
      }
      if (Buffer.byteLength(request.prompt, "utf8") > MAX_ARGV_PROMPT_BYTES) {
        throw new Error(
          `${this.id} passes prompts in argv; prompt exceeds the ${MAX_ARGV_PROMPT_BYTES}-byte safe limit`
        );
      }
    }
  }

  validateTuiRequest(
    model?: string,
    cwd?: string,
    autonomy: AutonomyLevel = "read-only",
    effort?: ReasoningEffort,
    passthroughEnv: readonly string[] = [],
    enablePlaywrightMcp = false
  ): void {
    const caps = this.capabilities();
    if (!caps.supportsInteractive) {
      throw new Error(`${this.id} does not support interactive execution`);
    }
    this.assertNoUnsupportedProviderOverride();
    if (model !== undefined) {
      validateModelName(model);
      if (!this.supportsTuiModel()) {
        throw new Error(`${this.id} does not support model selection in TUI mode`);
      }
    }
    validateAutonomy(autonomy);
    if (!this.supportsTuiAutonomy()) {
      throw new Error(`${this.id} does not support autonomy in TUI mode`);
    }
    if (!caps.autonomyLevels.includes(autonomy)) {
      throw new Error(`${this.id} does not support autonomy level '${autonomy}'`);
    }
    if (effort !== undefined) {
      validateEffort(effort);
      if (!this.supportsTuiEffort() || !caps.effortLevels.includes(effort)) {
        throw new Error(
          `${this.id} does not support reasoning effort '${effort}' in TUI mode`
        );
      }
    }
    validateWorkingDirectory(cwd);
    validateEnvironmentNames(passthroughEnv);
    if (typeof enablePlaywrightMcp !== "boolean") {
      throw new Error("enablePlaywrightMcp must be a boolean");
    }
  }

  /**
   * Runs one request directly, without a sandbox, by delegating to the one
   * launch path (launch.ts): validation, beforeLaunch, the run context, the
   * spawn, processRunResult, and cleanup all happen there. A standalone
   * caller therefore gets the same post-processed result a launchRunRequest
   * caller gets -- a `resultJson` run returns its envelope, never raw
   * harness output, and the run's scratch is disposed before the result
   * returns. The launch path refuses a request that claims a sandbox and
   * one whose autonomy needs one, exactly as it does for its own callers.
   */
  async run(request: RunRequest): Promise<RunResult> {
    return launchRunRequest(this, request, {
      sandbox: false,
      requestedAutonomy: request.autonomy ?? "read-only",
    });
  }

  async runInteractive(
    model?: string,
    cwd?: string,
    autonomy?: AutonomyLevel,
    effort?: ReasoningEffort,
    sandboxed = false,
    passthroughEnv: readonly string[] = [],
    enablePlaywrightMcp = false
  ): Promise<number> {
    if (sandboxed) {
      throw new Error(
        "BaseAdapter.runInteractive cannot attest an external sandbox; use the sandbox runner"
      );
    }
    const effectiveAutonomy = autonomy ?? "read-only";
    this.validateTuiRequest(
      model,
      cwd,
      effectiveAutonomy,
      effort,
      passthroughEnv,
      enablePlaywrightMcp
    );
    if (this.requiresSandboxForTuiAutonomy(effectiveAutonomy)) {
      throw new Error(
        `${this.id} cannot enforce '${effectiveAutonomy}' autonomy without an external sandbox`
      );
    }
    this.beforeLaunch();
    const workdir = validateWorkingDirectory(cwd) ?? process.cwd();
    const command = this.resolveExecutionCommand(this.buildTuiCommand(
      model,
      effectiveAutonomy,
      effort,
      false,
      enablePlaywrightMcp,
      workdir
    ), workdir);
    const env = this.buildExecutionEnv(
      this.getTuiEnv(model, effectiveAutonomy, effort, false),
      passthroughEnv
    );

    const proc = Bun.spawn(command, {
      cwd: workdir,
      stdout: "inherit",
      stderr: "inherit",
      stdin: "inherit",
      env,
    });

    return await guardedWait(proc);
  }
}
