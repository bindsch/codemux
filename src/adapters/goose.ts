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
      supportsAutonomy: false,
      autonomyLevels: [],
      supportsEffort: false,
      effortLevels: [],
    };
  }

  buildRunCommand(request: RunRequest): string[] {
    const cmd = ["goose", "run", "-t", request.prompt];
    return cmd;
  }

  buildTuiCommand(_model?: string, _autonomy?: AutonomyLevel, _effort?: ReasoningEffort): string[] {
    return ["goose"];
  }
}
