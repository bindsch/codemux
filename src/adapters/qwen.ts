import { BaseAdapter } from "./base.js";
import {
  readProviderOverride,
  requireProviderOverride,
  type ProviderOverride,
} from "../provider-override.js";
import type {
  AgentId,
  AutonomyLevel,
  ReasoningEffort,
  RunRequest,
  AdapterCapabilities,
} from "../types.js";

export class QwenAdapter extends BaseAdapter {
  readonly id: AgentId = "qwen";

  get binaryName(): string {
    return this.isLegacyBinary ? "qwen-coder" : "qwen";
  }

  private readonly resolvedBinary: string | null;
  private readonly isLegacyBinary: boolean;

  capabilities(): AdapterCapabilities {
    return {
      supportsNonInteractive: true,
      supportsInteractive: true,
      supportsModel: !this.isLegacyBinary,
      supportsAutonomy: true,
      autonomyLevels: ["read-only", "low", "medium", "high"],
      supportsEffort: false,
      effortLevels: [],
      // Every codemux qwen run already passes --safe-mode, which closes
      // every operator channel by construction, so --hermetic has nothing
      // left to close and its control can never leak; no tool-removal
      // flag survives safe mode. Both refusals are detailed in
      // docs/HERMETIC.md.
      supportsHermetic: false,
      supportsToolSelection: false,
    };
  }

  constructor(
    private readonly findBinary: (name: string) => string | null = (name) =>
      Bun.which(name, { PATH: process.env.PATH }),
    private readonly environment: NodeJS.ProcessEnv = process.env
  ) {
    super();
    const currentBinary = this.findBinary("qwen");
    const legacyBinary = currentBinary ? null : this.findBinary("qwen-coder");
    this.resolvedBinary = currentBinary ?? legacyBinary;
    this.isLegacyBinary = currentBinary === null && legacyBinary !== null;
  }

  private resolveBinary(): string {
    return this.resolvedBinary ?? "qwen";
  }

  override isAvailable(): boolean {
    return this.resolvedBinary !== null;
  }

  /**
   * The provider override, validated: qwen's env delivery needs a base URL
   * and a key (the model may come from `--model` instead of the variable).
   * The legacy qwen-coder binary predates the OpenAI-compatible endpoint
   * group, so it refuses the override rather than half-applying it.
   */
  private validatedProvider(): (ProviderOverride & { baseUrl: string; apiKey: string }) | null {
    const override = readProviderOverride("qwen", this.environment);
    if (override === null) return null;
    if (this.isLegacyBinary) {
      throw new Error(
        "the qwen provider override supports the current qwen CLI only; the legacy qwen-coder binary has no OpenAI-compatible endpoint group"
      );
    }
    return requireProviderOverride("qwen", override, [
      "baseUrl",
      "apiKey",
    ]) as ProviderOverride & { baseUrl: string; apiKey: string };
  }

  /** The model the override routes: the request's, else the override's. */
  private modelFor(model: string | undefined): string | undefined {
    const override = this.validatedProvider();
    const resolved = model ?? override?.model;
    if (resolved === undefined && override !== null) {
      throw new Error(
        "qwen needs a model for the provider override; pass --model or set CODEMUX_QWEN_PROVIDER_MODEL"
      );
    }
    return resolved;
  }

  override mapAutonomy(level: AutonomyLevel): string[] {
    switch (level) {
      case "read-only":
        return ["--approval-mode", "plan"];
      case "low":
        return ["--approval-mode", "default"];
      case "medium":
        return ["--approval-mode", "auto"];
      case "high":
        return ["--approval-mode", "yolo"];
    }
  }

  override requiresSandboxForAutonomy(level: AutonomyLevel): boolean {
    // The legacy binary cannot enforce any level on its own, so it needs the
    // boundary even at `high`, which the base policy exempts.
    return this.isLegacyBinary || super.requiresSandboxForAutonomy(level);
  }

  buildRunCommand(request: RunRequest): string[] {
    const binary = this.resolveBinary();

    if (this.isLegacyBinary) {
      if (request.model) {
        throw new Error("qwen-coder does not support model selection");
      }
      if (!request.sandboxed) {
        throw new Error(
          "qwen-coder cannot enforce autonomy levels; use --sandbox or install the current qwen CLI"
        );
      }
      return [binary, "--", request.prompt];
    }

    const cmd = [binary, "--safe-mode"];
    if (request.model) {
      cmd.push("--model", request.model);
    }
    if (request.autonomy) {
      cmd.push(...this.mapAutonomy(request.autonomy));
    }
    return cmd;
  }

  override getStdinInput(request: RunRequest): string | null {
    return this.isLegacyBinary ? null : request.prompt;
  }

  /**
   * The provider override rides the environment group qwen documents for
   * headless setups — "set provider environment variables, for example
   * OPENAI_API_KEY + OPENAI_BASE_URL + OPENAI_MODEL" (the removed `qwen
   * auth` farewell, 0.24.0; configuration/auth.md in the package) — so the
   * key never touches argv or an operator file, and every codemux qwen run
   * already carries --safe-mode without disturbing it. When `--model` is
   * also passed the same value rides OPENAI_MODEL, so the flag/env
   * precedence cannot split the run.
   */
  private providerEnv(model: string | undefined): Record<string, string> {
    const override = this.validatedProvider();
    if (override === null) return {};
    const resolved = this.modelFor(model);
    return {
      OPENAI_API_KEY: override.apiKey,
      OPENAI_BASE_URL: override.baseUrl,
      ...(resolved ? { OPENAI_MODEL: resolved } : {}),
    };
  }

  override getRunEnv(request: RunRequest): Record<string, string> {
    return this.providerEnv(request.model);
  }

  override validateRunRequest(request: RunRequest): void {
    super.validateRunRequest(request);
    // Fail before launch on a half-configured override, and surface the
    // model requirement early: qwen's own default model would otherwise be
    // sent to the override endpoint.
    this.modelFor(request.model);
  }

  buildTuiCommand(
    model?: string,
    autonomy?: AutonomyLevel,
    _effort?: ReasoningEffort,
    sandboxed?: boolean
  ): string[] {
    const binary = this.resolveBinary();
    if (this.isLegacyBinary) {
      if (model) {
        throw new Error("qwen-coder does not support model selection");
      }
      if (!sandboxed) {
        throw new Error(
          "qwen-coder cannot enforce autonomy levels; use --sandbox or install the current qwen CLI"
        );
      }
      return [binary];
    }

    const cmd = [binary, "--safe-mode"];
    if (model) {
      cmd.push("--model", model);
    }
    if (autonomy) {
      cmd.push(...this.mapAutonomy(autonomy));
    }
    return cmd;
  }

  override getTuiEnv(
    model?: string,
    _autonomy?: AutonomyLevel,
    _effort?: ReasoningEffort,
    _sandboxed?: boolean
  ): Record<string, string> {
    return this.providerEnv(model);
  }

  override validateTuiRequest(
    model?: string,
    cwd?: string,
    autonomy: AutonomyLevel = "read-only",
    effort?: ReasoningEffort,
    passthroughEnv: readonly string[] = [],
    enablePlaywrightMcp = false
  ): void {
    super.validateTuiRequest(model, cwd, autonomy, effort, passthroughEnv, enablePlaywrightMcp);
    this.modelFor(model);
  }
}
