import { BaseAdapter } from "./base.js";
import type {
  AgentId,
  AutonomyLevel,
  ReasoningEffort,
  RunRequest,
  AdapterCapabilities,
} from "../types.js";

export class ClaudeAdapter extends BaseAdapter {
  readonly id: AgentId = "claude";
  readonly binaryName = "claude";

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

  override mapAutonomy(level: AutonomyLevel): string[] {
    switch (level) {
      case "read-only":
        return [];
      case "low":
        return ["--permission-mode", "acceptEdits"];
      case "medium":
        return ["--permission-mode", "dontAsk"];
      case "high":
        return ["--dangerously-skip-permissions"];
    }
  }

  buildRunCommand(request: RunRequest): string[] {
    const cmd = ["claude", "-p"];

    if (request.model) {
      cmd.push("--model", request.model);
    }

    if (request.autonomy) {
      cmd.push(...this.mapAutonomy(request.autonomy));
    }

    return cmd;
  }

  override getStdinInput(request: RunRequest): string | null {
    return request.prompt;
  }

  buildTuiCommand(model?: string, autonomy?: AutonomyLevel, _effort?: ReasoningEffort): string[] {
    const cmd = ["claude"];
    if (model) {
      cmd.push("--model", model);
    }
    if (autonomy) {
      cmd.push(...this.mapAutonomy(autonomy));
    }
    return cmd;
  }
}
