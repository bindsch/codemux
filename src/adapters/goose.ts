import { BaseAdapter } from "./base.js";
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
      supportsModel: false,
      supportsAutonomy: true,
      autonomyLevels: ["read-only", "low", "medium", "high"],
      supportsEffort: false,
      effortLevels: [],
    };
  }

  override mapAutonomy(level: AutonomyLevel): string[] {
    return [`GOOSE_MODE=${this.mapAutonomyToMode(level)}`];
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
    const mode = `GOOSE_MODE=${request.autonomy ? this.mapAutonomyToMode(request.autonomy) : "smart_approve"}`;
    return ["env", mode, "goose", "run", "-t", request.prompt];
  }

  buildTuiCommand(
    _model?: string,
    autonomy?: AutonomyLevel,
    _effort?: ReasoningEffort,
    _sandboxed?: boolean
  ): string[] {
    const mode = `GOOSE_MODE=${autonomy ? this.mapAutonomyToMode(autonomy) : "smart_approve"}`;
    return ["env", mode, "goose"];
  }
}
