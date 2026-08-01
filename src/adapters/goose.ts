import { BaseAdapter } from "./base.js";
import { assertNoGooseProjectExecutionConfig } from "../project-safety.js";
import { validateWorkingDirectory } from "../validation.js";
import type {
  AgentId,
  AutonomyLevel,
  ReasoningEffort,
  RunRequest,
  AdapterCapabilities,
} from "../types.js";

export class GooseAdapter extends BaseAdapter {
  readonly id: AgentId = "goose";
  readonly binaryName = "goose";

  capabilities(): AdapterCapabilities {
    return {
      supportsNonInteractive: true,
      supportsInteractive: true,
      supportsModel: true,
      supportsAutonomy: true,
      autonomyLevels: ["read-only", "low", "medium", "high"],
      supportsEffort: false,
      effortLevels: [],
    };
  }

  override mapAutonomy(_level: AutonomyLevel): string[] {
    return [];
  }

  private resolveMode(level?: AutonomyLevel): string {
    return this.mapAutonomyToMode(level ?? "read-only");
  }

  private mapAutonomyToMode(level: AutonomyLevel): string {
    switch (level) {
      case "read-only":
        return "chat";
      case "low":
        return "approve";
      case "medium":
        return "smart_approve";
      case "high":
        return "auto";
    }
  }

  buildRunCommand(request: RunRequest): string[] {
    return ["goose", "run", "-t", request.prompt];
  }

  override validateRunRequest(request: RunRequest): void {
    super.validateRunRequest(request);
    assertNoGooseProjectExecutionConfig(
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
    assertNoGooseProjectExecutionConfig(
      validateWorkingDirectory(cwd) ?? process.cwd()
    );
  }

  override getRunEnv(request: RunRequest): Record<string, string> {
    return {
      GOOSE_MODE: this.resolveMode(request.autonomy),
      ...(request.model ? { GOOSE_MODEL: request.model } : {}),
    };
  }

  buildTuiCommand(
    _model?: string,
    _autonomy?: AutonomyLevel,
    _effort?: ReasoningEffort,
    _sandboxed?: boolean
  ): string[] {
    return ["goose"];
  }

  override getTuiEnv(
    model?: string,
    autonomy?: AutonomyLevel,
    _effort?: ReasoningEffort,
    _sandboxed?: boolean
  ): Record<string, string> {
    return {
      GOOSE_MODE: this.resolveMode(autonomy),
      ...(model ? { GOOSE_MODEL: model } : {}),
    };
  }
}
