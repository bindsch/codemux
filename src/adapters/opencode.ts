import { BaseAdapter } from "./base.js";
import type {
  AgentId,
  AutonomyLevel,
  ReasoningEffort,
  RunRequest,
  AdapterCapabilities,
} from "../types.js";

export class OpencodeAdapter extends BaseAdapter {
  readonly id: AgentId = "opencode";
  readonly binaryName = "opencode";

  capabilities(): AdapterCapabilities {
    return {
      supportsNonInteractive: true,
      supportsInteractive: true,
      supportsModel: true,
      supportsAutonomy: true,
      autonomyLevels: ["read-only", "high"],
      supportsEffort: false,
      effortLevels: [],
    };
  }

  override mapAutonomy(level: AutonomyLevel): string[] {
    switch (level) {
      case "read-only":
        return ["--agent", "explore"];
      case "high":
        return ["--agent", "build"];
      default:
        return [];
    }
  }

  buildRunCommand(request: RunRequest): string[] {
    const cmd = ["opencode", "run"];

    if (request.model) {
      cmd.push("--model", request.model);
    }

    if (request.autonomy) {
      cmd.push(...this.mapAutonomy(request.autonomy));
    }

    cmd.push("-"); // read prompt from stdin

    return cmd;
  }

  override getStdinInput(request: RunRequest): string | null {
    return request.prompt;
  }

  buildTuiCommand(model?: string, autonomy?: AutonomyLevel, _effort?: ReasoningEffort): string[] {
    const cmd = ["opencode"];
    if (model) {
      cmd.push("--model", model);
    }
    if (autonomy) {
      cmd.push(...this.mapAutonomy(autonomy));
    }
    return cmd;
  }
}
