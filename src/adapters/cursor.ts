import { BaseAdapter } from "./base.js";
import { assertNoCursorProjectExecutionConfig } from "../project-safety.js";
import { validateWorkingDirectory } from "../validation.js";
import type {
  AdapterCapabilities,
  AgentId,
  AutonomyLevel,
  ReasoningEffort,
  RunRequest,
} from "../types.js";

export class CursorAdapter extends BaseAdapter {
  readonly id: AgentId = "cursor";

  private readonly resolvedBinaryName: "agent" | "cursor-agent";
  private readonly available: boolean;

  constructor(
    findBinary: (name: string) => string | null = (name) =>
      Bun.which(name, { PATH: process.env.PATH })
  ) {
    super();
    if (findBinary("agent") !== null) {
      this.resolvedBinaryName = "agent";
      this.available = true;
    } else if (findBinary("cursor-agent") !== null) {
      this.resolvedBinaryName = "cursor-agent";
      this.available = true;
    } else {
      this.resolvedBinaryName = "agent";
      this.available = false;
    }
  }

  get binaryName(): string {
    return this.resolvedBinaryName;
  }

  override isAvailable(): boolean {
    return this.available;
  }

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

  override mapAutonomy(level: AutonomyLevel): string[] {
    switch (level) {
      case "read-only":
        return ["--mode", "plan"];
      case "low":
        return [];
      case "medium":
        return ["--auto-review"];
      case "high":
        return ["--force"];
    }
  }

  buildRunCommand(request: RunRequest): string[] {
    const cmd = [
      this.resolvedBinaryName,
      "--print",
      "--output-format",
      "text",
      "--trust",
    ];
    if (request.sandboxed) {
      cmd.push("--sandbox", "disabled");
    }
    if (request.model) {
      cmd.push("--model", request.model);
    }
    if (request.autonomy) {
      cmd.push(...this.mapAutonomy(request.autonomy));
    }
    return cmd;
  }

  override getStdinInput(request: RunRequest): string | null {
    return request.prompt;
  }

  override validateRunRequest(request: RunRequest): void {
    super.validateRunRequest(request);
    assertNoCursorProjectExecutionConfig(
      validateWorkingDirectory(request.cwd) ?? process.cwd()
    );
  }

  override validateTuiRequest(
    model?: string,
    cwd?: string,
    autonomy: AutonomyLevel = "read-only",
    effort?: ReasoningEffort,
    passthroughEnv: readonly string[] = [],
    enablePlaywrightMcp = false
  ): void {
    super.validateTuiRequest(
      model,
      cwd,
      autonomy,
      effort,
      passthroughEnv,
      enablePlaywrightMcp
    );
    assertNoCursorProjectExecutionConfig(
      validateWorkingDirectory(cwd) ?? process.cwd()
    );
  }

  buildTuiCommand(
    model?: string,
    autonomy?: AutonomyLevel,
    _effort?: ReasoningEffort,
    sandboxed?: boolean
  ): string[] {
    const cmd: string[] = [this.resolvedBinaryName];
    if (sandboxed) {
      cmd.push("--trust", "--sandbox", "disabled");
    }
    if (model) {
      cmd.push("--model", model);
    }
    if (autonomy) {
      cmd.push(...this.mapAutonomy(autonomy));
    }
    return cmd;
  }

  override requiresSandboxForAutonomy(level: AutonomyLevel): boolean {
    return level !== "high";
  }
}
