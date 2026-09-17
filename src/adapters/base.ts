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
import type { ScodeTrustLevel } from "../sandbox.js";
import { resolveTrustedCommand } from "../executable-security.js";
import {
  guardedWait,
  MAX_ARGV_PROMPT_BYTES,
  runCapturedCommand,
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

export abstract class BaseAdapter {
  abstract readonly id: AgentId;
  abstract readonly binaryName: string;

  abstract capabilities(): AdapterCapabilities;

  abstract buildRunCommand(request: RunRequest): string[];

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
   */
  getRunEnv(_request: RunRequest): Record<string, string> {
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
   * Called before every headless launch, after validation and beforeLaunch,
   * for work a run needs on disk before its command and environment can be
   * built (Codex's private hermetic home). Static command previews
   * (`verify`) never call it.
   */
  prepareRun(_request: RunRequest): void {
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

  async run(request: RunRequest): Promise<RunResult> {
    if (request.sandboxed) {
      throw new Error(
        "BaseAdapter.run cannot attest an external sandbox; use the sandbox runner"
      );
    }
    const effectiveAutonomy = request.autonomy ?? "read-only";
    if (this.requiresSandboxForAutonomy(effectiveAutonomy)) {
      throw new Error(
        `${this.id} cannot enforce '${effectiveAutonomy}' autonomy without an external sandbox`
      );
    }
    const effectiveRequest = { ...request, autonomy: effectiveAutonomy };
    this.validateRunRequest(effectiveRequest);
    this.beforeLaunch();
    this.prepareRun(effectiveRequest);
    const cwd = validateWorkingDirectory(effectiveRequest.cwd) ?? process.cwd();
    const command = this.resolveExecutionCommand(
      this.buildRunCommand(effectiveRequest),
      cwd
    );
    const stdinInput = this.getStdinInput(effectiveRequest);
    const env = this.buildExecutionEnv(
      this.getRunEnv(effectiveRequest),
      effectiveRequest.passthroughEnv
    );

    return runCapturedCommand(command, {
      cwd,
      env,
      stdinInput,
      timeoutMs: effectiveRequest.timeoutMs,
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
