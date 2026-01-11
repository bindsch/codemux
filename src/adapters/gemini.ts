import { BaseAdapter } from "./base.js";
import type {
  AgentId,
  AutonomyLevel,
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

  buildTuiCommand(model?: string): string[] {
    const cmd = ["gemini"];
    if (model) {
      cmd.push("-m", model);
    }
    return cmd;
  }
}
