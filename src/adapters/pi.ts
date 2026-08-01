import { BaseAdapter } from "./base.js";
import type {
  AgentId,
  AutonomyLevel,
  ReasoningEffort,
  RunRequest,
  AdapterCapabilities,
} from "../types.js";

export class PiAdapter extends BaseAdapter {
  readonly id: AgentId = "pi";
  readonly binaryName = "pi";

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
        return ["--no-extensions", "--tools", "read,grep,find,ls"];
      case "low":
        return [
          "--no-extensions",
          "--tools",
          "read,grep,find,ls,edit,write",
        ];
      case "medium":
        console.warn("Warning: pi has no dedicated 'medium' approval mode, using default tool-enabled mode");
        return [];
      case "high":
        console.warn("Warning: pi has no dedicated 'high' approval mode, using default tool-enabled mode");
        return [];
    }
  }

  override mapEffort(level: ReasoningEffort): string[] {
    return ["--thinking", level === "none" ? "off" : level];
  }

  buildRunCommand(request: RunRequest): string[] {
    const cmd = ["pi", "--print", "--no-session", "--no-approve"];

    if (request.model) {
      cmd.push("--model", request.model);
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

  buildTuiCommand(
    model?: string,
    autonomy?: AutonomyLevel,
    effort?: ReasoningEffort,
    _sandboxed?: boolean
  ): string[] {
    const cmd = ["pi", "--no-approve"];
    if (model) {
      cmd.push("--model", model);
    }
    if (autonomy) {
      cmd.push(...this.mapAutonomy(autonomy));
    }
    if (effort) {
      cmd.push(...this.mapEffort(effort));
    }
    return cmd;
  }
}
