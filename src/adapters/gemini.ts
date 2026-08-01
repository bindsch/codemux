import { BaseAdapter } from "./base.js";
import { assertNoGeminiProjectExecutionConfig } from "../project-safety.js";
import { validateWorkingDirectory } from "../validation.js";
import { fileURLToPath } from "node:url";
import type {
  AgentId,
  AutonomyLevel,
  ReasoningEffort,
  RunRequest,
  AdapterCapabilities,
} from "../types.js";

export const GEMINI_SYSTEM_SETTINGS_PATH = fileURLToPath(
  new URL("../../resources/gemini-system-settings.json", import.meta.url)
);

export class GeminiAdapter extends BaseAdapter {
  readonly id: AgentId = "gemini";
  readonly binaryName = "gemini";

  override getEnv(): Record<string, string> {
    return { GEMINI_CLI_SYSTEM_SETTINGS_PATH: GEMINI_SYSTEM_SETTINGS_PATH };
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
        return ["--approval-mode", "plan"];
      case "low":
        return ["--approval-mode", "default"];
      case "medium":
        return ["--approval-mode", "auto_edit"];
      case "high":
        return ["--approval-mode", "yolo"];
    }
  }

  override requiresSandboxForAutonomy(level: AutonomyLevel): boolean {
    // Headless Plan Mode can approve its own transition into implementation.
    // An outer read-only filesystem boundary is therefore required.
    return level === "read-only";
  }

  override requiresSandboxForTuiAutonomy(_level: AutonomyLevel): boolean {
    return false;
  }

  buildRunCommand(request: RunRequest): string[] {
    const cmd = ["gemini", "--sandbox=false"];

    if (request.model) {
      cmd.push("-m", request.model);
    }

    if (request.autonomy) {
      cmd.push(...this.mapAutonomy(request.autonomy));
    }

    cmd.push("-p", request.prompt);

    return cmd;
  }

  override validateRunRequest(request: RunRequest): void {
    super.validateRunRequest(request);
    assertNoGeminiProjectExecutionConfig(
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
    super.validateTuiRequest(model, cwd, autonomy, effort, passthroughEnv, enablePlaywrightMcp);
    assertNoGeminiProjectExecutionConfig(
      validateWorkingDirectory(cwd) ?? process.cwd()
    );
  }

  buildTuiCommand(
    model?: string,
    autonomy?: AutonomyLevel,
    _effort?: ReasoningEffort,
    _sandboxed?: boolean
  ): string[] {
    const cmd = ["gemini", "--sandbox=false"];
    if (model) {
      cmd.push("-m", model);
    }
    if (autonomy) {
      cmd.push(...this.mapAutonomy(autonomy));
    }
    return cmd;
  }
}
