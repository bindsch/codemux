import { BaseAdapter } from "./base.js";
import type {
  AgentId,
  AutonomyLevel,
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

    cmd.push(request.prompt);

    return cmd;
  }

  buildTuiCommand(model?: string): string[] {
    const cmd = ["claude"];
    if (model) {
      cmd.push("--model", model);
    }
    return cmd;
  }
}
