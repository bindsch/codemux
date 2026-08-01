import type {
  AgentId,
  AutonomyLevel,
  ReasoningEffort,
  RunRequest,
  RunResult,
  AdapterCapabilities,
} from "../types.js";
import { sanitizeEnvironment } from "../environment.js";
import { resolveTrustedExecutable } from "../executable-security.js";
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

  requiresSandboxForAutonomy(_level: AutonomyLevel): boolean {
    return false;
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
    const requestedBinary = command[0]!;
    const binaryPath = Bun.which(requestedBinary, { PATH: process.env.PATH });
    if (!binaryPath) {
      throw new Error(`${this.id} executable '${requestedBinary}' was not found`);
    }
    return [
      resolveTrustedExecutable(binaryPath, this.id, cwd),
      ...command.slice(1),
    ];
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
