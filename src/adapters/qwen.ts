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

  get binaryName(): string {
    return this.isLegacyBinary ? "qwen-coder" : "qwen";
  }

  private readonly resolvedBinary: string | null;
  private readonly isLegacyBinary: boolean;

  capabilities(): AdapterCapabilities {
    return {
      supportsNonInteractive: true,
      supportsInteractive: true,
      supportsModel: !this.isLegacyBinary,
      supportsAutonomy: true,
      autonomyLevels: ["read-only", "low", "medium", "high"],
      supportsEffort: false,
      effortLevels: [],
    };
  }

  constructor(
    private readonly findBinary: (name: string) => string | null = (name) =>
      Bun.which(name, { PATH: process.env.PATH })
  ) {
    super();
    const currentBinary = this.findBinary("qwen");
    const legacyBinary = currentBinary ? null : this.findBinary("qwen-coder");
    this.resolvedBinary = currentBinary ?? legacyBinary;
    this.isLegacyBinary = currentBinary === null && legacyBinary !== null;
  }

  private resolveBinary(): string {
    return this.resolvedBinary ?? "qwen";
  }

  override isAvailable(): boolean {
    return this.resolvedBinary !== null;
  }

  override mapAutonomy(level: AutonomyLevel): string[] {
    switch (level) {
      case "read-only":
        return ["--approval-mode", "plan"];
      case "low":
        return ["--approval-mode", "default"];
      case "medium":
        return ["--approval-mode", "auto"];
      case "high":
        return ["--approval-mode", "yolo"];
    }
  }

  override requiresSandboxForAutonomy(_level: AutonomyLevel): boolean {
    return this.isLegacyBinary;
  }

  buildRunCommand(request: RunRequest): string[] {
    const binary = this.resolveBinary();

    if (this.isLegacyBinary) {
      if (request.model) {
        throw new Error("qwen-coder does not support model selection");
      }
      if (!request.sandboxed) {
        throw new Error(
          "qwen-coder cannot enforce autonomy levels; use --sandbox or install the current qwen CLI"
        );
      }
      return [binary, "--", request.prompt];
    }

    const cmd = [binary, "--safe-mode"];
    if (request.model) {
      cmd.push("--model", request.model);
    }
    if (request.autonomy) {
      cmd.push(...this.mapAutonomy(request.autonomy));
    }
    return cmd;
  }

  override getStdinInput(request: RunRequest): string | null {
    return this.isLegacyBinary ? null : request.prompt;
  }

  buildTuiCommand(
    model?: string,
    autonomy?: AutonomyLevel,
    _effort?: ReasoningEffort,
    sandboxed?: boolean
  ): string[] {
    const binary = this.resolveBinary();
    if (this.isLegacyBinary) {
      if (model) {
        throw new Error("qwen-coder does not support model selection");
      }
      if (!sandboxed) {
        throw new Error(
          "qwen-coder cannot enforce autonomy levels; use --sandbox or install the current qwen CLI"
        );
      }
      return [binary];
    }

    const cmd = [binary, "--safe-mode"];
    if (model) {
      cmd.push("--model", model);
    }
    if (autonomy) {
      cmd.push(...this.mapAutonomy(autonomy));
    }
    return cmd;
  }
}
