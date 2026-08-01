import { BaseAdapter } from "./base.js";
import { assertNoDroidProjectExecutionConfig } from "../project-safety.js";
import { validateWorkingDirectory } from "../validation.js";
import type {
  AgentId,
  AutonomyLevel,
  ReasoningEffort,
  RunRequest,
  AdapterCapabilities,
} from "../types.js";

export class DroidAdapter extends BaseAdapter {
  readonly id: AgentId = "droid";
  readonly binaryName = "droid";

  capabilities(): AdapterCapabilities {
    return {
      supportsNonInteractive: true,
      supportsInteractive: true,
      supportsModel: true,
      supportsAutonomy: true,
      autonomyLevels: ["read-only", "low", "medium", "high"],
      supportsEffort: true,
      effortLevels: ["none", "minimal", "low", "medium", "high", "xhigh", "max"],
    };
  }

  override mapAutonomy(level: AutonomyLevel): string[] {
    switch (level) {
      case "read-only":
        return [];
      case "low":
        return ["--auto", "low"];
      case "medium":
        return ["--auto", "medium"];
      case "high":
        return ["--auto", "high"];
    }
  }

  override mapEffort(level: ReasoningEffort): string[] {
    return [
      "--reasoning-effort",
      level === "none" ? "off" : level,
    ];
  }

  private mapEffortForModel(
    level: ReasoningEffort,
    model?: string
  ): string[] {
    if (level === "none" && model?.startsWith("gpt-5.6-")) {
      return ["--reasoning-effort", "none"];
    }
    return this.mapEffort(level);
  }

  buildRunCommand(request: RunRequest): string[] {
    const cmd = ["droid", "exec"];

    if (request.model) {
      cmd.push("-m", request.model);
    }

    if (request.autonomy) {
      cmd.push(...this.mapAutonomy(request.autonomy));
    }

    if (request.effort) {
      cmd.push(...this.mapEffortForModel(request.effort, request.model));
    }

    return cmd;
  }

  override getStdinInput(request: RunRequest): string | null {
    return request.prompt;
  }

  override validateRunRequest(request: RunRequest): void {
    super.validateRunRequest(request);
    assertNoDroidProjectExecutionConfig(
      validateWorkingDirectory(request.cwd) ?? process.cwd()
    );
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
    assertNoDroidProjectExecutionConfig(
      validateWorkingDirectory(cwd) ?? process.cwd()
    );
  }

  buildTuiCommand(
    _model?: string,
    autonomy?: AutonomyLevel,
    _effort?: ReasoningEffort,
    _sandboxed?: boolean
  ): string[] {
    const cmd = ["droid"];
    if (autonomy) {
      cmd.push(...this.mapAutonomy(autonomy));
    }
    return cmd;
  }

  override supportsTuiModel(): boolean {
    return false;
  }

  override supportsTuiEffort(): boolean {
    return false;
  }
}
