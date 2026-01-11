import { BaseAdapter } from "./base.js";
import type {
  AgentId,
  AutonomyLevel,
  RunRequest,
  AdapterCapabilities,
} from "../types.js";

export class CodexAdapter extends BaseAdapter {
  readonly id: AgentId = "codex";
  readonly binaryName = "codex";

  capabilities(): AdapterCapabilities {
    return {
      supportsNonInteractive: true,
      supportsInteractive: true,
      supportsModel: true,
      supportsAutonomy: true,
      autonomyLevels: ["read-only", "medium", "high"],
    };
  }

  override mapAutonomy(level: AutonomyLevel): string[] {
    switch (level) {
      case "read-only":
        return ["-s", "read-only"];
      case "low":
        console.warn("Warning: codex does not support 'low' autonomy, using 'read-only'");
        return ["-s", "read-only"];
      case "medium":
        return ["-s", "workspace-write"];
      case "high":
        return ["-s", "danger-full-access"];
    }
  }

  buildRunCommand(request: RunRequest): string[] {
    const cmd = ["codex", "exec"];

    if (request.model) {
      cmd.push("-m", request.model);
    }

    if (request.autonomy) {
      cmd.push(...this.mapAutonomy(request.autonomy));
    }

    cmd.push(request.prompt);

    return cmd;
  }

  buildTuiCommand(model?: string): string[] {
    const cmd = ["codex"];
    if (model) {
      cmd.push("-m", model);
    }
    return cmd;
  }
}
