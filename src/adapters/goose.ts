import { BaseAdapter } from "./base.js";
import type {
  AgentId,
  AutonomyLevel,
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
    };
  }

  buildRunCommand(request: RunRequest): string[] {
    const cmd = ["goose", "run", "-t", request.prompt];
    return cmd;
  }

  buildTuiCommand(_model?: string): string[] {
    return ["goose"];
  }
}
