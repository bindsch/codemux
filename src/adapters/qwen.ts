import { BaseAdapter } from "./base.js";
import type {
  AgentId,
  AutonomyLevel,
  ReasoningEffort,
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
      supportsEffort: false,
      effortLevels: [],
    };
  }

  buildRunCommand(request: RunRequest): string[] {
    return ["qwen-coder", request.prompt];
  }

  buildTuiCommand(_model?: string, _autonomy?: AutonomyLevel, _effort?: ReasoningEffort): string[] {
    return ["qwen-coder"];
  }
}
