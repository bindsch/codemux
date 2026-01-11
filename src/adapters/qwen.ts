import { BaseAdapter } from "./base.js";
import type {
  AgentId,
  AutonomyLevel,
  RunRequest,
  AdapterCapabilities,
} from "../types.js";

export class QwenAdapter extends BaseAdapter {
  readonly id: AgentId = "qwen";
  readonly binaryName = "qwen-coder";

  capabilities(): AdapterCapabilities {
    return {
      supportsNonInteractive: true,
      supportsInteractive: true,
      supportsModel: false,
      supportsAutonomy: false,
      autonomyLevels: [],
    };
  }

  buildRunCommand(request: RunRequest): string[] {
    return ["qwen-coder", request.prompt];
  }

  buildTuiCommand(_model?: string): string[] {
    return ["qwen-coder"];
  }
}
