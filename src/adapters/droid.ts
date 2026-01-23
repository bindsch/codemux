import { BaseAdapter } from "./base.js";
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
      effortLevels: ["none", "low", "medium", "high"],
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
    switch (level) {
      case "none":
        return ["-r", "none"];
      case "low":
        return ["-r", "low"];
      case "medium":
        return ["-r", "medium"];
      case "high":
        return ["-r", "high"];
    }
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
      cmd.push(...this.mapEffort(request.effort));
    }

    return cmd;
  }

  override getStdinInput(request: RunRequest): string | null {
    return request.prompt;
  }

  buildTuiCommand(model?: string, _autonomy?: AutonomyLevel, effort?: ReasoningEffort): string[] {
    const cmd = ["droid"];
    if (model) {
      cmd.push("-m", model);
    }
    if (effort) {
      cmd.push(...this.mapEffort(effort));
    }
    return cmd;
  }
}
