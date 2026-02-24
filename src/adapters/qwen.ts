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
  readonly binaryName = "qwen";

  capabilities(): AdapterCapabilities {
    return {
      supportsNonInteractive: true,
      supportsInteractive: true,
      supportsModel: true,
      supportsAutonomy: true,
      autonomyLevels: ["read-only", "low", "medium", "high"],
      supportsEffort: false,
      effortLevels: [],
    };
  }

  private hasBinary(name: string): boolean {
    return Bun.spawnSync(["which", name]).exitCode === 0;
  }

  private resolveBinary(): "qwen" | "qwen-coder" {
    if (this.hasBinary("qwen")) {
      return "qwen";
    }
    if (this.hasBinary("qwen-coder")) {
      return "qwen-coder";
    }
    return "qwen";
  }

  override isAvailable(): boolean {
    return this.hasBinary("qwen") || this.hasBinary("qwen-coder");
  }

  override mapAutonomy(level: AutonomyLevel): string[] {
    switch (level) {
      case "read-only":
        return ["--approval-mode", "plan"];
      case "low":
        return ["--approval-mode", "default"];
      case "medium":
        return ["--approval-mode", "auto-edit"];
      case "high":
        return ["--approval-mode", "yolo"];
    }
  }

  buildRunCommand(request: RunRequest): string[] {
    const binary = this.resolveBinary();

    // Legacy binary fallback keeps previous behavior.
    if (binary === "qwen-coder") {
      if (request.model) {
        console.warn("Warning: qwen-coder fallback does not support --model, ignoring");
      }
      if (request.autonomy && request.autonomy !== "low") {
        console.warn("Warning: qwen-coder fallback does not support approval modes, using default mode");
      }
      return ["qwen-coder", request.prompt];
    }

    const cmd = ["qwen"];
    if (request.model) {
      cmd.push("--model", request.model);
    }
    if (request.autonomy) {
      cmd.push(...this.mapAutonomy(request.autonomy));
    }
    cmd.push("--prompt", request.prompt);
    return cmd;
  }

  buildTuiCommand(
    model?: string,
    autonomy?: AutonomyLevel,
    _effort?: ReasoningEffort,
    _sandboxed?: boolean
  ): string[] {
    const binary = this.resolveBinary();
    if (binary === "qwen-coder") {
      if (model) {
        console.warn("Warning: qwen-coder fallback does not support --model, ignoring");
      }
      if (autonomy && autonomy !== "low") {
        console.warn("Warning: qwen-coder fallback does not support approval modes, using default mode");
      }
      return ["qwen-coder"];
    }

    const cmd = ["qwen"];
    if (model) {
      cmd.push("--model", model);
    }
    if (autonomy) {
      cmd.push(...this.mapAutonomy(autonomy));
    }
    return cmd;
  }
}
