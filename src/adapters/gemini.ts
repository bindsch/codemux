import { BaseAdapter } from "./base.js";
import type {
  AgentId,
  AutonomyLevel,
  ReasoningEffort,
  RunRequest,
  AdapterCapabilities,
} from "../types.js";

export class GeminiAdapter extends BaseAdapter {
  readonly id: AgentId = "gemini";
  readonly binaryName = "gemini";

  capabilities(): AdapterCapabilities {
    return {
      supportsNonInteractive: true,
      supportsInteractive: true,
      supportsModel: true,
      supportsAutonomy: false,
      autonomyLevels: [],
      supportsEffort: false,
      effortLevels: [],
    };
  }

  buildRunCommand(request: RunRequest): string[] {
    const cmd = ["gemini", "-p"];

    if (request.model) {
      cmd.push("-m", request.model);
    }

    cmd.push(request.prompt);

    return cmd;
  }

  buildTuiCommand(model?: string, _autonomy?: AutonomyLevel, _effort?: ReasoningEffort): string[] {
    const cmd = ["gemini"];
    if (model) {
      cmd.push("-m", model);
    }
    return cmd;
  }
}
