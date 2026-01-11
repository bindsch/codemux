import { BaseAdapter } from "./base.js";
import type {
  AgentId,
  AutonomyLevel,
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
      supportsAutonomy: false,
      autonomyLevels: [],
    };
  }

  buildRunCommand(request: RunRequest): string[] {
    const cmd = ["opencode", "run"];

    if (request.model) {
      cmd.push("--model", request.model);
    }

    cmd.push(request.prompt);

    return cmd;
  }

  buildTuiCommand(model?: string): string[] {
    const cmd = ["opencode"];
    if (model) {
      cmd.push("--model", model);
    }
    return cmd;
  }
}
